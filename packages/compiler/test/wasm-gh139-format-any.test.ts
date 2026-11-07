/* GH #139: util.format with an `any` or `unknown` format string formats.
 * Node's formatWithOptions scan runs at run time over the format string
 * whatever its static type (board #237's runtime port), so
 * `util.format(cfg.f, o, 5)` substitutes where it used to join the
 * arguments with spaces. A specifier this tier fences at run time keeps
 * its named fence (SEMANTICS.md S099), pinned below. Every row equals Node
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
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh139-"));
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
    id: "GH139-TS-01 the issue's repro: an any format string substitutes",
    src: `import * as util from "node:util";
const cfg: any = JSON.parse("{\\"f\\":\\"v=%s;%d\\"}");
console.log(util.format(cfg.f, { a: 1 }, 5));
console.log(cfg.f, { a: 1 }, 5);`,
  },
  {
    id: "GH139-TS-02 every specifier over an any format string; extra arguments, a lone format, %%",
    src: `import * as util from "node:util";
const cfg: any = JSON.parse("{\\"f\\":\\"v=%s;%d\\",\\"g\\":\\"%O|%j|%%|%i|%f|%c\\",\\"n\\":5}");
console.log(util.format(cfg.f));
console.log(util.format(cfg.f, "x", "7", "extra", 9));
console.log(util.format(cfg.g, [1], { b: 2 }, 3.5, "4.5", "css"));
console.log(util.format(cfg.g, 1));
console.log(util.formatWithOptions({}, cfg.f, "w", 2));`,
  },
  {
    id: "GH139-TS-03 a non-string any first argument, an unknown format string, a missing member",
    src: `import * as util from "node:util";
const cfg: any = JSON.parse("{\\"f\\":\\"v=%s;%d\\",\\"n\\":5}");
console.log(util.format(cfg.n, "a"));
console.log(util.format(cfg.n));
const u: unknown = cfg.f;
console.log(util.format(u, "q", 1));
console.log(util.format(cfg.missing, 1));
const arr: any = [1, 2];
console.log(util.format(arr, "z"));
const s: string = cfg.f;
console.log(util.format(s, cfg, cfg.n));`,
  },
  {
    id: "GH139-JS-01 a JavaScript source's parsed format string substitutes",
    entry: "main.js",
    src: `const util = require("node:util");
const cfg = JSON.parse("{\\"f\\":\\"v=%s;%d\\",\\"g\\":\\"%O|%j|%%|%i|%f\\",\\"n\\":5}");
console.log(util.format(cfg.f, { a: 1 }, 5));
console.log(util.format(cfg.f));
console.log(util.format(cfg.g, [1], { b: 2 }, 3.5, "4.5"));
console.log(util.format(cfg.n, "a"));
console.log(util.format(cfg.missing, 1));`,
  },
  {
    id: "GH139-TS-04 (S099) %o over an array under an any format string stops at its named fence",
    src: `import * as util from "node:util";
const cfg: any = JSON.parse("{\\"g\\":\\"%o\\"}");
console.log("before");
console.log(util.format(cfg.g, [1]));`,
    fence: { text: /'util\.format %o over arrays' is part of the standard library types but has no scriptc lowering yet/, stdout: "before\n" },
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

describe("GH #139: util.format with an any format string formats (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #139: util.format with an any format string formats (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
