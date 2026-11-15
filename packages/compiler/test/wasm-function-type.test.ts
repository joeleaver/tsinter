/* docs/design/function-type.md: TypeScript's global `Function` as a value
 * type is the dynamic value. Typed functions entering box; calls,
 * `.call`/`.apply`/`.bind`, `.name` and `.length` (Node's rule: the
 * parameters before the first default or rest) are the dynamic function's
 * own; `String(f)` echoes a JavaScript definition's source and stops by
 * name for any other compiled function (SEMANTICS.md S019, S020 amended).
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane, or stops by name where
 * noted. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-fntype-"));
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
  /** Ends uncaught: Node and this tier both exit 1 after the same stdout,
   * and this tier's report is `report` (S007). */
  uncaught?: { report: string };
  /** Still stops by name on this tier: stdout up to the stop is a prefix
   * of Node's, and stderr names the diagnostic. */
  fence?: string;
  /** The build refuses, and some diagnostic's message contains this. */
  refusedMsg?: string;
  /** Other files written beside the entry (name -> source). */
  extra?: Record<string, string>;
}

const ROWS: Row[] = [
  {
    id: "FN-01 a Function[] of typed functions: push, call, typeof, iterate name and length",
    src: `const hooks: Function[] = [];
hooks.push((a: number) => a + 1);
hooks.push(function named(x: string) { return x.toUpperCase(); });
console.log(hooks.length, hooks[0]!(1), hooks[1]!("hi"), typeof hooks[0]);
for (const h of hooks) console.log(JSON.stringify(h.name), h.length);`,
  },
  {
    id: "FN-02 a { [key: string]: Function } registry (vue's optionMergeStrategies): store, look up, call",
    src: `const strats: { [key: string]: Function } = {};
strats.data = function (parent: unknown, child: unknown) { return child ?? parent; };
strats["watch"] = (a: number[], b: number[]) => a.concat(b);
console.log(strats.data!(1, undefined), strats.watch!([1], [2]), Object.keys(strats).join(","));
const pick = (k: string): Function | undefined => strats[k];
console.log(typeof pick("data"), pick("nope"));`,
  },
  {
    id: "FN-03 (fn: Function, ...) => Function: bind with a leading argument, call and apply through Function values, the bound name and length",
    src: `function bindIt(fn: Function, first: number): Function { return fn.bind(null, first); }
function show(a: number, b: number, c: number): number { return a * 100 + b * 10 + c; }
const f: Function = show;
const bound = bindIt(f, 1);
console.log(bound(2, 3), f.call(null, 4, 5, 6), f.apply(null, [7, 8, 9]), bound.name, bound.length, f.name, f.length);`,
  },
  {
    id: "FN-04 .length follows Node: parameters before the first default; this is no parameter; ? counts",
    src: `function a1(x: number, y = 2, z?: number) { return x + y + (z ?? 0); }
function a0(p = 1, q = 2) { return p + q; }
function a3(p: number, q?: string, r: number = 3) { return p + (q ?? "").length + r; }
function a4(this: unknown, u: number, v?: number) { return u + (v ?? 0); }
const d1: Function = a1;
const d0: Function = a0;
const d3: Function = a3;
const d4: Function = a4;
console.log(d1.length, d0.length, d3.length, d4.length, d1(1), d0(), d3(1, "ab"));`,
  },
  {
    id: "FN-04b a function with a rest parameter as a Function value: still refused by name (rest functions have no boxed form yet), never a wrong length",
    src: `function a2(head: number, ...r: number[]) { return head + r.length; }
const d2: Function = a2;
console.log(d2.length);`,
    refusedMsg: "functions with rest parameters as values",
  },
  {
    id: "FN-05 a typed function into Function and back into a typed slot: the same function, identity kept",
    src: `function twice(n: number): number { return n * 2; }
const stash: Function = twice;
const again: Function = twice;
const back = stash as (n: number) => number;
console.log(stash === again, back(4), typeof stash);`,
  },
  {
    id: "FN-06 an optional Function field (vue's CompilerOptions.warn): absent and present",
    src: `interface Opts { warn?: Function; name: string }
const o1: Opts = { name: "a" };
const o2: Opts = { name: "b", warn: (m: string) => "W:" + m };
for (const o of [o1, o2]) console.log(o.name, o.warn ? o.warn("x") : "none", typeof o.warn);`,
  },
  {
    id: "FN-07 JavaScript: String(f) on a function echoes its source text, as Node does",
    entry: "main.js",
    src: `/** @param {number} a @param {number} b @returns {number} */
function add(a, b) { return a + b; }
/** @type {(x: number) => number} */
const arrow = (x) => x * 2;
/** @type {Function} */
const f = add;
/** @type {Function} */
const g = arrow;
console.log(String(f));
console.log(\`\${g}\`);`,
  },
  {
    id: "FN-08 TypeScript: String(f) on a compiled function stops by name (Node echoes its type-stripped source; no invented text)",
    src: `function add(a: number, b: number): number { return a + b; }
const f: Function = add;
console.log("before", f.length);
console.log(String(f));`,
    fence: "converting a compiled function to a string",
  },
  {
    id: "FN-09 TypeScript in a module that clones: the carried text is TypeScript, so String(f) still stops by name",
    src: `function add(a: number, b: number): number { return a + b; }
const f: Function = add;
try { structuredClone(f as unknown); } catch (e) { console.log((e as Error).name); }
console.log("before");
console.log(String(f));`,
    fence: "converting a compiled function to a string",
  },
  {
    id: "FN-10 (review) JavaScript: a generator function in a Function slot reports Node's source, length, name and inspect form (a call through it stops by name)",
    entry: "main.js",
    src: `function* gen(n) { yield n; }
/** @type {Function} */
const f = gen;
console.log(String(f));
console.log(f.length, f.name, f);
console.log(\`\${f}\`);`,
  },
  {
    id: "FN-11 (review) JavaScript: an anonymous generator expression in a Function slot: Node's text, name and length",
    entry: "main.js",
    src: `const ge = function* (a, b) { yield a + b; };
/** @type {Function} */
const f1 = ge;
console.log(String(f1), f1.name, f1.length);`,
  },
  {
    id: "FN-11b (review) JavaScript: a generator method read off an object (o.g) stops by name at the crossing (a property is never followed)",
    entry: "main.js",
    src: `const o = { *g(a) { yield a; } };
/** @type {Function} */
const f2 = o.g;
console.log(typeof f2);
console.log(String(f2));`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-12 (review) TypeScript: f.toString() on a compiled function stops by name, as String(f) does",
    src: `function add(a: number, b: number) { return a + b; }
const f: Function = add;
console.log("before");
console.log(f.toString());`,
    fence: "converting a compiled function to a string",
  },
  {
    id: "FN-13 (review) JavaScript: f.toString() echoes a JavaScript definition's source",
    entry: "main.js",
    src: `/** @param {number} a @returns {number} */
function inc(a) { return a + 1; }
/** @type {Function} */
const f = inc;
console.log(f.toString(), f.call(null, 1));`,
  },
  {
    id: "FN-14 (review) JavaScript: an imported generator in a Function slot: the import is followed to its definition (Node's length, name, inspect form)",
    entry: "main.js",
    extra: { "lib.js": "export function* gen(a, b) { yield a + b; }" },
    src: `import { gen } from "./lib.js";
/** @type {Function} */
const f = gen;
console.log(f.length, f.name, f);`,
  },
  {
    id: "FN-15 (review) JavaScript: a generator method read off an object (o.g): a property is never followed to its value (it can be written), so its length stops by name",
    entry: "main.js",
    src: `const o = { *g(a) { yield a; } };
/** @type {Function} */
const f = o.g;
console.log("before");
console.log(f.length, f.name, f);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-16 (review) JavaScript: a const alias of a generator keeps the definition's name",
    entry: "main.js",
    src: `function* gen(a) { yield a; }
const gen2 = gen;
/** @type {Function} */
const f = gen2;
console.log(f.length, f.name, f);`,
  },
  {
    id: "FN-17 (review) JavaScript: an imported anonymous default-export generator is named 'default'",
    entry: "main.js",
    extra: { "lib.js": "export default function* (a) { yield a; }" },
    src: `import g from "./lib.js";
/** @type {Function} */
const f = g;
console.log(f.length, JSON.stringify(f.name), f);`,
  },
  {
    id: "FN-18 (review) JavaScript: an anonymous generator as an array element of a Function[]: building the array stops by name (no conversion for the element yet), never a stand-in value",
    entry: "main.js",
    src: `/** @type {Function[]} */
const arr = [function* (a) { yield a; }];
const f = arr[0];
console.log(f.length, JSON.stringify(f.name), f);`,
    fence: "converting typed values to 'unknown'",
  },
  {
    id: "FN-19 (review) JavaScript: a generator chosen at run time between two definitions has no single definition: its length stops by name (Node prints 2)",
    entry: "main.js",
    src: `function* a(x) { yield x; }
function* b(x, y) { yield x + y; }
/** @type {Function} */
const f = process.argv.length > 99 ? a : b;
console.log("before");
console.log(f.length);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-20 (review) JavaScript: a reassigned let holding a generator (same arity, another name): the initializer is stale, so its name stops by name (never the old definition's)",
    entry: "main.js",
    src: `function* one(a) { yield a; }
function* two(b) { yield b * 2; }
let g = one;
g = two;
/** @type {Function} */
const f = g;
console.log("before");
console.log(f.name, f.length);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-21 (review) JavaScript: an overwritten object property holding a generator (same arity, another name): its name stops by name",
    entry: "main.js",
    src: `function* one(a) { yield a; }
function* two(b) { yield b * 2; }
const o = { g: one };
o.g = two;
/** @type {Function} */
const f = o.g;
console.log("before");
console.log(f.name, f.length);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-22 (review) JavaScript: a generator read off an object chosen at run time: its length stops by name",
    entry: "main.js",
    src: `function* one(a) { yield a; }
function* two(a, b) { yield a + b; }
const o = process.argv.length > 99 ? { g: one } : { g: two };
/** @type {Function} */
const f = o.g;
console.log("before");
console.log(f.length);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-23 (review) JavaScript: a generator read off an element of an array of objects: its length stops by name",
    entry: "main.js",
    src: `function* one(a) { yield a; }
function* two(a, b) { yield a + b; }
const arr = [{ g: one }, { g: two }];
/** @type {Function} */
const f = arr[1].g;
console.log("before");
console.log(f.length);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-24 (review) JavaScript: Object.defineProperty renames a generator: name, length and inspect read Node's answers through every reference",
    entry: "main.js",
    src: `function* first(a) { yield a; }
console.log("before");
Object.defineProperty(first, "name", { value: "renamed" });
/** @type {Function} */
const f = first;
console.log(f.length, JSON.stringify(f.name), f);`,
  },
  {
    id: "FN-24b (review) JavaScript: Object.defineProperty of a const generator's length reads back as Node's",
    entry: "main.js",
    src: `const g = function* first(a) { yield a; };
console.log("before");
Object.defineProperty(g, "length", { value: 5 });
/** @type {Function} */
const f = g;
console.log(f.length);`,
  },
  {
    id: "FN-25 (review) JavaScript: one generator through two Function references is one value: === holds, and a property defined through Object.defineProperty reads through both",
    entry: "main.js",
    src: `function* first(a) { yield a; }
Object.defineProperty(first, "tag", { value: 5, enumerable: true });
/** @type {Function} */
const f = first;
/** @type {Function} */
const g = first;
console.log(f === g, f.tag, g.tag);`,
  },
  {
    id: "FN-26 (review) JavaScript: a generator held in a let (and a var) the program never rebinds: two Function references are one value (===)",
    entry: "main.js",
    src: `let g = function* a(x) { yield x; };
var h = function* b(x) { yield x; };
/** @type {Function} */
const f1 = g;
/** @type {Function} */
const f2 = g;
/** @type {Function} */
const f3 = h;
/** @type {Function} */
const f4 = h;
console.log(f1 === f2, f3 === f4, f1 === f3);`,
  },
  {
    id: "FN-26b (review) JavaScript: a generator held in a let rebound later: its definition is not certain, so the crossing stops by name (never a false ===)",
    entry: "main.js",
    src: `let g = function* a(x) { yield x; };
/** @type {Function} */
const f1 = g;
/** @type {Function} */
const f2 = g;
console.log(f1 === f2);
g = function* b(x) { yield x; };`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-27 (review) JavaScript: o.g === o.g for a generator method through two Function slots: a property read stops by name at the crossing (never a false ===)",
    entry: "main.js",
    src: `const o = { *g(a) { yield a; } };
/** @type {Function} */
const f1 = o.g;
/** @type {Function} */
const f2 = o.g;
console.log(f1 === f2);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-28 (review) JavaScript: { g: gen } then o.g against gen: the property read stops by name at the crossing",
    entry: "main.js",
    src: `function* gen(a) { yield a; }
const o = { g: gen };
/** @type {Function} */
const f1 = gen;
/** @type {Function} */
const f2 = o.g;
console.log(f1 === f2);`,
    fence: "whose definition this build cannot see",
  },
  {
    id: "FN-29 (review) JavaScript: a namespace import's member and the named import are one generator (===)",
    entry: "main.js",
    extra: { "lib.js": "export function* gen(a) { yield a; }" },
    src: `import * as ns from "./lib.js";
import { gen } from "./lib.js";
/** @type {Function} */
const f1 = ns.gen;
/** @type {Function} */
const f2 = gen;
console.log(f1 === f2, f1.length, f1.name);`,
  },
  {
    id: "FN-30 (review) JavaScript: a named generator expression in a const inside a function body is a new object per call: the crossing stops by name (never make() === make())",
    entry: "main.js",
    src: `function make() {
  const g = function* inner(a) { yield a; };
  /** @type {Function} */
  const f = g;
  return f;
}
console.log("before");
console.log(make() === make());`,
    fence: "defined inside a function body or a loop",
  },
  {
    id: "FN-31 (review) JavaScript: a generator declaration nested in a function body: the crossing stops by name",
    entry: "main.js",
    src: `function make() {
  function* inner(a) { yield a; }
  /** @type {Function} */
  const f = inner;
  return f;
}
console.log("before");
console.log(make() === make());`,
    fence: "defined inside a function body or a loop",
  },
  {
    id: "FN-32 (review) JavaScript: an inline generator expression crossing in place inside a function body: the crossing stops by name",
    entry: "main.js",
    src: `function make() {
  /** @type {Function} */
  const f = function* (a) { yield a; };
  return f;
}
console.log("before");
console.log(make() === make());`,
    fence: "defined inside a function body or a loop",
  },
  {
    id: "FN-33 (review) JavaScript: a property defined on one call's nested generator never shows on another's: the crossing stops by name",
    entry: "main.js",
    src: `function make() {
  function* inner(a) { yield a; }
  /** @type {Function} */
  const f = inner;
  return f;
}
console.log("before");
const a = make();
Object.defineProperty(a, "tag", { value: 1, enumerable: true });
console.log(Object.keys(make()).length);`,
    fence: "defined inside a function body or a loop",
  },
  {
    id: "FN-34 (review) JavaScript: a generator expression in a loop body is a new object per iteration: the crossing stops by name",
    entry: "main.js",
    src: `/** @type {Function[]} */
const out = [];
console.log("before");
for (let i = 0; i < 2; i++) {
  const g = function* each(a) { yield a; };
  /** @type {Function} */
  const f = g;
  out.push(f);
}
console.log(out[0] === out[1]);`,
    fence: "defined inside a function body or a loop",
  },
  {
    id: "FN-35 (gate) JavaScript: an ordinary function's name and length redefined through Object.defineProperties read back as Node's (the mustCall wrapper shape)",
    entry: "main.js",
    src: `function wrap(fn) {
  const wrapped = function () { return fn.apply(this, arguments); };
  Object.defineProperties(wrapped, {
    name: { value: fn.name, writable: false, enumerable: false, configurable: true },
    length: { value: fn.length, writable: false, enumerable: false, configurable: true },
  });
  return wrapped;
}
const w = wrap(function onTwice(a, b) { return a + b; });
console.log(w.name, w.length, w(2, 3));`,
  },
  {
    id: "FN-36 (review) JavaScript: bind reads the target's name and length as properties: a redefined name and length, a non-number length (0) and a non-string name ('')",
    entry: "main.js",
    src: `function plain(a, b) { return a + b; }
Object.defineProperty(plain, "name", { value: "renamed" });
Object.defineProperty(plain, "length", { value: 5 });
const b = plain.bind(null, 1);
console.log(b.name, b.length, b(2));
function odd(a) { return a; }
Object.defineProperty(odd, "length", { value: "7" });
Object.defineProperty(odd, "name", { value: 5 });
const o = odd.bind(null);
console.log(JSON.stringify(o.name), o.length, o(3));
function big(a, b, c) { return a; }
Object.defineProperty(big, "length", { value: 2.9 });
console.log(big.bind(null).length, big.bind(null, 1, 2, 3, 4).length);`,
  },
  {
    id: "FN-37 (review) JavaScript: a generator with only its length redefined keeps its name, kind and source",
    entry: "main.js",
    src: `function* gen(a, b) { yield a; }
Object.defineProperty(gen, "length", { value: 5 });
console.log(gen.name, gen.length, gen, String(gen));`,
  },
  {
    id: "FN-38 (review) JavaScript: new on a generator throws Node's TypeError",
    entry: "main.js",
    src: `function* G(a) { yield a; }
Object.defineProperty(G, "tag", { value: 1 });
try {
  new G(1);
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}`,
  },
  {
    id: "FN-39 (review) JavaScript: a generator's prototype (what its generator objects inherit) stops by name",
    entry: "main.js",
    src: `function* G(a) { yield a; }
console.log("before");
G.prototype.m = function () { return "m"; };
const it = G(1);
console.log(it.m(), it.next());`,
    fence: "a generator function's 'prototype'",
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.extra ?? {})) writeFileSync(join(dir, name), text + "\n");
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
  if (row.refusedMsg !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.some((d) => d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.fence !== undefined) {
    expect(node.exitCode).toBe(0);
    expect(got.exitCode, row.id).not.toBe(0);
    expect(node.stdout.startsWith(got.stdout), row.id).toBe(true);
    expect(got.stderr, row.id).toContain(row.fence);
    return;
  }
  if (row.uncaught !== undefined) {
    expect(node.exitCode).toBe(1);
    expect(got.exitCode, row.id).toBe(1);
    expect(got.stdout, row.id).toBe(node.stdout);
    expect(got.stderr.split("\n")[0], row.id).toBe(row.uncaught.report);
    return;
  }
  expect(node.exitCode).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("TypeScript's global Function as a value type (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("TypeScript's global Function as a value type (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
