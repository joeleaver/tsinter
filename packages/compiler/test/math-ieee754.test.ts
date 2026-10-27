/* Math on every lane (SEMANTICS.md S100): every Math member, bit for bit
 * against the live Node that runs this suite, on the wasm, c and llvm lanes.
 * Every lane computes from ONE copy of V8's own code: the transcendentals are
 * V8 13.6's src/base/ieee754.cc, vendored once (packages/runtime/vendor/
 * v8-ieee754) -- the native lanes compile it as C++ (scr_ieee754.cc), the
 * WasmGC tier compiles the text generated from it (ieee754-src.ts, csubset.ts;
 * the drift test pins the two together) -- and the members V8 computes in its
 * builtins (pow, hypot, sign, f16round, ...) are ported once per runtime from
 * V8's source.
 *
 * Each row class compiles ONE program per lane (a plain build: Math needs no
 * engine anywhere) and runs the SAME source under this process's Node
 * (`--experimental-transform-types`); the stdouts must be equal byte for
 * byte. No expected value is typed by hand: the oracle is Node itself, so a
 * Node whose V8 computes other bits (a libm-trig build, an FMA-contracted
 * build) reddens these rows instead of passing them stale. Inputs ride in the
 * source as IEEE-754 hex (decoded at run time with Buffer.readDoubleBE, so
 * nothing folds) and every result prints as its full 64-bit pattern -- NaN
 * payloads included, since Node's own NaNs here are not all canonical
 * (Math.log(-1) is 0x7ff4000000000000).
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
 * Row classes, per lane: IEEE (the 19 one-argument ieee754.cc members), ATAN2
 * (its sign/quadrant cross product), HYPOT (math.tq, arities 0 to 6), EXACT
 * (sqrt, sign, fround, f16round, clz32, imul, pow), DYN (dynamic arguments
 * through ToNumber), NAN (each NaN-returning path's bits, and the registered
 * number[] divergence), DISC (inputs on which a system libm or the original
 * fdlibm answers differently from Node -- the negative controls), DYNAMIC
 * (every member in a --dynamic build, which lowers them the same static way).
 * Per lane class: ENGINE (c, llvm, wasm: the embedded engine's OWN Math,
 * which scr_island_math.h points at the same functions), LINK (c: the ieee754 object is
 * linked exactly when a transcendental is called), LAZY (wasm: a module
 * carries only the C functions its Math members reach), CSUB (csubset.ts
 * refuses, by name, the C it does not model, rather than compile it wrongly). */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { promisify } from "node:util";
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

type Lane = "wasm" | "c" | "llvm";
const LANES: Lane[] = ["wasm", "c", "llvm"];
const execFileAsync = promisify(execFile);

let serial = 0;
const nodeOut = new Map<string, Promise<string>>();

/** The same source under this process's Node (once per source). */
function onNode(src: string, entry: string): Promise<string> {
  let out = nodeOut.get(src);
  if (out === undefined) {
    out = execFileAsync(process.execPath, ["--no-warnings", "--experimental-transform-types", entry], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    }).then((r) => r.stdout);
    nodeOut.set(src, out);
  }
  return out;
}

/** Compiles `src` for `lane` (a --dynamic build when `dynamic`) and runs it; runs the same source
 * under Node; returns both, and the wasm module or native binary path. */
async function onLane(
  lane: Lane,
  src: string,
  dynamic = false,
): Promise<{ out: string; node: string; binary: string }> {
  const id = `r${serial++}`;
  const entry = join(scratch, `${id}.ts`);
  const text = (dynamic ? "// @dynamic\n" : "") + src;
  await writeFile(entry, text);
  const binary = join(scratch, lane === "wasm" ? `${id}.wasm` : id);
  const res = await compile(entry, { outPath: binary, outDir: scratch, backend: lane, dynamic });
  if (!res.ok) throw new Error(`${id} (${lane}) refused: ${res.diagnostics.map((d) => `${d.code}: ${d.message}`).join(" | ")}`);
  let out: string;
  if (lane === "wasm") {
    const run = await runWasm(res.binaryPath);
    expect(String(run.stderr)).toBe("");
    expect(run.exitCode).toBe(0);
    out = String(run.stdout);
  } else {
    const run = await execFileAsync(res.binaryPath, [], { encoding: "utf8", maxBuffer: 64 << 20 });
    expect(run.stderr).toBe("");
    out = run.stdout;
  }
  return { out, node: await onNode(text, entry), binary: res.binaryPath };
}

/** The wasm lane's run plus the module bytes (LAZY reads its function names). */
async function both(src: string): Promise<{ wasm: string; node: string; module: Buffer }> {
  const r = await onLane("wasm", src);
  return { wasm: r.out, node: r.node, module: await readFile(r.binary) };
}

/** Row-by-row equality, naming the first rows that differ (input, lane bits, Node bits). */
function expectRows(what: string, inputs: number[], arity: number, got: string, node: string): void {
  const w = got.split("\n");
  const n = node.split("\n");
  const bad: string[] = [];
  for (let i = 0; i < Math.max(w.length, n.length); i++) {
    if (w[i] === n[i]) continue;
    const args = inputs.slice(i * arity, i * arity + arity).map(toHex).join(",");
    bad.push(`${what}(${args}) lane=${w[i]} node=${n[i]}`);
    if (bad.length >= 5) break;
  }
  expect(bad, `${what}: rows that differ from Node`).toEqual([]);
  expect(n.length).toBe(Math.max(1, inputs.length / Math.max(arity, 1)) + 1);
}

const nanInputs = (): number[] => NAN_BITS.map(fromBits);

/* ── IEEE: the 19 unary ieee754.cc members ─────────────────────────────── */

describe.for(LANES)("IEEE: V8's ieee754.cc, compiled, against Node [%s]", (lane) => {
  test.for(UNARY.map((f, i) => [f.name, f, i] as const))("IEEE %s", async ([, f, i]) => {
    const inputs = [
      ...EDGES,
      ...nanInputs(),
      ...thresholds(f.c),
      ...(f.c.includes("__ieee754_rem_pio2") ? piMultiples() : []),
      ...randoms(0x9e3779b97f4a7c15n + BigInt(i) * 0x1234567n, 4000, f.domain),
    ];
    const { out, node } = await onLane(lane, program(`Math.${f.name}(a)`, 1, inputs));
    expectRows(f.name, inputs, 1, out, node);
  });
});

/* ── ATAN2 ─────────────────────────────────────────────────────────────── */

describe.for(LANES)("ATAN2 [%s]", (lane) => {
  test("ATAN2: the sign/quadrant cross product of the edges, thresholds and random pairs", async () => {
    // every pair of the NaN payloads too: which NaN `x + y` answers is an operand-order question
    const vals = [...EDGES.slice(0, 30), ...nanInputs()];
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
    const { out, node } = await onLane(lane, program("Math.atan2(a, b)", 2, inputs));
    expectRows("atan2", inputs, 2, out, node);
  });
});

/* ── HYPOT ─────────────────────────────────────────────────────────────── */

describe.for(LANES)("HYPOT: V8's math.tq MathHypot at every arity [%s]", (lane) => {
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
    const { out, node } = await onLane(lane, program(call, k, inputs));
    if (k === 0) {
      expect(out).toBe(node);
      return;
    }
    expectRows(`hypot/${k}`, inputs, k, out, node);
  });
});

/* ── EXACT: the members that are one operation ─────────────────────────── */

describe.for(LANES)("EXACT: sqrt, sign, fround, f16round, clz32, imul, pow [%s]", (lane) => {
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
      const bases = [...EDGES.slice(0, 24), ...nanInputs()];
      for (const a of bases) for (const b of [0, -0, 0.5, -0.5, 1, -1, 2, 3, -3, 0.25, 1.5, 1e10, Infinity, -Infinity, ...nanInputs()]) out.push(a, b);
      for (let i = 0; i < 2000; i++) out.push(u() * 10, (u() * 2 - 1) * 50);
      for (let i = 0; i < 500; i++) out.push(-u() * 10, (u() * 2 - 1) * 50); // negative bases: hardware NaNs
      return out;
    }],
    ["**", "a ** b", 2, () => {
      const out: number[] = [];
      for (const a of [...EDGES.slice(0, 24), ...nanInputs()]) for (const b of [0, 0.5, 2, -3, 1.5, Infinity, -Infinity, ...nanInputs()]) out.push(a, b);
      for (let i = 0; i < 1000; i++) out.push((u() * 2 - 1) * 10, (u() * 2 - 1) * 50);
      return out;
    }],
  ];
  test.for(cases)("EXACT %s", async ([name, call, arity, make]) => {
    const inputs = make();
    // pow and `**` NaNs included: the native lanes run V8's math::pow over the C library pow Node
    // calls, and the wasm tier computes the negative-base NaN the way that path does (board #158).
    const { out, node } = await onLane(lane, program(call, arity, inputs));
    expectRows(name, inputs, arity, out, node);
  });
});

/* ── DYN: dynamic arguments get ToNumber ───────────────────────────────── */

const DYN_SRC = [
  `const xs: any = JSON.parse('["1.5", " -2e3 ", "0x10", "", "abc", null, true, false, [], [7], [1, 2], "Infinity", "-0", 3, {"a": 1}]');`,
  "const buf = Buffer.alloc(8);",
  'const bits = (v: number): string => { buf.writeDoubleBE(v, 0); return buf.toString("hex"); };',
  "const n: number = xs.length;",
  "for (let i = 0; i < n; i++) {",
  "  const x: any = xs[i];",
  // each result goes straight to bits(): a number[] would let Node silence a signaling NaN (NAN below)
  "  console.log(bits(Math.sin(x)), bits(Math.log1p(x)), bits(Math.cbrt(x)), bits(Math.atan2(x, 2)), bits(Math.atan2(2, x)),",
  "    bits(Math.hypot(x, 1, x)), bits(Math.sqrt(x)), bits(Math.sign(x)), bits(Math.fround(x)), bits(Math.f16round(x)),",
  "    bits(Math.clz32(x)), bits(Math.imul(x, 3)), bits(Math.pow(x, 2)), bits(Math.tanh(x)),",
  // the members that were static before the unit (board #263: they threw on a string)
  "    bits(Math.abs(x)), bits(Math.floor(x)), bits(Math.ceil(x)), bits(Math.trunc(x)), bits(Math.round(x)),",
  "    bits(Math.min(x, 1)), bits(Math.max(x)), bits(Math.max(-1, x, 2)));",
  "}",
  "",
].join("\n");

describe.for(LANES)("DYN [%s]", (lane) => {
  test("DYN: dynamic (any) arguments convert with ToNumber before the computation, as Node's Math does", async () => {
    const plain = await onLane(lane, DYN_SRC);
    expect(plain.out).toBe(plain.node);
    // under --dynamic an `any` is an island value: the same conversion, through the engine on native
    const dynamic = await onLane(lane, DYN_SRC, true);
    expect(dynamic.out).toBe(dynamic.node);
  });

  test("DYN: an island object's own valueOf / toString run, in order, and their throws propagate", async () => {
    const src = [
      "const log: string[] = [];",
      'const o: any = { valueOf() { log.push("valueOf"); return 4; }, toString() { log.push("toString"); return "9"; } };',
      'const t: any = { toString() { log.push("t.toString"); return "16"; } };',
      "const bad: any = { toString: 5 };",
      'const thr: any = { valueOf() { throw new Error("boom"); } };',
      "console.log(Math.sqrt(o), Math.sqrt(t), Math.hypot(o, t), Math.max(o, t), log.join(\",\"));",
      'try { console.log(Math.sin(thr)); } catch (e) { console.log("caught", (e as Error).message); }',
      'try { console.log(Math.atan2(1, bad)); } catch (e) { console.log("caught", (e as Error).name); }',
      "",
    ].join("\n");
    const r = await onLane(lane, src, true);
    expect(r.out).toBe(r.node);
  });
});

/* ── NAN: the NaN each member returns, by provenance ───────────────────── */

describe.for(LANES)("NAN [%s]", (lane) => {
  test("NAN: Node's own NaN bits -- ieee754.cc's signaling_NaN() (0x7ff4...), quiet_NaN(), the hardware's -- and the registered number[] divergence", async () => {
    // arguments pass through id() so no call is literal-only
    const calls = ["Math.log(id(-1))", "Math.log2(id(-1))", "Math.log1p(id(-2))", "Math.acos(id(2))", "Math.asin(id(-2))",
      "Math.acosh(id(0.5))", "Math.atanh(id(2))", "Math.log10(id(-1))", "Math.sin(id(Infinity))", "Math.cos(id(-Infinity))",
      "Math.tan(id(Infinity))", "Math.sqrt(id(-1))", "Math.log(Math.log(id(-1)))", "Math.exp(id(NaN))", "Math.hypot(id(NaN), 1)",
      "Math.f16round(-id(NaN))", "Math.fround(Math.log(id(-1)))", "Math.atan2(id(NaN), Math.log(id(-1)))",
      "Math.atan2(Math.log(id(-1)), -id(NaN))", "Math.pow(id(NaN), 2)",
      // a signaling NaN (ieee754.cc's) through every other member
      ...["abs", "floor", "ceil", "round", "trunc", "sign", "sqrt", "cbrt", "exp", "fround", "f16round", "hypot", "clz32"].map((m) => `Math.${m}(Math.log(id(-1)))`),
      "Math.max(Math.log(id(-1)), 1)", "Math.min(1, Math.log(id(-1)))", "Math.max(Math.log(id(-1)))", "Math.min(id(-0), -id(NaN))",
      "Math.max(...arrA)", "Math.min(...arrB)", "Math.hypot(Math.log(id(-1)), 2, 3, 4)",
      // literal-only `**` folds as V8's parser folds it: the canonical NaN (S036, board #207);
      // so does a negation of a folded operand, where the NaN global and Infinity do not fold
      "(-8) ** 1.5", "(0 / 0) ** 1", "Math.pow(id(-8), 1.5)", "-((-8) ** 1.5)", "-(0 / 0)", "-NaN", "-(NaN + 1)",
      "-((-2) ** 0.5)", "-(1 ** Infinity)", "-(2 ** 0.5)", "0 - ((-8) ** 1.5)", "1 * -((-8) ** 1.5)", "-(-(0 / 0))"];
    const src = [
      "const buf = Buffer.alloc(8);",
      'const bits = (v: number): string => { buf.writeDoubleBE(v, 0); return buf.toString("hex"); };',
      "const id = (v: number): number => v;",
      "const arrA: number[] = [1, -id(NaN), 2];",
      "const arrB: number[] = [id(NaN)];",
      ...calls.map((c) => `console.log(${JSON.stringify(c)}, bits(${c}));`),
      "",
    ].join("\n");
    const r = await onLane(lane, src);
    // floor / ceil / trunc of a SIGNALING NaN: Node's own answer depends on the JIT tier (the
    // builtin hands the bits back, 0x7ff4..., optimized code's roundsd quiets them, 0x7ffc...);
    // every lane answers the optimized one (SEMANTICS.md S104). Pinned here, then set aside.
    const tiered = /^Math\.(floor|ceil|trunc)\(Math\.log\(id\(-1\)\)\) (.*)$/gm;
    for (const m of r.out.matchAll(tiered)) expect(m[2], `${m[1]} of a signaling NaN`).toBe("7ffc000000000000");
    for (const m of r.node.matchAll(tiered)) expect(["7ff4000000000000", "7ffc000000000000"]).toContain(m[2]);
    expect(r.out.replace(tiered, "")).toBe(r.node.replace(tiered, ""));
    expect(r.node.split("\n")[0]).toBe("Math.log(id(-1)) 7ff4000000000000");
    // SEMANTICS.md S100: a signaling NaN stored into a number[] -- V8 silences it on the way into a
    // double-elements backing store, every lane stores the bits -- so the same value reads back
    // 0x7ffc... in Node and 0x7ff4... here. Pinned both ways; the oracle half is live.
    const arr = "const buf = Buffer.alloc(8);\nconst id = (v: number): number => v;\nconst a = [Math.log(id(-1))];\nbuf.writeDoubleBE(a[0]!, 0);\nconsole.log(buf.toString(\"hex\"));\n";
    const stored = await onLane(lane, arr);
    expect(stored.node).toBe("7ffc000000000000\n");
    expect(stored.out).toBe("7ff4000000000000\n");
  });
});

/* ── DISC: the negative controls ───────────────────────────────────────── */

/* Seven inputs on which another implementation of the same function answers
 * differently from Node, measured on this machine (scratch programs, not part of
 * the suite): GNU libc 2.43 (Ubuntu 2.43-2ubuntu2.4, x86-64), the system libm a
 * native build used to call; and Java's StrictMath (OpenJDK 25.0.4.1), the original
 * fdlibm 5.3 that ieee754.cc started from. A lane that fell back to either, or
 * lost V8's changes (exp(1) == E, the FreeBSD-msun cosh/tanh/cbrt), reddens the
 * row: Node's bits are checked against the alternative here, and the lane's
 * against Node's. */
const DISC: { call: string; glibc: string; fdlibm: string }[] = [
  { call: "Math.log(3)", glibc: "3ff193ea7aad030b", fdlibm: "3ff193ea7aad030a" },
  { call: "Math.cbrt(2)", glibc: "3ff428a2f98d728c", fdlibm: "3ff428a2f98d728b" },
  { call: "Math.sin(-3.1902814782969835)", glibc: "3fa8eb3872e25af7", fdlibm: "3fa8eb3872e25af8" },
  { call: "Math.exp(1)", glibc: "4005bf0a8b145769", fdlibm: "4005bf0a8b14576a" },
  { call: "Math.cosh(1)", glibc: "3ff8b07551d9f550", fdlibm: "3ff8b07551d9f551" },
  { call: "Math.tanh(1.0487516560492713e-13)", glibc: "3d3d850d56f02811", fdlibm: "3d3d850d56f02811" },
  { call: "Math.cbrt(0.9991103149666114)", glibc: "3feffd91e16bca6e", fdlibm: "3feffd91e16bca6d" },
];

const DISC_SRC = [
  "const buf = Buffer.alloc(8);",
  'const bits = (v: number): string => { buf.writeDoubleBE(v, 0); return buf.toString("hex"); };',
  // the arguments go through a function so the call is not a literal-only expression
  "const id = (v: number): number => v;",
  ...DISC.map((d) => `console.log(bits(${d.call.replace(/\(([^)]*)\)$/, "(id($1))")}));`),
  "",
].join("\n");

describe.for(LANES)("DISC [%s]", (lane) => {
  test("DISC: inputs a system libm or the original fdlibm answers differently -- each row discriminates, and the lane answers Node's bits", async () => {
    const { out, node } = await onLane(lane, DISC_SRC);
    expect(out).toBe(node);
    const nodeBits = node.trim().split("\n");
    DISC.forEach((d, i) => {
      // every row is wrong under at least one substitute, and the set covers both
      expect(nodeBits[i] !== d.glibc || nodeBits[i] !== d.fdlibm, `${d.call} discriminates nothing`).toBe(true);
    });
    expect(DISC.filter((d, i) => nodeBits[i] !== d.glibc).length).toBeGreaterThanOrEqual(4);
    expect(DISC.filter((d, i) => nodeBits[i] !== d.fdlibm).length).toBeGreaterThanOrEqual(4);
  });
});

/* ── DYNAMIC: every member in a --dynamic build ─────────────────────────── */

describe.for(LANES)("DYNAMIC [%s]", (lane) => {
  test("DYNAMIC: a --dynamic build lowers every member statically, to the same bits", async () => {
    const next = xorshift(0x7777000011112222n);
    const inputs: number[] = [...EDGES, ...nanInputs()];
    for (let i = 0; i < 300; i++) inputs.push(fromBits(next()), (Number(next() >> 11n) / 2 ** 53 - 0.5) * 20);
    const members = [...UNARY.map((f) => `Math.${f.name}(a)`), "Math.atan2(a, 0.75)", "Math.hypot(a, 2, a)", "Math.pow(a, 1.25)",
      "Math.sqrt(a)", "Math.sign(a)", "Math.fround(a)", "Math.f16round(a)", "Math.clz32(a)", "Math.imul(a, 7)", "a ** 3.5",
      "Math.abs(a)", "Math.floor(a)", "Math.max(a, 1)", "Math.round(a)", "Math.PI * a",
      "Math.E + Math.LN10 + Math.LN2 + Math.LOG2E + Math.LOG10E + Math.SQRT2 + Math.SQRT1_2"];
    const src = program(`0`, 1, inputs).replace(
      "  outBuf.writeDoubleBE(0, 0);\n  lines.push(outBuf.toString(\"hex\"));",
      members.map((m) => `  outBuf.writeDoubleBE(${m}, 0);\n  lines.push(outBuf.toString("hex"));`).join("\n"),
    );
    const { out, node } = await onLane(lane, src, true);
    expect(out).toBe(node);
  });
});

/* ── ENGINE: the embedded engine's own Math (native --dynamic) ──────────── */

/* Code the embedded engine evaluates itself (packages, a Math object reached as
 * a value, __island_eval) calls the ENGINE's Math members. scr_island.c points
 * them at the same functions the compiled program calls, so they answer
 * Node's bits too. Node runs the same JavaScript text through eval. The wasm
 * lane's engine (phase 2) runs the SAME override (scr_island_math.h) over the
 * same ieee754.cc compiled into engine.wasm, its pow bound to the module's
 * own %w.jsPow. */
describe.for(["c", "llvm", "wasm"] as const)("ENGINE [%s]", (lane) => {
  test("ENGINE: Math evaluated by the embedded engine answers Node's bits", async () => {
    const next = xorshift(0x2468ace013579bdfn);
    const xs: number[] = [...EDGES, ...nanInputs()];
    for (let i = 0; i < 400; i++) xs.push(i % 2 === 0 ? fromBits(next()) : (Number(next() >> 11n) / 2 ** 53 - 0.5) * 40);
    const js = [
      "(function () {",
      `  const xs = new Float64Array(new BigUint64Array([${xs.map((x) => `0x${toHex(x)}n`).join(",")}]).buffer);`,
      "  const f = new Float64Array(1), u = new BigUint64Array(f.buffer);",
      "  const hex = (v) => { f[0] = v; return u[0].toString(16).padStart(16, '0'); };",
      "  const out = [];",
      "  for (const a of xs) {",
      // each result straight to hex(): an array literal would let Node silence a signaling NaN
      `    out.push(${[...UNARY.map((g) => `Math.${g.name}(a)`), "Math.atan2(a, 0.75)", "Math.atan2(0.75, a)", "Math.hypot(a, 2)", "Math.hypot(a, 2, a, 3)",
        "Math.pow(a, 1.25)", "Math.pow(a, 2)", "Math.sign(a)", "Math.f16round(a)", "Math.max(a, 1)", "Math.min(1, a)", "Math.max(a)",
        "Math.min(a, 2, a)", "Math.round(a)"].map((c) => `hex(${c})`).join(", ")});`,
      "  }",
      "  return out.join(' ');",
      "})()",
    ].join("\n");
    const src = `// @dynamic\nconst JS = ${JSON.stringify(js)};\nconsole.log(__island_eval(JS));\n`;
    const nodeSrc = `const JS = ${JSON.stringify(js)};\nconsole.log(String((0, eval)(JS)));\n`;
    const id = `e${serial++}`;
    const entry = join(scratch, `${id}.ts`);
    await writeFile(entry, src);
    const res = await compile(entry, { outPath: join(scratch, lane === "wasm" ? `${id}.wasm` : id), outDir: scratch, backend: lane, dynamic: true });
    if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code}: ${d.message}`).join(" | ")}`);
    const run =
      lane === "wasm"
        ? { stdout: String((await runWasm(res.binaryPath)).stdout) }
        : await execFileAsync(res.binaryPath, [], { encoding: "utf8", maxBuffer: 64 << 20 });
    const nodeEntry = join(scratch, `${id}-node.mjs`);
    await writeFile(nodeEntry, nodeSrc);
    const node = await execFileAsync(process.execPath, [nodeEntry], { encoding: "utf8", maxBuffer: 64 << 20 });
    const got = run.stdout.trim().split(" ");
    const want = node.stdout.trim().split(" ");
    // The wasm engine is a 32-bit build, so quickjs NaN-boxes its values:
    // every NaN a value holds is the canonical 7ff8000000000000 (SEMANTICS.md
    // S103 (f)) — a NaN Node answers must be that one there; every other
    // answer is bit-exact.
    const isNaNHex = (h: string | undefined): boolean => h !== undefined && /^[7f]ff/.test(h) && !/^[7f]ff0000000000000$/.test(h);
    const same = (g: string, w: string | undefined): boolean =>
      g === w || (lane === "wasm" && isNaNHex(w) && g === "7ff8000000000000");
    const bad = got.map((g, i) => (same(g, want[i]) ? null : `#${i} engine=${g} node=${want[i]}`)).filter((x) => x !== null);
    expect(bad.slice(0, 5), "engine-evaluated Math answers that differ from Node").toEqual([]);
    expect(got.length).toBe(want.length);
  });
});

/* ── LINK: the ieee754 object joins a native link exactly when used ─────── */

test("LINK: a native binary carries V8's ieee754 code exactly when it calls a transcendental (or embeds the engine)", async () => {
  const syms = async (bin: string): Promise<string[]> => {
    const r = await execFileAsync("nm", [bin], { encoding: "utf8", maxBuffer: 64 << 20 });
    return [...new Set([...r.stdout.matchAll(/\bscr_ieee754_[a-z0-9]+\b/g)].map((m) => m[0]))].sort();
  };
  const plain = await onLane("c", "const x: number = JSON.parse('2');\nconsole.log(Math.sqrt(x), Math.hypot(x, x), Math.floor(x / 3), x ** 0.5);\n");
  expect(plain.out).toBe(plain.node);
  expect(await syms(plain.binary)).toEqual([]);
  const sin = await onLane("c", "const x: number = JSON.parse('2');\nconsole.log(Math.sin(x));\n");
  expect(sin.out).toBe(sin.node);
  expect(await syms(sin.binary)).toContain("scr_ieee754_sin");
  const dyn = await onLane("c", "const x: number = JSON.parse('2');\nconsole.log(x + 1);\n", true);
  expect(dyn.out).toBe(dyn.node);
  expect(await syms(dyn.binary)).toContain("scr_ieee754_cbrt");
});

/* ── ORDER: every argument is evaluated before any is converted ───────── */

/* Node evaluates all of a Math call's arguments, then converts them in order; an `any`
 * argument's valueOf can change what a LATER argument reads (SEMANTICS.md S104 (a)). */
const ORDER_SRC = [
  "let counter = 10;",
  "const a: any = { valueOf() { counter = 100; return 1; } };",
  "console.log(Math.max(a, counter), counter);",
  "counter = 10;",
  "console.log(Math.atan2(a, counter), Math.pow(a, counter), Math.hypot(a, counter, counter + 1));",
  "const box = { v: 10 };",
  "const b: any = { valueOf() { box.v = 200; return 1; } };",
  "const xs: number[] = [3, 4];",
  "const c: any = { valueOf() { xs[0] = 30; xs.pop(); return 2; } };",
  "console.log(Math.max(b, box.v), Math.hypot(b, box.v), Math.min(c, xs[0]!, -xs.length), Math.max(c, xs[0]! + 1));",
  'const log: string[] = [];',
  'const d: any = { valueOf() { log.push("d"); return 5; } };',
  'const e: any = { valueOf() { log.push("e"); return 6; } };',
  'function f(): number { log.push("f"); return 7; }',
  'console.log(Math.max(d, f(), e), Math.min(f(), d, e, 1), log.join(","));',
  "",
].join("\n");

describe.for(LANES)("ORDER [%s]", (lane) => {
  test("ORDER: Node's order -- evaluate every argument, then convert -- under a valueOf that writes what later arguments read", async () => {
    const r = await onLane(lane, ORDER_SRC, true);
    expect(r.out).toBe(r.node);
    // a plain build: a dyn `any` first, then expressions over locals and elements
    const plain = await onLane(lane, 'const a: any = JSON.parse("[2]");\nconst xs: number[] = [3, 4];\nlet y = 1;\nconsole.log(Math.max(a, y + 1, xs[0]!, -xs.length), Math.atan2(a, y), Math.hypot(a, ++y, y));\n');
    expect(plain.out).toBe(plain.node);
  });
});

/* ── JS: what a JavaScript file can pass ────────────────────────────────── */

describe.for(LANES)("JS [%s]", (lane) => {
  test("JS: undefined, null, booleans and strings convert as Node converts them", async () => {
    const src = [
      'console.log(Math.sqrt(undefined), Math.abs(null), Math.round(undefined), Math.max(null, -1), Math.floor(undefined));',
      'console.log(Math.sqrt("16"), Math.abs(true), Math.hypot("3", "4"), Math.min(false, "-2"), Math.atan2(null, -1));',
      "",
    ].join("\n");
    for (const dynamic of [false, true]) {
      const id = `js${serial++}`;
      const entry = join(scratch, `${id}.js`);
      await writeFile(entry, src);
      const binary = join(scratch, lane === "wasm" ? `${id}.wasm` : id);
      const res = await compile(entry, { outPath: binary, outDir: scratch, backend: lane, dynamic });
      if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code}: ${d.message}`).join(" | ")}`);
      const out = lane === "wasm" ? String((await runWasm(res.binaryPath)).stdout) : (await execFileAsync(res.binaryPath, [], { encoding: "utf8" })).stdout;
      const node = (await execFileAsync(process.execPath, [entry], { encoding: "utf8" })).stdout;
      expect(out, dynamic ? "--dynamic" : "plain").toBe(node);
    }
  });
});

/* ── LAZY: a module carries only what its members reach ────────────────── */

test("LAZY: only the C functions a program's Math members reach are compiled into its module", async () => {
  const names = (m: Buffer): string[] => {
    const text = m.toString("latin1");
    return [...new Set([...text.matchAll(/%w\.ieee754\.([A-Za-z_0-9]+)/g)].map((x) => x[1]!))].sort();
  };
  const exact = await both("const x: number = JSON.parse('2');\nconsole.log(Math.sqrt(x), Math.sign(-x), Math.hypot(x, x), Math.clz32(x));\n");
  expect(exact.wasm).toBe(exact.node);
  expect(names(exact.module)).toEqual([]);
  const sin = await both("const x: number = JSON.parse('2');\nconsole.log(Math.sin(x * 1e300));\n");
  expect(sin.wasm).toBe(sin.node);
  expect(names(sin.module)).toEqual(["__ieee754_rem_pio2", "__kernel_cos", "__kernel_rem_pio2", "__kernel_sin", "scalbn", "sin"]);
  const acosh = await both("const x: number = JSON.parse('2');\nconsole.log(Math.acosh(x + 0.5));\n");
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
