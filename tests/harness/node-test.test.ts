/* The node:test differential — fixtures under tests/fixtures/node-test
 * run under Node AND compiled, stdout and exit codes compared with ONE
 * documented normalization applied to BOTH lanes. Node's spec reporter
 * embeds real durations in every line, so raw byte-compare is impossible
 * for ANY node:test program (which is why these are fixtures here, not
 * corpus entries); everything else — result lines, symbols, indentation,
 * # SKIP/# TODO directives, ℹ diagnostics, the summary block, the
 * failing-tests section's "test at file:line:col" and error MESSAGE
 * lines — must match byte-exactly.
 *
 * NORMALIZATIONS (both lanes):
 *   - "(1.234ms)" duration parentheticals → "(Xms)"
 *   - the "ℹ duration_ms N" summary line → "ℹ duration_ms X"
 *   - stack frames ("    at ...") and the inspect property block a frame
 *     opens ("... {" through its closing "}") are dropped — Node prints
 *     its runner-internal frames and an error-property dump the compiled
 *     runtime deliberately omits (SEMANTICS.md).
 *
 * Fixtures never console.log inside test bodies or hooks: Node's
 * reporter stream lags console output RACILY (its ordering varies run to
 * run under Node alone), while the compiled runtime reports
 * synchronously — mixed programs cannot be byte-compared against any
 * oracle. The `// @exit:` first line documents the expected exit code
 * and is asserted against BOTH lanes. SCRIPTC_SAN=1 rebuilds with ASan +
 * the RC audit over every case. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";
import { normalizeNodeTestOutput } from "./node-test-normalize.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/node-test");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface ProgramRun {
  stdout: string;
  exitCode: number;
}

function runLane(cmd: string, args: string[]): Promise<ProgramRun> {
  return new Promise((resolve, reject) => {
    // cwd pinned to the repo root: both reporters render "test at" paths
    // relative to the working directory, so the lanes must share one.
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: repoRoot });
    const out: Buffer[] = [];
    let errText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`node:test program timed out\nstderr so far:\n${errText}`));
    }, 60_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (errText += c.toString("utf8")));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`node:test program died to ${signal}\nstderr:\n${errText}`));
        return;
      }
      resolve({ stdout: Buffer.concat(out).toString("utf8"), exitCode: code ?? 0 });
    });
  });
}

// The documented normalization — durations, frames, the property block —
// lives in node-test-normalize.ts: the Linux lane applies the identical
// scrub to its in-container lanes.
const normalize = normalizeNodeTestOutput;

/** Expected exit code: 0 unless the fixture's first line says otherwise. */
function expectedExitCode(file: string): number {
  const firstLine = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
  const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(firstLine);
  return m ? Number(m[1]) : 0;
}

async function build(entry: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(entry).update(readFileSync(entry));
  const key = hash.update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `node-test-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    // Pinned: the spec-reporter normalizations here were written against
    // the C lane; lane identity stays fixed so a diff means the reporter
    // (or Node) changed, never that the default backend moved.
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(
      "node:test fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

const cases = globSync(join(fixturesRoot, "cases/*.ts"))
  .sort()
  .map((entry) => ({ name: entry.split("/").at(-1)!.replace(/\.ts$/, ""), entry }));

describe(`node:test differential (${cases.length} programs${sanitize ? ", sanitized" : ""})`, () => {
  test.for(cases.map((c) => [c.name, c] as const))("%s", async ([, c]) => {
    const binary = await build(c.entry);
    const [nodeRes, nativeRes] = await Promise.all([
      runLane("node", [c.entry]),
      runLane(binary, []),
    ]);
    expect(normalize(nativeRes.stdout)).toBe(normalize(nodeRes.stdout));
    const wanted = expectedExitCode(c.entry);
    expect(nodeRes.exitCode).toBe(wanted); // keeps `// @exit:` honest
    expect(nativeRes.exitCode).toBe(wanted);
  }, 120_000);
});
