/* tsinter:memory for the node column (design §3.2): the same names and
 * checks as the module's intrinsics, over an ArrayBuffer. Addresses differ
 * from the module's (rows never print them); everything else must match:
 * little-endian reads and writes, the fences' texts, UTF-8 with
 * replacement. `fence(text)` stops the instance the way the driver does. */
const SIZE = 1 << 24;
const HEAP = 1 << 23;

export function createMemory(fence) {
  const buf = new ArrayBuffer(SIZE);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let cursor = 4096;
  let heapTop = HEAP;
  const blocks = new Map(); // payload -> size
  const free = [];
  const range = (what, p, n) => {
    if (!(Number.isInteger(p) && p >= 0 && n >= 0 && p + n <= SIZE)) fence(`tsinter: ${what} is outside the module's memory: ${String(p)}`);
    return p;
  };
  const u32 = (what, v, hi = 4294967295, cls = "u32", lo = 0) => {
    if (!(typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi)) fence(`tsinter: ${what} is not a ${cls}: ${String(v)}`);
    return v;
  };
  const dec = new TextDecoder();
  const mem = {
    scratch(n) {
      u32("the size of mem.scratch", n, 2147483647);
      cursor = (cursor + 7) & ~7;
      const p = cursor;
      cursor += n;
      return p;
    },
    alloc(n) {
      u32("the size of mem.alloc", n, 2147483647);
      const size = Math.max(8, (n + 7) & ~7);
      const i = free.findIndex((p) => blocks.get(p) >= size);
      if (i >= 0) return free.splice(i, 1)[0];
      const p = heapTop + 8;
      heapTop = p + size;
      blocks.set(p, size);
      return p;
    },
    free(p) {
      u32("the pointer of mem.free", p);
      if (p === 0) return;
      if (!blocks.has(p)) fence(`tsinter: mem.free of a pointer the heap did not allocate is outside the module's memory: ${String(p)}`);
      free.push(p);
    },
    u8: (p) => u8[range("mem.u8", p, 1)],
    i32: (p) => dv.getInt32(range("mem.i32", p, 4), true),
    u32: (p) => dv.getUint32(range("mem.u32", p, 4), true),
    f32: (p) => dv.getFloat32(range("mem.f32", p, 4), true),
    f64: (p) => dv.getFloat64(range("mem.f64", p, 8), true),
    setU8(p, v) {
      range("mem.setU8", p, 1);
      u8[p] = u32("the value of mem.setU8", v, 255, "u8");
    },
    setI32(p, v) {
      range("mem.setI32", p, 4);
      dv.setInt32(p, u32("the value of mem.setI32", v, 2147483647, "s32", -2147483648), true);
    },
    setU32(p, v) {
      range("mem.setU32", p, 4);
      dv.setUint32(p, u32("the value of mem.setU32", v), true);
    },
    // SEMANTICS.md S146: a NaN is stored as the canonical NaN
    setF32(p, v) {
      dv.setFloat32(range("mem.setF32", p, 4), Number.isNaN(v) ? NaN : v, true);
    },
    setF64(p, v) {
      dv.setFloat64(range("mem.setF64", p, 8), Number.isNaN(v) ? NaN : v, true);
    },
    utf8(p, n) {
      u32("the length of mem.utf8", n, 2147483647);
      return dec.decode(u8.subarray(range("mem.utf8", p, n), p + n));
    },
    copyU8(p, n) {
      u32("the length of mem.copyU8", n, 2147483647);
      return u8.slice(range("mem.copyU8", p, n), p + n);
    },
    copyI32(p, n) {
      u32("the length of mem.copyI32", n, 2147483647);
      return new Int32Array(buf.slice(range("mem.copyI32", p, 4 * n), p + 4 * n));
    },
    copyU32(p, n) {
      u32("the length of mem.copyU32", n, 2147483647);
      return new Uint32Array(buf.slice(range("mem.copyU32", p, 4 * n), p + 4 * n));
    },
    copyF32(p, n) {
      u32("the length of mem.copyF32", n, 2147483647);
      return new Float32Array(buf.slice(range("mem.copyF32", p, 4 * n), p + 4 * n));
    },
  };
  return { mem, bytes: u8, reset: () => (cursor = 4096) };
}
