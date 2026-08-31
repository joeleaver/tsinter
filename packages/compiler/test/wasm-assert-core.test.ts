/* node:assert (increment 23 P1, board #37's continuation) — durable
 * builder-level pins for the static assert core (emitAssertLibCall's
 * ok/eqF64/eqStr/eqBool/sameValue/deqEnter+Leave/throwsNone/
 * throwsMismatch/unwantedRejection/shapeBegin+Str+End/ifErrorErr+F64+
 * Str+Bool+Dyn). Same pattern as wasm-assert.test.ts (stage D P3's own
 * pin mold): compile REAL TypeScript through the actual frontend+
 * backend, run it through the real abi.ts host (wasm-host.ts), assert
 * against a live-Node-measured shape — mechanism reachability, not a
 * typecheck. Every emitted branch here executes in at least one pin,
 * including branches NONE of the ten P1 corpus claims (1601, 1602,
 * 1603, 1604, 1605, 1609, 1724, 1727, 2285, 2487) reach on their own
 * (plus 2693 and 2694, added by F1/F2) —
 * those are marked "force-pinned" below and Node-measured first (own
 * probes; see plan.txt for the full record, not transcribed from the
 * C comments).
 *
 * Every string literal asserted against Node's own output was measured
 * directly (node v24.18.1, own probes: impl/probe/scalar.mjs, other.mjs,
 * numcaret.mjs, dyncheck.mjs, shapeedge.mjs) before being written here. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-assert-core-"));
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

// The corpus's own messageOf idiom (1602/1603/1724's shared shape):
// catches, returns the message (or a marker when nothing threw).
const MESSAGE_OF_HELPER = [
  "const messageOf = (f: () => void): string => {",
  "  try {",
  "    f();",
  "    return 'DID NOT THROW';",
  "  } catch (e) {",
  "    return e instanceof Error ? e.message : 'not an Error';",
  "  }",
  "};",
];

/* ── assert.ok / assert() / fail() — positive control + every message
 * form ────────────────────────────────────────────────────────────── */

test("assert.ok/assert()/fail(): pass silently, source-text form, custom message, fail defaults", async () => {
  const path = await build("ok-core.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "assert.ok(true, 'never seen');",
    "assert(1 === 1);",
    "console.log('pass-ok');",
    "console.log(JSON.stringify(messageOf(() => assert.ok(false))));",
    "console.log(JSON.stringify(messageOf(() => assert(false))));",
    "console.log(JSON.stringify(messageOf(() => assert.ok(false, 'custom ok msg'))));",
    "console.log(JSON.stringify(messageOf(() => assert.fail())));",
    "console.log(JSON.stringify(messageOf(() => assert.fail('custom fail msg'))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "pass-ok",
      JSON.stringify("The expression evaluated to a falsy value:\n\n  assert.ok(false)\n"),
      JSON.stringify("The expression evaluated to a falsy value:\n\n  assert(false)\n"),
      JSON.stringify("custom ok msg"),
      JSON.stringify("Failed"),
      JSON.stringify("custom fail msg"),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── eqF64 — every branch: short/stacked/caret/suppressed-caret/
 * bothZero/msg-header/msg-empty/negated inline+block/deep header ──── */

test("assert.eqF64: the full scalar-diff battery over numbers", async () => {
  const path = await build("eqf64-core.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(1, 2))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(1111111, 1111112))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(11111111111, 21111111111))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(0, -0))));",
    // The numeric-prefix caret guard (i<la — LIVE for numbers, unlike
    // strings, since a number's inspection has no quote character to
    // break the prefix relationship — a lead correction to this pass's
    // OWN first draft, which mis-scoped "unreachable" to every operand
    // type; own re-measurement, node v24.18.1, matches the lead's exact
    // strings byte for byte).
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(1234567, 12345678))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(12345678, 1234567))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(1, 2, 'custom header'))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(1, 2, ''))));",
    "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual(7, 7))));",
    "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual(123456, 123456))));",
    "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual(1, 1, ''))));",
    "console.log(JSON.stringify(messageOf(() => assert.deepStrictEqual(1, 2))));",
    "console.log(JSON.stringify(messageOf(() => assert.notDeepStrictEqual(123456, 123456))));",
    "assert.strictEqual(0 / 0, 0 / 0);",
    "console.log('nan-pass-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify("Expected values to be strictly equal:\n\n1 !== 2\n"),
      JSON.stringify("Expected values to be strictly equal:\n+ actual - expected\n\n+ 1111111\n- 1111112\n        ^\n"),
      JSON.stringify("Expected values to be strictly equal:\n+ actual - expected\n\n+ 11111111111\n- 21111111111\n"),
      JSON.stringify("Expected values to be strictly equal:\n+ actual - expected\n\n+ 0\n- -0\n"),
      JSON.stringify("Expected values to be strictly equal:\n+ actual - expected\n\n+ 1234567\n- 12345678\n"),
      JSON.stringify(
        "Expected values to be strictly equal:\n+ actual - expected\n\n+ 12345678\n- 1234567\n         ^\n",
      ),
      JSON.stringify("custom header\n\n1 !== 2\n"),
      JSON.stringify("Expected values to be strictly equal:\n\n1 !== 2\n"),
      JSON.stringify('Expected "actual" to be strictly unequal to: 7'),
      JSON.stringify('Expected "actual" to be strictly unequal to:\n\n123456'),
      JSON.stringify(""),
      JSON.stringify("Expected values to be strictly deep-equal:\n\n1 !== 2\n"),
      JSON.stringify('Expected "actual" not to be strictly deep-equal to:\n\n123456'),
      "nan-pass-ok",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── eqStr — the same battery + the quote ladder + a non-ASCII/
 * surrogate-pair axis 1603 never varies ─────────────────────────────── */

test("assert.eqStr: the full scalar-diff battery over strings, plus the quote ladder", async () => {
  const path = await build("eqstr-core.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual('abcdefgh', 'abcdefxy'))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(\"it's\", 'other'))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual('has \"double\"', 'other'))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual('it\\'s \"both\"', 'other'))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual('a\\u{1F600}b', 'a\\u{1F600}c'))));",
    "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual('xyz', 'xyz'))));",
    "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual('wxyz', 'wxyz'))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual('a', 'b', 'custom str header'))));",
    "assert.strictEqual('same', 'same');",
    "console.log('str-pass-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify(
        "Expected values to be strictly equal:\n+ actual - expected\n\n+ 'abcdefgh'\n- 'abcdefxy'\n         ^\n",
      ),
      JSON.stringify('Expected values to be strictly equal:\n\n"it\'s" !== \'other\'\n'),
      JSON.stringify("Expected values to be strictly equal:\n+ actual - expected\n\n+ 'has \"double\"'\n- 'other'\n"),
      JSON.stringify(
        "Expected values to be strictly equal:\n+ actual - expected\n\n+ `it's \"both\"`\n- 'other'\n",
      ),
      JSON.stringify(
        "Expected values to be strictly equal:\n\n'a😀b' !== 'a😀c'\n",
      ),
      JSON.stringify("Expected \"actual\" to be strictly unequal to: 'xyz'"),
      JSON.stringify('Expected "actual" to be strictly unequal to:\n\n\'wxyz\''),
      JSON.stringify("custom str header\n\n'a' !== 'b'\n"),
      "str-pass-ok",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── F2/F-3: the caret's 80-unit LENGTH GATE, straddled ───────────────
 * The caret is emitted only when the two INSPECTED operands' lengths
 * SUM to <=80 (Node's 80-column non-TTY default, emitter.ts's
 * REF_EQ_HEADER-adjacent i32Const(80) gate) — bisected on real Node
 * first (own probe, node v24.18.1): equal-length operands of 38 raw
 * units each (inspected 40, sum 80) keep the caret; 39 raw units each
 * (inspected 41, sum 82) lose it. 81 is not a case — equal operands
 * cannot sum to an odd number. No P1/P1-F1 corpus program reaches this
 * gate at all (1603's longest stacked pair is 16 combined inspected
 * units); gate finding F-3: mutation-check confirmed (widening the
 * gate to 200 leaves all OTHER pins and 1603 green, and turns THIS
 * pin red — evidence in FINDINGS). Difference sits at raw index 3 (the
 * 4th character) so the "shared 3-char prefix" skip never applies. ── */

test("assert.eqStr: the caret's 80-unit length gate straddled at 38 vs 39 raw units (F2/F-3 — previously unpinned)", async () => {
  const pad = (n: number, ch: string): string => ch.repeat(n);
  const path = await build("eqstr-caret-gate.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    `console.log(JSON.stringify(messageOf(() => assert.strictEqual(${JSON.stringify("abc" + "A" + pad(34, "z"))}, ${JSON.stringify("abc" + "B" + pad(34, "z"))}))));`,
    `console.log(JSON.stringify(messageOf(() => assert.strictEqual(${JSON.stringify("abc" + "A" + pad(35, "z"))}, ${JSON.stringify("abc" + "B" + pad(35, "z"))}))));`,
  ]);
  const { stdout, stderr } = await runWasm(path);
  const zz38 = "z".repeat(34);
  const zz39 = "z".repeat(35);
  expect(stdout).toBe(
    [
      JSON.stringify(
        `Expected values to be strictly equal:\n+ actual - expected\n\n+ 'abcA${zz38}'\n- 'abcB${zz38}'\n      ^\n`,
      ),
      JSON.stringify(
        `Expected values to be strictly equal:\n+ actual - expected\n\n+ 'abcA${zz39}'\n- 'abcB${zz39}'\n`,
      ),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── eqBool — the one reachable (short) form, both directions, plus
 * custom message ────────────────────────────────────────────────────── */

test("assert.eqBool: short form only (measured: no bool pair can reach the stacked/caret branch), both directions", async () => {
  const path = await build("eqbool-core.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(true, false))));",
    "console.log(JSON.stringify(messageOf(() => assert.notStrictEqual(true, true))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(true, false, 'bool header'))));",
    "assert.strictEqual(true, true);",
    "assert.notStrictEqual(true, false);",
    "console.log('bool-pass-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify("Expected values to be strictly equal:\n\ntrue !== false\n"),
      JSON.stringify('Expected "actual" to be strictly unequal to: true'),
      JSON.stringify("bool header\n\ntrue !== false\n"),
      "bool-pass-ok",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── eqF64/eqBool's own inspections cannot span lines (des-23 D.9) —
 * checked, not assumed: extreme values whose ToString/literal form
 * might plausibly be long enough to tempt a split gate, none of which
 * actually contain a newline, all landing on the short/simple form
 * exactly like an ordinary pair. If this ever needed a multi-line
 * branch, the two would ALSO need eqStr's sentinel — this pin is what
 * proves they don't. ─────────────────────────────────────────────── */

test("assert.eqF64/eqBool: no operand's inspection can span lines — extreme values still take the plain scalar form (des-23 D.9, checked not assumed)", async () => {
  const path = await build("scalar-no-multiline.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(Infinity, -Infinity))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(0 / 0, 1))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(1e308, 1e-308))));",
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual(true, false))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      // "Infinity"+"-Infinity" is 17 combined units, over the 12-unit
      // budget — stacked, not short (own re-check; no caret since the
      // shared prefix is 0, "I" vs "-").
      JSON.stringify("Expected values to be strictly equal:\n+ actual - expected\n\n+ Infinity\n- -Infinity\n"),
      JSON.stringify("Expected values to be strictly equal:\n\nNaN !== 1\n"),
      JSON.stringify("Expected values to be strictly equal:\n\n1e+308 !== 1e-308\n"),
      JSON.stringify("Expected values to be strictly equal:\n\ntrue !== false\n"),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── eqStr's multi-line-inspection case, POST-P2b (des-23 D.9): what
 * USED to be a named sentinel trap here (P1's own scope, before P2b
 * landed) is GONE — D.9's own boxing shim boxes the failing operand
 * into dyn and calls `dynEqFail`/`dynNeqFail` directly, so a
 * multi-line rendering now produces Node's REAL myers-diff message,
 * uncaught (this test never wraps the call in try/catch, matching
 * 1773's own "simple/stacked, UNCAUGHT, exit 1" shape), not a silent
 * trap. These two pins are the DIRECT DESCENDANTS of the P1-era
 * sentinel pins that lived here (same shapes, same eq/neq split) —
 * updated rather than deleted, since "the trap is GONE, replaced by
 * real rendering" is itself worth a standing regression pin, distinct
 * from wasm-assert.test.ts's own "D.9 scalar routing" pin (which
 * checks the CAUGHT `.message` value directly; these two check the
 * UNCAUGHT stderr path specifically, confirming `emitSetCellError`/
 * `emitUnwind`/`reportUncaughtHelper` all still run normally — nothing
 * about the OLD sentinel's own early-exit survives). ───────────────── */

test("assert.eqStr's multi-line case (eq path), POST-P2b: no longer a trap — a real, uncaught AssertionError with Node's own myers-diff message on stderr, exit non-zero", async () => {
  const path = await build("eqstr-multiline-trap-eq.ts", [
    "import assert from 'node:assert';",
    "const long = 'abcdefghij'.repeat(8) + '\\nsecond line here';",
    "console.log('before-trap');",
    "assert.strictEqual(long, 'x');",
    "console.log('never reached');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["before-trap", ""].join("\n"));
  expect(stderr).toBe(
    "Uncaught AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n+ actual - expected\n\n+ 'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij\\n' +\n+   'second line here'\n- 'x'\n\n",
  );
});

test("assert.eqStr's multi-line case (neq path), POST-P2b: no longer a trap — Node's real inline-vs-block neq form on stderr (E-11's own scope: a multi-line rendering never reaches neqFail's length-based choice, it goes through dynNeqFail instead)", async () => {
  const path = await build("eqstr-multiline-trap-neq.ts", [
    "import assert from 'node:assert';",
    "const long = 'abcdefghij'.repeat(8) + '\\nsecond line here';",
    "console.log('before-neq-trap');",
    "assert.notStrictEqual(long, long);",
    "console.log('never reached');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["before-neq-trap", ""].join("\n"));
  expect(stderr).toBe(
    "Uncaught AssertionError [ERR_ASSERTION]: Expected \"actual\" to be strictly unequal to:\n\n'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij\\n' +\n  'second line here'\n\n",
  );
});

test("assert.eqStr's multi-line sentinel: a SHORT string containing a newline stays on the ordinary simple form (under the 16/76-unit split gate — no trap)", async () => {
  const path = await build("eqstr-short-newline-no-trap.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.strictEqual('ab\\ncd', 'x'))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe([JSON.stringify("Expected values to be strictly equal:\n\n'ab\\ncd' !== 'x'\n"), ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.eqStr's multi-line sentinel: the predicate is on the RENDERED text, not the input — a newline past the 10000-unit cap renders on ONE line and must NOT trap (des-23 D.9's own measured distinction)", async () => {
  const path = await build("eqstr-cap-removes-newline.ts", [
    "import assert from 'node:assert';",
    "const long = 'x'.repeat(10001) + '\\ny';",
    "console.log('no-trap-here');",
    "let threw = false;",
    "try { assert.strictEqual(long, 'x'); } catch { threw = true; }",
    "console.log('threw', threw);",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["no-trap-here", "threw true", ""].join("\n"));
  expect(stderr).toBe("");
});

/* ── the deep-equal pair memo — cycle shapes beyond 2487's own four:
 * a longer (3-node) cycle, a shared subtree, unequal cycles of
 * different periods ─────────────────────────────────────────────────── */

test("assert.deqEnter/deqLeave: a 3-node cycle compares equal to a structurally-equal 3-node cycle", async () => {
  const path = await build("deq-longcycle.ts", [
    "import assert from 'node:assert';",
    "interface Node { label: string; next: Node[] }",
    "const a1: Node = { label: 'x', next: [] };",
    "const a2: Node = { label: 'y', next: [] };",
    "const a3: Node = { label: 'z', next: [] };",
    "a1.next.push(a2); a2.next.push(a3); a3.next.push(a1);",
    "const b1: Node = { label: 'x', next: [] };",
    "const b2: Node = { label: 'y', next: [] };",
    "const b3: Node = { label: 'z', next: [] };",
    "b1.next.push(b2); b2.next.push(b3); b3.next.push(b1);",
    "assert.deepStrictEqual(a1, b1);",
    "console.log('longcycle-equal-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["longcycle-equal-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.deqEnter/deqLeave: a SHARED subtree (two branches pointing at the same child) compares equal to its structural twin", async () => {
  const path = await build("deq-shared.ts", [
    "import assert from 'node:assert';",
    "interface Node { label: string; kids: Node[] }",
    "const shared: Node = { label: 'leaf', kids: [] };",
    "const a: Node = { label: 'root', kids: [shared, shared] };",
    "const b1: Node = { label: 'leaf', kids: [] };",
    "const b2: Node = { label: 'leaf', kids: [] };",
    "const b: Node = { label: 'root', kids: [b1, b2] };",
    "assert.deepStrictEqual(a, b);",
    "console.log('shared-equal-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["shared-equal-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

// FIXED (increment 23, all three lanes): a plain "pair currently open
// answers equal" memo — the brief's own first-drafted spec, matching
// scr_assert.c's PRE-fix documented stance — is measurably too
// permissive for cyclic structures: by pigeonhole, any two same-
// labeled finite cycles eventually revisit some already-open pair
// regardless of whether the cycles are isomorphic, so it wrongly
// answers "equal" for EVERY period mismatch. Node's REAL cycle memo
// (lib/internal/util/comparisons.js handleCycles, lifted directly) is
// a SET OF VALUES, not a set of pairs: deqEnter(a,b) now answers a
// 3-way verdict — both a and b already in the set -> EQUAL; EXACTLY
// ONE present -> UNEQUAL (definitive — the arm the old memo lacked
// entirely); neither -> pushes both, walks. All six shapes below
// (1v1/1v2/2v2/2v4/2v3/3v3) are own-measured against real Node
// (v24.18.1) and match exactly — EQUAL only when the periods match,
// THROWN for every mismatch including exact multiples (2v4), not just
// coprime ones (2v3). tests/corpus/2693 pins the SAME six shapes plus
// the shared-subtree case as the three-lane corpus net (C/LLVM/wasm
// all differential-tested against Node); this pin is the wasm-specific
// mechanism check (byte-exact message content is NOT re-verified here
// — 2487 and the eqF64/eqStr batteries already cover the message
// machinery; this is purely about the memo's EQUAL-vs-THREW verdict).
test("assert.deqEnter/deqLeave: Node's REAL set-of-values memo — all six period shapes, EQUAL only when periods match", async () => {
  const ringTs = (n: number, prefix: string): string[] => {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(`const ${prefix}${i}: Node = { label: 'x', next: [] };`);
    for (let i = 0; i < n; i++) lines.push(`${prefix}${i}.next.push(${prefix}${(i + 1) % n});`);
    return lines;
  };
  const shape = (name: string, an: number, bn: number): string[] => [
    ...ringTs(an, `${name}a`),
    ...ringTs(bn, `${name}b`),
    `console.log('${name}', (() => { try { assert.deepStrictEqual(${name}a0, ${name}b0); return 'EQUAL'; } catch { return 'THREW'; } })());`,
  ];
  const path = await build("deq-period-six.ts", [
    "import assert from 'node:assert';",
    "interface Node { label: string; next: Node[] }",
    ...shape("s1v1", 1, 1),
    ...shape("s1v2", 1, 2),
    ...shape("s2v2", 2, 2),
    ...shape("s2v4", 2, 4),
    ...shape("s2v3", 2, 3),
    ...shape("s3v3", 3, 3),
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "s1v1 EQUAL",
      "s1v2 THREW",
      "s2v2 EQUAL",
      "s2v4 THREW",
      "s2v3 THREW",
      "s3v3 EQUAL",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

// The LEAK pin (des-23's own spec): if deqLeave failed to pop, r1 would
// stay marked "present" in the memo FOREVER after the first comparison
// — so a LATER comparison reusing r1 against a FRESH, genuinely
// deep-equal counterpart would find r1 present but its partner absent
// (exactly one present -> the memo's own UNEQUAL verdict), a FALSE
// NEGATIVE the leak specifically causes (not a coincidental correct
// answer, unlike a naive "unrelated objects" version of this pin,
// which this replaced after checking — those never touch the leaked
// entries by reference, so they cannot observe a leak either way).
// Confirmed leak-sensitive by mutation (own check, reverted before
// freeze): disabling deqLeave's decrement makes THIS EXACT pin fail.
test("assert.deqEnter/deqLeave: deqLeave actually pops — a LATER comparison reusing r1 against a fresh, genuinely deep-equal counterpart still answers EQUAL (a leak would make it wrongly throw)", async () => {
  const path = await build("deq-no-leak.ts", [
    "import assert from 'node:assert';",
    "interface Node { label: string; next: Node[] }",
    "const r1: Node = { label: 'x', next: [] };",
    "const r2: Node = { label: 'x', next: [] };",
    "r1.next.push(r2); r2.next.push(r1);",
    "assert.deepStrictEqual(r1, r2);", // pushes+pops r1/r2 normally if deqLeave works
    "console.log('first-ok');",
    "const r4: Node = { label: 'x', next: [] };",
    "const r5: Node = { label: 'x', next: [] };",
    "r4.next.push(r5); r5.next.push(r4);",
    // r1's cycle and r4's cycle are isomorphic (same period, same
    // label) — genuinely deep-equal. A leaked r1 (still "present" from
    // the FIRST comparison) paired with a fresh r4 (never present)
    // trips the memo's "exactly one present -> UNEQUAL" arm wrongly.
    "assert.deepStrictEqual(r1, r4);",
    "console.log('second-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["first-ok", "second-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

/* ── fix round F2: Node's REAL memo is TWO rules, not one ─────────────
 * F1 (above) fixed the plain pair-memo bug but applied the general
 * set-of-values rule from the FIRST comparison — measurably wrong
 * (gate finding F-1): at depth 2 (the immediate child of the top
 * pair), Node is still on its a/b/c/d two-slot fast path and has NOT
 * promoted to a set; it is PAIR semantics against the top pair only.
 * Shapes below are `interface Y { x: Y | null }`; y.x=y (self-cyclic);
 * b={x:y}; a={x:b}; c={x:a} — own-measured against real Node
 * (v24.18.1) and against the reconstructed post-overflow memo trace
 * (lead-probe/table.mjs, spec-check5/6.mjs) since these shapes are
 * short enough that a FRESH node process never overflows; SEMANTICS.md
 * S056 has the full record including where a fresh process would
 * differ. tests/corpus/2693's F2 extension carries the SAME crossed
 * shapes on a direct record field as the three-lane regression net. */

test("assert.deqEnter/deqLeave: crossed depth-2 pair — Node's a/b two-slot fast path WALKS it (both orders), not the general set rule", async () => {
  const path = await build("deq-crossed-d2.ts", [
    "import assert from 'node:assert';",
    "interface Y { x: Y | null }",
    "const m = (p: Y, q: Y): string => { try { assert.deepStrictEqual(p, q); return 'EQUAL'; } catch { return 'THREW'; } };",
    "const y: Y = { x: null };",
    "y.x = y;",
    "const b: Y = { x: y };",
    "const a: Y = { x: b };",
    // depth 1: top=(a,b). depth 2: (a.x,b.x)=(b,y) — b IS top.a's OWN
    // value reused from the OTHER column (b was never top.b); the
    // general set rule (F1) sees "b present, y absent" -> UNEQUAL,
    // wrongly. Node's real depth-2 pair check: b!==top.a(a) and
    // y!==top.b(b) -> falls to "record (c,d), WALK" -> b.x=y vs y.x=y
    // -> y===y -> EQUAL. Node-measured (own probe): EQUAL both orders.
    "console.log('a-vs-b', m(a, b));",
    "console.log('b-vs-a', m(b, a));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["a-vs-b EQUAL", "b-vs-a EQUAL", ""].join("\n"));
  expect(stderr).toBe("");
});

// CORRECTED (rev-23's post-verdict addendum, P-d): the FIRST attempt at
// this pin (a self-cyclic RIGHT operand paired with an aTop whose OWN
// child was a plain non-cyclic leaf) was a duplicate-in-spirit bug of a
// different kind than named below — it resolved via a trivial
// null-vs-object type mismatch one level down the walk, so it would
// have stayed green even with the b-hit shortcut removed entirely (a
// pin named for an arm it does not reach is worse than none). The
// GENUINE `val2===top.b` arm (Node: `if (memos.b === val2) return
// false`) needs the depth-2 pair's SECOND slot to be the depth-1 RIGHT
// value itself (b self-cyclic, b.x===b) and its FIRST slot to be
// something else entirely — reused verbatim from rev/probe/val2.ts.
// Both rows here and the val1===a-mismatch row AGREE across Node and
// every lane in BOTH of Node's own modes (rev-23's table) — this is a
// REGRESSION NET, not a disagreement F2 fixes.
test("assert.deqEnter/deqLeave: the genuine depth-2 val2===top.b arm and the val1===top.a-mismatch arm (regression net, not a fix target)", async () => {
  const path = await build("deq-val2.ts", [
    "import assert from 'node:assert';",
    "interface Y { x: Y | null }",
    "const vy = (p: Y, q: Y): string => { try { assert.deepStrictEqual(p, q); return 'EQUAL'; } catch { return 'THREW'; } };",
    // val2===top.b: b self-cyclic (b.x===b); a's child z is a fresh,
    // unrelated leaf. depth 2 pair for a-vs-b is (z,b): z!==top.a(a)
    // (a-hit fails), b===top.b(b) (b-hit fires) -> UNEQUAL, without
    // ever walking z vs b.
    "{ const b: Y = { x: null }; b.x = b; const z: Y = { x: null }; const a: Y = { x: z };",
    "  console.log('val2-eq-b a-vs-b', vy(a, b));",
    "  console.log('val2-eq-b b-vs-a', vy(b, a)); }",
    // val1===top.a, mismatch: a self-cyclic (a.x===a); b's child w is a
    // fresh, unrelated leaf. depth 2 pair for a-vs-b is (a,w): a===top.a
    // (a-hit fires), w!==top.b(b) -> UNEQUAL.
    "{ const a: Y = { x: null }; a.x = a; const w: Y = { x: null }; const b: Y = { x: w };",
    "  console.log('val1-eq-a mismatch a-vs-b', vy(a, b)); }",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["val2-eq-b a-vs-b THREW", "val2-eq-b b-vs-a THREW", "val1-eq-a mismatch a-vs-b THREW", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

// MUST-STAY-THREW (lead refinement, rev-23's colA.ts against the
// option-A column): the crossed depth-3 pair — c={x:a} — already
// answers THREW on all three lanes on the frozen tree and MUST STAY
// THREW under F2 — an over-correction that flips it green is itself a
// bug (SEMANTICS.md S056's own registered divergence: Node's POST-
// overflow behavior agrees THREW; only a truly FRESH Node process,
// unreachable by a deterministic port, answers EQUAL here — S056's
// table has both). This is ALSO the "depth ≥3, exactly-one-present ->
// UNEQUAL" arm the brief requires pinned: promotion seeds the set with
// {top.a, top.b, mid.a, mid.b} — traced exactly (spec-check6.mjs,
// re-run for this pass): for c-vs-a the seed is {a:c b:a c:a d:b},
// giving set={c,a,b}, and the depth-3 pair (b,y) has b present, y
// absent -> UNEQUAL, matching what this pin measures end to end.
test("assert.deqEnter/deqLeave: crossed depth-3 pair — this tier's memo-always choice answers UNEQUAL (SEMANTICS.md S056's registered divergence from a fresh Node process), matching Node's OWN post-overflow behavior", async () => {
  const path = await build("deq-crossed-d3.ts", [
    "import assert from 'node:assert';",
    "interface Y { x: Y | null }",
    "const m = (p: Y, q: Y): string => { try { assert.deepStrictEqual(p, q); return 'EQUAL'; } catch { return 'THREW'; } };",
    "const y: Y = { x: null };",
    "y.x = y;",
    "const b: Y = { x: y };",
    "const a: Y = { x: b };",
    "const c: Y = { x: a };",
    "console.log('c-vs-a', m(c, a));",
    "console.log('a-vs-c', m(a, c));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["c-vs-a THREW", "a-vs-c THREW", ""].join("\n"));
  expect(stderr).toBe("");
});

// PRESERVE, not build (lead refinement): the property already holds on
// the frozen (pre-F2) tree — scr_assert.c's own invariant is that the
// emitted walks cannot throw mid-compare (the verdict is computed in
// full, THEN the assert libCall raises), which makes leak-free-across-
// a-throw true by construction, independent of F2's own fix. Pinned
// here (not merely asserted) with the SHARPER shape (rev/probe/
// stale.ts, own re-measurement byte-identical to Node): rows 2/3 reuse
// the FAILED comparison's OWN operands (not fresh, unrelated ones) —
// the sharp case, since a leaked frame would make a2/a4 wrongly
// "present" against a genuinely fresh, equal partner.
test("assert.deqEnter/deqLeave: a THROWN cyclic comparison leaves NO stale memo state — reusing the FAILED comparison's own operands afterward, the sharp case (property preserved, not newly built by F2)", async () => {
  const path = await build("deq-stale-state.ts", [
    "import assert from 'node:assert';",
    "interface N { label: string; next: N[] }",
    "const ring = (n: number, label: string): N => {",
    "  const nodes: N[] = [];",
    "  for (let i = 0; i < n; i++) nodes.push({ label, next: [] });",
    "  for (let i = 0; i < n; i++) nodes[i]!.next.push(nodes[(i + 1) % n]!);",
    "  return nodes[0]!;",
    "};",
    "const v = (p: N, q: N): string => { try { assert.deepStrictEqual(p, q); return 'EQUAL'; } catch { return 'THREW'; } };",
    "const a2 = ring(2, 'x');",
    "const a4 = ring(4, 'x');",
    "console.log('1 throwing-cyclic 2v4', v(a2, a4));",
    "const b2 = ring(2, 'x');",
    "console.log('2 reuse-after-throw a2-vs-fresh2', v(a2, b2));",
    "const c4 = ring(4, 'x');",
    "console.log('3 reuse-after-throw a4-vs-fresh4', v(a4, c4));",
    "console.log('4 unrelated-after-throw', v(ring(3, 'z'), ring(3, 'z')));",
    "console.log('5 repeat-original 2v4', v(a2, a4));",
    "const d1 = ring(2, 'x');",
    "const d2 = ring(2, 'y');",
    "console.log('6 content-mismatch-throw', v(d1, d2));",
    "console.log('7 reuse-after-content-throw', v(d1, ring(2, 'x')));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "1 throwing-cyclic 2v4 THREW",
      "2 reuse-after-throw a2-vs-fresh2 EQUAL",
      "3 reuse-after-throw a4-vs-fresh4 EQUAL",
      "4 unrelated-after-throw EQUAL",
      "5 repeat-original 2v4 THREW",
      "6 content-mismatch-throw THREW",
      "7 reuse-after-content-throw EQUAL",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── fix round F3 (gate re-cert R-1/R-2/R-3): a SECOND route into
 * S056's divergence class — a SIBLING's promotion, not nesting depth —
 * plus the depth-2 SET-POP, previously live and correct but entirely
 * unpinned (removing it left all 28 pins above green). `interface T {
 * p: T | null; q: T | null }` puts BOTH siblings at depth 2 (immediate
 * children of one top pair) — the T-TYPED fields (the SAME type as the
 * top record, not an unrelated type) are what make the depth-2 PAIR
 * arms (`val1===memos.a`/`val2===memos.b`) reachable at all; an
 * earlier probe typed the fields as a DIFFERENT record type and its six
 * shapes could not reach either arm by construction (disclosed in
 * FINDINGS as P-e — own re-derivation, not the probe's numbers). ── */

test("assert.deqEnter/deqLeave: SIBLING shape B, both orders — an earlier SIBLING's own promotion (not nesting depth) reaches the same divergence class as crossed-depth-3 (SEMANTICS.md S056's sibling-B row, must-stay-THREW under option A)", async () => {
  const path = await build("deq-sib-b.ts", [
    "import assert from 'node:assert';",
    "interface RingNode { label: string; next: RingNode[] }",
    "function ring(n: number): RingNode {",
    "  const nodes: RingNode[] = [];",
    "  for (let i = 0; i < n; i++) nodes.push({ label: 'x', next: [] });",
    "  for (let i = 0; i < n; i++) nodes[i]!.next.push(nodes[(i + 1) % n]!);",
    "  return nodes[0]!;",
    "}",
    "try { assert.deepStrictEqual(ring(2), ring(4)); } catch {}", // primer: forces this tier's own deterministic memo-always path to be exercised consistently with Node's post-overflow column, matching 2694's own corpus ordering
    "interface T { p: T | null; q: T | null }",
    "const m = (a: T, b: T): string => { try { assert.deepStrictEqual(a, b); return 'EQUAL'; } catch { return 'THREW'; } };",
    "const leaf = (): T => ({ p: null, q: null });",
    "const deep = (): T => ({ p: leaf(), q: null });",
    // sibling 1 is one level deeper here than shape A below, so ITS OWN
    // walk (the "p" field pair) reaches depth 3 and promotes the set;
    // sibling 2's pair (the "q" field pair, (tb, w)) then meets the SET
    // rule instead of the depth-2 PAIR rules that shape A reaches.
    "const w: T = { p: deep(), q: null };",
    "w.q = w;",
    "const tb: T = { p: deep(), q: w };",
    "const ta: T = { p: deep(), q: tb };",
    "console.log('B a-vs-b', m(ta, tb));",
    "console.log('B b-vs-a', m(tb, ta));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["B a-vs-b THREW", "B b-vs-a THREW", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.deqEnter/deqLeave: sibling shapes A/C/D/E — regression net (a shallow sibling, no sibling at all, and both depth-2 pair arms reached via a sibling all agree across Node's two modes and every lane already)", async () => {
  const path = await build("deq-sib-acde.ts", [
    "import assert from 'node:assert';",
    "interface RingNode { label: string; next: RingNode[] }",
    "function ring(n: number): RingNode {",
    "  const nodes: RingNode[] = [];",
    "  for (let i = 0; i < n; i++) nodes.push({ label: 'x', next: [] });",
    "  for (let i = 0; i < n; i++) nodes[i]!.next.push(nodes[(i + 1) % n]!);",
    "  return nodes[0]!;",
    "}",
    "try { assert.deepStrictEqual(ring(2), ring(4)); } catch {}",
    "interface T { p: T | null; q: T | null }",
    "const m = (a: T, b: T): string => { try { assert.deepStrictEqual(a, b); return 'EQUAL'; } catch { return 'THREW'; } };",
    "const leaf = (): T => ({ p: null, q: null });",
    // A: sibling 1 (the "p" pair) stays SHALLOW — never reaches depth 3,
    // never promotes — so sibling 2's pair meets the depth-2 PAIR rules
    // and WALKS, the same pair shape B's set rule instead intercepts.
    "{ const w: T = { p: leaf(), q: null }; w.q = w;",
    "  const tb: T = { p: leaf(), q: w }; const ta: T = { p: leaf(), q: tb };",
    "  console.log('A sib1-shallow  sib2=(tb,w)', m(ta, tb)); }",
    // C: the plain crossed-depth-2 shape with no first sibling at all
    // (a single-field record) — the control neither shape reaches.
    "{ const w: T = { p: null, q: null }; w.q = w;",
    "  const tb: T = { p: null, q: w }; const ta: T = { p: null, q: tb };",
    "  console.log('C no-sibling    sib=(tb,w) ', m(ta, tb)); }",
    // D: reaches val1===memos.a directly via a sibling — both operands
    // self-cyclic on their own "q" field.
    "{ const ta: T = { p: leaf(), q: null }; ta.q = ta;",
    "  const tb: T = { p: leaf(), q: null }; tb.q = tb;",
    "  console.log('D val1-eq-a arm, both self ', m(ta, tb)); }",
    // E: reaches val2===memos.b via a sibling — tb self-cyclic, ta's own
    // "q" field a fresh, non-cyclic leaf.
    "{ const ta: T = { p: leaf(), q: leaf() };",
    "  const tb: T = { p: leaf(), q: null }; tb.q = tb;",
    "  console.log('E val2-eq-b arm via sibling', m(ta, tb)); }",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "A sib1-shallow  sib2=(tb,w) EQUAL",
      "C no-sibling    sib=(tb,w)  EQUAL",
      "D val1-eq-a arm, both self  EQUAL",
      "E val2-eq-b arm via sibling THREW",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

// R-2: the depth-2 SET-POP (Node: `set.delete(memos.c); set.delete(
// memos.d)` on depth-2 exit) is a LIVE, correctly-implemented mechanism
// with NO pin anywhere above — removing it (own mutation check) leaves
// ALL 28 P1/F1/F2 pins green. u/v/y are distinct but structurally equal
// T's, deep enough that comparing (u,v) reaches depth 3 and promotes;
// sibling 2's pair reuses sibling 1's OWN operand (u) against a FRESH
// twin (y) — WITH the pop, u is no longer in the set by the time
// sibling 2 is checked (WALK, u~y structurally equal, EQUAL); WITHOUT
// it, u is still "present" (exactly one -> wrongly UNEQUAL). The
// no-promotion control (shallow siblings, set never created) must stay
// EQUAL under BOTH the clean code and the mutation — it never reaches
// the arm being tested.
test("assert.deqEnter/deqLeave: the depth-2 SET-POP (Node's set.delete(c,d) on depth-2 exit) — two pop-observable rows plus a no-promotion control", async () => {
  const path = await build("deq-sib4-pop.ts", [
    "import assert from 'node:assert';",
    "interface T { p: T | null; q: T | null }",
    "const m = (a: T, b: T): string => { try { assert.deepStrictEqual(a, b); return 'EQUAL'; } catch { return 'THREW'; } };",
    "const leaf = (): T => ({ p: null, q: null });",
    "const deep = (): T => ({ p: leaf(), q: null });",
    "{ const u = deep(); const v = deep(); const y = deep();",
    "  console.log('pop-observable  ta{p:u,q:u} vs tb{p:v,q:y}', m({ p: u, q: u }, { p: v, q: y })); }",
    "{ const u = deep(); const v = deep(); const y = deep();",
    "  console.log('pop-observable  mirrored                  ', m({ p: u, q: y }, { p: v, q: v })); }",
    "{ const u = leaf(); const v = leaf(); const y = leaf();",
    "  console.log('no-promotion control (shallow siblings)   ', m({ p: u, q: u }, { p: v, q: y })); }",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "pop-observable  ta{p:u,q:u} vs tb{p:v,q:y} EQUAL",
      "pop-observable  mirrored                   EQUAL",
      "no-promotion control (shallow siblings)    EQUAL",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── S056's REAL memo matrix, end to end through COMPILED `assert.eqDyn`
 * programs (increment 23 P2b, the memo-rows ruling) — the P-3 debt from
 * P2a's own gate: every static-side shape above is ALSO ported here as
 * plain, UNTYPED `.cjs` objects (dyn-native from birth, never crossing
 * a static-to-dyn boundary — a `w.q = w` field write on a STATIC TS
 * variable REBOXES per S014 and never builds a genuine cycle, confirmed
 * this pass; the false-premise pins built on that mistake were deleted,
 * not fixed — see FINDINGS), routed through `deepEqDyn`'s SHARED
 * deqEnter/deqLeave state machine (dyn.ts: "the dyn walk wants the
 * IDENTICAL coinductive step — no second memo").
 *
 * THE COMPLEMENTARY-ASSERTION CONSTRUCTION (Lead's ruling, 2026-08-30):
 * S058's cycle trap only fires on the RENDER path, which only runs on a
 * FAILING comparison — so every row below is observed through the
 * assertion that PASSES SILENTLY for that row's own verdict: an UNEQUAL
 * row uses `assert.notDeepStrictEqual` (Node — and this tier — pass
 * without ever rendering); an EQUAL row uses `assert.deepStrictEqual`.
 * Under the INVERTED-ARMS mutation below (deqEnterHelper's five
 * f64Const(1)/f64Const(2) verdict sites swapped), every verdict flips,
 * the now-WRONG complementary assertion FAILS, the renderer runs, and
 * S058's cycle trap fires — reddening every row BY NAME (a non-zero
 * exit plus the S058 diagnostic on stderr, not a bare `unreachable`).
 *
 * TWO CONSTRUCTION HAZARDS FOUND BUILDING THESE (own re-derivation,
 * neither a divergence — board #109 covers the first as a REGISTERED
 * finding, the second is this pin file's own mistake, not tsinter's):
 *   (a) a RING built via an array of nodes plus a cross-assignment
 *       loop (`nodes[i].next = nodes[(i+1)%n]`) — OR even a plain
 *       object-field ring wrapped in a FUNCTION that RETURNS it —
 *       misinfers the node's own static shape and throws a boundary
 *       TypeError crossing into `assert`'s `unknown` parameters ("a
 *       value narrowed or asserted past it still held it"); avoided
 *       throughout by building every ring as INLINE, top-level (or
 *       block-scoped, never function-scoped) `const` declarations.
 *   (b) MULTIPLE, INDEPENDENTLY-CONSTRUCTED cyclic shapes in ONE
 *       compiled program corrupt each OTHER's inferred type even when
 *       neither alone is a ring at all (confirmed: two unrelated
 *       `{x:null}` self-loops in one file fail the same way) — every
 *       row below is therefore its OWN compiled program; rows that
 *       share ONE already-built chain (crossed-d2/d3 reusing the same
 *       y/b/a/c) coexist fine, confirming the hazard is INDEPENDENT
 *       construction sites, not object count.
 *
 * A third, unrelated hazard (accidentally SHARING one leaf object
 * across sibling-B's three "deep" copies short-circuits the walk via
 * reference equality before it ever reaches the promoting depth) was
 * caught and fixed in this file's own construction, not tsinter's. */

test("assert.eqDyn memo row: period 1-vs-2 (UNEQUAL family) — notDeepStrictEqual passes silently, no render", async () => {
  const path = await build("memo-period-1v2.cjs", [
    "const assert = require('node:assert');",
    "const a0 = { x: null }; a0.x = a0;",
    "const b0 = { x: null }; const b1 = { x: null };",
    "b0.x = b1; b1.x = b0;",
    "assert.notDeepStrictEqual(a0, b0);",
    "console.log('period-1v2-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["period-1v2-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.eqDyn memo row: period 2-vs-4 (UNEQUAL family) — notDeepStrictEqual passes silently, no render", async () => {
  const path = await build("memo-period-2v4.cjs", [
    "const assert = require('node:assert');",
    "const b0 = { x: null }; const b1 = { x: null };",
    "b0.x = b1; b1.x = b0;",
    "const d0 = { x: null }; const d1 = { x: null }; const d2 = { x: null }; const d3 = { x: null };",
    "d0.x = d1; d1.x = d2; d2.x = d3; d3.x = d0;",
    "assert.notDeepStrictEqual(b0, d0);",
    "console.log('period-2v4-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["period-2v4-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.eqDyn memo row: period 2-vs-3 (UNEQUAL family) — notDeepStrictEqual passes silently, no render", async () => {
  const path = await build("memo-period-2v3.cjs", [
    "const assert = require('node:assert');",
    "const b0 = { x: null }; const b1 = { x: null };",
    "b0.x = b1; b1.x = b0;",
    "const c0 = { x: null }; const c1 = { x: null }; const c2 = { x: null };",
    "c0.x = c1; c1.x = c2; c2.x = c0;",
    "assert.notDeepStrictEqual(b0, c0);",
    "console.log('period-2v3-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["period-2v3-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.eqDyn memo row: period-match, 2-vs-2 (EQUAL family) — deepStrictEqual passes silently, no render", async () => {
  const path = await build("memo-period-match.cjs", [
    "const assert = require('node:assert');",
    "const e0 = { x: null }; const e1 = { x: null };",
    "e0.x = e1; e1.x = e0;",
    "const f0 = { x: null }; const f1 = { x: null };",
    "f0.x = f1; f1.x = f0;",
    "assert.deepStrictEqual(e0, f0);",
    "console.log('period-match-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["period-match-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.eqDyn memo row: crossed depth-2 (EQUAL, both orders) and crossed depth-3 (UNEQUAL, both orders) — the SAME y/b/a/c chain S056 measures", async () => {
  const path = await build("memo-crossed.cjs", [
    "const assert = require('node:assert');",
    "const y = { x: null }; y.x = y;",
    "const b = { x: y };",
    "const a = { x: b };",
    "const c = { x: a };",
    "assert.deepStrictEqual(a, b);",
    "console.log('crossed-d2-a-vs-b-ok');",
    "assert.deepStrictEqual(b, a);",
    "console.log('crossed-d2-b-vs-a-ok');",
    "assert.notDeepStrictEqual(c, a);",
    "console.log('crossed-d3-c-vs-a-ok');",
    "assert.notDeepStrictEqual(a, c);",
    "console.log('crossed-d3-a-vs-c-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "crossed-d2-a-vs-b-ok",
      "crossed-d2-b-vs-a-ok",
      "crossed-d3-c-vs-a-ok",
      "crossed-d3-a-vs-c-ok",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("assert.eqDyn memo row: SIBLING shape B, both orders (UNEQUAL family) — an earlier sibling's OWN nesting promotes the set (no primer needed: this tier's memo runs unconditionally, SEMANTICS.md S056)", async () => {
  const path = await build("memo-sib-b.cjs", [
    "const assert = require('node:assert');",
    "const leafW = { p: null, q: null }; const deepW = { p: leafW, q: null };",
    "const w = { p: deepW, q: null }; w.q = w;",
    "const leafTb = { p: null, q: null }; const deepTb = { p: leafTb, q: null };",
    "const tb = { p: deepTb, q: w };",
    "const leafTa = { p: null, q: null }; const deepTa = { p: leafTa, q: null };",
    "const ta = { p: deepTa, q: tb };",
    "assert.notDeepStrictEqual(ta, tb);",
    "console.log('sibling-B-a-vs-b-ok');",
    "assert.notDeepStrictEqual(tb, ta);",
    "console.log('sibling-B-b-vs-a-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["sibling-B-a-vs-b-ok", "sibling-B-b-vs-a-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.eqDyn memo row: non-promoting SIBLING shape A (EQUAL family) — sibling 1 stays shallow, never promotes", async () => {
  const path = await build("memo-sib-a.cjs", [
    "const assert = require('node:assert');",
    "const leaf1 = { p: null, q: null };",
    "const w = { p: leaf1, q: null }; w.q = w;",
    "const leaf2 = { p: null, q: null };",
    "const tb = { p: leaf2, q: w };",
    "const leaf3 = { p: null, q: null };",
    "const ta = { p: leaf3, q: tb };",
    "assert.deepStrictEqual(ta, tb);",
    "console.log('non-promoting-sibling-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["non-promoting-sibling-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

/* ── assert.throws/rejects: throwsNone (bare/class/shape missing-
 * exception detail forms) and throwsMismatch (with/without a message
 * trailer, and — force-pinned — a custom-message override 1609 never
 * exercises) ─────────────────────────────────────────────────────────── */

test("assert.throwsNone: the missing-exception detail forms (bare, class with displayName, shape with a name key)", async () => {
  const path = await build("throwsnone-core.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => {}))));",
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => {}, RangeError))));",
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => {}, RangeError, 'custom missing'))));",
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => {}, { name: 'TypeError' }))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify("Missing expected exception."),
      JSON.stringify("Missing expected exception (RangeError)."),
      JSON.stringify("Missing expected exception (RangeError): custom missing"),
      JSON.stringify("Missing expected exception (TypeError)."),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("assert.throwsMismatch: with and without an Error-message trailer, plus a force-pinned custom-message override (no P1 claim reaches this branch)", async () => {
  const path = await build("throwsmismatch-core.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError('boom'); }, TypeError))));",
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError(); }, TypeError))));",
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError('boom'); }, TypeError, 'force-pinned custom'))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify(
        'The error is expected to be an instance of "TypeError". Received "RangeError"\n\nError message:\n\nboom',
      ),
      JSON.stringify('The error is expected to be an instance of "TypeError". Received "RangeError"'),
      JSON.stringify("force-pinned custom"),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── assert.unwantedRejection: force-pinned, no P1 claim reaches it ─── */

test("assert.doesNotReject's unwantedRejection: force-pinned (no P1 claim reaches it)", async () => {
  const path = await build("unwanted-rejection.ts", [
    "import assert from 'node:assert';",
    "async function boom(): Promise<void> { throw new RangeError('nope'); }",
    "async function main(): Promise<void> {",
    "  try {",
    "    await assert.doesNotReject(boom(), RangeError, 'custom unwanted');",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log(JSON.stringify(e.message));",
    "  }",
    "  try {",
    "    await assert.doesNotReject(boom(), RangeError);",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log(JSON.stringify(e.message));",
    "  }",
    "}",
    "void main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify("Got unwanted rejection: custom unwanted\nActual message: \"nope\""),
      JSON.stringify('Got unwanted rejection.\nActual message: "nope"'),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

/* ── the shape Comparison diff: shapes beyond 1727's own 2-key
 * mismatch — 1-key name-only, 1-key message-only, 3-key with an
 * ABSENT actual code, and the passing (matches) case ─────────────────── */

test("assert.throws shape Comparison diff: a 1-key name-only mismatch", async () => {
  const path = await build("shape-name-only.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError('boom'); }, { name: 'TypeError' }))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   name: 'RangeError'\n-   name: 'TypeError'\n  }\n",
      ),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("assert.throws shape Comparison diff: a 1-key message-only mismatch", async () => {
  const path = await build("shape-message-only.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError('boom'); }, { message: 'nope' }))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   message: 'boom'\n-   message: 'nope'\n  }\n",
      ),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("assert.throws shape Comparison diff: a 3-key shape with an ABSENT actual code (the 'Comparison {}' collapse's sibling — code has no + counterpart at all)", async () => {
  const path = await build("shape-absent-code.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError('boom'); }, { code: 'ERR_X', message: 'boom', name: 'RangeError' }))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n-   code: 'ERR_X',\n    message: 'boom',\n    name: 'RangeError'\n  }\n",
      ),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("assert.throws shape Comparison diff: a code-only expectation with an ABSENT actual code collapses the actual Comparison to '{}' — and the walk reorders +/- lines (code+name both failing, own probe: +name appears BEFORE -code)", async () => {
  const path = await build("shape-code-only-absent.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError('boom'); }, { code: 'ERR_X' }))));",
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new RangeError('boom'); }, { code: 'ERR_X', name: 'TypeError' }))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n+ Comparison {}\n- Comparison {\n-   code: 'ERR_X'\n- }\n",
      ),
      JSON.stringify(
        "Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   name: 'RangeError'\n-   code: 'ERR_X',\n-   name: 'TypeError'\n  }\n",
      ),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("assert.throws shape: the PASSING case (all expected keys match) never throws", async () => {
  const path = await build("shape-pass.ts", [
    "import assert from 'node:assert';",
    "assert.throws(() => { throw new RangeError('boom'); }, { name: 'RangeError', message: 'boom' });",
    "console.log('shape-pass-ok');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["shape-pass-ok", ""].join("\n"));
  expect(stderr).toBe("");
});

/* ── ifErrorDyn's composite-kind arm: a NAMED, force-pinned runtime
 * trap (P2's job) — real, compilable source (`assert.ifError` over an
 * `unknown`-typed array), not a hand-built dyn box (unlike the
 * genuinely-unconstructible HANDLE/JSVAL precedent). Everything BEFORE
 * the trap prints normally; the trap itself is the tier's exit-1
 * channel, `runWasmToTrap`. ────────────────────────────────────────── */

test("assert.ifErrorDyn's composite-kind (ARR) arm: a bare, deliberately silent sentinel trap (P2b's compact:false renderer's job), force-pinned via runWasmToTrap — everything before it still runs", async () => {
  const path = await build("iferrordyn-composite-trap.ts", [
    "import assert from 'node:assert';",
    "function check(v: unknown): void { assert.ifError(v); }",
    "console.log('before-trap');",
    "check([1, 2, 3]);",
    "console.log('never reached');",
  ]);
  // runWasmToTrap asserts the trap itself (WebAssembly.RuntimeError) —
  // a WRONG arm (e.g. a bare unreachable placed at the wrong spot, or
  // one that never runs) fails THAT assertion first, which is the point.
  const { stdout } = await runWasmToTrap(path);
  expect(stdout).toBe(["before-trap", ""].join("\n"));
});

test("assert.ifErrorDyn's composite-kind (OBJ without '%error') arm: the SAME named trap, a plain object literal", async () => {
  const path = await build("iferrordyn-obj-trap.ts", [
    "import assert from 'node:assert';",
    "function check(v: unknown): void { assert.ifError(v); }",
    "console.log('before-obj-trap');",
    "check({ foo: 1 });",
    "console.log('never reached');",
  ]);
  const { stdout } = await runWasmToTrap(path);
  expect(stdout).toBe(["before-obj-trap", ""].join("\n"));
});

test("assert.ifError's empty-message fallback answers the error's `name` SLOT, not Node's true `constructor.name` — a custom Error subclass reports its BASE class (S063)", async () => {
  const path = await build("iferror-ctorname-s063.ts", [
    "import assert from 'node:assert';",
    "class Weird extends Error {}",
    "function check(): void { assert.ifError(new Weird()); }",
    "try { check(); } catch (e) { if (e instanceof Error) console.log(e.message); }",
  ]);
  const { stdout, stderr } = await runWasm(path);
  // MEASURED wasm/C/LLVM answer (S063): "Error" (the `name` slot this
  // runtime carries), not Node's own "Weird" (constructor.name on the
  // true derived class) — this pin guards the CURRENT, registered
  // divergence, not Node's real behavior.
  expect(stdout).toBe(["ifError got unwanted exception: Error", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.throws' class-mismatch text answers the error's `name` SLOT, not Node's true `constructor.name` — the SAME divergence ifError's fallback shows, on the OTHER assert surface (S063)", async () => {
  const path = await build("throws-ctorname-s063.ts", [
    "import assert from 'node:assert';",
    ...MESSAGE_OF_HELPER,
    "class Weird extends Error {}",
    "console.log(JSON.stringify(messageOf(() => assert.throws(() => { throw new Weird('boom'); }, RangeError))));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  // MEASURED wasm/C/LLVM answer (S063): 'Received "Error"' (the `name`
  // slot this runtime carries), not Node's own 'Received "Weird"'
  // (constructor.name on the true derived class) — assert.throws IS
  // wasm-reachable with a custom-subclass-thrown value against a raw
  // class expectation (CR/F-2's own correction: the entry's earlier
  // "refuses to build" claim was wrong, caused by an unrelated
  // construct this program does not use).
  expect(stdout).toBe(
    [
      JSON.stringify(
        'The error is expected to be an instance of "RangeError". Received "Error"\n\nError message:\n\nboom',
      ),
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
