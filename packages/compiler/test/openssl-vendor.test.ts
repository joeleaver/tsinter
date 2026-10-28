/* The vendored OpenSSL (Node v24.18.1's deps/openssl, OpenSSL 3.5.7; design
 * unit O1): the archive backend/openssl-build.ts builds for the host, its
 * symbol prefix, and a smoke test proving the build is OpenSSL as Node runs
 * it — a C program (fixtures/openssl/smoke.c) linked statically against the
 * archive does known-answer crypto, Node's material-error texts, a chain
 * verdict with X509_check_host, and a TLS client handshake over memory BIOs
 * against a Node https server, each compared with what Node itself reports.
 *
 * The prefix: every global the archive defines is scr_ossl_* (the recipe
 * fails the build otherwise; OS-03 re-checks the published archive), no
 * OpenSSL name is referenced unprefixed, and a linked executable carries
 * no plain OpenSSL name — an embedder's own OpenSSL or BoringSSL never
 * collides with it. The first run builds the archive (about 1100 TUs; the
 * recipe's own parallelism, cached afterwards under vendor/.cache). */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:https";
import { connect, createSecureContext } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveCc, runtimeSrcDir } from "../src/backend/cc.js";
import {
  definedGlobals,
  opensslIncludeArgs,
  opensslPrefixHeader,
  opensslPrefixNames,
  opensslTargetFor,
} from "../src/backend/openssl-build.js";
import { OPENSSL_VERSION } from "../src/backend/openssl-sources.js";
import { wasmNativeOpensslArchive } from "../src/backend/wasm-native.js";

const execFileAsync = promisify(execFile);
const certs = join(runtimeSrcDir(), "..", "..", "..", "tests", "fixtures", "server", "certs");
const smokeSrc = join(import.meta.dirname, "fixtures", "openssl", "smoke.c");
const driver = resolveCc({ ...process.env, SCRIPTC_TARGET: "" });
const target = opensslTargetFor(driver);
const darwin = target.startsWith("darwin");

let scratch: string;
let archive: string;
let smoke: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-openssl-"));
  // the wasm-native lane's archive (its driver: the host's)
  archive = await wasmNativeOpensslArchive();
  smoke = join(scratch, "smoke");
  await execFileAsync(driver.argv[0] ?? "clang", [
    ...driver.argv.slice(1),
    "-std=gnu11",
    "-O2",
    ...driver.targetArgs,
    ...opensslIncludeArgs(target),
    smokeSrc,
    archive,
    ...(darwin ? ["-Wl,-dead_strip"] : ["-Wl,--gc-sections"]),
    "-o",
    smoke,
    "-lpthread",
    ...driver.linkArgs,
  ]);
}, 900_000);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<string> {
  return (await execFileAsync(smoke, args)).stdout;
}

describe("the vendored OpenSSL's symbol prefix", () => {
  test("OS-01 the vendored tree is the OpenSSL this Node runs", async () => {
    expect(OPENSSL_VERSION).toBe(process.versions.openssl);
    expect(await run("version")).toBe(`${process.versions.openssl} ${process.versions.openssl}\n`);
  });

  test("OS-02 scr_ossl_prefix.h is one sorted, unique #define X scr_ossl_X per name", async () => {
    const text = await readFile(opensslPrefixHeader(), "utf8");
    const lines = [...text.matchAll(/^(?:\/\* )?#define (\w+) scr_ossl_(\w+)/gm)];
    const names = lines.map((m) => {
      expect(m[2]).toBe(m[1]);
      return m[1]!;
    });
    expect(names.length).toBeGreaterThan(10000);
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe((await opensslPrefixNames()).size);
    // the caller-commented names are exactly those a public header maps
    expect([...text.matchAll(/^\/\* #define (\w+)/gm)].map((m) => m[1]).every((n) => n?.startsWith("EVP_") && n.endsWith("_cfb"))).toBe(true);
  });

  test("OS-03 every global the archive defines is scr_ossl_*, and it references no plain OpenSSL name", async () => {
    const defined = await definedGlobals(archive, darwin);
    expect(defined).not.toBeNull();
    expect([...defined!].filter((n) => !n.startsWith("scr_ossl_"))).toEqual([]);
    const names = await opensslPrefixNames();
    for (const n of names) expect(defined!.has(`scr_ossl_${n}`), `scr_ossl_${n} defined`).toBe(true);
    const { stdout } = await execFileAsync("nm", ["-u", archive], { maxBuffer: 1 << 28 });
    const undef = new Set(stdout.split("\n").map((l) => l.trim().split(/\s+/).pop()!).map((n) => (darwin && n.startsWith("_") ? n.slice(1) : n)));
    expect([...names].filter((n) => undef.has(n))).toEqual([]);
  });

  test("OS-04 a linked executable carries no plain OpenSSL name", async () => {
    // every symbol, any binding: the archive's objects are hidden, so the
    // link makes them local; none may be a plain OpenSSL name either way
    const { stdout } = await execFileAsync("nm", [smoke], { maxBuffer: 1 << 28 });
    const syms = new Set(
      stdout
        .split("\n")
        .map((l) => l.trim().split(/\s+/).pop() ?? "")
        .map((n) => (darwin && n.startsWith("_") ? n.slice(1) : n)),
    );
    const names = await opensslPrefixNames();
    expect([...syms].filter((n) => names.has(n))).toEqual([]);
    for (const n of ["scr_ossl_SSL_new", "scr_ossl_X509_verify_cert", "scr_ossl_EVP_sha256", "scr_ossl_X509_check_host"]) {
      expect(syms.has(n), n).toBe(true);
    }
  });
});

describe("the vendored OpenSSL works as Node's does", () => {
  test("OS-05 known answers: SHA-256, AES-256-GCM", async () => {
    expect(await run("kat")).toBe(
      [
        "sha256(abc) ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "aes256gcm ct cea7403d4d606b6e074ec5d3baf39d18",
        "aes256gcm tag d0d1c8a799996bf0265b98b5d48ab919",
        "",
      ].join("\n"),
    );
  });

  test("OS-06 material errors read as Node's", async () => {
    const node = (opts: { cert?: string; key?: string }): string => {
      try {
        createSecureContext(opts);
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(await run("pemerr")).toBe(`cert ${node({ cert: "garbage" })}\nkey ${node({ key: "garbage" })}\n`);
  });

  test("OS-07 X509_verify_cert + X509_check_host on the fixture chain", async () => {
    expect(await run("verify", join(certs, "ca.pem"), join(certs, "localhost.pem"), "localhost", "example.com")).toBe(
      "verify 1 0 ok\nhost localhost 1\nhost example.com 0\n",
    );
    expect(await run("verify", join(certs, "ca2.pem"), join(certs, "localhost.pem"), "localhost")).toBe(
      "verify 0 20 unable to get local issuer certificate\nhost localhost 1\n",
    );
  });

  test("OS-08 a TLS client handshake over memory BIOs against a Node https server", async () => {
    const server = createServer({ key: readFileSync(join(certs, "localhost-key.pem")), cert: readFileSync(join(certs, "localhost.pem")) }, (_req, res) => {
      res.end("hello from node\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = String((server.address() as AddressInfo).port);
    try {
      // what Node's own client negotiates and decides against the same server
      const nodeClient = (ca: string): Promise<{ protocol: string; cipher: string; error: string }> =>
        new Promise((resolve, reject) => {
          const s = connect({ port: Number(port), host: "127.0.0.1", servername: "localhost", ca: readFileSync(join(certs, ca)), rejectUnauthorized: false }, () => {
            const r = { protocol: s.getProtocol() ?? "", cipher: s.getCipher().name, error: s.authorizationError === null ? "" : String(s.authorizationError) };
            s.end();
            resolve(r);
          });
          s.on("error", reject);
        });
      const good = await nodeClient("ca.pem");
      expect(await run("tls", join(certs, "ca.pem"), port, "localhost")).toBe(
        [
          `protocol ${good.protocol}`,
          `cipher ${good.cipher}`,
          "group X25519MLKEM768",
          "verify 0 ok",
          "host localhost 1",
          "status HTTP/1.1 200",
          "body hello from node",
          "",
        ].join("\n"),
      );
      // an untrusted issuer: the same verdict Node reaches (its code name
      // and OpenSSL's text for it)
      const bad = await nodeClient("ca2.pem");
      expect(bad.error).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
      const out = await run("tls", join(certs, "ca2.pem"), port, "localhost");
      expect(out).toContain("verify 21 unable to verify the first certificate\n");
    } finally {
      server.close();
    }
  });

  test("OS-09 the archive is published whole, with its digest recorded beside it (#323)", async () => {
    const recorded = await readFile(`${archive}.ok`, "utf8");
    expect(recorded).toBe(`${(await stat(archive)).size} ${(await import("node:crypto")).createHash("sha256").update(await readFile(archive)).digest("hex")}`);
  });
});
