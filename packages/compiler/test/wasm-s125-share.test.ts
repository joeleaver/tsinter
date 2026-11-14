/* S125 share-vs-copy (paperclip's slice A): values the program shares
 * between typed and dynamic code are one object, as in Node. A4: a DECLARED
 * function handed to dynamic code (commander's `.option(flag, desc,
 * collect, [])` collectors) runs its boxed instance, whose refused composite
 * parameters hold the dynamic argument itself; direct calls keep the typed
 * function. Compared with Node byte for byte on the wasm and wasm-native
 * lanes (u3u4-rows.ts). */
import { defineRows } from "./u3u4-rows.js";

const DEP = `export function option(fn, init) {
  const r1 = fn("a", init);
  const r2 = fn("b", r1);
  return { same: r1 === init, r2 };
}`;

defineRows("S125 share-vs-copy", [
  {
    id: "S125-A4-01 a declared collector pushing into its array parameter, handed to dynamic code: one array; a direct call stays typed",
    entry: "main.ts",
    files: { "dep.mjs": DEP },
    src: `import { option } from "./dep.mjs";
function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
const init: string[] = [];
const res = option(collect, init);
console.log(res.same, res.r2, init);
console.log(collect("direct", ["x"]));`,
  },
  {
    id: "S125-A4-02 commander's concat collector: a fresh array each call, the defaults array untouched",
    entry: "main.ts",
    files: { "dep.mjs": DEP },
    src: `import { option } from "./dep.mjs";
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
const defaults: string[] = [];
const res = option(collect, defaults);
console.log(res.same, res.r2, defaults);
console.log(collect("d", ["c"]).length);`,
  },
  {
    id: "S125-A1a-01 a helper returning its dynamic argument cast to a record (the adapters' asRecord): the caller writes through the one object",
    entry: "main.ts",
    src: `function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const parsed: unknown = JSON.parse('{"a":1,"n":{"b":2}}');
const r = asRecord(parsed);
if (r) r.extra = 3;
console.log(parsed, r === parsed, asRecord([1]), asRecord("s"));`,
  },
  {
    id: "S125-A1a-02 a plain cast-returning helper and an arrow: both callers share the dynamic object",
    entry: "main.ts",
    src: `function rec(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}
const recA = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const src: unknown = JSON.parse('{"m":1}');
const a = rec(src);
a.m = 2;
const b = recA(src);
b.k = "x";
console.log(src, a === b);`,
  },
]);
