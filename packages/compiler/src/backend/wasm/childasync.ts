/* INC-28 U2 — child_process's asynchronous surface (spawn, the ChildProcess
 * value, its 'exit' and 'error' events, kill, unref) on the WasmGC tier,
 * in childproc.ts's shape: one builder with its own `cached()` memo and its
 * own `%w.cpa.*` name prefix.
 *
 * THE HOST STARTS THE CHILD AND ANSWERS AT ONCE (abi.ts, cpCall op 5); the
 * child's later events — its exit, and the bytes of any stream the host
 * captures for it — wait in the host's queue until the module's event loop
 * polls (abi.ts, evPoll; timers.ts, `%w.loop`). The module keeps every
 * child it started in its own table, by handle, until the child's exit has
 * been delivered.
 *
 * THE MODULE BUILDS EVERY MESSAGE, from Node's own source
 * (lib/internal/child_process.js, v24.18.1): argument validation is
 * childproc.ts's (normalizeSpawnArguments, Node's order and texts); a spawn
 * failure is split exactly as ChildProcess.prototype.spawn splits it —
 * EACCES, EAGAIN, EMFILE, ENFILE and ENOENT are reported on a nextTick as an
 * 'error' event ("spawn <file> <CODE>", and the child's exitCode becomes the
 * negative errno first: onErrorNT -> onexit), every other errno is thrown at
 * once ("spawn <CODE>"). An 'error' event with no listener is the program's
 * death (Node's unhandled 'error'). */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

export interface ChildAsyncDeps {
  strRef: () => ValType;
  /** `tsinter.cpCall`'s index. */
  cpCallFunc: () => number;
  /** `tsinter.evPoll`'s index. */
  evPollFunc: () => number;
  /** `tsinter.write`'s index. */
  writeFunc: () => number;
  /** `emitEnsureCapacity`: `need` pushes ONE i32 and is emitted twice. */
  ensureCapacity: (c: Code, need: () => void) => void;
  /** The output-stage bump-cursor global. */
  stageCursor: () => number;
  pushStrLit: (c: Code, value: string) => void;
  /** Print `message` as the uncaught report and trap. */
  namedTrap: (c: Code, message: string) => void;
  stringVecRef: () => ValType;
  stringVecLen: (c: Code) => void;
  stringVecGet: () => number;
  /** `() -> string vec`: the module's own environment map as pairs. */
  envPairs: () => number;
  /** childproc.ts: `(s, ptr, cut) -> next`, one request run. */
  stageRun: () => number;
  /** childproc.ts: the file / args / cwd+env validators (1 = passes; 0 =
   * the pending cell is set). */
  checkFile: () => number;
  checkArgs: () => number;
  checkCwdEnv: () => number;
  /** childproc.ts: `(i32) -> string`, an errno carried as -(256 + n). */
  codeName: () => number;
  /** childproc.ts: `(i32) -> string`, a Linux signal's name. */
  signalName: () => number;
  concat: () => number;
  /** Write an Error of `className` into the pending cell. */
  throwCoded: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  /** Push a fresh %Error (a value). */
  newErrorCoded: (c: Code, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  /** The `() => void` closure pair and the user nextTick enqueue `(clos) -> ()`. */
  voidClos: () => { clos: number; fn: number };
  nextTickEnqueue: () => number;
  /** The fixed closure pairs every listener is stored as: an exit listener
   * takes (hasCode i32, code f64, signum i32), an error listener the Error. */
  exitClos: () => { clos: number; fn: number };
  errorClos: () => { clos: number; fn: number };
  excKind: () => number;
  reportUncaught: () => number;
  /** `(string) -> string`, the tier's full String.prototype.toUpperCase. */
  toUpperCase: () => number;
  /** process.ts: `(string) -> f64`, Node's Linux signal number for an
   * exact name ("" is 15 there — never asked with "" here), -1 unknown. */
  killSignalByName: () => number;
  /** `(f64) -> string`, Node's Number -> String. */
  f64ToStr: () => number;
  /** One steady-state microtask checkpoint, emitted inline. */
  checkpoint: (c: Code) => void;
}

/** cpCall's async op numbers (abi.ts). */
const OP_SPAWN = 5;
const OP_KILL = 6;
const OP_UNREF = 7;
const OP_RELEASE = 8;
/** The request header and the reply, in bytes (abi.ts). */
const SPAWN_HEADER_BYTES = 32;
/** evPoll's header, in bytes, and the module's first buffer size. */
const EV_HEADER_BYTES = 24;
const EV_FIRST_CAPACITY = 1024;
const HOST_FAILURE = "cpCall: host failure";
/** The errnos Node reports later as an 'error' event (EACCES, EAGAIN,
 * EMFILE, ENFILE, ENOENT on Linux); every other one is thrown at once. */
const EMIT_LATER_ERRNOS: readonly number[] = [-13, -11, -24, -23, -2];

/* The child struct's fields. */
export const CH_HANDLE = 0; // i32, -1 = no host child
export const CH_PID = 1; // f64
export const CH_HAS_PID = 2; // i32
export const CH_STATE = 3; // i32: 0 running, 1 exited with a code, 2 ended by a signal, 3 failed spawn's error fired
export const CH_CODE = 4; // f64: the exit code, or the negative errno in state 3
export const CH_SIGNAL = 5; // i32: the Linux signal number in state 2
export const CH_KILLED = 6; // i32
export const CH_REFFED = 7; // i32
export const CH_CONSUMED = 8; // i32: the exit (or the failure) has been delivered
export const CH_FILE = 9; // string
export const CH_EXIT_LIST = 10;
export const CH_EXIT_N = 11;
export const CH_ERR_LIST = 12;
export const CH_ERR_N = 13;

export class ChildAsyncBuilder {
  private readonly fns = new Map<string, number>();
  private childTField: number | null = null;
  private exitArrField: number | null = null;
  private errArrField: number | null = null;
  private tableTField: number | null = null;
  private globalsField: { refLive: number; table: number; cap: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: ChildAsyncDeps,
  ) {}

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.cpa.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  private get exitArrT(): number {
    this.exitArrField ??= this.mb.arrayType({ kind: "ref", nullable: true, typeIndex: this.deps.exitClos().clos }, true);
    return this.exitArrField;
  }

  private get errArrT(): number {
    this.errArrField ??= this.mb.arrayType({ kind: "ref", nullable: true, typeIndex: this.deps.errorClos().clos }, true);
    return this.errArrField;
  }

  /** type:child — the module's own ChildProcess. */
  childType(): number {
    if (this.childTField === null) {
      const exitArr: ValType = { kind: "ref", nullable: true, typeIndex: this.exitArrT };
      const errArr: ValType = { kind: "ref", nullable: true, typeIndex: this.errArrT };
      this.childTField = this.mb.structType([
        { storage: I32, mutable: true },
        { storage: F64, mutable: false },
        { storage: I32, mutable: false },
        { storage: I32, mutable: true },
        { storage: F64, mutable: true },
        { storage: I32, mutable: true },
        { storage: I32, mutable: true },
        { storage: I32, mutable: true },
        { storage: I32, mutable: true },
        { storage: this.deps.strRef(), mutable: false },
        { storage: exitArr, mutable: true },
        { storage: I32, mutable: true },
        { storage: errArr, mutable: true },
        { storage: I32, mutable: true },
      ]);
    }
    return this.childTField;
  }

  childRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.childType() };
  }

  private get tableT(): number {
    this.tableTField ??= this.mb.arrayType(this.childRef(), true);
    return this.tableTField;
  }

  private g(): { refLive: number; table: number; cap: number } {
    if (this.globalsField === null) {
      const tableT = this.tableT;
      this.globalsField = {
        refLive: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(0);
        }),
        table: this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: tableT }, true, (w) => {
          w.u8(0xd0);
          w.sleb(tableT);
        }),
        cap: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(EV_FIRST_CAPACITY);
        }),
      };
    }
    return this.globalsField;
  }

  /** The i32 global counting ref'd children whose exit is undelivered —
   * the event loop's third liveness term (timers.ts). */
  refLiveGlobal(): number {
    return this.g().refLive;
  }

  /* ── record primitives ─────────────────────────────────────────────── */

  /** u32 little-endian load at local `addr` + off (two 16-bit loads, no
   * alignment claimed). */
  private emitLoadU32(c: Code, addr: number, off: number): void {
    c.localGet(addr);
    c.i32Const(off);
    c.i32Add();
    c.i32Load16U();
    c.localGet(addr);
    c.i32Const(off + 2);
    c.i32Add();
    c.i32Load16U();
    c.i32Const(16);
    c.i32Shl();
    c.i32Or();
  }

  private emitStoreU32(c: Code, addr: number, off: number, push: () => void): void {
    c.localGet(addr);
    c.i32Const(off);
    c.i32Add();
    push();
    c.i32Store();
  }

  /** Push the byte size of one run for the string in local `s`:
   * 4 + roundUp4(2 * length) (childproc.ts's run). */
  private emitRunSize(c: Code, s: number): void {
    c.localGet(s);
    c.arrayLen();
    c.i32Const(2);
    c.i32Mul();
    c.i32Const(3);
    c.i32Add();
    c.i32Const(-4);
    c.i32And();
    c.i32Const(4);
    c.i32Add();
  }

  /** The stage base: the cursor rounded up to 4. */
  private emitBase(c: Code, local: number): void {
    c.globalGet(this.deps.stageCursor());
    c.i32Const(3);
    c.i32Add();
    c.i32Const(-4);
    c.i32And();
    c.localSet(local);
  }

  private trap(c: Code): void {
    this.deps.namedTrap(c, HOST_FAILURE);
  }

  /* ── the handle table ──────────────────────────────────────────────── */

  /** `%w.cpa.tableSet(h, child)` — grows by copy. */
  private tableSetHelper(): number {
    return this.cached("tableSet", [I32, this.childRef()], [], (idx) => {
      const g = this.g();
      const c = new Code();
      const H = 0;
      const CH = 1;
      const NT = 2;
      c.globalGet(g.table);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(8);
      c.arrayNewDefault(this.tableT);
      c.globalSet(g.table);
      c.end();
      c.block();
      c.loop();
      c.localGet(H);
      c.globalGet(g.table);
      c.arrayLen();
      c.i32LtU();
      c.brIf(1);
      c.globalGet(g.table);
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.arrayNewDefault(this.tableT);
      c.localSet(NT);
      c.localGet(NT);
      c.i32Const(0);
      c.globalGet(g.table);
      c.i32Const(0);
      c.globalGet(g.table);
      c.arrayLen();
      c.arrayCopy(this.tableT, this.tableT);
      c.localGet(NT);
      c.globalSet(g.table);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(g.table);
      c.localGet(H);
      c.localGet(CH);
      c.arraySet(this.tableT);
      this.mb.setBody(idx, [{ kind: "ref", nullable: true, typeIndex: this.tableT }], c.bytes());
    });
  }

  /** `%w.cpa.tableGet(h) -> child` — the named trap for a handle the
   * module does not hold. */
  private tableGetHelper(): number {
    return this.cached("tableGet", [I32], [this.childRef()], (idx) => {
      const g = this.g();
      const c = new Code();
      const H = 0;
      const CH = 1;
      c.globalGet(g.table);
      c.refIsNull();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(H);
      c.globalGet(g.table);
      c.arrayLen();
      c.i32GeU();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.globalGet(g.table);
      c.localGet(H);
      c.arrayGet(this.tableT);
      c.localTee(CH);
      c.refIsNull();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(CH);
      this.mb.setBody(idx, [this.childRef()], c.bytes());
    });
  }

  /* ── listeners ─────────────────────────────────────────────────────── */

  /** `%w.cpa.addExit(child, listener)` / `%w.cpa.addError(child, listener)`
   * — append in registration order (the list grows by copy). */
  private addHelper(name: string, arrT: number, closT: number, listField: number, nField: number): number {
    const closRef: ValType = { kind: "ref", nullable: true, typeIndex: closT };
    return this.cached(name, [this.childRef(), closRef], [], (idx) => {
      const c = new Code();
      const CH = 0;
      const L = 1;
      const NA = 2;
      const childT = this.childType();
      c.localGet(CH);
      c.structGet(childT, listField);
      c.refIsNull();
      c.ifVoid();
      c.localGet(CH);
      c.i32Const(2);
      c.arrayNewDefault(arrT);
      c.structSet(childT, listField);
      c.end();
      c.localGet(CH);
      c.structGet(childT, nField);
      c.localGet(CH);
      c.structGet(childT, listField);
      c.arrayLen();
      c.i32GeU();
      c.ifVoid();
      c.localGet(CH);
      c.structGet(childT, listField);
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.arrayNewDefault(arrT);
      c.localSet(NA);
      c.localGet(NA);
      c.i32Const(0);
      c.localGet(CH);
      c.structGet(childT, listField);
      c.i32Const(0);
      c.localGet(CH);
      c.structGet(childT, nField);
      c.arrayCopy(arrT, arrT);
      c.localGet(CH);
      c.localGet(NA);
      c.structSet(childT, listField);
      c.end();
      c.localGet(CH);
      c.structGet(childT, listField);
      c.localGet(CH);
      c.structGet(childT, nField);
      c.localGet(L);
      c.arraySet(arrT);
      c.localGet(CH);
      c.localGet(CH);
      c.structGet(childT, nField);
      c.i32Const(1);
      c.i32Add();
      c.structSet(childT, nField);
      this.mb.setBody(idx, [{ kind: "ref", nullable: true, typeIndex: arrT }], c.bytes());
    });
  }

  addExitHelper(): number {
    return this.addHelper("addExit", this.exitArrT, this.deps.exitClos().clos, CH_EXIT_LIST, CH_EXIT_N);
  }

  addErrorHelper(): number {
    return this.addHelper("addError", this.errArrT, this.deps.errorClos().clos, CH_ERR_LIST, CH_ERR_N);
  }

  /** `%w.cpa.emitError(child, head, CODE)` — emit 'error' with a fresh
   * Error (message head + CODE, code CODE) to every error listener in
   * registration order, stopping at the first that leaves an exception
   * pending; with no listener, the Error goes into the pending cell
   * (Node's unhandled 'error'). The caller's own check unwinds. */
  private errorEventHelper(): number {
    const s = this.deps.strRef();
    return this.cached("emitError", [this.childRef(), s, s], [], (idx) => {
      const c = new Code();
      const CH = 0;
      const HEAD = 1;
      const CODE = 2;
      const I = 3;
      const N = 4;
      const LIST = 5;
      const childT = this.childType();
      const pair = this.deps.errorClos();
      const message = (c2: Code): void => {
        c2.localGet(HEAD);
        c2.localGet(CODE);
        c2.call(this.deps.concat());
      };
      const code = (c2: Code): void => c2.localGet(CODE);
      c.localGet(CH);
      c.structGet(childT, CH_ERR_N);
      c.i32Eqz();
      c.ifVoid();
      this.deps.throwCoded(c, "%Error", "Error", message, code);
      c.return_();
      c.end();
      // The listeners as registered when the emission starts: the array and
      // its count are read ONCE (Node's emit copies its listener list, so a
      // listener added during the emission is not called for it; an add
      // never moves the entries below the old count).
      c.localGet(CH);
      c.structGet(childT, CH_ERR_N);
      c.localSet(N);
      c.localGet(CH);
      c.structGet(childT, CH_ERR_LIST);
      c.localSet(LIST);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      // The listener closure, its Error, then call_ref through its code.
      c.localGet(LIST);
      c.localGet(I);
      c.arrayGet(this.errArrT);
      this.deps.newErrorCoded(c, message, code);
      c.localGet(LIST);
      c.localGet(I);
      c.arrayGet(this.errArrT);
      c.structGet(pair.clos, 0);
      c.callRef(pair.fn);
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32, I32, { kind: "ref", nullable: true, typeIndex: this.errArrT }], c.bytes());
    });
  }

  /* ── the failed spawn's nextTick ───────────────────────────────────── */

  /** The environment of the failed spawn's tick: a subtype of the void
   * closure struct holding the child and its (negative) errno. */
  private failEnvT(): number {
    const pair = this.deps.voidClos();
    return this.mb.subStructType(
      "%w.cpa.failEnv",
      [
        { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
        { storage: this.childRef(), mutable: false },
        { storage: I32, mutable: false },
      ],
      pair.clos,
    );
  }

  /** `%w.cpa.failTick` — Node's onErrorNT -> onexit(err): exitCode is the
   * negative errno, then 'error' ("spawn <file> <CODE>"); never 'exit'. */
  private failTickHelper(): number {
    const pair = this.deps.voidClos();
    const hit = this.fns.get("failTick");
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(pair.fn, "%w.cpa.failTick");
    this.fns.set("failTick", idx);
    const env = this.failEnvT();
    const childT = this.childType();
    const c = new Code();
    const CH = 1;
    const ERRNO = 2;
    const CODE = 3;
    c.localGet(0);
    c.refCast(env);
    c.structGet(env, 1);
    c.localSet(CH);
    c.localGet(0);
    c.refCast(env);
    c.structGet(env, 2);
    c.localSet(ERRNO);
    c.localGet(CH);
    c.i32Const(3);
    c.structSet(childT, CH_STATE);
    c.localGet(CH);
    c.localGet(ERRNO);
    c.f64ConvertI32S();
    c.structSet(childT, CH_CODE);
    c.localGet(CH);
    c.i32Const(1);
    c.structSet(childT, CH_CONSUMED);
    c.localGet(ERRNO);
    c.i32Const(256);
    c.i32Sub();
    c.call(this.deps.codeName());
    c.localSet(CODE);
    c.localGet(CH);
    this.deps.pushStrLit(c, "spawn ");
    c.localGet(CH);
    c.structGet(childT, CH_FILE);
    c.call(this.deps.concat());
    this.deps.pushStrLit(c, " ");
    c.call(this.deps.concat());
    c.localGet(CODE);
    c.call(this.errorEventHelper());
    this.mb.setBody(idx, [this.childRef(), I32, this.deps.strRef()], c.bytes());
    return idx;
  }

  /* ── spawn ─────────────────────────────────────────────────────────── */

  /** `%w.cpa.spawn(file, argv, inMode, outMode, errMode, outFd, errFd,
   * detached, hasEnv, pairs, cwd) -> child` — validation in Node's order,
   * then SPAWN (abi.ts). A validation failure or a thrown spawn failure
   * leaves the pending cell set and answers null (the caller's check
   * unwinds). */
  spawnHelper(): number {
    const vec = this.deps.stringVecRef();
    const s = this.deps.strRef();
    return this.cached("spawn", [s, vec, I32, I32, I32, I32, I32, I32, I32, vec, s], [this.childRef()], (idx) => {
      const c = new Code();
      const FILE = 0;
      const ARGV = 1;
      const IN_MODE = 2;
      const OUT_MODE = 3;
      const ERR_MODE = 4;
      const OUT_FD = 5;
      const ERR_FD = 6;
      const DETACHED = 7;
      const HAS_ENV = 8;
      const PAIRS = 9;
      const CWD = 10;
      const SIZE = 11;
      const I = 12;
      const N = 13;
      const BASE = 14;
      const P = 15;
      const ANS = 16;
      const ERRNO = 17;
      const DISP = 18;
      const PID = 19;
      const DERIVED = 20;
      const TMPS = 21; // string
      const SEND = 22; // vec: the pairs actually sent
      const CH = 23; // child
      const CODE = 24; // string
      const childT = this.childType();
      const vecGet = this.deps.stringVecGet();
      const stage = this.deps.stageRun();
      const fail = (): void => {
        c.i32Eqz();
        c.ifVoid();
        c.refNull(childT);
        c.return_();
        c.end();
      };
      c.localGet(FILE);
      c.call(this.deps.checkFile());
      fail();
      c.localGet(ARGV);
      c.i32Const(0);
      c.call(this.deps.checkArgs());
      fail();
      c.localGet(CWD);
      c.localGet(HAS_ENV);
      c.localGet(PAIRS);
      c.call(this.deps.checkCwdEnv());
      fail();
      // The environment sent: the replacement pairs, or the module's own
      // map (cut at U+0000 when staged, Node's process.env setter's cut).
      c.localGet(HAS_ENV);
      c.ifResult(vec);
      c.localGet(PAIRS);
      c.else_();
      c.call(this.deps.envPairs());
      c.end();
      c.localSet(SEND);
      // SIZE = header + file + argc + args + cwd + pair count + pairs +
      // 3 bytes of alignment slack.
      c.i32Const(SPAWN_HEADER_BYTES + 4 + 4 + 3);
      this.emitRunSize(c, FILE);
      c.i32Add();
      this.emitRunSize(c, CWD);
      c.i32Add();
      c.localSet(SIZE);
      for (const VEC of [ARGV, SEND]) {
        c.localGet(VEC);
        this.deps.stringVecLen(c);
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(VEC);
        c.localGet(I);
        c.f64ConvertI32S();
        c.call(vecGet);
        c.localSet(TMPS);
        c.localGet(SIZE);
        this.emitRunSize(c, TMPS);
        c.i32Add();
        c.localSet(SIZE);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
      }
      this.deps.ensureCapacity(c, () => c.localGet(SIZE));
      this.emitBase(c, BASE);
      // The header.
      this.emitStoreU32(c, BASE, 0, () => c.localGet(IN_MODE));
      this.emitStoreU32(c, BASE, 4, () => c.localGet(OUT_MODE));
      this.emitStoreU32(c, BASE, 8, () => c.localGet(ERR_MODE));
      this.emitStoreU32(c, BASE, 12, () => c.localGet(OUT_FD));
      this.emitStoreU32(c, BASE, 16, () => c.localGet(ERR_FD));
      this.emitStoreU32(c, BASE, 20, () => c.localGet(DETACHED));
      this.emitStoreU32(c, BASE, 24, () => c.i32Const(0));
      this.emitStoreU32(c, BASE, 28, () => c.i32Const(0));
      // The runs.
      c.localGet(FILE);
      c.localGet(BASE);
      c.i32Const(SPAWN_HEADER_BYTES);
      c.i32Add();
      c.i32Const(0);
      c.call(stage);
      c.localSet(P);
      const stageVec = (VEC: number, pairs: boolean): void => {
        c.localGet(VEC);
        this.deps.stringVecLen(c);
        c.localSet(N);
        this.emitStoreU32(c, P, 0, () => {
          c.localGet(N);
          if (pairs) {
            c.i32Const(1);
            c.i32ShrU();
          }
        });
        c.localGet(P);
        c.i32Const(4);
        c.i32Add();
        c.localSet(P);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(VEC);
        c.localGet(I);
        c.f64ConvertI32S();
        c.call(vecGet);
        c.localGet(P);
        // The module's own map is cut at U+0000; replacement pairs are not
        // (Node validates those, above).
        if (pairs) {
          c.localGet(HAS_ENV);
          c.i32Eqz();
        } else {
          c.i32Const(0);
        }
        c.call(stage);
        c.localSet(P);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
      };
      stageVec(ARGV, false);
      c.localGet(CWD);
      c.localGet(P);
      c.i32Const(0);
      c.call(stage);
      c.localSet(P);
      stageVec(SEND, true);
      // SPAWN.
      c.i32Const(OP_SPAWN);
      c.localGet(BASE);
      c.localGet(P);
      c.localGet(BASE);
      c.i32Sub();
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.deps.cpCallFunc());
      c.localTee(ANS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.trap(c);
      c.end();
      this.emitLoadU32(c, BASE, 0);
      c.localSet(ERRNO);
      this.emitLoadU32(c, BASE, 4);
      c.localSet(DISP);
      this.emitLoadU32(c, BASE, 8);
      c.localSet(PID);
      // The module's own derivation of the disposition from the errno.
      c.localGet(ERRNO);
      c.i32Eqz();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.i32Const(2);
      c.localSet(DERIVED);
      for (const e of EMIT_LATER_ERRNOS) {
        c.localGet(ERRNO);
        c.i32Const(e);
        c.i32Eq();
        c.ifVoid();
        c.i32Const(1);
        c.localSet(DERIVED);
        c.end();
      }
      c.localGet(DERIVED);
      c.end();
      c.localGet(DISP);
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      // The answer is a handle (>= 1) exactly when the child was spawned,
      // and 0 exactly when it was not.
      c.localGet(DISP);
      c.i32Eqz();
      c.localGet(ANS);
      c.i32Const(1);
      c.i32GeS();
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(DISP);
      c.i32Eqz();
      c.i32Eqz();
      c.localGet(ANS);
      c.i32Eqz();
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      // Disposition 2: thrown now, "spawn <CODE>" (no file).
      c.localGet(DISP);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ERRNO);
      c.i32Const(256);
      c.i32Sub();
      c.call(this.deps.codeName());
      c.localSet(CODE);
      this.deps.throwCoded(
        c,
        "%Error",
        "Error",
        (c2) => {
          this.deps.pushStrLit(c2, "spawn ");
          c2.localGet(CODE);
          c2.call(this.deps.concat());
        },
        (c2) => c2.localGet(CODE),
      );
      c.refNull(childT);
      c.return_();
      c.end();
      // The child value: handle, pid, hasPid, state, code, signal, killed,
      // reffed, consumed, file, two empty listener lists.
      c.localGet(DISP);
      c.ifResult(I32);
      c.i32Const(-1);
      c.else_();
      c.localGet(ANS);
      c.end();
      c.localGet(PID);
      c.f64ConvertI32S();
      c.localGet(DISP);
      c.i32Eqz();
      c.i32Const(0);
      c.f64Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(DISP);
      c.i32Eqz();
      c.i32Const(0);
      c.localGet(FILE);
      c.refNull(this.exitArrT);
      c.i32Const(0);
      c.refNull(this.errArrT);
      c.i32Const(0);
      c.structNew(childT);
      c.localSet(CH);
      c.localGet(DISP);
      c.ifVoid();
      // Disposition 1: reported on a nextTick (Node's onErrorNT).
      this.mb.declareFuncRef(this.failTickHelper());
      c.refFunc(this.failTickHelper());
      c.localGet(CH);
      c.localGet(ERRNO);
      c.structNew(this.failEnvT());
      c.call(this.deps.nextTickEnqueue());
      c.else_();
      c.localGet(ANS);
      c.localGet(CH);
      c.call(this.tableSetHelper());
      c.globalGet(this.g().refLive);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.g().refLive);
      c.end();
      c.localGet(CH);
      this.mb.setBody(
        idx,
        [I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, this.deps.strRef(), vec, this.childRef(), this.deps.strRef()],
        c.bytes(),
      );
    });
  }

  /* ── kill ──────────────────────────────────────────────────────────── */

  /** Throw Node's ERR_UNKNOWN_SIGNAL TypeError, "Unknown signal: " + the
   * string `pushArg` pushes. */
  private emitUnknownSignal(c: Code, pushArg: (c: Code) => void): void {
    this.deps.throwCoded(
      c,
      "%TypeError",
      "TypeError",
      (c2) => {
        this.deps.pushStrLit(c2, "Unknown signal: ");
        pushArg(c2);
        c2.call(this.deps.concat());
      },
      (c2) => this.deps.pushStrLit(c2, "ERR_UNKNOWN_SIGNAL"),
    );
  }

  /** `%w.cpa.killSend(child, signum) -> i32` — Node's kill after the
   * signal is validated: no host child (a failed spawn) or an exit already
   * delivered answers false without asking the host; otherwise KILL:
   * sent -> killed, true; ESRCH (already reaped) -> false; EINVAL or
   * ENOSYS -> throws "kill <CODE>"; any other errno -> 'error'
   * "kill <CODE>" emitted at once, false. */
  killSendHelper(): number {
    return this.cached("killSend", [this.childRef(), I32], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      const SIG = 1;
      const R = 2;
      const CODE = 3;
      const childT = this.childType();
      c.localGet(CH);
      c.structGet(childT, CH_HANDLE);
      c.i32Const(1);
      c.i32LtS();
      c.localGet(CH);
      c.structGet(childT, CH_CONSUMED);
      c.i32Or();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.i32Const(OP_KILL);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(CH);
      c.structGet(childT, CH_HANDLE);
      c.localGet(SIG);
      c.call(this.deps.cpCallFunc());
      c.localTee(R);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(CH);
      c.i32Const(1);
      c.structSet(childT, CH_KILLED);
      c.i32Const(1);
      c.return_();
      c.end();
      // A KILL answer is 0 or a negative errno in -4095..-1.
      c.localGet(R);
      c.i32Const(-4095);
      c.i32LtS();
      c.localGet(R);
      c.i32Const(0);
      c.i32GtS();
      c.i32Or();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(R);
      c.i32Const(-3);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(R);
      c.i32Const(256);
      c.i32Sub();
      c.call(this.deps.codeName());
      c.localSet(CODE);
      c.localGet(R);
      c.i32Const(-22);
      c.i32Eq();
      c.localGet(R);
      c.i32Const(-38);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      this.deps.throwCoded(
        c,
        "%Error",
        "Error",
        (c2) => {
          this.deps.pushStrLit(c2, "kill ");
          c2.localGet(CODE);
          c2.call(this.deps.concat());
        },
        (c2) => c2.localGet(CODE),
      );
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(CH);
      this.deps.pushStrLit(c, "kill ");
      c.localGet(CODE);
      c.call(this.errorEventHelper());
      c.i32Const(0);
      this.mb.setBody(idx, [I32, this.deps.strRef()], c.bytes());
    });
  }

  /** `%w.cpa.kill(child, name) -> i32` — child.kill with a signal NAME:
   * Node's convertToValidSignal upper-cases it (the tier's full
   * toUpperCase) and looks it up; an unknown name (the empty one too)
   * throws "Unknown signal: <name as given>" even for a child that is
   * gone. */
  killHelper(): number {
    return this.cached("kill", [this.childRef(), this.deps.strRef()], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      const NAME = 1;
      const SIG = 2;
      c.i32Const(-1);
      c.localSet(SIG);
      c.localGet(NAME);
      c.arrayLen();
      c.ifVoid();
      c.localGet(NAME);
      c.call(this.deps.toUpperCase());
      c.call(this.deps.killSignalByName());
      c.i32TruncF64S();
      c.localSet(SIG);
      c.end();
      c.localGet(SIG);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitUnknownSignal(c, (c2) => c2.localGet(NAME));
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(CH);
      c.localGet(SIG);
      c.call(this.killSendHelper());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.cpa.killNum(child, n) -> i32` — child.kill with a NUMBER: 0 is
   * sent as is (the existence probe); otherwise only an integer naming a
   * Linux signal Node knows (1..31) passes, and anything else throws
   * "Unknown signal: <n>" (Node's convertToValidSignal over its
   * number-to-name table). */
  killNumHelper(): number {
    return this.cached("killNum", [this.childRef(), F64], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      const N = 1;
      const OKAY = 2;
      c.localGet(N);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(N);
      c.f64Trunc();
      c.localGet(N);
      c.f64Eq();
      c.localGet(N);
      c.f64Const(1);
      c.f64Ge();
      c.i32And();
      c.localGet(N);
      c.f64Const(31);
      c.f64Le();
      c.i32And();
      c.i32Or();
      c.localSet(OKAY);
      c.localGet(OKAY);
      c.i32Eqz();
      c.ifVoid();
      this.emitUnknownSignal(c, (c2) => {
        c2.localGet(N);
        c2.call(this.deps.f64ToStr());
      });
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(CH);
      c.localGet(N);
      c.i32TruncF64S();
      c.call(this.killSendHelper());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /* ── unref ─────────────────────────────────────────────────────────── */

  /** `%w.cpa.unref(child)` — a live, ref'd child stops holding the loop
   * (and the host is told); anything else is a no-op, as in Node. */
  unrefHelper(): number {
    return this.cached("unref", [this.childRef()], [], (idx) => {
      const c = new Code();
      const CH = 0;
      const childT = this.childType();
      const g = this.g();
      c.localGet(CH);
      c.structGet(childT, CH_REFFED);
      c.localGet(CH);
      c.structGet(childT, CH_CONSUMED);
      c.i32Eqz();
      c.i32And();
      c.localGet(CH);
      c.structGet(childT, CH_HANDLE);
      c.i32Const(1);
      c.i32GeS();
      c.i32And();
      c.ifVoid();
      c.localGet(CH);
      c.i32Const(0);
      c.structSet(childT, CH_REFFED);
      c.globalGet(g.refLive);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(g.refLive);
      c.i32Const(OP_UNREF);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(CH);
      c.structGet(childT, CH_HANDLE);
      c.i32Const(0);
      c.call(this.deps.cpCallFunc());
      c.ifVoid();
      this.trap(c);
      c.end();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /* ── the poll phase ────────────────────────────────────────────────── */

  /** `%w.cpa.exit(child, a, b)` — a child's EXIT: its state, the host's
   * handle released, then every exit listener in registration order with
   * (code | null, signal | null), each followed by the death check, then
   * ONE checkpoint (Node emits 'exit' to all listeners inside one callback
   * scope, which drains ticks and microtasks when it closes). */
  private exitHelper(): number {
    return this.cached("exit", [this.childRef(), I32, I32], [], (idx) => {
      const c = new Code();
      const CH = 0;
      const A = 1;
      const B = 2;
      const I = 3;
      const N = 4;
      const LIST = 5;
      const childT = this.childType();
      const g = this.g();
      const pair = this.deps.exitClos();
      c.localGet(CH);
      c.structGet(childT, CH_CONSUMED);
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(CH);
      c.i32Const(1);
      c.structSet(childT, CH_CONSUMED);
      c.localGet(CH);
      c.structGet(childT, CH_REFFED);
      c.ifVoid();
      c.localGet(CH);
      c.i32Const(0);
      c.structSet(childT, CH_REFFED);
      c.globalGet(g.refLive);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(g.refLive);
      c.end();
      c.localGet(A);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(CH);
      c.i32Const(1);
      c.structSet(childT, CH_STATE);
      c.localGet(CH);
      c.localGet(A);
      c.f64ConvertI32S();
      c.structSet(childT, CH_CODE);
      c.else_();
      c.localGet(CH);
      c.i32Const(2);
      c.structSet(childT, CH_STATE);
      c.localGet(CH);
      c.localGet(B);
      c.structSet(childT, CH_SIGNAL);
      c.end();
      // RELEASE, and the table slot cleared.
      c.i32Const(OP_RELEASE);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(CH);
      c.structGet(childT, CH_HANDLE);
      c.i32Const(0);
      c.call(this.deps.cpCallFunc());
      c.ifVoid();
      this.trap(c);
      c.end();
      c.globalGet(g.table);
      c.localGet(CH);
      c.structGet(childT, CH_HANDLE);
      c.refNull(childT);
      c.arraySet(this.tableT);
      // The listeners as registered when the emission starts (the array and
      // its count read ONCE: Node's emit copies its listener list, so a
      // listener added during the emission is not called for it).
      c.localGet(CH);
      c.structGet(childT, CH_EXIT_N);
      c.localSet(N);
      c.localGet(CH);
      c.structGet(childT, CH_EXIT_LIST);
      c.localSet(LIST);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(LIST);
      c.localGet(I);
      c.arrayGet(this.exitArrT);
      c.localGet(CH);
      c.structGet(childT, CH_STATE);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(CH);
      c.structGet(childT, CH_CODE);
      c.localGet(CH);
      c.structGet(childT, CH_STATE);
      c.i32Const(2);
      c.i32Eq();
      c.ifResult(I32);
      c.localGet(CH);
      c.structGet(childT, CH_SIGNAL);
      c.else_();
      c.i32Const(0);
      c.end();
      c.localGet(LIST);
      c.localGet(I);
      c.arrayGet(this.exitArrT);
      c.structGet(pair.clos, 0);
      c.callRef(pair.fn);
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.call(this.deps.reportUncaught());
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.deps.checkpoint(c);
      this.mb.setBody(idx, [I32, I32, { kind: "ref", nullable: true, typeIndex: this.exitArrT }], c.bytes());
    });
  }

  /** `%w.cpa.poll()` — the POLL phase: every queued host event, oldest
   * first (abi.ts, evPoll). A short buffer grows to the length the host
   * needs and asks again; the event is never dropped. */
  pollHelper(): number {
    return this.cached("poll", [], [], (idx) => {
      const c = new Code();
      const BASE = 0;
      const LEN = 1;
      const KIND = 2;
      const PLEN = 3;
      const g = this.g();
      c.block();
      c.loop();
      this.deps.ensureCapacity(c, () => {
        c.globalGet(g.cap);
        c.i32Const(3);
        c.i32Add();
      });
      this.emitBase(c, BASE);
      c.localGet(BASE);
      c.globalGet(g.cap);
      c.call(this.deps.evPollFunc());
      c.localTee(LEN);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(LEN);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      // A short buffer: the event is held; grow and ask again. An answer
      // that does not grow the buffer is a host failure (no progress).
      c.i32Const(0);
      c.localGet(LEN);
      c.i32Sub();
      c.globalGet(g.cap);
      c.i32LeS();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.i32Const(0);
      c.localGet(LEN);
      c.i32Sub();
      c.globalSet(g.cap);
      c.br(1);
      c.end();
      // A record: its header, and a length that must be 24 + payloadLen.
      this.emitLoadU32(c, BASE, 0);
      c.i32Const(1);
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      this.emitLoadU32(c, BASE, 8);
      c.localSet(KIND);
      this.emitLoadU32(c, BASE, 12);
      c.localSet(PLEN);
      c.localGet(LEN);
      c.localGet(PLEN);
      c.i32Const(EV_HEADER_BYTES);
      c.i32Add();
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      // Kinds 2 and 3: bytes for the program's own stdout / stderr.
      c.localGet(KIND);
      c.i32Const(2);
      c.i32Eq();
      c.localGet(KIND);
      c.i32Const(3);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      // The handle must name a child this module holds.
      this.emitLoadU32(c, BASE, 4);
      c.call(this.tableGetHelper());
      c.drop();
      c.localGet(KIND);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(BASE);
      c.i32Const(EV_HEADER_BYTES);
      c.i32Add();
      c.localGet(PLEN);
      c.call(this.deps.writeFunc());
      c.br(1);
      c.end();
      // Kind 1: EXIT.
      c.localGet(KIND);
      c.i32Const(1);
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      this.emitLoadU32(c, BASE, 4);
      c.call(this.tableGetHelper());
      this.emitLoadU32(c, BASE, 16);
      this.emitLoadU32(c, BASE, 20);
      c.call(this.exitHelper());
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
    });
  }
}
