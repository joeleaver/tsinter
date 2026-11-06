/* GH #127: throwing a union-typed value throws its arm — a number, string
 * or boolean arm reads back as that primitive, an Error arm as its class
 * (instanceof, name, message), a unit arm as undefined or null — where the
 * whole union used to ride the exception cell's generic arm and read back
 * as an object.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh127-"));
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
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** A registered divergence: this tier prints `stdout` where Node prints
   * `node` (both asserted, so the row notices either side moving). */
  diverges?: { stdout: string; node: string; entry: string };
}

const ROWS: Row[] = [
  {
    id: "GH127-01 the issue's repro: an Error | string | number element thrown and caught",
    src: `for (const v of [new Error("e"), "str", 42]) {
  try { throw v; } catch (e) { console.log(typeof e); }
}`,
  },
  {
    id: "GH127-02 each arm reads back as its own kind: instanceof, message, String, equality",
    src: `function pick(i: number): Error | string | number | boolean {
  if (i === 0) return new TypeError("bad");
  if (i === 1) return "text";
  if (i === 2) return 7;
  return false;
}
for (let i = 0; i < 4; i++) {
  try { throw pick(i); } catch (e) {
    console.log(i, typeof e, e instanceof Error, e instanceof TypeError, String(e), e === 7, e === "text", e === false);
    if (e instanceof Error) console.log("  ", e.name, e.message);
    if (typeof e === "string") console.log("  ", e.length, e.toUpperCase());
    if (typeof e === "number") console.log("  ", e + 1);
  }
}`,
  },
  {
    id: "GH127-03 unit arms: undefined and null throw as themselves",
    src: `const vs: (number | undefined | null)[] = [1, undefined, null];
for (const v of vs) {
  try { throw v; } catch (e) { console.log(typeof e, e === undefined, e === null, String(e)); }
}`,
  },
  {
    id: "GH127-04 a rethrow keeps the arm; a finally runs; an outer catch sees the same value",
    src: `function f(u: string | number): void {
  try { throw u; } catch (e) { console.log("inner", typeof e); throw e; } finally { console.log("finally"); }
}
for (const u of ["a", 2] as (string | number)[]) {
  try { f(u); } catch (e) { console.log("outer", typeof e, e); }
}`,
  },
  {
    id: "GH127-05 a union thrown inside an async function rejects with the arm",
    src: `async function g(u: Error | string | number): Promise<void> { throw u; }
async function main(): Promise<void> {
  for (const u of [new RangeError("r"), "s", 3] as (Error | string | number)[]) {
    try { await g(u); } catch (e) { console.log(typeof e, e instanceof RangeError, String(e)); }
  }
}
main();`,
  },
  {
    id: "GH127-07 a union holding its slot's undefined (an array hole) throws undefined",
    src: `const arr: (string | number)[] = [1, "a"];
try { throw arr[5]; } catch (e) { console.log("hole", typeof e, e, e === undefined); }
const errs: (Error | string)[] = [new Error("x")];
try { throw errs[3]; } catch (e) { console.log("hole2", typeof e, e); }
try { throw arr[1]; } catch (e) { console.log("arm", typeof e, e); }`,
  },
  {
    id: "GH127-08 a fall-off function's undefined union result, thrown",
    src: `type S = { kind: "a" } | { kind: "b" };
const s = JSON.parse('{"kind":"c"}') as S;
function fu(x: S): string | number { switch (x.kind) { case "a": return "A"; case "b": return 2; } }
try { throw fu(s); } catch (e) { console.log("falloff", typeof e, e); }
try { throw fu({ kind: "b" }); } catch (e) { console.log("arm", typeof e, e); }`,
  },
  {
    id: "GH127-06 a user Error subclass arm keeps its class",
    src: `class AppError extends Error {
  constructor(m: string, public readonly code: number) { super(m); this.name = "AppError"; }
}
const items: (AppError | string)[] = [new AppError("boom", 42), "plain"];
for (const it of items) {
  try { throw it; } catch (e) {
    if (e instanceof AppError) console.log("app", e.name, e.message, e.code);
    else console.log("other", typeof e, e);
  }
}`,
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
  if (row.diverges !== undefined) {
    expect(node.stdout, `${row.id}: Node's side of ${row.diverges.entry}`).toBe(row.diverges.node);
    expect(got, `${row.id}: this tier's side of ${row.diverges.entry}`).toEqual({ stdout: row.diverges.stdout, stderr: "", exitCode: 0 });
    return;
  }
  expect(got, row.id).toEqual(node);
}

describe("GH #127: throwing a union-typed value (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #127: throwing a union-typed value (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
