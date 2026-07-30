/* Live process-I/O parity. The differential corpus captures stdout/stderr
 * only after each process exits, so it cannot detect an implementation that
 * retains console.log/process.stdout.write bytes in a userspace buffer until
 * a later error, a size threshold, or normal exit.
 *
 * These probes keep the child alive after writing and observe its stdout
 * pipe directly. The abrupt-death case additionally proves byte parity when
 * no exit hook can rescue retained output. SCRIPTC_SAN=1 builds the native
 * probes with the same ASan + refcount-audit instrumentation as the corpus. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/console-io");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface ClosedChild {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function build(name: string): Promise<{ binary: string; sourceFile: string }> {
  const sourceFile = join(fixtureDir, `${name}.ts`);
  const key = createHash("sha256")
    .update(sourceFile)
    .update(readFileSync(sourceFile))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `console-io-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(sourceFile, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(
      "console-I/O probe failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return { binary: result.binaryPath, sourceFile };
}

/** Resolve only after expected stdout was visible while the child was still
 * alive. SIGKILL makes a false pass impossible: it runs no stdio/atexit
 * flushing if the expected bytes were still retained by the child. */
function observeLiveStdout(cmd: string, args: string[], expected: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let observed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      const all = Buffer.concat(stdout);
      if (!observed && all.includes(expected)) {
        observed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      if (!observed) {
        reject(
          new Error(
            `stdout was not visible before child exit` +
              `${timedOut ? " (timed out)" : ""}; code=${code}, signal=${signal}, ` +
              `stdout=${JSON.stringify(out.toString("utf8"))}, ` +
              `stderr=${JSON.stringify(Buffer.concat(stderr).toString("utf8"))}`,
          ),
        );
        return;
      }
      resolve(out);
    });
  });
}

function runToClose(cmd: string, args: string[]): Promise<ClosedChild> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("abrupt console-I/O probe timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code,
        signal,
      });
    });
  });
}

describe(`console/process output visibility${sanitize ? " (sanitized)" : ""}`, () => {
  test("console.log and string/byte stdout writes are visible before exit", async () => {
    const expected = Buffer.from("log-ready\nstring-ready|bytes-ready");
    const probe = await build("live-stdout");

    const [nodeOut, nativeOut] = await Promise.all([
      observeLiveStdout("node", [probe.sourceFile], expected),
      observeLiveStdout(probe.binary, [], expected),
    ]);
    expect(nodeOut.subarray(0, expected.length)).toEqual(expected);
    expect(nativeOut.subarray(0, expected.length)).toEqual(expected);
  });

  test("stdout already submitted before an unflushable SIGKILL matches Node", async () => {
    const expected = Buffer.from("before-sigkill\n");
    const probe = await build("sigkill-stdout");

    const [nodeRes, nativeRes] = await Promise.all([
      runToClose("node", [probe.sourceFile]),
      runToClose(probe.binary, []),
    ]);
    expect(nodeRes.stdout).toEqual(expected);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(nativeRes.stderr).toEqual(nodeRes.stderr);
    expect(nativeRes.code).toBe(nodeRes.code);
    expect(nativeRes.signal).toBe(nodeRes.signal);
  });
});
