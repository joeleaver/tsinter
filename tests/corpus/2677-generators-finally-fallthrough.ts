// 2676's exact shape, but the inner try body ALSO has a normal
// fallthrough path (an `if` guarding the throw) — same Node output as
// 2676 when the throw branch runs, but a DIFFERENT compiler path: this
// is what a compiler crash from reading completion fields the frame
// never allocated looked like (no park call happening to run for this
// specific shape before the read did). Landed as its own program
// deliberately — identical expected output must never be read as
// identical coverage.
function* g(flag: boolean): Generator<string, string, unknown> {
  try {
    try {
      yield "a";
      if (flag) throw new Error("boom");
    } finally {
      yield "inner-fin";
    }
  } catch (e) {
    yield "caught:" + (e as Error).message;
  }
  return "end";
}
const it = g(true);
console.log("1", JSON.stringify(it.next()));
console.log("2", JSON.stringify(it.next()));
console.log("3", JSON.stringify(it.next()));
console.log("4", JSON.stringify(it.next()));
