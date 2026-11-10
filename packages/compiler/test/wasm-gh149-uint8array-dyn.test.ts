/* GH #149: `new Uint8Array(x)` in a JavaScript source, over an argument
 * that is already a checked-dynamic value (a parameter, an array literal
 * of dynamic numbers), compiled to an internal error (SC9001 "dynFromJsval
 * operand must be jsval, got dyn"). The issue met it through a local
 * `var Buffer = { from(s) { return new Uint8Array(...); } }`. It now builds
 * as Node does for a length, an array of numbers (ToUint8 per element), a
 * typed array (a copy) and undefined or null (empty); any other argument
 * (a string, an array-like object) stops at the checked
 * extraction's named fence (SEMANTICS.md S122).
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh149-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source, written as main.js. */
  src: string;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
}

const ROWS: Row[] = [
  {
    id: "GH149-01 the issue's shape: a local Buffer object whose from builds a Uint8Array, passed on",
    src: `function show(x) { console.log(x.length, x[0], x[1], x[2]); }
function f() {
  var Buffer = { from(s) { return new Uint8Array([s.length, 300, -1]); } };
  show(Buffer.from("abc"));
}
f();`,
  },
  {
    id: "GH149-02 a dynamic length, an array of numbers and a typed array; a negative length throws Node's RangeError",
    src: `function g(a) { const u = new Uint8Array(a); return u.length + ":" + u.join(","); }
console.log(g([1, 2.7, 256]), g(3), g(new Uint8Array([9, 8])), g(0));
try { g(-1); } catch (e) { console.log(e instanceof RangeError, e.message); }`,
  },
  {
    id: "GH149-03 a typed-array argument is copied, not shared",
    src: `function g(a) { const u = new Uint8Array(a); u[0] = 77; return u; }
const src = new Uint8Array([1, 2]);
const c = g(src);
console.log(src[0], c[0], c.length);`,
  },
  {
    id: "GH149-04 the argument is evaluated once",
    src: `let n = 0;
function arg() { n++; return [1, 2]; }
function g() { return new Uint8Array(arg()); }
console.log(g().length, n);`,
  },
  {
    id: "GH149-06 undefined, a missing argument, a missing member and null build an empty array",
    src: `function g(a) { return new Uint8Array(a); }
const o = { n: 2 };
function k(x) { return g(x); }
console.log("before");
console.log(g(undefined).length, k().length, g(o.missing).length, g(null).length);`,
  },
  {
    id: "GH149-07 a string argument stops at the named fence",
    src: `function g(a) { return new Uint8Array(a); }
console.log("before");
console.log(g("3").length);`,
    fence: { text: /expected Uint8Array at \$, got string \[SC1100\]/, stdout: "before\n" },
  },
  {
    id: "GH149-05 an array holding a non-number stops at the named fence",
    src: `function g(a) { return new Uint8Array(a); }
console.log("before");
console.log(g(["1"]).length);`,
    fence: { text: /expected number at \$\[0\], got string \[SC1100\]/, stdout: "before\n" },
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.js");
  writeFileSync(entry, row.src + "\n");
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
  expect(got, row.id).toEqual(node);
}

describe("GH #149: new Uint8Array over a checked-dynamic argument in JavaScript (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #149: new Uint8Array over a checked-dynamic argument in JavaScript (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
