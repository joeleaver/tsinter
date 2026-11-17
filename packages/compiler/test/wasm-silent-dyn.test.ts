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
