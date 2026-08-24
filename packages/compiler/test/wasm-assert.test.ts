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
