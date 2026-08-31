/* increment 23 P3, rider 2 — `url.fileURLToPathStr` (SEMANTICS.md S060:
 * the remaining scope narrowings — dot-segment resolution, PERCENT-
 * DECODED non-ASCII path bytes, malformed percent-escapes — this file's
 * own trap pins). Compile REAL TypeScript through the actual frontend+
 * backend, run it through the real abi.ts host (wasm-host.ts). Every
 * literal below is measured directly against node v24.18.1 (own probes,
 * this pass — not transcribed).
 *
 * rev-23's axis-D sweep (F-1, increment 23 P3 fix round F2-p3) found FOUR
 * unregistered divergence classes, three of which silently returned a
 * WRONG path (corpus 1356 line 9 is one of them — reachability was not
 * hypothetical). Query-string/fragment stripping and backslash-as-
 * separator normalization are FIXED this round; a class-4 follow-up
 * ruling (rev-23's fresh oracle measurements) found the RAW non-ASCII
 * trap this file used to pin was ITSELF a divergence — Node's own
 * parser round-trips a raw non-ASCII code unit LOSSLESSLY (percent-
 * encode then decode), so that trap is now DROPPED too, fixed to a
 * correct pass-through (with the one Node-measured exception: an
 * unpaired surrogate becomes U+FFFD). Only the ENCODED (percent-
 * escaped) non-ASCII byte and the malformed-percent-escape classes
 * remain NAMED traps. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-url-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, lines: string[]) {
  const entry = join(scratch, name);
  await writeFile(entry, `${lines.join("\n")}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

const FAILS_HELPER = [
  "function fails(input: string): string {",
  "  try {",
  "    fileURLToPath(input);",
  "    return 'no-throw';",
  "  } catch (e) {",
  "    if (e instanceof TypeError) return e.message;",
  "    return 'not-a-typeerror';",
  "  }",
  "}",
];

// Every backslash below goes through TWO escaping levels: this array's
// own JS string literals (parsed once, when THIS file loads), and the
// TS-source text they produce (parsed again, by the compiler under
// test). One raw '\' surviving into the COMPILED PROGRAM's own string
// VALUE needs two literal backslashes in the temp .ts file's TEXT
// (`\\` — TS's own escaped-backslash rule), which in turn needs four
// backslash characters in THIS file's own source (each `\\` pair here
// producing one raw backslash in the string this array element
// evaluates to). Verified directly (own throwaway script, not assumed)
// before writing the pin below — `string.fromCharCode` was tried first
// and is itself out-of-tier for the wasm backend (a DIFFERENT unrelated
// gap, not this rider's), so plain doubled-escape literals are used
// instead.

test("fileURLToPathStr — 2385's own literal, the claim itself, byte-exact vs Node", async () => {
  const path = await build("literal.ts", [
    "import { fileURLToPath } from 'node:url';",
    "console.log(fileURLToPath('file:///tmp/some file.txt'));",
    "console.log(fileURLToPath('file:///tmp/other.txt'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["/tmp/some file.txt", "/tmp/other.txt", ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — localhost host empties, %20 decodes, scheme case-fold (FILE:///), byte-exact vs Node", async () => {
  const path = await build("basics.ts", [
    "import { fileURLToPath } from 'node:url';",
    "console.log(fileURLToPath('file://localhost/tmp/x.txt'));",
    "console.log(fileURLToPath('file:///tmp/a%20b.txt'));",
    "console.log(fileURLToPath('FILE:///upper'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["/tmp/x.txt", "/tmp/a b.txt", "/upper", ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — the 0/1/2-slash host-less forms all root the path (scr_url.c's own 'prepend one if absent' rule, PREVIOUSLY A BUG in this pin file's own construction — found by running it, not review: the leading slash was never actually written)", async () => {
  const path = await build("hostless.ts", [
    "import { fileURLToPath } from 'node:url';",
    "console.log(fileURLToPath('file:tmp/x.txt'));",
    "console.log(fileURLToPath('file:/tmp/x.txt'));",
    "console.log(fileURLToPath('file:///tmp/x.txt'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["/tmp/x.txt", "/tmp/x.txt", "/tmp/x.txt", ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — the four TypeError arms, message and instanceof byte-exact vs Node (%2F, non-localhost host, unparseable, wrong scheme)", async () => {
  const path = await build("errors.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fails('file:///tmp/a%2Fb.txt'));",
    "console.log(fails('file://host/tmp/x.txt'));",
    "console.log(fails('not a url'));",
    "console.log(fails('http://example.com/x'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "File URL path must not include encoded / characters",
      'File URL host must be "localhost" or empty on linux',
      "Invalid URL",
      "The URL must be of scheme file",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("fileURLToPathStr — S060(a): a bare dot-segment (interior and trailing) traps by name, catchable, NOT Node's own collapsed-path answer (Node measured: file:///a/../b -> /b; this tier throws instead), citing SEMANTICS.md S060 by number (F-4)", async () => {
  const path = await build("dotseg.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fails('file:///a/../b'));",
    "console.log(fails('file:///a/./b'));",
    "console.log(fails('file:///a/..'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  const msg = "dot-segment path resolution is not supported yet (SEMANTICS.md S060)";
  expect(stdout).toBe([msg, msg, msg, ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — F-3: the dot-segment trap now ALSO fires on the %2e/%2E PERCENT-ENCODED spellings (S060(a)'s heading used to be false of its own body — this closes the gap: checked on DECODED segments, not raw bytes), while non-dot-segment near-misses still pass through unchanged (Node measured: %2eb -> .b, a literal segment; %2e%2e%2e -> ..., three dots, also literal — neither is a real dot-segment)", async () => {
  const path = await build("dotseg-encoded.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fails('file:///a/%2e%2e/b'));",
    "console.log(fails('file:///a/%2E%2E/b'));",
    "console.log(fails('file:///a/.%2e/b'));",
    "console.log(fails('file:///a/%2e./b'));",
    "console.log(fails('file:///a/%2e/b'));",
    "console.log(fileURLToPath('file:///a/%2eb/c'));",
    "console.log(fileURLToPath('file:///a/%2e%2e%2e/b'));",
    "console.log(fileURLToPath('file:///a..b/c'));",
    "console.log(fileURLToPath('file:///a/x%2ey/b'));", // CTRL.x-pct2e-y — the dot lands MID-segment, not at its start; still not a dot-segment
  ]);
  const { stdout, stderr } = await runWasm(path);
  const msg = "dot-segment path resolution is not supported yet (SEMANTICS.md S060)";
  expect(stdout).toBe([msg, msg, msg, msg, msg, "/a/.b/c", "/a/.../b", "/a..b/c", "/a/x.y/b", ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — class-4 amendment: a RAW non-ASCII code unit is NOT trapped (an earlier build's raw-code-unit trap was ITSELF a divergence — Node's own parser round-trips a raw code unit losslessly), and passes through byte-exact vs Node — including a real (paired) astral character surviving as its own intact surrogate pair, and an unpaired (lone) surrogate substituting U+FFFD (Node's own WHATWG-encode behavior, not this tier's invention)", async () => {
  const path = await build("nonascii-raw.ts", [
    "import { fileURLToPath } from 'node:url';",
    "console.log(fileURLToPath('file:///t/\\u00e9'));",
    "console.log(fileURLToPath('file:///t/\\u{1f30d}'));",
    "console.log(fileURLToPath('file:///t/\\u0080'));",
    "console.log(fileURLToPath('file:///t/\\ud800'));", // lone HIGH surrogate
    "console.log(fileURLToPath('file:///t/\\udc00'));", // lone LOW surrogate -- a different detection branch than the high case above
    // charCodeAt on the RETURNED string directly, printed as a NUMBER --
    // a wasm program's own write-path ALREADY normalizes a raw lone
    // surrogate to U+FFFD generically at the byte level when encoding
    // for stdout (measured directly: the raw bytes match Node's own
    // EVEN with the substitution code disabled), so the string pins
    // above alone cannot tell "this code explicitly substitutes U+FFFD
    // into the RETURNED value" from "some other layer normalizes it at
    // print time" -- printing a NUMBER bypasses that write-path's own
    // string encoding and reads the returned value's own code unit,
    // which Node's own fileURLToPath ALSO already holds as literal
    // 65533/U+FFFD (measured directly on Node's own RETURN VALUE via
    // charCodeAt, not inferred from console.log's printed bytes).
    "console.log(fileURLToPath('file:///t/\\ud800').charCodeAt(3));",
    "console.log(fileURLToPath('file:///t/\\udc00').charCodeAt(3));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["/t/é", "/t/\u{1f30d}", "/t/", "/t/�", "/t/�", "65533", "65533", ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — F-1(4): S060(b), the ENCODED half — a percent-DECODED byte >= 0x80 traps (the raw half, pinned above, is FIXED — this is the one remaining divergence, reached via a percent escape rather than a raw byte). This is corpus 1356's OWN line 9 (fileURLToPath('file:///tmp/%C3%A9')) — previously a SILENT WRONG PATH ('/tmp/Ã©', a byte-wise mojibake decode of café's UTF-8 bytes); now a named, catchable refusal instead (rule 1) — 1356 itself still does not claim through this rider (its own first refusal is libCall:url.href, unchanged; this trap is unreachable from its own top-level code)", async () => {
  const path = await build("nonascii-encoded.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fails('file:///tmp/%C3%A9'));", // 1356 line 9's own literal, byte-for-byte
    "console.log(fails('file:///tmp/%F0%9F%8C%8D'));", // 1611's own astral (U+1F30D) shape
    // WITNESS row (completion round): %C3 is a well-formed hex escape
    // (no F-1(4b) malformed-escape violation) but %28 is NOT a valid
    // UTF-8 continuation byte for the %C3 lead — an INVALID sequence,
    // not merely an unsupported valid one. Node throws URIError('URI
    // malformed') for this (measured). This tier's decoded->=0x80 trap
    // SUBSUMES this and all 7 measured invalid-UTF-8 classes: %C3 alone
    // already decodes to 0xC3 (>=0x80), tripping THIS trap before %28's
    // own validity is ever examined — no separate handling needed.
    "console.log(fails('file:///t/%C3%28'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  const msg = "non-ASCII fileURLToPath paths are not supported yet (SEMANTICS.md S060)";
  expect(stdout).toBe([msg, msg, msg, ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — F-1(4b): a malformed percent-escape (bad hex, trailing '%', truncated) traps by name — Node throws a catchable URIError('URI malformed') for every one of these; this tier has no URIError class (not cheap to add this round), so it traps by name instead of the PREVIOUS silent behavior (treating the bare '%' as a literal character)", async () => {
  const path = await build("malformed-escape.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fails('file:///tmp/a%zzb'));",
    "console.log(fails('file:///tmp/a%'));",
    "console.log(fails('file:///tmp/a%2'));",
    // R-1 (rev-23's re-cert finding): ONE valid hex digit, one invalid
    // ('2' then 'Z') — the fence a naive is-next-char-hex test can miss
    // if it ORs the two digit checks instead of ANDing them (rev's M9:
    // %zz still traps under OR since NEITHER digit is hex; %/%2 fail the
    // room check first; only a MIXED valid/invalid pair like this one
    // actually distinguishes AND from OR). Node throws URIError('URI
    // malformed') on this exact input (measured).
    "console.log(fails('file:///tmp/a%2Zb'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  const msg = "malformed percent-escape in a file URL path is not supported yet (SEMANTICS.md S060)";
  expect(stdout).toBe([msg, msg, msg, msg, ""].join("\n"));
  expect(stderr).toBe("");
});

test("fileURLToPathStr — F-1(1)/(2): the path is truncated at the first UNESCAPED '?' or '#' before decoding — Node's own pathname extraction, not a divergence — while %3F/%23 (escaped) stay literal in the output; the truncation cuts the WHOLE remainder, including what would otherwise be the authority span (Node measured: file://localhost?x/foo -> '/', not a host mismatch)", async () => {
  const path = await build("query-fragment.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fileURLToPath('file:///tmp/x?q=1'));",
    "console.log(fileURLToPath('file:///tmp/x#frag'));",
    "console.log(fileURLToPath('file:///tmp/%3F'));",
    "console.log(fileURLToPath('file:///tmp/%23'));",
    "console.log(fileURLToPath('file:///tmp/x%3Fq=1'));",
    "console.log(fileURLToPath('file:///tmp/x%23f'));", // CTRL.pct23 — %23 survives mid-string too, not just at the end
    "console.log(fileURLToPath('file://localhost?x/foo'));",
    "console.log(fails('file://loc?alhost/tmp/x'));",
    "console.log(fileURLToPath('file://?x/tmp'));", // empty host AND empty path once '?x/tmp' is chopped — roots to '/'
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "/tmp/x",
      "/tmp/x",
      "/tmp/?",
      "/tmp/#",
      "/tmp/x?q=1",
      "/tmp/x#f",
      "/",
      'File URL host must be "localhost" or empty on linux',
      "/",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("fileURLToPathStr — F-1(3): a raw backslash is a path separator for file: (a WHATWG SPECIAL scheme), normalized to '/' EVERYWHERE — slash-counting, authority-end, rooting, and the OUTPUT byte itself; measured against a mixed/interleaved matrix, not just isolated runs of one delimiter", async () => {
  const path = await build("backslash.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fileURLToPath('file:///tmp/a\\\\b'));", // raw \ IN the path, mid-segment
    "console.log(fileURLToPath('file:\\\\tmp\\\\x'));", // 0-slash host-less, all-backslash
    "console.log(fails('file:\\\\/tmp/x'));", // exactly-2 mixed delimiter (\/) takes the AUTHORITY branch, not the >2 bucket — host "tmp", not localhost
    "console.log(fails('file:\\\\\\\\tmp\\\\x'));", // 2 raw backslashes = 2-slash authority form, host "tmp"
    "console.log(fileURLToPath('file://localhost\\\\tmp\\\\x'));", // AUTH_END stops at \, not just /
    "console.log(fileURLToPath('file:////tmp\\\\x'));", // >2-slash bucket, backslash in the leftover+path
    // A BARE %5C-survives row — no raw backslash involved at all, so
    // this isolates "an escaped backslash is a decoded BYTE, never
    // touched by raw-byte normalization" from the ordering proof below,
    // which mixes a raw \ with an escaped %5C in the same input.
    "console.log(fileURLToPath('file:///tmp/a%5cb'));",
    // CTRL.bs-mixed: ordering proof — ONE raw \ normalizes to ONE '/',
    // the escaped %5C right after it survives untouched (own measurement:
    // "/tmp/a/b\c", a SINGLE slash between a and b — a relayed lead
    // worked example for this exact input claimed a doubled slash;
    // re-measured independently against a fresh `node -e` AND against
    // rev-23's own hash-verified anchor-vs-node-matrix.txt, both agree on
    // single; flagged as a discrepancy, not silently built to the wrong
    // value or silently overridden without saying so).
    "console.log(fileURLToPath('file:///tmp/a\\\\b%5Cc'));",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "/tmp/a/b",
      "/tmp/x",
      'File URL host must be "localhost" or empty on linux',
      'File URL host must be "localhost" or empty on linux',
      "/tmp/x",
      "//tmp/x",
      "/tmp/a\\b",
      "/tmp/a/b\\c",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("fileURLToPathStr — backslash SCHEME position: each raw \\ counts as exactly one slash-form delimiter (0/1/2/3/4/5/6 leading \\-or-/ characters right after 'file:'), re-measured with SOURCE-LEVEL escapes only after an earlier relayed matrix carried a shell/JS two-layer escaping artifact on three of these exact rows (file:\\/tmp/x and file:\\\\tmp/x THROW, not '/tmp/x' — the false rows were in the WORKED EXAMPLE, not in this tier's own rule, which was already 'treat \\ exactly like /' throughout)", async () => {
  // Auto-generated escaping (own throwaway script, not hand-counted —
  // hand-counting backslash-doubling arithmetic is exactly the mistake
  // this whole correction round is about): N raw backslashes right after
  // "file:", N = 1..6, verified fresh against Node before being written
  // here (N=1 -> 1-slash form; N=2 -> 2-slash AUTHORITY form, THROWS,
  // host "tmp"; N=3 -> 3-slash form; N>=4 -> the >2 bucket, N-2 leftover
  // slash-equivalents prepended literally).
  const path = await build("backslash-scheme.ts", [
    "import { fileURLToPath } from 'node:url';",
    ...FAILS_HELPER,
    "console.log(fileURLToPath('file:\\\\tmp/x'));", // N=1
    "console.log(fails('file:\\\\\\\\tmp/x'));", // N=2
    "console.log(fileURLToPath('file:\\\\\\\\\\\\tmp/x'));", // N=3
    "console.log(fileURLToPath('file:\\\\\\\\\\\\\\\\tmp/x'));", // N=4
    "console.log(fileURLToPath('file:\\\\\\\\\\\\\\\\\\\\tmp/x'));", // N=5
    "console.log(fileURLToPath('file:\\\\\\\\\\\\\\\\\\\\\\\\tmp/x'));", // N=6
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "/tmp/x",
      'File URL host must be "localhost" or empty on linux',
      "/tmp/x",
      "//tmp/x",
      "///tmp/x",
      "////tmp/x",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
