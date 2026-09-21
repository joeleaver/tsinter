/* INC-27 U0 (board #156): the twenty rows pinning the jsPowHelper repair —
 * the y = ±Infinity arms hoisted to run immediately after arm 5, before the
 * old arm 6/7, and pushIsOddInteger answering 0 for any non-finite operand,
 * bit-for-bit unchanged for every finite one. ONE `test` PER ROW, EACH ROW
 * ITS OWN COMPILE: with one shared module, a mutant that makes one row trap
 * (for example disabling the y===2 special case, or altering the fence)
 * would truncate that program's output and destroy mutation attribution for
 * every row sharing the module.
 *
 * Every operand is `any`-ANNOTATED under a `// @dynamic` head so `**`
 * reaches `%w.jsPow` through the live dyn route, never the static `bin:**`
 * refusal at compile time. Results are printed as f64 BIT PATTERNS, never a
 * decimal or a template literal, because a template or a bare print of a
 * signed zero hides the difference between +0 and -0 — the exact
 * distinction two of the four wrong cells (R02, R03) depend on.
 *
 * Every expected line below is an INLINED literal: a committed repo test
 * must not depend on files outside this repository (board #126/#150's
 * class) — the only file this suite reads at test time is
 * tests/corpus/760-any-arithmetic.ts (R18's SOURCE). Every row compares
 * `line.trimEnd()` on both sides because many of the expected lines end in
 * a trailing space (the empty IS-NEG-ZERO field). A script outside this
 * repository proves every literal below equals its oracle's line before
 * this file is trusted. */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

// Resolved relative to THIS file via import.meta.url, matching
// wasm-parse.test.ts's own CORPUS_1522 precedent.
const CORPUS_760 = fileURLToPath(new URL("../../../tests/corpus/760-any-arithmetic.ts", import.meta.url));

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-pow-u0-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const HELPERS = [
  "const buf = Buffer.alloc(8);",
  "function bits(v: number): string {",
  "  buf.writeDoubleBE(v, 0);",
  "  return buf.toString(\"hex\");",
  "}",
  "function row(label: string, x: any, y: any): void {",
  "  try {",
  "    const r = (x ** y) as number;",
  "    console.log(label, bits(x as number), bits(y as number), \"->\", bits(r), Object.is(r, -0) ? \"IS-NEG-ZERO\" : \"\");",
  "  } catch (e) {",
  "    console.log(label, bits(x as number), bits(y as number), \"-> CAUGHT:\" + (e as Error).message);",
  "  }",
  "}",
].join("\n");

/** Compile ONE row's program (its own compile) and return its single
 * output line, UNTRIMMED (callers compare with .trimEnd()). */
async function runRow(name: string, decls: string, call: string): Promise<string> {
  const entry = join(scratch, `${name}.ts`);
  const src = ["// @dynamic", HELPERS, decls, call].join("\n");
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
    dynamic: true,
  });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const lines = stdout.split("\n");
  expect(lines.length, `${name}: expected exactly one output line + trailing newline, got ${JSON.stringify(stdout)}`).toBe(2);
  return lines[0]!;
}

function expectRow(actual: string, expected: string): void {
  expect(actual.trimEnd()).toBe(expected.trimEnd());
}

// ============================================================
// WRONG-CELL — R01..R04. Node's bits: the repair's own closing evidence.
// R02/R03 additionally assert the ABSENCE of IS-NEG-ZERO (Node's answer
// there is +0, not -0).
// ============================================================

test("R01 (-Inf)**(+Inf) — WRONG-CELL", async () => {
  const actual = await runRow(
    "r01",
    "const pInf: any = 1 / 0;\nconst nInf: any = -1 / 0;",
    'row("R01 (-Inf)**(+Inf)", nInf, pInf);',
  );
  expectRow(actual, "R01 (-Inf)**(+Inf) fff0000000000000 7ff0000000000000 -> 7ff0000000000000 ");
});

test("R02 (-Inf)**(-Inf) — WRONG-CELL, no IS-NEG-ZERO", async () => {
  const actual = await runRow("r02", "const nInf: any = -1 / 0;", 'row("R02 (-Inf)**(-Inf)", nInf, nInf);');
  expectRow(actual, "R02 (-Inf)**(-Inf) fff0000000000000 fff0000000000000 -> 0000000000000000 ");
  expect(actual).not.toContain("IS-NEG-ZERO");
});

test("R03 (-0)**(+Inf) — WRONG-CELL, no IS-NEG-ZERO", async () => {
  const actual = await runRow(
    "r03",
    "const pInf: any = 1 / 0;\nconst nZero: any = -0;",
    'row("R03 (-0)**(+Inf)", nZero, pInf);',
  );
  expectRow(actual, "R03 (-0)**(+Inf) 8000000000000000 7ff0000000000000 -> 0000000000000000 ");
  expect(actual).not.toContain("IS-NEG-ZERO");
});

test("R04 (-0)**(-Inf) — WRONG-CELL", async () => {
  const actual = await runRow(
    "r04",
    "const nInf: any = -1 / 0;\nconst nZero: any = -0;",
    'row("R04 (-0)**(-Inf)", nZero, nInf);',
  );
  expectRow(actual, "R04 (-0)**(-Inf) 8000000000000000 fff0000000000000 -> 7ff0000000000000 ");
});

// ============================================================
// DISCRIMINATING-AGREE — R05..R08, R19, R20. R07/R08 send an ODD (3) and
// R19/R20 an EVEN (2) finite exponent through the x=-Infinity / x=±0 arms:
// a two-sided pin on pushIsOddInteger via the ACTUAL arm dispatch.
// ============================================================

test("R05 (+Inf)**(+Inf) — DISCRIMINATING-AGREE", async () => {
  const actual = await runRow("r05", "const pInf: any = 1 / 0;", 'row("R05 (+Inf)**(+Inf)", pInf, pInf);');
  expectRow(actual, "R05 (+Inf)**(+Inf) 7ff0000000000000 7ff0000000000000 -> 7ff0000000000000 ");
});

test("R06 (+0)**(+Inf) — DISCRIMINATING-AGREE", async () => {
  const actual = await runRow(
    "r06",
    "const pInf: any = 1 / 0;\nconst pZero: any = 0;",
    'row("R06 (+0)**(+Inf)", pZero, pInf);',
  );
  expectRow(actual, "R06 (+0)**(+Inf) 0000000000000000 7ff0000000000000 -> 0000000000000000 ");
});

test("R07 (-Inf)**3 — DISCRIMINATING-AGREE (ODD)", async () => {
  const actual = await runRow(
    "r07",
    "const nInf: any = -1 / 0;\nconst three: any = 3;",
    'row("R07 (-Inf)**3", nInf, three);',
  );
  expectRow(actual, "R07 (-Inf)**3 fff0000000000000 4008000000000000 -> fff0000000000000 ");
});

test("R08 (-0)**3 — DISCRIMINATING-AGREE (ODD)", async () => {
  const actual = await runRow(
    "r08",
    "const nZero: any = -0;\nconst three: any = 3;",
    'row("R08 (-0)**3", nZero, three);',
  );
  expectRow(actual, "R08 (-0)**3 8000000000000000 4008000000000000 -> 8000000000000000 IS-NEG-ZERO");
});

test("R19 (-Inf)**2 — DISCRIMINATING-AGREE (EVEN)", async () => {
  const actual = await runRow(
    "r19",
    "const nInf: any = -1 / 0;\nconst two: any = 2;",
    'row("R19 (-Inf)**2", nInf, two);',
  );
  expectRow(actual, "R19 (-Inf)**2 fff0000000000000 4000000000000000 -> 7ff0000000000000 ");
});

test("R20 (-0)**2 — DISCRIMINATING-AGREE (EVEN)", async () => {
  const actual = await runRow(
    "r20",
    "const nZero: any = -0;\nconst two: any = 2;",
    'row("R20 (-0)**2", nZero, two);',
  );
  expectRow(actual, "R20 (-0)**2 8000000000000000 4000000000000000 -> 0000000000000000 ");
});

// ============================================================
// CONTROL — R09..R11. Unaffected by either repair; must stay green
// throughout the battery.
// ============================================================

test("R09 (-1)**(+Inf) — CONTROL", async () => {
  const actual = await runRow(
    "r09",
    "const pInf: any = 1 / 0;\nconst negOne: any = -1;",
    'row("R09 (-1)**(+Inf)", negOne, pInf);',
  );
  expectRow(actual, "R09 (-1)**(+Inf) bff0000000000000 7ff0000000000000 -> 7ff8000000000000 ");
});

test("R10 2**2 — CONTROL", async () => {
  const actual = await runRow("r10", "const two: any = 2;", 'row("R10 2**2", two, two);');
  expectRow(actual, "R10 2**2 4000000000000000 4000000000000000 -> 4010000000000000 ");
});

test("R11 (-2)**2 — CONTROL", async () => {
  const actual = await runRow(
    "r11",
    "const two: any = 2;\nconst negTwo: any = -2;",
    'row("R11 (-2)**2", negTwo, two);',
  );
  expectRow(actual, "R11 (-2)**2 c000000000000000 4000000000000000 -> 4010000000000000 ");
});

// ============================================================
// FENCE-PIN — R12..R16. The exact fence text; R13..R16 additionally pin the
// S043 wording fix (base ±1 with a FINITE exponent still fences).
// ============================================================

test("R12 2**3 — FENCE-PIN", async () => {
  const actual = await runRow(
    "r12",
    "const two: any = 2;\nconst three: any = 3;",
    'row("R12 2**3", two, three);',
  );
  expectRow(actual, "R12 2**3 4000000000000000 4008000000000000 -> CAUGHT:Math.pow with this exponent is not supported yet");
});

test("R13 1**3 — FENCE-PIN (base +1, finite exponent, still fences)", async () => {
  const actual = await runRow(
    "r13",
    "const one: any = 1;\nconst three: any = 3;",
    'row("R13 1**3", one, three);',
  );
  expectRow(actual, "R13 1**3 3ff0000000000000 4008000000000000 -> CAUGHT:Math.pow with this exponent is not supported yet");
});

test("R14 1**1 — FENCE-PIN (base +1, finite exponent, still fences)", async () => {
  const actual = await runRow("r14", "const one: any = 1;", 'row("R14 1**1", one, one);');
  expectRow(actual, "R14 1**1 3ff0000000000000 3ff0000000000000 -> CAUGHT:Math.pow with this exponent is not supported yet");
});

test("R15 (-1)**3 — FENCE-PIN (base -1, finite exponent, still fences)", async () => {
  const actual = await runRow(
    "r15",
    "const negOne: any = -1;\nconst three: any = 3;",
    'row("R15 (-1)**3", negOne, three);',
  );
  expectRow(actual, "R15 (-1)**3 bff0000000000000 4008000000000000 -> CAUGHT:Math.pow with this exponent is not supported yet");
});

test("R16 1**1e308 — FENCE-PIN (base +1, finite exponent, still fences)", async () => {
  const actual = await runRow(
    "r16",
    "const one: any = 1;\nconst big: any = 1e308;",
    'row("R16 1**1e308", one, big);',
  );
  expectRow(actual, "R16 1**1e308 3ff0000000000000 7fe1ccf385ebc8a0 -> CAUGHT:Math.pow with this exponent is not supported yet");
});

// ============================================================
// REGISTERED-NaN — R17. Asserts the TIER's OWN 7ff8000000000000 (not
// Node's fff8000000000000) — board #158, cited by SEMANTICS.md S036; this
// row changes when #158 is fixed, not before.
// ============================================================

test("R17 (-2)**0.5 — REGISTERED-NaN (board #158; tier answers CANONICAL_NAN, Node answers fff8000000000000; SEMANTICS.md S036)", async () => {
  const actual = await runRow(
    "r17",
    "const negTwo: any = -2;\nconst half: any = 0.5;",
    'row("R17 (-2)**0.5", negTwo, half);',
  );
  expectRow(actual, "R17 (-2)**0.5 c000000000000000 3fe0000000000000 -> 7ff8000000000000 ");
});

// ============================================================
// REGRESSION — R18. tests/corpus/760-any-arithmetic.ts's SOURCE is read at
// test time (never copied); its five expected lines are Node v24's output
// for that file, inlined here.
// ============================================================

test("R18 760-any-arithmetic.ts — REGRESSION vs the Node oracle", async () => {
  await readFile(CORPUS_760, "utf8"); // read at test time; never copied into this file
  const res = await compile(CORPUS_760, {
    outPath: join(scratch, "r18.wasm"),
    outDir: scratch,
    backend: "wasm",
    dynamic: true,
  });
  if (!res.ok) throw new Error(`R18 refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const expected = [
    "42 40.5 82 10.25 1 1681",
    "1x string",
    "20 105 10 -10",
    "NaN false",
    "true true false false true false",
  ];
  const actualLines = stdout.split("\n");
  // trailing empty string from the final newline
  expect(actualLines.length, `R18: expected exactly ${expected.length} lines + trailing newline, got ${JSON.stringify(stdout)}`).toBe(
    expected.length + 1,
  );
  for (let i = 0; i < expected.length; i++) {
    expect(actualLines[i]!.trimEnd(), `R18 line ${i + 1}`).toBe(expected[i]!.trimEnd());
  }
});
