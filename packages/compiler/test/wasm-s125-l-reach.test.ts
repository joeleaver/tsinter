/* S125-L (SEMANTICS.md S125 amendment (L)): two more ways a dynamic value
 * is shared where S125 (c) refused its copy. M4: an object literal passed
 * directly to a plain function, a field of which would copy a dynamic value,
 * is built as the dynamic object Node builds and the callee binds it on the
 * arm (dyn-arm-bag.ts). M5: an async function declaration whose every call
 * is awaited in place returns the promise of the dynamic value
 * (dyn-arm-async.ts). Fields and elements keep J4's refusal, a class
 * instance in a bag keeps its copy's refusal (Q1), and an async function
 * whose promise is used any other way keeps its typed result, the refusal
 * naming that use. Each row runs against Node on both lanes. */
import { defineRows } from "./u3u4-rows.js";

const PJ = (n: string): string => `{"name":"${n}","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`;

/** A zod-shaped package whose parse result is the value it keeps (lastCfg()
 * reads the last one back). */
const ZK: Record<string, string> = {
  "node_modules/zk/package.json": PJ("zk"),
  "node_modules/zk/index.js": `let last = null;
export function parseCfg(v) { last = v; return v; }
export function lastCfg() { return last; }`,
  "node_modules/zk/index.d.ts": `export type Cfg = { a: number[]; name: string };
export declare function parseCfg(v: unknown): Cfg;
export declare function lastCfg(): any;`,
};

defineRows("S125-L (M4): options bags on the dynamic arm", [
  { id: "S125-L-01 an options bag holding a package's result and a typed record: the callee writes through both, JSON and keys match Node, and the caller sees both writes", entry: "main.ts", npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
function readConfig(t: string): Cfg | null { return parseCfg(JSON.parse(t)); }
type Opts = { sourceConfig: Cfg; targetConfig: Cfg; label?: string; n: number };
function seed(o: Opts): string {
  o.sourceConfig.a.push(9);
  o.targetConfig.a.push(8);
  o.n = 5;
  o.label = "set";
  console.log(JSON.stringify(o), Object.keys(o));
  return o.sourceConfig.name;
}
function run(): void {
  const sourceConfig = readConfig('{"name":"s","a":[2],"extra":true}');
  if (!sourceConfig) throw new Error("no");
  const targetConfig: Cfg = { a: [1], name: "t" };
  const r = seed({ sourceConfig, targetConfig, label: undefined, n: 1 });
  console.log(r, sourceConfig, targetConfig, sourceConfig === lastCfg());
}
run();` },
  { id: "S125-L-02 the bag's values evaluate left to right, its keys keep the literal's order, `undefined`-valued keys are own keys, and a function field calls", entry: "main.ts", npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
function readConfig(t: string): Cfg | null { return parseCfg(JSON.parse(t)); }
type Opts = { b: number; src: Cfg; tags: string[]; extra?: string; c: string | undefined; cb: (n: number) => string; nested: { x: number } };
function logN(s: string, v: number): number { console.log("eval", s); return v; }
function logS(s: string, v: string | undefined): string | undefined { console.log("eval", s); return v; }
function take(o: Opts): void {
  console.log(Object.keys(o), "extra" in o, o.c === undefined, "c" in o);
  o.tags.push("t2");
  o.nested.x = 7;
  console.log(o.cb(3), o.src.name);

}
function run(): void {
  const src = readConfig('{"name":"s","a":[2]}')!;
  const tags = ["t1"];
  take({ b: logN("b", 1), src, tags, extra: undefined, c: logS("c", undefined), cb: (n) => \`cb\${n}\`, nested: { x: 1 } });
  console.log(tags, src === lastCfg());
}
run();` },
  { id: 'S125-L-03 JSON.stringify of the bag (an `undefined` key and a nested literal) inside the callee, and a write to the nested literal', entry: "main.ts", npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
function readConfig(t: string): Cfg | null { return parseCfg(JSON.parse(t)); }
type Opts = { b: number; src: Cfg; tags: string[]; extra?: string; c: string | undefined; nested: { x: number } };
function logN(s: string, v: number): number { console.log("eval", s); return v; }
function logS(s: string, v: string | undefined): string | undefined { console.log("eval", s); return v; }
function take(o: Opts): void {
  console.log(Object.keys(o), JSON.stringify(o), "extra" in o, o.c === undefined, "c" in o);
  o.tags.push("t2");
  o.nested.x = 7;
  console.log(o.src.name);

}
function run(): void {
  const src = readConfig('{"name":"s","a":[2]}')!;
  const tags = ["t1"];
  take({ b: logN("b", 1), src, tags, extra: undefined, c: logS("c", undefined), nested: { x: 1 } });
  console.log(tags, src === lastCfg());
}
run();` },
  { id: 'S125-L-04 an async callee awaited by its caller reads and writes the bag after an await', entry: "main.ts", npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
function readConfig(t: string): Cfg | null { return parseCfg(JSON.parse(t)); }
type Opts = { sourceConfig: Cfg; targetConfig: Cfg; mode: string };
async function seedAsync(o: Opts): Promise<number> {
  await Promise.resolve();
  o.sourceConfig.a.push(1);
  o.targetConfig.a.push(2);
  console.log(JSON.stringify(o));
  return o.sourceConfig.a.length;
}
async function run(): Promise<void> {
  const sourceConfig = readConfig('{"name":"s","a":[2],"x":1}');
  if (!sourceConfig) throw new Error("none");
  const targetConfig: Cfg = { a: [], name: "t" };
  const n = await seedAsync({ sourceConfig, targetConfig, mode: "m" });
  console.log(n, sourceConfig, targetConfig, lastCfg() === sourceConfig);
}
run().then(() => console.log("done"));` },
  { id: 'S125-L-05 a defaulted bag parameter forwarded to another plain function and read by a closure; the same callee called with a typed record and with no argument', entry: "main.ts", npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
type Opts = { src: Cfg; n?: number };
function inner(o: Opts, k: string): void { o.src.a.push(k.length); }
function take(o: Opts = { src: { a: [], name: "d" } }): number {
  inner(o, "abc");
  const later = (): number => o.src.a.length;
  console.log(o, Object.keys(o), JSON.stringify(o));
  return later();
}
function run(): void {
  let config: Cfg;
  config = parseCfg(JSON.parse('{"name":"s","a":[],"q":1}'));
  console.log(take({ src: config, n: undefined }));
  const typed: Opts = { src: { a: [7], name: "t" } };
  console.log(take(typed), typed);
  console.log(take());
  console.log(config, config === lastCfg());
}
run();` },
  { id: "S125-L-06 a bag with a class-instance field keeps the field's copy refused by name (decision Q1)", entry: "main.ts", npmStatic: ["zk"], files: ZK, refused: /checked into '\{ a: number\[\]; name: string \}'.*SEMANTICS\.md S125/,
    src: `import { parseCfg, type Cfg } from "zk";
class Box { v = 1; bump(): void { this.v++; } }
type Opts = { src: Cfg; box: Box };
function take(o: Opts): void { o.box.bump(); o.src.a.push(1); console.log(o.box.v, o.src); }
function run(): void {
  const src = parseCfg(JSON.parse('{"name":"s","a":[],"q":1}'));
  const box = new Box();
  take({ src, box });
  console.log(box.v);
}
run();` },
  { id: 'S125-L-07 a bag the callee stores into a module binding keeps that copy refused by name', entry: "main.ts", npmStatic: ["zk"], files: ZK, refused: /checked into 'null \| \{ n: number \| undefined; src: .*SEMANTICS\.md S125/,
    src: `import { parseCfg, type Cfg } from "zk";
type Opts = { src: Cfg; n?: number };
let kept: Opts | null = null;
function take(o: Opts = { src: { a: [], name: "d" } }): void { o.src.a.push(1); kept = o; console.log(o); }
function run(): void {
  let config: Cfg;
  config = parseCfg(JSON.parse('{"name":"s","a":[],"q":1}'));
  take({ src: config, n: undefined });
  take();
  console.log(config, kept);
}
run();` },
]);

defineRows("S125-L (M5): async results on the dynamic arm", [
  { id: "S125-L-08 an async function's `return value as Json` (M5): the caller's `await` holds the parsed object itself, a write is seen through the original, and a chained async function and a deferred `let` share it too", entry: "main.ts",
    src: `type Json = Record<string, unknown>;
const raw = '{"result":{"items":[1],"k":"v"},"ok":true}';
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad");
  return value as Json;
}
async function rpc(): Promise<Json> {
  const data = await safeJson(raw);
  if (!data.result || typeof data.result !== "object") throw new Error("no");
  return data.result as Json;
}
async function main(): Promise<void> {
  const d = await safeJson(raw);
  d.added = 1;
  console.log(d, d === seen, JSON.stringify(seen), Object.keys(d));
  const r = await rpc();
  (r.items as number[]).push(2);
  r.k2 = "w";
  console.log(r, JSON.stringify(r));
  let late: Json;
  late = await safeJson('{"z":1}');
  console.log(late, late === seen);
}
main();` },
  { id: "S125-L-09 a sync function's `return value as Json` over an `unknown` local takes the result arm (the cast is no conversion)", entry: "main.ts",
    src: `type Json = Record<string, unknown>;
let seen: unknown = null;
function safeJson(text: string): Json {
  const value: unknown = JSON.parse(text);
  seen = value;
  return value as Json;
}
const d = safeJson('{"a":1}');
d.added = 1;
console.log(d, d === seen);` },
  { id: 'S125-L-10 an async function returning null, a typed record or an awaited dynamic value: identity and writes on each path, and a rejection caught by the caller', entry: "main.ts",
    src: `type Json = Record<string, unknown>;
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object") throw new Error("bad: " + text);
  return value as Json;
}
type Info = { host: string; port: number };
const local: Info = { host: "h", port: 1 };
async function pick(n: number): Promise<Json | Info | null> {
  if (n === 0) return null;
  if (n === 1) return local;
  return await safeJson('{"host":"d","port":2,"x":true}');
}
async function main(): Promise<void> {
  for (const n of [0, 1, 2]) {
    const r = await pick(n);
    if (r) (r as { port: number }).port = 10 + n;
    console.log(r, r === local, r === seen);
  }
  console.log(local);
  try { await safeJson("null"); } catch (e) { console.log("caught", (e as Error).message); }
}
main();` },
  { id: 'S125-L-11 an exported async function called through an import alias in another module is on the arm there too', entry: "main.ts", files: { "lib.ts": `type Json = Record<string, unknown>;
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object") throw new Error("bad: " + text);
  return value as Json;
}
export async function rpc(m: string): Promise<Json> {
  const data = await safeJson('{"result":{"m":"' + m + '"}}');
  return data.result as Json;
}
export function lastSeen(): unknown { return seen; }` },
    src: `import { rpc as call, lastSeen } from "./lib.ts";
async function main(): Promise<void> {
  const r = await call("x");
  r.added = [1];
  console.log(r, (lastSeen() as { result: unknown }).result === r, JSON.stringify(lastSeen()));
}
main();` },
  { id: 'S125-L-12 an awaited result pushed into an array keeps its copy refused by name (J4)', entry: "main.ts", refused: /checked into '\{ \[key: string\]: unknown \}'.*SEMANTICS\.md S125/,
    src: `type Json = Record<string, unknown>;
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object") throw new Error("bad: " + text);
  return value as Json;
}
async function main(): Promise<void> {
  const d = await safeJson('{"a":1}');
  d.w = 1;
  const all: Json[] = [];
  all.push(await safeJson('{"b":2}'));
  all[0]!.z = 3;
  console.log(d, all, all[0] === seen);
}
main();` },
  { id: 'S125-L-13 an awaited result stored into a record field keeps its copy refused by name (J4)', entry: "main.ts", refused: /checked into 'null \| \{ \[key: string\]: unknown \}'.*SEMANTICS\.md S125/,
    src: `type Json = Record<string, unknown>;
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object") throw new Error("bad: " + text);
  return value as Json;
}
const holder: { r: Json | null } = { r: null };
async function main(): Promise<void> {
  const d = await safeJson('{"a":1}');
  d.w = 1;
  holder.r = await safeJson('{"b":2}');
  holder.r.z = 3;
  console.log(d, holder, holder.r === seen);
}
main();` },
  { id: 'S125-L-14 `.then` on the promise keeps the result typed: the return refuses by name and says which use kept the arm off', entry: "main.ts", refused: /SEMANTICS\.md S125\) \(the async function's result arm \(S125 \(L\)\) was not taken: 'safeJson' is used other than as `await safeJson\(…\)` \[line 13\]\)/,
    src: `type Json = Record<string, unknown>;
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object") throw new Error("bad: " + text);
  return value as Json;
}
async function main(): Promise<void> {
  const d = await safeJson('{"a":1}');
  d.w = 1;
  safeJson('{"b":2}').then((v) => { v.x = 1; console.log(v, v === seen); });
  console.log(d, d === seen);
}
main();` },
  { id: 'S125-L-15 `Promise.all([f(), f()])` keeps the result typed: the return refuses by name and says which use', entry: "main.ts", refused: /result arm \(S125 \(L\)\) was not taken: 'safeJson' is used other than as `await safeJson\(…\)` \[line 11\]/,
    src: `type Json = Record<string, unknown>;
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object") throw new Error("bad: " + text);
  return value as Json;
}
async function main(): Promise<void> {
  const [a, b] = await Promise.all([safeJson('{"a":1}'), safeJson('{"b":2}')]);
  a.w = 1;
  console.log(a, b, b === seen);
}
main();` },
  { id: "S125-L-16 the function stored as a record's value keeps the result typed: the return refuses by name and says which use", entry: "main.ts", refused: /result arm \(S125 \(L\)\) was not taken: 'safeJson' is used other than as `await safeJson\(…\)` \[line 10\]/,
    src: `type Json = Record<string, unknown>;
let seen: unknown = null;
async function safeJson(text: string): Promise<Json> {
  await Promise.resolve();
  const value: unknown = JSON.parse(text);
  seen = value;
  if (!value || typeof value !== "object") throw new Error("bad: " + text);
  return value as Json;
}
const deps = { load: safeJson };
async function main(): Promise<void> {
  const d = await safeJson('{"a":1}');
  d.w = 1;
  const e = await deps.load('{"q":1}');
  console.log(d, e, e === seen);
}
main();` },
]);
