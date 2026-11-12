// tsinter:memory: an out-buffer (get_vec3), the hostStr retry shape
// (read_text), reads and writes of every width, the heap and the copies.
import * as pw from "pw";
import { mem } from "tsinter:memory";

let e = 0n;
let heap = 0;

export function setup(): void {
  e = pw.spawn(1);
  pw.set_f32(e, 2, 0, 1.5);
  pw.set_f32(e, 2, 1, -2.25);
  pw.set_f32(e, 2, 2, 1e10);
  heap = mem.alloc(64);
  mem.setF64(heap, Math.PI);
}

export function vec(): void {
  const p = mem.scratch(12);
  pw.get_vec3(e, 2, 0, p);
  pw.note_f64(mem.f32(p));
  pw.note_f64(mem.f32(p + 4));
  pw.note_f64(mem.f32(p + 8));
}

export function text(): void {
  let cap = 4;
  let p = mem.scratch(cap);
  let n = pw.read_text(p, cap);
  if (n > cap) {
    cap = n;
    p = mem.scratch(cap);
    n = pw.read_text(p, cap);
  }
  pw.log(mem.utf8(p, n));
  const bytes = mem.copyU8(p, n);
  pw.note_f64(bytes.length);
  pw.note_f64(bytes[1]!);
}

export function widths(): void {
  const p = mem.scratch(32);
  mem.setU8(p, 200);
  mem.setI32(p + 4, -5);
  mem.setU32(p + 8, 4000000000);
  mem.setF32(p + 12, 0.1);
  mem.setF64(p + 16, -0.5);
  pw.note_f64(mem.u8(p));
  pw.note_f64(mem.i32(p + 4));
  pw.note_f64(mem.u32(p + 4));
  pw.note_f64(mem.u32(p + 8));
  pw.note_f64(mem.i32(p + 8));
  pw.note_f64(mem.f32(p + 12));
  pw.note_f64(mem.f64(p + 16));
  const f = mem.copyF32(p + 12, 1);
  pw.note_f64(f[0]!);
  const u = mem.copyU32(p + 4, 2);
  pw.note_f64(u[0]! + u[1]!);
  const i = mem.copyI32(p + 4, 1);
  pw.note_f64(i[0]!);
  pw.note_f64(mem.f64(heap));
}

export function heapChurn(): void {
  // free then alloc: the block comes back; a fresh one grows the heap
  for (let k = 0; k < 100; k++) {
    const a = mem.alloc(100 + k);
    mem.setU8(a, k);
    mem.free(a);
  }
  const big = mem.alloc(200000);
  mem.setU32(big + 199996, 77);
  pw.note_f64(mem.u32(big + 199996));
  mem.free(big);
  pw.note_f64(mem.f64(heap));
}
