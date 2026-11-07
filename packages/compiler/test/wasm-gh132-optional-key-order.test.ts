/* GH #132: a record keeps its own keys in Node's creation order. A record
 * filled in declared order stays on the fast path (no stored order); a
 * write that gives an optional field its key after a later field, an
 * explicit undefined written into an optional field, a literal spelling
 * one, or a delete moves it to its own stored order, which every key
 * surface reads — Object.keys/values/entries, for-in, JSON.stringify,
 * util.inspect, `in`, Object.hasOwn, spread, Object.assign and the shared
 * dynamic view (frontend/lowering/record-order.ts).
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh132-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source (written as main.ts unless `entry` names another). */
  src: string;
  entry?: string;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** A registered divergence: this tier prints `stdout` where Node prints
   * `node` (both asserted, so the row notices either side moving). */
  diverges?: { stdout: string; node: string; entry: string };
}

const ROWS: Row[] = [
  {
    id: "GH132-01 the issue's repro: a late optional key renders last, as in Node",
    src: `type R = { xx?: number; b: number };
const o: R = { b: 2 };
console.log("before");
o.xx = 4;
console.log(JSON.stringify(o), Object.keys(o));`,
  },
  {
    id: "GH132-02 the bracket spelling on an options interface",
    src: `interface Opts { verbose?: boolean; name: string }
const o: Opts = { name: "x" };
console.log("before");
o["verbose"] = true;
console.log(o);`,
  },
  {
    id: "GH132-03 two optional fields given their keys in reverse order",
    src: `type Q = { m?: number; n?: number };
const q: Q = {};
q.n = 2;
console.log("before", Object.keys(q));
q.m = 1;
console.log(q);`,
  },
  {
    id: "GH132-04 writes that keep Node's order run: an existing key, the last position, declared order",
    src: `type R = { xx?: number; b: number };
const p: R = { xx: 1, b: 2 };
p.xx = 5;
p["xx"] = 6;
console.log(JSON.stringify(p), Object.keys(p));
type T = { a: number; z?: string };
const t: T = { a: 1 };
t.z = "late";
for (const k in t) console.log("k", k);
console.log(t, Object.keys(t), JSON.stringify(t));
type Q = { m?: number; n?: number };
const q: Q = {};
q.m = 1;
q.n = 2;
q.m = 3;
console.log(q, Object.entries(q));`,
  },
  {
    id: "GH132-05 a function building its result field by field in declared order",
    src: `interface Row { id?: number; name?: string; tags?: string[] }
function build(i: number): Row {
  const r: Row = {};
  r.id = i;
  r.name = "n" + i;
  if (i % 2 === 0) r.tags = ["even"];
  return r;
}
console.log(Object.keys(build(1)), Object.keys(build(2)), JSON.stringify([build(3), build(4)]));`,
  },
  {
    id: "GH132-06 dynamic code writing the late key through a shared view",
    src: `type R = { x?: number; b: number };
const o: R = { b: 2 };
const aq: any = o;
console.log("before", Object.keys(aq));
aq.x = 5;
console.log(o.x, Object.keys(o));`,
  },
  {
    id: "GH132-07 a field cleared with undefined and filled again keeps its key, as in Node",
    src: `type E = { note?: string; hits?: number };
const e: E = { note: "a", hits: 1 };
e.note = undefined;
e.note = "b";
console.log(JSON.stringify(e), Object.keys(e));`,
  },
  {
    id: "GH132-08 a field the program also stores undefined into, given its key late",
    src: `type E = { note?: string; hits: number };
const e: E = { hits: 1 };
e.note = "late";
console.log(JSON.stringify(e));
const f: E = { note: "x", hits: 2 };
f.note = undefined;`,
  },
  {
    id: "GH132-10 every key surface reads the late order: keys, values, entries, for-in, JSON, inspect",
    src: `type R = { xx?: number; b: number; c?: string };
const o: R = { b: 2 };
o.c = "c";
o.xx = 4;
console.log(o, JSON.stringify(o), JSON.stringify(o, null, 1));
console.log(Object.keys(o), Object.values(o), Object.entries(o));
for (const k in o) console.log("k", k);
for (const [k, v] of Object.entries(o)) console.log(k, v);`,
  },
  {
    id: "GH132-11 an explicit undefined is an own key: in, hasOwn, keys, entries, printing",
    src: `type E = { note?: string; hits?: number };
const e: E = { note: "a", hits: 1 };
e.note = undefined;
console.log(e, Object.keys(e), "note" in e, Object.hasOwn(e, "note"), JSON.stringify(e), Object.entries(e));
const f: E = { hits: 3, note: undefined };
console.log(f, Object.keys(f), "note" in f);
const g: E = {};
g.hits = undefined;
console.log(g, Object.keys(g), "hits" in g, Object.values(g));`,
  },
  {
    id: "GH132-12 delete removes the key; refilling appends it",
    src: `type E = { note?: string; hits?: number };
const f: E = { note: "n", hits: 3 };
delete f.note;
console.log(f, Object.keys(f), "note" in f);
f.note = "z";
console.log(f, Object.keys(f), JSON.stringify(f));`,
  },
  {
    id: "GH132-13 spread and Object.assign copy the source's own order",
    src: `type R = { xx?: number; b: number };
const o: R = { b: 2 };
o.xx = 4;
const s: R = { ...o };
const s2: R = { ...o, b: 5 };
console.log(s, s2, Object.keys(s));
const t: R = { b: 9 };
Object.assign(t, o);
console.log(t, Object.keys(t), Object.assign({}, o));`,
  },
  {
    id: "GH132-14 records in arrays, nested records, factories and a shared view",
    src: `type R = { xx?: number; b: number };
const list: R[] = [{ b: 1 }, { b: 2 }];
for (const r of list) r.xx = r.b * 10;
console.log(list, JSON.stringify(list));
function mk(n: number): R { const r: R = { b: n }; if (n > 1) r.xx = n; return r; }
console.log(JSON.stringify([mk(1), mk(2)]));
type N = { inner: R; tag?: string };
const n: N = { inner: { b: 5 } };
n.inner.xx = 6;
n.tag = "t";
console.log(n, JSON.stringify(n));
const shared: any = n.inner;
console.log(shared, Object.keys(shared), JSON.stringify(shared));`,
  },
  {
    id: "GH132-15 integer-index keys order ascending ahead of the rest, whenever written",
    src: `enum E { A, B, C }
type Bins = { [K in E]?: string } & { label?: string };
const b: Bins = {};
b.label = "L";
b[2] = "two";
b[0] = "zero";
console.log(JSON.stringify(b), Object.keys(b), Object.entries(b));
type M = { 1?: string; x?: number };
const m: M = { x: 1 };
m[1] = "one";
console.log(JSON.stringify(m), Object.keys(m));`,
  },
  {
    id: "GH132-16 a shape with an optional unknown field: late keys, the left-out field, an explicit undefined, delete",
    src: `type R = { xx?: number; meta?: unknown; b: number };
const o: R = { b: 2 };
o.xx = 4;
console.log(Object.keys(o), o);
o.meta = { k: 1 };
console.log(Object.keys(o));
o.meta = undefined;
delete o.xx;
console.log(Object.keys(o), "meta" in o, "xx" in o);
const p: R = { b: 1, meta: undefined };
console.log(Object.keys(p), "meta" in p);`,
  },
  {
    id: "GH132-17 a literal holding undefined at run time, a spread with an explicit undefined",
    src: `type R = { a: number; w?: number };
const arr: number[] = [1];
const o: R = { a: 1, w: arr[5] };
console.log(o, Object.keys(o), "w" in o);
const m = new Map<string, number>();
const p: R = { a: 1, w: m.get("x")! };
console.log(Object.keys(p));
const base: R = { a: 1, w: 2 };
const s: R = { ...base, w: undefined };
console.log(s, Object.keys(s));`,
  },
  {
    id: "GH132-18 a literal spelled out of declared order keeps its spelling",
    src: `type R = { a?: number; b: number; c?: string };
const q: R = { b: 2, a: 3 };
const r: R = { c: "x", b: 1 };
const t: R = { a: 1, b: 2 };
console.log(Object.keys(q), JSON.stringify(q), Object.keys(r), Object.keys(t));
function pick(n: number): R { if (n > 0) return { b: n, a: n }; return { a: n, b: n }; }
console.log(JSON.stringify(pick(1)), JSON.stringify(pick(-1)), JSON.stringify(pick(1)) === JSON.stringify({ b: 1, a: 1 }));`,
  },
  {
    id: "GH132-19 a width copy into a wider type and a rest object keep the source's order",
    src: `type R = { a?: number; b: number; c?: number };
type R2 = { a?: number; b: number; c?: number; d?: string };
const o: R = { b: 1 };
o.a = 2;
o.c = undefined;
const w: R2 = o;
console.log(Object.keys(w));
const { b, ...rest } = o;
console.log(b, Object.keys(rest), rest);`,
  },
  {
    id: "GH132-20 160 optional fields written in reverse: every key in Node's order",
    src: (() => {
      const names = Array.from({ length: 160 }, (_, i) => "f" + i);
      return "type W = { " + names.map((n) => n + "?: number").join("; ") + " };\n" +
        "const r: W = {};\n" + [...names].reverse().map((n, i) => "r." + n + " = " + i + ";").join("\n") +
        "\nconsole.log(Object.keys(r).slice(0, 3), Object.keys(r).length, JSON.stringify(r).length);\n" +
        "const s: W = {};\ns.f0 = 1;\ns.f159 = 2;\ns.f80 = 3;\nconsole.log(Object.keys(s));";
    })(),
  },
  {
    id: "GH132-09 dynamic code rewriting a key the record already has runs",
    src: `type R = { x?: number; b: number };
const o: R = { x: 1, b: 2 };
const aq: any = o;
aq.x = 5;
aq.b = 6;
console.log(o, Object.keys(aq), JSON.stringify(aq));`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
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
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
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
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.diverges !== undefined) {
    expect(node.stdout, `${row.id}: Node's side of ${row.diverges.entry}`).toBe(row.diverges.node);
    expect(got, `${row.id}: this tier's side of ${row.diverges.entry}`).toEqual({ stdout: row.diverges.stdout, stderr: "", exitCode: 0 });
    return;
  }
  expect(got, row.id).toEqual(node);
}

describe("GH #132: a late optional key and the record's key order (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #132: a late optional key and the record's key order (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
