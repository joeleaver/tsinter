/* INC-24 P1, CP3: RegexByteWriter (regex-bytewriter.ts) — the assembler's
 * byte buffer. Verified against hand-computed expected byte sequences
 * (little-endian, matching libregexp.c's put_u16/put_u32) and the
 * specific splice/backpatch idioms the assembler will depend on. */
import { describe, expect, test } from "vitest";
import { RegexByteWriter } from "../src/backend/wasm/regex-bytewriter.js";

describe("RegexByteWriter: basic writes are little-endian", () => {
  test("u8", () => {
    const w = new RegexByteWriter();
    w.u8(0xab);
    expect([...w.toBytes()]).toEqual([0xab]);
  });
  test("u16 little-endian", () => {
    const w = new RegexByteWriter();
    w.u16(0x1234);
    expect([...w.toBytes()]).toEqual([0x34, 0x12]);
  });
  test("u32 little-endian", () => {
    const w = new RegexByteWriter();
    w.u32(0x12345678);
    expect([...w.toBytes()]).toEqual([0x78, 0x56, 0x34, 0x12]);
  });
  test("size tracks byte count as writes accumulate", () => {
    const w = new RegexByteWriter();
    w.u8(1);
    expect(w.size).toBe(1);
    w.u16(2);
    expect(w.size).toBe(3);
    w.u32(3);
    expect(w.size).toBe(7);
  });
});

describe("RegexByteWriter: byteAt / readU16 (bytecode scanning)", () => {
  test("byteAt reads back individual already-written bytes", () => {
    const w = new RegexByteWriter();
    w.u8(0x11);
    w.u8(0x22);
    w.u8(0x33);
    expect(w.byteAt(0)).toBe(0x11);
    expect(w.byteAt(1)).toBe(0x22);
    expect(w.byteAt(2)).toBe(0x33);
  });
  test("readU16 round-trips what u16 wrote, little-endian", () => {
    const w = new RegexByteWriter();
    w.u8(0xff); // offset marker
    w.u16(0x1234);
    expect(w.readU16(1)).toBe(0x1234);
  });
});

describe("RegexByteWriter: patchU32 / readU32 (backpatching)", () => {
  test("patchU32 overwrites 4 already-written bytes in place, byte count unchanged", () => {
    const w = new RegexByteWriter();
    w.u8(0xff); // a marker byte before the patch target
    const pos = w.size;
    w.u32(0); // placeholder
    w.u8(0xee); // a marker byte after
    expect(w.size).toBe(6);
    w.patchU32(pos, 0xdeadbeef);
    expect(w.size).toBe(6); // patching doesn't grow the buffer
    expect([...w.toBytes()]).toEqual([0xff, 0xef, 0xbe, 0xad, 0xde, 0xee]);
  });
  test("readU32 round-trips what u32/patchU32 wrote", () => {
    const w = new RegexByteWriter();
    w.u32(0x87654321);
    expect(w.readU32(0)).toBe(0x87654321);
    w.patchU32(0, 0x11223344);
    expect(w.readU32(0)).toBe(0x11223344);
  });
});

describe("RegexByteWriter: insertZeros (dbuf_insert — the quantifier-wrapping splice)", () => {
  test("inserts zero bytes at a position, shifting everything after it forward", () => {
    const w = new RegexByteWriter();
    w.u8(1);
    w.u8(2);
    w.u8(3);
    w.insertZeros(1, 2); // insert 2 zero bytes right after the first byte
    expect([...w.toBytes()]).toEqual([1, 0, 0, 2, 3]);
  });
  test("the reference's own idiom: emit an atom, then retroactively wrap it in a quantifier opcode by inserting BEFORE it", () => {
    const w = new RegexByteWriter();
    // Simulate: emit some prior bytecode, remember the position, emit
    // "the atom" (a couple of bytes), then insert a wrapping opcode
    // BEFORE the atom by splicing at the remembered position.
    w.u8(0xaa); // prior bytecode
    const atomStart = w.size;
    w.u8(0xbb);
    w.u8(0xcc); // "the atom"
    w.insertZeros(atomStart, 1); // make room for a 1-byte wrapper opcode
    const bytes = w.toBytes();
    expect([...bytes]).toEqual([0xaa, 0x00, 0xbb, 0xcc]); // wrapper slot still zero, atom shifted right by 1
  });
  test("insertZeros at position 0 prepends", () => {
    const w = new RegexByteWriter();
    w.u8(9);
    w.insertZeros(0, 2);
    expect([...w.toBytes()]).toEqual([0, 0, 9]);
  });
  test("insertZeros at the end appends (equivalent to writing zeros directly)", () => {
    const w = new RegexByteWriter();
    w.u8(9);
    w.insertZeros(w.size, 2);
    expect([...w.toBytes()]).toEqual([9, 0, 0]);
  });
});

describe("RegexByteWriter: moveToFront (re_parse_alternative's term-reversal idiom)", () => {
  test("two terms: after processing both incrementally, order is fully reversed", () => {
    const w = new RegexByteWriter();
    const S = w.size; // alternative start
    // Term A: 2 bytes [0xa1, 0xa2].
    const aStart = w.size;
    w.u8(0xa1);
    w.u8(0xa2);
    w.moveToFront(S, aStart, w.size); // trivial no-op: A is already at the front
    expect([...w.toBytes()]).toEqual([0xa1, 0xa2]);
    // Term B: 3 bytes [0xb1, 0xb2, 0xb3], emitted after A.
    const bStart = w.size;
    w.u8(0xb1);
    w.u8(0xb2);
    w.u8(0xb3);
    w.moveToFront(S, bStart, w.size);
    // Expect B prepended before A: [B, A].
    expect([...w.toBytes()]).toEqual([0xb1, 0xb2, 0xb3, 0xa1, 0xa2]);
  });
  test("three terms: incremental prepend yields fully reversed order [C, B, A]", () => {
    const w = new RegexByteWriter();
    const S = w.size;
    const aStart = w.size;
    w.u8(0xa1);
    w.moveToFront(S, aStart, w.size);
    const bStart = w.size;
    w.u8(0xb1);
    w.u8(0xb2);
    w.moveToFront(S, bStart, w.size);
    const cStart = w.size;
    w.u8(0xc1);
    w.u8(0xc2);
    w.u8(0xc3);
    w.moveToFront(S, cStart, w.size);
    expect([...w.toBytes()]).toEqual([0xc1, 0xc2, 0xc3, 0xb1, 0xb2, 0xa1]);
  });
  test("preserves bytes before blockStart (only the alternative's own span is touched)", () => {
    const w = new RegexByteWriter();
    w.u8(0xff); // prior bytecode, outside the alternative
    const S = w.size;
    const aStart = w.size;
    w.u8(0xa1);
    w.moveToFront(S, aStart, w.size);
    const bStart = w.size;
    w.u8(0xb1);
    w.u8(0xb2);
    w.moveToFront(S, bStart, w.size);
    expect([...w.toBytes()]).toEqual([0xff, 0xb1, 0xb2, 0xa1]);
  });
});

describe("RegexByteWriter: truncate (the quant_max===0 discard case)", () => {
  test("shrinks the buffer to the given size, discarding trailing bytes", () => {
    const w = new RegexByteWriter();
    w.u8(1);
    w.u8(2);
    w.u8(3);
    const savedSize = 1;
    w.truncate(savedSize);
    expect(w.size).toBe(1);
    expect([...w.toBytes()]).toEqual([1]);
  });
  test("truncate then writing more continues from the truncated point", () => {
    const w = new RegexByteWriter();
    w.u8(1);
    w.u8(2);
    w.u8(3);
    w.truncate(1);
    w.u8(9);
    expect([...w.toBytes()]).toEqual([1, 9]);
  });
});
