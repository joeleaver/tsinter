/* GH #143: an optional record field shared into `any`. A record shared
 * with dynamic code is a live view whose keys follow S091's key rule: an
 * optional field holding undefined has no key. That is Node's answer for a
 * field the program left out, and S091 (a)'s registered divergence for one
 * it set to undefined explicitly (the issue's repro, pinned with Node's
 * answer beside it). Printing the record directly keeps the explicit
 * undefined, as Node does.
 *
 * Every other row equals Node (spawned at test time), on the wasm lane
 * and, in the second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh143-"));
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
    id: "GH143-01 the issue's repro: an optional field set to undefined, shared into any (S091 (a))",
    src: `type R = { x?: number; b: number };
const o: R = { x: undefined, b: 2 };
const aq: any = o;
console.log(aq, "x" in aq);`,
    diverges: { entry: "SEMANTICS.md S091 (a)", node: "{ x: undefined, b: 2 } true\n", stdout: "{ b: 2 } false\n" },
  },
  {
    id: "GH143-02 an optional field left out has no key through the view, as in Node",
    src: `type R = { x?: number; b: number };
const o: R = { b: 2 };
const aq: any = o;
console.log(aq, "x" in aq, Object.keys(aq), Object.hasOwn(aq, "x"), JSON.stringify(aq));
const f = (v: any): void => console.log(Object.keys(v), JSON.stringify(v));
f(o);
f({ x: 1, b: 2 } as R);`,
  },
  {
    id: "GH143-03 an optional field holding a value, then rewritten from typed code",
    src: `type R = { x?: number; b: number };
const p: R = { x: 3, b: 4 };
const ap: any = p;
console.log(ap, "x" in ap, Object.keys(ap));
p.x = 7;
console.log(ap, ap.x, JSON.stringify(ap));`,
  },
  {
    id: "GH143-04 printed directly, the explicit undefined shows, as in Node (S091's printing rule)",
    src: `type R = { x?: number; b: number };
const o: R = { x: undefined, b: 2 };
console.log(o, JSON.stringify(o));
const nested = { inner: o };
console.log(JSON.stringify(nested));`,
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

describe("GH #143: an optional field holding undefined, shared into any (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #143: an optional field holding undefined, shared into any (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
