// An async cycle (a member awaits at top level) whose top-level code calls
// into the cycle while it evaluates: async cycle evaluation is modeled only
// for declaration-only clusters, so the cycle keeps its fence, naming both
// the await and the call.
import { total } from "./a.ts";
console.log(await total());
