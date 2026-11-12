/* rea (tests/real-apps-top10) step 5: a generic helper called at many types.
 * rea's `ok = <T>(value: T): Result<T, never>` is called at hundreds of
 * distinct types across the program, and generic functions were capped at
 * 100 instances each ("unbounded generic instantiation ... polymorphic
 * recursion?", 37 sites in the past-gate census). The cap existed to stop
 * POLYMORPHIC recursion (`f<T>` calling `f<T[]>`), which grows by one
 * instance per level. Generic functions are now bounded by instantiation
 * recursion (each instance's parent is the instance whose body created
 * it; a function repeating MAX_GENERIC_DEPTH (64) times among a new
 * instance's ancestors refuses), with a 4096-instance backstop: wide use and
 * long chains of distinct generics compile, polymorphic recursion still
 * refuses by name.
 *
 * Exact rows equal Node (spawned at test time); the refused row pins the
 * named refusal. Both lanes. No third-party code. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-gdepth-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
  refused?: RegExp;
}

const RESULT =
  "type Result<T, E> =\n" +
  "  | { readonly ok: true; readonly value: T }\n" +
  "  | { readonly ok: false; readonly error: E };\n" +
  "const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });\n";

// 150 call sites, each at its own record type (one instance per type).
const WIDE = Array.from({ length: 150 }, (_, i) => `out.push(JSON.stringify(ok({ f${i}: ${i} })));`).join("\n");

// A long chain of DISTINCT generics: g0 calls g1 ... calls g69 (the
// review's chain70: deeper than MAX_GENERIC_DEPTH, but no function repeats).
const CHAIN = Array.from({ length: 70 }, (_, i) =>
  i === 69 ? `function g69<T>(x: T): T[] { return [x]; }` : `function g${i}<T>(x: T): T[] { return g${i + 1}(x); }`,
)
  .reverse()
  .join("\n");

const ROWS: Row[] = [
  {
    id: "REA-GDEPTH-01 one generic helper at 150 distinct types",
    src: RESULT + "const out: string[] = [];\n" + WIDE + "\nconsole.log(out.length, out[0], out[149]);",
  },
  {
    id: "REA-GDEPTH-02 a seventy-deep chain of distinct generic functions at several types",
    src: CHAIN + '\nconsole.log(g0(1), g0("a"), g0({ k: true }), g0([2, 3]));',
  },
  {
    id: "REA-GDEPTH-03 polymorphic recursion still refuses by name",
    src:
      "function nest<T>(x: T, n: number): number {\n" +
      "  return n === 0 ? 0 : 1 + nest([x], n - 1);\n" +
      "}\n" +
      "console.log(nest(1, 3));",
    refused: /unbounded generic instantiation \('nest' instantiated recursively 64 levels deep at ever-new types — polymorphic recursion\)/,
  },
  {
    id: "REA-GDEPTH-04 mutual polymorphic recursion through two generics still refuses",
    src:
      "function ping<T>(x: T, n: number): number {\n" +
      "  return n === 0 ? 0 : 1 + pong([x], n - 1);\n" +
      "}\n" +
      "function pong<T>(x: T, n: number): number {\n" +
      "  return n === 0 ? 0 : 1 + ping([x], n - 1);\n" +
      "}\n" +
      "console.log(ping(1, 3));",
    refused: /unbounded generic instantiation \('p[io]ng' instantiated recursively 64 levels deep at ever-new types — polymorphic recursion\)/,
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.ts");
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
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  if (row.refused !== undefined) {
    expect(res.ok, `${row.id} must refuse on ${backend}`).toBe(false);
    if (res.ok) return;
    const d = res.diagnostics.find((x) => x.code === "SC1090" && row.refused!.test(x.message));
    expect(d, res.diagnostics.map((x) => `${x.code} ${x.message}`).join(" | ")).toBeDefined();
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("rea: generic instantiation bounded by depth (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: generic instantiation bounded by depth (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
