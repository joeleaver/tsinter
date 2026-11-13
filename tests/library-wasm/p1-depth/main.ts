// SEMANTICS.md S142: the call-depth limit (here the profile's 50) stops
// the instance with an uncatchable RangeError; within it, recursion works,
// and the counter unwinds through returns and caught exceptions.
import * as pw from "pw";

function down(n: number): number {
  return n === 0 ? 0 : 1 + down(n - 1);
}

function thrower(n: number): number {
  if (n === 0) throw new Error("bottom");
  return thrower(n - 1);
}

export function deep(n: number): void {
  for (let i = 0; i < 100; i++) {
    try {
      thrower(30);
    } catch (e) {
      // unwound through 31 frames
    }
  }
  pw.note_f64(down(n));
}

export function noCatch(n: number): void {
  try {
    pw.note_f64(down(n));
  } catch (e) {
    pw.note_f64(-1);
  }
}
