/* Paperclip's standard-library and @types/node surface batch: exactly the
 * call shapes paperclip's sources use (its first end-to-end run's SC2020
 * sites), Node-exact; other shapes keep their named refusals.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane, or stops by name where
 * noted. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  /** A project with @types/node (the vendored tests/fixtures/node-types
   * copy) and a strict tsconfig, as paperclip has. */
  nodeTypes?: boolean;
  /** Environment changes for the run, Node's and the tier's alike (a
   * string sets the variable, undefined removes it). */
  env?: Record<string, string | undefined>;
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
  {
    id: "SB-08 Date values in code the run never reaches build (paperclip's backup keys, seed timestamps, token expiry); Date.parse of strings and a Date-typed member holding JSON's string run as Node does",
    nodeTypes: true,
    src: `function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return \`\${date.getFullYear()}\${pad(date.getMonth() + 1)}\${pad(date.getDate())}-\${pad(date.getHours())}\`;
}
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return \`\${d.getUTCFullYear()}-W\${Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)}\`;
}
function startAttempt(path: string, now = new Date()): { path: string; at: string } {
  return { path, at: now.toISOString() };
}
function resolveExpiresAt(opts: { neverExpires?: boolean; expiresAt?: string; ttlDays?: string }): Date | null | undefined {
  if (opts.neverExpires) return null;
  if (opts.expiresAt?.trim()) {
    const date = new Date(opts.expiresAt.trim());
    if (!Number.isFinite(date.getTime())) throw new Error(\`Invalid --expires-at value: \${opts.expiresAt}\`);
    return date;
  }
  if (opts.ttlDays?.trim()) return new Date(Date.now() + Number(opts.ttlDays) * 86400000);
  return undefined;
}
const str = (value: unknown, max = 160): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const iso = (value: unknown): string | null => {
  const text = str(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};
if (process.argv.length > 99) console.log(timestamp(), isoWeekKey(new Date(0)), startAttempt("x").at);
console.log(iso("2026-01-02T03:04:05Z"), iso("2026-01-02"), iso("never"), iso(5), iso(""));
console.log(Date.parse("2026-11-16T00:00:00.000Z"), Date.parse("Jul  1 00:00:00 2026 GMT"));
console.log(resolveExpiresAt({ neverExpires: true }), resolveExpiresAt({}));
type Row = { name: string; createdAt: Date; pausedAt: Date | null };
const row = JSON.parse('{"name":"acme","createdAt":"2026-01-01T00:00:00.000Z","pausedAt":null}') as Row;
console.log(row.name, typeof row.createdAt, row.createdAt, row.pausedAt === null);`,
  },
  {
    id: "SB-09 a Date object reached stops by name after its arguments evaluate",
    nodeTypes: true,
    src: `function ms(): number { console.log("arg evaluated"); return 0; }
console.log("before");
const d = new Date(ms());
console.log(d.getTime());`,
    fence: "new Date(...) as a value",
  },
  {
    id: "SB-10 FormData and Blob in code the run never reaches build (paperclip's attachment and asset uploads)",
    nodeTypes: true,
    src: `async function uploadAsset(apiBase: string, bytes: Uint8Array, file: string, opts: { namespace?: string; title?: string }): Promise<number> {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "image/png" }), file.split(/[\\\\/]/).pop() ?? "asset");
  if (opts.namespace?.trim()) form.set("namespace", opts.namespace.trim());
  if (opts.title?.trim()) form.set("title", opts.title.trim());
  const response = await fetch(apiBase + "/api/assets", { method: "POST", body: form });
  return response.status;
}
if (process.argv.length > 99) void uploadAsset("http://x", new Uint8Array(1), "a.png", {});
console.log("built");`,
  },
  {
    id: "SB-11 new FormData() reached stops by name",
    nodeTypes: true,
    src: `console.log("before");
const form = new FormData();
form.set("a", "b");
console.log("after");`,
    fence: "new FormData()",
  },
  {
    id: "SB-12 Object.fromEntries over pairs the static shapes decline (paperclip's connector scopes and permission records): Node's object, key order and duplicate rule",
    nodeTypes: true,
    src: `const auth = (s: string) => \`https://www.googleapis.com/auth/\${s}\`;
const one = (a: string, b?: string) => [(b === undefined ? [a] : [a, b]).map(auth)];
// (an object type, not Record<Service, …>: GH #235 orders a Record's keys)
const toolScopes: { gmail: Record<string, string[][]>; drive: Record<string, string[][]> } = {
  gmail: Object.fromEntries([
    ...["get_message", "get_thread", "list_labels"].map((name) => [name, one("gmail.readonly")]),
    ["create_draft", one("gmail.compose")],
    ["get_thread", one("gmail.modify")],
  ]),
  drive: Object.fromEntries([
    ...["read_file_content"].map((name) => [name, one("drive.readonly")]),
    ...["copy_file", "create_file"].map((name) => [name, one("drive.file", "drive")]),
  ]),
};
console.log(JSON.stringify(toolScopes), Object.keys(toolScopes.gmail).join(","));
const KEYS = ["canAssign", "canMention", "canEdit"] as const;
type Key = (typeof KEYS)[number];
function resolvePerms(value: unknown): Record<Key, boolean> {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(KEYS.map(key => [key, record[key] !== false])) as Record<Key, boolean>;
}
const perms = resolvePerms({ canMention: false });
console.log(JSON.stringify(perms), perms.canEdit, perms.canMention);`,
  },
  {
    id: "SB-13 a dynamic Object.fromEntries entry that is not an object stops by name",
    nodeTypes: true,
    src: `const rows = JSON.parse('[["a",1],5]') as any;
console.log("before");
try {
  console.log(Object.fromEntries(rows));
} catch (e) {
  console.log("caught", e instanceof TypeError);
}`,
    fence: "an entry that is not an object",
  },
  {
    id: "SB-14 util.styleText on a piped stdout with FORCE_COLOR unset (@clack/prompts' calls): the text unchanged, as Node answers it",
    nodeTypes: true,
    env: { FORCE_COLOR: undefined, NO_COLOR: undefined, NODE_DISABLE_COLORS: undefined },
    src: `import { styleText } from "node:util";
import { bar } from "./bar.js";
const S_BAR = "│";
const pick = (ok: boolean) => (ok ? "cyan" : "dim");
console.log(styleText("gray", S_BAR), styleText(["strikethrough", "dim"], "gone"), styleText(pick(false), "[ submit ]"));
console.log(styleText(["gray", "bgWhite", "inverse"], " space "), styleText("none", "plain"), JSON.stringify(styleText("red", "")));
const name = process.argv.length > 99 ? "blue" : "magenta";
console.log(styleText(name, "m"), bar("error"), bar("active"));`,
    extra: {
      "bar.js": `import { styleText } from "node:util";
export function bar(state) {
  const color = state === "error" ? "yellow" : "cyan";
  return styleText(color, "|") + styleText("dim", \`(\${state})\`);
}`,
    },
  },
  {
    id: "SB-15 util.styleText that would colorize (FORCE_COLOR=1) stops by name",
    nodeTypes: true,
    env: { FORCE_COLOR: "1", NO_COLOR: undefined, NODE_DISABLE_COLORS: undefined },
    src: `import { styleText } from "node:util";
console.log("before");
console.log(styleText("green", "ok"));`,
    fence: "util.styleText colorizing",
  },
  {
    id: "SB-16 removeUndefined<T> (paperclip's teams policy records) in code the run never reaches builds",
    nodeTypes: true,
    src: `function removeUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
function policy(name: string | undefined, mode: string | undefined, overrides: Record<string, { adapterConfig: Record<string, unknown> }> | undefined) {
  return removeUndefined({ name, mode, adapterOverrides: overrides });
}
if (process.argv.length > 99) console.log(JSON.stringify(policy("n", undefined, undefined)));
console.log("built");`,
  },
  {
    id: "SB-17 removeUndefined<T> reached stops by name at the result's crossing",
    nodeTypes: true,
    src: `function removeUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
const shared = { a: { x: 1 } };
console.log("before");
const out = removeUndefined({ name: "n", mode: undefined as string | undefined, adapterOverrides: shared });
console.log(out.adapterOverrides === shared, JSON.stringify(out));`,
    fence: "it would be a COPY",
  },
  {
    id: "SB-18 a JavaScript module-load new WeakSet([...]) (the shape of zod's v4/core/errors.js): the seeded set, Node's has/add",
    nodeTypes: true,
    src: `import { check } from "./zerr.js";
console.log(check());`,
    extra: {
      "zerr.js": `const seeded = {};
const installed = /* @__PURE__ */ new WeakSet([Object.prototype, seeded]);
const own = {};
export function check() {
  const before = [installed.has(Object.prototype), installed.has(seeded), installed.has(own)];
  installed.add(own);
  return before.join(",") + " " + installed.has(own);
}`,
    },
  },
  {
    id: "SB-18b a JavaScript new WeakSet([...]) with a registered symbol or a primitive throws Node's TypeError",
    nodeTypes: true,
    src: `import { tries } from "./ws.js";
console.log(tries());`,
    extra: {
      "ws.js": `function a() { return new WeakSet([Symbol.for("x")]); }
function b() { return new WeakSet([{}, 3]); }
export function tries() {
  const out = [];
  try { a(); out.push("ok"); } catch (e) { out.push(String(e instanceof TypeError) + " " + e.message); }
  try { b(); out.push("ok"); } catch (e) { out.push(String(e instanceof TypeError) + " " + e.message); }
  return out.join(" | ");
}`,
    },
  },
  {
    id: "SB-18c a JavaScript new WeakSet([...]) of an object, an array and a function (no internal error)",
    nodeTypes: true,
    src: `import { mixed } from "./wm.js";
console.log(mixed());`,
    extra: {
      "wm.js": `export function mixed() {
  const w = new WeakSet([{ a: 1 }, [1, 2], function f() {}]);
  return typeof w;
}`,
    },
  },
  {
    id: "SB-19 Error.prototype read in JavaScript is an object (GH #238: it read undefined, then stopped by name)",
    nodeTypes: true,
    src: `import { protos } from "./p.js";
console.log("before");
console.log(protos());`,
    extra: { "p.js": `export function protos() { return typeof Error.prototype; }` },
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  if (row.nodeTypes === true) {
    symlinkSync(join(import.meta.dirname, "../../../tests/fixtures/node-types/node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, allowJs: true } }));
  }
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.extra ?? {})) writeFileSync(join(dir, name), text + "\n");
  return entry;
}

function envOf(row: Row): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(row.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function nodeRun(file: string, env: NodeJS.ProcessEnv): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "", env });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string, env: NodeJS.ProcessEnv): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8", env });
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
  const env = envOf(row);
  const host = row.env ? { env: Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined) } : undefined;
  const node = nodeRun(entry, env);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!, host).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!, host).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!, env);
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
