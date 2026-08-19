/* The timer runtime and the event loop the host pumps: a min-heap of
 * armed timers, a FIFO of immediates, and `%w.tick` — one turn of
 * scr_async.c's `scr_loop_run` with the sleep taken OUT and handed to the
 * embedder (abi.ts's `_tick` contract). Emitted lazily, like every other
 * helper family here: a module that arms no timer gets none of this, and
 * exports no `_tick`.
 *
 * WHY THE LOOP INVERTS. The native runtime owns its own clock: it sleeps
 * to the next deadline and runs what came due. A .wasm module cannot sleep
 * — it has no thread to block and no clock but what the host hands it — so
 * the loop turns inside out. `_tick(now)` runs everything that is due AT
 * `now` and RETURNS the next deadline; the host does the waiting and calls
 * back. The phases inside one call are Node's, in Node's order (microtask
 * checkpoint → due timers → check phase), and the return value is exactly
 * the `due` the C loop would have slept until.
 *
 * PORTED EXACTLY (scr_async.c, and Node's lib/internal/timers.js behind
 * it), because these are the observable rules:
 *
 *   - DELAY COERCION. `!(ms >= 1)` (NaN, negative, sub-millisecond) and
 *     anything past TIMEOUT_MAX (2^31-1, +Infinity included) become 1;
 *     everything else TRUNCATES to integer milliseconds. So 1, 1.8, 1.1
 *     and 0.5 all land in the 1ms bucket and fire in REGISTRATION order.
 *   - ORDER. The heap is keyed on (deadline, seq) with a monotonic seq, so
 *     equal deadlines are FIFO by arm time — including re-armed intervals,
 *     which take a FRESH seq and therefore queue behind timers armed
 *     earlier for the same instant.
 *   - CLEAR IS EAGER. clearTimeout/clearInterval remove the entry from the
 *     heap immediately: a cleared one-hour interval must let the program
 *     exit NOW, not at its next deadline. The reffed COUNT moves with it.
 *   - LIVENESS COUNTS ONLY REF'D WORK. `unref()` drops a timer from the
 *     count that keeps the loop alive; the timer stays ARMED and still
 *     fires if the loop runs on for other reasons. That is why the next
 *     deadline is the earliest of ANY armed timer while the exit decision
 *     reads the reffed counts alone.
 *   - FIRING FLAGS. A timer is OUT of the heap while its callback runs, so
 *     clear/ref/unref/refresh naming the RUNNING timer cannot find it in
 *     the heap; four globals carry those calls to the re-arm that follows
 *     the callback. An interval re-arms to POST-CALLBACK now + period (no
 *     catch-up bursts); `refresh()` re-arms a one-shot to now + its
 *     ORIGINAL delay, which is why the entry stores that delay.
 *   - A THROW KILLS THE PROGRAM. An uncaught exception out of a timer or
 *     immediate callback traps (SEMANTICS.md S007) — and a repeating
 *     interval does NOT re-arm, because the process is already dead.
 *   - THE CHECK PHASE SNAPSHOTS ITS END. Immediates queued BEFORE the
 *     phase run FIFO; ones a callback queues wait for the next turn, so a
 *     setImmediate chain cannot starve timers. Microtasks drain fully
 *     between callbacks.
 *
 * ONE PLACE THIS FOLLOWS NODE AND NOT scr_async.c. The C loop decides
 * unhandled rejections at the top of a checkpoint, and its timers phase
 * only returns there when a callback left MICROTASKS ready (:2079) — so a
 * rejection raised by a timer with no waiters lets the next same-deadline
 * timer run first. Node's `runNextTicks` runs after EVERY timer callback
 * and processes rejections there, so the program dies before that second
 * callback. `_tick` checkpoints after every callback, which is Node's
 * answer; Node is the oracle.
 *
 * THE CLOCK. Arming reads the host's `tsinter.now` import — scr_now_ms()'s
 * place — never `_tick`'s parameter, so a timer armed during `_start` (no
 * tick is running) and one armed inside a callback agree on what time it
 * is. The DUE comparison uses the parameter, exactly as the C loop
 * compares against the `now` it took after its sleep. */
import type { ByteWriter } from "./bytes.js";
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

/** What the runtime needs from the emitter that owns it. */
export interface TimerDeps {
  /** The `() => void` closure pair EVERY timer callback arrives as — the
   * frontend adapts parameterized callbacks through its own wrappers
   * before the libCall, so this runtime only ever calls zero-argument
   * void closures. */
  voidClos: () => { clos: number; fn: number };
  /** `tsinter.now`'s import index (milliseconds, f64). */
  now: () => number;
  /** The exception cell's kind tag: nonzero after a callback means the
   * throw was UNCAUGHT and the program is over (SEMANTICS.md S007). */
  excKind: () => number;
  /** %w.err.reportUncaught() — prints "Uncaught <rendered cell>" to fd 2
   * then traps; never returns. GATE FIX C5's shared reporter (emitter.ts),
   * the same one `_start`'s post-entry check calls — S007's macrotask
   * half gets the identical treatment as its synchronous half. */
  reportUncaught: () => number;
  /** One microtask checkpoint — drain, then the unhandled-rejection
   * report — emitted inline. A module with no promise surface emits
   * nothing here, which is what keeps a timer-only program free of the
   * promise runtime. */
  checkpoint: (c: Code) => void;
}

/* timerT's fields. Deadline, seq and reffed are MUTABLE: a re-armed
 * interval and a refreshed one-shot are the SAME entry re-entering the
 * heap with a new deadline and a new seq (the C runtime copies a value
 * struct; here the identity is free and the closure never moves). */
const T_DEADLINE = 0;
const T_SEQ = 1;
const T_CB = 2;
const T_REPEAT = 3; // 0 = one-shot
const T_ID = 4; // 0 = not clearable (statement-position setTimeout)
const T_REFFED = 5;
const T_DELAY = 6; // the original delay — refresh() re-arms to now + this

/* immT's fields: an intrusive FIFO node. `cb` is nulled by
 * clearImmediate, which is how a cleared entry stays in the list (ids and
 * order unchanged mid-phase) yet never fires and never answers a find. */
const I_CB = 0;
const I_ID = 1;
const I_REFFED = 2;
const I_NEXT = 3;

/** Node's TIMEOUT_MAX. */
const TIMEOUT_MAX = 2147483647;

function initI32(v: number): (w: ByteWriter) => void {
  return (w) => {
    w.u8(0x41);
    w.sleb(v);
  };
}

function initF64(v: number): (w: ByteWriter) => void {
  return (w) => {
    w.u8(0x44);
    w.f64(v);
  };
}

function initNull(typeIndex: number): (w: ByteWriter) => void {
  return (w) => {
    w.u8(0xd0);
    w.sleb(typeIndex);
  };
}

export class TimerBuilder {
  private readonly fns = new Map<string, number>();
  private timerTField: number | null = null;
  private heapTField: number | null = null;
  private immTField: number | null = null;
  private heapG: {
    arr: number;
    len: number;
    seq: number;
    nextId: number;
    reffed: number;
    firingId: number;
    firingCleared: number;
    firingReffed: number;
    firingRefresh: number;
  } | null = null;
  private immG: { head: number; tail: number; nextId: number; pending: number; reffed: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: TimerDeps,
  ) {}

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  private get timerT(): number {
    if (this.timerTField === null) {
      // The closure pair is resolved BEFORE the entry is reserved: a
      // selfStructType's `make` may not intern a type (module.ts).
      const cb: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      this.timerTField = this.mb.selfStructType("%w.timer", () => [
        { storage: F64, mutable: true }, // deadline
        { storage: F64, mutable: true }, // seq
        { storage: cb, mutable: false },
        { storage: F64, mutable: false }, // repeat
        { storage: F64, mutable: false }, // id
        { storage: I32, mutable: true }, // reffed
        { storage: F64, mutable: false }, // delay
      ]);
    }
    return this.timerTField;
  }

  private timerRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.timerT };
  }

  /** The heap's backing store — grown by copy, like the vector runtime. */
  private get heapT(): number {
    this.heapTField ??= this.mb.arrayType(this.timerRef(), true);
    return this.heapTField;
  }

  private heapRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.heapT };
  }

  private get immT(): number {
    if (this.immTField === null) {
      const cb: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      // Same rule as timerT: `cb` above is resolved first, so `make`
      // interns nothing but the entry it is handed.
      this.immTField = this.mb.selfStructType("%w.immediate", (self) => [
        { storage: cb, mutable: true },
        { storage: F64, mutable: false },
        { storage: I32, mutable: true },
        { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true },
      ]);
    }
    return this.immTField;
  }

  private immRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.immT };
  }

  /* ── globals ───────────────────────────────────────────────────────── */

  private g(): NonNullable<typeof this.heapG> {
    if (this.heapG === null) {
      const heapT = this.heapT;
      this.heapG = {
        arr: this.mb.addGlobal(this.heapRef(), true, initNull(heapT)),
        len: this.mb.addGlobal(I32, true, initI32(0)),
        seq: this.mb.addGlobal(F64, true, initF64(0)),
        // Handle ids start at 1 so truthiness narrowing works on a
        // `Timeout | null` binding; setInterval and setTimeoutHandle
        // SHARE the space (clearTimeout of an interval works, like Node).
        nextId: this.mb.addGlobal(F64, true, initF64(1)),
        reffed: this.mb.addGlobal(I32, true, initI32(0)),
        firingId: this.mb.addGlobal(F64, true, initF64(0)),
        firingCleared: this.mb.addGlobal(I32, true, initI32(0)),
        firingReffed: this.mb.addGlobal(I32, true, initI32(0)),
        firingRefresh: this.mb.addGlobal(I32, true, initI32(0)),
      };
    }
    return this.heapG;
  }

  private i(): NonNullable<typeof this.immG> {
    if (this.immG === null) {
      const immT = this.immT;
      this.immG = {
        head: this.mb.addGlobal(this.immRef(), true, initNull(immT)),
        tail: this.mb.addGlobal(this.immRef(), true, initNull(immT)),
        // Immediates ride their OWN id space (clearTimeout of an
        // Immediate is a no-op, like Node); ++seq, so the first is 1.
        nextId: this.mb.addGlobal(F64, true, initF64(0)),
        pending: this.mb.addGlobal(I32, true, initI32(0)),
        reffed: this.mb.addGlobal(I32, true, initI32(0)),
      };
    }
    return this.immG;
  }

  /* ── heap primitives ───────────────────────────────────────────────── */

  /** heap[i] onto the stack. */
  private slot(c: Code, index: () => void): void {
    c.globalGet(this.g().arr);
    index();
    c.arrayGet(this.heapT);
  }

  /** `(deadline, seq)` order — the FIFO-at-equal-deadline rule. */
  private before(): number {
    return this.cached("before", () => {
      const t = this.timerRef();
      const idx = this.mb.declareFunc(this.mb.funcType([t, t], [I32]), "%w.timer.before");
      const c = new Code();
      const A = 0, B = 1;
      c.localGet(A);
      c.structGet(this.timerT, T_DEADLINE);
      c.localGet(B);
      c.structGet(this.timerT, T_DEADLINE);
      c.f64Ne();
      c.ifResult(I32);
      c.localGet(A);
      c.structGet(this.timerT, T_DEADLINE);
      c.localGet(B);
      c.structGet(this.timerT, T_DEADLINE);
      c.f64Lt();
      c.else_();
      c.localGet(A);
      c.structGet(this.timerT, T_SEQ);
      c.localGet(B);
      c.structGet(this.timerT, T_SEQ);
      c.f64Lt();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  private emitSwap(c: Code, I: number, J: number, TMP: number): void {
    const g = this.g();
    this.slot(c, () => c.localGet(I));
    c.localSet(TMP);
    c.globalGet(g.arr);
    c.localGet(I);
    this.slot(c, () => c.localGet(J));
    c.arraySet(this.heapT);
    c.globalGet(g.arr);
    c.localGet(J);
    c.localGet(TMP);
    c.arraySet(this.heapT);
  }

  /** Sifts entry `i` toward the root, answering where it came to rest —
   * removeAt needs that index to sift the same entry back down. */
  private siftUp(): number {
    return this.cached("siftUp", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32], [I32]), "%w.timer.siftUp");
      const before = this.before();
      const c = new Code();
      const I = 0, P = 1, TMP = 2;
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.i32Const(1);
      c.i32ShrU();
      c.localSet(P);
      this.slot(c, () => c.localGet(I));
      this.slot(c, () => c.localGet(P));
      c.call(before);
      c.i32Eqz();
      c.brIf(1);
      this.emitSwap(c, I, P, TMP);
      c.localGet(P);
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(I);
      this.mb.setBody(idx, [I32, this.timerRef()], c.bytes());
      return idx;
    });
  }

  private siftDown(): number {
    return this.cached("siftDown", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32], []), "%w.timer.siftDown");
      const before = this.before();
      const g = this.g();
      const c = new Code();
      const I = 0, L = 1, R = 2, M = 3, TMP = 4;
      c.loop();
      c.localGet(I);
      c.i32Const(1);
      c.i32Shl();
      c.i32Const(1);
      c.i32Add();
      c.localSet(L);
      c.localGet(L);
      c.i32Const(1);
      c.i32Add();
      c.localSet(R);
      c.localGet(I);
      c.localSet(M);
      for (const CHILD of [L, R]) {
        c.localGet(CHILD);
        c.globalGet(g.len);
        c.i32LtS();
        c.ifVoid();
        this.slot(c, () => c.localGet(CHILD));
        this.slot(c, () => c.localGet(M));
        c.call(before);
        c.ifVoid();
        c.localGet(CHILD);
        c.localSet(M);
        c.end();
        c.end();
      }
      c.localGet(M);
      c.localGet(I);
      c.i32Eq();
      c.ifVoid();
      c.return_();
      c.end();
      this.emitSwap(c, I, M, TMP);
      c.localGet(M);
      c.localSet(I);
      c.br(0);
      c.end();
      this.mb.setBody(idx, [I32, I32, I32, this.timerRef()], c.bytes());
      return idx;
    });
  }

  /** Insert, keeping the reffed count in step. */
  private push(): number {
    return this.cached("push", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.timerRef()], []), "%w.timer.push");
      const siftUp = this.siftUp();
      const g = this.g();
      const c = new Code();
      const T = 0, NB = 1;
      c.localGet(T);
      c.structGet(this.timerT, T_REFFED);
      c.ifVoid();
      c.globalGet(g.reffed);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(g.reffed);
      c.end();
      // The store grows by copy — a GC array is fixed-length, so capacity
      // doubles the way the vector runtime's does.
      c.globalGet(g.arr);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(8);
      c.arrayNewDefault(this.heapT);
      c.globalSet(g.arr);
      c.end();
      c.globalGet(g.len);
      c.globalGet(g.arr);
      c.arrayLen();
      c.i32GeS();
      c.ifVoid();
      c.globalGet(g.arr);
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.i32Const(8);
      c.i32Or();
      c.arrayNewDefault(this.heapT);
      c.localSet(NB);
      c.localGet(NB);
      c.i32Const(0);
      c.globalGet(g.arr);
      c.i32Const(0);
      c.globalGet(g.len);
      c.arrayCopy(this.heapT, this.heapT);
      c.localGet(NB);
      c.globalSet(g.arr);
      c.end();
      c.globalGet(g.arr);
      c.globalGet(g.len);
      c.localGet(T);
      c.arraySet(this.heapT);
      c.globalGet(g.len);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(g.len);
      c.globalGet(g.len);
      c.i32Const(1);
      c.i32Sub();
      c.call(siftUp);
      c.drop();
      this.mb.setBody(idx, [this.heapRef()], c.bytes());
      return idx;
    });
  }

  /** The reffed-count decrement guarded exactly as the C runtime guards
   * it (the count is an invariant, not a trusted number). */
  private emitUnreff(c: Code, counter: number): void {
    c.globalGet(counter);
    c.i32Const(0);
    c.i32GtS();
    c.ifVoid();
    c.globalGet(counter);
    c.i32Const(1);
    c.i32Sub();
    c.globalSet(counter);
    c.end();
  }

  private pop(): number {
    return this.cached("pop", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], [this.timerRef()]), "%w.timer.pop");
      const siftDown = this.siftDown();
      const g = this.g();
      const c = new Code();
      const TOP = 0;
      this.slot(c, () => c.i32Const(0));
      c.localSet(TOP);
      c.localGet(TOP);
      c.structGet(this.timerT, T_REFFED);
      c.ifVoid();
      this.emitUnreff(c, g.reffed);
      c.end();
      c.globalGet(g.len);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(g.len);
      c.globalGet(g.arr);
      c.i32Const(0);
      this.slot(c, () => c.globalGet(g.len));
      c.arraySet(this.heapT);
      // Drop the vacated slot's reference: a live tail entry would keep
      // the whole fired prefix reachable for the GC.
      c.globalGet(g.arr);
      c.globalGet(g.len);
      c.refNull(this.timerT);
      c.arraySet(this.heapT);
      c.i32Const(0);
      c.call(siftDown);
      c.localGet(TOP);
      this.mb.setBody(idx, [this.timerRef()], c.bytes());
      return idx;
    });
  }

  private removeAt(): number {
    return this.cached("removeAt", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32], []), "%w.timer.removeAt");
      const siftUp = this.siftUp();
      const siftDown = this.siftDown();
      const g = this.g();
      const c = new Code();
      const I = 0;
      this.slot(c, () => c.localGet(I));
      c.structGet(this.timerT, T_REFFED);
      c.ifVoid();
      this.emitUnreff(c, g.reffed);
      c.end();
      c.globalGet(g.len);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(g.len);
      c.globalGet(g.arr);
      c.localGet(I);
      this.slot(c, () => c.globalGet(g.len));
      c.arraySet(this.heapT);
      c.globalGet(g.arr);
      c.globalGet(g.len);
      c.refNull(this.timerT);
      c.arraySet(this.heapT);
      c.localGet(I);
      c.globalGet(g.len);
      c.i32GeS();
      c.ifVoid();
      c.return_();
      c.end();
      // The moved entry may belong either way — sift up first, then down
      // from wherever that left it (scr_timer_remove_at's shape).
      c.localGet(I);
      c.call(siftUp);
      c.call(siftDown);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** Heap index of the entry with this id, or -1. LINEAR: the corpus
   * arms a handful of timers at a time, and an id→index map would have to
   * be maintained through every sift. */
  private find(): number {
    return this.cached("find", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [I32]), "%w.timer.find");
      const g = this.g();
      const c = new Code();
      const ID = 0, I = 1;
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.globalGet(g.len);
      c.i32GeS();
      c.brIf(1);
      this.slot(c, () => c.localGet(I));
      c.structGet(this.timerT, T_ID);
      c.localGet(ID);
      c.f64Eq();
      c.ifVoid();
      c.localGet(I);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(-1);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** Node's delay coercion (see the header). */
  private coerce(): number {
    return this.cached("coerce", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [F64]), "%w.timer.coerce");
      const c = new Code();
      const MS = 0;
      c.localGet(MS);
      c.f64Const(1);
      c.f64Ge();
      c.i32Eqz();
      c.ifVoid();
      c.f64Const(1);
      c.return_();
      c.end();
      c.localGet(MS);
      c.f64Const(TIMEOUT_MAX);
      c.f64Gt();
      c.ifVoid();
      c.f64Const(1);
      c.return_();
      c.end();
      c.localGet(MS);
      c.f64Trunc();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** arm(cb, ms, repeating, id) — the one entry point behind setTimeout,
   * setTimeoutHandle and setInterval. */
  private arm(): number {
    return this.cached("arm", () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      const idx = this.mb.declareFunc(this.mb.funcType([closRef, F64, I32, F64], []), "%w.timer.arm");
      const coerce = this.coerce();
      const push = this.push();
      const g = this.g();
      const c = new Code();
      const CB = 0, MS = 1, REPEATING = 2, ID = 3;
      c.localGet(MS);
      c.call(coerce);
      c.localSet(MS);
      c.call(this.deps.now());
      c.localGet(MS);
      c.f64Add();
      c.globalGet(g.seq);
      c.localGet(CB);
      c.localGet(REPEATING);
      c.ifResult(F64);
      c.localGet(MS);
      c.else_();
      c.f64Const(0);
      c.end();
      c.localGet(ID);
      c.i32Const(1);
      c.localGet(MS);
      c.structNew(this.timerT);
      c.globalGet(g.seq);
      c.f64Const(1);
      c.f64Add();
      c.globalSet(g.seq);
      c.call(push);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** A fresh handle id (the shared timeout/interval space). */
  private emitMintId(c: Code): void {
    const g = this.g();
    c.globalGet(g.nextId);
    c.globalGet(g.nextId);
    c.f64Const(1);
    c.f64Add();
    c.globalSet(g.nextId);
  }

  /* ── the libCall surface ───────────────────────────────────────────── */

  /** setTimeout in statement position: no handle, so nothing can clear or
   * unref it (id 0). */
  setTimeout(): number {
    return this.cached("setTimeout", () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      const idx = this.mb.declareFunc(this.mb.funcType([closRef, F64], []), "%w.timers.setTimeout");
      const arm = this.arm();
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.i32Const(0);
      c.f64Const(0);
      c.call(arm);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** setTimeout / setInterval WITH a handle. */
  private handleArm(name: string, repeating: boolean): number {
    return this.cached(name, () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      const idx = this.mb.declareFunc(this.mb.funcType([closRef, F64], [F64]), `%w.timers.${name}`);
      const arm = this.arm();
      const c = new Code();
      const CB = 0, MS = 1, ID = 2;
      this.emitMintId(c);
      c.localSet(ID);
      c.localGet(CB);
      c.localGet(MS);
      c.i32Const(repeating ? 1 : 0);
      c.localGet(ID);
      c.call(arm);
      c.localGet(ID);
      this.mb.setBody(idx, [F64], c.bytes());
      return idx;
    });
  }

  setTimeoutHandle(): number {
    return this.handleArm("setTimeoutHandle", false);
  }

  setInterval(): number {
    return this.handleArm("setInterval", true);
  }

  /** The guard every handle op opens with: `!(handle >= 1)` is never a
   * live handle, and Node tolerates those silently. Leaves nothing on the
   * stack; `onBad` emits the early return. */
  private emitHandleGuard(c: Code, onBad: () => void): void {
    c.localGet(0);
    c.f64Const(1);
    c.f64Ge();
    c.i32Eqz();
    c.ifVoid();
    onBad();
    c.return_();
    c.end();
  }

  /** clearTimeout and clearInterval — one function, one id space. */
  clear(): number {
    return this.cached("clear", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], []), "%w.timers.clear");
      const find = this.find();
      const removeAt = this.removeAt();
      const g = this.g();
      const c = new Code();
      const H = 0, I = 1;
      this.emitHandleGuard(c, () => {});
      // Clearing the timer whose callback is RUNNING: it is out of the
      // heap, so the flag carries the decision to the re-arm.
      c.localGet(H);
      c.globalGet(g.firingId);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(1);
      c.globalSet(g.firingCleared);
      c.return_();
      c.end();
      c.localGet(H);
      c.call(find);
      c.localSet(I);
      c.localGet(I);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(I);
      c.call(removeAt);
      c.end();
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** unref()/ref() — loop-liveness bookkeeping; both RETURN the handle so
   * `t.ref().unref()` chains, like Node's Timeout methods. */
  refOp(on: boolean): number {
    return this.cached(on ? "ref" : "unref", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [F64]), `%w.timers.${on ? "ref" : "unref"}`);
      const find = this.find();
      const g = this.g();
      const c = new Code();
      const H = 0, I = 1;
      this.emitHandleGuard(c, () => c.localGet(H));
      c.localGet(H);
      c.globalGet(g.firingId);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(on ? 1 : 0);
      c.globalSet(g.firingReffed);
      c.localGet(H);
      c.return_();
      c.end();
      c.localGet(H);
      c.call(find);
      c.localSet(I);
      c.localGet(I);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      this.slot(c, () => c.localGet(I));
      c.structGet(this.timerT, T_REFFED);
      if (on) c.i32Eqz();
      c.ifVoid();
      this.slot(c, () => c.localGet(I));
      c.i32Const(on ? 1 : 0);
      c.structSet(this.timerT, T_REFFED);
      if (on) {
        c.globalGet(g.reffed);
        c.i32Const(1);
        c.i32Add();
        c.globalSet(g.reffed);
      } else {
        this.emitUnreff(c, g.reffed);
      }
      c.end();
      c.end();
      c.localGet(H);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  hasRef(): number {
    return this.cached("hasRef", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [I32]), "%w.timers.hasRef");
      const find = this.find();
      const g = this.g();
      const c = new Code();
      const H = 0, I = 1;
      this.emitHandleGuard(c, () => c.i32Const(0));
      c.localGet(H);
      c.globalGet(g.firingId);
      c.f64Eq();
      c.ifVoid();
      c.globalGet(g.firingReffed);
      c.return_();
      c.end();
      c.localGet(H);
      c.call(find);
      c.localSet(I);
      c.localGet(I);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(I32);
      this.slot(c, () => c.localGet(I));
      c.structGet(this.timerT, T_REFFED);
      c.else_();
      c.i32Const(0);
      c.end();
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** refresh(): re-arm to now + the ORIGINAL delay. A heap entry leaves
   * and re-enters with a fresh seq (so it queues behind same-deadline
   * timers armed earlier, exactly like a brand-new one); the RUNNING
   * timer sets the flag and `_tick` re-arms after the callback. A
   * one-shot that already fired is gone, and refreshing it is a tolerated
   * no-op where Node would revive it (SEMANTICS.md S011). */
  refresh(): number {
    return this.cached("refresh", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [F64]), "%w.timers.refresh");
      const find = this.find();
      const removeAt = this.removeAt();
      const push = this.push();
      const g = this.g();
      const c = new Code();
      const H = 0, I = 1, T = 2;
      this.emitHandleGuard(c, () => c.localGet(H));
      c.localGet(H);
      c.globalGet(g.firingId);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(1);
      c.globalSet(g.firingRefresh);
      c.localGet(H);
      c.return_();
      c.end();
      c.localGet(H);
      c.call(find);
      c.localSet(I);
      c.localGet(I);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      this.slot(c, () => c.localGet(I));
      c.localSet(T);
      c.localGet(I);
      c.call(removeAt);
      c.localGet(T);
      c.call(this.deps.now());
      c.localGet(T);
      c.structGet(this.timerT, T_DELAY);
      c.f64Add();
      c.structSet(this.timerT, T_DEADLINE);
      c.localGet(T);
      c.globalGet(g.seq);
      c.structSet(this.timerT, T_SEQ);
      c.globalGet(g.seq);
      c.f64Const(1);
      c.f64Add();
      c.globalSet(g.seq);
      c.localGet(T);
      c.call(push);
      c.end();
      c.localGet(H);
      this.mb.setBody(idx, [I32, this.timerRef()], c.bytes());
      return idx;
    });
  }

  /* ── immediates (Node's check phase) ───────────────────────────────── */

  /** The queued, UNCLEARED immediate with this id, or null — a fired one
   * has already left the list, so every handle op on it no-ops. */
  private immFind(): number {
    return this.cached("immFind", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [this.immRef()]), "%w.imm.find");
      const i = this.i();
      const c = new Code();
      const H = 0, N = 1;
      c.globalGet(i.head);
      c.localSet(N);
      c.block();
      c.loop();
      c.localGet(N);
      c.refIsNull();
      c.brIf(1);
      c.localGet(N);
      c.structGet(this.immT, I_ID);
      c.localGet(H);
      c.f64Eq();
      c.localGet(N);
      c.structGet(this.immT, I_CB);
      c.refIsNull();
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(N);
      c.return_();
      c.end();
      c.localGet(N);
      c.structGet(this.immT, I_NEXT);
      c.localSet(N);
      c.br(0);
      c.end();
      c.end();
      c.refNull(this.immT);
      this.mb.setBody(idx, [this.immRef()], c.bytes());
      return idx;
    });
  }

  setImmediate(): number {
    return this.cached("setImmediate", () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      const idx = this.mb.declareFunc(this.mb.funcType([closRef], [F64]), "%w.timers.setImmediate");
      const i = this.i();
      const c = new Code();
      const CB = 0, ID = 1, N = 2;
      c.globalGet(i.nextId);
      c.f64Const(1);
      c.f64Add();
      c.localSet(ID);
      c.localGet(ID);
      c.globalSet(i.nextId);
      c.localGet(CB);
      c.localGet(ID);
      c.i32Const(1);
      c.refNull(this.immT);
      c.structNew(this.immT);
      c.localSet(N);
      c.globalGet(i.tail);
      c.refIsNull();
      c.ifVoid();
      c.localGet(N);
      c.globalSet(i.head);
      c.else_();
      c.globalGet(i.tail);
      c.localGet(N);
      c.structSet(this.immT, I_NEXT);
      c.end();
      c.localGet(N);
      c.globalSet(i.tail);
      c.globalGet(i.pending);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(i.pending);
      c.globalGet(i.reffed);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(i.reffed);
      c.localGet(ID);
      this.mb.setBody(idx, [F64, this.immRef()], c.bytes());
      return idx;
    });
  }

  clearImmediate(): number {
    return this.cached("clearImmediate", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], []), "%w.timers.clearImmediate");
      const find = this.immFind();
      const i = this.i();
      const c = new Code();
      const H = 0, N = 1;
      this.emitHandleGuard(c, () => {});
      c.localGet(H);
      c.call(find);
      c.localSet(N);
      c.localGet(N);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      // The node stays in the list with a NULL callback: ids and order
      // survive a clear that happens mid-phase.
      c.localGet(N);
      c.refNull(this.deps.voidClos().clos);
      c.structSet(this.immT, I_CB);
      this.emitUnreff(c, i.pending);
      c.localGet(N);
      c.structGet(this.immT, I_REFFED);
      c.ifVoid();
      c.localGet(N);
      c.i32Const(0);
      c.structSet(this.immT, I_REFFED);
      this.emitUnreff(c, i.reffed);
      c.end();
      this.mb.setBody(idx, [this.immRef()], c.bytes());
      return idx;
    });
  }

  /** The Immediate ref trio — the Timeout trio's story over the queue. */
  immRefOp(on: boolean): number {
    return this.cached(on ? "immRef" : "immUnref", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([F64], [F64]),
        `%w.timers.immediate${on ? "Ref" : "Unref"}`,
      );
      const find = this.immFind();
      const i = this.i();
      const c = new Code();
      const H = 0, N = 1;
      this.emitHandleGuard(c, () => c.localGet(H));
      c.localGet(H);
      c.call(find);
      c.localSet(N);
      c.localGet(N);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(N);
      c.structGet(this.immT, I_REFFED);
      if (on) c.i32Eqz();
      c.ifVoid();
      c.localGet(N);
      c.i32Const(on ? 1 : 0);
      c.structSet(this.immT, I_REFFED);
      if (on) {
        c.globalGet(i.reffed);
        c.i32Const(1);
        c.i32Add();
        c.globalSet(i.reffed);
      } else {
        this.emitUnreff(c, i.reffed);
      }
      c.end();
      c.end();
      c.localGet(H);
      this.mb.setBody(idx, [this.immRef()], c.bytes());
      return idx;
    });
  }

  immHasRef(): number {
    return this.cached("immHasRef", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [I32]), "%w.timers.immediateHasRef");
      const find = this.immFind();
      const c = new Code();
      const H = 0, N = 1;
      this.emitHandleGuard(c, () => c.i32Const(0));
      c.localGet(H);
      c.call(find);
      c.localSet(N);
      c.localGet(N);
      c.refIsNull();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(N);
      c.structGet(this.immT, I_REFFED);
      c.end();
      this.mb.setBody(idx, [this.immRef()], c.bytes());
      return idx;
    });
  }

  /* ── the pump ──────────────────────────────────────────────────────── */

  /** Invoke a `() => void` closure sitting in local `L`. */
  private emitCall(c: Code, L: number, field: number, structT: number): void {
    const pair = this.deps.voidClos();
    c.localGet(L);
    c.structGet(structT, field); // arg0: the closure itself
    c.localGet(L);
    c.structGet(structT, field);
    c.structGet(pair.clos, 0);
    c.callRef(pair.fn);
  }

  /** An uncaught throw out of a callback ends the program: the trap IS
   * this tier's exit-1 channel (SEMANTICS.md S007). GATE FIX C5: reports
   * before it traps, same as `_start`'s own post-entry check — the two
   * are `_tick`'s and %main's halves of the same S007 uncaught path, and
   * now share the same reporter. */
  private emitDeathCheck(c: Code): void {
    c.globalGet(this.deps.excKind());
    c.ifVoid();
    c.call(this.deps.reportUncaught());
    c.end();
  }

  /** `%w.tick(now) -> next` — ONE loop turn (see the header). The return
   * is the `due` the C loop would sleep until: a deadline in the future,
   * `now` itself when there is ready work (immediates), or -1 when
   * nothing ref'd is left and the program is over. */
  tick(): number {
    return this.cached("tick", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [F64]), "%w.tick");
      const pop = this.pop();
      const push = this.push();
      const g = this.g();
      const i = this.i();
      const c = new Code();
      const NOW = 0, T = 1, N = 2, END = 3;

      // 1. The checkpoint: microtasks to exhaustion, then the
      // unhandled-rejection decision — Node's order, at the END of a
      // complete checkpoint and BEFORE advancing to timers.
      this.deps.checkpoint(c);

      // 2. The timers phase. Each callback is followed by its own
      // checkpoint, so a promise settled by a timer resumes before the
      // NEXT timer fires.
      c.block();
      c.loop();
      c.globalGet(g.len);
      c.i32Eqz();
      c.brIf(1);
      this.slot(c, () => c.i32Const(0));
      c.structGet(this.timerT, T_DEADLINE);
      c.localGet(NOW);
      c.f64Gt();
      c.brIf(1);
      c.call(pop);
      c.localSet(T);
      // The entry is OUT of the heap while its callback runs; the flags
      // carry clear/ref/unref/refresh of its own id to the re-arm.
      c.localGet(T);
      c.structGet(this.timerT, T_ID);
      c.f64Const(0);
      c.f64Ne();
      c.ifVoid();
      c.localGet(T);
      c.structGet(this.timerT, T_ID);
      c.globalSet(g.firingId);
      c.i32Const(0);
      c.globalSet(g.firingCleared);
      c.localGet(T);
      c.structGet(this.timerT, T_REFFED);
      c.globalSet(g.firingReffed);
      c.i32Const(0);
      c.globalSet(g.firingRefresh);
      c.end();
      this.emitCall(c, T, T_CB, this.timerT);
      // Re-arm — never after a throw: the process is already dead, so a
      // repeating interval does not get another tick.
      c.localGet(T);
      c.structGet(this.timerT, T_ID);
      c.f64Const(0);
      c.f64Ne();
      c.globalGet(g.firingCleared);
      c.i32Eqz();
      c.i32And();
      c.globalGet(this.deps.excKind());
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      {
        const rearm = (delay: () => void): void => {
          c.localGet(T);
          c.call(this.deps.now());
          delay();
          c.f64Add();
          c.structSet(this.timerT, T_DEADLINE);
          c.localGet(T);
          c.globalGet(g.seq);
          c.structSet(this.timerT, T_SEQ);
          c.globalGet(g.seq);
          c.f64Const(1);
          c.f64Add();
          c.globalSet(g.seq);
          // The ref state carries across ticks: a self-unref'd interval
          // stays unref'd.
          c.localGet(T);
          c.globalGet(g.firingReffed);
          c.structSet(this.timerT, T_REFFED);
          c.localGet(T);
          c.call(push);
        };
        c.localGet(T);
        c.structGet(this.timerT, T_REPEAT);
        c.f64Const(0);
        c.f64Gt();
        c.ifVoid();
        // An interval re-arms relative to the POST-callback clock — no
        // catch-up burst after a slow callback (libuv's uv_timer repeat).
        rearm(() => {
          c.localGet(T);
          c.structGet(this.timerT, T_REPEAT);
        });
        c.else_();
        c.globalGet(g.firingRefresh);
        c.ifVoid();
        rearm(() => {
          c.localGet(T);
          c.structGet(this.timerT, T_DELAY);
        });
        c.end();
        c.end();
      }
      c.end();
      c.f64Const(0);
      c.globalSet(g.firingId);
      this.emitDeathCheck(c);
      this.deps.checkpoint(c);
      c.br(0);
      c.end();
      c.end();

      // 3. The check phase: immediates queued BEFORE it run FIFO; ones a
      // callback queues wait for the next turn, so a setImmediate chain
      // cannot starve the timers phase.
      c.globalGet(i.pending);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.globalGet(i.tail);
      c.localSet(END);
      c.block();
      c.loop();
      c.globalGet(i.head);
      c.refIsNull();
      c.brIf(1);
      c.globalGet(i.head);
      c.localSet(N);
      c.localGet(N);
      c.structGet(this.immT, I_NEXT);
      c.globalSet(i.head);
      c.globalGet(i.head);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.immT);
      c.globalSet(i.tail);
      c.end();
      c.localGet(N);
      c.refNull(this.immT);
      c.structSet(this.immT, I_NEXT);
      c.localGet(N);
      c.structGet(this.immT, I_CB);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      this.emitUnreff(c, i.pending);
      c.localGet(N);
      c.structGet(this.immT, I_REFFED);
      c.ifVoid();
      c.localGet(N);
      c.i32Const(0);
      c.structSet(this.immT, I_REFFED);
      this.emitUnreff(c, i.reffed);
      c.end();
      this.emitCall(c, N, I_CB, this.immT);
      this.emitDeathCheck(c);
      this.deps.checkpoint(c);
      c.end();
      c.localGet(N);
      c.localGet(END);
      c.refEq();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      c.end();

      // 4. The answer. Liveness counts only REF'D work: parked promise
      // frames and unref'd timers never hold the loop, and armed-but-
      // unref'd timers left behind simply drop (scr_timers_teardown).
      c.globalGet(g.reffed);
      c.i32Eqz();
      c.globalGet(i.reffed);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.f64Const(-1);
      c.return_();
      c.end();
      // Pending immediates are always-ready work: no sleep.
      c.globalGet(i.pending);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(NOW);
      c.return_();
      c.end();
      // The earliest ARMED deadline — any timer, ref'd or not (an unref'd
      // one fires when the loop lives for other reasons).
      c.globalGet(g.len);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      this.slot(c, () => c.i32Const(0));
      c.structGet(this.timerT, T_DEADLINE);
      c.return_();
      c.end();
      c.f64Const(-1);
      this.mb.setBody(idx, [this.timerRef(), this.immRef(), this.immRef()], c.bytes());
      return idx;
    });
  }
}
