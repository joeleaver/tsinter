// An exception escaping an export: report, trap, and the instance is
// stopped for good (SEMANTICS.md S140).
import * as pw from "pw";

let calls = 0;

export function step(n: number): number {
  calls++;
  pw.note_f64(calls);
  if (n === 3) throw new TypeError("step " + n + " is bad");
  try {
    if (n === 2) throw new RangeError("caught inside");
  } catch (e) {
    pw.note_f64(-1);
  }
  return calls * 10;
}

export function other(): void {
  pw.note_f64(99);
}
