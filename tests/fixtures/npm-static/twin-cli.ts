// npm-static: a package whose declarations come from its @types twin (the
// js-yaml / semver shape). Auto mode judges it as the runtime package, the
// twin as its declared surface (SEMANTICS.md S133). Byte-compared with Node.
import { greet, sum, VERSION } from "twinned";

console.log(greet("world"), sum([1, 2, 3.5]), VERSION);
