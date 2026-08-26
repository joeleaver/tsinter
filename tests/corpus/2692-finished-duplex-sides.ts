// finished() over the three duplex-family SIDEDNESS verdicts: a plain
// Duplex tracks BOTH sides so neither the readable end nor an unfinished
// writable end reports clean (premature); a Transform that both ends and
// finishes reports clean; a PassThrough whose readable side is never
// drained leaves end() alone insufficient — a bare destroy() is premature.
// Re-derived by the corpus-scan census (board #94) from stage D's own
// sidedness audit (board #77, the "precedent's covering set" lesson).
// (Formerly g8 in the corpus-scan re-derivation — renamed per board #94's
// fix round, task #94/94-D1.)
import { Duplex, Transform, PassThrough, finished } from "node:stream";

const order: string[] = [];
const d = new Duplex({
  read() {
    this.push(null);
  },
  write(_c: Buffer, _e: string, _cb: () => void) {
    /* never call cb: the writable side never finishes */
  },
});
d.on("end", () => order.push("readable ended"));
finished(d, (err?: Error | null) => {
  order.push("fin: " + (err !== undefined && err !== null ? (err as NodeJS.ErrnoException).code : "clean"));
  console.log(order.join(" / "));
  bothSides();
});
d.resume();
d.write("never finishes");
setTimeout(() => d.destroy(), 1);

function bothSides(): void {
  // A Transform that BOTH ends and finishes reports clean.
  const t = new Transform({
    transform(c: Buffer, _e: string, cb: (e: Error | null, o?: Buffer) => void) {
      cb(null, c);
    },
  });
  finished(t, (err?: Error | null) => {
    console.log("transform:", err !== undefined && err !== null ? (err as NodeJS.ErrnoException).code : "clean");
    passthrough();
  });
  t.resume();
  t.end("payload");
}

function passthrough(): void {
  // A PassThrough whose readable side is never drained: end() alone leaves
  // the readable side unfinished, so a bare destroy() is premature.
  const p = new PassThrough();
  finished(p, (err?: Error | null) => {
    console.log("passthrough:", err !== undefined && err !== null ? (err as NodeJS.ErrnoException).code : "clean");
    console.log("done");
  });
  p.end("held");
  setTimeout(() => p.destroy(), 1);
}
console.log("sync");
