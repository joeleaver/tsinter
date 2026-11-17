// GH #248: reads of a key a closed JavaScript object lacks, through every
// operator that tests for it, in a statically compiled package (absentkeys,
// tests/fixtures/npm-static/node_modules). Byte-compared with Node.
import * as k from "absentkeys";

console.log("coalesce", k.coalesce("ab"));
console.log("or", k.or("ab"));
console.log("optional", k.optional("ab"));
console.log("destructure", k.destructure("ab"));
console.log("paramDestructure", k.paramDestructure("ab"));
console.log("localCoalesce", k.localCoalesce("ab"));
console.log("localOr", k.localOr("ab"));
console.log("kind", k.kind("ab"));
console.log("isUndef", k.isUndef("ab"));
console.log("isNull", k.isNull("ab"));
console.log("toNull", k.toNull("ab"));
console.log("asText", k.asText("ab"));
console.log("arith", k.arith("ab"));
console.log("concat", k.concat("ab"));
console.log("compound", k.compound("ab"));
console.log("widths", k.widths("abc"));
