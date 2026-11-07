/* GH #140: an object literal's function members are named by their key.
 * ES SetFunctionName names a method and an anonymous function or arrow
 * defined as a property value by its key, a named function expression by
 * its own name; a literal built as a dynamic value (or read through
 * `o.h.name` in a JavaScript source) now carries those names, so `f.name`
 * and util.inspect's `[Function: m]` answer as Node's (SEMANTICS.md S020's
 * GH #140 amendment). A static record that crosses as a whole names its
 * members by key, which is wrong for a named function expression: that row
 * pins this tier's answer beside Node's. Every other row equals Node
 * (spawned at test time), on the wasm lane and, in the second describe, on
 * the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh140-"));
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
  /** Build with --dynamic (the engine). */
  dynamic?: true;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** A registered divergence (the SEMANTICS.md entry the row names): this
   * tier prints `tier`, Node prints `node`; both are pinned. */
  pin?: { tier: string; node: string };
}

const ROWS: Row[] = [
  {
    id: "GH140-TS-01 the issue's repro: an any-typed literal's method prints with its name",
    src: `const x: any = { a: 1, toString() { return "x"; } };
console.log(x);
console.log(x.toString.name, String(x));`,
  },
  {
    id: "GH140-TS-02 methods, anonymous functions, arrows, named expressions and string keys",
    src: `const o: any = { m() { return 1; }, f: function () { return 2; }, g: () => 3, h: function named() { return 4; }, "q-r"() { return 5; }, p: (function () { return 6; }) };
console.log(o);
console.log(o.m.name, o.f.name, o.g.name, o.h.name, o["q-r"].name, o.p.name);
console.log(o.m(), o.f(), o.g(), o.h(), o["q-r"](), o.p());`,
  },
  {
    id: "GH140-TS-03 literals passed into an any parameter, and a static record that crosses",
    src: `function take(v: any): void { console.log(v, v.run.name); }
take({ run() { return 0; } });
take({ run: () => 0 });
const r = { run() { return 0; }, w: function () { return 1; } };
take(r);`,
  },
  {
    id: "GH140-TS-04 (S020) a static record's named function expression answers its key",
    src: `function take(v: any): void { console.log(v.run.name); }
const r = { run: function named() { return 0; } };
take(r);`,
    pin: { tier: "run\n", node: "named\n" },
  },
  {
    id: "GH140-JS-01 a JavaScript source's literals print and read their members' names",
    entry: "main.js",
    src: `function show(v) { console.log(v); }
show({ a: 1, toString() { return "x"; } });
const nul = JSON.parse("{}");
nul.box = { m() { return 1; } };
console.log(nul.box, nul.box.m.name);
const o = { m() { return 1; }, f: function () { return 2; }, g: () => 3, h: function named() { return 4; }, "q-r"() { return 5; } };
show([o.m.name, o.f.name, o.g.name, o.h.name, o["q-r"].name]);
const p = { async am() { return 1; } };
show(p.am.name);`,
  },
  {
    id: "GH140-JS-02 (S020) a JavaScript literal that crosses as a record names a named function expression by its key",
    entry: "main.js",
    src: `function show(v) { console.log(v); }
const o = { m() { return 1; }, h: function named() { return 4; } };
show(o);`,
    pin: { tier: "{ m: [Function: m], h: [Function: h] }\n", node: "{ m: [Function: m], h: [Function: named] }\n" },
  },
  {
    id: "GH140-JS-03 a generator method's name read stops at its named fence",
    entry: "main.js",
    src: `const p = { *gm() { yield 1; } };
console.log("before");
console.log(p.gm.name);`,
    fence: { text: /'\(\) => Generator<number, void, unknown>\.name' is part of the standard library types but has no scriptc lowering yet/, stdout: "before\n" },
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
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, ...(row.dynamic ? { dynamic: true } : {}) });
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
  if (row.pin !== undefined) {
    // A registered divergence: this tier's answer and Node's, both pinned.
    expect(node.stdout, `${row.id} (Node)`).toBe(row.pin.node);
    expect(got, row.id).toEqual({ stdout: row.pin.tier, stderr: "", exitCode: 0 });
    return;
  }
  expect(got, row.id).toEqual(node);
}

describe("GH #140: object-literal function members are named by their key (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #140: object-literal function members are named by their key (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
