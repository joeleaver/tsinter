/* Unit U1a (SEMANTICS.md S014/S015/S016/S042/S115/S125 (c) U1a amendments):
 * on the WasmGC lanes a TypeScript program's `any`, `unknown` and `object`
 * are one dynamic value; a program with a JavaScript source keeps the
 * checked-dynamic path whole until U1b.
 *
 * An exact row equals Node (spawned at test time). A `refused` row fails
 * to compile with the named code (and S125's text when `s125` is set). A
 * `fence` row compiles, prints Node's stdout up to the construct, and ends
 * at its named run-time fence (S122). Rows run on the wasm lane; the
 * wasm-native describe repeats them for the cloud gate. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-u1-"));
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
  refused?: { code: string; s125?: boolean; text?: RegExp };
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** Which dynamic world the build took, read off the emitted IR module
   * (`sharedDynamic`): "new" for a TypeScript-only program, "old" for a
   * program with a JavaScript source. */
  world?: "old" | "new";
}

const S125_TAIL = /it would be a COPY where JavaScript shares the object, and .* \(SEMANTICS\.md S125\) (is|are) not supported yet$/;

const ROWS: Row[] = [
  // ── one world: typed composites are shared (S014, S115 (a)) ─────────
  {
    id: "U1-SHARE-01 a record entering unknown is the same object",
    src: `const p = { n: 1 };
const u: unknown = p;
p.n = 2;
console.log((u as { n: number }).n, u === p);
const back = u as { n: number };
back.n = 3;
console.log(p.n);`,
  },
  {
    id: "U1-SHARE-02 a named function crossing into unknown keeps its name (1664)",
    src: `import { inspect } from "node:util";
function add(a: number, b: number): number { return a + b; }
const u: unknown = add;
console.log(inspect(u));
const pass = (v: unknown): unknown => v;
console.log(inspect(pass(function named() {})));`,
  },
  // ── the silent fixes: V8's texts over dynamic values ────────────────
  {
    id: "U1-TEXT-01 calling a non-function names the callee (1667)",
    src: `const num: any = JSON.parse("42");
try { num(1); } catch (e) { console.log((e as Error).message); }
const obj: any = JSON.parse("{}");
try { obj.missing(); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "U1-TEXT-02 array destructuring of a non-iterable names the source (2602)",
    src: `const bad: any = JSON.parse("5");
try { const [z] = bad; console.log(z); } catch (e) { console.log((e as Error).message); }
try { const [a, ...r] = bad; console.log(a, r); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "U1-TEXT-03 object destructuring of null names the property and source",
    src: `const nul: any = JSON.parse("null");
try { const { a } = nul; console.log(a); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "U1-TEXT-04 for-of over a non-iterable names the source",
    src: `const bad: any = JSON.parse("5");
try { for (const x of bad) console.log(x); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "U1-TEXT-05 string methods on a dynamic string",
    src: `const cfg: any = JSON.parse('{"host":"  API.Example.COM  "}');
console.log(cfg.host.trim().toLowerCase(), cfg.host.padStart(20, "*").length);`,
  },
  // ── S015 ─────────────────────────────────────────────────────────────
  {
    id: "U1-S015-01 inherited methods called on a dynamic value",
    src: `const o: any = JSON.parse('{"a":1}');
console.log(o.toString(), o.hasOwnProperty("a"), "a" in o);
const arr: any = JSON.parse("[1,2,3]");
console.log(arr.slice(1).length);`,
  },
  {
    id: "U1-S015-02 an inherited member read as a value is a named fence",
    src: `const arr: any = JSON.parse("[1,2]");
console.log("before");
console.log(typeof arr.slice);`,
    fence: { text: /'Array\.prototype\.slice' on an island value is not supported yet/, stdout: "before\n" },
  },
  {
    id: "U1-S015-03 a keyed read of an inherited name is a named fence",
    src: `const o: any = JSON.parse('{"a":1}');
console.log(o["a"]);
console.log(o["toString"]);`,
    fence: { text: /a keyed read of a member a dynamic value inherits from its prototype .*SEMANTICS\.md S015/, stdout: "1\n" },
  },
  {
    id: "U1-S015-04 a computed keyed read of an inherited name is a named fence",
    src: `const a: any = [1, 2];
const k = ["length", "map"];
console.log(a[k[0]!]);
console.log(typeof a[k[1]!]);`,
    fence: { text: /a keyed read of a member a dynamic value inherits from its prototype/, stdout: "2\n" },
  },
  // ── S016 ─────────────────────────────────────────────────────────────
  {
    id: "U1-PAD-01 an index write past the end is a named fence (S110 (f))",
    src: `const a: any = JSON.parse("[1]");
a[1] = 2;
console.log(a.length);
a[3] = 9;
console.log(a.length, a[1], a[3]);`,
    fence: { text: /writing an island array at index 3 past its length \(the holes Node leaves\) is not supported yet on the wasm lane/, stdout: "2\n" },
  },
  // ── the U1a ports, each against Node ────────────────────────────────
  {
    id: "U1-ERASE-01 a double cast through unknown keeps the function itself",
    src: `function base(a: number): void { console.log("base", a); }
const wide: (a: number, b: string) => void = base;
console.log(wide === (base as unknown as typeof wide));
const f2 = base as unknown as (a: number) => void;
console.log(f2 === base);
f2(3);`,
  },
  {
    id: "U1-BYTES-01 new Uint8Array over an unknown narrowed by instanceof copies",
    src: `const u: unknown = new Uint8Array([1, 2]);
if (u instanceof Uint8Array) {
  const c = new Uint8Array(u);
  c[0] = 9;
  console.log(c[0], c.length, u[0]);
}`,
  },
  {
    id: "U1-CAUGHT-01 caught payloads entering unknown keep their kind",
    src: `const describe = (x: unknown): string => x instanceof Error ? "Error " + x.message : typeof x;
try { throw new TypeError("boom"); } catch (e) { console.log(describe(e)); }
try { throw "str"; } catch (e) { console.log(describe(e)); }
try { throw 42; } catch (e) { console.log(describe(e)); }`,
  },
  {
    id: "U1-TEXT-06 array destructuring of a call's non-iterable result names the callee",
    src: `const get = (): any => JSON.parse("5");
try { const [x] = get(); console.log(x); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "U1-DYNPARAM-01 an unknown-typed callback of a parsed array's filter",
    src: `function globs(raw: string): string[] | null {
  const pkg = JSON.parse(raw);
  const w = pkg.ws;
  if (Array.isArray(w)) return w.filter((g: unknown) => typeof g === "string");
  return null;
}
console.log(globs('{"ws":["a",2,"b"]}')!.join());`,
  },
  {
    id: "U1-FNCAST-01 a cast to a function with an unknown result adapts",
    src: `const add = (a: number, b: number): number => a + b;
const u: unknown = add;
const loose = u as (a: number, b: number) => unknown;
const r = loose(4, 5);
console.log(typeof r, r as number);`,
  },
  {
    id: "U1-FNCAST-02 a cast of a non-function to a function type is a named fence (S009)",
    src: `const u: unknown = JSON.parse("5");
const f = u as (a: number) => unknown;
console.log("cast");
console.log(f(1));`,
    fence: { text: /expected function at \$, got number/, stdout: "" },
  },
  // ── S115 (d) U1a: judged copies at every exit ───────────────────────
  {
    id: "U1-EXIT-01 a copy into a local nobody can tell apart runs",
    src: `type P = { n: number };
const src: unknown = JSON.parse('{"n":4}');
const p = src as P;
console.log(p.n);`,
  },
  {
    id: "U1-EXIT-02 a copy into a field the original is later written refuses",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const box = { p: get() as P };
shared.n = 2;
console.log(box.p.n);`,
    refused: { code: "SC1090", s125: true },
  },
  {
    id: "U1-EXIT-03 a copy into an element written through refuses",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const xs: P[] = [get() as P];
xs[0]!.n = 5;
console.log(shared.n);`,
    refused: { code: "SC1090", s125: true },
  },
  {
    id: "U1-EXIT-06 a copy compared by identity through a view refuses",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const xs: P[] = [];
xs.push(get() as P);
console.log(xs[0] === shared);`,
    refused: { code: "SC1090", s125: true },
  },
  {
    id: "U1-EXIT-07 a copy found by includes in a dynamic array refuses",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const p = get() as P;
const arr: any[] = [shared];
console.log(arr.includes(p));`,
    refused: { code: "SC1090", s125: true },
  },
  {
    id: "U1-EXIT-08 a copy searched by indexOf refuses",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const p = get() as P;
console.log([shared].indexOf(p));`,
    refused: { code: "SC1090", s125: true },
  },
  {
    id: "U1-EXIT-09 a copy re-entering unknown and compared refuses",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const p = get() as P;
const u: unknown = p;
console.log(u === shared);`,
    refused: { code: "SC1090", s125: true },
  },
  {
    id: "U1-EXIT-10 a write through an index-signature part of a copy refuses (gate S1)",
    src: `const o: any = { m: { a: [1] } };
const m: Record<string, number[]> = o.m;
m["a"]!.push(2);
console.log(o.m.a.length);`,
    refused: { code: "SC1090", s125: true },
  },
  {
    id: "U1-EXIT-04 a copy into a field nobody writes runs",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const box = { p: get() as P };
console.log(box.p.n);`,
  },
  {
    id: "U1-EXIT-05 a copy into an element nobody writes runs",
    src: `type P = { n: number };
const shared: any = { n: 1 };
function get(): unknown { return shared; }
const xs: P[] = [get() as P];
console.log(xs.length, xs[0]!.n);`,
  },
  // ── S042: TypeScript cannot reach the unbound listener `this` ───────
  {
    id: "U1-THIS-01 this outside a class method refuses by name",
    src: `import { EventEmitter } from "node:events";
const ee = new EventEmitter();
ee.on("x", function (this: any, v: any) { console.log(this === ee, v); });
ee.emit("x", 1);`,
    refused: { code: "SC1080" },
  },
  // ── the language seam: a program with a JS source keeps today's path ─
  {
    id: "U1-WORLD-01 a TypeScript-only program takes the one dynamic world",
    src: `console.log("ts only");`,
    world: "new",
  },
  {
    id: "U1-SEAM-01 a TypeScript entry calls a JavaScript module",
    src: `import { twice } from "./lib.js";
console.log(twice(21));`,
    files: { "lib.js": "export function twice(x) { return x * 2; }\n" },
    world: "old",
  },
  {
    id: "U1-SEAM-02 a JavaScript entry calls a TypeScript module",
    entry: "main.mjs",
    src: `import { twice } from "./lib.ts";
console.log(twice(21));`,
    files: { "lib.ts": "export function twice(x: number): number { return x * 2; }\n" },
    world: "old",
  },
  {
    id: "U1-SEAM-03 a TypeScript function value passed into JavaScript",
    src: `import { applyTo } from "./lib.js";
const inc = (n: number): number => n + 1;
console.log(applyTo(inc, 41));`,
    files: { "lib.js": "export function applyTo(f, x) { return f(x); }\n" },
    world: "old",
  },
  {
    id: "U1-SEAM-04 a JavaScript function value passed into TypeScript",
    entry: "main.mjs",
    src: `import { applyTo } from "./lib.ts";
console.log(applyTo((n) => n + 1, 41));`,
    files: { "lib.ts": "export function applyTo(f: (n: number) => number, x: number): number { return f(x); }\n" },
    world: "old",
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
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (row.refused !== undefined) {
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const named = res.diagnostics.filter((d) => d.code === row.refused!.code);
    expect(named.length, JSON.stringify(res.diagnostics)).toBeGreaterThan(0);
    if (row.refused.s125) expect(named.some((d) => S125_TAIL.test(d.message)), JSON.stringify(res.diagnostics)).toBe(true);
    if (row.refused.text) expect(named.some((d) => row.refused!.text!.test(d.message))).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  if (row.fence !== undefined) {
    const got: Out = backend === "wasm"
      ? await runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 }))
      : await nativeRun(res.binaryPath!);
    expect(got.exitCode).toBe(1);
    expect(got.stdout).toBe(row.fence.stdout);
    expect(node.stdout.startsWith(got.stdout)).toBe(true);
    expect(got.stderr).toMatch(/^tsinter: unsupported: /);
    expect(got.stderr).toMatch(row.fence.text);
    // One fence line first; the wasm-native host may add its trap report after it.
    expect(got.stderr.split("\n")[0]).toMatch(row.fence.text);
    return;
  }
  if (row.world !== undefined) {
    // The emitted IR module records the world the build took.
    const withIr = await compile(entry, { outPath: join(dir, backend === "wasm" ? "w.wasm" : "wprogram"), outDir: dir, backend, emitIr: true });
    expect(withIr.ok).toBe(true);
    if (!withIr.ok || withIr.irPath === undefined) throw new Error(`${row.id}: no IR emitted`);
    const mod = JSON.parse(readFileSync(withIr.irPath, "utf8")) as { sharedDynamic?: boolean };
    expect(mod.sharedDynamic === true).toBe(row.world === "new");
  }
  expect(node.exitCode).toBe(0);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got).toEqual(node);
}

describe("U1a: one dynamic world for TypeScript programs (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("U1a: one dynamic world for TypeScript programs (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
