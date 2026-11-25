// Tuple + ref-element-array fences — what stays OUT of the new surface and
// why: dynamic tuple indexing (heterogeneous positions have no single
// element type), optional/rest tuple elements (no fixed shape), for-of over
// tuples, spread into tuple literals, join on ref-element arrays (JS would
// recursively toString), and Map-element arrays (hashed storage has no
// element representation in the array runtime).
const pair: [string, number] = ["a", 1];

// Dynamic index: reads and writes both need the literal-index shape.
let i = 0;
console.log(pair[i]);
pair[i] = "b";

// Optional and rest elements have no fixed arity/shape.
const opt: [string, number?] = ["x"];
const rest: [string, ...number[]] = ["y", 1, 2];

// Heterogeneous tuples ITERATE now (positions snapshot into the union),
// and the union-typed loop variable PRINTS (per-arm console rendering).
for (const part of pair) {
  console.log(part);
}

// Spread has no fixed positions inside a tuple literal.
const copy: [string, number] = [...pair];

// join on ref-element arrays: JS would recursively toString — dishonest.
const recs: { id: number }[] = [{ id: 1 }];
console.log(recs.join(","));
const tuples: [string, string][] = [["k", "v"]];
console.log(tuples.join(";"));

// Map elements stay out entirely (function elements compile — the REF
// element kind).
const maps: Map<string, number>[] = [];
