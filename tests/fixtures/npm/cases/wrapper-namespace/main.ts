// @dynamic
// wrapdual's ESM entry is a named-export wrapper over its CommonJS
// implementation: Node's namespace for an import statement is the
// WRAPPER's (count, label — no default, no hidden). Under --npm-static
// the CJS-first substitution must not quietly hand the CJS module's
// namespace here — the package falls back to the island instead.
import * as wd from "wrapdual";

console.log(wd.count, wd.label("y"));
