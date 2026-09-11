/* INC-26 pass P1 (design-host-v7.txt cccf7d6e §2.2-§2.5/§4, DECISIONS.md
 * D2/D3; CP1 cp1-plan-p1.txt 70a46350) — the process host contract's own
 * builder, in DateBuilder's shape (its own `cached()` memo, its own
 * `%w.proc.*` name prefix — the CACHED lesson: never a second builder under
 * an existing name).
 *
 * THE ARGV/ENV SNAPSHOT (D2, abi.ts §2.4). Both are read ONCE, at first
 * touch, through `hostStr`/`hostNum`, into module-owned storage: argv as
 * one string vec, env as TWO PARALLEL string vecs (keys, values) rather
 * than a hash map — Node's own process.env iterates in FIRST-READ-THEN-
 * APPEND order, which two parallel vecs give for free (the existing vec
 * machinery already has get/set/pushOne/splice; a hash map would have to
 * re-derive insertion order some other way for no benefit). `readHostStr`
 * is the ONE place the retry contract (abi.ts §2.2: len > cap means retry
 * with a bigger buffer) is implemented, reused by every hostStr read this
 * file makes.
 *
 * THE EXIT LISTENER LIST (D3, abi.ts's exit paragraph, design §4). One
 * self-referential struct, in the immediate queue's own shape
 * (timers.ts's `%w.immediate`: cb/tag-ish field, i32 flag, mutable
 * nullable-self next) with head/tail globals for FIFO append. THE ONE
 * DEPARTURE FROM `onExit`/`offExit`'s doc comment ("() => void or
 * (code: number) => void — the emitter picks the runtime adapter"): rather
 * than building an adapter CLOSURE that re-shapes a 0-arg callback into a
 * 1-arg one (which would store the ADAPTER's identity, not the ORIGINAL
 * closure's — breaking `offExit`'s removal-by-identity, Node's own
 * contract), the callback is stored as a GENERIC `(ref null eq)` value
 * alongside an i32 SHAPE TAG (0 or 1 params) recorded at the REGISTRATION
 * call site, where the concrete closure type is still statically known.
 * The drain (`exitDrain`) reads the tag and `ref.cast`s back to whichever
 * concrete closure type it registered, exactly reversing the implicit
 * upcast a struct field of a supertype always allows on the way in — no
 * cast is needed to STORE a closure as `eq`, only to READ one back as
 * itself. `offExit` compares by `ref.eq` against the SAME generic field,
 * which works on the original closure's identity directly since nothing
 * ever wrapped it. */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type FieldType, type ValType } from "./module.js";
import { LEN, type VecInfo } from "./arrays.js";
import {
  HOST_NUM_KIND_ARGC,
  HOST_NUM_KIND_ENV_PAIR_COUNT,
  HOST_STR_KIND_ARGV,
  HOST_STR_KIND_ENV_KEY,
  HOST_STR_KIND_ENV_VALUE,
} from "./abi.js";

/** The abstract `eq` heap type (WasmGC's common ancestor for every GC
 * struct/array) — the sleb-encoded negative heap-type code, the same
 * numbering convention `EQ_HEAP_STUB`/`EQ_REF_STUB` already use in the
 * bytes-validate/bytes-flag test fixtures (-0x13). Used ONLY as the exit
 * listener struct's `cb` field storage type, so a closure of EITHER arity
 * can occupy the SAME field via wasm's ordinary struct-field upcast (no
 * cast instruction needed to store a subtype into a supertype-typed
 * field) — `exitDrain` casts back down using the shape tag recorded
 * alongside it. */
const EQ_HEAP = -0x13;
const REF_EQ: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

export interface ProcessDeps {
  strRef: () => ValType;
  strType: () => number;
  /** `%w.strEq(ref,ref)->i32` — content equality, for the env key scan. */
  strEq: () => number;
  hostStrFunc: () => number;
  hostNumFunc: () => number;
  exitFunc: () => number;
  /** `%w.toInt32(f64)->i32` — NOT used for argc/pair-count (see readHostStr
   * and the snapshot loaders' own comments on why a trapping truncation is
   * the right defensive choice there instead). Kept for callers that need
   * ECMA ToInt32 specifically (the `process.exit` dispatch arm, emitter.ts). */
  toInt32: () => number;
  /** `emitEnsureCapacity`'s own signature: `need` pushes ONE i32 (bytes
   * needed beyond the cursor) and is emitted TWICE by the callee. */
  ensureCapacity: (c: Code, need: () => void) => void;
  /** The output-stage bump-cursor global (emitter.ts's `cursorGlobal`) —
   * hostStr writes AT this value without advancing it (abi.ts §2.2/M-17). */
  stageCursor: () => number;
  /** The `arrayOf(STRING)` VecInfo/ops, shared by argv and both env vecs —
   * structurally one vec type, reused three times. */
  stringVecInfo: () => VecInfo;
  stringVecRef: () => ValType;
  stringVecNewLen: () => number;
  stringVecGet: () => number;
  stringVecSet: () => number;
  stringVecPushOne: () => number;
  stringVecSplice: () => number;
  /** The (closure-struct, function-type) pair for a wasm-level closure
   * signature — emitter.ts's own `closPairFor`, threaded through so this
   * file never needs its own closure-type bookkeeping. */
  closPairFor: (params: ValType[], results: ValType[]) => { clos: number; fn: number };
  /** `dyn`'s own ref type — the rejection listeners' payload arguments
   * (reason, promise) are ALWAYS dyn-boxed (Node's ambient callback
   * shape), unlike onExit's closure itself which is statically typed. */
  dynRef: () => ValType;
  /** `%w.dyn.check:<(dyn,dyn)=>void>` — unwraps an ALREADY KIND-CHECKED
   * dyn function value into a callable closure of that exact shape
   * (emitter.ts's `dynCheckHelper`, memoized by type — safe to call from
   * anywhere, unlike `acquireScratch`, because it builds its OWN
   * independent function via its own locals, never touching `this.fn`).
   * Takes (dyn, path) per its own signature; `dynPathNull` is the null
   * path value dynCheckHelper's error arm would render (never taken here
   * — the dispatch arm already validated callability at REGISTRATION,
   * and the list only ever stores what passed that check).
   * WHY UNWRAP AT DISPATCH TIME AND NOT AT REGISTRATION: the list stores
   * the RAW dyn value (not the unwrapped closure) specifically so
   * `offUnhandledRejection`'s identity comparison is against the SAME
   * object `onUnhandledRejection` was given — unwrapping is not
   * guaranteed to be identity-stable across two separate calls, and
   * storing the unwrapped form would have made removal-by-identity
   * silently unreliable. */
  rejCheckHelper: () => number;
  dynPathT: () => number;
  /** `%w.dyn.strictEq(dyn,dyn)->i32` — Node's own `===`, which for two
   * FUNC-kind dyn values compares the underlying closure (`FN_CLOS`), NOT
   * the dyn wrapper struct (dyn.ts's own B.1a: "the box is a boundary
   * artifact, never the identity"). REQUIRED for `offUnhandledRejection`:
   * `dyn.boxFunc` allocates a FRESH `$dyn` wrapper on every box (measured
   * — no interning), so two separate references to the SAME closure
   * variable produce two DIFFERENT dyn wrapper objects; a raw `ref.eq` on
   * the wrappers would never match even the closure that was JUST
   * registered. This was caught by the forced-host row itself, not by
   * inspection — see findings. */
  dynStrictEq: () => number;
  /** RULING P1-R3: `%w.dyn.check:<(dyn)=>void>` — `rejCheckHelper`'s own
   * shape, ONE parameter instead of two: Node's real `rejectionHandled`
   * event calls its listener with ONLY the promise (measured directly,
   * five Node v24.18.1 probes; the ORIGINAL ruling text's "with the
   * reason" was loose shorthand — this file follows Node, not the
   * paraphrase, per CLAUDE.md's own "Node is the oracle"). */
  rejHandledCheckHelper: () => number;
  /** The pending-exception cell's four globals (emitter.ts's `exc()`) —
   * needed ONLY by `exitDrain`, to snapshot-clear-restore around EACH
   * listener call. Without this, a listener that itself throws (M-18(ii))
   * would overwrite the cell the CALLER (reportUncaughtHelper / emitReport)
   * is about to render its OWN report from — the drain runs BEFORE that
   * render, per design §4.4, so corrupting the cell here would print the
   * wrong exception. The listener's own throw is itself silent (Node's
   * own measured behaviour: no second report, the exit code unchanged),
   * which the drain gets for free by restoring the cell unconditionally. */
  excCell: () => { kindG: number; f64G: number; refG: number; preG: number; refType: ValType };
}

export class ProcessBuilder {
  private readonly fns = new Map<string, number>();
  private argvGlobal: number | null = null;
  private envKeysGlobal: number | null = null;
  private envValuesGlobal: number | null = null;
  private exitListHeadGlobal: number | null = null;
  private exitListTailGlobal: number | null = null;
  private exitDrainingGlobal: number | null = null;
  private exitListenerStructField: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: ProcessDeps,
  ) {}

  private strRef(): ValType {
    return this.deps.strRef();
  }
  private strType(): number {
    return this.deps.strType();
  }

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.proc.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── globals, allocated lazily on first use ───────────────────────────── */

  /** `addGlobal`'s init writer needs the VEC's own type index (not `eq`) so
   * the global's declared type and its zero-value init agree — a thin
   * wrapper so every nullable-vec global below shares one correct
   * ref.null encoding instead of repeating the heap-type arithmetic. */
  private initNullVecGlobal(): number {
    const vecRefT = this.deps.stringVecRef();
    if (vecRefT.kind !== "ref") throw new Error("emitter bug: stringVecRef() must be a ref type");
    return this.mb.addGlobal(vecRefT, true, (w) => {
      w.u8(0xd0);
      w.sleb(vecRefT.typeIndex);
    });
  }

  private argvGlobalIdx(): number {
    if (this.argvGlobal === null) this.argvGlobal = this.initNullVecGlobal();
    return this.argvGlobal;
  }
  private envKeysGlobalIdx(): number {
    if (this.envKeysGlobal === null) this.envKeysGlobal = this.initNullVecGlobal();
    return this.envKeysGlobal;
  }
  private envValuesGlobalIdx(): number {
    if (this.envValuesGlobal === null) this.envValuesGlobal = this.initNullVecGlobal();
    return this.envValuesGlobal;
  }

  private exitDrainingG(): number {
    if (this.exitDrainingGlobal === null) {
      this.exitDrainingGlobal = this.mb.addGlobal(I32, true, (w) => {
        w.u8(0x41);
        w.sleb(0);
      });
    }
    return this.exitDrainingGlobal;
  }

  /* ── the exit listener list's struct ──────────────────────────────────── */

  /** Has the exit listener struct EVER been built in this module — i.e.
   * has `process.exit`, `process.onExit` or `process.offExit` been
   * reached at all? Lets the emitter skip the quiescence drain call in
   * `_start`'s tail / `%w.tick`'s two sites entirely for a module that
   * touches only argv/env/cwd/platform — the machinery this file builds
   * for those never creates the listener struct on its own. */
  hasExitListenerSurface(): boolean {
    return this.exitListenerStructField !== null;
  }

  private exitListenerT(): number {
    if (this.exitListenerStructField === null) {
      this.exitListenerStructField = this.mb.selfStructType("%w.proc.exitListener", (self) => {
        const fields: FieldType[] = [
          { storage: REF_EQ, mutable: false }, // cb — either arity, upcast to eq on store
          { storage: I32, mutable: false }, // shape: 0 = zero-arg, 1 = one-arg(code)
          { storage: I32, mutable: false }, // once — stored per D3/design §4.1; never read (see file header)
          { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // next
        ];
        return fields;
      });
    }
    return this.exitListenerStructField;
  }
  private exitListenerRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.exitListenerT() };
  }
  private exitListHeadG(): number {
    if (this.exitListHeadGlobal === null) {
      const t = this.exitListenerRef();
      this.exitListHeadGlobal = this.mb.addGlobal(t, true, (w) => {
        w.u8(0xd0);
        w.sleb(this.exitListenerT());
      });
    }
    return this.exitListHeadGlobal;
  }
  private exitListTailG(): number {
    if (this.exitListTailGlobal === null) {
      const t = this.exitListenerRef();
      this.exitListTailGlobal = this.mb.addGlobal(t, true, (w) => {
        w.u8(0xd0);
        w.sleb(this.exitListenerT());
      });
    }
    return this.exitListTailGlobal;
  }

  /* ── the ONE retry-contract reader every hostStr call goes through ────── */

  /** `%w.proc.readHostStr(kind, index) -> string` — abi.ts §2.2's retry
   * contract, implemented once. Starts with a 64-code-unit stack buffer at
   * the output staging cursor (emitEnsureCapacity, never advanced —
   * M-17); on `len > cap` it grows to exactly `len` and asks again, in a
   * loop (not merely twice) so a host that under-answers more than once is
   * still served correctly. `len === -1` ("no such datum") is an emitter-
   * bug trap here: every caller in this file bounds its own index by a
   * count it just read from the SAME host, so a well-behaved host never
   * answers -1 to a call this function makes. */
  readHostStr(): number {
    return this.cached("readHostStr", [I32, I32], [this.strRef()], (idx) => {
      const c = new Code();
      const KIND = 0;
      const INDEX = 1;
      const CAP = 2;
      const LEN = 3;
      const RESULT = 4;
      const I = 5;
      c.i32Const(64);
      c.localSet(CAP);
      c.block();
      c.loop();
      this.deps.ensureCapacity(c, () => {
        c.localGet(CAP);
        c.i32Const(2);
        c.i32Mul();
      });
      c.localGet(KIND);
      c.localGet(INDEX);
      c.globalGet(this.deps.stageCursor());
      c.localGet(CAP);
      c.call(this.deps.hostStrFunc());
      c.localSet(LEN);
      c.localGet(LEN);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.unreachable(); // emitter bug: an index this file itself bounded went out of range
      c.end();
      c.localGet(LEN);
      c.localGet(CAP);
      c.i32LeS();
      c.brIf(1); // sized correctly on the first (or a later) try — done
      c.localGet(LEN);
      c.localSet(CAP);
      c.br(0); // retry with the exact size the host just reported
      c.end();
      c.end();
      // Build the result string and copy LEN code units in from the
      // staging cursor via i32.load16_u — this file's first INBOUND read
      // (code.ts's own note: every prior caller only ever wrote memory).
      c.localGet(LEN);
      c.arrayNewDefault(this.strType());
      c.localSet(RESULT);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(RESULT);
      c.localGet(I);
      c.globalGet(this.deps.stageCursor());
      c.localGet(I);
      c.i32Const(2);
      c.i32Mul();
      c.i32Add();
      c.i32Load16U();
      c.arraySet(this.strType());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(RESULT);
      // Extra locals, in index order (CAP=2, LEN=3, RESULT=4, I=5) — NOT
      // declaration order in the source above; setBody's array is keyed
      // by wasm local INDEX, and getting this wrong is a silent type
      // mismatch the validator catches only if two types happen to
      // collide in size, never a TypeScript-visible bug.
      this.mb.setBody(idx, [I32, I32, this.strRef(), I32], c.bytes());
    });
  }

  /* ── argv (D2, abi.ts §2.4) ────────────────────────────────────────────── */

  /** `%w.proc.ensureArgv()` — idempotent; a null check on the interned
   * global IS the "loaded" flag (no separate boolean needed). */
  ensureArgv(): number {
    return this.cached("ensureArgv", [], [], (idx) => {
      const c = new Code();
      const ARGC = 0;
      const I = 1;
      c.globalGet(this.argvGlobalIdx());
      c.refIsNull();
      c.ifVoid();
      c.f64Const(0);
      c.call(this.deps.stringVecNewLen());
      c.globalSet(this.argvGlobalIdx());
      // hostNum kind 0 (argc). A negative/NaN answer is a host-contract
      // violation this file traps on rather than silently miscounts —
      // i32TruncF64S already traps on NaN/out-of-range, which is exactly
      // the defensive behaviour a malformed count deserves here.
      c.i32Const(HOST_NUM_KIND_ARGC);
      c.i32Const(0);
      c.call(this.deps.hostNumFunc());
      c.i32TruncF64S();
      c.localSet(ARGC);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(ARGC);
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.argvGlobalIdx());
      c.i32Const(HOST_STR_KIND_ARGV);
      c.localGet(I);
      c.call(this.readHostStr());
      c.call(this.deps.stringVecPushOne());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  argvGlobalForRead(): number {
    return this.argvGlobalIdx();
  }

  /* ── env (D2, abi.ts §2.4) ─────────────────────────────────────────────── */

  ensureEnv(): number {
    return this.cached("ensureEnv", [], [], (idx) => {
      const c = new Code();
      const N = 0;
      const I = 1;
      c.globalGet(this.envKeysGlobalIdx());
      c.refIsNull();
      c.ifVoid();
      c.f64Const(0);
      c.call(this.deps.stringVecNewLen());
      c.globalSet(this.envKeysGlobalIdx());
      c.f64Const(0);
      c.call(this.deps.stringVecNewLen());
      c.globalSet(this.envValuesGlobalIdx());
      c.i32Const(HOST_NUM_KIND_ENV_PAIR_COUNT);
      c.i32Const(0);
      c.call(this.deps.hostNumFunc());
      c.i32TruncF64S();
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.envKeysGlobalIdx());
      c.i32Const(HOST_STR_KIND_ENV_KEY);
      c.localGet(I);
      c.call(this.readHostStr());
      c.call(this.deps.stringVecPushOne());
      c.globalGet(this.envValuesGlobalIdx());
      c.i32Const(HOST_STR_KIND_ENV_VALUE);
      c.localGet(I);
      c.call(this.readHostStr());
      c.call(this.deps.stringVecPushOne());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  /** `%w.proc.envGet(key) -> nullable string` — a linear scan; the union
   * wrap (found ? string arm : the interned undefined singleton) is the
   * DISPATCH ARM's job (emitter.ts), matching `error.code`'s own
   * precedent — the union's arm tags are per-call-site facts this file
   * has no business knowing. */
  envGetLookup(): number {
    return this.cached("envGet", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const KEY = 0;
      const N = 1;
      const I = 2;
      c.call(this.ensureEnv());
      c.globalGet(this.envKeysGlobalIdx());
      c.structGet(this.deps.stringVecInfo().struct, LEN);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.envKeysGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.localGet(KEY);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.globalGet(this.envValuesGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.refNull(this.strType());
      // KEY is param 0; extra locals are N=1, I=2 only.
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  envSet(): number {
    return this.cached("envSet", [this.strRef(), this.strRef()], [], (idx) => {
      const c = new Code();
      const KEY = 0;
      const VALUE = 1;
      const N = 2;
      const I = 3;
      c.call(this.ensureEnv());
      c.globalGet(this.envKeysGlobalIdx());
      c.structGet(this.deps.stringVecInfo().struct, LEN);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.envKeysGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.localGet(KEY);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.globalGet(this.envValuesGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.localGet(VALUE);
      c.call(this.deps.stringVecSet());
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(this.envKeysGlobalIdx());
      c.localGet(KEY);
      c.call(this.deps.stringVecPushOne());
      c.globalGet(this.envValuesGlobalIdx());
      c.localGet(VALUE);
      c.call(this.deps.stringVecPushOne());
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  envUnset(): number {
    return this.cached("envUnset", [this.strRef()], [], (idx) => {
      const c = new Code();
      const KEY = 0;
      const N = 1;
      const I = 2;
      c.call(this.ensureEnv());
      c.globalGet(this.envKeysGlobalIdx());
      c.structGet(this.deps.stringVecInfo().struct, LEN);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.envKeysGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.localGet(KEY);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.globalGet(this.envKeysGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.f64Const(1);
      c.call(this.deps.stringVecSplice());
      c.drop();
      c.globalGet(this.envValuesGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.f64Const(1);
      c.call(this.deps.stringVecSplice());
      c.drop();
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  envPairs(): number {
    return this.cached("envPairs", [], [this.deps.stringVecRef()], (idx) => {
      const c = new Code();
      const N = 0;
      const I = 1;
      const RESULT = 2;
      c.call(this.ensureEnv());
      c.globalGet(this.envKeysGlobalIdx());
      c.structGet(this.deps.stringVecInfo().struct, LEN);
      c.localSet(N);
      c.f64Const(0);
      c.call(this.deps.stringVecNewLen());
      c.localSet(RESULT);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(RESULT);
      c.globalGet(this.envKeysGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.call(this.deps.stringVecPushOne());
      c.localGet(RESULT);
      c.globalGet(this.envValuesGlobalIdx());
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.call(this.deps.stringVecPushOne());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(RESULT);
      this.mb.setBody(idx, [I32, I32, this.deps.stringVecRef()], c.bytes());
    });
  }

  /* ── the 'exit' listener list and its drain (D3, design §4) ───────────── */

  /** `%w.proc.onExit(cb: eq, shape: i32, once: i32)` — append at tail. */
  onExitAppend(): number {
    return this.cached("onExit", [REF_EQ, I32, I32], [], (idx) => {
      const c = new Code();
      const CB = 0;
      const SHAPE = 1;
      const ONCE = 2;
      const NODE = 3;
      c.localGet(CB);
      c.localGet(SHAPE);
      c.localGet(ONCE);
      c.refNull(this.exitListenerT());
      c.structNew(this.exitListenerT());
      c.localSet(NODE);
      c.globalGet(this.exitListTailG());
      c.refIsNull();
      c.ifVoid();
      c.localGet(NODE);
      c.globalSet(this.exitListHeadG());
      c.else_();
      c.globalGet(this.exitListTailG());
      c.localGet(NODE);
      c.structSet(this.exitListenerT(), 3);
      c.end();
      c.localGet(NODE);
      c.globalSet(this.exitListTailG());
      this.mb.setBody(idx, [this.exitListenerRef()], c.bytes());
    });
  }

  /** `%w.proc.offExit(cb: eq)` — remove the FIRST identity match (Node's
   * removeListener contract), walking with a trailing `prev` pointer so
   * unlinking a middle or head node is one structSet either way. */
  offExitRemove(): number {
    return this.cached("offExit", [REF_EQ], [], (idx) => {
      const c = new Code();
      const CB = 0;
      const PREV = 1;
      const CUR = 2;
      c.refNull(this.exitListenerT());
      c.localSet(PREV);
      c.globalGet(this.exitListHeadG());
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1); // exhausted: no match, no-op
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 0);
      c.localGet(CB);
      c.refEq();
      c.ifVoid();
      // Unlink CUR: PREV.next = CUR.next (or head = CUR.next if PREV is null).
      c.localGet(PREV);
      c.refIsNull();
      c.ifVoid();
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 3);
      c.globalSet(this.exitListHeadG());
      c.else_();
      c.localGet(PREV);
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 3);
      c.structSet(this.exitListenerT(), 3);
      c.end();
      // If CUR was the tail, the tail must follow.
      c.globalGet(this.exitListTailG());
      c.localGet(CUR);
      c.refEq();
      c.ifVoid();
      c.localGet(PREV);
      c.globalSet(this.exitListTailG());
      c.end();
      c.return_();
      c.end();
      c.localGet(CUR);
      c.localSet(PREV);
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 3);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [this.exitListenerRef(), this.exitListenerRef()], c.bytes());
    });
  }

  /** `%w.proc.exitDrain(code: i32)` — design §4.2, verbatim: re-entrancy
   * guard; SNAPSHOT by swapping the live head/tail to empty FIRST (so a
   * listener registered mid-drain lands on the fresh, now-live list and
   * does NOT run this round — the first unit row) and iterating the SAVED
   * old head (so a listener removed mid-drain, already visited or not,
   * cannot be un-removed by the walk — `offExit` mutates the OLD chain's
   * `next` pointers directly, which the walk already read past or is
   * about to read, either way producing "still runs" for the second unit
   * row); call each listener in the saved list, in order, with `code`. A
   * listener that calls `process.exit` re-enters this function — the
   * guard makes that "call the import with the new code" and nothing
   * else, which is exactly M-18(iii)/(iv)'s measured shape.
   *
   * RULING P1-R2 (findings-rev26-p1-throwing-listener.txt befdf83e/75,
   * five Node v24.18.1 probes): a throwing listener ALWAYS stops the
   * walk (unchanged), but what happens to the pending-exception cell
   * splits on whether a pending exception was ALREADY there at drain
   * ENTRY — WAS_FATAL below, read from SAVED_KIND on the iteration the
   * throw happened on (constant for the whole drain call: nothing before
   * a throw can change what SAVED_KIND was captured as, and the loop
   * stops the instant one occurs).
   *   WAS_FATAL (reportUncaughtHelper's own top-of-function call, and
   *   emitReport's exitDrainFatal hook, both already have a real
   *   exception/rejection rendering to do): restore the ORIGINAL over
   *   the listener's — the caller renders what was already pending, the
   *   listener's own error is silently dropped, exactly the prior
   *   behaviour (M-18(ii)).
   *   NOT WAS_FATAL (the three implicit-code sites: tick quiescence,
   *   `_start`'s tail, `process.exit`'s arm — SAVED_KIND is 0 at entry
   *   on every one of them by construction, nothing was pending): do
   *   NOT restore — restoring here would overwrite the listener's OWN
   *   exception with "nothing pending" and silently swallow it (the
   *   bug rev-26 named: "your check + restore unconditionally is
   *   exactly right on the fatal path and WRONG on the non-fatal
   *   paths"). Leave it live in the cell for the CALLER to notice and
   *   report — see emitter.ts's post-drain check at each of those three
   *   sites. */
  exitDrainHelper(): number {
    return this.cached("exitDrain", [I32], [], (idx) => {
      // Resolved once, here — the caller (emitter.ts) never needs to know
      // these pairs exist, matching every other DI entry in this file.
      const oneArgClosPair = this.deps.closPairFor([F64], []);
      const zeroArgClosPair = this.deps.closPairFor([], []);
      const cell = this.deps.excCell();
      const c = new Code();
      const CODE = 0;
      const OLD_HEAD = 1;
      const CUR = 2;
      const SAVED_KIND = 3;
      const SAVED_F64 = 4;
      const SAVED_REF = 5;
      const SAVED_PRE = 6;
      const THREW = 7;
      const WAS_FATAL = 8;
      c.globalGet(this.exitDrainingG());
      c.ifVoid();
      c.return_();
      c.end();
      c.i32Const(1);
      c.globalSet(this.exitDrainingG());
      c.globalGet(this.exitListHeadG());
      c.localSet(OLD_HEAD);
      c.refNull(this.exitListenerT());
      c.globalSet(this.exitListHeadG());
      c.refNull(this.exitListenerT());
      c.globalSet(this.exitListTailG());
      c.localGet(OLD_HEAD);
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      // Snapshot the pending-exception cell BEFORE the call: this drain
      // runs INSIDE reportUncaughtHelper/emitReport, before either has
      // rendered anything from that SAME cell (design §4.4) — a listener
      // that itself throws must not corrupt what the caller is about to
      // print. Cleared (not just saved) so the listener's own call site
      // starts from "nothing pending", matching every other call site's
      // invariant in this tier.
      c.globalGet(cell.kindG);
      c.localSet(SAVED_KIND);
      c.globalGet(cell.f64G);
      c.localSet(SAVED_F64);
      c.globalGet(cell.refG);
      c.localSet(SAVED_REF);
      c.globalGet(cell.preG);
      c.localSet(SAVED_PRE);
      c.i32Const(0);
      c.globalSet(cell.kindG);
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 1); // shape
      c.ifVoid();
      // shape 1: (f64) => void — call_ref needs [env, f64-arg, funcref],
      // funcref LAST (the wasm call_ref operand order: every declared
      // param in order, THEN the typed function reference on top).
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 0);
      c.refCast(oneArgClosPair.clos);
      c.localGet(CODE);
      c.f64ConvertI32S();
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 0);
      c.refCast(oneArgClosPair.clos);
      c.structGet(oneArgClosPair.clos, 0);
      c.callRef(oneArgClosPair.fn);
      c.else_();
      // shape 0: () => void
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 0);
      c.refCast(zeroArgClosPair.clos);
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 0);
      c.refCast(zeroArgClosPair.clos);
      c.structGet(zeroArgClosPair.clos, 0);
      c.callRef(zeroArgClosPair.fn);
      c.end();
      // P1-R2: a throwing listener always stops the walk — check BEFORE
      // touching the cell (the check reads what the listener just did).
      // Whether to restore the SAVED_* snapshot over it now depends on
      // WAS_FATAL (see the doc comment above): restoring unconditionally
      // was the bug — on the non-fatal paths SAVED_KIND is 0, so an
      // unconditional restore would overwrite the listener's own
      // exception with "nothing pending" and silently swallow it.
      c.globalGet(cell.kindG);
      c.i32Const(0);
      c.i32Ne();
      c.localSet(THREW);
      c.localGet(SAVED_KIND);
      c.i32Const(0);
      c.i32Ne();
      c.localSet(WAS_FATAL);
      c.localGet(THREW);
      c.ifVoid();
      c.localGet(WAS_FATAL);
      c.ifVoid();
      // Fatal: the caller already has a real exception/rejection to
      // render — restore it over the listener's, which is dropped.
      c.localGet(SAVED_KIND);
      c.globalSet(cell.kindG);
      c.localGet(SAVED_F64);
      c.globalSet(cell.f64G);
      c.localGet(SAVED_REF);
      c.globalSet(cell.refG);
      c.localGet(SAVED_PRE);
      c.globalSet(cell.preG);
      c.end();
      // Non-fatal: leave the listener's own exception exactly as it set
      // it — nothing to restore over it (SAVED_KIND was already 0).
      c.br(2); // stop iterating — exits the drain's outer block
      c.else_();
      // Did not throw: restore the snapshot (a no-op on the non-fatal
      // paths, since it was 0 either side) and continue to the next
      // listener.
      c.localGet(SAVED_KIND);
      c.globalSet(cell.kindG);
      c.localGet(SAVED_F64);
      c.globalSet(cell.f64G);
      c.localGet(SAVED_REF);
      c.globalSet(cell.refG);
      c.localGet(SAVED_PRE);
      c.globalSet(cell.preG);
      c.localGet(CUR);
      c.structGet(this.exitListenerT(), 3);
      c.localSet(CUR);
      c.br(1); // continue the loop
      c.end();
      c.end();
      c.end();
      this.mb.setBody(
        idx,
        [this.exitListenerRef(), this.exitListenerRef(), I32, F64, cell.refType, I32, I32, I32],
        c.bytes(),
      );
    });
  }

  /* ── the unhandledRejection listener list (D3-adjacent; §3.2 EXACT) ─────
   * A SEPARATE list from the exit listeners'. Stores the RAW dyn callback
   * value AS GIVEN — never an unwrapped closure — specifically so
   * `offUnhandledRejection`'s identity comparison is against the exact
   * object `onUnhandledRejection` was called with (unwrapping is not
   * guaranteed identity-stable across two separate calls on the same dyn
   * value; storing the unwrapped form would have made removal silently
   * unreliable). The MAY_THROW callability check happens at the DISPATCH
   * ARM (emitter.ts, which owns the dyn/error machinery); by the time
   * this file sees a value it is already known to be a dyn FUNC. The
   * unwrap-to-callable step happens at DISPATCH time instead (see
   * `dispatchUnhandledRejection`), via `deps.rejCheckHelper()`. */

  private rejListenerStructField: number | null = null;
  private rejListenerT(): number {
    this.rejListenerStructField ??= this.mb.selfStructType("%w.proc.rejListener", (self) => [
      { storage: this.deps.dynRef(), mutable: false }, // cb — the RAW dyn value
      { storage: I32, mutable: false }, // once — stored, unread (Node's 'unhandledRejection' fires once per rejection regardless of the once flag's TARGET semantics; no corpus program or unit row currently distinguishes once-vs-on for this event)
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // next
    ]);
    return this.rejListenerStructField;
  }
  private rejListenerRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.rejListenerT() };
  }

  private rejListHeadGlobal: number | null = null;
  private rejListTailGlobal: number | null = null;
  private rejListHeadG(): number {
    if (this.rejListHeadGlobal === null) {
      this.rejListHeadGlobal = this.mb.addGlobal(this.rejListenerRef(), true, (w) => {
        w.u8(0xd0);
        w.sleb(this.rejListenerT());
      });
    }
    return this.rejListHeadGlobal;
  }
  private rejListTailG(): number {
    if (this.rejListTailGlobal === null) {
      this.rejListTailGlobal = this.mb.addGlobal(this.rejListenerRef(), true, (w) => {
        w.u8(0xd0);
        w.sleb(this.rejListenerT());
      });
    }
    return this.rejListTailGlobal;
  }

  /** `%w.proc.onUnhandledRejection(cb, once)` — append at tail; the exact
   * append shape `onExitAppend` uses. `cb` is the RAW dyn value, already
   * kind-checked callable by the dispatch arm. */
  onUnhandledRejectionAppend(): number {
    return this.cached("onUnhandledRejection", [this.deps.dynRef(), I32], [], (idx) => {
      const c = new Code();
      const CB = 0;
      const ONCE = 1;
      const NODE = 2;
      c.localGet(CB);
      c.localGet(ONCE);
      c.refNull(this.rejListenerT());
      c.structNew(this.rejListenerT());
      c.localSet(NODE);
      c.globalGet(this.rejListTailG());
      c.refIsNull();
      c.ifVoid();
      c.localGet(NODE);
      c.globalSet(this.rejListHeadG());
      c.else_();
      c.globalGet(this.rejListTailG());
      c.localGet(NODE);
      c.structSet(this.rejListenerT(), 2);
      c.end();
      c.localGet(NODE);
      c.globalSet(this.rejListTailG());
      this.mb.setBody(idx, [this.rejListenerRef()], c.bytes());
    });
  }

  /** `%w.proc.offUnhandledRejection(cb)` — remove the FIRST identity
   * match, `offExitRemove`'s exact SHAPE over the rejection list, but the
   * comparison itself is `dyn.strictEq()` (Node's own `===`), NOT a raw
   * `ref.eq` on the stored dyn values — `dyn.boxFunc` allocates a fresh
   * `$dyn` wrapper on EVERY box (measured, no interning), so two
   * references to the SAME closure produce two DIFFERENT dyn wrappers;
   * `strictEq` compares the underlying `FN_CLOS` instead (dyn.ts's own
   * B.1a), which is the actually-stable identity. Caught by this pass's
   * own forced-host row, not by inspection — see findings. */
  offUnhandledRejectionRemove(): number {
    return this.cached("offUnhandledRejection", [this.deps.dynRef()], [], (idx) => {
      const strictEq = this.deps.dynStrictEq();
      const c = new Code();
      const CB = 0;
      const PREV = 1;
      const CUR = 2;
      c.refNull(this.rejListenerT());
      c.localSet(PREV);
      c.globalGet(this.rejListHeadG());
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 0);
      c.localGet(CB);
      c.call(strictEq);
      c.ifVoid();
      c.localGet(PREV);
      c.refIsNull();
      c.ifVoid();
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 2);
      c.globalSet(this.rejListHeadG());
      c.else_();
      c.localGet(PREV);
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 2);
      c.structSet(this.rejListenerT(), 2);
      c.end();
      c.globalGet(this.rejListTailG());
      c.localGet(CUR);
      c.refEq();
      c.ifVoid();
      c.localGet(PREV);
      c.globalSet(this.rejListTailG());
      c.end();
      c.return_();
      c.end();
      c.localGet(CUR);
      c.localSet(PREV);
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 2);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [this.rejListenerRef(), this.rejListenerRef()], c.bytes());
    });
  }

  /** Pushes an i32 boolean: is the list non-empty? Inlined at the call
   * site (report()'s own gate, promises.ts via emitter.ts's deps hook) —
   * cheap enough that a dedicated function would just add an indirection. */
  emitHasUnhandledRejectionListeners(c: Code): void {
    c.globalGet(this.rejListHeadG());
    c.refIsNull();
    c.i32Eqz();
  }

  /** `%w.proc.dispatchUnhandledRejection(reason: dyn, promise: dyn)` —
   * calls every registered listener, in registration order, with BOTH
   * arguments. Each stored dyn callback is unwrapped to a callable
   * `(dyn,dyn)=>void` closure HERE, at dispatch time (via
   * `deps.rejCheckHelper()`), never at registration — see the list's own
   * header comment for why. NOT re-entrancy-guarded like exitDrain: Node
   * dispatches this event once per never-observed rejection and nothing
   * in this tier's own call graph re-enters it recursively the way
   * process.exit re-enters exitDrain. Does NOT snapshot the
   * pending-exception cell (unlike exitDrain) — a listener throwing here
   * is NOT one of the measured M-18 edge cases (that family is specific
   * to the 'exit' event) and no corpus program or unit row exercises it;
   * if one is added later, apply exitDrain's save/clear/restore shape
   * here too. */
  dispatchUnhandledRejection(): number {
    return this.cached("dispatchUnhandledRejection", [this.deps.dynRef(), this.deps.dynRef()], [], (idx) => {
      const checkIdx = this.deps.rejCheckHelper();
      const c = new Code();
      const REASON = 0;
      const PROMISE = 1;
      const CUR = 2;
      const CLOS = 3;
      c.globalGet(this.rejListHeadG());
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      // Unwrap the stored dyn cb into the concrete (dyn,dyn)=>void closure.
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 0);
      c.refNull(this.deps.dynPathT());
      c.call(checkIdx);
      c.localSet(CLOS);
      // call_ref needs [env, reason, promise, funcref] — funcref LAST.
      c.localGet(CLOS);
      c.localGet(REASON);
      c.localGet(PROMISE);
      c.localGet(CLOS);
      c.structGet(this.rejClosT(), 0);
      c.callRef(this.rejClosFnT());
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 2);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [this.rejListenerRef(), this.rejClosRefForLocal()], c.bytes());
    });
  }

  /** The `(dyn,dyn)=>void` closure pair `rejCheckHelper()` unwraps into —
   * needed here only for the struct/function type indices `structGet`/
   * `callRef` require; the ACTUAL unwrap call is `deps.rejCheckHelper()`
   * itself, resolved by the emitter (which owns `dynCheckHelper`). */
  private rejClosPairCache: { clos: number; fn: number } | null = null;
  private rejClosPair(): { clos: number; fn: number } {
    this.rejClosPairCache ??= this.deps.closPairFor([this.deps.dynRef(), this.deps.dynRef()], []);
    return this.rejClosPairCache;
  }
  private rejClosT(): number {
    return this.rejClosPair().clos;
  }
  private rejClosFnT(): number {
    return this.rejClosPair().fn;
  }
  private rejClosRefForLocal(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.rejClosT() };
  }

  /* ── process.onRejectionHandled ────────────────────────────────────────
   * RULING P1-R3 (supersedes the P1 build's original "registration only"
   * stance, D10's S-1 hazard): a registration-only key here would have
   * been a SILENT divergence from Node the moment a program registered
   * this event and later attached a handler to a reported-unhandled
   * rejection — exactly the class rule 1 forbids. Reuses `rejListenerT()`'s
   * exact struct shape (a second list of the SAME node type, not a second
   * builder under an existing name — the type is genuinely shared, the
   * LIST is not) with its OWN head/tail globals. DISPATCH: fired from
   * promises.ts's `subscribe`/`subscribeHandled` (the two, and only two,
   * places a handler attaches — see promises.ts's `PROM_REPORTED_UNHANDLED`
   * doc comment) via `dispatchRejectionHandled` below, with the Node-
   * measured single-argument shape (the promise, boxed as a fresh generic
   * dyn object like `onUnhandledRejection`'s own "promise" argument
   * already is — no identity fidelity is preserved either place).
   * `offRejectionHandled` is still not built at all (absent from the
   * whole increment's key partition; confirmed via the survey, CP1 §2). */
  private rejHandledListHeadGlobal: number | null = null;
  private rejHandledListTailGlobal: number | null = null;
  private rejHandledListHeadG(): number {
    if (this.rejHandledListHeadGlobal === null) {
      this.rejHandledListHeadGlobal = this.mb.addGlobal(this.rejListenerRef(), true, (w) => {
        w.u8(0xd0);
        w.sleb(this.rejListenerT());
      });
    }
    return this.rejHandledListHeadGlobal;
  }
  private rejHandledListTailG(): number {
    if (this.rejHandledListTailGlobal === null) {
      this.rejHandledListTailGlobal = this.mb.addGlobal(this.rejListenerRef(), true, (w) => {
        w.u8(0xd0);
        w.sleb(this.rejListenerT());
      });
    }
    return this.rejHandledListTailGlobal;
  }

  onRejectionHandledAppend(): number {
    return this.cached("onRejectionHandled", [this.deps.dynRef(), I32], [], (idx) => {
      const c = new Code();
      const CB = 0;
      const ONCE = 1;
      const NODE = 2;
      c.localGet(CB);
      c.localGet(ONCE);
      c.refNull(this.rejListenerT());
      c.structNew(this.rejListenerT());
      c.localSet(NODE);
      c.globalGet(this.rejHandledListTailG());
      c.refIsNull();
      c.ifVoid();
      c.localGet(NODE);
      c.globalSet(this.rejHandledListHeadG());
      c.else_();
      c.globalGet(this.rejHandledListTailG());
      c.localGet(NODE);
      c.structSet(this.rejListenerT(), 2);
      c.end();
      c.localGet(NODE);
      c.globalSet(this.rejHandledListTailG());
      this.mb.setBody(idx, [this.rejListenerRef()], c.bytes());
    });
  }

  /** The `(dyn)=>void` closure pair `rejHandledCheckHelper()` unwraps
   * into — `rejClosPair()`'s own shape, one parameter narrower (P1-R3:
   * Node's real `rejectionHandled` listener takes only the promise). */
  private rejHandledClosPairCache: { clos: number; fn: number } | null = null;
  private rejHandledClosPair(): { clos: number; fn: number } {
    this.rejHandledClosPairCache ??= this.deps.closPairFor([this.deps.dynRef()], []);
    return this.rejHandledClosPairCache;
  }
  private rejHandledClosT(): number {
    return this.rejHandledClosPair().clos;
  }
  private rejHandledClosFnT(): number {
    return this.rejHandledClosPair().fn;
  }
  private rejHandledClosRefForLocal(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.rejHandledClosT() };
  }

  /** `%w.proc.dispatchRejectionHandled(promise: dyn)` — RULING P1-R3:
   * calls every registered `process.on("rejectionHandled", ...)` listener,
   * in registration order, with the ONE argument (`dispatchUnhandledRejection`'s
   * own shape, one argument narrower). Called from promises.ts's
   * `subscribe`/`subscribeHandled` exactly once per promise (the caller
   * already read-and-cleared `PROM_REPORTED_UNHANDLED` before boxing
   * `promise` and calling here — this function does not touch that field
   * itself, matching `dispatchUnhandledRejection`'s own division of
   * labor: the LIST lives here, the PROMISE STATE lives in promises.ts).
   * Not re-entrancy-guarded, same reasoning as `dispatchUnhandledRejection`
   * — Node fires this at most once per promise by construction (the fire-
   * once clear happens before this is ever called), and nothing in this
   * tier's call graph re-enters it. Does not snapshot the pending-
   * exception cell (unlike exitDrain) — a listener throwing here is not a
   * measured M-18-shaped edge case for this event and no corpus program
   * or unit row exercises it. */
  dispatchRejectionHandled(): number {
    return this.cached("dispatchRejectionHandled", [this.deps.dynRef()], [], (idx) => {
      const checkIdx = this.deps.rejHandledCheckHelper();
      const c = new Code();
      const PROMISE = 0;
      const CUR = 1;
      const CLOS = 2;
      c.globalGet(this.rejHandledListHeadG());
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      // Unwrap the stored dyn cb into the concrete (dyn)=>void closure.
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 0);
      c.refNull(this.deps.dynPathT());
      c.call(checkIdx);
      c.localSet(CLOS);
      // call_ref needs [env, promise, funcref] — funcref LAST.
      c.localGet(CLOS);
      c.localGet(PROMISE);
      c.localGet(CLOS);
      c.structGet(this.rejHandledClosT(), 0);
      c.callRef(this.rejHandledClosFnT());
      c.localGet(CUR);
      c.structGet(this.rejListenerT(), 2);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [this.rejListenerRef(), this.rejHandledClosRefForLocal()], c.bytes());
    });
  }
}
