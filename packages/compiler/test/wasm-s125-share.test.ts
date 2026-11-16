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

/** The A4 extension's dynamic code: commander's option collector and an
 * async action runner, plus identity probes. */
const DEP2 = `export function option(fn, init) {
  const r1 = fn("a", init);
  const r2 = fn("b", r1);
  return { same: r1 === init, r2 };
}
let saved = null;
export function keep(fn) { saved = fn; return fn; }
export function isKept(fn) { return saved === fn; }
export function same(a, b) { return a === b; }
export async function action(fn, opts) {
  await fn(opts);
  return opts;
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
    id: "S125-RET-03 a spread of an arm value returned as a narrower type, whose caller reads undeclared keys, re-spreads and serializes it: GH #148's spread refusal by name, never a record missing 'b' and 'z'",
    entry: "main.ts",
    refused: /an object spread of a dynamic value into/,
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
  {
    id: "S125-RV-01 (delta review) a fresh spread of an arm value returned as a narrower type is a new object: reading its declared key runs as Node",
    entry: "main.ts",
    src: `type Wide = { a: number; b: number };
const shared: any = JSON.parse('{"a":1,"b":2,"z":9}');
function f(): { a: number } { const w = shared as Wide; return { ...w }; }
console.log(f().a);`,
  },
  {
    id: "S125-RV-02 (delta review) a cast pushed into a typed array, the array printed: the element copy stops by name where it would drop 'b', never a silent { a: 1 } (#222)",
    entry: "main.ts",
    fence: { text: /does not have exactly its typed slot's shape/, stdout: "" },
    src: `type N = { a: number };
const src: unknown = JSON.parse('{"a":1,"b":2}');
const arr: N[] = [];
arr.push(src as N);
console.log(arr);`,
  },
  {
    id: "S125-A2-01 a class instance into an interface parameter with a method (paperclip's API client into fetchLog): the body writes and calls through the caller's object, which is identical (===) to the caller's instance",
    entry: "main.ts",
    src: `interface Api { base: string; get(path: string): string }
class Client implements Api {
  base = "http://x";
  calls = 0;
  get(path: string): string { this.calls++; return this.base + path; }
}
function fetchLog(api: Api, p: string): string {
  api.base = api.base + "/v1";
  return api.get(p) + " " + String(api === ctx.api);
}
const ctx = { api: new Client() };
console.log(fetchLog(ctx.api, "/log"), ctx.api.calls, ctx.api.base, ctx.api instanceof Client);`,
  },
  {
    id: "S125-B-01 printing an index-signature record with declared fields: declared fields, then the added keys (SEMANTICS.md S031's order)",
    entry: "main.ts",
    src: `type Rec = { id: string | undefined; [key: string]: unknown };
function assertSafe(r: Rec): void {
  if (r.id === undefined) throw new Error("no id");
  r.checked = true;
}
const existing: Rec = { id: "a1", name: "n" };
assertSafe(existing);
console.log(existing);
const e: Rec = { id: undefined };
console.log(e, { id: "x", tags: ["a"], n: { deep: 1 } } as Rec);`,
  },
  {
    id: "S125-B-10 (main gate) a hybrid record's added array-index keys print before its declared fields, ascending, as Node orders integer keys",
    entry: "main.ts",
    src: `type Odd = { a?: boolean; [k: string]: boolean | string | undefined };
const nums: Odd = { a: false, "2": "two", z: "zz", "1": true };
console.log(nums);
nums["0"] = "zero";
nums["4294967295"] = "not an index";
nums["01"] = "not canonical";
nums["7"] = true;
console.log(nums);
const two: Odd = { a: true, b: "x", c: false };
console.log(two);`,
  },
  {
    id: "S125-B-02 (review) a hybrid record holding itself under an added key prints Node's <ref *1> / [Circular *1]",
    entry: "main.ts",
    src: `type R = { id: string; [k: string]: unknown };
const r: R = { id: "a" };
r.self = r;
console.log(r);
const q: R = { id: "q" };
q.l = [q, 2];
q.i = { b: q };
console.log(q);`,
  },
  {
    id: "S125-B-03 (review) a plain Record<string, unknown> holding itself prints Node's circular markers",
    entry: "main.ts",
    src: `const r: Record<string, unknown> = { a: 1 };
r.self = r;
r.list = [r, 2];
console.log(r);
const e: Record<string, unknown> = {};
e.self = e;
console.log(e);`,
  },
  {
    id: "S125-B-04 (review) a hybrid literal that sets an added key before a declared field prints in Node's insertion order (GH #227)",
    entry: "main.ts",
    src: `type R = { id: string; [k: string]: unknown };
const r: R = { name: "n", id: "a1" };
console.log(r);`,
  },
  {
    id: "S125-B-05 (review) a hybrid whose optional declared field is assigned after an added key prints in Node's order (GH #227)",
    entry: "main.ts",
    src: `type R = { id: string; tag?: string; [k: string]: unknown };
const r: R = { id: "a" };
r.extra = 1;
r.tag = "t";
console.log(r);`,
  },
  {
    id: "S125-B-06 (review) a hybrid checked out of JSON (keys in the source's order) prints in Node's order (GH #227)",
    entry: "main.ts",
    src: `type R = { id: string; [k: string]: unknown };
function load(s: string): R { return JSON.parse(s) as R; }
const r = load('{"name":"n","id":"a1"}');
console.log(r);`,
  },
  {
    id: "S125-B-07 (re-check) a computed-key write on a hybrid with an optional declared field may set it after an added key: prints in Node's order (GH #227)",
    entry: "main.ts",
    src: `type R = { id?: string; [k: string]: unknown };
const r: R = {};
r.x = 1;
const k = ["i", "d"].join("");
r[k] = "a";
console.log(r);`,
  },
  {
    id: "S125-B-08 (re-check) keys from data written into a hybrid with an optional declared field: prints in Node's order (GH #227)",
    entry: "main.ts",
    src: `type R = { id?: string; [k: string]: unknown };
const r: R = {};
for (const k of JSON.parse('["x","id"]') as string[]) r[k] = k;
console.log(r);`,
  },
  {
    id: "S125-B-09 (re-check) an explicit undefined written after an added key in a literal is a key: printed in Node's order (GH #227; required and optional declared fields)",
    entry: "main.ts",
    src: `type R = { id: string | undefined; [k: string]: unknown };
const r: R = { name: "n", id: undefined };
console.log(r);
type Q = { id?: string; [k: string]: unknown };
const q: Q = { name: "n", id: undefined };
console.log(q);`,
  },
  {
    id: "S125-A4-03 (A4 extension) deepseek's const-bound arrow collector with a defaulted array parameter, handed to dynamic code: the default applies, the result shares",
    entry: "main.ts",
    files: { "dep.mjs": DEP2 },
    src: `import { option } from "./dep.mjs";
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
const res = option(collect, ["x"]);
console.log(res.same, res.r2);
const r0 = option(collect, undefined);
console.log(r0.r2, collect("direct"));`,
  },
  {
    id: "S125-A4-04 (A4 extension) an async arrow action writing through its options parameter (commander's .action): the caller's object sees the write",
    entry: "main.ts",
    files: { "dep.mjs": DEP2 },
    src: `import { action } from "./dep.mjs";
interface Opts { config?: string; json?: boolean }
async function main(): Promise<void> {
  const out = await action(async (opts: Opts) => { opts.json = true; console.log("act", opts.config); }, { config: "c" });
  console.log(out);
}
main();`,
  },
  {
    id: "S125-A4-05 (A4 extension) an async DECLARED action handed to dynamic code: its boxed instance shares the options object; a direct call stays typed",
    entry: "main.ts",
    files: { "dep.mjs": DEP2 },
    src: `import { action } from "./dep.mjs";
interface Opts { config?: string; json?: boolean }
async function doctor(opts: Opts): Promise<void> { opts.json = true; console.log("doc", opts.config); }
async function main(): Promise<void> {
  const out = await action(doctor, { config: "c" });
  console.log(out);
  const mine: Opts = { config: "d" };
  await doctor(mine);
  console.log(mine);
}
main();`,
  },
  {
    id: "S125-A4-06 (A4 extension) a const-bound function expression pushing into its array parameter, handed to dynamic code: one array",
    entry: "main.ts",
    files: { "dep.mjs": DEP2 },
    src: `import { option } from "./dep.mjs";
const push = function (value: string, previous: string[]): string[] { previous.push(value); return previous; };
const init: string[] = [];
const res = option(push, init);
console.log(res.same, res.r2, init);`,
  },
  {
    id: "S125-A4-07 (A4 extension) a const-bound collector crossing twice is one function to dynamic code (identity kept), and its direct call stays typed",
    entry: "main.ts",
    files: { "dep.mjs": DEP2 },
    src: `import { keep, isKept, same, option } from "./dep.mjs";
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
keep(collect);
console.log(isKept(collect), same(collect, collect));
const r = option(collect, ["x"]);
console.log(r.r2, collect("direct"));`,
  },
]);
