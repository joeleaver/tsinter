// A rejection nobody handles is fatal at the export's drain, as in Node.
import * as pw from "pw";

export function ok(): void {
  Promise.reject(new Error("handled")).catch(() => pw.note_f64(7));
}

export function bad(): void {
  void Promise.reject(new Error("nobody listens"));
  pw.note_f64(1);
}
