/* S125-K (SEMANTICS.md S125 amendment (K)): the dynamic arm's reach — five
 * more slots hold the dynamic value itself where S125 (c) refuses its copy:
 * a `let` assigned only by plain `=` statements, an operand of `?:`/`??`/
 * `||`/`&&` inside a contained slot, a name of a `const` destructuring
 * pattern, a module global initialized by a package's call, and a
 * defaulted parameter of a plain function. Each row prints identity,
 * writes through both sides, JSON and key order against Node; the forms
 * left out refuse by name. */
import { defineRows } from "./u3u4-rows.js";

const PJ = (n: string): string => `{"name":"${n}","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`;

/** A zod/drizzle-shaped package whose results are the values it keeps
 * (lastCfg() reads the last one back). */
const ZK: Record<string, string> = {
  "node_modules/zk/package.json": PJ("zk"),
  "node_modules/zk/index.js": `let last = null;
export function parseCfg(v) { last = v; return v; }
export function lastCfg() { return last; }
class ZObj { constructor(shape) { this.shape = shape; } parse(v) { last = { ...v, parsed: true }; return last; } }
export function object(shape) { return new ZObj(shape); }
export function makeRows() { const r = JSON.parse('[{"n":1,"tags":["a"]},{"n":2,"tags":["x"]}]'); last = r; return r; }
export function selectP() { const r = JSON.parse('[{"n":1,"tags":["a"]},{"n":2,"tags":["x"]}]'); last = r; return Promise.resolve(r); }`,
  "node_modules/zk/index.d.ts": `export type Cfg = { a: number[]; name: string };
export declare function parseCfg(v: unknown): Cfg;
export declare function lastCfg(): any;
export interface ZObj<T> { parse(v: unknown): T }
export declare function object<T>(shape: T): ZObj<{ [K in keyof T]: string }>;
export declare function makeRows(): { n: number; tags: string[] }[];
export declare function selectP(): Promise<{ n: number; tags: string[] }[]>;`,
};

const READ_CONFIG = `import { parseCfg, lastCfg, type Cfg } from "zk";
function readConfig(t: string): Cfg | null { return parseCfg(JSON.parse(t)); }`;

defineRows("S125-K: the dynamic arm's reach", [
  { id: "S125-K-01 a deferred `let` assigned a package's result (r4) holds it: writes through either side, a closure's write, JSON and key order match Node", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `${READ_CONFIG}
function run(): void {
  let config: Cfg | null = null;
  try {
    config = readConfig('{"a":[1],"name":"n","extra":true}')!;
  } catch (e) { console.log("caught"); }
  const reset = (): void => { config = null; };
  config!.a.push(2);
  lastCfg().a.push(3);
  console.log(config, config === lastCfg(), JSON.stringify(config), Object.keys(config!));
  let other: Cfg | null | undefined;
  other = readConfig('{"name":"m","a":[]}');
  console.log(other, other === lastCfg());
  reset();
  console.log(config);
}
run();` },
  { id: "S125-K-02 a deferred `let` assigned a package's result on one path and a typed object on the other shares each", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
const local: Cfg = { a: [5], name: "local" };
function run(n: number): void {
  let cfg: Cfg;
  if (n > 0) cfg = parseCfg(JSON.parse('{"a":[1],"name":"p","extra":1}'));
  else cfg = local;
  cfg.a.push(n);
  const keep = (): Cfg => cfg;
  console.log(cfg, keep() === cfg, n > 0 ? cfg === lastCfg() : cfg === local, JSON.stringify(cfg), local);
}
run(1);
run(0);` },
  { id: "S125-K-03 `?:` arms (p3): a cast of an `unknown` member beside a fresh literal, and two package results, hold the value itself", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
function run(payload: Record<string, unknown>) {
  const args = Array.isArray(payload.commandArgs) ? (payload.commandArgs as string[]) : [];
  args.push("z");
  console.log(args, payload.commandArgs, args === payload.commandArgs);
  const m = typeof payload.message === "object" && payload.message !== null ? (payload.message as Record<string, unknown>) : {};
  m.k2 = 1;
  console.log(m, payload);
}
run(JSON.parse('{"commandArgs":["x","y"],"message":{"k":1}}'));
run({ commandArgs: 5 });
function pick(flag: boolean, t: string): Cfg {
  const c = flag ? parseCfg(JSON.parse(t)) : parseCfg({ a: [], name: "d" });
  c.a.push(7);
  return c;
}
const x = pick(true, '{"a":[1],"name":"n","z":0}');
console.log(x, x === lastCfg(), JSON.stringify(x));
const y = pick(false, "");
console.log(y, y === lastCfg());` },
  { id: "S125-K-04 `??`, `||` and `&&` operands of a contained slot (a binding, a plain function's result) hold the value itself", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
const raw: any = JSON.parse('{"list":[1,2]}');
const xs = (raw.list as number[] | undefined) ?? [];
xs.push(3);
const ys = (raw.none as number[] | undefined) ?? [];
ys.push(4);
const zs = (raw.list as number[]) || [];
const ws = raw.list && (raw.list as number[]);
console.log(xs, raw.list, ys, zs === raw.list, ws === raw.list);
function load(t: string | null): Cfg | null {
  return t === null ? null : parseCfg(JSON.parse(t));
}
const c = load('{"a":[1],"name":"n","q":true}') ?? { a: [], name: "fallback" };
c.a.push(2);
console.log(c, c === lastCfg(), load(null), JSON.stringify(c));` },
  { id: "S125-K-05 names of `const` array and object patterns over a package's rows (drizzle's `const [counts] = await db.select()`) are the rows themselves", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { makeRows, selectP, lastCfg } from "zk";
async function main(): Promise<void> {
  const [first] = await selectP();
  first.tags.push("b");
  console.log(first, lastCfg()[0], first === lastCfg()[0], JSON.stringify(first));
  const [a, b] = makeRows();
  b.tags.push("c");
  const { n, tags } = a;
  tags.push("t");
  const [{ tags: t0 }] = lastCfg() as { n: number; tags: string[] }[];
  console.log(a === lastCfg()[0], n, tags === a.tags, t0 === tags, b === lastCfg()[1], JSON.stringify(lastCfg()), Object.keys(a));
  lastCfg()[0].tags.push("w");
  console.log(tags, a);
}
main();` },
  { id: "S125-K-06 a module global initialized by a package's parse holds its result: identity, writes from its module and an importer, JSON and keys", entry: "main.ts",
    npmStatic: ["zk"], files: { ...ZK, "util/cfg.ts": `import { object } from "zk";
const policy = object({ mode: "" });
export const def = policy.parse({ mode: "x", extra: 2 });
export function bump(): void { def.mode = def.mode + "!"; }` },
    src: `import { def, bump } from "./util/cfg.ts";
import { lastCfg } from "zk";
bump();
console.log(def, def === lastCfg(), JSON.stringify(def), Object.keys(def));
def.mode = "y";
console.log(lastCfg());` },
  { id: "S125-K-07 a defaulted `opts = {}` (q1) binds a dynamic argument itself and picks its default on the dynamic undefined, with and without the argument", entry: "main.ts",
    src: `type Opts = { verbose?: boolean; tags?: string[] };
function cmd(options: Opts = {}, extra = 1): void {
  options.tags?.push("z");
  console.log(options, extra);
}
const o: any = JSON.parse('{"tags":["a"],"k":1}');
cmd(o);
console.log(o);
cmd();
cmd(undefined);
const dyn: any = undefined;
cmd(dyn, 2);` },
  { id: "S125-K-08 a `const` pattern's names are fresh per loop iteration: closures made in the loop see their own (`var`-hoisted before)", entry: "main.ts",
    src: `const fns: (() => number)[] = [];
for (const o of [{ a: 1 }, { a: 2 }, { a: 3 }]) {
  const { a } = o;
  fns.push(() => a);
}
console.log(fns.map((f) => f()));
const gs: (() => number)[] = [];
for (let i = 0; i < 3; i++) {
  const [b] = [i * 10];
  gs.push(() => b);
}
console.log(gs.map((f) => f()));
const raw: any = JSON.parse('[{"a":1},{"a":2}]');
const hs: (() => unknown)[] = [];
for (const r of raw) { const { a } = r; hs.push(() => a); }
console.log(hs.map((f) => f()));` },
  { id: "S125-K-13 a deferred `let` assigned a cast of an `unknown` value holds the value itself", entry: "main.ts",
    src: `type T = { a: number[]; name: string };
function run(src: string): void {
  let cfg: T | null = null;
  const u: unknown = JSON.parse(src);
  cfg = u as T;
  cfg.a.push(2);
  console.log(cfg, u === cfg, JSON.stringify(u), Object.keys(cfg));
}
run('{"a":[1],"name":"n","extra":true}');` },
  { id: "S125-K-09 a module-scope `let` assigned a package's result keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into 'null \| \{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `${READ_CONFIG}
let config: Cfg | null = null;
config = readConfig('{"a":[1],"name":"n","extra":true}');
config!.a.push(2);
console.log(config, config === lastCfg());` },
  { id: "S125-K-10 a `let` also written by a compound assignment (`??=`) keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into 'null \| \{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `${READ_CONFIG}
function run(): void {
  let config: Cfg | null = null;
  config ??= readConfig('{"a":[1],"name":"n","extra":true}');
  config!.a.push(2);
  console.log(config, lastCfg() === config);
}
run();` },
  { id: "S125-K-11 a `let` that is a for-of target keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `import { parseCfg, type Cfg } from "zk";
function run(): void {
  let cfg: Cfg | undefined;
  for (cfg of [parseCfg(JSON.parse('{"a":[1],"name":"p","extra":1}'))]) cfg.a.push(2);
  console.log(cfg);
}
run();` },
  { id: "S125-K-12 a `?:` whose other arm is a typed object keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `import { parseCfg, lastCfg, type Cfg } from "zk";
const fallback: Cfg = { a: [], name: "f" };
function pick(flag: boolean): Cfg {
  const c = flag ? parseCfg(JSON.parse('{"a":[1],"name":"n","z":0}')) : fallback;
  c.a.push(7);
  return c;
}
console.log(pick(true), lastCfg(), pick(false), fallback);` },
  // A spread's key-order snapshot belongs to the lowering that took it: the
  // same literal lowered again in a width instance on the dynamic arm (the
  // spread now dynamic) once read the typed instance's hidden local and
  // shape (paperclip's zod transform `{ ...rest, supportsLoginPty: … }`
  // crashed the compiler on a shape of an earlier pass).
  { id: "S125-K-14 a literal spread in a typed instance and in an instance on the dynamic arm keeps each instance's key order", entry: "main.ts",
    src: `interface Cfg { a?: number; list: string[] }
function f(c: Cfg): void {
  c.list.push("y");
  const out = { ...c, a: 2 };
  console.log(JSON.stringify(out), Object.keys(out).join(","));
}
f({ list: [] });
const raw: any = JSON.parse('{"list":["x"],"z":1}');
f(raw);
console.log(raw.list.length);` },
  { id: "S125-K-15 a rest element of a pattern over a parameter on the dynamic arm, spread into a returned literal, keeps its copy, refused by name", entry: "main.ts",
    refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: boolean \| undefined; n: string\[\]; z: number \| undefined \}': it would be a COPY/,
    src: `function canon(driver: { a?: boolean; b?: boolean; n: string[]; z?: number }) {
  driver.n.push("y");
  const { b, ...rest } = driver;
  return { ...rest, a: rest.a ?? b };
}
const raw: any = JSON.parse('{"z":4,"b":true,"n":["x"],"a":false}');
const out = canon(raw);
console.log(JSON.stringify(out), Object.keys(out).join(","), raw.n.length);
console.log(JSON.stringify(canon({ n: [], z: 1 })));` },  // A class instance an armed slot holds crosses as its class view, whose
  // members lower although discovery (which takes no arm) never reached
  // them: the pass that references them extends reachability.
  { id: "S125-K-16 a deferred `let` assigned a class instance with methods on one path holds the instance itself", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction run(f: boolean): void {
  let c: Cfg;
  const m = new M();
  if (f) c = parseCfg(JSON.parse('{"a":[1],"name":"n"}')); else c = m;
  c.a.push(2);
  console.log(m.a.length, c.a.length);
}
run(false); run(true);` },
  { id: "S125-K-20 a deferred `let` assigned a class instance through `as unknown as` calls the methods it shares", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }
function run(f: boolean): void {
  let c: Cfg;
  const m = new M();
  if (f) c = parseCfg(JSON.parse('{"a":[1],"name":"n"}')); else c = m as unknown as Cfg;
  c.a.push(2);
  m.bump();
  c.name = c.name + "!";
  console.log(c.a.length, m.a.length, m.name, c === (m as unknown), JSON.stringify(c));
}
run(false); run(true);` },
  { id: "S125-K-21 a deferred `let` assigned a getter class's instance through `as unknown as` runs the getter", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    src: `import { parseCfg, type Cfg } from "zk";
class G { a: number[] = []; get name(): string { console.log("get name"); return "g"; } }
function run(f: boolean): void {
  let c: Cfg;
  const g = new G();
  if (f) c = parseCfg(JSON.parse('{"a":[1],"name":"n"}')); else c = g as unknown as Cfg;
  c.a.push(2);
  console.log(c.name, g.a.length, JSON.stringify(c), Object.keys(c).join(","));
}
run(false); run(true);` },
  { id: "S125-K-22 printing a class instance a deferred `let` holds stops at S115's named fence", entry: "main.ts",
    npmStatic: ["zk"], files: ZK,
    fence: { text: /printing a 'M' instance shared with dynamic code is not supported yet \(SEMANTICS\.md S115\)/, stdout: "1\n" },
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }
function run(f: boolean): void {
  let c: Cfg;
  const m = new M();
  if (f) c = parseCfg(JSON.parse('{"a":[1],"name":"n"}')); else c = m as unknown as Cfg;
  c.a.push(2);
  console.log(c.a.length - m.a.length + 1);
  console.log(c);
}
run(false); run(true);` },
  // A class instance meeting the typed slot directly (not through a
  // dynamic value) never arms: each form keeps main's refusal by name.
  { id: "S125-K-17 a deferred `let` initialized with a class instance with a getter keeps main's refusal by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC2002 record shapes must match exactly or width-coerce: expected '\{ a: number\[\]; name: string \}', got 'G'/,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction run(f: boolean): void {
  const g = new G();
  let c: Cfg = g;
  if (f) c = parseCfg(JSON.parse('{"a":[1],"name":"n"}'));
  c.a.push(2);
  console.log(g.a.length, c.name);
}
run(false); run(true);` },
  { id: "S125-K-18 a `?:` with a class instance arm keeps its copy, refused by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC1090 a dynamic \('unknown', 'any' or 'object'\) value checked into '\{ a: number\[\]; name: string \}': it would be a COPY/,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction run(f: boolean): void {
  const c: Cfg = f ? parseCfg(JSON.parse('{"a":[1],"name":"n"}')) : new M();
  c.a.push(2);
  console.log(c.a.length);
}
run(false); run(true);` },
  { id: "S125-K-19 a defaulted parameter whose default is a class instance keeps main's refusal by name", entry: "main.ts",
    npmStatic: ["zk"], files: ZK, refused: /SC2002 record shapes must match exactly or width-coerce: expected '\{ a: number\[\]; name: string \}', got 'G'/,
    src: `import { parseCfg, type Cfg } from "zk";
class M { a: number[] = []; name = "m"; bump(): void { this.a.push(9); } }\nclass G { a: number[] = []; get name(): string { return "g"; } }\nfunction use(c: Cfg = new G()): void {
  c.a.push(2);
  console.log(c.a.length, c.name);
}
use(parseCfg(JSON.parse('{"a":[1],"name":"n"}')));
use();` },
]);
