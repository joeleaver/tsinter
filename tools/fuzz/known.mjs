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
    test: (b) => div(b) && nat(b) === "order" && !has(b, "parse()") && !has(b, "obj-spread") && !/\?:/.test(b.source),
  },
  {
    id: "S041 amendment + S115 (a checked conversion from a dynamic value takes the declared order and drops undeclared keys)",
    test: (b) => div(b) && (nat(b) === "order" || nat(b) === "missing") && has(b, "parse()") && (has(b, "as") || has(b, "any")),
  },
  {
    id: "S041 amendment (a structuredClone round trip takes the declared order)",
    test: (b) => div(b) && nat(b) === "order" && has(b, "structuredClone()"),
  },
  {
    id: "S018 ('<x> is not a function' names the callee's source text, or 'value')",
    test: (b) => div(b) && / is not a function/.test(b.res.diff?.node ?? "") && / is not a function/.test(b.res.diff?.got ?? ""),
  },
  {
    id: "S123 / GH #106 (an object spread's keys take the shape's order)",
    test: (b) => div(b) && nat(b) === "order" && has(b, "obj-spread"),
  },
  {
    // Since af11881e such a spread refuses by name; kept for older trees.
    id: "GH #148 (a spread into a narrower annotated type drops the extra keys)",
    test: (b) => div(b) && nat(b) === "missing" && has(b, "obj-spread") && /const \w+: N\d+ = \{ \.\.\./.test(b.source),
  },
  // Filed from the first nico-top campaign (seeds 100000..106799, 2026-11-10).
  {
    id: "GH #155 (throw undefined / throw null: SC9001 bare unitLit outside a unionWrap)",
    test: (b) => b.res.cls === "crash" && b.res.kind === "ice" && /bare unitLit '(undefined|null)'/.test(b.res.msg ?? ""),
  },
  {
    id: "GH #156 (an async function inspects as [Function: …], Node [AsyncFunction: …])",
    test: (b) => div(b) && /\[AsyncFunction/.test(b.res.diff?.node ?? "") && !/\[AsyncFunction/.test(b.res.diff?.got ?? ""),
  },
  {
    id: "GH #157 (Object.assign({}, rec) drops an explicit-undefined optional field and the record's own order)",
    test: (b) => div(b) && b.lang !== "js" && (nat(b) === "missing" || nat(b) === "order") && /Object\.assign\(\{\}, /.test(b.source) && /\?:/.test(b.source),
  },
  {
    id: "GH #158 (keys a literal holds beyond its declared type are lost under keys/values/structuredClone)",
    test: (b) => div(b) && b.lang !== "js" && (nat(b) === "missing" || nat(b) === "value") && /(interface \w+ \{\s*\}|type \w+ = \{\s*\};)/.test(b.source),
  },
  {
    id: "GH #159 (JS: a key added by assignment is lost in spread/print/JSON)",
    test: (b) => div(b) && b.lang === "js" && nat(b) === "missing" && /^\s*\w+(\.\w+|\["[^"]*"\]) = (?!undefined)/m.test(b.source) && !/: undefined/.test(b.source),
  },
  {
    id: "GH #160 (JS: a property explicitly holding undefined is lost as an own key)",
    test: (b) => div(b) && b.lang === "js" && (nat(b) === "missing" || nat(b) === "value") && /(: undefined|= undefined;)/.test(b.source),
  },
  {
    id: "GH #161 (JS: delete of a key holding undefined leaves the key)",
    test: (b) => div(b) && b.lang === "js" && nat(b) === "extra" && has(b, "delete"),
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
