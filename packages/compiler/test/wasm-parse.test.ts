/* INC-25 pass P3 (design-number-v6.txt §2.4/§5.1/§5.2/§6.1-6.3/§7.4,
 * CP1 ack 2026-09-07 hash 8ed55edc..., rulings R1-R9): the parsers —
 * num.parseInt, num.parseFloat, num.fromString — and board #123's fix
 * (a live silent miscompile: digit-at-a-time f64 accumulation) on EVERY
 * radix, plus board #123b's fix (an uncatchable trap on the radix
 * argument past +-2^31).
 *
 * FOUR ARMS: (a) radix 10 routes to the existing correctly-rounded
 * decimal helper; (b) power-of-two radices (2,4,8,16,32) transcribe V8's
 * InternalStringToIntDouble; (c) every other radix transcribes V8's
 * NumberParseIntHelper::HandleGenericCase; (d) the radix argument itself
 * uses ToInt32's modular wrap instead of a trapping signed truncation.
 *
 * Every expected value here is computed from THIS session's Node
 * (v24.18.1, V8 13.6.233.17) at test run time via execFileSync, never
 * hand-typed — including the design's own §6.3 rows, which this file
 * re-derives rather than copies.
 *
 * THE WITNESS CORRECTION (CP1 ack R1): the pow2 witness integer must be
 * rendered via BigInt.prototype.toString, not Number.prototype.toString
 * — the design's own value, 3301462806203025665, is NOT exactly
 * representable as a double (it rounds to 3301462806203025920 at the
 * literal-parse step), so `(3301462806203025665).toString(radix)` renders
 * the ALREADY-ROUNDED double's digits, which parse back to themselves
 * trivially on both sides. `3301462806203025665n.toString(radix)` renders
 * the TRUE integer's digits, which is what actually discriminates. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-parse-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function buildWasm(name: string, source: string, dynamic = false) {
  const entry = join(scratch, name);
  await writeFile(entry, (dynamic ? "// @dynamic\n" : "") + source);
  return compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, dynamic, backend: "wasm" });
}

async function runWasm(modulePath: string): Promise<{ stdout: string; exitCode: number }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => 0,
      seed: (): bigint => 1n,
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let exitCode = 0;
  try {
    (instance.exports["_start"] as () => void)();
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    exitCode = 1;
  }
  const status = instance.exports["_status"] as (() => number) | undefined;
  if (exitCode === 0 && status) exitCode = status();
  return { stdout: Buffer.concat(chunks[1]).toString("utf8"), exitCode };
}

/** Runs `exprs.join(", ")` through console.log on BOTH lanes (the real
 * compiled module and this session's own Node) and asserts byte-exact
 * agreement — Node is the oracle for the STRING too (console.log's -0/
 * Infinity/exponential rendering is reproduced by running it, never
 * hand-formatted here). */
let pinCounter = 0;
async function pinAgainstNode(name: string, exprs: string[], dynamic = false): Promise<void> {
  const uniq = `${name}-${pinCounter++}.ts`;
  const src = `console.log(${exprs.join(", ")});\n`;
  const res = await buildWasm(uniq, src, dynamic);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  const jsFile = join(scratch, `${uniq}-oracle.js`);
  await writeFile(jsFile, src);
  const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
  expect(stdout).toBe(nodeOut);
}

describe("wasm num.parseInt/parseFloat/fromString — the 10-candidate corpus regression set (D3, board #123/#123b)", () => {
  test("board #123's own examples: the 30-digit decimal and twenty nines, radix 10", async () => {
    await pinAgainstNode("b123-a", [
      'parseInt("123456789012345678901234567890", 10)',
      'parseInt("99999999999999999999", 10)',
    ]);
  });

  test("§6.3 EXACT non-pow2, five rows (one per radix), re-derived not copied", async () => {
    await pinAgainstNode("s63-nonpow2", [
      'parseInt("101022022222212020112122022012102202", 3)',
      'parseInt("341103043344124220004042", 5)',
      'parseInt("56500633346401245311653216522", 7)',
      'parseInt("ibe02i8ib7fe7b", 20)',
      'parseInt("8tnpfwnx67b8exh5idoxae9h43feu7fvoix", 36)',
    ]);
  });

  test("§6.3 EXACT pow2, five rows — CP1 ack R1's corrected witness: 3301462806203025665n rendered via BigInt.toString, one row per radix 2/4/8/16/32", async () => {
    const n = 3301462806203025665n;
    const exprs = [2, 4, 8, 16, 32].map((r) => `parseInt("${n.toString(r)}", ${r})`);
    await pinAgainstNode("s63-pow2", exprs);
  });

  test("§6.3 radix-10 control: parseInt('9'.repeat(25), 10)", async () => {
    await pinAgainstNode("s63-r10", ['parseInt("9".repeat(25), 10)']);
  });

  test("§6.3 #123b: parseInt('ff', 4294967312) must return 255, not trap", async () => {
    await pinAgainstNode("s63-123b", ['parseInt("ff", 4294967312)']);
  });

  test("§6.3 1522 line 18 verbatim — green today by luck, must stay green", async () => {
    await pinAgainstNode("s63-1522l18", [
      'parseInt("7".repeat(30), 36)',
      'parseInt("1".repeat(80), 35)',
      'parseInt("z".repeat(25), 36)',
    ]);
  });

  test("§6.3 1522's three diverging literals (radix 10), plus the 310-digit control that is Infinity on both sides", async () => {
    await pinAgainstNode("s63-1522lits", [
      'parseInt("123456789012345678901234567890", 10)',
      'parseInt("9".repeat(40), 10)',
      'parseInt("1" + "0".repeat(308), 10)',
      'parseInt("1" + "0".repeat(309), 10)',
    ]);
  });

  test("§5.2 the radix alphabet — every value against Node, none may trap", async () => {
    await pinAgainstNode("s52-alphabet", [
      'parseInt("11", 0)',
      'parseInt("11", 1)',
      'parseInt("11", 2)',
      'parseInt("11", 10)',
      'parseInt("11", 16)',
      'parseInt("11", 36)',
      'parseInt("11", 37)',
      'parseInt("11", -1)',
      'parseInt("11", -16)',
      'parseInt("11", 2.9)',
      'parseInt("11", 36.9)',
      'parseInt("11", 1.5)',
      'parseInt("11", 4294967296)',
      'parseInt("ff", 4294967312)',
      'parseInt("11", 4294967306)',
      'parseInt("11", 8589934592)',
      'parseInt("11", 1e21)',
      'parseInt("11", 9007199254740992)',
      'parseInt("11", 9223372036854776000)',
      'parseInt("11", 18446744073709552000)',
      'parseInt("11", -2147483649)',
      'parseInt("11", -4294967296)',
      'parseInt("11", Infinity)',
      'parseInt("11", -Infinity)',
      'parseInt("11", NaN)',
      'parseInt("11", -0)',
    ], true);
  });

  test("CP1 ack R2's additional arm (d) rows: the wrap-to-VALID rows, and the ONLY row separating a signed from an unsigned wrap", async () => {
    await pinAgainstNode("r2-armd", [
      'parseInt("ff", 4294967312)',
      'parseInt("zz", 4294967332)',
      'parseInt("ff", -(4294967296-16))',
      'parseInt("777", -(4294967296-8))',
      'parseInt("11", 4294967297)',
      'parseInt("11", Infinity)',
      'parseInt("11", 1e300)',
      'parseInt("11", Number.MAX_VALUE)',
      'parseInt("11", -2147483649)',
      'parseInt("ff", -0)',
    ]);
  });

  test("1522's own regression: the full corpus program compiles, claims, and matches Node byte-exact", async () => {
    const res = await compile("/home/joe/dev/tsinter/.claude/worktrees/inc25-impl-p3/tests/corpus/1522-parseint-static.ts", {
      outPath: join(scratch, "1522.wasm"),
      outDir: scratch,
      dynamic: false,
      backend: "wasm",
    });
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    const nodeOut = execFileSync(
      process.execPath,
      ["/home/joe/dev/tsinter/.claude/worktrees/inc25-impl-p3/tests/corpus/1522-parseint-static.ts"],
      { encoding: "utf8" },
    );
    expect(stdout).toBe(nodeOut);
  });

  test("1523's own shape: isNaN(parseInt('nope')) — the P1 leftover this pass closes", async () => {
    await pinAgainstNode("p1523-shape", ["isNaN(parseInt(\"nope\"))"]);
  });
});

describe("wasm num.parseInt — arm (a): radix 10 stops at the digit run, never an exponent suffix", () => {
  test("parseInt('123e5', 10) stays 123 (parseFloat/Number() would NOT stop there)", async () => {
    await pinAgainstNode("arma-noexp", ['parseInt("123e5", 10)']);
  });
});

describe("wasm num.parseInt — arm (b): InternalStringToIntDouble's own boundary rows (CP1 ack R3, items 6-8)", () => {
  test("R3 item 6: the zero_tail STICKY flag — three rows it decides, two rows it cannot", async () => {
    const a = (2n ** 53n + 1n).toString(2);
    const b = (2n ** 53n + 3n).toString(2);
    await pinAgainstNode("r3-sticky", [
      `parseInt("${a}1", 2)`,
      `parseInt("${a}10", 2)`,
      `parseInt("${a}01", 2)`,
      `parseInt("${a}00", 2)`, // control: sticky can't matter (dropped bits < middle)
      `parseInt("${b}1", 2)`, // control: sticky can't matter (number already odd)
    ]);
  });

  test("R3 item 7: the post-round carry into bit 53 — 54 binary ones", async () => {
    await pinAgainstNode("r3-carry", ['parseInt("1".repeat(54), 2)']);
  });

  test("R3 item 8: the exponent step at its own boundaries — finite up to 2^1023, Infinity from 2^1024", async () => {
    await pinAgainstNode("r3-exp", [
      'parseInt("1" + "0".repeat(1023), 2)',
      'parseInt("1" + "0".repeat(1024), 2)',
      'parseInt("1".repeat(1100), 2)',
      `parseInt("${"v".repeat(120)}", 32)`,
    ]);
  });

  test("leading zeros: a short run, a long run, and an all-zero span (both signs)", async () => {
    await pinAgainstNode("armb-leadingzeros", [
      'parseInt("000101", 2)',
      'parseInt("0".repeat(20) + "1", 2)',
      'parseInt("0".repeat(60), 2)',
      'parseInt("-" + "0".repeat(60), 2)',
    ]);
  });
});

describe("wasm num.parseFloat / num.fromString — the arm reaches the right helper (D3)", () => {
  test("parseFloat: a #123 string, a subnormal-exponent string, and trailing garbage", async () => {
    await pinAgainstNode("parsefloat-reach", [
      'parseFloat("123456789012345678901234567890")',
      'parseFloat("1e-400")',
      'parseFloat("  3.14abc")',
    ]);
  });

  test("fromString (unary +): whitespace, empty string, and the Infinity literal", async () => {
    await pinAgainstNode("fromstring-reach", ['+" 42 "', '+""', '+"Infinity"']);
  });

  test("StringToNumber's pow2 literals: 0x/0o/0b whole-literal grammar, including the bit-53 boundary and the whole-span (not prefix) rule", async () => {
    await pinAgainstNode("stringtonumber-pow2", [
      'Number("0x" + "f".repeat(20))',
      'Number("0b1" + "0".repeat(60) + "1")',
      'Number("0o" + "7".repeat(30))',
      'Number("0x8" + "0".repeat(15))',
      'Number("-0x1F")',
      'Number("0x1Fg")',
    ]);
  });

  test("CP1 ack R7: a sticky-tie hex literal at the bit-53 boundary", async () => {
    // 2^53 in hex is 1 followed by 13 zeros; a hex digit's own 4-bit
    // granularity means a hex whole-literal exercises arm (b)'s pow2
    // path (log2radix=4) with a genuine mid-nibble rounding tie.
    const hex53 = (2n ** 53n).toString(16);
    await pinAgainstNode("r7-hexsticky", [`Number("0x${hex53}8")`, `Number("0x${hex53}0")`]);
  });
});

describe("wasm F-1 (D2): the alphabet sweep re-run through the STATIC keys, not the island path", () => {
  test("245-row grammar sweep subset re-derived through static parseInt/parseFloat/ToNumber, no @dynamic — the two #123 positive-control rows must be IDENTICAL now (not differing)", async () => {
    const rows: [string, string][] = [
      ["parseInt('123456789012345678901234567890',10)", 'parseInt("123456789012345678901234567890", 10)'],
      ["parseInt('9'.repeat(25),10)", 'parseInt("9".repeat(25), 10)'],
      ["parseInt('0x1F')", "parseInt(\"0x1F\")"],
      ["parseInt(' 42 ')", "parseInt(\" 42 \")"],
      ["parseFloat('1e309')", "parseFloat(\"1e309\")"],
      ["parseFloat('  .5')", "parseFloat(\"  .5\")"],
      ["+'0777'", "+\"0777\""],
      ["+''", "+\"\""],
    ];
    for (const [label, expr] of rows) {
      await pinAgainstNode(`f1-${label.replace(/[^a-z0-9]/gi, "")}`, [expr]);
    }
  });
});
