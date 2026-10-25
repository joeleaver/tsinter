/* INC-29 U3 — the WHATWG URL and URLSearchParams on the WasmGC tier: the
 * oracle rows. Each row compiles a driver program over an input list,
 * runs the module on the shared test host, and compares every output line
 * with Node v24.18.1 computing the same thing IN-PROCESS (this process is
 * the oracle's own runtime) — the input lists supply inputs only, never
 * expected answers. The URL inputs come from web-platform-tests
 * (fixtures/wpt-url-inputs.json) plus the hand-written matrices below.
 * Every row names the single edit that would make it fail. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-url-u3-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const WPT = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/wpt-url-inputs.json"), "utf8")) as {
  urls: string[];
  toascii: string[];
  idna: string[];
  bases: [string, string][];
};

let seq = 0;
async function run(src: string, ext = "ts"): Promise<string[]> {
  const file = join(scratch, `p${seq++}.${ext}`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: ext !== "ts", backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  const r = await runWasm(res.binaryPath);
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
  return r.stdout.split("\n").slice(0, -1);
}

/** Compare line for line, naming each input that differs. */
function same(inputs: readonly string[], got: string[], want: string[]): void {
  const bad: string[] = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) bad.push(`${JSON.stringify(inputs[i])}\n  wasm: ${got[i]}\n  node: ${want[i]}`);
  }
  expect(bad.slice(0, 30).join("\n"), `${bad.length} of ${want.length} lines differ`).toBe("");
  expect(got.length).toBe(inputs.length);
}

/* ── URL parsing ─────────────────────────────────────────────────────── */

const PARSE_DRIVER = `
for (const s of INPUTS) {
  let line: string;
  try {
    const u = new URL(s);
    line = JSON.stringify([u.href, u.protocol, u.host, u.hostname, u.pathname, u.search, u.searchParams.toString()]);
  } catch (e) {
    line = e instanceof TypeError ? "X " + e.message : "not a TypeError";
  }
  console.log(line);
}
`;
function parseLine(s: string): string {
  try {
    const u = new URL(s);
    return JSON.stringify([u.href, u.protocol, u.host, u.hostname, u.pathname, u.search, u.searchParams.toString()]);
  } catch (e) {
    return e instanceof TypeError ? "X " + e.message : "not a TypeError";
  }
}
async function parseRow(inputs: readonly string[]): Promise<void> {
  const got = await run(`const INPUTS: string[] = ${JSON.stringify(inputs)};\n${PARSE_DRIVER}`);
  same(inputs, got, inputs.map(parseLine));
}

/** The hand-written parse matrix: the categories the brief names. */
const MATRIX: string[] = [
  // special vs non-special schemes, scheme case, opaque paths
  "HTTP://EXAMPLE.COM/", "hTtPs://a.b/", "foo://Host/Path", "FOO:bar", "javascript:alert(1)", "mailto:a@b.c", "data:,x",
  "urn:isbn:0451450523", "blob:https://a.b/uuid", "web+demo:/.//not-a-host/", "web+demo:/..//not-a-host/", "sc://ñ.test/", "sc://%/",
  "a1+-.:x", "1a:x", "+a:x", "a:", "a:/", "a://", "a:///", "a:////x", "A://h", "ws:", "wss:/x", "ftp:x", "file:", "http:", "https:x",
  // ports: default elision, out of range, leading zeros, empties, signs
  "http://h:80/", "http://h:080/", "http://h:443/", "https://h:443/", "https://h:80/", "ws://h:80/", "wss://h:443/", "ftp://h:21/", "ftp://h:22/",
  "foo://h:0/", "http://h:0/", "http://h:65535/", "http://h:65536/", "http://h:99999999999999999999/", "http://h:-1/", "http://h:+1/", "http://h: 1/",
  "http://h:1 /", "http://h:1a/", "http://h::1/", "http://h:/", "http://h:", "foo://h:/", "foo://h:1x/", "http://h:1\\x", "foo://h:1\\x", "http://h:1?q", "http://h:1#f",
  "file://h:1/", "http://[::1]:8080/", "http://[::1]8080/", "http://u:p@h:1/",
  // IPv4: shorthand, hex, octal, overflow, trailing dots
  "http://1/", "http://0/", "http://1.2/", "http://1.2.3/", "http://1.2.3.4/", "http://1.2.3.4./", "http://1.2.3.4../", "http://1.2.3.4.5/",
  "http://0x7f.1/", "http://0X7F.0.0.1/", "http://0x/", "http://0x./", "http://0x.0x.0/", "http://0xg/", "http://0177.0.0.1/", "http://08/", "http://09.0/",
  "http://4294967295/", "http://4294967296/", "http://0xffffffff/", "http://0x100000000/", "http://256.0.0.1/", "http://1.256/", "http://1.2.65536/",
  "http://1.2.3.256/", "http://00000000000000000001/", "http://0x00000000000000001/", "http://1.0x/", "http://a.1/", "http://1.a/", "http://1.2.3.0x4/",
  "http://123.45.67.89x/", "http://%31%32%37.0.0.1/", "http://%30x7f.1/", "http://１２７.0.0.1/", "http://0..0x300/", "http://1.2.3.09/", "foo://1.2.3.4/",
  "file://127.0.0.1/x", "file://0x7f.1/x",
  // IPv6: compression, embedded IPv4, errors
  "http://[::]/", "http://[::1]/", "http://[1::]/", "http://[1:2:3:4:5:6:7:8]/", "http://[1:0:0:2:0:0:0:3]/", "http://[1:0:0:0:2:0:0:3]/", "http://[0:0:1:0:0:1:0:0]/",
  "http://[1:2:3:4:5:6:7::]/", "http://[::1:2:3:4:5:6:7]/", "http://[1:2:3:4:5:6:7:8:9]/", "http://[1::2::3]/", "http://[:1]/", "http://[1:]/", "http://[::ffff:1.2.3.4]/",
  "http://[::1.2.3.4]/", "http://[::1.2.3]/", "http://[::1.2.3.4.5]/", "http://[::01.2.3.4]/", "http://[::256.2.3.4]/", "http://[1:2:3:4:5:6:1.2.3.4]/",
  "http://[1:2:3:4:5:6:7:1.2.3.4]/", "http://[ABCD::EF]/", "http://[0abc:00de::f]/", "http://[12345::]/", "http://[g::]/", "http://[]/", "http://[/", "http://]/",
  "http://[::1]x/", "http://[::1]/", "foo://[::1]/", "foo://[1::2::3]/", "http://[::1%25eth0]/", "http://[1:2:3:4:5:6:7:8]:9/",
  // hosts: case, forbidden code points, percent-decoding, empty, opaque
  "http://ExAmPlE.CoM/", "http://a b/", "http://a<b/", "http://a^b/", "http://a|b/", "http://a%b/", "http://a%25b/", "http://a%2Eb/", "http://%41/", "http://%zz/",
  "http://a\u0000b/", "http://a.b./", "http://a..b/", "http://./", "http://../", "http://a.b..", "http://-a.b/", "http://a-.b/", "http://_a.b/", "http://a*b/",
  "foo://a b/", "foo://a%20b/", "foo://ExAmPlE/", "foo://a^b/", "foo://é/", "foo://%C3%A9/", "foo://a@b@c/", "foo://u:p@/", "http://@h/", "http://:@h/", "http://u:@h/",
  "http://:p@h/", "http://u@@h/", "http://u:p:q@h/", "http://u%40@h/", "http://a@b@c/", "http://a@/", "http://@/", "http://a:b@/", "http://ú:ß@h/", "http://u\\@h/",
  // percent-encoding per component
  "http://h/ !\"#$%&'()*+,-./0123456789:;<=>?@AZ[\\]^_`az{|}~\u007f", "http://h/?!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ \u007f",
  "foo://h/?!\"'<>`{}~ ", "http://h/#!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ \u007f", "http://h/é?é#é", "http://h/\ud83d\ude00?\ud83d\ude00#\ud83d\ude00",
  "http://h/\ud800?\udc00#\ud800x", "foo:é ?é", "foo:a  ", "foo:a  ?q", "foo:a  #f", "http://u:p é@h/", "http://h/%", "http://h/%2", "http://h/%zz", "http://h/%41",
  // backslashes
  "http:\\\\h\\a\\b", "http:/\\h/x", "http://h\\x?y\\z#w\\v", "foo:\\\\h\\a", "foo://h\\a\\b", "file:\\\\h\\x", "file:c:\\x", "\\\\h\\x",
  // tabs and newlines stripped, C0 control / space trimmed
  "ht\ttp://h/", "http://h\n.com/", "http://h/a\r\nb", "\u0001\u0002http://h/\u001f ", " \t http://h/ \n", "http://h/ ", "http://h/? ", "http://h/# ",
  "\u0000http://h/", "http://h/\u0000", "\u00a0http://h/", "http://h\u00a0/",
  // dot segments
  "http://h/a/./b/../c", "http://h/./", "http://h/../", "http://h/a/..", "http://h/a/.", "http://h/a/%2e", "http://h/a/%2E%2e/b", "http://h/.%2e/x", "http://h/%2e./x",
  "http://h/a/..%2f", "http://h/a/.../", "foo://h/a/../b", "foo:/a/../../b", "foo:/.//a", "foo:/..//a", "foo:a/../b", "file:///a/../../b", "file:///C:/../x",
  "file:///C:/a/../..", "file:///c|/x", "file:/c:/x", "file://c:/x", "file:c:x", "file:///C%3A/x", "file:..", "file:///./C:/x",
  // file URLs
  "file:///", "file://", "file:///tmp/x", "file://localhost/x", "file://LOCALHOST/x", "file://localhost:80/x", "file://host/x", "file://host:1/x",
  "file:x", "file:/x", "file://///x", "file:?q", "file:#f", "file://h?q", "file:///x?q#f", "FILE:///X", "file://[::1]/x", "file://%41/x", "file://é/x",
  // non-ASCII hosts (IDNA)
  "http://ñ.com/", "http://MÜNCHEN.de/", "http://xn--mnchen-3ya.de/", "http://xn--MNCHEN-3ya.de/", "http://bücher.example/", "http://例え.テスト/", "http://ドメイン.テスト/",
  "http://ﬀ.com/", "http://faß.de/", "http://ς.gr/", "http://Σ.gr/", "http://㍿/", "http://①②③/", "http://a\u00ad b/", "http://\u00ad/", "http://a\u200bb/",
  "http://a\u200cb/", "http://a\u200db/", "http://\u0915\u094d\u200c\u0937/", "http://\u0644\u0627/", "http://a\u0644/", "http://\u05d0\u05d1/", "http://\u05d0a/", "http://1\u05d0/",
  "http://\u0301a/", "http://xn--/", "http://xn--a/", "http://xn--a.com/", "http://xn--zca/", "http://xn--xn--zca/", "http://xn--zcaa/", "http://a.xn--1ch/",
  "http://☃.net/", "http://xn--n3h.net/", "http://\ud83d\udca9.la/", "http://%E2%98%83/", "http://%C3%BC/", "http://%C3/", "http://%FF/", "http://\ufffd/",
  "http://\uff21\uff22\uff23/", "http://ａ．ｂ/", "http://a。b/", "http://a．b/", "http://a｡b/", "http://\u2488/", "http://\u00df.de/", "http://\u0130/",
  "http://\u2163/", "http://\u1100\u1161/", "http://\uac00\u11a8/", "http://e\u0301/", "http://\u00e9/", "http://xn--9ca/", "http://xn--e-ufa/",
  "http://\u0663\u0661/", "http://\u0661a/", "http://a\u0300/", "http://\u05d0\u0300/", "http://\u05d0\u0661\u06f1/", "http://\u05d0.1/", "http://\u05d0.a/",
  // invalid inputs
  "", " ", "http", "http:", "http:/", "http://", "http:///", "http://:", "http://:80", "//h/x", "/x", "?x", "#x", "x", "1http://x", "http//x", "-x:y", ".x:y",
  "http://h:8a/", "http://u@/x", "http://u:p@", "http://[", "https://\u0000/", "https://a b c/",
];

describe("INC-29 U3 WHATWG URL — parse matrices against Node", () => {
  test("U3-PARSE-01 the hand-written matrix: special vs non-special schemes, ports, IPv4 forms, IPv6 compression, per-component percent-encoding, backslashes, tabs/newlines, C0 trimming, dot segments, file URLs, IDNA hosts, invalid inputs — href, protocol, host, hostname, pathname, search, searchParams for each, or the TypeError — SINGLE-EDIT: any parser state", async () => {
    await parseRow(MATRIX);
  }, 120000);
  test("U3-PARSE-02 every distinct web-platform-tests urltestdata.json input, parsed with no base — SINGLE-EDIT: any parser state", async () => {
    await parseRow(WPT.urls);
  }, 120000);
  test("U3-IDNA-01 web-platform-tests toascii.json and IdnaTestV2.json inputs as special-scheme hosts (domain to ASCII: UTS #46 mapping, NFC, punycode both ways, the bidi and ContextJ rules) and as opaque hosts — SINGLE-EDIT: an IDNA table or step", async () => {
    const hosts = [...WPT.toascii, ...WPT.idna];
    const inputs = hosts.flatMap((h) => [`https://${h}/p`, `foo://${h}/p`]);
    await parseRow(inputs);
  }, 300000);
});

/* ── a base: new URL(input, base), URL.parse, URL.canParse ────────────── */

const BASE_DRIVER = `
for (const [s, b] of PAIRS) {
  let line: string;
  try {
    const u = new URL(s, b);
    line = JSON.stringify([u.href, u.protocol, u.host, u.hostname, u.pathname, u.search, u.searchParams.toString()]);
  } catch (e) {
    line = e instanceof TypeError ? "X " + e.message : "not a TypeError";
  }
  const p = URL.parse(s, b);
  console.log(line + " | " + String(URL.canParse(s, b)) + " " + (p === null ? "null" : p.href));
}
`;
function baseLine([s, b]: readonly [string, string]): string {
  let line: string;
  try {
    const u = new URL(s, b);
    line = JSON.stringify([u.href, u.protocol, u.host, u.hostname, u.pathname, u.search, u.searchParams.toString()]);
  } catch (e) {
    line = e instanceof TypeError ? "X " + e.message : "not a TypeError";
  }
  const p = URL.parse(s, b);
  return line + " | " + String(URL.canParse(s, b)) + " " + (p === null ? "null" : p.href);
}
async function baseRow(pairs: readonly (readonly [string, string])[]): Promise<void> {
  const got = await run(`const PAIRS: [string, string][] = ${JSON.stringify(pairs)};\n${BASE_DRIVER}`);
  same(pairs.map((p) => JSON.stringify(p)), got, pairs.map(baseLine));
}

/** The hand-written base matrix: every input against every base. */
const BASE_INPUTS: string[] = [
  "", " ", "?", "?q", "#", "#f", "?#", "?q#f", "x", "x#f", "x?q", "./x", "../x", "../../../../x", "..", ".", "./", "../", "%2e%2E/x", "a/./b/../c",
  "/", "/x", "/x/../..", "\\x", "\\y\\z", "//", "//h2/p", "///p", "//u:p@h2:99/p", "//[::1]/", "//ñ/x", "/\\x", "\\/x", "\\x\\y",
  "C:", "C:/x", "C|/x", "/C:/x", "//C:/x", "C:x", "c:\\x", "/C|x",
  "http:x", "http:/x", "http://x", "https:x", "ws:x", "file:x", "file:/x", "file://x/y", "FILE:..", "foo:x", "foo:/x", "foo://x", "mailto:x", "sc:x",
  "x y", "é", "\ud800", "\tx\n", "javascript:alert(1)",
];
const BASE_BASES: string[] = [
  "http://h/a/b?q#f", "http://h", "https://u:p@h:8443/a/b/", "http://h/a?", "http://[::1]:81/p", "http://ñ.test/a/", "ws://h/", "ftp://h/a",
  "file:///a/b", "file:///C:/a/b", "file:///C:", "file:///c|/a", "file://srv/share/x", "file:///", "file:",
  "foo://h/a/b", "foo:/a/b", "foo:///a", "foo:/..//a", "foo://h", "foo:", "mailto:a@b", "mailto:a?q", "data:,x", "sc://ñ/x", "javascript:x", "a:b/c",
  "bad", "", "//h/", "http://[::1", "http://h:99999/",
];
const BASE_MATRIX: [string, string][] = BASE_BASES.flatMap((b) => BASE_INPUTS.map((i): [string, string] => [i, b]));

describe("URL base — new URL(input, base), URL.parse, URL.canParse against Node", () => {
  test("URL-BASE-01 every distinct web-platform-tests urltestdata.json [input, base] pair: href and the getters (or the TypeError), URL.canParse and URL.parse's href or null — SINGLE-EDIT: any base state (NO_SCHEME, SPECIAL_RELATIVE_OR_AUTHORITY, RELATIVE_SCHEME, RELATIVE_SLASH, the FILE / FILE_SLASH base arms)", async () => {
    await baseRow(WPT.bases);
  }, 300000);
  test("URL-BASE-02 the hand-written matrix — every input (empty, query, fragment, dot segments, slashes and backslashes, drive letters, same- and other-scheme relatives, non-ASCII) against every base (special, file with and without drive letters, non-special with and without host, opaque including the ada mailto: fall-through, an empty query, invalid) — SINGLE-EDIT: RELATIVE_SCHEME's query copy, shorten_path in the FILE base arm, or NO_SCHEME's opaque-base test", async () => {
    await baseRow(BASE_MATRIX);
  }, 600000);
  test("URL-BASE-03 the argument routes on the static tier: a URL-object base (its href), the literal undefined and an undefined-typed variable (the base-less parse), a string base after a throwing input — and URL.parse / URL.canParse with no base — SINGLE-EDIT: lowerUrlBaseArgs' URL route skipping url.href", async () => {
    const src = `const b = new URL("http://u:p@h:81/a/b?q#f");
const none: undefined = undefined;
const out: string[] = [];
out.push(new URL("c", b).href, new URL("?z", b).href, new URL("", b).href);
out.push(new URL("http://x/y", undefined).href, new URL("http://x/z", none).href);
try { new URL("x", undefined); out.push("no throw"); } catch (e) { out.push(e instanceof TypeError ? e.message : "?"); }
try { new URL("x", "nope"); out.push("no throw"); } catch (e) { out.push(e instanceof TypeError ? e.message : "?"); }
out.push(String(URL.canParse("http://h/")), String(URL.canParse("x")), String(URL.canParse("x", undefined)), String(URL.canParse("x", b)));
const p1 = URL.parse("http://h/p?q"); const p2 = URL.parse("x"); const p3 = URL.parse("../y", b);
out.push(p1 === null ? "null" : p1.href, p2 === null ? "null" : p2.href, p3 === null ? "null" : p3.href + " " + p3.pathname);
console.log(JSON.stringify(out));
`;
    const b = new URL("http://u:p@h:81/a/b?q#f");
    const out: string[] = [];
    out.push(new URL("c", b).href, new URL("?z", b).href, new URL("", b).href);
    out.push(new URL("http://x/y", undefined).href, new URL("http://x/z", undefined).href);
    try { new URL("x", undefined); out.push("no throw"); } catch (e) { out.push(e instanceof TypeError ? e.message : "?"); }
    try { new URL("x", "nope"); out.push("no throw"); } catch (e) { out.push(e instanceof TypeError ? e.message : "?"); }
    out.push(String(URL.canParse("http://h/")), String(URL.canParse("x")), String(URL.canParse("x", undefined)), String(URL.canParse("x", b)));
    const p1 = URL.parse("http://h/p?q"); const p2 = URL.parse("x"); const p3 = URL.parse("../y", b);
    out.push(p1 === null ? "null" : p1.href, p2 === null ? "null" : p2.href, p3 === null ? "null" : p3.href + " " + p3.pathname);
    expect(await run(src)).toEqual([JSON.stringify(out)]);
  }, 120000);
  test("URL-BASE-05 an optional base (`b?: string`, `b?: URL`): undefined chooses the base-less parse, a string or URL resolves, for new URL, URL.parse and URL.canParse — SINGLE-EDIT: the union arm of lowerUrlBaseArgs' run-time undefined test", async () => {
    const src = `function f(b?: string): string { return new URL("x", b).href; }
function g(b?: URL): string { return new URL("http://abs/y", b).href + " " + new URL("z", b ?? new URL("http://d/")).href; }
function h(i: string, b?: string): string { const p = URL.parse(i, b); return String(URL.canParse(i, b)) + " " + (p === null ? "null" : p.href); }
const show = (fn: () => string): void => { try { console.log("ret " + fn()); } catch (e) { console.log(e instanceof TypeError ? "TypeError " + e.message : "?"); } };
show(() => f("http://h/a/b")); show(() => f(undefined)); show(() => f()); show(() => f("bad"));
show(() => g(new URL("http://u/p/q"))); show(() => g());
show(() => h("x", "http://h/")); show(() => h("x")); show(() => h("http://q/")); show(() => h("http://q/", "bad"));
`;
    const f = (b?: string): string => new URL("x", b).href;
    const g = (b?: URL): string => new URL("http://abs/y", b).href + " " + new URL("z", b ?? new URL("http://d/")).href;
    const h = (i: string, b?: string): string => { const p = URL.parse(i, b); return String(URL.canParse(i, b)) + " " + (p === null ? "null" : p.href); };
    const want: string[] = [];
    const show = (fn: () => string): void => { try { want.push("ret " + fn()); } catch (e) { want.push(e instanceof TypeError ? "TypeError " + e.message : "?"); } };
    show(() => f("http://h/a/b")); show(() => f(undefined)); show(() => f()); show(() => f("bad"));
    show(() => g(new URL("http://u/p/q"))); show(() => g());
    show(() => h("x", "http://h/")); show(() => h("x")); show(() => h("http://q/")); show(() => h("http://q/", "bad"));
    expect(await run(src)).toEqual(want);
  }, 120000);
  test("URL-BASE-04 a dynamic base (.cjs): undefined chooses the base-less parse, anything else converts as `${base}` does — null and 5 are Invalid URL bases, an object's own toString is called (its throw propagates), an own valueOf answers when toString is not callable — for new URL, URL.parse and URL.canParse — SINGLE-EDIT: the run-time undefined test in lowerUrlBaseArgs, or the dyn base converted by String() instead of dyn.toStringCoerce", async () => {
    const src = `'use strict';
const show = (f) => { try { console.log('ret ' + String(f())); } catch (e) { console.log(e.name + '|' + e.message); } };
const bases = JSON.parse('["http://h/a/b", null, 5, "bad", "file:///C:/x"]');
const rel = JSON.parse('"../c?d#e"');
let b0 = bases[0]; let bu; let bn = bases[1]; let b5 = bases[2]; let bb = bases[3]; let bf = bases[4];
show(() => new URL(rel, b0).href);
show(() => new URL('x', bu).href);
show(() => new URL('http://q/', bu).href);
show(() => new URL(rel, bn).href);
show(() => new URL('x', b5).href);
show(() => new URL('x', bb).href);
show(() => new URL('/y', bf).href);
show(() => URL.canParse(rel, b0));
show(() => URL.canParse(rel, bu));
show(() => URL.canParse('http://q/', bu));
show(() => URL.canParse('x', bn));
show(() => { const p = URL.parse(rel, b0); return p === null ? 'null' : p.href; });
show(() => { const p = URL.parse('x', bb); return p === null ? 'null' : p.href; });
show(() => { const p = URL.parse('http://q/', bu); return p === null ? 'null' : p.href; });
let ob = JSON.parse('{}'); ob.toString = function () { console.log('ts called'); return 'http://h/a/'; };
let ot = JSON.parse('{}'); ot.toString = function () { throw new RangeError('boom'); };
let ov = JSON.parse('{}'); ov.valueOf = function () { return 'http://v/'; }; ov.toString = undefined;
show(() => new URL('x', ob).href);
show(() => new URL('x', ot).href);
show(() => new URL('x', ov).href);
show(() => URL.canParse('x', ob));
`;
    expect(await run(src, "cjs")).toEqual([
      "ret http://h/c?d#e", "TypeError|Invalid URL", "ret http://q/", "TypeError|Invalid URL", "TypeError|Invalid URL", "TypeError|Invalid URL",
      "ret file:///C:/y", "ret true", "ret false", "ret true", "ret false", "ret http://h/c?d#e", "ret null", "ret http://q/",
      "ts called", "ret http://h/a/x", "RangeError|boom", "ret http://v/x", "ts called", "ret true",
    ]);
  }, 120000);
});

/* ── URLSearchParams ─────────────────────────────────────────────────── */

const QS: string[] = [
  "", "?", "??", "a", "a=", "=a", "=", "==", "a=b=c", "&", "&&a=1&&", "a&b", "a+b=c+d", "%2B=%2b", "%", "%%", "%2", "%2G", "%g2", "%41%42", "%41%", "%%41",
  "a%3Db=c", "%26=%3D", "%E2%82%AC", "%e2%82%ac", "%E2%82", "%E2%82%", "%FF", "%C0%80", "%ED%A0%80", "%F0%9F%98%80", "%F4%90%80%80", "é=%C3%A9", "é%FF", "%FFé",
  "\ud800=x", "x=\udc00", "\ud83d\ude00=\ud83d\ude00", "a=1&a=2&b=3", "+%2B+", "%+41", "%4+1", "a=%zz&b=%41", "%41=%zz", "?a=1", "??a=1", " a = b ", "a\u0000=b",
];

const SP_DRIVER = `
for (const q of QS) {
  const sp = new URLSearchParams(q);
  const parts: string[] = [];
  sp.forEach((v, k) => parts.push(JSON.stringify([k, v])));
  console.log(parts.join(",") + " | " + sp.toString() + " | " + String(sp.size));
}
`;
function spLine(q: string): string {
  const sp = new URLSearchParams(q);
  const parts: string[] = [];
  sp.forEach((v, k) => parts.push(JSON.stringify([k, v])));
  return parts.join(",") + " | " + sp.toString() + " | " + String(sp.size);
}

describe("INC-29 U3 URLSearchParams against Node", () => {
  test("U3-SP-01 the application/x-www-form-urlencoded parser: '&' and '=' splitting, '+' as space, percent-decoding (decodeURIComponent, else unescapeBuffer and UTF-8 decode with replacement), lone surrogates — and the serializer (+ vs %20, the noEscape set) — SINGLE-EDIT: qsUnescape's fallback or the encoder table", async () => {
    const got = await run(`const QS: string[] = ${JSON.stringify(QS)};\n${SP_DRIVER}`);
    same(QS, got, QS.map(spLine));
  }, 120000);

  test("U3-SP-02 the serializer over every BMP code unit class and astral pairs, names and values — SINGLE-EDIT: formEncode's UTF-8 or its byte set", async () => {
    const chars: string[] = [];
    for (let c = 0; c < 0x800; c++) chars.push(String.fromCharCode(c));
    for (const c of [0x800, 0xfff, 0xd7ff, 0xe000, 0xfffd, 0xffff]) chars.push(String.fromCharCode(c));
    chars.push("\ud83d\ude00", "\udbff\udfff", "\ud800", "\udfff");
    const src = `const CH: string[] = ${JSON.stringify(chars)};\nfor (const c of CH) { const sp = new URLSearchParams(); sp.append(c, c + "x"); console.log(sp.toString()); }\n`;
    const got = await run(src);
    same(chars, got, chars.map((c) => {
      const sp = new URLSearchParams();
      sp.append(c, c + "x");
      return sp.toString();
    }));
  }, 120000);

  test("U3-SP-03 sort is stable and orders by UTF-16 code units, below and past Node's 100-entry insertion/merge switch — SINGLE-EDIT: strCmp or the insertion loop's comparison", async () => {
    const keys = ["b", "a", "", "B", "\ufffb", "\ud83d\ude00", "\ue000", "aa", "a", "b", "\u00e9", "e\u0301"];
    const make = (n: number): string[] => Array.from({ length: n }, (_, i) => `${keys[(i * 7) % keys.length]}=${i}`);
    const lists = [make(3), make(12), make(49), make(50), make(51), make(140)];
    const src = `const L: string[] = ${JSON.stringify(lists.map((l) => l.join("&")))};\nfor (const q of L) { const sp = new URLSearchParams(q); sp.sort(); console.log(sp.toString()); }\n`;
    const got = await run(src);
    const want = lists.map((l) => {
      const sp = new URLSearchParams(l.join("&"));
      sp.sort();
      return sp.toString();
    });
    same(lists.map((l) => l.join("&")), got, want);
  }, 120000);

  test("U3-SP-05 sort over 60,000 pairs is Node's merge sort (stable, code-unit order, n log n): the sorted list equals Node's, inside a time bound an insertion sort cannot meet — SINGLE-EDIT: spSort's 100-entry switch to the merge sort, or the merge's '<=' made '<'", async () => {
    const gen = (): string => {
      // Pseudo-random names with many duplicates and non-ASCII, values the index.
      let x = 12345;
      const parts: string[] = [];
      for (let i = 0; i < 60000; i++) {
        x = (x * 75 + 74) % 65537;
        const k = x % 3000;
        parts.push(`${k % 7 === 0 ? "é" : ""}k${k}=${i}`);
      }
      return parts.join("&");
    };
    // The module builds its list with append(): joining 60,000 strings is
    // itself slow on this tier (a separate, pre-existing cost), and the
    // row times the sort.
    const src = `let x = 12345;
const sp = new URLSearchParams();
for (let i = 0; i < 60000; i++) {
  x = (x * 75 + 74) % 65537;
  const k = x % 3000;
  sp.append((k % 7 === 0 ? "\\u00e9" : "") + "k" + String(k), String(i));
}
sp.sort();
console.log(sp.toString());
`;
    const t0 = Date.now();
    const got = await run(src);
    const elapsed = Date.now() - t0;
    const sp = new URLSearchParams(gen());
    sp.sort();
    expect(got.length).toBe(1);
    expect(got[0] === sp.toString(), "the sorted list differs from Node's").toBe(true);
    expect(elapsed).toBeLessThan(15000);
  }, 120000);

  test("U3-SP-04 the live link: url.searchParams mutations rewrite href and search at once, an emptied list drops the query, url.search reads back through the view, special vs non-special query encoding of the view's initial parse — SINGLE-EDIT: spSync", async () => {
    const urls = ["http://h/p?a=1&b=2#f", "foo://h/p?a=1#f", "http://h/p", "http://h/p?", "foo:opaque?x=1", "http://h/?a+b=%20&c=%zz", "file:///x?q=1", "http://h/?a=%E2%82%AC"];
    const src = `const U: string[] = ${JSON.stringify(urls)};
for (const s of U) {
  const u = new URL(s);
  const v = u.searchParams;
  const out: string[] = [u.search, v.toString()];
  v.append("n", "x y");
  out.push(u.href, u.search);
  v.set("a", "~!");
  out.push(u.href);
  v.sort();
  out.push(u.href);
  v.delete("a");
  v.delete("b");
  v.delete("n");
  v.delete("c");
  v.delete("a b");
  v.delete("q");
  v.delete("x");
  out.push(u.href, JSON.stringify(u.search), String(v.size));
  console.log(JSON.stringify(out));
}
`;
    const got = await run(src);
    const want = urls.map((s) => {
      const u = new URL(s);
      const v = u.searchParams;
      const out: string[] = [u.search, v.toString()];
      v.append("n", "x y");
      out.push(u.href, u.search);
      v.set("a", "~!");
      out.push(u.href);
      v.sort();
      out.push(u.href);
      for (const k of ["a", "b", "n", "c", "a b", "q", "x"]) v.delete(k);
      out.push(u.href, JSON.stringify(u.search), String(v.size));
      return JSON.stringify(out);
    });
    same(urls, got, want);
  }, 120000);
});

/* ── file URLs ───────────────────────────────────────────────────────── */

describe("INC-29 U3 file URLs against Node", () => {
  test("U3-FILE-01 fileURLToPath over strings and URL values: percent-decoding (UTF-8, malformed escapes as URIError), encoded slashes, hosts, other schemes, unparsable input — SINGLE-EDIT: fileToPath's checks", async () => {
    const inputs = ["file:///tmp/a%20b", "file:///%C3%A9", "file:///%E2%82", "file:///a%2fb", "file:///a%2Fb", "file:///a%252fb", "file://localhost/x", "file://h/x",
      "file:///a/../b/./c", "file:///C:/x", "http://h/x", "foo:x", "not a url", "file:///%", "file:///%zz", "file:///\ud800", "file:///a?b#c", "file:///é", "file:", "FILE:///X"];
    const line = (s: string): string => {
      const r: string[] = [];
      for (const viaUrl of [false, true]) {
        try {
          r.push(viaUrl ? nodeFileURLToPath(new URL(s)) : nodeFileURLToPath(s));
        } catch (e) {
          r.push(e instanceof TypeError ? "TypeError " + e.message : e instanceof Error ? "Error " + e.message : "?");
        }
      }
      return JSON.stringify(r);
    };
    const src = `import { fileURLToPath } from "node:url";
const I: string[] = ${JSON.stringify(inputs)};
for (const s of I) {
  const r: string[] = [];
  try { r.push(fileURLToPath(s)); } catch (e) { r.push(e instanceof TypeError ? "TypeError " + e.message : e instanceof Error ? "Error " + e.message : "?"); }
  try { r.push(fileURLToPath(new URL(s))); } catch (e) { r.push(e instanceof TypeError ? "TypeError " + e.message : e instanceof Error ? "Error " + e.message : "?"); }
  console.log(JSON.stringify(r));
}
`;
    const got = await run(src);
    same(inputs, got, inputs.map(line));
  }, 120000);

  test("U3-FILE-02 pathToFileURL over absolute paths: node_url.cc's EncodePathChars set, '%', non-ASCII, a lone surrogate, trailing slashes and dot segments — SINGLE-EDIT: the EncodePathChars table", async () => {
    const paths = ["/", "/tmp/a b", "/a%b", "/a?b#c", "/a\\b", "/[x]^|~", "/é/\ud83d\ude00", "/\ud800", "/a/", "/a/../b/./c", "//x", "/a\tb\nc\u0000", "/\"<>`{}"];
    const src = `import { pathToFileURL } from "node:url";
const P: string[] = ${JSON.stringify(paths)};
for (const p of P) { const u = pathToFileURL(p); console.log(JSON.stringify([u.href, u.pathname])); }
`;
    const got = await run(src);
    same(paths, got, paths.map((p) => {
      const u = nodePathToFileURL(p);
      return JSON.stringify([u.href, u.pathname]);
    }));
  }, 120000);
});

/* ── registered divergences (SEMANTICS.md S089), this tier's answers pinned ── */

describe("INC-29 U3 SEMANTICS.md S089 rows", () => {
  test("URL-REG-01 S089 (a): an Invalid URL TypeError carries name, message and code only — Node: TypeError Invalid URL ERR_INVALID_URL nope (the input) — SINGLE-EDIT: the code dropped from newFn's error", async () => {
    const got = await run("'use strict';\ntry { new URL('nope'); } catch (e) { console.log(e.name, e.message, e.code, e.input); }\n", "cjs");
    expect(got).toEqual(["TypeError Invalid URL ERR_INVALID_URL undefined"]);
  }, 60000);
  test("URL-REG-02 S089 (b): a dynamic array as a URLSearchParams name throws a named Error — Node: ret \"x\" (the array converts to \"1,2\"); a number and an object with its own toString convert as in Node — SINGLE-EDIT: the array kind admitted to dyn.toStringCoerce", async () => {
    const got = await run("'use strict';\nconst p = new URLSearchParams('1,2=x&7=n&[object Object]=o');\nconst show = (f) => { try { console.log('ret', JSON.stringify(f())); } catch (e) { console.log(e.name + '|' + e.message); } };\nshow(() => p.get([1, 2]));\nshow(() => p.get(7));\nconst o = { toString() { return 7; } };\nshow(() => p.get(o));\n", "cjs");
    expect(got).toEqual(["Error|converting this dynamic value to a URLSearchParams string is not supported yet", 'ret "n"', 'ret "n"']);
  }, 60000);
});

void readFile;
