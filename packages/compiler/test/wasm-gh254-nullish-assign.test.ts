/* GH #254: `x ??= e` on a variable the lowering holds dynamically (a
 * JavaScript `let x;` / `var x;`, a TypeScript `any` or `unknown`) did
 * nothing: the statement took the "checker says never nullish" fold, so
 * `let v; v ??= 5` left v undefined. It now writes `x = x ?? e` through the
 * dynamic nullish test (e runs only when x is nullish), and `x ??= e` used
 * as a value answers x afterwards, for every variable type.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh254-"));
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
    id: "NA-01 (GH #254) JavaScript let and var: ??= writes when undefined or null, keeps 0 and set values, a function value",
    entry: "main.js",
    src: `let v; v ??= 5; console.log(v);
let u; u ??= () => 1; console.log(typeof u, u());
var w; w ??= "x"; console.log(w);
let n = null; n ??= 7; console.log(n);
let s = 3; s ??= 9; console.log(s);
let z = 0; z ??= 9; console.log(z);
function f() { let x; x ??= 3; var y; y ??= "y"; return x + ":" + y; }
console.log(f());
let c; function g() { c ??= 2; return c; } console.log(g(), c);`,
  },
  {
    id: "NA-02 (GH #254) JavaScript: the right side runs only when the variable is nullish",
    entry: "main.js",
    src: `function side() { console.log("side"); return 1; }
let k = 1; k ??= side(); console.log(k);
let k2; k2 ??= side(); console.log(k2);
var k3 = "set"; k3 ??= "other"; console.log(k3);`,
  },
  {
    id: "NA-03 (GH #254) JavaScript: x ??= e as an expression's value",
    entry: "main.js",
    src: `function side() { console.log("side"); return 1; }
let v; console.log(v ??= 5, v);
var m; const r = (m ??= side()); console.log(r, m);
let set; set = 4; console.log(set ??= side(), set);
let nn = null; console.log(nn ??= "d", nn);`,
  },
  {
    id: "NA-04 (GH #254) TypeScript: an implicit-any let/var, an any and an unknown; the right side's effects",
    entry: "main.ts",
    src: `let v; v ??= 5; console.log(v);
let u; u ??= () => 1; console.log(typeof u);
var w; w ??= "x"; console.log(w);
function side() { console.log("side"); return 1; }
let k: any = 1; k ??= side(); console.log(k);
let k2: any; k2 ??= side(); console.log(k2);
let q: unknown; q ??= 4; console.log(q);`,
  },
  {
    id: "NA-05 (GH #254) TypeScript: x ??= e as an expression's value, dynamic and typed variables",
    entry: "main.ts",
    src: `function side() { console.log("side"); return 1; }
let v: any; console.log(v ??= 5, v);
let k: any = "set"; console.log(k ??= side());
let q: unknown; console.log(q ??= 4);
let o: number | undefined; console.log(o ??= side(), o);
let p: number | null = 3; console.log(p ??= side(), p);`,
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
  expect(node.exitCode, JSON.stringify(node)).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("GH #254: ??= on dynamic variables (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #254: ??= on dynamic variables (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});

// A typed non-union variable's slot can read a zero value where Node has
// undefined (`let m!: number`, GH #255), so `x ??= e` as a VALUE over one
// keeps its refusal by name instead of folding to a no-op.
test("NA-06 (GH #254) x ??= e as a value over a typed non-union variable refuses by name", async () => {
  const dir = join(scratch, "NA-06");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.ts");
  writeFileSync(entry, "let m!: number;\nconsole.log(m ??= 5, m);\n");
  const res = await compile(entry, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm" });
  expect(res.ok).toBe(false);
  expect(JSON.stringify(res.diagnostics)).toContain("compound assignment as an expression");
});
