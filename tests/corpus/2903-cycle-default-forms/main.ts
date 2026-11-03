// Default exports across an import cycle. A module's `default` is a binding
// of its own: `export default <identifier>` initializes it when the export
// statement runs (even when the target is already initialized, or is a
// hoisted function), `export default class {}` when the class definition
// completes, and `export default function` at link (hoisted). readers.ts
// evaluates while defaults.ts is still mid-evaluation.
import { report } from "./readers.ts";
import named, { helper } from "./defaults.ts";
console.log("main", named(2), helper(3));
console.log(report());
