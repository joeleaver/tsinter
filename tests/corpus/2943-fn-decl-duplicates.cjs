// @ts-nocheck
// GH #111 (sloppy CommonJS): a scope that declares the same function more
// than once binds the LAST declaration from scope entry on — before,
// between and after the declarations; at module and function scope, in a
// sloppy block, in a switch, captured, recursive and taken as a value. And
// the binding forms that meet a function declaration's name where Node's
// answer is the checker's: a var with no initializer, a later function
// assignment, a block-level let, a parameter the block's function cannot
// replace, and a nested function's own var.
console.log(top());
function top() { return "first"; }
console.log(top());
function top() { return "second"; }
console.log(top());

function nested() {
  function f() { return 1; }
  const a = f();
  function f() { return 2; }
  return a + f();
}
console.log(nested());

function three() {
  var r = [g()];
  function g() { return 1; }
  r.push(g());
  function g() { return 2; }
  r.push(g());
  function g() { return 3; }
  return r.join(",");
}
console.log(three());

function inBlock() {
  {
    function d() { return "d1"; }
    function d() { return "d2"; }
    return d();
  }
}
console.log(inBlock());

/** @param {number} k */
function inSwitch(k) {
  switch (k) {
    case 0:
      function s() { return "a"; }
      return s();
    case 1:
      function s() { return "b"; }
      return s();
  }
  return "none";
}
console.log(inSwitch(0), inSwitch(1));

function captured() {
  let n = 1;
  function f() { return n; }
  function f() { return n * 10; }
  n = 2;
  return f();
}
console.log(captured());

function recursive() {
  function fact(n) { return 0; }
  function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
  return fact(5);
}
console.log(recursive());

function asValue() {
  const h = f;
  function f() { return "one"; }
  function f() { return "two"; }
  return h();
}
console.log(asValue());

function varNoInit() {
  var m;
  function m() { return 1; }
  return typeof m + m();
}
console.log(varNoInit());
var q;
function q() { return 2; }
console.log(typeof q, q());

function reassigned() {
  function h() { return 1; }
  h = function () { return 2; };
  return h();
}
console.log(reassigned());

function letShadow() {
  let f = 1;
  {
    function f() { return 2; }
    console.log(typeof f);
  }
  return typeof f;
}
console.log(letShadow());

function nestedVar() {
  function h() { return 1; }
  function inner() { var h = 2; return h; }
  return typeof h + inner();
}
console.log(nestedVar());

/** @param {number} f */
function paramVar(f) {
  var f;
  return typeof f;
}
console.log(paramVar(1));

/** @param {number} f */
function paramBlockFn(f) {
  {
    function f() { return 2; }
  }
  return typeof f;
}
console.log(paramBlockFn(1));

function ifElse(flag) {
  if (flag) {
    function p() { return "yes"; }
    return p();
  } else {
    function p() { return "no"; }
    return p();
  }
}
console.log(ifElse(true), ifElse(false));

function blockOnly() {
  {
    function f() { return 2; }
    return f();
  }
}
console.log(blockOnly());

function shadowedInner() {
  {
    function f() { return 2; }
  }
  function inner() { var f = 3; return f; }
  return inner();
}
console.log(shadowedInner());
