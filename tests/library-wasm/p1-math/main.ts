import * as pw from "pw";
export function m(x: number, y: number): void {
  const fs = [Math.sin(x), Math.cos(x), Math.tan(x), Math.exp(x), Math.log(Math.abs(x)), Math.pow(x, y), x ** y, Math.atan2(x, y), Math.cbrt(x), Math.hypot(x, y), Math.expm1(x / 100), Math.log1p(Math.abs(x) / 3), Math.sinh(x / 50), Math.cosh(x / 50), Math.tanh(x), Math.asin(1 / x), Math.acos(1 / x), Math.atan(x), Math.log2(Math.abs(x)), Math.log10(Math.abs(x)), Math.asinh(x), Math.acosh(Math.abs(x) + 1), Math.atanh(1 / (x + 0.5)), Math.fround(x / 3), Math.round(x * 2.5), Math.sqrt(Math.abs(x))];
  for (const f of fs) pw.note_f64(f);
  pw.note_f64(Number((x / 7).toFixed(5)));
  pw.note_f64(parseFloat((x * 1e20 / 3).toString()));
}
