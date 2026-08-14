// A catch nested BETWEEN a suspending inner finally and an outer finally
// — at the inner finally's own end state, the middle catch is NEARER
// than the outer finally (pushed after it, more deeply nested), so a
// re-raise reaching this point must deliver to the catch first, not skip
// past it to the outer finally on a fixed "finally always wins" priority.
function* g(): Generator<string, string, unknown> {
  try {
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
  } finally {
    yield "outer-fin";
  }
  return "end";
}
const it = g();
console.log("1", JSON.stringify(it.next()));
console.log("2", JSON.stringify(it.next()));
console.log("3", JSON.stringify(it.next()));
console.log("4", JSON.stringify(it.next()));
console.log("5", JSON.stringify(it.next()));
