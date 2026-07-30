/* fetch differential: embedded npm code AND user-code fetch (the
 * island-backed ambient — the user-fetch case) issue REAL http requests
 * against local Node servers (tests/fixtures/fetch/servers.mjs — this file
 * runs them in-process; the Linux lane runs the identical routes inside
 * its container) — never the network. Each fixture
 * program runs under Node AND compiled --dynamic with the server's base
 * URL in argv; stdout must match byte-for-byte and exit codes agree. The
 * suite covers the enumerated request-time needs of the AI-SDK graph:
 * text/json bodies, POST with implicit/explicit content-types, header
 * round trips, chunked streaming consumed through the reader protocol,
 * SSE through the real eventsource-parser (TextDecoderStream →
 * EventSourceParserStream — the exact AI-SDK shape), 404-resolves,
 * redirect following, gzip/deflate response decoding, and
 * connection-refused rejection (TypeError "fetch failed", Node's
 * message).
 *
 * SCRIPTC_SAN=1 rebuilds with ASan + the RC audit: transfer/socket handle
 * hygiene and the island's zero-live-allocations teardown audit run over
 * every case.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";
// The servers live in the fixture tree (a plain .mjs): the Linux lane runs
// the IDENTICAL routes standalone inside its container.
// eslint-disable-next-line import/no-relative-packages
import { startFetchServers } from "../fixtures/fetch/servers.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/fetch");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/* ── the local servers (tests/fixtures/fetch/servers.mjs: all routes, the
 * refused port, and the counting forward proxy for the NODE_USE_ENV_PROXY
 * opt-in case) ───────────────────────────────────────────────────────── */

let servers: Awaited<ReturnType<typeof startFetchServers>>;
let baseUrl = "";
let refusedUrl = "";
let proxyUrl = "";

beforeAll(async () => {
  servers = await startFetchServers();
  ({ baseUrl, refusedUrl, proxyUrl } = servers);

  // Every child below inherits POISONED proxy env pointing at the refused
  // port: Node's fetch ignores http_proxy/https_proxy without the
  // NODE_USE_ENV_PROXY=1 opt-in, and the embedded runtime must match
  // (libcurl's default is to honor them) — so every case in this file
  // doubles as the regression test for that parity, and any fixture that
  // DID consult the env would fail loudly instead of leaving the machine.
  process.env["http_proxy"] = refusedUrl;
  process.env["https_proxy"] = refusedUrl;
  process.env["HTTP_PROXY"] = refusedUrl;
  process.env["HTTPS_PROXY"] = refusedUrl;
});

afterAll(async () => {
  delete process.env["http_proxy"];
  delete process.env["https_proxy"];
  delete process.env["HTTP_PROXY"];
  delete process.env["HTTPS_PROXY"];
  await servers.close();
});

/* ── build + run (the npm.test.ts pattern) ───────────────────────────── */

interface RunResult {
  stdout: Buffer;
  exitCode: number;
}

async function runBinary(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: "buffer", env });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout)) throw err;
    return { stdout: e.stdout, exitCode: e.code };
  }
}

async function build(entry: string): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(join(fixturesRoot, "node_modules/**/*.{js,mjs,cjs,json,d.ts}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash.update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `fetch-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    dynamic: true,
    // Pinned: real-socket fixtures — the compiled lane stays the C
    // reference so a diff is fetch behavior, never a backend-lane change
    // (npm.test.ts rides the default and covers the fallback at scale).
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(
      "fetch fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

const cases = globSync(join(fixturesRoot, "cases/*/main.ts"))
  .sort()
  .map((entry) => ({ name: entry.split("/").at(-2)!, entry }));

describe(`proxy env opt-in (NODE_USE_ENV_PROXY${sanitize ? ", sanitized" : ""})`, () => {
  // The other half of the proxy parity: WITH NODE_USE_ENV_PROXY=1 both
  // lanes honor http_proxy and route through the local forward proxy —
  // outputs stay byte-identical AND the proxy sees exactly one relayed
  // request per lane.
  test("both lanes route through http_proxy when opted in", async () => {
    const entry = join(fixturesRoot, "cases/proxy-optin/main.ts");
    const binary = await build(entry);
    const argv = [baseUrl, refusedUrl];
    const env = {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      http_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
    };
    const before = servers.proxiedRequests();
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, ...argv], env),
      runBinary(binary, argv, env),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    expect(servers.proxiedRequests() - before).toBe(2);
  }, 120_000);
});

describe(`fetch differential (${cases.length} programs${sanitize ? ", sanitized" : ""})`, () => {
  test.for(cases.map((c) => [c.name, c] as const))("%s", async ([, c]) => {
    const binary = await build(c.entry);
    const argv = [baseUrl, refusedUrl];
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [c.entry, ...argv]),
      runBinary(binary, argv),
    ]);
    if (!nodeRes.stdout.equals(nativeRes.stdout)) {
      expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
      expect.unreachable("stdout differed at byte level but not after utf8 decode");
    }
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);
});
