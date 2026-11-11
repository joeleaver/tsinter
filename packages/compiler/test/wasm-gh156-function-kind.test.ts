/* GH #156: an async function value prints `[AsyncFunction: af]`, as Node
 * prints it, where it printed `[Function: af]` (silently). The inspect
 * header names the function's kind: AsyncFunction, GeneratorFunction and
 * AsyncGeneratorFunction, named and `(anonymous)`, through console.log,
 * util.inspect (baked and dynamic), and past the depth budget. A box whose
 * function the lowering cannot see prints `Function` (SEMANTICS.md S020's
 * GH #156 amendment), and a row pins that beside Node's answer.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh156-"));
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
  /** A registered divergence: this tier prints `stdout` where Node prints
   * `node` (both asserted, so the row notices either side moving). */
  diverges?: { stdout: string; node: string; entry: string };
}

const ROWS: Row[] = [
  {
    id: "GH156-JS-01 the issue's repro: an async function prints as AsyncFunction, alone and in a container",
    entry: "main.js",
    src: `async function af() {}
const xs = JSON.parse("[]");
xs.push(af);
console.log(af, xs);`,
  },
  {
    id: "GH156-JS-02 async arrows, async function expressions, anonymous ones, in containers",
    entry: "main.js",
    src: `async function af() {}
const aa = async () => {};
const ae = async function () {};
console.log(af, aa, ae);
const xs = JSON.parse("[]");
xs.push(af, aa, ae, async () => {});
console.log(xs);
const o = JSON.parse("{}");
o.anon = async () => {};
console.log(o, [o.anon]);
function plain() {}
console.log(plain, () => 0);`,
  },
  {
    id: "GH156-JS-03 util.inspect of async functions, nested and at the depth budget",
    entry: "main.js",
    src: `const util = require("node:util");
async function af() {}
const xs = JSON.parse("[]");
xs.push(af);
console.log(util.inspect(af), util.inspect(xs), util.inspect(xs, { depth: 0 }));
const deep = JSON.parse('{"a":{"b":{}}}');
deep.a.b.c = xs;
console.log(util.inspect(deep), util.inspect(deep, { depth: 0 }));
console.log(Object.hasOwn(xs[0], "prototype"), "prototype" in xs[0]);`,
  },
  {
    id: "GH156-JS-05 an assert failure message renders an async function with its kind",
    entry: "main.js",
    src: `const assert = require("node:assert");
async function af() {}
const a = JSON.parse("{}"); a.f = 1;
const b = JSON.parse("{}"); b.f = 2; b.g = JSON.parse("[]"); b.g.push(af);
try { assert.deepStrictEqual(a, b); } catch (e) { console.log(e.message); }`,
  },
  {
    id: "GH156-TS-03 TypeScript: async functions held in any containers",
    src: `async function af() {}
const aa = async () => {};
const xs: any = [af, aa];
console.log(xs, [xs[0]]);
xs.push(async () => {});
console.log(xs);`,
  },
  {
    id: "GH156-JS-04 generator functions: GeneratorFunction and AsyncGeneratorFunction headers through util.inspect",
    entry: "main.js",
    src: `const util = require("node:util");
function* g() { yield 1; }
console.log(util.inspect(g), util.inspect(function* () {}), util.inspect(function* named() {}));`,
  },
  {
    id: "GH156-TS-01 TypeScript: declarations, arrows, expressions, statics, unknown",
    src: `import { inspect } from "node:util";
async function af() {}
function* g() { yield 1; }
const aa = async () => {};
const ae = async function () {};
class C { static async s() {} }
console.log(af, aa, ae, C.s);
console.log(inspect(af), inspect(g), inspect(aa), inspect(async () => 1), inspect(function* () {}));
const u: unknown = af;
console.log(u, typeof u);
function plain() {}
console.log(plain);`,
  },
  {
    id: "GH156-TS-02 an async function seen only as a parameter prints as Function (S020)",
    src: `async function af() {}
function show(f: () => Promise<void>): void { console.log(f); }
show(af);`,
    diverges: { stdout: "[Function: f]\n", node: "[AsyncFunction: af]\n", entry: "S020" },
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

describe("GH #156: a function value's inspect header names its kind (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #156: a function value's inspect header names its kind (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
