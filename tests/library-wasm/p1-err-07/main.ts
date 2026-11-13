// The failure text the module reports, for every kind of thrown value
// (SEMANTICS.md S140): Node's String() for errors and primitives, S007's
// spellings for other objects, UTF-8 with U+FFFD, cut at 4,096 bytes.
import * as pw from "pw";
class MyErr extends Error {
  constructor(m: string) {
    super(m);
    this.name = "MyErr";
  }
}
export function step(n: number): number {
  if (n === 1) throw "plain string";
  if (n === 2) throw 5;
  if (n === 3) throw new Error("ends with newline\n");
  if (n === 4) throw new Error("x".repeat(5000));
  if (n === 5) throw new Error("uni \u00e9\u2603\u{1d11e} lone \ud800 end");
  if (n === 6) throw new MyErr("custom");
  if (n === 7) throw new Error("");
  if (n === 8) throw new Error("\u00e9".repeat(2100));
  if (n === 9) throw null;
  if (n === 10) throw new TypeError("multi\nline\n\n");
  if (n === 11) throw { a: 1 };
  if (n === 12) void Promise.resolve().then(() => {
    throw new Error("then-throw");
  });
  return n;
}
export function other(): void {
  pw.note_f64(99);
}
