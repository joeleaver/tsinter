// `arguments.length` folds to the declared parameter count only where
// every invocation is a direct call tsc checks against that list: a
// method called on its class's own instances (never extracted, no
// heritage, no subclass, the instance never typed as anything else), a
// getter or setter, a constructor (subclass construction included), a
// function declaration only ever called (a `this:` parameter is not an
// argument), an immediately-invoked function expression. Anything else
// (a value, a callback, overloads, a wider signature) refuses (GH #22).
class C {
  m(a: number, b: number): number { return arguments.length + a + b; }
  get g(): number { return arguments.length; }
  set s(v: number) { console.log("set", arguments.length, v); }
}
const c = new C();
console.log(c.m(1, 2), c.g);
c.s = 9;
console.log(new C().m(3, 4));
class Base {
  constructor(x: number) { console.log("ctor", arguments.length, x); }
}
new Base(4);
class Derived extends Base {}
new Derived(1);
function f(a: string): number { return arguments.length + a.length; }
console.log(f("xy"));
function g(this: void, a: number): number { return arguments.length * 10 + a; }
console.log(g(1));
console.log((function (q: number) { return arguments.length + q; })(5));
