// SEMANTICS.md S142: heavy frames at the default max_depth (2,000) stay
// inside both engines (wasmtime at the contract's 1 MiB stack); a JSON value
// nested deeper than the limit stops by the counter where Node would not:
// this row's output is recorded, and V8 and wasmtime must both print it.
import * as pw from "pw";
function heavy(d: number, a: number, b: number, c: number, e: number, f: number, g: number, h: number): number {
  if (d === 0) return a + b + c + e + f + g + h;
  const x1 = a * 1.1, x2 = b * 1.2, x3 = c * 1.3, x4 = e * 1.4, x5 = f * 1.5, x6 = g * 1.6, x7 = h * 1.7;
  const y1 = x1 + x2, y2 = x3 + x4, y3 = x5 + x6, y4 = x7 + y1, y5 = y2 + y3, y6 = y4 + y5;
  const s = "k" + d;
  const o = { p: x1, q: x2, r: s };
  let r = 0;
  try {
    r = heavy(d - 1, x1 % 7, x2 % 7, x3 % 7, x4 % 7, x5 % 7, x6 % 7, x7 % 7) + y6 % 3 + o.p % 2 + o.r.length;
  } catch (err) {
    r = -1;
  } finally {
    r += 0;
  }
  return r + y1 + y2 + y3 + y4 + y5 + y6 + x1 + x2 + x3 + x4 + x5 + x6 + x7 - (y1 + y2 + y3 + y4 + y5 + y6 + x1 + x2 + x3 + x4 + x5 + x6 + x7);
}
export function go(n: number): void { pw.note_f64(Math.floor(heavy(n, 1, 2, 3, 4, 5, 6, 7))); }
type N = { c: N | null; v: number };
export function jsonDeep(n: number): void {
  let t: N | null = null;
  for (let i = 0; i < n; i++) t = { c: t, v: i };
  pw.note_f64(JSON.stringify(t).length);
}
