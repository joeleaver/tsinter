// @exit: 1
// Node loads a JSON module only with the `type: "json"` import attribute:
// without it the load phase refuses the program (ERR_IMPORT_ATTRIBUTE_MISSING)
// before any module evaluates — the attribute-carrying importer in other.ts
// does not help, every request is checked.
import { label } from "./other.ts";
import meta from "./meta.json";
console.log(label, meta.version);
