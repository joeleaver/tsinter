// The island-backed ambient surface (number methods, string-pattern
// replace/at, the Number statics, ...) typechecks against real static
// types but executes in the embedded engine: in a static build every use
// site is its own SC2012 naming the flag — never an ICE, never a link
// error. (All of Math — SEMANTICS.md S100 — .split(string), the trim/pad
// variants, parseInt, isNaN, and the global parseFloat/isFinite over
// exactly-typed arguments compile statically now and no longer appear
// here.)
const price = (19.99).toPrecision(4);
const swapped = "banana".replace("an", "AN");
const ch = "hello".at(0);
const n = Number.parseFloat("3.14");
