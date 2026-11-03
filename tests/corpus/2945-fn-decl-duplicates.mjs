// @ts-nocheck
// GH #111 (ES module): a function body may declare a function twice (the
// last wins); a block-level function is block-scoped in module code.
function fnBody() {
  function g() { return "a"; }
  const first = g();
  function g() { return "b"; }
  return first + g();
}
console.log(fnBody());

var f = 1;
function blockScoped() {
  {
    function f() { return 2; }
  }
  return typeof f;
}
console.log(blockScoped());
