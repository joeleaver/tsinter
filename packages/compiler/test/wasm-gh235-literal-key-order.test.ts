/* GH #235: a mapped type over literal keys (`Record<"gmail" | "drive", V>`)
 * lists its keys in the checker's key-union order, which no value spells;
 * such a shape keeps each record's own key order (record-order.ts), so an
 * object literal answers its spelling on every key surface, as in Node.
 * paperclip's google-workspace-connectors.ts builds two at module load
 * (its Object.fromEntries values are stdlib batch 2's; plain helpers here).
 * A structuredClone of one keeps S041's declared order (registered).
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh235-"));
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
    id: "GH235-01 the issue's repro: a Record over a literal union lists the literal's keys",
    src: `type Service = "gmail" | "drive";
const r: Record<Service, number> = { gmail: 1, drive: 2 };
console.log(JSON.stringify(r), Object.keys(r).join(","));`,
  },
  {
    id: "GH235-02 paperclip's SERVICE_PROFILES: Readonly<Record<Exclude<tuple keys>>>, entries at module load, spread with an added key",
    src: `const IDS = ["gmail.read", "gmail.draft", "gmail.archive", "drive.read", "drive.write", "calendar.read", "workspace.all"] as const;
type ProfileId = (typeof IDS)[number];
const auth = (scope: string) => \`https://example.test/auth/\${scope}\`;
function def(appSlug: string, serverUrl: string, scopes: readonly string[], writeTools: readonly string[] = []) {
  return { appSlug, serverUrl, scopes, writeTools };
}
const SERVICE_PROFILES: Readonly<Record<Exclude<ProfileId, "workspace.all">, {
  appSlug: string;
  serverUrl: string;
  scopes: readonly string[];
  writeTools: readonly string[];
}>> = {
  "gmail.read": def("gmail", "u1", [auth("gmail.readonly")]),
  "gmail.draft": def("gmail", "u1", [auth("gmail.readonly"), auth("gmail.compose")], ["create_draft"]),
  "gmail.archive": def("gmail", "u1", [auth("gmail.readonly"), auth("gmail.modify")], ["unlabel_thread"]),
  "drive.read": def("google-drive", "u2", [auth("drive.readonly")]),
  "drive.write": def("google-drive", "u2", [auth("drive.readonly"), auth("drive.file")], ["copy_file"]),
  "calendar.read": def("google-calendar", "u3", [auth("calendar.events.readonly")]),
};
export const PROFILES = {
  ...SERVICE_PROFILES,
  "workspace.all": def("google-workspace", "u4",
    [...new Set(Object.entries(SERVICE_PROFILES).filter(([id]) => id !== "gmail.archive").flatMap(([, profile]) => profile.scopes))]),
};
console.log(PROFILES["workspace.all"].scopes);
console.log(Object.keys(SERVICE_PROFILES).join(","));
console.log(Object.prototype.hasOwnProperty.call(PROFILES, "drive.read"), PROFILES["gmail.draft"].writeTools);`,
  },
  {
    id: "GH235-03 paperclip's toolScopes: Record<keyof typeof a const object, Record<string, string[][]>>",
    src: `export const SERVICES = { gmail: "gmail.draft", drive: "drive.write", docs: "docs.write", search: "workspace-search.read" } as const;
export type Service = keyof typeof SERVICES;
function one(...scopes: string[]): string[][] { return [scopes.map((s) => "a/" + s)]; }
function fromPairs(pairs: [string, string[][]][]): Record<string, string[][]> {
  const out: Record<string, string[][]> = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}
const toolScopes: Record<Service, Record<string, string[][]>> = {
  gmail: fromPairs([
    ...["get_message", "get_thread"].map((name): [string, string[][]] => [name, one("gmail.readonly")]),
    ["create_draft", one("gmail.compose")],
  ]),
  drive: fromPairs(["copy_file", "create_file"].map((name): [string, string[][]] => [name, one("drive.file")])),
  docs: { read_doc: one("documents.readonly", "documents"), update_doc: one("documents") },
  search: { search_corpus: ["x", "y"].map((scope) => [scope]) },
};
console.log(Object.keys(toolScopes).join(","), Object.keys(toolScopes.gmail).join(","));
for (const s of Object.keys(SERVICES) as Service[]) console.log(s, Object.keys(toolScopes[s]).length);
console.log(JSON.stringify(toolScopes.docs));`,
  },
  {
    id: "GH235-04 every key surface answers the literal's spelling",
    src: `type K = "zeta" | "alpha" | "mid";
const r: Record<K, number> = { mid: 1, zeta: 2, alpha: 3 };
console.log(Object.keys(r), Object.values(r), Object.entries(r));
for (const k in r) console.log("k", k);
console.log(JSON.stringify(r), r);
const s = { ...r };
const t: Record<K, number> = { ...r };
console.log(JSON.stringify(s), JSON.stringify(t), JSON.stringify(Object.assign({}, r)));
const { mid, ...rest } = r;
console.log(mid, rest);
const d: unknown = r;
console.log(Object.keys(d as object));
function show(x: Record<K, number>): string { return Object.keys(x).join("|"); }
console.log(show(r), show({ alpha: 1, mid: 2, zeta: 3 }));`,
  },
  {
    id: "GH235-05 writes keep each record's own order; two literals spell two orders",
    src: `type K = "b" | "a" | "c";
const x: Record<K, string> = { c: "1", a: "2", b: "3" };
const y: Record<K, string> = { a: "4", b: "5", c: "6" };
x.a = "w";
x["b"] = "v";
y.c = "u";
console.log(x, y, JSON.stringify([x, y]));
const list: Record<K, string>[] = [x, y, { b: "7", c: "8", a: "9" }];
console.log(list.map((r) => Object.keys(r).join("")).join(" "));`,
  },
  {
    id: "GH235-06 Readonly and nested records over literal keys",
    src: `type Lvl = "warn" | "error" | "info";
const COLORS: Readonly<Record<Lvl, { fg: string; bold: boolean }>> = {
  warn: { fg: "yellow", bold: false },
  error: { fg: "red", bold: true },
  info: { fg: "blue", bold: false },
};
console.log(COLORS);
console.log(Object.entries(COLORS).map(([k, v]) => k + "=" + v.fg).join(";"));`,
  },
  {
    id: "GH235-07 (review) a deleted required key written again comes back last: dot, computed, ??=, bracket literal, on a Record and on an interface with an optional field",
    src: `interface J { a?: number; b: number | undefined; c: number }
const j: J = { c: 1, b: 2, a: 3 };
delete j.b;
j.b = 9;
console.log(j, JSON.stringify(j));
type S = "gmail" | "drive" | "docs";
const r: Record<S, number | undefined> = { gmail: 1, drive: 2, docs: 3 };
delete r.gmail;
const k: S = (process.argv.length > 99 ? "docs" : "gmail") as S;
r[k] = 8;
console.log(r, JSON.stringify(r));
const r3: Record<S, number | undefined> = { gmail: 1, drive: 2, docs: 3 };
delete r3.drive;
r3.drive ??= 6;
console.log(r3, JSON.stringify(r3));
const r4: Record<S, number | undefined> = { gmail: 1, drive: 2, docs: 3 };
delete r4["docs"];
r4["docs"] = 11;
console.log(r4, JSON.stringify(r4), Object.values(r4));
const q: Record<"gmail" | "drive" | "docs", number | undefined> = { gmail: 1, drive: 2, docs: 3 };
delete q.gmail;
q.gmail = 7;
console.log(q, JSON.stringify(q), Object.keys(q));`,
  },
  {
    id: "GH235-08 (review) \"in\" and hasOwn after deleting a required key answer false, and true again once it is written",
    src: `type S = "gmail" | "drive" | "docs";
const r: Record<S, number | undefined> = { docs: 3, gmail: 1, drive: 2 };
delete r.docs;
console.log("docs" in r, Object.hasOwn(r, "docs"), Object.keys(r));
r.docs = 4;
console.log("docs" in r, Object.hasOwn(r, "docs"), r);
interface J { a?: number; b: number | undefined }
const j: J = { b: 1, a: 2 };
delete j.b;
console.log("b" in j, j);`,
  },
  {
    id: "GH235-09 (review) deleting a required key from a record spelled in declared order (no order yet) drops it, and a rewrite appends it",
    src: `type S = "docs" | "drive" | "gmail";
const r: Record<S, number | undefined> = { docs: 1, drive: 2, gmail: 3 };
delete r.drive;
console.log(r, JSON.stringify(r), Object.keys(r), "drive" in r);
r.drive = 5;
console.log(r, JSON.stringify(r));
interface J { a?: number; b: number | undefined; c: number }
const j: J = { a: 1, b: 2, c: 3 };
delete j.b;
console.log(j, "b" in j);
j.b = 4;
console.log(JSON.stringify(j));`,
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

describe("GH #235: a literal-key Record lists its literal's keys (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #235: a literal-key Record lists its literal's keys (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
