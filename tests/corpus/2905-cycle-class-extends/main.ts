// Class hierarchies split across a cycle. main imports nodes.ts first, so
// base.ts evaluates while nodes.ts is still mid-evaluation: base.ts's top
// level cannot construct a Leaf yet (Node's TDZ), but nodes.ts's `class
// Leaf extends Base` runs after base.ts completed. Static fields and
// instanceof across the cycle.
import { Leaf, Wrapper, leafCount } from "./nodes.ts";
import { Base, make, early, created } from "./base.ts";
const w = new Wrapper(new Leaf(4));
console.log(w.describe(), make(5).describe(), leafCount(), early);
console.log(w instanceof Base, w.inner instanceof Base, created(), Leaf.kind);
