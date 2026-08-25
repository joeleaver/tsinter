/* Board #85 — durable pins for the PURE ARITY-DROP identity fix. Joe's
 * ruling (2026-08-24): a pure arity-drop coercion (fewer trailing params,
 * every SHARED param/return type typeEquals-identical — pureArityDrop in
 * ir/nodes.ts) is an INVOCATION rule in JS, not a value-shape coercion —
 * Node mints no new function object for it, so the compiler must not
 * either. widthLiftPlan/coerceToExpected now emit a dedicated `arityWiden`
 * IR node for this subset instead of routing through funcCoerceAdapter's
 * wrapper-minting `%fn.adapt.N` path.
 *
 * Per-backend mechanism (full grounding: the lowerer's pureArityDrop doc,
 * ir/nodes.ts's arityWiden doc, and each backend's own "arityWiden" case):
 * - C/LLVM: every func value is ONE uniformly-typed opaque representation
 *   (ScrClosure* / ptr) whose callable code is cast to the desired
 *   signature FRESH at each call site — a pure arity-drop widening is a
 *   literal same-pointer relabel, zero runtime cost.
 * - wasm: WasmGC closure struct/func-ref pairs are exact-arity-typed (no
 *   subtype relation across arities), so a thin marker wrapper is
 *   unavoidable — this generalizes board #75's listener-snapshot adapter
 *   family (listenerAdapterBase/listenerAdapterFn/universalUnwrapFn),
 *   making the wrapper fully identity-transparent at every site already
 *   consulting the universal unwrap (bin ===/!==, assert.refEqFn, and —
 *   via %assert.deq.N's own plain bin "===" — assert.deepStrictEqual over
 *   function-element arrays).
 *
 * Three groups of pins:
 *  1. The minimal cross-lane repro (rev-p3's b9/b11 shape), PLUS the
 *     mixed-SysV-register-class ABI requirement (board #85 gate 1): the
 *     widened call's UNREAD trailing arguments deliberately span integer,
 *     SSE/double, and pointer/string register classes, on BOTH native
 *     lanes under BOTH plain and SANITIZED (ASan) flags — the real
 *     generated-code twin of gate1/abi-probe.c's standalone measurement.
 *  2. 2557-width-field-lifts.ts's own two arity-drop shapes, replicated
 *     here (corpus texts are immutable — this is the identity observation
 *     the corpus program itself never makes), covering BOTH producer
 *     paths: coerceToExpected's direct call (2253-style) and
 *     widthLiftPlan's nested record-width lift (2557-style, one level
 *     AND two levels deep).
 *  3. A scope-boundary check on the emitted IR: the non-arity-drop
 *     dispositions (param coercion, return coercion) still route through
 *     funcCoerceAdapter's `%fn.adapt.N` — never arityWiden — confirming
 *     the fix does not over-apply. Board #89 tracks their own residual
 *     identity loss; not fixed here. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const execFileAsync = promisify(execFile);

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-board85-"));
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

/* ── group 1: identity + mixed-register-class ABI safety ────────────── *
 *
 * 85-D4 SPLIT, and why this group is now THREE shapes, not one: the
 * plain relabel (C/LLVM) only fires when EVERY dropped trailing param
 * is a plain SCALAR (f64/bool/procStream — the ONLY non-refcounted IR
 * kinds) — in this system EVERY heap type (string included) is
 * refcounted, so there is no such thing as a "pointer register class"
 * dropped argument on the relabel path anymore: any pointer-class drop
 * routes to the absorbing trampoline instead (85-D4's own fix). The
 * ORIGINAL version of this group's single IDENTITY_SOURCE had a
 * trailing `string` param — meaning it was ALREADY exercising the
 * trampoline, not the relabel, and its "identity preserved" claim was
 * consequently WRONG the moment the trampoline landed (caught by this
 * group's own re-run, not asserted blindly — see FINDINGS.txt). Split
 * into: (1) RELABEL_SOURCE — genuinely all-scalar trailing drops
 * (int/SSE register classes only, the only classes reachable on this
 * path), identity PRESERVED; (2)/(3) TRAMPOLINE_*_SOURCE — refcounted
 * trailing drops, identity LOST (matches this lane's own pre-#85
 * behavior exactly — board #89's residual, not a regression), audit-
 * clean under sanitize:true. LESSON recorded here because it bit this
 * pin file directly: string LITERALS are compile-time interned/
 * immortal in this compiler (retain/release are no-ops on them), so a
 * refcount-sensitive pin that only ever passes literals can pass clean
 * while genuinely leaking — TRAMPOLINE_STRING_SOURCE below deliberately
 * COMPUTES its trailing string (Math.random()-derived) rather than
 * using a literal, precisely to avoid silently testing nothing (this
 * is exactly what board #85's own gate-round leak escaped through
 * once already). */

const RELABEL_SOURCE = `
function real(a: string, b: number): void {
  console.log("real", a, b);
}
type Wide = (a: string, b: number, c: boolean, d: number, e: boolean) => void;
const w: Wide = real;
// Scalars are never refcounted, so literal-vs-computed makes no
// difference to THIS path's correctness (nothing is ever retained/
// released for a dropped scalar either way) — unlike the trampoline-
// path pins below, where it is load-bearing. Plain literals here.
w("hello", 42, true, 3.14159, false);
console.log("identity", w === real);
`;
const RELABEL_EXPECTED = "real hello 42\nidentity true\n";

describe("board #85: pure relabel path — all-scalar trailing drops (int/SSE register classes), identity preserved", () => {
  for (const backend of ["llvm", "c"] as const) {
    for (const sanitize of [false, true]) {
      test(`${backend}, ${sanitize ? "sanitized (ASan)" : "plain"}: identity preserved, extra scalar trailing args ignored safely`, async () => {
        const bin = await buildNative(`relabel-${backend}-${sanitize}.ts`, RELABEL_SOURCE, backend, sanitize);
        const { stdout } = await execFileAsync(bin);
        expect(stdout).toBe(RELABEL_EXPECTED);
      });
    }
  }

  test("wasm: identity preserved, extra scalar trailing args ignored safely", async () => {
    const bin = await buildWasm("relabel-wasm.ts", RELABEL_SOURCE);
    const run = await runWasm(bin);
    expect(run.stdout).toBe(RELABEL_EXPECTED);
    expect(run.exitCode).toBe(0);
  });
});

const TRAMPOLINE_UNION_SOURCE = `
type Callback = (x?: string) => void;
let seen = "";
const cb: Callback = function () { seen += "ran;"; };
cb("ignored");
cb();
console.log(seen);
`;
const TRAMPOLINE_UNION_EXPECTED = "ran;ran;\n";

const TRAMPOLINE_STRING_SOURCE = `
function real(a: string): void { console.log("real", a); }
type Wide = (a: string, extra: string) => void;
const w: Wide = real;
const computed: string = "unread-" + Math.random().toString().slice(0, 1);
w("hello", computed);
`;
const TRAMPOLINE_STRING_EXPECTED = "real hello\n";

describe("board #85: absorbing trampoline path — refcounted trailing drops, audit-clean, identity lost (board #89, matches base)", () => {
  for (const backend of ["llvm", "c"] as const) {
    test(`${backend}, sanitized (ASan): union/optional trailing param (2253's own Callback shape) — no leak`, async () => {
      const bin = await buildNative(`trampoline-union-${backend}.ts`, TRAMPOLINE_UNION_SOURCE, backend, true);
      const { stdout } = await execFileAsync(bin);
      expect(stdout).toBe(TRAMPOLINE_UNION_EXPECTED);
    });
    test(`${backend}, sanitized (ASan): computed (non-literal) heap string trailing param — no leak`, async () => {
      const bin = await buildNative(`trampoline-string-${backend}.ts`, TRAMPOLINE_STRING_SOURCE, backend, true);
      const { stdout } = await execFileAsync(bin);
      expect(stdout).toBe(TRAMPOLINE_STRING_EXPECTED);
    });
  }
});

test("board #85: 2253-union-coercions.ts itself, sanitized (ASan) — no leak (the shape that surfaced 85-D4)", async () => {
  const repoRoot = join(import.meta.dirname, "../../..");
  const source = await readFile(join(repoRoot, "tests/corpus/2253-union-coercions.ts"), "utf8");
  const bin = await buildNative("2253-sanitized.ts", source, "llvm", true);
  const { stdout } = await execFileAsync(bin);
  expect(stdout).toContain("ran;ran;");
});

/* ── group 2: 2557's own shapes, both producer paths ─────────────────── */

const RECORD_WIDTH_SOURCE = `
type Handlers = { f: () => number; name: string };
const hs: Handlers = { f: () => 7, name: "seven" };
const slot: { f: (x: number) => number } = hs;
console.log(slot.f(99), slot.f === hs.f);

type Outer = { inner: { calc: () => number; note: string }; count: number };
const outer: Outer = { inner: { calc: () => 6, note: "n" }, count: 2 };
const narrowed: { inner: { calc: (x: number) => number } } = outer;
console.log(narrowed.inner.calc(99), narrowed.inner.calc === outer.inner.calc);
`;
const RECORD_WIDTH_EXPECTED = "7 true\n6 true\n";

describe("board #85: 2557's own record-width-lift shapes (top-level + nested)", () => {
  for (const backend of ["llvm", "c"] as const) {
    test(`${backend}: identity survives record-field width lift, both depths`, async () => {
      const bin = await buildNative(`recwidth-${backend}.ts`, RECORD_WIDTH_SOURCE, backend, false);
      const { stdout } = await execFileAsync(bin);
      expect(stdout).toBe(RECORD_WIDTH_EXPECTED);
    });
  }
  test("wasm: identity survives record-field width lift, both depths", async () => {
    const bin = await buildWasm("recwidth-wasm.ts", RECORD_WIDTH_SOURCE);
    const run = await runWasm(bin);
    expect(run.stdout).toBe(RECORD_WIDTH_EXPECTED);
    expect(run.exitCode).toBe(0);
  });
});

/* ── group 2b: 2253's own coerceToExpected-direct shape ──────────────── */

const CALLBACK_ARITY_DROP_SOURCE = `
type Callback = (x?: string) => void;
let seen = "";
const cb: Callback = function () { seen += "ran;"; };
cb("ignored");
cb();
console.log(seen, cb === cb);
`;
const CALLBACK_ARITY_DROP_EXPECTED = "ran;ran; true\n";

test("board #85: 2253's own cb/Callback shape (coerceToExpected direct path) calls correctly", async () => {
  const bin = await buildNative("cb-aritydrop.ts", CALLBACK_ARITY_DROP_SOURCE, "llvm", false);
  const { stdout } = await execFileAsync(bin);
  expect(stdout).toBe(CALLBACK_ARITY_DROP_EXPECTED);
});

/* ── group 4: CHAINED widening (rev-85's F1 finding) — depth 2 AND 3,
 * every arm of the wasm loop, all three lanes ─────────────────────────
 *
 * narrow -> mid -> wide, each step its own genuine pureArityDrop (the
 * shape rev-85 found: base wasm answered the INTERMEDIATE marker for
 * wide===narrow/wide===mid, not the true original — single-pass unwrap,
 * sound only for depth 1). This ONE program's chain exercises BOTH
 * marker bases (Mid's and Wide's) as MATCH arms at different loop
 * depths, plus an unrelated plainA/plainB comparison AFTER the chain —
 * i.e. in a module where >=2 marker bases already exist — to exercise
 * the cascade's NO-MATCH passthrough with bases.length > 0 (not just
 * the trivially-always-covered zero-bases edge). Native lanes get this
 * as a REGRESSION pin (they were already correct — relabeling composes
 * for free); wasm is the one this unit's F1 fix changes. */
const CHAIN_SOURCE = `
function narrow(a: string): void { console.log("narrow", a); }
type Mid = (a: string, b: number) => void;
type Wide = (a: string, b: number, c: boolean) => void;
const mid: Mid = narrow;
const wide: Wide = mid;
mid("m", 1);
wide("w", 2, true);
console.log("mid===narrow", mid === narrow);
console.log("wide===narrow", wide === narrow);
console.log("wide===mid", wide === mid);

function plainA(): void { console.log("plainA"); }
function plainB(): void { console.log("plainB"); }
console.log("plainA===plainA", plainA === plainA);
console.log("plainA===plainB", plainA === plainB);
`;
const CHAIN_EXPECTED =
  "narrow m\nnarrow w\nmid===narrow true\nwide===narrow true\nwide===mid true\n" +
  "plainA===plainA true\nplainA===plainB false\n";

describe("board #85 F1: chained (depth-2/3) arity-drop identity, every loop arm", () => {
  for (const backend of ["llvm", "c"] as const) {
    test(`${backend}: depth-3 chain identity + no-match-with-bases (regression pin, was already correct)`, async () => {
      const bin = await buildNative(`chain-${backend}.ts`, CHAIN_SOURCE, backend, false);
      const { stdout } = await execFileAsync(bin);
      expect(stdout).toBe(CHAIN_EXPECTED);
    });
  }
  test("wasm: depth-3 chain identity + no-match-with-bases (rev-85's F1 fix)", async () => {
    const bin = await buildWasm("chain-wasm.ts", CHAIN_SOURCE);
    const run = await runWasm(bin);
    expect(run.stdout).toBe(CHAIN_EXPECTED);
    expect(run.exitCode).toBe(0);
  });
});

/* ── group 5: rest-fence coverage (rev-85's flagged gap) ─────────────── *
 * pureArityDrop's `src.rest !== true && dst.rest !== true` guard reads
 * defensively, but MEASURED (not assumed): a rest-carrying function used
 * as a VALUE on the SOURCE side refuses at requireExactArityValue
 * (lower-calls.ts, SC1090, "functions with rest parameters as values")
 * — fires on the function's OWN shape, independent of any destination
 * type. A rest-carrying func TYPE on the DESTINATION side refuses at
 * the type-mapping layer (SC2009, "its rest parameter ... has no
 * compiled calling convention yet") the moment it's used as a value
 * binding's type at all — independent of what's being assigned. BOTH
 * fire strictly BEFORE coerceToExpected or widthLiftPlan ever consult
 * pureArityDrop/funcCoerceAdapter, on EITHER lane. These two pins lock
 * in that upstream fencing so a future change to either upstream check
 * can't silently make pureArityDrop's own rest guard the only thing
 * standing between a rest-shaped pair and a miscompile — mutation-
 * checked (see FINDINGS.txt): removing pureArityDrop's rest checks
 * leaves BOTH these pins passing unchanged, confirming the guard is
 * currently redundant-but-correct, not load-bearing dead code masking a
 * live path. */
describe("board #85: rest-param shapes refuse identically regardless of pureArityDrop's own rest guard", () => {
  test("rest-carrying SOURCE used as a value refuses SC1090, base-identical", async () => {
    const entry = join(scratch, "rest-src.ts");
    await writeFile(
      entry,
      `
type Handler = (a: string, b: number, c: number) => void;
function withRest(a: string, ...nums: number[]): void { console.log(a, nums.length); }
const h: Handler = withRest;
h("x", 1, 2);
`,
    );
    const outPath = join(scratch, "rest-src");
    const res = await compile(entry, { outPath, outDir: scratch, backend: "llvm" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics[0]?.code).toBe("SC1090");
  });

  test("rest-carrying DESTINATION type refuses SC2009, base-identical", async () => {
    const entry = join(scratch, "rest-dst.ts");
    await writeFile(
      entry,
      `
type Handler = (a: string, ...nums: number[]) => void;
function plain(a: string, b: number): void { console.log(a, b); }
const h: Handler = plain;
h("x", 1, 2, 3);
`,
    );
    const outPath = join(scratch, "rest-dst");
    const res = await compile(entry, { outPath, outDir: scratch, backend: "llvm" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics[0]?.code).toBe("SC2009");
  });
});

/* ── group 3: scope boundary on the emitted IR ───────────────────────── */

async function emittedIrText(name: string, source: string): Promise<string> {
  const entry = join(scratch, name);
  await writeFile(entry, source);
  const outPath = join(scratch, name.replace(/\.ts$/, ""));
  const res = await compile(entry, { outPath, outDir: scratch, backend: "llvm", emitIr: true });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  if (!res.irPath) throw new Error("compile ok but no irPath (emitIr not honored)");
  return readFile(res.irPath, "utf8");
}

describe("board #85: scope boundary — non-arity-drop dispositions never route through arityWiden", () => {
  test("param coercion (bivariant method, same arity, union-wrap) stays on funcCoerceAdapter", async () => {
    const ir = await emittedIrText(
      "scope-param.ts",
      `
type Handler = { handle(x: string | number): void };
function stringOnly(x: string): void { console.log("got", x); }
const h: Handler = { handle: stringOnly };
h.handle("ok");
`,
    );
    expect(ir).not.toContain("arityWiden");
    expect(ir).toContain("fn.adapt");
  });

  test("return coercion (same arity, union-wrap on the result) stays on funcCoerceAdapter", async () => {
    const ir = await emittedIrText(
      "scope-return.ts",
      `
type Producer = () => string | undefined;
function makeStr(): string { return "made"; }
const make: Producer = makeStr;
console.log(String(make()));
`,
    );
    expect(ir).not.toContain("arityWiden");
    expect(ir).toContain("fn.adapt");
  });

  test("pure arity-drop (2253's own cb/Callback shape) DOES route through arityWiden, never mints fn.adapt", async () => {
    const ir = await emittedIrText("scope-aritydrop.ts", CALLBACK_ARITY_DROP_SOURCE);
    expect(ir).toContain("arityWiden");
    expect(ir).not.toContain("fn.adapt");
  });

  test("2470-mockable-module-shape's own dyn-boundary param coercion stays on funcCoerceAdapter (empirically re-traced, not assumed)", async () => {
    const repoRoot = join(import.meta.dirname, "../../..");
    const source = await readFile(join(repoRoot, "tests/corpus/2470-mockable-module-shape.js"), "utf8");
    const entry = join(scratch, "2470-retrace.js");
    await writeFile(entry, source);
    const outPath = join(scratch, "2470-retrace");
    const res = await compile(entry, { outPath, outDir: scratch, backend: "llvm", emitIr: true });
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    if (!res.irPath) throw new Error("compile ok but no irPath");
    const ir = await readFile(res.irPath, "utf8");
    expect(ir).not.toContain("arityWiden");
    expect(ir).toContain("fn.adapt");
  });
});

/* ── group 7: 85-D3/D4 addendum — rev-85's own F1-blast-radius probes,
 * ported verbatim (not reinvented) per the addendum's explicit
 * instruction, with provenance cited. Source: fix-85-rev/probes/
 * p13-depth2-array.ts, p14-depth2-record.ts, p15-depth2-capture.ts,
 * p19-depth3.ts (the reviewer's own depth-3 oracle — 4 widenings, 5
 * comparisons — measured FRESH here against the current tree rather
 * than assumed symmetric with depth-2, per the addendum's own
 * requirement), and p17-compose.ts (the cross-family composition
 * shape — confirmed SC1090-unreachable, base-identical, no pin
 * required beyond this one refusal check per the addendum's ruling —
 * the fence itself, not a behavioral claim past it). All four
 * behavioral probes independently verified against the Node oracle
 * AND all three lanes before porting (not transcribed on trust). */

const P13_ARRAY_SOURCE = `
import assert from "node:assert";
const f = (a: number): void => { console.log("f", a); };
const mid: (a: number, b: number) => void = f;
const wide: (a: number, b: number, c: number) => void = mid;
const arr: ((a: number, b: number, c: number) => void)[] = [wide];
console.log("arr[0]===f", arr[0] === f);
console.log("arr[0]===mid", arr[0] === mid);
const arr2: ((a: number, b: number, c: number) => void)[] = [f];
let deepOk = true;
try { assert.deepStrictEqual(arr, arr2); } catch { deepOk = false; }
console.log("deepStrictEqual depth2-vs-bare", deepOk);
arr[0]!(1, 2, 3);
`;
const P13_ARRAY_EXPECTED = "arr[0]===f true\narr[0]===mid true\ndeepStrictEqual depth2-vs-bare true\nf 1\n";

const P14_RECORD_SOURCE = `
const f = (a: number): void => { console.log("f", a); };
const mid: (a: number, b: number) => void = f;
type Slot = { cb: (a: number, b: number, c: number) => void };
const slot: Slot = { cb: mid };
console.log("slot.cb===f", slot.cb === f);
console.log("slot.cb===mid", slot.cb === mid);
slot.cb(1, 2, 3);
`;
const P14_RECORD_EXPECTED = "slot.cb===f true\nslot.cb===mid true\nf 1\n";

const P15_CAPTURE_SOURCE = `
function make(tag: string): (a: number) => void {
  let n = 0;
  return (a: number): void => { n += a; console.log(tag, n); };
}
const c1 = make("A");
const mid: (a: number, b: number) => void = c1;
const wide: (a: number, b: number, c: number) => void = mid;
console.log("wide===c1", wide === c1);
c1(1);
wide(2, 0, 0);
c1(3);
`;
const P15_CAPTURE_EXPECTED = "wide===c1 true\nA 1\nA 3\nA 6\n";

const P19_DEPTH3_SOURCE = `
const f = (a: number): void => { console.log("f", a); };
const w1: (a: number, b: number) => void = f;
const w2: (a: number, b: number, c: number) => void = w1;
const w3: (a: number, b: number, c: number, d: number) => void = w2;
console.log("w3===f", w3 === f);
console.log("w3===w1", w3 === w1);
console.log("w3===w2", w3 === w2);
console.log("w2===f", w2 === f);
console.log("w1===f", w1 === f);
w3(1, 2, 3, 4);
w2(5, 6, 7);
w1(8, 9);
f(10);
`;
const P19_DEPTH3_EXPECTED =
  "w3===f true\nw3===w1 true\nw3===w2 true\nw2===f true\nw1===f true\n" +
  "f 1\nf 5\nf 8\nf 10\n";

const ADDENDUM_SHAPES: { name: string; source: string; expected: string }[] = [
  { name: "p13-array", source: P13_ARRAY_SOURCE, expected: P13_ARRAY_EXPECTED },
  { name: "p14-record", source: P14_RECORD_SOURCE, expected: P14_RECORD_EXPECTED },
  { name: "p15-capture", source: P15_CAPTURE_SOURCE, expected: P15_CAPTURE_EXPECTED },
  { name: "p19-depth3", source: P19_DEPTH3_SOURCE, expected: P19_DEPTH3_EXPECTED },
];

describe("board #85 85-D3/D4 addendum: rev-85's F1-blast-radius shapes (ported, provenance cited)", () => {
  for (const shape of ADDENDUM_SHAPES) {
    for (const backend of ["llvm", "c"] as const) {
      test(`${backend}: ${shape.name}`, async () => {
        const bin = await buildNative(`${shape.name}-${backend}.ts`, shape.source, backend, false);
        const { stdout } = await execFileAsync(bin);
        expect(stdout).toBe(shape.expected);
      });
    }
    test(`wasm: ${shape.name}`, async () => {
      const bin = await buildWasm(`${shape.name}-wasm.ts`, shape.source);
      const run = await runWasm(bin);
      expect(run.stdout).toBe(shape.expected);
      expect(run.exitCode).toBe(0);
    });
  }

  test("cross-family composition (a #75 listener adapter OVER a #85 marker) refuses SC1090, base-identical — no behavioral pin needed past the fence", async () => {
    const source = `
import { EventEmitter } from "node:events";
const narrow = (): void => { console.log("n"); };
const wide: (a: number) => void = narrow;
const ee = new EventEmitter();
ee.on("x", wide);
const ls = ee.listeners("x");
console.log("len", ls.length);
ee.emit("x", 1);
`;
    const entry = join(scratch, "p17-compose.ts");
    await writeFile(entry, source);
    const outPath = join(scratch, "p17-compose");
    const res = await compile(entry, { outPath, outDir: scratch, backend: "wasm" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics[0]?.code).toBe("SC1090");
  });
});
