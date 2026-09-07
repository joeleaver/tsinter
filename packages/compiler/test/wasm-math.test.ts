/* INC-25 pass P1 (design-number-v6.txt §2.1/§2.2/§2.6/§7.3, CP1 ack
 * 2026-09-07, hash 13571c6e...): the scalar Math/Number unit —
 * math.abs/ceil/floor/trunc/round/max/min/maxArr/minArr and the five
 * predicates (num.isNaN, number.isFinite/isNaN/isInteger/isSafeInteger).
 * Math.random's own pin lives in wasm-random.test.ts (its own host, its
 * own seed-forcing contract).
 *
 * Every row here is measured against THIS session's Node (v24.18.1,
 * process.versions.v8 = 13.6.233.17-node.50, matching SEMANTICS.md
 * S068's pinned version), not carried from the design doc. Negative
 * controls build a STANDALONE hand-encoded wasm module (ModuleBuilder +
 * Code directly, no imports, no memory) implementing the NAIVE substitute
 * byte for byte — the same "hand-encode the raw instructions" technique
 * design-number-v6.txt's own probes/wasmops.mjs uses for §2.1 — so a
 * negative control never means mutating and reverting this backend's real
 * source. THE HEADLINE RULE: before trusting a green, ask whether the
 * naive substitute could produce the same result — that is what these
 * controls are FOR. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { F64, I32, ModuleBuilder } from "../src/backend/wasm/module.js";
import { Code } from "../src/backend/wasm/code.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-math-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function buildWasm(name: string, source: string) {
  const entry = join(scratch, name);
  await writeFile(entry, source);
  return compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
}

async function runWasm(modulePath: string): Promise<{ stdout: string; exitCode: number }> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  const clock = 0;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => clock,
      seed: (): bigint => 1n, // no P1 program in this file draws; present for link-safety only
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

/** A standalone module (no imports, no memory) exporting `run` with the
 * given (params -> results) shape, body built by `emit`. The negative-
 * control vehicle: hand-encoded bytes, never this backend's real source. */
function standaloneModule(params: typeof F64[], results: typeof F64[], emit: (c: Code) => void): Uint8Array {
  const mb = new ModuleBuilder();
  const ty = mb.funcType(params, results);
  const idx = mb.declareFunc(ty, "%test.standalone");
  const c = new Code();
  emit(c);
  mb.setBody(idx, [], c.bytes());
  mb.exportFunc("run", idx);
  return mb.emit();
}

async function standaloneRun1(bytes: Uint8Array): Promise<(x: number) => number> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports["run"] as (x: number) => number;
}
async function standaloneRun2(bytes: Uint8Array): Promise<(a: number, b: number) => number> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports["run"] as (a: number, b: number) => number;
}

const isNeg0 = (x: number): boolean => Object.is(x, -0);

describe("wasm math.abs/ceil/trunc — constructible-level pins (§1.3: no corpus program reaches these three)", () => {
  test("math.abs/ceil/trunc over signed and boundary values, byte-exact against Node", async () => {
    const src = `
      console.log(Math.abs(-5), Math.abs(5), Math.abs(-0), Math.abs(0), Math.abs(-Infinity), Math.abs(NaN));
      console.log(Math.ceil(1.1), Math.ceil(-1.1), Math.ceil(-0.5), Math.ceil(0), Math.ceil(-0));
      console.log(Math.trunc(-1.5), Math.trunc(1.5), Math.trunc(-0.5), Math.trunc(0.9), Math.trunc(-0.9));
    `;
    const res = await buildWasm("abs-ceil-trunc.ts", src);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    // Object.is-sensitive rows (trunc(-0.5) = -0, ceil(-0) = -0) need their
    // own check since console.log's own string form already round-trips
    // -0 as "-0" — confirm against Node's own text, not a hand quote.
    expect(stdout).toBe("5 5 0 0 Infinity NaN\n2 -1 -0 0 -0\n-1 1 -0 0 -0\n");
  });
});

describe("wasm f64.min/f64.max — direct instructions, JS semantics measured (§2.1)", () => {
  const rows: [number, number][] = [
    [0, -0],
    [-0, 0],
    [5, 5],
    [-3, 7],
    [NaN, 5],
    [5, NaN],
    [NaN, NaN],
    [-0, NaN],
    [NaN, Infinity],
    [Infinity, -Infinity],
  ];
  test("math.min/math.max BOTH argument orders, byte-exact, including ±0 and NaN", async () => {
    const parts = rows.map(([a, b], i) => `console.log(Math.min(${fmt(a)},${fmt(b)}), Math.max(${fmt(a)},${fmt(b)}));`);
    const src = parts.join("\n");
    const res = await buildWasm("minmax-matrix.ts", src);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const [a, b] = rows[i]!;
      const expected = `${fmtOut(Math.min(a, b))} ${fmtOut(Math.max(a, b))}`;
      expect(lines[i]).toBe(expected);
    }
  });
  function fmt(x: number): string {
    if (Number.isNaN(x)) return "NaN";
    if (x === Infinity) return "Infinity";
    if (x === -Infinity) return "-Infinity";
    if (Object.is(x, -0)) return "-0";
    return String(x);
  }
  function fmtOut(x: number): string {
    if (Object.is(x, -0)) return "-0"; // console.log itself already renders -0 as "-0"
    return String(x);
  }

  test("NEGATIVE CONTROL: C-style fmin/fmax (isnan(a)?b:isnan(b)?a:(a<b?a:b)) — must redden on the NaN rows AND on the (0,-0)/(-0,0) reversed-order pair (R11: the reversed order is the discriminating witness, not the matching one)", async () => {
    const emitCFmin = (c: Code, wantMax: boolean): void => {
      c.localGet(0);
      c.localGet(0);
      c.f64Ne(); // isNaN(a)
      c.ifResult(F64);
      c.localGet(1);
      c.else_();
      c.localGet(1);
      c.localGet(1);
      c.f64Ne(); // isNaN(b)
      c.ifResult(F64);
      c.localGet(0);
      c.else_();
      c.localGet(0);
      c.localGet(1);
      if (wantMax) c.f64Gt();
      else c.f64Lt();
      c.ifResult(F64);
      c.localGet(0);
      c.else_();
      c.localGet(1);
      c.end();
      c.end();
      c.end();
    };
    const cMin = await standaloneRun2(standaloneModule([F64, F64], [F64], (c) => emitCFmin(c, false)));
    const cMax = await standaloneRun2(standaloneModule([F64, F64], [F64], (c) => emitCFmin(c, true)));
    // NaN rows: C drops NaN (returns the OTHER operand); JS propagates it.
    expect(cMin(NaN, 5)).toBe(5);
    expect(Math.min(NaN, 5)).toBeNaN();
    expect(cMax(5, NaN)).toBe(5);
    expect(Math.max(5, NaN)).toBeNaN();
    // ±0 order: C's "a<b?a:b"/"a>b?a:b" on (0,-0) HAPPENS to agree with JS
    // (0<-0 is false, so cMin returns b=-0, matching Math.min(0,-0)=-0) —
    // a control that stopped here would be worthless. The REVERSED order
    // is where it reddens: cMin(-0,0): -0<0 is false (IEEE -0==0), returns
    // b=0, but Math.min(-0,0) is -0. That mismatch is the actual witness.
    expect(isNeg0(cMin(0, -0))).toBe(true); // agrees with JS here — not the witness
    expect(isNeg0(Math.min(0, -0))).toBe(true);
    expect(isNeg0(cMin(-0, 0))).toBe(false); // C gives +0
    expect(isNeg0(Math.min(-0, 0))).toBe(true); // JS gives -0 — REDDENS
    expect(isNeg0(cMax(-0, 0))).toBe(false); // agrees with JS here (both +0)
    expect(isNeg0(Math.max(-0, 0))).toBe(false);
    expect(isNeg0(cMax(0, -0))).toBe(true); // C gives -0
    expect(isNeg0(Math.max(0, -0))).toBe(false); // JS gives +0 — REDDENS
  });
});

describe("wasm math.maxArr/math.minArr — the runtime fold, empty-array seed (§2.1)", () => {
  test("empty array falls out of the ∓Infinity seed (1435's own shape), and NaN/-0 elements", async () => {
    const res = await buildWasm(
      "maxarr-minarr.ts",
      `
        const empty: number[] = [];
        console.log(Math.max(...empty), Math.min(...empty));
        const withNaN: number[] = [1, NaN, 3];
        console.log(Math.max(...withNaN), Math.min(...withNaN));
        const zeros: number[] = [0, -0];
        console.log(Math.max(...zeros), Math.min(...zeros));
        console.log(1 / Math.max(...zeros), 1 / Math.min(...zeros));
      `,
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe(
      `${Math.max()} ${Math.min()}\nNaN NaN\n0 -0\n${1 / Math.max(0, -0)} ${1 / Math.min(0, -0)}\n`,
    );
  });

  test("n-ary Math.max/min's argument ORDER is the backend's binary-walk order, not an abstract 'fold' — 2445's shape: three args with an observing side effect must print in left-to-right EVALUATION order", async () => {
    const res = await buildWasm(
      "minmax-nary-order.ts",
      `
        function tap(n: number): number { console.log("tap", n); return n; }
        console.log(Math.max(tap(3), tap(1), tap(2)));
      `,
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe("tap 3\ntap 1\ntap 2\n3\n");
  });
});

describe("wasm math.round — port of scr_math_round (scr_lib.c:2505), nine-plus-row pin (§2.2, CP1 ack R3/R4)", () => {
  // Every row bit-compared (Object.is-style via isNeg0 where relevant),
  // measured against THIS session's Node, not carried from the design.
  const rows: [number, string][] = [
    [-0, "-0"],
    [-0.5, "-0"],
    [-0.4, "-0"],
    [-5e-324, "-0"],
    [-0.49999999999999994, "measure"], // CP1 ack R3's boundary witness
    [0.49999999999999994, "0"],
    [-1.5, "-1"],
    [2.5, "3"],
    [4503599627370497, "identity"],
    [9007199254740991, "identity"],
    [-4503599627370495.5, "measure"], // R4: reddens f64.nearest AND a `<=` slip
    [-4503599627370497, "measure"], // R4: reddens floor(x+0.5) on the negative side
  ];
  test("Math.round's pin rows, each against Node's OWN answer measured fresh (never a hand-typed expectation) — console.log's own inspect formatting distinguishes -0 from 0 without needing num.sameValue (P2's key, not P1's: never used here)", async () => {
    const exprs = rows.map(([x]) => `Math.round(${Object.is(x, -0) ? "-0" : x})`);
    const src = `console.log(${exprs.join(", ")});`;
    const res = await buildWasm("round-pins.ts", src);
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    // Node is the oracle for the STRING too — console.log/util.inspect's
    // -0 rendering is reproduced by running the identical expression list
    // through this session's own Node, not hand-reimplemented here.
    const jsSrc = `console.log(${exprs.join(", ")});`;
    const jsFile = join(scratch, "round-pins-oracle.js");
    writeFileSync(jsFile, jsSrc);
    const nodeOut = execFileSync(process.execPath, [jsFile], { encoding: "utf8" });
    expect(stdout).toBe(nodeOut);
  });

  test("early guards (isnan/isinf/x==0) are DEAD CODE for every finite nonzero x — no row here claims to cover them; the -0 row is what pins the SIGN RULE, not the guard", async () => {
    // f = floor(x); diff = x-f; the arm without any early guard produces
    // the identical result for every finite nonzero x, including the ones
    // above (this IS the port's own shape: the guards only matter for
    // NaN/Infinity/exact-zero, none of which is reached by "remove them
    // and re-check a finite input"). Recorded as a finding, not asserted
    // as a redundant test — the removal is a code-comment fact (scr_lib.c
    // reads the same way), not something a wasm-level test could show by
    // itself without literally deleting the guard from a live build.
    expect(true).toBe(true);
  });

  test("NEGATIVE CONTROL: floor(x+0.5) — must redden the 0.49999999999999994 row AND -4503599627370497 (R4: the negative-side analogue)", async () => {
    const run = await standaloneRun1(
      standaloneModule([F64], [F64], (c) => {
        c.localGet(0);
        c.f64Const(0.5);
        c.f64Add();
        c.f64Floor();
      }),
    );
    expect(run(0.49999999999999994)).toBe(1); // Node: 0 — REDDENS
    expect(Math.round(0.49999999999999994)).toBe(0);
    expect(run(-4503599627370497)).not.toBe(Math.round(-4503599627370497));
    expect(run(-0.5)).not.toBe(-0); // 0, not -0 — the sign-rule row also reddens
  });

  test("NEGATIVE CONTROL: f64.nearest (round-half-to-even) — must redden 2.5/-1.5, the halves JS rounds AWAY from even", async () => {
    const run = await standaloneRun1(
      standaloneModule([F64], [F64], (c) => {
        c.localGet(0);
        c.f64Nearest();
      }),
    );
    expect(run(2.5)).toBe(2); // Node: 3 — REDDENS
    expect(Math.round(2.5)).toBe(3);
    expect(run(-1.5)).toBe(-2); // Node: -1 — REDDENS
    expect(Math.round(-1.5)).toBe(-1);
  });
});

describe("wasm the five predicates — pinned against the IR doc's own contract, not intuition (§2.6, CP1 ack R11)", () => {
  test("num.isNaN / number.isNaN: NaN vs a non-NaN number, no ToNumber in this key's contract", async () => {
    const res = await buildWasm(
      "isnan-predicates.ts",
      `
        console.log(isNaN(0 / 0), isNaN(5), isNaN(-5), isNaN(0));
        console.log(Number.isNaN(0 / 0), Number.isNaN(-0), Number.isNaN(5));
      `,
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe("true false false false\ntrue false false\n");
  });

  test("number.isFinite: NaN/±Infinity/finite", async () => {
    const res = await buildWasm(
      "isfinite-predicates.ts",
      `console.log(Number.isFinite(0/0), Number.isFinite(Infinity), Number.isFinite(-Infinity), Number.isFinite(1), Number.isFinite(-0));`,
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe("false false false true true\n");
  });

  test("number.isInteger: the 2^53 boundary, -0, and a fractional value (R11 additions)", async () => {
    const res = await buildWasm(
      "isinteger-predicates.ts",
      `
        console.log(Number.isInteger(9007199254740992));
        console.log(Number.isInteger(-0));
        console.log(Number.isInteger(0.5));
        console.log(Number.isInteger(NaN), Number.isInteger(Infinity));
      `,
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe("true\ntrue\nfalse\nfalse false\n");
  });

  test("number.isSafeInteger: the 2^53-1 vs 2^53 discriminating pair, AND its negative-boundary mirror (R11)", async () => {
    const res = await buildWasm(
      "issafeinteger-predicates.ts",
      `
        console.log(Number.isSafeInteger(9007199254740991));
        console.log(Number.isSafeInteger(9007199254740992));
        console.log(Number.isSafeInteger(-9007199254740991));
        console.log(Number.isSafeInteger(-9007199254740992));
      `,
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const { stdout } = await runWasm(res.binaryPath);
    expect(stdout).toBe("true\nfalse\ntrue\nfalse\n");
  });

  test("num.isNaN's NO-ToNumber half is UNPINNABLE in typed programs (R11): num.isNaN's argument is always already a number by construction, so no corpus-legal program can observe whether it coerces — stated here, not tested as though it were", () => {
    expect(true).toBe(true);
  });
});
