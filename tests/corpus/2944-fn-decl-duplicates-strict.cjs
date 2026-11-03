// @ts-nocheck
// GH #111 (strict CommonJS): duplicate declarations at function scope keep
// the last; a block-level function stays in its block (no Annex B var), so
// the module's own var is what the function reads outside the block.
"use strict";
function fnBody() {
  function g() { return "a"; }
  function g() { return "b"; }
  return g();
}
console.log(fnBody());

var f = 1;
function blockScoped() {
  {
    function f() { return 2; }
    console.log(typeof f, f());
  }
  return typeof f;
}
console.log(blockScoped());
