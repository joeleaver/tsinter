/* SCRIPTC_WASM_IC_STATS=1: instrumented counters for the U8 speed work
 * (docs/design/u8-dynamic-speed.md §9). Never on by default; with the
 * variable unset at compile time nothing here emits a byte.
 *
 * The CI speed checks count work instead of timing it, so they cannot
 * flake: a row builds a probe with the variable set, runs it, and reads
 * the counts the program prints to stderr when `_start` ends, one line
 * per counter:
 *
 *   tsinter-stats: dyn-allocs <n>
 *   tsinter-stats: ic-hits <n>
 *   tsinter-stats: ic-misses <n>
 *   tsinter-stats: shapes <n>
 *   tsinter-stats: ic-megas <n>
 *   tsinter-stats: set-hits <n>
 *   tsinter-stats: set-misses <n>
 *   tsinter-stats: lit-hits <n>
 *   tsinter-stats: proto-bumps <n>
 *
 *   - dyn-allocs counts every `$dyn` box the program allocated: each
 *     `struct.new` of the box type (dyn.ts dynT), wherever it is emitted,
 *     first adds one to an i64 global. A loop whose body allocates no box
 *     prints the same count at 1 round as at 2 (wasm-u8a-loop.test.ts).
 *   - ic-hits / ic-misses count the property-read caches' answers
 *     (ic-read.ts): a hit is a read the site's cache answered inline, a
 *     miss one that went to the shared miss helper (filling the cache or
 *     reading through keyGet).
 *   - shapes counts the shapes made (shapes.ts next), the root excluded.
 *   - ic-megas counts the sites (read or store) that went megamorphic
 *     (ic-ways.ts): every way taken, and a further shape offered.
 *   - set-hits / set-misses count the store caches' writes (ic-write.ts):
 *     a hit is a write the site's cache did itself (in place, or an
 *     append on a cached transition), a miss one that went to the shared
 *     miss helper or through keySet.
 *   - lit-hits counts the object literals built on their site's cached
 *     final shape (lit-shape.ts).
 *   - proto-bumps counts the moves of the prototype epoch (proto-ic.ts):
 *     key-structure changes of objects that are prototypes.
 *
 * Every counter's global is made when the module starts (the Assembler's
 * constructor), so a counter reads 0 in a module that never reaches it.
 * Later U8 sub-units add their counters (argument vectors, ...) here. */
import type { Code } from "./code.js";
import { I64, type ModuleBuilder } from "./module.js";

/** Is the stats mode on for this build? Read per build (the variable is the
 * compiler's environment, as SCRIPTC_WASM_LIT_CHECK is). */
export function icStatsOn(): boolean {
  return process.env["SCRIPTC_WASM_IC_STATS"] === "1";
}

/** The counters, in report order. */
const COUNTERS = ["dyn-allocs", "ic-hits", "ic-misses", "shapes", "ic-megas", "set-hits", "set-misses", "lit-hits", "proto-bumps"] as const;
type Counter = (typeof COUNTERS)[number];

/** The module being built's counter globals, and the `$dyn` type index
 * once the module mints it (-1 before). Null outside the stats mode. */
let stats: { globals: Record<Counter, number>; dynType: number } | null = null;

/** Arms the counters for the module `mb` builds (stats mode only), before
 * anything can mint the box type. */
export function armIcStats(mb: ModuleBuilder): void {
  if (!icStatsOn()) return;
  const globals = {} as Record<Counter, number>;
  for (const name of COUNTERS) {
    globals[name] = mb.addGlobal(I64, true, (w) => {
      w.u8(0x42); // i64.const
      w.sleb64(0n);
    });
  }
  stats = { globals, dynType: -1 };
}

/** Clears the counters; emitWasmModule calls it when the build ends. */
export function clearIcStats(): void {
  stats = null;
}

/** dyn.ts dynT: the `$dyn` box type's index, once minted. */
export function noteDynType(typeIndex: number): void {
  if (stats !== null) stats.dynType = typeIndex;
}

function bump(c: Code, name: Counter): void {
  if (stats === null) return;
  const g = stats.globals[name];
  c.globalGet(g);
  c.i64Const(1n);
  c.i64Add();
  c.globalSet(g);
}

/** code.ts structNew: before a `struct.new` of `typeIndex`, add one to the
 * box counter when that is the box type. The operands already on the
 * stack are untouched. */
export function countDynAlloc(c: Code, typeIndex: number): void {
  if (stats === null || typeIndex !== stats.dynType) return;
  bump(c, "dyn-allocs");
}

/** ic-read.ts: a read a site's cache answered inline. */
export function countIcHit(c: Code): void {
  bump(c, "ic-hits");
}

/** ic-read.ts: a read that went to the miss helper. */
export function countIcMiss(c: Code): void {
  bump(c, "ic-misses");
}

/** ic-ways.ts: a site gone megamorphic. */
export function countIcMega(c: Code): void {
  bump(c, "ic-megas");
}

/** ic-write.ts: a write a store site's cache did itself. */
export function countSetHit(c: Code): void {
  bump(c, "set-hits");
}

/** ic-write.ts: a write that went to the miss helper or keySet. */
export function countSetMiss(c: Code): void {
  bump(c, "set-misses");
}

/** lit-shape.ts: an object literal built on its cached final shape. */
export function countLitHit(c: Code): void {
  bump(c, "lit-hits");
}

/** proto-ic.ts: a move of the prototype epoch. */
export function countProtoBump(c: Code): void {
  bump(c, "proto-bumps");
}

/** shapes.ts: a shape made. */
export function countShape(c: Code): void {
  bump(c, "shapes");
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

/** The report lines, written to stderr. Emitted at the end of `_start`. */
export function emitIcStatsReport(c: Code, deps: IcStatsReportDeps): void {
  if (stats === null) return;
  for (const name of COUNTERS) {
    deps.pushStrLit(c, `tsinter-stats: ${name} `);
    c.call(deps.stage);
    c.globalGet(stats.globals[name]);
    c.f64ConvertI64U();
    c.call(deps.f64ToStr);
    c.call(deps.stage);
    c.i32Const(0x0a);
    c.call(deps.putc);
    c.i32Const(2);
    c.call(deps.flush);
  }
}
