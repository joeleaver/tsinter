// Function reference identity across ARITY WIDENING: a pure arity-drop
// coercion is an invocation rule in JS, not a value-shape coercion — Node
// mints no new function object, so every identity spelling must agree.
// Re-derived by the corpus-scan census (board #94) from board #85/#89's own
// probes: a depth-3 narrow->mid->wide chain, an unrelated no-match pair, an
// array slot compared both by index and via deepStrictEqual/notDeepStrictEqual,
// a record-field direct coercion plus a width-lift over an unrelated method,
// and a captured-state closure proving the widened view drives the SAME cell.
// (Formerly g1 in the corpus-scan re-derivation — renamed per board #94's
// fix round, task #94/94-D1: the corpus is numerically keyed.)
//
// WIDENING PROVENANCE CHAIN (task #94, board #94 — read this before ever
// touching the cells below): the ORIGINAL sketch — MEASURED at commit
// 0f991c2, not stored or living there — dropped only SCALAR (number/
// boolean) trailing params, constrained on purpose, because native lanes
// lost identity on REFCOUNTED (string) trailing drops — the 85-D4
// trampoline's release path was position-based, not kind-based. BOARD #89
// LANDED (43f71a7) and fixed exactly that axis. RE-MEASURED here at P1
// with an independent probe (computed, never-literal strings; single- and
// double-string-drop, plus a negative control) — byte-exact on c/llvm/wasm
// against the Node oracle. WIDENED below to add the now-correct axis.
import assert from "node:assert";

function narrow(a: string): void {
  console.log("narrow", a);
}
type Mid = (a: string, b: number) => void;
type Wide = (a: string, b: number, c: boolean) => void;
const mid: Mid = narrow;
const wide: Wide = mid;
mid("m", 1);
wide("w", 2, true);
console.log("chain:", mid === narrow, wide === narrow, wide === mid);

// An unrelated pair AFTER the chain: no-match passthrough with bases present.
function plainA(): void {}
function plainB(): void {}
console.log("plain:", plainA === plainA, plainA === plainB);

// Through an array element, and deep-equality over widened elements.
const f = (a: number): void => {
  console.log("f", a);
};
const w2: (a: number, b: number) => void = f;
const arr: ((a: number, b: number) => void)[] = [w2];
const arr2: ((a: number, b: number) => void)[] = [f];
console.log("array:", arr[0] === f);
assert.deepStrictEqual(arr, arr2);
assert.notDeepStrictEqual(arr, [w2, f]);

// Through a record field (coerceToExpected direct), and a nested width lift.
type Slot = { cb: (a: number, b: number) => void };
const slot: Slot = { cb: f };
console.log("record:", slot.cb === f);
slot.cb(1, 2);

type Handlers = { calc: () => number; note: string };
const hs: Handlers = { calc: () => 7, note: "n" };
const lifted: { calc: (x: number) => number } = hs;
console.log("width-lift:", lifted.calc(99), lifted.calc === hs.calc);

// Through a closure with captured state: the widened view must drive the
// SAME captured cell, not a copy.
function make(tag: string): (a: number) => void {
  let n = 0;
  return (a: number): void => {
    n += a;
    console.log(tag, n);
  };
}
const c1 = make("A");
const cw: (a: number, b: number, c: number) => void = c1;
console.log("capture:", cw === c1);
c1(1);
cw(2, 0, 0);
c1(3);

// WIDENED (post-#89): a REFCOUNTED (string) trailing param, dropped rather
// than added — the axis native lanes got wrong before #89's D4 fix. Computed
// strings throughout (never literal — literals are interned/immortal here
// and would test nothing per this project's own leak-axis lesson).
function mk(i: number): string {
  return "pay" + String(i) + "load";
}
function base(a: number): void {
  console.log("base", a);
}
const wideStr: (a: number, b: string) => void = base;
console.log("string-drop identity BEFORE call:", wideStr === (base as unknown as typeof wideStr));
wideStr(1, mk(1));
console.log("string-drop identity AFTER call:", wideStr === (base as unknown as typeof wideStr));
function other(a: number): void {
  console.log("other", a);
}
console.log("string-drop NEGATIVE (must be false):", wideStr === (other as unknown as typeof wideStr));

function two(a: number): void {
  console.log("two", a);
}
const wideStr2: (a: number, b: string, c: string) => void = two;
console.log("two-string-drop identity:", wideStr2 === (two as unknown as typeof wideStr2));
wideStr2(2, mk(2), mk(3) + "x");
console.log("two-string-drop identity AFTER call:", wideStr2 === (two as unknown as typeof wideStr2));
console.log("done");
