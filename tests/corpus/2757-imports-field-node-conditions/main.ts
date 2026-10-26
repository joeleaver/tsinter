// A project's own package.json conditions resolve with NODE's condition
// set for the importing syntax (an import statement: node, import,
// module-sync, node-addons, default — first key in object order), never
// the bundler set {types, import, default}: "#impl" takes its "node"
// target ahead of "default" (chalk 5's #supports-color shape), "#nested"
// recurses into "import" and skips the non-Node "browser" key, and the
// self-name subpath "nodecond-corpus/side" takes "module-sync", which is
// listed before "import".
import { who as impl } from "#impl";
import { who as nested } from "#nested";
import { who as side } from "nodecond-corpus/side";

console.log(impl);
console.log(nested);
console.log(side);
