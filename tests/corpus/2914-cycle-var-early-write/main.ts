// A `var` with no initializer stores nothing when its declaration runs: a
// write that cycle code made before a.ts ran (b.ts calls setV during a's
// imports) survives, and reads before and after the declaration see it.
import { v, setV } from "./a.ts";
console.log("main", v, setV());
