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
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Server } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
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
  test("wasm/unhandled.ts: an unhandled 'fetch failed' ends the run with exit 1: the tier's report (S007), then the trap's own V8 text (S117 (d))", async () => {
    const r = await both(subst(readFileSync(join(fixtures, "wasm", "unhandled.ts"), "utf8")), false);
    expectSame(r, true);
    expect(r.native.stderr.toString("utf8")).toBe("Unhandled promise rejection: TypeError: fetch failed\nRuntimeError: unreachable\n");
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

/* ── host defects found in N1's review, pinned against Node ───────────────
 * Each row is a program the reviewer broke the host with, run on both
 * sides. The two TLS rows are SECURITY regression tests: a certificate
 * that does not name the host it was fetched from, and a redirect onto a
 * server whose chain is not trusted, must fail exactly as Node fails them
 * — never be accepted. The servers live in this process; the fixture CA
 * is trusted through NODE_EXTRA_CA_CERTS on both sides (Node's own
 * variable, honoured by the native host's default store). */
describe("N1 review rows: the host against Node", () => {
  const certs = join(repoRoot, "tests/fixtures/server/certs");
  const pem = (n: string): Buffer => readFileSync(join(certs, n));
  const env = { NODE_EXTRA_CA_CERTS: join(certs, "ca.pem") };
  const servers: { close: () => void }[] = [];
  let altPort = 0;
  let goodPort = 0;
  let selfPort = 0;
  let redirPort = 0;
  let evilPort = 0;
  let floodPort = 0;
  /* malformed responses, as llhttp / undici see them */
  const EVIL: Record<string, string> = {
    a: "HTTP/1.1 2\r\n\r\n",
    b: "HTTP/1.1\n\n",
    c: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\nhello\r\n0\r\n\r\n",
    d: "HTTP/1.1 200 OK\r\ncontent-length: -5\r\n\r\nhello",
    e: "HTTP/1.1 200 OK\r\ncontent-length: 3\r\ncontent-length: 5\r\n\r\nhello",
    h: "HTTP/1.1 200 OK\r\ncontent-length: 5\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    i: "HTTP/1.1 999999999999 X\r\ncontent-length: 0\r\n\r\n",
    j: "HTTP/1.1 200 OK\r\nX-A: " + "a".repeat(100000) + "\r\ncontent-length: 2\r\n\r\nok",
    l: "HTTP/1.1 200 OK\r\ncontent-length: 99999999999999999999\r\n\r\nhi",
    m: "HTTP/1.1 200\r\ncontent-length: 2\r\n\r\nok",
    n: "HTTP/1.1 200 OK\nx-a: 1\ncontent-length: 2\n\nok",
    o: "HTTP/1.1 200 OK\r\nfoo : bar\r\ncontent-length: 2\r\n\r\nok",
    r: "HTTP/1.1 abc OK\r\ncontent-length: 2\r\n\r\nok",
    t: "HTTP/1.1 200 OK\r\ncontent-length:  2 \r\n\r\nok",
    u: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n0\r\n\r\n",
    w: "HTTP/1.1 200 OK\r\nx: a\x00b\r\ncontent-length: 2\r\n\r\nok",
    x: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n",
    y: "XTTP/1.1 200 OK\r\n\r\n",
    ab: "HTTP/1.1 200 OK\r\ntransfer-encoding: gzip, chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
    ae: "HTTP/1.1 200  OK\r\ncontent-length: 2\r\n\r\nok",
    ag: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nFFFFFFFFFFFFFFFFFF\r\nhello\r\n0\r\n\r\n",
    ah: "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r",
  };
  beforeAll(async () => {
    const listen = (srv: Server | TlsServer): Promise<number> =>
      new Promise((resolve) => {
        srv.listen(0, "127.0.0.1", () => resolve((srv.address() as AddressInfo).port));
        servers.push(srv);
      });
    altPort = await listen(createHttpsServer({ key: pem("alt-key.pem"), cert: pem("alt.pem") }, (_q, r) => r.end("alt")));
    goodPort = await listen(createHttpsServer({ key: pem("localhost-key.pem"), cert: pem("localhost.pem") }, (q, r) => r.end(`good ${q.url}`)));
    selfPort = await listen(createHttpsServer({ key: pem("selfsigned-key.pem"), cert: pem("selfsigned.pem") }, (q, r) => r.end(`SECRET ${q.url}`)));
    redirPort = await listen(
      createHttpsServer({ key: pem("localhost-key.pem"), cert: pem("localhost.pem") }, (_q, r) => {
        r.writeHead(302, { location: `https://localhost:${selfPort}/secret` });
        r.end();
      }),
    );
    evilPort = await listen(
      createNetServer((s) => {
        let buf = "";
        s.on("data", (d) => {
          buf += d.toString("latin1");
          const m = /^[A-Z]+ \/(\S+)/.exec(buf);
          if (m && buf.includes("\r\n\r\n")) s.end(Buffer.from(EVIL[m[1]!] ?? "HTTP/1.1 404 NF\r\ncontent-length: 0\r\n\r\n", "latin1"));
        });
        s.on("error", () => {});
      }),
    );
    const chunk = Buffer.alloc(1 << 20, 97);
    floodPort = await listen(
      createTlsServer({ key: pem("localhost-key.pem"), cert: pem("localhost.pem") }, (s) => {
        let sent = 0;
        const pump = (): void => {
          while (sent < 256) {
            sent++;
            if (!s.write(chunk)) {
              s.once("drain", pump);
              return;
            }
          }
          s.end();
        };
        pump();
        s.on("error", () => {});
      }),
    );
  });
  afterAll(() => {
    for (const s of servers) s.close();
  });

  async function both(src: string, opts: { env?: Record<string, string>; ulimitFiles?: number; rss?: boolean } = {}): Promise<{ node: Out; native: Out; nativeMaxRssKb: number }> {
    const dir = mkdtempSync(join(tmpdir(), "wn-review-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(entry, src);
      const res = await compile(entry, { outPath: join(dir, "out", "program"), outDir: join(dir, "out"), dynamic: false, backend: "wasm-native" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      const wrap = (cmd: string, args: string[]): [string, string[]] => {
        const pre = opts.ulimitFiles !== undefined ? `ulimit -n ${opts.ulimitFiles}; ` : "";
        const time = opts.rss ? `/usr/bin/time -f "maxrss %M" -o ${join(dir, "rss.txt")} ` : "";
        return ["/bin/sh", ["-c", `${pre}exec ${time}"$0" "$@"`, cmd, ...args]];
      };
      const [nc, na] = wrap(process.execPath, ["--import", comptimeShim, "--import", islandShim, entry]);
      const node = await run(nc, na, repoRoot, undefined, opts.env);
      const [xc, xa] = wrap(res.binaryPath, []);
      const native = await run(xc, xa, repoRoot, undefined, opts.env);
      let nativeMaxRssKb = 0;
      if (opts.rss) nativeMaxRssKb = Number(/maxrss (\d+)/.exec(readFileSync(join(dir, "rss.txt"), "utf8"))?.[1] ?? "0");
      return { node, native, nativeMaxRssKb };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const fetchProbe = (urls: string[]): string => `async function go(u: string): Promise<void> {
  try {
    const r = await fetch(u);
    console.log(u, "OK", r.status, r.url, await r.text());
  } catch (e) {
    const x: unknown = e;
    const c = (x as { cause: { code: string; message: string } }).cause;
    console.log(u, "ERR", c.code, c.message);
  }
}
async function main(): Promise<void> {
${urls.map((u) => `  await go(${JSON.stringify(u)});`).join("\n")}
}
main();
`;

  test("SECURITY B1: fetch checks the host name against the certificate as Node does — an IP literal must be one of its IP-address names, a DNS name one of its DNS names; a certificate naming another host is ERR_TLS_CERT_ALTNAME_INVALID, never accepted", async () => {
    const { node, native } = await both(
      fetchProbe([`https://127.0.0.1:${altPort}/ip`, `https://localhost:${altPort}/dns`, `https://127.0.0.1:${goodPort}/ok-ip`, `https://localhost:${goodPort}/ok-dns`]),
      { env },
    );
    const out = node.stdout.toString("utf8");
    expect(out).toContain("ERR_TLS_CERT_ALTNAME_INVALID Hostname/IP does not match certificate's altnames: IP: 127.0.0.1 is not in the cert's list: ");
    expect(out).toContain("ERR_TLS_CERT_ALTNAME_INVALID Hostname/IP does not match certificate's altnames: Host: localhost. is not in the cert's altnames: DNS:alt.localhost");
    expect(native.stdout.toString("utf8")).toBe(out);
    expect(native.code).toBe(node.code);
  }, 120_000);

  test("SECURITY B2: a redirect onto a server whose certificate is not trusted fails as Node fails it — no verification state survives from the hop before", async () => {
    const { node, native } = await both(fetchProbe([`https://localhost:${redirPort}/go`, `https://localhost:${selfPort}/direct`]), { env });
    const out = node.stdout.toString("utf8");
    expect(out).not.toContain("SECRET");
    expect(native.stdout.toString("utf8")).toBe(out);
    expect(native.code).toBe(node.code);
  }, 120_000);

  test("B3: malformed responses fail as llhttp and undici fail them (status line, header tokens and values, Content-Length, chunk framing, the header-size limit) — a short status line is never read past", async () => {
    const src = `async function go(k: string): Promise<void> {
  try {
    const r = await fetch("http://127.0.0.1:${evilPort}/" + k);
    const names: string[] = [];
    r.headers.forEach((v, n) => {
      if (n !== "date") names.push(n + "=" + v);
    });
    let t = "";
    try {
      t = await r.text();
    } catch (e) {
      const x: unknown = e;
      const c = x as { message: string; cause: { name: string; message: string } };
      console.log(k, "BODY", c.message, c.cause.name, c.cause.message);
      return;
    }
    console.log(k, "OK", r.status, JSON.stringify(r.statusText), names.join(" "), t.length);
  } catch (e) {
    const x: unknown = e;
    const c = x as { message: string; cause: { name: string; message: string } };
    console.log(k, "ERR", c.message, c.cause.name, c.cause.message);
  }
}
async function main(): Promise<void> {
  for (const k of ${JSON.stringify(Object.keys(EVIL))}) await go(k);
}
main();
`;
    const { node, native } = await both(src);
    expect(node.stdout.toString("utf8")).toContain("a ERR fetch failed HTTPParserError Response does not match the HTTP/1.1 protocol (Invalid status code)");
    expect(native.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
    expect(native.code).toBe(0);
  }, 120_000);

  test("B4: out of descriptors, the listener does not spin — libuv's EMFILE reserve, taken at the first stream, is spent to accept and close what waits; the program finishes", async () => {
    const src = `import * as net from "node:net";
const M = 1500;
const srv = net.createServer((s) => {
  s.on("data", (d: Buffer) => {
    s.end(d);
  });
});
srv.on("error", () => {});
srv.listen(0, "127.0.0.1", () => {
  const port = srv.address().port;
  let done = 0;
  let ok = 0;
  let errs = 0;
  let code = "";
  for (let i = 0; i < M; i++) {
    const c = net.connect(port, "127.0.0.1");
    let got = "";
    c.on("connect", () => {
      c.write("m" + i);
    });
    c.on("data", (d: Buffer) => {
      got += d.toString();
    });
    c.on("error", (e) => {
      errs++;
      if (errs === 1) code = String((e as NodeJS.ErrnoException).code);
    });
    c.on("close", () => {
      if (got === "m" + i) ok++;
      if (++done === M) {
        console.log("done", errs > 0, code);
        srv.close();
      }
    });
  }
});
`;
    const t0 = Date.now();
    const { node, native } = await both(src, { ulimitFiles: 300 });
    expect(node.stdout.toString("utf8")).toBe("done true EMFILE\n");
    expect(native.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
    expect(native.code).toBe(node.code);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  test("spawnSync with a timeout past an int's milliseconds (1e11) waits as long as the child runs and reports its status, as Node does", async () => {
    const src = `import { spawnSync } from "node:child_process";
const r = spawnSync("/bin/sh", ["-c", "exit 3"], { timeout: 1e11 });
console.log(r.status, r.signal, r.error === undefined);
`;
    const { node, native } = await both(src);
    expect(node.stdout.toString("utf8")).toBe("3 null true\n");
    expect(native.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
  }, 120_000);

  test("TLS back-pressure: a secured socket the program has not read from stops reading the peer (Node's readStop reaches the socket) — 256 MiB from a flooding server never pile up in the runner", async () => {
    const src = `import * as tls from "node:tls";
import * as fs from "node:fs";
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");
const s = tls.connect(${floodPort}, "localhost", { ca }, () => {
  console.log("secure", s.authorized);
  setTimeout(() => {
    let n = 0;
    s.on("data", (d: Buffer) => {
      n += d.length;
    });
    s.on("end", () => {
      console.log("got", n);
    });
  }, 1500);
});
`;
    const { node, native, nativeMaxRssKb } = await both(src, { rss: true });
    expect(node.stdout.toString("utf8")).toBe(`secure true\ngot ${256 << 20}\n`);
    expect(native.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
    expect(nativeMaxRssKb).toBeGreaterThan(0);
    // bounded by the collector, not by what the peer sent: buffering the
    // flood would take more than its 256 MiB
    expect(nativeMaxRssKb).toBeLessThan(160 * 1024);
  }, 120_000);
});
