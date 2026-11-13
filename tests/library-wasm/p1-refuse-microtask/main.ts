import * as pw from "pw";
export function run(): void {
  queueMicrotask(() => pw.note_f64(1));
}
