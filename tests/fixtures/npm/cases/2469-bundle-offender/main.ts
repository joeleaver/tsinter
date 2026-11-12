// A TYPE-ONLY name has no JS value an inferred surface could carry; under
// SEMANTICS.md S133 the program types against the package's declarations,
// where it is just a type, and the package compiles statically (coverage
// pins this; there is no differential run).
import { look, GhostShape } from "gtghost";

const g: GhostShape = { id: 4 };
console.log(look(), g.id);
