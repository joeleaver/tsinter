// Unions in the `string | object` family — every arm dyn-subsumable
// (scalars, units, JSON-safe records/arrays, plus the 'object'/'unknown'-
// flavored arm itself) — map to the checked-dynamic representation
// WHOLESALE: no per-arm tags, typeof/Array.isArray/unit guards dispatch
// natively on the dyn kind, scalar narrowings validate back out through
// dynCheck, and record/array arms ride as dyn data (the dynFrom deep-copy
// stance; SEMANTICS.md). Arms with real typed representations (classes,
// Maps/Sets, functions, promises) stay OUT of the collapse and keep their
// existing union homes and fences.

// The guard ladder over the whole family.
type Thing = string | number | boolean | object | null | undefined;
function classify(v: Thing): string {
  if (typeof v === "string") return `str:${v.toUpperCase()}`;
  if (typeof v === "number") return `num:${v + 1}`;
  if (typeof v === "boolean") return `bool:${!v}`;
  if (v === null) return "null";
  if (v === undefined) return "undef";
  if (Array.isArray(v)) return `arr:${v.length}`;
  return "obj";
}
console.log(classify("hi"));
console.log(classify(41));
console.log(classify(false));
console.log(classify(null));
console.log(classify(undefined));
console.log(classify([1, 2, 3]));
console.log(classify({ a: 1 }));

// The two-arm driver shape: `string | object` reads, both directions.
type Plugin = string | object;
const named: Plugin = "babel";
const inline: Plugin = { languages: ["js"], options: { semi: true } };
console.log(typeof named, typeof inline);
if (typeof named === "string") console.log("name:", named);
// The record arm rides as dyn data: JSON keeps its full width.
console.log(JSON.stringify(inline));

// `plugins[0]` — element reads on the collapsed array type: the whole
// array is one dyn value now (a dyn element has no static array slot),
// so length and index reads are dyn keyed reads.
const plugins: (string | object)[] = ["p1", { parser: "babel" }];
console.log(plugins.length, typeof plugins[0], typeof plugins[1]);
const first = plugins[0];
if (typeof first === "string") console.log("first:", first);

// The normalize-options option-table shape: defaults span the family.
interface OptionDef {
  name: string;
  default: string | number | boolean | object | null | undefined;
}
const table: OptionDef[] = [
  { name: "semi", default: true },
  { name: "printWidth", default: 80 },
  { name: "parser", default: "babel" },
  { name: "plugins", default: [] },
  { name: "overrides", default: { files: "*.ts" } },
  { name: "rangeEnd", default: null },
  { name: "cursorOffset", default: undefined },
];
for (const def of table) {
  console.log(def.name, classify(def.default));
}

// Scalar arms keep value semantics through the checked-dynamic tree: === by value,
// String() JS-exact, checked casts extract.
const s1: Plugin = "hello";
const s2: Plugin = "hello";
console.log(s1 === s2, s1 === "hello", String(s1));
console.log((s1 as string).length);

// Unit-armed spellings collapse too: `object | null`, `{} | null |
// undefined` (the lib's Object flavors ride the same rule).
const maybe: object | null = null;
console.log(maybe === null);
type MyType = {} | null | undefined;
const box: MyType = { tag: "t" };
console.log(typeof box, box !== null);
