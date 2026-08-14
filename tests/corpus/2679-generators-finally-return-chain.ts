// The RETURN-completion analog of 2673's chain, as a permanent control:
// a .return() crossing two suspending, nested finallys already worked
// before this round (genretRouting has always consulted finallyOf
// directly) — pinned as its own corpus program so a future change to the
// THROW-side chaining mechanism cannot silently regress this path
// without a claimed program noticing.
function* g(): Generator<string, string, unknown> {
  try {
    try {
      yield "a";
      return "natural";
    } finally {
      yield "inner-fin";
    }
  } finally {
    yield "outer-fin";
  }
}
const it = g();
console.log("1", JSON.stringify(it.next()));
console.log("2", JSON.stringify(it.return("early")));
console.log("3", JSON.stringify(it.next()));
console.log("4", JSON.stringify(it.next()));
