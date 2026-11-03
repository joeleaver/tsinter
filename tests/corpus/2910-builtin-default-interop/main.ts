// Default imports of builtins in a TypeScript project whose tsconfig never
// spells esModuleInterop: `module: "nodenext"` IMPLIES it (as tsc computes
// the effective flag), so `import path from "node:path"` is the project's
// own legal dialect — and Node binds the module object as the default.
import path from "node:path";
import os from "os";
import util, { format } from "node:util";
console.log(path.basename("/srv/app/index.ts"), path.extname("a.json"));
console.log(typeof os.EOL, os.EOL === "\n" || os.EOL === "\r\n");
console.log(util.format("%s=%d", "n", 4), format("%s", "same"));
