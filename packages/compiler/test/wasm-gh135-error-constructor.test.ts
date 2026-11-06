/* GH #135: a caught error reached as a dynamic value (a JavaScript
 * source's `catch (e)`, a TypeScript `catch (e: any)` / `unknown`) answers
 * `e.constructor`, `e.constructor.name`, `e.constructor === TypeError`,
 * `instanceof`, `Object.getPrototypeOf(e) === X.prototype`, `e.name`,
 * `e.message` and `e.stack` the way Node does, for the errors the runtime
 * raises (a nullish member read, a non-callable call, JSON.parse's
 * SyntaxError, an invalid array length) and for user-thrown errors, Error
 * subclasses and non-Error throws.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh135-"));
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
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** Refuses to compile with the named code (and message). */
  refused?: { code: string; text: RegExp };
}


/** What a caught error answers about its class, one line per error. */
const SHOW_JS = `function show(tag, e) {
  console.log(tag, typeof e.constructor, e.constructor.name, e.constructor.length, e.name, e.message);
  console.log(" ", e instanceof TypeError, e instanceof RangeError, e instanceof SyntaxError, e instanceof Error, String(e.constructor));
}`;
const SHOW_TS = `function show(tag: string, e: any): void {
  console.log(tag, typeof e.constructor, e.constructor.name, e.constructor.length, e.name, e.message);
  console.log(" ", e instanceof TypeError, e instanceof RangeError, e instanceof SyntaxError, e instanceof Error, String(e.constructor));
}`;

const ROWS: Row[] = [
  // ── JavaScript sources ──────────────────────────────────────────────
  {
    id: "GH135-JS-01 the issue's repro: a nullish member read's TypeError names its constructor",
    entry: "main.js",
    src: `const nul = JSON.parse("null");
try { nul.x; } catch (e) { console.log(e.constructor.name); }
const und = JSON.parse("[]")[0];
try { und.y; } catch (e) { console.log(e.constructor.name, typeof e.constructor, e instanceof TypeError); }`,
  },
  {
    id: "GH135-JS-02 errors the runtime raises: null read, non-callable call, JSON.parse, toFixed, repeat",
    entry: "main.js",
    src: `${SHOW_JS}
const nul = JSON.parse("null");
try { nul.x; } catch (e) { show("null-read", e); }
try { const f = JSON.parse("5"); f(); } catch (e) { show("not-fn", e); }
try { JSON.parse("{bad"); } catch (e) { show("json", e); }
try { (1.5).toFixed(500); } catch (e) { show("toFixed", e); }
try { "x".repeat(-1); } catch (e) { show("repeat", e); }`,
  },
  {
    id: "GH135-JS-03 user-thrown built-in errors; a renamed error keeps its class",
    entry: "main.js",
    src: `${SHOW_JS}
try { throw new TypeError("t1"); } catch (e) { show("TypeError", e); }
try { throw new RangeError("r1"); } catch (e) { show("RangeError", e); }
try { throw new SyntaxError("s1"); } catch (e) { show("SyntaxError", e); }
try { throw new Error("e1"); } catch (e) { show("Error", e); }
try { throw new TypeError("t3"); } catch (e) { e.name = "Custom"; console.log(e.constructor.name, e.name); }`,
  },
  {
    id: "GH135-JS-04 a user class extending Error, and a subclass of it",
    entry: "main.js",
    src: `class AppError extends Error {
  /** @param {string} msg */
  constructor(msg) { super(msg); this.name = "AppError"; }
}
class Deep extends AppError {}
class Bare extends Error {}
try { throw new AppError("a"); } catch (e) { console.log(e.constructor.name, e.name, e.message, e instanceof AppError, e instanceof Deep, e instanceof Error); }
try { throw new Deep("d"); } catch (e) { console.log(e.constructor.name, e.name, e.message, e instanceof AppError, e instanceof Deep, e instanceof Error); }
try { throw new Bare("b"); } catch (e) { console.log(e.constructor.name, e.name, e instanceof Bare, typeof e.constructor); }
function grab(f) { try { f(); } catch (e) { return e; } return null; }
const a = grab(() => { throw new AppError("x"); }), d = grab(() => { throw new Deep("y"); }), b = grab(() => { throw new Bare("z"); });
console.log(a.constructor.length, d.constructor.length, b.constructor.length);`,
  },
  {
    id: "GH135-JS-05 one constructor per class: two errors of a class share it, two classes do not",
    entry: "main.js",
    src: `function grab(f) { try { f(); } catch (e) { return e; } return null; }
const nul = JSON.parse("null");
const a = grab(() => nul.x), b = grab(() => nul.y), c = grab(() => { throw new TypeError("c"); });
const r = grab(() => { throw new RangeError("r"); });
console.log(a.constructor === b.constructor, a.constructor === c.constructor, a.constructor === r.constructor, a.constructor === a.constructor);
console.log(a?.constructor.name, a["constructor"].name, typeof a.constructor, Object.keys(a.constructor).length);`,
  },
  {
    id: "GH135-JS-06 non-Error throws: a number, a string, a boolean, a dynamic array",
    entry: "main.js",
    src: `try { throw 5; } catch (e) { console.log(typeof e, e.constructor.name, e.constructor.length, String(e.constructor), e instanceof Error, e.message); }
try { throw "s"; } catch (e) { console.log(typeof e, e.constructor.name, e instanceof Error); }
try { throw false; } catch (e) { console.log(typeof e, e.constructor.name); }
try { throw JSON.parse("[1,2]"); } catch (e) { console.log(Array.isArray(e), e.constructor.name, e.length); }
const xs = JSON.parse("[3]");
console.log(xs.constructor.name);`,
  },
  {
    id: "GH135-JS-07 a nullish throw: reading its constructor throws a TypeError of its own",
    entry: "main.js",
    src: `const vals = JSON.parse("[null]");
vals.push(undefined);
for (const v of vals) {
  try { throw v; } catch (e) {
    try { console.log(e.constructor); } catch (e2) { console.log(e2.constructor.name, e2.message); }
    console.log(e?.constructor);
  }
}`,
  },
  {
    id: "GH135-JS-08 e.constructor === TypeError stops at the builtin-as-a-value fence",
    entry: "main.js",
    src: `const nul = JSON.parse("null");
try { nul.x; } catch (e) { console.log("before"); console.log(e.constructor === TypeError); }`,
    fence: { text: /the builtin 'TypeError' used as a value .*\[SC1090/, stdout: "before\n" },
  },
  {
    id: "GH135-JS-09 calling a caught error's constructor stops at its named fence",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { console.log("before"); const x = e.constructor("again"); console.log(x.message); }`,
    fence: { text: /calling a constructor read from a dynamic value \(`x.constructor`\) is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH135-JS-10 Object.getPrototypeOf(e) stops at its named fence",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { console.log("before"); console.log(Object.getPrototypeOf(e) === TypeError.prototype); }`,
    fence: { text: /'Object.getPrototypeOf' is part of the standard library types but has no scriptc lowering yet \[SC2020/, stdout: "before\n" },
  },
  {
    id: "GH135-JS-11 the issue's literal spelling (null.x) refuses by name",
    entry: "main.js",
    src: `try { null.x; } catch (e) { console.log(e.constructor.name); }`,
    refused: { code: "SC0001", text: /The value 'null' cannot be used here/ },
  },
  {
    id: "GH135-JS-12 --dynamic JS: a caught error names its constructor",
    entry: "main.js",
    dynamic: true,
    src: `const nul = JSON.parse("null");
try { nul.x; } catch (e) { console.log(e.constructor.name, e instanceof TypeError); }
try { throw new RangeError("r"); } catch (e) { console.log(e.constructor.name, e.message); }
try { throw 5; } catch (e) { console.log(e.constructor.name); }`,
  },
  {
    id: "GH135-JS-13 errors the runtime builds as a plain Error under another name keep that class (URIError)",
    entry: "main.js",
    src: `try { decodeURIComponent("%"); } catch (e) { console.log(e.name, e.constructor.name, e.constructor.length, e instanceof Error); }
try { encodeURIComponent("\\uD800"); } catch (e) { console.log(e.name, e.constructor.name); }
try { throw new Error("plain"); } catch (e) { e.name = "Renamed"; console.log(e.name, e.constructor.name); }`,
  },
  {
    id: "GH135-JS-14 an assigned constructor member answers, undefined included",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { e.constructor = undefined; console.log(typeof e.constructor, e.constructor); }
try { throw new TypeError("t"); } catch (e) { e.constructor = function () { return 10; }; console.log(e.constructor(), typeof e.constructor); }
const o = JSON.parse("{}"); o.constructor = 5; console.log(o.constructor);`,
  },
  {
    id: "GH135-JS-15 inspecting a builtin error's constructor prints it as Node does",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { console.log(e.constructor); }
try { throw new RangeError("r"); } catch (e) { console.log([e.constructor.name]); }`,
  },
  {
    id: "GH135-JS-16 inspecting a user error class read as a constructor stops at its named fence",
    entry: "main.js",
    src: `class AppError extends Error {}
try { throw new AppError("a"); } catch (e) { console.log("before"); console.log(e.constructor); }`,
    fence: { text: /inspecting a class read as a dynamic value's constructor .*is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH135-JS-17 String() of a user error class read as a constructor stops at its named fence",
    entry: "main.js",
    src: `class AppError extends Error {}
try { throw new AppError("a"); } catch (e) { console.log("before"); console.log(String(e.constructor)); }`,
    fence: { text: /converting a class read as a dynamic value's constructor to a string .*is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH135-JS-18 a class with a static name stops at its named fence",
    entry: "main.js",
    src: `class Named extends Error { static name = "Other"; }
try { throw new Named("n"); } catch (e) { console.log("before"); console.log(e.constructor.name); }`,
    fence: { text: /reading 'constructor' of an error whose class declares a static 'name' or 'length' .*\[SC1090 at .*main\.js:2\]/, stdout: "before\n" },
  },
  {
    id: "GH135-JS-19 arguments.constructor stops at its named fence (this tier's arguments is an array)",
    entry: "main.js",
    src: `function f() { console.log("before", arguments.length); return arguments.constructor.name; }
console.log(f(1, 2));`,
    fence: { text: /reading 'constructor' of a function's 'arguments' object .*S081/, stdout: "before 2\n" },
  },
  {
    id: "GH135-JS-20 calling a plain object's constructor stops at its named fence",
    entry: "main.js",
    src: `const o = JSON.parse("{}");
console.log("before");
try { const r = o.constructor(); console.log(typeof r); } catch (x) { console.log("caught", x.name); }`,
    fence: { text: /calling a constructor read from a dynamic value \(`x.constructor\(...\)`\) is not supported yet .*\[SC1090 at .*main\.js:3\]/, stdout: "before\n" },
  },
  {
    id: "GH135-JS-21 reading the prototype of a constructor read from a dynamic value stops at its named fence",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { console.log("before"); console.log(typeof e.constructor.prototype); }`,
    fence: { text: /reading 'prototype' of a constructor read from a dynamic value/, stdout: "before\n" },
  },
  // ── TypeScript sources ──────────────────────────────────────────────
  {
    id: "GH135-TS-01 catch (e: any): errors the runtime raises",
    src: `${SHOW_TS}
const nul: any = JSON.parse("null");
try { nul.x; } catch (e: any) { show("null-read", e); }
try { const f: any = JSON.parse("5"); f(); } catch (e: any) { show("not-fn", e); }
try { JSON.parse("{bad"); } catch (e: any) { show("json", e); }
try { (1.5).toFixed(500); } catch (e: any) { show("toFixed", e); }
try { "x".repeat(-1); } catch (e: any) { show("repeat", e); }`,
  },
  {
    id: "GH135-TS-02 catch (e: unknown) and an untyped catch: user-thrown built-in errors",
    src: `${SHOW_TS}
try { throw new TypeError("t1"); } catch (e: unknown) { show("TypeError", e); }
try { throw new RangeError("r1"); } catch (e: unknown) { show("RangeError", e); }
try { throw new SyntaxError("s1"); } catch (e) { show("SyntaxError", e); }
try { throw new Error("e1"); } catch (e) { show("Error", e); }
try { throw new DOMException("m", "AbortError"); } catch (e: any) { console.log(e.constructor.name, e.name, e.constructor.length); }`,
  },
  {
    id: "GH135-TS-03 a user class extending Error names its own class, not its name member",
    src: `class AppError extends Error {
  constructor(msg: string) { super(msg); this.name = "AppError"; }
}
class Deep extends AppError {}
function grab(f: () => void): any { try { f(); } catch (e) { return e; } return null; }
const a = grab(() => { throw new Deep("x"); }), b = grab(() => { throw new Deep("y"); }), c = grab(() => { throw new AppError("z"); });
console.log(a.constructor.name, a.name, a.message, a instanceof Error);
console.log(c.constructor.name, c.constructor.length, a.constructor.length, a.constructor === b.constructor, a.constructor === c.constructor);
try { throw new TypeError("t"); } catch (e: any) { e.name = "Renamed"; console.log(e.constructor.name, e?.constructor.name, e.name); }`,
  },
  {
    id: "GH135-TS-04 non-Error throws and dynamic arrays",
    src: `try { throw 5; } catch (e: any) { console.log(typeof e, e.constructor.name, e.constructor.length, e instanceof Error, e.message); }
try { throw "s"; } catch (e: any) { console.log(typeof e, e.constructor.name); }
try { throw true; } catch (e: any) { console.log(typeof e, e.constructor.name); }
const arr: any = [1, 2];
const parsed: any = JSON.parse("[1]");
console.log(arr.constructor.name, parsed.constructor.name, arr.constructor === parsed.constructor);`,
  },
  {
    id: "GH135-TS-05 a JavaScript library's caught error handed to TypeScript",
    files: {
      "lib.js": `export function grab(f) { try { f(); } catch (e) { return e; } return null; }
export function name(e) { return e.constructor.name; }
`,
    },
    src: `import { grab, name } from "./lib.js";
const e: any = grab(() => { const o: any = JSON.parse("null"); return o.x; });
console.log(e.constructor.name, name(e), e instanceof TypeError, e.message);
const r: any = grab(() => { throw new RangeError("r"); });
console.log(r.constructor.name, name(r), r instanceof RangeError, r.constructor === e.constructor);`,
  },
  {
    id: "GH135-TS-06 a plain object's constructor stops at the S015 fence (Node answers Object)",
    src: `try { throw JSON.parse('{"a":1}'); } catch (e: any) { console.log("before", e.a); console.log(typeof e.constructor); }`,
    fence: { text: /reading 'constructor' of a dynamic value other than an error, a number, a string, a boolean or an array .*S015\) \[SC1090 at .*main\.ts:1\]/, stdout: "before 1\n" },
  },
  {
    id: "GH135-TS-07 calling a caught error's constructor stops at its named fence",
    src: `const nul: any = JSON.parse("null");
try { nul.x; } catch (e: any) { console.log("before"); const x = e.constructor("again"); console.log(x.message); }`,
    fence: { text: /calling a constructor read from a dynamic value \(`x.constructor\(...\)`\) is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH135-TS-08 e.constructor === TypeError refuses by name",
    src: `try { throw new TypeError("t"); } catch (e: any) { console.log(e.constructor === TypeError); }`,
    refused: { code: "SC2020", text: /'TypeError' is part of the standard library types but has no scriptc lowering yet/ },
  },
  {
    id: "GH135-TS-09 a keyed constructor read stops at the S015 keyed fence",
    src: `try { throw new TypeError("t"); } catch (e: any) { console.log("before"); console.log(e["constructor"].name); }`,
    fence: { text: /a keyed read of a member a dynamic value inherits from its prototype .*S015\) \[SC1090/, stdout: "before\n" },
  },
  {
    id: "GH135-TS-10 errors the runtime builds as a plain Error under another name: URIError, AssertionError",
    src: `import assert from "node:assert";
try { decodeURIComponent("%"); } catch (e: any) { console.log(e.name, e.constructor.name, e.code); }
try { assert.strictEqual(1, 2); } catch (e: any) { console.log(e.name, e.constructor.name, e.constructor.length); }
try { throw new Error("plain"); } catch (e: any) { e.name = "Renamed"; console.log(e.name, e.constructor.name); }`,
  },
  {
    id: "GH135-TS-11 a statically renamed plain Error stops at its named fence",
    src: `const err = new Error("x");
err.name = "Custom";
try { throw err; } catch (e: any) { console.log("before", e.name); console.log(e.constructor.name); }`,
    fence: { text: /reading 'constructor' of an Error whose name was assigned or that the runtime built under another name .*S015/, stdout: "before Custom\n" },
  },
  {
    id: "GH135-TS-12 an assigned constructor member answers, undefined included",
    src: `try { throw new TypeError("t"); } catch (e: any) { e.constructor = undefined; console.log(typeof e.constructor); }
const p: any = JSON.parse("{}");
p.constructor = (n: number) => n + 1;
console.log(p.constructor(4));`,
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
  if (row.refused !== undefined) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === row.refused!.code && row.refused!.text.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
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

describe("GH #135: a caught error's constructor, prototype and fields (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #135: a caught error's constructor, prototype and fields (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
