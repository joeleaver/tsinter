/* GH #126: a dynamic value checked into a typed slot can carry a literal
 * discriminant or enum value its type does not admit
 * (`JSON.parse('{"kind":"c"}') as S`). A function whose exhaustive switch
 * then falls off its end answers undefined, as Node's does (the slot's
 * undefined, SEMANTICS.md S119), instead of trapping; a narrowing that
 * reads the union as an arm it does not hold ends the program by name
 * (S122) instead of a bare trap.
 *
 * Every row equals Node (spawned at test time), or stops at the named
 * fence after printing Node's prefix, on the wasm lane and, in the second
 * describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh126-"));
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
    id: "GH126-01 the issue's repro: an exhaustive switch over a discriminant JSON lied about",
    src: `type S = { kind: "a" } | { kind: "b" };
const s = JSON.parse('{"kind":"c"}') as S;
function f(x: S): string { switch (x.kind) { case "a": return "A"; case "b": return "B"; } }
console.log(f(s));`,
  },
  {
    id: "GH126-02 an enum-typed field holding an out-of-range value",
    src: `enum Color { Red, Green }
type P = { c: Color };
const p = JSON.parse('{"c":7}') as P;
function name(c: Color): string { switch (c) { case Color.Red: return "red"; case Color.Green: return "green"; } }
console.log(name(p.c), p.c, name(Color.Green));`,
  },
  {
    id: "GH126-03 a double cast, and number / boolean / record / async results falling off the end",
    src: `type S = { kind: "a" } | { kind: "b" };
const s = JSON.parse('{"kind":"c"}') as unknown as S;
function f(x: S): number { switch (x.kind) { case "a": return 1; case "b": return 2; } }
function g(x: S): boolean { switch (x.kind) { case "a": return true; case "b": return false; } }
type R = { n: number };
function h(x: S): R { switch (x.kind) { case "a": return { n: 1 }; case "b": return { n: 2 }; } }
async function k(x: S): Promise<string> { switch (x.kind) { case "a": return "A"; case "b": return "B"; } }
console.log(f(s), g(s), typeof g(s), String(f(s)), f(s) === undefined, h(s));
k(s).then((v) => console.log("async", v));`,
  },
  {
    id: "GH126-04 a method and an arrow, and the same functions over honest values",
    src: `type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };
class Area {
  of(s: Shape): string { switch (s.kind) { case "circle": return "c" + s.r; case "square": return "s" + s.side; } }
}
const label = (s: Shape): string => { switch (s.kind) { case "circle": return "round"; case "square": return "boxy"; } };
const lie = JSON.parse('{"kind":"hexagon","r":1}') as Shape;
const a = new Area();
console.log(a.of(lie), label(lie));
console.log(a.of({ kind: "circle", r: 2 }), a.of({ kind: "square", side: 3 }), label({ kind: "square", side: 1 }));`,
  },
  {
    id: "GH126-05 a static method and a getter over a lying discriminant, and a non-union switch",
    src: `type S = { kind: "a" } | { kind: "b" };
class K {
  static code(s: S): number { switch (s.kind) { case "a": return 1; case "b": return 2; } }
  constructor(private readonly s: S) {}
  get name(): string { switch (this.s.kind) { case "a": return "A"; case "b": return "B"; } }
  of(s: S): string { switch (s.kind) { case "a": return "A"; case "b": return "B"; } }
}
const lie = JSON.parse('{"kind":"z"}') as S;
const k = new K(lie);
console.log(K.code(lie), k.name, k.of(lie), new K({ kind: "b" }).name, K.code({ kind: "a" }));`,
  },
  {
    id: "GH126-06 an if/else narrowing over a lying discriminant stops by name (Node reads on)",
    src: `type U = { kind: "a"; n: number } | { kind: "b"; s: string };
const u = JSON.parse('{"kind":"c","n":1}') as U;
console.log("start");
if (u.kind === "a") console.log("a", u.n);
else console.log("b", u.s);`,
    fence: { text: /a value narrowed to one member of a union holds another member .*SEMANTICS\.md S122\) \[SC1100 at .*main\.ts:5\]/, stdout: "start\n" },
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

describe("GH #126: a checked value whose discriminant lies (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #126: a checked value whose discriminant lies (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
