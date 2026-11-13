// Module evaluation that throws: the first call (whichever) fails.
import * as pw from "pw";
import "./side.ts";

export function run(): void {
  pw.note_f64(2);
}
