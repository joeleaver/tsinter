/* GH #247: for-in skips a key deleted before the walk reaches it.
 *
 * The record for-in walks a key list snapshotted at loop entry (keys added
 * during the walk are never visited, as in Node). Node additionally
 * re-checks each key's presence (HasProperty on the receiver) just before
 * visiting it, so a key deleted earlier in the same loop is skipped, and a
 * key deleted and re-added before its turn is visited. Every receiver kind
 * whose keys can disappear mid-walk carries that re-check now: records with
 * optional fields (interfaces, type literals, Partial<Record<lit-union>>,
 * hybrids with optional declared fields), pure Record<string, T> (already
 * guarded; pinned here), dynamic objects (JavaScript code, prototype chains
 * included), and arrays (pops; pinned here).
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-forin-live-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's file name (main.js or main.ts). */
  entry: string;
  src: string;
}

const ROWS: Row[] = [
  {
    id: "FL-01 an interface with an optional field: the issue's repro, a key deleted before its turn is skipped",
    entry: "main.ts",
    src: `interface J { a?: number; b: number; c: number }
const j: J = { c: 3, a: 1, b: 2 };
for (const k in j) { console.log(k); if (k === "c") delete j.a; }
console.log(Object.keys(j).join(","));`,
  },
  {
    id: "FL-02 a type literal in declared order: delete ahead, delete behind, delete then re-add before its turn (visited), and the current key deleted",
    entry: "main.ts",
    src: `type T = { a?: number; b?: number; c?: number; d: number };
const t1: T = { a: 1, b: 2, c: 3, d: 4 };
for (const k in t1) { if (k === "a") delete t1.c; console.log("ahead", k); }
const t2: T = { a: 1, b: 2, c: 3, d: 4 };
for (const k in t2) { if (k === "c") delete t2.a; console.log("behind", k); }
const t3: T = { a: 1, b: 2, c: 3, d: 4 };
for (const k in t3) { if (k === "a") { delete t3.b; t3.b = 9; } console.log("readd", k, k === "b" ? t3.b : "-"); }
const t4: T = { a: 1, b: 2, c: 3, d: 4 };
for (const k in t4) { if (k === "b") delete t4.b; console.log("self", k); }`,
  },
  {
    id: "FL-03 keys added during the walk are not visited; a key absent at entry and set mid-walk stays unvisited",
    entry: "main.ts",
    src: `interface O { a?: number; b: number; c?: number }
const o: O = { b: 1 };
for (const k in o) { if (k === "b") { o.a = 5; o.c = 6; } console.log(k); }
for (const k in o) console.log("again", k);`,
  },
  {
    id: "FL-04 the delete happens in a called function through an alias, and with assignment-target and var heads",
    entry: "main.ts",
    src: `interface J { a?: string; b?: string; c: string }
function drop(x: J, k: "a" | "b"): void { if (k === "a") delete x.a; else delete x.b; }
const j: J = { c: "c", a: "a", b: "b" };
const alias = j;
for (const k in j) { if (k === "c") drop(alias, "b"); console.log("const", k); }
const m: J = { a: "a", b: "b", c: "c" };
let key = "none";
for (key in m) { if (key === "a") delete m.b; console.log("target", key); }
console.log("after", key);
const n: J = { a: "a", b: "b", c: "c" };
for (var vk in n) { if (vk === "a") delete n.b; console.log("var", vk); }`,
  },
  {
    id: "FL-05 Partial<Record<lit-union>> and a Record<lit-union, T | undefined> spelled through an interface",
    entry: "main.ts",
    src: `type K = "x" | "y" | "z";
const r: Partial<Record<K, number>> = { x: 1, y: 2, z: 3 };
for (const k in r) { if (k === "x") delete r.z; console.log("partial", k); }
const r2: Partial<Record<K, number>> = { z: 3, y: 2, x: 1 };
for (const k in r2) { if (k === "z") delete r2.x; console.log("reordered", k); }`,
  },
  {
    id: "FL-06 a pure Record<string, T>: the existing live guard (delete ahead, delete and re-add)",
    entry: "main.ts",
    src: `const r: Record<string, number> = { p: 1, q: 2, s: 3 };
for (const k in r) { if (k === "p") delete r["s"]; console.log("rec", k); }
const r2: Record<string, number> = { p: 1, q: 2, s: 3 };
for (const k in r2) { if (k === "p") { delete r2["q"]; r2["q"] = 7; } console.log("readd", k, r2[k]); }`,
  },
  {
    id: "FL-07 a hybrid (declared optional fields and an index signature): a deleted declared field is skipped",
    entry: "main.ts",
    src: `interface H { a?: number; b?: number; [k: string]: number | undefined }
const h: H = { a: 1, b: 2 };
h["extra"] = 3;
for (const k in h) { if (k === "a") delete h.b; console.log("hyb", k); }`,
  },
  {
    id: "FL-08 dynamic objects in JavaScript: delete ahead, re-add, the issue's plain literal, and a key added mid-walk",
    entry: "main.js",
    src: `const j = { c: 1, a: 2, b: 3 };
for (const k in j) { if (k === "c") delete j.a; console.log(k); }
const q = { a: 1, b: 2, c: 3 };
for (const k in q) { if (k === "a") { delete q.b; q.b = 5; q.z = 1; } console.log("q", k, q[k]); }
const e = { a: 1, b: 2 };
for (const k in e) { if (k === "a") delete e[k === "a" ? "b" : "a"]; console.log("e", k); }`,
  },
  {
    id: "FL-09 dynamic objects with a prototype: an own key deleted while the prototype still has it is visited; an inherited key deleted from the prototype is skipped",
    entry: "main.js",
    src: `const p = { x: 1 };
const o = Object.create(p);
o.a = 1; o.x = 2; o.b = 3;
for (const k in o) { if (k === "a") delete o.x; console.log("own", k); }
const proto = { y: 1, z: 2 };
const o2 = Object.create(proto);
o2.a = 1;
for (const k in o2) { if (k === "a") delete proto.z; console.log("inh", k); }`,
  },
  {
    id: "FL-10 dynamic values that are not plain objects: a string, an array popped mid-walk, null",
    entry: "main.js",
    src: `function walk(v, f) { const out = []; for (const k in v) { f(v); out.push(k); } return out.join(","); }
console.log(walk("abc", () => {}));
console.log(walk([1, 2, 3, 4], (a) => { if (a.length === 4) a.pop(); }));
console.log(walk(null, () => {}), walk(undefined, () => {}));`,
  },
  {
    id: "FL-11 typed arrays popped mid-walk (pinned)",
    entry: "main.ts",
    src: `const xs = [1, 2, 3, 4];
for (const k in xs) { if (k === "0") xs.pop(); console.log("arr", k); }`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry);
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
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  expect(node.exitCode, JSON.stringify(node)).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("for-in re-checks presence before each visit (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("for-in re-checks presence before each visit (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
