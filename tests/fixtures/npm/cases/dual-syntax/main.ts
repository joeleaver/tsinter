// @dynamic
// Node picks a dual package's entry from the IMPORTING SYNTAX (board
// #258): the import statement takes "import", require() takes
// "module-sync" (in require's condition set since require(esm) went
// unflagged, and listed first) — "browser" and the "module" field are
// never Node's. wrapdual is commander's shape: its "import" entry is a
// named-export wrapper over the CommonJS implementation. fakewrapesm has
// the wrapper SHAPE, but its "require" target is an ES module (Node 24
// syntax detection): the import side reads the module's default object,
// the require side its namespace.
import { side, weight } from "dualsync";
import { label, count } from "wrapdual";
import { reqSide, reqWeight, reqA } from "./lib.cjs";
import { a } from "fakewrapesm";

const s: string = side;
console.log(s, weight(10));
console.log(reqSide, reqWeight);
const fa: string = a;
console.log(fa, reqA);
console.log(label("x"), count);
