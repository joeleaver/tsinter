// SEMANTICS.md S147: tsinter:memory's heap, modelled byte for byte by the
// Node column: zeroed blocks, first-fit reuse in free order, the same
// addresses, and named stops for bad frees, corrupted headers and the 1 GiB
// limit.
import * as pw from "pw";
import { mem } from "tsinter:memory";

const keep = mem.alloc(16);
mem.setU32(keep, 1234);

export function addrs(): void {
  const a = mem.alloc(24);
  const b = mem.alloc(8);
  pw.note_f64(a);
  pw.note_f64(b - a);
  mem.setU32(a, 99);
  mem.setU32(a + 8, 77);
  mem.free(a);
  const c = mem.alloc(16);
  pw.note_f64(c === a ? 1 : 0);
  pw.note_f64(mem.u32(c) + mem.u32(c + 8));
  mem.free(c);
  mem.free(b);
  const s = mem.scratch(32);
  pw.note_f64(mem.u32(s + 4));
  pw.note_f64(mem.u32(keep));
}

export function bad(k: number): void {
  const a = mem.alloc(16);
  if (k === 1) mem.free(a + 8);
  if (k === 2) {
    mem.free(a);
    mem.free(a);
  }
  if (k === 3) mem.free(12);
  if (k === 4) {
    mem.free(a);
    mem.setU32(a - 4, 7);
    mem.alloc(8);
  }
  if (k === 5) mem.alloc(2147483647);
  if (k === 6) mem.alloc(1073741824);
  pw.note_f64(k);
}
