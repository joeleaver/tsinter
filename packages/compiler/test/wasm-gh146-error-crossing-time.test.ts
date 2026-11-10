/* GH #146: an error's first crossing into a dynamic value looked for its
 * existing encoding by scanning a process-long list of every error that
 * had ever crossed, so a loop that catches a fresh error and reads it
 * through `any` grew quadratic (200k iterations: ~78s where Node takes
 * 0.3s). The encoding now lives in the error's own slot: every crossing
 * is constant time and the encoding lives as long as its error. Identity
 * is unchanged (the same error crosses as the same value), and the timing
 * rows pin the cost with a bound far above the fixed time and far below
 * the old one. Every row equals Node (spawned at test time), on the wasm
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh146-"));
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
  /** A timing row: the compiled program's run must finish inside this
   * many milliseconds (measured around the run, so it holds on the wasm
   * lane, whose host clock is virtual, as much as on the native one). */
  budgetMs?: number;
}

const ROWS: Row[] = [
  {
    id: "GH146-TS-01 the issue's repro: 200k caught errors read through any stay linear",
    src: `let n = 0;
for (let i = 0; i < 200000; i++) {
  try { decodeURIComponent("%"); } catch (e) { const d: any = e; if (d.name === "URIError") n++; }
}
console.log(n);`,
    budgetMs: 20_000,
  },
  {
    id: "GH146-TS-02 reading constructor through any over 200k caught errors stays linear",
    src: `let n = 0;
for (let i = 0; i < 200000; i++) {
  try { JSON.parse("{"); } catch (e) { const d: any = e; if (d.constructor.name === "SyntaxError" && d instanceof SyntaxError) n++; }
}
console.log(n);`,
    budgetMs: 20_000,
  },
  {
    id: "GH146-TS-03 typed errors crossing into any by the thousand keep their identity",
    src: `const errs: Error[] = [];
const first: any[] = [];
for (let i = 0; i < 20000; i++) { const e = i % 2 === 0 ? new Error("e" + i) : new TypeError("t" + i); errs.push(e); const a: any = e; first.push(a); }
let same = 0;
for (let i = errs.length - 1; i >= 0; i--) { const again: any = errs[i]!; if (again === first[i]) same++; }
const a: any = errs[7]!;
a.name = "Seven";
a.extra = 7;
const b: any = errs[7]!;
console.log(same, errs[7]!.name, String(errs[7]!), b.extra, b === a, first[7] === b, first[8] === b);`,
    budgetMs: 20_000,
  },
  {
    id: "GH146-JS-01 a JavaScript loop over 200k caught errors stays linear",
    entry: "main.js",
    src: `const nul = JSON.parse("null");
let n = 0;
for (let i = 0; i < 200000; i++) {
  try { nul.x; } catch (e) { if (e.name === "TypeError" && e.constructor.name === "TypeError") n++; }
}
console.log(n);`,
    budgetMs: 20_000,
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
  const t0 = Date.now();
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  const ms = Date.now() - t0;
  expect(got, row.id).toEqual(node);
  if (row.budgetMs !== undefined) expect(ms, `${row.id}: ${ms}ms`).toBeLessThan(row.budgetMs);
}

describe("GH #146: an error crossing into a dynamic value is constant time (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  }, 300_000);
});

describe("GH #146: an error crossing into a dynamic value is constant time (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
