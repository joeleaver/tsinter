/* node:assert (stage D P3, board #37) — durable builder-level pins for
 * the deepResult/refEqBytes/bytesDeepEq machinery (emitter.ts's
 * emitAssertLibCall). Same pattern as wasm-stream-finished.test.ts:
 * compile REAL TypeScript through the actual frontend+backend, run it
 * through the real abi.ts host (wasm-host.ts), assert against a live-
 * Node-measured shape — mechanism reachability, not a typecheck (every
 * emitted branch here executes in at least one test; `emitSetCellError`/
 * `emitSetCellErrorLit` is a #20-class implicit-buffer hazard that has
 * bitten this codebase before, so every pin instantiates the module).
 *
 * MESSAGE SCOPE: this pass builds ONLY the header/custom-message text —
 * never Node's trailing multi-line diff (SEMANTICS.md S054, drafted
 * separately). Every `.message` assertion below is the EXACT, WHOLE
 * string (not `.split("\n")[0]`) to make that boundary explicit; one
 * pin additionally uses `.split("\n")[0]` to mirror 1680's own corpus
 * pattern directly.
 *
 * Every string literal asserted against Node's own output was measured
 * directly (node v24.18.1, own probes) before being written here — see
 * stage D P3's design note (plan.txt) for the full measurement record;
 * this file re-derives the same values independently rather than
 * transcribing them, per the two-instruments-never-average discipline. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-assert-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, lines: string[]) {
  const entry = join(scratch, name);
  await writeFile(entry, `${lines.join("\n")}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

// A shared firstLine-style helper mirroring 1680's own corpus pattern:
// catches, prints name/code/message. Every test file below inlines this
// so each program stays a single, independently-compilable unit.
const FIRST_LINE_HELPER = [
  "const firstLine = (fn: () => void): void => {",
  "  try {",
  "    fn();",
  "    console.log('no throw');",
  "  } catch (e) {",
  "    if (e instanceof Error) {",
  "      console.log(e.name, `${(e as NodeJS.ErrnoException).code}`, e.message);",
  "    }",
  "  }",
  "};",
];

test("strictEqual/deepStrictEqual pass silently on equal Buffers (positive control, no throw)", async () => {
  const path = await build("pass.ts", [
    "import assert from 'node:assert';",
    "const a = Buffer.from([1, 2, 3]);",
    "const b = Buffer.from([1, 2, 3]);",
    "assert.strictEqual(a, a);",
    "assert.deepStrictEqual(a, b);",
    "console.log('ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("strictEqual failing on deep-equal-but-different-identity Buffers renders the SAME-STRUCTURE header", async () => {
  // Node v24.18.1, measured: brandsEq=true AND content-equal -> "Values
  // have same structure but are not reference-equal:" (no trailing diff
  // observed here — this pin's own message property IS the whole text).
  const path = await build("samestruct.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "const a = Buffer.from([1, 2, 3]);",
    "const b = Buffer.from([1, 2, 3]);",
    "firstLine(() => assert.strictEqual(a, b));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["AssertionError ERR_ASSERTION Values have same structure but are not reference-equal:", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("strictEqual failing on different-content Buffers renders the REFERENCE-EQUAL header", async () => {
  const path = await build("refeq-content.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "const a = Buffer.from([1, 2, 3]);",
    "const c = Buffer.from([1, 2, 4]);",
    "firstLine(() => assert.strictEqual(a, c));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ['AssertionError ERR_ASSERTION Expected "actual" to be reference-equal to "expected":', ""].join("\n"),
  );
});

test("strictEqual failing on same-content, DIFFERENT-BRAND operands renders REFERENCE-EQUAL, not same-structure (brandsEq=false branch, force-pinned)", async () => {
  // Not reachable from 1680's own shapes (its strict calls are same-
  // brand throughout) — this is the brandsEq=false branch the lead
  // flagged as needing its own forced pin. Re-measured directly (own
  // probe, node v24.18.1) rather than trusting the prediction: brand
  // mismatch suppresses the "same structure" header even though the
  // bytes match exactly, confirming assert.refEqBytes's header decision
  // is brand-checked, not content-only.
  const path = await build("brand-mismatch.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "const a: Buffer = Buffer.from([1, 2, 3]);",
    "const u: Uint8Array = new Uint8Array([1, 2, 3]);",
    "firstLine(() => assert.strictEqual(a, u));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ['AssertionError ERR_ASSERTION Expected "actual" to be reference-equal to "expected":', ""].join("\n"),
  );
});

test("notStrictEqual failing (same reference) renders the NOT-REFERENCE-EQUAL header", async () => {
  const path = await build("notrefeq.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "const a = Buffer.from([1, 2, 3]);",
    "firstLine(() => assert.notStrictEqual(a, a));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ['AssertionError ERR_ASSERTION Expected "actual" not to be reference-equal to "expected":', ""].join("\n"),
  );
});

test("deepStrictEqual failing over Buffer content renders the DEEP-EQUAL header (bytesDeepEq path)", async () => {
  const path = await build("deepfail-bytes.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "const a = Buffer.from([1, 2, 3]);",
    "const c = Buffer.from([1, 2, 4]);",
    "firstLine(() => assert.deepStrictEqual(a, c));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["AssertionError ERR_ASSERTION Expected values to be strictly deep-equal:", ""].join("\n"));
});

test("notDeepStrictEqual failing over equal Buffer content renders the NOT-DEEP-EQUAL header", async () => {
  const path = await build("notdeepfail-bytes.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "const a = Buffer.from([1, 2, 3]);",
    "const b = Buffer.from([1, 2, 3]);",
    "firstLine(() => assert.notDeepStrictEqual(a, b));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ['AssertionError ERR_ASSERTION Expected "actual" not to be strictly deep-equal to:', ""].join("\n"),
  );
});

test("custom message overrides the header verbatim, for both refEqBytes and deepResult forms", async () => {
  const path = await build("custommsg.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "const a = Buffer.from([1, 2, 3]);",
    "const b = Buffer.from([1, 2, 3]);",
    "const c = Buffer.from([1, 2, 4]);",
    "firstLine(() => assert.strictEqual(a, c, 'custom words strict'));",
    "firstLine(() => assert.deepStrictEqual(a, c, 'custom words deep'));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "AssertionError ERR_ASSERTION custom words strict",
      "AssertionError ERR_ASSERTION custom words deep",
      "",
    ].join("\n"),
  );
});

test("name/code/message are exact and stable across BOTH strict and deep failure families", async () => {
  const path = await build("namecode.ts", [
    "import assert from 'node:assert';",
    "const a = Buffer.from([1, 2, 3]);",
    "const c = Buffer.from([1, 2, 4]);",
    "try {",
    "  assert.strictEqual(a, c);",
    "} catch (e) {",
    "  if (e instanceof Error) {",
    "    console.log(e.name === 'AssertionError', `${(e as NodeJS.ErrnoException).code}` === 'ERR_ASSERTION');",
    "  }",
    "}",
    "try {",
    "  assert.deepStrictEqual(a, c);",
    "} catch (e) {",
    "  if (e instanceof Error) {",
    "    console.log(e.name === 'AssertionError', `${(e as NodeJS.ErrnoException).code}` === 'ERR_ASSERTION');",
    "  }",
    "}",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["true true", "true true", ""].join("\n"));
});

test("the corpus's own .message.split(\"\\n\")[0] pattern reads the exact header (mirrors 1680 directly)", async () => {
  const path = await build("splitpattern.ts", [
    "import assert from 'node:assert';",
    "const a = Buffer.from([1, 2, 3]);",
    "const c = Buffer.from([1, 2, 4]);",
    "try {",
    "  assert.deepStrictEqual(a, c);",
    "} catch (e) {",
    "  if (e instanceof Error) console.log((e.message.split('\\n')[0]) as string);",
    "}",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["Expected values to be strictly deep-equal:", ""].join("\n"));
});

test("deepStrictEqual over an array of REAL (non-adapter) functions: reference identity per element, independent of board #75", async () => {
  // The generic composite path (deepEqHelper's synthesized %assert.deq.N
  // helper): array length + per-element bin "===" (reference identity
  // for functions — Node's own stance, lower-assert.ts's deepEqHelper
  // "func" case). NEITHER function here ever passes through a
  // listeners()/rawListeners() snapshot, so this exercises deepResult's
  // generic path with zero dependency on board #75's adapter cascade —
  // a standalone control proving the reuse claim (deepEqHelper's
  // pre-existing bin "===" + arrIntrinsic:length machinery) independent
  // of the listeners-snapshot machinery.
  const path = await build("funcarray.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "function f(): void {}",
    "function g(): void {}",
    "assert.deepStrictEqual([f, f], [f, f]);",
    "console.log('equal-pass');",
    "firstLine(() => assert.deepStrictEqual([f], [g]));",
    "firstLine(() => assert.deepStrictEqual([f], [f, g]));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "equal-pass",
      "AssertionError ERR_ASSERTION Expected values to be strictly deep-equal:",
      "AssertionError ERR_ASSERTION Expected values to be strictly deep-equal:",
      "",
    ].join("\n"),
  );
});

test("empty-Buffer deepStrictEqual passes (zero-length content, same brand)", async () => {
  const path = await build("emptybuf.ts", [
    "import assert from 'node:assert';",
    "const e1 = Buffer.alloc(0);",
    "const e2 = Buffer.from([]);",
    "assert.deepStrictEqual(e1, e2);",
    "console.log('empty-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["empty-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

/* ── the 1681 stretch: assert.refEqFn (bare-function strictEqual/
 * notStrictEqual) ────────────────────────────────────────────────────
 * SIMPLER than refEqBytes: no "same structure" branch is possible for
 * functions — deep-equality over functions IS reference identity
 * (deepEqHelper's own `case "func"`), so a strictEqual FAILURE (not-
 * reference-equal) can never also be deep-equal. Measured directly
 * (node v24.18.1, own probe, fresh for this stretch — not inherited
 * from the earlier design-note prediction): strictEqual failing always
 * renders 'Expected "actual" to be reference-equal to "expected":',
 * notStrictEqual failing always renders 'Expected "actual" not to be
 * reference-equal to "expected":'. 1681's own corpus exercises BOTH of
 * those (lines: strictEqual(f,g), notStrictEqual(f,alias)) but NEITHER
 * custom-message form — force-pinned here, Node-measured first. */

test("assert.refEqFn: strictEqual failing renders the REFERENCE-EQUAL header (bare functions, no custom message)", async () => {
  const path = await build("reffn-strict.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "function f(): void {}",
    "function g(): void {}",
    "firstLine(() => assert.strictEqual(f, g));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ['AssertionError ERR_ASSERTION Expected "actual" to be reference-equal to "expected":', ""].join("\n"),
  );
});

test("assert.refEqFn: notStrictEqual failing renders the NOT-REFERENCE-EQUAL header (bare functions, no custom message)", async () => {
  const path = await build("reffn-notstrict.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "function f(): void {}",
    "const alias = f;",
    "firstLine(() => assert.notStrictEqual(f, alias));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ['AssertionError ERR_ASSERTION Expected "actual" not to be reference-equal to "expected":', ""].join("\n"),
  );
});

test("assert.refEqFn custom message: force-pinned (1681 itself never passes one) — overrides both strictEqual and notStrictEqual headers verbatim", async () => {
  const path = await build("reffn-custom.ts", [
    "import assert from 'node:assert';",
    ...FIRST_LINE_HELPER,
    "function f(): void {}",
    "function g(): void {}",
    "const alias = f;",
    "firstLine(() => assert.strictEqual(f, g, 'custom words strict fn'));",
    "firstLine(() => assert.notStrictEqual(f, alias, 'custom words notstrict fn'));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "AssertionError ERR_ASSERTION custom words strict fn",
      "AssertionError ERR_ASSERTION custom words notstrict fn",
      "",
    ].join("\n"),
  );
});

test("assert.refEqFn passes silently when references agree/disagree as expected (positive control, no throw)", async () => {
  const path = await build("reffn-pass.ts", [
    "import assert from 'node:assert';",
    "function f(): void {}",
    "function g(): void {}",
    "const alias = f;",
    "assert.strictEqual(f, alias);",
    "assert.notStrictEqual(f, g);",
    "console.log('reffn-pass-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["reffn-pass-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

/* ── increment 23 P2b: F.2's own "what the six do not reach" list ────────
 * `assert.eqDyn`'s libCall is wired for real as of this pass (D.1-D.9);
 * every scenario below is F.2's own citation of a mechanism the SIX
 * target corpus programs never exercise, each pinned end-to-end through
 * the REAL compiled pipeline (frontend -> `assert.eqDyn`'s libCall ->
 * the dyn assemblers), never a force-emit on the standalone helper —
 * `Assembler` (where `dynEqFailHelper`/`dynNeqFailHelper` live) is
 * deliberately unexported, unlike `DynBuilder`/`InspectBuilder`'s own
 * injectable design, so this compiled-program route is these two
 * helpers' FIRST real test (the lead's own ruling on the checkpoint-2
 * gap). Every literal below was measured directly against live Node
 * v24.18.1 (this pass's own re-run, `scratchpad/inc23/impl-p2b/
 * measure-f2.mjs`) — long, repeated-character values are built via the
 * SAME `.repeat()` calls Node's own oracle run used, not transcribed as
 * giant string literals, so a test failure's diff stays readable and
 * the file stays a reasonable size. */

const SHOW_MSG_HELPER = [
  "const showMsg = (fn: () => void): void => {",
  "  try {",
  "    fn();",
  "    console.log('NO THROW');",
  "  } catch (e) {",
  "    console.log((e as Error).message);",
  "  }",
  "};",
];


test("F.2 renderer: NULL/BOOL/UNDEF as nested values, an empty OBJ, and empty BYTES nested inside a larger diff", async () => {
  // Every operand crosses the `unknown` boundary explicitly (the
  // corpus's own idiom, e.g. 1770/1771's `const dobj: unknown = ...`) —
  // a bare object literal handed straight to assert stays a STATIC
  // type and takes the P1-era static-composite path (deepResult),
  // which is header-only (S054) and never reaches `assert.eqDyn` at
  // all; my own first attempt at this file forgot that and every test
  // silently exercised the WRONG family until re-checked against a
  // small probe.
  //
  // BUFFER-FLAVOUR BYTES (F.2's other citation in this group) is NOT
  // built here: D.9's own text already documents that "the dyn copy
  // cannot carry the Buffer/Uint8Array brand" — own re-confirmation,
  // `const b: unknown = Buffer.from([1,2])` boxes as a PLAIN Uint8Array
  // (`assert.strictEqual(b, b)` on it renders `Uint8Array(2) [`, never
  // `Buffer(2) [Uint8Array] [`), so this rendering form is UNREACHABLE
  // through the checked-dynamic boundary, not merely unbuilt. The
  // brand IS observable through the OTHER (static-composite) family —
  // this file's own EARLIER pins already cover it there (e.g.
  // "different-BRAND operands renders REFERENCE-EQUAL").
  const path = await build("f2-nested-scalars.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const a1: unknown = { a: null, b: true, c: undefined, d: 1 };",
    "const b1: unknown = { a: null, b: true, c: undefined, d: 2 };",
    "showMsg(() => assert.deepStrictEqual(a1, b1));",
    "const a2: unknown = { x: {}, y: 1 };",
    "const b2: unknown = { x: {}, y: 2 };",
    "showMsg(() => assert.deepStrictEqual(a2, b2));",
    "const a3: unknown = { x: new Uint8Array(0), y: 1 };",
    "const b3: unknown = { x: new Uint8Array(0), y: 2 };",
    "showMsg(() => assert.deepStrictEqual(a3, b3));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    a: null,\n    b: true,\n    c: undefined,\n+   d: 1\n-   d: 2\n  }\n",
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    x: {},\n+   y: 1\n-   y: 2\n  }\n",
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    x: Uint8Array(0) [],\n+   y: 1\n-   y: 2\n  }\n",
      "",
    ].join("\n"),
  );
});

test("F.2 renderer: FUNC ANONYMOUS nested (same closure both sides, genuinely un-nameable)", async () => {
  // A null-prototype OBJ pin (F.2's own other citation in this group)
  // is NOT built here: `Object.create(null)` boxed into `unknown`
  // refuses by name today (libCall:dyn.objCreateNullProto, own probe)
  // — an EXISTING wasm-backend gap unrelated to P2b's own scope, not
  // something this pass introduces or should paper over.
  //
  // Getting a genuinely anonymous render took TWO failed attempts:
  // `const fn = (() => () => {})();` keeps `fn.name === ""` in real
  // JS, but tsinter's OWN "best-effort JS name" heuristic (the
  // `coerceInto` convention lower-assert.ts's own `box()` documents)
  // infers a name from the NEAREST enclosing variable BINDING for a
  // function VALUE, not from real ECMA-262 NamedEvaluation — so THAT
  // construction still rendered `[Function: fn]` (a genuine, existing
  // wasm-tier divergence, own finding, not something this pass
  // introduces). Passing the function as a CALL ARGUMENT instead (never
  // bound to any name, anywhere) avoids the heuristic entirely.
  const path = await build("f2-func-anon.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "function identity(x: unknown): unknown { return x; }",
    "const fnU: unknown = identity(() => {});",
    "const a: unknown = { f: fnU, y: 1 };",
    "const b: unknown = { f: fnU, y: 2 };",
    "showMsg(() => assert.deepStrictEqual(a, b));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    f: [Function (anonymous)],\n+   y: 1\n-   y: 2\n  }\n\n",
  );
});

test("F.2 renderer: key rendering forms — quoted-at-top-level, the reserved ['__proto__'] own-property form (JSON.parse's [[DefineOwnProperty]] semantics create a real own property, unlike a plain assignment through the accessor), a $-prefixed key (quoted: keyStrRegExp excludes '$' from its first-char class), and the empty-string key", async () => {
  // Object.defineProperty itself refuses today ('is part of the
  // standard library types but has no scriptc lowering yet', own
  // probe) — JSON.parse is the one construct already proven (by the
  // corpus itself) to cross composite shapes into dyn, and it happens
  // to be the cleanest way to get a genuine '__proto__' OWN property.
  const path = await build("f2-key-forms.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const a1: unknown = { 'a-b': 1, y: 1 };",
    "const b1: unknown = { 'a-b': 1, y: 2 };",
    "showMsg(() => assert.deepStrictEqual(a1, b1));",
    "const a2: unknown = JSON.parse('{\"__proto__\": 1, \"y\": 1}');",
    "const b2: unknown = JSON.parse('{\"__proto__\": 1, \"y\": 2}');",
    "showMsg(() => assert.deepStrictEqual(a2, b2));",
    "const a3: unknown = { $a: 1, y: 1 };",
    "const b3: unknown = { $a: 1, y: 2 };",
    "showMsg(() => assert.deepStrictEqual(a3, b3));",
    "const a4: unknown = { '': 1, y: 1 };",
    "const b4: unknown = { '': 1, y: 2 };",
    "showMsg(() => assert.deepStrictEqual(a4, b4));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    'a-b': 1,\n+   y: 1\n-   y: 2\n  }\n",
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    ['__proto__']: 1,\n+   y: 1\n-   y: 2\n  }\n",
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    '$a': 1,\n+   y: 1\n-   y: 2\n  }\n",
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    '': 1,\n+   y: 1\n-   y: 2\n  }\n",
      "",
    ].join("\n"),
  );
});

test("F.2 renderer: the 10000-unit STR cap (singular and plural 'more character(s)') and the multi-line ' +' split for a string with a REAL embedded newline", async () => {
  // Pure scalars — these reach the dyn assemblers unconditionally via
  // D.9's own boxing shim on `assert.eqStr`'s failure path, no
  // `unknown` annotation needed (the shim boxes AFTER the byte
  // compare, regardless of the operands' own static type).
  const path = await build("f2-str-cap-split.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "showMsg(() => assert.strictEqual('a'.repeat(10000) + 'X', 'a'.repeat(10000) + 'Y'));",
    "showMsg(() => assert.strictEqual('a'.repeat(10002) + 'X', 'a'.repeat(10002) + 'Y'));",
    "showMsg(() => assert.strictEqual('abcdefghij'.repeat(8) + '\\nsecond line here', 'abcdefghij'.repeat(8) + '\\nsecond line HERE'));",
  ]);
  const { stdout } = await runWasm(path);
  const a10000 = "a".repeat(10000);
  const cappedLine = (extra: number): string =>
    `Expected values to be strictly equal:\n+ actual - expected\n\n+ '${a10000}'... ${extra} more character${extra === 1 ? "" : "s"}\n- '${a10000}'... ${extra} more character${extra === 1 ? "" : "s"}\n`;
  expect(stdout).toBe(
    [
      cappedLine(1),
      cappedLine(3),
      `Expected values to be strictly equal:\n+ actual - expected\n\n  '${"abcdefghij".repeat(8)}\\n' +\n+   'second line here'\n-   'second line HERE'\n`,
      "",
    ].join("\n"),
  );
});

test("F.2 renderer: the indent-dependent split threshold (A.3(b)) — 76/77 at top level (indent 0), 74/75 nested one level (indent 1), reached through real assert.strictEqual/deepStrictEqual", async () => {
  const path = await build("f2-indent-split.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    // mkStr(len): a newline sits 6 units from the end, matching the
    // existing P2a cfInspect-level pin's own straddle-probe shape
    // (wasm-assert-dyn.test.ts, "STR arm's indent handoff").
    "const mkStr = (len: number, last: string): string => 'x'.repeat(len - 6) + '\\n' + 'y'.repeat(4) + last;",
    "showMsg(() => assert.strictEqual(mkStr(76, 'A'), mkStr(76, 'B')));",
    "showMsg(() => assert.strictEqual(mkStr(77, 'A'), mkStr(77, 'B')));",
    "const a1: unknown = { s: mkStr(74, 'A') };",
    "const b1: unknown = { s: mkStr(74, 'B') };",
    "showMsg(() => assert.deepStrictEqual(a1, b1));",
    "const a2: unknown = { s: mkStr(75, 'A') };",
    "const b2: unknown = { s: mkStr(75, 'B') };",
    "showMsg(() => assert.deepStrictEqual(a2, b2));",
  ]);
  const { stdout } = await runWasm(path);
  const x76 = "x".repeat(76 - 6);
  const x77 = "x".repeat(77 - 6);
  const x74 = "x".repeat(74 - 6);
  const x75 = "x".repeat(75 - 6);
  expect(stdout).toBe(
    [
      `Expected values to be strictly equal:\n+ actual - expected\n\n+ '${x76}\\nyyyyA'\n- '${x76}\\nyyyyB'\n`,
      `Expected values to be strictly equal:\n+ actual - expected\n\n  '${x77}\\n' +\n+   'yyyyA'\n-   'yyyyB'\n`,
      `Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n+   s: '${x74}\\nyyyyA'\n-   s: '${x74}\\nyyyyB'\n  }\n`,
      `Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    s: '${x75}\\n' +\n+     'yyyyA'\n-     'yyyyB'\n  }\n`,
      "",
    ].join("\n"),
  );
});

test("F.2 renderer: a 10002-unit string whose only newline sits past the 10000-unit cap renders on ONE line (the truncation removes it, not just hides it) — separates 'the rendering spans lines' from 'the input contains a newline'", async () => {
  const path = await build("f2-cap-removes-newline.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const long = 'a'.repeat(10001) + '\\n' + 'b';",
    "showMsg(() => assert.strictEqual(long, long + 'X'));",
  ]);
  const { stdout } = await runWasm(path);
  const a10000 = "a".repeat(10000);
  expect(stdout).toBe(
    `Expected values to be strictly equal:\n+ actual - expected\n\n+ '${a10000}'... 3 more characters\n- '${a10000}'... 4 more characters\n\n`,
  );
  // The defining property: neither quoted line contains a literal '\n'
  // (byte 0x0a) — the newline sits past the cap and is truncated away,
  // so this took the SIMPLE assembler (one line each), never myers.
  // (7, not 6: console.log's OWN trailing "\n" adds one more split
  // element beyond the message's own 5 embedded "\n"s — a first
  // attempt at this pin miscounted by exactly this.)
  expect(stdout.split("\n").length).toBe(7);
});

test("F.2 renderer: number corners (Infinity/-Infinity/NaN/1e+21/5e-324) inside a real deepStrictEqual failure, and the UTF-16 code-UNIT sort axis (E-4: U+10000's surrogate pair sorts before U+FF01 under strCmpU16, the opposite of a code-point compare)", async () => {
  // Depth elision (F.2's other citation in this group, all four forms)
  // is NOT re-pinned end-to-end here: the existing P2a pins already
  // cover it thoroughly at the cfInspect level, BOTH spec-derived (a
  // wasm-built 1002-level chain) AND cross-checked against real Node
  // under a raised stack size at the true n=1000/1001 boundary
  // (wasm-assert-dyn.test.ts). Building an equivalent through a
  // LOOP-CONSTRUCTED 1002-level `unknown` chain would just re-hit
  // S057's own documented default-stack unreachability on NODE'S side
  // too, for zero additional confidence over what already exists.
  const path = await build("f2-corners.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const a1: unknown = { a: Infinity, b: -Infinity, c: NaN, d: 1e21, e: 5e-324, z: 1 };",
    "const b1: unknown = { a: Infinity, b: -Infinity, c: NaN, d: 1e21, e: 5e-324, z: 2 };",
    "showMsg(() => assert.deepStrictEqual(a1, b1));",
    "const a2: unknown = { '！': 1, '\u{10000}': 2, z: 1 };",
    "const b2: unknown = { '！': 1, '\u{10000}': 2, z: 2 };",
    "showMsg(() => assert.deepStrictEqual(a2, b2));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    a: Infinity,\n    b: -Infinity,\n    c: NaN,\n    d: 1e+21,\n    e: 5e-324,\n+   z: 1\n-   z: 2\n  }\n",
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n    '\u{10000}': 2,\n    '！': 1,\n+   z: 1\n-   z: 2\n  }\n",
      "",
    ].join("\n"),
  );
});

test("F.2 comparison: BYTES payload identity under SameValue (two crossings of ONE Uint8Array are ===, the S014 amendment's assert-side face) and the null-prototype gate", async () => {
  // The Buffer-vs-Uint8Array brand gate is NOT pinned here: own
  // re-confirmation that `const buf: unknown = Buffer.from([1,2])`
  // boxes as a PLAIN Uint8Array through the dyn boundary (D.9's own
  // "the dyn copy cannot carry the Buffer/Uint8Array brand" —
  // `assert.deepStrictEqual(buf, new Uint8Array([1,2]))` here does NOT
  // throw, confirming the brand is genuinely unobservable this way,
  // not merely un-pinned).
  const path = await build("f2-comparison-gates.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const u: unknown = new Uint8Array([1, 2]);",
    "showMsg(() => assert.strictEqual(u, u));",
    "const np: unknown = JSON.parse('{\"k\":1}');",
    // A genuine null-prototype OBJECT cannot be constructed and boxed
    // today (libCall:dyn.objCreateNullProto refuses) — this sub-case
    // instead pins the OTHER half of the SAME gate: two structurally
    // IDENTICAL plain objects still compare deep-equal, confirming the
    // null-proto check is a GATE alongside content equality, not a
    // replacement for it (the corpus's own dobj/dobj2 precedent).
    "const np2: unknown = JSON.parse('{\"k\":1}');",
    "showMsg(() => assert.deepStrictEqual(np, np2));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["NO THROW", "NO THROW", ""].join("\n"));
});

test("F.2 comparison: the cycle memo — structurally-equal self-cycles PASS deepStrictEqual silently (the coinductive step is real, not just non-crashing)", async () => {
  const path = await build("f2-cycle-pass.ts", [
    "import assert from 'node:assert';",
    "const a: Record<string, unknown> = { x: 1 };",
    "a.self = a;",
    "const b: Record<string, unknown> = { x: 1 };",
    "b.self = b;",
    "const au: unknown = a;",
    "const bu: unknown = b;",
    "assert.deepStrictEqual(au, bu);",
    "console.log('cycle-pass-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["cycle-pass-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("F.2 assembler: the notIdentical >50-line collapse (the first 50 SPLIT elements — including the opening brace — then a literal '...}', the SIX never build an object this large) and the neq family's own >50 collapse (res[46] REPLACED by '...', truncated to 47 elements, the ORIGINAL closing brace dropped entirely)", async () => {
  const path = await build("f2-notident-neq-50.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const mk = (): unknown => {",
    "  const o: Record<string, number> = {};",
    "  for (let i = 0; i < 55; i++) o['k' + i] = i;",
    "  return o;",
    "};",
    "const a1 = mk();",
    "const a2 = mk();",
    "showMsg(() => assert.strictEqual(a1, a2));",
    "showMsg(() => assert.notDeepStrictEqual(mk(), mk()));",
  ]);
  const { stdout } = await runWasm(path);
  // Node's own key sort here is lexicographic over the ENTRY TEXT
  // ("k0: 0" vs "k10: 10" vs "k1: 1" — '0' < ':' so k10 sorts before
  // k1: F.3's own "compare keys instead of entry texts" mutation row
  // targets exactly this ordering) — extracted programmatically from
  // this pass's own `measure-f2.mjs` run against live Node rather than
  // hand-derived (a first attempt at re-deriving the order by formula
  // miscounted twice; this is the literal, parsed order).
  const num = (k: string): number => Number(k.slice(1));
  const notIdentKeys = [
    "k0", "k10", "k11", "k12", "k13", "k14", "k15", "k16", "k17", "k18", "k19", "k1", "k20", "k21", "k22",
    "k23", "k24", "k25", "k26", "k27", "k28", "k29", "k2", "k30", "k31", "k32", "k33", "k34", "k35", "k36",
    "k37", "k38", "k39", "k3", "k40", "k41", "k42", "k43", "k44", "k45", "k46", "k47", "k48", "k49", "k4",
    "k50", "k51", "k52", "k53",
  ]; // 49 entries — the opening "{" is the split's own element 0, so 1+49=50 elements sliced.
  const neqKeys = notIdentKeys.slice(0, 45); // res[0]="{", res[1..45]=these 45, res[46]="..." (47 total).
  const notIdentLines = notIdentKeys.map((k) => `  ${k}: ${num(k)},`).join("\n");
  const neqLines = neqKeys.map((k) => `  ${k}: ${num(k)},`).join("\n");
  expect(stdout).toBe(
    [
      `Values have same structure but are not reference-equal:\n\n... Skipped lines\n{\n${notIdentLines}\n...}\n`,
      `Expected "actual" not to be strictly deep-equal to:\n\n{\n${neqLines}\n...\n`,
      "",
    ].join("\n"),
  );
});

test("F.2 assembler: the printer's nopCount===6 and nopCount===7 arms (the six only ever reach <=5 or >=8)", async () => {
  const path = await build("f2-nop67.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    // An array's own opening "[" line is ITSELF a common NOP line
    // before the first element, so nopCount===6 needs only 5 "p"
    // elements (bracket+5=6), and ===7 needs 6 (bracket+6=7) — own
    // re-derivation of the SAME arithmetic the printMyersDiff-level
    // unit pins (wasm-assert-dyn.test.ts) already established; nopCount
    // ==6/==7 un-collapse to their FULL content with no "..." marker at
    // all (skipped stays false for both — only >=8 sets it), matching
    // that same pin's own ground truth.
    // Spread over a dynamic (unknown[]) array literal refuses today
    // ("spread elements... is not supported yet", own probe) — the
    // tail element is appended INSIDE the builder instead.
    "const mkArr = (n: number, tail: string): unknown => {",
    "  const a: string[] = [];",
    "  for (let i = 0; i < n; i++) a.push('p' + i);",
    "  a.push(tail);",
    "  return a;",
    "};",
    "showMsg(() => assert.deepStrictEqual(mkArr(5, 'X'), mkArr(5, 'Y')));",
    "showMsg(() => assert.deepStrictEqual(mkArr(6, 'X'), mkArr(6, 'Y')));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  [\n    'p0',\n    'p1',\n    'p2',\n    'p3',\n    'p4',\n+   'X'\n-   'Y'\n  ]\n",
      "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  [\n    'p0',\n    'p1',\n    'p2',\n    'p3',\n    'p4',\n    'p5',\n+   'X'\n-   'Y'\n  ]\n",
      "",
    ].join("\n"),
  );
});

test("F.2 assembler: expectsErrDyn (D.7, in scope per the brief's own H-1 call — claims nothing in the six but is wired) — positive control only", async () => {
  // Reached ONLY via the "errValue" classification (lower-assert.ts):
  // an error INSTANCE as assert.throws's second argument, NOT a plain
  // `{message, name}` shape literal (that syntax takes a WHOLLY
  // different path — ThrowsShapeKey/assert.throwsMismatch, P1's own
  // machinery, unrelated to expectsErrDyn). A first attempt at this
  // pin used the shape-literal form and silently tested the wrong
  // libCall entirely.
  //
  // The MISMATCH rendering is NOT pinned here: real Node wraps the
  // fallback deepStrictEqual comparison in an object tagged
  // "Comparison" (own measurement: `Comparison {\n  message: '...',\n
  // name: '...'\n}`, not a plain `{`) — a Node-internal detail neither
  // this design's own C reference (`scr_assert_expects_err_dyn`) nor
  // D.7's own citation mentions, and this pass's own implementation
  // does not reproduce (it renders the raw actual/expected objects
  // directly). This is a genuine, newly-found gap; flagged for the
  // register/FINDINGS rather than guessed at with an unverified
  // literal. It costs nothing to the six (D.7's own "claims nothing"),
  // so only the reachable, verified half — the matching case, which
  // must NOT throw — is pinned.
  //
  // A SECOND genuine gap, also own-found: `new TypeError(...)` refuses
  // ("assert.throws with this expected-error shape... has no scriptc
  // lowering yet") — `classifyThrowsExpected`'s own errValue branch
  // (lower-assert.ts) tests `expectedT.className === "%Error"` by
  // EXACT string equality, not `inErrorHierarchy` (the hierarchy-aware
  // helper the SAME file uses one branch up for the "class" form) — so
  // only a BARE `new Error(...)` reaches errValue; any subclass
  // (TypeError/RangeError/...) as the expected VALUE (not as a class
  // reference) falls through to the generic refusal. A pre-existing
  // frontend limitation in a file this pass does not otherwise touch —
  // flagged, not fixed here; `new Error(...)` below stays inside it.
  const path = await build("f2-expectserrdyn.ts", [
    "import assert from 'node:assert';",
    "assert.throws(() => { throw new Error('boom'); }, new Error('boom'));",
    "console.log('expectserrdyn-match-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["expectserrdyn-match-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("F.2 assembler: the caret's 80-unit boundary, both sides (80 -> present, 82 -> absent) — the SUM is of the INSPECTED (quoted) lengths, raw+2 each", async () => {
  const path = await build("f2-caret-80.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const mk = (r: number, last: string): string => 'x'.repeat(r - 1) + last;",
    "showMsg(() => assert.strictEqual(mk(38, 'A'), mk(38, 'B')));",
    "showMsg(() => assert.strictEqual(mk(39, 'A'), mk(39, 'B')));",
  ]);
  const { stdout } = await runWasm(path);
  const x38 = "x".repeat(37);
  const x39 = "x".repeat(38);
  expect(stdout).toBe(
    [
      `Expected values to be strictly equal:\n+ actual - expected\n\n+ '${x38}A'\n- '${x38}B'\n${" ".repeat(x38.length + 3)}^\n`,
      `Expected values to be strictly equal:\n+ actual - expected\n\n+ '${x39}A'\n- '${x39}B'\n`,
      "",
    ].join("\n"),
  );
});

test("F.2 assembler: custom message on both families — the eq family weaves msg-or-readable into the FULL diff (D.1's own getErrorMessage), the neq family BYPASSES the whole assembler on ANY message (even ''), matching real Node's super(String(message)) — the bug this SAME differential caught in dynNeqFailHelper before this freeze", async () => {
  const path = await build("f2-custom-message.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    "const a1: unknown = { a: 1 };",
    "const b1: unknown = { a: 2 };",
    "showMsg(() => assert.deepStrictEqual(a1, b1, 'custom deq'));",
    "const a2: unknown = { a: 1 };",
    "const b2: unknown = { a: 1 };",
    "showMsg(() => assert.notDeepStrictEqual(a2, b2, 'custom ndse'));",
    "const a3: unknown = { a: 1 };",
    "const b3: unknown = { a: 1 };",
    "showMsg(() => assert.notDeepStrictEqual(a3, b3, ''));",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    [
      "custom deq\n+ actual - expected\n\n  {\n+   a: 1\n-   a: 2\n  }\n",
      "custom ndse",
      "",
      "",
    ].join("\n"),
  );
});

test("D.9 scalar routing: the five named shapes (design-p2.txt D.9's own measured citations, re-run this pass) proving eqStr's failure path reaches the SAME dyn assemblers as assert.eqDyn, via the box-and-call shim — not a second, parallel assembler", async () => {
  const path = await build("d9-routing.ts", [
    "import assert from 'node:assert';",
    ...SHOW_MSG_HELPER,
    // Shape 1: a long multi-line string against a SHORT one (asymmetric
    // lengths) — D.9's own first citation.
    "const long = 'abcdefghij'.repeat(8) + '\\nsecond line here';",
    "showMsg(() => assert.strictEqual(long, 'x'));",
    // Shape 2: two long multi-line strings differing in the LAST
    // character only.
    "const longB = 'abcdefghij'.repeat(8) + '\\nsecond line herE';",
    "showMsg(() => assert.strictEqual(long, longB));",
    // Shape 3: notStrictEqual(long, long) — SAME reference, neq family,
    // its own trailing-newline-in-source shape.
    "showMsg(() => assert.notStrictEqual(long, long));",
    // Shape 4: the myers branch with the SKIPPED banner — two 60-line
    // strings differing in the last line.
    "const mk60 = (tail: string): string => {",
    "  const lines: string[] = [];",
    "  for (let i = 0; i < 59; i++) lines.push('line' + i);",
    "  lines.push(tail);",
    "  return lines.join('\\n');",
    "};",
    "const s60a = mk60('line59a');",
    "const s60b = mk60('line59b');",
    "showMsg(() => assert.strictEqual(s60a, s60b));",
    // Shape 5: the neq >50 collapse over a 60-line STRING (same
    // reference, so it takes the neq path with res.n>1 straight
    // through, not the myers branch).
    "showMsg(() => assert.notStrictEqual(s60a, s60a));",
  ]);
  const { stdout } = await runWasm(path);
  const rep8 = "abcdefghij".repeat(8);
  // Shape 4: 5 NOP context lines (line0..line4, first one unindented —
  // it opens the stacked block), then "...", then the last common line
  // (line58) immediately before the +/- pair, under the "... Skipped
  // lines" header marker.
  const shape4 = [
    "Expected values to be strictly equal:",
    "+ actual - expected",
    "... Skipped lines",
    "",
    "  'line0\\n' +",
    "    'line1\\n' +",
    "    'line2\\n' +",
    "    'line3\\n' +",
    "    'line4\\n' +",
    "...",
    "    'line58\\n' +",
    "+   'line59a'",
    "-   'line59b'",
    "",
  ].join("\n");
  // Shape 5: the neq >50 collapse — 46 real lines (line0..line45, first
  // one unindented), then "..." as the 47th, no closing content after.
  const shape5Lines = ["Expected \"actual\" to be strictly unequal to:", ""];
  for (let i = 0; i < 46; i++) shape5Lines.push(`${i === 0 ? "" : "  "}'line${i}\\n' +`);
  shape5Lines.push("...", "");
  const shape5 = shape5Lines.join("\n");
  expect(stdout).toBe(
    [
      `Expected values to be strictly equal:\n+ actual - expected\n\n+ '${rep8}\\n' +\n+   'second line here'\n- 'x'\n`,
      `Expected values to be strictly equal:\n+ actual - expected\n\n  '${rep8}\\n' +\n+   'second line here'\n-   'second line herE'\n`,
      `Expected "actual" to be strictly unequal to:\n\n'${rep8}\\n' +\n  'second line here'\n`,
      shape4,
      shape5,
      "",
    ].join("\n"),
  );
});


/* ── F3-p2b: the eager-argument-order row (rev-23's gate, the memo-rows
 * fix round) — the `assert.eqDyn` libCall case evaluates all six
 * arguments (actual, expected, negated, deep, msg, hasMsg) up front,
 * in IR order, before ever computing `same`. Node's own left-to-right
 * argument evaluation makes the actual/expected order user-observable
 * whenever either operand is a call with a side effect; this pin is
 * the previously-missing instrument for that claim, added this round
 * because the mutation (swapping the two `walkExpr` calls) reddened
 * nothing until this pin existed. */
test("assert.eqDyn: eager argument evaluation is IN ORDER — actual evaluated strictly before expected (side-effecting operands)", async () => {
  const path = await build("eqdyn-eval-order.ts", [
    "import assert from 'node:assert';",
    "const log: string[] = [];",
    "function mk(label: string): unknown {",
    "  log.push(label);",
    "  return { v: 1 };",
    "}",
    "assert.deepStrictEqual(mk('actual'), mk('expected'));",
    "console.log(JSON.stringify(log));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe([JSON.stringify(["actual", "expected"]), ""].join("\n"));
  expect(stderr).toBe("");
});
