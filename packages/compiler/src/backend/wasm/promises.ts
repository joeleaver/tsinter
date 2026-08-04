/* The promise runtime the resumable lowering (statemachine.ts) suspends
 * over: one promise struct, one waiter node, one microtask queue, one
 * ledger of maybe-unhandled rejections, and the drain loop `_start` runs
 * after the entry returns. Emitted lazily, like every other helper family
 * here — a module with no promise in it gets none of this.
 *
 * ONE PROMISE TYPE. Every promise in a module shares `promT` regardless of
 * its inner type, exactly as every union value shares the union base: the
 * payload rides a (kind, f64, ref) triple with the EXCEPTION CELL's
 * encoding (the emitter owns those tags and passes them in), so a
 * fulfilment and a rejection are the same three slots and the awaiting
 * side reads back by its own static type. That is what makes
 * `mapType(promise) → promT` total, and it is why the waiter queue can be
 * one list rather than one per instantiation.
 *
 * EVERY AWAIT SPENDS A TURN. subscribe on an ALREADY-SETTLED promise does
 * not resume inline — it pushes the waiter straight onto the microtask
 * queue, so `await settled` costs exactly one turn, which is what V8 does
 * (post-await-optimization) and therefore what interleaving observes.
 * There is deliberately no settled fast path.
 *
 * NO ADOPTION. Settling with a promise payload would have to subscribe to
 * it and cost two further turns (the spec's thenable job pair); this tier
 * refuses those programs up front (`fn:async:nested-promise`,
 * `expr:newPromise:adopt`) rather than approximate them.
 *
 * THE LEDGER AND THE REPORT. A rejected promise joins an intrusive
 * singly-linked ledger; observing it (an await that re-throws, or a
 * subscribe that lands on it) sets `observed`. When the queue is empty and
 * `_start` is done, the report walks the ledger for the FIRST unobserved
 * rejection — scr_async.c's shape, prints once — writes Node's
 * "Unhandled promise rejection: <reason>" to stderr, and TRAPS: the trap
 * is this tier's exit-1 channel (SEMANTICS.md S007, S010).
 *
 * THE MODULE ROOT IS ITS OWN CHANNEL. A top-level-await program's entry
 * promise belongs to the loader, so it is marked observed at birth and the
 * ledger walk never answers for it. Its rejection is instead decided by
 * the emitter's checkpoint, which calls `rootReport` — the SAME rendered
 * line, the same trap — and thereby stops the event loop before any later
 * timer runs, exactly where scr_loop_run breaks on a rejected root. */
import type { ByteWriter } from "./bytes.js";
import { Code } from "./code.js";
import { FD_STDERR } from "./abi.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

/** What the runtime needs from the emitter that owns it. Everything here
 * is resolved LAZILY (the first helper that needs it interns it), so a
 * module that mints a promise but never rejects one still pays for the
 * number formatter — the report is the only reader, and it is emitted
 * with the rest of the runtime. */
export interface PromiseDeps {
  /** The open struct every `%frame.<fn>` subtypes — what a waiter carries.
   * (The runtime never reads a frame; it hands it back to its resume.) */
  frameBase: () => number;
  /** The ONE resume signature's (closure struct, func type) pair. */
  resumeClos: () => { clos: number; fn: number };
  /** The exception cell's payload tags — the promise payload uses the
   * identical encoding, so a caught snapshot copies across field-wise. */
  tags: { f64: number; bool: number; str: number; obj: number };
  /** `(ref null any)` — the one slot every ref payload shares. */
  anyRef: ValType;
  /** The builtin-error struct: an OBJ payload's only shape. */
  errT: () => number;
  f64ToStr: () => number;
  errToStr: () => number;
  /** The output staging trio (stage/putc/flush) the report writes with. */
  out: () => { stage: number; putc: number; flush: number };
  lit: (c: Code, s: string) => void;
}

/* promT's fields. The first four and `observed` are exported because the
 * emitter reads them inline: %async.rejectCheck moves a rejection's
 * payload into the exception cell, which is one field-wise copy and not
 * worth a call. */
export const PROM_STATE = 0; // 0 pending, 1 fulfilled, 2 rejected
export const PROM_KIND = 1; // the payload tag (the exception cell's encoding)
export const PROM_F64 = 2; // number payloads, and bools as 0/1
export const PROM_REF = 3; // string / error / other ref payloads
const P_WAIT_HEAD = 4;
const P_WAIT_TAIL = 5;
export const PROM_OBSERVED = 6; // a rejection somebody looked at
const P_NEXT = 7; // the maybe-unhandled ledger's intrusive link

/* waiterT's fields — one node type, used both for a promise's own waiter
 * list and for the microtask queue (a node moves between them). */
const W_CLOS = 0;
const W_FRAME = 1;
const W_NEXT = 2;

/* ── the combinators' reaction nodes ──────────────────────────────────
 * Promise.all and Promise.race need NO promise-shape change: a reaction
 * is an ORDINARY WAITER — same waiterT, same FIFO, same subscribe, same
 * settle, same drain — whose "resume closure" is one of the emitter's
 * interned reaction functions and whose "frame" is one of the two nodes
 * below (both subtype %frameBase, exactly like a real async frame; the
 * runtime never reads either, it just hands them back).
 *
 * THAT IS ALSO THE RIGHT SEMANTICS, not merely the cheap one. A
 * combinator in ECMAScript is `.then(onFulfilled, onRejected)` on every
 * entry, so an entry's settlement ENQUEUES its reaction job — the result
 * promise settles one microtask turn AFTER the deciding entry, and an
 * awaiter of the result resumes a turn after that. Riding the waiter
 * queue reproduces that for free. (scr_async.c instead runs its `cbs`
 * synchronously inside settle, which lands the result a full turn early;
 * measured against Node, that is where the C lane and this one part
 * company — Node is the oracle, so this lane queues.)
 *
 * The `+1 for the iteration` of the spec's remaining-count needs no
 * counterpart: nothing decrements until a reaction runs, and no reaction
 * can run before the subscribing loop ends, so an EMPTY all is the only
 * case that fulfills during construction — which is what the spec says
 * too. */

/* %w.all.state's fields — the countdown one Promise.all's entries share.
 * `values` is the pre-sized result array held as a bare anyref so this
 * type stays ONE type: which vector it really is belongs to the reaction
 * function, which is interned per element representation anyway. Null for
 * a void-inner all (`Promise.all(voids)` fulfills void). */
export const ALL_REMAINING = 0;
export const ALL_RESULT = 1;
export const ALL_VALUES = 2;

/* %w.all.entry's fields — one entry's reaction frame. The index is f64
 * because that is what the vector helpers take. */
export const ALLE_STATE = 0;
export const ALLE_INDEX = 1;
export const ALLE_SRC = 2;

/* %w.race.entry's fields — one entry's reaction frame: where to settle,
 * and what settled. */
export const RACEE_DST = 0;
export const RACEE_SRC = 1;

export class PromiseBuilder {
  private readonly fns = new Map<string, number>();
  private promTField: number | null = null;
  private waiterTField: number | null = null;
  private allStateField: number | null = null;
  private allEntryField: number | null = null;
  private raceEntryField: number | null = null;
  private queue: { head: number; tail: number } | null = null;
  private ledger: { head: number; tail: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    /** The UTF-16 string array type — a STR payload's shape. */
    private readonly strType: number,
    private readonly deps: PromiseDeps,
  ) {}

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** The waiter node: (resume closure, its frame, next). Interned before
   * promT because promT's list heads name it. */
  private get waiterT(): number {
    if (this.waiterTField === null) {
      const clos: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.resumeClos().clos };
      const frame: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.frameBase() };
      this.waiterTField = this.mb.selfStructType("%w.waiter", (self) => [
        { storage: clos, mutable: true },
        { storage: frame, mutable: true },
        { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true },
      ]);
    }
    return this.waiterTField;
  }

  /** The one promise struct (see the header). */
  get promT(): number {
    if (this.promTField === null) {
      const waiter: ValType = { kind: "ref", nullable: true, typeIndex: this.waiterT };
      const anyRef = this.deps.anyRef;
      this.promTField = this.mb.selfStructType("%w.promise", (self) => [
        { storage: I32, mutable: true },
        { storage: I32, mutable: true },
        { storage: F64, mutable: true },
        { storage: anyRef, mutable: true },
        { storage: waiter, mutable: true },
        { storage: waiter, mutable: true },
        { storage: I32, mutable: true },
        { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true },
      ]);
    }
    return this.promTField;
  }

  promRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.promT };
  }

  private waiterRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.waiterT };
  }

  private nullWaiter(c: Code): void {
    c.refNull(this.waiterT);
  }

  /** The microtask queue: one FIFO of waiter nodes, module-global. */
  private q(): { head: number; tail: number } {
    if (this.queue === null) {
      const t = this.waiterRef();
      const init = (w: ByteWriter): void => {
        w.u8(0xd0);
        w.sleb(this.waiterT);
      };
      this.queue = { head: this.mb.addGlobal(t, true, init), tail: this.mb.addGlobal(t, true, init) };
    }
    return this.queue;
  }

  /** The maybe-unhandled ledger: rejections in rejection order. */
  private led(): { head: number; tail: number } {
    if (this.ledger === null) {
      const t = this.promRef();
      const init = (w: ByteWriter): void => {
        w.u8(0xd0);
        w.sleb(this.promT);
      };
      this.ledger = { head: this.mb.addGlobal(t, true, init), tail: this.mb.addGlobal(t, true, init) };
    }
    return this.ledger;
  }

  /** %w.async.mint() → a fresh PENDING promise (every field's default). */
  mint(): number {
    return this.cached("mint", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], [this.promRef()]), "%w.async.mint");
      const c = new Code();
      c.structNewDefault(this.promT);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.async.hop(clos, frame) — enqueue a microtask calling clos(frame).
   * The bare `await <non-thenable>` turn, and the tail every settled
   * subscribe takes. */
  hop(): number {
    return this.cached("hop", () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.resumeClos().clos };
      const frameRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.frameBase() };
      const idx = this.mb.declareFunc(this.mb.funcType([closRef, frameRef], []), "%w.async.hop");
      const q = this.q();
      const c = new Code();
      const CLOS = 0, FRAME = 1, N = 2;
      c.localGet(CLOS);
      c.localGet(FRAME);
      this.nullWaiter(c);
      c.structNew(this.waiterT);
      c.localSet(N);
      c.globalGet(q.tail);
      c.refIsNull();
      c.ifVoid();
      c.localGet(N);
      c.globalSet(q.head);
      c.else_();
      c.globalGet(q.tail);
      c.localGet(N);
      c.structSet(this.waiterT, W_NEXT);
      c.end();
      c.localGet(N);
      c.globalSet(q.tail);
      this.mb.setBody(idx, [this.waiterRef()], c.bytes());
      return idx;
    });
  }

  /** %w.async.subscribe(p, clos, frame) — park (clos, frame) on `p`, or
   * (already settled) spend the turn straight away. Landing on a rejected
   * promise OBSERVES it: the awaiting frame is about to re-throw, so it is
   * not unhandled. */
  subscribe(): number {
    return this.cached("subscribe", () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.resumeClos().clos };
      const frameRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.frameBase() };
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.promRef(), closRef, frameRef], []),
        "%w.async.subscribe",
      );
      const hop = this.hop();
      const c = new Code();
      const P = 0, CLOS = 1, FRAME = 2, N = 3;
      c.localGet(P);
      c.structGet(this.promT, PROM_STATE);
      c.i32Eqz();
      c.ifVoid();
      {
        c.localGet(CLOS);
        c.localGet(FRAME);
        this.nullWaiter(c);
        c.structNew(this.waiterT);
        c.localSet(N);
        c.localGet(P);
        c.structGet(this.promT, P_WAIT_TAIL);
        c.refIsNull();
        c.ifVoid();
        c.localGet(P);
        c.localGet(N);
        c.structSet(this.promT, P_WAIT_HEAD);
        c.else_();
        c.localGet(P);
        c.structGet(this.promT, P_WAIT_TAIL);
        c.localGet(N);
        c.structSet(this.waiterT, W_NEXT);
        c.end();
        c.localGet(P);
        c.localGet(N);
        c.structSet(this.promT, P_WAIT_TAIL);
      }
      c.else_();
      {
        c.localGet(P);
        c.structGet(this.promT, PROM_STATE);
        c.i32Const(2);
        c.i32Eq();
        c.ifVoid();
        c.localGet(P);
        c.i32Const(1);
        c.structSet(this.promT, PROM_OBSERVED);
        c.end();
        c.localGet(CLOS);
        c.localGet(FRAME);
        c.call(hop);
      }
      c.end();
      this.mb.setBody(idx, [this.waiterRef()], c.bytes());
      return idx;
    });
  }

  /** %w.async.subscribeHandled(p, clos, frame) — subscribe(), plus the
   * mark every combinator owes its entries. Attaching a handler is what
   * makes a rejection HANDLED in JS, and a combinator subscribes to
   * EVERYTHING, so an entry that loses the race (or arrives after the
   * first rejection won an all) is never an unhandled-rejection report.
   * Marked at ATTACH time, like V8's [[PromiseIsHandled]] — not at
   * reaction time, so a report triggered by some other promise before the
   * reaction runs still sees these as handled. */
  subscribeHandled(): number {
    return this.cached("subscribeHandled", () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.resumeClos().clos };
      const frameRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.frameBase() };
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.promRef(), closRef, frameRef], []),
        "%w.async.subscribeHandled",
      );
      const subscribe = this.subscribe();
      const c = new Code();
      const P = 0, CLOS = 1, FRAME = 2;
      c.localGet(P);
      c.i32Const(1);
      c.structSet(this.promT, PROM_OBSERVED);
      c.localGet(P);
      c.localGet(CLOS);
      c.localGet(FRAME);
      c.call(subscribe);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.async.settleFrom(dst, src) — copy a settled promise's WHOLE
   * outcome (payload triple and state alike) into `dst`. Both combinators
   * settle their result this way on a rejection, and race does it on a
   * fulfilment too whenever no payload conversion is needed;
   * first-settle-wins needs no guard of its own because settle already
   * ignores a non-pending destination. */
  settleFrom(): number {
    return this.cached("settleFrom", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.promRef(), this.promRef()], []),
        "%w.async.settleFrom",
      );
      const settle = this.settle();
      const c = new Code();
      const DST = 0, SRC = 1;
      c.localGet(DST);
      c.localGet(SRC);
      c.structGet(this.promT, PROM_KIND);
      c.localGet(SRC);
      c.structGet(this.promT, PROM_F64);
      c.localGet(SRC);
      c.structGet(this.promT, PROM_REF);
      c.localGet(SRC);
      c.structGet(this.promT, PROM_STATE);
      c.call(settle);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** The countdown one Promise.all's entries share (see the block above). */
  get allStateT(): number {
    this.allStateField ??= this.mb.structType([
      { storage: I32, mutable: true },
      { storage: this.promRef(), mutable: false },
      { storage: this.deps.anyRef, mutable: false },
    ]);
    return this.allStateField;
  }

  allStateRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.allStateT };
  }

  /** One Promise.all entry's reaction frame. */
  get allEntryT(): number {
    this.allEntryField ??= this.mb.subStructType(
      "%w.all.entry",
      [
        { storage: this.allStateRef(), mutable: false },
        { storage: F64, mutable: false },
        { storage: this.promRef(), mutable: false },
      ],
      this.deps.frameBase(),
    );
    return this.allEntryField;
  }

  /** One Promise.race entry's reaction frame. */
  get raceEntryT(): number {
    this.raceEntryField ??= this.mb.subStructType(
      "%w.race.entry",
      [
        { storage: this.promRef(), mutable: false },
        { storage: this.promRef(), mutable: false },
      ],
      this.deps.frameBase(),
    );
    return this.raceEntryField;
  }

  /** %w.async.settle(p, kind, f64, ref, state) — FIRST SETTLE WINS: a
   * second call on the same promise is a no-op (JS's resolve/reject
   * idempotence). `state` is 1 (fulfilled) or 2 (rejected); a rejection
   * additionally joins the ledger. The parked waiters move to the
   * microtask queue's TAIL with their order preserved. */
  settle(): number {
    return this.cached("settle", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.promRef(), I32, F64, this.deps.anyRef, I32], []),
        "%w.async.settle",
      );
      const q = this.q();
      const led = this.led();
      const c = new Code();
      const P = 0, KIND = 1, VAL = 2, REF = 3, STATE = 4;
      c.localGet(P);
      c.structGet(this.promT, PROM_STATE);
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(P);
      c.localGet(KIND);
      c.structSet(this.promT, PROM_KIND);
      c.localGet(P);
      c.localGet(VAL);
      c.structSet(this.promT, PROM_F64);
      c.localGet(P);
      c.localGet(REF);
      c.structSet(this.promT, PROM_REF);
      c.localGet(P);
      c.localGet(STATE);
      c.structSet(this.promT, PROM_STATE);
      // A rejection is maybe-unhandled until something observes it.
      c.localGet(STATE);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.globalGet(led.tail);
      c.refIsNull();
      c.ifVoid();
      c.localGet(P);
      c.globalSet(led.head);
      c.else_();
      c.globalGet(led.tail);
      c.localGet(P);
      c.structSet(this.promT, P_NEXT);
      c.end();
      c.localGet(P);
      c.globalSet(led.tail);
      c.end();
      // Splice the whole waiter list onto the queue in one go — order
      // preserved, which is what makes two frames awaiting one promise
      // resume in subscription order.
      c.localGet(P);
      c.structGet(this.promT, P_WAIT_HEAD);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.globalGet(q.tail);
      c.refIsNull();
      c.ifVoid();
      c.localGet(P);
      c.structGet(this.promT, P_WAIT_HEAD);
      c.globalSet(q.head);
      c.else_();
      c.globalGet(q.tail);
      c.localGet(P);
      c.structGet(this.promT, P_WAIT_HEAD);
      c.structSet(this.waiterT, W_NEXT);
      c.end();
      c.localGet(P);
      c.structGet(this.promT, P_WAIT_TAIL);
      c.globalSet(q.tail);
      c.localGet(P);
      this.nullWaiter(c);
      c.structSet(this.promT, P_WAIT_HEAD);
      c.localGet(P);
      this.nullWaiter(c);
      c.structSet(this.promT, P_WAIT_TAIL);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.async.drain() — run microtasks to quiescence. No pending check
   * after the call: a resume never returns with the exception cell set
   * (its own tryCatch absorbs everything into a rejection), which is the
   * invariant that lets the loop stay this small. */
  drain(): number {
    return this.cached("drain", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], []), "%w.async.drain");
      const pair = this.deps.resumeClos();
      const q = this.q();
      const c = new Code();
      const N = 0;
      c.loop();
      c.globalGet(q.head);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.globalGet(q.head);
      c.localSet(N);
      c.localGet(N);
      c.structGet(this.waiterT, W_NEXT);
      c.globalSet(q.head);
      c.globalGet(q.head);
      c.refIsNull();
      c.ifVoid();
      this.nullWaiter(c);
      c.globalSet(q.tail);
      c.end();
      // Unlink before the call: the node is dead, and a live `next` would
      // keep the whole drained prefix reachable for the GC.
      c.localGet(N);
      this.nullWaiter(c);
      c.structSet(this.waiterT, W_NEXT);
      c.localGet(N);
      c.structGet(this.waiterT, W_CLOS); // arg0: the closure itself
      c.localGet(N);
      c.structGet(this.waiterT, W_FRAME);
      c.localGet(N);
      c.structGet(this.waiterT, W_CLOS);
      c.structGet(pair.clos, 0);
      c.callRef(pair.fn);
      c.br(0);
      c.end();
      this.mb.setBody(idx, [this.waiterRef()], c.bytes());
      return idx;
    });
  }

  /** The rejection line itself: `Unhandled promise rejection: <reason>` to
   * fd 2, then the trap that IS this tier's exit 1 (SEMANTICS.md S010).
   * `p` holds the rejected promise and `k` is a scratch i32; both the
   * ledger walk (report) and the module ROOT's own stop-and-trap
   * (rootReport) render through here, so the two lines cannot drift. */
  private emitReport(c: Code, p: number, k: number): void {
    const out = this.deps.out();
    const tags = this.deps.tags;
    this.deps.lit(c, "Unhandled promise rejection: ");
    c.call(out.stage);
    c.localGet(p);
    c.structGet(this.promT, PROM_KIND);
    c.localSet(k);
    // The payload's four renderable shapes, scr_async.c's report
    // exactly; anything else prints "[object]" like the C default.
    c.localGet(k);
    c.i32Const(tags.f64);
    c.i32Eq();
    c.ifVoid();
    c.localGet(p);
    c.structGet(this.promT, PROM_F64);
    c.call(this.deps.f64ToStr());
    c.call(out.stage);
    c.else_();
    c.localGet(k);
    c.i32Const(tags.bool);
    c.i32Eq();
    c.ifVoid();
    c.localGet(p);
    c.structGet(this.promT, PROM_F64);
    c.f64Const(0);
    c.f64Ne();
    c.ifVoid();
    this.deps.lit(c, "true");
    c.call(out.stage);
    c.else_();
    this.deps.lit(c, "false");
    c.call(out.stage);
    c.end();
    c.else_();
    c.localGet(k);
    c.i32Const(tags.str);
    c.i32Eq();
    c.ifVoid();
    c.localGet(p);
    c.structGet(this.promT, PROM_REF);
    c.refCast(this.strType);
    c.call(out.stage);
    c.else_();
    c.localGet(k);
    c.i32Const(tags.obj);
    c.i32Eq();
    c.ifVoid();
    c.localGet(p);
    c.structGet(this.promT, PROM_REF);
    c.refCast(this.deps.errT());
    c.call(this.deps.errToStr());
    c.call(out.stage);
    c.else_();
    this.deps.lit(c, "[object]");
    c.call(out.stage);
    c.end();
    c.end();
    c.end();
    c.end();
    c.i32Const(0x0a);
    c.call(out.putc);
    c.i32Const(FD_STDERR);
    c.call(out.flush);
    // Node exits 1 on an unhandled rejection; the trap is how this
    // artifact says that (SEMANTICS.md S010).
    c.unreachable();
  }

  /** %w.async.rootReport(p) — the TOP-LEVEL-AWAIT root's own stop: a
   * rejected module evaluation promise ends the program at the checkpoint
   * that observed it, before any later timer can run (S010, and
   * scr_loop_run's root break). The root is marked handled the moment it
   * exists, so the ledger walk deliberately skips it and this is the only
   * place it is answered for. Never returns. */
  rootReport(): number {
    return this.cached("rootReport", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.promRef()], []), "%w.async.rootReport");
      const c = new Code();
      const P = 0, K = 1;
      this.emitReport(c, P, K);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.async.report() — the quiescent unhandled-rejection check. Walks
   * the ledger, and on the FIRST rejection nobody observed writes Node's
   * line to stderr and traps (S010: the trap IS the exit-1 channel, and
   * the harness skips the stderr compare on a nonzero exit). Returns
   * normally when every rejection was handled.
   *
   * No stdout flush first, where the C runtime needs one: console output
   * here goes through the host's `write` synchronously per statement, so
   * the staging region is always empty between statements — there is no
   * buffered stdout to lose ahead of the stderr line. */
  report(): number {
    return this.cached("report", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], []), "%w.async.report");
      const led = this.led();
      const c = new Code();
      const P = 0, K = 1;
      c.globalGet(led.head);
      c.localSet(P);
      c.loop();
      c.localGet(P);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(this.promT, PROM_STATE);
      c.i32Const(2);
      c.i32Eq();
      c.localGet(P);
      c.structGet(this.promT, PROM_OBSERVED);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      this.emitReport(c, P, K);
      c.end();
      c.localGet(P);
      c.structGet(this.promT, P_NEXT);
      c.localSet(P);
      c.br(0);
      c.end();
      this.mb.setBody(idx, [this.promRef(), I32], c.bytes());
      return idx;
    });
  }
}
