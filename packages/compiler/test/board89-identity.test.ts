/* Board #89 — durable pins for funcCoerceAdapter's remaining identity-
 * transparency classes: (b) param/return coercion, (c) stranded/trap-only
 * wrappers, and the 85-D4 native refcounted-arity-drop trampoline. Board
 * #85 covers the PURE arity-drop subset (arityWiden) separately in
 * board85-arity-widen.test.ts; this file is everything funcCoerceAdapter
 * STILL mints a real wrapper for (identityOriginal makes the mint
 * identity-transparent without changing calling behavior at all).
 *
 * PROVENANCE, PER-CELL (89-D3's own directive: port with attribution).
 * P1/P2/P3/P4/P5/P6 are rev-89's own probes (fix-89-rev/probes/, files
 * rA/rB/rD/rH/rF/rK), reproduced here — NOT re-runs of the implementer's
 * b17/b18/b19/p2/p3/d1/d2, which were a DIFFERENT construction of the same
 * mechanisms and are not durable. P7/P8/P9 are rev-89's rI/rE/rG. P10 is
 * the implementer's own immortal-original cell (fix-89/probes/
 * immortal-orig.ts), which rev-89 recommended for promotion as-is. P11 is
 * rev-89's validator-axis.mjs, ported to a typed IrModule.
 *
 * EVERY expected-output string below was captured by running the SOURCE
 * PROGRAM against the Node oracle (node --experimental-transform-types)
 * during this round — never hand-derived — matching this project's
 * measure-before-transcribing discipline. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { validateModule } from "../src/ir/validate.js";
import { F64, type IrModule } from "../src/ir/nodes.js";
import { runWasm } from "./wasm-host.js";

const execFileAsync = promisify(execFile);

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-board89-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function buildNative(
  name: string,
  source: string,
  backend: "llvm" | "c",
  sanitize: boolean,
): Promise<string> {
  const entry = join(scratch, name);
  await writeFile(entry, source);
  const outPath = join(scratch, `${name}.${backend}.${sanitize ? "san" : "plain"}`);
  const res = await compile(entry, { outPath, outDir: scratch, backend, sanitize });
  if (!res.ok) throw new Error(`refused (${backend}, sanitize=${sanitize}): ${res.diagnostics[0]?.message}`);
  return res.binaryPath;
}

async function buildWasm(name: string, source: string): Promise<string> {
  const entry = join(scratch, name);
  await writeFile(entry, source);
  const outPath = join(scratch, `${name}.wasm`);
  const res = await compile(entry, { outPath, outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`refused (wasm): ${res.diagnostics[0]?.message}`);
  return res.binaryPath;
}

/** Runs `source` on all three lanes and asserts each matches `expected`
 * exactly — the standard shape for a pure-identity cell with no sanitize
 * requirement. */
async function expectAllLanes(name: string, source: string, expected: string): Promise<void> {
  for (const backend of ["llvm", "c"] as const) {
    const bin = await buildNative(`${name}-${backend}.ts`, source, backend, false);
    const { stdout } = await execFileAsync(bin);
    expect(stdout, `${name} (${backend})`).toBe(expected);
  }
  const wasmBin = await buildWasm(`${name}-wasm.ts`, source);
  const run = await runWasm(wasmBin);
  expect(run.stdout, `${name} (wasm)`).toBe(expected);
  expect(run.exitCode, `${name} (wasm) exit code`).toBe(0);
}

/* ══════════════════════════════════════════════════════════════════════
 * MUST — P1-P6: one per distinct mechanism this unit fixes. A regression
 * in any of these is a SILENT wrong answer (identity), not a loud
 * failure — the class of bug this whole unit exists to close.
 * ══════════════════════════════════════════════════════════════════════ */

/* P1 — param coercion + return coercion (funcCoerceAdapter's headline
 * disposition), all three lanes. Reads identity BEFORE the wrapper is
 * ever called, BETWEEN two calls, and AFTER — proving no lane caches or
 * mutates identity state at call time — plus operand symmetry, !== as
 * the exact complement of ===, and a different-function negative control
 * so a blanket "everything compares equal" bug cannot pass silently. */
const P1_SOURCE = `
type Handler = { handle(x: string | number): void };
function stringOnly(x: string): void {
  console.log("  called stringOnly:", x);
}
const h: Handler = { handle: stringOnly };

console.log("param-coerce id BEFORE call:", h.handle === stringOnly);
h.handle("alpha");
console.log("param-coerce id AFTER call:", h.handle === stringOnly);
h.handle("beta");
console.log("param-coerce id AFTER 2 calls:", h.handle === stringOnly);
function otherString(x: string): void {
  console.log("  called otherString:", x);
}
console.log("param-coerce NEGATIVE (must be false):", h.handle === otherString);

type Producer = () => string | undefined;
function makeStr(): string {
  return "produced";
}
const make: Producer = makeStr;
console.log("return-coerce id BEFORE call:", make === makeStr);
console.log("  value:", String(make()));
console.log("return-coerce id AFTER call:", make === makeStr);
console.log("return-coerce NEGATIVE (must be false):", make === (otherString as unknown as Producer));

console.log("symmetry (orig===wrapper):", stringOnly === h.handle);
console.log("complement (!== must be false):", h.handle !== stringOnly);
`;
const P1_EXPECTED =
  "param-coerce id BEFORE call: true\n" +
  "  called stringOnly: alpha\n" +
  "param-coerce id AFTER call: true\n" +
  "  called stringOnly: beta\n" +
  "param-coerce id AFTER 2 calls: true\n" +
  "param-coerce NEGATIVE (must be false): false\n" +
  "return-coerce id BEFORE call: true\n" +
  "  value: produced\n" +
  "return-coerce id AFTER call: true\n" +
  "return-coerce NEGATIVE (must be false): false\n" +
  "symmetry (orig===wrapper): true\n" +
  "complement (!== must be false): false\n";

test("board #89 P1: param + return coercion identity, before/between/after calls, symmetry, complement, negative control", async () => {
  await expectAllLanes("p1-coerce", P1_SOURCE, P1_EXPECTED);
});

/* P2 — stranded/trap-only wrapper identity. Deliberately NEVER called (a
 * stranded wrapper's whole point is that calling it throws — b18b's own
 * class — so this cell stays call-free to keep testing pure identity).
 * Includes TWO separate stranded wrappers over the SAME original: both
 * are distinct minted values in the compiled lanes but must compare
 * equal to each other AND to the original, exactly as they would in
 * Node (where neither one is a new value at all). */
const P2_SOURCE = `
class Shape {
  area(): number {
    return 1;
  }
}
class Square extends Shape {
  side(): number {
    return 2;
  }
}
type Sink = { take(s: Shape): void };
function needsSquare(s: Square): void {
  console.log("  needsSquare", s.side());
}
const sink: Sink = { take: needsSquare };

console.log("strand id:", sink.take === needsSquare);
console.log("strand symmetry:", needsSquare === sink.take);
console.log("strand complement (must be false):", sink.take !== needsSquare);

function otherSquare(s: Square): void {
  console.log("  otherSquare", s.side());
}
console.log("strand NEGATIVE (must be false):", sink.take === otherSquare);

const sink2: Sink = { take: needsSquare };
console.log("two strands, same original:", sink.take === sink2.take);
console.log("second strand vs original:", sink2.take === needsSquare);
`;
const P2_EXPECTED =
  "strand id: true\n" +
  "strand symmetry: true\n" +
  "strand complement (must be false): false\n" +
  "strand NEGATIVE (must be false): false\n" +
  "two strands, same original: true\n" +
  "second strand vs original: true\n";

test("board #89 P2: stranded/trap-only wrapper identity, incl. two wrappers over one original", async () => {
  await expectAllLanes("p2-strand", P2_SOURCE, P2_EXPECTED);
});

/* P3 — EventEmitter off()/listenerCount() in ALL THREE directions
 * (remove-by-original, remove-by-same-wrapper, remove-by-fresh-wrapper).
 * Highest value per line in the whole unit: direction 2 already passed
 * at base on bare pointer equality (the stored entry and the removal
 * argument are the SAME wrapper reference), so a one-direction pin would
 * have looked green while directions 1 and 3 were both silently wrong on
 * both native lanes (listenerCount-by-original read 0; the listener was
 * never removed and kept firing). Covers scr_emitter_off AND
 * scr_emitter_listener_count_fn together. [rev-89, A3]
 *
 * PROBE-SHAPE CAVEAT (rev-89's own note, carried verbatim — required):
 * this cell exercises an ARITY-DROP wrapper only (the trailing dropped
 * param is REFCOUNTED — a string — so on the native lanes this is
 * precisely the 85-D4 trampoline that populates trueOrig, and on wasm it
 * is the arityWiden marker; same identity plumbing, reached through a
 * shape the tier accepts). A CONVERSION-BEARING wrapper (param/return
 * coercion, funcCoerceAdapter's OWN headline disposition) registered
 * directly on an EventEmitter listener is NOT currently expressible in
 * tier: the event-name argument-type fence rejects a union-typed event
 * parameter program-wide (SC2020, "the event 'X' with conflicting
 * argument types") before the off/countFn machinery is ever reached —
 * rev-89's own two earlier probe versions hit exactly this fence.
 * EXTEND THIS CELL if that tier boundary ever lifts. */
const P3_SOURCE = `
import { EventEmitter } from "node:events";

type L = (a: number, b: string) => void;
function shortHandler(a: number): void {
  console.log("  handler saw:", a);
}
function otherHandler(a: number): void {
  console.log("  other saw:", a);
}
const tail = "tail-" + String(7);

const ee1 = new EventEmitter();
const w1: L = shortHandler;
ee1.on("d1", w1);
console.log("d1 count after on:", ee1.listenerCount("d1"));
console.log("d1 countFn by wrapper:", ee1.listenerCount("d1", w1));
console.log("d1 countFn by original:", ee1.listenerCount("d1", shortHandler as unknown as L));
ee1.emit("d1", 1, tail);
ee1.off("d1", shortHandler as unknown as L);
console.log("d1 count after off-by-ORIGINAL:", ee1.listenerCount("d1"));
ee1.emit("d1", 2, tail);
console.log("d1 done");

const ee2 = new EventEmitter();
const w2: L = shortHandler;
ee2.on("d2", w2);
console.log("d2 count after on:", ee2.listenerCount("d2"));
ee2.emit("d2", 3, tail);
ee2.off("d2", w2);
console.log("d2 count after off-by-WRAPPER:", ee2.listenerCount("d2"));
ee2.emit("d2", 4, tail);
console.log("d2 done");

const ee3 = new EventEmitter();
ee3.on("d3", shortHandler as unknown as L);
console.log("d3 count after on:", ee3.listenerCount("d3"));
const w3: L = shortHandler;
ee3.off("d3", w3);
console.log("d3 count after off-by-FRESH-WRAPPER:", ee3.listenerCount("d3"));
console.log("d3 done");

const ee4 = new EventEmitter();
ee4.on("d4", shortHandler as unknown as L);
ee4.off("d4", otherHandler as unknown as L);
console.log("NEGATIVE count (must still be 1):", ee4.listenerCount("d4"));
`;
const P3_EXPECTED =
  "d1 count after on: 1\n" +
  "d1 countFn by wrapper: 1\n" +
  "d1 countFn by original: 1\n" +
  "  handler saw: 1\n" +
  "d1 count after off-by-ORIGINAL: 0\n" +
  "d1 done\n" +
  "d2 count after on: 1\n" +
  "  handler saw: 3\n" +
  "d2 count after off-by-WRAPPER: 0\n" +
  "d2 done\n" +
  "d3 count after on: 1\n" +
  "d3 count after off-by-FRESH-WRAPPER: 0\n" +
  "d3 done\n" +
  "NEGATIVE count (must still be 1): 1\n";

test("board #89 P3: EventEmitter off()/listenerCount(), all three removal directions", async () => {
  await expectAllLanes("p3-ee", P3_SOURCE, P3_EXPECTED);
});

/* P4 — 85-D4 absorbing trampoline over MULTI-refcounted-param drops:
 * tails of 1, 2, 3, and a MIXED refcounted/scalar/refcounted tail. The
 * whole D4 story is that the removed wrapper's params WERE the release
 * path and callValue transfers ownership per the WIDE signature, so the
 * number of dropped OWNED params is the axis that decides how many
 * releases the trampoline owes — the implementer's own cells only ever
 * dropped ONE. The mixed tail is what a position-based (rather than
 * kind-based) release gets wrong. Native lanes only: wasm's marker
 * family was already correct here via a completely different (GC)
 * mechanism, unaffected by this axis. All values COMPUTED (never
 * literal — literals are interned/immortal here and would test
 * nothing). */
const P4_SOURCE = `
function mk(tag: string, i: number): string {
  return tag + "-" + String(i) + "-payload";
}
let acc = 0;

function one(a: number): void { acc += a; }
const wide1: (a: number, b: string) => void = one;
console.log("drop1 identity:", wide1 === (one as unknown as typeof wide1));
wide1(1, mk("one", 1));

function two(a: number): void { acc += a * 2; }
const wide2: (a: number, b: string, c: string) => void = two;
console.log("drop2 identity:", wide2 === (two as unknown as typeof wide2));
wide2(2, mk("two", 1), mk("two", 2));

function three(a: number): void { acc += a * 3; }
const wide3: (a: number, b: string, c: string, d: string) => void = three;
console.log("drop3 identity:", wide3 === (three as unknown as typeof wide3));
wide3(3, mk("three", 1), mk("three", 2), mk("three", 3));

function mixed(a: number): void { acc += a * 5; }
const wideM: (a: number, b: string, c: number, d: string) => void = mixed;
console.log("dropMixed identity:", wideM === (mixed as unknown as typeof wideM));
wideM(4, mk("mix", 1), 99, mk("mix", 2));

for (let i = 0; i < 50; i++) {
  wide1(i, mk("loop1", i));
  wide2(i, mk("loop2", i), mk("loop2b", i));
  wide3(i, mk("loop3", i), mk("loop3b", i), mk("loop3c", i));
  wideM(i, mk("loopM", i), i, mk("loopMb", i));
}
console.log("acc", acc);
`;
const P4_EXPECTED =
  "drop1 identity: true\ndrop2 identity: true\ndrop3 identity: true\ndropMixed identity: true\nacc 13509\n";

describe("board #89 P4: 85-D4 trampoline, multi-refcounted-param drops (1/2/3/mixed tails)", () => {
  for (const backend of ["llvm", "c"] as const) {
    test(`${backend}: identity + correct release across all four tail shapes`, async () => {
      const bin = await buildNative(`p4-multidrop-${backend}.ts`, P4_SOURCE, backend, false);
      const { stdout } = await execFileAsync(bin);
      expect(stdout).toBe(P4_EXPECTED);
    });
  }
});

/* P5 — depth-THREE mixed chain: a pure arity drop, then a param
 * coercion over the already-wrapped value, then another arity drop on
 * top of THAT. This project's own lesson is that depth-1 correctness
 * says nothing about depth 2, and depth 2 says nothing about depth 3
 * (the #85 F1 class — "every headline observable that passed at depth 1
 * failed at depth 2"); the implementer's own d1/d2 stop at depth 2. */
const P5_SOURCE = `
function base(a: string): void {
  console.log("  base:", a);
}
const h1: (a: string, b: number) => void = base;
type Wide2 = { m(a: string | number, b: number): void };
const o2: Wide2 = { m: h1 };
const h3: (a: string | number, b: number, c: boolean) => void = o2.m;

console.log("hop1 === base:", h1 === base);
console.log("hop2 === base:", o2.m === base);
console.log("hop3 === base:", h3 === base);
console.log("hop3 === hop1:", (h3 as unknown as (a: string) => void) === (h1 as unknown as (a: string) => void));
console.log("hop3 === hop2:", (h3 as unknown as (a: string) => void) === (o2.m as unknown as (a: string) => void));

h1("one", 1);
o2.m("two", 2);
h3("three", 3, true);

function other(a: string): void {
  console.log("  other:", a);
}
const oh1: (a: string, b: number) => void = other;
console.log("depth3 NEGATIVE (must be false):", h3 === (oh1 as unknown as typeof h3));
`;
const P5_EXPECTED =
  "hop1 === base: true\n" +
  "hop2 === base: true\n" +
  "hop3 === base: true\n" +
  "hop3 === hop1: true\n" +
  "hop3 === hop2: true\n" +
  "  base: one\n" +
  "  base: two\n" +
  "  base: three\n" +
  "depth3 NEGATIVE (must be false): false\n";

test("board #89 P5: depth-3 mixed chain (arity drop -> param coercion -> arity drop)", async () => {
  await expectAllLanes("p5-depth3", P5_SOURCE, P5_EXPECTED);
});

/* P6 — the LEAK cell under the SANITIZED lane, with COMPUTED (never
 * literal) refcounted values through each mechanism. The only cell that
 * can catch a trueOrig ownership regression; literals are interned/
 * immortal here and would mask it entirely. [rev-89, A3, carried
 * verbatim] Four mechanisms x 100 computed-value iterations each: (1)
 * param coercion — fresh wrapper over a fresh closure; (2) stranded —
 * fresh wrapper, never called (its trueOrig must still be released at
 * teardown); (3) D4 single drop — one refcounted trailing param; (4) D4
 * double drop — two refcounted trailing params (the sibling the
 * implementer's own leak probe never varied). Native lanes only
 * (sanitize is a native-lane flag). A leak here surfaces as a nonzero
 * exit under ASan, which execFileAsync turns into a rejected promise —
 * this test fails automatically on a leak, no separate assertion
 * needed. */
const P6_SOURCE = `
type Handler = { handle(x: string | number): void };
class Shape { area(): number { return 1; } }
class Square extends Shape { side(): number { return 2; } }
type Sink = { take(s: Shape): void };

let acc = 0;

for (let i = 0; i < 100; i++) {
  const tag = "coerce-" + String(i) + "-tail";
  const only = (x: string): void => { acc += x.length + tag.length; };
  const h: Handler = { handle: only };
  h.handle("hi");
}

for (let i = 0; i < 100; i++) {
  const tag = "strand-" + String(i) + "-tail";
  const sq = (s: Square): void => { acc += s.side() + tag.length; };
  const sink: Sink = { take: sq };
  if (sink.take === (sq as unknown as (s: Shape) => void)) acc += 1;
}

for (let i = 0; i < 100; i++) {
  const dropped = "drop1-" + String(i) + "-payload";
  const narrow = (n: number): void => { acc += n; };
  const wide: (n: number, extra: string) => void = narrow;
  wide(i, dropped);
}

for (let i = 0; i < 100; i++) {
  const d1 = "drop2a-" + String(i) + "-payload";
  const d2 = "drop2b-" + String(i) + "-payload";
  const narrow = (n: number): void => { acc += n * 2; };
  const wide: (n: number, a: string, b: string) => void = narrow;
  wide(i, d1, d2);
}

console.log("done", acc);
`;
const P6_EXPECTED = "done 16540\n";

describe("board #89 P6: LEAK axis, sanitized (ASan), computed values, 4 mechanisms x 100 iterations", () => {
  for (const backend of ["llvm", "c"] as const) {
    test(`${backend}, sanitized: no leak across param-coercion/stranded/D4-single/D4-double`, async () => {
      const bin = await buildNative(`p6-leak-${backend}.ts`, P6_SOURCE, backend, true);
      const { stdout } = await execFileAsync(bin);
      expect(stdout).toBe(P6_EXPECTED);
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * SHOULD — P7-P10: strong regression coverage, one tier below MUST.
 * ══════════════════════════════════════════════════════════════════════ */

/* P7 — cascade-of-TEN distinct env types (ten distinct impl functions,
 * so no interning collapses them) stresses the wasm cascade's LENGTH —
 * a cost the design explicitly waved off as "module-size, not
 * correctness" and the only cell that measures it. Every wrapper must
 * unwrap to its OWN original, including the LAST registered (deepest in
 * the chain), and no wrapper may match a NEIGHBOUR's original — a
 * cascade returning the first structural match instead of the exact one
 * fails only here. */
const P7_SOURCE = `
type H1 = { m(x: string | number): void };
function f0(x: string): void { console.log("  f0", x); }
function f1(x: string): void { console.log("  f1", x); }
function f2(x: string): void { console.log("  f2", x); }
function f3(x: string): void { console.log("  f3", x); }
function f4(x: string): void { console.log("  f4", x); }
function f5(x: string): void { console.log("  f5", x); }
function f6(x: string): void { console.log("  f6", x); }
function f7(x: string): void { console.log("  f7", x); }
function f8(x: string): void { console.log("  f8", x); }
function f9(x: string): void { console.log("  f9", x); }
const w0: H1 = { m: f0 };
const w1: H1 = { m: f1 };
const w2: H1 = { m: f2 };
const w3: H1 = { m: f3 };
const w4: H1 = { m: f4 };
const w5: H1 = { m: f5 };
const w6: H1 = { m: f6 };
const w7: H1 = { m: f7 };
const w8: H1 = { m: f8 };
const w9: H1 = { m: f9 };
console.log("w0:", w0.m === f0);
console.log("w1:", w1.m === f1);
console.log("w2:", w2.m === f2);
console.log("w3:", w3.m === f3);
console.log("w4:", w4.m === f4);
console.log("w5:", w5.m === f5);
console.log("w6:", w6.m === f6);
console.log("w7:", w7.m === f7);
console.log("w8:", w8.m === f8);
console.log("w9:", w9.m === f9);
console.log("w0 vs f9 (false):", w0.m === f9);
console.log("w9 vs f0 (false):", w9.m === f0);
console.log("w5 vs f4 (false):", w5.m === f4);
console.log("w4 vs f5 (false):", w4.m === f5);
w0.m("a"); w9.m("b"); w5.m("c");
`;
const P7_EXPECTED =
  "w0: true\nw1: true\nw2: true\nw3: true\nw4: true\nw5: true\nw6: true\nw7: true\nw8: true\nw9: true\n" +
  "w0 vs f9 (false): false\nw9 vs f0 (false): false\nw5 vs f4 (false): false\nw4 vs f5 (false): false\n" +
  "  f0 a\n  f9 b\n  f5 c\n";

test("board #89 P7: cascade-of-10 distinct env types, neighbour discrimination", async () => {
  await expectAllLanes("p7-cascade10", P7_SOURCE, P7_EXPECTED);
});

/* P8 — assert.strictEqual/notStrictEqual/deepStrictEqual over wrapped
 * functions, INCLUDING containers (arrays, nested arrays, records,
 * records-in-arrays). Pins the design's own "deepEqHelper's func arm IS
 * the same bin === node the unit patched, so containers come along for
 * free" reduction claim, which was asserted but never executed before
 * rev-89's gate. */
const P8_SOURCE = `
import { deepStrictEqual, strictEqual, notStrictEqual } from "node:assert";

type L = (x: string | number) => void;
type Handler = { handle(x: string | number): void };
function stringOnly(x: string): void { console.log("  called:", x); }
function otherString(x: string): void { console.log("  other:", x); }
const h: Handler = { handle: stringOnly };
const bare: L = stringOnly as unknown as L;
const otherBare: L = otherString as unknown as L;

strictEqual(h.handle, bare);
console.log("strictEqual bare: ok");
notStrictEqual(h.handle, otherBare);
console.log("notStrictEqual bare: ok");

const arrW: L[] = [h.handle];
const arrO: L[] = [bare];
deepStrictEqual(arrW, arrO);
console.log("deepStrictEqual array depth1: ok");

const nestW: L[][] = [[h.handle]];
const nestO: L[][] = [[bare]];
deepStrictEqual(nestW, nestO);
console.log("deepStrictEqual array depth2: ok");

const recW: { fn: L } = { fn: h.handle };
const recO: { fn: L } = { fn: bare };
deepStrictEqual(recW, recO);
console.log("deepStrictEqual record: ok");

const mixW: { fn: L }[] = [{ fn: h.handle }];
const mixO: { fn: L }[] = [{ fn: bare }];
deepStrictEqual(mixW, mixO);
console.log("deepStrictEqual record-in-array: ok");

let negativeHeld = false;
try {
  const arrN: L[] = [otherBare];
  deepStrictEqual(arrW, arrN);
} catch {
  negativeHeld = true;
}
console.log("deepStrictEqual NEGATIVE held (must be true):", negativeHeld);
`;
const P8_EXPECTED =
  "strictEqual bare: ok\n" +
  "notStrictEqual bare: ok\n" +
  "deepStrictEqual array depth1: ok\n" +
  "deepStrictEqual array depth2: ok\n" +
  "deepStrictEqual record: ok\n" +
  "deepStrictEqual record-in-array: ok\n" +
  "deepStrictEqual NEGATIVE held (must be true): true\n";

test("board #89 P8: assert strict/deepStrictEqual over arrays, nested arrays, records, records-in-arrays", async () => {
  await expectAllLanes("p8-assert", P8_SOURCE, P8_EXPECTED);
});

/* P9 — Object.is over wrapped functions (both operand orders), PLUS the
 * SAME function wrapped at TWO DIFFERENT call sites (registration is
 * claimed idempotent, deduped by env type — if the dedupe is wrong, one
 * of the two wrappers fails to unwrap), PLUS a third site over a
 * DIFFERENT original to confirm the dedupe does not over-merge distinct
 * originals sharing a wrapper signature. Pins the lower-calls.ts
 * "Object.is reduces to the reference kinds by pointer identity"
 * reduction claim as its own entry point, separate from bin ===. */
const P9_SOURCE = `
type Handler = { handle(x: string | number): void };
function stringOnly(x: string): void { console.log("  called:", x); }
function otherString(x: string): void { console.log("  other:", x); }

const site1: Handler = { handle: stringOnly };
const site2: Handler = { handle: stringOnly };

console.log("Object.is(wrapper, original):", Object.is(site1.handle, stringOnly));
console.log("Object.is(original, wrapper):", Object.is(stringOnly, site1.handle));
console.log("Object.is NEGATIVE (must be false):", Object.is(site1.handle, otherString));

console.log("two sites, ===:", site1.handle === site2.handle);
console.log("two sites, Object.is:", Object.is(site1.handle, site2.handle));
console.log("site1 === original:", site1.handle === stringOnly);
console.log("site2 === original:", site2.handle === stringOnly);

site1.handle("from-site1");
site2.handle("from-site2");

const site3: Handler = { handle: otherString };
console.log("site3 === its own original:", site3.handle === otherString);
console.log("site3 vs site1 (must be false):", site3.handle === site1.handle);
`;
const P9_EXPECTED =
  "Object.is(wrapper, original): true\n" +
  "Object.is(original, wrapper): true\n" +
  "Object.is NEGATIVE (must be false): false\n" +
  "two sites, ===: true\n" +
  "two sites, Object.is: true\n" +
  "site1 === original: true\n" +
  "site2 === original: true\n" +
  "  called: from-site1\n" +
  "  called: from-site2\n" +
  "site3 === its own original: true\n" +
  "site3 vs site1 (must be false): false\n";

test("board #89 P9: Object.is both orders, same function wrapped at two sites, third site over a different original", async () => {
  await expectAllLanes("p9-objectis", P9_SOURCE, P9_EXPECTED);
});

/* P10 — the wrapped ORIGINAL is an IMMORTAL, zero-capture, top-level
 * declared function (rc == SIZE_MAX in C/LLVM). Exercises the NULL
 * initialization in BOTH hand-rolled struct mirrors (emission/
 * emitter.ts's anonymous struct, llvm/emitter.ts's global initializer)
 * — precisely the shape whose missing field caused this unit's own bug
 * 2 SIGSEGV during the build round. Looped so any accidental rc-touch on
 * an immortal (which should never happen — scr_closure_retain/_release
 * both skip immortals by their own rc!=SIZE_MAX guard) would surface as
 * either a crash or, under the sanitized cell below, a leak report. */
const P10_SOURCE = `
function topLevel(x: string): void { /* no-op; identity + count matter here */ }
type Handler = { handle(x: string | number): void };
let n = 0;
for (let i = 0; i < 50; i++) {
  const h: Handler = { handle: topLevel };
  if (h.handle === topLevel) n++;
  h.handle("hi");
}
console.log("matches", n, "of 50");
`;
const P10_EXPECTED = "matches 50 of 50\n";

test("board #89 P10: immortal-original — wrapper's true original is a top-level interned closure", async () => {
  await expectAllLanes("p10-immortal", P10_SOURCE, P10_EXPECTED);
});

describe("board #89 P10b: immortal-original, sanitized — trueOrig retain/release on an immortal is a harmless no-op", () => {
  for (const backend of ["llvm", "c"] as const) {
    test(`${backend}, sanitized: no leak, no crash`, async () => {
      const bin = await buildNative(`p10b-immortal-san-${backend}.ts`, P10_SOURCE, backend, true);
      const { stdout } = await execFileAsync(bin);
      expect(stdout).toBe(P10_EXPECTED);
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * BUILDER-LEVEL — P11: the validator guard on identityOriginal. The
 * lowering can only ever produce the VALID shape (funcCoerceAdapter
 * always sets "f.0" on a single func-typed capture), so both refusal
 * branches are UNREACHABLE from real source — the force-emit-what-the-
 * lowering-cannot-reach pattern: build the IR by hand and validate it
 * directly, the same way this file's siblings (ir.test.ts) already do.
 * ══════════════════════════════════════════════════════════════════════ */

const P11_LOC = { file: "t.ts", start: 0, end: 0 };
const P11_FN_TYPE = { kind: "func" as const, params: [F64], ret: { kind: "void" as const } };

function p11ModuleWith(identityOriginal: string | undefined): IrModule {
  return {
    irVersion: 3,
    sourceFile: "t.ts",
    entry: "__main",
    functions: [
      {
        name: "impl",
        params: [],
        returnType: { kind: "void" },
        captures: [
          { localId: "f.0", name: "f", type: P11_FN_TYPE },
          { localId: "n.0", name: "n", type: F64 },
        ],
        locals: [
          { id: "f.0", name: "f", type: P11_FN_TYPE, mutable: false, boxed: true },
          { id: "n.0", name: "n", type: F64, mutable: false, boxed: true },
        ],
        body: [],
        loc: P11_LOC,
      },
      {
        name: "__main",
        params: [],
        returnType: { kind: "void" },
        locals: [
          { id: "f.0", name: "f", type: P11_FN_TYPE, mutable: false, boxed: true },
          { id: "n.0", name: "n", type: F64, mutable: false, boxed: true },
        ],
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "closure",
              fnName: "impl",
              captures: ["f.0", "n.0"],
              ...(identityOriginal === undefined ? {} : { identityOriginal }),
              type: P11_FN_TYPE,
              loc: P11_LOC,
            },
            loc: P11_LOC,
          },
        ],
        loc: P11_LOC,
      },
    ],
  };
}

function p11IdentityErrors(identityOriginal: string | undefined): string[] {
  return validateModule(p11ModuleWith(identityOriginal))
    .map((e) => e.message)
    .filter((m) => m.includes("identityOriginal"));
}

test("board #89 P11a (control): identityOriginal naming a func-typed capture validates clean", () => {
  expect(p11IdentityErrors("f.0")).toEqual([]);
});

test("board #89 P11b: identityOriginal naming a non-func-typed capture refuses", () => {
  expect(p11IdentityErrors("n.0")).toEqual([expect.stringContaining("is not func-typed")]);
});

test("board #89 P11c: identityOriginal naming something that is not a capture at all refuses", () => {
  expect(p11IdentityErrors("zzz.0")).toEqual([expect.stringContaining("is not one of its own captures")]);
});

test("board #89 P11d (control): identityOriginal absent validates clean", () => {
  expect(p11IdentityErrors(undefined)).toEqual([]);
});
