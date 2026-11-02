// A conditional whose arms produce no value (void), used as a VALUE: the
// ternary has no representation, so it is refused by name (GH #107 — the
// round-3 survey found it as an internal compiler error). In statement
// position (`c ? f() : g();`, a void arrow's concise body) it lowers as an
// if statement.
function report(flag: boolean): void {
  const result = flag ? console.log("yes") : console.log("no");
  console.log(result);
}
report(true);
