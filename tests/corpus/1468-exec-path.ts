// process.execPath: the compiled binary's own resolved absolute path —
// Node's is the node executable's (SEMANTICS.md S071, the
// argv[0]/argv[1] precedent), so the corpus asserts the CONTRACT the two
// worlds share (an absolute, non-empty, stable path), never the value.
import { isAbsolute, basename } from "node:path";

const p = process.execPath;
console.log(isAbsolute(p));
console.log(p.length > 0);
console.log(p === process.execPath);
console.log(basename(p).length > 0);
