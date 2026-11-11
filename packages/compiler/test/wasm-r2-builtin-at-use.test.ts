/* R2 (SEMANTICS.md S129): an import of a Node builtin module this build
 * does not serve (node:v8, node:sqlite, node:readline/promises, named
 * imports of node:process, ...) no longer refuses the build at the import.
 * The imported binding is a stub: the program runs as Node does until the
 * first statement that touches it (a call, a member read, passing it as a
 * value, reading it through a re-export), which stops at the named
 * run-time fence `tsinter: unsupported: the 'node:v8' module (...) is not
 * supported yet [SC1010 at <file>:<line>]`, exit 1, after the stdout the
 * program printed so far (a prefix of Node's). A program that imports the
 * module and never touches it matches Node byte for byte. Modules whose
 * IMPORT is observable in Node (a deprecation or experimental warning, or
 * domain's EventEmitter switch) keep the compile-time refusal.
 *
 * `import process from "node:process"` is Node's global process object and
 * lowers as `process` (like `const process = require("node:process")`).
 *
 * Every row runs under Node (spawned at test time) and on the wasm lane,
 * then on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { STUB_BUILTIN_EXPORTS } from "../src/frontend/stub-builtin-exports.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
/* The rows are projects with @types/node installed (the shape of every
 * real project that imports these modules): the vendored, pinned copy in
 * the node-types fixture. Without @types/node the shipped fallback
 * declarations type only the supported modules, and the import is a type
 * error, as before. */
const nodeTypes = join(import.meta.dirname, "../../../tests/fixtures/node-types/node_modules");
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true } });
const scratch = mkdtempSync(join(tmpdir(), "tsinter-r2-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** file name → source; the entry is `main.ts` or `main.js`. */
  files: Record<string, string>;
  /** Ends at the stub's run-time fence for `module`, at `file:line`, after
   * printing exactly `stdout` (a prefix of Node's). */
  fence?: { module: string; at: string; stdout: string };
  /** Node refuses the program at link time (exit 1, no stdout) with this
   * error text; the compiled program reports the same. */
  startup?: string;
}

const V8 = "the 'node:v8' module (it observes V8 engine internals";

const ROWS: Row[] = [
  {
    id: "R2-01 a named import never used",
    files: {
      "main.ts": `import { getHeapStatistics } from "node:v8";
console.log("hello", 1 + 2);`,
    },
  },
  {
    id: "R2-02 a use in a cold branch never taken",
    files: {
      "main.ts": `import { getHeapStatistics } from "node:v8";
function headroom(limit: number): number {
  if (limit < 0) {
    const s = getHeapStatistics();
    return s.heap_size_limit - s.used_heap_size;
  }
  return limit * 2;
}
console.log(headroom(21));`,
    },
  },
  {
    id: "R2-03 a call stops at the fence after Node's stdout so far",
    files: {
      "main.ts": `import { getHeapStatistics } from "node:v8";
console.log("before");
const s = getHeapStatistics();
console.log("after", s.total_heap_size > 0);`,
    },
    fence: { module: V8, at: "main.ts:3", stdout: "before\n" },
  },
  {
    id: "R2-04 a namespace import: unused functions build, a member call stops",
    files: {
      "main.ts": `import * as v8 from "node:v8";
function cold(): number { return v8.getHeapStatistics().used_heap_size; }
function hot(n: number): number { return n + 1; }
console.log(hot(1));
if (hot(0) > 5) console.log(cold());
console.log("then");
console.log(v8.getHeapStatistics().total_heap_size > 0);
console.log("unreached");`,
    },
    fence: { module: V8, at: "main.ts:7", stdout: "2\nthen\n" },
  },
  {
    id: "R2-05 several named imports and a default import, never touched",
    files: {
      "main.ts": `import v8, { getHeapStatistics, serialize, deserialize } from "node:v8";
export function snapshot(): unknown { return deserialize(serialize({ a: 1 })); }
export const heap = (): number => getHeapStatistics().used_heap_size;
export class Probe { read(): number { return v8.getHeapStatistics().heap_size_limit; } }
const probe = new Probe();
console.log("ok", typeof heap, typeof probe);`,
    },
  },
  {
    id: "R2-06 an expression-bodied arrow over a stub: defining it runs, calling it stops",
    files: {
      "main.ts": `import { getHeapStatistics } from "node:v8";
const heap = (): number => getHeapStatistics().used_heap_size;
console.log("defined", typeof heap);
console.log(heap() > 0);`,
    },
    fence: { module: V8, at: "main.ts:2", stdout: "defined function\n" },
  },
  {
    id: "R2-07 a stub passed as a value stops at the statement that passes it",
    files: {
      "main.ts": `import { getHeapStatistics } from "node:v8";
function call(f: () => unknown): string { return typeof f(); }
console.log("first");
console.log(call(getHeapStatistics));`,
    },
    fence: { module: V8, at: "main.ts:4", stdout: "first\n" },
  },
  {
    id: "R2-08 require(\"node:v8\") in JavaScript: unused, then a member call",
    files: {
      "main.js": `const v8 = require("node:v8");
const { getHeapStatistics } = require("node:v8");
function cold() { return getHeapStatistics().used_heap_size; }
console.log("start", typeof cold);
console.log(v8.getHeapStatistics().total_heap_size > 0);`,
    },
    fence: { module: "the 'node:v8' module (it observes V8 engine internals", at: "main.js:5", stdout: "start function\n" },
  },
  {
    id: "R2-09 require(\"node:v8\") in JavaScript, never touched",
    files: {
      "main.js": `const v8 = require("node:v8");
const { serialize } = require("node:v8");
require("node:v8");
exports.cold = function () { return serialize(v8.cachedDataVersionTag()); };
console.log("ok", typeof exports.cold);`,
    },
  },
  {
    id: "R2-10 re-exports: a named re-export and a local export of the import, untouched",
    files: {
      "heap.ts": `export { getHeapStatistics } from "node:v8";
import { serialize } from "node:v8";
export { serialize };
export function size(n: number): number { return n * 3; }`,
      "main.ts": `import { getHeapStatistics, serialize, size } from "./heap.ts";
function cold(): unknown { return [getHeapStatistics(), serialize(1)]; }
console.log(size(4), typeof cold);`,
    },
  },
  {
    id: "R2-11 re-exports: the importer's call through a re-export stops",
    files: {
      "heap.ts": `export { getHeapStatistics as stats } from "node:v8";
export const label = "heap";`,
      "main.ts": `import { stats, label } from "./heap.ts";
console.log(label);
console.log(stats().used_heap_size > 0);`,
    },
    fence: { module: V8, at: "main.ts:3", stdout: "heap\n" },
  },
  {
    id: "R2-12 paperclip's shape: node:sqlite, node:readline/promises and named node:process imports, never touched",
    files: {
      "main.ts": `import { DatabaseSync } from "node:sqlite";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
async function ask(q: string): Promise<string> {
  const rl = createInterface({ input, output });
  try { return await rl.question(q); } finally { rl.close(); }
}
function open(p: string): unknown { return new DatabaseSync(p); }
console.log("cli", typeof ask, typeof open);`,
    },
  },
  {
    id: "R2-13 node:sqlite: a constructor call stops",
    files: {
      "main.ts": `import { DatabaseSync } from "node:sqlite";
console.log("open");
const db = new DatabaseSync(":memory:");
console.log(typeof db);`,
    },
    fence: { module: "the 'node:sqlite' module (it wraps the SQLite library", at: "main.ts:3", stdout: "open\n" },
  },
  {
    id: "R2-14 import process from \"node:process\" is the global process",
    files: {
      "main.ts": `import process from "node:process";
console.log(process.argv.length >= 1, process.env.R2_UNSET_VAR ?? "unset");
process.stdout.write("written\\n");
process.exit(3);`,
    },
  },
  {
    id: "R2-15 a stub inside a function an exported caller never reaches, in a JavaScript module",
    files: {
      "main.mjs": `import { getHeapStatistics } from "node:v8";
import * as inspector from "node:inspector";
export function heap() { return getHeapStatistics().used_heap_size; }
function debugUrl() { return inspector.url(); }
console.log("esm", typeof heap, typeof debugUrl);`,
    },
  },
  {
    id: "R2-16 a stub in the cold arm of a module-level ?: and a cold default parameter",
    files: {
      "main.ts": `import * as v8 from "node:v8";
const big = process.argv.length > 99;
const lim = big ? v8.getHeapStatistics().heap_size_limit : 1024;
function f(x: number = v8.getHeapStatistics().used_heap_size): number { return x; }
console.log("lim", lim, f(2));`,
    },
  },
  {
    id: "R2-17 a function returning a type the stub module declares compiles; calling it stops at the touch inside",
    files: {
      "main.ts": `import { getHeapStatistics, type HeapInfo } from "node:v8";
function stats(): HeapInfo { return getHeapStatistics(); }
function limit(): number { return stats().heap_size_limit; }
console.log("a", process.argv.length > 99 ? limit() : 0);
console.log(limit() > 0);`,
    },
    fence: { module: V8, at: "main.ts:2", stdout: "a 0\n" },
  },
  {
    id: "R2-18 a touch after an await stops there",
    files: {
      "main.ts": `import { getHeapStatistics } from "node:v8";
async function f(): Promise<number> { await null; return getHeapStatistics().used_heap_size; }
async function main(): Promise<void> {
  console.log("d1");
  if (process.argv.length > 99) console.log(await f());
  console.log("d2");
  await f();
  console.log("d3");
}
void main();`,
    },
    fence: { module: V8, at: "main.ts:2", stdout: "d1\nd2\n" },
  },
  {
    id: "R2-19 a shorthand property over a require binding in JavaScript: reading the member stops, naming the shorthand",
    files: {
      "main.js": `const v8 = require("v8");
const deps = { v8 };
console.log("a");
try { console.log(deps.v8.getHeapStatistics().used_heap_size > 0); } catch (e) { console.log("caught", e.constructor.name); }
console.log("unreached");`,
    },
    fence: { module: "the 'v8' module (it observes V8 engine internals", at: "main.js:2", stdout: "a\n" },
  },
  {
    id: "R2-20 a shorthand property over a named import in TypeScript stops at its statement",
    files: {
      "main.ts": `import { getHeapStatistics } from "node:v8";
console.log("a");
const o = { getHeapStatistics };
console.log(typeof o.getHeapStatistics);`,
    },
    fence: { module: V8, at: "main.ts:3", stdout: "a\n" },
  },
  {
    id: "R2-21 a shorthand of a re-exported default namespace stops where it is built",
    files: {
      "m.mjs": `import * as v8 from "node:v8";
export default v8;`,
      "main.mjs": `import d from "./m.mjs";
console.log("a");
console.log(typeof d, typeof d.serialize);
const o = { d };
console.log(typeof o.d);`,
    },
    fence: { module: V8, at: "main.mjs:4", stdout: "a\nobject function\n" },
  },
  {
    id: "R2-22 a named import Node's module does not export is Node's link-time SyntaxError",
    files: {
      "main.ts": `import { SourceTextModule } from "node:vm";
console.log("hi");
export function compile(src: string) { return new SourceTextModule(src); }`,
    },
    startup: "SyntaxError: The requested module 'node:vm' does not provide an export named 'SourceTextModule'",
  },
  {
    id: "R2-23 unprefixed require of a stub builtin inside try (the optional-dependency probe) finds it",
    files: {
      "main.js": `let ok = true;
try { require("v8"); } catch (e) { ok = false; }
let insp = true;
try { require("inspector"); } catch { insp = false; }
require("vm");
console.log("has v8:", ok, "inspector:", insp);`,
    },
  },
  {
    id: "R2-24 createRequire's require of a stub builtin in statement position loads nothing observable",
    files: {
      "main.ts": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let ok = true;
try { require("vm"); require("node:v8"); } catch (e) { ok = false; }
console.log("has vm:", ok);`,
    },
  },
  {
    id: "R2-25 a class field and a parameter typed by the stub module compile (paperclip's shape)",
    files: {
      "main.ts": `import { DatabaseSync } from "node:sqlite";
import type { HeapInfo } from "node:v8";
class Store { db: DatabaseSync | null = null; open(p: string): void { this.db = new DatabaseSync(p); } }
function used(h: HeapInfo): number { return h.used_heap_size; }
const s = new Store();
console.log("a", s.db === null, typeof used);
s.open(":memory:");
console.log("unreached");`,
    },
    fence: { module: "the 'node:sqlite' module (it wraps the SQLite library", at: "main.ts:3", stdout: "a true function\n" },
  },
  {
    id: "R2-26 a program's own value of a type the stub module declares reads as Node does",
    files: {
      "main.ts": `import type { HeapInfo } from "node:v8";
function used(h: HeapInfo): number { return h.used_heap_size; }
const h = { used_heap_size: 5 } as HeapInfo;
console.log(used(h), h.used_heap_size + 1);`,
    },
  },
  {
    id: "R2-27 feature detection: typeof of an export Node's vm lacks without flags is \"undefined\" (CommonJS destructuring)",
    files: {
      "main.js": `const { SourceTextModule } = require("node:vm");
if (typeof SourceTextModule === "function") console.log("esm vm on"); else console.log("esm vm off");
const { Module, SyntheticModule } = require("vm");
console.log(typeof Module, typeof SyntheticModule);`,
    },
  },
  {
    id: "R2-28 feature detection off the namespace in TypeScript",
    files: {
      "main.ts": `import * as vm from "node:vm";
const on = typeof vm.SourceTextModule === "function";
console.log("vm modules", on);`,
    },
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  symlinkSync(nodeTypes, join(dir, "node_modules"));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  let entry = "";
  for (const [name, src] of Object.entries(row.files)) {
    writeFileSync(join(dir, name), src + "\n");
    if (name.startsWith("main.")) entry = join(dir, name);
  }
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", input: "" });
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
  if (row.startup !== undefined) {
    expect(node.exitCode).toBe(1);
    expect(node.stdout).toBe("");
    expect(node.stderr).toContain(row.startup);
    const got = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe("");
    expect(got.stderr).toContain(row.startup);
    return;
  }
  if (row.fence !== undefined) {
    expect(node.exitCode).toBe(0);
    const got: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(got.stdout)).toBe(true);
    const line = got.stderr.split("\n")[0]!.split(dir + "/").join("");
    expect(line.startsWith(`tsinter: unsupported: ${row.fence.module}`), line).toBe(true);
    expect(line.endsWith(` is not supported yet [SC1010 at ${row.fence.at}]`), line).toBe(true);
    return;
  }
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

/** Builtins whose import Node makes observable keep the compile-time
 * refusal at the import line. */
const KEEP_REFUSING: { spec: string; why: string }[] = [
  { spec: "node:punycode", why: "DEP0040 DeprecationWarning" },
  { spec: "node:sys", why: "DEP0025 DeprecationWarning" },
  { spec: "node:_stream_wrap", why: "DEP0125 DeprecationWarning" },
  { spec: "node:wasi", why: "ExperimentalWarning" },
  { spec: "node:domain", why: "EventEmitter.usingDomains flips" },
  { spec: "node:repl", why: "loads domain: EventEmitter.usingDomains flips" },
];

describe("R2: unsupported builtin imports stub at use (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
  test.for(KEEP_REFUSING.map((k) => [k.spec, k] as const))("%s keeps refusing at the import", async ([, k]) => {
    const dir = join(scratch, `keep-${k.spec.replace(/\W/g, "_")}`);
    mkdirSync(dir, { recursive: true });
    symlinkSync(nodeTypes, join(dir, "node_modules"));
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const entry = join(dir, "main.ts");
    writeFileSync(entry, `import * as m from "${k.spec}";\nconsole.log("x");\n`);
    const res = await compile(entry, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm" });
    expect(res.ok, k.why).toBe(false);
    expect(res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")).toContain(`SC1010`);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toContain(`the '${k.spec}' module`);
  });
});

/* node:process's namespace mirrors the live process object, whose own keys
 * depend on how Node was launched (`-e` adds _eval, an IPC channel adds
 * send/channel): its row is pinned from a plain `node file` run and left
 * out of the drift check. */
const STABLE_TABLE_MODULES = Object.keys(STUB_BUILTIN_EXPORTS).filter((m) => m !== "process");

test("the stub builtins' export table matches this Node (regenerate: test/gen-stub-builtin-exports.mjs)", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const mods = ${JSON.stringify(STABLE_TABLE_MODULES)};
    const out = {};
    for (const m of mods) out[m] = Object.keys(await import("node:" + m)).sort();
    console.log(JSON.stringify(out));`], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(Object.fromEntries(STABLE_TABLE_MODULES.map((m) => [m, STUB_BUILTIN_EXPORTS[m]])));
});

describe("R2: unsupported builtin imports stub at use (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
