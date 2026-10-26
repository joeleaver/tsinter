/* The Math unit (SEMANTICS.md S100): every Math method the island surface brings
 * to the WasmGC tier, bit for bit against the live Node that runs this suite.
 *
 * Each row class compiles ONE `// @dynamic` program under --backend wasm and runs
 * the SAME source under this process's Node (`--experimental-transform-types`);
 * the two stdouts must be equal byte for byte. No expected value is typed by
 * hand: the oracle is Node itself, so a Node whose V8 computes other bits (a
 * libm-trig build, an FMA-contracted build) reddens these rows instead of
 * passing them stale. Inputs ride in the source as IEEE-754 hex (decoded at run
 * time with Buffer.readDoubleBE, so nothing folds) and every result prints as
 * its full 64-bit pattern -- NaN payloads included, since Node's own NaNs here
 * are not all canonical (Math.log(-1) is 0x7ff4000000000000).
 *
 * Inputs per function (seeded xorshift64, so every run sees the same rows):
 * the edges (±0, NaN and NaN payloads, ±Infinity, the subnormal extremes,
 * MIN_NORMAL, MAX_VALUE, ...); for EVERY 32-bit high-word constant in that
 * function's own C text in ieee754-src.ts, the doubles at, just below and just
 * above that high word, both signs (so every `ix < 0x...` branch threshold of
 * the source is straddled); the named decimal thresholds; and ~4000 random
 * inputs over raw bit patterns, [-1, 1], [-10, 10], every binade, ±1e6,
 * 1 ± 1e-3 and the function's own domain. The trig rows add multiples of pi/2,
 * near and far, and inputs that need __kernel_rem_pio2's long reduction.
 *
 * Row classes: IEEE (the 19 one-argument ieee754.cc members), ATAN2 (its sign/quadrant cross
 * product), HYPOT (math.tq, arities 0 to 6), EXACT (sqrt, sign, fround,
 * f16round, clz32, imul, pow), DYN (dynamic arguments through ToNumber), NAN
 * (each NaN-returning path's bits, and the registered number[] divergence),
 * DISC (inputs on which a system libm or the original fdlibm answers
 * differently from Node -- the negative controls), LAZY (a module carries only
 * the C functions its Math members reach), CSUB (csubset.ts refuses, by name,
 * the C it does not model, rather than compile it wrongly). */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { IEEE754_CC } from "../src/backend/wasm/ieee754-src.js";
import { CCompiler, CSubsetError, parseC } from "../src/backend/wasm/csubset.js";
import { ModuleBuilder } from "../src/backend/wasm/module.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-ieee754-"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/* ── inputs ─────────────────────────────────────────────────────────────── */

const F = new Float64Array(1);
const U = new BigUint64Array(F.buffer);
const fromBits = (b: bigint): number => {
  U[0] = BigInt.asUintN(64, b);
  return F[0]!;
};
const toHex = (v: number): string => {
  F[0] = v;
  return U[0]!.toString(16).padStart(16, "0");
};

/** NaN inputs are carried by bit pattern (a JS NaN literal would lose its payload). */
const NAN_BITS = [0x7ff8000000000000n, 0xfff8000000000000n, 0x7ff4000000000000n, 0x7ff0000000000001n, 0xfff8dead0000beefn];

const EDGES: number[] = [
  0, -0, Infinity, -Infinity, 5e-324, -5e-324, fromBits(0x000fffffffffffffn), -fromBits(0x000fffffffffffffn),
  2.2250738585072014e-308, -2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308,
  1, -1, 0.5, -0.5, 2, -2, 3, 10, 0.1, 1e-8, 1e22, -1e22, 1e300, -1e300, 2 ** -28, 2 ** -27, 2 ** -54, 2 ** -1022,
  0.34657359027997264, 1.0397207708399179, 22, -22, 709.782712893384, 709.7827128933841, -745.1332191019412,
  -745.1332191019411, 710.4758600739439, 710.475860073944, 709.7822265625, 38.816242111356935, 0.975, 0.4375, 2.4375,
  Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4, Math.E, Math.LN2, Math.SQRT2, Math.SQRT1_2, 0.9999999999999999,
  1.0000000000000002, 6381956970095103 * 2 ** 797, -6381956970095103 * 2 ** 797, 1e-300, 1e-310,
];

function xorshift(seed: bigint): () => bigint {
  let s = seed;
  return () => {
    s ^= (s << 13n) & 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= (s << 17n) & 0xffffffffffffffffn;
    return s;
  };
}

/** The ~4000 seeded random inputs of one function, plus its domain class. */
function randoms(seed: bigint, n: number, domain: (u: () => number) => number): number[] {
  const next = xorshift(seed);
  const u = (): number => Number(next() >> 11n) / 2 ** 53;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    switch (i % 8) {
      case 0: out.push(fromBits(next())); break;
      case 1: out.push(u() * 2 - 1); break;
      case 2: out.push((u() * 2 - 1) * 10); break;
      case 3: out.push((u() < 0.5 ? -1 : 1) * (1 + u()) * 2 ** Math.floor(u() * 2098 - 1074)); break;
      case 4: out.push((u() * 2 - 1) * 1e6); break;
      case 5: out.push(1 + (u() * 2 - 1) * 1e-3); break;
      default: out.push(domain(u)); break;
    }
  }
  return out;
}

/** The C text of ieee754-src.ts's function `name` (its definition, to the closing brace in column 0). */
function cBody(name: string): string {
  const m = new RegExp(`^(?:[A-Za-z_0-9]+ )+${name}\\([^)]*\\) \\{$`, "m").exec(IEEE754_CC);
  if (m === null) throw new Error(`no definition of ${name} in ieee754-src.ts`);
  const end = IEEE754_CC.indexOf("\n}\n", m.index);
  return IEEE754_CC.slice(m.index, end);
}

/** Doubles straddling every high-word constant (0x00100000..0x7FF00000) in `name`'s C text and in the
 * C functions it is listed with; both signs. */
function thresholds(names: string[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const name of names) {
    for (const m of cBody(name).matchAll(/0x([0-9A-Fa-f]{8})\b/g)) {
      const hw = parseInt(m[1]!, 16);
      if (hw < 0x00100000 || hw > 0x7ff00000 || seen.has(hw)) continue;
      seen.add(hw);
      const base = BigInt(hw) << 32n;
      for (const d of [0n, -1n, 1n, 0xffffffffn, 0x100000000n]) {
        const b = base + d;
        if (b < 0n || b > 0x7ff0000000000000n) continue;
        out.push(fromBits(b), fromBits(b | (1n << 63n)));
      }
    }
  }
  return out;
}

/** k*pi/2 for small and large k, and their neighbours: the trig reductions' hard cases. */
function piMultiples(): number[] {
  const out: number[] = [];
  for (const k of [1, 2, 3, 4, 5, 7, 8, 16, 31, 32, 33, 100, 1000, 12345, 2 ** 19, 2 ** 19 + 1, 2 ** 20, 1e6, 1e9, 2 ** 52]) {
    const v = (k * Math.PI) / 2;
    F[0] = v;
    const b = U[0]!;
    for (const d of [-2n, -1n, 0n, 1n, 2n]) out.push(fromBits(b + d), -fromBits(b + d));
  }
  return out;
}

interface Unary {
  name: string;
  /** C functions whose thresholds this member's inputs straddle */
  c: string[];
  domain: (u: () => number) => number;
}

const TRIG = ["__ieee754_rem_pio2", "__kernel_sin", "__kernel_cos"];
const UNARY: Unary[] = [
  { name: "sin", c: ["sin", ...TRIG], domain: (u) => (u() * 2 - 1) * 2 ** Math.floor(u() * 1024) },
  { name: "cos", c: ["cos", ...TRIG], domain: (u) => (u() * 2 - 1) * 2 ** Math.floor(u() * 1024) },
  { name: "tan", c: ["tan", "__kernel_tan", "__ieee754_rem_pio2"], domain: (u) => (u() * 2 - 1) * 2 ** Math.floor(u() * 1024) },
  { name: "asin", c: ["asin"], domain: (u) => u() * 2 - 1 },
  { name: "acos", c: ["acos"], domain: (u) => u() * 2 - 1 },
  { name: "atan", c: ["atan"], domain: (u) => (u() * 2 - 1) * 2 ** Math.floor(u() * 140 - 70) },
  { name: "exp", c: ["exp"], domain: (u) => (u() * 2 - 1) * 750 },
  { name: "expm1", c: ["expm1"], domain: (u) => (u() * 2 - 1) * 60 },
  { name: "log", c: ["log"], domain: (u) => u() * 2 ** Math.floor(u() * 2098 - 1074) },
  { name: "log1p", c: ["log1p"], domain: (u) => u() * 2.5 - 1 },
  { name: "log2", c: ["log2"], domain: (u) => u() * 2 ** Math.floor(u() * 2098 - 1074) },
  { name: "log10", c: ["log10"], domain: (u) => u() * 2 ** Math.floor(u() * 2098 - 1074) },
  { name: "cbrt", c: ["cbrt"], domain: (u) => (u() * 2 - 1) * 2 ** Math.floor(u() * 2098 - 1074) },
  { name: "sinh", c: ["sinh"], domain: (u) => (u() * 2 - 1) * 720 },
  { name: "cosh", c: ["cosh"], domain: (u) => (u() * 2 - 1) * 720 },
  { name: "tanh", c: ["tanh"], domain: (u) => (u() * 2 - 1) * 25 },
  { name: "asinh", c: ["asinh"], domain: (u) => (u() * 2 - 1) * 2 ** Math.floor(u() * 80 - 40) },
  { name: "acosh", c: ["acosh"], domain: (u) => 1 + u() * 2 ** Math.floor(u() * 40 - 10) },
  { name: "atanh", c: ["atanh"], domain: (u) => u() * 2 - 1 },
];

/* ── programs ───────────────────────────────────────────────────────────── */

/** A program that applies `call` (over a, b, c, ...) to each `arity`-tuple of the inputs and prints
 * one result's bits per line. */
function program(call: string, arity: number, inputs: number[]): string {
  const params = ["a", "b", "c", "d", "e", "f"].slice(0, arity);
  const hex = inputs.map(toHex).join("");
  return [
    "// @dynamic",
    `const IN = "${hex}";`,
    'const inBuf = Buffer.from(IN, "hex");',
    "const outBuf = Buffer.alloc(8);",
    `const rows = inBuf.length / ${8 * Math.max(arity, 1)};`,
    "const lines: string[] = [];",
    "for (let i = 0; i < rows; i++) {",
    ...params.map((p, k) => `  const ${p} = inBuf.readDoubleBE((i * ${arity} + ${k}) * 8);`),
    `  outBuf.writeDoubleBE(${call}, 0);`,
    '  lines.push(outBuf.toString("hex"));',
    "}",
    'console.log(lines.join("\\n"));',
    "",
  ].join("\n");
}

let serial = 0;

/** Compiles `src` under --backend wasm and runs it; runs the same source under Node; returns both. */
async function both(src: string): Promise<{ wasm: string; node: string; module: Buffer }> {
  const id = `r${serial++}`;
  const entry = join(scratch, `${id}.ts`);
  await writeFile(entry, src);
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic: true });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code}: ${d.message}`).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  expect(String(run.stderr)).toBe("");
  expect(run.exitCode).toBe(0);
  const node = execFileSync(process.execPath, ["--no-warnings", "--experimental-transform-types", entry], { encoding: "utf8" });
  return { wasm: String(run.stdout), node, module: await readFile(res.binaryPath) };
}

/** Row-by-row equality, naming the first rows that differ (input, wasm bits, Node bits). */
function expectRows(what: string, inputs: number[], arity: number, wasm: string, node: string): void {
  const w = wasm.split("\n");
  const n = node.split("\n");
  const bad: string[] = [];
  for (let i = 0; i < Math.max(w.length, n.length); i++) {
    if (w[i] === n[i]) continue;
    const args = inputs.slice(i * arity, i * arity + arity).map(toHex).join(",");
    bad.push(`${what}(${args}) wasm=${w[i]} node=${n[i]}`);
    if (bad.length >= 5) break;
  }
  expect(bad, `${what}: rows that differ from Node`).toEqual([]);
  expect(n.length).toBe(Math.max(1, inputs.length / Math.max(arity, 1)) + 1);
}

const nanInputs = (): number[] => NAN_BITS.map(fromBits);

/* ── IEEE: the 19 unary ieee754.cc members ─────────────────────────────── */

describe("IEEE: V8's ieee754.cc, compiled, against Node", () => {
  test.for(UNARY.map((f, i) => [f.name, f, i] as const))("IEEE %s", async ([, f, i]) => {
    const inputs = [
      ...EDGES,
      ...nanInputs(),
      ...thresholds(f.c),
      ...(f.c.includes("__ieee754_rem_pio2") ? piMultiples() : []),
      ...randoms(0x9e3779b97f4a7c15n + BigInt(i) * 0x1234567n, 4000, f.domain),
    ];
    const { wasm, node } = await both(program(`Math.${f.name}(a)`, 1, inputs));
    expectRows(f.name, inputs, 1, wasm, node);
  });
});

/* ── ATAN2 ─────────────────────────────────────────────────────────────── */

test("ATAN2: the sign/quadrant cross product of the edges, thresholds and random pairs", async () => {
  const vals = [...EDGES.slice(0, 30), fromBits(0x7ff8000000000000n), fromBits(0x7ff4000000000000n)];
  const inputs: number[] = [];
  for (const y of vals) for (const x of vals) inputs.push(y, x);
  const ts = thresholds(["atan2", "atan"]);
  for (let i = 0; i < ts.length; i++) inputs.push(ts[i]!, 1, 1, ts[i]!, ts[i]!, -1);
  const next = xorshift(0x5555aaaa12345678n);
  const u = (): number => Number(next() >> 11n) / 2 ** 53;
  for (let i = 0; i < 4000; i++) {
    const k = i % 4;
    if (k === 0) inputs.push(fromBits(next()), fromBits(next()));
    else if (k === 1) inputs.push((u() * 2 - 1) * 10, (u() * 2 - 1) * 10);
    else if (k === 2) inputs.push((u() * 2 - 1) * 2 ** Math.floor(u() * 200 - 100), (u() * 2 - 1) * 2 ** Math.floor(u() * 200 - 100));
    else inputs.push(u() * 2 - 1, 1);
  }
  const { wasm, node } = await both(program("Math.atan2(a, b)", 2, inputs));
  expectRows("atan2", inputs, 2, wasm, node);
});

/* ── HYPOT ─────────────────────────────────────────────────────────────── */

describe("HYPOT: V8's math.tq MathHypot at every arity", () => {
  const calls = ["Math.hypot()", "Math.hypot(a)", "Math.hypot(a, b)", "Math.hypot(a, b, c)", "Math.hypot(a, b, c, d)", "Math.hypot(a, b, c, d, e)", "Math.hypot(a, b, c, d, e, f)"];
  test.for(calls.map((c, k) => [k, c] as const))("HYPOT arity %i", async ([k, call]) => {
    const special = [0, -0, 1, -3, 1e300, 1e-300, 5e-324, Infinity, -Infinity, fromBits(0x7ff8000000000000n), fromBits(0xfff8dead0000beefn), 1.7976931348623157e308];
    const next = xorshift(0x1111222233334444n + BigInt(k));
    const u = (): number => Number(next() >> 11n) / 2 ** 53;
    const inputs: number[] = [];
    const rows = k === 0 ? 1 : 3000;
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < k; j++) {
        const m = (r + j) % 5;
        if (r < 400) inputs.push(special[(r * 7 + j * 3 + Math.floor(r / 12)) % special.length]!);
        else if (m === 0) inputs.push(fromBits(next()));
        else if (m === 1) inputs.push((u() * 2 - 1) * 2 ** Math.floor(u() * 2000 - 1000));
        else inputs.push((u() * 2 - 1) * 10);
      }
    }
    const { wasm, node } = await both(program(call, k, inputs));
    if (k === 0) {
      expect(wasm).toBe(node);
      return;
    }
    expectRows(`hypot/${k}`, inputs, k, wasm, node);
  });
});

/* ── EXACT: the members that are one operation ─────────────────────────── */

describe("EXACT: sqrt, sign, fround, f16round, clz32, imul, pow", () => {
  const next = xorshift(0x0123456789abcdefn);
  const u = (): number => Number(next() >> 11n) / 2 ** 53;
  const generic = [...EDGES, ...nanInputs(), ...randoms(0x42n, 3000, (uu) => (uu() * 2 - 1) * 2 ** 40)];
  /** Binary16 values and the midpoints between neighbours, with a double ulp either side
   * (every 3rd subnormal and top-binade value, every 61st elsewhere). */
  const halfs: number[] = [];
  for (let h = 0; h <= 0x7c00; h++) {
    const e = h >> 10;
    if (!(e === 0 || e >= 0x1e ? h % 3 === 0 : h % 61 === 0)) continue;
    const v = e === 0 ? (h & 0x3ff) * 2 ** -24 : (1 + (h & 0x3ff) / 1024) * 2 ** (e - 15);
    const w = e === 0 ? ((h & 0x3ff) + 1) * 2 ** -24 : (1 + ((h & 0x3ff) + 1) / 1024) * 2 ** (e - 15);
    const mid = (v + w) / 2;
    F[0] = mid;
    const mb = U[0]!;
    for (const x of [v, mid, fromBits(mb - 1n), fromBits(mb + 1n)]) halfs.push(x, -x);
  }
  const ints = [0, 1, -1, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, -(2 ** 53) - 2, 4294967295, 0.5, -0.5, 1e20, -1e20, 123456789.9];
  const cases: [string, string, number, () => number[]][] = [
    ["sqrt", "Math.sqrt(a)", 1, () => generic],
    ["sign", "Math.sign(a)", 1, () => generic],
    ["fround", "Math.fround(a)", 1, () => [...generic, 3.4028235677973366e38, 3.4028235677973362e38, 1.401298464324817e-45, 7.006492321624085e-46, 7.006492321624087e-46]],
    ["f16round", "Math.f16round(a)", 1, () => [...generic, ...halfs, 65504, 65519.99999999999, 65520, 65536, 2 ** -24, 2 ** -25, 2 ** -25 + 2 ** -78, 3 * 2 ** -26]],
    ["clz32", "Math.clz32(a)", 1, () => [...generic, ...ints]],
    ["imul", "Math.imul(a, b)", 2, () => {
      const out: number[] = [];
      for (const a of ints) for (const b of ints) out.push(a, b);
      for (let i = 0; i < 2000; i++) out.push((u() * 2 - 1) * 2 ** Math.floor(u() * 70), (u() * 2 - 1) * 2 ** Math.floor(u() * 70));
      return out;
    }],
    ["pow", "Math.pow(a, b)", 2, () => {
      const out: number[] = [];
      for (const a of EDGES.slice(0, 24)) for (const b of [0, -0, 0.5, -0.5, 1, -1, 2, 3, -3, 0.25, 1e10, Infinity, -Infinity, fromBits(0x7ff8000000000000n)]) out.push(a, b);
      for (let i = 0; i < 2000; i++) out.push(u() * 10, (u() * 2 - 1) * 50);
      return out;
    }],
  ];
  test.for(cases)("EXACT %s", async ([name, call, arity, make]) => {
    const inputs = make();
    const { wasm, node } = await both(program(call, arity, inputs));
    if (name === "pow") {
      // Math.pow is `**` (%w.jsPow): its OWN returned NaN is the canonical one where Node's
      // is the hardware's -- the registered divergence of SEMANTICS.md S036 (board #158) --
      // so pow's NaNs compare as a class here, as in wasm-pow-u6.test.ts.
      const cls = (out: string): string =>
        out.split("\n").map((l) => (/^[7f]ff/.test(l) && !/^[7f]ff0{13}$/.test(l) ? "NaN" : l)).join("\n");
      expectRows(name, inputs, arity, cls(wasm), cls(node));
      return;
    }
    expectRows(name, inputs, arity, wasm, node);
  });
});

/* ── DYN: dynamic arguments get ToNumber ───────────────────────────────── */

test("DYN: dynamic (any) arguments convert with ToNumber before the computation, as Node's Math does", async () => {
  const src = [
    "// @dynamic",
    `const xs: any = JSON.parse('["1.5", " -2e3 ", "0x10", "", "abc", null, true, false, [], [7], "Infinity", "-0", 3]');`,
    "const buf = Buffer.alloc(8);",
    'const bits = (v: number): string => { buf.writeDoubleBE(v, 0); return buf.toString("hex"); };',
    "const n: number = xs.length;",
    "for (let i = 0; i < n; i++) {",
    "  const x: any = xs[i];",
    // each result goes straight to bits(): a number[] would let Node silence a signaling NaN (NAN below)
    "  console.log(bits(Math.sin(x)), bits(Math.log1p(x)), bits(Math.cbrt(x)), bits(Math.atan2(x, 2)), bits(Math.atan2(2, x)),",
    "    bits(Math.hypot(x, 1, x)), bits(Math.sqrt(x)), bits(Math.sign(x)), bits(Math.fround(x)), bits(Math.f16round(x)),",
    "    bits(Math.clz32(x)), bits(Math.imul(x, 3)), bits(Math.pow(x, 2)), bits(Math.tanh(x)));",
    "}",
    "",
  ].join("\n");
  const { wasm, node } = await both(src);
  expect(wasm).toBe(node);
});

/* ── NAN: the NaN each member returns, by provenance ───────────────────── */

test("NAN: Node's own NaN bits -- ieee754.cc's signaling_NaN() (0x7ff4...), quiet_NaN(), the hardware's -- and the registered number[] divergence", async () => {
  // arguments pass through id() so no call is literal-only
  const calls = ["Math.log(id(-1))", "Math.log2(id(-1))", "Math.log1p(id(-2))", "Math.acos(id(2))", "Math.asin(id(-2))",
    "Math.acosh(id(0.5))", "Math.atanh(id(2))", "Math.log10(id(-1))", "Math.sin(id(Infinity))", "Math.cos(id(-Infinity))",
    "Math.tan(id(Infinity))", "Math.sqrt(id(-1))", "Math.log(Math.log(id(-1)))", "Math.exp(id(NaN))", "Math.hypot(id(NaN), 1)",
    "Math.f16round(-id(NaN))", "Math.fround(Math.log(id(-1)))"];
  const src = [
    "// @dynamic",
    "const buf = Buffer.alloc(8);",
    'const bits = (v: number): string => { buf.writeDoubleBE(v, 0); return buf.toString("hex"); };',
    "const id = (v: number): number => v;",
    ...calls.map((c) => `console.log(${JSON.stringify(c)}, bits(${c}));`),
    "",
  ].join("\n");
  const { wasm, node } = await both(src);
  expect(wasm).toBe(node);
  expect(node.split("\n")[0]).toBe("Math.log(id(-1)) 7ff4000000000000");
  // SEMANTICS.md S100: a signaling NaN stored into a number[] -- V8 silences it on the way into a
  // double-elements backing store, this tier stores the bits -- so the same value reads back 0x7ffc...
  // in Node and 0x7ff4... here. Pinned both ways; the oracle half is live.
  const arr = "// @dynamic\nconst buf = Buffer.alloc(8);\nconst id = (v: number): number => v;\nconst a = [Math.log(id(-1))];\nbuf.writeDoubleBE(a[0]!, 0);\nconsole.log(buf.toString(\"hex\"));\n";
  const stored = await both(arr);
  expect(stored.node).toBe("7ffc000000000000\n");
  expect(stored.wasm).toBe("7ff4000000000000\n");
});

/* ── DISC: the negative controls ───────────────────────────────────────── */

/* Seven inputs on which another implementation of the same function answers
 * differently from Node, measured on this machine (scratch programs, not part of
 * the suite): GNU libc 2.43 (Ubuntu 2.43-2ubuntu2.4, x86-64), the system libm a
 * native build would call; and Java's StrictMath (OpenJDK 25.0.4.1), the original
 * fdlibm 5.3 that ieee754.cc started from. A transcription that fell back to
 * either, or lost V8's changes (exp(1) == E, the FreeBSD-msun cosh/tanh/cbrt),
 * reddens the row: Node's bits are checked against the alternative here, and
 * the tier's against Node's. */
const DISC: { call: string; glibc: string; fdlibm: string }[] = [
  { call: "Math.log(3)", glibc: "3ff193ea7aad030b", fdlibm: "3ff193ea7aad030a" },
  { call: "Math.cbrt(2)", glibc: "3ff428a2f98d728c", fdlibm: "3ff428a2f98d728b" },
  { call: "Math.sin(-3.1902814782969835)", glibc: "3fa8eb3872e25af7", fdlibm: "3fa8eb3872e25af8" },
  { call: "Math.exp(1)", glibc: "4005bf0a8b145769", fdlibm: "4005bf0a8b14576a" },
  { call: "Math.cosh(1)", glibc: "3ff8b07551d9f550", fdlibm: "3ff8b07551d9f551" },
  { call: "Math.tanh(1.0487516560492713e-13)", glibc: "3d3d850d56f02811", fdlibm: "3d3d850d56f02811" },
  { call: "Math.cbrt(0.9991103149666114)", glibc: "3feffd91e16bca6e", fdlibm: "3feffd91e16bca6d" },
];

test("DISC: inputs a system libm or the original fdlibm answers differently -- each row discriminates, and the tier answers Node's bits", async () => {
  const src = [
    "// @dynamic",
    "const buf = Buffer.alloc(8);",
    'const bits = (v: number): string => { buf.writeDoubleBE(v, 0); return buf.toString("hex"); };',
    // the arguments go through a function so the call is not a literal-only expression
    "const id = (v: number): number => v;",
    ...DISC.map((d) => `console.log(bits(${d.call.replace(/\(([^)]*)\)$/, "(id($1))")}));`),
    "",
  ].join("\n");
  const { wasm, node } = await both(src);
  expect(wasm).toBe(node);
  const nodeBits = node.trim().split("\n");
  DISC.forEach((d, i) => {
    // every row is wrong under at least one substitute, and the set covers both
    expect(nodeBits[i] !== d.glibc || nodeBits[i] !== d.fdlibm, `${d.call} discriminates nothing`).toBe(true);
  });
  expect(DISC.filter((d, i) => nodeBits[i] !== d.glibc).length).toBeGreaterThanOrEqual(4);
  expect(DISC.filter((d, i) => nodeBits[i] !== d.fdlibm).length).toBeGreaterThanOrEqual(4);
});

/* ── LAZY: a module carries only what its members reach ────────────────── */

test("LAZY: only the C functions a program's Math members reach are compiled into its module", async () => {
  const names = (m: Buffer): string[] => {
    const text = m.toString("latin1");
    return [...new Set([...text.matchAll(/%w\.ieee754\.([A-Za-z_0-9]+)/g)].map((x) => x[1]!))].sort();
  };
  const exact = await both("// @dynamic\nconst x: number = JSON.parse('2');\nconsole.log(Math.sqrt(x), Math.sign(-x), Math.hypot(x, x), Math.clz32(x));\n");
  expect(exact.wasm).toBe(exact.node);
  expect(names(exact.module)).toEqual([]);
  const sin = await both("// @dynamic\nconst x: number = JSON.parse('2');\nconsole.log(Math.sin(x * 1e300));\n");
  expect(sin.wasm).toBe(sin.node);
  expect(names(sin.module)).toEqual(["__ieee754_rem_pio2", "__kernel_cos", "__kernel_rem_pio2", "__kernel_sin", "scalbn", "sin"]);
  const acosh = await both("// @dynamic\nconst x: number = JSON.parse('2');\nconsole.log(Math.acosh(x + 0.5));\n");
  expect(acosh.wasm).toBe(acosh.node);
  expect(names(acosh.module)).toEqual(["acosh", "log", "log1p"]);
});

/* ── CSUB: what the C-subset compiler refuses ───────────────────────────── */

/** Compiles C function `f` of `src` alone and calls it on 0; a refusal comes back as its message. */
async function cRun(src: string, f = "f"): Promise<number | string> {
  try {
    const mb = new ModuleBuilder();
    const cc = new CCompiler(mb, parseC(src, {}), "t.");
    mb.exportFunc(f, cc.fn(f));
    const { instance } = await WebAssembly.instantiate(mb.emit());
    return (instance.exports[f] as (x: number) => number)(0);
  } catch (e) {
    if (!(e instanceof CSubsetError)) throw e;
    return e.message;
  }
}

describe("CSUB: csubset.ts refuses what it does not model", () => {
  const refused: [string, string, string][] = [
    // a table element type the i32/f64 arrays would store wrongly (0xFFFFFFFF would read back -1)
    ["uint32_t table", "double f(double x) { static const uint32_t tab[] = {0xFFFFFFFF, 1}; return tab[0]; }", "static table tab of uint"],
    ["uint64_t table", "double f(double x) { static const uint64_t tab[] = {0x123456789, 1}; return tab[0]; }", "static table tab of u64"],
    ["file-scope table", "static const uint32_t T[] = {1};\ndouble f(double x) { return T[0]; }", "static table T of uint"],
    // a second definition would otherwise silently replace the first
    ["duplicate constant", "static const double K = 1.0;\nstatic const double K = 2.0;\ndouble f(double x) { return K; }", "a second file-scope definition of K"],
    ["duplicate function", "double f(double x) { return 1; }\ndouble f(double x) { return 2; }", "a second file-scope definition of f"],
    // mutable static state (statics are compile-time constants here)
    ["static int", "double f(double x) { static int c = 0; c++; return c; }", "neither const nor volatile"],
    ["write to a static const", "double f(double x) { static const int c = 0; c++; return c; }", "++/-- on the static constant c"],
    ["assign to a static const", "double f(double x) { static const double c = 0; c = 1; return c; }", "assignment to the static constant c"],
    // shift counts C leaves undefined (wasm would take them modulo the width)
    ["int << 33", "double f(double x) { int a = 1; return a << 33; }", "a shift by 33 of a 32-bit value"],
    ["uint64_t << 64", "double f(double x) { uint64_t v = 1; return v << 64; }", "a shift by 64 of a 64-bit value"],
    ["int >> -1", "double f(double x) { int a = 8; return a >> -1; }", "a shift by -1 of a 32-bit value"],
    ["int <<= 32 via a constant", "static const int W = 32;\ndouble f(double x) { int a = 1; a <<= W; return a; }", "a shift by 32 of a 32-bit value"],
    // #if over a non-integer
    ["#if 1.5", "#if 1.5\n#endif\ndouble f(double x) { return 1; }", "bad integer literal 1.5"],
  ];
  test.for(refused)("CSUB refuses %s", async ([, src, msg]) => {
    const r = await cRun(src);
    expect(typeof r, `compiled to ${r}`).toBe("string");
    expect(r).toContain(msg);
  });

  test("CSUB accepts the in-range forms next to them", async () => {
    expect(await cRun("double f(double x) { static const int tab[] = {-2, 3}; return tab[0] * tab[1]; }")).toBe(-6);
    expect(await cRun("double f(double x) { uint64_t v = 1; return static_cast<double>(v << 63) > 0; }")).toBe(1);
    expect(await cRun("double f(double x) { static volatile double tiny = 1.0e-300; return tiny * 2; }")).toBe(2e-300);
    // #if reads an integer literal's suffix as C does: 0L is false, 1UL true
    expect(await cRun("#if 0L\ndouble f(double x) { return 1; }\n#else\ndouble f(double x) { return 2; }\n#endif\n")).toBe(2);
    expect(await cRun("#if 1UL\ndouble f(double x) { return 1; }\n#else\ndouble f(double x) { return 2; }\n#endif\n")).toBe(1);
  });
});
