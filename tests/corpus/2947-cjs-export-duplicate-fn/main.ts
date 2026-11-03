// GH #111: an exported function declared twice is its last declaration.
import lib from "./lib.cjs";
import { greet, local } from "./lib.cjs";
console.log(greet(), local(), lib.greet(), lib.local());
