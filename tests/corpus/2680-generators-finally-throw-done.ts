// After an exception escapes THROUGH a finally (reraisePending's own
// "nothing left to route into" exit), the generator must be marked
// DONE — every later .next() answers {value:undefined,done:true} and
// the finally must never run a second time.
function* g(): Generator<string, string, unknown> {
  try {
    yield "a";
    throw new Error("boom");
  } finally {
    yield "fin";
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
console.log("4", JSON.stringify(it.next()));
console.log("5", JSON.stringify(it.next()));
