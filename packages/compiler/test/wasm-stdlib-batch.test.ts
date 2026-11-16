/* Paperclip's standard-library and @types/node surface batch: exactly the
 * call shapes paperclip's sources use (its first end-to-end run's SC2020
 * sites), Node-exact; other shapes keep their named refusals.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane, or stops by name where
 * noted. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-stdlib-"));
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
  /** Node's exit status for the row (default 0); the tier's must match. */
  exit?: number;
  /** Still stops by name on this tier: stdout up to the stop is a prefix
   * of Node's, and stderr names the diagnostic. */
  nativeOnly?: boolean;
  fence?: string;
  /** The build refuses, and some diagnostic's message contains this. */
  refusedMsg?: string;
  /** Other files written beside the entry (name -> source). */
  extra?: Record<string, string>;
}

const ROWS: Row[] = [
  {
    id: "SB-01 URLSearchParams.set with 'any' values (paperclip's CLI flags): strings, numbers, booleans and objects coerce as Node's USVString conversion",
    src: `const opts: any = { status: "open", limit: 25, archived: false, tag: { toString() { return "T"; } } };
const params = new URLSearchParams();
params.set("status", opts.status);
params.set("limit", opts.limit);
params.set("archived", opts.archived);
params.set("tag", opts.tag);
params.set(opts.status, "x");
console.log(params.toString());`,
  },
  {
    id: "SB-02 fs/promises through a named 'promises' import (paperclip's import { promises as fs } from 'node:fs'): the call shapes paperclip uses",
    // the shared-host wasm lane's fs import is loud by design (wasm-host.ts);
    // real file-system calls run on the native lane only.
    nativeOnly: true,
    src: `import { promises as fs, constants as fsConstants } from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb02-"));
const file = path.join(dir, "a.txt");
await fs.writeFile(file, "hello", { mode: 0o600, encoding: "utf8" });
console.log(await fs.readFile(file, "utf8"), (await fs.readFile(file)).length);
await fs.mkdir(path.join(dir, "sub", "deep"), { recursive: true });
await fs.writeFile(path.join(dir, "sub", "b.txt"), "b");
const st = await fs.stat(file);
console.log(st.isFile(), st.size);
console.log((await fs.readdir(dir)).sort().join(","));
await fs.copyFile(file, path.join(dir, "c.txt"));
console.log(await fs.readFile(path.join(dir, "c.txt"), "utf8"));
await fs.access(file, fsConstants.R_OK);
console.log((await realpath(path.join(dir, "sub", "..", "a.txt"))) === (await realpath(file)));
try { await fs.access(path.join(dir, "nope"), fsConstants.R_OK); } catch (e) { console.log("access", (e as NodeJS.ErrnoException).code); }
try { await realpath(path.join(dir, "nope")); } catch (e) { console.log("realpath", (e as NodeJS.ErrnoException).code); }
const handle = await fs.open(path.join(dir, "lock"), "wx", 0o600);
await handle.close();
await fs.rm(path.join(dir, "lock"), { force: true });
await fs.rm(path.join(dir, "missing"), { force: true });
await fs.rm(dir, { recursive: true, force: true });
console.log("done");`,
  },
  {
    id: "SB-03 import.meta.resolve in code the run never reaches builds and runs as Node does (paperclip's runtime setup)",
    src: `export async function setupPi(): Promise<string> {
  return import.meta.resolve("node:path");
}
console.log("main ran");`,
  },
  {
    id: "SB-04 import.meta.resolve reached stops by name (a module resolution at run time)",
    src: `export {};
console.log("before");
const where = import.meta.resolve("node:path");
console.log(where);`,
    fence: "import.meta.resolve(specifier)",
  },
  {
    id: "SB-07 URL username and password (paperclip's userinfo checks): present, absent, percent-encoded, empty password",
    src: `for (const s of ["https://u:p@h.test/x", "https://h.test/", "https://us%20er:@h.test/", "https://a@h.test", "file:///tmp/x"]) {
  const url = new URL(s);
  console.log(JSON.stringify(url.username), JSON.stringify(url.password), Boolean(url.username || url.password));
}`,
  },
  {
    id: "SB-05 fs/promises symlink, readlink and readdir withFileTypes in code the run never reaches build and run as Node does",
    src: `import { promises as fs } from "node:fs";
export async function relink(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await fs.symlink(entries[0]!.name, dir + "/alias");
  return fs.readlink(dir + "/alias");
}
console.log("built");`,
  },
  {
    id: "SB-06 fs/promises symlink reached stops by name",
    src: `import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
console.log("before");
const link = path.join(os.tmpdir(), "sb06-" + Math.random().toString(36).slice(2));
await fs.symlink("a", link);
console.log("after");
await fs.unlink(link);`,
    fence: "fs/promises symlink",
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.extra ?? {})) writeFileSync(join(dir, name), text + "\n");
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
  if (row.refusedMsg !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.some((d) => d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.fence !== undefined) {
    expect(node.exitCode).toBe(0);
    expect(got.exitCode, row.id).not.toBe(0);
    expect(node.stdout.startsWith(got.stdout), row.id).toBe(true);
    expect(got.stderr, row.id).toContain(row.fence);
    return;
  }
  expect(node.exitCode, JSON.stringify(node)).toBe(row.exit ?? 0);
  expect(got, row.id).toEqual(node);
}

describe("Paperclip's stdlib batch (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    if (row.nativeOnly === true) return;
    await check(row, "wasm");
  });
});

describe("Paperclip's stdlib batch (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
