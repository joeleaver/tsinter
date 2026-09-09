/* INC-25 pass P5 — uri.ts's own pins: the URI component codecs
 * (str.encodeUriComponent/str.encodeUri/str.decodeUriComponent) and
 * (D5) the WHATWG base64 globals (str.atob/str.btoa). A SEPARATE file
 * from wasm-url.test.ts (S060's own neighbour, file-URL parsing) even
 * though both throw the tier's "no URIError class, throw by literal
 * name" shape — CP1 §11's own stated reason: different subsystems, and
 * a shared file would conflate them.
 *
 * Every expected value below is COMPUTED FROM NODE IN-PROCESS (this
 * file runs under node/vitest), never transcribed — D5's whole point
 * for atob/btoa, and CP1 §11's design for everything else this pass's
 * own corpus members do not cover: the full 128-point ASCII sweep
 * (2191 covers eight short strings), the lone-surrogate encode arm (NO
 * corpus program reaches it — M-4's own point, CP1 §12), the half-hex
 * %2Z row (confirmed absent from 2140's own `bad` array — CP1 addendum
 * §B3/E10), fromCharCode's coercion corners beyond 1427's five, and all
 * of atob/btoa (D5 — no corpus program reaches either key).
 *
 * THE VALUE PATH: every atob/btoa instrument run so far in this pass —
 * rev's ~2.9M-attempt fuzz, the lead's ~320K, and this file's own
 * pre-erratum 27-row dataset — is ERROR-SELECTION ONLY (lead-atob-rule-
 * p5-v3.txt, 056a97b7c88797b3931b4e9877e11cc577ed9a816c7c4c04a36855fcd
 * ffc7f68, its own "what remains untested" item (c)). This file is the
 * FIRST instrument anywhere in the pass to assert DECODED VALUES, not
 * just which error text fires. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-uri-"));
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

/** Node's own answer for a throwing expression, in the SAME format the
 * compiled program's own try/catch prints ("no-throw:<value>" or
 * "<name>:<message>") — computed by calling the SAME Node builtin
 * directly, never transcribed. */
function tryFmt(fn: () => string): string {
  try {
    return `no-throw:${fn()}`;
  } catch (e) {
    return `${(e as Error).name}:${(e as Error).message}`;
  }
}

/* ── (1) the 128-point ASCII sweep — both encoders, every code point ── */

test("encodeURI/encodeURIComponent — all 128 ASCII code points, byte-exact vs Node computed in-process (2191 covers eight short strings; this is exhaustive)", async () => {
  const lines: string[] = [];
  for (let cp = 0; cp < 128; cp++) {
    lines.push(`console.log(encodeURI(String.fromCharCode(${cp})));`);
    lines.push(`console.log(encodeURIComponent(String.fromCharCode(${cp})));`);
  }
  const path = await build("ascii128.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected: string[] = [];
  for (let cp = 0; cp < 128; cp++) {
    const ch = String.fromCharCode(cp);
    expected.push(encodeURI(ch));
    expected.push(encodeURIComponent(ch));
  }
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
  // M-8's witness (D-2): a control-character row whose hex pair has a
  // LETTER digit — this is the row the "lowercase instead of uppercase"
  // mutation actually reddens (cp=10, LF, "%0A" — the FIRST row after
  // the case-invariant 0x00-0x09 run) — concrete, not only reasoned.
  expect(expected[10 * 2]).toBe("%0A");
});

test("multi-byte and astral code points — both encoders agree, byte-exact vs Node (é, €, ☃, 💩, 𝒳)", async () => {
  const chars = ["é", "€", "☃", "\u{1f4a9}", "\u{1d4b3}"];
  const lines: string[] = [];
  for (const ch of chars) {
    lines.push(`console.log(encodeURI(${JSON.stringify(ch)}));`);
    lines.push(`console.log(encodeURIComponent(${JSON.stringify(ch)}));`);
  }
  const path = await build("multibyte.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected: string[] = [];
  for (const ch of chars) {
    expected.push(encodeURI(ch));
    expected.push(encodeURIComponent(ch));
  }
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
});

/* ── (2) the lone-surrogate encode arm — CORPUS-UNREACHABLE (M-4) ───── */

test("lone-surrogate encode arm — both encoders throw URIError \"URI malformed\", byte-exact vs Node — CORPUS-UNREACHABLE (M-4: no candidate calls either encoder with a literal lone surrogate; this file is the only witness)", async () => {
  // Each row's char codes, built directly (not derived) so the compiled
  // program's own `String.fromCharCode(...)` argument list and the
  // Node-side reference string are unambiguously the SAME code units.
  const rows: Array<[string, number[]]> = [
    ["high alone", [0xd800]],
    ["low alone", [0xdc00]],
    ["high + ascii after", [0xd800, 0x41]],
    ["ascii + high before", [0x41, 0xd800]],
    ["low + ascii after", [0xdc00, 0x41]],
    ["ascii + low before", [0x41, 0xdc00]],
    ["reversed pair", [0xdc00, 0xd800]],
  ];
  const lines: string[] = [];
  const expected: string[] = [];
  for (const [, codes] of rows) {
    const s = String.fromCharCode(...codes);
    const arg = `String.fromCharCode(${codes.join(", ")})`;
    lines.push(
      `try { console.log("no-throw:" + encodeURI(${arg})); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }`,
    );
    lines.push(
      `try { console.log("no-throw:" + encodeURIComponent(${arg})); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }`,
    );
    expected.push(tryFmt(() => encodeURI(s)));
    expected.push(tryFmt(() => encodeURIComponent(s)));
  }
  const path = await build("lonesurrogate.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
});

/* ── (3) decodeURIComponent's grammar — every malformed row ─────────── */

test("decodeURIComponent — every malformed row throws URIError \"URI malformed\", byte-exact vs Node, INCLUDING the half-hex %2Z case (E10: confirmed ABSENT from 2140's own `bad` array — corpus-uncovered, this file is its only witness)", async () => {
  const bad = [
    "%",
    "%2",
    "%zz",
    "%2Z",
    "%C3",
    "%C3x",
    "%C3%2F",
    "%E0%80%80",
    "%ED%A0%80",
    "%F4%90%80%80",
    "%FF",
    "%80",
    "abc%",
    "%A",
    "%GG",
  ];
  const lines = bad.map(
    (b) =>
      `try { console.log("no-throw:" + decodeURIComponent(${JSON.stringify(b)})); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }`,
  );
  const path = await build("decodebad.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = bad.map((b) => tryFmt(() => decodeURIComponent(b)));
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
});

test("decodeURIComponent — well-formed rows: lower/uppercase hex, multi-byte, astral surrogate-pair emission, the full ASCII escape set, raw non-ASCII beside an escape, byte-exact vs Node", async () => {
  const rows = [
    "a%2fb%2Fc",
    "no escapes at all",
    "mix é %C3%A9 raw",
    "%23%3F%2F%3A%40%26%3D%2B%24%2C",
    "%F0%9F%98%80",
    "é%41",
  ];
  const lines = rows.map((r) => `console.log(decodeURIComponent(${JSON.stringify(r)}));`);
  const path = await build("decodeok.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = rows.map((r) => decodeURIComponent(r));
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
  // The astral row: exactly one code point, UTF-16 length 2 (a surrogate
  // pair), never 4 (a byte-wise re-encoding) or 1 (a code-point count).
  expect(expected[4]!.length).toBe(2);
});

/* ── (4) String.fromCharCode's ToUint16 — corners beyond 1427's five ── */

test("String.fromCharCode — ToUint16 coercion corners beyond 1427's own five rows (NaN/±Infinity/±0/2^53 family), byte-exact vs Node", async () => {
  const lines = [
    "console.log(String.fromCharCode(0 / 0).charCodeAt(0));", // NaN -> 0
    "console.log(String.fromCharCode(1 / 0).charCodeAt(0));", // +Infinity -> 0
    "console.log(String.fromCharCode(-1 / 0).charCodeAt(0));", // -Infinity -> 0
    "console.log(String.fromCharCode(-0).charCodeAt(0));", // -0 -> 0
    "console.log(String.fromCharCode(2 ** 53).charCodeAt(0));", // 2^53 -> 0
    "console.log(String.fromCharCode(2 ** 53 + 1).charCodeAt(0));", // rounds to 2^53 -> 0
  ];
  const path = await build("fcccorners.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = [
    String.fromCharCode(0 / 0).charCodeAt(0),
    String.fromCharCode(1 / 0).charCodeAt(0),
    String.fromCharCode(-1 / 0).charCodeAt(0),
    String.fromCharCode(-0).charCodeAt(0),
    String.fromCharCode(2 ** 53).charCodeAt(0),
    String.fromCharCode(2 ** 53 + 1).charCodeAt(0),
  ];
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
});

/* ── (5) atob / btoa — the base64 family, VALUE-path included (D2) ──── */

test("atob/btoa — padding depths, over-padding, whitespace, non-alphabet, empty, and the DECODED VALUE at every depth — byte-exact vs Node (the value path: untested by every prior instrument in this pass, v3's own item (c))", async () => {
  const okRows = [
    ["QQ==", "atob"],
    ["QUI=", "atob"],
    ["QUJD", "atob"],
    [" Q Q = = ", "atob"],
    ["Q\tQ\n=\f=\r", "atob"],
    ["QUJD ", "atob"],
    ["", "atob"],
  ] as const;
  const lines = okRows.map(([r]) => `console.log(JSON.stringify(atob(${JSON.stringify(r)})));`);
  lines.push("console.log(btoa('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'));");
  lines.push(
    "console.log(atob(btoa('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')));",
  );
  const path = await build("b64ok.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = okRows.map(([r]) => JSON.stringify(atob(r)));
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  expected.push(btoa(table));
  expected.push(atob(btoa(table)));
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
  // The value path, explicitly: every leftover-bit depth decodes to the
  // EXACT byte sequence, not merely "does not throw".
  expect(JSON.parse(expected[0]!)).toBe("A"); // 1 byte, 4 leftover bits discarded
  expect(JSON.parse(expected[1]!)).toBe("AB"); // 2 bytes, 2 leftover bits discarded
  expect(JSON.parse(expected[2]!)).toBe("ABC"); // 3 bytes, no leftover
});

test("atob — the LEFTOVER-BIT DISCARD itself, isolated from the byte VALUE (v3's own item (c): no instrument anywhere in this pass — rev's ~2.9M attempts, the lead's ~320K, this file's own prior 27 rows — has varied this axis; all are error-selection only). For a fixed leading character, every trailing character whose HIGH bits agree must decode to the IDENTICAL byte regardless of its own low (discarded) bits — the plausible wrong implementation this row set exists to catch is a STRICT decoder that rejects nonzero leftover bits, which Node does NOT (measured: none of these throw)", async () => {
  // 2-char group (12 bits -> 1 byte, 4 leftover bits): Q/R/S/T all share
  // Q's own top-4-bit contribution (16..19, binary 0100xx) — Node computed
  // directly confirms all four decode to the SAME byte, leftover 0/1/2/3.
  const twoChar = ["QQ", "QR", "QS", "QT"];
  // 3-char group (18 bits -> 2 bytes, 2 leftover bits): same idea, one
  // level deeper — QQQ/QQR/QQS/QQT share both output bytes, leftover 0/1/2/3.
  const threeChar = ["QQQ", "QQR", "QQS", "QQT"];
  // The same groups, correctly padded — padding must not change the
  // answer (D5's own D is unaffected by a correct trailing '=' run).
  const padded2 = ["QQ==", "QR=="];
  const padded3 = ["QQQ=", "QQR="];
  const allRows = [...twoChar, ...threeChar, ...padded2, ...padded3];
  const lines = allRows.map((r) => `console.log(JSON.stringify(atob(${JSON.stringify(r)})));`);
  const path = await build("b64leftover.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = allRows.map((r) => JSON.stringify(atob(r)));
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
  // Every 2-char row answers the SAME single byte...
  for (const e of expected.slice(0, 4)) expect(e).toBe(expected[0]);
  // ...every 3-char row answers the SAME two bytes...
  for (const e of expected.slice(4, 8)) expect(e).toBe(expected[4]);
  // ...and padding changes nothing.
  expect(expected[8]).toBe(expected[0]); // "QQ==" === "QQ"
  expect(expected[9]).toBe(expected[1]); // "QR==" === "QR"
  expect(expected[10]).toBe(expected[4]); // "QQQ=" === "QQQ"
  expect(expected[11]).toBe(expected[5]); // "QQR=" === "QQR"
});

test("atob/btoa — every throwing row, exact name+message vs Node (over-padding, mod-4-length==1, non-alphabet, btoa's Latin-1 boundary and astral)", async () => {
  const rows: Array<[string, () => string]> = [
    ["QQ=== (over-padding)", () => atob("QQ===")],
    ["QQ= (mod-4 violation)", () => atob("QQ=")],
    ["Q (len 1)", () => atob("Q")],
    ["QQQQQ (len 5)", () => atob("QQQQQ")],
    ["Q Q Q Q Q (ws-stripped len 5)", () => atob("Q Q Q Q Q")],
    ["QQ!! (non-alphabet)", () => atob("QQ!!")],
    ["btoa over-Latin1 (U+0100)", () => btoa("Ā")],
    ["btoa astral", () => btoa("\u{1f4a9}")],
    ["btoa U+00FF (boundary, must NOT throw)", () => btoa("ÿ")],
  ];
  const lines = [
    'try { console.log("no-throw:" + atob("QQ===")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob("QQ=")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob("Q")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob("QQQQQ")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob("Q Q Q Q Q")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob("QQ!!")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + btoa("\\u0100")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + btoa("\\u{1F4A9}")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + btoa("\\u00FF")); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
  ];
  const path = await build("b64err.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = rows.map(([, fn]) => tryFmt(fn));
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
  // The two DIFFERENT DOMException messages (CP1 addendum §A5/E9): the
  // length text and the character text are NOT interchangeable.
  expect(expected[1]).toContain("Invalid character");
  expect(expected[2]).toContain("not correctly encoded");
});

test("atob — rev's six measured survivor rows (E6/CP1 addendum §A3/D-3): the LENGTH text, where EITHER WHATWG check order would wrongly answer CHARACTER — inputs only, expected values computed from Node", async () => {
  const survivors = ["Y=", "Y==", "YWJjZ=", "YWJjZ==", "YWJjZGVmZ=", "YWJjZGVmZ=="];
  const lines = survivors.map(
    (s) =>
      `try { console.log("no-throw:" + atob(${JSON.stringify(s)})); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }`,
  );
  const path = await build("b64survivors.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = survivors.map((s) => tryFmt(() => atob(s)));
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
  for (const line of expected) expect(line).toContain("not correctly encoded");
});

test("atob — the DYN-arrival probes (MEAS-11: Node's caller is literally `_atob(\\`${input}\\`)`), byte-exact vs Node — the observable cross-check of dynToStr's own coercion, since atob calls it as its first step (D1)", async () => {
  const rows: Array<[string, () => string]> = [
    ["null", () => atob(null as unknown as string)],
    ["undefined", () => atob(undefined as unknown as string)],
    ["42", () => atob(42 as unknown as string)],
    ["true", () => atob(true as unknown as string)],
    ["[] (empty array)", () => atob([] as unknown as string)],
    ['["a"]', () => atob(["a"] as unknown as string)],
    ["{} (plain object)", () => atob({} as unknown as string)],
    ["1e21 (stringifies '1e+21', not 21 zeros)", () => atob(1e21 as unknown as string)],
  ];
  const lines = [
    'try { console.log("no-throw:" + atob(null)); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob(undefined)); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob(42)); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob(true)); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob([])); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob(["a"])); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob({})); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
    'try { console.log("no-throw:" + atob(1e21)); } catch (e) { console.log((e as Error).name + ":" + (e as Error).message); }',
  ];
  const path = await build("b64dyn.ts", lines);
  const { stdout, stderr } = await runWasm(path);
  const expected = rows.map(([, fn]) => tryFmt(fn));
  expect(stdout).toBe(`${expected.join("\n")}\n`);
  expect(stderr).toBe("");
  // NOT covered here, confirmed unreachable rather than silently skipped:
  //   - atob(Symbol()): DK (dyn.ts) has no SYMBOL kind at all — a Symbol
  //     cannot arrive as a DYN argument on this tier.
  //   - an object with toString()/valueOf(): the frontend refuses this
  //     shape by name before any IR exists (SC2020, measured directly:
  //     "atob with a '{ toString: () => string }' argument... has no
  //     scriptc lowering yet") — MEAS-11's toString-vs-valueOf
  //     distinction is therefore also unreachable, not merely untested.
});
