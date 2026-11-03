// @exit: 1
// A read of a binding before its module ran, uncaught: Node's TDZ
// ReferenceError ends the program at b.ts's top level, before main.ts's
// own body (and a.ts's rest) ever runs.
import { a } from "./a.ts";
console.log("main", a);
