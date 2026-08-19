/* The node:events EventEmitter registry over WasmGC — scr_events_emitter.c
 * ported. THE ABI DECISION (scratchpad/listener-abi-decision.md, approved
 * by the stage lead): every listener normalizes to a `{clos: eq, thunk:
 * (ref thunkSig)}` pair via the EXISTING dyn.ts machinery (thunkSig /
 * dynFnThunk / dynFromHelper — built for the unrelated JS-lane checked-
 * dynamic surface, reused wholesale here), so the registry is ONE shared
 * bucket/entry struct family for every event whose tuple is dyn-
 * representable. This file owns PURE RUNTIME STRUCTURE ONLY: it never
 * touches an IrType or a closure's own signature — every (clos, thunk)
 * pair it stores was already built by the caller (emitter.ts's
 * type-directed dispatch), mirroring how nexttick.ts's queue never looks
 * inside the closures it runs.
 *
 * REACHABILITY (stated once so it does not need repeating at every call
 * site): a listener's thunk unboxes its declared-prefix parameters out of
 * the dyn args array via dynCheckHelper, which THROWS on a kind mismatch
 * — but that throw is structurally UNREACHABLE for every entry this
 * registry ever builds. The frontend's mergeListener/lowerListenerArg
 * (lower-emitter.ts) enforce byte-exact typeEquals between a listener's
 * declared prefix and the program-unified event tuple's corresponding
 * positions, and every emit site boxes tuple[i] through
 * dynFromHelper(tuple[i]) — the SAME type on both sides of every box/
 * unbox pair this registry ever exercises, and dynFromHelper(T) ->
 * dynCheckHelper(T) is a sound round-trip on that pair by the two
 * helpers' own mutual construction.
 *
 * STAGE-A SCOPE (as landed — this paragraph was stale at the gate,
 * describing the mid-stage state; the lead's spot-read corrected it at
 * landing, which is its own argument for reading headers against the
 * code below them): BUILT here — the general (dyn-array) bucket family
 * (on/addListener with once AND prepend honored, emit's snapshot
 * dispatch, off/removeListener with orig-identity for dyn-registered
 * listeners, listenerCount both forms, eventNames, removeAllListeners
 * named/whole with the meta-aware LIFO ordering), the meta events
 * (newListener before add, removeListener after each removal), the
 * dedicated 'error' bucket family (real-reference thunks, no dyn box —
 * the ABI note's "one exception"), and the maxListeners surface with its
 * Chk ladders. NOT built — named, not silently missing: the leak
 * warning and listeners()/rawListeners() (no corpus program can
 * execution-pin either today: 1677's first blocker is
 * libCall:emitter.listeners but it also needs node:assert behind that,
 * and the warning's pid-bearing text is unpinnable on exit-0 stderr —
 * the S-entry drafts for both native divergences sit unfiled in the
 * session archive until the code exists), and shape-mode reservation.
 * STAGE-B UPDATE: stream construction does NOT reserve shape-mode keys
 * either, despite REG_SHAPE existing for exactly that — stage B's claim
 * set lost its only shape-mode-observing program (2626) to the Writable-
 * contamination ruling (its `new Writable`/`new Duplex` siblings pushed
 * it to stage C), so nothing left in-tier can execution-pin the
 * reservation machinery or the eventNames() error-bucket merge shape
 * mode needs. Both land together whenever 2626 becomes claimable (stage
 * C, once Writable exists) — REG_SHAPE stays reserved-but-0 until then.
 *
 * SNAPSHOT DISPATCH NEEDS NO MANUAL REFCOUNTING under WasmGC: a snapshot
 * array of entry REFERENCES keeps every entry it holds alive regardless
 * of concurrent removal from the live list. A listener throw stops the
 * pass (C's cooperative "check pending, skip, continue" loop collapses to
 * one `break`, since GC leaves nothing to unref on the skipped tail).
 *
 * EXECUTION-PIN DISCIPLINE (the standing rule after a fence branch shipped
 * as invalid wasm from being only typechecked): every arm here is
 * exercised by an actual compiled-and-run corpus program before being
 * reported claimed. */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/** `$eeReg`'s field indices. */
export const REG_HEAD = 0;
export const REG_ERRBUCKET = 1;
export const REG_MAX = 2;
export const REG_SHAPE = 3;

/** `$eeBucketErr`'s field indices — the 'error' event's dedicated,
 * direct-reference family (no `name`/`next`: at most one per registry,
 * referenced straight off `$eeReg.errBucket` — see the file's ABI note). */
export const BUCKETERR_EHEAD = 0;
export const BUCKETERR_ETAIL = 1;
export const BUCKETERR_N = 2;
export const BUCKETERR_WARNED = 3;

/** `$eeEntryErr`'s field indices. */
export const ENTRYERR_CLOS = 0;
export const ENTRYERR_THUNK = 1;
export const ENTRYERR_ORIG = 2;
export const ENTRYERR_ONCE = 3;
export const ENTRYERR_FIRED = 4;
export const ENTRYERR_NEXT = 5;

/** `$eeBucket`'s field indices (the general, dyn-array-dispatched family). */
export const BUCKET_NAME = 0;
export const BUCKET_EHEAD = 1;
export const BUCKET_ETAIL = 2;
export const BUCKET_N = 3;
export const BUCKET_WARNED = 4;
export const BUCKET_NEXT = 5;

/** `$eeEntry`'s field indices. */
export const ENTRY_CLOS = 0;
export const ENTRY_THUNK = 1;
export const ENTRY_ORIG = 2;
export const ENTRY_ONCE = 3;
export const ENTRY_FIRED = 4;
export const ENTRY_NEXT = 5;

/** The emitter ROOT struct's own two injected fields, past `vt` — the
 * WasmGC nominal-supertype translation of C's ScrEmitter prefix (registry
 * pointer, display-name slot). classes.ts's gate lift places these at
 * indices 1/2 on every emitter-rooted class's struct (root AND every
 * descendant re-declare the identical prefix, exactly like `vt` itself —
 * wasm subtyping requires the repeat). */
export const EMITTER_REG = 1;
export const EMITTER_NAME = 2;
export const EMITTER_PREFIX_FIELDS = 2;

export interface EventsDeps {
  strRef: () => ValType;
  strEq: () => number;
  /** dyn.ts's uniform call-glue signature — `(clos: eq, args: dyn[]) ->
   * dyn` — reused verbatim as the entry's own thunk type. */
  thunkSig: () => number;
  dynArrRef: () => ValType;
  /** The emitter ROOT's own struct — every general helper's "receiver"
   * parameter, so ONE function serves every emitter-rooted class (a
   * subclass struct is a wasm SUBTYPE and upcasts for free). */
  rootRef: () => ValType;
  rootStruct: () => number;
  excKind: () => number;
  /** A fresh `string[]` vector (arrays.ts) — the SAME VecInfo the
   * ordinary `eventNames(): string[]` return type maps to, so the
   * libCall answers exactly the wasm type its declared IR return type
   * already expects. */
  stringVecRef: () => ValType;
  stringVecNewLen: () => number;
  stringVecPushOne: () => number;
  /** The shared builtin-error struct (`class:err`) — every error-rooted
   * class (the five builtins, every user `extends Error`) subtypes it, so
   * one nullable ref names every 'error' payload this tier can build.
   * The 'error' bucket's thunk takes it DIRECTLY (no dyn box — the file
   * header's "one exception"). */
  errRef: () => ValType;
  /** %w.f64ToStr — renders a number for the maxListeners ladder's
   * "Received <n>" tail (oracle-measured, scr_f64_to_str's twin). */
  f64ToStr: () => number;
  /** %w.concat — the ladder messages' builder. */
  concat: () => number;
  /** Push an interned string literal onto `c`'s stack. */
  lit: (c: Code, s: string) => void;
  /** dyn.ts's boxStr — boxes a raw string ref into a dyn STR value, for
   * the meta-events' one-string tuple (newListener/removeListener). */
  boxStr: (c: Code, pushValue: (c: Code) => void) => void;
  /** The dyn args vector's raw buffer array type and outer struct type
   * (arrays.ts's VecInfo, the SAME one dyn.ts's ARR payload and every
   * `emitter.emit` call site use) — needed here to build the meta
   * events' own one-element args vector directly. */
  dynArrBufType: () => number;
  dynArrStructType: () => number;
  /** Fill the exception cell with a fresh coded error; the CALLER (an
   * ordinary walked function, which has `this.fn`/emitPendingCheck)
   * unwinds — these hand-built functions just `return_()` immediately
   * after, matching every other may-throw helper's contract in this
   * backend. */
  throwCoded: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, code: string) => void;
}

export class EventsBuilder {
  private readonly fns = new Map<string, number>();
  private regTField: number | null = null;
  private bucketTField: number | null = null;
  private entryTField: number | null = null;
  private bucketErrTField: number | null = null;
  private entryErrTField: number | null = null;
  private errThunkSigField: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: EventsDeps,
  ) {}

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** The SELF/MUTUALLY-RECURSIVE twin of `cached`: some pairs here call
   * each other while being built (emitDispatch's once-removal reaches
   * unlinkEntry, which fires 'removeListener' through fireMetaHelper,
   * which calls emitDispatch AGAIN to dispatch the meta event itself) —
   * `cached` only records the index once `build` fully RETURNS, so a
   * reentrant call during that same build sees no cache entry yet and
   * recurses into building a SECOND copy, forever (a real bug this
   * caught: `Maximum call stack size exceeded` at TS-compile time, not
   * a wasm-runtime issue — nothing had run yet). This caches the index
   * the moment `declareFunc` reserves it, BEFORE `build` runs, so a
   * reentrant lookup resolves to the reservation instead of recursing. */
  private cachedRecursive(name: string, declare: () => number, build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = declare();
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  entryT(): number {
    if (this.entryTField !== null) return this.entryTField;
    const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.thunkSig() };
    this.entryTField = this.mb.selfStructType("%w.ee.entry", (self) => [
      { storage: EQ_REF, mutable: false }, // ENTRY_CLOS
      { storage: thunkRef, mutable: false }, // ENTRY_THUNK
      { storage: EQ_REF, mutable: false }, // ENTRY_ORIG
      { storage: I32, mutable: false }, // ENTRY_ONCE
      { storage: I32, mutable: true }, // ENTRY_FIRED
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // ENTRY_NEXT
    ]);
    return this.entryTField;
  }

  entryRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.entryT() };
  }

  bucketT(): number {
    if (this.bucketTField !== null) return this.bucketTField;
    const entryRef = this.entryRef();
    this.bucketTField = this.mb.selfStructType("%w.ee.bucket", (self) => [
      { storage: this.deps.strRef(), mutable: false }, // BUCKET_NAME
      { storage: entryRef, mutable: true }, // BUCKET_EHEAD
      { storage: entryRef, mutable: true }, // BUCKET_ETAIL
      { storage: I32, mutable: true }, // BUCKET_N
      { storage: I32, mutable: true }, // BUCKET_WARNED
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // BUCKET_NEXT
    ]);
    return this.bucketTField;
  }

  bucketRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bucketT() };
  }

  /** `errThunkSig` — the 'error' bucket's OWN uniform call-glue: `(clos:
   * eq, err: errRef) -> void`, taking the real error reference directly
   * (no dyn box — the file header's "one exception"). */
  errThunkSig(): number {
    this.errThunkSigField ??= this.mb.funcType([EQ_REF, this.deps.errRef()], []);
    return this.errThunkSigField;
  }

  entryErrT(): number {
    if (this.entryErrTField !== null) return this.entryErrTField;
    const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.errThunkSig() };
    this.entryErrTField = this.mb.selfStructType("%w.ee.entryErr", (self) => [
      { storage: EQ_REF, mutable: false }, // ENTRYERR_CLOS
      { storage: thunkRef, mutable: false }, // ENTRYERR_THUNK
      { storage: EQ_REF, mutable: false }, // ENTRYERR_ORIG
      { storage: I32, mutable: false }, // ENTRYERR_ONCE
      { storage: I32, mutable: true }, // ENTRYERR_FIRED
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // ENTRYERR_NEXT
    ]);
    return this.entryErrTField;
  }

  entryErrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.entryErrT() };
  }

  bucketErrT(): number {
    if (this.bucketErrTField !== null) return this.bucketErrTField;
    const entryRef = this.entryErrRef();
    this.bucketErrTField = this.mb.structType([
      { storage: entryRef, mutable: true }, // BUCKETERR_EHEAD
      { storage: entryRef, mutable: true }, // BUCKETERR_ETAIL
      { storage: I32, mutable: true }, // BUCKETERR_N
      { storage: I32, mutable: true }, // BUCKETERR_WARNED
    ]);
    return this.bucketErrTField;
  }

  bucketErrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bucketErrT() };
  }

  regT(): number {
    if (this.regTField !== null) return this.regTField;
    this.regTField = this.mb.structType([
      { storage: this.bucketRef(), mutable: true }, // REG_HEAD
      { storage: this.bucketErrRef(), mutable: true }, // REG_ERRBUCKET
      { storage: F64, mutable: true }, // REG_MAX
      { storage: I32, mutable: true }, // REG_SHAPE
    ]);
    return this.regTField;
  }

  regRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.regT() };
  }

  /* ── registry / bucket lookup ──────────────────────────────────────── */

  /** `(root) -> reg` — lazily allocates {head:null, errBucket:null,
   * max:-1, shape:0} and stores it back into the root's own registry
   * field, matching scr_ee_reg_ensure. */
  regEnsure(): number {
    return this.cached("regEnsure", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [this.regRef()]), "%w.ee.regEnsure");
      const c = new Code();
      const R = 0, N = 1;
      c.localGet(R);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.bucketT());
      c.refNull(this.bucketErrT());
      c.f64Const(-1);
      c.i32Const(0);
      c.structNew(this.regT());
      c.localSet(N);
      c.localGet(R);
      c.localGet(N);
      c.structSet(this.deps.rootStruct(), EMITTER_REG);
      c.end();
      c.localGet(R);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      this.mb.setBody(idx, [this.regRef()], c.bytes());
      return idx;
    });
  }

  /** `(reg, name) -> bucket-or-null` — scr_ee_bucket_find. `reg` may be
   * null (an emitter that never registered anything). */
  bucketFind(): number {
    return this.cached("bucketFind", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.regRef(), this.deps.strRef()], [this.bucketRef()]),
        "%w.ee.bucketFind",
      );
      const c = new Code();
      const REG = 0, NAME = 1, B = 2;
      c.localGet(REG);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.bucketT());
      c.return_();
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_HEAD);
      c.localSet(B);
      c.loop();
      c.localGet(B);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.bucketT());
      c.return_();
      c.end();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NAME);
      c.localGet(NAME);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.localGet(B);
      c.return_();
      c.end();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.localSet(B);
      c.br(0);
      c.end();
      c.unreachable();
      this.mb.setBody(idx, [this.bucketRef()], c.bytes());
      return idx;
    });
  }

  /** `(reg, name) -> bucket` — find-or-create, appending at the tail of
   * `reg.head` (bucket order IS eventNames() order — scr_ee_bucket_ensure). */
  bucketEnsure(): number {
    return this.cached("bucketEnsure", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.regRef(), this.deps.strRef()], [this.bucketRef()]),
        "%w.ee.bucketEnsure",
      );
      const c = new Code();
      const REG = 0, NAME = 1, B = 2, N = 3;
      c.localGet(REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localTee(B);
      c.refIsNull();
      c.ifVoid();
      c.localGet(NAME);
      c.refNull(this.entryT());
      c.refNull(this.entryT());
      c.i32Const(0);
      c.i32Const(0);
      c.refNull(this.bucketT());
      c.structNew(this.bucketT());
      c.localSet(N);
      // Append at the tail: an empty list makes N the new head.
      c.localGet(REG);
      c.structGet(this.regT(), REG_HEAD);
      c.refIsNull();
      c.ifVoid();
      c.localGet(REG);
      c.localGet(N);
      c.structSet(this.regT(), REG_HEAD);
      c.else_();
      c.localGet(REG);
      c.structGet(this.regT(), REG_HEAD);
      c.localSet(B);
      c.loop();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.refIsNull();
      c.ifVoid();
      c.localGet(B);
      c.localGet(N);
      c.structSet(this.bucketT(), BUCKET_NEXT);
      c.else_();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.localSet(B);
      c.br(1);
      c.end(); // end inner if/else (next == null?)
      c.end(); // end loop
      c.end(); // end outer if/else (REG_HEAD == null?)
      c.localGet(N);
      c.localSet(B);
      c.end(); // end outermost if (bucket not found)
      c.localGet(B);
      this.mb.setBody(idx, [this.bucketRef(), this.bucketRef()], c.bytes());
      return idx;
    });
  }

  /** Drops an emptied bucket from `reg.head` (Node deletes the _events
   * key — scr_ee_bucket_drop). `b` is known present in the chain. */
  bucketDrop(): number {
    return this.cached("bucketDrop", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.regRef(), this.bucketRef()], []), "%w.ee.bucketDrop");
      const c = new Code();
      const REG = 0, B = 1, CUR = 2;
      c.localGet(REG);
      c.structGet(this.regT(), REG_HEAD);
      c.localGet(B);
      c.refEq();
      c.ifVoid();
      c.localGet(REG);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.structSet(this.regT(), REG_HEAD);
      c.return_();
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_HEAD);
      c.localSet(CUR);
      c.loop();
      c.localGet(CUR);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.localGet(B);
      c.refEq();
      c.ifVoid();
      c.localGet(CUR);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.structSet(this.bucketT(), BUCKET_NEXT);
      c.return_();
      c.end();
      c.localGet(CUR);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      this.mb.setBody(idx, [this.bucketRef()], c.bytes());
      return idx;
    });
  }

  /* ── the meta events ('newListener' / 'removeListener') ────────────── */

  /** `(root, affectedName) -> void` — fires ONE meta event (scr_ee_emit_
   * meta): the affected event's NAME as the whole one-string tuple,
   * through the SAME general dispatch (`emitDispatch`) any other event
   * uses — meta events are ordinary string-tuple events, never
   * special-cased at the bucket/entry level. Unconditional: an empty or
   * absent meta bucket is exactly what `emitDispatch` already no-ops on,
   * so there is no separate "has listener" gate to keep in sync with it. */
  private fireMetaHelper(metaLit: "newListener" | "removeListener"): number {
    return this.cached(`fireMeta:${metaLit}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.strRef()], []), `%w.ee.fireMeta.${metaLit}`);
      const c = new Code();
      const ROOT = 0, NAME = 1, ARR = 2;
      c.i32Const(1);
      this.deps.boxStr(c, (x) => x.localGet(NAME));
      c.arrayNewFixed(this.deps.dynArrBufType(), 1);
      c.structNew(this.deps.dynArrStructType());
      c.localSet(ARR);
      c.localGet(ROOT);
      this.deps.lit(c, metaLit);
      c.localGet(ARR);
      c.call(this.emitDispatch());
      c.drop(); // hadListeners is not observed here
      this.mb.setBody(idx, [this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  /* ── add (general family) ──────────────────────────────────────────── */

  /** `(root, name, clos, thunk, once, prepend) -> void` — registers a
   * listener (scr_ee_add's insert half). `newListener` fires BEFORE the
   * add (Node's order — the listener count it reads is still the OLD
   * one); leak-warning is NOT yet built — see the file header. `once`/
   * `prepend` are compile-time constants at the plain `emitter.on` call
   * site (boolLit) but genuine runtime values at the shared onDyn
   * helper's call site — accepted as plain i32 either way. */
  entryAppend(): number {
    return this.cached("entryAppend", () => {
      const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.thunkSig() };
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.deps.rootRef(), this.deps.strRef(), EQ_REF, thunkRef, EQ_REF, I32, I32], []),
        "%w.ee.entryAppend",
      );
      const c = new Code();
      const ROOT = 0, NAME = 1, CLOS = 2, THUNK = 3, ORIG = 4, ONCE = 5, PREPEND = 6, REG = 7, B = 8, E = 9;
      c.localGet(ROOT);
      c.call(this.regEnsure());
      c.localSet(REG);
      // newListener BEFORE the add (Node's order — a listener reading
      // listenerCount(name) here still sees the OLD count). A throw
      // inside a newListener handler leaves the exception pending but
      // the add still happens (Node's addListener has no try around it).
      c.localGet(ROOT);
      c.localGet(NAME);
      c.call(this.fireMetaHelper("newListener"));
      c.localGet(REG);
      c.localGet(NAME);
      c.call(this.bucketEnsure());
      c.localSet(B);
      c.localGet(CLOS);
      c.localGet(THUNK);
      c.localGet(ORIG);
      c.localGet(ONCE);
      c.i32Const(0);
      c.refNull(this.entryT());
      c.structNew(this.entryT());
      c.localSet(E);
      c.localGet(PREPEND);
      c.ifVoid();
      // Prepend: empty bucket makes E both ends; otherwise E.next = old
      // head, head = E.
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.refIsNull();
      c.ifVoid();
      c.localGet(B);
      c.localGet(E);
      c.structSet(this.bucketT(), BUCKET_ETAIL);
      c.else_();
      c.localGet(E);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.structSet(this.entryT(), ENTRY_NEXT);
      c.end();
      c.localGet(B);
      c.localGet(E);
      c.structSet(this.bucketT(), BUCKET_EHEAD);
      c.else_();
      // Append: bucket.eTail == null ⇒ empty bucket, E becomes both ends.
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_ETAIL);
      c.refIsNull();
      c.ifVoid();
      c.localGet(B);
      c.localGet(E);
      c.structSet(this.bucketT(), BUCKET_EHEAD);
      c.else_();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_ETAIL);
      c.localGet(E);
      c.structSet(this.entryT(), ENTRY_NEXT);
      c.end();
      c.localGet(B);
      c.localGet(E);
      c.structSet(this.bucketT(), BUCKET_ETAIL);
      c.end();
      c.localGet(B);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_N);
      c.i32Const(1);
      c.i32Add();
      c.structSet(this.bucketT(), BUCKET_N);
      this.mb.setBody(idx, [this.regRef(), this.bucketRef(), this.entryRef()], c.bytes());
      return idx;
    });
  }

  /** Unlinks ONE entry (known present, matched by IDENTITY) from its
   * bucket's live list — the once-wrapper's own removal (scr_ee_remove_
   * at): unlink, drop the bucket if it emptied (shape mode is not yet
   * built — see the file header — so this ALWAYS drops, matching a plain
   * emitter), THEN fire 'removeListener' with the bucket's name — read
   * BEFORE the possible drop, Node's own order (scr_ee_remove_at retains
   * the name before `scr_ee_bucket_drop`, fires the meta after). */
  unlinkEntry(): number {
    return this.cached("unlinkEntry", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.deps.rootRef(), this.regRef(), this.bucketRef(), this.entryRef()], []),
        "%w.ee.unlinkEntry",
      );
      const c = new Code();
      const ROOT = 0, REG = 1, B = 2, TARGET = 3, CUR = 4, PREV = 5, N = 6, NAME = 7;
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NAME);
      c.localSet(NAME);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.localSet(CUR);
      c.refNull(this.entryT());
      c.localSet(PREV);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.localGet(TARGET);
      c.refEq();
      c.brIf(1);
      c.localGet(CUR);
      c.localSet(PREV);
      c.localGet(CUR);
      c.structGet(this.entryT(), ENTRY_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      // Unlink CUR ( === TARGET): PREV.next = CUR.next (or head = CUR.next
      // when PREV is null), and fix the tail if CUR was it.
      c.localGet(PREV);
      c.refIsNull();
      c.ifVoid();
      c.localGet(B);
      c.localGet(CUR);
      c.structGet(this.entryT(), ENTRY_NEXT);
      c.structSet(this.bucketT(), BUCKET_EHEAD);
      c.else_();
      c.localGet(PREV);
      c.localGet(CUR);
      c.structGet(this.entryT(), ENTRY_NEXT);
      c.structSet(this.entryT(), ENTRY_NEXT);
      c.end();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_ETAIL);
      c.localGet(CUR);
      c.refEq();
      c.ifVoid();
      c.localGet(B);
      c.localGet(PREV);
      c.structSet(this.bucketT(), BUCKET_ETAIL);
      c.end();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(N);
      c.localGet(B);
      c.localGet(N);
      c.structSet(this.bucketT(), BUCKET_N);
      c.localGet(N);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(REG);
      c.localGet(B);
      c.call(this.bucketDrop());
      c.end();
      c.localGet(ROOT);
      c.localGet(NAME);
      c.call(this.fireMetaHelper("removeListener"));
      this.mb.setBody(idx, [this.entryRef(), this.entryRef(), I32, this.deps.strRef()], c.bytes());
      return idx;
    });
  }

  /* ── emit (general family) ────────────────────────────────────────── */

  /** `(root, name, args) -> i32(hadListeners)` — snapshot-before-dispatch
   * (scr_ee_emit_core, minus the once-removal and meta-fire steps not yet
   * built): entries invoke in list order, a listener throw stops the
   * pass. Snapshotting is a plain array copy — WasmGC keeps every
   * snapshotted entry alive regardless of concurrent live-list mutation,
   * so add-mid-emit waits (the snapshot predates it) and remove-mid-emit
   * still fires (the snapshot still holds the reference) for free. */
  emitDispatch(): number {
    return this.cachedRecursive(
      "emitDispatch",
      () =>
        this.mb.declareFunc(
          this.mb.funcType([this.deps.rootRef(), this.deps.strRef(), this.deps.dynArrRef()], [I32]),
          "%w.ee.emitDispatch",
        ),
      (idx) => {
      const c = new Code();
      const ROOT = 0, NAME = 1, ARGS = 2, REG = 3, B = 4, N = 5, SNAP = 6, I = 7, E = 8, SI = 9, LB = 10;
      const entryT = this.entryT();
      const snapArrType = this.mb.arrayType(this.entryRef(), true);
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localSet(REG);
      c.localGet(REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localTee(B);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_N);
      c.localTee(N);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      // Snapshot: walk the live list into a fixed array of N entry refs.
      // block B_snap { loop L_snap { if (E==null) br 2 (exit B_snap);
      // ...; br 0 (continue L_snap) } } — br's target counts structured
      // constructs from the innermost: depth 0 is the `if` itself, depth
      // 1 the loop (branching a LOOP jumps to its TOP, not past it — the
      // reason the exit needs the wrapping block at depth 2).
      c.localGet(N);
      c.arrayNewDefault(snapArrType);
      c.localSet(SNAP);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.localSet(E);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(E);
      c.refIsNull();
      c.ifVoid();
      c.br(2);
      c.end();
      c.localGet(SNAP);
      c.localGet(I);
      c.localGet(E);
      c.arraySet(snapArrType);
      c.localGet(E);
      c.structGet(entryT, ENTRY_NEXT);
      c.localSet(E);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end(); // end L_snap
      c.end(); // end B_snap
      // Dispatch: call each snapshotted entry's thunk in order. Same
      // block+loop shape: `brIf(1)` (I>=N) is a DIRECT branch from the
      // loop's own body (no nested `if`), so depth 0 is the loop itself
      // (continue — never taken here) and depth 1 is the wrapping block
      // (exit) — correct with no `if` layer between.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(SNAP);
      c.localGet(I);
      c.arrayGet(snapArrType);
      c.localSet(E);
      // once: fired ⇒ this call skips (nested emit already ran it);
      // not-yet-fired ⇒ mark fired and unlink from the LIVE bucket BEFORE
      // invoking (Node's wrapper.removeListener-before-body order) — the
      // live bucket is RE-FOUND by name rather than reusing `B`, since an
      // earlier once-removal in this same pass may have dropped and a
      // nested emit re-created it (scr_ee_emit_core's own discipline).
      c.i32Const(1);
      c.localSet(SI);
      c.localGet(E);
      c.structGet(entryT, ENTRY_ONCE);
      c.ifVoid();
      c.localGet(E);
      c.structGet(entryT, ENTRY_FIRED);
      c.ifVoid();
      c.i32Const(0);
      c.localSet(SI);
      c.else_();
      c.localGet(E);
      c.i32Const(1);
      c.structSet(entryT, ENTRY_FIRED);
      c.localGet(REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localTee(LB);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(REG);
      c.localGet(LB);
      c.localGet(E);
      c.call(this.unlinkEntry());
      c.end();
      // A 'removeListener' meta listener may have just thrown (fired
      // from inside unlinkEntry) — leaves the exception pending and
      // skips invoking THIS entry's own callback (scr_ee_emit_core's
      // own "a removeListener meta listener threw" branch).
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.i32Const(0);
      c.localSet(SI);
      c.end();
      c.end();
      c.end();
      c.localGet(SI);
      c.ifVoid();
      c.localGet(E);
      c.structGet(entryT, ENTRY_CLOS);
      c.localGet(ARGS);
      c.localGet(E);
      c.structGet(entryT, ENTRY_THUNK);
      c.callRef(this.deps.thunkSig());
      c.drop(); // the listener's own return value is never observed
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.br(3); // if=0,if(SI)=1,loop=2,block=3 — exit past the block
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end(); // end L_disp
      c.end(); // end B_disp
      c.i32Const(1);
      this.mb.setBody(
        idx,
        [this.regRef(), this.bucketRef(), I32,
          { kind: "ref", nullable: true, typeIndex: snapArrType }, I32, this.entryRef(), I32, this.bucketRef()],
        c.bytes(),
      );
      },
    );
  }

  /* ── introspection ─────────────────────────────────────────────────── */

  /** `(root, name) -> f64` — listenerCount(name) (scr_emitter_listener_count). */
  countOf(): number {
    return this.cached("countOf", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.strRef()], [F64]), "%w.ee.countOf");
      const c = new Code();
      const ROOT = 0, NAME = 1, B = 2;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localTee(B);
      c.refIsNull();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_N);
      c.f64ConvertI32U();
      c.end();
      this.mb.setBody(idx, [this.bucketRef()], c.bytes());
      return idx;
    });
  }

  /** `(entry) -> eq` — the entry's IDENTITY closure (scr_ee_entry_fn):
   * `orig` when a dyn-adapted registration set it, `clos` otherwise. */
  private entryIdentity(): number {
    return this.cached("entryIdentity", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.entryRef()], [EQ_REF]), "%w.ee.entryIdentity");
      const c = new Code();
      const E = 0;
      c.localGet(E);
      c.structGet(this.entryT(), ENTRY_ORIG);
      c.refIsNull();
      c.ifResult(EQ_REF);
      c.localGet(E);
      c.structGet(this.entryT(), ENTRY_CLOS);
      c.else_();
      c.localGet(E);
      c.structGet(this.entryT(), ENTRY_ORIG);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root, name, cb) -> void` — off/removeListener: the LAST matching
   * occurrence leaves (Node searches from the end — scr_emitter_off).
   * `cb` borrowed, matched by identity. A no-match is a silent no-op
   * (`b` may be null, or nothing may match). */
  removeLast(): number {
    return this.cached("removeLast", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.strRef(), EQ_REF], []), "%w.ee.removeLast");
      const c = new Code();
      const ROOT = 0, NAME = 1, CB = 2, REG = 3, B = 4, E = 5, MATCH = 6;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localTee(B);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      // Walk the whole list; the LAST match wins (a later match simply
      // overwrites an earlier candidate — one forward pass answers the
      // same question a backward scan would).
      c.refNull(this.entryT());
      c.localSet(MATCH);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.localSet(E);
      c.block();
      c.loop();
      c.localGet(E);
      c.refIsNull();
      c.brIf(1);
      c.localGet(E);
      c.call(this.entryIdentity());
      c.localGet(CB);
      c.refEq();
      c.ifVoid();
      c.localGet(E);
      c.localSet(MATCH);
      c.end();
      c.localGet(E);
      c.structGet(this.entryT(), ENTRY_NEXT);
      c.localSet(E);
      c.br(0);
      c.end();
      c.end();
      c.localGet(MATCH);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ROOT);
      c.localGet(REG);
      c.localGet(B);
      c.localGet(MATCH);
      c.call(this.unlinkEntry());
      this.mb.setBody(idx, [this.regRef(), this.bucketRef(), this.entryRef(), this.entryRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, name, cb) -> f64` — listenerCount(name, fn): entries whose
   * identity matches `fn` (scr_emitter_listener_count_fn). */
  countFnOf(): number {
    return this.cached("countFnOf", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.strRef(), EQ_REF], [F64]), "%w.ee.countFnOf");
      const c = new Code();
      const ROOT = 0, NAME = 1, CB = 2, B = 3, E = 4, N = 5;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localSet(B);
      c.i32Const(0);
      c.localSet(N);
      c.localGet(B);
      c.refIsNull();
      c.ifVoid();
      c.f64Const(0);
      c.return_();
      c.end();
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.localSet(E);
      c.block();
      c.loop();
      c.localGet(E);
      c.refIsNull();
      c.brIf(1);
      c.localGet(E);
      c.call(this.entryIdentity());
      c.localGet(CB);
      c.refEq();
      c.ifVoid();
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.localSet(N);
      c.end();
      c.localGet(E);
      c.structGet(this.entryT(), ENTRY_NEXT);
      c.localSet(E);
      c.br(0);
      c.end();
      c.end();
      c.localGet(N);
      c.f64ConvertI32U();
      this.mb.setBody(idx, [this.bucketRef(), this.entryRef(), I32], c.bytes());
      return idx;
    });
  }

  /** `(bucket, entry) -> i32` — is `entry` still in `bucket`'s live list
   * right now (by identity)? The meta-aware removeAll's own "is it still
   * there" gate — a nested 'removeListener' handler may have already
   * removed it mid-pass (scr_ee_remove_all_named's `if (live) {...}`). */
  private entryPresent(): number {
    return this.cached("entryPresent", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bucketRef(), this.entryRef()], [I32]), "%w.ee.entryPresent");
      const c = new Code();
      const B = 0, TARGET = 1, CUR = 2;
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      c.localGet(CUR);
      c.localGet(TARGET);
      c.refEq();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(CUR);
      c.structGet(this.entryT(), ENTRY_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [this.entryRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, reg, bucket) -> void` — the meta-aware removeAllListeners
   * (scr_ee_remove_all_named's `meta` branch): snapshot the bucket's
   * entries in list order, then remove them ONE AT A TIME from the END
   * (LIFO — Node's own order), RE-FINDING the live bucket by name and
   * re-checking presence each time (a 'removeListener' handler running
   * mid-pass may add/remove/drop-and-recreate it). `bucket`'s own `name`
   * field stays valid to read even after it drops out of the chain (an
   * ordinary GC reference, not invalidated by unlinking). */
  private removeAllNamedMeta(): number {
    return this.cached("removeAllNamedMeta", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.regRef(), this.bucketRef()], []), "%w.ee.removeAllNamedMeta");
      const c = new Code();
      const ROOT = 0, REG = 1, BUCKET = 2, NAME = 3, N = 4, SNAP = 5, I = 6, E = 7, LIVE = 8;
      const entryT = this.entryT();
      const snapArrType = this.mb.arrayType(this.entryRef(), true);
      c.localGet(BUCKET);
      c.structGet(this.bucketT(), BUCKET_NAME);
      c.localSet(NAME);
      c.localGet(BUCKET);
      c.structGet(this.bucketT(), BUCKET_N);
      c.localSet(N);
      c.localGet(N);
      c.arrayNewDefault(snapArrType);
      c.localSet(SNAP);
      c.localGet(BUCKET);
      c.structGet(this.bucketT(), BUCKET_EHEAD);
      c.localSet(E);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(E);
      c.refIsNull();
      c.ifVoid();
      c.br(2);
      c.end();
      c.localGet(SNAP);
      c.localGet(I);
      c.localGet(E);
      c.arraySet(snapArrType);
      c.localGet(E);
      c.structGet(entryT, ENTRY_NEXT);
      c.localSet(E);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // LIFO: I counts down from N-1 to 0.
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localTee(LIVE);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(LIVE);
      c.localGet(SNAP);
      c.localGet(I);
      c.arrayGet(snapArrType);
      c.localTee(E);
      c.call(this.entryPresent());
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(REG);
      c.localGet(LIVE);
      c.localGet(E);
      c.call(this.unlinkEntry());
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(
        idx,
        [this.deps.strRef(), I32, { kind: "ref", nullable: true, typeIndex: snapArrType }, I32, this.entryRef(), this.bucketRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(root, name) -> void` — removeAllListeners(name): the plain
   * wholesale bucket drop when nothing observes 'removeListener' (scr_
   * ee_remove_all_named's `!meta` arm), else the meta-aware LIFO removal
   * (this file has no shape mode, so unlike the C reference there is no
   * separate "were all buckets already empty" wholesale-wipe corner to
   * chase — a bucket here is NEVER present at n==0, so there is nothing
   * extra left to sweep once the named bucket's own entries are gone). */
  removeAllNamed(): number {
    return this.cached("removeAllNamed", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.strRef()], []), "%w.ee.removeAllNamed");
      const c = new Code();
      const ROOT = 0, NAME = 1, REG = 2, B = 3, RL = 4;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(REG);
      c.localGet(NAME);
      c.call(this.bucketFind());
      c.localTee(B);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(REG);
      this.deps.lit(c, "removeListener");
      c.call(this.bucketFind());
      c.localTee(RL);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(RL);
      c.structGet(this.bucketT(), BUCKET_N);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(REG);
      c.localGet(B);
      c.call(this.removeAllNamedMeta());
      c.return_();
      c.end();
      c.end();
      c.localGet(REG);
      c.localGet(B);
      c.call(this.bucketDrop());
      this.mb.setBody(idx, [this.regRef(), this.bucketRef(), this.bucketRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — removeAllListeners(): every OTHER bucket's
   * entries first (bucket-chain order, meta-aware if 'removeListener'
   * has its own listeners), then 'removeListener's own entries LAST
   * (Node's exact order — scr_emitter_remove_all's whole-emitter form),
   * then reset the chain. The per-bucket pass RE-WALKS `reg.head` from
   * the front each time (skipping past whatever the meta pass already
   * emptied/dropped) since the chain mutates under it. */
  removeAllWhole(): number {
    return this.cached("removeAllWhole", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.ee.removeAllWhole");
      const c = new Code();
      const ROOT = 0, REG = 1, RL = 2, PICK = 3;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(REG);
      this.deps.lit(c, "removeListener");
      c.call(this.bucketFind());
      c.localTee(RL);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(RL);
      c.structGet(this.bucketT(), BUCKET_N);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      // Meta-aware: every OTHER bucket first (chain order), re-walking
      // from the front each pass since a handler can mutate the chain;
      // 'removeListener' itself last.
      c.block();
      c.loop();
      c.refNull(this.bucketT());
      c.localSet(PICK);
      c.localGet(REG);
      c.structGet(this.regT(), REG_HEAD);
      c.localSet(RL); // reuse RL as the walk cursor — its own bucket is skipped by name below
      c.block();
      c.loop();
      c.localGet(RL);
      c.refIsNull();
      c.brIf(1);
      c.localGet(RL);
      c.structGet(this.bucketT(), BUCKET_NAME);
      this.deps.lit(c, "removeListener");
      c.call(this.deps.strEq());
      c.i32Eqz();
      c.ifVoid();
      c.localGet(RL);
      c.localSet(PICK);
      c.br(2); // found one — stop BOTH the inner walk and fall to using it
      c.end();
      c.localGet(RL);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.localSet(RL);
      c.br(0);
      c.end();
      c.end();
      c.localGet(PICK);
      c.refIsNull();
      c.brIf(1); // nothing left but (maybe) 'removeListener' — exit the outer loop
      c.localGet(ROOT);
      c.localGet(REG);
      c.localGet(PICK);
      c.call(this.removeAllNamedMeta());
      c.br(0);
      c.end();
      c.end();
      c.localGet(REG);
      this.deps.lit(c, "removeListener");
      c.call(this.bucketFind());
      c.localTee(RL);
      c.refIsNull();
      c.ifVoid();
      c.else_();
      c.localGet(ROOT);
      c.localGet(REG);
      c.localGet(RL);
      c.call(this.removeAllNamedMeta());
      c.end();
      c.end();
      c.end();
      c.localGet(REG);
      c.refNull(this.bucketT());
      c.structSet(this.regT(), REG_HEAD);
      this.mb.setBody(idx, [this.regRef(), this.bucketRef(), this.bucketRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> string[]` — eventNames(): the bucket chain IS
   * first-registration order already (scr_emitter_event_names). Every
   * bucket in the chain has n>0 today — this file drops a bucket the
   * instant it empties (no shape-mode reserved-but-empty buckets yet),
   * so no `n>0` filter is needed here (unlike the C reference, which
   * DOES need one once reserved buckets exist — a stage-B note). */
  namesArr(): number {
    return this.cached("namesArr", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], [this.deps.stringVecRef()]), "%w.ee.namesArr");
      const c = new Code();
      const ROOT = 0, REG = 1, OUT = 2, B = 3;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localSet(REG);
      c.f64Const(0);
      c.call(this.deps.stringVecNewLen());
      c.localSet(OUT);
      c.localGet(REG);
      c.refIsNull();
      c.ifVoid();
      c.localGet(OUT);
      c.return_();
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_HEAD);
      c.localSet(B);
      c.block();
      c.loop();
      c.localGet(B);
      c.refIsNull();
      c.brIf(1);
      c.localGet(OUT);
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NAME);
      c.call(this.deps.stringVecPushOne());
      c.localGet(B);
      c.structGet(this.bucketT(), BUCKET_NEXT);
      c.localSet(B);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUT);
      this.mb.setBody(idx, [this.regRef(), this.deps.stringVecRef(), this.bucketRef()], c.bytes());
      return idx;
    });
  }

  /* ── the 'error' bucket (direct-reference family) ─────────────────────
   * KNOWN GAP, named rather than silent: eventNames()/countOf/countFnOf
   * above walk ONLY the general chain, so `eventNames()`/`listenerCount`
   * over the literal name "error" do not see this bucket — the dispatch
   * site (emitter.ts) fences those two specific paths for the literal
   * name "error" rather than answering a wrong count/list. Every op an
   * ACTUAL stage-A corpus claim needs over 'error' (on/off/emit/
   * emitError/removeAllListeners, both forms) IS implemented here. */

  /** `(root) -> bucketErr` — lazily creates the registry AND the one
   * error bucket (scr_ee_reg_ensure + the bucket's own first-touch). */
  errBucketEnsure(): number {
    return this.cached("errBucketEnsure", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], [this.bucketErrRef()]), "%w.ee.errBucketEnsure");
      const c = new Code();
      const ROOT = 0, REG = 1, EB = 2;
      c.localGet(ROOT);
      c.call(this.regEnsure());
      c.localSet(REG);
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.refIsNull();
      c.ifVoid();
      c.localGet(REG);
      c.refNull(this.entryErrT());
      c.refNull(this.entryErrT());
      c.i32Const(0);
      c.i32Const(0);
      c.structNew(this.bucketErrT());
      c.structSet(this.regT(), REG_ERRBUCKET);
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      this.mb.setBody(idx, [this.regRef(), this.bucketErrRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, clos, thunk, once, prepend) -> void` — the 'error' bucket's
   * own insert (mirrors entryAppend structurally, newListener-before-add
   * included; leak-warning is NOT yet built, same scope note as the
   * general family). */
  errEntryAppend(): number {
    return this.cached("errEntryAppend", () => {
      const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.errThunkSig() };
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.deps.rootRef(), EQ_REF, thunkRef, I32, I32], []),
        "%w.ee.errEntryAppend",
      );
      const c = new Code();
      const ROOT = 0, CLOS = 1, THUNK = 2, ONCE = 3, PREPEND = 4, EB = 5, E = 6;
      c.localGet(ROOT);
      this.deps.lit(c, "error");
      c.call(this.fireMetaHelper("newListener"));
      c.localGet(ROOT);
      c.call(this.errBucketEnsure());
      c.localSet(EB);
      c.localGet(CLOS);
      c.localGet(THUNK);
      c.refNull(EQ_HEAP);
      c.localGet(ONCE);
      c.i32Const(0);
      c.refNull(this.entryErrT());
      c.structNew(this.entryErrT());
      c.localSet(E);
      c.localGet(PREPEND);
      c.ifVoid();
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.refIsNull();
      c.ifVoid();
      c.localGet(EB);
      c.localGet(E);
      c.structSet(this.bucketErrT(), BUCKETERR_ETAIL);
      c.else_();
      c.localGet(E);
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.structSet(this.entryErrT(), ENTRYERR_NEXT);
      c.end();
      c.localGet(EB);
      c.localGet(E);
      c.structSet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.else_();
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_ETAIL);
      c.refIsNull();
      c.ifVoid();
      c.localGet(EB);
      c.localGet(E);
      c.structSet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.else_();
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_ETAIL);
      c.localGet(E);
      c.structSet(this.entryErrT(), ENTRYERR_NEXT);
      c.end();
      c.localGet(EB);
      c.localGet(E);
      c.structSet(this.bucketErrT(), BUCKETERR_ETAIL);
      c.end();
      c.localGet(EB);
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_N);
      c.i32Const(1);
      c.i32Add();
      c.structSet(this.bucketErrT(), BUCKETERR_N);
      this.mb.setBody(idx, [this.bucketErrRef(), this.entryErrRef()], c.bytes());
      return idx;
    });
  }

  private errEntryIdentity(): number {
    return this.cached("errEntryIdentity", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.entryErrRef()], [EQ_REF]), "%w.ee.errEntryIdentity");
      const c = new Code();
      const E = 0;
      c.localGet(E);
      c.structGet(this.entryErrT(), ENTRYERR_ORIG);
      c.refIsNull();
      c.ifResult(EQ_REF);
      c.localGet(E);
      c.structGet(this.entryErrT(), ENTRYERR_CLOS);
      c.else_();
      c.localGet(E);
      c.structGet(this.entryErrT(), ENTRYERR_ORIG);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** Unlinks ONE entry (known present, matched by identity) from the
   * error bucket's live list — mirrors unlinkEntry (removeListener-
   * after included; name is always the literal "error"), minus the
   * bucket-drop (there is exactly one error bucket per registry; it
   * persists empty, unlike a general-family bucket, so a later reserve/
   * shape-mode story never has to distinguish "never had an error
   * bucket" from "has one, empty"). */
  errUnlinkEntry(): number {
    return this.cached("errUnlinkEntry", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.deps.rootRef(), this.bucketErrRef(), this.entryErrRef()], []),
        "%w.ee.errUnlinkEntry",
      );
      const c = new Code();
      const ROOT = 0, EB = 1, TARGET = 2, CUR = 3, PREV = 4, N = 5;
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.localSet(CUR);
      c.refNull(this.entryErrT());
      c.localSet(PREV);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.localGet(TARGET);
      c.refEq();
      c.brIf(1);
      c.localGet(CUR);
      c.localSet(PREV);
      c.localGet(CUR);
      c.structGet(this.entryErrT(), ENTRYERR_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      c.localGet(PREV);
      c.refIsNull();
      c.ifVoid();
      c.localGet(EB);
      c.localGet(CUR);
      c.structGet(this.entryErrT(), ENTRYERR_NEXT);
      c.structSet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.else_();
      c.localGet(PREV);
      c.localGet(CUR);
      c.structGet(this.entryErrT(), ENTRYERR_NEXT);
      c.structSet(this.entryErrT(), ENTRYERR_NEXT);
      c.end();
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_ETAIL);
      c.localGet(CUR);
      c.refEq();
      c.ifVoid();
      c.localGet(EB);
      c.localGet(PREV);
      c.structSet(this.bucketErrT(), BUCKETERR_ETAIL);
      c.end();
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(N);
      c.localGet(EB);
      c.localGet(N);
      c.structSet(this.bucketErrT(), BUCKETERR_N);
      c.localGet(ROOT);
      this.deps.lit(c, "error");
      c.call(this.fireMetaHelper("removeListener"));
      this.mb.setBody(idx, [this.entryErrRef(), this.entryErrRef(), I32], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — is there at least one 'error' listener right now
   * (scr_ee_has(reg,"error"), the emitError throw-vs-dispatch gate)?
   * No registry yet ⇒ no bucket yet ⇒ false, without allocating one. */
  hasErrorListeners(): number {
    return this.cached("hasErrorListeners", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], [I32]), "%w.ee.hasErrorListeners");
      const c = new Code();
      const ROOT = 0, REG = 1, EB = 2;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.localTee(EB);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_N);
      c.i32Const(0);
      c.i32GtS();
      this.mb.setBody(idx, [this.regRef(), this.bucketErrRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, err) -> void` — dispatches to every 'error' listener, snap-
   * shot-before-dispatch with the SAME once-guard/re-find-and-unlink
   * discipline as the general family's emitDispatch (mirrored, not
   * shared, since the two thunk signatures differ). The caller (emitter.
   * ts) has already established `hasErrorListeners` is true. */
  errDispatch(): number {
    return this.cached("errDispatch", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.errRef()], []), "%w.ee.errDispatch");
      const c = new Code();
      const ROOT = 0, ERR = 1, REG = 2, EB = 3, N = 4, SNAP = 5, I = 6, E = 7, SI = 8, LEB = 9;
      const entryT = this.entryErrT();
      const snapArrType = this.mb.arrayType(this.entryErrRef(), true);
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localSet(REG);
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.localSet(EB);
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_N);
      c.localTee(N);
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(N);
      c.arrayNewDefault(snapArrType);
      c.localSet(SNAP);
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.localSet(E);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(E);
      c.refIsNull();
      c.ifVoid();
      c.br(2);
      c.end();
      c.localGet(SNAP);
      c.localGet(I);
      c.localGet(E);
      c.arraySet(snapArrType);
      c.localGet(E);
      c.structGet(entryT, ENTRYERR_NEXT);
      c.localSet(E);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(SNAP);
      c.localGet(I);
      c.arrayGet(snapArrType);
      c.localSet(E);
      c.i32Const(1);
      c.localSet(SI);
      c.localGet(E);
      c.structGet(entryT, ENTRYERR_ONCE);
      c.ifVoid();
      c.localGet(E);
      c.structGet(entryT, ENTRYERR_FIRED);
      c.ifVoid();
      c.i32Const(0);
      c.localSet(SI);
      c.else_();
      c.localGet(E);
      c.i32Const(1);
      c.structSet(entryT, ENTRYERR_FIRED);
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.localTee(LEB);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(LEB);
      c.localGet(E);
      c.call(this.errUnlinkEntry());
      c.end();
      // A 'removeListener' meta listener may have just thrown — skip
      // invoking THIS entry (mirrors emitDispatch's identical guard).
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.i32Const(0);
      c.localSet(SI);
      c.end();
      c.end();
      c.end();
      c.localGet(SI);
      c.ifVoid();
      c.localGet(E);
      c.structGet(entryT, ENTRYERR_CLOS);
      c.localGet(ERR);
      c.localGet(E);
      c.structGet(entryT, ENTRYERR_THUNK);
      c.callRef(this.errThunkSig());
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.br(3);
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(
        idx,
        [this.regRef(), this.bucketErrRef(), I32,
          { kind: "ref", nullable: true, typeIndex: snapArrType }, I32, this.entryErrRef(), I32, this.bucketErrRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(root) -> void` — removeAllListeners("error") / the error half of
   * the whole-emitter wipe: reset the one bucket to empty (a plain
   * struct.new — cheaper than walking and unlinking one at a time, and
   * observably identical since no 'removeListener' meta-listener can
   * exist yet — see the general family's own scope note). No-op if the
   * registry or bucket was never created. */
  errRemoveAll(): number {
    return this.cached("errRemoveAll", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.ee.errRemoveAll");
      const c = new Code();
      const ROOT = 0, REG = 1;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(REG);
      c.refNull(this.entryErrT());
      c.refNull(this.entryErrT());
      c.i32Const(0);
      c.i32Const(0);
      c.structNew(this.bucketErrT());
      c.structSet(this.regT(), REG_ERRBUCKET);
      this.mb.setBody(idx, [this.regRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> f64` — listenerCount("error"). */
  errCountOf(): number {
    return this.cached("errCountOf", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], [F64]), "%w.ee.errCountOf");
      const c = new Code();
      const ROOT = 0, REG = 1, EB = 2;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.localTee(EB);
      c.refIsNull();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_N);
      c.f64ConvertI32U();
      c.end();
      c.end();
      this.mb.setBody(idx, [this.regRef(), this.bucketErrRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, cb) -> f64` — listenerCount("error", fn). */
  errCountFnOf(): number {
    return this.cached("errCountFnOf", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), EQ_REF], [F64]), "%w.ee.errCountFnOf");
      const c = new Code();
      const ROOT = 0, CB = 1, REG = 2, EB = 3, E = 4, N = 5;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifVoid();
      c.f64Const(0);
      c.return_();
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.localTee(EB);
      c.refIsNull();
      c.ifVoid();
      c.f64Const(0);
      c.return_();
      c.end();
      c.i32Const(0);
      c.localSet(N);
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.localSet(E);
      c.block();
      c.loop();
      c.localGet(E);
      c.refIsNull();
      c.brIf(1);
      c.localGet(E);
      c.call(this.errEntryIdentity());
      c.localGet(CB);
      c.refEq();
      c.ifVoid();
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.localSet(N);
      c.end();
      c.localGet(E);
      c.structGet(this.entryErrT(), ENTRYERR_NEXT);
      c.localSet(E);
      c.br(0);
      c.end();
      c.end();
      c.localGet(N);
      c.f64ConvertI32U();
      this.mb.setBody(idx, [this.regRef(), this.bucketErrRef(), this.entryErrRef(), I32], c.bytes());
      return idx;
    });
  }

  /** `(root, cb) -> void` — off("error", cb) / removeListener: the LAST
   * matching occurrence leaves (mirrors removeLast). */
  errRemoveLast(): number {
    return this.cached("errRemoveLast", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), EQ_REF], []), "%w.ee.errRemoveLast");
      const c = new Code();
      const ROOT = 0, CB = 1, REG = 2, EB = 3, E = 4, MATCH = 5;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(REG);
      c.structGet(this.regT(), REG_ERRBUCKET);
      c.localTee(EB);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.refNull(this.entryErrT());
      c.localSet(MATCH);
      c.localGet(EB);
      c.structGet(this.bucketErrT(), BUCKETERR_EHEAD);
      c.localSet(E);
      c.block();
      c.loop();
      c.localGet(E);
      c.refIsNull();
      c.brIf(1);
      c.localGet(E);
      c.call(this.errEntryIdentity());
      c.localGet(CB);
      c.refEq();
      c.ifVoid();
      c.localGet(E);
      c.localSet(MATCH);
      c.end();
      c.localGet(E);
      c.structGet(this.entryErrT(), ENTRYERR_NEXT);
      c.localSet(E);
      c.br(0);
      c.end();
      c.end();
      c.localGet(MATCH);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ROOT);
      c.localGet(EB);
      c.localGet(MATCH);
      c.call(this.errUnlinkEntry());
      this.mb.setBody(idx, [this.regRef(), this.bucketErrRef(), this.entryErrRef(), this.entryErrRef()], c.bytes());
      return idx;
    });
  }

  /* ── maxListeners ──────────────────────────────────────────────────────
   * Ladder texts oracle-measured against Node (node --experimental-
   * transform-types, CJS require — the ESM `import * as events` spelling
   * answers a FROZEN namespace object instead and throws a completely
   * different "Cannot assign to read only property" TypeError, which is
   * NOT what the corpus's require()-based programs observe):
   *   RangeError/ERR_OUT_OF_RANGE: 'The value of "<name>" is out of
   *   range. It must be >= 0. Received <n>' — <name> is "setMaxListeners"
   *   for both the instance form and the static call form, "default
   *   MaxListeners" for the `events.defaultMaxListeners = v` property
   *   write (Node's own two-slot split, threaded through by the caller).
   * The Chk (type-check) ladder's non-number rendering lives in
   * emitter.ts (dyn-kind-directed, not this file's business) — this
   * class only does the RANGE half, reused by both the unchecked
   * (statically f64) and checked (post-unbox) call sites. */

  private defaultMaxG: number | null = null;

  /** `EventEmitter.defaultMaxListeners` — one process-wide global,
   * default 10 (scr_emitter_default_max). */
  private defaultMaxGlobal(): number {
    if (this.defaultMaxG !== null) return this.defaultMaxG;
    this.defaultMaxG = this.mb.addGlobal(F64, true, (w) => {
      w.u8(0x44); // f64.const
      w.f64(10);
    });
    return this.defaultMaxG;
  }

  /** Shared message build + throw: 'The value of "<name>" is out of
   * range. It must be >= 0. Received <n>' then an immediate `return_()`
   * (void) — the CALLER's ordinary post-call pending check unwinds. */
  private throwOutOfRange(c: Code, pushName: (c: Code) => void, nLocal: number): void {
    this.deps.throwCoded(
      c,
      "%RangeError",
      "RangeError",
      (m) => {
        this.deps.lit(m, 'The value of "');
        pushName(m);
        m.call(this.deps.concat());
        this.deps.lit(m, '" is out of range. It must be >= 0. Received ');
        m.call(this.deps.concat());
        m.localGet(nLocal);
        m.call(this.deps.f64ToStr());
        m.call(this.deps.concat());
      },
      "ERR_OUT_OF_RANGE",
    );
    c.return_();
  }

  /** `() -> f64` — EventEmitter.defaultMaxListeners (read). */
  getDefaultMax(): number {
    return this.cached("getDefaultMax", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], [F64]), "%w.ee.getDefaultMax");
      const c = new Code();
      c.globalGet(this.defaultMaxGlobal());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> f64` — getMaxListeners(): the per-instance cap if one was
   * ever set (>= 0), else a LIVE read of the default (2321's own pin:
   * an emitter that never called setMaxListeners tracks the default as
   * it changes, not a snapshot taken at construction). */
  getMaxOf(): number {
    return this.cached("getMaxOf", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], [F64]), "%w.ee.getMaxOf");
      const c = new Code();
      const ROOT = 0, REG = 1, M = 2;
      c.localGet(ROOT);
      c.structGet(this.deps.rootStruct(), EMITTER_REG);
      c.localTee(REG);
      c.refIsNull();
      c.ifResult(F64);
      c.globalGet(this.defaultMaxGlobal());
      c.else_();
      c.localGet(REG);
      c.structGet(this.regT(), REG_MAX);
      c.localTee(M);
      c.f64Const(0);
      c.f64Ge();
      c.ifResult(F64);
      c.localGet(M);
      c.else_();
      c.globalGet(this.defaultMaxGlobal());
      c.end();
      c.end();
      this.mb.setBody(idx, [this.regRef(), F64], c.bytes());
      return idx;
    });
  }

  /** `(root, n) -> void` — setMaxListeners(n): range-validated
   * (`!(n>=0)` catches NaN too — IEEE754 comparisons against NaN are
   * false either way, so testing `n>=0` and negating is the ONLY correct
   * form; `n<0` alone would miss NaN), else stored on the per-instance
   * registry. The message's name slot is always "setMaxListeners" for
   * this receiver form (oracle-measured). */
  setMaxOf(): number {
    return this.cached("setMaxOf", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), F64], []), "%w.ee.setMaxOf");
      const c = new Code();
      const ROOT = 0, N = 1, REG = 2;
      c.localGet(N);
      c.f64Const(0);
      c.f64Ge();
      c.i32Eqz();
      c.ifVoid();
      this.throwOutOfRange(c, (m) => this.deps.lit(m, "setMaxListeners"), N);
      c.end();
      c.localGet(ROOT);
      c.call(this.regEnsure());
      c.localSet(REG);
      c.localGet(REG);
      c.localGet(N);
      c.structSet(this.regT(), REG_MAX);
      this.mb.setBody(idx, [this.regRef()], c.bytes());
      return idx;
    });
  }

  /** `(n) -> void` — the STATIC unchecked form (`EventEmitter.
   * setMaxListeners(<numeric literal>)`, the ONLY site that reaches this
   * without a name argument — Node's own name slot there is always
   * "setMaxListeners" too). */
  setDefaultMax(): number {
    return this.cached("setDefaultMax", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], []), "%w.ee.setDefaultMax");
      const c = new Code();
      const N = 0;
      c.localGet(N);
      c.f64Const(0);
      c.f64Ge();
      c.i32Eqz();
      c.ifVoid();
      this.throwOutOfRange(c, (m) => this.deps.lit(m, "setMaxListeners"), N);
      c.end();
      c.localGet(N);
      c.globalSet(this.defaultMaxGlobal());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(n, name) -> void` — the Chk ladder's post-type-validation range
   * setter, RUNTIME name (the module-property write's own slot,
   * "defaultMaxListeners", vs. the static call forms' "setMaxListeners"
   * — Node's exact split, threaded by the caller). */
  setDefaultMaxNamed(): number {
    return this.cached("setDefaultMaxNamed", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64, this.deps.strRef()], []), "%w.ee.setDefaultMaxNamed");
      const c = new Code();
      const N = 0, NAME = 1;
      c.localGet(N);
      c.f64Const(0);
      c.f64Ge();
      c.i32Eqz();
      c.ifVoid();
      this.throwOutOfRange(c, (m) => m.localGet(NAME), N);
      c.end();
      c.localGet(N);
      c.globalSet(this.defaultMaxGlobal());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }
}
