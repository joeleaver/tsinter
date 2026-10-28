// `arguments.length` folds to the declared parameter count only where
// every invocation is a direct call tsc checks against that list: a
// method called on its class (never extracted, no heritage), a getter, a
// constructor (subclass construction included), a function declaration
// only ever called, an immediately-invoked function expression. A
// function also taken as a value is refused instead (GH #22).
class C {
  m(a: number, b: number): number { return arguments.length + a + b; }
  get g(): number { return arguments.length; }
  set s(v: number) { console.log("set", arguments.length, v); }
  constructor(x: number) { console.log("ctor", arguments.length, x); }
}
const c = new C(4);
console.log(c.m(1, 2), c.g);
c.s = 9;
function f(a: string): number { return arguments.length + a.length; }
console.log(f("xy"));
console.log((function (q: number) { return arguments.length + q; })(5));
class D extends C {}
new D(1);
