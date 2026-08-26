// for-await over a Readable, exited EARLY: Node's async iterator destroys
// the source on break / return / throw (including a throw the ITERATOR
// BODY raises after the stream already destroyed itself), and leaves it
// alone on continue — only the natural end destroys via that path.
// Re-derived by the corpus-scan census (board #94) from stage D's own
// destroy-on-early-exit probes (board #72). (Formerly g2 in the
// corpus-scan re-derivation — renamed per board #94's fix round, task
// #94/94-D1.)
//
// EXCLUDED CELLS (task #94 constraint, kept out on purpose): re-iteration
// after an early exit throws Node's AbortError, and readableEnded diverges
// from the destroyed-flag axis measured here — S048's native notes cover
// both as separate, already-registered divergences on the C lane. This
// program reads ONLY r.destroyed (never readableEnded) and never
// re-iterates a stream past its first for-await (push-return only).
import { Readable } from "node:stream";

async function main(): Promise<void> {
  const r = new Readable({ read() {} });
  r.push("one");
  r.push("two");
  let closes = 0;
  r.on("close", () => {
    closes++;
  });
  for await (const chunk of r) {
    console.log("break chunk:", chunk.toString());
    break;
  }
  console.log("after break:", r.destroyed, r.push("more"));
  await new Promise((res) => setTimeout(res, 5));
  console.log("closes:", closes);

  // continue never destroys mid-stream; only the natural end does.
  const chunks = ["skip", "one", "skip", "two"];
  let idx = 0;
  const c = new Readable({
    read() {
      if (idx < chunks.length) {
        const next = chunks[idx++] as string;
        setTimeout(() => c.push(next), 1);
      } else setTimeout(() => c.push(null), 1);
    },
  });
  for await (const chunk of c) {
    console.log("cont chunk:", chunk.toString(), "destroyed=", c.destroyed);
    if (chunk.toString() === "skip") continue;
  }
  console.log("after continue-loop:", c.destroyed);

  // return crossing the loop destroys too.
  const rr = new Readable({ read() {} });
  rr.push("first");
  console.log("returned:", await first(rr));
  console.log("after return:", rr.destroyed);

  // an uncaught-by-the-loop throw destroys as well.
  const t = new Readable({ read() {} });
  t.push("boom");
  try {
    for await (const chunk of t) {
      throw new Error("body threw: " + chunk.toString());
    }
  } catch (err) {
    console.log("caught:", (err as Error).message);
  }
  console.log("after throw:", t.destroyed);

  // destroy-idempotence: the body's own destroy leaves the iterator's
  // destroy a no-op — 'close' fires exactly once.
  const d = new Readable({ read() {} });
  let dCloses = 0;
  d.on("close", () => {
    dCloses++;
  });
  d.push("x");
  try {
    for await (const chunk of d) {
      console.log("idem chunk:", chunk.toString());
      d.destroy();
      throw new Error("after self-destroy");
    }
  } catch (err) {
    console.log("caught:", (err as Error).message);
  }
  await new Promise((res) => setTimeout(res, 5));
  console.log("idem closes:", dCloses, d.destroyed);
  console.log("done");
}

async function first(r: Readable): Promise<string> {
  for await (const chunk of r) return chunk.toString();
  return "<none>";
}

main();
