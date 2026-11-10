/* GH #155: `throw undefined` / `throw null` compile (they failed with the
 * internal SC9001 "bare unitLit 'undefined' outside a unionWrap") and throw
 * the value itself, as Node does: a catch binding reads back `e ===
 * undefined` / `e === null` with Node's typeof, printing, conversions and
 * rethrow; `throw void 0` and a binding typed `undefined` / `null` throw
 * the same; `Promise.reject(undefined)` / `Promise.reject(null)` reject
 * with it; and an uncaught one exits 1 after reporting `Uncaught
 * undefined` (SEMANTICS.md S007: Node's own stderr is its source-line
 * report, so stdout and the exit code are what match).
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh155-"));
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
}

const ROWS: Row[] = [
  {
    id: "GH155-01 the issue's repro: throw undefined / throw null are caught as themselves",
    src: `try { throw undefined; } catch (e) { console.log("caught", e); }
try { throw null; } catch (e) { console.log("caught", e); }`,
  },
  {
    id: "GH155-02 a caught undefined / null answers typeof, ===, conversions and inspect as Node's",
    src: `function thrower(k: number): number {
  if (k === 0) throw undefined;
  if (k === 1) throw null;
  return k;
}
for (let k = 0; k < 3; k++) {
  try { console.log("ret", thrower(k)); }
  catch (e) {
    console.log(k, typeof e, e === undefined, e === null, String(e), \`\${e}\`, JSON.stringify(e), e instanceof Error, e ?? "dflt", [e], !e);
  } finally { console.log("fin", k); }
}`,
  },
  {
    id: "GH155-03 throw void 0 and bindings typed undefined / null throw the value",
    src: `try { throw void 0; } catch (e) { console.log("void", e, e === undefined); }
const x: undefined = undefined;
const y: null = null;
try { throw x; } catch (e) { console.log("x", e, typeof e); }
try { throw y; } catch (e) { console.log("y", e, typeof e); }`,
  },
  {
    id: "GH155-04 a caught null rethrows as itself",
    src: `try { try { throw null; } catch (e) { console.log("inner", e); throw e; } } catch (e) { console.log("outer", e, e === null); }
function f(): void { try { throw undefined; } finally { console.log("finally"); } }
try { f(); } catch (e) { console.log("from f", e); }`,
  },
  {
    id: "GH155-05 an async function's throw undefined and Promise.reject(undefined / null) reject with the value",
    src: `async function g(): Promise<number> { throw undefined; }
const p: Promise<number> = Promise.reject(undefined);
p.catch((e) => console.log("rej", e, typeof e, e === undefined));
const q: Promise<string> = Promise.reject(null);
q.catch((e) => console.log("rejn", e, typeof e, e === null));
g().catch((e) => console.log("g", e, e === undefined));
Promise.reject(undefined).catch((e) => console.log("bare", e));
async function h(): Promise<void> {
  try { await p; } catch (e) { console.log("await", e); }
  try { await g(); } catch (e) { console.log("await g", e); throw e; }
}
h().catch((e) => { console.log("h", e); });`,
  },
  {
    id: "GH155-06 JavaScript: throw undefined / null / void 0 and Promise.reject(undefined)",
    entry: "main.js",
    src: `try { throw undefined; } catch (e) { console.log("caught", e, typeof e, e === undefined, [e]); }
try { throw null; } catch (e) { console.log("caught", e, typeof e, e === null, [e]); }
try { throw void 0; } catch (e) { console.log("void", e); }
Promise.reject(undefined).catch((e) => console.log("rej", e));`,
  },
  {
    id: "GH155-07 an uncaught throw undefined exits 1 reporting Uncaught undefined",
    src: `console.log("a");
throw undefined;`,
    uncaught: { report: "Uncaught undefined" },
  },
  {
    id: "GH155-08 an uncaught throw null from a function exits 1 reporting Uncaught null",
    src: `function f(): number { console.log("in f"); throw null; }
console.log(f());`,
    uncaught: { report: "Uncaught null" },
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
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
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

describe("GH #155: throw undefined / throw null (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #155: throw undefined / throw null (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
