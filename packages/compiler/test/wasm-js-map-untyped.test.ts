/* GH #183 / #185: JavaScript's untyped `new Map()` (and `new WeakMap()` /
 * `new WeakSet()`) lowered as board #218's opaque container object with no
 * entries and no methods, so `m.set(k, v)` threw an ordinary, catchable
 * `TypeError: m.set is not a function` where Node runs — through closures
 * and functions stored on dynamic objects too (lodash's memoize). The
 * container object now carries a typed table of dynamic keys and values
 * (SEMANTICS.md S015's #218 amendment): its methods, `size`, iteration,
 * inspection, structuredClone and deep equality answer from it, while
 * everything board #218 made exact (identity, own properties, string
 * conversion, the class texts) is unchanged. What still has no form stops
 * by name: a method value called on another class's receiver, a
 * keys()/values()/entries() iterator used other than by
 * iterating it, and a showHidden preview of a non-empty weak collection.
 *
 * An exact row equals Node (spawned at test time); a `fence` row prints
 * Node's stdout up to the named fence and ends there. Both wasm lanes. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-js-map-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  /** main.js unless set */
  entry?: string;
  /** absent: equals Node */
  fence?: { text: RegExp; stdout: string };
  /** A REGISTERED divergence: the compiled run prints exactly this, and
   * Node prints something else (the SEMANTICS entry the row names). */
  registered?: { stdout: string };
}

const ROWS: Row[] = [
  {
    id: "JSMAP-01 #183: set / get / has / size on an untyped Map",
    src: `const m = new Map();
m.set({}, 1);
m.set("a", 1);
m.set("a", 2);
console.log(m.size, m.has("a"), m.get("a"), m.get("zz"), m.has({}), m.set("b", 3) === m);`,
  },
  {
    id: "JSMAP-02 object keys by identity, delete, clear, forEach, for-of, spread keys/values, printing",
    src: `const m = new Map();
const key = {};
m.set(key, "obj");
m.set({ k: 1 }, [2]);
m.set(1, null);
console.log(m.get(key), m.get({}), m);
for (const [k, v] of m) console.log(typeof k, v);
for (const [k, v] of m.entries()) console.log("e", typeof k, v);
m.forEach((v, k, self) => console.log("fe", v, typeof k, self === m));
console.log([...m.keys()].length, [...m.values()].length);
console.log(m.delete(key), m.delete(key), m.size, m);
m.clear();
console.log(m.size, m);`,
  },
  {
    id: "JSMAP-03 #185: a function stored on a dynamic object calls set on a module Map",
    src: `const reg = new Map();
const api = JSON.parse("{}");
api.add = function (k, v) { reg.set(k, v); return reg.size; };
console.log(api.add("a", 1), api.add("b", 2), reg.get("b"));`,
  },
  {
    id: "JSMAP-04 #185: lodash's memoize shape (a Map captured by the returned closure)",
    src: `function memoize(func) {
  var cache = new Map();
  return function (k) {
    if (cache.has(k)) return cache.get(k);
    var r = func(k);
    cache.set(k, r);
    return r;
  };
}
let calls = 0;
const up = memoize(function (s) { calls++; return s.toUpperCase(); });
console.log(up("a"), up("a"), up("b"), calls);`,
  },
  {
    id: "JSMAP-05 a module Map and WeakMap used from a class and from plain functions",
    src: `const priv = new WeakMap();
class Counter {
  constructor() { priv.set(this, { n: 0 }); }
  inc() { const s = priv.get(this); s.n++; return s.n; }
}
const c = new Counter();
c.inc();
console.log(c.inc(), priv.has(c));
const p2 = new Map();
function f(k) { p2.set(k, (p2.get(k) ?? 0) + 1); return p2.get(k); }
f("x");
console.log(f("x"), p2);`,
  },
  {
    id: "JSMAP-06 a Map stored in and read back from dynamic values keeps its identity and entries",
    src: `const m = new Map();
m.set("a", 1);
const holder = JSON.parse("{}");
holder.m = m;
holder.m.set("b", 2);
console.log(holder.m === m, m.size, holder.m.get("a"), holder);
module.exports = { m };
console.log("exported");`,
    entry: "main.cjs",
  },
  {
    id: "JSMAP-07 untyped WeakMap and WeakSet: identity keys, Node's TypeErrors for primitive keys",
    src: `const w = new WeakMap();
const k = {};
const k2 = [1];
w.set(k, 1);
w.set(k2, { v: 2 });
console.log(w.get(k), w.has(k), w.get(k2), w.has({}), w.get({}), w.get("s"), w.has(1));
console.log(w.delete(k), w.has(k), w.delete(k));
try { w.set("str", 1); } catch (e) { console.log(e instanceof TypeError, e.message); }
const ws = new WeakSet();
ws.add(k);
try { ws.add(1); } catch (e) { console.log(e instanceof TypeError, e.message); }
console.log(ws.has(k), ws.has({}), ws.delete(k), ws.has(k), w, ws);`,
  },
  {
    id: "JSMAP-08 inspection: nested, beyond the depth, circular, Node's line breaking; own properties after the entries",
    entry: "main.cjs",
    src: `const util = require("util");
const m = new Map();
m.set("a", { n: 1 });
m.set(2, [3]);
m.x = "own";
console.log(m, util.inspect(m, { depth: 0 }), [m]);
console.log({ deep: { deeper: { m } } });
const big = new Map();
for (let i = 0; i < 30; i++) big.set("k" + i, i);
console.log(big);
const nested = new Map();
nested.set("inner", m);
nested.set(nested, "self");
console.log(nested);
console.log(util.format("%o", m));
console.log(JSON.stringify(m), Object.keys(m), { ...m }, String(m));`,
  },
  {
    id: "JSMAP-09 structuredClone copies the entries (cloned), never the own properties; deep equality compares the entries",
    entry: "main.cjs",
    src: `const assert = require("assert");
const m = new Map();
m.set("a", { n: 1 });
m.set(2, [3]);
m.x = "own";
const c = structuredClone(m);
c.get("a").n = 5;
console.log(m, c, c.x, m.get("a").n);
const m2 = new Map();
m2.set("a", { n: 1 });
m2.set(2, [3]);
m2.x = "own";
assert.deepStrictEqual(m, m2);
m2.set(2, [4]);
assert.notDeepStrictEqual(m, m2);
const m3 = new Map();
m3.set("a", { n: 1 });
m3.x = "own";
assert.notDeepStrictEqual(m, m3);
console.log("ok");`,
  },
  {
    id: "JSMAP-10 a keys() iterator used as an iterator (not just iterated) stops by name",
    src: `const m = new Map();
m.set("a", 1);
console.log("before");
const it = m.keys();
console.log(it.next());`,
    fence: { text: /Map\.prototype\.keys\(\) on an untyped Map/, stdout: "before\n" },
  },
  {
    id: "JSMAP-11 %o over a non-empty WeakMap (Node previews its entries) stops by name (S114 (d))",
    entry: "main.cjs",
    src: `const util = require("util");
const w = new WeakMap();
w.set({}, 1);
console.log("before");
console.log(util.format("%o", w));`,
    fence: { text: /util\.inspect of a WeakMap inside the scriptc island/, stdout: "before\n" },
  },
  {
    id: "JSMAP-12 (review) for-of over a Map and its keys()/values()/entries() walks live: deletes and adds during the loop are seen",
    src: `"use strict";
const n = new Map();
n.set("a", 1); n.set("b", 2);
for (const [k, v] of n) { console.log(k, v); if (k === "a") { n.delete("b"); n.set("z", 0); } }
for (const k of n.keys()) { console.log("key", k); if (k === "a") n.set("y", 9); }
for (const v of n.values()) console.log("val", v);
for (const e of n.entries()) { console.log("ent", e); if (e[0] === "a") n.set("a", 100); }
let count = 0;
for (const [k] of n) { if (count++ > 1) break; console.log("brk", k); }
n.set("after", 1);
n.delete("z");
console.log(n.size, n);`,
  },
  {
    id: "JSMAP-13 (review) forEach: thisArg, entries added after clear() inside the callback, a key deleted and re-added is visited again",
    src: `"use strict";
const n = new Map();
n.set("a", 1); n.set("b", 2);
const ctx = { tag: "T" };
n.forEach(function (v, k) { console.log(this === ctx, this.tag, k); }, ctx);
n.forEach(function () { console.log(this === undefined); });
const c = new Map(); c.set("v", 1);
c.forEach((v, k, self) => { console.log("v", v); if (v === 1) { self.clear(); self.set("w", 3); } });
const loop = new Map(); loop.set("k", 0);
let visits = 0;
loop.forEach((v, k, self) => { visits++; if (visits < 7) { self.delete(k); self.set(k, visits); } });
console.log(visits, loop);`,
  },
  {
    id: "JSMAP-14 (review) inspection stops at 100 entries with Node's '... n more items', nested too",
    src: `const m = new Map();
for (let i = 0; i < 101; i++) m.set(i, i);
console.log(m);
const m2 = new Map();
for (let i = 0; i < 103; i++) m2.set("k" + i, [i]);
console.log({ m2 });`,
  },
  {
    id: "JSMAP-15 (review) computed-key calls and method values: one function per class and name, .call, own properties shadow",
    src: `"use strict";
const m = new Map();
const name = "set";
m[name]("a", 1);
console.log(m["get"]("a"), m.size);
const s = m.set;
s.call(m, "b", 2);
console.log(m.get("b"), typeof m.get, m.get === new Map().get, m.has === new WeakMap().has);
console.log(["a", "b"].map((k) => m.get(k)));
const w = new WeakMap();
const k = {};
w["set"](k, 7);
console.log(w.get(k));
m.get = function () { return "own"; };
console.log(m.get("a"), m.has("a"));`,
  },
  {
    id: "JSMAP-16 (review) a Map method value called on another kind of receiver stops by name (Node throws a TypeError)",
    src: `"use strict";
const s = new Map().set;
console.log("before");
try { s.call({}, 1, 2); } catch (e) { console.log("caught", e.constructor.name); }`,
    fence: { text: /Map\.prototype\.set called on a receiver that is not an untyped Map/, stdout: "before\n" },
  },
  {
    id: "JSMAP-18 (S042's U3+U4 amendment) a sloppy forEach callback sees a null or primitive thisArg itself, where Node passes globalThis or the wrapper object",
    src: `const m = new Map();
m.set("a", 1);
m.forEach(function () { console.log(this === null, typeof this); }, null);
m.forEach(function () { console.log(typeof this, this === 5); }, 5);
m.forEach(function () { console.log(this.tag); }, { tag: "obj" });`,
    registered: { stdout: "true object\nnumber true\nobj\n" },
  },
  {
    id: "JSMAP-17 (review) `in` finds the class prototype's members (static and runtime keys, through a dynamic value too); own-key tests do not",
    src: `"use strict";
const m = new Map(); m.set("a", 1);
const w = new WeakMap(); const s = new WeakSet();
console.log("size" in m, "get" in m, "forEach" in m, "constructor" in m, "add" in m, "x" in m, "a" in m);
console.log("get" in w, "size" in w, "add" in s, "get" in s, "constructor" in s);
const names = ["size", "keys", "nope"];
for (const n of names) console.log(n, n in m);
console.log(Object.hasOwn(m, "size"), Object.hasOwn(m, "get"), Object.keys(m));
m.x = 1;
console.log("x" in m, Object.hasOwn(m, "x"));
const h = JSON.parse("{}"); h.m = m; console.log(h.m.hasOwnProperty("get"), h.m.hasOwnProperty("x"), "size" in h.m);`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.js");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
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
  const dir = dirname(entry);
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: join(dir, "out"), backend });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  if (row.fence !== undefined) {
    const got: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(got.stdout)).toBe(true);
    expect(got.stderr.split("\n")[0]).toMatch(/^tsinter: unsupported: /);
    expect(got.stderr.split("\n")[0]).toMatch(row.fence.text);
    return;
  }
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  if (row.registered !== undefined) {
    expect(got).toEqual({ stdout: row.registered.stdout, stderr: "", exitCode: 0 });
    expect(node.stdout).not.toBe(row.registered.stdout);
    return;
  }
  expect(got).toEqual(node);
}

describe("GH #183/#185: untyped JavaScript Map / WeakMap / WeakSet (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #183/#185: untyped JavaScript Map / WeakMap / WeakSet (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
