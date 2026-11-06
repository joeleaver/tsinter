/* GH #133: a call whose callee is an element access on a dynamic value
 * (`handlers[0](4)`, `fns[i](2)`, `o[k](1)`, `o[sym]()`) is the method call
 * it is in JavaScript: the element is read with the receiver's own keyed
 * get (array index, string key, symbol key), and called with `this` bound
 * to the receiver; a non-callable element throws V8's catchable
 * "<callee> is not a function".
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh133-"));
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
  /** Further files of the program, by name. */
  files?: Record<string, string>;
  /** Build with --dynamic (the engine). */
  dynamic?: true;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's) — a construct this lane does not
   * model yet, refused by name rather than answered wrongly. */
  fence?: { text: RegExp; stdout: string };
}

/** The catch-and-print helper every error row uses. */
const T = `const t = (f) => { try { console.log(f()); } catch (e) { console.log((e instanceof TypeError ? "TypeError" : "other") + ": " + e.message); } };`;
const TT = `const t = (f: () => unknown): void => { try { console.log(f()); } catch (e) { console.log((e instanceof TypeError ? "TypeError" : "other") + ": " + (e as Error).message); } };`;

const ROWS: Row[] = [
  // ── JavaScript sources ──────────────────────────────────────────────
  {
    id: "GH133-JS-01 a pushed handler called by a literal index (the issue's repro)",
    entry: "main.js",
    src: `const handlers = [];
handlers.push((x) => x * 2);
handlers.push(function (x) { return x + 1; });
console.log(handlers[0](4), handlers[1](4));
let total = 0;
for (let i = 0; i < handlers.length; i++) total += handlers[i](10);
console.log(total);`,
  },
  {
    id: "GH133-JS-02 a JSON.parse'd array of handlers called by a computed index",
    entry: "main.js",
    src: `const fns = JSON.parse("[]");
fns.push((x) => x * 3);
fns.push((x) => "s" + x);
for (let i = 0; i < fns.length; i++) console.log(fns[i](2));
const cfg = JSON.parse('{"list":[]}');
cfg.list.push((a, b) => a - b);
console.log(cfg.list[0](9, 4), cfg["list"][0](1, 1));`,
  },
  {
    id: "GH133-JS-03 the receiver of an index call is the array (numeric, string and computed keys)",
    entry: "main.js",
    src: `'use strict';
const a = [];
a.push(function () { return this.length; }, 5);
let i = 0;
const k = "0";
console.log(a[0](), a["0"](), a[0x0](), a[i](), a[k]());
console.log(a[0]() === 2, a[i]() === a.length);
const who = [];
who.push(function () { return this === who; });
console.log(who[0](), who[i]());`,
  },
  {
    id: "GH133-JS-09a --dynamic JS: a literal index call",
    entry: "main.js",
    dynamic: true,
    src: `'use strict';
const handlers = [];
handlers.push((x) => x * 2, function () { return this.length; });
console.log(handlers[0](4));
console.log(handlers[1]());`,
  },
  {
    id: "GH133-JS-09b --dynamic JS: a computed index read of this array stops at its named fence (as on main)",
    entry: "main.js",
    dynamic: true,
    src: `'use strict';
const handlers = [];
handlers.push((x) => x * 2, function () { return this.length; });
console.log("before");
let i = 1;
console.log(handlers[i]());`,
    fence: { text: /element access on non-array values are not supported yet \[SC1090/, stdout: "before\n" },
  },
  {
    id: "GH133-JS-09c --dynamic JS: a computed string key call",
    entry: "main.js",
    dynamic: true,
    src: `'use strict';
const o = JSON.parse('{"n":5}');
o.f = function () { return this.n; };
const k = "f";
console.log(o[k]());`,
  },
  {
    id: "GH133-JS-10 an array literal of functions (a typed JavaScript array)",
    entry: "main.js",
    src: `const fs = [(x) => x + 1, (x) => x * 2];
let i = 1;
console.log(fs[0](1), fs[i](5));`,
  },
  {
    id: "GH133-JS-04 a computed string key binds this",
    entry: "main.js",
    src: `'use strict';
const o = JSON.parse('{"n":3}');
o.f = function () { return this.n; };
o.g = function (x) { return this.n * x; };
const fk = "f";
const gk = "g";
console.log(o[fk](), o[gk](2), o["f"]());
const p = JSON.parse('{"n":4}');
p.get = function () { return this.n; };
const name = "get";
console.log(p[name]());
const arr = JSON.parse("[1,2]");
console.log(arr["push"](3), arr.length, arr["join"]("-"));
const q = JSON.parse("{}");
q[0] = function () { return this === q; };
let z = 0;
console.log(q[0](), q["0"](), q[z]());`,
  },
  {
    id: "GH133-JS-05 a symbol-keyed call on a dynamic object stops at the symbol-key fence",
    entry: "main.js",
    src: `'use strict';
${T}
const o = JSON.parse('{"v":9}');
const s = Symbol("m");
console.log("before");
t(() => o[s]());`,
    fence: { text: /symbol-keyed property access outside class fields .* is not supported yet \[SC1090/, stdout: "before\n" },
  },
  {
    id: "GH133-JS-06 a non-callable element throws V8's TypeError, spelled as V8 spells the callee",
    entry: "main.js",
    src: `${T}
const a = [];
a.push(function () { return this.length; }, 5);
let i = 0;
const k = "0";
t(() => a[1]());
t(() => a[5]());
t(() => a[-1]());
t(() => a[1.5]());
t(() => a[i + 7]());
t(() => a[k + "x"]());
const u = JSON.parse("[null]");
u.unshift(undefined);
t(() => u[0]());
t(() => u[1]());
t(() => u[i]());
const n = JSON.parse("null");
t(() => n[0]());
t(() => n[i]());
const bag = JSON.parse("{}");
t(() => bag.un[k]());
const str = JSON.parse('"abc"');
t(() => str[0]());
t(() => str[i]());`,
  },
  {
    id: "GH133-JS-07 a nested receiver; spread arguments",
    entry: "main.js",
    src: `${T}
const box = JSON.parse('{"list":[]}');
box.list.push(function () { return this.length; });
let i = 0;
console.log(box.list[0](), box.list[i](), box["list"][i]());
const a = [];
a.push((x) => x + 1);
t(() => a[i](...[4]));
t(() => a[0](...[5]));`,
  },
  {
    id: "GH133-JS-08 the key is evaluated once, before the arguments",
    entry: "main.js",
    src: `const log = [];
const a = [(x) => "first:" + x, (x) => "second:" + x];
let i = 0;
console.log(a[(log.push("key"), i++)]((log.push("arg"), i)));
console.log(log.join(","), i);`,
  },
  {
    id: "GH133-JS-11 a plain call inside an element-called function does not see the element call's receiver",
    entry: "main.js",
    src: `'use strict';
function who() { return this === undefined ? "undef" : "bound"; }
const o = JSON.parse("{}");
o.m = function () { return who(); };
const a = JSON.parse("[]");
a.push(function () { return who(); }, () => who());
let i = 1;
console.log(o.m(), a[0](), a[i](), who());
const box = JSON.parse("{}");
box.f = who;
a.push(function () { const g = box.f; return box.f.call(undefined) + "/" + g(); });
console.log(a[2]());`,
  },
  // ── TypeScript sources ──────────────────────────────────────────────
  {
    id: "GH133-TS-01 an any[] element called by literal and computed index (the issue's TS repro)",
    src: `function plain(x: number): number { return x + 100; }
const a: any[] = [plain];
console.log(a[0](1));
let i = 0;
console.log(a[i](2));
a.push((s: string) => s.toUpperCase());
console.log(a[1]("hi"), a[a.length - 1]("yo"));`,
  },
  {
    id: "GH133-TS-02 a JSON.parse'd any array of handlers",
    src: `const fns: any = JSON.parse("[]");
fns.push((x: number) => x * 3);
fns.push((x: number) => "s" + x);
for (let i = 0; i < fns.length; i++) console.log(fns[i](2));
console.log(fns[0](5));
const table: Record<string, any> = { inc: (x: number) => x + 1 };
const k = "inc";
console.log(table[k](1), table["inc"](2));`,
  },
  {
    id: "GH133-TS-03 the receiver is bound for JavaScript functions stored in a dynamic array or object",
    files: {
      "lib.js": `export function mk() {
  const arr = [];
  arr.push(function () { return this.length; }, function () { return this === arr; });
  const obj = JSON.parse('{"n":6}');
  obj.get2 = function () { return this.n * 2; };
  return { arr, obj };
}
`,
    },
    src: `import { mk } from "./lib.js";
const made: any = mk();
const arr = made.arr;
const obj = made.obj;
let i = 0;
const k = "get2";
console.log(arr[0](), arr[i](), arr[1](), arr[i + 1]());
console.log(obj[k](), obj["get2"]());
console.log(arr["push"](0), arr.length);`,
  },
  {
    id: "GH133-TS-04 a non-callable element throws V8's TypeError",
    src: `${TT}
function plain(x: number): number { return x; }
const a: any[] = [plain, 5];
const u: any[] = [undefined];
let i = 0;
t(() => a[1]());
t(() => a[9]());
t(() => a[-1]());
t(() => a[i + 7]());
t(() => u[0]());
t(() => u[i]());
const o: any = JSON.parse('{"x":1}');
const k = "x";
t(() => o[k]());
t(() => o["missing"]());`,
  },
  {
    id: "GH133-TS-06 a computed key naming an inherited method stops at S015's fence",
    src: `const arr: any = JSON.parse("[1,2]");
const m = "push";
console.log("before");
console.log(arr[m](3));`,
    fence: { text: /a keyed read of a member a dynamic value inherits from its prototype .*S015\) \[SC1090/, stdout: "before\n" },
  },
  {
    id: "GH133-TS-05 a typed function array is unaffected",
    src: `const fs: Array<(x: number) => number> = [(x) => x + 1, (x) => x * 2];
let i = 1;
console.log(fs[0](1), fs[i](5));`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.files ?? {})) writeFileSync(join(dir, name), text);
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
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, ...(row.dynamic ? { dynamic: true } : {}) });
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
  expect(got, row.id).toEqual(node);
}

describe("GH #133: element calls on dynamic values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #133: element calls on dynamic values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
