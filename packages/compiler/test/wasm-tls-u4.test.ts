/* INC-29 U4 — node:tls's CA store on the WasmGC tier, host-free: the
 * bundled roots and tls.setDefaultCACertificates' parse (OpenSSL's PEM
 * reading, X509_cmp's order, the dedupe and the errors) never reach the
 * host's TLS engine, so they run on the shared test host. Each row compiles
 * a driver over an input list and compares every output line with Node
 * v24.18.1 running the same driver in a CHILD process (setDefaultCACertificates
 * replaces the process's own root store, so the oracle never runs in this
 * one). Every row names the single edit that would make it fail. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-tls-u4-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const CERTS = join(import.meta.dirname, "../../../tests/fixtures/server/certs");
const ca = readFileSync(join(CERTS, "ca.pem"), "utf8");
const ca2 = readFileSync(join(CERTS, "ca2.pem"), "utf8");
const leaf = readFileSync(join(CERTS, "localhost.pem"), "utf8");
const self = readFileSync(join(CERTS, "selfsigned.pem"), "utf8");
const key = readFileSync(join(CERTS, "localhost-key.pem"), "utf8");
const body = (pem: string): string => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
const wrap = (b64: string, width: number, name = "CERTIFICATE"): string =>
  `-----BEGIN ${name}-----\n${(b64.match(new RegExp(`.{1,${width}}`, "g")) ?? []).join("\n")}\n-----END ${name}-----\n`;

let seq = 0;
async function runTs(src: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  return runWasm(res.binaryPath);
}

/** The same driver under Node, in a child process. */
async function nodeTs(src: string): Promise<string> {
  const file = join(scratch, `n${seq++}.ts`);
  await writeFile(file, src);
  return execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", file], { encoding: "utf8" });
}

const SET_DRIVER = `
import * as tls from "node:tls";
for (const set of SETS) {
  let line: string;
  try {
    tls.setDefaultCACertificates(set);
    line = JSON.stringify(tls.getCACertificates("default"));
  } catch (e) {
    line = "X " + (e as Error).name + " " + (e as Error).message;
  }
  console.log(line);
}
`;

describe("INC-29 U4 the CA store, host-free", () => {
  test("U4-CA-01 tls.rootCertificates is Node's bundled store, string for string (72-column lines, no trailing newline), and getCACertificates('bundled') is the same array — SINGLE-EDIT: the PEM line width", async () => {
    const r = await runTs(`import * as tls from "node:tls";\nconsole.log(JSON.stringify(tls.rootCertificates));\nconsole.log(tls.getCACertificates("bundled") === tls.rootCertificates);\n`);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const [roots, same] = r.stdout.split("\n");
    expect(JSON.parse(roots!) as string[]).toEqual(rootCertificates);
    expect(same).toBe("true");
  }, 120000);

  test("U4-CA-02 setDefaultCACertificates' parse over OpenSSL's PEM reading: canonical 64-column output, CRLF and a BOM and stray text accepted, two certificates in one string, the X509 CERTIFICATE name, TRUSTED CERTIFICATE and other blocks skipped, X509_cmp's order and the dedupe, the empty set, bad base64, undecodable DER, a bad end line, a block with no body, and 'No valid certificates' — SINGLE-EDIT: the X509_cmp order compared descending", async () => {
    const sets: string[][] = [
      [ca],
      [ca2, ca, ca2],
      [ca + ca2],
      [leaf, self, ca, ca2],
      [ca.replace(/\n/g, "\r\n")],
      ["﻿" + ca],
      ["hello\n" + ca + "trailer"],
      ["  " + ca],
      [ca.replace(/\n/g, "   \n")],
      [wrap(body(ca), 72)],
      [wrap(body(ca), 4)],
      [wrap(body(ca), 64, "X509 CERTIFICATE")],
      [wrap(body(ca), 64, "TRUSTED CERTIFICATE")],
      [key + ca],
      ["-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n"],
      ["-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" + ca],
      [wrap(body(ca), 64).replace("-----END CERTIFICATE-----", "-----END X509 CERTIFICATE-----")],
      [wrap(body(ca), 64).replace("-----END CERTIFICATE-----\n", "")],
      ["-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n" + ca],
      ["-----BEGIN CERTIFICATE-----\nAA==AA==\n-----END CERTIFICATE-----\n"],
      ["-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n"],
      [wrap(body(ca).slice(0, -4), 64)],
      [],
      [""],
      ["junk", ""],
      [ca, "junk"],
      ["not a pem at all"],
    ];
    const src = `const SETS: string[][] = ${JSON.stringify(sets)};\n${SET_DRIVER}`;
    const r = await runTs(src);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const want = (await nodeTs(src)).split("\n");
    const got = r.stdout.split("\n");
    const bad: string[] = [];
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) bad.push(`set ${i}\n  wasm: ${got[i]?.slice(0, 300)}\n  node: ${want[i]?.slice(0, 300)}`);
    expect(bad.join("\n")).toBe("");
  }, 120000);

  test("U4-REG-02 S090 (c): a PEM block with a header line, or a line BIO_gets reads in pieces (over 253 bytes), is a named fence — Node: a Proc-Type-less header is OpenSSL's PEM_R_NOT_PROC_TYPE error, a long line parses — SINGLE-EDIT: the header test dropped from pemRead", async () => {
    const sets: string[][] = [
      ["-----BEGIN CERTIFICATE-----\nX-Note: hi\n\n" + body(ca) + "\n-----END CERTIFICATE-----\n"],
      [wrap(body(ca), 300)],
    ];
    const r = await runTs(`const SETS: string[][] = ${JSON.stringify(sets)};\n${SET_DRIVER}`);
    expect(r.stdout).toBe(
      "X Error tls.setDefaultCACertificates of a PEM block with header lines or a line over 253 bytes is not supported yet\n".repeat(2),
    );
  }, 120000);
});
