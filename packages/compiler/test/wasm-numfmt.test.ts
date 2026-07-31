/* The emitted number formatter against the engine's own String(x) — the
 * wasm lane's slice of S001's fuzz bar (upstream verified the C lane's
 * Ryū on 10⁶ doubles; the corpus re-checks every claimed program). The
 * test module is built directly from ModuleBuilder + buildF64ToStr and
 * exports the formatter plus two accessors, because JS cannot read GC
 * array contents any other way. */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { F64, I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { buildF64ToStr } from "../src/backend/wasm/numfmt.js";

async function instantiateFormatter(): Promise<(x: number) => string> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const f2s = buildF64ToStr(mb, strType, strRef);
  const len = mb.declareFunc(mb.funcType([strRef], [I32]), "len");
  {
    const c = new Code();
    c.localGet(0);
    c.arrayLen();
    mb.setBody(len, [], c.bytes());
  }
  const at = mb.declareFunc(mb.funcType([strRef, I32], [I32]), "at");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGetU(strType);
    mb.setBody(at, [], c.bytes());
  }
  mb.exportFunc("conv", f2s);
  mb.exportFunc("len", len);
  mb.exportFunc("at", at);
  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as {
    conv: (x: number) => unknown;
    len: (r: unknown) => number;
    at: (r: unknown, i: number) => number;
  };
  return (x) => {
    const r = ex.conv(x);
    const n = ex.len(r);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(ex.at(r, i));
    return s;
  };
}

const EDGES = [
  0, -0, 1, -1, 0.1, 0.2, 0.3, 0.5, 2.5, 1 / 3, NaN, Infinity, -Infinity,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 2 ** 53, 2 ** 53 + 2,
  Number.MIN_VALUE, Number.MAX_VALUE, Number.EPSILON, 2.2250738585072014e-308,
  2.225073858507201e-308, // largest subnormal
  1e21, 999999999999999900000, 1.0000000000000001e21, 1e-6, 0.000001, 1e-7, 9.999999999999999e-7,
  123.456, 5e-324, 1.5e-323, 100, 1e20, 1e6, 123456789e40, 4.35e-18, 1.7976931348623157e308,
  0.30000000000000004, 9007199254740992, 909090909090909.1, -2147483648, 4294967295,
];

describe("emitted f64→string vs String(x)", () => {
  test("edge corpus", async () => {
    const conv = await instantiateFormatter();
    for (const x of EDGES) {
      expect(conv(x), `for ${x} (bits ${new Float64Array([x])[0]})`).toBe(String(x));
    }
  });

  test("1e5 seeded random bit patterns", async () => {
    const conv = await instantiateFormatter();
    // xorshift64* over raw bit patterns: covers normals, subnormals,
    // NaN payloads, and infinities without favoring any exponent range.
    let s = 0x9e3779b97f4a7c15n;
    const buf = new ArrayBuffer(8);
    const u64 = new BigUint64Array(buf);
    const f64 = new Float64Array(buf);
    for (let i = 0; i < 100_000; i++) {
      s ^= s >> 12n;
      s ^= (s << 25n) & 0xffff_ffff_ffff_ffffn;
      s ^= s >> 27n;
      u64[0] = (s * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
      const x = f64[0]!;
      const got = conv(x);
      const want = String(x);
      if (got !== want) {
        expect(got, `bit pattern 0x${u64[0]!.toString(16)}`).toBe(want);
      }
    }
  });

  test("every power of ten and adjacent doubles", async () => {
    const conv = await instantiateFormatter();
    for (let p = -323; p <= 308; p++) {
      const x = Number(`1e${p}`);
      for (const y of [x, x * (1 + Number.EPSILON), x * (1 - Number.EPSILON / 2)]) {
        expect(conv(y), `1e${p} neighborhood`).toBe(String(y));
      }
    }
  });
});
