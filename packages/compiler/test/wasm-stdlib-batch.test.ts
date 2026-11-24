/* Paperclip's standard-library and @types/node surface batch: exactly the
 * call shapes paperclip's sources use (its first end-to-end run's SC2020
 * sites), Node-exact; other shapes keep their named refusals.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane, or stops by name where
 * noted. */
import { describeRows, type Row } from "./stdlib-batch-harness.js";

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
  // ── batch 3 (paperclip's third SC2020 batch) ──────────────────────────
  {
    id: "SB-20 a module-level sort by localeCompare(b, 'en', { sensitivity: 'base' }) (paperclip's app catalog): primary strength — case and accents tie, punctuation counts",
    src: `const entries = new Map<string, { name: string; slug: string }>();
for (const [name, slug] of [["beta", "b"], ["Alpha", "a"], ["alpha", "c"], ["Émile", "e"], ["emile", "d"], ["Zed", "z"], ["a-b", "ab"], ["ab", "ab2"], ["Ab", "ab3"], ["Ærø", "ae"], ["aero", "ae2"], ["日本", "jp"], ["ß", "ss"], ["ss", "ss2"]] as const) entries.set(slug, { name, slug });
export const SORTED = [...entries.values()].sort((a, b) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.slug.localeCompare(b.slug));
console.log(SORTED.map((e) => e.slug).join(","));
console.log(["a", "A", "á", "b", "", "a b", "ab"].map((x) => ["a", "A", "á", "b", "", "a b", "ab"].map((y) => x.localeCompare(y, "en-US", { sensitivity: "base" })).join(" ")).join(" | "));`,
  },
  {
    id: "SB-21 readonly-tuple-constrained generic join (paperclip's presetSchema<T extends readonly number[]>) and a readonly tuple's includes over a cast argument",
    src: `const DAILY = [3, 7, 14] as const;
const WEEKLY = [1, 2, 4] as const;
function presetMessage<T extends readonly number[]>(presets: T, label: string) {
  return \`\${label} must be one of: \${presets.join(", ")}\`;
}
console.log(presetMessage(DAILY, "dailyDays"), "|", presetMessage(WEEKLY, "weeklyWeeks"));
const SOURCES = ["timer", "assignment", "on_demand", "automation"] as const;
type Source = (typeof SOURCES)[number];
const opts: { source: string } = { source: "timer" };
const pick = (o: { source: string }) => (SOURCES.includes(o.source as Source) ? (o.source as Source) : "on_demand");
console.log(pick(opts), pick({ source: "nope" }), SOURCES.includes(opts.source as Source));`,
  },
  {
    id: "SB-22 new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) at module level (paperclip's zip-entry decoder): the BOM kept, ill-formed input throws Node's TypeError",
    src: `const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const loose = new TextDecoder();
function dec(d: typeof strict, b: Uint8Array): string {
  try { return JSON.stringify(d.decode(b)); } catch (e) { const err = e as NodeJS.ErrnoException; return \`\${err.name} \${err.code} \${err.message}\`; }
}
const cases = [new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), new Uint8Array([0x68, 0xff, 0x69]), new Uint8Array([0xe2, 0x82]), new Uint8Array([0xed, 0xa0, 0x80]), new Uint8Array([0xf0, 0x9f, 0x98, 0x80]), new Uint8Array([])];
for (const c of cases) console.log(dec(strict, c), "/", dec(loose, c));
console.log(strict.encoding, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf])).length);`,
    nodeTypes: true,
  },
  {
    id: "SB-23 URL port and origin (paperclip's hostPortKey, trusted-origins default, github URL check)",
    nodeTypes: true,
    src: `for (const s of ["https://github.com/a/b", "http://h:8080/x", "https://h:443/", "postgres://u:p@db:5433/x", "file:///tmp/x", "blob:https://a.com:9/x", "blob:file:///x", "data:text/plain,hi", "ws://h:80", "wss://H:444", "ftp://f:21/"]) {
  const u = new URL(s);
  console.log(JSON.stringify(u.port), u.origin, \`\${u.hostname}:\${u.port || "5432"}\`);
}`,
  },
  {
    id: "SB-24 renameSync, linkSync, symlinkSync (with a type), readlinkSync and fsyncSync (paperclip's install store and config writes): Node's results and two-path errors",
    nativeOnly: true,
    nodeTypes: true,
    src: `import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const d = fs.mkdtempSync(path.join(os.tmpdir(), "sb24-"));
const show = (err: NodeJS.ErrnoException) => { console.log(err.code, err.message.split(d).join("<D>")); };
fs.writeFileSync(path.join(d, "a"), "A");
fs.renameSync(path.join(d, "a"), path.join(d, "b"));
console.log(fs.existsSync(path.join(d, "a")), fs.readFileSync(path.join(d, "b"), "utf8"));
try { fs.renameSync(path.join(d, "a"), path.join(d, "c")); } catch (e) { show(e as NodeJS.ErrnoException); }
fs.linkSync(path.join(d, "b"), path.join(d, "h"));
try { fs.linkSync(path.join(d, "b"), path.join(d, "h")); } catch (e) { show(e as NodeJS.ErrnoException); }
console.log(fs.statSync(path.join(d, "h")).nlink, fs.lstatSync(path.join(d, "b")).nlink);
fs.symlinkSync("b", path.join(d, "s"));
fs.mkdirSync(path.join(d, "dir"));
fs.symlinkSync("dir", path.join(d, "sd"), "dir");
console.log(fs.readlinkSync(path.join(d, "s")), fs.readlinkSync(path.join(d, "sd")), fs.lstatSync(path.join(d, "s")).isSymbolicLink());
try { fs.symlinkSync("x", path.join(d, "s")); } catch (e) { show(e as NodeJS.ErrnoException); }
try { fs.readlinkSync(path.join(d, "b")); } catch (e) { show(e as NodeJS.ErrnoException); }
try { fs.readlinkSync(path.join(d, "missing")); } catch (e) { show(e as NodeJS.ErrnoException); }
const fd = fs.openSync(path.join(d, "f"), "w");
fs.fsyncSync(fd);
fs.closeSync(fd);
try { fs.fsyncSync(fd); } catch (e) { show(e as NodeJS.ErrnoException); }
try { fs.renameSync(path.join(d, "b"), path.join(d, "dir")); } catch (e) { show(e as NodeJS.ErrnoException); }
fs.rmSync(d, { recursive: true, force: true });
console.log("done");`,
  },
  {
    id: "SB-25 a plain Stats' mode, uid and nlink (paperclip's ownership and permission checks)",
    nativeOnly: true,
    nodeTypes: true,
    src: `import * as fs from "node:fs";
import { statSync, chmodSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const d = fs.mkdtempSync(path.join(os.tmpdir(), "sb25-"));
const f = path.join(d, "f");
fs.writeFileSync(f, "x", { mode: 0o640 });
chmodSync(f, 0o640);
const st = fs.lstatSync(f);
console.log((st.mode & 0o777).toString(8), (st.mode & 0o022) !== 0, st.uid === process.getuid?.(), st.nlink, st.isFile(), st.size);
chmodSync(f, statSync(f).mode & 0o700);
console.log((fs.statSync(f).mode & 0o777).toString(8));
fs.rmSync(d, { recursive: true, force: true });`,
  },
  {
    id: "SB-26 paperclip's module-level Intl.DateTimeFormat (en-US, UTC, long month, h:mm a z): format over time values; TimeClip's RangeError",
    src: `const HUMAN = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC", timeZoneName: "short" });
export function fmt(ms: number): string { return HUMAN.format(ms); }
console.log([0, 1777378620000, 951782400000, 1e12, -1e10, 253402300799999, 43200000, 3600000 * 13 + 60000 * 5, -62135596800000, 8.64e15].map(fmt).join(" | "));
for (const bad of [NaN, 8.64e15 + 1, Infinity]) { try { fmt(bad); } catch (e) { console.log((e as Error).name, (e as Error).message); } }`,
  },
  {
    id: "SB-27 WeakRef and FinalizationRegistry at module level (paperclip's client registry): deref answers the target, register checks and keeps nothing observable",
    src: `type Client = { name: string };
const byKey = new Map<string, Set<WeakRef<Client>>>();
const fin = new FinalizationRegistry<{ key: string; ref: WeakRef<Client> }>(({ key, ref }) => {
  const refs = byKey.get(key);
  if (!refs) return;
  refs.delete(ref);
});
export function reg(key: string, c: Client): void {
  const ref = new WeakRef(c);
  let refs = byKey.get(key);
  if (!refs) { refs = new Set(); byKey.set(key, refs); }
  refs.add(ref);
  fin.register(c, { key, ref }, ref);
}
const a = { name: "a" };
reg("h:1", a);
reg("h:1", { name: "b" });
const set = byKey.get("h:1");
if (set) for (const r of set) console.log(r.deref()?.name, r.deref() === a);
const o = {};
const w = new WeakRef(o);
console.log(w.deref() === o, typeof fin);`,
  },
  {
    id: "SB-28 new Map(rows.map((r) => [r.id, r])) over rows shared with dynamic code (paperclip's drizzle rows with a Date member): get, has, size, keys, explicit value types",
    src: `interface Row { id: string; name: string; parentId: string | null; createdAt: Date; n: number }
function depthOf(rows: Row[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byKey = new Map(rows.map((r) => [\`\${r.id}:\${r.n}\`, r]));
  const numbers = new Map<string, number>(rows.map((r) => [r.id, r.n]));
  const depth = new Map<string, number>();
  const d = (r: Row): number => {
    const known = depth.get(r.id);
    if (known !== undefined) return known;
    if (!r.parentId) { depth.set(r.id, 0); return 0; }
    const parent = byId.get(r.parentId);
    if (!parent) { depth.set(r.id, 0); return 0; }
    const v = d(parent) + 1;
    depth.set(r.id, v);
    return v;
  };
  return [...rows].sort((x, y) => d(x) - d(y)).map((r) => \`\${r.name}:\${d(r)}:\${byId.has(r.id)}:\${byId.get(r.id)?.name ?? "-"}:\${numbers.get(r.id)}:\${byKey.size}\`).concat([...byKey.keys()].join("|"), String(byId.get("zz")));
}
const rows = JSON.parse('[{"id":"c","name":"C","parentId":"b","createdAt":"x","n":3},{"id":"a","name":"A","parentId":null,"createdAt":"x","n":1},{"id":"b","name":"B","parentId":"a","createdAt":"x","n":2},{"id":"a","name":"A2","parentId":null,"createdAt":"x","n":4}]') as Row[];
console.log(depthOf(rows).join(","));`,
  },
  {
    id: "SB-29 small batch-3 shapes: Object.hasOwn with a narrowed unknown key, Number.isInteger over number | undefined, process.stdout.columns ?? n, crypto.randomInt, process.version's shape, p.catch(() => undefined)",
    nodeTypes: true,
    src: `import { randomInt } from "node:crypto";
export const METHODS = { github: ["repo", "issues"], linear: ["issues"] } as const;
export function isId(value: unknown): value is keyof typeof METHODS { return typeof value === "string" && Object.hasOwn(METHODS, value); }
console.log(isId("github"), isId("toString"), isId(3), isId("linear"));
const entries: { idx?: number; tag: string }[] = [{ idx: 2, tag: "a" }, { tag: "b" }, { idx: 1.5, tag: "c" }];
console.log(entries.map((e, i) => (Number.isInteger(e.idx) ? Number(e.idx) : i)).join(","));
console.log(Math.max(60, process.stdout.columns ?? 100));
const xs = Array.from({ length: 500 }, () => randomInt(0, 360));
console.log(xs.every((x) => Number.isInteger(x) && x >= 0 && x < 360), new Set(xs).size > 100);
console.log(/^v\\d+\\.\\d+\\.\\d+$/.test(process.version), process.version === \`v\${process.versions.node}\`);
async function stop(): Promise<void> { throw new Error("no"); }
async function main() { await stop().catch(() => undefined); console.log("caught"); }
await main();`,
  },
  {
    id: "SB-30 Array.from(map, ([k, v], i) => ...) walks the live entries (paperclip's env-file writer); JSON.stringify(v, null, c ? 2 : 0); Date.now and console.error as default function values",
    src: `const missing = new Map<string, string>([["A", "1"], ["B", "2"]]);
console.log(JSON.stringify(Array.from(missing, ([key, value]) => ({ contents: \`\${key}=\${value}\`, ending: "\\n" }))));
const m2 = new Map<string, number>([["a", 1], ["b", 2], ["c", 3]]);
console.log(Array.from(m2, ([k, v], i) => { if (k === "a") { m2.delete("b"); m2.set("d", 4); } return \`\${i}:\${k}=\${v}\`; }).join(","));
function writeResult(value: unknown, options: { json?: boolean }) { process.stdout.write(\`\${JSON.stringify(value, null, options.json ? 2 : 0)}\\n\`); }
writeResult({ a: [1, { b: 2 }] }, { json: true });
writeResult({ a: [1] }, {});
writeResult(undefined, { json: true });
export function capture(now: () => number = Date.now): boolean { return now() > 1e12; }
console.log(capture(), capture(() => 5));
export function login(raw: string, notify: (message: string) => void = console.error) { notify(raw); }
login("to stderr");
login("x", (m) => console.log("got", m));`,
  },
  {
    id: "SB-31 new RegExp over a dynamic pattern (paperclip's question-set validator), util.isDeepStrictEqual over one static type (its config store)",
    nodeTypes: true,
    src: `import { isDeepStrictEqual } from "node:util";
const value: any = JSON.parse('{"a":{"pattern":"^a+$"},"b":{"pattern":"(["},"c":{},"d":{"pattern":42}}');
for (const k of ["a", "b", "c", "d"]) {
  let ok = true;
  let src = "";
  try { const re = new RegExp(value[k].pattern); src = re.source; } catch (e) { ok = false; src = (e as Error).name; }
  console.log(k, ok, src);
}
type Cfg = { server: { port: number; host: string }; tags: string[]; mode?: string };
const a: Cfg = { server: { port: 1, host: "h" }, tags: ["x"] };
const b: Cfg = { server: { port: 1, host: "h" }, tags: ["x"] };
const c: Cfg = { server: { port: 1, host: "h" }, tags: ["x"], mode: "m" };
console.log(isDeepStrictEqual(a, b), isDeepStrictEqual(a, c), isDeepStrictEqual(a, { ...b, tags: ["y"] }), isDeepStrictEqual(NaN, NaN), isDeepStrictEqual(0, -0), isDeepStrictEqual("s", "s"));`,
  },
  {
    id: "SB-32 an optional-chained Stats method (paperclip's seed-source probe: entry?.isSymbolicLink())",
    nativeOnly: true,
    nodeTypes: true,
    src: `import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const d = fs.mkdtempSync(path.join(os.tmpdir(), "sb32-"));
fs.writeFileSync(path.join(d, "f"), "x");
fs.symlinkSync("f", path.join(d, "l"));
function entry(p: string): fs.Stats | undefined { return fs.existsSync(p) ? fs.lstatSync(p) : undefined; }
for (const n of ["f", "l", "nope"]) console.log(n, entry(path.join(d, n))?.isSymbolicLink(), entry(path.join(d, n))?.isFile());
fs.rmSync(d, { recursive: true, force: true });`,
  },
];

describeRows("Paperclip's stdlib batch", ROWS);
