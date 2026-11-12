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
  /** No tsconfig.json at the project root (only the files' own). */
  noTsconfig?: boolean;
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
  if (row.noTsconfig !== true) writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
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

/** A row whose program must REFUSE at build time with a diagnostic whose
 * message contains `expected` (the loud-refusal half of a construct). */
export async function checkRefuses(scratch: string, row: Row, expected: string, absent?: string, backend: "wasm" | "wasm-native" = "wasm"): Promise<void> {
  const entry = write(scratch, row, `refuse-${backend}`);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  expect(res.ok, row.id).toBe(false);
  const text = res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n");
  expect(text).toContain(expected);
  if (absent !== undefined) expect(text).not.toContain(absent);
}

/** A row whose program BUILDS for `backend` (the wasm lane's in-process
 * host has no real child_process, so child rows only build there). */
export async function checkBuilds(scratch: string, row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(scratch, row, `${backend}-build`);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
}

/** A row whose program runs as Node does up to a construct this build
 * stops at by name (SEMANTICS.md S122): our stdout is Node's up to the
 * fence (`nodeStdoutPrefix`, checked against Node's own run), stderr
 * names the fence, and the exit code is 1. */
export async function checkFenced(scratch: string, row: Row, backend: "wasm-native", nodeStdoutPrefix: string, fence: string): Promise<void> {
  const entry = write(scratch, row, `${backend}-fence`);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, "program"), outDir: dir, backend });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry, []);
  expect(node.stdout.startsWith(nodeStdoutPrefix), `${row.id}: Node's stdout ${JSON.stringify(node.stdout)}`).toBe(true);
  const got = await nativeRun(res.binaryPath!, []);
  expect(got.stdout, row.id).toBe(nodeStdoutPrefix);
  expect(got.stderr, row.id).toContain(`tsinter: unsupported: ${fence}`);
  expect(got.exitCode, row.id).toBe(1);
}

/** A fenced row's report names `suffix` (e.g. "main.ts:8]": the line of
 * the construct that stopped it). */
export async function checkFencedLine(scratch: string, row: Row, suffix: string): Promise<void> {
  const entry = write(scratch, row, "wasm-native-line");
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${row.id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const got = await nativeRun(res.binaryPath!, []);
  const line = got.stderr.split("\n").find((l) => l.startsWith("tsinter: unsupported: ")) ?? "";
  expect(line.endsWith(suffix), `${row.id}: ${line}`).toBe(true);
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
