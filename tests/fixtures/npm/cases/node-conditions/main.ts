// @dynamic
// Node's own condition semantics on the import side (board #258 review):
//   - fakewrapesm's "import" entry has the commander wrapper SHAPE, but its
//     "require" target is an ES module (no "type", ESM syntax — Node 24's
//     syntax detection), so the wrapper destructures that module's DEFAULT
//     object: Node prints "default-prop-a", never the named "a";
//   - syncfirst lists "module-sync" before "import": an import statement
//     takes "module-sync";
//   - impalias's own "imports" alias #impl takes its "node" target ahead of
//     "default" (chalk 5's #supports-color shape).
import { a } from "fakewrapesm";
import { side } from "syncfirst";
import { who } from "impalias";

const s: string = a;
console.log("fakewrapesm:", s);
console.log("syncfirst:", side);
console.log("impalias:", who);
