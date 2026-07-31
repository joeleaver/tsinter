/* The wasm byte-writer's encodings, pinned at the byte level. Everything
 * above bytes.ts trusts these five primitives blindly (the emitter never
 * checks its own arithmetic), so the boundary cases live here: the 7-bit
 * group edges where LEB128 grows a byte, the sign-bit edge where signed
 * encoding pads, and the range asserts that turn emitter bugs into loud
 * throws instead of modules that fail validation three layers away. */
import { describe, expect, test } from "vitest";
import { ByteWriter } from "../src/backend/wasm/bytes.js";

function written(body: (w: ByteWriter) => void): number[] {
  const w = new ByteWriter();
  body(w);
  return [...w.bytes()];
}

describe("uleb128", () => {
  test.for([
    [0, [0x00]],
    [1, [0x01]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16383, [0xff, 0x7f]],
    [16384, [0x80, 0x80, 0x01]],
    [624485, [0xe5, 0x8e, 0x26]], // the LEB128 spec's worked example
    [0xffff_ffff, [0xff, 0xff, 0xff, 0xff, 0x0f]],
  ] as const)("%d", ([n, bytes]) => {
    expect(written((w) => w.uleb(n))).toEqual([...bytes]);
  });

  test("rejects values outside u32", () => {
    expect(() => written((w) => w.uleb(-1))).toThrow(/out of u32 range/);
    expect(() => written((w) => w.uleb(0x1_0000_0000))).toThrow(/out of u32 range/);
    expect(() => written((w) => w.uleb(1.5))).toThrow(/out of u32 range/);
  });
});

describe("sleb128", () => {
  test.for([
    [0, [0x00]],
    [1, [0x01]],
    [63, [0x3f]], // largest 1-byte positive
    [64, [0xc0, 0x00]], // sign bit set → needs the continuation
    [-1, [0x7f]],
    [-64, [0x40]], // smallest 1-byte negative
    [-65, [0xbf, 0x7f]],
    [-123456, [0xc0, 0xbb, 0x78]], // the LEB128 spec's worked example
    [0x7fff_ffff, [0xff, 0xff, 0xff, 0xff, 0x07]],
    [-0x8000_0000, [0x80, 0x80, 0x80, 0x80, 0x78]],
  ] as const)("%d", ([n, bytes]) => {
    expect(written((w) => w.sleb(n))).toEqual([...bytes]);
  });

  test("rejects values outside i32", () => {
    expect(() => written((w) => w.sleb(0x8000_0000))).toThrow(/out of i32 range/);
    expect(() => written((w) => w.sleb(-0x8000_0001))).toThrow(/out of i32 range/);
  });
});

describe("sleb64", () => {
  test.for([
    [0n, [0x00]],
    [-1n, [0x7f]],
    [(1n << 52n) - 1n, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x07]], // the mantissa mask
    [1n << 52n, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x08]], // the implicit bit
    // 9 full groups leave the sign bit set, so a 10th terminates.
    [0x7fff_ffff_ffff_ffffn, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]],
    [-0x8000_0000_0000_0000n, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f]],
  ] as const)("%s", ([n, bytes]) => {
    expect(written((w) => w.sleb64(n))).toEqual([...bytes]);
  });

  test("rejects values outside i64", () => {
    expect(() => written((w) => w.sleb64(1n << 63n))).toThrow(/out of i64 range/);
    expect(() => written((w) => w.sleb64(-(1n << 63n) - 1n))).toThrow(/out of i64 range/);
  });
});

test("f64 is little-endian IEEE754", () => {
  expect(written((w) => w.f64(1))).toEqual([0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
  expect(written((w) => w.f64(-2))).toEqual([0, 0, 0, 0, 0, 0, 0, 0xc0]);
});

test("name is uleb length + utf8 bytes", () => {
  expect(written((w) => w.name("_start"))).toEqual([6, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74]);
  // Multi-byte UTF-8 counts BYTES, not code points.
  expect(written((w) => w.name("π"))).toEqual([2, 0xcf, 0x80]);
});

test("framed prefixes the body's byte length, nesting included", () => {
  expect(
    written((w) =>
      w.framed((inner) => {
        inner.u8(0xaa);
        inner.framed((deeper) => deeper.raw(new Uint8Array(130)));
      }),
    ),
  ).toEqual([0x85, 0x01, 0xaa, 0x82, 0x01, ...new Array<number>(130).fill(0)]);
});

test("section is id byte + framed payload", () => {
  expect(written((w) => w.section(1, (b) => b.u8(0x60)))).toEqual([1, 1, 0x60]);
});
