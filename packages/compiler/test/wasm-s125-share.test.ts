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


/** fb73ae21 review: a width copy widened into an `object`-typed slot (a
 * Set<object> element, a WeakMap<object, …> key, an `object` variable
 * compared by identity) — one object, as in Node. */
const IT = `export type A = { enabled?: boolean; n?: number };
export type W = A & { max?: number };`;
const IM = (body: string, imp: string): string => `${imp}
import type { A } from "./types.ts";
const o: A = { enabled: false, n: 1 };
${body}
console.log(o, JSON.stringify(o));`;
const IW = (code: string) => ({ "types.ts": IT, "w.ts": `import type { A, W } from "./types.ts";\n${code}` });
const IH = `type A = { enabled?: boolean; n?: number };\ntype W = A & { max?: number };\n`;

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
  { id: "S125-A5-01 (paperclip managed-agent) a hybrid into Record<string, unknown> passed onward, with Record writes elsewhere", entry: "main.ts", src: `type RemoteResource = { id?: string; [key: string]: unknown };
function record(v: unknown): Record<string, unknown> { return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {}; }
function modelOf(agent: Record<string, unknown>): unknown { return typeof agent.model === "string" ? agent.model : record(agent.model).id; }
function assertSafeManagedAgent(agent: Record<string, unknown>): void {
  if (agent.archived_at !== null || modelOf(agent) !== "m1") throw new Error("unsafe");
}
function findAgent(): RemoteResource { return { id: "a1", archived_at: null, model: "m1" }; }
const existing = findAgent();
assertSafeManagedAgent(existing);
const bag: Record<string, unknown> = {};
bag.k = 1;
console.log(existing.id, bag, existing);` },
  {
    id: "S125-A5-02 (paperclip ensureLocalSecretsKeyFile) the hybrid config into a Pick, passed onward, with writes to the Pick type", entry: "main.ts", src: `type Config = { secrets: { provider: string; keyFilePath: string }; server: { port: number }; [key: string]: unknown };
function keyPath(c: Pick<Config, "secrets">): string { return c.secrets.keyFilePath; }
function ensureKey(config: Pick<Config, "secrets">, configPath?: string): string {
  if (config.secrets.provider !== "local") return "skipped";
  return keyPath(config) + (configPath ?? "");
}
function readConfig(): Config { return { secrets: { provider: "local", keyFilePath: "/k" }, server: { port: 1 } }; }
const cfg = readConfig();
console.log(ensureKey(cfg, "/c"));
const p: Pick<Config, "secrets"> = { secrets: { provider: "x", keyFilePath: "" } };
p.secrets = { provider: "y", keyFilePath: "z" };
console.log(p);` },
  {
    id: "S125-A5-03 (paperclip summarizePlanCounts) an array of wider records into a literal-union element type, filtered", entry: "main.ts", src: `interface Plan { action: "create" | "update" | "skip"; slug: string; reason: string | null }
function summarize(plans: Array<{ action: "create" | "update" | "skip" }>, noun: string): string {
  return plans.filter((p) => p.action === "create").length + " " + noun + " of " + plans.length;
}
const plans: Plan[] = [{ action: "create", slug: "a", reason: null }, { action: "skip", slug: "b", reason: "x" }];
const ps: { action: "create" | "update" | "skip" }[] = [{ action: "update" }];
ps[0]!.action = "skip";
console.log(summarize(plans, "agent"), ps);
plans[0]!.action = "update";
console.log(summarize(plans, "agent"), plans);` },
  {
    id: "S125-A5-04 (paperclip toKeySet) an array of wider records into Array<{ key: string }>, mapped to its keys, with writes of the element type elsewhere", entry: "main.ts", src: `type Option = { key: string; label: string; hint?: string; files: string[] };
function toKeySet(items: Array<{ key: string }>): Set<string> {
  return new Set(items.map((item) => item.key));
}
const projects: Option[] = [{ key: "p1", label: "P1", files: ["a"] }, { key: "p2", label: "P2", hint: "h", files: [] }];
const keys = toKeySet(projects);
const ks: { key: string }[] = [{ key: "z" }];
ks[0]!.key = "y";
projects[0]!.key = "p9";
console.log(keys, ks, projects, toKeySet(projects));` },
  {
    id: "S125-A5-05 (review V04) a hybrid into Record<string, unknown> whose body casts the parameter keeps the copy, refused by name", entry: "main.ts", src: `type R = { id?: string; count: number; name: string; [k: string]: unknown };
function f(r: Record<string, unknown>) { (r as Record<string, unknown>).t = 2; }
const x: R = { count: 1, name: "n" };
f(x);
console.log(x);`, refused: /SC1090 .*COPY where JavaScript shares the object.*S125/ },
  {
    id: "S125-A5-06 (review V14) an array of hybrids whose forEach callback casts its element keeps the copy, refused by name", entry: "main.ts", src: `type P = { action: string; slug: string; [k: string]: unknown };
function f(xs: Array<{ action: string }>) { xs.forEach((x) => { const r = x as { action: string }; r.action = "u"; }); }
const ps: P[] = [{ action: "create", slug: "a" }];
f(ps);
console.log(ps);`, refused: /SC1090 .*COPY where JavaScript shares the object.*S125/ },
  {
    id: "S125-M-01 (paperclip's telemetry, two modules) a record handed to another module's function, which widens it into an intersection parameter of a third: no escape through the tagged module's call",
    entry: "main.ts",
    files: {
      "config.ts": `export type Overrides = { maxEvents?: number; backoff?: { base: number } };
export function resolveCaps(o?: Overrides): { maxEvents: number; base: number } {
  return { maxEvents: o?.maxEvents ?? 50, base: o?.backoff?.base ?? 1000 };
}
export function resolveConfig(fileConfig?: { enabled?: boolean } & Overrides): { enabled: boolean; maxEvents: number; base: number } {
  const caps = resolveCaps(fileConfig);
  if (fileConfig?.enabled === false) return { enabled: false, ...caps };
  return { enabled: true, ...caps };
}`,
      "telemetry.ts": `import { resolveConfig } from "./config.ts";
export function initTelemetry(fileConfig?: { enabled?: boolean }): string {
  const config = resolveConfig(fileConfig);
  return config.enabled ? "on " + config.maxEvents : "off";
}`,
    },
    src: `import { initTelemetry } from "./telemetry.ts";
const fc: { enabled?: boolean } = { enabled: false };
console.log(initTelemetry(fc), initTelemetry(undefined), initTelemetry({}));
const other: { enabled?: boolean } = { enabled: true };
console.log(initTelemetry(other), other);`,
  },
  { id: "S125-M-02 (review) refused by name: another module stashes the widened record in a Set<object>" , entry: "main.ts", files: IW(`export const seen = new Set<object>();\nexport function f(p: W): void { seen.add(p); }`), src: IM(`f(o); console.log(seen.has(o));`, `import { f, seen } from "./w.ts";`), refused: /COPY where JavaScript shares the object, and the program compares values of these types by identity/ },
  { id: "S125-M-03 (review) refused by name: the same in one module", entry: "main.ts", src: `type A = { enabled?: boolean; n?: number };\ntype W = A & { max?: number };\nconst seen = new Set<object>();\nfunction f(p: W): void { seen.add(p); }\nconst o: A = { enabled: false, n: 1 };\nf(o);\nconsole.log(seen.has(o), o);`, refused: /COPY where JavaScript shares the object, and the program compares values of these types by identity/ },
  { id: "S125-M-04 (review) refused by name: another module keys a WeakMap<object, number> by the widened record", entry: "main.ts", files: IW(`export const wm = new WeakMap<object, number>();\nexport function f(p: W): void { wm.set(p, 7); }`), src: `import { f, wm } from "./w.ts";\nimport type { A } from "./types.ts";\nconst o: A = { enabled: false, n: 1 };\nf(o);\nconsole.log(wm.get(o));`, refused: /COPY where JavaScript shares the object, and the program compares values of these types by identity/ },
  { id: "S125-M-05 (review) refused by name: another module keeps the widened record in an object-typed binding and compares by identity", entry: "main.ts", files: IW(`let last: object | null = null;\nexport function f(p: W): void { last = p; }\nexport function isLast(x: object): boolean { return last === x; }`), src: `import { f, isLast } from "./w.ts";\nimport type { A } from "./types.ts";\nconst o: A = { enabled: false, n: 1 };\nf(o);\nconsole.log(isLast(o));`, refused: /COPY where JavaScript shares the object, and the program compares values of these types by identity/ },
  { id: "S125-M-06 (review) refused by name: one module: WeakMap<object, number> keyed by the widened record", entry: "main.ts", src: IH + `const wm = new WeakMap<object, number>();\nfunction f(p: W): void { wm.set(p, 7); }\nconst o: A = { enabled: false, n: 1 };\nf(o);\nconsole.log(wm.get(o));`, refused: /COPY where JavaScript shares the object, and the program compares values of these types by identity/ },
  { id: "S125-M-07 (review) refused by name: one module: an object-typed binding compared by identity", entry: "main.ts", src: IH + `let last: object | null = null;\nfunction f(p: W): void { last = p; }\nfunction isLast(x: object): boolean { return last === x; }\nconst o: A = { enabled: false, n: 1 };\nf(o);\nconsole.log(isLast(o));`, refused: /COPY where JavaScript shares the object, and the program compares values of these types by identity/ },
  { id: "S125-M-08 (review, fast-string-truncated-width) options widened into another module's `{}`-inferred defaulted parameter, whose reads of keys `{}` lacks would fold to undefined: refused by name, never a silent default", entry: "main.ts",
    files: {
      "node_modules/w/package.json": `{"name":"w","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`,
      "node_modules/w/index.js": `export function measure(input, opts = {}) { const limit = opts.limit ?? Infinity; return Math.min(input.length, limit); }`,
      "node_modules/w/index.d.ts": `export declare function measure(input: string, opts?: { limit?: number }): number;`,
    },
    npmStatic: ["w"],
    src: `import { measure } from "w";\nconsole.log(measure("abcdef", { limit: 3 }), measure("ab"));`,
    refused: /COPY where JavaScript shares the object.*(prints, serializes, lists the keys|keeps only the type's declared fields)/ },
]);
