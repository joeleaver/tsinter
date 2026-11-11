/* Shared row runner for the paperclip blocker rows
 * (wasm-top10-paperclip-*.test.ts): each row is a tiny project, without
 * third-party code, that reproduces one construct the paperclip CLI
 * (tests/real-apps-top10) needed. It runs under Node (spawned at test
 * time) and on a WasmGC lane, and stdout, stderr and the exit code must
 * match byte for byte. Rows default to a project with @types/node (the
 * vendored copy in tests/fixtures/node-types), as paperclip has. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const nodeTypes = join(import.meta.dirname, "../../../tests/fixtures/node-types/node_modules");
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true } });

export interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Row {
  id: string;
  /** file name → source; the entry is `main.ts` or `main.js`. */
  files: Record<string, string>;
  /** Default true: link the vendored @types/node into the project. */
  nodeTypes?: boolean;
  /** link path → target (relative to the link's directory), e.g. a
   * workspace member's node_modules symlink. */
  links?: Record<string, string>;
}

export function scratchDir(tag: string): string {
  const scratch = mkdtempSync(join(tmpdir(), `tsinter-${tag}-`));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  return scratch;
}

function write(scratch: string, row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  if (row.nodeTypes !== false) symlinkSync(nodeTypes, join(dir, "node_modules"));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  let entry = "";
  for (const [name, src] of Object.entries(row.files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), src + "\n");
    if (/(^|\/)main\.[cm]?[jt]s$/.test(name)) entry = join(dir, name);
  }
  for (const [link, target] of Object.entries(row.links ?? {})) {
    mkdirSync(join(dir, link, ".."), { recursive: true });
    symlinkSync(target, join(dir, link));
  }
  return entry;
}

function nodeRun(file: string, args: string[]): Out {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string, args: string[]): Promise<Out> {
  try {
    const p = run(path, args, { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

export async function checkRow(scratch: string, row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(scratch, row, backend);
  const dir = join(entry, "..");
  const args: string[] = [];
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry, args);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!, args);
  expect(got, row.id).toEqual(node);
}
