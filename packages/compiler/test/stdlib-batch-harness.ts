/* The row runner shared by paperclip's stdlib batch row files: every row
 * equals Node (spawned at test time), on the wasm lane and, in the second
 * describe, on the wasm-native lane, or stops by name where noted. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-stdlib-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Row {
  id: string;
  /** The entry's source (written as main.ts unless `entry` names another). */
  src: string;
  entry?: string;
  /** Node's exit status for the row (default 0); the tier's must match. */
  exit?: number;
  /** Still stops by name on this tier: stdout up to the stop is a prefix
   * of Node's, and stderr names the diagnostic. */
  nativeOnly?: boolean;
  fence?: string;
  /** The build refuses, and some diagnostic's message contains this. */
  refusedMsg?: string;
  /** Other files written beside the entry (name -> source). */
  extra?: Record<string, string>;
  /** A project with @types/node (the vendored tests/fixtures/node-types
   * copy) and a strict tsconfig, as paperclip has. */
  nodeTypes?: boolean;
  /** Environment changes for the run, Node's and the tier's alike (a
   * string sets the variable, undefined removes it). */
  env?: Record<string, string | undefined>;
}

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, row.entry ?? "main.ts");
  if (row.nodeTypes === true) {
    symlinkSync(join(import.meta.dirname, "../../../tests/fixtures/node-types/node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, allowJs: true } }));
  }
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.extra ?? {})) writeFileSync(join(dir, name), text + "\n");
  return entry;
}

function envOf(row: Row): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(row.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function nodeRun(file: string, env: NodeJS.ProcessEnv): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "", env });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string, env: NodeJS.ProcessEnv): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8", env });
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
  if (row.refusedMsg !== undefined) {
    expect(res.ok, row.id).toBe(false);
    expect(res.diagnostics.some((d) => d.message.includes(row.refusedMsg!)), JSON.stringify(res.diagnostics)).toBe(true);
    return;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${JSON.stringify(res.diagnostics)}`);
  const env = envOf(row);
  const host = row.env ? { env: Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined) } : undefined;
  const node = nodeRun(entry, env);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!, host).then(
        (r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }),
        // A trap is the tier's exit-1 channel: compare what it printed.
        () => runWasmToTrap(res.binaryPath!, host).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: 1 })),
      )
    : await nativeRun(res.binaryPath!, env);
  if (row.fence !== undefined) {
    expect(node.exitCode).toBe(0);
    expect(got.exitCode, row.id).not.toBe(0);
    expect(node.stdout.startsWith(got.stdout), row.id).toBe(true);
    expect(got.stderr, row.id).toContain(row.fence);
    return;
  }
  expect(node.exitCode, JSON.stringify(node)).toBe(row.exit ?? 0);
  expect(got, row.id).toEqual(node);
}

/** The two describes, wasm then wasm-native, over `rows` under `title`. */
export function describeRows(title: string, rows: Row[]): void {
  describe(`${title} (wasm lane vs Node)`, () => {
    test.for(rows.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      if (row.nativeOnly === true) return;
      await check(row, "wasm");
    });
  });

  describe(`${title} (wasm-native lane vs Node)`, () => {
    test.for(rows.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await check(row, "wasm-native");
    }, 600_000);
  });
}
