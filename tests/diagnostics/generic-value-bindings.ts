// Generic function VALUE fences, named: every shape here keeps the generic
// signature alive where static monomorphization cannot follow.

// A reassigned binding cannot resolve statically — a later write could hold
// a structurally identical function with a different body.
let flip = <T>(x: T): T => x;
flip = <T>(x: T): T => x;
console.log(flip(1));

// An ALIAS binding registers its target (calls through it monomorphize),
// but a USE with no pinning context still keeps the generic signature —
// the value fences at the reference, not the binding.
const id = <T>(x: T): T => x;
const stored = id;
console.log(typeof stored);

// An alias of a REASSIGNED binding never registers: the target's own
// fence reports, and the alias falls back to the ordinary binding story.
const flipAlias = flip;
console.log(flipAlias(5));

// Declared inside a function: instances are module functions and cannot
// capture the enclosing frame.
function outer(): number {
  const inner = <T>(x: T): T => x;
  return inner(3);
}
console.log(outer());

// An ambient binding of generic function type now compiles to Node's exact
// ReferenceError at the access (the declare-erasure stance — no diagnostic
// here; the optional chain cannot guard the root's own throw).
declare const ambient: undefined | (<T>(f: (a: T) => T) => T);
console.log(ambient?.((n: number) => n) === undefined);

// A call whose RESULT is itself a generic function: the returned signature
// keeps its type parameters and would need the producing call's frame.
const curried = <T>(x: T) => <U>(y: U): string => `${x}|${y}`;
console.log(curried(1)("a"));

// A body-less `declare class` describes a dynamic value (vue-object-model.md):
// through an AMBIENT-ROOTED receiver the call compiles to Node's
// ReferenceError at the root, and through a parameter it dispatches on the
// value at run time, generic methods included (no diagnostic here).
declare class Amb {
  m<T>(x: T): T;
}
declare const amb: Amb;
console.log(amb.m(4));
function throughParam(a: Amb): void {
  console.log(a.m(4));
}
throughParam(amb);

// A generic lambda outside any monomorphizable home (an IIFE).
console.log((<T>(x: T): T => x)(5));
