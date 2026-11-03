// An import cycle whose modules run code while the cycle evaluates (Node's
// ESM order: depth-first postorder, a module already evaluating is a cache
// hit). b.ts runs first, while a.ts is still mid-evaluation: every read of
// one of a.ts's let/const/class/default bindings throws Node's TDZ
// ReferenceError, named as the READING module spells it (an import alias,
// a namespace member's export name, `default` through a namespace).
import { y, z, bump, count } from "./a.ts";
import { late, early } from "./b.ts";
console.log("main", y, new z().k, late());
console.log("early saw", early);
// Imported bindings are live: the exporter's own writes show through.
console.log("count", count);
bump();
bump();
console.log("count", count);
