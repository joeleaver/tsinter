/* INC-25 pass P4 (design-number-v6.txt §2.5/§3.2/§3.3/§4/§5.3/§6.1-6.2/
 * §6.7/§7.5/§7.8/§9.3/§11.1-11.2/§12.2, CP1 ack cp1-rulings-p4-v1.txt
 * 6eaf8db1.../93, rulings R1-R13): the formatters — num.toFixed,
 * num.toFixed0, num.toExponential (the digit-free static key) — plus
 * D4's three dyn-path options: Math.PI/Math.E via the getProp
 * closed-table shape (i), toPrecision on a dyn NUM receiver (ii),
 * toString(radix) for radix != 10 via a transcription of V8's
 * DoubleToRadixStringView (iii). Board #125 closes (the toPrecision
 * placeholder-call and direct-call texts are now Node's own). The
 * MERGE (R12): dyn.ts's own toFixed port is retired — every caller
 * (static AND dyn) now goes through the ONE shared json.ts helper.
 *
 * Every expected value here is computed from THIS session's Node
 * (v24.18.1, V8 13.6.233.17) at test run time via execFileSync, never
 * hand-typed — matching wasm-parse.test.ts's own contract exactly (this
 * file reuses its buildWasm/runWasm/pinAgainstNode shape verbatim).
 *
 * The BULK Node-oracle sweep (>=100000 seeded doubles x toFixed's digit
 * axis, >=70000 radix rows, a 840-row dyn toPrecision/toString(radix)
 * sweep over 39 values x 21 expressions) is a BUILD-PHASE / freeze-time
 * measurement (findings-p4-v1.txt), not reproduced row-by-row here —
 * this file pins every row the brief (§D4) and the CP1 ack (R1-R13)
 * name SPECIFICALLY, plus the exact witnesses each of the eight
 * mutation controls needs, so a future regression in any of them fails
 * HERE, fast, without needing the full sweep. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-format-"));
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

/** Node's own `.js` execution does not understand TypeScript syntax —
 * `let a: any = 5;` and `(e as Error)` are compile-only annotations for
 * the WASM side. Every hand-written multi-statement `src` string below
 * is authored ONCE, in this shape, and run through the compiler
 * VERBATIM; this strips exactly the two TS-only forms it uses so the
 * SAME source (not a hand-duplicated "plain JS" twin that could drift
 * from it) becomes the Node oracle. */
function stripTsForOracle(src: string): string {
  return src.replace(/:\s*any\b/g, "").replace(/\(([a-zA-Z_$][\w$]*)\s+as\s+Error\)/g, "$1");
}

/** Runs `exprs.join(", ")` through console.log on BOTH lanes (the real
 * compiled module and this session's own Node) and asserts byte-exact
 * agreement — Node is the oracle for the STRING too. Every call is
 * wrapped in try/catch so a RangeError row prints its own name+message
 * instead of ending the run, matching 1980's own corpus convention. */
let pinCounter = 0;
async function pinAgainstNode(name: string, exprs: string[], dynamic = false): Promise<void> {
  const uniq = `${name}-${pinCounter++}.ts`;
  const lines = exprs.map(
    (e) => `try { console.log(\`\${${e}}\`); } catch (err) { console.log((err as Error).name + ": " + (err as Error).message); }`,
  );
  const src = lines.join("\n") + "\n";
  const res = await buildWasm(uniq, src, dynamic);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
  const { stdout } = await runWasm(res.binaryPath);
  const jsFile = join(scratch, `${uniq}-oracle.js`);
  await writeFile(jsFile, stripTsForOracle(src));
  const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
  expect(stdout).toBe(nodeOut);
}

// ============================================================================
// STATIC: num.toFixed / num.toFixed0 (D4 pin table, the hard set + edges)
// ============================================================================
describe("wasm num.toFixed / num.toFixed0 — static key, D4's hard set + boundary rows", () => {
  test("1980's own 10-value hard set x both signs x toFixed at {0,1,2,3,6,17,20,100}", async () => {
    const vals = [5e-324, 1.7976931348623157e308, 0.1 + 0.2, 123456789.123456789, 2 ** 53, 1e-7, 9.999999999999999e22, 0.000001, 100, 12345e6];
    const digitsSet = [0, 1, 2, 3, 6, 17, 20, 100];
    const exprs: string[] = [];
    for (const v of vals) {
      for (const d of digitsSet) {
        exprs.push(`(${v}).toFixed(${d})`, `(${-v}).toFixed(${d})`);
      }
    }
    await pinAgainstNode("hard-set", exprs);
  });

  test("the exact-tie rows PAIRED WITH THEIR OWN f (CP1 ack R9): x = odd/2^(f+1), position f, both signs, f = 0..20", async () => {
    const exprs: string[] = [];
    for (let f = 0; f <= 20; f++) {
      for (const odd of [1, 3, 5, 7, 9, 11]) {
        const x = odd / 2 ** (f + 1);
        exprs.push(`(${x}).toFixed(${f})`, `(${-x}).toFixed(${f})`);
      }
    }
    await pinAgainstNode("tie-pairs", exprs);
  });

  test("named tie instances from the brief: 0.5/1.5/2.5/-2.5 at 0; 0.125/0.375 at 2", async () => {
    await pinAgainstNode("tie-named", [
      "(0.5).toFixed(0)",
      "(1.5).toFixed(0)",
      "(2.5).toFixed(0)",
      "(-2.5).toFixed(0)",
      "(0.125).toFixed(2)",
      "(0.375).toFixed(2)",
    ]);
  });

  test("carry rows (CP1 ack R7): the collapse-to-1 shape, both signs, incl. the tie+carry row and the sign-crossing row", async () => {
    await pinAgainstNode("carry", [
      "(999.995).toFixed(2)",
      "(9.995).toFixed(2)", // NOT a carry — below the tie, the over-rounding control
      "(9.9999).toFixed(3)",
      "(0.999).toFixed(2)",
      "(99.99).toFixed(1)",
      "(9.5).toFixed(0)", // a carry that is ALSO an exact tie
      "(-9.9999).toFixed(3)", // a carry crossing the sign axis
      "(0.000005).toFixed(5)",
    ]);
  });

  test("NOT a carry (R7): 0.95 at 1 digit stays below the tie, same trap as 9.995", async () => {
    await pinAgainstNode("not-carry", ["(0.95).toFixed(1)"]);
  });

  test("sign rows: sign from x<0 ALONE, prepended unconditionally", async () => {
    await pinAgainstNode("sign", ["(-0.4).toFixed(0)", "(-1e-10).toFixed(2)", "(-0).toFixed(2)"]);
  });

  test("the 1e21 boundary from both sides", async () => {
    await pinAgainstNode("boundary-1e21", [
      "(999999999999999900000).toFixed(2)",
      "(1e21).toFixed(0)",
      "(1e21).toFixed(2)",
      "(1e20).toFixed(2)",
    ]);
  });

  test("2^53 and 2^63 at 2 digits; 0.1 at 25 digits; a near-2^53 mantissa at 20", async () => {
    await pinAgainstNode("big-mantissa", ["(9007199254740992).toFixed(2)", "(9223372036854775808).toFixed(2)", "(0.1).toFixed(25)", "(1.0000000000000002).toFixed(20)"]);
  });

  test("the trunc==0 witnesses (CP1 ack R4): the LARGEST DENORMAL is the 767-digit maximum, not 5e-324 (751) or MAX_VALUE (309)", async () => {
    await pinAgainstNode("trunc-witnesses", [
      "(5e-324).toFixed(100)",
      "(Number.MAX_VALUE).toFixed(100)",
      "(2.225073858507201e-308).toFixed(100)",
    ]);
  });

  test("(1.005) at 2/50/100 — the classic float-representation trap", async () => {
    await pinAgainstNode("1005", ["(1.005).toFixed(2)", "(1.005).toFixed(50)", "(1.005).toFixed(100)", "(1.015).toFixed(2)", "(2.25).toFixed(1)", "(-2.25).toFixed(1)"]);
  });

  test("0.1+0.2 at 17 digits", async () => {
    await pinAgainstNode("0.1+0.2", ["(0.1 + 0.2).toFixed(17)"]);
  });

  test("RangeError rows: -1, 101, 1/0, -1/0 — the exact message; NaN.toFixed(101) still throws (order row, R8's mirror)", async () => {
    await pinAgainstNode("range-error", [
      "(1).toFixed(-1)",
      "(1).toFixed(101)",
      "(1).toFixed(1 / 0)",
      "(1).toFixed(-1 / 0)",
      "(NaN).toFixed(101)",
    ]);
  });

  test("coercions the key can express: 3.9 -> 3, NaN -> 0, -0.9 -> 0", async () => {
    await pinAgainstNode("coercions", ["(5).toFixed(3.9)", "(5).toFixed(NaN)", "(5).toFixed(-0.9)"]);
  });

  test("toFixed0 (f=0, the thin wrapper): the same rows toFixed(0) proves, called via the bare no-arg spelling", async () => {
    await pinAgainstNode("toFixed0", [
      "(2.5).toFixed()",
      "(-2.5).toFixed()",
      "(0.5).toFixed()",
      "(1.4).toFixed()",
      "(-0.4).toFixed()",
      "(-0).toFixed()",
      "(1e21).toFixed()",
      "(0 / 0).toFixed()",
    ]);
  });

  test("NaN / Infinity texts (both formatters share this special-casing)", async () => {
    await pinAgainstNode("nan-inf", ["(NaN).toFixed(2)", "(Infinity).toFixed(2)", "(-Infinity).toFixed(2)"]);
  });

  test("optional/undefined digits, incl. an effectful missing-digits expression and optional chaining — lower-calls.ts's own `digits ?? 0` handling", async () => {
    await pinAgainstNode("optional-digits", [
      "(22 / 7).toFixed(undefined)",
      "(22 / 7).toFixed(void 0)",
    ]);
  });
});

// ============================================================================
// STATIC: num.toExponential (digit-free only — the key cannot express toExponential(d))
// ============================================================================
describe("wasm num.toExponential — static key, digit-free only (v6 §7.8)", () => {
  test("1980's own hard set, both signs, plus the named specials", async () => {
    const vals = [5e-324, 1.7976931348623157e308, 0.1 + 0.2, 123456789.123456789, 2 ** 53, 1e-7, 9.999999999999999e22, 0.000001, 100, 12345e6];
    const exprs: string[] = [];
    for (const v of vals) exprs.push(`(${v}).toExponential()`, `(${-v}).toExponential()`);
    exprs.push(
      "(0).toExponential()",
      "(-0).toExponential()",
      "(1e21).toExponential()",
      "(NaN).toExponential()",
      "(Infinity).toExponential()",
      "(-Infinity).toExponential()",
      "(123).toExponential()",
      "(0.5).toExponential()",
      "(9007199254740992).toExponential()",
    );
    await pinAgainstNode("toexp-hardset", exprs);
  });
});

// ============================================================================
// DYN: toPrecision (D4-ii, board #125)
// ============================================================================

async function pinToPrecisionTable(): Promise<void> {
  const values = [5, 5, NaN, Infinity, 123.456, 0.000001, 0.0000001, 123456, 1e21, 9.5, 2.5, -2.5, 0, -0, 1.005, 5e-324, Number.MAX_VALUE];
  const src =
    values.map((v, i) => `let x${i}: any = ${Object.is(v, -0) ? "-0" : v};`).join("\n") +
    "\n" +
    [
      "try { console.log(`${x0.toPrecision()}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x0.toPrecision(undefined)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x1.toPrecision(0)}`); } catch (e) { console.log((e as Error).name + ': ' + (e as Error).message); }",
      "try { console.log(`${x1.toPrecision(101)}`); } catch (e) { console.log((e as Error).name + ': ' + (e as Error).message); }",
      "try { console.log(`${x2.toPrecision(101)}`); } catch (e) { console.log((e as Error).name + ': ' + (e as Error).message); }",
      "try { console.log(`${x3.toPrecision(0)}`); } catch (e) { console.log((e as Error).name + ': ' + (e as Error).message); }",
      "try { console.log(`${x4.toPrecision(1)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x5.toPrecision(2)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x6.toPrecision(2)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x7.toPrecision(2)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x7.toPrecision(6)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x7.toPrecision(7)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x8.toPrecision(21)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x8.toPrecision(22)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x9.toPrecision(1)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x10.toPrecision(1)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x11.toPrecision(1)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x12.toPrecision(3)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x13.toPrecision(3)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x14.toPrecision(3)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x15.toPrecision(100)}`); } catch (e) { console.log((e as Error).message); }",
      "try { console.log(`${x16.toPrecision(100)}`); } catch (e) { console.log((e as Error).message); }",
    ].join("\n") +
    "\n";
  const res = await buildWasm("toprecision-real.ts", src, true);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
  const { stdout } = await runWasm(res.binaryPath);
  const jsFile = join(scratch, "toprecision-real.ts-oracle.js");
  await writeFile(jsFile, stripTsForOracle(src));
  const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
  expect(stdout).toBe(nodeOut);
}

describe("wasm dyn toPrecision — the real table (values as locals, not literals, so -0/NaN/Infinity round-trip correctly)", () => {
  test("undefined, RangeError arms, the NaN/order row, both e>=p boundaries, ties, the trunc==0 witnesses", pinToPrecisionTable);

  test("the placeholder-call spelling and the direct-call spelling both close board #125 (own message texts, not fenced ones)", async () => {
    const src =
      "let x: any = 5;\n" +
      "const { toPrecision } = x;\n" +
      "console.log(`${toPrecision.call(5, 3)}`);\n" +
      "let y: any = 1234.5678;\n" +
      "console.log(`${y.toPrecision(2)}`);\n";
    const res = await buildWasm("board125.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "board125.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
    expect(stdout).not.toContain("is not a function");
    expect(stdout).not.toContain("not supported yet");
  });
});

// ============================================================================
// DYN: toString(radix) (D4-iii) — DoubleToRadixStringView
// ============================================================================
describe("wasm dyn toString(radix) — D4-iii, a transcription of V8's DoubleToRadixStringView", () => {
  test("1112's and 1116's own calls, verbatim", async () => {
    const src =
      "let a: any = 255;\n" +
      "console.log(`${a.toString(16)}`);\n" +
      "let b: any = 255;\n" +
      "console.log(`${b.toString(2)}`);\n" +
      "let c: any = 511;\n" +
      "console.log(`${c.toString(8)}`);\n" +
      "let d: any = 12345;\n" +
      "console.log(`${d.toString(36)}`);\n" +
      "let e: any = -255;\n" +
      "console.log(`${e.toString(16)}`);\n" +
      "let f: any = 0.5;\n" +
      "console.log(`${f.toString(2)}`);\n" +
      "let g: any = 48879;\n" +
      "console.log(`${g.toString(16)}`);\n" +
      "let h: any = Math.trunc(15249);\n" +
      "console.log(`${h.toString(36)}`);\n" +
      "let i: any = 255.5;\n" +
      "console.log(`${i.toString(16)}`);\n";
    const res = await buildWasm("radix-1112.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-1112.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("fractional radices, carries, and the round-to-even boundary", async () => {
    const src =
      "let v0: any = 0.1;\n" +
      "console.log(`${v0.toString(3)}`);\n" +
      "let v1: any = 1 / 3;\n" +
      "console.log(`${v1.toString(2)}`);\n" +
      "let v2: any = 0.3;\n" +
      "console.log(`${v2.toString(2)}`);\n" +
      "let v3: any = -255.5;\n" +
      "console.log(`${v3.toString(2)}`);\n" +
      "let v4: any = 0.999999999999;\n" +
      "console.log(`${v4.toString(2)}`);\n" +
      "let v5: any = 1.9999999999999998;\n" +
      "console.log(`${v5.toString(2)}`);\n" +
      "let v6: any = 3.9999999999999996;\n" +
      "console.log(`${v6.toString(4)}`);\n" +
      "let v7: any = 2 ** 53 + 2;\n" +
      "console.log(`${v7.toString(2)}`);\n";
    const res = await buildWasm("radix-fractional-real.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-fractional-real.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("the back-trace witnesses (CP1 ack R1, rev-25's measured rows — the brief's OWN two rows were VOID, kept only as delta-termination rows below)", async () => {
    const src =
      "let a: any = 1.3333333333333333;\n" +
      "console.log(`${a.toString(3)}`);\n" +
      "let b: any = 1.3333333333333333;\n" +
      "console.log(`${b.toString(9)}`);\n" +
      "let c: any = 0.00018313042101781934;\n" +
      "console.log(`${c.toString(6)}`);\n" +
      "console.log(`${c.toString(13)}`);\n" +
      "console.log(`${c.toString(14)}`);\n" +
      "console.log(`${c.toString(17)}`);\n";
    const res = await buildWasm("radix-backtrace.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-backtrace.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("long ordinary expansions near a radix-power boundary (C1 round C2's own rename: NEITHER delta-termination [6a's real witnesses are (0.1).toString(3)/(0.5).toString(2), per cp1-plan-p4.txt] NOR round-to-even [measured directly: fraction never lands exactly on the tie's ACTION branch for either value below] — a many-iteration correctness check the original build mislabeled, kept as history in findings-p4-v2.txt/v3.txt)", async () => {
    const src =
      "let a: any = 3.9999999999999996;\n" +
      "console.log(`${a.toString(4)}`);\n" +
      "let b: any = 0.999999999999;\n" +
      "console.log(`${b.toString(2)}`);\n";
    const res = await buildWasm("radix-delta-term.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-delta-term.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("the fmod witnesses (CP1 ack R2: 2^53+2 at radix 3, and 1e21 in radices 6/7/9/11/13/15/19 — NOT radix 36, which does not redden)", async () => {
    const src =
      "let a: any = 9007199254740994;\n" +
      "console.log(`${a.toString(3)}`);\n" +
      "let b: any = 1e21;\n" +
      "console.log(`${b.toString(6)}`);\n" +
      "console.log(`${b.toString(7)}`);\n" +
      "console.log(`${b.toString(9)}`);\n" +
      "console.log(`${b.toString(11)}`);\n" +
      "console.log(`${b.toString(13)}`);\n" +
      "console.log(`${b.toString(15)}`);\n" +
      "console.log(`${b.toString(19)}`);\n" +
      "console.log(`${b.toString(36)}`);\n";
    const res = await buildWasm("radix-fmod.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-fmod.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("the delta<=0 termination guarantee (CP1 ack R13): every subnormal AND the whole smallest-normal binade, plus its mirror (the row that must NOT need the arm)", async () => {
    const src =
      "let a: any = 5e-324;\n" +
      "console.log(`${a.toString(2)}`);\n" +
      "console.log(`${a.toString(3)}`);\n" +
      "let b: any = 2.225073858507201e-308;\n" +
      "console.log(`${b.toString(3)}`);\n" +
      "let c: any = 2.2250738585072014e-308;\n" + // 2^-1022, a NORMAL number, arm live
      "console.log(`${c.toString(3)}`);\n" +
      "let d: any = 4.4501477170144023e-308;\n" + // top of the binade, arm live
      "console.log(`${d.toString(3)}`);\n" +
      "let e: any = 4.450147717014403e-308;\n" + // 2^-1021, arm NOT live — the mirror
      "console.log(`${e.toString(3)}`);\n";
    const res = await buildWasm("radix-delta-guarantee.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-delta-guarantee.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("the integer zero-fill (MAX_VALUE's ~181 trailing zeros at radix 36, and its radix-2 length) plus the subnormal radix-2 length", async () => {
    const src =
      "let a: any = Number.MAX_VALUE;\n" +
      "console.log(`${a.toString(36)}`);\n" +
      "console.log(`${a.toString(2)}`.length);\n" +
      "let b: any = 5e-324;\n" +
      "console.log(`${b.toString(2)}`.length);\n";
    const res = await buildWasm("radix-zerofill.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-zerofill.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("NaN/Infinity/±0/radix-10-passthrough/undefined-radix/string-radix/coercion/RangeError rows", async () => {
    const src =
      "let a: any = NaN;\n" +
      "console.log(`${a.toString(2)}`);\n" +
      "let b: any = -Infinity;\n" +
      "console.log(`${b.toString(16)}`);\n" +
      "let c: any = -0;\n" +
      "console.log(`${c.toString(2)}`);\n" +
      "let d: any = 0;\n" +
      "console.log(`${d.toString(36)}`);\n" +
      "let e: any = 42;\n" +
      "console.log(`${e.toString(10)}`);\n" +
      "console.log(`${e.toString(undefined)}`);\n" +
      "console.log(`${e.toString('16')}`);\n" +
      "console.log(`${e.toString(2.9)}`);\n" +
      "try { console.log(`${e.toString(1)}`); } catch (err) { console.log((err as Error).name + ': ' + (err as Error).message); }\n" +
      "try { console.log(`${e.toString(37)}`); } catch (err) { console.log((err as Error).name + ': ' + (err as Error).message); }\n" +
      "try { console.log(`${e.toString(NaN)}`); } catch (err) { console.log((err as Error).name + ': ' + (err as Error).message); }\n";
    const res = await buildWasm("radix-specials.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "radix-specials.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });
});

// ============================================================================
// DYN: Math.PI / Math.E (D4-i) — the getProp closed-table shape
// ============================================================================
describe("wasm dyn Math.PI / Math.E — D4-i, the getProp closed-table shape (CP1 ack R10: {PI, E} only)", () => {
  test("1112's own verbatim call, plus the bare values and Math.E", async () => {
    const src =
      "console.log(`${Math.PI.toFixed(3)}`);\n" +
      "console.log(`${Math.PI}`);\n" +
      "console.log(`${Math.E}`);\n" +
      "console.log(`${Math.E.toFixed(5)}`);\n";
    const res = await buildWasm("mathconst.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "mathconst.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("NEGATIVE CONTROL: a Math.<fn>() island call still REFUSES named (expr:jsOp is untouched by the getProp special case)", async () => {
    const res = await buildWasm("mathfn-negative.ts", "console.log(`${Math.LN10}`);\n", true);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics[0]?.code).toBe("SC2020");
  });

  test("board #124's nesting hole, closed: 1112's own Math.PI.toFixed no longer masks anything — the program claims byte-exact", async () => {
    const res = await buildWasm(
      "board124-closed.ts",
      "console.log(`${Math.PI.toFixed(3)}`);\n",
      true,
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe("3.142\n");
  });
});

// ============================================================================
// THE MERGE (R12): the fence's own two named examples now compute Node's digits
// ============================================================================
describe("wasm dyn toFixed — the MERGE (CP1 ack R12): S043 bullet (b)'s own two examples, red before this pass / green after", () => {
  test("S043's own two named calls, verbatim, through the dyn NUM receiver — the fence never fires", async () => {
    const src =
      "let a: any = 999999999999999;\n" +
      "console.log(`${a.toFixed(0)}`);\n" +
      "let b: any = 1234567890.12345;\n" +
      "console.log(`${b.toFixed(5)}`);\n" +
      "let c: any = 5;\n" +
      "console.log(`${c.toFixed(100)}`);\n"; // beyond the OLD intDigits+f<=14 window
    const res = await buildWasm("s043b-closed.ts", src, true);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.code + ":" + d.message).join(" | ")}`);
    const { stdout } = await runWasm(res.binaryPath);
    const jsFile = join(scratch, "s043b-closed.ts-oracle.js");
    await writeFile(jsFile, stripTsForOracle(src));
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
    expect(stdout).not.toContain("not supported yet");
  });
});
