// Chained getter/setter calls typed by the package's own .d.ts overloads
// (SEMANTICS.md S133): the program types against the declarations, while
// chainy's JS — whose INFERRED surface types name() as `string | Chainy` —
// compiles, and each chained result crosses into the declared `this`.
import { Chainy } from "chainy";

const c = new Chainy();
c.name("emulate").tag("cli");
console.log(c.render());
console.log(c.name());
