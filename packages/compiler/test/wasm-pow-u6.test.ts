/* INC-27 unit U6 — `**`, all of it. Rows for the helper %w.jsPow and its core
 * (emitter.ts jsPowHelper, pow.ts, pow-tables.ts; SEMANTICS.md S079):
 *   - the ECMA-262 special-value ladder for every finite exponent (x = ±0,
 *     ±Infinity, ±1; a negative base with a non-integer exponent);
 *   - V8's two exponent pre-cases, y = 2 → x*x and y = 0.5 → sqrt(x + 0),
 *     on inputs where the C library's pow answers differently, and the
 *     |x| = 1, infinite-y NaN;
 *   - the core, glibc's pow as Node calls it on Linux x86-64 with an FMA CPU:
 *     bit tables over every overflow/underflow branch, integer exponents,
 *     negative bases, the thresholds, y = -1 where Node's answer is not 1/x,
 *     and inputs where a correctly rounded answer would differ from Node's;
 *   - one row per a*b+c site whose fusion (or non-fusion) in glibc's FMA build
 *     changes an answer (FMA), so each site's exact fused multiply-add is
 *     pinned by an input that depends on it;
 *   - the any/dyn route, the literal fold against the same operands at run
 *     time, the static shapes (`**`, `**=`, a generic, a method), the
 *     lockstep of the two transcriptions in pow.ts, and what stays refused.
 *
 * Every expected output below is an INLINED literal: the stdout of a Node v24
 * run (`node --experimental-transform-types`) of the SAME source, byte for
 * byte, with exit code 0. Tables print each result as its IEEE-754 bit
 * pattern, or `NaN` — a NaN is compared as a class, because its payload is
 * S036's matter (board #158) — plus ` IS-NEG-ZERO` for -0. The native lanes
 * call the C library's pow without V8's pre-cases and do not fold, so on the
 * rows marked board #207 they print other bits than Node; these rows pin this
 * tier. Nothing outside this repository is read at test time; corpus rows read
 * tests/corpus through a relative path. Row classes, in file order: CORPUS,
 * LADDER, V8PRE, CORE, FMA, DYN, FOLD, LOCKSTEP, STATIC, NOT-LIFTED. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript5";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { SITE } from "../src/backend/wasm/pow.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-pow-u6-"));
  await mkdir(join(scratch, "esm"));
  await writeFile(join(scratch, "esm", "package.json"), '{"type":"module"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A `// @dynamic` head builds with --dynamic (the differential harness's own rule). */
function isDynamic(src: string): boolean {
  return /^\/\/ @dynamic\s*$/m.test(src.split("\n", 2).join("\n"));
}

/** Each row's source is written byte for byte as it was run under Node; one compile per row. */
async function build(id: string, src: string) {
  const dir = join(scratch, "esm");
  const entry = join(dir, `${id}.ts`);
  await writeFile(entry, src);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  return { entry, res };
}

async function runRow(id: string, src: string): Promise<{ stdout: string; stderr: string; exitCode: number; module: Buffer }> {
  const { res } = await build(id, src);
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode, module: readFileSync(res.binaryPath) };
}

async function refuseRow(id: string, src: string): Promise<{ diagnostics: string[]; survey: string[] }> {
  const { entry, res } = await build(id, src);
  if (res.ok) throw new Error(`${id} compiled but was expected to refuse`);
  return {
    diagnostics: [...new Set(res.diagnostics.map((d) => `${d.code}: ${d.message}`.split(entry).join("<ROW>")))].sort(),
    survey: [...(res.wasmSurvey ?? [])].sort(),
  };
}

async function runCorpusRow(id: string, relPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = fileURLToPath(new URL(`../../../tests/corpus/${relPath}`, import.meta.url));
  const src = await readFile(entry, "utf8");
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic: isDynamic(src) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

/** pow.ts's tokens (the repo's own TypeScript scanner: comments and strings
 * are single tokens, never matched by text). */
function powTokens(): { kind: ts.SyntaxKind; text: string; pos: number }[] {
  const path = fileURLToPath(new URL("../src/backend/wasm/pow.ts", import.meta.url));
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, readFileSync(path, "utf8"));
  const out: { kind: ts.SyntaxKind; text: string; pos: number }[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) out.push({ kind: k, text: scanner.getTokenText(), pos: scanner.getTokenPos() });
  return out;
}

/** The (wrapper, site) pairs `<wrapper> ( SITE . <id>` between the tokens `function <from>` and the next `function <to>`. */
function sitePairs(tokens: { kind: ts.SyntaxKind; text: string }[], from: string, to: string | null): string[] {
  const start = tokens.findIndex((t, i) => t.text === "function" && tokens[i + 1]?.text === from);
  const end = to === null ? tokens.length : tokens.findIndex((t, i) => i > start && t.text === "function" && tokens[i + 1]?.text === to);
  expect(start, `function ${from} not found`).toBeGreaterThanOrEqual(0);
  expect(end, `function ${to} not found`).toBeGreaterThan(start);
  const pairs: string[] = [];
  for (let i = start + 2; i < end - 3; i++) {
    if (tokens[i]!.text === "SITE" && tokens[i + 1]!.kind === ts.SyntaxKind.DotToken) {
      expect(tokens[i - 1]!.kind, `SITE.${tokens[i + 2]!.text} is not a call's first argument`).toBe(ts.SyntaxKind.OpenParenToken);
      pairs.push(`${tokens[i - 2]!.text} ${tokens[i + 2]!.text}`);
    }
  }
  return pairs.sort();
}

/** Tokens of `text` that could reach the host's own pow: a `**` or `**=` operator, or any `Math` other than
 * Math.abs / Math.sqrt / Math.trunc (so Math.pow, Math["pow"] and an aliased Math are all caught). Strings and
 * comments are single tokens and never match. */
function hostPowUses(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const t: { kind: ts.SyntaxKind; text: string }[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) t.push({ kind: k, text: scanner.getTokenText() });
  const hits: string[] = [];
  t.forEach((tok, i) => {
    if (tok.kind === ts.SyntaxKind.AsteriskAsteriskToken || tok.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken) hits.push(tok.text);
    if (tok.text === "Math") {
      const member = t[i + 1]?.kind === ts.SyntaxKind.DotToken ? t[i + 2]?.text : undefined;
      if (member !== "abs" && member !== "sqrt" && member !== "trunc") hits.push(`Math${t[i + 1]?.text ?? ""}${t[i + 2]?.text ?? ""}`);
    }
  });
  return hits;
}

/** The text of emitter.ts's tryFoldFloatConst, from its declaration to its matching close brace (by tokens). */
function tryFoldFloatConstText(): string {
  const text = readFileSync(fileURLToPath(new URL("../src/backend/wasm/emitter.ts", import.meta.url)), "utf8");
  const at = text.indexOf("private tryFoldFloatConst(");
  expect(at).toBeGreaterThan(0);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text, undefined, at);
  let depth = 0;
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.OpenBraceToken) depth++;
    if (k === ts.SyntaxKind.CloseBraceToken && --depth === 0) return text.slice(at, scanner.getTextPos());
  }
  throw new Error("tryFoldFloatConst's body not closed");
}

// ----------------------------------------------------------------------
// CORPUS

test("K01 CORPUS: 304-compound-incdec.ts (`p **= 8`) — full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("k01", "304-compound-incdec.ts");
  expect(stdout).toBe("1\n256\nab2true\n1\n1\n3\n22\n");
  expect(exitCode).toBe(0);
});

test("K02 CORPUS: 700-classes-basic.ts (`(dx * dx + dy * dy) ** 0.5`) — full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("k02", "700-classes-basic.ts");
  expect(stdout).toBe("5 5 0\npt(0, 0) pt(3, 4)\nfar(13, 6)\n99 true false true\n7 dark\n10\n");
  expect(exitCode).toBe(0);
});

test("K03 CORPUS: 760-any-arithmetic.ts, the any/dyn route's claimed carrier, unedited — full stdout and exit code", async () => {
  const { stdout, exitCode } = await runCorpusRow("k03", "760-any-arithmetic.ts");
  expect(stdout).toBe("42 40.5 82 10.25 1 1681\n1x string\n20 105 10 -10\nNaN false\ntrue true false false true false\n");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// LADDER — the ECMA-262 special-value arms for finite exponents

test("L01 LADDER: x = +0 with finite exponents", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"L01.1\", hx(\"0000000000000000\"), hx(\"4008000000000000\"));\nshow(\"L01.2\", hx(\"0000000000000000\"), hx(\"4010000000000000\"));\nshow(\"L01.3\", hx(\"0000000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"L01.4\", hx(\"0000000000000000\"), hx(\"c008000000000000\"));\nshow(\"L01.5\", hx(\"0000000000000000\"), hx(\"c010000000000000\"));\nshow(\"L01.6\", hx(\"0000000000000000\"), hx(\"bfe0000000000000\"));\nshow(\"L01.7\", hx(\"0000000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"L01.8\", hx(\"0000000000000000\"), hx(\"ffe1ccf385ebc8a0\"));\nshow(\"L01.9\", hx(\"0000000000000000\"), hx(\"0000000000000001\"));\nshow(\"L01.10\", hx(\"0000000000000000\"), hx(\"4000000000000000\"));\nshow(\"L01.11\", hx(\"0000000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"L01.12\", hx(\"0000000000000000\"), hx(\"bff0000000000000\"));\nshow(\"L01.13\", hx(\"0000000000000000\"), hx(\"4004000000000000\"));\nshow(\"L01.14\", hx(\"0000000000000000\"), hx(\"4340000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("l01", src);
  expect(stdout).toBe("L01.1 0000000000000000 4008000000000000 -> 0000000000000000\nL01.2 0000000000000000 4010000000000000 -> 0000000000000000\nL01.3 0000000000000000 3fe0000000000000 -> 0000000000000000\nL01.4 0000000000000000 c008000000000000 -> 7ff0000000000000\nL01.5 0000000000000000 c010000000000000 -> 7ff0000000000000\nL01.6 0000000000000000 bfe0000000000000 -> 7ff0000000000000\nL01.7 0000000000000000 7fe1ccf385ebc8a0 -> 0000000000000000\nL01.8 0000000000000000 ffe1ccf385ebc8a0 -> 7ff0000000000000\nL01.9 0000000000000000 0000000000000001 -> 0000000000000000\nL01.10 0000000000000000 4000000000000000 -> 0000000000000000\nL01.11 0000000000000000 3ff0000000000000 -> 0000000000000000\nL01.12 0000000000000000 bff0000000000000 -> 7ff0000000000000\nL01.13 0000000000000000 4004000000000000 -> 0000000000000000\nL01.14 0000000000000000 4340000000000000 -> 0000000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L02 LADDER: x = -0 with finite exponents", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"L02.1\", hx(\"8000000000000000\"), hx(\"4008000000000000\"));\nshow(\"L02.2\", hx(\"8000000000000000\"), hx(\"4010000000000000\"));\nshow(\"L02.3\", hx(\"8000000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"L02.4\", hx(\"8000000000000000\"), hx(\"c008000000000000\"));\nshow(\"L02.5\", hx(\"8000000000000000\"), hx(\"c010000000000000\"));\nshow(\"L02.6\", hx(\"8000000000000000\"), hx(\"bfe0000000000000\"));\nshow(\"L02.7\", hx(\"8000000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"L02.8\", hx(\"8000000000000000\"), hx(\"ffe1ccf385ebc8a0\"));\nshow(\"L02.9\", hx(\"8000000000000000\"), hx(\"0000000000000001\"));\nshow(\"L02.10\", hx(\"8000000000000000\"), hx(\"4000000000000000\"));\nshow(\"L02.11\", hx(\"8000000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"L02.12\", hx(\"8000000000000000\"), hx(\"bff0000000000000\"));\nshow(\"L02.13\", hx(\"8000000000000000\"), hx(\"4004000000000000\"));\nshow(\"L02.14\", hx(\"8000000000000000\"), hx(\"4340000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("l02", src);
  expect(stdout).toBe("L02.1 8000000000000000 4008000000000000 -> 8000000000000000 IS-NEG-ZERO\nL02.2 8000000000000000 4010000000000000 -> 0000000000000000\nL02.3 8000000000000000 3fe0000000000000 -> 0000000000000000\nL02.4 8000000000000000 c008000000000000 -> fff0000000000000\nL02.5 8000000000000000 c010000000000000 -> 7ff0000000000000\nL02.6 8000000000000000 bfe0000000000000 -> 7ff0000000000000\nL02.7 8000000000000000 7fe1ccf385ebc8a0 -> 0000000000000000\nL02.8 8000000000000000 ffe1ccf385ebc8a0 -> 7ff0000000000000\nL02.9 8000000000000000 0000000000000001 -> 0000000000000000\nL02.10 8000000000000000 4000000000000000 -> 0000000000000000\nL02.11 8000000000000000 3ff0000000000000 -> 8000000000000000 IS-NEG-ZERO\nL02.12 8000000000000000 bff0000000000000 -> fff0000000000000\nL02.13 8000000000000000 4004000000000000 -> 0000000000000000\nL02.14 8000000000000000 4340000000000000 -> 0000000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L03 LADDER: x = +Infinity with finite exponents", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"L03.1\", hx(\"7ff0000000000000\"), hx(\"4008000000000000\"));\nshow(\"L03.2\", hx(\"7ff0000000000000\"), hx(\"4010000000000000\"));\nshow(\"L03.3\", hx(\"7ff0000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"L03.4\", hx(\"7ff0000000000000\"), hx(\"c008000000000000\"));\nshow(\"L03.5\", hx(\"7ff0000000000000\"), hx(\"c010000000000000\"));\nshow(\"L03.6\", hx(\"7ff0000000000000\"), hx(\"bfe0000000000000\"));\nshow(\"L03.7\", hx(\"7ff0000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"L03.8\", hx(\"7ff0000000000000\"), hx(\"ffe1ccf385ebc8a0\"));\nshow(\"L03.9\", hx(\"7ff0000000000000\"), hx(\"0000000000000001\"));\nshow(\"L03.10\", hx(\"7ff0000000000000\"), hx(\"4000000000000000\"));\nshow(\"L03.11\", hx(\"7ff0000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"L03.12\", hx(\"7ff0000000000000\"), hx(\"bff0000000000000\"));\nshow(\"L03.13\", hx(\"7ff0000000000000\"), hx(\"4004000000000000\"));\nshow(\"L03.14\", hx(\"7ff0000000000000\"), hx(\"4340000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("l03", src);
  expect(stdout).toBe("L03.1 7ff0000000000000 4008000000000000 -> 7ff0000000000000\nL03.2 7ff0000000000000 4010000000000000 -> 7ff0000000000000\nL03.3 7ff0000000000000 3fe0000000000000 -> 7ff0000000000000\nL03.4 7ff0000000000000 c008000000000000 -> 0000000000000000\nL03.5 7ff0000000000000 c010000000000000 -> 0000000000000000\nL03.6 7ff0000000000000 bfe0000000000000 -> 0000000000000000\nL03.7 7ff0000000000000 7fe1ccf385ebc8a0 -> 7ff0000000000000\nL03.8 7ff0000000000000 ffe1ccf385ebc8a0 -> 0000000000000000\nL03.9 7ff0000000000000 0000000000000001 -> 7ff0000000000000\nL03.10 7ff0000000000000 4000000000000000 -> 7ff0000000000000\nL03.11 7ff0000000000000 3ff0000000000000 -> 7ff0000000000000\nL03.12 7ff0000000000000 bff0000000000000 -> 0000000000000000\nL03.13 7ff0000000000000 4004000000000000 -> 7ff0000000000000\nL03.14 7ff0000000000000 4340000000000000 -> 7ff0000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L04 LADDER: x = -Infinity with finite exponents", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"L04.1\", hx(\"fff0000000000000\"), hx(\"4008000000000000\"));\nshow(\"L04.2\", hx(\"fff0000000000000\"), hx(\"4010000000000000\"));\nshow(\"L04.3\", hx(\"fff0000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"L04.4\", hx(\"fff0000000000000\"), hx(\"c008000000000000\"));\nshow(\"L04.5\", hx(\"fff0000000000000\"), hx(\"c010000000000000\"));\nshow(\"L04.6\", hx(\"fff0000000000000\"), hx(\"bfe0000000000000\"));\nshow(\"L04.7\", hx(\"fff0000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"L04.8\", hx(\"fff0000000000000\"), hx(\"ffe1ccf385ebc8a0\"));\nshow(\"L04.9\", hx(\"fff0000000000000\"), hx(\"0000000000000001\"));\nshow(\"L04.10\", hx(\"fff0000000000000\"), hx(\"4000000000000000\"));\nshow(\"L04.11\", hx(\"fff0000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"L04.12\", hx(\"fff0000000000000\"), hx(\"bff0000000000000\"));\nshow(\"L04.13\", hx(\"fff0000000000000\"), hx(\"4004000000000000\"));\nshow(\"L04.14\", hx(\"fff0000000000000\"), hx(\"4340000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("l04", src);
  expect(stdout).toBe("L04.1 fff0000000000000 4008000000000000 -> fff0000000000000\nL04.2 fff0000000000000 4010000000000000 -> 7ff0000000000000\nL04.3 fff0000000000000 3fe0000000000000 -> 7ff0000000000000\nL04.4 fff0000000000000 c008000000000000 -> 8000000000000000 IS-NEG-ZERO\nL04.5 fff0000000000000 c010000000000000 -> 0000000000000000\nL04.6 fff0000000000000 bfe0000000000000 -> 0000000000000000\nL04.7 fff0000000000000 7fe1ccf385ebc8a0 -> 7ff0000000000000\nL04.8 fff0000000000000 ffe1ccf385ebc8a0 -> 0000000000000000\nL04.9 fff0000000000000 0000000000000001 -> 7ff0000000000000\nL04.10 fff0000000000000 4000000000000000 -> 7ff0000000000000\nL04.11 fff0000000000000 3ff0000000000000 -> fff0000000000000\nL04.12 fff0000000000000 bff0000000000000 -> 8000000000000000 IS-NEG-ZERO\nL04.13 fff0000000000000 4004000000000000 -> 7ff0000000000000\nL04.14 fff0000000000000 4340000000000000 -> 7ff0000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L05 LADDER: x = +1 with finite exponents", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"L05.1\", hx(\"3ff0000000000000\"), hx(\"4008000000000000\"));\nshow(\"L05.2\", hx(\"3ff0000000000000\"), hx(\"4010000000000000\"));\nshow(\"L05.3\", hx(\"3ff0000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"L05.4\", hx(\"3ff0000000000000\"), hx(\"c008000000000000\"));\nshow(\"L05.5\", hx(\"3ff0000000000000\"), hx(\"c010000000000000\"));\nshow(\"L05.6\", hx(\"3ff0000000000000\"), hx(\"bfe0000000000000\"));\nshow(\"L05.7\", hx(\"3ff0000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"L05.8\", hx(\"3ff0000000000000\"), hx(\"ffe1ccf385ebc8a0\"));\nshow(\"L05.9\", hx(\"3ff0000000000000\"), hx(\"0000000000000001\"));\nshow(\"L05.10\", hx(\"3ff0000000000000\"), hx(\"4000000000000000\"));\nshow(\"L05.11\", hx(\"3ff0000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"L05.12\", hx(\"3ff0000000000000\"), hx(\"bff0000000000000\"));\nshow(\"L05.13\", hx(\"3ff0000000000000\"), hx(\"4004000000000000\"));\nshow(\"L05.14\", hx(\"3ff0000000000000\"), hx(\"4340000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("l05", src);
  expect(stdout).toBe("L05.1 3ff0000000000000 4008000000000000 -> 3ff0000000000000\nL05.2 3ff0000000000000 4010000000000000 -> 3ff0000000000000\nL05.3 3ff0000000000000 3fe0000000000000 -> 3ff0000000000000\nL05.4 3ff0000000000000 c008000000000000 -> 3ff0000000000000\nL05.5 3ff0000000000000 c010000000000000 -> 3ff0000000000000\nL05.6 3ff0000000000000 bfe0000000000000 -> 3ff0000000000000\nL05.7 3ff0000000000000 7fe1ccf385ebc8a0 -> 3ff0000000000000\nL05.8 3ff0000000000000 ffe1ccf385ebc8a0 -> 3ff0000000000000\nL05.9 3ff0000000000000 0000000000000001 -> 3ff0000000000000\nL05.10 3ff0000000000000 4000000000000000 -> 3ff0000000000000\nL05.11 3ff0000000000000 3ff0000000000000 -> 3ff0000000000000\nL05.12 3ff0000000000000 bff0000000000000 -> 3ff0000000000000\nL05.13 3ff0000000000000 4004000000000000 -> 3ff0000000000000\nL05.14 3ff0000000000000 4340000000000000 -> 3ff0000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L06 LADDER: x = -1 with finite exponents", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"L06.1\", hx(\"bff0000000000000\"), hx(\"4008000000000000\"));\nshow(\"L06.2\", hx(\"bff0000000000000\"), hx(\"4010000000000000\"));\nshow(\"L06.3\", hx(\"bff0000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"L06.4\", hx(\"bff0000000000000\"), hx(\"c008000000000000\"));\nshow(\"L06.5\", hx(\"bff0000000000000\"), hx(\"c010000000000000\"));\nshow(\"L06.6\", hx(\"bff0000000000000\"), hx(\"bfe0000000000000\"));\nshow(\"L06.7\", hx(\"bff0000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"L06.8\", hx(\"bff0000000000000\"), hx(\"ffe1ccf385ebc8a0\"));\nshow(\"L06.9\", hx(\"bff0000000000000\"), hx(\"0000000000000001\"));\nshow(\"L06.10\", hx(\"bff0000000000000\"), hx(\"4000000000000000\"));\nshow(\"L06.11\", hx(\"bff0000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"L06.12\", hx(\"bff0000000000000\"), hx(\"bff0000000000000\"));\nshow(\"L06.13\", hx(\"bff0000000000000\"), hx(\"4004000000000000\"));\nshow(\"L06.14\", hx(\"bff0000000000000\"), hx(\"4340000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("l06", src);
  expect(stdout).toBe("L06.1 bff0000000000000 4008000000000000 -> bff0000000000000\nL06.2 bff0000000000000 4010000000000000 -> 3ff0000000000000\nL06.3 bff0000000000000 3fe0000000000000 -> NaN\nL06.4 bff0000000000000 c008000000000000 -> bff0000000000000\nL06.5 bff0000000000000 c010000000000000 -> 3ff0000000000000\nL06.6 bff0000000000000 bfe0000000000000 -> NaN\nL06.7 bff0000000000000 7fe1ccf385ebc8a0 -> 3ff0000000000000\nL06.8 bff0000000000000 ffe1ccf385ebc8a0 -> 3ff0000000000000\nL06.9 bff0000000000000 0000000000000001 -> NaN\nL06.10 bff0000000000000 4000000000000000 -> 3ff0000000000000\nL06.11 bff0000000000000 3ff0000000000000 -> bff0000000000000\nL06.12 bff0000000000000 bff0000000000000 -> bff0000000000000\nL06.13 bff0000000000000 4004000000000000 -> NaN\nL06.14 bff0000000000000 4340000000000000 -> 3ff0000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("L07 LADDER: negative base, non-integer exponent", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"L07.1\", hx(\"c000000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"L07.2\", hx(\"c000000000000000\"), hx(\"3ff8000000000000\"));\nshow(\"L07.3\", hx(\"bfe0000000000000\"), hx(\"c004000000000000\"));\nshow(\"L07.4\", hx(\"fe37e43c8800759c\"), hx(\"3fb999999999999a\"));\nshow(\"L07.5\", hx(\"8000000000000001\"), hx(\"400c000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("l07", src);
  expect(stdout).toBe("L07.1 c000000000000000 3fe0000000000000 -> NaN\nL07.2 c000000000000000 3ff8000000000000 -> NaN\nL07.3 bfe0000000000000 c004000000000000 -> NaN\nL07.4 fe37e43c8800759c 3fb999999999999a -> NaN\nL07.5 8000000000000001 400c000000000000 -> NaN\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// V8PRE — V8's own pre-cases

test("P01 V8PRE: y = 2 answers x*x (rows where glibc pow(x, 2) differs from x*x) (the native lanes differ, board #207)", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"P01.1\", hx(\"3fbd713f93cc6e1f\"), hx(\"4000000000000000\"));\nshow(\"P01.2\", hx(\"3fe010b57fdd7b51\"), hx(\"4000000000000000\"));\nshow(\"P01.3\", hx(\"401454c3fbe8799a\"), hx(\"4000000000000000\"));\nshow(\"P01.4\", hx(\"403d75e0935f0c1d\"), hx(\"4000000000000000\"));\nshow(\"P01.5\", hx(\"c01454c3fbe8799a\"), hx(\"4000000000000000\"));\nshow(\"P01.6\", hx(\"6974e718d7d7625a\"), hx(\"4000000000000000\"));\nshow(\"P01.7\", hx(\"96687e92154ef7ac\"), hx(\"4000000000000000\"));\nshow(\"P01.8\", hx(\"c008000000000000\"), hx(\"4000000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("p01", src);
  expect(stdout).toBe("P01.1 3fbd713f93cc6e1f 4000000000000000 -> 3f8b16d40564ac01\nP01.2 3fe010b57fdd7b51 4000000000000000 -> 3fd0217c72c5928a\nP01.3 401454c3fbe8799a 4000000000000000 -> 4039d5ab08fad4bf\nP01.4 403d75e0935f0c1d 4000000000000000 -> 408b1f594379fed6\nP01.5 c01454c3fbe8799a 4000000000000000 -> 4039d5ab08fad4bf\nP01.6 6974e718d7d7625a 4000000000000000 -> 7ff0000000000000\nP01.7 96687e92154ef7ac 4000000000000000 -> 0000000000000000\nP01.8 c008000000000000 4000000000000000 -> 4022000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P02 V8PRE: y = 0.5 answers sqrt(x + 0) (rows where glibc pow(x, 0.5) differs from sqrt) (the native lanes differ, board #207)", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"P02.1\", hx(\"3fd870d4d019cdba\"), hx(\"3fe0000000000000\"));\nshow(\"P02.2\", hx(\"402d71eec38b9e1b\"), hx(\"3fe0000000000000\"));\nshow(\"P02.3\", hx(\"4000432cfff362b2\"), hx(\"3fe0000000000000\"));\nshow(\"P02.4\", hx(\"3fd573d40bfc26e8\"), hx(\"3fe0000000000000\"));\nshow(\"P02.5\", hx(\"3fd0000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"P02.6\", hx(\"4000000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"P02.7\", hx(\"7fefffffffffffff\"), hx(\"3fe0000000000000\"));\nshow(\"P02.8\", hx(\"0000000000000001\"), hx(\"3fe0000000000000\"));\nshow(\"P02.9\", hx(\"8000000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"P02.10\", hx(\"0000000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"P02.11\", hx(\"7ff0000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"P02.12\", hx(\"fff0000000000000\"), hx(\"3fe0000000000000\"));\nshow(\"P02.13\", hx(\"c010000000000000\"), hx(\"3fe0000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("p02", src);
  expect(stdout).toBe("P02.1 3fd870d4d019cdba 3fe0000000000000 -> 3fe3c6689b210912\nP02.2 402d71eec38b9e1b 3fe0000000000000 -> 400eb22a0861afa5\nP02.3 4000432cfff362b2 3fe0000000000000 -> 3ff6cfed1010f54c\nP02.4 3fd573d40bfc26e8 3fe0000000000000 -> 3fe286d6f8da76f7\nP02.5 3fd0000000000000 3fe0000000000000 -> 3fe0000000000000\nP02.6 4000000000000000 3fe0000000000000 -> 3ff6a09e667f3bcd\nP02.7 7fefffffffffffff 3fe0000000000000 -> 5fefffffffffffff\nP02.8 0000000000000001 3fe0000000000000 -> 1e60000000000000\nP02.9 8000000000000000 3fe0000000000000 -> 0000000000000000\nP02.10 0000000000000000 3fe0000000000000 -> 0000000000000000\nP02.11 7ff0000000000000 3fe0000000000000 -> 7ff0000000000000\nP02.12 fff0000000000000 3fe0000000000000 -> 7ff0000000000000\nP02.13 c010000000000000 3fe0000000000000 -> NaN\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("P03 V8PRE: |x| = 1 with an infinite exponent is NaN (the native lanes differ, board #207)", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"P03.1\", hx(\"3ff0000000000000\"), hx(\"7ff0000000000000\"));\nshow(\"P03.2\", hx(\"3ff0000000000000\"), hx(\"fff0000000000000\"));\nshow(\"P03.3\", hx(\"bff0000000000000\"), hx(\"7ff0000000000000\"));\nshow(\"P03.4\", hx(\"bff0000000000000\"), hx(\"fff0000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("p03", src);
  expect(stdout).toBe("P03.1 3ff0000000000000 7ff0000000000000 -> NaN\nP03.2 3ff0000000000000 fff0000000000000 -> NaN\nP03.3 bff0000000000000 7ff0000000000000 -> NaN\nP03.4 bff0000000000000 fff0000000000000 -> NaN\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// CORE — glibc's pow, bit for bit

test("C01 CORE: general representatives", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C01.1\", hx(\"3ff8000000000000\"), hx(\"4004000000000000\"));\nshow(\"C01.2\", hx(\"4024000000000000\"), hx(\"3fd3333333333333\"));\nshow(\"C01.3\", hx(\"3fb999999999999a\"), hx(\"400d99999999999a\"));\nshow(\"C01.4\", hx(\"405edd2f1a9fbe77\"), hx(\"bff3ae147ae147ae\"));\nshow(\"C01.5\", hx(\"401c000000000000\"), hx(\"3fd5555555555555\"));\nshow(\"C01.6\", hx(\"4000000000000000\"), hx(\"3fb999999999999a\"));\nshow(\"C01.7\", hx(\"3ee4f8b588e368f1\"), hx(\"3fd0000000000000\"));\nshow(\"C01.8\", hx(\"4008000000000000\"), hx(\"c01e000000000000\"));\nshow(\"C01.9\", hx(\"4017c97d0b5d9fb2\"), hx(\"40253aab398c4f24\"));\nshow(\"C01.10\", hx(\"3fbe6afb9b8993dc\"), hx(\"4026b19737b1f244\"));\nshow(\"C01.11\", hx(\"4073c81c371fb815\"), hx(\"40024c0466bcdc7a\"));\nshow(\"C01.12\", hx(\"3fe7c8a405c6688c\"), hx(\"3fe55a346bb8cc48\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c01", src);
  expect(stdout).toBe("C01.1 3ff8000000000000 4004000000000000 -> 40060b9fd68a4554\nC01.2 4024000000000000 3fd3333333333333 -> 3fffec982d5bb8af\nC01.3 3fb999999999999a 400d99999999999a -> 3f2a26fd472780c3\nC01.4 405edd2f1a9fbe77 bff3ae147ae147ae -> 3f65eb6202d6647d\nC01.5 401c000000000000 3fd5555555555555 -> 3ffe9b5dba58189d\nC01.6 4000000000000000 3fb999999999999a -> 3ff125fbee250664\nC01.7 3ee4f8b588e368f1 3fd0000000000000 -> 3faccab8602d2697\nC01.8 4008000000000000 c01e000000000000 -> 3f314d0c8b96d651\nC01.9 4017c97d0b5d9fb2 40253aab398c4f24 -> 41a3b9318c420c36\nC01.10 3fbe6afb9b8993dc 4026b19737b1f244 -> 3dc1805717191178\nC01.11 4073c81c371fb815 40024c0466bcdc7a -> 411fef0ea19b956c\nC01.12 3fe7c8a405c6688c 3fe55a346bb8cc48 -> 3fea407ab1cd4bb5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C02 CORE: every branch of the special-result paths", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C02.1\", hx(\"3ff230f72e197309\"), hx(\"40b5687f26721d09\"));\nshow(\"C02.2\", hx(\"3ff00ce476c6bb81\"), hx(\"c10b66e6d405b2d6\"));\nshow(\"C02.3\", hx(\"3fee7b48d71837de\"), hx(\"40c38fb06d9a7789\"));\nshow(\"C02.4\", hx(\"4000000000000000\"), hx(\"c090cc0000000000\"));\nshow(\"C02.5\", hx(\"4000000000000000\"), hx(\"c090c80000000000\"));\nshow(\"C02.6\", hx(\"4000000000000000\"), hx(\"4090000000000000\"));\nshow(\"C02.7\", hx(\"3fe0000000000000\"), hx(\"4091300000000000\"));\nshow(\"C02.8\", hx(\"3ff000001ad7f29b\"), hx(\"3e112e0be826d695\"));\nshow(\"C02.9\", hx(\"3ff0000000000001\"), hx(\"3ee4f8b588e368f1\"));\nshow(\"C02.10\", hx(\"4008000000000000\"), hx(\"3bf0000000000000\"));\nshow(\"C02.11\", hx(\"3fd3333333333333\"), hx(\"bbf0000000000000\"));\nshow(\"C02.12\", hx(\"3ff8000000000000\"), hx(\"43e0000000000000\"));\nshow(\"C02.13\", hx(\"3feccccccccccccd\"), hx(\"43e0000000000000\"));\nshow(\"C02.14\", hx(\"0000000000000003\"), hx(\"3fe8000000000000\"));\nshow(\"C02.15\", hx(\"800000000000000b\"), hx(\"4008000000000000\"));\nshow(\"C02.16\", hx(\"3ff0000029aecb8d\"), hx(\"c1f10e05a72fbca3\"));\nshow(\"C02.17\", hx(\"c000000000000000\"), hx(\"c090cc0000000000\"));\nshow(\"C02.18\", hx(\"c000000000000000\"), hx(\"4090040000000000\"));\nshow(\"C02.19\", hx(\"3f83cb3a3e48a256\"), hx(\"406316e7f641d19b\"));\nshow(\"C02.20\", hx(\"c018cb2198645a0c\"), hx(\"c078500000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c02", src);
  expect(stdout).toBe("C02.1 3ff230f72e197309 40b5687f26721d09 -> 7f5ccdd3535d7523\nC02.2 3ff00ce476c6bb81 c10b66e6d405b2d6 -> 00531aeca643873b\nC02.3 3fee7b48d71837de 40c38fb06d9a7789 -> 1407e82f9a3b71e4\nC02.4 4000000000000000 c090cc0000000000 -> 0000000000000000\nC02.5 4000000000000000 c090c80000000000 -> 0000000000000001\nC02.6 4000000000000000 4090000000000000 -> 7ff0000000000000\nC02.7 3fe0000000000000 4091300000000000 -> 0000000000000000\nC02.8 3ff000001ad7f29b 3e112e0be826d695 -> 3ff0000000000000\nC02.9 3ff0000000000001 3ee4f8b588e368f1 -> 3ff0000000000000\nC02.10 4008000000000000 3bf0000000000000 -> 3ff0000000000000\nC02.11 3fd3333333333333 bbf0000000000000 -> 3ff0000000000000\nC02.12 3ff8000000000000 43e0000000000000 -> 7ff0000000000000\nC02.13 3feccccccccccccd 43e0000000000000 -> 0000000000000000\nC02.14 0000000000000003 3fe8000000000000 -> 0da9ca285c7abac0\nC02.15 800000000000000b 4008000000000000 -> 8000000000000000 IS-NEG-ZERO\nC02.16 3ff0000029aecb8d c1f10e05a72fbca3 -> 00015232657f40b2\nC02.17 c000000000000000 c090cc0000000000 -> 8000000000000000 IS-NEG-ZERO\nC02.18 c000000000000000 4090040000000000 -> fff0000000000000\nC02.19 3f83cb3a3e48a256 406316e7f641d19b -> 000e9f62594eed77\nC02.20 c018cb2198645a0c c078500000000000 -> 8004945b560c7527\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C03 CORE: seven rows where an unmodified upstream build with this compiler differs from glibc", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C03.1\", hx(\"40022e22c101268a\"), hx(\"c084fb903071359e\"));\nshow(\"C03.2\", hx(\"3fef2d4ef37afd76\"), hx(\"c07d9a1646091685\"));\nshow(\"C03.3\", hx(\"3fffa98edb31bef5\"), hx(\"c07fce83a5650f59\"));\nshow(\"C03.4\", hx(\"3fe0b974a15af7b4\"), hx(\"c0795d95111fcd59\"));\nshow(\"C03.5\", hx(\"3ff98fbc90e25728\"), hx(\"403e000000000000\"));\nshow(\"C03.6\", hx(\"400aaa416e063794\"), hx(\"c056d041f204d1a6\"));\nshow(\"C03.7\", hx(\"400e780d58768808\"), hx(\"c0713bc708206e91\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c03", src);
  expect(stdout).toBe("C03.1 40022e22c101268a c084fb903071359e -> 0e3c0758fe7d7f06\nC03.2 3fef2d4ef37afd76 c07d9a1646091685 -> 410bef3e2db1184d\nC03.3 3fffa98edb31bef5 c07fce83a5650f59 -> 209d78db9a497e41\nC03.4 3fe0b974a15af7b4 c0795d95111fcd59 -> 57ae4b581dfcfa4e\nC03.5 3ff98fbc90e25728 403e000000000000 -> 413362e76041542e\nC03.6 400aaa416e063794 c056d041f204d1a6 -> 3606abfa36049702\nC03.7 400e780d58768808 c0713bc708206e91 -> 1eb05973be458cc6\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C04 CORE: Node's bits where the correctly rounded result differs (Node is the oracle)", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C04.1\", hx(\"3f8f79d2bfa77b23\"), hx(\"c02bce9ea1b5ab24\"));\nshow(\"C04.2\", hx(\"3f59ea00a2c75bb5\"), hx(\"3ff716e236cb0a20\"));\nshow(\"C04.3\", hx(\"3ffe4063ed7fb92a\"), hx(\"4032000000000000\"));\nshow(\"C04.4\", hx(\"3fd1f863acedb690\"), hx(\"402a000000000000\"));\nshow(\"C04.5\", hx(\"049250660fd6404f\"), hx(\"bfd02fd9b6b300c0\"));\nshow(\"C04.6\", hx(\"5fe66f852127eb0c\"), hx(\"bfed34d7adceb850\"));\nshow(\"C04.7\", hx(\"3f64db2a3ed50c98\"), hx(\"3ff8282882f19fc4\"));\nshow(\"C04.8\", hx(\"4007ade00dc129fd\"), hx(\"c01c000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c04", src);
  expect(stdout).toBe("C04.1 3f8f79d2bfa77b23 c02bce9ea1b5ab24 -> 452af4f902aa9189\nC04.2 3f59ea00a2c75bb5 3ff716e236cb0a20 -> 3f17cd69f8e2f5e7\nC04.3 3ffe4063ed7fb92a 4032000000000000 -> 40f746f83fd194ba\nC04.4 3fd1f863acedb690 402a000000000000 -> 3e7219f05c628170\nC04.5 049250660fd6404f bfd02fd9b6b300c0 -> 4ef2b41da2e75af7\nC04.6 5fe66f852127eb0c bfed34d7adceb850 -> 22c1effc8de1a911\nC04.7 3f64db2a3ed50c98 3ff8282882f19fc4 -> 3f1fc2633fcd8993\nC04.8 4007ade00dc129fd c01c000000000000 -> 3f40768b580afd41\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C05 CORE: integer exponents incl. 8, negative bases odd and even, and exponents at 2^53", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C05.1\", hx(\"3ff199999999999a\"), hx(\"4020000000000000\"));\nshow(\"C05.2\", hx(\"bff199999999999a\"), hx(\"4020000000000000\"));\nshow(\"C05.3\", hx(\"400d99999999999a\"), hx(\"4008000000000000\"));\nshow(\"C05.4\", hx(\"c00d99999999999a\"), hx(\"4008000000000000\"));\nshow(\"C05.5\", hx(\"4024000000000000\"), hx(\"4024000000000000\"));\nshow(\"C05.6\", hx(\"c004000000000000\"), hx(\"c000000000000000\"));\nshow(\"C05.7\", hx(\"c004000000000000\"), hx(\"c008000000000000\"));\nshow(\"C05.8\", hx(\"3ff00068db8bac71\"), hx(\"403e000000000000\"));\nshow(\"C05.9\", hx(\"3feff7ced916872b\"), hx(\"404a800000000000\"));\nshow(\"C05.10\", hx(\"bff8000000000000\"), hx(\"4050000000000000\"));\nshow(\"C05.11\", hx(\"bff8000000000000\"), hx(\"c01c000000000000\"));\nshow(\"C05.12\", hx(\"3ff000010c6f7a0b\"), hx(\"408f400000000000\"));\nshow(\"C05.13\", hx(\"bff000000006df38\"), hx(\"4340000000000000\"));\nshow(\"C05.14\", hx(\"bff000000006df38\"), hx(\"4330000000000001\"));\nshow(\"C05.15\", hx(\"bfeffffffff24190\"), hx(\"4340000000000001\"));\nshow(\"C05.16\", hx(\"3ff0000000000001\"), hx(\"43b0000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c05", src);
  expect(stdout).toBe("C05.1 3ff199999999999a 4020000000000000 -> 40012611e3d82c2a\nC05.2 bff199999999999a 4020000000000000 -> 40012611e3d82c2a\nC05.3 400d99999999999a 4008000000000000 -> 40495395810624de\nC05.4 c00d99999999999a 4008000000000000 -> c0495395810624de\nC05.5 4024000000000000 4024000000000000 -> 4202a05f20000000\nC05.6 c004000000000000 c000000000000000 -> 3fc47ae147ae147b\nC05.7 c004000000000000 c008000000000000 -> bfb0624dd2f1a9fc\nC05.8 3ff00068db8bac71 403e000000000000 -> 3ff00c4e4b271f0c\nC05.9 3feff7ced916872b 404a800000000000 -> 3fee58ec4cb93bce\nC05.10 bff8000000000000 4050000000000000 -> 4245ab6a57c7bc99\nC05.11 bff8000000000000 c01c000000000000 -> bfadf75680feb65f\nC05.12 3ff000010c6f7a0b 408f400000000000 -> 3ff00419199587de\nC05.13 bff000000006df38 4340000000000000 -> 7ff0000000000000\nC05.14 bff000000006df38 4330000000000001 -> fff0000000000000\nC05.15 bfeffffffff24190 4340000000000001 -> 0000000000000000\nC05.16 3ff0000000000001 43b0000000000000 -> 57041c7a8814be19\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C06 CORE: overflow and underflow thresholds", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C06.1\", hx(\"4000000000000000\"), hx(\"408fffffffffffff\"));\nshow(\"C06.2\", hx(\"4000000000000000\"), hx(\"408ff80000000000\"));\nshow(\"C06.3\", hx(\"4000000000000000\"), hx(\"c08ff00000000000\"));\nshow(\"C06.4\", hx(\"4000000000000000\"), hx(\"c090c60000000000\"));\nshow(\"C06.5\", hx(\"4000000000000000\"), hx(\"c090ca0000000000\"));\nshow(\"C06.6\", hx(\"4024000000000000\"), hx(\"4073440000000000\"));\nshow(\"C06.7\", hx(\"4024000000000000\"), hx(\"40734413404ea4a9\"));\nshow(\"C06.8\", hx(\"4024000000000000\"), hx(\"c07434cccccccccd\"));\nshow(\"C06.9\", hx(\"4024000000000000\"), hx(\"c074400000000000\"));\nshow(\"C06.10\", hx(\"3fe0000000000000\"), hx(\"c090000000000000\"));\nshow(\"C06.11\", hx(\"3fe0000000000000\"), hx(\"4090c80000000000\"));\nshow(\"C06.12\", hx(\"4000000000000001\"), hx(\"4090000000000000\"));\nshow(\"C06.13\", hx(\"3fffffffffffffff\"), hx(\"4090000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c06", src);
  expect(stdout).toBe("C06.1 4000000000000000 408fffffffffffff -> 7feffffffffffd3a\nC06.2 4000000000000000 408ff80000000000 -> 7fe0000000000000\nC06.3 4000000000000000 c08ff00000000000 -> 0010000000000000\nC06.4 4000000000000000 c090c60000000000 -> 0000000000000001\nC06.5 4000000000000000 c090ca0000000000 -> 0000000000000001\nC06.6 4024000000000000 4073440000000000 -> 7fefa788589d81d3\nC06.7 4024000000000000 40734413404ea4a9 -> 7fefffb4dd50f1df\nC06.8 4024000000000000 c07434cccccccccd -> 0000000000000001\nC06.9 4024000000000000 c074400000000000 -> 0000000000000000\nC06.10 3fe0000000000000 c090000000000000 -> 7ff0000000000000\nC06.11 3fe0000000000000 4090c80000000000 -> 0000000000000001\nC06.12 4000000000000001 4090000000000000 -> 7ff0000000000000\nC06.13 3fffffffffffffff 4090000000000000 -> 7feffffffffffc00\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C07 CORE: y = -1 where Node's bits differ from 1/x", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C07.1\", hx(\"9d4213bcbd2f54a8\"), hx(\"bff0000000000000\"));\nshow(\"C07.2\", hx(\"18a3b4a97500f5ca\"), hx(\"bff0000000000000\"));\nshow(\"C07.3\", hx(\"fb6faf77b56c4c83\"), hx(\"bff0000000000000\"));\nshow(\"C07.4\", hx(\"3ff76b6fdddc849f\"), hx(\"bff0000000000000\"));\nshow(\"C07.5\", hx(\"3ff53d4adc75a62f\"), hx(\"bff0000000000000\"));\nshow(\"C07.6\", hx(\"3fb2c91e18acfcf8\"), hx(\"bff0000000000000\"));\nshow(\"C07.7\", hx(\"3ff8e5682acb9fca\"), hx(\"bff0000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c07", src);
  expect(stdout).toBe("C07.1 9d4213bcbd2f54a8 bff0000000000000 -> e29c52b8970d2036\nC07.2 18a3b4a97500f5ca bff0000000000000 -> 6739fb790d73dcbc\nC07.3 fb6faf77b56c4c83 bff0000000000000 -> 847028aa7cb4f61a\nC07.4 3ff76b6fdddc849f bff0000000000000 -> 3fe5dca95f88f69d\nC07.5 3ff53d4adc75a62f bff0000000000000 -> 3fe81b2a65031328\nC07.6 3fb2c91e18acfcf8 bff0000000000000 -> 402b4140e0881bf0\nC07.7 3ff8e5682acb9fca bff0000000000000 -> 3fe490c186d1d6e9\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C08 CORE: y = 1", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C08.1\", hx(\"3ff8000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"C08.2\", hx(\"bff8000000000000\"), hx(\"3ff0000000000000\"));\nshow(\"C08.3\", hx(\"0000000000000001\"), hx(\"3ff0000000000000\"));\nshow(\"C08.4\", hx(\"7fefffffffffffff\"), hx(\"3ff0000000000000\"));\nshow(\"C08.5\", hx(\"3fb2c91e18acfcf8\"), hx(\"3ff0000000000000\"));\nshow(\"C08.6\", hx(\"c0a5b22d0e560419\"), hx(\"3ff0000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c08", src);
  expect(stdout).toBe("C08.1 3ff8000000000000 3ff0000000000000 -> 3ff8000000000000\nC08.2 bff8000000000000 3ff0000000000000 -> bff8000000000000\nC08.3 0000000000000001 3ff0000000000000 -> 0000000000000001\nC08.4 7fefffffffffffff 3ff0000000000000 -> 7fefffffffffffff\nC08.5 3fb2c91e18acfcf8 3ff0000000000000 -> 3fb2c91e18acfcf8\nC08.6 c0a5b22d0e560419 3ff0000000000000 -> c0a5b22d0e560419\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C09 CORE: x = +-1 with finite exponents through the core", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"C09.1\", hx(\"3ff0000000000000\"), hx(\"4008000000000000\"));\nshow(\"C09.2\", hx(\"3ff0000000000000\"), hx(\"3fd3333333333333\"));\nshow(\"C09.3\", hx(\"3ff0000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"C09.4\", hx(\"3ff0000000000000\"), hx(\"c01c000000000000\"));\nshow(\"C09.5\", hx(\"bff0000000000000\"), hx(\"4008000000000000\"));\nshow(\"C09.6\", hx(\"bff0000000000000\"), hx(\"4010000000000000\"));\nshow(\"C09.7\", hx(\"bff0000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\nshow(\"C09.8\", hx(\"bff0000000000000\"), hx(\"c014000000000000\"));\nshow(\"C09.9\", hx(\"bff0000000000000\"), hx(\"4340000000000001\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("c09", src);
  expect(stdout).toBe("C09.1 3ff0000000000000 4008000000000000 -> 3ff0000000000000\nC09.2 3ff0000000000000 3fd3333333333333 -> 3ff0000000000000\nC09.3 3ff0000000000000 7fe1ccf385ebc8a0 -> 3ff0000000000000\nC09.4 3ff0000000000000 c01c000000000000 -> 3ff0000000000000\nC09.5 bff0000000000000 4008000000000000 -> bff0000000000000\nC09.6 bff0000000000000 4010000000000000 -> 3ff0000000000000\nC09.7 bff0000000000000 7fe1ccf385ebc8a0 -> 3ff0000000000000\nC09.8 bff0000000000000 c014000000000000 -> bff0000000000000\nC09.9 bff0000000000000 4340000000000001 -> 3ff0000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// FMA — one row per a*b+c site whose fusion changes an answer

test("M01 FMA: inputs whose Node bits change if site F01 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M01.1\", hx(\"007031a16e3d2e96\"), hx(\"3fe5e53764697fcc\"));\nshow(\"M01.2\", hx(\"4a7fd39eea5f7a03\"), hx(\"40006723e7ecae06\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m01", src);
  expect(stdout).toBe("M01.1 007031a16e3d2e96 3fe5e53764697fcc -> 147c8407147f486c\nM01.2 4a7fd39eea5f7a03 40006723e7ecae06 -> 55968ca59b737b74\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M02 FMA: inputs whose Node bits change if site F04 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M02.1\", hx(\"3fd9145567b1f272\"), hx(\"c05b83bfb8faa9f8\"));\nshow(\"M02.2\", hx(\"403a7f6398e78c14\"), hx(\"4054cff7a3fc962e\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m02", src);
  expect(stdout).toBe("M02.1 3fd9145567b1f272 c05b83bfb8faa9f8 -> 493af038559bf067\nM02.2 403a7f6398e78c14 4054cff7a3fc962e -> 5888050df5168d26\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M03 FMA: inputs whose Node bits change if site F05 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M03.1\", hx(\"3fef3033b0f89b1e\"), hx(\"40dacbf95350b9c5\"));\nshow(\"M03.2\", hx(\"3fef2f035efc3f9e\"), hx(\"c0d6964d689c01fc\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m03", src);
  expect(stdout).toBe("M03.1 3fef3033b0f89b1e 40dacbf95350b9c5 -> 005d458478b2f80a\nM03.2 3fef2f035efc3f9e c0d6964d689c01fc -> 75d3d849aaa59dc5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M04 FMA: inputs whose Node bits change if site F10 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M04.1\", hx(\"3fb2fba9fcac012a\"), hx(\"c07097c4539dd0e1\"));\nshow(\"M04.2\", hx(\"3feb128be94a042c\"), hx(\"405e126a7ef47862\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m04", src);
  expect(stdout).toBe("M04.1 3fb2fba9fcac012a c07097c4539dd0e1 -> 7e360ab449076f68\nM04.2 3feb128be94a042c 405e126a7ef47862 -> 3e1f94c4464abac7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M05 FMA: inputs whose Node bits change if site F11 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M05.1\", hx(\"2729475e40314477\"), hx(\"bffee2bc3f386ec2\"));\nshow(\"M05.2\", hx(\"4da4580e38e0cd9d\"), hx(\"bfec6588d3b80d14\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m05", src);
  expect(stdout).toBe("M05.1 2729475e40314477 bffee2bc3f386ec2 -> 6fc0e1753caa7f39\nM05.2 4da4580e38e0cd9d bfec6588d3b80d14 -> 33c46ff0a6636791\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M06 FMA: inputs whose Node bits change if site F18 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M06.1\", hx(\"3f9470a0517ef522\"), hx(\"3fde92e214f700dd\"));\nshow(\"M06.2\", hx(\"3fb58a0026b78953\"), hx(\"bfdd4c97dcbebbf1\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m06", src);
  expect(stdout).toBe("M06.1 3f9470a0517ef522 3fde92e214f700dd -> 3fc3bb7fb9f192d7\nM06.2 3fb58a0026b78953 bfdd4c97dcbebbf1 -> 4008d83369b0a698\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M07 FMA: inputs whose Node bits change if site F20 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M07.1\", hx(\"1500f7f0090879d2\"), hx(\"3fb11cbf6476c5ca\"));\nshow(\"M07.2\", hx(\"255f8399f5cac1e4\"), hx(\"3efc0bfef8fdeb25\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m07", src);
  expect(stdout).toBe("M07.1 1500f7f0090879d2 3fb11cbf6476c5ca -> 3d10f33739870079\nM07.2 255f8399f5cac1e4 3efc0bfef8fdeb25 -> 3fefbfb391a6c3ed\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M08 FMA: inputs whose Node bits change if site F21 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M08.1\", hx(\"10e23aac0d563d1d\"), hx(\"bff3e97ec38f66bc\"));\nshow(\"M08.2\", hx(\"62f243cf9e539d6e\"), hx(\"3ff5b454ae40c5b3\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m08", src);
  expect(stdout).toBe("M08.1 10e23aac0d563d1d bff3e97ec38f66bc -> 7a7d6ab685a874e3\nM08.2 62f243cf9e539d6e 3ff5b454ae40c5b3 -> 6f6e2451a7ca43cb\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M09 FMA: inputs whose Node bits change if site N02 (NOT fused) is fused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M09.1\", hx(\"40029155be91ce02\"), hx(\"404d9052cda795cd\"));\nshow(\"M09.2\", hx(\"3ff6b558c8645461\"), hx(\"408d94deca005295\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m09", src);
  expect(stdout).toBe("M09.1 40029155be91ce02 404d9052cda795cd -> 446c51675df3816d\nM09.2 3ff6b558c8645461 408d94deca005295 -> 5dd22864255e954c\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M10 FMA: inputs whose Node bits change if site N03 (NOT fused) is fused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M10.1\", hx(\"677c70a9408ef6c5\"), hx(\"bff41435685601f5\"));\nshow(\"M10.2\", hx(\"384955a7d77137a9\"), hx(\"401df418508bd8dc\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m10", src);
  expect(stdout).toBe("M10.1 677c70a9408ef6c5 bff41435685601f5 -> 0e4ca663a0e268f4\nM10.2 384955a7d77137a9 401df418508bd8dc -> 06adc14d72ae8506\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M11 FMA: inputs whose Node bits change if site N04 (NOT fused) is fused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M11.1\", hx(\"3f8398e8c1cacee4\"), hx(\"40630e89e7f92e01\"));\nshow(\"M11.2\", hx(\"3ff0000029aecb8d\"), hx(\"c1f10e05a72fbca3\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m11", src);
  expect(stdout).toBe("M11.1 3f8398e8c1cacee4 40630e89e7f92e01 -> 000abe0403b1cbd8\nM11.2 3ff0000029aecb8d c1f10e05a72fbca3 -> 00015232657f40b2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("M12 FMA: inputs whose Node bits change if site F16 (fused) is computed unfused", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction show(label: string, x: number, y: number): void {\n  const r = x ** y;\n  console.log(label + \" \" + bits(x) + \" \" + bits(y) + \" -> \" + out(r));\n}\nshow(\"M12.1\", hx(\"3ffe17c1acf1d31e\"), hx(\"c08690ba01b376e2\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("m12", src);
  expect(stdout).toBe("M12.1 3ffe17c1acf1d31e c08690ba01b376e2 -> 16ce61b642b12832\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// DYN — the any/dyn route

test("D01 DYN: the any/dyn route: the expressions that fenced now compute (the native lanes differ, board #207)", async () => {
  const src = "// @dynamic\nconst buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction dshow(label: string, x: any, y: any): void {\n  try {\n    const r = (x ** y) as number;\n    console.log(label + \" \" + bits(x as number) + \" \" + bits(y as number) + \" -> \" + out(r));\n  } catch (e) {\n    console.log(label + \" \" + bits(x as number) + \" \" + bits(y as number) + \" -> CAUGHT:\" + (e as Error).message);\n  }\n}\ndshow(\"D01.1\", hx(\"3ff0000000000000\"), hx(\"4008000000000000\"));\ndshow(\"D01.2\", hx(\"4000000000000000\"), hx(\"3fe0000000000000\"));\ndshow(\"D01.3\", hx(\"3ffb333333333333\"), hx(\"3ff0000000000000\"));\ndshow(\"D01.4\", hx(\"9d4213bcbd2f54a8\"), hx(\"bff0000000000000\"));\ndshow(\"D01.5\", hx(\"4000000000000000\"), hx(\"4008000000000000\"));\ndshow(\"D01.6\", hx(\"3ff8000000000000\"), hx(\"4004000000000000\"));\ndshow(\"D01.7\", hx(\"bff0000000000000\"), hx(\"4008000000000000\"));\ndshow(\"D01.8\", hx(\"3ff0000000000000\"), hx(\"7fe1ccf385ebc8a0\"));\ndshow(\"D01.9\", hx(\"3fbd713f93cc6e1f\"), hx(\"4000000000000000\"));\ndshow(\"D01.10\", hx(\"3fd870d4d019cdba\"), hx(\"3fe0000000000000\"));\ndshow(\"D01.11\", hx(\"4000000000000000\"), hx(\"c090cc0000000000\"));\ndshow(\"D01.12\", hx(\"c000000000000000\"), hx(\"3fe0000000000000\"));\n";
  const { stdout, stderr, exitCode, module } = await runRow("d01", src);
  expect(stdout).toBe("D01.1 3ff0000000000000 4008000000000000 -> 3ff0000000000000\nD01.2 4000000000000000 3fe0000000000000 -> 3ff6a09e667f3bcd\nD01.3 3ffb333333333333 3ff0000000000000 -> 3ffb333333333333\nD01.4 9d4213bcbd2f54a8 bff0000000000000 -> e29c52b8970d2036\nD01.5 4000000000000000 4008000000000000 -> 4020000000000000\nD01.6 3ff8000000000000 4004000000000000 -> 40060b9fd68a4554\nD01.7 bff0000000000000 4008000000000000 -> bff0000000000000\nD01.8 3ff0000000000000 7fe1ccf385ebc8a0 -> 3ff0000000000000\nD01.9 3fbd713f93cc6e1f 4000000000000000 -> 3f8b16d40564ac01\nD01.10 3fd870d4d019cdba 3fe0000000000000 -> 3fe3c6689b210912\nD01.11 4000000000000000 c090cc0000000000 -> 0000000000000000\nD01.12 c000000000000000 3fe0000000000000 -> NaN\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("D02 DYN: the static route and the any/dyn route agree on a 7x7 table", async () => {
  const src = "// @dynamic\nconst buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction st(x: number, y: number): number {\n  return x ** y;\n}\nfunction dy(x: any, y: any): number {\n  return (x ** y) as number;\n}\nconst xs: string[] = [\"3ff8000000000000\", \"4024000000000000\", \"3fb999999999999a\", \"c00c000000000000\", \"3ff0000000000000\", \"0000000000000003\", \"7fefffffffffffff\"];\nconst ys: string[] = [\"4004000000000000\", \"3fd3333333333333\", \"c01e000000000000\", \"4020000000000000\", \"bff0000000000000\", \"3fe0000000000000\", \"4000000000000000\"];\nfor (const a of xs) {\n  for (const b of ys) {\n    const s = st(hx(a), hx(b));\n    const d = dy(hx(a) as any, hx(b) as any);\n    console.log(a + \" \" + b + \" static \" + out(s) + \" dyn \" + out(d) + (Object.is(s, d) || (s !== s && d !== d) ? \" same\" : \" DIFFERENT\"));\n  }\n}\n";
  const { stdout, stderr, exitCode, module } = await runRow("d02", src);
  expect(stdout).toBe("3ff8000000000000 4004000000000000 static 40060b9fd68a4554 dyn 40060b9fd68a4554 same\n3ff8000000000000 3fd3333333333333 static 3ff211ce179a0012 dyn 3ff211ce179a0012 same\n3ff8000000000000 c01e000000000000 static 3fa8779f0513f1b6 dyn 3fa8779f0513f1b6 same\n3ff8000000000000 4020000000000000 static 4039a10000000000 dyn 4039a10000000000 same\n3ff8000000000000 bff0000000000000 static 3fe5555555555555 dyn 3fe5555555555555 same\n3ff8000000000000 3fe0000000000000 static 3ff3988e1409212e dyn 3ff3988e1409212e same\n3ff8000000000000 4000000000000000 static 4002000000000000 dyn 4002000000000000 same\n4024000000000000 4004000000000000 static 4073c3a4edfa9759 dyn 4073c3a4edfa9759 same\n4024000000000000 3fd3333333333333 static 3fffec982d5bb8af dyn 3fffec982d5bb8af same\n4024000000000000 c01e000000000000 static 3e60fa3389d6eb40 dyn 3e60fa3389d6eb40 same\n4024000000000000 4020000000000000 static 4197d78400000000 dyn 4197d78400000000 same\n4024000000000000 bff0000000000000 static 3fb999999999999a dyn 3fb999999999999a same\n4024000000000000 3fe0000000000000 static 40094c583ada5b53 dyn 40094c583ada5b53 same\n4024000000000000 4000000000000000 static 4059000000000000 dyn 4059000000000000 same\n3fb999999999999a 4004000000000000 static 3f69e7c6e43390b8 dyn 3f69e7c6e43390b8 same\n3fb999999999999a 3fd3333333333333 static 3fe009b9cf334253 dyn 3fe009b9cf334253 same\n3fb999999999999a c01e000000000000 static 417e286789a07f2c dyn 417e286789a07f2c same\n3fb999999999999a 4020000000000000 static 3e45798ee2308c3d dyn 3e45798ee2308c3d same\n3fb999999999999a bff0000000000000 static 4024000000000000 dyn 4024000000000000 same\n3fb999999999999a 3fe0000000000000 static 3fd43d136248490f dyn 3fd43d136248490f same\n3fb999999999999a 4000000000000000 static 3f847ae147ae147c dyn 3f847ae147ae147c same\nc00c000000000000 4004000000000000 static NaN dyn NaN same\nc00c000000000000 3fd3333333333333 static NaN dyn NaN same\nc00c000000000000 c01e000000000000 static NaN dyn NaN same\nc00c000000000000 4020000000000000 static 40d5fdb040000000 dyn 40d5fdb040000000 same\nc00c000000000000 bff0000000000000 static bfd2492492492492 dyn bfd2492492492492 same\nc00c000000000000 3fe0000000000000 static NaN dyn NaN same\nc00c000000000000 4000000000000000 static 4028800000000000 dyn 4028800000000000 same\n3ff0000000000000 4004000000000000 static 3ff0000000000000 dyn 3ff0000000000000 same\n3ff0000000000000 3fd3333333333333 static 3ff0000000000000 dyn 3ff0000000000000 same\n3ff0000000000000 c01e000000000000 static 3ff0000000000000 dyn 3ff0000000000000 same\n3ff0000000000000 4020000000000000 static 3ff0000000000000 dyn 3ff0000000000000 same\n3ff0000000000000 bff0000000000000 static 3ff0000000000000 dyn 3ff0000000000000 same\n3ff0000000000000 3fe0000000000000 static 3ff0000000000000 dyn 3ff0000000000000 same\n3ff0000000000000 4000000000000000 static 3ff0000000000000 dyn 3ff0000000000000 same\n0000000000000003 4004000000000000 static 0000000000000000 dyn 0000000000000000 same\n0000000000000003 3fd3333333333333 static 2bd35dd0a9edf0a3 dyn 2bd35dd0a9edf0a3 same\n0000000000000003 c01e000000000000 static 7ff0000000000000 dyn 7ff0000000000000 same\n0000000000000003 4020000000000000 static 0000000000000000 dyn 0000000000000000 same\n0000000000000003 bff0000000000000 static 7ff0000000000000 dyn 7ff0000000000000 same\n0000000000000003 3fe0000000000000 static 1e6bb67ae8584caa dyn 1e6bb67ae8584caa same\n0000000000000003 4000000000000000 static 0000000000000000 dyn 0000000000000000 same\n7fefffffffffffff 4004000000000000 static 7ff0000000000000 dyn 7ff0000000000000 same\n7fefffffffffffff 3fd3333333333333 static 5322611186bae64c dyn 5322611186bae64c same\n7fefffffffffffff c01e000000000000 static 0000000000000000 dyn 0000000000000000 same\n7fefffffffffffff 4020000000000000 static 7ff0000000000000 dyn 7ff0000000000000 same\n7fefffffffffffff bff0000000000000 static 0004000000000000 dyn 0004000000000000 same\n7fefffffffffffff 3fe0000000000000 static 5fefffffffffffff dyn 5fefffffffffffff same\n7fefffffffffffff 4000000000000000 static 7ff0000000000000 dyn 7ff0000000000000 same\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// FOLD — a literal-literal `**` folds to the run-time value

test("X01 FOLD: literal-literal ** equals the same operands through non-literal variables across every arm (the native lanes differ, board #207)", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction v(n: number): number {\n  return n;\n}\nconsole.log(\"F01.1 \" + out(2 ** 0.5) + \" \" + out(v(2) ** v(0.5)));\nconsole.log(\"F01.2 \" + out((-0) ** 3) + \" \" + out(v(-0) ** v(3)));\nconsole.log(\"F01.3 \" + out(0 ** -1) + \" \" + out(v(0) ** v(-1)));\nconsole.log(\"F01.4 \" + out((-8) ** 3) + \" \" + out(v(-8) ** v(3)));\nconsole.log(\"F01.5 \" + out(1 ** 3) + \" \" + out(v(1) ** v(3)));\nconsole.log(\"F01.6 \" + out((-1) ** 1e308) + \" \" + out(v(-1) ** v(1e308)));\nconsole.log(\"F01.7 \" + out(1.1 ** 2) + \" \" + out(v(1.1) ** v(2)));\nconsole.log(\"F01.8 \" + out(0.11500928266871611 ** 2) + \" \" + out(v(0.11500928266871611) ** v(2)));\nconsole.log(\"F01.9 \" + out(0.38188667604773807 ** 0.5) + \" \" + out(v(0.38188667604773807) ** v(0.5)));\nconsole.log(\"F01.10 \" + out(1.5 ** 2.5) + \" \" + out(v(1.5) ** v(2.5)));\nconsole.log(\"F01.11 \" + out(10 ** 308.25) + \" \" + out(v(10) ** v(308.25)));\nconsole.log(\"F01.12 \" + out(10 ** 400) + \" \" + out(v(10) ** v(400)));\nconsole.log(\"F01.13 \" + out(10 ** -323.3) + \" \" + out(v(10) ** v(-323.3)));\nconsole.log(\"F01.14 \" + out(10 ** -400) + \" \" + out(v(10) ** v(-400)));\nconsole.log(\"F01.15 \" + out(2 ** -1074) + \" \" + out(v(2) ** v(-1074)));\nconsole.log(\"F01.16 \" + out(2 ** 1023.9999999999999) + \" \" + out(v(2) ** v(1023.9999999999999)));\nconsole.log(\"F01.17 \" + out((-2) ** 0.5) + \" \" + out(v(-2) ** v(0.5)));\nconsole.log(\"F01.18 \" + out((-2) ** 1.5) + \" \" + out(v(-2) ** v(1.5)));\nconsole.log(\"F01.19 \" + out((-9.579903901399578e-168) ** -1) + \" \" + out(v(-9.579903901399578e-168) ** v(-1)));\nconsole.log(\"F01.20 \" + out(1.463729731222237 ** -1) + \" \" + out(v(1.463729731222237) ** v(-1)));\nconsole.log(\"F01.21 \" + out(2 ** 10) + \" \" + out(v(2) ** v(10)));\nconsole.log(\"F01.22 \" + out(2 ** 53) + \" \" + out(v(2) ** v(53)));\nconsole.log(\"F01.23 \" + out(2 ** -2) + \" \" + out(v(2) ** v(-2)));\nconsole.log(\"F01.24 \" + out(0.1 ** 3.7) + \" \" + out(v(0.1) ** v(3.7)));\n";
  const { stdout, stderr, exitCode, module } = await runRow("x01", src);
  expect(stdout).toBe("F01.1 3ff6a09e667f3bcd 3ff6a09e667f3bcd\nF01.2 8000000000000000 IS-NEG-ZERO 8000000000000000 IS-NEG-ZERO\nF01.3 7ff0000000000000 7ff0000000000000\nF01.4 c080000000000000 c080000000000000\nF01.5 3ff0000000000000 3ff0000000000000\nF01.6 3ff0000000000000 3ff0000000000000\nF01.7 3ff35c28f5c28f5d 3ff35c28f5c28f5d\nF01.8 3f8b16d40564ac01 3f8b16d40564ac01\nF01.9 3fe3c6689b210912 3fe3c6689b210912\nF01.10 40060b9fd68a4554 40060b9fd68a4554\nF01.11 7fefa788589d81d3 7fefa788589d81d3\nF01.12 7ff0000000000000 7ff0000000000000\nF01.13 0000000000000001 0000000000000001\nF01.14 0000000000000000 0000000000000000\nF01.15 0000000000000001 0000000000000001\nF01.16 7feffffffffffd3a 7feffffffffffd3a\nF01.17 NaN NaN\nF01.18 NaN NaN\nF01.19 e29c52b8970d2036 e29c52b8970d2036\nF01.20 3fe5dca95f88f69d 3fe5dca95f88f69d\nF01.21 4090000000000000 4090000000000000\nF01.22 4340000000000000 4340000000000000\nF01.23 3fd0000000000000 3fd0000000000000\nF01.24 3f2a26fd472780c3 3f2a26fd472780c3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("X02 FOLD: the three NaN-boundary expressions (the inner ** folds, the outer op folds) (the native lanes differ, board #207)", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nconsole.log(\"X02.1 \" + bits((10 ** 400) - (10 ** 400)));\nconsole.log(\"X02.2 \" + bits((2 ** 2000) * 0));\nconsole.log(\"X02.3 \" + bits((10 ** -400) / (10 ** -400)));\n";
  const { stdout, stderr, exitCode, module } = await runRow("x02", src);
  expect(stdout).toBe("X02.1 7ff8000000000000\nX02.2 7ff8000000000000\nX02.3 7ff8000000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("X03 FOLD: a module whose only ** are literal-literal still folds (no pow helper in the module)", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nconsole.log(\"X03.1 \" + out(2 ** 0.5) + \" \" + out((2 ** 0.5) * (2 ** 0.5)) + \" \" + out(-(2 ** 3)) + \" \" + out(1.5 ** 2.5) + \" \" + out(3 ** -2));\n";
  const { stdout, stderr, exitCode, module } = await runRow("x03", src);
  expect(stdout).toBe("X03.1 3ff6a09e667f3bcd 4000000000000001 c020000000000000 40060b9fd68a4554 3fbc71c71c71c71c\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  // every `**` here is literal-literal: folded, so the module carries neither the helper nor its core
  expect(module.includes("%w.jsPow")).toBe(false);
  expect(module.includes("%w.powCore")).toBe(false);
});

// ----------------------------------------------------------------------
// LOCKSTEP and the fold's host independence

test("Z01 LOCKSTEP: the TypeScript core and the WebAssembly builder in pow.ts reach every SITE through the same wrapper kind, and that kind is the SITE list's (fused below 100, unfused above), read by the TypeScript scanner", () => {
  const tokens = powTokens();
  const ids = Object.keys(SITE).sort();
  expect(ids.length).toBe(25);
  const fused = (id: string): boolean => (SITE as Record<string, number>)[id]! < 100;
  const tsPairs = sitePairs(tokens, "makeCore", "powCoreValue");
  const wasmPairs = sitePairs(tokens, "buildPowCore", null);
  expect(tsPairs).toEqual(ids.map((id) => `${fused(id) ? "fmaAt" : "mulAdd"} ${id}`).sort());
  expect(wasmPairs).toEqual(ids.map((id) => `${fused(id) ? "emitFmaAt" : "emitMulAdd"} ${id}`).sort());
  // known-fail: one site swapped between the wrappers in one transcription is seen
  const swapped = tsPairs.map((x) => (x === "fmaAt F03" ? "mulAdd F03" : x));
  expect(swapped).not.toEqual(ids.map((id) => `${fused(id) ? "fmaAt" : "mulAdd"} ${id}`).sort());
});

test("Z02 FOLD: the fold never reaches the host's pow — no `**` operator and no Math other than abs/sqrt/trunc in pow.ts or in tryFoldFloatConst, read by the TypeScript scanner (known-fails both ways)", () => {
  const pow = readFileSync(fileURLToPath(new URL("../src/backend/wasm/pow.ts", import.meta.url)), "utf8");
  expect(hostPowUses(pow)).toEqual([]);
  const fold = tryFoldFloatConstText();
  expect(fold).toContain("jsPowValue(l, r)");
  expect(hostPowUses(fold)).toEqual([]);
  // the scan passes a string or a comment holding "**", and catches each way to reach the host pow
  expect(hostPowUses('if (e.op !== "**") return; // x ** y')).toEqual([]);
  expect(hostPowUses("return l ** r;")).toEqual(["**"]);
  expect(hostPowUses("l **= r;")).toEqual(["**="]);
  expect(hostPowUses("return Math.pow(l, r);")).toEqual(["Math.pow"]);
  expect(hostPowUses('return Math["pow"](l, r);')).toEqual(['Math["pow"']);
  expect(hostPowUses("const M = Math; return M.pow(l, r);")).toEqual(["Math;return"]);
});

// ----------------------------------------------------------------------
// STATIC — the static shapes

test("S01 STATIC: ** and **= over a local and a field, ** into an array element; precedence and right associativity", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nclass Box {\n  x: number;\n  constructor(x: number) {\n    this.x = x;\n  }\n}\nfunction f(a: number, b: number): number {\n  return a ** b;\n}\nlet p = 1.5;\np **= 8;\nconst o = new Box(1.25);\no.x **= 3;\nconst arr: number[] = [2, 3];\narr[1] = arr[1]! ** 0.5;\nconst a = f(2, 3);\nconst b = f(2, 0.5);\nconst c = f(3, 2);\nconst d = f(2, 3);\nconsole.log(\"S01.1 \" + out(p) + \" \" + out(o.x) + \" \" + out(arr[1]!) + \" \" + out(a));\nconsole.log(\"S01.2 \" + out(-(b ** 2)) + \" \" + out((-b) ** 2) + \" \" + out(c ** -b) + \" \" + out(c ** d ** 0.5) + \" \" + out((c ** d) ** 0.5));\n";
  const { stdout, stderr, exitCode, module } = await runRow("s01", src);
  expect(stdout).toBe("S01.1 4039a10000000000 3fff400000000000 3ffbb67ae8584caa 4020000000000000\nS01.2 c000000000000001 4000000000000001 3fa6e57aac5e7966 407f40a6e8bc4ec6 40b9a10000000000\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("S02 STATIC: ** in a generic function, a class method and a loop", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction g<T extends number>(a: T, b: T): number {\n  return a ** b;\n}\nclass Pt {\n  constructor(public x: number, public y: number) {}\n  norm(): number {\n    return (this.x * this.x + this.y * this.y) ** 0.5;\n  }\n}\nlet acc = 0;\nfor (let i = 1; i <= 20; i++) {\n  acc += i ** 1.5;\n}\nconsole.log(\"S02.1 \" + out(g(1.25, 7)) + \" \" + out(new Pt(3, 4).norm()) + \" \" + out(new Pt(1, 1).norm()) + \" \" + out(acc));\n";
  const { stdout, stderr, exitCode, module } = await runRow("s02", src);
  expect(stdout).toBe("S02.1 401312d000000000 4014000000000000 3ff6a09e667f3bcd 4087c65f8a043518\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// NOT-LIFTED — what stays refused, by name

test("N01 NOT-LIFTED: Math.pow stays refused (plain build) — a named refusal", async () => {
  const src = "const buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction hx(h: string): number {\n  return Buffer.from(h, \"hex\").readDoubleBE(0);\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction mp(a: number, b: number): number {\n  return Math.pow(a, b);\n}\nconsole.log(\"N01.1 \" + out(mp(2, 0.5)));\n";
  const { diagnostics, survey } = await refuseRow("n01", src);
  expect(diagnostics).toEqual(["SC2012: 'Math.pow' runs in the embedded dynamic engine, which this build does not include"]);
  expect(survey).toEqual([]);
});

test("N02 LIFTED (the Math unit, SEMANTICS.md S100): Math.pow under --dynamic computes through %w.jsPow -- the bits of `**`", async () => {
  const src = "// @dynamic\nconst buf = Buffer.alloc(8);\nfunction bits(v: number): string {\n  buf.writeDoubleBE(v, 0);\n  return buf.toString(\"hex\");\n}\nfunction out(r: number): string {\n  return (r !== r ? \"NaN\" : bits(r)) + (Object.is(r, -0) ? \" IS-NEG-ZERO\" : \"\");\n}\nfunction mp(a: number, b: number): number {\n  return Math.pow(a, b);\n}\nconst pairs: number[][] = [[2, 0.5], [1.1, 3.7], [-8, 1 / 3], [10, -2], [-0, -3], [0.9999999, 1e10], [3, 2], [1.0000001, -1]];\nfor (const [a, b] of pairs) {\n  const m = mp(a!, b!);\n  console.log(\"N02 \" + out(m) + \" \" + (out(m) === out(a! ** b!) ? \"same\" : \"DIFFERENT\"));\n}\n";
  const { stdout, stderr, exitCode } = await runRow("n02", src);
  expect(stdout).toBe("N02 3ff6a09e667f3bcd same\nN02 3ff6c3e91ed0825a same\nN02 NaN same\nN02 3f847ae147ae147b same\nN02 fff0000000000000 same\nN02 0000000000000000 same\nN02 4022000000000000 same\nN02 3fefffffca501b24 same\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("N03 NOT-LIFTED: a compound array-element **= stays refused (SC1090, every compound element op) — a named refusal", async () => {
  const src = "const arr: number[] = [2, 3];\narr[0] **= 0.5;\nconsole.log(String(arr[0]));\n";
  const { diagnostics, survey } = await refuseRow("n03", src);
  expect(diagnostics).toEqual(["SC1090: compound array-element assignment (a[i] += v) is not supported yet"]);
  expect(survey).toEqual([]);
});
