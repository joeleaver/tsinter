/* tsinter:memory for the node column (design §3.2, SEMANTICS.md S147): a
 * line-for-line model of the module's linear memory — the same layout (the
 * error area, then the heap from 4,352, then the scratch arena), the same
 * heap (8-byte headers [size, tag], first fit in free order, zeroed
 * blocks), the same growth and the same fences with the same addresses.
 * Keep it in step with emitter.ts's %lib.alloc/%lib.free/%lib.scratch/
 * %lib.grow. One difference stays: the module also stages import arguments
 * in the scratch arena (and restores it), so its memory can be larger;
 * reading outside the blocks a program owns is unspecified (S147).
 * `fence(text)` stops the instance the way the driver does. */
const PAGE = 65536;
const STAGE_BASE = 4352;
const CAP = 16384 * PAGE;
const TAG_LIVE = 0xa110c8ed;
const TAG_FREE = 0xf4eeb10c;

export function createMemory(fence) {
  const buf = new ArrayBuffer(PAGE, { maxByteLength: CAP });
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let cursor = STAGE_BASE;
  let stageBase = STAGE_BASE;
  let heapTop = STAGE_BASE;
  let freeHead = 0;
  const grow = (top) => {
    if (top > CAP) fence("tsinter: the module's memory would pass its 1 GiB limit");
    if (top > buf.byteLength) buf.resize(buf.byteLength + Math.ceil((top - buf.byteLength) / PAGE) * PAGE);
  };
  const corrupt = () => fence("tsinter: the tsinter:memory heap is corrupted (a write past the end of a block?)");
  const range = (what, p, n) => {
    if (!(Number.isInteger(p) && p >= 0 && n >= 0 && p + n <= buf.byteLength)) fence(`tsinter: ${what} is outside the module's memory: ${String(p)}`);
    return p;
  };
  const u32 = (what, v, hi = 4294967295, cls = "u32", lo = 0) => {
    if (!(typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi)) fence(`tsinter: ${what} is not a ${cls}: ${String(v)}`);
    return v;
  };
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  const canon = (v) => (Number.isNaN(v) ? NaN : v);
  const alloc = (n) => {
    let sz = (n + 7) & ~7;
    sz = sz >>> 0;
    if (sz === 0) sz = 8;
    for (let b = freeHead, prev = 0; b !== 0; prev = b, b = dv.getUint32(b + 8, true)) {
      if (b < STAGE_BASE || b >= heapTop || (b & 7) !== 0) corrupt();
      if (dv.getUint32(b + 4, true) !== TAG_FREE) corrupt();
      const size = dv.getUint32(b, true);
      if (size >= sz) {
        const next = dv.getUint32(b + 8, true);
        if (prev === 0) freeHead = next;
        else dv.setUint32(prev + 8, next, true);
        dv.setUint32(b + 4, TAG_LIVE, true);
        u8.fill(0, b + 8, b + 8 + size);
        return b + 8;
      }
    }
    if (cursor !== stageBase) fence("tsinter: mem.alloc needs to grow the heap while this call's scratch is in use; allocate before using mem.scratch in the call");
    const b = heapTop;
    grow(b + 8 + sz);
    const top = b + 8 + sz;
    dv.setUint32(b, sz, true);
    dv.setUint32(b + 4, TAG_LIVE, true);
    u8.fill(0, b + 8, top);
    heapTop = stageBase = cursor = top;
    return b + 8;
  };
  const free = (p) => {
    if (p === 0) return;
    for (let b = STAGE_BASE; b < heapTop; ) {
      const sz = dv.getUint32(b, true);
      if (sz === 0 || (sz & 7) !== 0 || sz > heapTop - b - 8) corrupt();
      if (b + 8 === p) {
        if (dv.getUint32(b + 4, true) === TAG_LIVE) {
          dv.setUint32(b + 4, TAG_FREE, true);
          dv.setUint32(b + 8, freeHead, true);
          freeHead = b;
          return;
        }
        break;
      }
      b = b + 8 + sz;
    }
    fence(`tsinter: mem.free(${String(p)}) is not a live block: an interior pointer, a pointer mem.alloc did not return, or a double free`);
  };
  const scratch = (n) => {
    cursor = (cursor + 7) & ~7;
    grow(cursor + n);
    u8.fill(0, cursor, cursor + n);
    const p = cursor;
    cursor += n;
    return p;
  };
  const mem = {
    scratch(n) {
      return scratch(u32("the size of mem.scratch", n, 2147483647));
    },
    alloc(n) {
      return alloc(u32("the size of mem.alloc", n, 2147483647));
    },
    free(p) {
      free(u32("the pointer of mem.free", p));
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
      dv.setFloat32(range("mem.setF32", p, 4), canon(v), true);
    },
    setF64(p, v) {
      dv.setFloat64(range("mem.setF64", p, 8), canon(v), true);
    },
    utf8(p, n) {
      u32("the length of mem.utf8", n, 2147483647);
      return dec.decode(u8.slice(range("mem.utf8", p, n), p + n));
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
  /** The result buffer of an export returning a pointer class: the
   * module's free/alloc at the end of the call (index.ts runLibrary). */
  const results = new Map();
  const putResult = (name, bytes) => {
    cursor = stageBase;
    let r = results.get(name) ?? { ptr: 0, cap: 0 };
    if (bytes > r.cap) {
      free(r.ptr);
      r = { ptr: alloc(bytes), cap: bytes };
      results.set(name, r);
    }
  };
  return { mem, get bytes() { return u8; }, reset: () => (cursor = stageBase), putResult };
}
