/* The wasm-native lane's HOST against Node (native-runner phase N1): the
 * wasm lane's host rows, run natively.
 *
 * tests/harness/wasm-differential.test.ts pins the event sources' behavior
 * on the wasm lane with rows — whole programs over child_process (INC-28
 * U1-U3), node:net / http / tls / https / dgram (INC-29 U1, U2, U4 and its
 * review), signals, fs.watch and stdin / readline (units G1-G3). There the
 * host is Node itself (the harness's in-process host over Node's own
 * spawn, net, tls and fs.watch); here it is the native runner's C host
 * (packages/runtime/src/wasmnative). This file reads those rows' programs
 * out of that file (its TypeScript syntax tree: every `run*(src, ...)`
 * call and the G blocks' row tables — so a row added there is run here
 * too), builds each on the wasm-native lane, and holds it to the Node
 * oracle run the same way: the same directory, the same stdin (a row's
 * input, else a pipe closed at once), Node first, then the executable;
 * stdout always, stderr when the program exits 0, and the exit code.
 *
 * KNOWN pins the rows that cannot equal Node, EXACTLY (both directions,
 * the claim floor's discipline): a row that starts equalling Node fails
 * until it leaves the list. Each cites why — a divergence the MODULE owns
 * (registered for the wasm lane and shared here, since the module is the
 * same), or a row whose output is not a function of the program (a pid).
 * TIMED lists rows whose Node answer depends on a child's speed against
 * the program's own start (S086 (l), S117): each gets three attempts.
 *
 * Runs concurrently within the file, at most SCRIPTC_TEST_WORKERS (default
 * 4) rows at once. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@tsinter/compiler";
import { startFetchServers } from "../fixtures/fetch/servers.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const source = join(import.meta.dirname, "wasm-differential.test.ts");

/** The blocks whose rows exercise a host event source or process host. */
const BLOCKS = /^(INC-28 U[123] |INC-29 U[124] |INC-29 U4 review|unit G[123] )/;

interface Row {
  id: string;
  block: string;
  src: string;
  /** the entry's file name (its extension picks the module kind) */
  file: string;
  files: Record<string, string>;
  input?: string;
  dynamic: boolean;
}

function literal(n: ts5.Node | undefined): string | null {
  return n !== undefined && (ts5.isStringLiteral(n) || ts5.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
}

/** Every row program of BLOCKS, from the wasm lane's file. */
function extractRows(): Row[] {
  const sf = ts5.createSourceFile(source, readFileSync(source, "utf8"), ts5.ScriptTarget.Latest, true);
  const rows: Row[] = [];
  const visit = (n: ts5.Node, block: string | null, title: string | null): void => {
    if (ts5.isCallExpression(n) && ts5.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const a0 = literal(n.arguments[0]);
      if (name === "describe" && a0 !== null) block = a0;
      if (name === "test" && a0 !== null) title = a0;
      if (block !== null && BLOCKS.test(block) && /^run[A-Z0-9][A-Za-z0-9]*$/.test(name)) {
        const a1 = literal(n.arguments[1]);
        const id = (title ?? "").split(" ")[0]!;
        if (a0 !== null && a0.includes("\n")) {
          // run*Source(src, ext?) / runR(src, files, ext) / runDyn(src)
          const extArg = name === "runR" ? literal(n.arguments[2]) : a1;
          const ext = extArg === "cjs" || extArg === "ts" ? extArg : "ts";
          const files: Record<string, string> = {};
          const filesArg = name === "runR" ? n.arguments[1] : undefined;
          if (filesArg !== undefined && ts5.isObjectLiteralExpression(filesArg)) {
            for (const p of filesArg.properties) {
              if (ts5.isPropertyAssignment(p) && literal(p.initializer) !== null) {
                const key = ts5.isStringLiteral(p.name) || ts5.isIdentifier(p.name) ? p.name.text : null;
                if (key !== null) files[key] = literal(p.initializer)!;
              }
            }
          }
          rows.push({ id, block, src: a0, file: `main.${ext}`, files, dynamic: false });
        } else if (a0 !== null && a1 !== null && a1.includes("\n")) {
          // runN2(file, src) / runU4(file, src)
          rows.push({ id, block, src: a1, file: a0, files: {}, dynamic: false });
        }
      }
    }
    if (block !== null && /^unit G[123] /.test(block) && ts5.isArrayLiteralExpression(n) && n.elements.length >= 5) {
      const [id, , src, stdout, exit, input] = n.elements;
      const s = literal(src);
      if (literal(id) !== null && s !== null && s.includes("\n") && literal(stdout) !== null && exit !== undefined && ts5.isNumericLiteral(exit)) {
        const inp = literal(input);
        rows.push({ id: literal(id)!, block, src: s, file: "main.ts", files: {}, dynamic: false, ...(inp !== null ? { input: inp } : {}) });
      }
    }
    ts5.forEachChild(n, (c) => visit(c, block, title));
  };
  visit(sf, null, null);
  return rows;
}

/* ── the rows that cannot equal Node, pinned exactly ─────────────────── */
const KNOWN: Record<string, string> = {
  // The module's own registered divergences (the wasm lane's row asserts
  // the tier's answer; the module is the same here).
  "U1-REG-01": "S085 (a): uncaptured outputs read \"\"",
  "U1-REG-02": "S085 (b): promisified execFile's rejection has no numeric code",
  "U1-REG-03": "S085 (c): spawnSync's error is fresh per read",
  "U1-REG-04": "S085 (d): the exec family has no maxBuffer",
  "U1-REG-05": "S085 (e): promisified execFile settles synchronously",
  "U1-REG-06": "S085 (f): the default echo is raw",
  "U1-DEC-02": "S085 (f): the same program as U1-REG-06 (its E1 line is Node's, its E2 line the raw byte)",
  "U1-REG-07": "S085 (g): an explicit cwd \"\" is the current directory",
  "U1-REG-11": "S085 (e): a validation failure rejects the promise",
  "U1-REG-09": "S086 (d): the lowering carries a literal or tuple \"ignore\" stdin as a pipe (a socket at end of file)",
  "U1-REG-13": "S086 (d): the same through execFileSync",
  "U2-REG-05": "S085 (b): a failed spawn's error carries name, message and code only",
  "U3-LATE-01": "S086 (k): a late 'data' listener's buffered chunks arrive at the next poll phase",
  "N1-REG-01": "S087 (a): a net error carries name, message and code only",
  "N1-REG-02": "S087 (f): the checked-dynamic handle's unmodelled surface is fenced",
  "N1-REG-03": "S037: a Buffer crossing an untyped call slices as a copy",
  "N2-REG-01": "S088 (f): the checked-dynamic http handle's unmodelled members are fenced",
  "N2-REG-03": "S088 (g): a null the static type does not admit is fenced",
  "U4-REG-01": "S090 (h): the rejecting client's Finished has left, so the server's handshake completes",
  "U4-R-13": "S090 (c): a certificate OpenSSL would re-encode is a named Error",
  // Not a function of the program: each prints its child's pid (the wasm
  // lane's host kills the leftover child, S086 (i); this host and Node
  // leave it running).
  "U2-REG-04": "prints a pid",
  "U2-HYG-03": "prints a pid",
};
/* Rows whose order is the runner's own speed against a child's (SEMANTICS.md
 * S117 (f)): measured, not pinned — compared, reported, never failed, and
 * exempt from KNOWN's exactness. */
const UNPINNED: Record<string, string> = {
  // the first poll phase comes well under a millisecond after the spawn,
  // before `sh` has written; Node's comes after its module loader
  // settles, and sees the output
  "U3-ORD-01": "S117 (f): the first poll phase can precede the child's first output",
};
const TIMED: Record<string, string> = {
  "U3-TWO-02": "S086 (l): close-together children's exit and end follow the reads",
  // Node itself prints either order: whether the last read reaches end of
  // file before the child's exit is processed is the kernel's timing
  "U3-BIG-01": "S086 (l): a child's exit and its stream's end, when the exit lands mid-drain",
};

interface Out {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function run(cmd: string, args: string[], cwd: string, input: string | undefined, env?: Record<string, string>): Promise<Out> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], ...(env !== undefined ? { env: { ...process.env, ...env } } : {}) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("error", reject);
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code, signal });
    });
    p.stdin.on("error", () => {});
    // no input: the pipe is closed at once (destroyed, not merely ended,
    // so a program's fd 0 is a socket whose peer is gone before anything
    // can write to it — the same for both sides, whatever their speed)
    if (input === undefined) p.stdin.destroy();
    else p.stdin.end(Buffer.from(input, "latin1"));
  });
}

const comptimeShim = pathToFileURL(join(import.meta.dirname, "comptime-shim.mjs")).href;
const islandShim = pathToFileURL(join(import.meta.dirname, "island-shim.mjs")).href;

function same(node: Out, native: Out): boolean {
  return node.stdout.equals(native.stdout) && node.code === native.code && node.signal === native.signal && (node.code !== 0 || node.stderr.equals(native.stderr));
}

/* ── at most N rows in flight ─────────────────────────────────────────── */
const width = Math.max(1, Number(process.env["SCRIPTC_TEST_WORKERS"] ?? "4") || 4);
let inFlight = 0;
const waiters: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  while (inFlight >= width) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
  try {
    return await f();
  } finally {
    inFlight--;
    waiters.shift()?.();
  }
}

const rows = extractRows();
const equalNode = new Set<string>();
const seen = new Set<string>();

describe(`the wasm lane's host rows on the wasm-native lane (${rows.length} rows)`, () => {
  test("the rows were found (the wasm lane's file still has its blocks)", () => {
    expect(rows.length).toBeGreaterThan(200);
    for (const b of ["INC-28 U1 ", "INC-28 U2 ", "INC-28 U3 ", "INC-29 U1 ", "INC-29 U2 ", "INC-29 U4 ", "INC-29 U4 review", "unit G1 ", "unit G2 ", "unit G3 "]) {
      expect(rows.some((r) => r.block.startsWith(b)), b).toBe(true);
    }
  });

  test.concurrent.for(rows.map((r, i) => [`${r.id} (#${i})`, r] as const))("%s", async ([, row]) => {
    await slot(async () => {
      const dir = mkdtempSync(join(tmpdir(), "wn-row-"));
      try {
        for (const [n, body] of Object.entries(row.files)) writeFileSync(join(dir, n), body);
        const entry = join(dir, row.file);
        writeFileSync(entry, row.src.replaceAll("@CERTS@", dir + "/"));
        const res = await compile(entry, { outPath: join(dir, "out", "program"), outDir: join(dir, "out"), dynamic: row.dynamic, backend: "wasm-native" });
        if (!res.ok) {
          // the wasm lane builds every one of these rows; so must this lane
          expect.unreachable(`${row.id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
          return;
        }
        const transform = /\benum\s+[A-Za-z_$]/.test(row.src) ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"] : [];
        const attempts = row.id in TIMED ? 3 : 1;
        let node: Out | null = null;
        let native: Out | null = null;
        for (let k = 0; k < attempts; k++) {
          node = await run(process.execPath, [...transform, "--import", comptimeShim, "--import", islandShim, entry], repoRoot, row.input);
          native = await run(res.binaryPath, [], repoRoot, row.input);
          if (same(node, native)) break;
        }
        seen.add(row.id);
        if (same(node!, native!)) {
          equalNode.add(row.id);
          return;
        }
        if (row.id in KNOWN) return;
        if (row.id in UNPINNED) {
          console.info(`${row.id} differs from Node (unpinned: ${UNPINNED[row.id]})`);
          return;
        }
        expect(native!.stdout.toString("latin1")).toBe(node!.stdout.toString("latin1"));
        if (node!.code === 0) expect(native!.stderr.toString("latin1")).toBe(node!.stderr.toString("latin1"));
        expect({ code: native!.code, signal: native!.signal }).toEqual({ code: node!.code, signal: node!.signal });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("KNOWN is exact: no listed row equals Node now, and every entry names a row", () => {
    const stale = Object.keys(KNOWN).filter((id) => equalNode.has(id) || !seen.has(id));
    const missing = [...Object.keys(KNOWN), ...Object.keys(TIMED), ...Object.keys(UNPINNED)].filter((id) => !rows.some((r) => r.id === id));
    expect({ stale, missing }).toEqual({ stale: [], missing: [] });
  });
});

/* ── fetch: the wasm lane's "#227 fetch rows" fixtures ────────────────────
 * The same programs that block runs (tests/fixtures/fetch: three cases of
 * fetch.test.ts, static and @dynamic builds, and the focused programs
 * under wasm/), against the fixture servers in this process, with their
 * base and refused URLs substituted in. proxy-optin runs twice, as
 * fetch.test.ts runs it: with the proxy variables poisoned (a refused
 * port) and no opt-in — the request goes direct — and with
 * NODE_USE_ENV_PROXY=1 and http_proxy at the fixture proxy, where both
 * sides' requests must reach the proxy. */
describe("the fetch fixtures on the wasm-native lane", () => {
  let servers: Awaited<ReturnType<typeof startFetchServers>>;
  beforeAll(async () => {
    servers = await startFetchServers();
  });
  afterAll(async () => {
    await servers.close();
  });
  const fixtures = join(repoRoot, "tests/fixtures/fetch");
  const subst = (src: string): string =>
    src
      .replaceAll("process.argv[2]", JSON.stringify(servers.baseUrl))
      .replaceAll("process.argv[3]", JSON.stringify(servers.refusedUrl))
      .replaceAll("__BASE__", servers.baseUrl)
      .replaceAll("__REFUSED__", servers.refusedUrl);
  async function both(src: string, dynamic: boolean, env?: Record<string, string>): Promise<{ node: Out; native: Out }> {
    const dir = mkdtempSync(join(tmpdir(), "wn-fetch-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(entry, src);
      const res = await compile(entry, { outPath: join(dir, "out", "program"), outDir: join(dir, "out"), dynamic, backend: "wasm-native" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      const node = await run(process.execPath, ["--import", comptimeShim, "--import", islandShim, entry], repoRoot, undefined, env);
      const native = await run(res.binaryPath, [], repoRoot, undefined, env);
      return { node, native };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const expectSame = ({ node, native }: { node: Out; native: Out }, quiet = false): void => {
    if (!quiet) expect(node.stdout.toString("utf8").split("\n").length).toBeGreaterThan(1);
    expect(native.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
    if (node.code === 0) expect(native.stderr.toString("utf8")).toBe(node.stderr.toString("utf8"));
    expect(native.code).toBe(node.code);
  };
  for (const fixture of ["user-fetch", "response-surface"]) {
    for (const dynamic of [false, true]) {
      test(`${fixture} (${dynamic ? "@dynamic" : "static"}): full stdout, stderr and exit code equal Node's`, async () => {
        const raw = readFileSync(join(fixtures, "cases", fixture, "main.ts"), "utf8");
        expectSame(await both(subst(dynamic ? raw : raw.replace(/^\/\/ @dynamic\n/, "")), dynamic));
      }, 120_000);
    }
  }
  test("proxy-optin: poisoned proxy variables without the opt-in go direct; with NODE_USE_ENV_PROXY=1 both sides reach the proxy", async () => {
    const src = subst(readFileSync(join(fixtures, "cases", "proxy-optin", "main.ts"), "utf8"));
    expectSame(await both(src, false, { http_proxy: servers.refusedUrl, https_proxy: servers.refusedUrl, HTTP_PROXY: servers.refusedUrl }));
    const before = servers.proxiedRequests();
    expectSame(await both(src, false, { NODE_USE_ENV_PROXY: "1", http_proxy: servers.proxyUrl, HTTP_PROXY: servers.proxyUrl }));
    expect(servers.proxiedRequests() - before).toBe(2);
  }, 120_000);
  for (const name of ["abort-signal", "body-readers", "failure-cause", "given-empty", "headers", "requests", "string-tags", "url-input", "with-signal"]) {
    test(`wasm/${name}.ts: full stdout, stderr and exit code equal Node's`, async () => {
      expectSame(await both(subst(readFileSync(join(fixtures, "wasm", `${name}.ts`), "utf8")), false));
    }, 120_000);
  }
  test("wasm/unhandled.ts: an unhandled 'fetch failed' ends the run with exit 1 and the tier's report (S007), as on the wasm lane", async () => {
    const r = await both(subst(readFileSync(join(fixtures, "wasm", "unhandled.ts"), "utf8")), false);
    expectSame(r, true);
    expect(r.native.stderr.toString("utf8")).toBe("Unhandled promise rejection: TypeError: fetch failed\n");
  }, 120_000);
  test("wasm/fences.ts: the module's fences (S098 (d)), as on the wasm lane", async () => {
    const { node, native } = await both(subst(readFileSync(join(fixtures, "wasm", "fences.ts"), "utf8")), false);
    expect(node.stdout.toString("utf8")).toBe("body ok false\njson ok {}\ntypeof: object\n");
    expect(native.stdout.toString("utf8")).toBe(
      "body: Error Response.body (a ReadableStream) is not supported yet\njson: Error JSON.stringify of a fetch value is not supported yet\ntypeof: object\n",
    );
    expect(native.code).toBe(0);
  }, 120_000);
});
