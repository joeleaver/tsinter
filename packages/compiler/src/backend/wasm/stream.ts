/* node:stream's Readable over WasmGC — scr_stream.c's readable-side state
 * machine ported (PASS 1: construction, push/read, pause/resume/flow with
 * the direct-emit fast path, destroy's default path, the underscore _read
 * dispatch, and the scalar/flowing/errored property surface). Mirrors
 * events.ts's shape exactly: one shared struct family for every
 * %Readable-rooted class (root AND every user subclass — classes.ts's
 * gate lift), hand-built functions over an explicit Code buffer, PURE
 * RUNTIME STRUCTURE — this file never touches an IrType.
 *
 * SCHEDULING. Every deferred stream callback ('readable' collapse,
 * 'resume', 'end', 'error', 'close', `maybeReadMore_`'s own tick (R3),
 * and the 'readable'-listener-added priming `read(0)` (`nReadingNextTick`,
 * 2572's fix)) is a NODE on this file's OWN private FIFO (`$rTick`),
 * dispatched one-at-a-time through nexttick.ts's
 * raw-marker seam (`enqueueRaw`/`rawFnType` — built in stage 0 for exactly
 * this): scheduling a stream tick both appends to THIS file's list AND
 * posts one bare marker onto the user process.nextTick queue, so stream
 * ticks and user nextTicks interleave in true enqueue-order FIFO (2627's
 * pin) without this file needing to touch nexttick.ts's queue struct
 * directly — the scr_st_tick / scr_stream_dispatch_one split, ported.
 *
 * THE EMITDATA ABI DECISION (unpinned by the frontend — lower-stream.ts's
 * IR-level 'data' tuple is always a single `bytes` value; nothing forces
 * a two-slot shape at the wasm boundary). This file boxes the delivered
 * chunk through dyn.ts's ordinary `boxBytes`/the general emitter dispatch
 * (events.ts's `emitDispatch`, the SAME path any user-defined event uses)
 * rather than inventing a dedicated stream-only listener ABI: a listener
 * declared `(chunk: Buffer) => void` already lowers, at the emitter
 * layer, to a thunk that unboxes dyn arg 0 back to bytes (the general
 * family's existing per-signature thunk machinery, events.ts's own
 * header) — so 'data' degenerates into the dyn-tuple path with ZERO new
 * machinery, exactly the design doc's bet at §1. Rejected alternative: a
 * bytes-specific fast lane bypassing the dyn array entirely (skip the
 * box/unbox round trip) — buys nothing measurable (the dyn box is one
 * struct.new over a value already computed) and would need a SECOND
 * thunk-adaptation story beside the one events.ts already owns; not worth
 * the duplication for a single event name.
 *
 * SCOPE (pass 1 — see the stage-B checkpoint messages for the contamination
 * ruling this scope reflects): readable.new/init (STATIC literal-options
 * form only — newDyn/initDyn are pass 2), push/pushStr/pushNull/unshift/
 * unshiftStr (push's string form decodes via plain UTF-8 — pushStrEnc's
 * explicit per-call encoding argument is pass 2; unshift/unshiftStr
 * SHIPPED IN PASS 1, not pass 2 — reclassified during landing, trivial
 * once push's `front` parameter existed and 1686 needed it), read,
 * pause/resume/isPaused, the flow state machine + direct-emit fast path
 * + `maybeReadMore` (R3, ported in the gate round), 'data'/'readable'/
 * 'end'/'close' through events.ts's EXISTING general dispatch (shape-mode
 * reservation DEFERRED — see events.ts's header, unpinnable this stage),
 * destroy/destroyErr (the NO-USER-_destroy-OVERRIDE default path only —
 * a provided `destroy` option/override refuses by name, unexercised by
 * any claim this stage), the _read underscore dispatch (options-callback
 * AND construction-time override binding), stream.prop scalar reads,
 * readable.flowing, stream.errored. setEncoding, Readable.from,
 * for-await, stream/consumers, and the dyn lanes (newDyn/initDyn/
 * pushDyn/pushU/pushStrEnc) are PASS 2 — named gaps, refused by their
 * own libCall name at the emitter.ts dispatch site until then, never
 * silently mishandled. */
import type { ByteWriter } from "./bytes.js";
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/** The %Readable-rooted class's OWN injected prefix field, past the
 * emitter pair (classes.ts's gate lift: vt, EMITTER_REG, EMITTER_NAME,
 * then this one) — the WasmGC translation of C's lazily-allocated
 * stream-state pointer. */
export const STREAM_STATE = 3;

/** `$rState`'s field indices. */
export const RS_HWM = 0; // f64
export const RS_LENGTH = 1; // f64 — buffered byte length
export const RS_HEAD = 2; // chunk ref, nullable
export const RS_TAIL = 3; // chunk ref, nullable
export const RS_FLOWING = 4; // i32: -1 unset, 0 paused, 1 flowing
export const RS_READING = 5; // i32 bool
/** Node's real `state.sync` (the lifted internal/streams/readable source,
 * scratchpad/rev/pb/lift.cjs+lift3.cjs — the gate-review's ground truth):
 * true from CONSTRUCTION, set true again immediately before EVERY
 * `_read()`-driven read cycle and cleared right after that SAME cycle's
 * `_read()` call returns (`callRead`'s own bracket) — NOT a one-time
 * "past construction" latch (the gate-round B2 finding: the prior design
 * cleared this once at a stream's first tick, which is wasm-only
 * invented behavior, not Node's). Serves BOTH of Node's two real
 * consumers of `kSync`: `addChunk`'s direct-emit fast-path condition
 * (`pushCore`) and `onEofChunk`'s sync-vs-deferred 'readable' branch
 * (`pushNullCore`) — one field, matching Node's one bit, not two
 * invented ones. Since `_read` is never called before a stream's first
 * real read cycle, `sync` reads `true` for any push()/push(null) that
 * happens synchronously in the SAME stack that merely registered a
 * listener (1687's pin — `push()` right after `.on('data', cb)` still
 * buffers rather than emitting inline, even though `flowing` already
 * reads `true`), which is what the old two-field design was really
 * chasing without the right mechanism. */
export const RS_SYNC = 6;
export const RS_ENDED = 7; // i32 bool
export const RS_END_EMITTED = 8; // i32 bool
/** NOT one of Node's real bits (Node's own `endReadable()` has no
 * "already scheduled" guard at all — it may re-schedule `endReadableNT`
 * on every qualifying `read()` call, relying on `endReadableNT`'s OWN
 * `!endEmitted` recheck at tick time to make repeats harmless) — kept
 * here as this file's own defensive dedup, strictly reducing redundant
 * ticks without changing any OBSERVABLE outcome for a single end cycle;
 * not flagged for removal by the gate round. */
export const RS_END_SCHEDULED = 9; // i32 bool
export const RS_NEED_READABLE = 10; // i32 bool
export const RS_EMITTED_READABLE = 11; // i32 bool
export const RS_RESUME_SCHEDULED = 12; // i32 bool
export const RS_DESTROYED = 13; // i32 bool
export const RS_ERROR = 14; // errRef, nullable
export const RS_EMIT_CLOSE = 15; // i32 bool
export const RS_AUTO_DESTROY = 16; // i32 bool
export const RS_READ_CLOS = 17; // eq, nullable
export const RS_READ_THUNK = 18; // readThunkSig ref, nullable
export const RS_READABLE_LISTENING = 19; // i32 bool
/** Node's real `state.readingMore` — `maybeReadMore`'s own reentrancy
 * guard (R3: ported now, pass 2's buffering builds on it and its absence
 * distorted downstream behavior — pb/b6 pins `_read` filling to the
 * highWaterMark, which needs this loop to exist at all). */
export const RS_READING_MORE = 20; // i32 bool
export const RS_FIELD_COUNT = 21;

/** `$rChunk`'s field indices — one pushed entry, an immutable payload plus
 * a mutable consumed-offset (partial takes advance `off` rather than
 * re-slicing the remainder on every read). */
export const CHUNK_BYTES = 0;
export const CHUNK_OFF = 1;
export const CHUNK_NEXT = 2;

/** `$rTick`'s field indices — this file's own private FIFO node (the
 * scr_st_tick data half; the raw marker riding nexttick.ts's queue is the
 * dispatch half, see `scheduleTick`). */
const RT_ROOT = 0;
const RT_OP = 1;
const RT_NEXT = 2;

export const OP_READABLE = 0;
export const OP_RESUME = 1;
export const OP_END = 2;
export const OP_ERROR = 3;
export const OP_CLOSE = 4;
/** Node's real `maybeReadMore_` tick (R3) — a THIRD scheduled callback
 * distinct from `emitReadable_`'s own tick, per the lifted source
 * (lift2.cjs's `maybeReadMore`/`maybeReadMore_`). */
export const OP_READMORE = 5;
/** Node's real `nReadingNextTick` (lift2.cjs's `Readable.prototype.on`
 * override, the 'readable' arm's empty-buffer branch): a bare
 * `process.nextTick(() => stream.read(0))`, distinct from every other
 * tick here — found via 2572's regression (a synchronous `readCore` call
 * from `onReadableAdded` clears `sync` BEFORE a same-turn `push(null)`
 * runs, which flips `onEofChunk`'s branch and produces an extra
 * 'readable' cycle Node never fires; Node genuinely defers this one). */
export const OP_PRIME_READ = 6;

export interface StreamDeps {
  /** The %Readable hierarchy ROOT's own struct — every general helper's
   * receiver parameter, mirroring events.ts's `rootRef`/`rootStruct`. A
   * subclass struct is a wasm SUBTYPE (classes.ts's gate lift), so
   * upcasts are free. */
  rootRef: () => ValType;
  rootStruct: () => number;
  bytesRef: () => ValType;
  strRef: () => ValType;
  /** %w.bytes.length — (bytes) -> f64. */
  bytesLength: () => number;
  /** %w.bytes.slice:u8 — (bytes, f64 start, f64 end) -> bytes, a fresh
   * copy over relative/clamped indices. */
  bytesSlice: () => number;
  /** %w.bytes.fromStr:utf8 — (str) -> bytes, `push(str)`'s plain-UTF-8
   * decode (pushStrEnc's explicit-encoding form is pass 2). */
  bytesFromStrUtf8: () => number;
  errRef: () => ValType;
  /** The exception cell's kind global — nonzero after a call means an
   * uncaught throw happened; the caller (nexttick.ts's drain, or this
   * file's own dispatcher) traps. */
  excKind: () => number;
  dynArrRef: () => ValType;
  dynArrBufType: () => number;
  dynArrStructType: () => number;
  /** dyn.ts's boxBytes — boxes a raw bytes ref into a dyn BYTES value for
   * the 'data' event's one-element tuple. */
  boxBytes: (c: Code, pushPayload: (c: Code) => void) => void;
  /** dyn.ts's pushNewBytesPayload — wraps a raw bytes ref into the
   * `{bytes, isBuffer}` box `boxBytes`'s own payload actually expects
   * (NOT the raw bytesRef itself — dynCheckHelper's bytes<u8> arm casts
   * to this exact wrapper shape, and a bare bytesRef there is an illegal
   * cast at unbox time). Every chunk this file boxes is a real Buffer
   * (Buffer.isBuffer() is always true for a stream chunk), so `isBuffer`
   * is fixed true at the call site, not threaded through as a param. */
  pushBytesPayload: (c: Code, pushBytes: (c: Code) => void) => void;
  /** events.ts's general dispatch — 'data'/'readable'/'end'/'close' all
   * ride this SAME path any user-defined event uses (the emitData ABI
   * decision above). */
  emitDispatch: () => number;
  /** events.ts's `(root, name) -> f64` listener count — used to gate the
   * direct-emit fast path ("has a 'data' listener"). */
  countOf: () => number;
  hasErrorListeners: () => number;
  errDispatch: () => number;
  /** Push an interned string literal onto `c`'s stack. */
  lit: (c: Code, s: string) => void;
  /** Build a FRESH error VALUE (not committing to the exception cell) —
   * the construction half of emitter.ts's `emitSetCellError`, for errors
   * this file raises itself (ERR_STREAM_PUSH_AFTER_EOF, ERR_METHOD_NOT_
   * IMPLEMENTED). */
  buildErrorLit: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, codeLit: string | null) => void;
  /** Commit an already-built, DYNAMICALLY-typed error reference (already
   * on the stack via `pushErr`) to the exception cell as an uncaught
   * throw — the trap fires at the caller (nexttick.ts's drain loop
   * already checks `excKind` after every dispatched entry). */
  setUncaughtError: (c: Code, pushErr: (c: Code) => void) => void;
  /** If the exception cell holds a pending OBJ-kind exception rooted in
   * %Error (a genuine Error instance/subclass — the only shape this
   * tier's `RS_ERROR` slot can hold), pushes it (errRef, non-null) and
   * CLEARS the cell — `callRead`'s D2 fix, `errorOrDestroy(this, err)`'s
   * equivalent, inlined since `_read`'s call site has no AST try/catch
   * node to hang a catch block off of. Otherwise pushes null and leaves
   * the cell untouched (a non-Error throw keeps propagating through the
   * ordinary pending-check path — named, not silently dropped: D2 pins
   * only the Error-shaped case, pb/f7's shape). */
  tryCatchAsError: (c: Code) => void;
  /** nexttick.ts's raw-marker seam — the stage-0 queue every deferred
   * stream emission rides (this file's own header). */
  enqueueRaw: () => number;
  rawFnType: () => number;
  /** %w.bytes.new:u8 — (f64 len) -> bytes, a zeroed buffer (the empty-
   * read/no-data-available answer needs a real zero-length bytes value
   * in a couple of paths, not a null). */
  bytesNewLen: () => number;
  /** The raw `i8` storage array type (typedarrays.ts's `bufType()`) —
   * needed alongside `bytesStructType` for hand-rolled multi-chunk
   * concatenation (`array.copy` over the shared byte-granular storage,
   * the SAME representation typedarrays.ts's own slice/concat helpers
   * use — read directly rather than duplicated through a Vec<bytes>
   * dependency this file has no other use for). */
  bytesBufType: () => number;
  /** The `$bytes` struct type index — field 0 storage (ref array i8),
   * field 1 off (i32 bytes), field 2 len (i32 elements); typedarrays.ts's
   * own private layout, stable and read here by hand for the same reason
   * as `bytesBufType`. */
  bytesStructType: () => number;
}

// $bytes's field indices (typedarrays.ts's own private layout, mirrored
// here rather than exported cross-file — see StreamDeps.bytesStructType).
const BYTES_STORAGE = 0;
const BYTES_OFF = 1;
const BYTES_LEN = 2;

export class StreamBuilder {
  private readonly fns = new Map<string, number>();
  private stateTField: number | null = null;
  private chunkTField: number | null = null;
  private tickTField: number | null = null;
  private readThunkSigField: number | null = null;
  private tickQueue: { head: number; tail: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: StreamDeps,
  ) {}

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  private cachedRecursive(name: string, declare: () => number, build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = declare();
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  /** `readThunkSig` — the underscore `_read`'s own uniform call-glue:
   * `(clos: eq, this: root, size: f64) -> void`. Compiler-generated glue
   * calling a stored slot (no dyn box — events.ts's errThunkSig precedent
   * for a non-JS-listener signature), but UNLIKE errThunkFor's listener
   * thunks, `_read`'s closure comes from lower-stream.ts's
   * streamMethodWrapper, which lifts the override into a `(this,
   * ...prefix) => ret` closure — the receiver is a REAL declared
   * parameter of the closure's own signature, not captured in its
   * environment, so the thunk must carry it across explicitly (the
   * adapter downcasts `this` from the generic %Readable root to the
   * declaring class, per-signature — emitter.ts's `readThunkFor`). */
  readThunkSig(): number {
    if (this.readThunkSigField === null) {
      const rootRef = this.deps.rootRef();
      this.readThunkSigField = this.mb.funcType([EQ_REF, rootRef, F64], []);
    }
    return this.readThunkSigField;
  }

  chunkT(): number {
    if (this.chunkTField !== null) return this.chunkTField;
    // Every OTHER type the fields need is resolved BEFORE the call
    // (module.ts's selfStructType contract: `make` must not intern
    // anything, since the reserved index would move under it).
    const bytesRef = this.deps.bytesRef();
    this.chunkTField = this.mb.selfStructType("%w.rs.chunk", (self) => [
      { storage: bytesRef, mutable: false }, // CHUNK_BYTES
      { storage: I32, mutable: true }, // CHUNK_OFF
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // CHUNK_NEXT
    ]);
    return this.chunkTField;
  }

  chunkRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.chunkT() };
  }

  stateT(): number {
    if (this.stateTField !== null) return this.stateTField;
    const readThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.readThunkSig() };
    this.stateTField = this.mb.structType([
      { storage: F64, mutable: true }, // RS_HWM
      { storage: F64, mutable: true }, // RS_LENGTH
      { storage: this.chunkRef(), mutable: true }, // RS_HEAD
      { storage: this.chunkRef(), mutable: true }, // RS_TAIL
      { storage: I32, mutable: true }, // RS_FLOWING
      { storage: I32, mutable: true }, // RS_READING
      { storage: I32, mutable: true }, // RS_SYNC
      { storage: I32, mutable: true }, // RS_ENDED
      { storage: I32, mutable: true }, // RS_END_EMITTED
      { storage: I32, mutable: true }, // RS_END_SCHEDULED
      { storage: I32, mutable: true }, // RS_NEED_READABLE
      { storage: I32, mutable: true }, // RS_EMITTED_READABLE
      { storage: I32, mutable: true }, // RS_RESUME_SCHEDULED
      { storage: I32, mutable: true }, // RS_DESTROYED
      { storage: this.deps.errRef(), mutable: true }, // RS_ERROR
      { storage: I32, mutable: true }, // RS_EMIT_CLOSE
      { storage: I32, mutable: true }, // RS_AUTO_DESTROY
      { storage: EQ_REF, mutable: true }, // RS_READ_CLOS
      { storage: readThunkRef, mutable: true }, // RS_READ_THUNK
      { storage: I32, mutable: true }, // RS_READABLE_LISTENING
      { storage: I32, mutable: true }, // RS_READING_MORE
    ]);
    return this.stateTField;
  }

  stateRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.stateT() };
  }

  private tickT(): number {
    if (this.tickTField !== null) return this.tickTField;
    const rootRef = this.deps.rootRef();
    this.tickTField = this.mb.selfStructType("%w.rs.tick", (self) => [
      { storage: rootRef, mutable: false }, // RT_ROOT
      { storage: I32, mutable: false }, // RT_OP
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // RT_NEXT
    ]);
    return this.tickTField;
  }

  private tickRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.tickT() };
  }

  /* ── state lookup ──────────────────────────────────────────────────── */

  /** `(root) -> state` — lazily allocates the state struct with every
   * scalar at its zero/unset default and stores it back into the root's
   * own stream-state field (mirrors events.ts's regEnsure). Construction
   * (readable.new/init) calls this THEN immediately overwrites hwm/auto-
   * destroy/emitClose/the read closure — this function only guarantees a
   * non-null state exists, exactly like regEnsure's own contract. */
  stateEnsure(): number {
    return this.cached("stateEnsure", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [this.stateRef()]), "%w.rs.stateEnsure");
      const c = new Code();
      const R = 0, N = 1;
      c.localGet(R);
      c.structGet(this.deps.rootStruct(), STREAM_STATE);
      c.refIsNull();
      c.ifVoid();
      c.f64Const(65536); // hwm default (overwritten by construction; Node's real non-Windows default)
      c.f64Const(0); // length
      c.refNull(this.chunkT()); // head
      c.refNull(this.chunkT()); // tail
      c.i32Const(-1); // flowing
      c.i32Const(0); // reading
      c.i32Const(1); // sync — Node's real default: TRUE from construction (RS_SYNC's own header)
      c.i32Const(0); // ended
      c.i32Const(0); // end_emitted
      c.i32Const(0); // end_scheduled
      c.i32Const(0); // need_readable
      c.i32Const(0); // emitted_readable
      c.i32Const(0); // resume_scheduled
      c.i32Const(0); // destroyed
      c.refNull(this.errType()); // error
      c.i32Const(1); // emit_close default (overwritten by construction)
      c.i32Const(1); // auto_destroy default (overwritten by construction)
      c.refNull(EQ_HEAP); // read_clos
      c.refNull(this.readThunkSig()); // read_thunk
      c.i32Const(0); // readable_listening
      c.i32Const(0); // reading_more
      c.structNew(this.stateT());
      c.localSet(N);
      c.localGet(R);
      c.localGet(N);
      c.structSet(this.deps.rootStruct(), STREAM_STATE);
      c.end();
      c.localGet(R);
      c.structGet(this.deps.rootStruct(), STREAM_STATE);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  private errType(): number {
    const ref = this.deps.errRef();
    if (ref.kind !== "ref") throw new Error("wasm emitter bug: errRef is not a ref type");
    return ref.typeIndex;
  }

  /* ── the private tick FIFO (scr_st_tick / scr_stream_dispatch_one) ──── */

  private q(): { head: number; tail: number } {
    if (this.tickQueue === null) {
      const t = this.tickRef();
      const init = (w: ByteWriter): void => {
        w.u8(0xd0); // ref.null $rTick
        w.sleb(this.tickT());
      };
      this.tickQueue = { head: this.mb.addGlobal(t, true, init), tail: this.mb.addGlobal(t, true, init) };
    }
    return this.tickQueue;
  }

  /** `(root, op: i32) -> void` — schedules ONE deferred stream emission:
   * appends a node to this file's own private list, then posts one bare
   * marker onto nexttick.ts's queue (the stage-0 seam) so it dispatches
   * in true FIFO order against user nextTicks (2627's pin). Callers own
   * their own idempotency guards (end_scheduled, emitted_readable, etc)
   * — this function always enqueues unconditionally. */
  private scheduleTick(): number {
    // cachedRecursive, NOT plain cached: this function's own body reaches
    // BACK into itself through a real cycle (scheduleTick -> dispatchOne
    // -> opResume -> flow -> readCore -> endReadableCore ->
    // scheduleTick again) — events.ts's emitDispatch/fireMetaHelper
    // header explains the exact hazard (a plain `cached` only records the
    // index once `build` fully RETURNS, so the reentrant call during that
    // same build recurses into building a SECOND copy forever). Reserving
    // the index before building the body, as this does, is what breaks
    // the cycle.
    return this.cachedRecursive(
      "scheduleTick",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), I32], []), "%w.rs.scheduleTick"),
      (idx) => {
        const q = this.q();
        const c = new Code();
        const ROOT = 0, OP = 1, N = 2;
        c.localGet(ROOT);
        c.localGet(OP);
        c.refNull(this.tickT());
        c.structNew(this.tickT());
        c.localSet(N);
        c.globalGet(q.tail);
        c.refIsNull();
        c.ifVoid();
        c.localGet(N);
        c.globalSet(q.head);
        c.else_();
        c.globalGet(q.tail);
        c.localGet(N);
        c.structSet(this.tickT(), RT_NEXT);
        c.end();
        c.localGet(N);
        c.globalSet(q.tail);
        // ref.func requires the target in the module's declared-functions
        // element segment (module.ts's declareFuncRef) — dispatchOne is
        // taken BY REFERENCE here (not called directly), so it needs the
        // explicit declaration every plain `call` site gets for free.
        this.mb.declareFuncRef(this.dispatchOne());
        c.refFunc(this.dispatchOne());
        c.call(this.deps.enqueueRaw());
        this.mb.setBody(idx, [this.tickRef()], c.bytes());
      },
    );
  }

  /** `() -> ()` — the raw marker's target (nexttick.ts's bare-funcref
   * seam): pops ONE node off this file's private list and dispatches by
   * op code. nexttick.ts's drain() already checks the exception cell
   * after calling this and traps if it's set — an uncaught 'error'
   * inside `opError` needs no unwind logic of its own here. */
  private dispatchOne(): number {
    return this.cachedRecursive(
      "dispatchOne",
      () => this.mb.declareFunc(this.deps.rawFnType(), "%w.rs.dispatchOne"),
      (idx) => {
        const q = this.q();
        const c = new Code();
        const N = 0, ROOT = 1, OP = 2;
        c.globalGet(q.head);
        c.localSet(N);
        c.localGet(N);
        c.structGet(this.tickT(), RT_NEXT);
        c.globalSet(q.head);
        c.globalGet(q.head);
        c.refIsNull();
        c.ifVoid();
        c.refNull(this.tickT());
        c.globalSet(q.tail);
        c.end();
        c.localGet(N);
        c.refNull(this.tickT());
        c.structSet(this.tickT(), RT_NEXT);
        c.localGet(N);
        c.structGet(this.tickT(), RT_ROOT);
        c.localSet(ROOT);
        c.localGet(N);
        c.structGet(this.tickT(), RT_OP);
        c.localSet(OP);
        // NO "clear sync here" step — that was this file's own invented
        // one-time latch (the gate-round B2 finding). `sync` is now
        // cleared ONLY by `callRead`'s own per-_read-call bracket,
        // matching Node's real `state.sync` exactly (RS_SYNC's header).
        c.localGet(OP);
        c.i32Const(OP_READABLE);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opReadable());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_RESUME);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opResume());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_END);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opEnd());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_ERROR);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opError());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_CLOSE);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opClose());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_READMORE);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opReadMore());
        c.else_();
        // OP_PRIME_READ, exhaustive: the op codes are this file's own
        // closed enum, never a runtime-supplied value.
        c.localGet(ROOT);
        c.call(this.opPrimeRead());
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        this.mb.setBody(idx, [this.tickRef(), this.deps.rootRef(), I32], c.bytes());
      },
    );
  }

  /* ── the chunk list ────────────────────────────────────────────────── */

  /** `(state, bytes, front: i32) -> void` — appends (or, if `front`,
   * prepends) one chunk node and adds its length to `state.length`
   * (scr_stream_rbuf_push, minus the ring-buffer representation — a
   * plain list here). */
  private appendChunk(): number {
    return this.cached("appendChunk", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.stateRef(), this.deps.bytesRef(), I32], []),
        "%w.rs.appendChunk",
      );
      const c = new Code();
      const ST = 0, BY = 1, FRONT = 2, N = 3;
      c.localGet(BY);
      c.i32Const(0);
      c.refNull(this.chunkT());
      c.structNew(this.chunkT());
      c.localSet(N);
      c.localGet(FRONT);
      c.ifVoid();
      c.localGet(N);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.structSet(this.chunkT(), CHUNK_NEXT);
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_HEAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_TAIL);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_TAIL);
      c.end();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_TAIL);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_HEAD);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_TAIL);
      c.localGet(N);
      c.structSet(this.chunkT(), CHUNK_NEXT);
      c.end();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_TAIL);
      c.end();
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(BY);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.f64ConvertI32S();
      c.f64Add();
      c.structSet(this.stateT(), RS_LENGTH);
      this.mb.setBody(idx, [this.chunkRef()], c.bytes());
      return idx;
    });
  }

  /* ── push family ───────────────────────────────────────────────────── */

  /** `(root, bytes, front: i32) -> i32(should-push-more)` —
   * scr_stream_add_chunk ported: push-after-EOF errors (destroy path,
   * matching Node's `ERR_STREAM_PUSH_AFTER_EOF`); otherwise the DIRECT-
   * EMIT fast path (flowing + empty buffer + not mid-`_read` + not a
   * front/unshift push + a live 'data' listener ⇒ synchronous 'data',
   * skipping the buffer entirely) or buffering + a collapsed 'readable'
   * kick. */
  pushCore(): number {
    return this.cached("pushCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, this.deps.bytesRef(), I32], [I32]), "%w.rs.push");
      const c = new Code();
      const ROOT = 0, BYTES = 1, FRONT = 2, ST = 3, COND = 4, ARGS = 5;
      const pushCanPushMore = (): void => {
        // canPushMore(state): !ended && (length < hwm || length==0) —
        // the lifted source's OWN function (lift2.cjs), returned
        // VERBATIM from every exit of this one (zero-length, front,
        // back, and the final fall-through) — not just the fall-through,
        // per B3/R1's fix.
        c.localGet(ST);
        c.structGet(this.stateT(), RS_ENDED);
        c.i32Eqz();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_LENGTH);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_HWM);
        c.f64Lt();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_LENGTH);
        c.f64Const(0);
        c.f64Eq();
        c.i32Or();
        c.i32And();
      };
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      // ZERO-LENGTH, BEFORE the ended/destroyed checks — B3/R1's fix,
      // Node's OWN position (lift2.cjs's readableAddChunkPushByteMode:
      // the `chunk.length<=0` branch comes BEFORE the `kEnded` check),
      // which is what makes a zero-length push AFTER EOF a silent
      // `canPushMore()` (false) rather than ERR_STREAM_PUSH_AFTER_EOF
      // (pb/b2's pin) — R1 and B3 are the SAME fix. Front (unshift) and
      // back (push) differ here too: the lifted
      // readableAddChunkUnshiftByteMode's zero-length branch does NOT
      // clear `reading` and does NOT call `maybeReadMore` — only the
      // push (back) side does both.
      c.localGet(BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.i32Const(0);
      c.i32LeS();
      c.ifVoid();
      c.localGet(FRONT);
      c.ifVoid();
      c.else_();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_READING);
      c.localGet(ROOT);
      c.call(this.maybeReadMoreCore());
      c.end();
      pushCanPushMore();
      c.return_();
      c.end();
      // The EOF guard is DIFFERENT for front (unshift) vs back (push) —
      // Node's real `readableAddChunk`: the back path checks `state.
      // ended` (push() after push(null), ERR_STREAM_PUSH_AFTER_EOF) and
      // `state.destroyed`; the FRONT path checks `state.endEmitted`
      // instead (ERR_STREAM_UNSHIFT_AFTER_END_EVENT) and does NOT
      // consult `ended`/`destroyed` at all — unshift() called from a
      // 'readable'/'data' handler that runs AFTER push(null) already set
      // `ended` (but BEFORE 'end' has emitted) is perfectly legal
      // (1686's pin: `unshift()` inside the 'readable' callback, called
      // after a `push(null)` earlier in the same synchronous script).
      c.localGet(FRONT);
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.ifVoid();
      c.localGet(ROOT);
      this.deps.buildErrorLit(
        c,
        "%Error",
        "Error",
        (cc) => this.deps.lit(cc, "stream.unshift() after end event"),
        "ERR_STREAM_UNSHIFT_AFTER_END_EVENT",
      );
      c.call(this.destroyErrCore());
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.ifVoid();
      c.localGet(ROOT);
      this.deps.buildErrorLit(
        c,
        "%Error",
        "Error",
        (cc) => this.deps.lit(cc, "stream.push() after EOF"),
        "ERR_STREAM_PUSH_AFTER_EOF",
      );
      c.call(this.destroyErrCore());
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_READING);
      c.end();
      // addChunk(stream, state, chunk, front) — lift.cjs's own condition
      // does NOT exclude `front` (an unshift CAN take the direct-emit
      // path too, if flowing+sync+dataListening+length===0 all hold);
      // every operand here is a pure read, so unconditional evaluation +
      // i32And-chaining is safe (the i32.and-no-short-circuit gotcha is
      // about skipping UNSAFE operand evaluation, not about combining
      // already-safe comparisons).
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_SYNC);
      c.i32Eqz();
      c.i32And();
      c.localGet(ROOT);
      this.deps.lit(c, "data");
      c.call(this.deps.countOf());
      c.f64Const(0);
      c.f64Gt();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.i32And();
      c.localSet(COND);
      c.localGet(COND);
      c.ifVoid();
      // Node's real `addChunk` direct-emit arm touches only
      // `awaitDrainWriters` (out of this tier's scope, no `pipe()`) and
      // `stream.emit('data', chunk)` — no `emittedReadable` clear here
      // (dropped: the reviewer proved it unobservable either way — h1's
      // own probe fails IDENTICALLY with the clear reinstated, isolating
      // its root cause to something else entirely: this tier's single
      // tri-state `RS_FLOWING` does not model Node's real kHasFlowing/
      // kReadableListening dual-bit legacy pause()/resume() interaction
      // with a 'readable' listener, a materially deeper gap outside this
      // round's scope — and an unmotivated deviation from the lifted
      // source accumulates risk even when benign today).
      this.emitDataFrom(c, ROOT, BYTES, ARGS);
      c.else_();
      c.localGet(ST);
      c.localGet(BYTES);
      c.localGet(FRONT);
      c.call(this.appendChunk());
      c.localGet(ST);
      c.structGet(this.stateT(), RS_NEED_READABLE);
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.scheduleReadable());
      c.end();
      c.end();
      c.localGet(ROOT);
      c.call(this.maybeReadMoreCore());
      pushCanPushMore();
      this.mb.setBody(idx, [this.stateRef(), I32, this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, str, front: i32) -> i32` — `push(str)`'s plain-UTF-8 decode
   * (pushStrEnc's explicit-encoding form is pass 2), then pushCore. */
  pushStrCore(): number {
    return this.cached("pushStrCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, this.deps.strRef(), I32], [I32]), "%w.rs.pushStr");
      const c = new Code();
      const ROOT = 0, STR = 1, FRONT = 2;
      c.localGet(ROOT);
      c.localGet(STR);
      c.call(this.deps.bytesFromStrUtf8());
      c.localGet(FRONT);
      c.call(this.pushCore());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `push(null)`: Node's real `onEofChunk` (lift.cjs),
   * ported exactly (the gate-round B2/R4/R5 fix — the prior design's
   * "outside a _read call, run flow() synchronously" heuristic
   * approximated this function's OWN ultimate effect without actually
   * BEING it, which is why it needed a second invented flag to gate
   * correctly; `onEofChunk` needs none, because the real branch is keyed
   * on `sync` alone). Always returns false (push(null) has no other
   * caller-visible answer; `canPushMore` after `ended=true` collapses to
   * false regardless). */
  pushNullCore(): number {
    return this.cached("pushNullCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.pushNull");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_ENDED);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_SYNC);
      c.ifVoid();
      // if (kSync): emitReadable(stream) — the SCHEDULER, tick-deferred.
      c.localGet(ROOT);
      c.call(this.scheduleReadable());
      c.else_();
      // else: state &= ~kNeedReadable; state |= kEmittedReadable;
      // emitReadable_(stream) — called SYNCHRONOUSLY (not scheduled);
      // `opReadable` IS `emitReadable_`'s body (it also unconditionally
      // calls `flow()` at its own end, which is what drains a flowing
      // stream right here — R4/R5's "EOF-path readable emissions").
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ROOT);
      c.call(this.opReadable());
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `endReadable` (lift2.cjs): schedules
   * the 'end' tick, gated ONLY by `!endEmitted` (plus this file's own
   * `end_scheduled` dedup — RS_END_SCHEDULED's own header). R2's fix:
   * called ONLY from `readCore`'s three call sites (Node's `read()` is
   * the ONLY caller of `endReadable` in the lifted source — NOT from
   * `pushNullCore`/push(null) directly, which is what the prior design
   * did, proactively ending a stream nobody ever called `read()`/
   * `resume()`/`pipe()` on and changing exit codes on ordinary programs
   * that have no consumer at all — pb/c3's pin: `push(null)` alone,
   * with 'end'/'close' listeners but no read/flow driver, never emits
   * either, byte-exact against Node). `endReadableNT` — the tick body —
   * is `opEnd`, unchanged in shape (its own re-check at tick time
   * already covers "one more unshift snuck in"). */
  private endReadableCore(): number {
    return this.cached("endReadableCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.endReadable");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_SCHEDULED);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_END_SCHEDULED);
      c.localGet(ROOT);
      c.i32Const(OP_END);
      c.call(this.scheduleTick());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `emitReadable` (lift.cjs): the
   * SCHEDULER half (clears `needReadable` unconditionally, collapses
   * repeat calls via `emittedReadable`, schedules the OP_READABLE tick
   * — `emitReadable_`/`opReadable` is the tick BODY, called through
   * `dispatchOne` here, and ALSO directly for the synchronous EOF path,
   * `pushNullCore`'s own call). */
  private scheduleReadable(): number {
    return this.cached("scheduleReadable", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.scheduleReadable");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_EMITTED_READABLE);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ROOT);
      c.i32Const(OP_READABLE);
      c.call(this.scheduleTick());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `maybeReadMore` (lift2.cjs, R3): the
   * SCHEDULER half (guarded by `reading`/`readingMore` — `kConstructed`
   * is always true here, this tier fences the async-`construct` option
   * entirely). `maybeReadMore_`/`opReadMore` is the tick body. */
  private maybeReadMoreCore(): number {
    return this.cached("maybeReadMoreCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.maybeReadMore");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING_MORE);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_READING_MORE);
      c.localGet(ROOT);
      c.i32Const(OP_READMORE);
      c.call(this.scheduleTick());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `() -> void`'s tick body — Node's real `maybeReadMore_` (lift2.cjs):
   * loops `stream.read(0)` while under the highWaterMark (or flowing
   * with an empty buffer), stopping once a round produces no growth —
   * pb/b6's pin (`_read` filling the buffer to `highWaterMark` with
   * NOTHING else driving it — no 'data' listener, no explicit `.read()`
   * calls — is this loop's own doing, not `_read`'s). */
  private opReadMore(): number {
    return this.cached("opReadMore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opReadMore");
      const c = new Code();
      const ROOT = 0, ST = 1, LEN = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.block();
      c.loop();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.brIf(1);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Lt();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.i32And();
      c.i32Or();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localSet(LEN);
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      c.localGet(LEN);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Eq();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_READING_MORE);
      this.mb.setBody(idx, [this.stateRef(), F64], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `nReadingNextTick` (lift2.cjs's
   * `Readable.prototype.on` override, the 'readable' arm): a bare
   * `stream.read(0)`, scheduled via a plain `process.nextTick`, not
   * called synchronously from `onReadableAdded` itself — 2572's fix (a
   * synchronous priming call there clears `sync` before a same-turn
   * `push(null)` gets to run, which flips `onEofChunk`'s own branch and
   * produces an extra, Node-never-emits 'readable' cycle). */
  private opPrimeRead(): number {
    return this.cached("opPrimeRead", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opPrimeRead");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** Emits 'data' with a one-element dyn-boxed-bytes tuple through
   * events.ts's general dispatch (the emitData ABI decision, this file's
   * header) — inlined at each call site against the CALLER's own local
   * slots (`rootLocal`/`bytesLocal` already hold the values;
   * `argsScratch` is a spare local the caller declared for this). */
  private emitDataFrom(c: Code, rootLocal: number, bytesLocal: number, argsScratch: number): void {
    c.i32Const(1); // the dyn-vec's own `len` field, ahead of `buf`
    this.deps.boxBytes(c, (cc) => this.deps.pushBytesPayload(cc, (ccc) => ccc.localGet(bytesLocal)));
    c.arrayNewFixed(this.deps.dynArrBufType(), 1);
    c.structNew(this.deps.dynArrStructType());
    c.localSet(argsScratch);
    c.localGet(rootLocal);
    this.deps.lit(c, "data");
    c.localGet(argsScratch);
    c.call(this.deps.emitDispatch());
    c.drop(); // hadListeners is not observed here
  }

  /** `(state, f64 take) -> bytes` — takes exactly `take` bytes off the
   * front of the chunk list, spanning as many chunks as needed
   * (scr_stream_rbuf_take's byte-mode branch), advancing each consumed
   * chunk's `off` and dropping it once exhausted, decrementing
   * `state.length`. `take` is always <= state.length (the caller's own
   * invariant — read_n clamps before calling). Single-chunk-exact-take is
   * NOT special-cased: array.copy over one segment is exactly as cheap
   * as the general loop's one iteration. */
  private takeFromChunks(): number {
    return this.cached("takeFromChunks", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.stateRef(), F64], [this.deps.bytesRef()]), "%w.rs.take");
      const c = new Code();
      const ST = 0, TAKE = 1, TOTAL = 2, OUT = 3, DESTOFF = 4, REMAIN = 5, H = 6, AVAIL = 7, HERE = 8;
      c.localGet(TAKE);
      c.i32TruncF64S();
      c.localSet(TOTAL);
      c.localGet(TOTAL);
      c.arrayNewDefault(this.deps.bytesBufType());
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(DESTOFF);
      c.localGet(TOTAL);
      c.localSet(REMAIN);
      c.block();
      c.loop();
      c.localGet(REMAIN);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.localSet(H);
      // avail = head.bytes.len - head.off
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.i32Sub();
      c.localSet(AVAIL);
      c.localGet(AVAIL);
      c.localGet(REMAIN);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(AVAIL);
      c.else_();
      c.localGet(REMAIN);
      c.end();
      c.localSet(HERE);
      // array.copy(out, destOff, head.bytes.storage, head.bytes.off + head.off, here)
      c.localGet(OUT);
      c.localGet(DESTOFF);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_STORAGE);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_OFF);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.i32Add();
      c.localGet(HERE);
      c.arrayCopy(this.deps.bytesBufType(), this.deps.bytesBufType());
      c.localGet(DESTOFF);
      c.localGet(HERE);
      c.i32Add();
      c.localSet(DESTOFF);
      c.localGet(REMAIN);
      c.localGet(HERE);
      c.i32Sub();
      c.localSet(REMAIN);
      // advance/drop the head chunk
      c.localGet(HERE);
      c.localGet(AVAIL);
      c.i32GeS();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_NEXT);
      c.structSet(this.stateT(), RS_HEAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.refNull(this.chunkT());
      c.structSet(this.stateT(), RS_TAIL);
      c.end();
      c.else_();
      c.localGet(H);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.localGet(HERE);
      c.i32Add();
      c.structSet(this.chunkT(), CHUNK_OFF);
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(TAKE);
      c.f64Sub();
      c.structSet(this.stateT(), RS_LENGTH);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(TOTAL);
      c.structNew(this.deps.bytesStructType());
      this.mb.setBody(
        idx,
        [I32, { kind: "ref", nullable: false, typeIndex: this.deps.bytesBufType() }, I32, I32, this.chunkRef(), I32, I32],
        c.bytes(),
      );
      return idx;
    });
  }

  /* ── read / call_read / flow ──────────────────────────────────────── */

  /** `(root) -> void` — the bracketed `this._read(state.highWaterMark)`
   * call, matching `Readable.prototype.read`'s OWN inline shape (lift3.
   * cjs) exactly: `reading` and `sync` are set TOGETHER right before the
   * call; the call itself is wrapped in a try/catch (`errorOrDestroy` on
   * throw — D2's fix, the gate round's callRead header wrongly claimed
   * this shape already; the try/catch IS part of it), and `sync` is
   * cleared right after, UNCONDITIONALLY, whether the call threw or not
   * — `reading` is Node's signal for "is a _read cycle still
   * outstanding", and it is cleared ONLY by `push()`'s own logic
   * (readableAddChunkPushByteMode's `state[kState] &= ~kReading`), never
   * by `read()`'s post-call code. The gate-round B2 finding: the prior
   * design cleared BOTH here unconditionally, which destroyed the "did
   * _read push synchronously" signal `readCore`'s own doRead branch
   * needs to decide whether to recompute `n`. The caller (`readCore`'s
   * doRead branch — the ONLY caller now) owns the `reading`/`ended`/
   * `destroyed`/absent-closure gate; this function no longer re-derives
   * it. */
  private callRead(): number {
    return this.cached("callRead", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.callRead");
      const c = new Code();
      const ROOT = 0, ST = 1, ERR = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READ_CLOS);
      c.refIsNull();
      c.ifVoid();
      c.return_(); // defensive only — construction always supplies one
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_READING);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_SYNC);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READ_CLOS);
      c.localGet(ROOT);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READ_THUNK);
      c.callRef(this.readThunkSig());
      // try { this._read(hwm) } catch (err) { errorOrDestroy(this, err) }
      // — D2's fix. `tryCatchAsError` catches ONLY an Error-shaped OBJ
      // throw (this tier's `RS_ERROR` slot has no other shape to hold);
      // anything else stays pending and propagates as before (named, not
      // silently dropped — D2 pins pb/f7's shape, a genuine `new Error`).
      this.deps.tryCatchAsError(c);
      c.localSet(ERR);
      c.localGet(ERR);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(ERR);
      c.call(this.destroyErrCore());
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_SYNC);
      this.mb.setBody(idx, [this.stateRef(), this.deps.errRef()], c.bytes());
      return idx;
    });
  }

  /** `(state, n: f64, absent: i32) -> f64` — Node's real `howMuchToRead`
   * (lift4.cjs), verbatim: 0 when nothing can be given (bad `n`, or
   * ended with an empty buffer); one whole object in object mode (out of
   * this tier's scope — objectMode is always-false, never reached); an
   * ABSENT `n` (Node's NaN) takes only the FRONT buffered entry's
   * remaining bytes while flowing with a non-empty buffer (so 'data'
   * preserves each push()'s own chunk boundary — 1685's pin) and the
   * WHOLE buffer otherwise; an explicit `n` clamps to what's available,
   * or to everything once ended. Factored out because `readCore` calls
   * it TWICE (Node's own `read()` does too — once up front, again after
   * a synchronous `_read` push invalidates the first answer). */
  private howMuchToRead(): number {
    return this.cached("howMuchToRead", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.stateRef(), F64, I32], [F64]), "%w.rs.howMuchToRead");
      const c = new Code();
      const ST = 0, N = 1, ABSENT = 2;
      // Node's real check is `n<=0`, where an absent `n` is NaN and
      // `NaN<=0` is ALWAYS false — so the "n<=0" arm must never fire for
      // absent reads. This build passes a literal 0 as N's placeholder
      // when ABSENT is set, so the comparison has to be gated explicitly
      // (a bare N<=0 would wrongly true for every absent/flow() call).
      c.localGet(ABSENT);
      c.i32Eqz();
      c.localGet(N);
      c.f64Const(0);
      c.f64Le();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.i32Or();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(ABSENT);
      c.ifResult(F64);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.i32And();
      c.ifResult(F64);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.i32Sub();
      c.f64ConvertI32S();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.end();
      c.else_();
      c.localGet(N);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Le();
      c.ifResult(F64);
      c.localGet(N);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.ifResult(F64);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.else_();
      c.f64Const(0);
      c.end();
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root, n: f64, absent: i32) -> bytes|null` — `Readable.prototype.
   * read`, ported line-for-line from the lifted source (lift3.cjs; the
   * gate-round's ground truth) with this tier's scope cuts: no dynamic
   * highWaterMark growth (`n > hwm` raising it — no pass-1/2 claim needs
   * it), no encoding/decoder/objectMode, no `errorEmitted`/`closeEmitted`
   * gate on the final 'data' emission (named, not silently dropped: the
   * gate-round's fix list does not touch this condition, and every
   * pass-1 claim that BOTH successfully takes AND is errorEmitted/
   * closeEmitted at that instant does not exist — adding the exact gate
   * back would need RS_ERROR_EMITTED/RS_CLOSE_EMITTED, which the gate
   * round named dead and this stays within its own fix list rather than
   * re-growing the struct for an unflagged corner). */
  readCore(): number {
    return this.cached("readCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, F64, I32], [this.deps.bytesRef()]), "%w.rs.read");
      const c = new Code();
      const ROOT = 0, N = 1, ABSENT = 2, ST = 3, NW = 4, RESULT = 5, ARGS = 6, DOREAD = 7, ISFIN = 8, TRUNCN = 9;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      // Node's real n-coercion, the OTHER clause (D4; `n===undefined
      // -> NaN` is D1's fix, already the ABSENT flag by the time this
      // runs): `!Number.isInteger(n) -> n=parseInt(n,10)`. parseInt
      // stringifies first: a FINITE non-integer truncates toward zero
      // (its leading digits before the decimal point); a NON-finite
      // value (+-Infinity) stringifies to a leading non-digit, so
      // parseInt answers NaN — which folds into the SAME absent path
      // here, since nothing downstream distinguishes "the arg was
      // omitted" from "Node's own coercion turned it into NaN" (pb/f10:
      // read(Infinity) reads the whole buffer, exactly like a bare
      // read()). Lands at the very top, matching Node's OWN placement
      // (before `nOrig` is even captured) — NOT at the take site, which
      // is what corrupted the length for a fractional size instead of
      // truncating it (the coercion-matrix pin in 1686). isInteger(n)
      // is tested as `isFinite(n) && trunc(n)===n` — `isFinite` itself
      // as `n-n===0` (NaN-NaN and Infinity-Infinity both give NaN,
      // never 0; every finite n, including -0, gives exactly 0). NOT
      // exact for one sub-microscopic fractional corner — SEMANTICS.md
      // S046 carries the measured boundary and the rationale; this
      // comment deliberately does not restate it (the entry is the
      // single source).
      c.localGet(N);
      c.localGet(N);
      c.f64Sub();
      c.f64Const(0);
      c.f64Eq();
      c.localSet(ISFIN);
      c.localGet(N);
      c.f64Trunc();
      c.localSet(TRUNCN);
      c.localGet(ABSENT);
      c.i32Eqz();
      c.localGet(ISFIN);
      c.localGet(TRUNCN);
      c.localGet(N);
      c.f64Eq();
      c.i32And();
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ISFIN);
      c.ifVoid();
      c.localGet(TRUNCN);
      c.localSet(N);
      c.else_();
      c.f64Const(NaN);
      c.localSet(N);
      c.i32Const(1);
      c.localSet(ABSENT);
      c.end();
      c.end();
      // if (n !== 0) state.emittedReadable = false — absent (NaN) is
      // always !==0.
      c.localGet(ABSENT);
      c.localGet(N);
      c.f64Const(0);
      c.f64Ne();
      c.i32Or();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.end();
      // read(0)-to-trigger-readable fast path.
      c.localGet(ABSENT);
      c.i32Eqz();
      c.localGet(N);
      c.f64Const(0);
      c.f64Eq();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_NEED_READABLE);
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Const(0);
      c.f64Ne();
      c.ifResult(I32);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Ge();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.endReadableCore());
      c.else_();
      c.localGet(ROOT);
      c.call(this.scheduleReadable());
      c.end();
      c.refNull(this.deps.bytesStructType());
      c.return_();
      c.end();
      c.end();
      // n = howMuchToRead(n, state)
      c.localGet(ST);
      c.localGet(N);
      c.localGet(ABSENT);
      c.call(this.howMuchToRead());
      c.localSet(NW);
      // if (n===0 && ended): finish up.
      c.localGet(NW);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.endReadableCore());
      c.end();
      c.refNull(this.deps.bytesStructType());
      c.return_();
      c.end();
      // doRead computation.
      c.localGet(ST);
      c.structGet(this.stateT(), RS_NEED_READABLE);
      c.localSet(DOREAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(NW);
      c.f64Sub();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Lt();
      c.i32Or();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(DOREAD);
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Or();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(DOREAD);
      c.else_();
      c.localGet(DOREAD);
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      c.localGet(ROOT);
      c.call(this.callRead());
      // "If _read pushed data synchronously, then `reading` will be
      // false, and we need to re-evaluate how much data we can return."
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(N);
      c.localGet(ABSENT);
      c.call(this.howMuchToRead());
      c.localSet(NW);
      c.end();
      c.end();
      c.end();
      // ret = n>0 ? fromList(n,state) : null
      c.localGet(NW);
      c.f64Const(0);
      c.f64Gt();
      c.ifResult(this.deps.bytesRef());
      c.localGet(ST);
      c.localGet(NW);
      c.call(this.takeFromChunks());
      c.else_();
      c.refNull(this.deps.bytesStructType());
      c.end();
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Le();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      c.f64Const(0);
      c.localSet(NW);
      c.else_();
      // NW's `state.length -= NW` already happened INSIDE takeFromChunks
      // (its own documented contract) — a second decrement here would
      // double-subtract every successful take (found via d2's dropped
      // second 'data' event: length going 2->0 instead of 2->1 after
      // taking 1 byte off a 2-byte buffer).
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      // "if we tried to read() past the EOF, then emit end" — nOrig!==n:
      // absent is always !== (NaN semantics), an explicit n compares its
      // ORIGINAL value against the post-take NW.
      c.localGet(ABSENT);
      c.localGet(N);
      c.localGet(NW);
      c.f64Ne();
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.endReadableCore());
      c.end();
      c.end();
      c.localGet(RESULT);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      this.emitDataFrom(c, ROOT, RESULT, ARGS);
      c.end();
      c.localGet(RESULT);
      this.mb.setBody(
        idx,
        [this.stateRef(), F64, this.deps.bytesRef(), this.deps.dynArrRef(), I32, I32, F64],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(root) -> void` — while flowing, repeatedly pulls everything
   * currently available (calling `_read` to refill when empty) and lets
   * `readCore` emit 'data' as it goes, until nothing more is available
   * (scr_stream_flow). Stops early if a 'data' listener threw (the
   * exception cell is set — the caller's own pending-check propagates
   * it; this loop just must not keep pumping past it). */
  flow(): number {
    return this.cached("flow", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.flow");
      const c = new Code();
      const ROOT = 0, ST = 1, CHUNK = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.block();
      c.loop();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Ne();
      c.brIf(1);
      c.globalGet(this.deps.excKind());
      c.brIf(1);
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(1);
      c.call(this.readCore());
      c.localSet(CHUNK);
      c.localGet(CHUNK);
      c.refIsNull();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.bytesRef()], c.bytes());
      return idx;
    });
  }

  /* ── pause / resume / unshift ─────────────────────────────────────── */

  /** `(root) -> void` — flips to paused and fires 'pause' SYNCHRONOUSLY
   * (Node's own sync/tick split — only when actually transitioning away
   * from flowing/unset, matching `flowing !== false`). */
  pauseCore(): number {
    return this.cached("pauseCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.pause");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(0);
      c.i32Ne();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_FLOWING);
      this.emitNoArgFrom(c, ROOT, "pause", ARGS);
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — flips to flowing and schedules the 'resume' tick
   * once (collapsed via `resume_scheduled`, matching `!flowing`). */
  resumeCore(): number {
    return this.cached("resumeCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.resume");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Ne();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_FLOWING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_RESUME_SCHEDULED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_RESUME_SCHEDULED);
      c.localGet(ROOT);
      c.i32Const(OP_RESUME);
      c.call(this.scheduleTick());
      c.end();
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — the `.on('data', cb)` side effect (Node's
   * `Readable.prototype.on` override): auto-resumes UNLESS the stream is
   * explicitly paused (`flowing === false` exactly — an unset/-1 stream
   * still auto-resumes, matching `flowing !== false`). */
  onDataAdded(): number {
    return this.cached("onDataAdded", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.onDataAdded");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(0);
      c.i32Ne();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.resumeCore());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — the `.on('readable', cb)` side effect: arms
   * `needReadable`/`readableListening`, forces paused mode, and either
   * schedules the collapsed 'readable' tick (content already buffered)
   * or opportunistically primes `_read` (nothing buffered yet) —
   * ONE-TIME (`readableListening` guards re-entry on a second
   * registration, and `endEmitted` on a stream that already finished). */
  onReadableAdded(): number {
    return this.cached("onReadableAdded", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.onReadableAdded");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READABLE_LISTENING);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_READABLE_LISTENING);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_FLOWING);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ROOT);
      c.i32Const(OP_READABLE);
      c.call(this.scheduleTick());
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.ifVoid();
      // Node's real `nReadingNextTick` (2572's fix): a SCHEDULED
      // `stream.read(0)`, not a synchronous call here — a same-turn
      // synchronous `read(0)` would clear `sync` (via `callRead`'s own
      // bracket) before a later-in-the-SAME-turn `push(null)` runs,
      // flipping `onEofChunk`'s sync-vs-direct branch and producing an
      // extra 'readable' cycle Node never fires (opPrimeRead's header).
      c.localGet(ROOT);
      c.i32Const(OP_PRIME_READ);
      c.call(this.scheduleTick());
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `isPaused()`: `flowing === false` exactly (NOT
   * "not flowing" — the unset/-1 state answers false too, matching
   * Node's `state.flowing === false`). */
  isPausedCore(): number {
    return this.cached("isPausedCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.isPaused");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(0);
      c.i32Eq();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /* ── destroy ───────────────────────────────────────────────────────── */

  /** `(root, err: errRef|null) -> void` — the NO-USER-`_destroy`-OVERRIDE
   * default path only (this pass — see the file header): idempotent
   * (`destroyed` guards the whole function, matching Node's `if
   * (state.destroyed) return`), schedules 'error' THEN 'close' as two
   * SEPARATE ticks in that order (scr_stream_do_destroy — FIFO dispatch
   * makes 'error' always land before 'close', 1694/1698's pin). */
  destroyErrCore(): number {
    return this.cached("destroyErrCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, this.deps.errRef()], []), "%w.rs.destroyErr");
      const c = new Code();
      const ROOT = 0, ERR = 1, ST = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_DESTROYED);
      c.localGet(ERR);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(ERR);
      c.structSet(this.stateT(), RS_ERROR);
      c.localGet(ROOT);
      c.i32Const(OP_ERROR);
      c.call(this.scheduleTick());
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_EMIT_CLOSE);
      c.ifVoid();
      c.localGet(ROOT);
      c.i32Const(OP_CLOSE);
      c.call(this.scheduleTick());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — `destroy()` with no error, destroyErrCore's
   * plain-error-null twin. */
  destroyCore(): number {
    return this.cached("destroyCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.destroy");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.refNull(this.errType());
      c.call(this.destroyErrCore());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /* ── the tick op handlers ─────────────────────────────────────────── */

  /** Emits a NO-ARGUMENT event ('pause'/'resume'/'end'/'close') through
   * events.ts's general dispatch — the same empty-tuple shape the meta
   * events use (events.ts's `fireMetaHelper`, mirrored here for a
   * zero-element tuple instead of a one-string one). */
  private emitNoArgFrom(c: Code, rootLocal: number, name: string, argsScratch: number): void {
    c.i32Const(0); // the dyn-vec's own `len` field, ahead of `buf`
    c.arrayNewFixed(this.deps.dynArrBufType(), 0);
    c.structNew(this.deps.dynArrStructType());
    c.localSet(argsScratch);
    c.localGet(rootLocal);
    this.deps.lit(c, name);
    c.localGet(argsScratch);
    c.call(this.deps.emitDispatch());
    c.drop();
  }

  /** Node's real `emitReadable_` (lift.cjs) — the OP_READABLE tick body,
   * and ALSO called DIRECTLY (a plain function `call`, not through a
   * scheduled tick) from `pushNullCore`'s synchronous EOF branch, the
   * exact dual role the lifted source itself gives this function. Does
   * NOT clear `needReadable` (unlike the prior design) — Node's real
   * function never touches it except the OR-only `need_readable` set
   * near its own end; the CALLER (`scheduleReadable`/`pushNullCore`)
   * clears it before invoking this, matching `emitReadable`/`onEofChunk`
   * exactly. Always calls `flow()` at the end (R4/R5's fix — this is
   * what drains a stream on the EOF path with nothing else consuming). */
  private opReadable(): number {
    return this.cached("opReadable", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opReadable");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.i32And();
      c.ifVoid();
      this.emitNoArgFrom(c, ROOT, "readable", ARGS);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.end();
      // state |= (!(flowing||ended) && length<=hwm) ? needReadable : 0 —
      // OR-only, never clears.
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Le();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      c.localGet(ROOT);
      c.call(this.flow());
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  private opResume(): number {
    return this.cached("opResume", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opResume");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_RESUME_SCHEDULED);
      this.emitNoArgFrom(c, ROOT, "resume", ARGS);
      c.localGet(ROOT);
      c.call(this.flow());
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  private opEnd(): number {
    return this.cached("opEnd", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opEnd");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_END_SCHEDULED);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32Eqz();
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_END_EMITTED);
      this.emitNoArgFrom(c, ROOT, "end", ARGS);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_AUTO_DESTROY);
      c.ifVoid();
      c.localGet(ROOT);
      c.refNull(this.errType());
      c.call(this.destroyErrCore());
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  private opError(): number {
    return this.cached("opError", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opError");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      // RS_ERROR_EMITTED dropped (the gate round's dead-field instruction
      // — nothing in this file's own scope reads it back; Node's real
      // `errorEmitted` only gates the far-side 'data'/'error' re-entrancy
      // checks this file doesn't model, per readCore's own header note).
      c.localGet(ROOT);
      c.call(this.deps.hasErrorListeners());
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.call(this.deps.errDispatch());
      c.else_();
      this.deps.setUncaughtError(c, (cc) => {
        cc.localGet(ST);
        cc.structGet(this.stateT(), RS_ERROR);
      });
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  private opClose(): number {
    return this.cached("opClose", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opClose");
      const c = new Code();
      const ROOT = 0, ARGS = 1;
      this.emitNoArgFrom(c, ROOT, "close", ARGS);
      this.mb.setBody(idx, [this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  /* ── the scalar property surface ──────────────────────────────────── */

  /** `(root) -> f64` — `readableLength`. */
  lengthOf(): number {
    return this.cached("lengthOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.rs.length");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_LENGTH);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> f64` — `readableHighWaterMark`. */
  hwmOf(): number {
    return this.cached("hwmOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.rs.hwm");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_HWM);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — the raw tri-state (-1/0/1); the emitter.ts call
   * site maps this to the nullable-bool union `readableFlowing` answers
   * (-1 -> null). */
  flowingRaw(): number {
    return this.cached("flowingRaw", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.flowingRaw");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_FLOWING);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `_readableState.emittedReadable` (2572's pin). */
  emittedReadableOf(): number {
    return this.cached("emittedReadableOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.emittedReadable");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_EMITTED_READABLE);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> errRef|null` — `stream.errored`. */
  erroredOf(): number {
    return this.cached("erroredOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [this.deps.errRef()]), "%w.rs.errored");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_ERROR);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }
}
