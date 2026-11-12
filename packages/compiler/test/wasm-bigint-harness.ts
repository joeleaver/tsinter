/* The BigInt rows' shared harness (wasm-bigint-*.test.ts): each row is a
 * program in test/fixtures/bigint/ (`<id>.ts.txt` / `<id>.js.txt`, kept out
 * of the repo's own type-check), run under Node (spawned at test time, the
 * oracle) and compiled for the wasm and wasm-native lanes; stdout, stderr
 * and the exit code must match byte for byte. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const FIXTURES = join(import.meta.dirname, "fixtures", "bigint");

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function wasmRun(scratch: string, id: string, file: string): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
}

async function nativeRun(scratch: string, id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  try {
    const p = run(res.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

/** Rows `ids` (fixture names `<id>.ts.txt` or `<id>.js.txt`) on both lanes. */
export function bigintRows(title: string, ids: string[]): void {
  const scratch = mkdtempSync(join(tmpdir(), "tsinter-bigint-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const rows = ids.map((id) => {
    const ext = id.endsWith(".js") ? "js" : "ts";
    const name = id.replace(/\.js$/, "");
    return { id: name, ext, src: readFileSync(join(FIXTURES, `${name}.${ext}.txt`), "utf8") };
  });
  describe(`${title} (wasm lane vs Node)`, () => {
    test.for(rows.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
      const file = join(scratch, `${id}.${row.ext}`);
      writeFileSync(file, row.src);
      const node = nodeRun(file);
      expect(node.exitCode).toBe(0);
      expect(await wasmRun(scratch, id, file)).toEqual(node);
    }, 300_000);
  });
  describe(`${title} (wasm-native lane vs Node)`, () => {
    test.for(rows.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
      const file = join(scratch, `${id}-n.${row.ext}`);
      writeFileSync(file, row.src);
      const node = nodeRun(file);
      expect(node.exitCode).toBe(0);
      expect(await nativeRun(scratch, id, file)).toEqual(node);
    }, 600_000);
  });
}
