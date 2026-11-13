/* GH #200: rethrowing an Error held as a dynamic value (`unknown`, a
 * JavaScript binding, a stored catch binding) loses nothing: the catch
 * that receives it answers `instanceof Error` (and the subclass) true, the
 * `(e as Error)` checked cast holds, and the caught value is the SAME
 * object (`e === u`), as Node. Non-Error dynamic values rethrow as before.
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh200-"));
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
  /** Ends uncaught: Node and this tier both exit 1 after the same stdout,
   * and this tier's report is `report` (S007). */
  uncaught?: { report: string };
}

const ROWS: Row[] = [
  {
    id: "GH200-01 the issue's shape: an Error returned as unknown and rethrown is caught as an Error",
    src: `function mk(): unknown { try { throw new Error("x"); } catch (e) { return e; } }
try { throw mk(); } catch (e) { console.log(e instanceof Error, String(e), (e as Error).message); }
try { throw mk(); } catch (e) { if (e instanceof Error) console.log("narrowed", e.name, e.message); else console.log("lost"); }`,
  },
  {
    id: "GH200-02 a user Error subclass and built-in subclasses keep their class through the rethrow",
    src: `class MyErr extends Error { constructor(m: string) { super(m); this.name = "MyErr"; } }
function mk2(): unknown { try { throw new MyErr("y"); } catch (e) { return e; } }
try { throw mk2(); } catch (e) { console.log(e instanceof Error, e instanceof MyErr, e instanceof TypeError, String(e)); }
const u: unknown = new TypeError("t");
try { throw u; } catch (e) { console.log(e instanceof TypeError, e instanceof RangeError, e instanceof Error, e === u); }`,
  },
  {
    id: "GH200-03 rethrow through a never-returning helper, a finally and an outer catch keeps identity",
    src: `function rethrow(x: unknown): never { throw x; }
class AppErr extends Error {}
function wrap(): unknown { try { throw new AppErr("app"); } catch (e) { return e; } }
const w = wrap();
try { try { rethrow(w); } finally { console.log("fin"); } } catch (e) {
  console.log(e === w, e instanceof AppErr);
  if (e instanceof AppErr) console.log("app", e.name, e.message);
}`,
  },
  {
    id: "GH200-04 non-Error dynamic values rethrow as themselves",
    src: `function rethrow(x: unknown): never { throw x; }
const vals: unknown[] = [];
vals.push(1); vals.push("s"); vals.push(JSON.parse('{"a":1}')); vals.push(null); vals.push(undefined); vals.push(new RangeError("r"));
for (const v of vals) {
  try { rethrow(v); } catch (e) {
    console.log(typeof e, e instanceof Error, e instanceof RangeError, e === v, String(e));
  }
}`,
  },
  {
    id: "GH200-05 an async function throwing an Error held as unknown rejects with that Error",
    src: `async function main(): Promise<void> {
  const u: unknown = new Error("rej");
  try { await (async () => { throw u; })(); } catch (e) { console.log(e instanceof Error, e === u, (e as Error).message); }
}
main();`,
  },
  {
    id: "GH200-06 JavaScript: a saved catch binding rethrown later is caught as the Error it is",
    entry: "main.js",
    src: `function attempt(f) { let saved = null; try { f(); } catch (e) { saved = e; } if (saved) throw saved; }
try { attempt(() => { throw new TypeError("bad"); }); } catch (e) {
  console.log(e instanceof TypeError, e instanceof Error, e.message, String(e));
}
try { attempt(() => { throw "str"; }); } catch (e) { console.log(typeof e, e instanceof Error, e); }`,
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
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  if (row.uncaught !== undefined) {
    expect(node.exitCode).toBe(1);
    expect(got.exitCode, row.id).toBe(1);
    expect(got.stdout, row.id).toBe(node.stdout);
    expect(got.stderr.split("\n")[0], row.id).toBe(row.uncaught.report);
    return;
  }
  expect(node.exitCode).toBe(0);
  expect(got, row.id).toEqual(node);
}

describe("GH #200: rethrowing an Error held as a dynamic value (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #200: rethrowing an Error held as a dynamic value (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
