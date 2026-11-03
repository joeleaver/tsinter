// Mutual recursion across a cycle whose top level CALLS into it while the
// cycle evaluates: b.ts evaluates first (a.ts imports it), then a.ts's
// top-level `aye(2)` recurses through b.ts's hoisted function, so Node
// prints "a-init 2" and then 5.
import { aye } from "./a.ts";
console.log(aye(5));
