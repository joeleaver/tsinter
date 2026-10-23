/* node:querystring on the WasmGC tier (querystring.ts): the oracle rows.
 * Each row compiles a driver program over an input list, runs the module
 * on the shared test host, and compares every output line with Node
 * v24.18.1's own node:querystring computing the same thing IN-PROCESS
 * (this process is the oracle's runtime) — the input lists supply inputs
 * only, never expected answers. Then the null-prototype refusal rows: the
 * three readers of a parse result that would show its missing prototype
 * refuse by name, and the same shapes in a module without qs.parse are
 * unaffected. Every row names the single edit that would make it fail. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as querystring from "node:querystring";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-qs-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
async function build(src: string, ext: string): Promise<Awaited<ReturnType<typeof compile>>> {
  const file = join(scratch, `p${seq++}.${ext}`);
  await writeFile(file, src);
  return compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
}
async function run(src: string, ext = "ts"): Promise<string[]> {
  const res = await build(src, ext);
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  const r = await runWasm(res.binaryPath);
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
  return r.stdout.split("\n").slice(0, -1);
}
/** The one SC3001 refusal a module must answer with. */
async function refusal(src: string, ext = "ts"): Promise<string> {
  const res = await build(src, ext);
  expect(res.ok).toBe(false);
  expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
  return /\(([^)]+)\)/.exec(res.diagnostics[0]!.message)?.[1] ?? "?";
}

/** Compare line for line, naming each input that differs. */
function same(inputs: readonly unknown[], got: string[], want: string[]): void {
  const bad: string[] = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) bad.push(`${JSON.stringify(inputs[i])}\n  wasm: ${got[i]}\n  node: ${want[i]}`);
  }
  expect(bad.slice(0, 30).join("\n"), `${bad.length} of ${want.length} lines differ`).toBe("");
  expect(got.length).toBe(inputs.length);
}

/** A TS source literal for a string (JSON escapes lone surrogates). */
const lit = (s: string): string => JSON.stringify(s);
/** A TS source literal for a number, NaN and the infinities included. */
const num = (n: number): string => (Number.isNaN(n) ? "NaN" : n === Infinity ? "Infinity" : n === -Infinity ? "-Infinity" : Object.is(n, -0) ? "-0" : String(n));

/** A deterministic generator (xorshift32) for the input sweeps. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}
function sweep(alphabet: readonly string[], count: number, maxLen: number, seed: number): string[] {
  const r = rng(seed);
  const out = new Set<string>([""]);
  for (const a of alphabet) out.add(a);
  while (out.size < count) {
    const n = 1 + Math.floor(r() * maxLen);
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)]!;
    out.add(s);
  }
  return [...out];
}

/* ── parse ───────────────────────────────────────────────────────────── */

const PARSE_ALPHABET = ["a", "b", "=", "&", "+", "%", "2", "B", "f", "F", "g", "%41", "%2B", "%E2%98%83", "%FF", "%ED%A0%80", "☃", "😀", "\ud800", "\udc00", ";", ":", " "];

type ParseCase = [string, string | null, string | null, number | null];
function parseDriver(cases: readonly ParseCase[]): string {
  // A null separator rides as "" (Node's `!sep` rule makes the two one
  // case; the corpus programs pin the literal null and undefined forms).
  const rows = cases.map(([s, sep, eq, mk]) => `  [${lit(s)}, ${lit(sep ?? "")}, ${lit(eq ?? "")}, ${mk === null ? "null" : num(mk)}],`);
  return `import { parse } from "node:querystring";
const CASES: [string, string, string, number | null][] = [
${rows.join("\n")}
];
for (const c of CASES) {
  const mk = c[3];
  const r = mk === null ? parse(c[0], c[1], c[2]) : parse(c[0], c[1], c[2], { maxKeys: mk });
  console.log(JSON.stringify(r) + " " + JSON.stringify(Object.keys(r)));
}
`;
}
function parseLine([s, sep, eq, mk]: ParseCase): string {
  const r = mk === null ? querystring.parse(s, sep, eq) : querystring.parse(s, sep, eq, { maxKeys: mk });
  return JSON.stringify(r) + " " + JSON.stringify(Object.keys(r));
}
async function parseRow(cases: readonly ParseCase[]): Promise<void> {
  same(cases, await run(parseDriver(cases)), cases.map(parseLine));
}

describe("qs.parse against Node in-process", () => {
  test("QS-P-01 the default separators over a 300-input grammar sweep (repeats, '+', escapes valid and malformed, the encodeCheck fast path, non-ASCII, astral and lone-surrogate input, integer-like key order) — SINGLE-EDIT: any arm of the parse scan or addKeyVal", async () => {
    await parseRow(sweep(PARSE_ALPHABET, 300, 10, 2460).map((s): ParseCase => [s, null, null, null]));
  }, 120000);

  test("QS-P-02 separators: multi-unit, overlapping, astral and empty-string (the default) sep and eq crossed with a sweep — SINGLE-EDIT: the naive partial-match reset or the falsy default", async () => {
    const seps: [string | null, string | null][] = [
      [";", ":"], ["&&", "=="], ["XYX", null], ["ab", "b"], ["", ""], [null, "=="], ["🌍", "☃"], ["&", "&"], ["=", "&"], ["aa", "a"], ["\ud800", "\udc00"], ["😀", "😀="],
    ];
    const inputs = sweep(["a", "b", "=", "&", ";", ":", "X", "Y", "🌍", "☃", "+", "%41", "\ud800", "\udc00", "😀"], 40, 12, 2461);
    const cases: ParseCase[] = [];
    for (const [sep, eq] of seps) for (const s of inputs) cases.push([s, sep, eq, null]);
    await parseRow(cases);
  }, 120000);

  test("QS-P-03 maxKeys: absent, 0, -1, 1, 2, 0.5, 1.5, NaN, Infinity, -Infinity, 1000 over inputs with empty segments (which spend the budget) — SINGLE-EDIT: pairs' > 0 test or spending it on an empty segment", async () => {
    const inputs = ["a=1&b=2&c=3", "&&&a=1&b=2", "a=1&&b=2&c=3", "a=1&a=2&a=3&b=4", "", "&", "a", "a&b&c&d&e"];
    const keys: (number | null)[] = [null, 0, -1, 1, 2, 0.5, 1.5, NaN, Infinity, -Infinity, 1000, 3];
    const cases: ParseCase[] = [];
    for (const mk of keys) for (const s of inputs) cases.push([s, null, null, mk]);
    await parseRow(cases);
  }, 120000);

  test("QS-P-04 the result reads as the dictionary record: a repeat narrows to its array bucket in place, a single to the string arm, an absent key to undefined, for-in order — SINGLE-EDIT: the in-place array replacement", async () => {
    const got = await run(`import { parse } from "node:querystring";
const r = parse("k=1&z=2&k=3&k=4&1=x&0=y");
const k = r["k"];
if (Array.isArray(k)) console.log("arr", k.length, k.join(","));
const z = r["z"];
if (typeof z === "string") console.log("str", z);
console.log(r["none"] === undefined);
for (const key in r) console.log("key", key);
console.log(Object.keys(r).join(","), JSON.stringify(r));
`);
    const r = querystring.parse("k=1&z=2&k=3&k=4&1=x&0=y");
    const want = [`arr 3 ${(r["k"] as string[]).join(",")}`, `str ${r["z"]}`, "true", ...Object.keys(r).map((k) => `key ${k}`), `${Object.keys(r).join(",")} ${JSON.stringify(r)}`];
    expect(got).toEqual(want);
  }, 60000);
});

/* ── stringify ───────────────────────────────────────────────────────── */

describe("qs.stringify against Node in-process", () => {
  // Each case is JavaScript source for the object and the sep / eq
  // arguments; the driver is CommonJS, so the objects are dynamic values.
  const CASES: [string, string, string][] = [
    ["{ a: 1, b: 'x y', c: ['1', '2'], d: true, e: '' }", "undefined", "undefined"],
    ["{ a: Infinity, b: NaN, c: -0, d: 1e21, e: 0.1, f: -1.5, g: 1e-7, h: -1e21, i: 123456789012345680000 }", "undefined", "undefined"],
    ["{ 'a b': 'c', '☃': '+', '': 'empty', k: '', '😀': '😀' }", "undefined", "undefined"],
    ["{}", "undefined", "undefined"],
    ["{ a: [], b: 'x' }", "undefined", "undefined"],
    ["{ a: [], b: [] }", "undefined", "undefined"],
    ["{ b: 'x', a: [] }", "undefined", "undefined"],
    ["{ a: ['x', 'y'] }", "';'", "':'"],
    ["{ a: '1', b: '2' }", "''", "''"],
    ["{ u: undefined, n: null, s: 'v', o: { x: 1 }, f: function () {}, arr: [[1], {}, null, undefined, 'z'] }", "undefined", "undefined"],
    ["{ a: [1, 2.5, true, false] }", "'&&'", "'=='"],
    ["{ 'é☃': 'é☃ 😀', x: \"!'()*-._~\" }", "'☃'", "'🌍'"],
    ["{ 2: 'two', 1: 'one', b: 'b', a: 'a', 10: 'ten' }", "undefined", "undefined"],
    ["['a', 'b', ['c', 'd']]", "undefined", "undefined"],
    ["'abc'", "undefined", "undefined"],
    ["42", "undefined", "undefined"],
    ["null", "undefined", "undefined"],
    ["undefined", "undefined", "undefined"],
    ["true", "undefined", "undefined"],
    ["function () {}", "undefined", "undefined"],
    ["{ '%': '%25', '+': '+', '&': '=', '\\u0000': '\\u007f' }", "undefined", "undefined"],
    ["{ a: '\\ud83d\\ude00', b: '\\udc00\\ud800x', c: '\\ud800a' }", "undefined", "undefined"],
    ["{ k: 'v' }", "null", "null"],
  ];
  test("QS-S-01 a dynamic-object sweep: encodeStringified's value rules, array expansion and empty arrays, custom and default separators, own-key order, a dynamic array as the object, non-objects — SINGLE-EDIT: any arm of valueInto or the separator logic", async () => {
    // An untyped function's result is a dynamic value.
    const src = `'use strict';\nconst qs = require('querystring');\nfunction d(o) { return o; }\n` + CASES.map(([o, sep, eq]) => `console.log(JSON.stringify(qs.stringify(d(${o}), ${sep}, ${eq})));`).join("\n") + "\n";
    const got = await run(src, "cjs");
    // eslint-disable-next-line no-new-func
    const want = CASES.map(([o, sep, eq]) => JSON.stringify(new Function("qs", `return qs.stringify(${o}, ${sep}, ${eq});`)(querystring)));
    same(CASES, got, want);
  }, 60000);

  test("QS-S-02 typed records cross as dynamic values: declared fields, optional and null fields, index-signature records and the parse round trip — SINGLE-EDIT: the qs.stringify arm's direct dynFrom", async () => {
    const got = await run(`import { parse, stringify } from "node:querystring";
const o: { u?: string; s: string; n: number | null; b: boolean } = { u: undefined, s: "v w", n: null, b: false };
console.log(stringify(o));
const r: Record<string, string | string[]> = {};
r["z"] = "1";
r["m"] = ["a", "b"];
console.log(stringify(r, "|", "~"));
console.log(stringify(parse("a=1&a=2&b=x%20y&c=&%E2%98%83=%F0%9F%98%80")));
`);
    const r: Record<string, string | string[]> = { z: "1", m: ["a", "b"] };
    expect(got).toEqual([
      querystring.stringify({ u: undefined, s: "v w", n: null, b: false }),
      querystring.stringify(r, "|", "~"),
      querystring.stringify(querystring.parse("a=1&a=2&b=x%20y&c=&%E2%98%83=%F0%9F%98%80")),
    ]);
  }, 60000);

  test("QS-S-03 a key or value ending in a surrogate throws Node's URIError [ERR_INVALID_URI] out of stringify, catchably — SINGLE-EDIT: valueInto or the key's encode ignoring encodeInto's failure", async () => {
    const got = await run(`'use strict';
const qs = require('querystring');
function d(o) { return o; }
function s(o) {
  try { console.log(qs.stringify(o)); } catch (e) { console.log(e.name, e.code, e.message, String(e)); }
}
s(d({ k: 'a\\ud800' }));
s(d({ 'x\\udc00': 'v' }));
s(d({ k: ['ok', 'b\\ud800'] }));
`, "cjs");
    const want: string[] = [];
    for (const o of [{ k: "a\ud800" }, { ["x\udc00"]: "v" }, { k: ["ok", "b\ud800"] }]) {
      try {
        want.push(querystring.stringify(o));
      } catch (e) {
        const x = e as Error & { code: string };
        want.push(`${x.name} ${x.code} ${x.message} ${String(x)}`);
      }
    }
    expect(got).toEqual(want);
  }, 60000);
});

describe("qs.stringify of an object literal with accessors refuses by name (every lane)", () => {
  const WHAT = "get/set accessors in a querystring.stringify object literal";
  test("QS-S-04 a get accessor in the literal refuses where its value would silently drop (Node: g=got&a=1): at compile time in TypeScript on wasm and c, as the deferred JS fence in CommonJS — SINGLE-EDIT: lowerQuerystringStringifyCall's accessor check", async () => {
    const ts = `import * as qs from "node:querystring";\nconsole.log(qs.stringify({ get g() { return "got"; }, a: 1 }));\n`;
    expect(querystring.stringify({ get g() { return "got"; }, a: 1 })).toBe("g=got&a=1");
    for (const backend of ["wasm", "c"] as const) {
      const file = join(scratch, `p${seq++}.ts`);
      await writeFile(file, ts);
      const res = await compile(file, { outPath: `${file}.${backend}`, outDir: scratch, dynamic: false, backend });
      expect(res.ok).toBe(false);
      expect(res.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([`SC1090 ${WHAT} is not supported yet`]);
    }
    const res = await build(`'use strict';\nconst qs = require('querystring');\nconsole.log('before');\nconsole.log(qs.stringify({ get g() { return 'got'; }, a: 1 }));\n`, "cjs");
    if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
    // The fence reports by name, then traps (the tier's exit-1 channel).
    const r = await runWasmToTrap(res.binaryPath);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toContain(`Uncaught Error: ${WHAT} is not supported yet [SC1090`);
  }, 120000);
});

/* ── escape / unescape ───────────────────────────────────────────────── */

describe("qs.escape and qs.unescape against Node in-process", () => {
  test("QS-E-01 escape over the whole BMP outside the surrogates, 256 code units per line — SINGLE-EDIT: the noEscape table or a UTF-8 width boundary", async () => {
    const got = await run(`import { escape } from "node:querystring";
for (let b = 0; b < 65536; b += 256) {
  const units: string[] = [];
  for (let c = b; c < b + 256; c++) if (c < 0xd800 || c > 0xdfff) units.push(String.fromCharCode(c));
  console.log(escape(units.join("")));
}
`);
    const want: string[] = [];
    const blocks: number[] = [];
    for (let b = 0; b < 65536; b += 256) {
      let s = "";
      for (let c = b; c < b + 256; c++) if (c < 0xd800 || c > 0xdfff) s += String.fromCharCode(c);
      want.push(querystring.escape(s));
      blocks.push(b);
    }
    same(blocks, got, want);
  }, 120000);

  test("QS-E-02 surrogates: encodeStr pairs ANY surrogate with the unit after it unchecked, and throws URIError [ERR_INVALID_URI] (code, name, message, String) only for a surrogate in the last position — SINGLE-EDIT: validating the trail unit, or the end-of-string check", async () => {
    const inputs = ["\ud800", "\udc00", "a\ud800", "\ud800a", "\udc00x", "\udc00\ud800", "😀", "x\udc00", "\ud800\ud800", "\ud800\ud800\ud800", "é\udfff", "􏿿", "\ud800 ", "a\ud800b\udc00"];
    const got = await run(`'use strict';
const qs = require('querystring');
for (const s of ${JSON.stringify(inputs)}) {
  try { console.log(qs.escape(s)); } catch (e) { console.log('X', e.name, e.code, e.message, String(e)); }
}
`, "cjs");
    const want = inputs.map((s) => {
      try {
        return querystring.escape(s);
      } catch (e) {
        const x = e as Error & { code: string };
        return `X ${x.name} ${x.code} ${x.message} ${String(x)}`;
      }
    });
    same(inputs, got, want);
  }, 60000);

  test("QS-U-01 unescape over a 400-input sweep of escapes valid and malformed, invalid UTF-8, '+', non-ASCII units (unescapeBuffer's low-byte truncation) and lone surrogates — SINGLE-EDIT: the strict-then-lenient fallback", async () => {
    const inputs = sweep(["%", "4", "1", "E2", "98", "83", "%ED", "%A0", "%80", "%FF", "%c3", "%a9", "G", "+", "a", "é", "☃", "😀", "\ud800", "%2", "%%"], 400, 8, 2463);
    const got = await run(`import { unescape } from "node:querystring";
const INPUTS: string[] = ${JSON.stringify(inputs)};
for (const s of INPUTS) console.log(JSON.stringify(unescape(s)));
`);
    same(inputs, got, inputs.map((s) => JSON.stringify(querystring.unescape(s))));
  }, 60000);
});

/* ── the null-prototype refusals ─────────────────────────────────────── */

describe("qs.parse's null-prototype result refuses by name where it would show", () => {
  test("QS-N-01 printing a parse result refuses (console.log, util.inspect, util.format, nested in an array, CommonJS) — Node prints [Object: null prototype] — SINGLE-EDIT: the %util.insp gate in the function walk", async () => {
    expect(await refusal(`import { parse } from "node:querystring";\nconsole.log(parse("a=1"));\n`)).toBe("libCall:qs.parse:null-proto-inspect");
    expect(await refusal(`import { parse } from "node:querystring";\nimport { inspect } from "node:util";\nconsole.log(inspect(parse("a=1")).length);\n`)).toBe("libCall:qs.parse:null-proto-inspect");
    expect(await refusal(`import { parse } from "node:querystring";\nimport { format } from "node:util";\nconsole.log(format("%o", parse("a=1")).length);\n`)).toBe("libCall:qs.parse:null-proto-inspect");
    expect(await refusal(`import { parse } from "node:querystring";\nconsole.log([parse("a=1")]);\n`)).toBe("libCall:qs.parse:null-proto-inspect");
    expect(await refusal(`'use strict';\nconst qs = require('querystring');\nconst p = qs.parse('a=1&b=2&b=3');\nconsole.log(p);\n`, "cjs")).toBe("libCall:qs.parse:null-proto-inspect");
    expect(inspect(querystring.parse("a=1"))).toBe("[Object: null prototype] { a: '1' }");
  }, 60000);

  test("QS-N-02 converting a parse result to a string refuses (String(), a template, concatenation, CommonJS) — Node throws TypeError: Cannot convert object to primitive value — SINGLE-EDIT: the record ToString arm's gate", async () => {
    expect(await refusal(`import { parse } from "node:querystring";\nconsole.log(String(parse("a=1")));\n`)).toBe("libCall:qs.parse:null-proto-tostring");
    expect(await refusal(`import { parse } from "node:querystring";\nconst p = parse("a=1");\nconsole.log(\`\${p}\`);\n`)).toBe("libCall:qs.parse:null-proto-tostring");
    expect(await refusal(`import { parse } from "node:querystring";\nconst p = parse("a=1");\nconsole.log("x" + p);\n`)).toBe("libCall:qs.parse:null-proto-tostring");
    expect(await refusal(`'use strict';\nconst qs = require('querystring');\nconst p = qs.parse('a=1');\nconsole.log(\`\${p}\`);\n`, "cjs")).toBe("libCall:qs.parse:null-proto-tostring");
    expect(() => String(querystring.parse("a=1"))).toThrow("Cannot convert object to primitive value");
  }, 60000);

  test("QS-N-03 a parse result becoming a dynamic value refuses (an unknown binding, nested in an array) — Node's copy would have no hasOwnProperty — SINGLE-EDIT: the dynFromHelper gate", async () => {
    expect(await refusal(`import { parse } from "node:querystring";\nconst u: unknown = parse("a=1");\nconsole.log(typeof u);\n`)).toBe("libCall:qs.parse:null-proto-dyn");
    expect(await refusal(`import { parse } from "node:querystring";\nconst u: unknown = [parse("a=1")];\nconsole.log(typeof u);\n`)).toBe("libCall:qs.parse:null-proto-dyn");
    // The one direct conversion stays open: stringify(parse(..)).
    expect(await run(`import { parse, stringify } from "node:querystring";\nconsole.log(stringify(parse("a=1&a=2")));\n`)).toEqual([querystring.stringify(querystring.parse("a=1&a=2"))]);
  }, 60000);

  test("QS-N-05 a parse result copied into ANOTHER record shape refuses at the copy (a cast, an annotated binding, a function return, an array-wrapped print) — Node keeps the one null-prototype object, so the copy's shape would escape the three gates — SINGLE-EDIT: the %rec.capture / %rec.width gate in the function walk", async () => {
    expect(await refusal(`import * as qs from "node:querystring";\nconst r = qs.parse("a=1") as Record<string, string>;\nconsole.log(String(r));\n`)).toBe("libCall:qs.parse:null-proto-reshape");
    expect(await refusal(`import * as qs from "node:querystring";\nconst r: { [k: string]: unknown } = qs.parse("a=1");\nconsole.log(r);\n`)).toBe("libCall:qs.parse:null-proto-reshape");
    expect(await refusal(`import * as qs from "node:querystring";\nfunction f(): { [k: string]: unknown } { return qs.parse("a=1"); }\nconsole.log(\`\${f()}\`);\n`)).toBe("libCall:qs.parse:null-proto-reshape");
    expect(await refusal(`import * as qs from "node:querystring";\nconst rr = qs.parse("x=1") as { [k: string]: string };\nconsole.log([rr]);\n`)).toBe("libCall:qs.parse:null-proto-reshape");
  }, 60000);

  test("QS-N-04 the same dictionary shapes in a module that never reaches qs.parse print, convert and box exactly as before (ParsedUrlQuery-typed and plain dictionaries) — SINGLE-EDIT: the gates ignoring qs.parse reachability", async () => {
    const got = await run(`import type { ParsedUrlQuery } from "node:querystring";
import { stringify } from "node:querystring";
const q: ParsedUrlQuery = { a: "1", b: ["2", "3"] };
console.log(q);
console.log(String(q), \`\${q}\`);
const u: unknown = q;
console.log(typeof u, stringify(q));
const d: { [k: string]: string | string[] } = { x: "y" };
console.log(d, String(d));
`);
    const q: querystring.ParsedUrlQuery = { a: "1", b: ["2", "3"] };
    const d: { [k: string]: string | string[] } = { x: "y" };
    expect(got).toEqual([inspect(q), `${String(q)} ${String(q)}`, `object ${querystring.stringify(q)}`, `${inspect(d)} ${String(d)}`]);
  }, 60000);
});
