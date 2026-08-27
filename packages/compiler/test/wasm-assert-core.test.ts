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

/* ── eqStr's multi-line-inspection sentinel (des-23 D.9 / the lead's own
 * measurement + refinement): once EITHER inspection spans lines, Node's
 * real createErrDiff leaves the simple/stacked machinery entirely for
 * the myers line-diff assembler, which P1 does not port (P2's job,
 * D.9's boxing-shim recommendation) — a named, reachable-by-real-
 * source, force-pinned trap instead. No P1 corpus program reaches it
 * (1603's own "a\nb" is 3 units, far under the 76-unit split
 * threshold). The predicate is on the RENDERED text, not the input —
 * a companion pin below proves a string whose only newline sits past
 * the 10000-unit cap does NOT trip the sentinel (it renders on one
 * line, same as Node).
 *
 * `runWasmToTrap` alone does NOT distinguish the sentinel from an
 * ORDINARY uncaught AssertionError trap — BOTH are a genuine
 * WebAssembly.RuntimeError (an uncaught throw also traps, via
 * reportUncaughtHelper, once assert.strictEqual actually decides to
 * fail — this pass's own MUTATION CHECK caught exactly this: disabling
 * emitStrHasNewline still traps, just later and for the ordinary
 * reason, and both pins below would have stayed GREEN without the
 * stderr assertion). The distinguishing signal is stderr: the
 * sentinel's bare `unreachable()` fires BEFORE emitSetCellError/
 * emitUnwind/reportUncaughtHelper ever run, so stderr is EMPTY; the
 * ordinary uncaught path prints "Uncaught AssertionError ..." first
 * (measured directly, own probe, both ways). Both pins assert
 * `stderr === ""` for exactly this reason — a comment alone would not
 * have caught the mutation; the assertion does. ───────────────────── */

test("assert.eqStr's multi-line sentinel: a long string containing a newline traps (eq path) — everything before it still runs, and stderr is EMPTY (proves the SENTINEL fired, not an ordinary uncaught AssertionError — see the header comment's own mutation-check story)", async () => {
  const path = await build("eqstr-multiline-trap-eq.ts", [
    "import assert from 'node:assert';",
    "const long = 'abcdefghij'.repeat(8) + '\\nsecond line here';",
    "console.log('before-trap');",
    "assert.strictEqual(long, 'x');",
    "console.log('never reached');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["before-trap", ""].join("\n"));
  expect(stderr).toBe("");
});

test("assert.eqStr's multi-line sentinel: the SAME shape traps on the neq path too (E-11's own scope: a multi-line rendering never reaches neqFail's length-based inline/block choice), stderr EMPTY", async () => {
  const path = await build("eqstr-multiline-trap-neq.ts", [
    "import assert from 'node:assert';",
    "const long = 'abcdefghij'.repeat(8) + '\\nsecond line here';",
    "console.log('before-neq-trap');",
    "assert.notStrictEqual(long, long);",
    "console.log('never reached');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["before-neq-trap", ""].join("\n"));
  expect(stderr).toBe("");
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
