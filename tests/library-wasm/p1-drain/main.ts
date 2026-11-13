// Module evaluation runs at the first export call, then a drain, then the
// body, then a drain. A task waiting on a promise resumes in the drain of
// the call that resolves it.
import * as pw from "pw";

pw.note_f64(1);
void Promise.resolve().then(() => pw.note_f64(2));

let wake: (() => void) | null = null;
async function task(): Promise<void> {
  pw.note_f64(10);
  await new Promise<void>((r) => {
    wake = r;
  });
  pw.note_f64(11);
  await null;
  pw.note_f64(12);
}

export function start(): void {
  pw.note_f64(3);
  void task();
  pw.note_f64(4);
}

export function tick(t: bigint): void {
  pw.note_s64(t);
  if (t === 2n && wake !== null) wake();
  void Promise.resolve(t).then((v) => pw.note_s64(v * 100n));
}
