// An inner try/finally wrapped by a SEPARATE outer try/catch (not one
// try/catch/finally) — nesting order matters, not just "a handler
// exists somewhere outward": the finally is pushed AFTER (more deeply
// nested than) the outer handler, so it must run BEFORE the exception
// ever reaches that catch.
function* g(): Generator<string, string, unknown> {
  try {
    try {
      yield "a";
      throw new Error("boom");
    } finally {
      yield "inner-fin";
    }
  } catch (e) {
    yield "caught:" + (e as Error).message;
  }
  return "end";
}
const it = g();
console.log("1", JSON.stringify(it.next()));
console.log("2", JSON.stringify(it.next()));
console.log("3", JSON.stringify(it.next()));
console.log("4", JSON.stringify(it.next()));
