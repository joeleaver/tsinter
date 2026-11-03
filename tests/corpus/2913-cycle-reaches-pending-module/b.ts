import { fn, fnBox, fnItems } from "./a.ts";
import { probe } from "./probe.ts";
console.log("b", probe(fn));
console.log("b", probe(fnBox));
console.log("b", probe(fnItems));
