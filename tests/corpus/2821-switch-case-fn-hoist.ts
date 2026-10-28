// A function declaration inside a case clause is hoisted to the switch
// block's entry: another clause — entered by a jump past the declaring
// clause — calls it, Node-exact (GH #49's sibling: the in-place lowering
// left the local unset there and trapped on a null closure).
function hoisted(k: number): string {
  switch (k) {
    case 0:
      function g(): string { return "g"; }
      return g();
    case 1:
      return "late " + g();
  }
  return "none";
}
console.log(hoisted(1));
console.log(hoisted(0));
for (const k of [1, 0]) {
  switch (k) {
    case 0:
      function h(n: number): string { return "h" + n; }
      console.log(h(0));
      break;
    default:
      console.log("default " + h(k));
  }
}
