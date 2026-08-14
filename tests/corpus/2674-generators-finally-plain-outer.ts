// The chaining shape (2673) with the OUTER finally not suspending at all
// — the re-raise still has to reach it and run it to completion (its own
// console.log) before the exception continues out, not skip straight past
// a finally that happens to complete synchronously.
function* g(): Generator<string, string, unknown> {
  try {
    try {
      yield "a";
      throw new Error("boom");
    } finally {
      yield "inner-fin";
    }
  } finally {
    console.log("outer-fin ran");
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
