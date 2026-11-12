/* Object keys in Set, Map, WeakMap and WeakSet (docs/design/object-keys.md).
 * Any value is a key, compared with SameValueZero exactly as Node does:
 * objects (records, class instances, arrays, functions, errors, maps and
 * sets, dynamic values) by identity, primitives by value (NaN equals NaN,
 * -0 is stored as +0), insertion order kept. A record and its view are one
 * key. A WeakMap/WeakSet refuses a primitive key with Node's TypeError and
 * prints `<items unknown>`. Adjacent: Map/Set/function Map values, and a
 * Map/Set arm beside undefined/null.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane. The scaling row pins the
 * O(1) identity hash (10k and 40k object keys, linear); the perf row pins
 * that a string-keyed Map loop pays nothing for it. */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";
import { cpuClockMs } from "./scaling-clock.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-objkey-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
}

const ROWS: Row[] = [
  {
    id: "OK-01 class instances, records and arrays are keys by identity",
    src: `class E { m: string; constructor(m: string) { this.m = m; } }
const s = new Set<E>();
const a = new E("a");
s.add(a); s.add(new E("b")); s.add(a);
console.log(s.size, s.has(a), s.has(new E("a")));
console.log(s);
for (const x of s) console.log(x.m);
const r1 = { k: 1 }, r2 = { k: 1 };
const m = new Map<{ k: number }, string>();
m.set(r1, "one"); m.set(r2, "two"); m.set(r1, "uno");
console.log(m.size, m.get(r1), m.get(r2), m.get({ k: 1 }));
console.log(m);
const arrs = new Map<number[], number>();
const xs = [1, 2];
arrs.set(xs, 3); arrs.set([1, 2], 4);
console.log(arrs.get(xs), arrs.size, arrs);
const tup = new Set<[string, number]>();
const t: [string, number] = ["a", 1];
tup.add(t); tup.add(["a", 1]); tup.add(t);
console.log(tup.size, tup.has(t), tup);`,
  },
  {
    id: "OK-02 errors, functions, Maps/Sets, booleans and unions as keys",
    src: `class AErr extends Error { constructor(m: string) { super(m); this.name = "AErr"; } }
const errs = new Set<AErr>();
const e1 = new AErr("x");
errs.add(e1); errs.add(e1); errs.add(new AErr("y"));
console.log(errs.size, errs.has(e1), errs.has(new AErr("x")));
const plain = new Map<Error, number>();
const er = new Error("boom");
plain.set(er, 1); plain.set(new TypeError("t"), 2); plain.set(er, 3);
console.log(plain.get(er), plain.size);
const fns = new Set<() => number>();
const f = () => 1;
const g = () => 2;
fns.add(f); fns.add(g); fns.add(f);
console.log(fns.size, fns.has(f), fns.has(() => 1));
const mk = new Map<Set<number>, string>();
const k1 = new Set([1]);
mk.set(k1, "a"); mk.set(new Set([1]), "b");
console.log(mk.get(k1), mk.size, mk);
const bs = new Set<boolean>([true, false, true]);
console.log(bs, bs.has(false), bs.size);
class N { id: number; constructor(id: number) { this.id = id; } }
const n1 = new N(1);
const ou = new Map<N | undefined, number>();
ou.set(undefined, 0); ou.set(n1, 1); ou.set(n1, 2);
console.log(ou.size, ou.get(undefined), ou.get(n1), ou.get(new N(1)));
const objs = new Map<object, string>();
const o1 = { z: 1 };
objs.set(o1, "o1"); objs.set([1], "arr"); objs.set(o1, "again");
console.log(objs.get(o1), objs.size, objs);`,
  },
  {
    id: "OK-03 NaN equals NaN and -0 is stored as +0 (number, union and dynamic keys)",
    src: `const u = new Map<string | number, string>();
u.set(NaN, "nan"); u.set(-0, "zero"); u.set("1", "s"); u.set(1, "n"); u.set(0 / 0, "nan2");
console.log(u.get(NaN), u.get(0), u.get(-0), u.get("1"), u.get(1), u.size, [...u.keys()], Object.is([...u.keys()][1], -0), u);
const ds = new Set<unknown>();
ds.add(0); ds.add(-0); ds.add(NaN); ds.add(NaN); ds.add("x"); ds.add(-0);
console.log(ds.size, ds.has(-0), ds.has(NaN), ds);
for (const d of ds) console.log(typeof d, d);
const ns = new Set<number | boolean>([-0, 0, NaN, true, 1]);
for (const v of ns) console.log(typeof v, Object.is(v, -0), Object.is(v, 0));
console.log(ns.size, ns);`,
  },
  {
    id: "OK-04 a record and its dynamic view are one key, both ways",
    src: `type R = { a: number };
const r: R = { a: 1 };
const other: R = { a: 1 };
const m = new Map<any, string>();
m.set(r, "rec");
const x: any = r;
console.log(m.get(x), m.get(r), m.has(other), m.size);
m.set(x, "again");
console.log(m.size, m.get(r), [...m.keys()][0] === r);
const arr = [1, 2, 3];
m.set(arr, "arr");
const ax: any = arr;
console.log(m.get(ax), m.get(arr), m.size);
const p = JSON.parse('{"q":1}');
m.set(p, "parsed");
console.log(m.get(p), m.get(JSON.parse('{"q":1}')), m.size);
const s = new Set<unknown>([1, "1", r, x, arr, ax]);
console.log(s.size, s);
const tm = new Map<R, number>();
tm.set(r, 7);
console.log(tm.get(x), tm.has(other));
const ws = new WeakSet<object>();
ws.add(r);
console.log(ws.has(x), ws.has(other));`,
  },
  {
    id: "OK-05 dynamic keys: every primitive kind and object identity",
    src: `const m = new Map<unknown, string>();
m.set(undefined, "u"); m.set(null, "n"); m.set(true, "t"); m.set(false, "f"); m.set(1, "1"); m.set("1", "s1");
m.set(NaN, "nan"); m.set("", "empty");
const o = JSON.parse('{"a":[1]}');
m.set(o, "o"); m.set(o.a, "oa");
console.log(m.size, m.get(undefined), m.get(null), m.get(true), m.get(false), m.get(1), m.get("1"), m.get(NaN), m.get(""), m.get(o), m.get(o.a));
console.log(m.has(JSON.parse('{"a":[1]}')), m.delete(null), m.has(null), m.size);
console.log(m);`,
  },
  {
    id: "OK-06 deletion and insertion during iteration, order after delete and re-add",
    src: `class N { id: number; constructor(id: number) { this.id = id; } }
const ns = [new N(0), new N(1), new N(2), new N(3)];
const s = new Set<N>(ns);
for (const n of s) { if (n.id === 1) s.delete(ns[2]!); if (n.id === 3) s.add(ns[2]!); }
console.log([...s].map((n) => n.id));
s.delete(ns[0]!); s.add(ns[0]!);
console.log(Array.from(s).map((n) => n.id));
s.forEach((v, v2) => console.log(v.id, v === v2));
const m = new Map<N, string>();
for (const n of ns) m.set(n, "v" + n.id);
let moved = false;
m.forEach((v, k) => { if (k.id === 0) m.delete(ns[1]!); if (k.id === 2 && !moved) { moved = true; m.delete(k); m.set(k, "back"); } });
const parts: string[] = [];
m.forEach((v, k) => parts.push(k.id + "=" + v));
console.log(parts);
m.delete(ns[3]!); m.set(ns[3]!, "end"); m.set(ns[0]!, "first-kept");
const parts2: string[] = [];
for (const k of m.keys()) parts2.push(k.id + "=" + m.get(k));
console.log(parts2, m.size);
m.clear();
console.log(m.size, m.get(ns[0]!), m);`,
  },
  {
    id: "OK-07 WeakMap and WeakSet: identity keys, Node's TypeError on a primitive key, <items unknown>",
    src: `class E { m: string; constructor(m: string) { this.m = m; } }
const a = new E("a");
const wm = new WeakMap<E, number>();
wm.set(a, 5); wm.set(new E("b"), 6);
console.log(wm.get(a), wm.has(new E("z")), wm.has(a), wm.delete(a), wm.has(a), wm);
const ws = new WeakSet<E>();
ws.add(a);
console.log(ws.has(a), ws, { w: { x: { y: ws } } }, { w: ws });
const dw = new WeakMap<object, number>();
const ds = new WeakSet<object>();
try { dw.set(1 as any, 2); } catch (e) { console.log((e as Error).name, (e as Error).message, e instanceof TypeError); }
try { ds.add("s" as any); } catch (e) { console.log((e as Error).name, (e as Error).message); }
try { dw.set(undefined as any, 2); } catch (e) { console.log((e as Error).message); }
try { dw.set(null as any, 2); } catch (e) { console.log((e as Error).message); }
console.log(dw.get(1 as any), dw.has("x" as any), dw.delete(3 as any), ds.has(true as any));
const k = { id: 1 };
dw.set(k, 9);
console.log(dw.get(k), dw.has({ id: 1 }));`,
  },
  {
    id: "OK-08 nested collections: Map/Set values, Map/Set arms beside undefined/null, inspect",
    src: `class N { id: number; constructor(id: number) { this.id = id; } }
const nested = new Map<string, Set<number>>();
nested.set("a", new Set([1, 2]));
nested.get("a")!.add(3);
nested.set("b", new Set());
console.log(nested, nested.get("zz"));
const deep = new Map<string, Map<string, Set<N>>>();
deep.set("a", new Map([["b", new Set([new N(0)])]]));
console.log(deep, { deep: { deeper: { x: deep } } });
const byObj = new Map<N, Map<N, number>>();
const n = new N(7);
byObj.set(n, new Map([[n, 1]]));
console.log(byObj.get(n)!.get(n), byObj);
const handlers = new Map<string, (x: number) => number>();
handlers.set("dbl", (x) => x * 2);
console.log(handlers.get("dbl")!(21), handlers.size, handlers.get("nope") === undefined);
let cache: Map<number, number[]> | null = null;
console.log(cache);
cache = new Map<number, number[]>();
cache.set(1, [1]);
console.log(cache?.get(1), cache);
class Holder {
  #deps: Set<N> | undefined;
  add(x: N): void { if (this.#deps === undefined) this.#deps = new Set(); this.#deps.add(x); }
  get n(): number { return this.#deps?.size ?? 0; }
}
const h = new Holder();
console.log(h.n);
h.add(n); h.add(n); h.add(new N(1));
console.log(h.n);`,
  },
  {
    id: "OK-09 different union key types with the same value type keep their own hash, equality and -0 rule (review fix)",
    src: `const opt = new Set<string | undefined>();
opt.add("x"); opt.add(undefined); opt.add("x");
const ids = new Set<string | number>();
ids.add("alpha"); ids.add("beta"); ids.add("gamma"); ids.add(-0); ids.add(0); ids.add(NaN); ids.add(NaN);
console.log(opt.size, ids.size, ids.has("zeta"), ids.has("beta"), ids.has(0), [...ids], opt);
class Base { id: number; constructor(id: number) { this.id = id; } }
class Other { z = 0; }
const b = new Base(1);
const s2 = new Set<Base | Other>();
s2.add(b); s2.add(new Other()); s2.add(b);
const s3 = new Set<Base | undefined>();
s3.add(undefined); s3.add(b); s3.add(undefined);
console.log(s2.size, s2.has(b), s3.size, s3.has(b), s3.has(undefined));
const m1 = new Map<string | undefined, number>();
m1.set(undefined, 1); m1.set("u", 2); m1.set(undefined, 3);
const m2 = new Map<number | string, number>();
m2.set(-0, 1); m2.set("a", 2); m2.set(0, 3); m2.set(NaN, 4); m2.set(NaN, 5);
const m3 = new Map<number | boolean, number>();
m3.set(true, 1); m3.set(1, 2); m3.set(-0, 3); m3.set(0, 4);
console.log(m1.size, m1.get(undefined), m2.size, m2.get(0), m2.get(NaN), m2, m3.size, m3);`,
  },
  {
    id: "OK-10 a dynamic RegExp and URL beside identity-keyed tables: a valid module, each payload told apart",
    src: `const m = new Map<unknown, number>();
const o: any = { k: 1 };
m.set(o, 1);
const r: any = /a+/g;
const u: any = new URL("https://example.com/p?q=1");
m.set(r, 2);
m.set(u, 3);
console.log(r.source, r.flags, m.get(o), m.get(r), m.get(u), m.size);
console.log(String(u), u.pathname, String(r));`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.ts");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "", timeout: 60_000 });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
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

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(row, backend);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("object keys in Set/Map/WeakMap/WeakSet (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("object keys in Set/Map/WeakMap/WeakSet (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});

/* ── scaling: the identity hash is O(1) ─────────────────────────────────
 * Each workload runs at N and 4N object keys (10k and 40k), best of
 * several runs, timed against the host's CPU clock: linear answers ≈ ×4,
 * a shared probe chain (O(n) per operation) ≥ ×16. */

const N = 10_000;
const RUNS = 3;
const RATIO_BOUND = 10;
const NOISE_FLOOR_MS = 3;
const SLOW_N_MS = 1500;

const SCALE_OPS: [string, string][] = [
  ["Set<class> add+has", "{ const s = new Set<C>(); const xs: C[] = []; for (let i = 0; i < n; i++) { const c = new C(i); xs.push(c); s.add(c); } let h = 0; for (const c of xs) if (s.has(c)) h++; return h + s.size; }"],
  ["Map<record> set+get", "{ const m = new Map<{ i: number }, number>(); const xs: { i: number }[] = []; for (let i = 0; i < n; i++) { const r = { i }; xs.push(r); m.set(r, i); } let t = 0; for (const r of xs) t += m.get(r) ?? 0; return t; }"],
  ["Set<number[]> visited", "{ const s = new Set<number[]>(); const xs: number[][] = []; for (let i = 0; i < n; i++) xs.push([i]); for (const x of xs) { if (!s.has(x)) s.add(x); } return s.size; }"],
  ["Map<any> parsed objects", "{ const m = new Map<any, number>(); const parts: string[] = []; for (let i = 0; i < n; i++) parts.push('{\"i\":' + i + '}'); const xs: any[] = JSON.parse('[' + parts.join(',') + ']'); for (let i = 0; i < n; i++) m.set(xs[i], i); let t = 0; for (let i = 0; i < n; i++) t += m.get(xs[i]) ?? 0; return t + m.size; }"],
  ["WeakMap<class> memo", "{ const w = new WeakMap<C, number>(); const xs: C[] = []; for (let i = 0; i < n; i++) { const c = new C(i); xs.push(c); w.set(c, i * 2); } let t = 0; for (const c of xs) t += w.get(c) ?? 0; return t; }"],
];

function scaleProgram(): string {
  const lines: string[] = ["class C { v: number; constructor(v: number) { this.v = v; } }"];
  SCALE_OPS.forEach(([, body], i) => lines.push(`function op${i}(n: number): number ${body}`));
  lines.push("function best(f: (n: number) => number, n: number): number {");
  lines.push("  let t = Infinity;");
  lines.push(`  for (let r = 0; r < ${RUNS}; r++) {`);
  lines.push("    const t0 = performance.now();");
  lines.push("    f(n);");
  lines.push("    const dt = performance.now() - t0;");
  lines.push("    if (dt < t) t = dt;");
  lines.push(`    if (dt > ${SLOW_N_MS}) break;`);
  lines.push("  }");
  lines.push("  return t;");
  lines.push("}");
  lines.push(`const fs: ((n: number) => number)[] = [${SCALE_OPS.map((_, i) => `op${i}`).join(", ")}];`);
  lines.push("for (let i = 0; i < fs.length; i++) {");
  lines.push(`  const tn = best(fs[i]!, ${N});`);
  lines.push(`  const slow = tn > ${SLOW_N_MS};`);
  lines.push(`  const t4n = slow ? -1 : best(fs[i]!, ${4 * N});`);
  lines.push("  console.log('T ' + i + ' ' + tn + ' ' + t4n);");
  lines.push(`  console.log('R ' + i + ' ' + fs[i]!(${N}) + ' ' + (slow ? 'skipped' : fs[i]!(${4 * N})));`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

test("OK-SCALE-01 object-keyed Set/Map/WeakMap operations scale linearly (10k and 40k keys) and agree with Node", async () => {
  const entry = join(scratch, "objkey-scaling.ts");
  writeFileSync(entry, scaleProgram());
  const res = await compile(entry, { outPath: join(scratch, "objkey-scaling.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const r = await runWasm(res.binaryPath!, { imports: { now: cpuClockMs } });
  expect(r.stderr).toBe("");
  const out = String(r.stdout).split("\n");
  const node = execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", entry], { encoding: "utf8" }).split("\n");
  const bad: string[] = [];
  const timings = out.filter((l) => l.startsWith("T "));
  expect(timings.length).toBe(SCALE_OPS.length);
  for (const line of timings) {
    const [, i, tn, t4n] = line.split(" ");
    const name = SCALE_OPS[Number(i)]![0];
    const small = Number(tn);
    const big = Number(t4n);
    if (big < 0) {
      bad.push(`${name}: ${small.toFixed(0)} ms at ${N} keys — the quadratic path`);
      continue;
    }
    if (big < NOISE_FLOOR_MS) continue;
    const ratio = big / Math.max(small, 0.05);
    if (ratio > RATIO_BOUND) bad.push(`${name}: ×${ratio.toFixed(1)} for ×4 input (${small.toFixed(2)} → ${big.toFixed(2)} ms)`);
  }
  expect(bad).toEqual([]);
  expect(out.filter((l) => l.startsWith("R "))).toEqual(node.filter((l) => l.startsWith("R ")));
}, 600_000);

/* ── perf: a string-keyed Map loop pays nothing ──────────────────────────
 * The same string-keyed Map workload compiled alone (no identity-keyed
 * container: the module layout is the pre-object-keys one) and beside an
 * object-keyed Set (records, vectors and class instances carry the hash
 * slot). The string-keyed path's code is the same in both; the bound
 * catches a regression that leaked into it. Measured numbers are printed
 * for the report. */

const STR_LOOP = `function strLoop(n: number): number {
  const m = new Map<string, number>();
  for (let i = 0; i < n; i++) m.set("k" + (i % 5000), i);
  let t = 0;
  for (let i = 0; i < n; i++) t += m.get("k" + (i % 5000)) ?? 0;
  for (const [k, v] of m) if (k.length > 3) t -= v;
  return t;
}
function best(n: number): number {
  let t = Infinity;
  for (let r = 0; r < 5; r++) { const t0 = performance.now(); strLoop(n); const dt = performance.now() - t0; if (dt < t) t = dt; }
  return t;
}
`;

async function timeStrLoop(name: string, extra: string): Promise<{ ms: number; out: string }> {
  const entry = join(scratch, `${name}.ts`);
  writeFileSync(entry, STR_LOOP + extra + "console.log('T ' + best(200000));\nconsole.log('R ' + strLoop(200000));\n");
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const r = await runWasm(res.binaryPath!, { imports: { now: cpuClockMs } });
  expect(r.stderr).toBe("");
  const lines = String(r.stdout).split("\n");
  const node = execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", entry], { encoding: "utf8" }).split("\n");
  expect(lines.filter((l) => l.startsWith("R "))).toEqual(node.filter((l) => l.startsWith("R ")));
  return { ms: Number(lines.find((l) => l.startsWith("T "))!.slice(2)), out: lines.join("\n") };
}

test("OK-PERF-01 a string-keyed Map loop is as fast beside an object-keyed container as without one", async () => {
  const plain = await timeStrLoop("strloop-plain", "");
  const keyed = await timeStrLoop(
    "strloop-objkeys",
    "class C { v = 1; }\nconst seen = new Set<C>();\nconst c0 = new C();\nseen.add(c0);\nconsole.log('S ' + seen.has(c0));\n",
  );
  console.log(`OK-PERF-01 string-keyed Map loop (200k ops, best of 5): plain ${plain.ms.toFixed(2)} ms, beside object keys ${keyed.ms.toFixed(2)} ms`);
  expect(keyed.ms).toBeLessThan(plain.ms * 1.5 + 5);
}, 600_000);
