/* SCRIPTC_WASM_IC_STATS=1: instrumented counters for the U8 speed work
 * (docs/design/u8-dynamic-speed.md §9). Never on by default; with the
 * variable unset at compile time nothing here emits a byte.
 *
 * The CI speed checks count work instead of timing it, so they cannot
 * flake: a row builds a probe with the variable set, runs it, and reads
 * the counts the program prints to stderr when `_start` ends:
 *
 *   tsinter-stats: dyn-allocs <n>
 *
 * dyn-allocs counts every `$dyn` box the program allocated: each
 * `struct.new` of the box type (dyn.ts dynT), wherever it is emitted, first
 * adds one to an i64 global. A loop whose body allocates no box prints the
 * same count at 1 round as at 2 (wasm-u8a-loop.test.ts).
 *
 * Later U8 sub-units add their counters (IC hits and misses, shapes
 * created, argument vectors) to this report. */
import type { Code } from "./code.js";

/** Is the stats mode on for this build? Read per build (the variable is the
 * compiler's environment, as SCRIPTC_WASM_LIT_CHECK is). */
export function icStatsOn(): boolean {
  return process.env["SCRIPTC_WASM_IC_STATS"] === "1";
}

/** The box counter: its i64 global, and the `$dyn` type index once the
 * module mints it (-1 before). Null outside the stats mode. */
let dynAllocCounter: { global: number; typeIndex: number } | null = null;

/** Arms (a global index) or clears (null) the box counter for the module
 * being built. emitWasmModule clears it when the build ends. */
export function setDynAllocCounter(global: number | null): void {
  dynAllocCounter = global === null ? null : { global, typeIndex: -1 };
}

/** dyn.ts dynT: the `$dyn` box type's index, once minted. */
export function noteDynType(typeIndex: number): void {
  if (dynAllocCounter !== null) dynAllocCounter.typeIndex = typeIndex;
}

/** code.ts structNew: before a `struct.new` of `typeIndex`, add one to the
 * box counter when that is the box type. The operands already on the
 * stack are untouched. */
export function countDynAlloc(c: Code, typeIndex: number): void {
  if (dynAllocCounter === null || typeIndex !== dynAllocCounter.typeIndex) return;
  c.globalGet(dynAllocCounter.global);
  c.i64Const(1n);
  c.i64Add();
  c.globalSet(dynAllocCounter.global);
}

export interface IcStatsReportDeps {
  /** Push a compile-time string literal onto `c`. */
  pushStrLit: (c: Code, value: string) => void;
  /** The console line helpers: stage a string, put one byte, flush the
   * staged line to a file descriptor. */
  stage: number;
  putc: number;
  flush: number;
  /** `f64 -> str`, console.log's number format. */
  f64ToStr: number;
}

/** The report line, written to stderr. Emitted at the end of `_start`. */
export function emitIcStatsReport(c: Code, deps: IcStatsReportDeps): void {
  if (dynAllocCounter === null) return;
  deps.pushStrLit(c, "tsinter-stats: dyn-allocs ");
  c.call(deps.stage);
  c.globalGet(dynAllocCounter.global);
  c.f64ConvertI64U();
  c.call(deps.f64ToStr);
  c.call(deps.stage);
  c.i32Const(0x0a);
  c.call(deps.putc);
  c.i32Const(2);
  c.call(deps.flush);
}
