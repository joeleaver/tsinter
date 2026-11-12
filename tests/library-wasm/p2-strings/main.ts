// Strings across the boundary (design §3.2): UTF-8 both ways, lone
// surrogates become U+FFFD (SEMANTICS.md S144), a string result lands in
// the result buffer (<name>_result_ptr/_len).
import * as pw from "pw";

export function say(s: string): string {
  pw.log(s);
  pw.log("len " + s.length);
  pw.emit_command("spawn " + s.toUpperCase());
  pw.note_f64(pw.register_component(s));
  return "<" + s + ">";
}

export function odd(): void {
  pw.log("lone \ud800 high, lone \udc00 low, pair \ud83d\ude00");
  pw.log("");
  pw.log("x".repeat(20000).length + " " + "y".repeat(3000));
}

export function many(n: number): void {
  for (let i = 0; i < n; i++) pw.register_component("c" + (i % 7));
  pw.log("done " + n);
}

export function echo(s: string): string {
  return s;
}
