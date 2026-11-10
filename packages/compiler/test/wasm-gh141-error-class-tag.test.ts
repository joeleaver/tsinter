/* GH #141: an error's built class lives on the error. The runtime builds
 * URIError, ReferenceError, EvalError, AggregateError and AssertionError
 * as a plain Error; each is now stamped with its own class tag of Error's
 * vtable at construction, and `constructor` (and inspect's class name)
 * read the tag, never the `name` member, so a rename through any path
 * never moves it, at no cost per rename (the #135 side table, and its
 * registered cost residue, are gone — SEMANTICS.md S015's GH #135
 * amendment, rewritten). Every row equals Node (spawned at test time), on
 * the wasm lane and, in the second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const islandShim = pathToFileURL(join(import.meta.dirname, "../../../tests/harness/island-shim.mjs")).href;
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh141-"));
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
  /** Node runs with the corpus island shim (`__island_eval` as an indirect
   * eval, tests/harness/island-shim.mjs); implies --dynamic. */
  island?: true;
  /** Ends at a run-time fence whose message matches, after printing
   * exactly `stdout` (a prefix of Node's). */
  fence?: { text: RegExp; stdout: string };
  /** A registered divergence (the SEMANTICS.md entry the row names): this
   * tier prints `tier`, Node prints `node`; both are pinned. */
  pin?: { tier: string; node: string };
}

const ROWS: Row[] = [
  {
    id: "GH141-TS-01 a runtime-built URIError answers URIError through every rename",
    src: `function ctor(e: unknown): string {
  const d: any = e;
  return String(d.constructor.name) + "/" + String(d.constructor.length);
}
try { decodeURIComponent("%"); } catch (e) { console.log(ctor(e)); }
try { decodeURIComponent("%"); } catch (e) { const x = e as Error; x.name = "Error"; console.log(ctor(x), x.name); }
try { decodeURIComponent("%"); } catch (e) { const d: any = e; d.name = "Custom"; console.log(ctor(d), String(d)); }
try { decodeURIComponent("%"); } catch (e) { const d: any = e; Object.assign(d, { name: "Assigned" }); console.log(ctor(d), String(d)); }
try { encodeURIComponent("\\uD800"); } catch (e) { console.log(ctor(e)); }`,
  },
  {
    id: "GH141-TS-02 a plain Error renamed to a runtime name, statically or dynamically, answers Error",
    src: `function ctor(e: unknown): string { const d: any = e; return String(d.constructor.name); }
const plain = new Error("p");
plain.name = "URIError";
console.log(ctor(plain), String(plain));
const p2: any = new Error("p2");
p2.name = "ReferenceError";
console.log(ctor(p2), String(p2));
const p3: any = new Error("p3");
Object.assign(p3, { name: "AggregateError" });
console.log(ctor(p3));
class AppError extends Error {}
const a: any = new AppError("x");
a.name = "URIError";
console.log(ctor(a));
const t: any = new TypeError("t");
t.name = "URIError";
console.log(ctor(t));`,
  },
  {
    id: "GH141-TS-03 many renames of runtime-built errors in a loop keep their class",
    src: `let n = 0;
for (let i = 0; i < 20000; i++) {
  try { decodeURIComponent("%"); } catch (e) {
    (e as Error).name = "R" + (i % 7);
    const d: any = e;
    if (d.constructor.name === "URIError") n++;
  }
}
console.log(n);`,
  },
  {
    id: "GH141-TS-04 a structuredClone keeps the class; inspect's header reads it",
    src: `import * as util from "node:util";
try { decodeURIComponent("%"); } catch (e) { const c: any = structuredClone(e); console.log(c.constructor.name, String(c)); }
try { decodeURIComponent("%"); } catch (e) { const d: any = e; d.stack = ""; d.name = "MyError"; console.log(d); console.log(util.inspect(d)); }
try { decodeURIComponent("%"); } catch (e) { const d: any = e; d.stack = ""; d.name = "URIErrorX"; console.log([d]); }`,
  },
  {
    id: "GH141-TS-05 a ReferenceError (TDZ) and an AssertionError answer their classes after a rename",
    src: `import assert from "node:assert";
function f(): number { return later; }
try { f(); } catch (e) { const d: any = e; d.name = "X"; console.log(d.constructor.name); }
const later = 1;
try { assert.strictEqual(1, 2); } catch (e) { const d: any = e; d.name = "Error"; console.log(d.constructor.name); }`,
  },
  {
    id: "GH141-TS-06 an engine-thrown URIError answers URIError; an engine error under another name stops by name",
    island: true,
    src: `declare function __island_eval(code: string): string;
try { __island_eval("decodeURIComponent('%')"); } catch (e) { const d: any = e; d.name = "X"; console.log(d.constructor.name); }
try { __island_eval("const e = new Error('m'); e.name = 'AbortError'; throw e"); } catch (e) { const d: any = e; console.log(d.name); console.log(d.constructor.name); }`,
    fence: { text: /reading 'constructor' of an error rebuilt from a host's, the embedded engine's or a marker-carrying object's name and message/, stdout: "URIError\nAbortError\n" },
  },
  {
    id: "GH141-JS-01 a JavaScript source: a renamed runtime error and a caught plain Error renamed to a runtime name",
    entry: "main.js",
    src: `try { decodeURIComponent("%"); } catch (e) { e.name = "Error"; console.log(e.constructor.name, String(e)); }
try { throw new Error("q"); } catch (e) { e.name = "EvalError"; console.log(e.constructor.name, String(e)); }`,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  writeFileSync(entry, row.src + "\n");
  return entry;
}

function nodeRun(file: string, island: boolean): Out {
  const r = spawnSync(process.execPath, [...(island ? ["--import", islandShim] : []), "--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
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
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, ...(row.dynamic || row.island ? { dynamic: true } : {}) });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry, row.island === true);
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

describe("GH #141: an error answers the class it was built as (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #141: an error answers the class it was built as (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
