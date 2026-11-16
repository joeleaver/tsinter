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
    id: "SB-02b fs/promises realpath failures are the native realpath's: syscall realpath, the path as given, '' rejected",
    nativeOnly: true,
    src: `import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const d = await fs.mkdtemp(path.join(os.tmpdir(), "sb02b-"));
await fs.writeFile(path.join(d, "f"), "x");
for (const p of ["", path.join(d, "nope"), path.join(d, "nope", "x"), path.join(d, "f", "x")]) {
  try {
    console.log("ok", await fs.realpath(p));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(err.code, err.message.split(d).join("<D>"));
  }
}
await fs.rm(d, { recursive: true, force: true });`,
  },
  {
    id: "SB-02c fs/promises rm failures are rimraf's: the failing syscall and path (unlink, rmdir), one failure reported exactly",
    nativeOnly: true,
    src: `import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const d = await fs.mkdtemp(path.join(os.tmpdir(), "sb02c-"));
await fs.mkdir(path.join(d, "ro", "sd"), { recursive: true });
await fs.writeFile(path.join(d, "ro", "in"), "x");
await fs.mkdir(path.join(d, "ok", "deep"), { recursive: true });
await fs.writeFile(path.join(d, "ok", "deep", "f"), "x");
await fs.chmod(path.join(d, "ro"), 0o555);
const show = (err: NodeJS.ErrnoException) => { console.log(err.code, err.message.split(d).join("<D>")); };
try { await fs.rm(path.join(d, "ro", "in")); } catch (e) { show(e as NodeJS.ErrnoException); }
try { await fs.rm(path.join(d, "ro", "sd"), { recursive: true }); } catch (e) { show(e as NodeJS.ErrnoException); }
// (a tree with SEVERAL failures -- rm(ro, { recursive }) here -- is left
// out: Node reports whichever settles first, SEMANTICS.md S074)
try { await fs.rm(path.join(d, "ro", "in"), { force: true }); } catch (e) { show(e as NodeJS.ErrnoException); }
try { await fs.rm(path.join(d, "missing")); } catch (e) { show(e as NodeJS.ErrnoException); }
try { await fs.rm(path.join(d, "ok")); } catch (e) { show(e as NodeJS.ErrnoException); }
await fs.rm(path.join(d, "ok"), { recursive: true });
await fs.chmod(path.join(d, "ro"), 0o755);
await fs.rm(d, { recursive: true, force: true });
console.log("done");`,
  },
  {
    id: "SB-02f fs/promises rm of a symlink to a directory spelled with a trailing slash resolves and deletes nothing (rimraf's ENOTDIR with no original error)",
    nativeOnly: true,
    src: `import { promises as fs, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
const d = await fs.mkdtemp(path.join(os.tmpdir(), "sb02f-"));
await fs.mkdir(path.join(d, "dir"));
await fs.writeFile(path.join(d, "dir", "f"), "x");
spawnSync("ln", ["-s", "dir", path.join(d, "l")]);
await fs.rm(path.join(d, "l") + "/", { recursive: true });
console.log("ok", existsSync(path.join(d, "dir", "f")), existsSync(path.join(d, "l")));
await fs.rm(d, { recursive: true, force: true });`,
  },
  {
    id: "SB-02g a named sub-namespace import of node:path (win32, posix) is that module: its separators and joins as Node's",
    nodeTypes: true,
    src: `import { win32, posix } from "node:path";
console.log(JSON.stringify([win32.sep, win32.delimiter, posix.sep, posix.delimiter]));
console.log(win32.join("a", "b", "..", "c"), posix.join("/x", "y"), win32.basename("C:\\\\d\\\\f.txt"));`,
  },
  {
    id: "SB-02d mkdtemp appends six characters (fs/promises and mkdtempSync)",
    nativeOnly: true,
    src: `import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const a = await fs.mkdtemp(path.join(os.tmpdir(), "sb02d-"));
const b = mkdtempSync(path.join(os.tmpdir(), "sb02d-"));
console.log(path.basename(a).length - 6, path.basename(b).length - 6);
rmSync(a, { recursive: true });
rmSync(b, { recursive: true });`,
  },
  {
    id: "SB-02e access and accessSync range-check the mode as Node's binding does",
    src: `import { accessSync, promises as fs } from "node:fs";
for (const m of [8, -1, -1.5, 8.0001, NaN, Infinity]) {
  try { accessSync(".", m); } catch (e) { console.log(String(m), (e as Error).name, (e as NodeJS.ErrnoException).code, (e as Error).message); }
}
for (const m of [8, NaN]) {
  try { await fs.access(".", m); } catch (e) { console.log("promise", String(m), (e as Error).name, (e as NodeJS.ErrnoException).code, (e as Error).message); }
}`,
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
