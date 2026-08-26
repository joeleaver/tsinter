// finished() as a per-stream watcher LIST: several watchers on one stream
// fire in REGISTRATION order, the returned cleanup unhooks exactly one of
// them, a watcher registered on an ALREADY-closed stream still fires
// (asynchronously), and BOTH the callback and the promise form settle when
// registered on the same stream (what stdout can observe — not a claim
// about whether they share one internal list; that's a mechanism inference
// this program's output can't distinguish from two independent lists).
// Re-derived by the corpus-scan census (board #94) from stage D's
// finished() probes (board #77). (Formerly g5 in the corpus-scan
// re-derivation — renamed per board #94's fix round, task #94/94-D1.)
import { Readable, Writable, finished } from "node:stream";
import { finished as finishedP } from "node:stream/promises";

const order: string[] = [];
const r = new Readable({
  read() {
    this.push(null);
  },
});
finished(r, () => order.push("A"));
const dropB = finished(r, () => order.push("B"));
finished(r, () => order.push("C"));
dropB();
finished(r, () => {
  order.push("D");
  console.log("order:", order.join(","));
  late();
});
r.resume();

function late(): void {
  // Registering on an already-closed stream: still fires, asynchronously.
  console.log("late: registering on closed stream, destroyed=", r.destroyed);
  finished(r, (err?: Error | null) => {
    console.log("late fired:", err !== undefined && err !== null ? err.message : "clean");
    mixed();
  });
  console.log("late: registered (not yet fired)");
}

function mixed(): void {
  // Both forms watching one stream: callback registered first, promise
  // second, both settle.
  const w = new Writable({
    write(_c: Buffer, _e: string, cb: () => void) {
      cb();
    },
  });
  finished(w, (err?: Error | null) => {
    console.log("cb form:", err !== undefined && err !== null ? err.message : "clean");
  });
  const done = finishedP(w);
  w.write("data");
  w.end();
  void done.then(() => {
    console.log("promise form: clean");
    console.log("done");
  });
}
console.log("sync");
