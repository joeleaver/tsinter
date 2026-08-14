// A plain source-level throw, parked at an inner finally that itself
// suspends, must chain through a STILL-open outer finally at the inner
// finally's own natural end — not merely when a consumer injection lands
// directly at a suspend point (2012's own shapes). reraisePending's own
// re-raise has to consult the SAME "is there another finally out there"
// question its RETURN/GENRET siblings already do.
function* g(): Generator<string, string, unknown> {
  try {
    try {
      yield "a";
      throw new Error("boom");
    } finally {
      yield "inner-fin";
    }
  } finally {
    yield "outer-fin";
  }
}
const it = g();
console.log("1", JSON.stringify(it.next()));
console.log("2", JSON.stringify(it.next()));
console.log("3", JSON.stringify(it.next()));
try {
  console.log("4", JSON.stringify(it.next()));
} catch (e) {
  if (e instanceof Error) console.log("4 THREW", e.message);
}
