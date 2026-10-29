/* The module's view of its OS (SEMANTICS.md S118): one compiled module
 * runs on every OS, so it bakes in no signal or errno NUMBER. It keeps the
 * NAMES (os-names.ts, generated from Node's libuv headers by
 * scripts/gen-os-names.mjs) and asks the host, through hostNum kinds 16
 * and 17 (abi.ts), for the number the host's OS gives each — what that
 * OS's Node puts in os.constants.signals and util.getSystemErrorMap().
 * Every signal or errno number crossing the host contract is the host
 * OS's own, and is named here.
 *
 * The lookups are unrolled name by name (a host call each) and never
 * cached: they run on an error or a signal path, where one host call per
 * name costs nothing next to the syscall that produced the number. */
import { Code } from "./code.js";
import { I32, type ModuleBuilder, type ValType } from "./module.js";
import { HOST_NUM_KIND_ERRNO_NUMBER, HOST_NUM_KIND_PLATFORM_ID, HOST_NUM_KIND_SIGNAL_NUMBER, PLATFORM_ID_WIN32 } from "./abi.js";

const PLATFORM_NAMES = ["linux", "darwin", "win32", "this OS"];
import { ERRNO_NAMES, SIGNAL_NAMES, errnoIndex, signalIndex } from "./os-names.js";

export interface OsTablesDeps {
  strRef: () => ValType;
  /** `%w.strEq(ref,ref)->i32` — content equality */
  strEq: () => number;
  hostNumFunc: () => number;
  pushStrLit: (c: Code, value: string) => void;
}

export class OsTablesBuilder {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: OsTablesDeps,
  ) {}

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.os.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  private platformGlobal: number | null = null;

  /** `%w.os.platformId() -> i32`: the host's OS (abi.ts hostNum kind 18:
   * PLATFORM_ID_LINUX / _DARWIN / _WIN32 / _OTHER), asked once and kept in
   * a global (-1 until asked). */
  platformIdHelper(): number {
    return this.cached("platformId", [], [I32], (idx) => {
      this.platformGlobal ??= this.mb.addGlobal(I32, true, (w) => {
        w.u8(0x41);
        w.sleb(-1);
      });
      const g = this.platformGlobal;
      const c = new Code();
      c.globalGet(g);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(HOST_NUM_KIND_PLATFORM_ID);
      c.i32Const(0);
      c.call(this.deps.hostNumFunc());
      c.i32TruncF64S();
      c.globalSet(g);
      c.end();
      c.globalGet(g);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** Pushes 1 when the host's OS is `id` (a PLATFORM_ID_*), else 0. */
  emitPlatformIs(c: Code, id: number): void {
    c.call(this.platformIdHelper());
    c.i32Const(id);
    c.i32Eq();
  }

  /** `%w.os.defaultHwm() -> i32`: Node's default byte highWaterMark on the
   * host's OS (lib/internal/streams/state.js: 16 KiB on win32, 64 KiB
   * elsewhere — stream.getDefaultHighWaterMark(false)). */
  defaultHwmHelper(): number {
    return this.cached("defaultHwm", [], [I32], (idx) => {
      const c = new Code();
      this.emitPlatformIs(c, PLATFORM_ID_WIN32);
      c.ifResult(I32);
      c.i32Const(16384);
      c.else_();
      c.i32Const(65536);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** Pushes defaultHwm as an f64. */
  emitDefaultHwmF64(c: Code): void {
    c.call(this.defaultHwmHelper());
    c.f64ConvertI32S();
  }

  /** A surface whose Node behaviour differs on OS `id` in a way the tier
   * does not model yet: on that OS the program stops with a named report
   * (`trap` — the caller's uncaught-report-and-exit), never a silent
   * difference (SEMANTICS.md S118). */
  emitUnsupportedOn(c: Code, id: number, what: string, trap: (c: Code, message: string) => void): void {
    this.emitPlatformIs(c, id);
    c.ifVoid();
    trap(c, `wasm tier: ${what} is not supported on ${PLATFORM_NAMES[id]} yet (SEMANTICS.md S118)`);
    c.end();
  }

  /** `%w.os.signalNum(i) -> i32`: the host OS's number for
   * SIGNAL_NAMES[i], 0 when its OS has none. */
  signalNumHelper(): number {
    return this.cached("signalNum", [I32], [I32], (idx) => {
      const c = new Code();
      c.i32Const(HOST_NUM_KIND_SIGNAL_NUMBER);
      c.localGet(0);
      c.call(this.deps.hostNumFunc());
      c.i32TruncF64S();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.os.errnoNum(i) -> i32`: the host OS's (negative) libuv number for
   * ERRNO_NAMES[i], 0 when its OS has none. */
  errnoNumHelper(): number {
    return this.cached("errnoNum", [I32], [I32], (idx) => {
      const c = new Code();
      c.i32Const(HOST_NUM_KIND_ERRNO_NUMBER);
      c.localGet(0);
      c.call(this.deps.hostNumFunc());
      c.i32TruncF64S();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** Pushes the host OS's number for signal `name` (i32). */
  emitSignalNum(c: Code, name: string): void {
    c.i32Const(signalIndex(name));
    c.call(this.signalNumHelper());
  }

  /** Pushes the host OS's libuv number for errno `name` (i32). */
  emitErrnoNum(c: Code, name: string): void {
    c.i32Const(errnoIndex(name));
    c.call(this.errnoNumHelper());
  }

  /** `%w.os.signalByName(name) -> i32`: the host OS's number for the
   * signal spelled exactly `name` (os.constants.signals[name]), 0 when the
   * name is not one its OS has. A flat chain of string comparisons — never
   * an object-keyed lookup ("toString" is no signal). */
  signalByNameHelper(): number {
    return this.cached("signalByName", [this.deps.strRef()], [I32], (idx) => {
      const c = new Code();
      SIGNAL_NAMES.forEach((name, i) => {
        c.localGet(0);
        this.deps.pushStrLit(c, name);
        c.call(this.deps.strEq());
        c.ifVoid();
        c.i32Const(i);
        c.call(this.signalNumHelper());
        c.return_();
        c.end();
      });
      c.i32Const(0);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.os.signalName(n) -> string`: the FIRST name (os-names.ts order)
   * the host OS gives signal number `n` — Node's name for a child's signal
   * (6 is SIGABRT, never SIGIOT) — or "" when none does (n <= 0 included). */
  signalNameHelper(): number {
    return this.cached("signalName", [I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.i32Const(0);
      c.i32LeS();
      c.ifVoid();
      this.deps.pushStrLit(c, "");
      c.return_();
      c.end();
      SIGNAL_NAMES.forEach((name, i) => {
        c.i32Const(i);
        c.call(this.signalNumHelper());
        c.localGet(0);
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

  /** `%w.os.errnoName(n) -> string`: Node's code for the host OS's libuv
   * errno `n` (util.getSystemErrorName), "" when its map has none (n >= 0
   * included). */
  errnoNameHelper(): number {
    return this.errnoTextHelper("errnoName", 0);
  }

  /** `%w.os.errnoMessage(n) -> string`: libuv's message for errno `n`
   * (uv_strerror: util.getSystemErrorMap()'s text), "" when none. */
  errnoMessageHelper(): number {
    return this.errnoTextHelper("errnoMessage", 1);
  }

  private errnoTextHelper(name: string, field: 0 | 1): number {
    return this.cached(name, [I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      this.deps.pushStrLit(c, "");
      c.return_();
      c.end();
      ERRNO_NAMES.forEach((entry, i) => {
        c.i32Const(i);
        c.call(this.errnoNumHelper());
        c.localGet(0);
        c.i32Eq();
        c.ifVoid();
        this.deps.pushStrLit(c, entry[field]);
        c.return_();
        c.end();
      });
      this.deps.pushStrLit(c, "");
      this.mb.setBody(idx, [], c.bytes());
    });
  }
}
