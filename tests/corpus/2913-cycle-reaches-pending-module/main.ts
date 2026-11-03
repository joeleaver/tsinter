// Cycle code reaching a module OUTSIDE the cycle that has not run yet:
// main → a → b → (a: a cache hit), and b's top level calls a's function,
// which calls into util.ts — a's import that Node evaluates only after b.
// util's const, class and array are all still in their TDZ then.
import { fn } from "./a.ts";
console.log("main", fn());
