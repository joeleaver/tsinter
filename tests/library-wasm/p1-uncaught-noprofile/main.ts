// No profile, no report import: the text is in the error buffer.
import { note_f64 } from "pw";

export function a(n: number): void {
  note_f64(n);
  if (n > 1) throw "plain string " + n;
}
