/* GH #256: a TDZ ReferenceError is catchable.
 *
 * Reading, writing or updating a `let`/`const` binding before its
 * declaration has run throws Node's ReferenceError "Cannot access '<name>'
 * before initialization". A try/catch around the access catches it (name,
 * message, instanceof Error, String(e)), and the
 * program goes on; uncaught, it prints Node's report and exits 1.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-tdz-catch-"));
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
    id: "TDZ-01 the issue's repro: `r ??= 2` on a module let before its declaration, caught, with name, message and instanceof",
    entry: "main.ts",
    src: `function early(): void {
  try { r ??= 2; } catch (e) { console.log("caught", (e as Error).name, (e as Error).message, e instanceof Error); }
}
early();
let r: number | null = null;
early();
console.log("r", r);`,
  },
  {
    id: "TDZ-02 a plain read, a write, a compound update and typeof of a module let in its TDZ, each caught; then the same accesses after the declaration",
    entry: "main.ts",
    src: `function early(): void {
  try { console.log(r); } catch (e) { console.log("read", String(e)); }
  try { r = 3; } catch (e) { console.log("write", (e as Error).message); }
  try { r += 1; } catch (e) { console.log("update", (e as Error).message); }
  try { console.log(typeof r); } catch (e) { console.log("typeof", (e as Error).message); }
}
early();
let r: number = 0;
early();
console.log("r", r);`,
  },
  {
    id: "TDZ-03 a module const of each kind (string, record, function) read in its TDZ through a function, caught; finally runs",
    entry: "main.ts",
    src: `function peek(): void {
  try { console.log(s.length); } catch (e) { console.log("s", (e as Error).message); } finally { console.log("finally"); }
  try { console.log(o.n); } catch (e) { console.log("o", (e as Error).message); }
  try { console.log(f()); } catch (e) { console.log("f", (e as Error).message); }
}
peek();
const s: string = "abc";
const o: { n: number } = { n: 1 };
const f = (): number => 7;
peek();`,
  },
  {
    id: "TDZ-04 a function-scope const captured by a closure called before the declaration ran, caught; after it, the value",
    entry: "main.ts",
    src: `function local(): void {
  const read = (): number => q;
  try { read(); } catch (e) { console.log("closure", (e as Error).name, (e as Error).message); }
  const q = 5;
  console.log(read());
}
local();`,
  },
  {
    id: "TDZ-05 the error propagates to an outer try through calls, and a catch that rethrows reaches the outer handler",
    entry: "main.ts",
    src: `function inner(): number { return v * 2; }
function middle(): number { try { return inner(); } catch (e) { console.log("middle", (e as Error).message); throw e; } }
try { middle(); } catch (e) { console.log("outer", e instanceof Error, (e as Error).message); }
let v = 21;
console.log(middle());`,
  },
  {
    id: "TDZ-06 in JavaScript: a module let read and assigned in its TDZ, caught",
    entry: "main.js",
    src: `function early() {
  try { r ??= 2; } catch (e) { console.log("caught", e.name, e.message, e instanceof Error, String(e)); }
  try { r = 1; } catch (e) { console.log("write", e.message); }
}
early();
/** @type {number | null} */
let r = null;
early();
console.log(r);`,
  },
  {
    id: "TDZ-08 in JavaScript: module lets of every initial kind (null, a string, none) behind a function that starts the file; each early access caught, each later one Node's value",
    entry: "main.js",
    src: `function early(tag) {
  try { a ??= 2; } catch (e) { console.log(tag, "a", e.message); }
  try { b += "!"; } catch (e) { console.log(tag, "b", e.message); }
  try { console.log(tag, typeof c, c); } catch (e) { console.log(tag, "c", e.message); }
}
early("before");
console.log("mid");
/** @type {number | null} */
let a = null;
let b = "s";
let c;
early("after");
console.log(a, b, c);`,
  },
  {
    id: "TDZ-07 uncaught, the TDZ error still prints Node's report and exits 1",
    entry: "main.ts",
    src: `function early(): number { return r + 1; }
console.log("before");
console.log(early());
let r = 1;`,
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
  if (row.id.startsWith("TDZ-07")) {
    // Node's uncaught report names the source file and line: compare the
    // exit code, stdout and the error line.
    expect(node.exitCode).toBe(1);
    expect(got.exitCode, row.id).toBe(1);
    expect(got.stdout, row.id).toBe(node.stdout);
    expect(got.stderr, row.id).toContain("ReferenceError: Cannot access 'r' before initialization");
    return;
  }
  expect(node.exitCode, JSON.stringify(node)).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("TDZ ReferenceErrors are catchable (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("TDZ ReferenceErrors are catchable (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
