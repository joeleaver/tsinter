/* GH #137: an error held in a dynamic value converts and prints with the
 * members a dynamic write changed. `String(e)`, a template, `+`,
 * `e.toString()` and util.format read a caught error's `name` and
 * `message` the way Node does after `e.name = "Custom"` (Error.prototype
 * .toString's rules included: an undefined name is "Error", an empty side
 * drops the ": "), and console.log / util.inspect render it as Node renders
 * an error with an emptied stack (SEMANTICS.md S027): `[Custom: t]`, with
 * Node's improveStack header rule (`[MyType [TypeError]: m]`). What this
 * tier does not model stops at a named fence, and those rows pin it.
 *
 * Inspect rows empty the stack first (`e.stack = ""`), the form S027
 * registers: Node prints the stack's frames otherwise. Every row equals
 * Node (spawned at test time), on the wasm lane and, in the second
 * describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh137-"));
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
  /** Build with --dynamic (the engine). */
  dynamic?: true;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
}

const SHOW_JS = `const util = require("node:util");
function show(e) { e.stack = ""; console.log(e); console.log(util.inspect(e)); console.log(util.format("%s|%o", e, 1)); console.log({ k: e }); console.log([e, 1]); }`;

const ROWS: Row[] = [
  // ── JavaScript sources ──────────────────────────────────────────────
  {
    id: "GH137-JS-01 the issue's repro: a renamed caught error converts with its new name and message",
    entry: "main.js",
    src: `const nul = JSON.parse("null");
try { nul.x; } catch (e) { e.name = "Custom"; e.message = "t3"; console.log(String(e)); console.log(\`\${e}\`); console.log("" + e); console.log(e.toString()); }`,
  },
  {
    id: "GH137-JS-02 every conversion of a renamed TypeError agrees",
    entry: "main.js",
    src: `const util = require("node:util");
try { throw new TypeError("t"); } catch (e) {
  e.name = "Custom";
  console.log(String(e), \`\${e}\`, "x" + e, e + "", e.toString(), e.name, [String(e)].join());
  e.stack = "";
  console.log(util.format("%s|%s", e, "z"), util.format("%s", String(e)));
}
try { throw new TypeError("t"); } catch (e) { e.message = "M2"; console.log(String(e), e.message); }`,
  },
  {
    id: "GH137-JS-03 Error.prototype.toString's rules over the renamed members",
    entry: "main.js",
    src: `try { throw new Error("t"); } catch (e) { e.name = ""; console.log(JSON.stringify(String(e))); e.message = ""; console.log(JSON.stringify(String(e))); }
try { throw new RangeError("r"); } catch (e) { e.name = "A"; e.message = ""; console.log(String(e), \`[\${e}]\`); }
try { throw new Error("t"); } catch (e) { e.message = "two\\nlines"; console.log(String(e)); }`,
  },
  {
    id: "GH137-JS-03b a non-string name assigned to a caught error stops at its named fence",
    entry: "main.js",
    src: `try { throw new Error("t"); } catch (e) { console.log("before"); e.name = undefined; console.log(String(e)); }`,
    fence: { text: /assigning a non-string 'name' to an error held in a dynamic value is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH137-JS-03c a non-string message assigned to a caught error stops at its named fence",
    entry: "main.js",
    src: `try { throw new Error("t"); } catch (e) { console.log("before"); e.message = 5; console.log(String(e)); }`,
    fence: { text: /assigning a non-string 'message' to an error held in a dynamic value is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH137-JS-04 an own toString member is what the conversions call",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { e.toString = () => "mine"; console.log(String(e), \`\${e}\`, e.toString()); }`,
  },
  {
    id: "GH137-JS-05 inspecting a caught error (emptied stack): the S027 bracket form, renamed and nested",
    entry: "main.js",
    src: `${SHOW_JS}
const nul = JSON.parse("null");
try { nul.x; } catch (e) { show(e); }
try { throw new RangeError("line one\\nline two"); } catch (e) { show(e); }
try { throw new TypeError("t"); } catch (e) { e.name = "MyError"; show(e); }
try { throw new TypeError("t"); } catch (e) { e.name = "TypeErrorX"; show(e); }
try { throw new TypeError("t"); } catch (e) { e.name = "ErrorType"; show(e); }
try { throw new Error("t"); } catch (e) { e.name = "Custom"; show(e); }
try { throw new Error(""); } catch (e) { show(e); }
try { decodeURIComponent("%"); } catch (e) { show(e); }`,
  },
  {
    id: "GH137-JS-06 inspecting user error classes: Node's improveStack header",
    entry: "main.js",
    src: `class AppError extends Error {}
class MyType extends TypeError {}
class Named extends Error { constructor(m) { super(String(m)); this.name = "Named"; } }
try { throw new AppError("m"); } catch (e) { e.stack = ""; console.log(e, [e], String(e)); }
try { throw new MyType("m"); } catch (e) { e.stack = ""; console.log(e, [e], String(e)); }
try { throw new Named("m"); } catch (e) { e.stack = ""; console.log(e, [e], String(e)); }`,
  },
  {
    id: "GH137-JS-07 beyond the depth budget an error prints in full",
    entry: "main.js",
    src: `const util = require("node:util");
try { throw new TypeError("t"); } catch (e) { e.stack = ""; e.name = "Custom"; console.log(util.inspect({ a: { b: { c: e } } })); console.log(util.inspect({ a: { b: { c: [e] } } }, { depth: 0 })); }`,
  },
  {
    id: "GH137-JS-08 an error with an extra own property stops at its named fence",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { e.stack = ""; e.extra = 1; console.log("before", String(e)); console.log(e); }`,
    fence: { text: /inspecting an error held in a dynamic value with own properties beyond name, message and code is not supported yet/, stdout: "before TypeError: t\n" },
  },
  {
    id: "GH137-JS-09 a code member a program writes does not make an error print as Node's internal errors do",
    entry: "main.js",
    src: `const nul = JSON.parse("null");
try { nul.x; } catch (e) { e.code = "ERR_X"; console.log(String(e), e.toString(), \`\${e}\`, "" + e); }
try { throw new TypeError("t"); } catch (e) { e.code = "ERR_Y"; e.stack = ""; console.log(e); }`,
  },
  {
    id: "GH137-JS-14 an object spelling the error marker is an ordinary object to inspect",
    entry: "main.js",
    src: `console.log(JSON.parse('{"%error":true,"name":"A","message":"b"}'));
const o = JSON.parse('{"%error":1}');
console.log(o, [o]);`,
  },
  {
    id: "GH137-JS-10 an error whose name prints empty stops at its named fence when inspected",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { e.stack = ""; e.name = ""; console.log("before", String(e)); console.log(e); }`,
    fence: { text: /inspecting an error held in a dynamic value whose name prints empty is not supported yet/, stdout: "before t\n" },
  },
  {
    id: "GH137-JS-11 an error with its own stack stops at its named fence when inspected",
    entry: "main.js",
    src: `try { throw new TypeError("t"); } catch (e) { e.stack = "S"; console.log("before", String(e)); console.log(e); }`,
    fence: { text: /inspecting an error held in a dynamic value with its own 'stack' \(Node prints the stack\) is not supported yet/, stdout: "before TypeError: t\n" },
  },
  {
    id: "GH137-JS-13 a Node internal error converts as NodeError does, and a DOMException inspects with its own header",
    entry: "main.cjs",
    src: `'use strict';
const qs = require("querystring");
try { qs.escape("a\\ud800"); } catch (e) { console.log(e.name, e.code, String(e), \`\${e}\`, "" + e); e.stack = ""; console.log(e); }
try { atob("*"); } catch (e) { e.stack = ""; console.log(e, [e], String(e)); }
const d = new DOMException("m", { name: "DataError", cause: 5 });
try { throw d; } catch (e) { e.stack = ""; console.log(e); }`,
  },
  {
    id: "GH137-JS-12 --dynamic JS: a renamed caught error converts with its new name",
    entry: "main.js",
    dynamic: true,
    src: `const nul = JSON.parse("null");
try { nul.x; } catch (e) { e.name = "Custom"; console.log(String(e), \`\${e}\`, "" + e); e.stack = ""; console.log(e); }`,
  },
  // ── TypeScript sources ──────────────────────────────────────────────
  {
    id: "GH137-TS-01 catch (e: any): a renamed error converts and prints with its new name",
    src: `import { format, inspect } from "node:util";
try { throw new TypeError("t"); } catch (e: any) {
  e.name = "Custom";
  console.log(String(e), \`\${e}\`, "x" + e, e.toString());
  e.stack = "";
  console.log(e, inspect(e), format("%s", e), format("%s", String(e)));
}
const n: any = JSON.parse("null");
try { n.x; } catch (e: any) { e.name = "Custom"; e.message = "t3"; console.log(String(e), \`\${e}\`); }`,
  },
  {
    id: "GH137-TS-02 a rename through any is seen by String() of the catch binding",
    src: `try { throw new TypeError("t"); } catch (e: unknown) { const u: any = e; u.name = "Custom"; console.log(String(e), String(u), \`\${e}\`); }
try { throw new RangeError("r"); } catch (e) { const u: any = e; u.message = "changed"; console.log(String(e), \`\${e}\`); }`,
  },
  {
    id: "GH137-TS-03 statically typed renames are unchanged",
    src: `const err = new Error("m");
err.name = "Custom";
console.log(String(err), \`\${err}\`, err.toString());
try { throw new TypeError("t"); } catch (e) { const x = e as Error; x.name = "Custom"; console.log(String(x), \`\${x}\`, x.toString()); }`,
  },
  {
    id: "GH137-TS-04 a user error class held in any prints with Node's header",
    src: `class AppError extends Error {}
try { throw new AppError("m"); } catch (e: any) { e.stack = ""; console.log(e, String(e)); e.name = "Renamed"; console.log(e, String(e)); }`,
  },
  {
    id: "GH137-TS-05 a dynamic write is seen through the typed error",
    src: `try { throw new TypeError("t"); } catch (e) {
  const u: any = e; u.name = "C"; u.message = "M";
  if (e instanceof Error) console.log(e.name, e.message, e.toString(), String(e));
}`,
  },
  {
    id: "GH137-TS-06 a typed write is seen through the dynamic value, the error's own class included",
    src: `class AppError extends Error {
  constructor(m: string) { super(m); this.name = "AppError"; }
  rename(): void { this.name = "Re"; this.message = "RM"; }
}
try { throw new TypeError("t"); } catch (e) {
  if (e instanceof Error) { const u: any = e; e.name = "Static"; e.message = "SM"; console.log(u.name, u.message, String(u), e.toString()); }
}
try { throw new AppError("a"); } catch (e) { const u: any = e; if (e instanceof AppError) { e.rename(); console.log(u.name, u.message, String(u)); } }
function run(): string {
  try { throw new TypeError("boom"); } catch (e) {
    const first: unknown = e;
    (e as Error).message = "MUTATED";
    (e as Error).name = "Renamed";
    const second: unknown = e;
    const x: any = first;
    const y: any = second;
    return String(x.name) + "/" + String(x.message) + " " + String(y.name) + "/" + String(y.message) + " " + String(x === y) + " [" + String(x) + "]";
  }
}
console.log(run());`,
  },
  {
    id: "GH137-TS-07 a code member a program writes is ignored by every conversion; a stamped one is Node's",
    src: `const e = new Error("m");
const a: any = e;
a.code = "ERR_X";
console.log(String(e), String(a), \`\${a}\`, e.toString(), "" + a);
try { Buffer.alloc(-1); } catch (x: any) { console.log(String(x), \`\${x}\`, x.toString()); }`,
  },
  {
    id: "GH137-TS-08 Object.assign onto an error held in any writes the error",
    src: `const e = new TypeError("m");
const a: any = e;
Object.assign(a, { message: "assigned", name: "AN" });
console.log(e.message, e.name, String(e), String(a), a.name, e.toString());
const t = new RangeError("r");
const b: any = t;
t.name = "Typed";
t.message = "TM";
console.log(b.name, b.message, String(b), \`\${b}\`);
for (const k of ["name", "message"]) console.log(b[k]);`,
  },
  {
    id: "GH137-TS-09 a non-string name written through any stops at its named fence",
    src: `const e = new TypeError("m");
const a: any = e;
console.log("before");
a.name = 5;
console.log(String(e));`,
    fence: { text: /assigning a non-string 'name' to an error held in a dynamic value is not supported yet/, stdout: "before\n" },
  },
  {
    id: "GH137-TS-10 a typed conversion of an error given its own toString through any stops at its named fence",
    src: `const e = new TypeError("m");
const a: any = e;
a.toString = () => "mine";
console.log(String(a));
console.log("before");
console.log(String(e));`,
    fence: { text: /converting a typed error whose dynamic value has its own 'toString' is not supported yet/, stdout: "mine\nbefore\n" },
  },
  {
    id: "GH137-TS-11 typed name / message writes stay constant time with thousands of crossed errors",
    src: `const kept: Error[] = [];
const seen: any[] = [];
for (let i = 0; i < 6000; i++) { const e = new Error("c" + i); const u: any = e; seen.push(u); kept.push(e); }
const t0 = Date.now();
const e = new Error("m");
let last = "";
for (let i = 0; i < 300000; i++) { e.name = "N" + (i % 7); e.message = "M"; last = String(e); }
const c = kept[5999]!;
for (let i = 0; i < 300000; i++) { c.message = "x" + (i % 5); }
const big: any = JSON.parse("{}");
for (let i = 0; i < 2000; i++) big["k" + i] = i;
for (let i = 0; i < 2000; i++) { big.name = "a"; big.message = "b"; }
console.log(last, seen.length, seen[5999].message, big.name, Date.now() - t0 < 3000);`,
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

describe("GH #137: an error held in a dynamic value converts and prints with its own members (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #137: an error held in a dynamic value converts and prints with its own members (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
