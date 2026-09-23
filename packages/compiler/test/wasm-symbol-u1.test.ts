/* INC-27 unit U1 — the symbol value: construction, toString, the
 * description accessor, identity, truthiness, a `symbol | undefined`
 * union crossing a real function boundary, the `Symbol.for` registry,
 * the third Map/Set key kind, rendering, and assert.eqSym's eight
 * message shapes. ONE `test` PER ROW, EACH ROW ITS OWN COMPILE —
 * wasm-pow-u0.test.ts's own idiom (a mutant that traps one row must not
 * truncate a shared module's other rows and destroy mutation
 * attribution).
 *
 * Every expected line below is an INLINED literal, derived from a real
 * `node --experimental-transform-types` run of the SAME snippet each row
 * compiles — a committed test reads nothing outside this repository at
 * test time (board #126/#150's class). inspect needs no wasm-side hunk
 * for these rows: a symbol VALUE renders through `sym.toString`, and a
 * `string | undefined` union prints through the ALREADY-SUPPORTED
 * insp.dyn/insp.str/undefined-arm machinery (no new code this file
 * exercises beyond the sym.* dispatch, mapType/mapTypeSoft's new arm,
 * and the registry's own linear scan). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-symbol-u1-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Compile ONE row's program (its own compile, static/plain mode — none
 * of these rows cross a symbol into `any`) and return its full stdout. */
async function runRow(name: string, src: string): Promise<string> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  return stdout;
}

/** Compile ONE row expecting a COMPILE-TIME refusal (B-i's named-gate
 * rows) in the given mode, and return the sorted, de-duplicated set of
 * "CODE:message" strings — a named-refusal row asserts the diagnostic,
 * never a Node oracle (there is nothing for Node to run). Throws if the
 * program unexpectedly compiles. */
async function compileDiag(name: string, src: string, dynamic: boolean): Promise<string[]> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (res.ok) throw new Error(`${name} [${dynamic ? "dyn" : "plain"}] compiled but was expected to refuse`);
  return [...new Set(res.diagnostics.map((d) => `${d.code}:${d.message}`))].sort();
}

/** Compile ONE row expecting SUCCESS in the given mode (a number-typed
 * twin control) — returns nothing, just throws if it unexpectedly
 * refuses. */
async function compileOk(name: string, src: string, dynamic: boolean): Promise<void> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`${name} [${dynamic ? "dyn" : "plain"}] refused but was expected to compile: ${res.diagnostics[0]?.message}`);
}

// ============================================================
// VALUE — construction (sym.new / sym.newAnon), toString, description.
// ============================================================

test("V1 Symbol('a').toString() — described", async () => {
  const out = await runRow(
    "v1",
    'const s: symbol = Symbol("a");\nconsole.log(s.toString());',
  );
  expect(out.trimEnd()).toBe("Symbol(a)");
});

test("V2 Symbol().toString() — anonymous", async () => {
  const out = await runRow("v2", "const s: symbol = Symbol();\nconsole.log(s.toString());");
  expect(out.trimEnd()).toBe("Symbol()");
});

test("V3 Symbol('').description answers the empty string, not undefined", async () => {
  const out = await runRow("v3", 'const s: symbol = Symbol("");\nconsole.log(s.description);');
  // Node prints a bare blank line for the empty description.
  expect(out).toBe("\n");
});

test("V4 Symbol().description answers undefined when no description was given", async () => {
  const out = await runRow("v4", "const s: symbol = Symbol();\nconsole.log(s.description);");
  expect(out.trimEnd()).toBe("undefined");
});

test("V5 Symbol('nonempty').description answers the non-empty description present", async () => {
  const out = await runRow("v5", "const s: symbol = Symbol(\"nonempty\");\nconsole.log(s.description);");
  expect(out.trimEnd()).toBe("nonempty");
});

test("V6 sym.valueOf() === sym", async () => {
  const out = await runRow("v6", "const s: symbol = Symbol(\"v\");\nconsole.log(s.valueOf() === s);");
  expect(out.trimEnd()).toBe("true");
});

test("CAP a symbol[] captured by a closure, read back through the return", async () => {
  // A closure that captures an ARRAY of symbols (not a bare symbol) and
  // reads two elements back out of it after the enclosing call returns —
  // the shape a boxed capture's own representation must agree with the
  // array element's representation on, or the captured array's element
  // slot disagrees with what the closure's own box expects to read.
  const out = await runRow(
    "cap",
    [
      "function make(): () => string {",
      '  const arr: symbol[] = [Symbol("p"), Symbol("q")];',
      "  return () => arr[0]!.toString() + \",\" + arr[1]!.toString();",
      "}",
      "const f = make();",
      "console.log(f());",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe("Symbol(p),Symbol(q)");
});

// ============================================================
// IDENTITY — ref.eq, lifted for symbol only.
// ============================================================

test("I1 fresh vs fresh, same description — unequal", async () => {
  const out = await runRow("i1", 'console.log(Symbol("a") === Symbol("a"));');
  expect(out.trimEnd()).toBe("false");
});

test("I2 same reference — equal", async () => {
  const out = await runRow("i2", 'const s: symbol = Symbol("a");\nconsole.log(s === s);');
  expect(out.trimEnd()).toBe("true");
});

test("I3 identity carried through a function PARAMETER", async () => {
  const out = await runRow(
    "i3",
    [
      "function same(a: symbol, b: symbol): boolean { return a === b; }",
      'const s: symbol = Symbol("p");',
      "console.log(same(s, s));",
      'console.log(same(Symbol("p"), Symbol("p")));',
    ].join("\n"),
  );
  expect(out).toBe("true\nfalse\n");
});

test("I4 identity carried through a RECORD FIELD", async () => {
  const out = await runRow(
    "i4",
    [
      'const s: symbol = Symbol("f");',
      "const rec = { k: s };",
      "console.log(rec.k === s);",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe("true");
});

test("I5 identity carried through a RETURNED VALUE", async () => {
  const out = await runRow(
    "i5",
    [
      'function make(): symbol { return Symbol("r"); }',
      "console.log(make() === make());",
      'const s: symbol = Symbol("r2");',
      "function get(): symbol { return s; }",
      "console.log(get() === s);",
    ].join("\n"),
  );
  expect(out).toBe("false\ntrue\n");
});

test("I6 !== — the negated form, both a distinct pair and a self-pair", async () => {
  const out = await runRow(
    "i6",
    [
      'const a: symbol = Symbol("n");',
      'const b: symbol = Symbol("n");',
      "console.log(a !== b);",
      "console.log(a !== a);",
    ].join("\n"),
  );
  expect(out).toBe("true\nfalse\n");
});

// ============================================================
// TYPEOF-TRUTHY — a symbol is truthy unconditionally.
// ============================================================

test("T1 truthiness — always true, described or not", async () => {
  const out = await runRow(
    "t1",
    'const s: symbol = Symbol();\nconsole.log(s ? "truthy" : "falsy");',
  );
  expect(out.trimEnd()).toBe("truthy");
});

test("T2 typeof s answers 'symbol'", async () => {
  const out = await runRow("t2", 'const s: symbol = Symbol("t");\nconsole.log(typeof s);');
  expect(out.trimEnd()).toBe("symbol");
});

test("T3 !s — the negation form, always false", async () => {
  const out = await runRow("t3", 'const s: symbol = Symbol("t");\nconsole.log(!s);');
  expect(out.trimEnd()).toBe("false");
});

test("T4 typeof over a string | symbol PARAMETER — both arms", async () => {
  const out = await runRow(
    "t4",
    [
      "function f(v: string | symbol): string { return typeof v; }",
      'console.log(f(Symbol("t")));',
      'console.log(f("plain"));',
    ].join("\n"),
  );
  expect(out).toBe("symbol\nstring\n");
});

// ============================================================
// UNION — `symbol | undefined` wrap (a real value) and narrow (a real
// function boundary), across two calls sharing one compile.
// ============================================================

test("U1 symbol | undefined — wrap a symbol, wrap undefined, narrow both", async () => {
  const out = await runRow(
    "u1",
    [
      "function pick(x: symbol | undefined): string {",
      "  if (x === undefined) return \"none\";",
      "  return x.toString();",
      "}",
      'console.log(pick(Symbol("z")));',
      "console.log(pick(undefined));",
    ].join("\n"),
  );
  expect(out).toBe("Symbol(z)\nnone\n");
});

// ============================================================
// RENDER — console.log and util.inspect of a symbol, bare and inside a
// container (record value, array element, Set element).
// ============================================================

test("RENDER1 console.log of a described, anonymous, empty-description, and registered symbol", async () => {
  const out = await runRow(
    "render1",
    [
      'console.log(Symbol("d"));',
      "console.log(Symbol());",
      'console.log(Symbol(""));',
      'const r: symbol = Symbol.for("rk");',
      "console.log(r);",
    ].join("\n"),
  );
  expect(out).toBe("Symbol(d)\nSymbol()\nSymbol()\nSymbol(rk)\n");
});

test("RENDER2 a symbol inside a record value, an array, and a Set — never quoted", async () => {
  const out = await runRow(
    "render2",
    [
      'console.log({ k: Symbol("x") });',
      'console.log([Symbol("a"), Symbol("b")]);',
      'console.log(new Set<symbol>([Symbol("p"), Symbol("q"), Symbol("r")]));',
    ].join("\n"),
  );
  expect(out).toBe("{ k: Symbol(x) }\n[ Symbol(a), Symbol(b) ]\nSet(3) { Symbol(p), Symbol(q), Symbol(r) }\n");
});

test("RENDER3 util.inspect renders a symbol identically to console.log", async () => {
  const out = await runRow(
    "render3",
    ["import * as util from \"node:util\";", 'console.log(util.inspect(Symbol("d")));'].join("\n"),
  );
  expect(out.trimEnd()).toBe("Symbol(d)");
});

// ============================================================
// REGISTRY — `Symbol.for` (present-or-absent, never truthiness) and
// `Symbol.keyFor`, including the empty-key row (an empty-string key is
// a legal, distinct registration, not an absent one).
// ============================================================

test("REG1 Symbol.for(k) === Symbol.for(k) — the same registered symbol both times", async () => {
  const out = await runRow("reg1", 'console.log(Symbol.for("a") === Symbol.for("a"));');
  expect(out.trimEnd()).toBe("true");
});

test("REG2 Symbol.for(k) !== Symbol(k) — registration is distinct from a plain construction with the same description", async () => {
  const out = await runRow("reg2", 'console.log(Symbol.for("b") === Symbol("b"));');
  expect(out.trimEnd()).toBe("false");
});

test("REG3 Symbol.keyFor of a registered symbol answers its key", async () => {
  const out = await runRow("reg3", 'console.log(Symbol.keyFor(Symbol.for("c")));');
  expect(out.trimEnd()).toBe("c");
});

test("REG4 Symbol.keyFor of a plain (unregistered) symbol answers undefined", async () => {
  const out = await runRow("reg4", 'console.log(Symbol.keyFor(Symbol("d")));');
  expect(out.trimEnd()).toBe("undefined");
});

test("REG5 two DIFFERENT keys registered are distinct symbols", async () => {
  const out = await runRow("reg5", 'console.log(Symbol.for("e1") === Symbol.for("e2"));');
  expect(out.trimEnd()).toBe("false");
});

test("REG-EMPTY-1 Symbol.for('') === Symbol.for('') — the empty key is a legal, present registration", async () => {
  const out = await runRow("reg-empty-1", 'console.log(Symbol.for("") === Symbol.for(""));');
  expect(out.trimEnd()).toBe("true");
});

test("REG-EMPTY-2 Symbol.keyFor(Symbol.for('')) answers the empty string, not undefined", async () => {
  const out = await runRow("reg-empty-2", 'console.log(Symbol.keyFor(Symbol.for("")));');
  // Node prints a bare blank line for the empty key.
  expect(out).toBe("\n");
});

test("REG-GROWTH six distinct registrations force the registry's own array growth, every entry still distinct and round-trips", async () => {
  // The registry starts at a small fixed capacity — six DIFFERENT keys
  // force at least one grow-and-copy before the sixth is appended, and
  // every earlier entry must still answer correctly afterward (a bug in
  // the copy, or in re-reading the live count against the OLD capacity,
  // would silently drop or duplicate an early entry).
  const out = await runRow(
    "reg-growth",
    [
      'const s0 = Symbol.for("k0");',
      'const s1 = Symbol.for("k1");',
      'const s2 = Symbol.for("k2");',
      'const s3 = Symbol.for("k3");',
      'const s4 = Symbol.for("k4");',
      'const s5 = Symbol.for("k5");',
      'console.log(Symbol.for("k0") === s0 && Symbol.for("k1") === s1 && Symbol.for("k2") === s2 && Symbol.for("k3") === s3 && Symbol.for("k4") === s4 && Symbol.for("k5") === s5);',
      "console.log(Symbol.keyFor(s0));",
      "console.log(Symbol.keyFor(s1));",
      "console.log(Symbol.keyFor(s2));",
      "console.log(Symbol.keyFor(s3));",
      "console.log(Symbol.keyFor(s4));",
      "console.log(Symbol.keyFor(s5));",
    ].join("\n"),
  );
  expect(out).toBe("true\nk0\nk1\nk2\nk3\nk4\nk5\n");
});

// ============================================================
// SET — Set<symbol>, the third Map/Set key kind: add-by-add, seeded
// (array/spread) construction, clear(), and an ordinary f64-keyed Set as
// a control (nothing here should ever regress a Set the third key kind
// didn't touch).
// ============================================================

test("SET1 add-by-add: distinct symbols each count once, a duplicate add does not grow size", async () => {
  const out = await runRow(
    "set1",
    [
      "const s = new Set<symbol>();",
      'const a = Symbol("x");',
      'const b = Symbol("y");',
      "s.add(a);",
      "s.add(b);",
      "console.log(s.size);",
      "console.log(s.has(a), s.has(b));",
      "s.add(a);",
      "console.log(s.size);",
    ].join("\n"),
  );
  expect(out).toBe("2\ntrue true\n2\n");
});

test("SET2 seeded construction (the addAll path) de-duplicates a repeated symbol", async () => {
  const out = await runRow(
    "set2",
    [
      'const a = Symbol("x");',
      'const b = Symbol("y");',
      'const c = Symbol("z");',
      "const s = new Set<symbol>([a, b, c, a]);",
      "console.log(s.size);",
      "console.log(s.has(a), s.has(b), s.has(c));",
    ].join("\n"),
  );
  expect(out).toBe("3\ntrue true true\n");
});

test("SET3 clear() empties a symbol-keyed Set, and a re-add works afterward", async () => {
  const out = await runRow(
    "set3",
    [
      'const a = Symbol("x");',
      'const c = Symbol("z");',
      "const s = new Set<symbol>([a, c]);",
      "s.clear();",
      "console.log(s.size);",
      "console.log(s.has(a));",
      "s.add(c);",
      "console.log(s.size, s.has(c));",
    ].join("\n"),
  );
  expect(out).toBe("0\nfalse\n1 true\n");
});

test("SET4 an ordinary f64-keyed Set is unaffected by the third key kind (control)", async () => {
  const out = await runRow(
    "set4",
    ["const s = new Set<number>([1, 2, 3, 1]);", "console.log(s.size);", "console.log(s.has(2));"].join("\n"),
  );
  expect(out).toBe("3\ntrue\n");
});

test("SET5 an f64-keyed Set's delete AND clear (SET4 alone is seeded-only)", async () => {
  const out = await runRow(
    "set5",
    [
      "const s = new Set<number>([1, 2, 3]);",
      "console.log(s.delete(2));",
      "console.log(s.size, s.has(2));",
      "s.clear();",
      "console.log(s.size);",
      "s.add(9);",
      "console.log(s.size, s.has(9));",
    ].join("\n"),
  );
  expect(out).toBe("true\n2 false\n0\n1 true\n");
});

// ============================================================
// ASSERT A-H — assert.eqSym's eight message shapes, each pinned to its
// own line of a real Node run of corpus program 1725
// (tests/corpus/1725-assert-symbols.ts), which was ALSO verified
// byte-for-byte as a whole program earlier in this unit — these rows
// isolate each shape for per-mutation attribution the shared program
// cannot give.
// ============================================================

const ASSERT_HELPERS = [
  "import assert from \"node:assert\";",
  "function messageOf(f: () => void): string {",
  "  try {",
  "    f();",
  "    return \"NO THROW\";",
  "  } catch (e) {",
  "    return e instanceof Error ? `${e.name}|${e.message}` : \"not an Error\";",
  "  }",
  "}",
].join("\n");

test("ASSERT A strictEqual, distinct renderings — the stacked diff with a caret", async () => {
  const out = await runRow(
    "assert-a",
    [
      ASSERT_HELPERS,
      'const a = Symbol("a");',
      'const b = Symbol("b");',
      "console.log(JSON.stringify(messageOf(() => assert.strictEqual(a, b))));",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe(
    '"AssertionError|Expected values to be strictly equal:\\n+ actual - expected\\n\\n+ Symbol(a)\\n- Symbol(b)\\n         ^\\n"',
  );
});

test("ASSERT B strictEqual, distinct symbols with IDENTICAL renderings — no caret", async () => {
  const out = await runRow(
    "assert-b",
    [
      ASSERT_HELPERS,
      'const a = Symbol("a");',
      'const a2 = Symbol("a");',
      "console.log(JSON.stringify(messageOf(() => assert.strictEqual(a, a2))));",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe(
    '"AssertionError|Expected values to be strictly equal:\\n+ actual - expected\\n\\n+ Symbol(a)\\n- Symbol(a)\\n"',
  );
});

test("ASSERT C strictEqual, two anonymous symbols — identical 'Symbol()' renderings", async () => {
  const out = await runRow(
    "assert-c",
    [ASSERT_HELPERS, "console.log(JSON.stringify(messageOf(() => assert.strictEqual(Symbol(), Symbol()))));"].join(
      "\n",
    ),
  );
  expect(out.trimEnd()).toBe(
    '"AssertionError|Expected values to be strictly equal:\\n+ actual - expected\\n\\n+ Symbol()\\n- Symbol()\\n"',
  );
});

test("ASSERT D notStrictEqual, same reference — the unequal-to shape, no diff block", async () => {
  const out = await runRow(
    "assert-d",
    [
      ASSERT_HELPERS,
      'const a = Symbol("a");',
      "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual(a, a))));",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe('"AssertionError|Expected \\"actual\\" to be strictly unequal to:\\n\\nSymbol(a)"');
});

test("ASSERT E notStrictEqual, same registered symbol — the unequal-to shape over a registry key", async () => {
  const out = await runRow(
    "assert-e",
    [
      ASSERT_HELPERS,
      "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual(Symbol.for(\"k\"), Symbol.for(\"k\")))));",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe('"AssertionError|Expected \\"actual\\" to be strictly unequal to:\\n\\nSymbol(k)"');
});

test("ASSERT F strictEqual with a custom message — only the header line changes", async () => {
  const out = await runRow(
    "assert-f",
    [
      ASSERT_HELPERS,
      'const a = Symbol("a");',
      'const b = Symbol("b");',
      'console.log(JSON.stringify(messageOf(() => assert.strictEqual(a, b, "custom"))));',
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe('"AssertionError|custom\\n+ actual - expected\\n\\n+ Symbol(a)\\n- Symbol(b)\\n         ^\\n"');
});

test("ASSERT G strictEqual with long descriptions — the caret placement survives multi-word text", async () => {
  const out = await runRow(
    "assert-g",
    [
      ASSERT_HELPERS,
      "console.log(JSON.stringify(messageOf(() => assert.strictEqual(Symbol(\"long description here\"), Symbol(\"other long description\")))));",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe(
    '"AssertionError|Expected values to be strictly equal:\\n+ actual - expected\\n\\n+ Symbol(long description here)\\n- Symbol(other long description)\\n         ^\\n"',
  );
});

test("ASSERT H deepStrictEqual — the 'strictly deep-equal' header variant, otherwise row A's shape", async () => {
  const out = await runRow(
    "assert-h",
    [
      ASSERT_HELPERS,
      'const a = Symbol("a");',
      'const b = Symbol("b");',
      "console.log(JSON.stringify(messageOf(() => assert.deepStrictEqual(a, b))));",
    ].join("\n"),
  );
  expect(out.trimEnd()).toBe(
    '"AssertionError|Expected values to be strictly deep-equal:\\n+ actual - expected\\n\\n+ Symbol(a)\\n- Symbol(b)\\n         ^\\n"',
  );
});

// ============================================================
// B-i — checked TypeScript, eight compile-time gates. Each symbol row's
// mode is stated explicitly; each carries a number-typed twin CONTROL
// (compiles in every mode the symbol row is a row for) proving the gate
// is about the SYMBOL type, not about `any`/`unknown` in general.
// ============================================================

// NOTE: none of gates 1-3's programs print the crossed `any` value —
// `console.log` of an `any`/dyn value is ITSELF an unsupported dynamic
// construct (SC1090 "console.log of 'any' values...") independent of
// symbol, and printing it would confound the gate under test with that
// unrelated one (measured: an earlier draft's number-typed twin failed
// to compile in dynamic mode for exactly this reason, caught by
// compileOk actually throwing). Each program prints only a constant
// string, so the ANY-typed crossing itself is the sole discriminator.

test("B-i gate 1 (const s: any = Symbol('d')) — plain and dynamic, with a number twin", async () => {
  const sym = "const s: any = Symbol('d');\nconsole.log('done');";
  const num = "const s: any = 1;\nconsole.log('done');";
  const plain = await compileDiag("bi-g1-plain", sym, false);
  expect(plain).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
  const dyn = await compileDiag("bi-g1-dyn", sym, true);
  expect(dyn).toEqual([
    "SC1090:passing a value of type 'symbol' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet",
  ]);
  await compileOk("bi-g1-num-plain", num, false);
  await compileOk("bi-g1-num-dyn", num, true);
});

test("B-i gate 2 (const t: symbol = ...; const s: any = t) — plain and dynamic, with a number twin", async () => {
  const sym = "const t: symbol = Symbol('d');\nconst s: any = t;\nconsole.log('done');";
  const num = "const t: number = 1;\nconst s: any = t;\nconsole.log('done');";
  const plain = await compileDiag("bi-g2-plain", sym, false);
  expect(plain).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
  const dyn = await compileDiag("bi-g2-dyn", sym, true);
  expect(dyn).toEqual([
    "SC1090:passing a value of type 'symbol' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet",
  ]);
  await compileOk("bi-g2-num-plain", num, false);
  await compileOk("bi-g2-num-dyn", num, true);
});

test("B-i gate 3 (f(Symbol('d')) where f(v: any)) — plain and dynamic, with a number twin", async () => {
  const sym = "function f(v: any) { }\nf(Symbol('d'));\nconsole.log('done');";
  const num = "function f(v: any) { }\nf(1);\nconsole.log('done');";
  const plain = await compileDiag("bi-g3-plain", sym, false);
  expect(plain).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
  const dyn = await compileDiag("bi-g3-dyn", sym, true);
  expect(dyn).toEqual([
    "SC1090:passing a value of type 'symbol' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet",
  ]);
  await compileOk("bi-g3-num-plain", num, false);
  await compileOk("bi-g3-num-dyn", num, true);
});

test("B-i gate 4 (const a: any[] = [Symbol('d')]) — DYNAMIC ONLY; plain fences on `any[]` itself, not on symbol", async () => {
  const sym = "const a: any[] = [Symbol('d')];\nconsole.log(a.length);";
  const num = "const a: any[] = [1];\nconsole.log(a.length);";
  // Plain mode: BOTH the symbol shape and its number twin refuse with the
  // IDENTICAL code (a fence on `any[]` itself, unrelated to symbol) — not
  // a symbol row here, a stated exclusion, so only the CODE is checked
  // (not a full row), and the twin's plain-mode refusal is the proof.
  const plain = await compileDiag("bi-g4-plain", sym, false);
  expect(plain).toEqual(["SC2011:values of type 'any[]' have no static representation but run in the embedded dynamic engine, which this build does not include"]);
  const plainTwin = await compileDiag("bi-g4-num-plain", num, false);
  expect(plainTwin).toEqual(["SC2011:values of type 'any[]' have no static representation but run in the embedded dynamic engine, which this build does not include"]);
  // Dynamic mode DOES discriminate: the symbol shape refuses, the number
  // twin compiles — this IS the row.
  const dyn = await compileDiag("bi-g4-dyn", sym, true);
  expect(dyn).toEqual([
    "SC1090:passing a value of type 'symbol' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet",
  ]);
  await compileOk("bi-g4-num-dyn", num, true);
});

test("B-i gate 5 (const u: unknown = Symbol('d')) — mode-invariant, with a number twin", async () => {
  const sym = "const u: unknown = Symbol('d');\nconsole.log(u);";
  const num = "const u: unknown = 1;\nconsole.log(u);";
  for (const dynamic of [false, true]) {
    const codes = await compileDiag(`bi-g5-${dynamic ? "dyn" : "plain"}`, sym, dynamic);
    expect(codes).toEqual(["SC1101:converting typed values to 'unknown' is not supported yet"]);
    await compileOk(`bi-g5-num-${dynamic ? "dyn" : "plain"}`, num, dynamic);
  }
});

test("B-i gate 6 (a symbol under Record<string, unknown>) — mode-invariant, with a number twin", async () => {
  const sym = "const r: Record<string, unknown> = { k: Symbol('d') };\nconsole.log(r.k);";
  const num = "const r: Record<string, unknown> = { k: 1 };\nconsole.log(r.k);";
  for (const dynamic of [false, true]) {
    const codes = await compileDiag(`bi-g6-${dynamic ? "dyn" : "plain"}`, sym, dynamic);
    expect(codes).toEqual([
      "SC1100:storing 'symbol' values under an 'unknown'-valued index signature (only numbers, strings, booleans, and JSON-safe records/arrays/unions convert) is not supported yet",
    ]);
    await compileOk(`bi-g6-num-${dynamic ? "dyn" : "plain"}`, num, dynamic);
  }
});

test("B-i gate 7 (Map<string, symbol>) — the fixed r7-a shape, full sorted four-code multiset, mode-invariant, with a number twin", async () => {
  const sym = 'const m = new Map<string, symbol>();\nm.set("a", Symbol("d"));\nconsole.log(m.size);';
  const num = 'const m = new Map<string, number>();\nm.set("a", 1);\nconsole.log(m.size);';
  for (const dynamic of [false, true]) {
    const codes = await compileDiag(`bi-g7-${dynamic ? "dyn" : "plain"}`, sym, dynamic);
    expect(codes).toEqual([
      "SC1090:Map values of type 'symbol' (Map values must be number, string, boolean, records, class instances, arrays, promises, or unions of those — not functions, Maps, 'unknown', or 'any') is not supported yet",
      "SC2009:values of type 'Map<string, symbol>' cannot be compiled: the Map shape is supported, but 'symbol' values have no Map slot yet (functions, promises, and nested Maps stay out)",
      "SC2020:'Map<string, symbol>.set' is part of the standard library types but has no scriptc lowering yet",
      "SC2020:'Map<string, symbol>.size' is part of the standard library types but has no scriptc lowering yet",
    ]);
    await compileOk(`bi-g7-num-${dynamic ? "dyn" : "plain"}`, num, dynamic);
  }
});

test("B-i gate 8 (an island-minted symbol) — mode-invariant: no node:island module exists", async () => {
  const sym = "import { mintSymbol } from 'node:island';\nconsole.log(typeof mintSymbol);";
  for (const dynamic of [false, true]) {
    const codes = await compileDiag(`bi-g8-${dynamic ? "dyn" : "plain"}`, sym, dynamic);
    expect(codes).toEqual([
      "SC0001:Cannot find module 'node:island' or its corresponding type declarations.",
      "SC1010:the 'node:island' module is not supported yet",
    ]);
  }
});

test("B-i gate 9 (Reflect.ownKeys over a symbol-computed key) — both modes name SC1090 + SC2020", async () => {
  const sym = 'const s = Symbol("k");\nconst o: any = { [s]: 1 };\nconsole.log(Reflect.ownKeys(o).length);';
  const plain = await compileDiag("bi-g9-plain", sym, false);
  expect(plain).toEqual([
    "SC1090:computed property keys (compile-time-known keys fold — a pure expression whose checker type is one string or number literal: consts, enum members, quoted keys, templates of those — `{ [MARKER]: v }`; runtime string keys write through an index-signature target; symbol keys stay out) are not supported yet",
    "SC2020:'Reflect.ownKeys' is part of the standard library types but has no scriptc lowering yet",
  ]);
  const dyn = await compileDiag("bi-g9-dyn", sym, true);
  expect(dyn).toEqual([
    "SC1090:this property form in an 'any'-typed object literal (only `name: value`, shorthand names, methods, and get accessors are supported) is not supported yet",
    "SC2020:'Reflect.ownKeys' is part of the standard library types but has no scriptc lowering yet",
  ]);
});

// ============================================================
// B-ii — unchecked JS (.cjs): the crossing is NOT gated at compile time;
// the program BUILDS and the refusal becomes a deferred RUN-TIME trap.
// MEASURED WITH STDERR (a correction from an earlier reading of this
// checkpoint that captured only the RuntimeError and stdout: the
// deferred diagnostic text is never IN the module — base 2abbd214's and
// this worktree's compiled module for the same source are BYTE-
// IDENTICAL — it reaches STDERR through the host's own uncaught-error
// report, "Uncaught Error: <text> [<CODE> at <file>:<line>]\n", exitCode
// unaffected by the trap that follows). Each row asserts the
// RuntimeError via runWasmToTrap (never .exitCode), empty stdout, AND
// the deferred code + text on stderr (the file:line suffix is the
// scratch dir's own path, so only the CODE and the message text before
// " at " are asserted verbatim).
// ============================================================

const B_II_ROWS: { id: string; src: string; expected: string }[] = [
  {
    id: "row1",
    src: "function f(v){return `${typeof v}`}\nconsole.log(f(Symbol('d')));\n",
    expected: "Uncaught Error: converting typed values to 'unknown' is not supported yet [SC1101 at ",
  },
  {
    id: "row2",
    src: "const w = Symbol.iterator;\nconsole.log(typeof w);\n",
    expected: "Uncaught Error: 'Symbol.iterator' is part of the standard library types but has no scriptc lowering yet [SC2020 at ",
  },
  {
    id: "row3",
    src: "console.log(Symbol.for('Symbol.iterator') === Symbol.iterator);\n",
    expected: "Uncaught Error: 'Symbol.iterator' is part of the standard library types but has no scriptc lowering yet [SC2020 at ",
  },
  {
    id: "row4",
    src: "const x = Symbol.asyncIterator;\nconsole.log(typeof x);\n",
    expected: "Uncaught Error: 'Symbol.asyncIterator' is part of the standard library types but has no scriptc lowering yet [SC2020 at ",
  },
  {
    id: "row5",
    src:
      "function g(v){ try { return `${v}` } catch (e) { return 'CAUGHT|' + e.message; } }\n" +
      "console.log(g(Symbol('d')));\n",
    expected: "Uncaught Error: converting typed values to 'unknown' is not supported yet [SC1101 at ",
  },
];

// Dynamic mode's deferred text is a DIFFERENT code/message for rows 1
// and 5 (the crossing-into-`any` message) but the SAME SC2020 text for
// rows 2-4 (a well-known symbol as a bare VALUE has no lowering in
// either mode — the crossing-into-`any` question never arises for it).
const B_II_DYN_OVERRIDE: Record<string, string> = {
  row1:
    "Uncaught Error: passing a value of type 'symbol' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at ",
  row5: "Uncaught Error: passing a value of type 'symbol' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at ",
};

for (const row of B_II_ROWS) {
  for (const dynamic of [false, true]) {
    const tag = dynamic ? "dyn" : "plain";
    test(`B-ii ${row.id} [${tag}] — unchecked-JS, builds, traps, empty stdout, the deferred code+text on stderr`, async () => {
      const entry = join(scratch, `bii-${row.id}-${tag}.cjs`);
      await writeFile(entry, row.src);
      const res = await compile(entry, {
        outPath: join(scratch, `bii-${row.id}-${tag}.wasm`),
        outDir: scratch,
        backend: "wasm",
        dynamic,
      });
      if (!res.ok) throw new Error(`${row.id} [${tag}] refused at compile time: ${res.diagnostics[0]?.message}`);
      const { stdout, stderr } = await runWasmToTrap(res.binaryPath);
      expect(stdout).toBe("");
      const expected = dynamic && B_II_DYN_OVERRIDE[row.id] !== undefined ? B_II_DYN_OVERRIDE[row.id]! : row.expected;
      expect(stderr.startsWith(expected)).toBe(true);
      // The suffix shape (":<line>]\n" at the very end) and exactly ONE
      // "Uncaught Error" in the whole message — tighter than the prefix
      // match alone.
      expect(stderr).toMatch(/:\d+\]\n$/);
      expect(stderr.match(/Uncaught Error/g)?.length).toBe(1);
    });
  }
}

test("B-ii symbol-free twin (.cjs, both modes) RUNS and MATCHES — the control proving 'builds' is not vacuous", async () => {
  for (const dynamic of [false, true]) {
    const tag = dynamic ? "dyn" : "plain";
    const entry = join(scratch, `bii-twin-${tag}.cjs`);
    await writeFile(entry, "function f(v){return `${typeof v}`}\nconsole.log(f(7));\n");
    const res = await compile(entry, { outPath: join(scratch, `bii-twin-${tag}.wasm`), outDir: scratch, backend: "wasm", dynamic });
    if (!res.ok) throw new Error(`bii-twin [${tag}] refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe("number\n");
  }
});

// ============================================================
// REGRESSION — a pre-existing symbol-KEYED construct (front-end-lowered,
// none of this unit's own machinery) and one of the twelve U1 programs,
// both re-verified against sealed oracles from inside this rows file.
// ============================================================

// Resolved relative to THIS file via import.meta.url (wasm-pow-u0.test.ts's
// own CORPUS_760 precedent) — a committed test names no absolute path and
// survives the worktree that built it being removed.
const CORPUS_2252 = fileURLToPath(new URL("../../../tests/corpus/2252-class-iterators.ts", import.meta.url));
const CORPUS_1731 = fileURLToPath(new URL("../../../tests/corpus/1731-symbol-field-shapes.cjs", import.meta.url));

test("REGRESSION 2252 (Symbol.iterator as a computed method name, front-end-lowered) is unaffected", async () => {
  const res = await compile(CORPUS_2252, { outPath: join(scratch, "regression-2252.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`2252 refused: ${JSON.stringify(res.diagnostics)}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout).toBe("0,1,2,3,\n5 4\n0|2|4\n5 0a\n3\n0 2\n0 1234\nyes folded\n");
});

test("REGRESSION 1731 (symbol field shapes, one of the twelve U1 programs) is unaffected", async () => {
  const res = await compile(CORPUS_1731, { outPath: join(scratch, "regression-1731.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`1731 refused: ${JSON.stringify(res.diagnostics)}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout).toBe(
    "box: five = 5\nbump -> 7\nanon slot: 10 number\noutside write -> 41\npostfix old: 10 new: 11\nprefix new: 12\n" +
      "Chip {\n  name: 'chip',\n  Symbol(count): 41,\n  Symbol(label): 'five',\n  Symbol(): 10\n}\n" +
      "box: tagged = 6\nextra: extra-slot\nbase read of derived: 6 extra-slot\n" +
      "Tagged {\n  name: 'box',\n  Symbol(count): 6,\n  Symbol(label): 'tagged',\n  Symbol(): 10,\n  Symbol(extra): 'extra-slot'\n}\n",
  );
});

// ============================================================
// NOT-LIFTED — every OTHER ref kind still refuses this tier's own
// bin:ref-eq / setNew:ref-elem fallback by exact name. A first-refusal
// probe alone cannot see this (each program's FIRST diagnostic is an
// unrelated, earlier-reached construct), but the census records EVERY
// refusal a program reaches: the full refusal set (`res.wasmSurvey`)
// contains the fallback key even though it is not the first entry.
// ============================================================

test("NOT-LIFTED setNew:ref-elem still refuses for netServer (Set of server handles)", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/2714-set-server-handles.ts", import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, "notlifted-2714.wasm"), outDir: scratch, backend: "wasm" });
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.wasmSurvey).toContain("setNew:ref-elem");
});

test("NOT-LIFTED bin:ref-eq still refuses for netSocket (a dynamic socket comparison)", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/2640-net-dyn-socket-compat.cjs", import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, "notlifted-2640.wasm"), outDir: scratch, backend: "wasm" });
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.wasmSurvey).toContain("bin:ref-eq");
});
