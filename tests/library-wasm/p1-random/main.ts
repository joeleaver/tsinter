// SEMANTICS.md S141: Math.random draws the host's stream.
import * as pw from "pw";

const first = Math.random();

export function draw(n: number): void {
  pw.note_f64(first);
  for (let i = 0; i < n; i++) pw.note_f64(Math.random());
  pw.note_f64(Math.floor(Math.random() * 6) + 1);
}
