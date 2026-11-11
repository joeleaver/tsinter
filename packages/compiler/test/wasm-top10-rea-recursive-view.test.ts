/* rea (tests/real-apps-top10) step 3: a value of a RECURSIVE union type (the
 * JSON value type: an arm holding an array of the union itself, an index
 * signature of it) crossing into an `any` slot. The view's check for a Node
 * class instance inside the value (nestsNodeClassShape, island-views.ts)
 * guarded records only, so the union recursed until the compiler's stack
 * overflowed (RangeError: an internal crash, rea's first compile past the
 * gate). It now visits each type once.
 *
 * Every row equals Node (spawned at test time), on the wasm lane and on the
 * wasm-native lane. No third-party code: the rows are written from scratch. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-rea-recview-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  src: string;
}

const JSON_T = "type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json };\n";

const ROWS: Row[] = [
  {
    id: "REA-RECVIEW-01 a recursive JSON value handed to an any slot",
    src:
      JSON_T +
      'const doc: Json = { name: "rea", tags: ["cli", ["nested", 1]], ok: true, none: null };\n' +
      "const loose: any = doc;\n" +
      "console.log(loose, typeof loose.name, loose.tags[1][0]);",
  },
  {
    id: "REA-RECVIEW-02 a recursive JSON value handed to a function taking unknown",
    src:
      JSON_T +
      "const show = (v: unknown): string => JSON.stringify(v);\n" +
      'const doc: Json = { list: ["a", 2, null], inner: { flag: false, more: ["x"] } };\n' +
      "console.log(show(doc));",
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
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("rea: recursive union values into any (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("rea: recursive union values into any (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  });
});
