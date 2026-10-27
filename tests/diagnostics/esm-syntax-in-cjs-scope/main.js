// Board #281: a .js file under a package.json "type": "commonjs" scope is
// CommonJS to Node whatever its syntax, so an import statement is Node's
// load-time SyntaxError ("Cannot use import statement outside a module").
// The build refuses by name instead of running a program Node never runs.
import os from "node:os";

console.log(typeof os.EOL);
