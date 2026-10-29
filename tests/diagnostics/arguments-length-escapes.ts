// `arguments.length` reachable through a signature other than its own
// parameter list cannot fold to the declared count (GH #22): an overload
// with more parameters, a class method overload, a type parameter's
// constraint that declares more parameters, a trailing `void` parameter a
// caller may omit. Each refuses by name.
function over(a: number, b: number): number;
function over(a: number): number { return arguments.length + a * 0; }
console.log(over(1, 2));

class Overloaded {
  m(a: number, b: number): number;
  m(a: number): number { return arguments.length + a * 0; }
}
console.log(new Overloaded().m(1, 2));

class Narrow { m(a: number): number { return arguments.length + a * 0; } }
function viaConstraint<T extends { m(a: number, b: number): number }>(t: T): number { return t.m(1, 2); }
console.log(viaConstraint(new Narrow()));

function trailingVoid(a: number, b: void): number { return arguments.length + a * 0; }
console.log(trailingVoid(1));
