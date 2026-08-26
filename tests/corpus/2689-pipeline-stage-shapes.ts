// pipeline() stage shapes the single-middle success/error pair never
// reaches: TWO middle stages, a filtering transform whose data-less cb(null)
// drops a chunk without ever hitting EOF, and a stage destroyed cleanly
// mid-flight — which fails the pipeline with ERR_STREAM_PREMATURE_CLOSE
// rather than hanging. Re-derived by the corpus-scan census (board #94)
// from stage D's pipeline probes (board #77). (Formerly g4 in the
// corpus-scan re-derivation — renamed per board #94's fix round, task
// #94/94-D1.)
import { Readable, Transform, Writable, PassThrough, pipeline } from "node:stream";

const chunks = ["a", "b", "c"];
let i = 0;
const s = new Readable({
  read() {
    this.push(i < chunks.length ? (chunks[i++] as string) : null);
  },
});
const drop = new Transform({
  transform(c: Buffer, _e: string, cb: (e: Error | null, o?: Buffer) => void) {
    if (c.toString() === "b") {
      cb(null);
      return;
    }
    cb(null, c);
  },
});
const mid = new PassThrough();
const w = new Writable({
  write(c: Buffer, _e: string, cb: () => void) {
    console.log("w:", c.toString());
    cb();
  },
});
pipeline(s, drop, mid, w, (err?: Error | null) => {
  console.log("two-middles cb:", err !== undefined && err !== null ? err.message : "clean");
  cleanDestroy();
});

function cleanDestroy(): void {
  const src = new Readable({ read() {} });
  const dst = new Writable({
    write(_c: Buffer, _e: string, cb: () => void) {
      cb();
    },
  });
  let closes = 0;
  src.on("close", () => {
    closes++;
  });
  dst.on("close", () => {
    closes++;
  });
  pipeline(src, dst, (err: NodeJS.ErrnoException | null) => {
    console.log("clean-destroy cb:", err ? `${err.code}/${err.message}` : "none");
    console.log("closes:", closes);
  });
  dst.destroy();
}
console.log("sync");
