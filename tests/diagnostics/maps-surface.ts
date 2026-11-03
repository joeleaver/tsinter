// The Map surface beyond the lowering: the lib declares all of this, so
// it TYPECHECKS (seeded constructors, iterators, 3-param forEach
// callbacks) — each use is fenced per site by the lowerer, never truncated.
const m = new Map<string, number>();

// Entry-seeded construction lowers for an array literal of pair literals
// at the construction site and for [K, V][]-typed tuple-array values;
// other seeds (another Map, general iterables) stay fenced.
const seeded = new Map(m);

// keys()/values()/entries() lower ONLY where an array spread drains them
// on the spot ([...m.keys()]); a stored iterator would need the protocol.
const ks = m.keys();
const vs = m.values();
const es = m.entries();

// Spreading the MAP itself (no [Symbol.iterator] lowering) stays fenced —
// for-of over the map and spreads of its keys()/values()/entries() are the
// lowered iteration forms.
const spread = [...m];

// The forEach callback receives (value, key) — no third map parameter.
m.forEach((v, k, theMap) => console.log(k, v));
