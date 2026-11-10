/* Known findings: buckets matching an entry here are registered
 * divergences (SEMANTICS.md S###) or already-filed GitHub issues, and the
 * report marks them so instead of "new?". Each entry is a predicate over
 * a bucket { res, source, feats } (res.diff.nature: order / missing /
 * extra / value); keep the test narrow, and name the entry by what it
 * cites. Add one when a campaign's finding is filed or registered.
 *
 * The generator already steers clear of most of these unless run with
 * --include-known (gen.mjs, `includeKnown`); these catch the rest. */
const div = (b) => b.res.cls === "divergence";
const nat = (b) => b.res.diff?.nature;
const has = (b, ...fs) => fs.every((f) => b.feats.includes(f));

export const KNOWN = [
  {
    id: "S041 (record shapes render their declared order; GH #132's amendment covers shapes with an optional field)",
    test: (b) => div(b) && nat(b) === "order" && !has(b, "parse()") && !has(b, "obj-spread") && !has(b, "any") && !/\?:/.test(b.source),
  },
  {
    id: "S041 amendment + S115 (a checked conversion from a dynamic value takes the declared order and drops undeclared keys)",
    test: (b) => div(b) && (nat(b) === "order" || nat(b) === "missing") && has(b, "parse()") && (has(b, "as") || has(b, "any")),
  },
  {
    id: "S123 / GH #106 (an object spread's keys take the shape's order)",
    test: (b) => div(b) && nat(b) === "order" && has(b, "obj-spread"),
  },
  {
    id: "GH #148 (a spread into a narrower annotated type drops the extra keys)",
    test: (b) => div(b) && nat(b) === "missing" && has(b, "obj-spread") && /const \w+: N\d+ = \{ \.\.\./.test(b.source),
  },
  {
    id: "S022 (a non-Error object payload crossing into unknown becomes an empty object)",
    test: (b) => div(b) && has(b, "throw", "try") && /throw (\{|\[|new Map|new Set)/.test(b.source),
  },
];

export function known(bucket) {
  const hits = KNOWN.filter((k) => {
    try {
      return k.test(bucket);
    } catch {
      return false;
    }
  }).map((k) => k.id);
  return hits.length > 0 ? hits.join("; ") : null;
}
