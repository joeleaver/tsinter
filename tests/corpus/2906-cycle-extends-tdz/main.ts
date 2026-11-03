// @exit: 1
// The cycle real class hierarchies trip over: main imports base.ts first,
// base.ts imports leaf.ts, and leaf.ts's `class Leaf extends Base` runs
// while base.ts is still mid-evaluation — Node's TDZ ReferenceError at the
// class definition, uncaught, before anything else prints.
import { Base } from "./base.ts";
import { Leaf } from "./leaf.ts";
console.log(new Leaf() instanceof Base);
