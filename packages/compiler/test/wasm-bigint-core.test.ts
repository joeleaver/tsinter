/* BigInt's magnitude arithmetic (backend/wasm/bigint-src.ts), compiled alone
 * by the C-subset compiler and checked against the host's own BigInt over
 * edge values and a seeded random sweep: every operation the WasmGC lanes
 * call into for values outside the i64 fast path. The differential rows
 * (wasm-bigint-*.test.ts) check the same operations end to end against Node;
 * this is the second, independent instrument (an operand of thousands of
 * limbs, or a Knuth-D correction step, is cheap to reach here). */
import { describe, expect, test } from "vitest";
import { BIGINT_C } from "../src/backend/wasm/bigint-src.js";
import { CCompiler, parseC } from "../src/backend/wasm/csubset.js";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder } from "../src/backend/wasm/module.js";

type Arr = unknown;
interface Ex {
  mk(n: number): Arr;
  set(a: Arr, i: number, v: number): void;
  get(a: Arr, i: number): number;
  len(a: Arr): number;
  [k: string]: (...args: never[]) => unknown;
}

const FNS = [
  "bn_from_bits", "bn_fits_i64", "bn_to_bits", "bn_cmp", "bn_add", "bn_sub", "bn_neg", "bn_mul", "bn_div", "bn_rem",
  "bn_pow", "bn_bitlen", "bn_shl", "bn_sar", "bn_bitop", "bn_not", "bn_asn", "bn_from_double", "bn_to_double",
  "bn_cmp_double", "bn_parse", "bn_digits", "bn_hash", "bn_eq", "bn_pow_limited",
];

async function build(): Promise<Ex> {
  const mb = new ModuleBuilder();
  const cc = new CCompiler(mb, parseC(BIGINT_C, {}), "bn.");
  for (const f of FNS) mb.exportFunc(f, cc.fn(f));
  const ia = { kind: "ref" as const, nullable: true, typeIndex: cc.ia };
  const fn = (name: string, params: typeof I32[] | unknown[], results: unknown[], body: (c: Code) => void): void => {
    const idx = mb.declareFunc(mb.funcType(params as never, results as never), name);
    const c = new Code();
    body(c);
    mb.setBody(idx, [], c.bytes());
    mb.exportFunc(name, idx);
  };
  fn("mk", [I32], [ia], (c) => {
    c.localGet(0);
    c.arrayNewDefault(cc.ia);
  });
  fn("set", [ia, I32, I32], [], (c) => {
    c.localGet(0);
    c.localGet(1);
    c.localGet(2);
    c.arraySet(cc.ia);
  });
  fn("get", [ia, I32], [I32], (c) => {
    c.localGet(0);
    c.localGet(1);
    c.arrayGet(cc.ia);
  });
  fn("len", [ia], [I32], (c) => {
    c.localGet(0);
    c.arrayLen();
  });
  const { instance } = await WebAssembly.instantiate(mb.emit());
  return instance.exports as unknown as Ex;
}

const exP = build();

function toArr(x: Ex, v: bigint): Arr {
  const neg = v < 0n;
  let m = neg ? -v : v;
  const limbs: number[] = [];
  while (m > 0n) {
    limbs.push(Number(m & 0xffffffffn) | 0);
    m >>= 32n;
  }
  const a = x.mk(limbs.length + 1);
  x.set(a, 0, neg ? 1 : 0);
  limbs.forEach((l, i) => x.set(a, i + 1, l));
  return a;
}

function fromArr(x: Ex, a: Arr): bigint {
  const n = x.len(a);
  if (n === 0) throw new Error("empty array (parse failure)");
  let m = 0n;
  for (let i = n - 1; i >= 1; i--) {
    const l = x.get(a, i) >>> 0;
    if (i === n - 1 && l === 0) throw new Error("not trimmed");
    m = (m << 32n) | BigInt(l);
  }
  const s = x.get(a, 0);
  if (s !== 0 && s !== 1) throw new Error(`bad sign ${s}`);
  if (s === 1 && m === 0n) throw new Error("negative zero");
  return s === 1 ? -m : m;
}

/* seeded xorshift so a failure reproduces */
let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}
function rbig(maxLimbs: number): bigint {
  const n = rnd() % (maxLimbs + 1);
  let v = 0n;
  for (let i = 0; i < n; i++) {
    const r = rnd() % 4;
    const limb = r === 0 ? 0xffffffff : r === 1 ? 0 : r === 2 ? 0x80000000 : rnd();
    v = (v << 32n) | BigInt(limb >>> 0);
  }
  return rnd() % 2 === 0 ? -v : v;
}

const EDGES: bigint[] = [
  0n, 1n, -1n, 2n, -2n, 0xffffffffn, 0x100000000n, -0x100000000n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 63n, -(2n ** 63n) - 1n,
  2n ** 64n - 1n, 2n ** 64n, -(2n ** 64n), 2n ** 95n + 12345n, -(2n ** 127n), 3n ** 100n, -(7n ** 77n),
];

function samples(): bigint[] {
  const out = [...EDGES];
  for (let i = 0; i < 150; i++) out.push(rbig(i < 100 ? 4 : 12));
  return out;
}

describe("bigint-src.ts against the host BigInt", () => {
  test("add/sub/mul/neg/cmp/eq/bitops over value pairs", async () => {
    const x = await exP;
    const vs = samples();
    for (let i = 0; i < vs.length; i++) {
      for (let j = 0; j < vs.length; j += 7) {
        const a = vs[i]!;
        const b = vs[(i + j) % vs.length]!;
        const A = toArr(x, a);
        const B = toArr(x, b);
        const ctx = `${a} ${b}`;
        expect(fromArr(x, x.bn_add!(A as never, B as never) as Arr), ctx).toBe(a + b);
        expect(fromArr(x, x.bn_sub!(A as never, B as never) as Arr), ctx).toBe(a - b);
        expect(fromArr(x, x.bn_mul!(A as never, B as never) as Arr), ctx).toBe(a * b);
        expect(fromArr(x, x.bn_neg!(A as never) as Arr), ctx).toBe(-a);
        expect(x.bn_cmp!(A as never, B as never), ctx).toBe(a < b ? -1 : a > b ? 1 : 0);
        expect(x.bn_eq!(A as never, B as never), ctx).toBe(a === b ? 1 : 0);
        expect(fromArr(x, x.bn_bitop!(A as never, B as never, 0 as never) as Arr), ctx).toBe(a & b);
        expect(fromArr(x, x.bn_bitop!(A as never, B as never, 1 as never) as Arr), ctx).toBe(a | b);
        expect(fromArr(x, x.bn_bitop!(A as never, B as never, 2 as never) as Arr), ctx).toBe(a ^ b);
        expect(fromArr(x, x.bn_not!(A as never) as Arr), ctx).toBe(~a);
        if (b !== 0n) {
          expect(fromArr(x, x.bn_div!(A as never, B as never) as Arr), ctx).toBe(a / b);
          expect(fromArr(x, x.bn_rem!(A as never, B as never) as Arr), ctx).toBe(a % b);
        }
      }
    }
  });

  test("division: Knuth-D correction steps and wide operands", async () => {
    const x = await exP;
    const cases: [bigint, bigint][] = [
      // qhat overestimates (the classic add-back case of divmnu's test set)
      [0x800000000000000000000003n, 0x200000000000000000000001n],
      [0x7fff800000000000n * 2n ** 64n, 0x800000000000ffffn],
      [2n ** 128n - 1n, 2n ** 64n + 1n],
      [2n ** 192n, 2n ** 96n - 1n],
      [-(10n ** 60n), 10n ** 20n + 7n],
    ];
    for (let i = 0; i < 400; i++) {
      const a = rbig(24);
      let b = rbig(10);
      if (b === 0n) b = 3n;
      cases.push([a, b]);
    }
    for (const [a, b] of cases) {
      const A = toArr(x, a);
      const B = toArr(x, b);
      expect(fromArr(x, x.bn_div!(A as never, B as never) as Arr), `${a} / ${b}`).toBe(a / b);
      expect(fromArr(x, x.bn_rem!(A as never, B as never) as Arr), `${a} % ${b}`).toBe(a % b);
    }
  });

  test("shifts, pow, bitlen, asIntN/asUintN", async () => {
    const x = await exP;
    for (const a of samples()) {
      const A = toArr(x, a);
      const m = a < 0n ? -a : a;
      expect(x.bn_bitlen!(A as never), `${a}`).toBe(m === 0n ? 0 : m.toString(2).length);
      for (const n of [0, 1, 5, 31, 32, 33, 63, 64, 65, 100, 200]) {
        expect(fromArr(x, x.bn_shl!(A as never, n as never) as Arr), `${a} << ${n}`).toBe(a << BigInt(n));
        expect(fromArr(x, x.bn_sar!(A as never, n as never) as Arr), `${a} >> ${n}`).toBe(a >> BigInt(n));
      }
      for (const bits of [1, 2, 7, 31, 32, 33, 63, 64, 65, 96, 128, 200]) {
        expect(fromArr(x, x.bn_asn!(A as never, bits as never, 0 as never) as Arr), `asUintN(${bits}, ${a})`).toBe(BigInt.asUintN(bits, a));
        expect(fromArr(x, x.bn_asn!(A as never, bits as never, 1 as never) as Arr), `asIntN(${bits}, ${a})`).toBe(BigInt.asIntN(bits, a));
      }
    }
    for (const [b, e] of [[2n, 0], [2n, 1], [2n, 64], [3n, 100], [-3n, 33], [0n, 0], [0n, 5], [-1n, 7], [12345678901n, 9]] as [bigint, number][]) {
      expect(fromArr(x, x.bn_pow!(toArr(x, b) as never, e as never) as Arr), `${b} ** ${e}`).toBe(b ** BigInt(e));
    }
  });

  test("pow under the size limit: powers of two as shifts, the log2 estimate, the measured result", async () => {
    const x = await exP;
    for (const [b, e] of [[2n, 100], [-2n, 101], [-2n, 100], [4n, 33], [-(2n ** 40n), 3], [3n, 1000], [-7n, 77], [12345678901n, 9], [2n ** 64n + 1n, 5]] as [bigint, number][]) {
      expect(fromArr(x, x.bn_pow_limited!(toArr(x, b) as never, e as never) as Arr), `${b} ** ${e}`).toBe(b ** BigInt(e));
    }
    // past 2^30 bits: the empty array, decided without computing
    for (const [b, e] of [[2n, 2 ** 30], [4n, 2 ** 29], [3n, 1_000_000_000], [7n, 383_000_000], [-(2n ** 40n), 2 ** 25]] as [bigint, number][]) {
      expect(x.len(x.bn_pow_limited!(toArr(x, b) as never, e as never) as Arr), `${b} ** ${e}`).toBe(0);
    }
  });

  test("i64 bits, fits, hash consistency", async () => {
    const x = await exP;
    for (const a of samples()) {
      const A = toArr(x, a);
      const fits = a >= -(2n ** 63n) && a < 2n ** 63n;
      expect(x.bn_fits_i64!(A as never), `${a}`).toBe(fits ? 1 : 0);
      expect(BigInt.asIntN(64, x.bn_to_bits!(A as never) as bigint), `${a}`).toBe(BigInt.asIntN(64, a));
      if (fits) expect(fromArr(x, x.bn_from_bits!(a as never) as Arr)).toBe(a);
      expect(x.bn_hash!(A as never)).toBe(x.bn_hash!(toArr(x, a) as never));
    }
  });

  test("doubles: from, to (ties to even), compare", async () => {
    const x = await exP;
    const ds = [0, -0, 1, -1, 2 ** 53, 2 ** 53 + 2, 2 ** 63, -(2 ** 63), 2 ** 64, 1e21, -1e300, 1.7976931348623157e308, 5e15 + 0.5];
    for (const d of ds) {
      if (!Number.isInteger(d)) continue;
      expect(fromArr(x, x.bn_from_double!(d as never) as Arr), `${d}`).toBe(BigInt(d));
    }
    const vs = [...samples(), 2n ** 1023n * 3n, 2n ** 1024n, -(2n ** 1024n) + 1n, 2n ** 1024n - 2n ** 970n, 2n ** 1024n - 2n ** 971n,
      (2n ** 53n + 1n) * 2n ** 64n, (2n ** 53n + 1n) * 2n ** 64n + 1n, (2n ** 53n + 3n) * 2n ** 64n, 2n ** 64n + 2n ** 11n, 2n ** 65n + 2n ** 12n];
    for (const a of vs) {
      expect(x.bn_to_double!(toArr(x, a) as never), `${a}`).toBe(Number(a));
    }
    const cmpDs = [0, 0.5, -0.5, 1.5, -1e30, 1e30, 2 ** 64, -(2 ** 64), Infinity, -Infinity, 2 ** 63 + 2048, 1e300];
    for (const a of vs) {
      for (const d of cmpDs) {
        const want = a < d ? -1 : a > d ? 1 : 0;
        expect(x.bn_cmp_double!(toArr(x, a) as never, d as never), `${a} vs ${d}`).toBe(want);
      }
    }
  });

  test("parse and digits", async () => {
    const x = await exP;
    const parse = (s: string): bigint | "fail" => {
      const a = x.mk(s.length);
      for (let i = 0; i < s.length; i++) x.set(a, i, s.charCodeAt(i));
      const r = x.bn_parse!(a as never, s.length as never) as Arr;
      return x.len(r) === 0 ? "fail" : fromArr(x, r);
    };
    const host = (s: string): bigint | "fail" => {
      try {
        return BigInt(s);
      } catch {
        return "fail";
      }
    };
    const texts = ["", "  ", "0", "-0", "+7", "-12", " 0x1f ", "0XfF", "0o17", "0O7", "0b101", "0B2", "-0x1", "+0b1", "0x", "-", "+", "1.5",
      "1e3", "1n", "1_000", "  12 \n", "﻿9　", "00012", "123456789012345678901234567890", "-98765432109876543210987654321098765",
      "0x" + "f".repeat(70), "0b" + "1".repeat(130), "0o" + "7".repeat(50), "abc", "12a", "0x1g", " -5 ", "᠎1"];
    for (const t of texts) expect(parse(t), JSON.stringify(t)).toBe(host(t));
    for (const a of samples()) {
      for (const r of [2, 8, 10, 16, 36, 7]) {
        const d = x.bn_digits!(toArr(x, a) as never, r as never, 0 as never) as Arr;
        let s = "";
        for (let i = 0; i < x.len(d); i++) s += String.fromCharCode(x.get(d, i));
        expect(s, `${a} radix ${r}`).toBe(a.toString(r));
      }
      const grouped = (sepChar: number): string => {
        const g = x.bn_digits!(toArr(x, a) as never, 10 as never, sepChar as never) as Arr;
        let s = "";
        for (let i = 0; i < x.len(g); i++) s += String.fromCharCode(x.get(g, i));
        return s;
      };
      expect(grouped(44), `${a} grouped`).toBe(a.toLocaleString("en-US"));
      // Node's addNumericalSeparator (ERR_OUT_OF_RANGE's Received text)
      const text = a.toString();
      const sign = text.startsWith("-") ? "-" : "";
      const mag = text.slice(sign.length);
      let tail = "";
      let i = mag.length;
      for (; i >= 4; i -= 3) tail = `_${mag.slice(i - 3, i)}${tail}`;
      expect(grouped(95), `${a} underscored`).toBe(sign + mag.slice(0, i) + tail);
    }
  });
});

describe("the legacy C/LLVM lanes refuse BigInt by name (SC3003), never an internal error", () => {
  test.for(["c", "llvm"] as const)("--backend %s", async (backend) => {
    const { compile } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tsinter-bigint-legacy-"));
    try {
      const file = join(dir, "main.ts");
      writeFileSync(file, "const n = 2;\nconst b: bigint = 2n ** 70n;\nconsole.log(n, b);\n");
      const res = await compile(file, { outPath: join(dir, "out"), outDir: dir, backend });
      expect(res.ok).toBe(false);
      expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3003"]);
      expect(res.diagnostics[0]!.message).toContain("are not supported on the legacy C and LLVM backends");
      expect(res.diagnostics[0]!.loc.start).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
