/* Shared harness for the U3+U4 rows (wasm-u3u4-*.test.ts): each row is a
 * program compiled for the wasm and wasm-native lanes and compared with
 * Node byte for byte (stdout, stderr, exit code), Node spawned at test
 * time. A `nodeArgs` row runs Node with extra flags (S132's rows compare
 * against `--disallow-code-generation-from-strings`). */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);

export interface Row {
  id: string;
  src: string;
  /** The entry's file name (main.js unless set). */
  entry?: string;
  nodeArgs?: string[];
  /** The program ends with an uncaught error: stdout and the exit code
   * match Node, and stderr is S007's one-line rendering of the error Node
   * reports (Node's report adds the source line and the stack). */
  uncaught?: string;
  /** The program compiles, prints Node's stdout up to the check, and
   * stops at the named fence (S122). */
  fence?: { text: RegExp; stdout: string };
}

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function nodeRun(file: string, extra: string[]): Out {
  const r = spawnSync(process.execPath, [...extra, "--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
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

/** Node's uncaught-error report names the script path; both sides print
 * it from the same file, so the rows compare it as is. */
export function defineRows(title: string, rows: Row[]): void {
  const scratch = mkdtempSync(join(tmpdir(), "tsinter-u3u4-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const check = async (row: Row, backend: "wasm" | "wasm-native"): Promise<void> => {
    const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, row.entry ?? "main.js");
    writeFileSync(entry, row.src + "\n");
    const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
    if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
    const node = nodeRun(entry, row.nodeArgs ?? []);
    const got: Out = backend === "wasm"
      ? await runWasm(res.binaryPath!).then(
          (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
          async () => runWasmToTrap(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
        )
      : await nativeRun(res.binaryPath!);
    if (row.fence !== undefined) {
      expect(got.stdout).toBe(row.fence.stdout);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr).toMatch(row.fence.text);
      return;
    }
    if (row.uncaught !== undefined) {
      expect(got.stdout).toBe(node.stdout);
      expect(node.exitCode).toBe(1);
      expect(got.exitCode).toBe(1);
      expect(node.stderr).toContain(`\n${row.uncaught}\n`);
      // (the wasm-native runner adds its trap line after it, S117)
      expect(backend === "wasm" ? got.stderr : got.stderr.split("\n")[0] + "\n").toBe(`Uncaught ${row.uncaught}\n`);
      return;
    }
    expect(got).toEqual(node);
  };
  describe(`${title} (wasm lane vs Node)`, () => {
    test.for(rows.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await check(row, "wasm");
    });
  });
  describe(`${title} (wasm-native lane vs Node)`, () => {
    test.for(rows.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await check(row, "wasm-native");
    }, 600_000);
  });
}
