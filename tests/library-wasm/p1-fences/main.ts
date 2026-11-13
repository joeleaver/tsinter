// SEMANTICS.md S143: a value that does not fit its class stops the
// instance; it never wraps.
import * as pw from "pw";

export function u(x: number): void {
  pw.note_u32(x);
}
export function s(x: number): void {
  pw.note_s32(x);
}
export function result(x: number): number {
  return x;
}
