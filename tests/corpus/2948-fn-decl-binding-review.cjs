// @ts-nocheck
// GH #111 review: forms Node runs that the binding checks must let through.
// Duplicates with different parameter counts call the last declaration
// (with fewer arguments too); a catch parameter, a destructuring's
// property name and a label named like a sloppy block function are their
// own bindings, not uses of its Annex B var.
function nm() {
  return f(1, 2);
  function f(a) { return "f1"; }
  function f(a, b) { return "f2"; }
}
console.log(nm());

console.log("start");
function m(a) { return "one"; }
console.log(m(1, 2));
function m(a, b) { return "two:" + a + ":" + b; }
console.log(m(1, 2), m(1), m.length);

function lengths() {
  function f(a) {}
  function f(a, b) {}
  return f.length;
}
console.log(lengths());

function fewer() {
  function g(a, b, c) { return "g3:" + a + b + c; }
  function g(a) { return "g1:" + a; }
  return [g(1), g(1, 2, 3), g.length].join(" ");
}
console.log(fewer());

function catchParam() {
  if (true) { function h() { return "in"; } console.log(h()); }
  try { throw "e"; } catch (h) { return h; }
}
console.log(catchParam());

function propertyNames() {
  if (true) { function h() { return "in"; } console.log(h()); }
  var obj = { h: 5 };
  var { h: z } = obj;
  return z + obj.h;
}
console.log(propertyNames());

function labels() {
  if (true) { function h() { return "in"; } console.log(h()); }
  h: for (var i = 0; i < 2; i++) { continue h; }
  return i;
}
console.log(labels());
