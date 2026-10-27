/* The wasm-native lane's host and runner, end to end (native-runner N0
 * review): small programs built with `backend: "wasm-native"` must match
 * the Node oracle where the host decides —
 *  - a path holding U+0000 never reaches a syscall: every fs key throws
 *    Node's TypeError ERR_INVALID_ARG_VALUE (the module's own validation)
 *    and existsSync answers false, so rmSync("d\0x") cannot remove "d" and
 *    writeFileSync("w.txt\0.js") cannot write "w.txt";
 *  - copyFileSync(a, a) leaves the file alone (libuv's same-file check);
 *  - a SIGSEGV the process sends itself kills it as it kills Node (the
 *    runner's fault handler re-raises a signal no access raised).
 * Each program runs in its own temporary directory, the oracle first. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const run = promisify(execFile);

interface Out {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}
async function exec(cmd: string, args: string[], cwd: string): Promise<Out> {
  const p = run(cmd, args, { cwd, encoding: "utf8" });
  p.child.stdin?.end();
  try {
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, code: 0, signal: null };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number; signal?: string };
    return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", code: typeof x.code === "number" ? x.code : null, signal: x.signal ?? null };
  }
}

async function both(src: string): Promise<{ node: Out; native: Out }> {
  const dir = mkdtempSync(join(tmpdir(), "tsinter-wasm-native-"));
  try {
    const file = join(dir, "main.ts");
    writeFileSync(file, src);
    const res = await compile(file, { outPath: join(dir, "out", "program"), outDir: join(dir, "out"), backend: "wasm-native" });
    if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join("\n"));
    const nodeDir = mkdtempSync(join(dir, "node-"));
    const nativeDir = mkdtempSync(join(dir, "native-"));
    // no core files: a signal death would otherwise spend seconds dumping
    const node = await exec("/bin/sh", ["-c", 'ulimit -c 0; exec "$0" "$1"', process.execPath, file], nodeDir);
    const native = await exec("/bin/sh", ["-c", 'ulimit -c 0; exec "$0"', res.binaryPath], nativeDir);
    return { node, native };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the wasm-native lane's host, end to end against Node", () => {
  test("a path holding U+0000: every fs key throws Node's ERR_INVALID_ARG_VALUE, existsSync answers false, nothing is touched", async () => {
    const src = `import * as fs from "node:fs";
fs.mkdirSync("d");
fs.writeFileSync("d/keep.txt", "keep");
fs.writeFileSync("a.txt", "a");
const tries: [string, () => unknown][] = [
  ["rmSync", () => fs.rmSync("d\\0junk", { recursive: true, force: true })],
  ["writeFileSync", () => fs.writeFileSync("w.txt\\0.js", "x")],
  ["appendFileSync", () => fs.appendFileSync("w.txt\\0.js", "x")],
  ["readFileSync", () => fs.readFileSync("a.txt\\0", "utf8")],
  ["readdirSync", () => fs.readdirSync("d\\0x")],
  ["mkdirSync", () => fs.mkdirSync("m\\0x")],
  ["mkdtempSync", () => fs.mkdtempSync("t\\0x")],
  ["rmdirSync", () => fs.rmdirSync("d\\0x")],
  ["unlinkSync", () => fs.unlinkSync("a.txt\\0x")],
  ["statSync", () => fs.statSync("a.txt\\0x")],
  ["lstatSync", () => fs.lstatSync("a.txt\\0x")],
  ["realpathSync", () => fs.realpathSync("a.txt\\0x")],
  ["accessSync", () => fs.accessSync("a.txt\\0x")],
  ["chmodSync", () => fs.chmodSync("a.txt\\0x", 0o644)],
  ["copyFileSync src", () => fs.copyFileSync("a.txt\\0x", "b.txt")],
  ["copyFileSync dest", () => fs.copyFileSync("a.txt", "b.txt\\0x")],
  ["openSync", () => fs.openSync("a.txt\\0x", "r")],
];
for (const [name, f] of tries) {
  try {
    f();
    console.log(name, "returned");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(name, err.code, err.message);
  }
}
console.log("exists", fs.existsSync("a.txt\\0zz"), fs.existsSync("d"), fs.existsSync("d/keep.txt"), fs.existsSync("w.txt"), fs.existsSync("b.txt"));
`;
    const { node, native } = await both(src);
    expect(node.code).toBe(0);
    expect(native.stdout).toBe(node.stdout);
    expect(native.code).toBe(0);
  });

  test("copyFileSync(a, a) leaves the file as it was (libuv checks for the same file before truncating)", async () => {
    const src = `import * as fs from "node:fs";
fs.writeFileSync("a.txt", "hello world\\n");
fs.copyFileSync("a.txt", "a.txt");
console.log(JSON.stringify(fs.readFileSync("a.txt", "utf8")));
fs.writeFileSync("b.txt", "other");
fs.copyFileSync("a.txt", "b.txt");
console.log(JSON.stringify(fs.readFileSync("b.txt", "utf8")));
`;
    const { node, native } = await both(src);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stdout).toContain("hello world");
  });

  test("a SIGSEGV the process sends itself kills it, as it kills Node", async () => {
    const src = `console.log("before");
process.kill(process.pid, "SIGSEGV");
console.log("after");
`;
    const { node, native } = await both(src);
    expect(node.signal).toBe("SIGSEGV");
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toBe(node.stdout);
  });
});
