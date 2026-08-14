// The other half of 2674's axis: the INNER finally does not suspend (so
// no park ever reaches reraisePending at that level at all — the throw
// unwinds straight through the inline finally body), while the OUTER one
// does. The exception still has to chain into the outer finally via
// catchArm's own routing, a different mechanism half than 2673/2674.
function* g(): Generator<string, string, unknown> {
  try {
    try {
      yield "a";
      throw new Error("boom");
    } finally {
      console.log("inner-fin ran");
    }
  } finally {
    yield "outer-fin";
  }
}
const it = g();
console.log("1", JSON.stringify(it.next()));
console.log("2", JSON.stringify(it.next()));
try {
  console.log("3", JSON.stringify(it.next()));
} catch (e) {
  if (e instanceof Error) console.log("3 THREW", e.message);
}
