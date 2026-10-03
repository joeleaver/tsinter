/* INC-28 U1 — child_process's synchronous surface (spawnSync, execSync,
 * execFileSync and promisified execFile) on the WasmGC tier, in fs.ts's
 * shape: one builder with its own `cached()` memo and its own `%w.cp.*`
 * name prefix, standalone wasm functions with numbered locals, errors
 * written into the pending-exception cell by the caller's own check.
 *
 * THE HOST RUNS THE CHILD ONCE (abi.ts, `cpCall`): a child cannot be
 * re-run, so there is no retry-on-short-buffer loop here. `%w.cp.run`
 * stages ONE request record, RUNs it, reads the fixed 32-byte result
 * record (META), copies each non-empty stream out (READ) and releases the
 * host's handle (FREE) — all inside one function, so no handle outlives
 * it. Any answer outside the import's contract is a named trap
 * ("cpCall: host failure"): every program-reachable Node throw is
 * validated by the family wrappers BEFORE `run` is called, so a host
 * failure is a host bug, never a program outcome.
 *
 * THE MODULE BUILDS EVERY MESSAGE. The host transcribes Node's own child
 * result field by field (status, signal number, an errno index); the
 * text a program can read is assembled here from those numbers and the
 * program's own strings.
 *
 * OUTPUT ORDER inside one call: stdout's bytes are written to fd 1 when
 * stdout was inherited; then stderr's bytes to fd 2 when stderr was
 * inherited or when the call echoes (execSync/execFileSync with no stdio
 * option) — always the RAW bytes, always before the caller can throw.
 * Captured streams are decoded with the tier's UTF-8 decoder (the WHATWG
 * maximal-subpart rule Buffer#toString shares). A stream that is not
 * captured reads "" (SEMANTICS.md S085). */
import { Code } from "./code.js";
import { F64, I32, I64, ModuleBuilder, type ValType } from "./module.js";

export interface ChildProcDeps {
  strRef: () => ValType;
  strType: () => number;
  /** `tsinter.cpCall`'s index, or a descriptive throw (the emitter's
   * `cpCallFuncOrThrow`). */
  cpCallFunc: () => number;
  /** `tsinter.write`'s index — every module imports it. */
  writeFunc: () => number;
  /** `emitEnsureCapacity`: `need` pushes ONE i32 and is emitted twice. */
  ensureCapacity: (c: Code, need: () => void) => void;
  /** The output-stage bump-cursor global. */
  stageCursor: () => number;
  /** Push a compile-time string literal. */
  pushStrLit: (c: Code, value: string) => void;
  /** Print `message` as the uncaught report and trap. */
  namedTrap: (c: Code, message: string) => void;
  stringVecRef: () => ValType;
  /** With a string vec on the stack, push its i32 length. */
  stringVecLen: (c: Code) => void;
  /** `(vec, f64 index) -> string`. */
  stringVecGet: () => number;
  bytesRef: () => ValType;
  /** `(string) -> bytes` — Buffer.from(s, "utf8"). */
  bytesFromStrUtf8: () => number;
  /** `(bytes) -> f64` length. */
  bytesLength: () => number;
  /** `(bytes, f64 index) -> f64` byte. */
  bytesGetElem: () => number;
  /** `(f64 len) -> bytes`, zero-filled. */
  bytesNewLen: () => number;
  /** `(bytes, f64 index, f64 value) -> void`. */
  bytesSetElem: () => number;
  /** `(bytes) -> string` — the utf8 decoder. */
  bytesToStrUtf8: () => number;
  /** Build a builtin error of `className` and write it into the pending
   * exception cell (the caller's own check unwinds). */
  throwCoded: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  /** Push a FRESH %Error object (name "Error") — a value, not a throw. */
  newErrorCoded: (c: Code, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  /** The %Error object's value type. */
  errRef: () => ValType;
  /** `(string, string) -> string`. */
  concat: () => number;
  /** `(f64) -> string`, Node's Number -> String. */
  f64ToStr: () => number;
  /** `(string) -> string`, util.inspect of a string under the default
   * options (inspect.ts's formatPrimitive string arm). */
  inspectStr: () => number;
  /** `(string) -> f64`: Node's Linux signal number for a name, 15 for
   * "", -1 when unknown (process.ts). */
  killSignalByName: () => number;
  /** `() -> string vec`: a fresh [k0, v0, ...] copy of the module's own
   * environment map (process.ts envPairs). */
  envPairs: () => number;
}

/** The module's own errno table for `cpCall`'s errCode field: index i is
 * code i + 1 (0 = no error). Every code a program can reach through
 * Node's spawnSync is in it (measured: ENOENT, EACCES, ENOTDIR, ELOOP,
 * ENAMETOOLONG, E2BIG, ETIMEDOUT, EPIPE, ENOBUFS); an errno outside it
 * travels as -(256 + errno). The host's table is written independently
 * (tests/harness/wasm-differential.test.ts) and a row checks the two
 * agree. Append-only. */
export const CP_CODES: readonly string[] = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "ENOEXEC",
  "ELOOP",
  "ENAMETOOLONG",
  "E2BIG",
  "ENOMEM",
  "EAGAIN",
  "EIO",
  "EINVAL",
  "ETIMEDOUT",
  "EPIPE",
  "ENOBUFS",
];

/** Node's name for each Linux signal number, index = number: the FIRST
 * key carrying that number in os.constants.signals' own order (so 6 is
 * SIGABRT, never SIGIOT, and 29 is SIGIO, never SIGPOLL), 1..31 with no
 * gaps, measured on Node v24.18.1. Index 0 is unused (no signal). */
export const CP_SIGNAL_NAMES: readonly string[] = [
  "",
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGSTKFLT",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPWR",
  "SIGSYS",
];

/** Node's own errno -> name map (util.getSystemErrorMap(): libuv's names,
 * keyed by the NEGATIVE errno), for an errno outside CP_CODES: Node's
 * spawnSync error code is that name, or "Unknown system error -<n>" when
 * libuv has none. */
// generated from Node v24.18.1 util.getSystemErrorMap(): 85 entries
export const CP_ERRNO_NAMES: readonly (readonly [number, string])[] = [
  [-1, "EPERM"],
  [-2, "ENOENT"],
  [-3, "ESRCH"],
  [-4, "EINTR"],
  [-5, "EIO"],
  [-6, "ENXIO"],
  [-7, "E2BIG"],
  [-8, "ENOEXEC"],
  [-9, "EBADF"],
  [-11, "EAGAIN"],
  [-12, "ENOMEM"],
  [-13, "EACCES"],
  [-14, "EFAULT"],
  [-16, "EBUSY"],
  [-17, "EEXIST"],
  [-18, "EXDEV"],
  [-19, "ENODEV"],
  [-20, "ENOTDIR"],
  [-21, "EISDIR"],
  [-22, "EINVAL"],
  [-23, "ENFILE"],
  [-24, "EMFILE"],
  [-25, "ENOTTY"],
  [-26, "ETXTBSY"],
  [-27, "EFBIG"],
  [-28, "ENOSPC"],
  [-29, "ESPIPE"],
  [-30, "EROFS"],
  [-31, "EMLINK"],
  [-32, "EPIPE"],
  [-34, "ERANGE"],
  [-36, "ENAMETOOLONG"],
  [-38, "ENOSYS"],
  [-39, "ENOTEMPTY"],
  [-40, "ELOOP"],
  [-49, "EUNATCH"],
  [-61, "ENODATA"],
  [-64, "ENONET"],
  [-71, "EPROTO"],
  [-75, "EOVERFLOW"],
  [-84, "EILSEQ"],
  [-88, "ENOTSOCK"],
  [-89, "EDESTADDRREQ"],
  [-90, "EMSGSIZE"],
  [-91, "EPROTOTYPE"],
  [-92, "ENOPROTOOPT"],
  [-93, "EPROTONOSUPPORT"],
  [-94, "ESOCKTNOSUPPORT"],
  [-95, "ENOTSUP"],
  [-97, "EAFNOSUPPORT"],
  [-98, "EADDRINUSE"],
  [-99, "EADDRNOTAVAIL"],
  [-100, "ENETDOWN"],
  [-101, "ENETUNREACH"],
  [-103, "ECONNABORTED"],
  [-104, "ECONNRESET"],
  [-105, "ENOBUFS"],
  [-106, "EISCONN"],
  [-107, "ENOTCONN"],
  [-108, "ESHUTDOWN"],
  [-110, "ETIMEDOUT"],
  [-111, "ECONNREFUSED"],
  [-112, "EHOSTDOWN"],
  [-113, "EHOSTUNREACH"],
  [-114, "EALREADY"],
  [-121, "EREMOTEIO"],
  [-125, "ECANCELED"],
  [-3000, "EAI_ADDRFAMILY"],
  [-3001, "EAI_AGAIN"],
  [-3002, "EAI_BADFLAGS"],
  [-3003, "EAI_CANCELED"],
  [-3004, "EAI_FAIL"],
  [-3005, "EAI_FAMILY"],
  [-3006, "EAI_MEMORY"],
  [-3007, "EAI_NODATA"],
  [-3008, "EAI_NONAME"],
  [-3009, "EAI_OVERFLOW"],
  [-3010, "EAI_SERVICE"],
  [-3011, "EAI_SOCKTYPE"],
  [-3013, "EAI_BADHINTS"],
  [-3014, "EAI_PROTOCOL"],
  [-4028, "EFTYPE"],
  [-4080, "ECHARSET"],
  [-4094, "UNKNOWN"],
  [-4095, "EOF"],
];

/** `cpCall`'s op numbers (abi.ts). */
const OP_RUN = 1;
const OP_META = 2;
const OP_READ = 3;
const OP_FREE = 4;
/** The request header's and the result record's byte size (abi.ts). */
const HEADER_BYTES = 32;
const RESULT_BYTES = 32;
const HOST_FAILURE = "cpCall: host failure";

/** The spawnRes struct's field indices. */
export const SR_HAS_STATUS = 0;
export const SR_STATUS = 1;
export const SR_SIGNAL = 2;
export const SR_ERR_CODE = 3;
export const SR_FILE = 4;
export const SR_STDOUT = 5;
export const SR_STDERR = 6;

export class ChildProcBuilder {
  private readonly fns = new Map<string, number>();
  private spawnResTypeCache: number | undefined;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: ChildProcDeps,
  ) {}

  private strRef(): ValType {
    return this.deps.strRef();
  }

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.cp.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /** type:spawnRes — an immutable struct: hasStatus (i32), status (f64),
   * signal (i32, the Linux number, 0 = none), errCode (i32, the record's
   * field), file (the program's file string, for messages), stdout and
   * stderr (decoded strings, "" when not captured). */
  spawnResType(): number {
    if (this.spawnResTypeCache !== undefined) return this.spawnResTypeCache;
    const s = this.strRef();
    const idx = this.mb.structType([
      { storage: I32, mutable: false },
      { storage: F64, mutable: false },
      { storage: I32, mutable: false },
      { storage: I32, mutable: false },
      { storage: s, mutable: false },
      { storage: s, mutable: false },
      { storage: s, mutable: false },
    ]);
    this.spawnResTypeCache = idx;
    return idx;
  }

  spawnResRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.spawnResType() };
  }

  /* ── record primitives ──────────────────────────────────────────────── */

  /** u32 little-endian load from the address in `addrLocal` + off, built
   * from two 16-bit loads (no alignment claimed). */
  private emitLoadU32(c: Code, addrLocal: number, off: number): void {
    c.localGet(addrLocal);
    c.i32Const(off);
    c.i32Add();
    c.i32Load16U();
    c.localGet(addrLocal);
    c.i32Const(off + 2);
    c.i32Add();
    c.i32Load16U();
    c.i32Const(16);
    c.i32Shl();
    c.i32Or();
  }

  /** Store the i32 `push()` leaves at `addrLocal` + off. */
  private emitStoreU32(c: Code, addrLocal: number, off: number, push: () => void): void {
    c.localGet(addrLocal);
    c.i32Const(off);
    c.i32Add();
    push();
    c.i32Store();
  }

  /** Store the f64 in `valLocal` at `addrLocal` + off as two u32 words
   * (low word first — little-endian). `bitsLocal` is an i64 scratch. */
  private emitStoreF64(c: Code, addrLocal: number, off: number, valLocal: number, bitsLocal: number): void {
    c.localGet(valLocal);
    c.i64ReinterpretF64();
    c.localSet(bitsLocal);
    this.emitStoreU32(c, addrLocal, off, () => {
      c.localGet(bitsLocal);
      c.i32WrapI64();
    });
    this.emitStoreU32(c, addrLocal, off + 4, () => {
      c.localGet(bitsLocal);
      c.i64Const(32n);
      c.i64ShrU();
      c.i32WrapI64();
    });
  }

  /** Push the byte size of one run for the string in `strLocal`:
   * 4 + roundUp4(2 * length). An upper bound when the run is cut. */
  private emitRunSize(c: Code, strLocal: number): void {
    c.localGet(strLocal);
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

  /** `%w.cp.stageRun(s, ptr, cut) -> next` — writes one run at ptr: a u32
   * code-unit count, the code units (two byte stores each), zero padding
   * to the next multiple of 4; answers the address after it. With cut =
   * 1 the run stops at the string's first U+0000 (Node's process.env
   * setter's cut, applied when the module sends its own environment). */
  stageRunHelper(): number {
    return this.cached("stageRun", [this.strRef(), I32, I32], [I32], (idx) => {
      const c = new Code();
      const S = 0;
      const PTR = 1;
      const CUT = 2;
      const LEN = 3;
      const I = 4;
      const END = 5;
      const NEXT = 6;
      c.localGet(S);
      c.arrayLen();
      c.localSet(LEN);
      // The cut: LEN = the index of the first U+0000, when asked.
      c.localGet(CUT);
      c.ifVoid();
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.localSet(LEN);
      c.br(2);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.end();
      // The count.
      c.localGet(PTR);
      c.localGet(LEN);
      c.i32Store();
      // The code units.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeU();
      c.brIf(1);
      c.localGet(PTR);
      c.i32Const(4);
      c.i32Add();
      c.localGet(I);
      c.i32Const(1);
      c.i32Shl();
      c.i32Add();
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.i32Store8();
      c.localGet(PTR);
      c.i32Const(5);
      c.i32Add();
      c.localGet(I);
      c.i32Const(1);
      c.i32Shl();
      c.i32Add();
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.i32Const(8);
      c.i32ShrU();
      c.i32Store8();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // Zero padding from END up to NEXT (at most 3 bytes).
      c.localGet(PTR);
      c.i32Const(4);
      c.i32Add();
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Shl();
      c.i32Add();
      c.localSet(END);
      c.localGet(PTR);
      c.i32Const(4);
      c.i32Add();
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Shl();
      c.i32Const(3);
      c.i32Add();
      c.i32Const(-4);
      c.i32And();
      c.i32Add();
      c.localSet(NEXT);
      c.block();
      c.loop();
      c.localGet(END);
      c.localGet(NEXT);
      c.i32GeU();
      c.brIf(1);
      c.localGet(END);
      c.i32Const(0);
      c.i32Store8();
      c.localGet(END);
      c.i32Const(1);
      c.i32Add();
      c.localSet(END);
      c.br(0);
      c.end();
      c.end();
      c.localGet(NEXT);
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
    });
  }

  /** `%w.cp.readStream(h, which, len, mode, echo) -> string` — copies one
   * stream out of the host's result (READ) when it is non-empty, writes
   * it raw to fd `which` when inherited (mode 2) and to fd 2 when `echo`,
   * and answers its decoded text when captured (mode 0), else "". */
  private readStreamHelper(): number {
    return this.cached("readStream", [I32, I32, I32, I32, I32], [this.strRef()], (idx) => {
      const c = new Code();
      const H = 0;
      const WHICH = 1;
      const LEN = 2;
      const MODE = 3;
      const ECHO = 4;
      const BASE = 5;
      const I = 6;
      const BYTES = 7;
      c.localGet(LEN);
      c.i32Eqz();
      c.ifVoid();
      this.deps.pushStrLit(c, "");
      c.return_();
      c.end();
      this.deps.ensureCapacity(c, () => {
        c.localGet(LEN);
        c.i32Const(3);
        c.i32Add();
      });
      c.globalGet(this.deps.stageCursor());
      c.i32Const(3);
      c.i32Add();
      c.i32Const(-4);
      c.i32And();
      c.localSet(BASE);
      c.i32Const(OP_READ);
      c.localGet(BASE);
      c.i32Const(0);
      c.localGet(H);
      c.localGet(WHICH);
      c.call(this.deps.cpCallFunc());
      c.localGet(LEN);
      c.i32Ne();
      c.ifVoid();
      this.deps.namedTrap(c, HOST_FAILURE);
      c.end();
      c.localGet(MODE);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.localGet(WHICH);
      c.localGet(BASE);
      c.localGet(LEN);
      c.call(this.deps.writeFunc());
      c.end();
      c.localGet(ECHO);
      c.ifVoid();
      c.i32Const(2);
      c.localGet(BASE);
      c.localGet(LEN);
      c.call(this.deps.writeFunc());
      c.end();
      c.localGet(MODE);
      c.ifVoid();
      this.deps.pushStrLit(c, "");
      c.return_();
      c.end();
      // Captured: bytes from memory, then the utf8 decoder.
      c.localGet(LEN);
      c.f64ConvertI32U();
      c.call(this.deps.bytesNewLen());
      c.localSet(BYTES);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeU();
      c.brIf(1);
      c.localGet(BYTES);
      c.localGet(I);
      c.f64ConvertI32U();
      c.localGet(BASE);
      c.localGet(I);
      c.i32Add();
      c.i32Load8U();
      c.f64ConvertI32U();
      c.call(this.deps.bytesSetElem());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(BYTES);
      c.call(this.deps.bytesToStrUtf8());
      this.mb.setBody(idx, [I32, I32, this.deps.bytesRef()], c.bytes());
    });
  }

  /** `%w.cp.run(file, argv, cwd, pairs, input, stdinMode, stdoutMode,
   * stderrMode, killSignal, timeoutMs, maxBufferMode, echo, cutEnv) ->
   * spawnRes` — one child, start to finish (abi.ts `cpCall`). `pairs` is
   * the WHOLE environment as [k0, v0, k1, v1, ...]; `cutEnv` = 1 cuts
   * each key and value at its first U+0000 (the module's own map). `input`
   * is read only when stdinMode is 1. Validation is the caller's. */
  runHelper(): number {
    const vec = this.deps.stringVecRef();
    return this.cached(
      "run",
      [this.strRef(), vec, this.strRef(), vec, this.strRef(), I32, I32, I32, I32, F64, I32, I32, I32],
      [this.spawnResRef()],
      (idx) => {
        const c = new Code();
        const FILE = 0;
        const ARGV = 1;
        const CWD = 2;
        const PAIRS = 3;
        const INPUT = 4;
        const IN_MODE = 5;
        const OUT_MODE = 6;
        const ERR_MODE = 7;
        const KILL = 8;
        const TIMEOUT = 9;
        const MAXBUF = 10;
        const ECHO = 11;
        const CUT = 12;
        const SIZE = 13;
        const I = 14;
        const N = 15;
        const BASE = 16;
        const P = 17;
        const INLEN = 18;
        const H = 19;
        const HAS = 20;
        const SIG = 21;
        const ERRC = 22;
        const OUTLEN = 23;
        const ERRLEN = 24;
        const TMPS = 25; // string scratch
        const INBYTES = 26; // bytes
        const STATUS = 27; // f64
        const BITS = 28; // i64
        const OUTSTR = 29; // string
        const ERRSTR = 30; // string
        const stage = this.stageRunHelper();
        const vecGet = this.deps.stringVecGet();

        // The input's UTF-8 bytes, when there is one.
        c.i32Const(0);
        c.localSet(INLEN);
        c.localGet(IN_MODE);
        c.i32Const(1);
        c.i32Eq();
        c.ifVoid();
        c.localGet(INPUT);
        c.call(this.deps.bytesFromStrUtf8());
        c.localSet(INBYTES);
        c.localGet(INBYTES);
        c.call(this.deps.bytesLength());
        c.i32TruncF64U();
        c.localSet(INLEN);
        c.end();

        // SIZE = header + file + argc + args + cwd + pairCount + pairs +
        // input count + input bytes + 3 bytes of alignment slack.
        c.i32Const(HEADER_BYTES + 4 + 4 + 4 + 3);
        this.emitRunSize(c, FILE);
        c.i32Add();
        this.emitRunSize(c, CWD);
        c.i32Add();
        c.localGet(INLEN);
        c.i32Add();
        c.localSet(SIZE);
        for (const VEC of [ARGV, PAIRS]) {
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
        this.deps.ensureCapacity(c, () => {
          c.localGet(SIZE);
        });
        // The base: the cursor rounded up to 4 (it is 0 at every libCall
        // dispatch; the rounding keeps the alignment independent of that).
        c.globalGet(this.deps.stageCursor());
        c.i32Const(3);
        c.i32Add();
        c.i32Const(-4);
        c.i32And();
        c.localSet(BASE);

        // The header.
        this.emitStoreU32(c, BASE, 0, () => c.localGet(IN_MODE));
        this.emitStoreU32(c, BASE, 4, () => c.localGet(OUT_MODE));
        this.emitStoreU32(c, BASE, 8, () => c.localGet(ERR_MODE));
        this.emitStoreU32(c, BASE, 12, () => c.localGet(KILL));
        this.emitStoreF64(c, BASE, 16, TIMEOUT, BITS);
        this.emitStoreU32(c, BASE, 24, () => c.localGet(MAXBUF));
        this.emitStoreU32(c, BASE, 28, () => c.i32Const(0));

        // The runs.
        c.localGet(FILE);
        c.localGet(BASE);
        c.i32Const(HEADER_BYTES);
        c.i32Add();
        c.i32Const(0);
        c.call(stage);
        c.localSet(P);
        const stageVec = (VEC: number, countDivisor: number, cut: () => void): void => {
          c.localGet(VEC);
          this.deps.stringVecLen(c);
          c.localSet(N);
          this.emitStoreU32(c, P, 0, () => {
            c.localGet(N);
            if (countDivisor === 2) {
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
          cut();
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
        stageVec(ARGV, 1, () => c.i32Const(0));
        c.localGet(CWD);
        c.localGet(P);
        c.i32Const(0);
        c.call(stage);
        c.localSet(P);
        stageVec(PAIRS, 2, () => c.localGet(CUT));
        // The input: its byte count, then the bytes.
        this.emitStoreU32(c, P, 0, () => c.localGet(INLEN));
        c.localGet(P);
        c.i32Const(4);
        c.i32Add();
        c.localSet(P);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(INLEN);
        c.i32GeU();
        c.brIf(1);
        c.localGet(P);
        c.localGet(I);
        c.i32Add();
        c.localGet(INBYTES);
        c.localGet(I);
        c.f64ConvertI32U();
        c.call(this.deps.bytesGetElem());
        c.i32TruncF64U();
        c.i32Store8();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(P);
        c.localGet(INLEN);
        c.i32Add();
        c.localSet(P);

        // RUN.
        c.i32Const(OP_RUN);
        c.localGet(BASE);
        c.localGet(P);
        c.localGet(BASE);
        c.i32Sub();
        c.i32Const(0);
        c.i32Const(0);
        c.call(this.deps.cpCallFunc());
        c.localTee(H);
        c.i32Const(0);
        c.i32LtS();
        c.ifVoid();
        this.deps.namedTrap(c, HOST_FAILURE);
        c.end();
        // META, into the same region.
        c.i32Const(OP_META);
        c.localGet(BASE);
        c.i32Const(0);
        c.localGet(H);
        c.i32Const(0);
        c.call(this.deps.cpCallFunc());
        c.i32Const(RESULT_BYTES);
        c.i32Ne();
        c.ifVoid();
        this.deps.namedTrap(c, HOST_FAILURE);
        c.end();
        this.emitLoadU32(c, BASE, 0);
        c.localSet(HAS);
        c.localGet(BASE);
        c.i32Const(4);
        c.i32Add();
        c.f64Load();
        c.localSet(STATUS);
        this.emitLoadU32(c, BASE, 12);
        c.localSet(SIG);
        this.emitLoadU32(c, BASE, 16);
        c.localSet(ERRC);
        this.emitLoadU32(c, BASE, 20);
        c.localSet(OUTLEN);
        this.emitLoadU32(c, BASE, 24);
        c.localSet(ERRLEN);
        // READ stdout, then stderr (inherit writes and the echo happen
        // inside, in that order).
        c.localGet(H);
        c.i32Const(1);
        c.localGet(OUTLEN);
        c.localGet(OUT_MODE);
        c.i32Const(0);
        c.call(this.readStreamHelper());
        c.localSet(OUTSTR);
        c.localGet(H);
        c.i32Const(2);
        c.localGet(ERRLEN);
        c.localGet(ERR_MODE);
        c.localGet(ECHO);
        c.call(this.readStreamHelper());
        c.localSet(ERRSTR);
        // FREE.
        c.i32Const(OP_FREE);
        c.i32Const(0);
        c.i32Const(0);
        c.localGet(H);
        c.i32Const(0);
        c.call(this.deps.cpCallFunc());
        c.ifVoid();
        this.deps.namedTrap(c, HOST_FAILURE);
        c.end();
        c.localGet(HAS);
        c.localGet(STATUS);
        c.localGet(SIG);
        c.localGet(ERRC);
        c.localGet(FILE);
        c.localGet(OUTSTR);
        c.localGet(ERRSTR);
        c.structNew(this.spawnResType());
        this.mb.setBody(
          idx,
          [
            I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32,
            this.strRef(),
            this.deps.bytesRef(),
            F64,
            I64,
            this.strRef(),
            this.strRef(),
          ],
          c.bytes(),
        );
      },
    );
  }

  /* ── strings for messages ───────────────────────────────────────────── */

  /** `%w.cp.slice(s, from, to) -> string` — a fresh copy of [from, to). */
  private sliceHelper(): number {
    return this.cached("slice", [this.strRef(), I32, I32], [this.strRef()], (idx) => {
      const c = new Code();
      const S = 0;
      const FROM = 1;
      const TO = 2;
      const OUT = 3;
      const t = this.deps.strType();
      c.localGet(TO);
      c.localGet(FROM);
      c.i32Sub();
      c.arrayNewDefault(t);
      c.localSet(OUT);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(S);
      c.localGet(FROM);
      c.localGet(TO);
      c.localGet(FROM);
      c.i32Sub();
      c.arrayCopy(t, t);
      c.localGet(OUT);
      this.mb.setBody(idx, [this.strRef()], c.bytes());
    });
  }

  /** `%w.cp.hasNul(s) -> i32`. */
  private hasNulHelper(): number {
    return this.cached("hasNul", [this.strRef()], [I32], (idx) => {
      const c = new Code();
      const S = 0;
      const I = 1;
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(S);
      c.arrayLen();
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.cp.inspected(s) -> string` — util.inspect(s), cut to its first 128
   * code units + "..." when longer (ERR_INVALID_ARG_VALUE's own rule). */
  private inspectedHelper(): number {
    return this.cached("inspected", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const S = 0;
      const R = 1;
      c.localGet(S);
      c.call(this.deps.inspectStr());
      c.localSet(R);
      c.localGet(R);
      c.arrayLen();
      c.i32Const(128);
      c.i32GtU();
      c.ifVoid();
      c.localGet(R);
      c.i32Const(0);
      c.i32Const(128);
      c.call(this.sliceHelper());
      this.deps.pushStrLit(c, "...");
      c.call(this.deps.concat());
      c.return_();
      c.end();
      c.localGet(R);
      this.mb.setBody(idx, [this.strRef()], c.bytes());
    });
  }

  /** `%w.cp.numSep(s) -> string` — Node's addNumericalSeparator: from the
   * end, "_" before every group of three while at least four characters
   * (after a leading "-") remain. */
  private numSepHelper(): number {
    return this.cached("numSep", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const S = 0;
      const RES = 1;
      const I = 2;
      const START = 3;
      this.deps.pushStrLit(c, "");
      c.localSet(RES);
      c.localGet(S);
      c.arrayLen();
      c.localSet(I);
      c.localGet(S);
      c.i32Const(0);
      c.arrayGetU(this.deps.strType());
      c.i32Const(45); // '-'
      c.i32Eq();
      c.localSet(START);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(START);
      c.i32Const(4);
      c.i32Add();
      c.i32LtS();
      c.brIf(1);
      this.deps.pushStrLit(c, "_");
      c.localGet(S);
      c.localGet(I);
      c.i32Const(3);
      c.i32Sub();
      c.localGet(I);
      c.call(this.sliceHelper());
      c.call(this.deps.concat());
      c.localGet(RES);
      c.call(this.deps.concat());
      c.localSet(RES);
      c.localGet(I);
      c.i32Const(3);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(S);
      c.i32Const(0);
      c.localGet(I);
      c.call(this.sliceHelper());
      c.localGet(RES);
      c.call(this.deps.concat());
      this.mb.setBody(idx, [this.strRef(), I32, I32], c.bytes());
    });
  }

  /** `%w.cp.codeName(errCode) -> string` — the record's errCode as Node's
   * error code: CP_CODES for 1..15, else Node's name for the carried errno
   * (CP_ERRNO_NAMES), else "Unknown system error -<n>". */
  codeNameHelper(): number {
    return this.cached("codeName", [I32], [this.strRef()], (idx) => {
      const c = new Code();
      const CODE = 0;
      const NEG = 1;
      CP_CODES.forEach((name, i) => {
        c.localGet(CODE);
        c.i32Const(i + 1);
        c.i32Eq();
        c.ifVoid();
        this.deps.pushStrLit(c, name);
        c.return_();
        c.end();
      });
      // -(256 + n) -> -n, Node's negative errno.
      c.localGet(CODE);
      c.i32Const(256);
      c.i32Add();
      c.localSet(NEG);
      for (const [n, name] of CP_ERRNO_NAMES) {
        c.localGet(NEG);
        c.i32Const(n);
        c.i32Eq();
        c.ifVoid();
        this.deps.pushStrLit(c, name);
        c.return_();
        c.end();
      }
      this.deps.pushStrLit(c, "Unknown system error ");
      c.localGet(NEG);
      c.f64ConvertI32S();
      c.call(this.deps.f64ToStr());
      c.call(this.deps.concat());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.cp.signalName(n) -> string` (n in 1..31; anything else ""). */
  signalNameHelper(): number {
    return this.cached("signalName", [I32], [this.strRef()], (idx) => {
      const c = new Code();
      CP_SIGNAL_NAMES.forEach((name, n) => {
        if (n === 0) return;
        c.localGet(0);
        c.i32Const(n);
        c.i32Eq();
        c.ifVoid();
        this.deps.pushStrLit(c, name);
        c.return_();
        c.end();
      });
      this.deps.pushStrLit(c, "");
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.cp.error(res) -> Error` — spawnSync's `error` property: a FRESH
   * %Error "spawnSync <file> <CODE>" with `code`, built on every read
   * (SEMANTICS.md S085). The caller reads it only when errCode != 0. */
  errorHelper(): number {
    return this.cached("error", [this.spawnResRef()], [this.deps.errRef()], (idx) => {
      const c = new Code();
      const R = 0;
      const CODE = 1;
      c.localGet(R);
      c.structGet(this.spawnResType(), SR_ERR_CODE);
      c.call(this.codeNameHelper());
      c.localSet(CODE);
      this.deps.newErrorCoded(
        c,
        (c2) => {
          this.deps.pushStrLit(c2, "spawnSync ");
          c2.localGet(R);
          c2.structGet(this.spawnResType(), SR_FILE);
          c2.call(this.deps.concat());
          this.deps.pushStrLit(c2, " ");
          c2.call(this.deps.concat());
          c2.localGet(CODE);
          c2.call(this.deps.concat());
        },
        (c2) => c2.localGet(CODE),
      );
      this.mb.setBody(idx, [this.strRef()], c.bytes());
    });
  }

  /* ── validation (Node's own text; each check writes the pending cell and
   * answers 0 on failure, 1 when the value passes) ───────────────────── */

  /** `%w.cp.checkNul(value, lead) -> i32` — ERR_INVALID_ARG_VALUE when the
   * value holds U+0000: lead + util.inspect(value) (128-cut). `lead` is the
   * message up to "Received " ("The argument 'file' must be a string
   * without null bytes. Received "). */
  checkNulHelper(): number {
    return this.cached("checkNul", [this.strRef(), this.strRef()], [I32], (idx) => {
      const c = new Code();
      const V = 0;
      const LEAD = 1;
      c.localGet(V);
      c.call(this.hasNulHelper());
      c.ifVoid();
      this.deps.throwCoded(
        c,
        "%TypeError",
        "TypeError",
        (c2) => {
          c2.localGet(LEAD);
          c2.localGet(V);
          c2.call(this.inspectedHelper());
          c2.call(this.deps.concat());
        },
        (c2) => this.deps.pushStrLit(c2, "ERR_INVALID_ARG_VALUE"),
      );
      c.i32Const(0);
      c.return_();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.cp.checkFile(file) -> i32` — Node's normalizeSpawnArguments for
   * the file: no U+0000, then not empty. */
  checkFileHelper(): number {
    return this.cached("checkFile", [this.strRef()], [I32], (idx) => {
      const c = new Code();
      const F = 0;
      c.localGet(F);
      this.deps.pushStrLit(c, "The argument 'file' must be a string without null bytes. Received ");
      c.call(this.checkNulHelper());
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(F);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      this.deps.throwCoded(
        c,
        "%TypeError",
        "TypeError",
        (c2) => this.deps.pushStrLit(c2, "The argument 'file' cannot be empty. Received ''"),
        (c2) => this.deps.pushStrLit(c2, "ERR_INVALID_ARG_VALUE"),
      );
      c.i32Const(0);
      c.return_();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.cp.checkArgs(argv, from) -> i32` — each argument from index
   * `from` on: no U+0000 ("The argument 'args[<i>]' ..."). */
  checkArgsHelper(): number {
    return this.cached("checkArgs", [this.deps.stringVecRef(), I32], [I32], (idx) => {
      const c = new Code();
      const V = 0;
      const I = 1;
      const N = 2;
      c.localGet(V);
      this.deps.stringVecLen(c);
      c.localSet(N);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(V);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      this.deps.pushStrLit(c, "The argument 'args[");
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.f64ToStr());
      c.call(this.deps.concat());
      this.deps.pushStrLit(c, "]' must be a string without null bytes. Received ");
      c.call(this.deps.concat());
      c.call(this.checkNulHelper());
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.cp.checkTimeout(t) -> i32` — validateTimeout: an integer >= 0
   * (-0 passes), else RangeError ERR_OUT_OF_RANGE with Node's rendering of
   * the received value (numeric separators past 2**32 in magnitude). */
  checkTimeoutHelper(): number {
    return this.cached("checkTimeout", [F64], [I32], (idx) => {
      const c = new Code();
      const T = 0;
      const INT = 1;
      const R = 2;
      // INT = finite && trunc(t) == t
      c.localGet(T);
      c.localGet(T);
      c.f64Sub();
      c.f64Const(0);
      c.f64Eq();
      c.localGet(T);
      c.f64Trunc();
      c.localGet(T);
      c.f64Eq();
      c.i32And();
      c.localSet(INT);
      c.localGet(INT);
      c.localGet(T);
      c.f64Const(0);
      c.f64Ge();
      c.i32And();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(T);
      c.call(this.deps.f64ToStr());
      c.localSet(R);
      c.localGet(INT);
      c.localGet(T);
      c.f64Abs();
      c.f64Const(4294967296);
      c.f64Gt();
      c.i32And();
      c.ifVoid();
      c.localGet(R);
      c.call(this.numSepHelper());
      c.localSet(R);
      c.end();
      this.deps.throwCoded(
        c,
        "%RangeError",
        "RangeError",
        (c2) => {
          this.deps.pushStrLit(c2, 'The value of "timeout" is out of range. It must be an unsigned integer. Received ');
          c2.localGet(R);
          c2.call(this.deps.concat());
        },
        (c2) => this.deps.pushStrLit(c2, "ERR_OUT_OF_RANGE"),
      );
      c.i32Const(0);
      this.mb.setBody(idx, [I32, this.strRef()], c.bytes());
    });
  }

  /* ── the spawnSync family ───────────────────────────────────────────── */

  /** `%w.cp.spawnSync(file, argv, timeout, killSignalName, stdinMode,
   * stdoutMode, stderrMode) -> spawnRes` — validation in Node's order
   * (file, args, timeout, killSignal), then the child with the module's
   * own environment; never throws after validation (spawn failures and
   * timeouts are data on the result). On a validation failure the cell is
   * set and a null placeholder returned (the caller's check unwinds). */
  spawnSyncHelper(): number {
    return this.cached(
      "spawnSync",
      [this.strRef(), this.deps.stringVecRef(), F64, this.strRef(), I32, I32, I32],
      [this.spawnResRef()],
      (idx) => {
        const c = new Code();
        const FILE = 0;
        const ARGV = 1;
        const TIMEOUT = 2;
        const KILLNAME = 3;
        const IN_MODE = 4;
        const OUT_MODE = 5;
        const ERR_MODE = 6;
        const KILL = 7;
        const fail = (): void => {
          c.i32Eqz();
          c.ifVoid();
          c.refNull(this.spawnResType());
          c.return_();
          c.end();
        };
        c.localGet(FILE);
        c.call(this.checkFileHelper());
        fail();
        c.localGet(ARGV);
        c.i32Const(0);
        c.call(this.checkArgsHelper());
        fail();
        c.localGet(TIMEOUT);
        c.call(this.checkTimeoutHelper());
        fail();
        c.localGet(KILLNAME);
        c.call(this.deps.killSignalByName());
        c.i32TruncF64S();
        c.localTee(KILL);
        c.i32Const(0);
        c.i32LtS();
        c.ifVoid();
        this.deps.throwCoded(
          c,
          "%TypeError",
          "TypeError",
          (c2) => {
            this.deps.pushStrLit(c2, "Unknown signal: ");
            c2.localGet(KILLNAME);
            c2.call(this.deps.concat());
          },
          (c2) => this.deps.pushStrLit(c2, "ERR_UNKNOWN_SIGNAL"),
        );
        c.refNull(this.spawnResType());
        c.return_();
        c.end();
        c.localGet(FILE);
        c.localGet(ARGV);
        this.deps.pushStrLit(c, "");
        c.call(this.deps.envPairs());
        c.refNull(this.deps.strType());
        c.localGet(IN_MODE);
        c.localGet(OUT_MODE);
        c.localGet(ERR_MODE);
        c.localGet(KILL);
        c.localGet(TIMEOUT);
        c.i32Const(0); // Node's default maxBuffer
        c.i32Const(0); // no echo
        c.i32Const(1); // the module's own map: cut at U+0000
        c.call(this.runHelper());
        this.mb.setBody(idx, [I32], c.bytes());
      },
    );
  }

  /** `%w.cp.spawnSyncStdioStr(file, argv, timeout, killSignalName, stdio)`
   * — the runtime stdio string ("pipe" | "ignore" | "inherit", proven by
   * the call site's type) mapped to the three modes; "ignore" gives the
   * child /dev/null on stdin (mode 3), Node-exact. */
  spawnSyncStdioStrHelper(): number {
    return this.cached(
      "spawnSyncStdioStr",
      [this.strRef(), this.deps.stringVecRef(), F64, this.strRef(), this.strRef()],
      [this.spawnResRef()],
      (idx) => {
        const c = new Code();
        const STDIO = 4;
        const call = (inMode: number, outMode: number): void => {
          c.localGet(0);
          c.localGet(1);
          c.localGet(2);
          c.localGet(3);
          c.i32Const(inMode);
          c.i32Const(outMode);
          c.i32Const(outMode);
          c.call(this.spawnSyncHelper());
          c.return_();
        };
        const is = (lit: string): void => {
          c.localGet(STDIO);
          c.arrayLen();
          c.i32Const(lit.length);
          c.i32Eq();
          c.ifResult(I32);
          c.localGet(STDIO);
          c.i32Const(0);
          c.arrayGetU(this.deps.strType());
          c.i32Const(lit.charCodeAt(0));
          c.i32Eq();
          c.else_();
          c.i32Const(0);
          c.end();
        };
        is("pipe");
        c.ifVoid();
        call(0, 0);
        c.end();
        is("ignore");
        c.ifVoid();
        call(3, 1);
        c.end();
        is("inherit");
        c.ifVoid();
        call(2, 2);
        c.end();
        this.deps.namedTrap(c, "spawnSync: stdio string outside its proven type");
        c.refNull(this.spawnResType());
        this.mb.setBody(idx, [], c.bytes());
      },
    );
  }


  /* ── the exec family (execSync, execFileSync, promisified execFile) ──── */

  /** `%w.cp.join(argv, from) -> string` — argv[from..] joined by " ". */
  private joinHelper(): number {
    return this.cached("join", [this.deps.stringVecRef(), I32], [this.strRef()], (idx) => {
      const c = new Code();
      const V = 0;
      const I = 1;
      const N = 2;
      const OUT = 3;
      c.localGet(V);
      this.deps.stringVecLen(c);
      c.localSet(N);
      this.deps.pushStrLit(c, "");
      c.localSet(OUT);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(OUT);
      c.arrayLen();
      c.ifVoid();
      c.localGet(OUT);
      this.deps.pushStrLit(c, " ");
      c.call(this.deps.concat());
      c.localSet(OUT);
      c.end();
      c.localGet(OUT);
      c.localGet(V);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.call(this.deps.concat());
      c.localSet(OUT);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUT);
      this.mb.setBody(idx, [I32, this.strRef()], c.bytes());
    });
  }

  /** `%w.cp.checkCwdEnv(cwd, hasEnv, pairs) -> i32` — Node's cwd check (a
   * cwd of "" is how the lowering spells "absent", so it is not checked)
   * and the env option's per-entry checks, key then value, in insertion
   * order. */
  checkCwdEnvHelper(): number {
    return this.cached("checkCwdEnv", [this.strRef(), I32, this.deps.stringVecRef()], [I32], (idx) => {
      const c = new Code();
      const CWD = 0;
      const HAS_ENV = 1;
      const PAIRS = 2;
      const I = 3;
      const N = 4;
      const LEAD = 5;
      c.localGet(CWD);
      c.arrayLen();
      c.ifVoid();
      c.localGet(CWD);
      this.deps.pushStrLit(c, "The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received ");
      c.call(this.checkNulHelper());
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.end();
      c.localGet(HAS_ENV);
      c.ifVoid();
      c.localGet(PAIRS);
      this.deps.stringVecLen(c);
      c.localSet(N);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      this.deps.pushStrLit(c, "The property 'options.env['");
      c.localGet(PAIRS);
      c.localGet(I);
      c.f64ConvertI32S();
      c.call(this.deps.stringVecGet());
      c.call(this.deps.concat());
      this.deps.pushStrLit(c, "']' must be a string without null bytes. Received ");
      c.call(this.deps.concat());
      c.localSet(LEAD);
      for (const off of [0, 1]) {
        c.localGet(PAIRS);
        c.localGet(I);
        c.i32Const(off);
        c.i32Add();
        c.f64ConvertI32S();
        c.call(this.deps.stringVecGet());
        c.localGet(LEAD);
        c.call(this.checkNulHelper());
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
      }
      c.localGet(I);
      c.i32Const(2);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [I32, I32, this.strRef()], c.bytes());
    });
  }

  /** Throw a plain %Error with `message` (pushed by `pushMessage`) and the
   * code string in local `codeLocal`, or no code when `codeLocal` < 0. */
  private emitThrowError(c: Code, pushMessage: (c: Code) => void, codeLocal: number): void {
    this.deps.throwCoded(c, "%Error", "Error", pushMessage, (c2) => {
      if (codeLocal < 0) c2.refNull(this.deps.strType());
      else c2.localGet(codeLocal);
    });
  }

  /** `%w.cp.execSync(file, argv, shell, input, hasInput, cwd, hasEnv,
   * pairs, timeout, stdoutMode, stderrMode) -> stdout` — execSync (shell
   * = 1: file is /bin/sh, argv ["-c", command]) and execFileSync. The IR's
   * modes: stdout 1 capture / 0 ignore / 2 inherit, plus 4 when stdin is
   * inherited; stderr 0 capture AND echo (no stdio option — Node's
   * inheritStderr) / 1 capture / 2 ignore / 3 inherit. Validation in
   * Node's order, then the child; then Node's checkExecSyncError: an
   * errno wins ("spawnSync <file> <CODE>" with code), else a non-zero
   * status or a signal is "Command failed: <display>" plus "\n" + stderr
   * when stderr was captured and is not empty (no code). The echo is
   * written raw inside `run`, before any throw. */
  execSyncHelper(): number {
    const vec = this.deps.stringVecRef();
    return this.cached(
      "execSync",
      [this.strRef(), vec, I32, this.strRef(), I32, this.strRef(), I32, vec, F64, I32, I32],
      [this.strRef()],
      (idx) => {
        const c = new Code();
        const FILE = 0;
        const ARGV = 1;
        const SHELL = 2;
        const INPUT = 3;
        const HAS_INPUT = 4;
        const CWD = 5;
        const HAS_ENV = 6;
        const PAIRS = 7;
        const TIMEOUT = 8;
        const OUTM = 9;
        const ERRM = 10;
        const CMD = 11; // string
        const RES = 12; // spawnRes
        const CODE = 13; // string
        const IN = 14;
        const OUT = 15;
        const ERR = 16;
        const fail = (): void => {
          c.i32Eqz();
          c.ifVoid();
          this.deps.pushStrLit(c, "");
          c.return_();
          c.end();
        };
        // The file, or the shell form's command (argv[1]).
        c.localGet(SHELL);
        c.ifVoid();
        c.localGet(ARGV);
        c.f64Const(1);
        c.call(this.deps.stringVecGet());
        c.localSet(CMD);
        c.localGet(CMD);
        this.deps.pushStrLit(c, "The argument 'command' must be a string without null bytes. Received ");
        c.call(this.checkNulHelper());
        fail();
        c.localGet(CMD);
        c.call(this.checkFileHelper());
        fail();
        c.else_();
        c.localGet(FILE);
        c.call(this.checkFileHelper());
        fail();
        c.localGet(ARGV);
        c.i32Const(0);
        c.call(this.checkArgsHelper());
        fail();
        c.end();
        c.localGet(CWD);
        c.localGet(HAS_ENV);
        c.localGet(PAIRS);
        c.call(this.checkCwdEnvHelper());
        fail();
        c.localGet(TIMEOUT);
        c.call(this.checkTimeoutHelper());
        fail();
        // The request modes.
        c.localGet(HAS_INPUT);
        c.ifResult(I32);
        c.i32Const(1);
        c.else_();
        c.localGet(OUTM);
        c.i32Const(4);
        c.i32And();
        c.ifResult(I32);
        c.i32Const(2);
        c.else_();
        c.i32Const(0);
        c.end();
        c.end();
        c.localSet(IN);
        // stdout: 1 -> 0 capture, 0 -> 1 discard, 2 -> 2 inherit.
        c.localGet(OUTM);
        c.i32Const(3);
        c.i32And();
        c.localTee(OUT);
        c.i32Const(2);
        c.i32Ne();
        c.ifVoid();
        c.i32Const(1);
        c.localGet(OUT);
        c.i32Sub();
        c.localSet(OUT);
        c.end();
        // stderr: 0/1 -> 0 capture, 2 -> 1 discard, 3 -> 2 inherit.
        c.localGet(ERRM);
        c.i32Const(1);
        c.i32Sub();
        c.localTee(ERR);
        c.i32Const(0);
        c.i32LtS();
        c.ifVoid();
        c.i32Const(0);
        c.localSet(ERR);
        c.end();
        // The child.
        c.localGet(FILE);
        c.localGet(ARGV);
        c.localGet(CWD);
        c.localGet(HAS_ENV);
        c.ifResult(vec);
        c.localGet(PAIRS);
        c.else_();
        c.call(this.deps.envPairs());
        c.end();
        c.localGet(HAS_INPUT);
        c.ifResult(this.strRef());
        c.localGet(INPUT);
        c.else_();
        c.refNull(this.deps.strType());
        c.end();
        c.localGet(IN);
        c.localGet(OUT);
        c.localGet(ERR);
        c.i32Const(15);
        c.localGet(TIMEOUT);
        c.i32Const(1); // unbounded (SEMANTICS.md S085)
        c.localGet(ERRM);
        c.i32Eqz(); // the echo: no stdio option
        c.localGet(HAS_ENV);
        c.i32Eqz(); // the module's own map: cut at U+0000
        c.call(this.runHelper());
        c.localSet(RES);
        // An errno wins.
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_ERR_CODE);
        c.ifVoid();
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_ERR_CODE);
        c.call(this.codeNameHelper());
        c.localSet(CODE);
        this.emitThrowError(
          c,
          (c2) => {
            this.deps.pushStrLit(c2, "spawnSync ");
            c2.localGet(FILE);
            c2.call(this.deps.concat());
            this.deps.pushStrLit(c2, " ");
            c2.call(this.deps.concat());
            c2.localGet(CODE);
            c2.call(this.deps.concat());
          },
          CODE,
        );
        this.deps.pushStrLit(c, "");
        c.return_();
        c.end();
        // A non-zero status or a signal.
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_HAS_STATUS);
        c.ifResult(I32);
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_STATUS);
        c.f64Const(0);
        c.f64Ne();
        c.else_();
        c.i32Const(1);
        c.end();
        c.ifVoid();
        this.emitThrowError(
          c,
          (c2) => {
            this.deps.pushStrLit(c2, "Command failed: ");
            c2.localGet(SHELL);
            c2.ifResult(this.strRef());
            c2.localGet(ARGV);
            c2.f64Const(1);
            c2.call(this.deps.stringVecGet());
            c2.else_();
            c2.localGet(FILE);
            c2.localGet(ARGV);
            this.deps.stringVecLen(c2);
            c2.ifResult(this.strRef());
            this.deps.pushStrLit(c2, " ");
            c2.localGet(ARGV);
            c2.i32Const(0);
            c2.call(this.joinHelper());
            c2.call(this.deps.concat());
            c2.else_();
            this.deps.pushStrLit(c2, "");
            c2.end();
            c2.call(this.deps.concat());
            c2.end();
            c2.call(this.deps.concat());
            c2.localGet(RES);
            c2.structGet(this.spawnResType(), SR_STDERR);
            c2.arrayLen();
            c2.ifResult(this.strRef());
            this.deps.pushStrLit(c2, "\n");
            c2.localGet(RES);
            c2.structGet(this.spawnResType(), SR_STDERR);
            c2.call(this.deps.concat());
            c2.else_();
            this.deps.pushStrLit(c2, "");
            c2.end();
            c2.call(this.deps.concat());
          },
          -1,
        );
        this.deps.pushStrLit(c, "");
        c.return_();
        c.end();
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_STDOUT);
        this.mb.setBody(idx, [this.strRef(), this.spawnResRef(), this.strRef(), I32, I32, I32], c.bytes());
      },
    );
  }

  /** `%w.cp.execCapture(file, argv, cwd, hasEnv, pairs, timeout) ->
   * spawnRes` — promisified execFile's child (the IR's async helper turns a
   * throw into the rejection). Validation in Node's ASYNC order — execFile
   * checks the timeout before spawn normalizes the file, args, cwd and env
   * (Node throws these synchronously from the call; here the promise
   * rejects, SEMANTICS.md S085). Then Node's exithandler: an errno other
   * than ETIMEDOUT is "spawn <file> <CODE>" with code; a non-zero status
   * or a signal (a timeout's kill included) is "Command failed: <file>
   * <args>\n<stderr>" (newline unconditional, no numeric code); a child
   * that exits 0 after the timeout's signal resolves. */
  execCaptureHelper(): number {
    const vec = this.deps.stringVecRef();
    return this.cached(
      "execCapture",
      [this.strRef(), vec, this.strRef(), I32, vec, F64],
      [this.spawnResRef()],
      (idx) => {
        const c = new Code();
        const FILE = 0;
        const ARGV = 1;
        const CWD = 2;
        const HAS_ENV = 3;
        const PAIRS = 4;
        const TIMEOUT = 5;
        const RES = 6; // spawnRes
        const CODE = 7; // string
        const ERRC = 8;
        const fail = (): void => {
          c.i32Eqz();
          c.ifVoid();
          c.refNull(this.spawnResType());
          c.return_();
          c.end();
        };
        c.localGet(TIMEOUT);
        c.call(this.checkTimeoutHelper());
        fail();
        c.localGet(FILE);
        c.call(this.checkFileHelper());
        fail();
        c.localGet(ARGV);
        c.i32Const(0);
        c.call(this.checkArgsHelper());
        fail();
        c.localGet(CWD);
        c.localGet(HAS_ENV);
        c.localGet(PAIRS);
        c.call(this.checkCwdEnvHelper());
        fail();
        c.localGet(FILE);
        c.localGet(ARGV);
        c.localGet(CWD);
        c.localGet(HAS_ENV);
        c.ifResult(vec);
        c.localGet(PAIRS);
        c.else_();
        c.call(this.deps.envPairs());
        c.end();
        c.refNull(this.deps.strType());
        c.i32Const(0);
        c.i32Const(0);
        c.i32Const(0);
        c.i32Const(15);
        c.localGet(TIMEOUT);
        c.i32Const(1);
        c.i32Const(0);
        c.localGet(HAS_ENV);
        c.i32Eqz();
        c.call(this.runHelper());
        c.localSet(RES);
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_ERR_CODE);
        c.localTee(ERRC);
        c.i32Const(0);
        c.i32Ne();
        c.localGet(ERRC);
        c.i32Const(13); // ETIMEDOUT: judged by status/signal below
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        c.localGet(ERRC);
        c.call(this.codeNameHelper());
        c.localSet(CODE);
        this.emitThrowError(
          c,
          (c2) => {
            this.deps.pushStrLit(c2, "spawn ");
            c2.localGet(FILE);
            c2.call(this.deps.concat());
            this.deps.pushStrLit(c2, " ");
            c2.call(this.deps.concat());
            c2.localGet(CODE);
            c2.call(this.deps.concat());
          },
          CODE,
        );
        c.refNull(this.spawnResType());
        c.return_();
        c.end();
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_HAS_STATUS);
        c.ifResult(I32);
        c.localGet(RES);
        c.structGet(this.spawnResType(), SR_STATUS);
        c.f64Const(0);
        c.f64Ne();
        c.else_();
        c.i32Const(1);
        c.end();
        c.ifVoid();
        this.emitThrowError(
          c,
          (c2) => {
            this.deps.pushStrLit(c2, "Command failed: ");
            c2.localGet(FILE);
            c2.call(this.deps.concat());
            c2.localGet(ARGV);
            this.deps.stringVecLen(c2);
            c2.ifResult(this.strRef());
            this.deps.pushStrLit(c2, " ");
            c2.localGet(ARGV);
            c2.i32Const(0);
            c2.call(this.joinHelper());
            c2.call(this.deps.concat());
            c2.else_();
            this.deps.pushStrLit(c2, "");
            c2.end();
            c2.call(this.deps.concat());
            this.deps.pushStrLit(c2, "\n");
            c2.call(this.deps.concat());
            c2.localGet(RES);
            c2.structGet(this.spawnResType(), SR_STDERR);
            c2.call(this.deps.concat());
          },
          -1,
        );
        c.refNull(this.spawnResType());
        c.return_();
        c.end();
        c.localGet(RES);
        this.mb.setBody(idx, [this.spawnResRef(), this.strRef(), I32], c.bytes());
      },
    );
  }

}
