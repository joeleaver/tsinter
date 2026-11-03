// The barrel pattern real projects are built on: util/index.ts re-exports
// every util module (`export *`, `export { x } from`), and those modules
// import their siblings THROUGH the barrel — a cycle through a re-export
// facade. The top levels compute tables with calls into other members
// while the cycle evaluates; a read that runs too early is Node's TDZ.
import { formatAll, warn, LEVELS, warnings } from "./util/index.ts";
console.log(formatAll(["a", "b"]));
warn("late");
console.log(LEVELS.join("/"), warnings.length);
