/* GH #109 (SEMANTICS.md S125): a value whose representation differs from
 * its typed slot's — a class instance where a record type is expected, a
 * wider record into a narrower one, `P[]` into `{ n: number }[]`, a tuple
 * into an array, a record into an index-signature record — used to enter
 * the slot as a silent COPY, losing writes, identity and keys. Now a
 * direct call of a plain function binds such a parameter to the
 * argument's own type (the object itself is passed), a copy nothing can
 * observe stays, and every other copy refuses by name at compile time.
 *
 * An exact row equals Node (spawned at test time) on the wasm and
 * wasm-native lanes; a `refused` row compiles to SC1090 naming S125 on
 * both. The helpers are wasm-undef-observers.test.ts's. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-width-identity-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

const S125 = /^a '.*' value where '.*' is expected.*: the slot would hold a COPY where JavaScript shares the object, and .* \(SEMANTICS\.md S125\) (is|are) not supported yet$/;

type Built = { ok: true; path: string } | { ok: false; diags: { code: string; message: string }[] };

async function build(id: string, file: string, backend: "wasm" | "wasm-native"): Promise<Built> {
  const dir = join(scratch, `${id}-${backend}`);
  const res = await compile(file, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) return { ok: false, diags: res.diagnostics.map((d) => ({ code: d.code, message: d.message })) };
  return { ok: true, path: res.binaryPath! };
}

async function wasmRun(path: string): Promise<Out> {
  const r = await runWasm(path);
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
}

async function nativeRun(path: string): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

interface Row {
  id: string;
  src: string;
  /** The copy the program could observe refuses by name: how many S125
   * diagnostics ("some": at least one). Absent: the row
   * compiles and equals Node. */
  refused?: number | "some";
}

const ROWS: Row[] = [
  // ── a direct call passes the object itself ──────────────────────────
  {
    id: "issue-109",
    src: `class P { n = 0 }
function bump(o: { n: number }) { o.n++; }
const p = new P(); bump(p); console.log(p.n);`,
  },
  {
    id: "interface-param-write",
    src: `interface HasN { n: number }
class P implements HasN { n = 0; inc() { this.n++; } }
function bump(o: HasN) { o.n += 10; }
const p = new P(); bump(p); p.inc(); bump(p); console.log(p.n, p);`,
  },
  {
    id: "subclass-into-interface",
    src: `interface HasN { n: number }
class B { n = 0 } class D extends B { k = 1 }
function bump(o: HasN) { o.n++; }
const d = new D(); const b: B = new B(); bump(d); bump(b); bump(d); console.log(d.n, b.n, d);`,
  },
  {
    id: "wider-record-param-write",
    src: `const a = { n: 0, m: 1 };
function bump(o: { n: number }) { o.n++; }
bump(a); bump(a); console.log(a, a.n);`,
  },
  {
    id: "param-sees-later-writes",
    src: `class P { n = 0; m = 2 }
function sum(o: { n: number; m: number }) { return o.n + o.m; }
const p = new P(); console.log(sum(p)); p.n = 4; console.log(sum(p));`,
  },
  {
    id: "param-keys-and-print",
    src: `class P { n = 0; m = 1 }
function show(o: { n: number }) { console.log(o); }
function keys(o: { n: number }) { return JSON.stringify(o) + Object.keys(o).join("") + Object.entries(o).length + ("m" in o); }
const w = { n: 3, m: 4, z: 5 };
show(new P()); show(w); console.log(keys(w));`,
  },
  {
    id: "param-identity",
    src: `class P { n = 0 }
function same(o: { n: number }, q: P) { return o === q; }
const p = new P(); console.log(same(p, p), same(p, new P()));`,
  },
  {
    id: "transitive-and-recursive",
    src: `class P { n = 0 }
function inner(o: { n: number }) { o.n += 2; }
function outer(o: { n: number }, k: number): number { inner(o); return k > 0 ? outer(o, k - 1) : o.n; }
const p = new P(); console.log(outer(p, 3), p.n);`,
  },
  {
    id: "closure-captures-param",
    src: `class P { n = 0 }
function counter(o: { n: number }) { return () => { o.n += 1; return o.n; }; }
const p = new P(); const c = counter(p); c(); c(); console.log(p.n);`,
  },
  {
    id: "async-param",
    src: `class P { n = 0 }
async function later(o: { n: number }) { await null; o.n += 5; }
const p = new P(); later(p).then(() => console.log("after", p.n)); console.log("before", p.n);`,
  },
  {
    id: "two-classes-one-function",
    src: `class A { n = 1; a = "x" } class B { n = 10; b = true }
function twice(o: { n: number }) { o.n *= 2; return o.n; }
const a = new A(); const b = new B(); twice(a); twice(b); twice(a); console.log(a, b, twice({ n: 7 }));`,
  },
  // ── copies nothing can observe stay ─────────────────────────────────
  {
    id: "class-json-same-keys",
    src: `class Pt { x = 1; y = 2 }
function j(p: { x: number; y: number }) { return JSON.stringify(p); }
const p = new Pt(); console.log(j(p), j(new Pt()));`,
  },
  {
    id: "readonly-interface-loop",
    src: `interface V { x: number }
class P implements V { x = 1 }
const f = (v: V) => v.x * 2;
const ps = [new P(), new P()]; let t = 0; for (const p of ps) t += f(p); console.log(t);`,
  },
  {
    id: "pick-table-read",
    src: `type Full = { id: number; name: string; secret: string };
const rows: Full[] = [{ id: 1, name: "a", secret: "x" }, { id: 2, name: "b", secret: "y" }];
function names(xs: { name: string }[]) { return xs.map((r) => r.name).join(","); }
console.log(names(rows));`,
  },
  {
    id: "fresh-instance",
    src: `class P { n = 0; m = 1 }
const bump = (o: { n: number }) => { o.n++; return o.n; };
console.log(bump(new P()), bump(new P()));`,
  },
  {
    id: "generic-keeps-object",
    src: `class P { n = 0 }
function bump<T extends { n: number }>(o: T) { o.n++; }
const p = new P(); bump(p); bump(p); console.log(p.n, p);`,
  },
  {
    id: "tuple-read-as-array",
    src: `const t: [number, number] = [1, 2];
function sum(xs: readonly number[]) { let s = 0; for (const x of xs) s += x; return s; }
console.log(sum(t));`,
  },
  {
    id: "sole-original-copy-written",
    src: `const pair: [number, number] = [3, 4];
const nums: number[] = pair;
nums.push(5); nums[0] = 9;
console.log(nums.length, nums[0], nums);
const src = { b: 2, a: 1 };
const rec: Record<string, number> = src;
rec["c"] = 3;
console.log(Object.keys(rec), JSON.stringify(rec));`,
  },
  // ── copies the program could tell apart refuse by name ──────────────
  {
    id: "returned-array-adapter-then-write",
    src: `type Wide = { host: string; port: number; pid: number };
type Narrow = { host: string; port: number };
const routes: Wide[] = [{ host: "a", port: 1, pid: 9 }];
function make(get: () => Narrow[]) { return () => get().map((r) => r.host + ":" + r.port).join(","); }
const show = make(() => routes);
console.log(show());
routes.push({ host: "b", port: 2, pid: 8 });
console.log(show());`,
    refused: 1,
  },
  {
    id: "element-escapes-filter",
    src: `const rs = [{ n: 0, m: 1 }];
function f(xs: { n: number }[]) { const ys = xs.filter((x) => x.n === 0); ys[0].n = 5; }
f(rs); console.log(rs[0].n);`,
    refused: 1,
  },
  {
    id: "element-escapes-map-identity",
    src: `const rs = [{ n: 0, m: 1 }];
function f(xs: { n: number }[]) { return xs.map((x) => x); }
const ys = f(rs); ys[0].n = 5; console.log(rs[0].n);`,
    refused: 1,
  },
  {
    id: "element-written-in-callback",
    src: `const rs = [{ n: 0, m: 1 }];
function f(xs: { n: number }[]) { xs.forEach((x) => { x.n++; }); }
f(rs); console.log(rs[0].n);`,
    refused: 1,
  },
  {
    id: "checked-record-narrow-printed",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1,"note":"x"}') as R;
const n: { a: number } = w;
console.log(n, Object.keys(n));`,
    // Unit U2: `n` takes the dynamic arm, which holds `w` (its typed arm: the
    // view) — Node's keys, no copy (SEMANTICS.md S128).
  },
  {
    id: "record-literal-into-class-instanceof",
    src: `class Pt { constructor(public x: number, public y: number) {} }
const isPt = (p: Pt) => p instanceof Pt;
console.log(isPt({ x: 0, y: 0 }), isPt(new Pt(1, 2)));`,
    refused: 1,
  },
  {
    id: "folded-in-on-copy",
    src: `const a = { n: 0, m: 1 };
const v: { n: number } = a;
console.log(a.n, "m" in v);`,
    refused: 1,
  },
  {
    id: "captured-copy-written",
    src: `const a = { n: 0, m: 1 };
const v: { n: number } = a;
const f = () => { v.n = 5; };
f(); console.log(a.n);`,
    refused: 1,
  },
  {
    id: "copies-compared",
    src: `class P { n = 0 }
const p = new P();
const v: { n: number } = p;
const w: { n: number } = p;
console.log(v === w, p.n);`,
    refused: 2,
  },
  {
    id: "local-alias-write",
    src: `class P { n = 0 }
const p = new P(); const v: { n: number } = p; p.n = 5; console.log(v.n); v.n = 7; console.log(p.n);`,
    refused: 1,
  },
  {
    id: "as-cast-write",
    src: `class P { n = 0 }
const p = new P(); const v = p as { n: number }; v.n = 6; console.log(p.n);`,
    refused: 1,
  },
  {
    id: "array-of-class",
    src: `class P { n = 0 }
function bumpAll(xs: { n: number }[]) { for (const x of xs) x.n++; xs.push({ n: 9 }); }
const ps = [new P(), new P()]; bumpAll(ps); console.log(ps.length, ps[0].n);`,
    refused: 1,
  },
  {
    id: "array-of-wider-records",
    src: `const rs = [{ n: 0, m: 1 }];
function bumpAll(xs: { n: number }[]) { for (const x of xs) x.n++; }
bumpAll(rs); console.log(rs[0].n);`,
    refused: 1,
  },
  {
    id: "union-param",
    src: `class P { n = 0 }
function bump(o: { n: number } | null) { if (o) o.n++; }
const p = new P(); bump(p); console.log(p.n);`,
    refused: 1,
  },
  {
    id: "return-alias",
    src: `class P { n = 0 }
const p = new P();
function get(): { n: number } { return p; }
get().n = 4; console.log(p.n);`,
    refused: 1,
  },
  {
    id: "field-alias",
    src: `class P { n = 0 }
const p = new P();
const h: { o: { n: number } } = { o: p };
h.o.n = 4; console.log(p.n);`,
    refused: 1,
  },
  {
    id: "map-value",
    src: `class P { n = 0 }
const p = new P();
const m = new Map<string, { n: number }>(); m.set("a", p); m.get("a")!.n = 3; console.log(p.n);`,
    refused: 1,
  },
  {
    id: "arrow-param-write",
    src: `class P { n = 0 }
const bump = (o: { n: number }) => { o.n++; };
const p = new P(); bump(p); console.log(p.n);`,
    refused: 1,
  },
  {
    id: "wider-optional-local",
    src: `type A = { n: number }; type B = { n: number; m?: number };
const a: A = { n: 0 }; const b: B = a; b.n = 2; console.log(a.n);`,
    refused: 1,
  },
  {
    id: "tuple-into-array-write",
    src: `const t: [number, number] = [1, 2]; const a: number[] = t; a[0] = 9; console.log(t[0]);`,
    refused: 1,
  },
  {
    id: "index-signature-param",
    src: `const r = { a: 1, b: 2 }; function bump(o: Record<string, number>) { o.a++; o.c = 3; }
bump(r); console.log(r, Object.keys(r));`,
    refused: 1,
  },
  {
    id: "narrow-copy-printed",
    src: `const a = { n: 0, m: 1 };
const show = (o: { n: number }) => console.log(o, JSON.stringify(o));
show(a);`,
    refused: 1,
  },
  {
    id: "class-copy-printed",
    src: `class P { n = 0 }
const show = (o: { n: number }) => console.log(o);
show(new P());`,
    refused: 1,
  },
  // ── the #109 review's repros: soundness holes (a constructor or field
  // closure keeping `this`, a constructor writing another object, writes to
  // an array, tuple or index-signature source) and read-only programs the
  // first build refused ──────────────────────────────────────────────
  {
    id: "review-arrow-field",
    src: `class P { n = 0; inc = () => { this.n++; }; }
const c: { n: number; inc: () => void } = new P();
c.inc();
console.log(c.n);`,
    refused: "some",
  },
  {
    id: "review-ctor-cb",
    src: `class P {
  n = 0;
  bump: () => void;
  constructor() { this.bump = () => { this.n += 1; }; }
}
const p = new P();
const c: { n: number; bump: () => void } = p;
c.bump(); c.bump();
console.log(c.n, p.n);`,
    refused: "some",
  },
  {
    id: "review-ctor-timer",
    src: `class P {
  n = 0;
  constructor() { setTimeout(() => { this.n = 9; }, 0); }
}
const c: { n: number } = new P();
setTimeout(() => console.log(c.n), 10);`,
    refused: "some",
  },
  {
    id: "review-arr-tuple-elem",
    src: `const t: [number, string] = [1, "a"];
const a: (number | string)[] = t;
t[1] = "z";
console.log(a[1]);`,
    refused: "some",
  },
  {
    id: "review-idx-write-from",
    src: `const r = { a: 1, b: 2 };
const d: Record<string, number> = r;
r.a = 5;
console.log(d.a, d["b"]);`,
    refused: "some",
  },
  {
    id: "review-tup-write-from",
    src: `const t: [number, number] = [1, 2];
const a: number[] = t;
t[0] = 5;
console.log(a[0], a);`,
    refused: "some",
  },
  {
    id: "review-ctor-cb-nonfresh-sole",
    src: `class P {
  n = 0;
  bump = (): void => { this.n++; };
}
const p = new P();
console.log(p.n);
const c: { n: number; bump: () => void } = p;
c.bump();
console.log(c.n, p.n);`,
    refused: "some",
  },
  {
    id: "review-rec-idx-target-decl",
    src: `const r = { a: 1, b: 2 };
const d: { a: number; [k: string]: number } = r;
r.b = 9;
console.log(d.b);`,
    refused: "some",
  },
  {
    id: "review-tup-nested",
    src: `const ts: [number, number][] = [[1, 2], [3, 4]];
const as: number[][] = ts;
ts[0][0] = 9;
console.log(as[0][0], as);`,
    refused: "some",
  },
  {
    id: "review-other-ctor-write",
    src: `class P { n = 0 }
class X { constructor(p: P) { p.n = 5; } }
const p = new P();
const c: { n: number } = p;
new X(p);
console.log(c.n, p.n);`,
    refused: "some",
  },
  {
    id: "review-other-ctor-write2",
    src: `class Account { balance = 0 }
class Deposit {
  constructor(acct: Account, amount: number) { acct.balance += amount; }
}
interface HasBalance { balance: number }
const acct = new Account();
const view: HasBalance[] = [acct];
new Deposit(acct, 50);
console.log(view[0].balance);`,
    refused: "some",
  },
  {
    id: "review-idx-cb",
    src: `const cfg = { retries: 1, timeout: 5 };
function show(m: Record<string, number>, f: () => void) { f(); console.log(m["retries"]); }
show(cfg, () => { cfg.retries = 3; });`,
    refused: "some",
  },
  {
    id: "review-tup-cb",
    src: `const t: [number, number] = [1, 2];
function each(xs: number[], f: () => void) { f(); console.log(xs[0]); }
each(t, () => { t[0] = 9; });`,
    refused: "some",
  },
  {
    id: "review-r01-push-then-sum",
    src: `interface Row { name: string; qty: number; price: number }
function total(items: { qty: number; price: number }[]): number {
  let s = 0;
  for (const it of items) s += it.qty * it.price;
  return s;
}
const rows: Row[] = [];
rows.push({ name: "a", qty: 2, price: 3 });
rows.push({ name: "b", qty: 1, price: 10 });
console.log(total(rows));`,
  },
  {
    id: "review-r04-points",
    src: `type Pt = { x: number; y: number };
class Vec { constructor(public x: number, public y: number) {} add(o: Pt) { this.x += o.x; this.y += o.y; return this; } }
function len(p: Pt) { return Math.hypot(p.x, p.y); }
const v = new Vec(3, 4);
console.log(len(v));
v.add({ x: 1, y: 1 });
console.log(len(v), v.x);
const pts: Pt[] = [v, { x: 0, y: 1 }];
console.log(pts.map(len).join(" "));`,
    refused: "some",
  },
  {
    id: "review-r05-dto",
    src: `interface Item { id: number; title: string }
interface Detailed extends Item { body: string; tags: string[] }
const all: Detailed[] = [
  { id: 1, title: "x", body: "bb", tags: ["a"] },
  { id: 2, title: "y", body: "cc", tags: [] },
];
function titles(items: Item[]): string[] { return items.map((i) => i.title); }
function byId(items: Item[], id: number): Item | undefined { return items.find((i) => i.id === id); }
console.log(titles(all).join(","), byId(all, 2)?.title);
all.push({ id: 3, title: "z", body: "", tags: [] });
console.log(titles(all).length);`,
  },
  {
    id: "review-r07-sort-view",
    src: `type Score = { name: string; pts: number; team: string };
const scores: Score[] = [{ name: "a", pts: 3, team: "x" }, { name: "b", pts: 9, team: "y" }];
function best(xs: { pts: number; name: string }[]) { return xs.reduce((m, s) => (s.pts > m.pts ? s : m)).name; }
scores.sort((a, b) => a.pts - b.pts);
console.log(best(scores));`,
  },
  {
    id: "review-s01-inventory",
    src: `interface Product { sku: string; price: number }
class StockItem implements Product { constructor(public sku: string, public price: number, public qty: number) {} restock(n: number) { this.qty += n; } }
const items = [new StockItem("a", 2, 1), new StockItem("b", 5, 0)];
items[1].restock(3);
function cheapest(ps: Product[]): string { return ps.slice().sort((x, y) => x.price - y.price)[0].sku; }
console.log(cheapest(items), items.map((i) => i.qty).join(","));`,
  },
  {
    id: "review-s02-logger",
    src: `interface LogEntry { level: string; msg: string }
const entries: { level: string; msg: string; ts: number }[] = [];
let clock = 0;
function add(level: string, msg: string) { entries.push({ level, msg, ts: clock++ }); }
function format(e: LogEntry) { return \`[\${e.level}] \${e.msg}\`; }
add("info", "start"); add("warn", "slow");
for (const e of entries) console.log(format(e));
const errs: LogEntry[] = entries.filter((e) => e.level === "warn");
console.log(errs.length);`,
  },
  {
    id: "review-s03-geom",
    src: `type P2 = { x: number; y: number };
type P3 = { x: number; y: number; z: number };
const path: P3[] = [{ x: 0, y: 0, z: 1 }, { x: 3, y: 4, z: 2 }];
function dist(a: P2, b: P2) { return Math.hypot(a.x - b.x, a.y - b.y); }
function perim(ps: P2[]) { let s = 0; for (let i = 1; i < ps.length; i++) s += dist(ps[i - 1], ps[i]); return s; }
path.push({ x: 6, y: 8, z: 3 });
console.log(perim(path), dist(path[0], path[2]));`,
  },
  {
    id: "review-s06-user-store",
    src: `interface Identified { id: number }
class User { constructor(public id: number, public name: string) {} rename(n: string) { this.name = n; } }
class Store<T extends Identified> { items: T[] = []; add(x: T) { this.items.push(x); } find(id: number) { return this.items.find((i) => i.id === id); } }
const s = new Store<User>();
s.add(new User(1, "a")); s.add(new User(2, "b"));
s.find(2)?.rename("bb");
function ids(xs: Identified[]) { return xs.map((x) => x.id).join(","); }
console.log(ids(s.items), s.find(2)?.name);`,
  },
  // ── the sweep: order, loops, calls ─────────────────────────────────
  {
    id: "write-before-copy-in-init",
    src: `type R = { n: number; m: number };
const rs: R[] = [];
rs.push({ n: 1, m: 2 });
rs[0].n = 5;
rs.sort((a, b) => a.n - b.n);
const ns = (xs: { n: number }[]) => xs.map((x) => x.n).join(",");
console.log(ns(rs));`,
  },
  {
    id: "write-in-same-loop-as-copy",
    src: `const p = { n: 0, m: 1 };
for (let i = 0; i < 2; i++) {
  const v: { n: number } = p;
  console.log(v.n);
  p.n++;
}`,
    refused: "some",
  },
  {
    id: "callee-writes-original-during-transient-copy",
    src: `const rs = [{ n: 0, m: 1 }];
function f(xs: { n: number }[]) { rs[0].n = 9; return xs[0].n; }
console.log(f(rs), rs[0].n);`,
    refused: "some",
  },
  {
    id: "write-after-copy-held",
    src: `const rs = [{ n: 0, m: 1 }];
const view: { n: number }[] = rs;
rs[0].n = 4;
console.log(view[0].n);`,
    refused: "some",
  },
  {
    id: "ctor-hands-this-to-a-method",
    src: `const reg: { n: number }[] = [];
class P { n = 0; constructor() { this.keep(); } keep() { reg.push(this); } }
const p = new P();
const v: { n: number } = p;
p.n = 3;
console.log(v.n, reg[0].n);`,
    refused: "some",
  },
  {
    id: "recheck-emit-runs-listener-during-transient-copy",
    src: `import { EventEmitter } from "node:events";
const em = new EventEmitter();
const p = { n: 0, m: 1 };
em.on("x", () => { p.n = 5; });
class Svc { show(o: { n: number }) { em.emit("x"); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-stream-write-runs-callback-during-transient-copy",
    src: `import { Writable } from "node:stream";
const p = { n: 0, m: 1 };
const ws = new Writable({ write(_c, _e, cb) { p.n = 5; cb(); } });
class Svc { show(o: { n: number }) { ws.write("x"); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  // ── the #109 re-check's repros: callbacks the runtime runs during a
  // call (emitter listeners, stream writes, promise executors ...), order in
  // the module initializer, identity through unions and closures, array
  // mutators, transient copies ───────────────────────────────────────
  {
    id: "recheck-a1-fn-earlier",
    src: `class P { n = 0 }
const p = new P();
function poke() { p.n = 5; }
const c: { n: number }[] = [p];
poke();
console.log(c[0].n);`,
    refused: "some",
  },
  {
    id: "recheck-a2-timer-before",
    src: `const r = { a: 1, b: 2 };
setTimeout(() => { r.a = 7; }, 0);
const d: Record<string, number> = r;
setTimeout(() => console.log(d["a"]), 5);`,
    refused: "some",
  },
  {
    id: "recheck-a3-promise-before",
    src: `const t: [number, number] = [1, 2];
Promise.resolve().then(() => { t[0] = 9; });
const a: number[] = t;
Promise.resolve().then(() => {}).then(() => console.log(a[0]));`,
    refused: "some",
  },
  {
    id: "recheck-a4-loop",
    src: `const t: [number, number] = [1, 2];
let a: number[] = [];
for (let i = 0; i < 2; i++) {
  if (i === 1) t[0] = 9;
  if (i === 0) a = t;
}
console.log(a[0]);`,
    refused: "some",
  },
  {
    id: "recheck-a6-earlier-stmt-write-in-init",
    src: `const r = { a: 1, b: 2 };
r.a = 3;
const d: Record<string, number> = r;
console.log(d["a"], d["b"]);`,
  },
  {
    id: "recheck-a7-generator-before",
    src: `const t: [number, number] = [1, 2];
function* g() { yield 0; t[0] = 9; }
const it = g();
it.next();
const a: number[] = t;
it.next();
console.log(a[0]);`,
    refused: "some",
  },
  {
    id: "recheck-a8-inline-gen-earlier",
    src: `const t: [number, number] = [1, 2];
const it = (function* () { yield 0; t[0] = 9; })();
it.next();
const a: number[] = t;
it.next();
console.log(a[0]);`,
    refused: "some",
  },
  {
    id: "recheck-a9-try",
    src: `const t: [number, number] = [1, 2];
let a: number[] = [];
try { a = t; throw new Error("x"); } catch { }
t[0] = 9;
console.log(a[0]);`,
    refused: "some",
  },
  {
    id: "recheck-s2-static-block",
    src: `const t: [number, number] = [1, 2];
const a: number[] = t;
class K { static { t[0] = 9; } }
console.log(a[0]);`,
    refused: "some",
  },
  {
    id: "recheck-s3-tla",
    src: `export {};
const t: [number, number] = [1, 2];
const a: number[] = t;
await null;
t[1] = 8;
console.log(a[1]);`,
    refused: "some",
  },
  {
    id: "recheck-s4-tla-timer",
    src: `export {};
const t: [number, number] = [1, 2];
const a: number[] = t;
await new Promise<void>((res) => setTimeout(res, 1));
console.log(a[0]);`,
  },
  {
    id: "recheck-s5-tla-before",
    src: `export {};
const t: [number, number] = [1, 2];
let a: number[] = [];
const pr = new Promise<void>((res) => setTimeout(res, 1));
t[0] = 4;
a = t;
await pr;
console.log(a[0]);`,
  },
  {
    id: "recheck-s6-enum-ns",
    src: `const t: [number, number] = [1, 2];
const a: number[] = t;
namespace N { t[0] = 9; }
console.log(a[0]);`,
    refused: "some",
  },
  {
    id: "recheck-s7-decl-order",
    src: `const r = { a: 1, b: 2 };
let d: Record<string, number> = {};
if (r.a > 0) d = r; else r.a = 5;
r.b = 3;
console.log(d["b"]);`,
    refused: "some",
  },
  {
    id: "recheck-b0-baseline",
    src: `class P { n = 0 }
const p = new P();
function poke() { p.n = 5; }
class Svc { show(o: { n: number }) { poke(); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-b12-recursion",
    src: `class P { n = 0 }
const p = new P();
class Svc { show(o: { n: number }, d: number): void { if (d > 0) { p.n = d; this.show({ n: 0 }, d - 1); } console.log(o.n); } }
new Svc().show(p, 2);`,
    refused: "some",
  },
  {
    id: "recheck-b13-emitter",
    src: `import { EventEmitter } from "node:events";
class P { n = 0 }
const p = new P();
const em = new EventEmitter();
em.on("x", () => { p.n = 5; });
class Svc { show(o: { n: number }) { em.emit("x"); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-b1-fnref",
    src: `class P { n = 0 }
const p = new P();
function poke() { p.n = 5; }
class Svc { show(o: { n: number }, f: () => void) { f(); console.log(o.n); } }
new Svc().show(p, poke);`,
    refused: "some",
  },
  {
    id: "recheck-b2-getter",
    src: `class P { n = 0 }
const p = new P();
class Q { get v(): number { p.n = 5; return 1; } }
const q = new Q();
class Svc { show(o: { n: number }) { const x = q.v; console.log(o.n, x); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-b5-sortcmp",
    src: `class P { n = 0 }
const p = new P();
function cmp(a: number, b: number) { p.n = 5; return a - b; }
class Svc { show(o: { n: number }) { [3, 1].sort(cmp); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-b6-foreach-ref",
    src: `class P { n = 0 }
const p = new P();
function poke(x: number) { p.n = x; }
class Svc { show(o: { n: number }) { [5].forEach(poke); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-b7-setter",
    src: `class P { n = 0 }
const p = new P();
class Q { set v(x: number) { p.n = x; } }
const q = new Q();
class Svc { show(o: { n: number }) { q.v = 5; console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-b8-stored-closure",
    src: `class P { n = 0 }
const p = new P();
const hooks: (() => void)[] = [];
hooks.push(() => { p.n = 5; });
class Svc { show(o: { n: number }) { for (const h of hooks) h(); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-b9-field-fn",
    src: `class P { n = 0 }
const p = new P();
function poke() { p.n = 5; }
class Svc { cb: () => void = poke; show(o: { n: number }) { this.cb(); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c10-sort-closure",
    src: `class P { n = 0 }
const p = new P();

class Svc { show(o: { n: number }) { [2, 1].sort((a, b) => { p.n = 5; return a - b; }); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c11-userclass-emitter",
    src: `class P { n = 0 }
const p = new P();
type L = () => void;
class Bus { ls: L[] = []; on(l: L) { this.ls.push(l); } emit() { for (const l of this.ls) l(); } }
const bus = new Bus();
bus.on(() => { p.n = 5; });
class Svc { show(o: { n: number }) { bus.emit(); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c12-str-split-map",
    src: `class P { n = 0 }
const p = new P();

class Svc { show(o: { n: number }) { "a,b".split(",").map(() => { p.n = 5; return 1; }); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c1-replace",
    src: `class P { n = 0 }
const p = new P();

class Svc { show(o: { n: number }) { const s = "ab".replace(/a/g, () => { p.n = 5; return "x"; }); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c4-mapforeach",
    src: `class P { n = 0 }
const p = new P();

class Svc { show(o: { n: number }) { new Map<string, number>([["a", 1]]).forEach(() => { p.n = 5; }); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c5-setforeach",
    src: `class P { n = 0 }
const p = new P();

class Svc { show(o: { n: number }) { new Set<number>([1]).forEach(() => { p.n = 5; }); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c6-promise-exec",
    src: `class P { n = 0 }
const p = new P();

class Svc { show(o: { n: number }) { new Promise<void>((res) => { p.n = 5; res(); }); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c7-emitter-once",
    src: `class P { n = 0 }
const p = new P();
import { EventEmitter } from "node:events";
const em = new EventEmitter();
em.once("x", () => { p.n = 5; });
class Svc { show(o: { n: number }) { em.emit("x"); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-c8-emitter-method",
    src: `class P { n = 0 }
const p = new P();
import { EventEmitter } from "node:events";
class Bus extends EventEmitter {}
const bus = new Bus();
function onX(): void { p.n = 5; }
bus.on("x", onX);
class Svc { show(o: { n: number }) { bus.emit("x"); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-d1-writable",
    src: `class P { n = 0 }
const p = new P();
import { Writable } from "node:stream";
const ws = new Writable({ write(_c, _e, cb) { p.n = 5; cb(); } });
class Svc { show(o: { n: number }) { ws.write("x"); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-d2-emitter-err",
    src: `class P { n = 0 }
const p = new P();
import { EventEmitter } from "node:events";
const em = new EventEmitter();
em.on("error", () => { p.n = 5; });
class Svc { show(o: { n: number }) { em.emit("error", new Error("e")); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-d3-emitter-newlistener",
    src: `class P { n = 0 }
const p = new P();
import { EventEmitter } from "node:events";
const em = new EventEmitter();
em.on("newListener", () => { p.n = 5; });
class Svc { show(o: { n: number }) { em.on("y", () => {}); console.log(o.n); } }
new Svc().show(p);`,
    refused: "some",
  },
  {
    id: "recheck-zc1-union-includes",
    src: `class P { n = 0 }
const p = new P();
const c: { n: number } = p;
const xs: ({ n: number } | string)[] = ["a", c];
console.log(xs.includes(p), xs.indexOf(p));`,
    refused: "some",
  },
  {
    id: "recheck-zc3-nullable-eq",
    src: `class P { n = 0 }
const p = new P();
const c: { n: number } = p;
let cur: { n: number } | null = null;
cur = c;
const q: { n: number } | null = p;
console.log(cur === q);`,
    refused: "some",
  },
  {
    id: "recheck-zc4-closure-capture-identity",
    src: `const t: [number, number] = [1, 2];
const a: number[] = t;
const same = (x: number[] | null) => x === a;
const b: number[] | null = t;
console.log(same(b));`,
    refused: "some",
  },
  {
    id: "recheck-zc5-obj-field-identity",
    src: `const r = { a: 1, b: 2 };
const d: Record<string, number> = r;
const box: { v: Record<string, number> | undefined } = { v: d };
const other: Record<string, number> | undefined = r;
console.log(box.v === other);`,
    refused: "some",
  },
  {
    id: "recheck-zd-alias",
    src: `class P { n = 0 }
const orig: P[] = [new P(), new P(), new P()];
const view: { n: number }[] = orig;
const al = orig; al[1] = new P(); al[1].n = 4;
console.log(view.length, orig.length, view.map((v) => v.n).join(","));`,
    refused: "some",
  },
  {
    id: "recheck-zd-fresh-filter-spine",
    src: `class P { n = 0 }
const ps = [new P(), new P()];
const keep = ps.filter(() => true);
const ys: { n: number }[] = keep;
keep.push(new P());
console.log(ys.length, keep.length);`,
    refused: "some",
  },
  {
    id: "recheck-zd-fresh-map",
    src: `class P { n = 0 }
const ps = [new P(), new P()];
const ys: { n: number }[] = ps.map((x) => x);
ps[0].n = 5;
console.log(ys[0].n);`,
    refused: "some",
  },
  {
    id: "recheck-zd-fresh-slice-elem",
    src: `const rows = [[1, 2], [3, 4]] as [number, number][];
const view: number[][] = rows.slice();
rows[0][0] = 9;
console.log(view[0][0]);`,
    refused: "some",
  },
  {
    id: "recheck-zd-pushspread",
    src: `class P { n = 0 }
const orig: P[] = [new P(), new P(), new P()];
const view: { n: number }[] = orig;
const more = [new P()]; orig.push(...more);
console.log(view.length, orig.length, view.map((v) => v.n).join(","));`,
    refused: "some",
  },
  {
    id: "recheck-zd-reverse",
    src: `class P { n = 0 }
const orig: P[] = [new P(), new P(), new P()];
const view: { n: number }[] = orig;
orig[0].n = 7; orig.reverse();
console.log(view.length, orig.length, view.map((v) => v.n).join(","));`,
    refused: "some",
  },
  {
    id: "recheck-zd-sort-then",
    src: `class P { n = 0 }
const orig: P[] = [new P(), new P(), new P()];
const view: { n: number }[] = orig;
orig[2].n = 9; orig.sort((a, b) => b.n - a.n);
console.log(view.length, orig.length, view.map((v) => v.n).join(","));`,
    refused: "some",
  },
  {
    id: "recheck-zd-splice",
    src: `class P { n = 0 }
const orig: P[] = [new P(), new P(), new P()];
const view: { n: number }[] = orig;
orig.splice(0, 1);
console.log(view.length, orig.length, view.map((v) => v.n).join(","));`,
    refused: "some",
  },
  {
    id: "recheck-zd-via-fn",
    src: `class P { n = 0 }
const orig: P[] = [new P(), new P(), new P()];
const view: { n: number }[] = orig;
function wipe(xs: P[]) { xs.splice(0); } wipe(orig);
console.log(view.length, orig.length, view.map((v) => v.n).join(","));`,
    refused: "some",
  },
  {
    id: "recheck-zd-view-splice",
    src: `class P { n = 0 }
const orig: P[] = [new P(), new P(), new P()];
const view: { n: number }[] = orig;
view.splice(0, 2);
console.log(view.length, orig.length, view.map((v) => v.n).join(","));`,
    refused: "some",
  },
  {
    id: "recheck-ze4-transient-cb-mutate",
    src: `const t: [number, number] = [1, 2];
class Svc { show(xs: number[], f: (v: number) => void) { [1].forEach(f); console.log(xs[0]); } }
new Svc().show(t, (v) => { t[0] = 9 + v; });`,
    refused: "some",
  },
  {
    id: "recheck-ze5-transient-async-inner",
    src: `const t: [number, number] = [1, 2];
async function later() { await null; t[0] = 9; }
function kick() { later(); }
class Svc { show(xs: number[]) { kick(); return xs; } }
const r = new Svc().show(t);
setTimeout(() => console.log(r[0]), 5);`,
    refused: "some",
  },
  // ── GH #118: a call that hands out an array nothing else holds ───────
  {
    // chess.js history(): one (Move | string)[] handed out as Move[] or
    // string[] by the overloads; the copy is the only reference left.
    id: "gh118-overload-history",
    src: `class Move {
  constructor(public san: string) {}
  isCapture(): boolean { return this.san.includes("x"); }
}
class Game {
  private moves = ["e4", "exd5"];
  history(): string[];
  history(o: { verbose: true }): Move[];
  history(o: { verbose: boolean } = { verbose: false }) {
    const out: (Move | string)[] = [];
    for (const m of this.moves) {
      if (o.verbose) out.push(new Move(m));
      else out.push(m);
    }
    return out;
  }
}
const g = new Game();
const verbose = g.history({ verbose: true });
console.log(verbose.filter((m) => m.isCapture()).length, g.history().length);
verbose.push(new Move("Nf3"));
console.log(verbose.map((m) => m.san), g.history(), verbose[0] instanceof Move);`,
  },
  {
    id: "gh118-overload-function",
    src: `function hist(): string[];
function hist(v: true): number[];
function hist(v?: boolean) {
  const out: (number | string)[] = [];
  for (let i = 0; i < 3; i++) out.push(v ? i : "s" + i);
  out.pop();
  return out;
}
const a = hist();
const b = hist(true);
a.push("x");
b[0] = 7;
console.log(a, b, a.length + b.length, JSON.stringify(a), b.includes(7));
function both(flag: boolean): string[] | number[] { return flag ? hist(true) : hist(); }
console.log(both(true), both(false));`,
  },
  {
    // The callee also stores the array: the caller's copy would miss a
    // later write through the stored reference (Node: 2).
    id: "gh118-callee-stores",
    src: `class Move { constructor(public san: string) {} }
class Game {
  cache: (Move | string)[] = [];
  history(): string[];
  history(o: { verbose: true }): Move[];
  history(o: { verbose: boolean } = { verbose: false }) {
    const out: (Move | string)[] = [];
    out.push(o.verbose ? new Move("e4") : "e4");
    this.cache = out;
    return out;
  }
}
const g = new Game();
const h = g.history();
g.cache.push("zz");
console.log(h.length);`,
    refused: "some",
  },
  {
    // The callee hands out an array it does not own (Node: 2).
    id: "gh118-callee-returns-field",
    src: `class Move { constructor(public san: string) {} }
class Game {
  moves: (Move | string)[] = ["a"];
  history(): string[];
  history(o: { verbose: true }): Move[];
  history(o: { verbose: boolean } = { verbose: false }) { return this.moves; }
}
const g = new Game();
const h = g.history();
g.moves.push("zz");
console.log(h.length);`,
    refused: "some",
  },
  {
    // A closure keeps the array past the return (Node: 2).
    id: "gh118-callee-captures",
    src: `let keep: () => number = () => 0;
function hist(): string[];
function hist(v: true): number[];
function hist(v?: boolean) {
  const out: (number | string)[] = [];
  keep = () => { out.push(1); return out.length; };
  out.push(v ? 1 : "a");
  return out;
}
const h = hist();
keep();
console.log(h.length);`,
    refused: "some",
  },
  {
    // A method that answers its receiver aliases it (Node: 2 true).
    id: "gh118-callee-aliases",
    src: `let last: (number | string)[] = [];
function hist(): string[];
function hist(v: true): number[];
function hist(v?: boolean) {
  const out: (number | string)[] = ["b", "a"];
  last = out.sort();
  return out;
}
const h = hist();
last.push("z");
console.log(h.length, last.length === 3);`,
    refused: "some",
  },
];

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const file = join(scratch, `${row.id}-${backend}.ts`);
  writeFileSync(file, row.src + "\n");
  const built = await build(row.id, file, backend);
  if (row.refused !== undefined) {
    expect(built.ok).toBe(false);
    if (built.ok) return;
    const s125 = built.diags.filter((d) => d.code === "SC1090" && S125.test(d.message));
    if (row.refused === "some") {
      expect(s125.length, JSON.stringify(built.diags)).toBeGreaterThan(0);
    } else {
      expect(s125.length, JSON.stringify(built.diags)).toBe(row.refused);
    }
    return;
  }
  if (!built.ok) throw new Error(`${row.id} refused on ${backend}: ${built.diags.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(file);
  expect(node.exitCode).toBe(0);
  const got = backend === "wasm" ? await wasmRun(built.path) : await nativeRun(built.path);
  expect(got).toEqual(node);
}

describe("GH #109: width copies keep identity or refuse (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #109: width copies keep identity or refuse (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
