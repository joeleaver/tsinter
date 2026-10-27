// Board #281 (review B3): a .ts file under a package.json "type":
// "commonjs" scope is CommonJS to Node (type stripping keeps import/export
// as written), so its import statement is Node's load-time SyntaxError. The
// build refuses by name — including with a top-level-await dependency,
// which used to crash the compiler.
import { v } from "./dep.ts";
console.log("main", v);
