/* Piped-stdin differential tests: the corpus harness closes both
 * children's stdin immediately (programs must see the same empty closed
 * stream), so the stdin DATA paths — chunk delivery to once-'data'
 * listeners, for-await over process.stdin, the race-then-destroy timeout
 * shape — run here, where the harness controls what flows into the pipe
 * and when. Node stays the oracle: same program, same stdin script, same
 * stdout bytes and exit code. SCRIPTC_SAN=1 sanitizes the native side like
 * the corpus. Each case runs on the c lane and on the wasm-native lane
 * (native-runner phase N1: the wasm module's stdin over the runner's host),
 * the timed writes reaching each as a real pipe. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";
import { eventLoopCases, type StdinScript } from "./event-loop-cases.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/event-loop");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  exitCode: number;
}

function runWithStdin(cmd: string, args: string[], script: StdinScript): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // the timeout ends a run that never exits (a hang is a failure, not a
    // stuck suite); every case finishes in a few seconds
    const child = execFile(cmd, args, { encoding: "utf8", timeout: 30_000 }, (err, stdout) => {
      const e = err as { code?: unknown } | null;
      if (e && typeof e.code !== "number") {
        reject(err);
        return;
      }
      resolve({ stdout, exitCode: e ? (e.code as number) : 0 });
    });
    void (async () => {
      for (const w of script.writes) {
        await new Promise((r) => setTimeout(r, w.delayMs));
        child.stdin?.write(w.data);
      }
      if (script.end) child.stdin?.end();
      // Held-open pipes close when the child exits (execFile cleans up).
    })();
  });
}

/** The lanes each case runs on: the c lane (the reference these fixtures
 * were written against) and the wasm-native lane. */
const BACKENDS = ["c", "wasm-native"] as const;
type Backend = (typeof BACKENDS)[number];

/** Cases the wasm-native lane does not yet match, pinned as failing (a
 * fix makes the case pass and this test fail until the entry goes): the
 * MODULE's stdin, which the wasm lane's harness cannot show (its stdin is
 * an emulated pipe whose bytes are all there at once). */
const WASM_NATIVE_KNOWN: Record<string, string> = {
  "read-all: chunked writes with delays, then EOF":
    "hostev.ts: a for-await over process.stdin begun after a once('data') listener left the stream flowing drops the chunks that arrive later (Node's async iterator turns flowing off)",
  "race-timeout: silent open pipe — timeout wins, destroy releases the loop":
    "hostev.ts: process.stdin.destroy() neither stops the read (stdinCall READ_STOP) nor releases the loop, so the program never exits",
};

async function compileFixture(name: string, backend: Backend): Promise<string> {
  const file = join(fixtureDir, name);
  const key = createHash("sha256")
    .update(file)
    .update(readFileSync(file))
    .update(sanitize ? "san" : "plain")
    .update(backend === "c" ? "" : backend)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    // Pinned: piped-stdin timing fixtures were written against the C
    // lane; lane identity stays fixed so a diff means the stdin/event-loop
    // story changed, never that the default backend moved.
    backend,
  });
  if (!result.ok) {
    throw new Error(
      "event-loop fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

async function differential(fixture: string, script: StdinScript, backend: Backend): Promise<void> {
  const binary = await compileFixture(fixture, backend);
  const [nodeRes, nativeRes] = await Promise.all([
    runWithStdin("node", [join(fixtureDir, fixture)], script),
    runWithStdin(binary, [], script),
  ]);
  expect(nativeRes.stdout).toBe(nodeRes.stdout);
  expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
}

describe("event loop: piped stdin (differential)", () => {
  // The case table lives in event-loop-cases.ts: the Linux lane runs the
  // identical fixtures with the identical stdin scripts in-container.
  const runs: [string, (typeof eventLoopCases)[number], Backend][] = BACKENDS.flatMap((b) => eventLoopCases.map((c): [string, (typeof eventLoopCases)[number], Backend] => [`${c.title} [${b}]`, c, b]));
  test.for(runs)("%s", { timeout: 120_000 }, async ([, c, b]) => {
    if (b === "wasm-native" && c.title in WASM_NATIVE_KNOWN) {
      await expect(differential(c.fixture, c.script, b)).rejects.toThrow();
      return;
    }
    await differential(c.fixture, c.script, b);
  });
});
