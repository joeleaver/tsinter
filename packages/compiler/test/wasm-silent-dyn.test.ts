/* Two silent divergences on the dynamic tier, Node-exact now:
 *
 * GH #234: in JavaScript `any` code, an object literal holding a method
 * (`{ v: { toString() {…} } }`) read through a dynamic value answered
 * typeof "function". A member value the checked-dynamic literal cannot hold
 * directly crosses through its JavaScript view; one with no view stops by
 * name where the literal is built, never as a stand-in function.
 *
 * GH #236: `Object.entries(o)` over an `unknown` narrowed to `object` infers
 * its element `[string, never]` (and `Object.values(o)` infers `never[]`).
 * Bindings and element reads typed by that residue `never` hold the dynamic
 * value instead of never's f64 (which stopped on the first non-number, or
 * folded `typeof v` to "number").
 *
 * GH #246: function members of a literal handed to dynamic code (a
 * JavaScript literal of function expressions or arrows only, a binding
 * holding one, async functions, a TypeScript literal nested in a fresh
 * one) carry Node's name: a function boxed where it is created takes its
 * definition's name, and the runtime-keyed literal names its members.
 * A reference names its function only from a definition (SD-12).
 *
 * Every row equals Node (spawned at test time) except SD-11, SD-11b, SD-11c,
 * SD-12b, SD-13b, SD-13bt, SD-13d, SD-13t, SD-14o and SD-14t, which pin registered S020 answers beside Node's; on the wasm
 * lane and, in the second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-silent-dyn-"));
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
  /** A registered divergence (the SEMANTICS.md entry the row names): this
   * tier prints `tier`, Node prints `node`; both are pinned. */
  pin?: { tier: string; node: string };
}

const ROWS: Row[] = [
  {
    id: "SD-01 (GH #234) literals holding methods read through a dynamic value: typeof is 'object', direct and nested, a binding and a fresh literal",
    entry: "main.js",
    src: `function t(o) { return typeof o.v; }
function u(o) { return typeof o; }
console.log(t({ v: { toString() { return "a"; } } }), t({ v: { m() { return "a"; } } }), t({ v: { x: 1 } }));
console.log(u({ toString() { return "a"; } }), u({ m() { return 1; } }));
const inner = { toString() { return "a"; }, m(n) { return n * 3; } };
console.log(t({ v: inner }), u(inner), typeof inner);
console.log(t({ v: { w: { m() { return 1; } } } }), typeof ({ v: { w: { m() { return 1; } } } }).v.w);`,
  },
  {
    id: "SD-02 (GH #234) String(), toString() and concatenation of such a member, and calling its methods through the dynamic value",
    entry: "main.js",
    src: `function s(o) { return String(o.v) + "|" + o.v.toString() + "|" + o.v; }
function c(o) { return o.v.m(2); }
const inner = { toString() { return "a"; }, m(n) { return n * 3; } };
console.log(s({ v: inner }), s({ v: { toString() { return "lit"; } } }));
console.log(c({ v: inner }), c({ v: { m(n) { return n + 1; } } }));
console.log(String(o2v({ v: inner })), typeof o2v({ v: inner }).m);
function o2v(o) { return o.v; }`,
  },
  {
    id: "SD-03 (GH #234) nested functions keep typeof 'function': a function-valued member, a function expression, an arrow and a method read off a literal",
    entry: "main.js",
    src: `function t(o) { return typeof o.v; }
console.log(t({ v: { f: function () {} } }), t({ v: function () {} }), t({ v: () => 1 }), typeof ({ v: { f() {} } }).v.f);
function f1(o) { return o.v.f(); }
function g1(o) { return o.v.g(); }
console.log(f1({ v: { f() { return "f"; } } }), g1({ v: { g: () => "g" } }));`,
  },
  {
    id: "SD-06 (GH #234) a nested literal's function members keep Node's name and length: an arrow and a method by their key, a named function expression by its own name, one level and two levels deep",
    entry: "main.js",
    src: `function nm(o) { return o.v.f.name + "|" + o.v.g.name + "|" + o.v.h.name + "|" + o.v.f.length + o.v.g.length + o.v.h.length; }
console.log(nm({ v: { f: () => 1, g() {}, h: function hh(a, b) {} } }));
console.log(nm({ v: { f: (x) => x, g(a, b, c) {}, h: function () {} } }));
function deep(o) { return o.v.w.k.name + "|" + o.v.w.k.length; }
console.log(deep({ v: { w: { k(a) { return a; } } } }));`,
  },
  {
    id: "SD-07 (GH #246) a JavaScript literal of function expressions and arrows only, passed to dynamic code: name, length and String() of each member, and util.inspect of the literal",
    entry: "main.js",
    src: `function nm(o) { return o.h.name + "|" + o.k.name + "|" + o.h.length + o.k.length + "|" + String(o.h) + "|" + String(o.k); }
console.log(nm({ h: function hh(a) {}, k: function (a, b) {} }));
console.log(nm({ h: (x) => x, k: () => 2 }));
console.log(nm({ h: function hh(a) {}, k: () => 1 }));
function show(v) { console.log(v); }
show({ h: function hh() {}, k: () => 1, "q-r": function () {} });
function decl(a) {}
const cst = function () {};
let lt = function () {};
const h = () => 1;
console.log(nm({ h: decl, k: cst }), nm({ h: lt, k: decl }), nm({ h, k: h }));`,
  },
  {
    id: "SD-08 (GH #246) a binding-held JavaScript literal of function members, passed directly and nested in a fresh literal: names, length and String()",
    entry: "main.js",
    src: `const inner = { h: function hh() {}, f: () => 1 };
function n2(o) { return o.v.h.name + "|" + o.v.f.name + "|" + o.v.h.length + "|" + String(o.v.h); }
console.log(n2({ v: inner }));
function n3(o) { return o.h.name + "|" + o.f.name + "|" + String(o.f); }
console.log(n3(inner));`,
  },
  {
    id: "SD-09 (GH #246) async function expressions and async arrows in a JavaScript literal, direct and nested: typeof, name, length, String() and a call",
    entry: "main.js",
    src: `function n3(o) { return typeof o.v.a + "|" + o.v.a.name + "|" + o.v.a.length + "|" + String(o.v.a); }
console.log(n3({ v: { a: async function (x) { return 1; } } }));
console.log(n3({ v: { a: async (x, y) => 1 } }));
function n4(o) { return typeof o.a + "|" + o.a.name + "|" + o.a.length + "|" + String(o.a); }
console.log(n4({ a: async function (x) {}, b: 1 }));
console.log(n4({ a: async function named(x, y) {}, b: 1 }));
async function run(o) { return (await o.a(3)) + (await o.v.a(2)); }
run({ a: async function (x) { return x * 2; }, v: { a: async function (x) { return x * 10; } } }).then((r) => console.log(r));`,
  },
  {
    id: "SD-10 (GH #246) TypeScript: fresh literals into an any parameter, direct and nested, function expressions, async ones and arrows; a computed key's neighbours",
    entry: "main.ts",
    src: `function nm(o: any) { return o.h.name + "|" + o.k.name + "|" + o.h.length + o.k.length; }
console.log(nm({ h: function hh(a: number) {}, k: function () {} }));
console.log(nm({ h: async function (a: number) {}, k: () => 1 }));
function n2(o: any) { return o.v.h.name + "|" + o.v.f.name; }
console.log(n2({ v: { h: function hh() {}, f: () => 1 } }));
console.log(n2({ v: { h: async function () {}, f: async () => 1 } }));
const k = "zz";
const o: any = { m: () => 1, [k]: () => 7, f: function () {} };
console.log(o.m.name + "|" + o[k].name + "|" + o.f.name);
const d: any = { inner: { deep() {}, a: () => 1 } };
console.log(d.inner.deep.name + "|" + d.inner.a.name);`,
  },
  {
    id: "SD-11 (S020 GH #140 amendment) a static record's named function expression, nested in a fresh literal, answers its key (a TypeScript record, and a JavaScript literal holding a method)",
    entry: "main.ts",
    src: `function n2(o: any) { return o.v.h.name + "|" + o.v.f.name; }
const inner = { h: function hh() {}, f: () => 1 };
console.log(n2({ v: inner }));`,
    pin: { tier: "h|f\n", node: "hh|f\n" },
  },
  {
    id: "SD-11b (S020 GH #140 amendment) a spread copy of a static record in a fresh literal names its function members by key, as the record's view does",
    entry: "main.js",
    src: `const rec = { h: function hh() {}, m() {}, a: () => 1 };
function n2(o) { return o.v.h.name + "|" + o.v.m.name + "|" + o.v.a.name; }
console.log(n2({ v: { ...rec } }));`,
    pin: { tier: "h|m|a\n", node: "hh|m|a\n" },
  },
  {
    id: "SD-11c (S020 GH #140 amendment) the TypeScript spread copy",
    entry: "main.ts",
    src: `const rec = { h: function hh() {}, m() {}, a: () => 1 };
function n2(o: any) { return o.v.h.name + "|" + o.v.m.name + "|" + o.v.a.name; }
console.log(n2({ v: { ...rec } }));`,
    pin: { tier: "h|m|a\n", node: "hh|m|a\n" },
  },
  {
    id: "SD-12 (GH #246) a JavaScript literal's reference names its function only from a definition: a const conditional and a factory's result stay anonymous, an alias and a const alias chain answer the definition, an assigned let its binding, a literal member read its definition",
    entry: "main.js",
    src: `function n(o) { return JSON.stringify(o.f.name); }
const cond = Math.random() < 2 ? () => 1 : () => 2;
function make() { return () => 1; }
const got = make();
function realName() {}
const alias = realName;
const named = function nm2() {};
const alias2 = named;
let late;
late = () => 1;
const handlers = { a: () => 1, b: function bb() {} };
console.log(n({ f: cond }), n({ f: got }), n({ f: alias }), n({ f: alias2 }), n({ f: late }), n({ f: handlers.a }), n({ f: handlers.b }));`,
  },
  {
    id: "SD-13 (GH #246) a let/var whose every function write is anonymous and assigned straight to it names its functions by the binding, through const aliases taken after a write, past non-function writes, and an assignment expression's value",
    entry: "main.js",
    src: `function n(o) { return JSON.stringify(o.f.name); }
let y; y = () => 1; const y1 = y; y = () => 2;
let m; m = () => 1; const keep = m; m = 5;
let t1 = function () {}; t1 = () => 1;
let q; const r = (q = () => 1);
let late; late = () => 1;
console.log(n({ f: y1 }), n({ f: y }), n({ f: keep }), n({ f: t1 }), n({ f: r }), n({ f: (q = () => 2) }), n({ f: late }));`,
  },
  {
    id: "SD-13d (S020) a direct .name read of a const alias keeps the binding's spelling",
    entry: "main.js",
    src: `let y; y = () => 1; const y1 = y; y = () => 2;
let m; m = () => 1; const keep = m; m = 5;
let q; const r = (q = () => 1);
console.log(y1.name, keep.name, r.name);`,
    pin: { tier: "y1 keep r\n", node: "y m q\n" },
  },
  {
    id: "SD-13t (S020) the same let/var shapes in TypeScript, into an any parameter: the island literal keeps the binding's spelling for an alias",
    entry: "main.ts",
    src: `function n(o: any) { return JSON.stringify(o.f.name); }
let y: () => number; y = () => 1; const y1 = y; y = () => 2;
let m: (() => number) | number; m = () => 1; const keep = m; m = 5;
let t1 = function () { return 0; }; t1 = () => 1;
let q: () => number; const r = (q = () => 1);
console.log(n({ f: y1 }), n({ f: y }), n({ f: keep }), n({ f: t1 }), n({ f: r }));`,
    pin: { tier: '"y1" "y" "keep" "t1" "r"\n', node: '"y" "y" "m" "t1" "q"\n' },
  },
  {
    id: "SD-13b (S020 GH #140 amendment) a let also written a named function expression: a const alias taken while it held an anonymous function answers the empty name where Node answers the binding's name",
    entry: "main.js",
    src: `function n(o) { return JSON.stringify(o.f.name); }
let x; x = () => 1; const first = x; x = function other() {};
console.log(n({ f: first }), n({ f: x }));`,
    pin: { tier: '"" "other"\n', node: '"x" "other"\n' },
  },
  {
    id: "SD-13bt (S020 GH #140 amendment) the TypeScript island literal keeps the binding spelling for that alias",
    entry: "main.ts",
    src: `function n(o: any) { return JSON.stringify(o.f.name); }
let x: () => void; x = () => {}; const first = x; x = function other() {};
console.log(n({ f: first }));`,
    pin: { tier: '"first"\n', node: '"x"\n' },
  },
  {
    id: "SD-14 (GH #246) a function written by array destructuring names nothing (an array element's arrow has no name)",
    entry: "main.js",
    src: `function n(o) { return JSON.stringify(o.f.name); }
let e; [e] = [() => 1];
const [c] = [() => 2];
console.log(n({ f: e }), n({ f: c }));`,
  },
  {
    id: "SD-14o (S020 GH #140 amendment) a function written by OBJECT destructuring answers the empty name where Node answers its definition's",
    entry: "main.js",
    src: `function n(o) { return JSON.stringify(o.f.name); }
let k; ({ k } = { k: () => 3 });
console.log(n({ f: k }));`,
    pin: { tier: '""\n', node: '"k"\n' },
  },
  {
    id: "SD-14t (S020) the same array destructuring in TypeScript, into an any parameter: the island literal keeps the binding's spelling",
    entry: "main.ts",
    src: `function n(o: any) { return JSON.stringify(o.f.name); }
let e: () => number; [e] = [() => 1];
const [c] = [() => 2];
console.log(n({ f: e }), n({ f: c }));`,
    pin: { tier: '"e" "c"\n', node: '"" ""\n' },
  },
  {
    id: "SD-12b (S020) a TypeScript island literal's reference keeps the binding's spelling",
    entry: "main.ts",
    src: `function n(o: any) { return JSON.stringify(o.f.name); }
const cond = Math.random() < 2 ? () => 1 : () => 2;
function make() { return () => 1; }
const got = make();
function realName() {}
const alias = realName;
let late: () => number;
late = () => 1;
console.log(n({ f: cond }), n({ f: got }), n({ f: alias }), n({ f: late }));`,
    pin: { tier: '"cond" "got" "alias" "late"\n', node: '"" "" "realName" "late"\n' },
  },
  {
    id: "SD-04 (GH #236) paperclip's run-event projection: a destructured Object.entries callback over a narrowed unknown holds any value",
    entry: "main.ts",
    src: `function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).map(([key, entry]) => key + "=" + JSON.stringify(project(entry))).join(";");
  }
  return value;
}
console.log(project(JSON.parse('{"b":1,"a":["x",{"2":null}]}')));`,
  },
  {
    id: "SD-05 (GH #236) the same residue through a for-of destructuring, an identifier parameter's element reads, and Object.values' callback (typeof was folded to 'number')",
    entry: "main.ts",
    src: `function viaFor(value: unknown): string {
  const out: string[] = [];
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) out.push(k + ":" + typeof v + ":" + JSON.stringify(v));
  }
  return out.join(",");
}
function viaIdent(value: unknown): string {
  if (value === null || typeof value !== "object") return "-";
  return Object.entries(value).map((e) => e[0] + "/" + JSON.stringify(e[1])).join(",");
}
function viaValues(value: unknown): string {
  if (value === null || typeof value !== "object") return "-";
  return Object.values(value).map((v) => typeof v).join(",");
}
const sample = JSON.parse('{"n":1,"s":"x","a":[1,{"b":true}],"o":{"z":null},"t":false}');
console.log(viaFor(sample));
console.log(viaValues(sample));
console.log(viaIdent(sample));`,
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
  if (row.pin) {
    expect(node.stdout, `${row.id}: Node's answer`).toBe(row.pin.node);
    expect(got, row.id).toEqual({ ...node, stdout: row.pin.tier });
    return;
  }
  expect(got, row.id).toEqual(node);
}

describe("silent dynamic-tier divergences (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("silent dynamic-tier divergences (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
