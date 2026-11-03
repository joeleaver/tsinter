// A runtime namespace in an import cycle whose top-level code runs while
// the cycle evaluates: Node reads the namespace object as undefined until
// its body ran (a TypeError at a member read), which is not modeled — the
// namespace refuses by name.
import { size } from "./a.ts";
console.log(size());
