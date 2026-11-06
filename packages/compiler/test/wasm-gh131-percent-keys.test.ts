/* GH #131: a key the PROGRAM spelled with a leading '%' ("%x", sinon's
 * "%ArrayPrototype%") is an ordinary own property. On an index-signature
 * record the runtime-key presence helpers — `k in o` and
 * `Object.hasOwn(o, k)` — used to skip every '%'-named declared field as
 * if it were a compiler-internal slot, so a declared "%x" answered false.
 * What marks an internal field is declaredOrder omission (isInternalField
 * in ir/nodes.ts), not the prefix.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh131-"));
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
  /** Further files of the program, by name. */
  files?: Record<string, string>;
  /** Build with --dynamic (the engine). */
  dynamic?: true;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** Refuses to compile with the named code (and message). */
  refused?: { code: string; text: RegExp };
  /** Runs on the wasm-native lane only (node:fs — the wasm test host has
   * no filesystem). */
  nativeOnly?: true;
}

const ROWS: Row[] = [
  {
    id: "GH131-01 runtime-key in / Object.hasOwn see a declared %-key (the issue's repro)",
    src: `type R = { "%x": number; b: number; [k: string]: number };
const o: R = { "%x": 1, b: 2 };
o["%y"] = 3;
const keys: string[] = ["%x", "b", "%y", "z", "%", "%z%"];
for (const k of keys) console.log(k, k in o, Object.hasOwn(o, k), o[k]);`,
  },
  {
    id: "GH131-02 an optional declared %-key answers its presence, before and after a write",
    src: `type R = { "%x"?: number; b: number; [k: string]: number | undefined };
const o: R = { b: 2 };
const k: string = ["%x"][0]!;
console.log(k in o, Object.hasOwn(o, k));
o["%x"] = 4;
console.log(k in o, Object.hasOwn(o, k), o[k]);
const p: R = { "%x": 7, b: 1 };
console.log(k in p, Object.hasOwn(p, k), p[k]);`,
  },
  {
    id: "GH131-03 sinon-style %Name% keys beside ordinary ones",
    src: `type Intrinsics = { "%ArrayPrototype%": string; "%ObjectPrototype%": string; length: number; [k: string]: string | number };
const t: Intrinsics = { "%ArrayPrototype%": "A", "%ObjectPrototype%": "O", length: 2 };
t["%FunctionPrototype%"] = "F";
const names: string[] = ["%ArrayPrototype%", "%ObjectPrototype%", "%FunctionPrototype%", "%Missing%", "length", "ArrayPrototype"];
for (const n of names) console.log(n, n in t, Object.hasOwn(t, n), t[n]);
console.log(Object.keys(t).join(","));
console.log(JSON.stringify(t));`,
  },
  {
    id: "GH131-04 literal-key in / hasOwn and the key surfaces agree with the runtime-key answers",
    src: `type R = { "%x": number; "%y"?: string; [k: string]: number | string | undefined };
const o: R = { "%x": 1 };
console.log("%x" in o, "%y" in o, Object.hasOwn(o, "%x"), Object.hasOwn(o, "%y"));
o["%y"] = "s";
console.log("%y" in o, Object.hasOwn(o, "%y"));
for (const k in o) console.log("key", k, k in o, Object.hasOwn(o, k));
console.log(Object.keys(o).every((k) => k in o && Object.hasOwn(o, k)));
console.log(JSON.stringify(o), Object.entries(o).length);`,
  },
  // ── The loud over-refusals the issue lists under "Related": a declared
  // "%x" is no accessor, so these cross / copy instead of refusing.
  {
    id: "GH131-05 a record with a declared %-key crosses into an 'any' slot as a live view",
    src: `type R = { "%x": number; b: number };
const o: R = { "%x": 1, b: 2 };
const a: any = o;
console.log(JSON.stringify(a), a["%x"], Object.keys(a), "%x" in a, Object.hasOwn(a, "%x"));
a["%x"] = 5;
console.log(o["%x"], a["%x"]);
console.log(a);
const u: unknown = o;
console.log(JSON.stringify(u), typeof u === "object" && u !== null && "%x" in u);`,
  },
  {
    id: "GH131-06 an index-signature record with a declared %-key crosses into 'any'",
    src: `type R = { "%x": number; [k: string]: number };
const o: R = { "%x": 1 };
o.q = 2;
const a: any = o;
console.log(JSON.stringify(a), a["%x"], Object.keys(a), "%x" in a);
a["%z"] = 9;
const k: string = "%z";
console.log(o[k], k in o, Object.hasOwn(o, k), JSON.stringify(o));`,
  },
  {
    id: "GH131-07 the any crossing under --dynamic",
    dynamic: true,
    src: `const o: { "%x": number; b: number } = { "%x": 1, b: 2 };
const a: any = o;
console.log(JSON.stringify(a), a["%x"], Object.keys(a));
a["%x"] = 5;
console.log(o["%x"]);`,
  },
  {
    id: "GH131-08 Object.assign and spread copy a declared %-key into a Record",
    src: `const o: { "%x": number; b: number } = { "%x": 1, b: 2 };
const t: Record<string, number> = {};
Object.assign(t, o);
const s: Record<string, number> = { ...o, c: 3 };
const k: string = "%x";
console.log(JSON.stringify(t), k in t, Object.hasOwn(t, k), t[k]);
console.log(JSON.stringify(s), k in s, Object.hasOwn(s, k), s[k], Object.keys(s).join());`,
  },
  // ── Internal slots are shape IDENTITY (the field's `internal` flag is in
  // ShapeRegistry.keyOf): a user type spelling an internal shape's field
  // list exactly never collapses into it, whichever is interned first.
  {
    id: "GH131-09 a user type spelling the hybrid's %call first: the hybrid still refuses its any crossing",
    src: `type U = { "%call": () => number; a: number };
const u: U = { "%call": () => 7, a: 1 };
console.log(Object.keys(u), u["%call"]());
type H = (() => number) & { a: number };
const h: H = Object.assign(() => 7, { a: 1 });
const x: any = h;
console.log(typeof x, x.a, Object.keys(x), x());`,
    refused: { code: "SC1090", text: /into dynamically-executed \('any'-typed\) code/ },
  },
  {
    id: "GH131-10 a user type spelling the hybrid's %call, before and after the hybrid, keeps its own keys",
    src: `type U = { "%call": () => number; a: number };
const u: U = { "%call": () => 7, a: 1 };
console.log(Object.keys(u), u["%call"](), typeof u);
type H = (() => number) & { a: number };
const h: H = Object.assign(() => 8, { a: 2 });
console.log(h.a, h(), Object.keys(h));
const v: U = { "%call": () => 9, a: 3 };
console.log(Object.keys(v), v["%call"](), typeof v);`,
  },
  {
    id: "GH131-11 the hybrid first, then a user type spelling its fields (the reverse order)",
    src: `type H = (() => number) & { a: number };
const h: H = Object.assign(() => 7, { a: 1 });
console.log(h.a, h(), Object.keys(h));
type U = { "%call": () => number; a: number };
const u: U = { "%call": () => 5, a: 1 };
console.log(Object.keys(u), u["%call"](), typeof u);
for (const k in u) console.log("key", k);`,
  },
  {
    id: "GH131-12 a user type spelling Dirent's fields first: a Dirent still refuses its any crossing",
    nativeOnly: true,
    src: `import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
type U = { "%dtype": number; name: string; parentPath: string };
const u: U = { "%dtype": 1, name: "n", parentPath: "p" };
console.log(Object.keys(u), JSON.stringify(u));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh131-"));
fs.writeFileSync(path.join(dir, "f.txt"), "x");
const d = fs.readdirSync(dir, { withFileTypes: true })[0]!;
const a: any = d;
console.log(a.name, typeof a.isFile, Object.keys(a).includes("%dtype"));`,
    refused: { code: "SC1090", text: /crossing into an 'any' slot/ },
  },
  {
    id: "GH131-13 a user type spelling Dirent's fields, before and after a Dirent, keeps its own keys",
    nativeOnly: true,
    src: `import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
type U = { "%dtype": number; name: string; parentPath: string };
const u: U = { "%dtype": 1, name: "n", parentPath: "p" };
console.log(Object.keys(u), JSON.stringify(u));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh131-"));
fs.writeFileSync(path.join(dir, "f.txt"), "x");
const d = fs.readdirSync(dir, { withFileTypes: true })[0]!;
console.log(d.name, d.isFile(), d.isDirectory());
fs.rmSync(dir, { recursive: true });
const w: U = { "%dtype": 2, name: "m", parentPath: "q" };
console.log(Object.keys(w), JSON.stringify(w));`,
  },
  {
    id: "GH131-14 a user type spelling StringDecoder's fields first: the decoder still refuses its any crossing",
    src: `import { StringDecoder } from "node:string_decoder";
type U = { "%enc": string; "%pending": number };
const u: U = { "%enc": "e", "%pending": 0 };
console.log(Object.keys(u), JSON.stringify(u));
const d = new StringDecoder("utf8");
const a: any = d;
console.log(typeof a.write, a.write(Buffer.from("hi")));`,
    refused: { code: "SC1090", text: /crossing into an 'any' slot/ },
  },
  {
    id: "GH131-15 a user type spelling StringDecoder's fields beside a decoder keeps its own keys, and crosses into any",
    src: `import { StringDecoder } from "node:string_decoder";
type U = { "%enc": string; "%pending": number };
const u: U = { "%enc": "e", "%pending": 0 };
console.log(Object.keys(u), JSON.stringify(u));
const d = new StringDecoder("utf8");
console.log(d.write(Buffer.from("hi")), d.end());
const a: any = u;
console.log(Object.keys(a), a["%enc"], "%pending" in a);`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.files ?? {})) writeFileSync(join(dir, name), text);
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
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, ...(row.dynamic ? { dynamic: true } : {}) });
  if (row.refused !== undefined) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === row.refused!.code && row.refused!.text.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
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
  expect(got, row.id).toEqual(node);
}

describe("GH #131: declared '%'-prefixed keys on index-signature records (wasm lane vs Node)", () => {
  test.for(ROWS.filter((r) => r.nativeOnly !== true).map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #131: declared '%'-prefixed keys on index-signature records (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
