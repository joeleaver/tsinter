// @exit: 1
// A JSON module exports only `default`: a NAMED import of one of its
// fields (the `import { version } from "./package.json"` spelling bundlers
// accept) is Node's link-time SyntaxError — the program never runs, so
// nothing prints, not even dep.ts's own line.
import "./dep.ts";
import { version } from "./meta.json" with { type: "json" };
console.log("version", version);
