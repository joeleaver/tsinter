/* node:diagnostics_channel and AsyncLocalStorage (node:async_hooks) on the
 * WasmGC tier — Node v24.18.1's lib/diagnostics_channel.js and
 * lib/internal/async_local_storage/async_context_frame.js (with
 * internal/async_context_frame.js: v24 runs AsyncContextFrame by default)
 * transcribed into the module. No host import. Emitted lazily: a module
 * that never reaches a dc.* / als.* libCall gets none of this.
 *
 * CHANNELS. A process-global registry; a Channel value is its registry
 * index (the IR's f64 handle). A channel record carries Node's state:
 * `active` is the Channel → ActiveChannel prototype swap (markActive runs
 * BEFORE validateFunction, so a rejected subscribe still leaves the
 * channel active; maybeMarkInactive runs only from unsubscribe and
 * unbindStore), the subscriber list is copy-on-write exactly like
 * `this._subscribers = ArrayPrototypeSlice(...)` (so publish iterates the
 * array it read — the mid-publish self-unsubscribe snapshot rule), and the
 * bound stores are (store id, transform) pairs in Map insertion order,
 * also copy-on-write so a runStores in flight keeps the transforms it
 * started with (Node captures them in its wrapStoreRun chain).
 *
 * Node's WeakRefMap lets an unreferenced channel be garbage-collected and
 * re-created; this registry keeps every channel (SEMANTICS.md S092 (d)).
 *
 * SUBSCRIBER ERRORS. publish catches a subscriber's throw and re-raises it
 * from a process.nextTick job (`triggerUncaughtException(err, false)`):
 * the remaining subscribers still run and the error surfaces as the
 * tier's ordinary uncaught exception (S007's rendering). A bound store's
 * throwing transform takes the same route and the run continues without
 * that store, as in wrapStoreRun.
 *
 * TRACING CHANNELS. A registry of five channel indices. traceSync /
 * traceCallback / tracePromise / runStores share ONE recursive runStores
 * (the wrapStoreRun chain: the LAST bound store is outermost) over a
 * `body` record whose `op` selects the innermost closure Node passes.
 * tracePromise's `PromisePrototypeThen(promise, resolve, reject)` is the
 * emitter's dyn-promise reaction trio (%w.dynthen.go) with two native
 * FUNC handlers, so reject's `PromiseReject(err)` is adopted with Node's
 * two extra jobs.
 *
 * ASYNC CONTEXT. The current AsyncContextFrame is one module global (null
 * = no frame): a store-id → value map copied on every enterWith, with
 * `run` transcribed exactly (prior / ObjectIs / enterWith / finally
 * enterWith(prior) — the restore re-derives from the CURRENT frame, as
 * Node's does) and `disable` deleting from the current frame in place.
 * Jobs carry the frame captured when they were scheduled: promises.ts's
 * waiter slot (every promise job), `wrapVoid` (the timer, immediate and
 * nextTick callbacks the emitter wraps at the call site), and the
 * setImmediate function value's own capture. */
import { Code } from "./code.js";
import { emitFlatCast } from "./strings.js";
import type { VecInfo } from "./arrays.js";
import type { ByteWriter } from "./bytes.js";
import { DK, DYN_KIND, DYN_NUM, DYN_REF, OBJ_PROTO, OBJ_PROTO_PLAIN, type DynBuilder } from "./dyn.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

const ANY_HEAP = -0x12;
const ANY_REF: ValType = { kind: "ref", nullable: true, typeIndex: ANY_HEAP };

/** The five tracing events, in Node's `traceEvents` order — also the
 * frontend's `dc.tcChannel` index order (DC_TRACE_EVENTS). */
const TRACE_EVENTS = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;
const EV_START = 0;
const EV_END = 1;
const EV_ASYNC_START = 2;
const EV_ASYNC_END = 3;
const EV_ERROR = 4;

/* The channel record's fields. */
const CH_NAME = 0;
const CH_ACTIVE = 1;
const CH_SUBS = 2;
const CH_SIDS = 3;
const CH_SFNS = 4;

/* The ALS frame's fields: parallel exact-length arrays. */
const FR_IDS = 0;
const FR_VALS = 1;

/* The runStores body record's fields. */
const B_OP = 0;
const B_TC = 1;
const B_FN = 2;
const B_CTX = 3;
const B_THIS = 4;
const B_ARGS = 5;

/* runStores body ops — the innermost closure each caller hands Node's
 * runStores. */
const OP_APPLY = 0; // Channel.runStores: ReflectApply(fn, thisArg, args)
const OP_SYNC = 1; // traceSync's try/catch/finally
const OP_PROMISE = 2; // tracePromise's try/catch/finally
const OP_CALLBACK = 3; // traceCallback's try/catch/finally
const OP_WRAPPED = 4; // wrappedCallback's try/finally

/** The libCall families whose callbacks this tier's event loop delivers
 * from somewhere other than the four queues that carry an
 * AsyncContextFrame (promise jobs, nextTick, timers, immediates): sockets,
 * servers, streams, child processes, readline/stdin, fs.watch/exists, the
 * process listener events, node:test. A module that reaches
 * AsyncLocalStorage refuses them by name (`libCall:als:context-through-
 * <family>`) rather than run their callbacks in the wrong context. */
const ALS_BLOCKED_FAMILIES: readonly string[] = [
  "http.", "http2.", "https.", "net.", "tls.", "dgram.", "dns.",
  "readable.", "writable.", "duplex.", "transform.", "passthrough.", "stream.",
  "child.", "cp.", "stdin.", "rl.", "watcher.", "procStream.", "test.",
  "fs.watch", "fs.existsChk", "sp.finished", "sp.pipeline",
  "process.onSignal", "process.offSignal", "process.onExit", "process.onWarning",
  "process.emitWarning", "process.onUnhandledRejection", "process.onRejectionHandled",
];

export function alsBlockedFamily(fn: string): string | null {
  for (const f of ALS_BLOCKED_FAMILIES) {
    if (fn.startsWith(f)) return f.endsWith(".") ? f.slice(0, -1) : f;
  }
  return null;
}

export interface DcDeps {
  strRef: () => ValType;
  strType: () => number;
  lit: (c: Code, s: string) => void;
  concat: () => number;
  strEq: () => number;
  f64ToStr: () => number;
  /** The dyn vector (an ARR payload) and its push / new-with-length. */
  vec: () => VecInfo;
  vecPush: () => number;
  vecNewLen: () => number;
  /** Fill the exception cell with a builtin error instance. */
  setCellError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, code: string | null) => void;
  exc: () => { kindG: number; f64G: number; refG: number; preG: number; caughtT: number };
  cellClear: (c: Code) => void;
  /** () -> dyn: the PENDING exception as a dyn value (caughtToDyn's ladder
   * over the cell). */
  cellToDyn: () => number;
  voidClos: () => { clos: number; fn: number };
  nextTickEnqueue: () => number;
  /** (void closure) -> f64 — the immediate queue. */
  setImmediate: () => number;
  promRef: () => ValType;
  promT: () => number;
  mint: () => number;
  settle: () => number;
  /** (PROMISE box, handler vector, mode) -> the derived PROMISE box. */
  thenGo: () => number;
  thenMode: number;
  excRef: number;
  /** The module reaches AsyncLocalStorage: jobs capture the frame. */
  alsLive: boolean;
}

export class DcBuilder {
  private readonly fns = new Map<string, number>();
  private chanTField: number | null = null;
  private tcTField: number | null = null;
  private frameTField: number | null = null;
  private bodyTField: number | null = null;
  private readonly envs = new Map<string, number>();
  private readonly globals = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly dyn: DynBuilder,
    private readonly deps: DcDeps,
  ) {}

  /* ── plumbing ─────────────────────────────────────────────────────── */

  private def(
    name: string,
    params: ValType[],
    results: ValType[],
    build: (c: Code, local: (t: ValType) => number) => void,
  ): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.dc.${name}`);
    this.fns.set(name, idx);
    const locals: ValType[] = [];
    const c = new Code();
    build(c, (t) => {
      locals.push(t);
      return params.length + locals.length - 1;
    });
    this.mb.setBody(idx, locals, c.bytes());
    return idx;
  }

  /** A function of an EXISTING type (a closure or thunk signature). */
  private defTyped(
    name: string,
    typeIdx: number,
    nparams: number,
    build: (c: Code, local: (t: ValType) => number) => void,
  ): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(typeIdx, `%w.dc.${name}`);
    this.fns.set(name, idx);
    const locals: ValType[] = [];
    const c = new Code();
    build(c, (t) => {
      locals.push(t);
      return nparams + locals.length - 1;
    });
    this.mb.setBody(idx, locals, c.bytes());
    this.mb.declareFuncRef(idx);
    return idx;
  }

  private global(name: string, t: ValType, init: (w: ByteWriter) => void): number {
    const hit = this.globals.get(name);
    if (hit !== undefined) return hit;
    const g = this.mb.addGlobal(t, true, init);
    this.globals.set(name, g);
    return g;
  }

  private i32Global(name: string): number {
    return this.global(name, I32, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
  }

  private nullGlobal(name: string, t: ValType & { kind: "ref" }): number {
    return this.global(name, t, (w) => {
      w.u8(0xd0);
      w.sleb(t.typeIndex);
    });
  }

  private get dynRef(): ValType {
    return this.dyn.dynRef();
  }

  private get vecRef(): ValType {
    return this.dyn.arrRef();
  }

  private get strRef(): ValType {
    return this.deps.strRef();
  }

  private dynBufT(): number {
    return this.mb.arrayType(this.dyn.dynRef(), true);
  }

  private dynBufRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.dynBufT() };
  }

  private i32ArrT(): number {
    return this.mb.arrayType(I32, true);
  }

  private i32ArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.i32ArrT() };
  }

  private chanT(): number {
    if (this.chanTField === null) {
      const fields = [
        { storage: this.strRef, mutable: false },
        { storage: I32, mutable: true },
        { storage: this.dynBufRef(), mutable: true },
        { storage: this.i32ArrRef(), mutable: true },
        { storage: this.dynBufRef(), mutable: true },
      ];
      this.chanTField = this.mb.openStructType("%w.dc.channel", fields);
    }
    return this.chanTField;
  }

  private chanRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.chanT() };
  }

  private chanArrT(): number {
    return this.mb.arrayType(this.chanRef(), true);
  }

  private tcT(): number {
    this.tcTField ??= this.mb.openStructType(
      "%w.dc.tracing",
      TRACE_EVENTS.map(() => ({ storage: I32, mutable: false })),
    );
    return this.tcTField;
  }

  private tcRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.tcT() };
  }

  private frameT(): number {
    this.frameTField ??= this.mb.openStructType("%w.als.frame", [
      { storage: this.i32ArrRef(), mutable: true },
      { storage: this.dynBufRef(), mutable: true },
    ]);
    return this.frameTField;
  }

  private frameRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.frameT() };
  }

  private bodyT(): number {
    this.bodyTField ??= this.mb.openStructType("%w.dc.body", [
      { storage: I32, mutable: false },
      { storage: I32, mutable: false },
      { storage: this.dynRef, mutable: false },
      { storage: this.dynRef, mutable: false },
      { storage: this.dynRef, mutable: false },
      { storage: this.vecRef, mutable: false },
    ]);
    return this.bodyTField;
  }

  private bodyRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bodyT() };
  }

  /** A closure environment subtyping the void closure struct. */
  private voidEnv(key: string, extra: ValType[]): number {
    const hit = this.envs.get(key);
    if (hit !== undefined) return hit;
    const pair = this.deps.voidClos();
    const env = this.mb.subStructType(
      `%w.dc.env.${key}`,
      [
        { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
        ...extra.map((t) => ({ storage: t, mutable: false })),
      ],
      pair.clos,
    );
    this.envs.set(key, env);
    return env;
  }

  /** A plain struct used as a native FUNC's closure (FN_CLOS is `eq`). */
  private thunkEnv(key: string, fields: ValType[]): number {
    const hit = this.envs.get(key);
    if (hit !== undefined) return hit;
    const env = this.mb.openStructType(
      `%w.dc.thunkEnv.${key}`,
      fields.map((t) => ({ storage: t, mutable: false })),
    );
    this.envs.set(key, env);
    return env;
  }

  private undef(c: Code): void {
    c.globalGet(this.dyn.undefinedGlobal());
  }

  private kindOf(c: Code, local: number): void {
    c.localGet(local);
    c.structGet(this.dyn.dynT(), DYN_KIND);
  }

  private pending(c: Code): void {
    c.globalGet(this.deps.exc().kindG);
  }

  /** if (pending) return <dummy>; */
  private returnIfPending(c: Code, dummy: ((c: Code) => void) | null): void {
    this.pending(c);
    c.ifVoid();
    if (dummy !== null) dummy(c);
    c.return_();
    c.end();
  }

  private nullDyn(c: Code): void {
    c.refNull(this.dyn.dynT());
  }

  private newVec(c: Code): void {
    c.f64Const(0);
    c.call(this.deps.vecNewLen());
  }

  /** Element `i` of the vector in `vecLocal`, undefined past its end. */
  private argAt(c: Code, vecLocal: number, i: number): void {
    this.dyn.arrLen(c, (x) => x.localGet(vecLocal));
    c.i32Const(i);
    c.i32GtS();
    c.ifResult(this.dynRef);
    this.dyn.arrAt(c, (x) => x.localGet(vecLocal), (x) => x.i32Const(i));
    c.else_();
    this.undef(c);
    c.end();
  }

  /** Snapshot the pending exception into a caught struct and clear the
   * cell; leaves the snapshot on the stack. */
  private snap(c: Code): void {
    const exc = this.deps.exc();
    c.globalGet(exc.kindG);
    c.globalGet(exc.f64G);
    c.globalGet(exc.refG);
    c.globalGet(exc.preG);
    c.structNew(exc.caughtT);
    this.deps.cellClear(c);
  }

  private snapRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.deps.exc().caughtT };
  }

  /** Re-raise the snapshot in `local` into the cell (kind last). */
  private restore(c: Code, local: number): void {
    const exc = this.deps.exc();
    c.localGet(local);
    c.structGet(exc.caughtT, 1);
    c.globalSet(exc.f64G);
    c.localGet(local);
    c.structGet(exc.caughtT, 2);
    c.globalSet(exc.refG);
    c.localGet(local);
    c.structGet(exc.caughtT, 3);
    c.globalSet(exc.preG);
    c.localGet(local);
    c.structGet(exc.caughtT, 0);
    c.globalSet(exc.kindG);
  }

  /** ERR_INVALID_ARG_TYPE for a non-function `argName` argument (Node's
   * validateFunction): `The "<argName>" argument must be of type
   * function. Received ...`. */
  private throwNotFunctionArg(c: Code, argName: string, valueLocal: number): void {
    this.deps.setCellError(
      c,
      "%TypeError",
      "TypeError",
      (x) => {
        this.deps.lit(x, `The "${argName}" argument must be of type function. Received `);
        x.localGet(valueLocal);
        x.call(this.dyn.specificType());
        x.call(this.deps.concat());
      },
      "ERR_INVALID_ARG_TYPE",
    );
  }

  /* ── calling dyn functions ────────────────────────────────────────── */

  /** %w.dc.applyNotFn(v) — V8's ReflectApply TypeError
   * (Runtime_ThrowApplyNonFunction): "Function.prototype.apply was called
   * on <v>, which is <a typeof | an object | null> and not a function".
   * The value renders for primitives, plain objects and arrays; any other
   * kind is a named fence (SEMANTICS.md S092 (a)). */
  private applyNotFn(): number {
    return this.def("applyNotFn", [this.dynRef], [], (c, local) => {
      const V = 0;
      const K = local(I32);
      const S = local(this.strRef);
      const D = local(this.strRef);
      const concat = this.deps.concat();
      this.kindOf(c, V);
      c.localSet(K);
      const is = (k: number): void => {
        c.localGet(K);
        c.i32Const(k);
        c.i32Eq();
      };
      const pair = (text: (x: Code) => void, desc: string): void => {
        text(c);
        c.localSet(S);
        this.deps.lit(c, desc);
        c.localSet(D);
      };
      // A plain non-error object renders V8's "#<Object>".
      is(DK.UNDEF);
      c.ifVoid();
      pair((x) => this.deps.lit(x, "undefined"), "a undefined");
      c.else_();
      is(DK.NULL);
      c.ifVoid();
      pair((x) => this.deps.lit(x, "null"), "null");
      c.else_();
      is(DK.BOOL);
      c.ifVoid();
      pair((x) => {
        x.localGet(V);
        x.structGet(this.dyn.dynT(), DYN_NUM);
        x.f64Const(0);
        x.f64Ne();
        x.ifResult(this.strRef);
        this.deps.lit(x, "true");
        x.else_();
        this.deps.lit(x, "false");
        x.end();
      }, "a boolean");
      c.else_();
      is(DK.NUM);
      c.ifVoid();
      pair((x) => {
        x.localGet(V);
        x.structGet(this.dyn.dynT(), DYN_NUM);
        x.call(this.deps.f64ToStr());
      }, "a number");
      c.else_();
      is(DK.STR);
      c.ifVoid();
      pair((x) => {
        x.localGet(V);
        x.structGet(this.dyn.dynT(), DYN_REF);
        emitFlatCast(x, this.deps.strType());
      }, "a string");
      c.else_();
      is(DK.ARR);
      c.ifVoid();
      pair((x) => this.deps.lit(x, "[object Array]"), "an object");
      c.else_();
      is(DK.OBJ);
      c.ifResult(I32);
      this.dyn.objPayload(c, (x) => x.localGet(V));
      c.structGet(this.dyn.objT(), OBJ_PROTO);
      c.i32Const(OBJ_PROTO_PLAIN);
      c.i32Eq();
      c.localGet(V);
      c.call(this.dyn.isError());
      c.i32Eqz();
      c.i32And();
      c.else_();
      c.i32Const(0);
      c.end();
      c.ifVoid();
      pair((x) => this.deps.lit(x, "#<Object>"), "an object");
      c.else_();
      this.deps.setCellError(
        c,
        "%Error",
        "Error",
        (x) => this.deps.lit(x, "calling a non-function value of this kind through diagnostics_channel or AsyncLocalStorage is not supported yet"),
        null,
      );
      c.return_();
      c.end();
      for (let i = 0; i < 6; i++) c.end();
      this.deps.setCellError(
        c,
        "%TypeError",
        "TypeError",
        (x) => {
          this.deps.lit(x, "Function.prototype.apply was called on ");
          x.localGet(S);
          x.call(concat);
          this.deps.lit(x, ", which is ");
          x.call(concat);
          x.localGet(D);
          x.call(concat);
          this.deps.lit(x, " and not a function");
          x.call(concat);
        },
        null,
      );
    });
  }

  /** %w.dc.apply(fn, thisArg, args) → dyn — ReflectApply(fn, thisArg,
   * args): the receiver rides the dyn this-stack for the call. Null with
   * the exception pending on a throw. */
  apply(): number {
    return this.def("apply", [this.dynRef, this.dynRef, this.vecRef], [this.dynRef], (c, local) => {
      const FN = 0, THIS = 1, ARGS = 2;
      const R = local(this.dynRef);
      this.kindOf(c, FN);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      c.localGet(FN);
      c.call(this.applyNotFn());
      this.nullDyn(c);
      c.return_();
      c.end();
      c.localGet(THIS);
      c.call(this.dyn.thisPush());
      c.localGet(FN);
      c.localGet(ARGS);
      this.deps.lit(c, "fn");
      c.call(this.dyn.callFn());
      c.localSet(R);
      c.call(this.dyn.thisPop());
      c.localGet(R);
    });
  }

  /** Call a FUNC dyn value with this = undefined and the given args. */
  private callPlain(c: Code, fnLocal: number, argsLocal: number, what: string): void {
    this.undef(c);
    c.call(this.dyn.thisPush());
    c.localGet(fnLocal);
    c.localGet(argsLocal);
    this.deps.lit(c, what);
    c.call(this.dyn.callFn());
    c.call(this.dyn.thisPop());
  }

  /* ── the uncaught re-raise ────────────────────────────────────────── */

  /** %w.dc.deferUncaught() — the pending exception moves into a
   * process.nextTick job that re-raises it (Node's
   * `process.nextTick(() => triggerUncaughtException(err, false))`). */
  private deferUncaught(): number {
    return this.def("deferUncaught", [], [], (c) => {
      const pair = this.deps.voidClos();
      const env = this.voidEnv("rethrow", [this.snapRef()]);
      const fn = this.defTyped("rethrow", pair.fn, 1, (x, local) => {
        const S = local(this.snapRef());
        x.localGet(0);
        x.refCast(env);
        x.structGet(env, 1);
        x.localSet(S);
        this.restore(x, S);
      });
      c.refFunc(fn);
      this.snap(c);
      c.structNew(env);
      c.call(this.deps.nextTickEnqueue());
    });
  }

  /* ── the channel registry ─────────────────────────────────────────── */

  private chansG(): number {
    return this.nullGlobal("chans", { kind: "ref", nullable: true, typeIndex: this.chanArrT() });
  }

  private nChansG(): number {
    return this.i32Global("nchans");
  }

  /** %w.dc.chanAt(i) → the channel record. */
  private chanAt(): number {
    return this.def("chanAt", [I32], [this.chanRef()], (c) => {
      c.globalGet(this.chansG());
      c.localGet(0);
      c.arrayGet(this.chanArrT());
    });
  }

  /** %w.dc.lookup(name) → index, or -1 (`channels.get(name)`). */
  private lookup(): number {
    return this.def("lookup", [this.strRef], [I32], (c, local) => {
      const I = local(I32);
      c.block();
      c.loop();
      c.localGet(I);
      c.globalGet(this.nChansG());
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.chansG());
      c.localGet(I);
      c.arrayGet(this.chanArrT());
      c.structGet(this.chanT(), CH_NAME);
      c.localGet(0);
      c.call(this.deps.strEq());
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
    });
  }

  /** %w.dc.channel(name) → index — `channel(name)`: the registered one,
   * or a new inactive channel. */
  channelIdx(): number {
    return this.def("channel", [this.strRef], [I32], (c, local) => {
      const arrT = this.chanArrT();
      const I = local(I32);
      const NB = local({ kind: "ref", nullable: true, typeIndex: arrT });
      c.localGet(0);
      c.call(this.lookup());
      c.localTee(I);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(I);
      c.return_();
      c.end();
      // Grow by doubling from 8.
      c.globalGet(this.chansG());
      c.refIsNull();
      c.ifVoid();
      c.i32Const(8);
      c.arrayNewDefault(arrT);
      c.globalSet(this.chansG());
      c.end();
      c.globalGet(this.nChansG());
      c.globalGet(this.chansG());
      c.arrayLen();
      c.i32GeU();
      c.ifVoid();
      c.globalGet(this.chansG());
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.arrayNewDefault(arrT);
      c.localTee(NB);
      c.i32Const(0);
      c.globalGet(this.chansG());
      c.i32Const(0);
      c.globalGet(this.nChansG());
      c.arrayCopy(arrT, arrT);
      c.localGet(NB);
      c.globalSet(this.chansG());
      c.end();
      c.globalGet(this.chansG());
      c.globalGet(this.nChansG());
      c.localGet(0);
      c.i32Const(0);
      c.refNull(this.dynBufT());
      c.refNull(this.i32ArrT());
      c.refNull(this.dynBufT());
      c.structNew(this.chanT());
      c.arraySet(arrT);
      c.globalGet(this.nChansG());
      c.globalGet(this.nChansG());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.nChansG());
    });
  }

  /** %w.dc.hasSubscribersName(name) → i32 — the module-level
   * `hasSubscribers(name)`: false for a channel never created. */
  hasSubscribersName(): number {
    return this.def("hasSubscribersName", [this.strRef], [I32], (c, local) => {
      const I = local(I32);
      c.localGet(0);
      c.call(this.lookup());
      c.localTee(I);
      c.i32Const(0);
      c.i32LtS();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(I);
      c.call(this.chanAt());
      c.structGet(this.chanT(), CH_ACTIVE);
      c.end();
    });
  }

  /** %w.dc.active(i) → i32 — `channel.hasSubscribers`. */
  active(): number {
    return this.def("active", [I32], [I32], (c) => {
      c.localGet(0);
      c.call(this.chanAt());
      c.structGet(this.chanT(), CH_ACTIVE);
    });
  }

  /** %w.dc.name(i) → the channel's name. */
  name(): number {
    return this.def("name", [I32], [this.strRef], (c) => {
      c.localGet(0);
      c.call(this.chanAt());
      c.structGet(this.chanT(), CH_NAME);
    });
  }

  /** markActive(channel), when the channel is still inactive. */
  private markActive(): number {
    return this.def("markActive", [this.chanRef()], [], (c) => {
      const chanT = this.chanT();
      c.localGet(0);
      c.structGet(chanT, CH_ACTIVE);
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(0);
      c.i32Const(1);
      c.structSet(chanT, CH_ACTIVE);
      c.localGet(0);
      c.i32Const(0);
      c.arrayNewDefault(this.dynBufT());
      c.structSet(chanT, CH_SUBS);
      c.localGet(0);
      c.i32Const(0);
      c.arrayNewDefault(this.i32ArrT());
      c.structSet(chanT, CH_SIDS);
      c.localGet(0);
      c.i32Const(0);
      c.arrayNewDefault(this.dynBufT());
      c.structSet(chanT, CH_SFNS);
    });
  }

  /** maybeMarkInactive(channel). */
  private maybeInactive(): number {
    return this.def("maybeInactive", [this.chanRef()], [], (c) => {
      const chanT = this.chanT();
      c.localGet(0);
      c.structGet(chanT, CH_SUBS);
      c.arrayLen();
      c.localGet(0);
      c.structGet(chanT, CH_SIDS);
      c.arrayLen();
      c.i32Or();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(0);
      c.i32Const(0);
      c.structSet(chanT, CH_ACTIVE);
      c.localGet(0);
      c.refNull(this.dynBufT());
      c.structSet(chanT, CH_SUBS);
      c.localGet(0);
      c.refNull(this.i32ArrT());
      c.structSet(chanT, CH_SIDS);
      c.localGet(0);
      c.refNull(this.dynBufT());
      c.structSet(chanT, CH_SFNS);
    });
  }

  /** Copy of `arr` (type `arrT`, local) with `push(c)` appended. */
  private appendCopy(c: Code, arrT: number, arrLocal: number, outLocal: number, push: (c: Code) => void): void {
    c.localGet(arrLocal);
    c.arrayLen();
    c.i32Const(1);
    c.i32Add();
    c.arrayNewDefault(arrT);
    c.localSet(outLocal);
    c.localGet(outLocal);
    c.i32Const(0);
    c.localGet(arrLocal);
    c.i32Const(0);
    c.localGet(arrLocal);
    c.arrayLen();
    c.arrayCopy(arrT, arrT);
    c.localGet(outLocal);
    c.localGet(arrLocal);
    c.arrayLen();
    push(c);
    c.arraySet(arrT);
  }

  /** Copy of `arr` without element `idxLocal`. */
  private removeCopy(c: Code, arrT: number, arrLocal: number, idxLocal: number, outLocal: number): void {
    c.localGet(arrLocal);
    c.arrayLen();
    c.i32Const(1);
    c.i32Sub();
    c.arrayNewDefault(arrT);
    c.localSet(outLocal);
    c.localGet(outLocal);
    c.i32Const(0);
    c.localGet(arrLocal);
    c.i32Const(0);
    c.localGet(idxLocal);
    c.arrayCopy(arrT, arrT);
    c.localGet(outLocal);
    c.localGet(idxLocal);
    c.localGet(arrLocal);
    c.localGet(idxLocal);
    c.i32Const(1);
    c.i32Add();
    c.localGet(arrLocal);
    c.arrayLen();
    c.localGet(idxLocal);
    c.i32Sub();
    c.i32Const(1);
    c.i32Sub();
    c.arrayCopy(arrT, arrT);
  }

  /** %w.dc.subscribe(i, fn) — Channel.subscribe / ActiveChannel.subscribe:
   * markActive, then validateFunction, then the copy-on-write push. */
  subscribe(): number {
    return this.def("subscribe", [I32, this.dynRef], [], (c, local) => {
      const chanT = this.chanT();
      const CH = local(this.chanRef());
      const A = local(this.dynBufRef());
      const NA = local(this.dynBufRef());
      c.localGet(0);
      c.call(this.chanAt());
      c.localTee(CH);
      c.call(this.markActive());
      this.kindOf(c, 1);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      this.throwNotFunctionArg(c, "subscription", 1);
      c.return_();
      c.end();
      c.localGet(CH);
      c.structGet(chanT, CH_SUBS);
      c.localSet(A);
      this.appendCopy(c, this.dynBufT(), A, NA, (x) => x.localGet(1));
      c.localGet(CH);
      c.localGet(NA);
      c.structSet(chanT, CH_SUBS);
    });
  }

  /** %w.dc.unsubscribe(i, fn) → i32 — found-ness, by strict equality. */
  unsubscribe(): number {
    return this.def("unsubscribe", [I32, this.dynRef], [I32], (c, local) => {
      const chanT = this.chanT();
      const bufT = this.dynBufT();
      const CH = local(this.chanRef());
      const A = local(this.dynBufRef());
      const NA = local(this.dynBufRef());
      const I = local(I32);
      c.localGet(0);
      c.call(this.chanAt());
      c.localTee(CH);
      c.structGet(chanT, CH_ACTIVE);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(CH);
      c.structGet(chanT, CH_SUBS);
      c.localSet(A);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(A);
      c.arrayLen();
      c.i32GeS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(A);
      c.localGet(I);
      c.arrayGet(bufT);
      c.localGet(1);
      c.call(this.dyn.strictEq());
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.removeCopy(c, bufT, A, I, NA);
      c.localGet(CH);
      c.localGet(NA);
      c.structSet(chanT, CH_SUBS);
      c.localGet(CH);
      c.call(this.maybeInactive());
      c.i32Const(1);
    });
  }

  /** %w.dc.publish(i, message) — every subscriber of the list read at
   * entry, called (message, name) with this = undefined; a throw is
   * re-raised from a nextTick job and the loop goes on. Never leaves an
   * exception pending. */
  publish(): number {
    return this.def("publish", [I32, this.dynRef], [], (c, local) => {
      const chanT = this.chanT();
      const bufT = this.dynBufT();
      const CH = local(this.chanRef());
      const A = local(this.dynBufRef());
      const I = local(I32);
      const NAME = local(this.dynRef);
      const ARGS = local(this.vecRef);
      const F = local(this.dynRef);
      c.localGet(0);
      c.call(this.chanAt());
      c.localTee(CH);
      c.structGet(chanT, CH_ACTIVE);
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(CH);
      c.structGet(chanT, CH_SUBS);
      c.localSet(A);
      this.dyn.boxStr(c, (x) => {
        x.localGet(CH);
        x.structGet(chanT, CH_NAME);
      });
      c.localSet(NAME);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(A);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(A);
      c.localGet(I);
      c.arrayGet(bufT);
      c.localSet(F);
      this.newVec(c);
      c.localSet(ARGS);
      c.localGet(ARGS);
      c.localGet(1);
      c.call(this.deps.vecPush());
      c.localGet(ARGS);
      c.localGet(NAME);
      c.call(this.deps.vecPush());
      this.callPlain(c, F, ARGS, "onMessage");
      c.drop();
      this.pending(c);
      c.ifVoid();
      c.call(this.deferUncaught());
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** publish from a `finally`: a pending exception is held aside around
   * the publish and restored after it. */
  private publishKeeping(): number {
    return this.def("publishKeeping", [I32, this.dynRef], [], (c, local) => {
      const S = local(this.snapRef());
      this.pending(c);
      c.ifVoid();
      this.snap(c);
      c.localSet(S);
      c.localGet(0);
      c.localGet(1);
      c.call(this.publish());
      this.restore(c, S);
      c.else_();
      c.localGet(0);
      c.localGet(1);
      c.call(this.publish());
      c.end();
    });
  }

  /** %w.dc.storeIndex(ids, id) → index or -1. */
  private storeIndex(): number {
    return this.def("storeIndex", [this.i32ArrRef(), I32], [I32], (c, local) => {
      const I = local(I32);
      c.localGet(0);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(-1);
      c.return_();
      c.end();
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(0);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(0);
      c.localGet(I);
      c.arrayGet(this.i32ArrT());
      c.localGet(1);
      c.i32Eq();
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
    });
  }

  /** %w.dc.bindStore(i, store, transform) — markActive, then
   * `this._stores.set(store, transform)` (a re-bind keeps its position). */
  bindStore(): number {
    return this.def("bindStore", [I32, I32, this.dynRef], [], (c, local) => {
      const chanT = this.chanT();
      const bufT = this.dynBufT();
      const idsT = this.i32ArrT();
      const CH = local(this.chanRef());
      const IDS = local(this.i32ArrRef());
      const FNS = local(this.dynBufRef());
      const NIDS = local(this.i32ArrRef());
      const NFNS = local(this.dynBufRef());
      const K = local(I32);
      c.localGet(0);
      c.call(this.chanAt());
      c.localTee(CH);
      c.call(this.markActive());
      c.localGet(CH);
      c.structGet(chanT, CH_SIDS);
      c.localSet(IDS);
      c.localGet(CH);
      c.structGet(chanT, CH_SFNS);
      c.localSet(FNS);
      c.localGet(IDS);
      c.localGet(1);
      c.call(this.storeIndex());
      c.localTee(K);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      // Replace the transform on a copy (a runStores in flight keeps its).
      c.localGet(FNS);
      c.arrayLen();
      c.arrayNewDefault(bufT);
      c.localTee(NFNS);
      c.i32Const(0);
      c.localGet(FNS);
      c.i32Const(0);
      c.localGet(FNS);
      c.arrayLen();
      c.arrayCopy(bufT, bufT);
      c.localGet(NFNS);
      c.localGet(K);
      c.localGet(2);
      c.arraySet(bufT);
      c.localGet(CH);
      c.localGet(NFNS);
      c.structSet(chanT, CH_SFNS);
      c.return_();
      c.end();
      this.appendCopy(c, idsT, IDS, NIDS, (x) => x.localGet(1));
      this.appendCopy(c, bufT, FNS, NFNS, (x) => x.localGet(2));
      c.localGet(CH);
      c.localGet(NIDS);
      c.structSet(chanT, CH_SIDS);
      c.localGet(CH);
      c.localGet(NFNS);
      c.structSet(chanT, CH_SFNS);
    });
  }

  /** %w.dc.unbindStore(i, store) → i32 found-ness. */
  unbindStore(): number {
    return this.def("unbindStore", [I32, I32], [I32], (c, local) => {
      const chanT = this.chanT();
      const CH = local(this.chanRef());
      const IDS = local(this.i32ArrRef());
      const FNS = local(this.dynBufRef());
      const NIDS = local(this.i32ArrRef());
      const NFNS = local(this.dynBufRef());
      const K = local(I32);
      c.localGet(0);
      c.call(this.chanAt());
      c.localTee(CH);
      c.structGet(chanT, CH_ACTIVE);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(CH);
      c.structGet(chanT, CH_SIDS);
      c.localTee(IDS);
      c.localGet(1);
      c.call(this.storeIndex());
      c.localTee(K);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(CH);
      c.structGet(chanT, CH_SFNS);
      c.localSet(FNS);
      this.removeCopy(c, this.i32ArrT(), IDS, K, NIDS);
      this.removeCopy(c, this.dynBufT(), FNS, K, NFNS);
      c.localGet(CH);
      c.localGet(NIDS);
      c.structSet(chanT, CH_SIDS);
      c.localGet(CH);
      c.localGet(NFNS);
      c.structSet(chanT, CH_SFNS);
      c.localGet(CH);
      c.call(this.maybeInactive());
      c.i32Const(1);
    });
  }

  /* ── runStores ────────────────────────────────────────────────────── */

  private newBody(c: Code, op: number, push: { tc?: (c: Code) => void; fn?: (c: Code) => void; ctx?: (c: Code) => void; self?: (c: Code) => void; args?: (c: Code) => void }): void {
    c.i32Const(op);
    if (push.tc) push.tc(c);
    else c.i32Const(-1);
    for (const p of [push.fn, push.ctx, push.self]) {
      if (p) p(c);
      else this.undef(c);
    }
    if (push.args) push.args(c);
    else this.newVec(c);
    c.structNew(this.bodyT());
  }

  /** %w.dc.runStores(i, data, body) → dyn — Channel.runStores /
   * ActiveChannel.runStores over the bound stores read at entry. */
  runStores(): number {
    return this.def("runStores", [I32, this.dynRef, this.bodyRef()], [this.dynRef], (c, local) => {
      const chanT = this.chanT();
      const CH = local(this.chanRef());
      c.localGet(0);
      c.call(this.chanAt());
      c.localTee(CH);
      c.structGet(chanT, CH_ACTIVE);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(2);
      c.call(this.runBody());
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(1);
      c.localGet(CH);
      c.structGet(chanT, CH_SIDS);
      c.localGet(CH);
      c.structGet(chanT, CH_SFNS);
      c.localGet(CH);
      c.structGet(chanT, CH_SIDS);
      c.arrayLen();
      c.localGet(2);
      c.call(this.runStoresAt());
    });
  }

  /** %w.dc.runStoresAt(i, data, ids, fns, k, body) — the wrapStoreRun
   * chain: entry k-1 is the outermost remaining store; k == 0 is
   * `run`'s own body (publish, then the body). */
  private runStoresAt(): number {
    return this.def(
      "runStoresAt",
      [I32, this.dynRef, this.i32ArrRef(), this.dynBufRef(), I32, this.bodyRef()],
      [this.dynRef],
      (c, local) => {
        const CHI = 0, DATA = 1, IDS = 2, FNS = 3, K = 4, BODY = 5;
        const ID = local(I32);
        const TF = local(this.dynRef);
        const CTX = local(this.dynRef);
        const PRIOR = local(this.dynRef);
        const ARGS = local(this.vecRef);
        const R = local(this.dynRef);
        const next = (x: Code): void => {
          x.localGet(CHI);
          x.localGet(DATA);
          x.localGet(IDS);
          x.localGet(FNS);
          x.localGet(K);
          x.i32Const(1);
          x.i32Sub();
          x.localGet(BODY);
          x.call(this.runStoresAt());
        };
        c.localGet(K);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(CHI);
        c.localGet(DATA);
        c.call(this.publish());
        c.localGet(BODY);
        c.call(this.runBody());
        c.return_();
        c.end();
        c.localGet(IDS);
        c.localGet(K);
        c.i32Const(1);
        c.i32Sub();
        c.arrayGet(this.i32ArrT());
        c.localSet(ID);
        c.localGet(FNS);
        c.localGet(K);
        c.i32Const(1);
        c.i32Sub();
        c.arrayGet(this.dynBufT());
        c.localSet(TF);
        // transform = defaultTransform when absent (undefined).
        this.kindOf(c, TF);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.ifVoid();
        c.localGet(DATA);
        c.localSet(CTX);
        c.else_();
        this.newVec(c);
        c.localSet(ARGS);
        c.localGet(ARGS);
        c.localGet(DATA);
        c.call(this.deps.vecPush());
        this.callPlain(c, TF, ARGS, "transform");
        c.localSet(CTX);
        this.pending(c);
        c.ifVoid();
        // A throwing transform: re-raised from a nextTick, and the run
        // continues WITHOUT this store (`return next()`).
        c.call(this.deferUncaught());
        next(c);
        c.return_();
        c.end();
        c.end();
        // store.run(context, next)
        c.localGet(ID);
        c.call(this.alsGetI());
        c.localTee(PRIOR);
        c.localGet(CTX);
        c.call(this.dyn.sameValueDyn());
        c.ifVoid();
        next(c);
        c.return_();
        c.end();
        c.localGet(ID);
        c.localGet(CTX);
        c.call(this.alsEnterWithI());
        next(c);
        c.localSet(R);
        c.localGet(ID);
        c.localGet(PRIOR);
        c.call(this.alsEnterWithI());
        c.localGet(R);
      },
    );
  }

  /** %w.dc.runBody(body) → dyn — the innermost closure. */
  private runBody(): number {
    return this.def("runBody", [this.bodyRef()], [this.dynRef], (c) => {
      const bodyT = this.bodyT();
      const arm = (op: number, fn: () => number): void => {
        c.localGet(0);
        c.structGet(bodyT, B_OP);
        c.i32Const(op);
        c.i32Eq();
        c.ifVoid();
        c.localGet(0);
        c.call(fn());
        c.return_();
        c.end();
      };
      arm(OP_SYNC, () => this.syncBody());
      arm(OP_PROMISE, () => this.promiseBody());
      arm(OP_CALLBACK, () => this.callbackBody());
      arm(OP_WRAPPED, () => this.wrappedBody());
      c.localGet(0);
      c.structGet(bodyT, B_FN);
      c.localGet(0);
      c.structGet(bodyT, B_THIS);
      c.localGet(0);
      c.structGet(bodyT, B_ARGS);
      c.call(this.apply());
    });
  }

  /** Channel index of event `ev` of the tracing channel in `tcLocal`
   * (an index into the tracing registry). */
  private tcCh(c: Code, tcLocal: number, ev: number): void {
    c.globalGet(this.tcsG());
    c.localGet(tcLocal);
    c.arrayGet(this.tcArrT());
    c.structGet(this.tcT(), ev);
  }

  /** `context = {}`: an undefined context argument takes the default
   * (a fresh plain object), as a JS default parameter does. */
  private defaultCtx(c: Code, local: number): void {
    this.kindOf(c, local);
    c.i32Const(DK.UNDEF);
    c.i32Eq();
    c.ifVoid();
    this.dyn.boxObj(c, (x) => this.dyn.pushNewObj(x, false));
    c.localSet(local);
    c.end();
  }

  /** The shared `catch (err) { context.error = err; error.publish(context);
   * throw err; } finally { end.publish(context); }` over a PENDING
   * exception. Leaves the (re-raised) exception pending. A context that
   * cannot take the `error` property throws that TypeError out of the
   * catch instead, end still publishing. */
  private catchPath(): number {
    return this.def("catchPath", [I32, this.dynRef], [], (c, local) => {
      const TC = 0, CTX = 1;
      const ERR = local(this.dynRef);
      const S = local(this.snapRef());
      const S2 = local(this.snapRef());
      c.call(this.deps.cellToDyn());
      c.localSet(ERR);
      this.snap(c);
      c.localSet(S);
      c.localGet(CTX);
      this.deps.lit(c, "error");
      c.localGet(ERR);
      c.call(this.dyn.keySet());
      this.pending(c);
      c.ifVoid();
      this.snap(c);
      c.localSet(S2);
      this.tcCh(c, TC, EV_END);
      c.localGet(CTX);
      c.call(this.publish());
      this.restore(c, S2);
      c.return_();
      c.end();
      this.tcCh(c, TC, EV_ERROR);
      c.localGet(CTX);
      c.call(this.publish());
      this.tcCh(c, TC, EV_END);
      c.localGet(CTX);
      c.call(this.publish());
      this.restore(c, S);
    });
  }

  /** traceSync's body. */
  private syncBody(): number {
    return this.def("syncBody", [this.bodyRef()], [this.dynRef], (c, local) => {
      const bodyT = this.bodyT();
      const TC = local(I32);
      const CTX = local(this.dynRef);
      const R = local(this.dynRef);
      c.localGet(0);
      c.structGet(bodyT, B_TC);
      c.localSet(TC);
      c.localGet(0);
      c.structGet(bodyT, B_CTX);
      c.localSet(CTX);
      c.localGet(0);
      c.structGet(bodyT, B_FN);
      c.localGet(0);
      c.structGet(bodyT, B_THIS);
      c.localGet(0);
      c.structGet(bodyT, B_ARGS);
      c.call(this.apply());
      c.localSet(R);
      this.pending(c);
      c.i32Eqz();
      c.ifVoid();
      // context.result = result (still inside the try).
      c.localGet(CTX);
      this.deps.lit(c, "result");
      c.localGet(R);
      c.call(this.dyn.keySet());
      c.end();
      this.pending(c);
      c.ifVoid();
      c.localGet(TC);
      c.localGet(CTX);
      c.call(this.catchPath());
      this.nullDyn(c);
      c.return_();
      c.end();
      this.tcCh(c, TC, EV_END);
      c.localGet(CTX);
      c.call(this.publish());
      c.localGet(R);
    });
  }

  /** traceCallback's body. */
  private callbackBody(): number {
    return this.def("callbackBody", [this.bodyRef()], [this.dynRef], (c, local) => {
      const bodyT = this.bodyT();
      const TC = local(I32);
      const CTX = local(this.dynRef);
      const R = local(this.dynRef);
      c.localGet(0);
      c.structGet(bodyT, B_TC);
      c.localSet(TC);
      c.localGet(0);
      c.structGet(bodyT, B_CTX);
      c.localSet(CTX);
      c.localGet(0);
      c.structGet(bodyT, B_FN);
      c.localGet(0);
      c.structGet(bodyT, B_THIS);
      c.localGet(0);
      c.structGet(bodyT, B_ARGS);
      c.call(this.apply());
      c.localSet(R);
      this.pending(c);
      c.ifVoid();
      c.localGet(TC);
      c.localGet(CTX);
      c.call(this.catchPath());
      this.nullDyn(c);
      c.return_();
      c.end();
      this.tcCh(c, TC, EV_END);
      c.localGet(CTX);
      c.call(this.publish());
      c.localGet(R);
    });
  }

  /** wrappedCallback's inner body: the original callback with the
   * wrapper's own this and arguments, then asyncEnd (finally). */
  private wrappedBody(): number {
    return this.def("wrappedBody", [this.bodyRef()], [this.dynRef], (c, local) => {
      const bodyT = this.bodyT();
      const TC = local(I32);
      const R = local(this.dynRef);
      c.localGet(0);
      c.structGet(bodyT, B_TC);
      c.localSet(TC);
      c.localGet(0);
      c.structGet(bodyT, B_FN);
      c.localGet(0);
      c.structGet(bodyT, B_THIS);
      c.localGet(0);
      c.structGet(bodyT, B_ARGS);
      c.call(this.apply());
      c.localSet(R);
      this.tcCh(c, TC, EV_ASYNC_END);
      c.localGet(0);
      c.structGet(bodyT, B_CTX);
      c.call(this.publishKeeping());
      c.localGet(R);
    });
  }

  /** A fulfilled promise of a dyn value, boxed (PromiseResolve of a
   * non-promise). */
  private resolvedBox(c: Code, valueLocal: number, promLocal: number): void {
    c.call(this.deps.mint());
    c.localTee(promLocal);
    c.i32Const(this.deps.excRef);
    c.f64Const(0);
    c.localGet(valueLocal);
    c.i32Const(-1);
    c.i32Const(1);
    c.call(this.deps.settle());
    c.i32Const(DK.PROMISE);
    c.f64Const(0);
    c.localGet(promLocal);
    c.structNew(this.dyn.dynT());
  }

  /** Named fence: an object with a callable `then` where Node adopts. */
  private thenableFence(c: Code, valueLocal: number, mLocal: number, message: string): void {
    this.kindOf(c, valueLocal);
    c.i32Const(DK.OBJ);
    c.i32Eq();
    c.ifVoid();
    this.dyn.objPayload(c, (x) => x.localGet(valueLocal));
    this.deps.lit(c, "then");
    c.call(this.dyn.objGet());
    c.localTee(mLocal);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    this.kindOf(c, mLocal);
    c.i32Const(DK.FUNC);
    c.i32Eq();
    c.ifVoid();
    this.deps.setCellError(c, "%Error", "Error", (x) => this.deps.lit(x, message), null);
    this.nullDyn(c);
    c.return_();
    c.end();
    c.end();
    c.end();
  }

  /** tracePromise's body: the traced call, a non-promise resolved,
   * `.then(resolve, reject)` through the dyn reaction trio, end (finally).
   * Answers the derived PROMISE box. */
  private promiseBody(): number {
    return this.def("promiseBody", [this.bodyRef()], [this.dynRef], (c, local) => {
      const bodyT = this.bodyT();
      const TC = local(I32);
      const CTX = local(this.dynRef);
      const R = local(this.dynRef);
      const M = local(this.dynRef);
      const P = local(this.deps.promRef());
      const H = local(this.vecRef);
      const D = local(this.dynRef);
      const env = this.tpEnv();
      c.localGet(0);
      c.structGet(bodyT, B_TC);
      c.localSet(TC);
      c.localGet(0);
      c.structGet(bodyT, B_CTX);
      c.localSet(CTX);
      c.localGet(0);
      c.structGet(bodyT, B_FN);
      c.localGet(0);
      c.structGet(bodyT, B_THIS);
      c.localGet(0);
      c.structGet(bodyT, B_ARGS);
      c.call(this.apply());
      c.localSet(R);
      this.pending(c);
      c.ifVoid();
      c.localGet(TC);
      c.localGet(CTX);
      c.call(this.catchPath());
      this.nullDyn(c);
      c.return_();
      c.end();
      this.kindOf(c, R);
      c.i32Const(DK.PROMISE);
      c.i32Ne();
      c.ifVoid();
      this.thenableFence(c, R, M, "tracePromise over a function returning a non-promise thenable is not supported yet");
      this.resolvedBox(c, R, P);
      c.localSet(R);
      c.end();
      // PromisePrototypeThen(promise, resolve, reject)
      this.newVec(c);
      c.localSet(H);
      for (const which of ["tpResolve", "tpReject"] as const) {
        c.localGet(H);
        this.dyn.boxFn(
          c,
          (x) => {
            x.localGet(TC);
            x.localGet(CTX);
            x.structNew(env);
          },
          (x) => x.refFunc(which === "tpResolve" ? this.tpResolve() : this.tpReject()),
          -1,
          (x) => this.deps.lit(x, which === "tpResolve" ? "resolve" : "reject"),
          1,
        );
        c.call(this.deps.vecPush());
      }
      c.localGet(R);
      c.localGet(H);
      c.i32Const(this.deps.thenMode);
      c.call(this.deps.thenGo());
      c.localSet(D);
      this.tcCh(c, TC, EV_END);
      c.localGet(CTX);
      c.call(this.publish());
      c.localGet(D);
    });
  }

  private tpEnv(): number {
    return this.thunkEnv("tp", [I32, this.dynRef]);
  }

  /** tracePromise's `resolve(result)` handler (a native FUNC thunk). */
  private tpResolve(): number {
    return this.defTyped("tpResolve", this.dyn.thunkSig(), 2, (c, local) => {
      const env = this.tpEnv();
      const TC = local(I32);
      const CTX = local(this.dynRef);
      const V = local(this.dynRef);
      c.localGet(0);
      c.refCast(env);
      c.structGet(env, 0);
      c.localSet(TC);
      c.localGet(0);
      c.refCast(env);
      c.structGet(env, 1);
      c.localSet(CTX);
      this.argAt(c, 1, 0);
      c.localSet(V);
      c.localGet(CTX);
      this.deps.lit(c, "result");
      c.localGet(V);
      c.call(this.dyn.keySet());
      this.returnIfPending(c, (x) => this.nullDyn(x));
      this.tcCh(c, TC, EV_ASYNC_START);
      c.localGet(CTX);
      c.call(this.publish());
      this.tcCh(c, TC, EV_ASYNC_END);
      c.localGet(CTX);
      c.call(this.publish());
      c.localGet(V);
    });
  }

  /** tracePromise's `reject(err)` handler: answers PromiseReject(err). */
  private tpReject(): number {
    return this.defTyped("tpReject", this.dyn.thunkSig(), 2, (c, local) => {
      const env = this.tpEnv();
      const TC = local(I32);
      const CTX = local(this.dynRef);
      const V = local(this.dynRef);
      const P = local(this.deps.promRef());
      c.localGet(0);
      c.refCast(env);
      c.structGet(env, 0);
      c.localSet(TC);
      c.localGet(0);
      c.refCast(env);
      c.structGet(env, 1);
      c.localSet(CTX);
      this.argAt(c, 1, 0);
      c.localSet(V);
      c.localGet(CTX);
      this.deps.lit(c, "error");
      c.localGet(V);
      c.call(this.dyn.keySet());
      this.returnIfPending(c, (x) => this.nullDyn(x));
      for (const ev of [EV_ERROR, EV_ASYNC_START, EV_ASYNC_END]) {
        this.tcCh(c, TC, ev);
        c.localGet(CTX);
        c.call(this.publish());
      }
      c.call(this.deps.mint());
      c.localTee(P);
      c.i32Const(this.deps.excRef);
      c.f64Const(0);
      c.localGet(V);
      c.i32Const(-1);
      c.i32Const(2);
      c.call(this.deps.settle());
      c.i32Const(DK.PROMISE);
      c.f64Const(0);
      c.localGet(P);
      c.structNew(this.dyn.dynT());
    });
  }

  /* ── tracing channels ─────────────────────────────────────────────── */

  private tcArrT(): number {
    return this.mb.arrayType(this.tcRef(), true);
  }

  private tcsG(): number {
    return this.nullGlobal("tcs", { kind: "ref", nullable: true, typeIndex: this.tcArrT() });
  }

  private nTcsG(): number {
    return this.i32Global("ntcs");
  }

  /** %w.dc.tcNew(5 channel indices) → tracing index. */
  private tcNew(): number {
    return this.def("tcNew", [I32, I32, I32, I32, I32], [I32], (c, local) => {
      const arrT = this.tcArrT();
      const NB = local({ kind: "ref", nullable: true, typeIndex: arrT });
      c.globalGet(this.tcsG());
      c.refIsNull();
      c.ifVoid();
      c.i32Const(8);
      c.arrayNewDefault(arrT);
      c.globalSet(this.tcsG());
      c.end();
      c.globalGet(this.nTcsG());
      c.globalGet(this.tcsG());
      c.arrayLen();
      c.i32GeU();
      c.ifVoid();
      c.globalGet(this.tcsG());
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.arrayNewDefault(arrT);
      c.localTee(NB);
      c.i32Const(0);
      c.globalGet(this.tcsG());
      c.i32Const(0);
      c.globalGet(this.nTcsG());
      c.arrayCopy(arrT, arrT);
      c.localGet(NB);
      c.globalSet(this.tcsG());
      c.end();
      c.globalGet(this.tcsG());
      c.globalGet(this.nTcsG());
      for (let i = 0; i < 5; i++) c.localGet(i);
      c.structNew(this.tcT());
      c.arraySet(arrT);
      c.globalGet(this.nTcsG());
      c.globalGet(this.nTcsG());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.nTcsG());
    });
  }

  /** %w.dc.tracingChannel(name) → tracing index — the string form: the
   * five `tracing:<name>:<event>` channels. */
  tracingChannel(): number {
    return this.def("tracingChannel", [this.strRef], [I32], (c) => {
      for (const ev of TRACE_EVENTS) {
        this.deps.lit(c, "tracing:");
        c.localGet(0);
        c.call(this.deps.concat());
        this.deps.lit(c, `:${ev}`);
        c.call(this.deps.concat());
        c.call(this.channelIdx());
      }
      c.call(this.tcNew());
    });
  }

  /** %w.dc.tracingChannelOf(5 channel indices) → tracing index. */
  tracingChannelOf(): number {
    return this.tcNew();
  }

  /** %w.dc.tcChannel(tc, ev) → channel index. */
  tcChannel(): number {
    return this.def("tcChannel", [I32, I32], [I32], (c) => {
      // ev is 0..4 (the frontend's literal): a branch per field.
      for (let ev = 0; ev < 5; ev++) {
        c.localGet(1);
        c.i32Const(ev);
        c.i32Eq();
        c.ifVoid();
        c.globalGet(this.tcsG());
        c.localGet(0);
        c.arrayGet(this.tcArrT());
        c.structGet(this.tcT(), ev);
        c.return_();
        c.end();
      }
      c.unreachable();
    });
  }

  /** %w.dc.tcHas(tc) → i32 — TracingChannel.hasSubscribers. */
  tcHas(): number {
    return this.def("tcHas", [I32], [I32], (c) => {
      for (let ev = 0; ev < 5; ev++) {
        this.tcCh(c, 0, ev);
        c.call(this.active());
        if (ev > 0) c.i32Or();
      }
    });
  }

  /** %w.dc.tcSubscribe(tc, handlers) — each truthy `handlers[name]`
   * subscribes to its channel. */
  tcSubscribe(): number {
    return this.def("tcSubscribe", [I32, this.dynRef], [], (c, local) => {
      const H = local(this.dynRef);
      TRACE_EVENTS.forEach((ev, i) => {
        c.localGet(1);
        this.deps.lit(c, ev);
        c.i32Const(0);
        c.call(this.dyn.keyGet());
        c.localSet(H);
        this.returnIfPending(c, null);
        c.localGet(H);
        c.call(this.dyn.truthy());
        c.ifVoid();
        this.tcCh(c, 0, i);
        c.localGet(H);
        c.call(this.subscribe());
        this.returnIfPending(c, null);
        c.end();
      });
    });
  }

  /** %w.dc.tcUnsubscribe(tc, handlers) → i32 — every truthy handler was
   * found. */
  tcUnsubscribe(): number {
    return this.def("tcUnsubscribe", [I32, this.dynRef], [I32], (c, local) => {
      const H = local(this.dynRef);
      const DONE = local(I32);
      c.i32Const(1);
      c.localSet(DONE);
      TRACE_EVENTS.forEach((ev, i) => {
        c.localGet(1);
        this.deps.lit(c, ev);
        c.i32Const(0);
        c.call(this.dyn.keyGet());
        c.localSet(H);
        this.returnIfPending(c, (x) => x.i32Const(0));
        c.localGet(H);
        c.call(this.dyn.truthy());
        c.ifVoid();
        this.tcCh(c, 0, i);
        c.localGet(H);
        c.call(this.unsubscribe());
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0);
        c.localSet(DONE);
        c.end();
        c.end();
      });
      c.localGet(DONE);
    });
  }

  /** %w.dc.traceSync(tc, fn, ctx, thisArg, args) → dyn. */
  traceSync(): number {
    return this.def("traceSync", [I32, this.dynRef, this.dynRef, this.dynRef, this.vecRef], [this.dynRef], (c) => {
      c.localGet(0);
      c.call(this.tcHas());
      c.i32Eqz();
      c.ifVoid();
      c.localGet(1);
      c.localGet(3);
      c.localGet(4);
      c.call(this.apply());
      c.return_();
      c.end();
      this.defaultCtx(c, 2);
      this.tcCh(c, 0, EV_START);
      c.localGet(2);
      this.newBody(c, OP_SYNC, {
        tc: (x) => x.localGet(0),
        fn: (x) => x.localGet(1),
        ctx: (x) => x.localGet(2),
        self: (x) => x.localGet(3),
        args: (x) => x.localGet(4),
      });
      c.call(this.runStores());
    });
  }

  /** %w.dc.tracePromise(tc, fn, ctx, thisArg, args) → the promise. The
   * no-subscriber early exit answers the traced promise itself; a
   * non-promise there is a named fence (S092 (b)). */
  tracePromise(): number {
    return this.def(
      "tracePromise",
      [I32, this.dynRef, this.dynRef, this.dynRef, this.vecRef],
      [this.deps.promRef()],
      (c, local) => {
        const R = local(this.dynRef);
        const promT = this.deps.promT();
        const nullP = (x: Code): void => x.refNull(promT);
        c.localGet(0);
        c.call(this.tcHas());
        c.i32Eqz();
        c.ifVoid();
        c.localGet(1);
        c.localGet(3);
        c.localGet(4);
        c.call(this.apply());
        c.localSet(R);
        this.returnIfPending(c, nullP);
        this.kindOf(c, R);
        c.i32Const(DK.PROMISE);
        c.i32Ne();
        c.ifVoid();
        this.deps.setCellError(
          c,
          "%Error",
          "Error",
          (x) => this.deps.lit(x, "tracePromise without subscribers over a function returning a non-promise is not supported yet"),
          null,
        );
        nullP(c);
        c.return_();
        c.end();
        c.localGet(R);
        c.structGet(this.dyn.dynT(), DYN_REF);
        c.refCast(promT);
        c.return_();
        c.end();
        this.defaultCtx(c, 2);
        this.tcCh(c, 0, EV_START);
        c.localGet(2);
        this.newBody(c, OP_PROMISE, {
          tc: (x) => x.localGet(0),
          fn: (x) => x.localGet(1),
          ctx: (x) => x.localGet(2),
          self: (x) => x.localGet(3),
          args: (x) => x.localGet(4),
        });
        c.call(this.runStores());
        c.localSet(R);
        this.returnIfPending(c, nullP);
        c.localGet(R);
        c.structGet(this.dyn.dynT(), DYN_REF);
        c.refCast(promT);
      },
    );
  }

  private wrapEnv(): number {
    return this.thunkEnv("wrapped", [I32, this.dynRef, this.dynRef]);
  }

  /** traceCallback's wrappedCallback (a native FUNC thunk). */
  private tcWrapped(): number {
    return this.defTyped("tcWrapped", this.dyn.thunkSig(), 2, (c, local) => {
      const env = this.wrapEnv();
      const TC = local(I32);
      const CTX = local(this.dynRef);
      const ERR = local(this.dynRef);
      const SELF = local(this.dynRef);
      c.call(this.dyn.thisGet());
      c.localSet(SELF);
      c.localGet(0);
      c.refCast(env);
      c.structGet(env, 0);
      c.localSet(TC);
      c.localGet(0);
      c.refCast(env);
      c.structGet(env, 1);
      c.localSet(CTX);
      this.argAt(c, 1, 0);
      c.localTee(ERR);
      c.call(this.dyn.truthy());
      c.ifVoid();
      c.localGet(CTX);
      this.deps.lit(c, "error");
      c.localGet(ERR);
      c.call(this.dyn.keySet());
      this.returnIfPending(c, (x) => this.nullDyn(x));
      this.tcCh(c, TC, EV_ERROR);
      c.localGet(CTX);
      c.call(this.publish());
      c.else_();
      c.localGet(CTX);
      this.deps.lit(c, "result");
      this.argAt(c, 1, 1);
      c.call(this.dyn.keySet());
      this.returnIfPending(c, (x) => this.nullDyn(x));
      c.end();
      this.tcCh(c, TC, EV_ASYNC_START);
      c.localGet(CTX);
      this.newBody(c, OP_WRAPPED, {
        tc: (x) => x.localGet(TC),
        fn: (x) => {
          x.localGet(0);
          x.refCast(env);
          x.structGet(env, 2);
        },
        ctx: (x) => x.localGet(CTX),
        self: (x) => x.localGet(SELF),
        args: (x) => x.localGet(1),
      });
      c.call(this.runStores());
      c.drop();
      this.returnIfPending(c, (x) => this.nullDyn(x));
      this.undef(c);
    });
  }

  /** %w.dc.traceCallback(tc, fn, position, ctx, thisArg, args) → dyn. */
  traceCallback(): number {
    return this.def(
      "traceCallback",
      [I32, this.dynRef, F64, this.dynRef, this.dynRef, this.vecRef],
      [this.dynRef],
      (c, local) => {
        const TC = 0, FN = 1, POS = 2, CTX = 3, THIS = 4, ARGS = 5;
        const N = local(F64);
        const P = local(F64);
        const K = local(I32);
        const CB = local(this.dynRef);
        c.localGet(TC);
        c.call(this.tcHas());
        c.i32Eqz();
        c.ifVoid();
        c.localGet(FN);
        c.localGet(THIS);
        c.localGet(ARGS);
        c.call(this.apply());
        c.return_();
        c.end();
        this.defaultCtx(c, CTX);
        // ArrayPrototypeAt(args, position): ToIntegerOrInfinity, a
        // negative index counts from the end.
        this.dyn.arrLen(c, (x) => x.localGet(ARGS));
        c.f64ConvertI32S();
        c.localSet(N);
        c.localGet(POS);
        c.localGet(POS);
        c.f64Eq();
        c.ifResult(F64);
        c.localGet(POS);
        c.f64Trunc();
        c.else_();
        c.f64Const(0);
        c.end();
        c.localTee(P);
        c.f64Const(0);
        c.f64Lt();
        c.ifVoid();
        c.localGet(P);
        c.localGet(N);
        c.f64Add();
        c.localSet(P);
        c.end();
        c.localGet(P);
        c.f64Const(0);
        c.f64Ge();
        c.localGet(P);
        c.localGet(N);
        c.f64Lt();
        c.i32And();
        c.ifResult(this.dynRef);
        c.localGet(P);
        c.i32TruncF64S();
        c.localSet(K);
        this.dyn.arrAt(c, (x) => x.localGet(ARGS), (x) => x.localGet(K));
        c.else_();
        c.i32Const(-1);
        c.localSet(K);
        this.undef(c);
        c.end();
        c.localTee(CB);
        c.structGet(this.dyn.dynT(), DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Ne();
        c.ifVoid();
        this.throwNotFunctionArg(c, "callback", CB);
        this.nullDyn(c);
        c.return_();
        c.end();
        // ArrayPrototypeSplice(args, position, 1, wrappedCallback)
        this.dyn.arrSet(
          c,
          (x) => x.localGet(ARGS),
          (x) => x.localGet(K),
          (x) =>
            this.dyn.boxFn(
              x,
              (y) => {
                y.localGet(TC);
                y.localGet(CTX);
                y.localGet(CB);
                y.structNew(this.wrapEnv());
              },
              (y) => y.refFunc(this.tcWrapped()),
              -1,
              (y) => this.deps.lit(y, "wrappedCallback"),
              2,
            ),
        );
        this.tcCh(c, TC, EV_START);
        c.localGet(CTX);
        this.newBody(c, OP_CALLBACK, {
          tc: (x) => x.localGet(TC),
          fn: (x) => x.localGet(FN),
          ctx: (x) => x.localGet(CTX),
          self: (x) => x.localGet(THIS),
          args: (x) => x.localGet(ARGS),
        });
        c.call(this.runStores());
      },
    );
  }

  /** %w.dc.runStoresApply(i, data, fn, thisArg, args) → dyn — the user's
   * `channel.runStores(data, fn, thisArg, ...args)`. */
  runStoresApply(): number {
    return this.def("runStoresApply", [I32, this.dynRef, this.dynRef, this.dynRef, this.vecRef], [this.dynRef], (c) => {
      c.localGet(0);
      c.localGet(1);
      this.newBody(c, OP_APPLY, {
        fn: (x) => x.localGet(2),
        self: (x) => x.localGet(3),
        args: (x) => x.localGet(4),
      });
      c.call(this.runStores());
    });
  }

  /* ── setImmediate as a value, new Promise(setImmediate) ───────────── */

  /** %w.dc.setImmediateValue() → the interned FUNC (one function object,
   * `setImmediate === setImmediate`). Calling it validates the callback
   * (Node's validateFunction) and schedules callback(...rest) on the
   * immediate queue; it answers undefined (S092 (c)). */
  setImmediateValue(): number {
    return this.def("setImmediateValue", [], [this.dynRef], (c) => {
      const g = this.nullGlobal("setImmFn", { kind: "ref", nullable: true, typeIndex: this.dyn.dynT() });
      const env = this.thunkEnv("marker", [I32]);
      c.globalGet(g);
      c.refIsNull();
      c.ifVoid();
      this.dyn.boxFn(
        c,
        (x) => {
          x.i32Const(0);
          x.structNew(env);
        },
        (x) => x.refFunc(this.setImmThunk()),
        -1,
        (x) => this.deps.lit(x, "setImmediate"),
        1,
      );
      c.globalSet(g);
      c.end();
      c.globalGet(g);
    });
  }

  private setImmThunk(): number {
    return this.defTyped("setImmThunk", this.dyn.thunkSig(), 2, (c, local) => {
      const CB = local(this.dynRef);
      const REST = local(this.vecRef);
      const I = local(I32);
      const pair = this.deps.voidClos();
      const env = this.voidEnv("imm", [this.dynRef, this.vecRef, ANY_REF]);
      const run = this.defTyped("immRun", pair.fn, 1, (x, l2) => {
        const SAVE = l2(ANY_REF);
        const E = l2({ kind: "ref", nullable: true, typeIndex: env });
        const CBL = l2(this.dynRef);
        const RL = l2(this.vecRef);
        x.localGet(0);
        x.refCast(env);
        x.localSet(E);
        if (this.deps.alsLive) {
          x.globalGet(this.alsCurGlobal());
          x.localSet(SAVE);
          x.localGet(E);
          x.structGet(env, 3);
          x.globalSet(this.alsCurGlobal());
        }
        x.localGet(E);
        x.structGet(env, 1);
        x.localSet(CBL);
        x.localGet(E);
        x.structGet(env, 2);
        x.localSet(RL);
        this.callPlain(x, CBL, RL, "callback");
        x.drop();
        if (this.deps.alsLive) {
          x.localGet(SAVE);
          x.globalSet(this.alsCurGlobal());
        }
      });
      this.argAt(c, 1, 0);
      c.localTee(CB);
      c.structGet(this.dyn.dynT(), DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      this.throwNotFunctionArg(c, "callback", CB);
      this.nullDyn(c);
      c.return_();
      c.end();
      this.newVec(c);
      c.localSet(REST);
      c.i32Const(1);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      this.dyn.arrLen(c, (x) => x.localGet(1));
      c.i32GeS();
      c.brIf(1);
      c.localGet(REST);
      this.dyn.arrAt(c, (x) => x.localGet(1), (x) => x.localGet(I));
      c.call(this.deps.vecPush());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.refFunc(run);
      c.localGet(CB);
      c.localGet(REST);
      if (this.deps.alsLive) c.globalGet(this.alsCurGlobal());
      else c.refNull(ANY_HEAP);
      c.structNew(env);
      c.call(this.deps.setImmediate());
      c.drop();
      this.undef(c);
    });
  }

  /** %w.dc.immediatePromise() → a pending promise an immediate fulfils —
   * `new Promise(setImmediate)`: setImmediate(resolve, reject) runs
   * resolve(reject), so the value is the executor's reject function (an
   * anonymous native function; it is a no-op by the time anyone holds
   * it, the promise being settled). */
  immediatePromise(): number {
    return this.def("immediatePromise", [], [this.deps.promRef()], (c, local) => {
      const P = local(this.deps.promRef());
      const pair = this.deps.voidClos();
      const env = this.voidEnv("immProm", [this.deps.promRef()]);
      const marker = this.thunkEnv("marker", [I32]);
      const noop = this.defTyped("immReject", this.dyn.thunkSig(), 2, (x) => this.undef(x));
      const run = this.defTyped("immResolve", pair.fn, 1, (x) => {
        x.localGet(0);
        x.refCast(env);
        x.structGet(env, 1);
        x.i32Const(this.deps.excRef);
        x.f64Const(0);
        this.dyn.boxFn(
          x,
          (y) => {
            y.i32Const(0);
            y.structNew(marker);
          },
          (y) => y.refFunc(noop),
          -1,
          (y) => y.refNull(this.deps.strType()),
          1,
        );
        x.i32Const(-1);
        x.i32Const(1);
        x.call(this.deps.settle());
      });
      c.call(this.deps.mint());
      c.localSet(P);
      c.refFunc(run);
      c.localGet(P);
      c.structNew(env);
      c.call(this.deps.setImmediate());
      c.drop();
      c.localGet(P);
    });
  }

  /* ── AsyncLocalStorage ────────────────────────────────────────────── */

  /** The current AsyncContextFrame (anyref: promises.ts's waiter slot
   * stores it untyped). Null = no frame. */
  alsCurGlobal(): number {
    return this.global("alsCur", ANY_REF, (w) => {
      w.u8(0xd0);
      w.sleb(ANY_HEAP);
    });
  }

  private alsCountG(): number {
    return this.i32Global("alsCount");
  }

  /** %w.als.new() → a fresh store id. */
  alsNew(): number {
    return this.def("alsNew", [], [F64], (c) => {
      c.globalGet(this.alsCountG());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.alsCountG());
      c.globalGet(this.alsCountG());
      c.f64ConvertI32S();
    });
  }

  /** The current frame, cast, or null — leaves (ref null frameT). */
  private curFrame(c: Code): void {
    c.globalGet(this.alsCurGlobal());
    c.refIsNull();
    c.ifResult(this.frameRef());
    c.refNull(this.frameT());
    c.else_();
    c.globalGet(this.alsCurGlobal());
    c.refCast(this.frameT());
    c.end();
  }

  /** %w.als.get(id) → dyn — getStore(): the frame's value, or undefined
   * (no defaultValue: the options form has no lowering). */
  alsGetI(): number {
    return this.def("alsGet", [I32], [this.dynRef], (c, local) => {
      const F = local(this.frameRef());
      const K = local(I32);
      this.curFrame(c);
      c.localTee(F);
      c.refIsNull();
      c.ifVoid();
      this.undef(c);
      c.return_();
      c.end();
      c.localGet(F);
      c.structGet(this.frameT(), FR_IDS);
      c.localGet(0);
      c.call(this.storeIndex());
      c.localTee(K);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.undef(c);
      c.return_();
      c.end();
      c.localGet(F);
      c.structGet(this.frameT(), FR_VALS);
      c.localGet(K);
      c.arrayGet(this.dynBufT());
      c.refAsNonNull();
    });
  }

  /** %w.als.enterWith(id, value) — `new AsyncContextFrame(store, data)`
   * (a copy of the current frame with the store set) becomes current. */
  alsEnterWithI(): number {
    return this.def("alsEnterWith", [I32, this.dynRef], [], (c, local) => {
      const frameT = this.frameT();
      const idsT = this.i32ArrT();
      const bufT = this.dynBufT();
      const F = local(this.frameRef());
      const IDS = local(this.i32ArrRef());
      const VALS = local(this.dynBufRef());
      const NIDS = local(this.i32ArrRef());
      const NVALS = local(this.dynBufRef());
      const K = local(I32);
      this.curFrame(c);
      c.localTee(F);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(idsT);
      c.localSet(IDS);
      c.i32Const(0);
      c.arrayNewDefault(bufT);
      c.localSet(VALS);
      c.else_();
      c.localGet(F);
      c.structGet(frameT, FR_IDS);
      c.localSet(IDS);
      c.localGet(F);
      c.structGet(frameT, FR_VALS);
      c.localSet(VALS);
      c.end();
      c.localGet(IDS);
      c.localGet(0);
      c.call(this.storeIndex());
      c.localTee(K);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      // Same key set: copy, then replace the value.
      c.localGet(IDS);
      c.arrayLen();
      c.arrayNewDefault(idsT);
      c.localTee(NIDS);
      c.i32Const(0);
      c.localGet(IDS);
      c.i32Const(0);
      c.localGet(IDS);
      c.arrayLen();
      c.arrayCopy(idsT, idsT);
      c.localGet(VALS);
      c.arrayLen();
      c.arrayNewDefault(bufT);
      c.localTee(NVALS);
      c.i32Const(0);
      c.localGet(VALS);
      c.i32Const(0);
      c.localGet(VALS);
      c.arrayLen();
      c.arrayCopy(bufT, bufT);
      c.localGet(NVALS);
      c.localGet(K);
      c.localGet(1);
      c.arraySet(bufT);
      c.else_();
      this.appendCopy(c, idsT, IDS, NIDS, (x) => x.localGet(0));
      this.appendCopy(c, bufT, VALS, NVALS, (x) => x.localGet(1));
      c.end();
      c.localGet(NIDS);
      c.localGet(NVALS);
      c.structNew(frameT);
      c.globalSet(this.alsCurGlobal());
    });
  }

  /** %w.als.disable(id) — `frame?.delete(store)` on the CURRENT frame,
   * in place (continuations sharing the frame see it too, as in Node). */
  alsDisableI(): number {
    return this.def("alsDisable", [I32], [], (c, local) => {
      const frameT = this.frameT();
      const F = local(this.frameRef());
      const A = local(this.i32ArrRef());
      const B = local(this.dynBufRef());
      const NA = local(this.i32ArrRef());
      const NB = local(this.dynBufRef());
      const K = local(I32);
      this.curFrame(c);
      c.localTee(F);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(F);
      c.structGet(frameT, FR_IDS);
      c.localTee(A);
      c.localGet(0);
      c.call(this.storeIndex());
      c.localTee(K);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(F);
      c.structGet(frameT, FR_VALS);
      c.localSet(B);
      this.removeCopy(c, this.i32ArrT(), A, K, NA);
      this.removeCopy(c, this.dynBufT(), B, K, NB);
      c.localGet(F);
      c.localGet(NA);
      c.structSet(frameT, FR_IDS);
      c.localGet(F);
      c.localGet(NB);
      c.structSet(frameT, FR_VALS);
    });
  }

  /** %w.als.run(id, value, fn, args) → dyn — AsyncLocalStorage.run:
   * ObjectIs(prior, data) calls straight through; otherwise enterWith,
   * ReflectApply(fn, null, args), finally enterWith(prior). */
  alsRunI(): number {
    return this.def("alsRun", [I32, this.dynRef, this.dynRef, this.vecRef], [this.dynRef], (c, local) => {
      const PRIOR = local(this.dynRef);
      const R = local(this.dynRef);
      const callFn = (x: Code): void => {
        x.localGet(2);
        x.globalGet(this.dyn.nullGlobal());
        x.localGet(3);
        x.call(this.apply());
      };
      c.localGet(0);
      c.call(this.alsGetI());
      c.localTee(PRIOR);
      c.localGet(1);
      c.call(this.dyn.sameValueDyn());
      c.ifVoid();
      callFn(c);
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(1);
      c.call(this.alsEnterWithI());
      callFn(c);
      c.localSet(R);
      c.localGet(0);
      c.localGet(PRIOR);
      c.call(this.alsEnterWithI());
      c.localGet(R);
    });
  }

  /** %w.als.wrapVoid(clos) → clos — a void callback that runs with the
   * frame current NOW (the timer/immediate/nextTick capture). */
  wrapVoid(): number {
    return this.def(
      "wrapVoid",
      [{ kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
      [{ kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
      (c) => {
        const pair = this.deps.voidClos();
        const closRef: ValType = { kind: "ref", nullable: true, typeIndex: pair.clos };
        const env = this.voidEnv("als", [closRef, ANY_REF]);
        const run = this.defTyped("alsRunVoid", pair.fn, 1, (x, l2) => {
          const SAVE = l2(ANY_REF);
          const INNER = l2(closRef);
          x.globalGet(this.alsCurGlobal());
          x.localSet(SAVE);
          x.localGet(0);
          x.refCast(env);
          x.structGet(env, 2);
          x.globalSet(this.alsCurGlobal());
          x.localGet(0);
          x.refCast(env);
          x.structGet(env, 1);
          x.localTee(INNER);
          x.localGet(INNER);
          x.structGet(pair.clos, 0);
          x.callRef(pair.fn);
          x.localGet(SAVE);
          x.globalSet(this.alsCurGlobal());
        });
        c.refFunc(run);
        c.localGet(0);
        c.globalGet(this.alsCurGlobal());
        c.structNew(env);
      },
    );
  }

  /** Vector payload of a dyn ARR box on the stack (the IR's rest
   * argument lists are dynArrLit values). */
  vecOf(c: Code): void {
    c.structGet(this.dyn.dynT(), DYN_REF);
    c.refCast(this.deps.vec().struct);
  }
}
