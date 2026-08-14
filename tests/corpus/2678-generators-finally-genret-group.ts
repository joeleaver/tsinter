// A GENRET (.return()) delivered at a state whose own routing-table
// group's REPRESENTATIVE state has no enclosing finally, while the state
// actually suspended does: "before" (no finally of its own) and "inside"
// (wrapped by an inner finally) share the SAME outer catch, but must NOT
// share the same finally-detour decision.
function* g(): Generator<string, string, unknown> {
  try {
    yield "before";
    try {
      yield "inside";
    } finally {
      yield "fin";
    }
  } catch (e) {
    yield "caught";
  }
  return "end";
}
const it = g();
console.log("1", JSON.stringify(it.next()));
console.log("2", JSON.stringify(it.next()));
console.log("3", JSON.stringify(it.return("early")));
console.log("4", JSON.stringify(it.next()));
