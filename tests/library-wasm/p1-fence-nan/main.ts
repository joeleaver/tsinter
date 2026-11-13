import * as pw from "pw";
export function n(x: number): number {
  return x;
}
export function big(x: bigint): void {
  pw.note_s64(x * x);
}
