/* GH #147: console.log / util.inspect of a STATICALLY typed error prints
 * Node's header. The bracket form (SEMANTICS.md S027) printed the `name`
 * slot as it stood; Node's improveStack rewrites a name ending in "Error"
 * that differs from the constructor's: `[TypeError [MyError]: t]` for a
 * TypeError renamed MyError, `[URIError: URI malformed]` for a URIError
 * renamed Error (the constructor contains the name). The rule is now the
 * one the dynamic path ported in GH #137 (one helper serves both), and the
 * constructor is the class the error was built as (GH #141's class tags).
 * Error.prototype.toString's empty-name rule holds too (`[t]`, on both
 * paths: the dynamic path's fence for it is gone), and beyond the depth
 * budget an error with a code names its constructor, as Node does.
 *
 * Rows empty the stack first (`(e as any).stack = ""`), the form S027
 * registers. Every row equals Node (spawned at test time), on the wasm
 * lane and, in the second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh147-"));
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
}

const ROWS: Row[] = [
  {
    id: "GH147-TS-01 the issue's repro: a renamed TypeError and a URIError renamed Error",
    src: `const t = new TypeError("t");
t.name = "MyError";
(t as any).stack = "";
console.log(t);
const u = (() => { try { decodeURIComponent("%"); } catch (e) { return e as Error; } })()!;
u.name = "Error";
(u as any).stack = "";
console.log(u);`,
  },
  {
    id: "GH147-TS-02 a plain Error renamed RangeError prints both, in every inspect position",
    src: `import * as util from "node:util";
const h = new Error("m");
h.name = "RangeError";
(h as any).stack = "";
console.log(h, [h], { h });
console.log(util.inspect(h), util.inspect({ a: { b: { c: { h } } } }));
h.message = "";
console.log(h, util.inspect(h));
h.message = "two\\nlines";
console.log({ k: h });`,
  },
  {
    id: "GH147-TS-03 names the rule leaves alone, and the ones it rewrites",
    src: `const k = new RangeError("r");
(k as any).stack = "";
console.log(k);
for (const n of ["Bad", "", "RangeError", "RangeErrorError", "RangError", "Error", "angeError", "TypeError"]) {
  k.name = n;
  console.log(JSON.stringify(n), k);
}
k.message = "";
console.log(k);
const s = new SyntaxError("s");
(s as any).stack = "";
s.name = "SyntaxErrorX";
console.log(s);`,
  },
  {
    id: "GH147-TS-04 a renamed error with a code prints its header, and its constructor beyond the depth",
    src: `let b: Error | undefined;
try { Buffer.alloc(-1); } catch (e) { b = e as Error; }
const e = b!;
(e as any).stack = "";
console.log(e);
e.name = "MyError";
console.log(e, { a: { b: { c: e } } }, { a: { b: { e } } });`,
  },
  {
    id: "GH147-TS-05 the typed and the dynamic rendering of one renamed error agree",
    src: `const t = new TypeError("t");
const a: any = t;
a.stack = "";
t.name = "MyError";
console.log(t, a);
a.name = "Other";
console.log(t, a);
t.name = "";
console.log(t, a, [t, a]);`,
  },
  {
    id: "GH147-JS-01 an error held in a dynamic value whose name prints empty renders its message alone",
    entry: "main.js",
    src: `const util = require("node:util");
try { throw new RangeError("r"); } catch (e) { e.stack = ""; e.name = ""; console.log(e, util.inspect({ a: e })); e.message = ""; console.log(e); }
try { throw new Error("m"); } catch (e) { e.stack = ""; e.name = "RangeError"; console.log(e); e.name = "SyntaxErrorX"; console.log(e); }`,
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
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("GH #147: a typed error inspects with Node's header (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #147: a typed error inspects with Node's header (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
