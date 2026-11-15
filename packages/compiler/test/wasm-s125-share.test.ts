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
  {
    id: "S125-RET-01 a plain function returning a dynamic array as a typed result: the caller's push reaches the original (was H-EXIT-02)",
    entry: "main.ts",
    src: `const o: any = { list: ["a"] };
function get(): string[] { return o.list; }
const r = get(); r.push("b");
console.log(o.list.length, r.length, r === o.list);`,
  },
  {
    id: "S125-RET-02 an unknown argument cast and returned as a typed array: one array (was H-UNK-01b)",
    entry: "main.ts",
    src: `const src: any = { xs: [1] };
function f(u: unknown): number[] { return (u as { xs: number[] }).xs; }
const t = f(src);
t.push(2);
console.log(src.xs.length, src.xs);`,
  },
  {
    id: "S125-RET-03 a spread of an arm value returned as a narrower type, whose caller reads undeclared keys, re-spreads and serializes it: the result's exact-fit copy stops by name at the return, never a record missing 'b' and 'z' (#148's case)",
    entry: "main.ts",
    fence: { text: /copied into typed storage it does not fit exactly/, stdout: "" },
    src: `type Wide = { a: number; b: number };
type Narrow = { a: number };
const shared: any = JSON.parse('{"a":1,"b":2,"z":9}');
function get(): unknown { return shared; }
function f(): Narrow {
  const w = get() as Wide;
  return { ...w };
}
const r = f();
console.log(r, Object.keys(r), (r as any).b, (r as any).z, { ...r }, JSON.stringify(r));
const r3 = f();
const r2 = { ...r3, extra: 1 };
console.log(r2, Object.keys(r2));`,
  },
  {
    id: "S125-W222-01 a cast of an unknown parameter returned as a narrower record, then printed, key-listed and serialized: every key, as Node (#222)",
    entry: "main.ts",
    src: `function f(v: unknown): { a: number } { return v as { a: number }; }
const r = f(JSON.parse('{"a":1,"b":2}'));
console.log(r, Object.keys(r), JSON.stringify(r));
const s = f(JSON.parse('{"a":3}'));
console.log(s.a + 1, s);`,
  },
  {
    id: "S125-W222-02 the same result stored into a class field (fields never take the arm): the copy stops by name where it would drop 'b', never a silent { a: 1 } (#222)",
    entry: "main.ts",
    fence: { text: /copied into typed storage it does not fit exactly/, stdout: "" },
    src: `function f(v: unknown): { a: number } { return v as { a: number }; }
class C { p: { a: number } = { a: 0 }; }
const c = new C();
c.p = f(JSON.parse('{"a":1,"b":2}'));
console.log(c.p);`,
  },
  {
    id: "S125-W222-03 a cast of an unknown value into a narrower record printed where it is made (#222)",
    entry: "main.ts",
    src: `function show(v: unknown): void { console.log(v as { a: number }); }
show(JSON.parse('{"a":1,"b":2}'));
const keep: unknown[] = [];
function hold(v: unknown): void { const x = v as { a: number }; keep.push(x.a); console.log(x.a); }
hold(JSON.parse('{"a":5,"z":1}'));
console.log(keep);`,
  },
]);
