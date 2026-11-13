// Every scalar class across the boundary, both ways (design §2.2).
import * as pw from "pw";

export function echo(k: number): void {
  pw.note_f64(pw.give_f64(k));
  pw.note_f32(pw.give_f32(k));
  pw.note_s32(pw.give_s32(k));
  pw.note_u32(pw.give_u32(k));
  pw.note_s64(pw.give_s64(k));
  pw.note_u64(pw.give_u64(k));
  pw.note_bool(pw.give_bool(k));
}

export function f32Round(x: number): void {
  pw.note_f32(x);
}

export function mix(a: number, b: bigint, c: boolean, d: number, e: bigint, f: number): number {
  pw.note_s32(a);
  pw.note_u64(b);
  pw.note_bool(c);
  pw.note_f64(d);
  pw.note_s64(e);
  pw.note_f32(f);
  return a + d;
}

export function back(k: number): bigint {
  return pw.give_u64(k);
}

export function neg(): number {
  return -7;
}

export function flag(x: boolean): boolean {
  return !x;
}
