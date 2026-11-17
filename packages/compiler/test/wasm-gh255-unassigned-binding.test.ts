/* GH #255: a number or boolean `let`/`var` with no initializer (a
 * definite-assignment `let n!: number`, or one a closure reads before the
 * write) started at its zero value — 0 / false — where Node has undefined,
 * and `n ??= 5` then kept the 0. On the WasmGC lanes it now starts as its
 * slot's undefined (SEMANTICS.md S119), and `??=` honours it.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh255-"));
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
    id: "DA-01 (GH #255) a definite-assignment let reads undefined before its write: number, boolean, string; ??= honours it",
    entry: "main.ts",
    src: `let n!: number; console.log(n);
let n2!: number; n2 ??= 5; console.log(n2);
let b!: boolean; b ??= true; console.log(b);
let b2!: boolean; console.log(b2, b2 ? "t" : "f", !b2, typeof b2, typeof n);
let s!: string; console.log(s, typeof s);
console.log(n + 1, n === undefined, b2 === undefined, String(n), \`\${n}\`, JSON.stringify({ n, b2 }));`,
  },
  {
    id: "DA-02 (GH #255) a let and a module var a closure reads before the write",
    entry: "main.ts",
    src: `let x: number;
function rd() { return x; }
console.log(rd());
x = 3;
console.log(rd());
var v: number;
function rv() { return v; }
console.log(rv());
v = 4; console.log(rv());
var vb: boolean;
function rb() { return vb; }
console.log(rb(), rb() ? 1 : 2);`,
  },
  {
    id: "DA-03 (GH #255) function-local let and var, a per-iteration let, and a ?? accumulator",
    entry: "main.ts",
    src: `function f(): string {
  let k!: number;
  let flag!: boolean;
  const g = () => [k, flag];
  const before = JSON.stringify(g());
  k = 2; flag = false;
  return before + " " + JSON.stringify(g());
}
console.log(f());
function h() { var w: number; const g = () => w; const r = g(); w = 1; return [r, g()]; }
console.log(h());
for (let i = 0; i < 2; i++) { let t!: number; console.log(t); t = i; }
let total!: number;
for (const k of [1, 2]) { total = (total ?? 0) + k; }
console.log(total);`,
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

describe("GH #255: unassigned number and boolean bindings (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #255: unassigned number and boolean bindings (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
