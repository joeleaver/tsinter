import * as pw from "pw";
export function div(a: number, b: number): number { return a / b; }
export function sub(a: number, b: number): number { return a - b; }
export function sq(a: number): number { return Math.sqrt(a); }
export function bytes(a: number, b: number): void {
  const u = new Uint8Array(8);
  const dv = new DataView(u.buffer);
  dv.setFloat64(0, a - b);
  pw.note_f64(dv.getUint32(0));
  dv.setFloat32(0, a * b);
  pw.note_f64(dv.getUint32(0));
  dv.setFloat64(0, a / b, true);
  pw.note_f64(u[7]!);
}
