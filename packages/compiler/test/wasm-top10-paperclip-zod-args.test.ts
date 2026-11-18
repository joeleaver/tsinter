/* paperclip's zod schema arguments on a dynamic receiver (SEMANTICS.md S133
 * (k): zod's declared interfaces are the implementation's dynamic value):
 * - `z.string().regex(re, msg?)`: the typed RegExp crosses as the one shared
 *   box (S043's unit F1 amendment), so identity and lastIndex are shared
 *   with the program's own reference;
 * - `z.string().datetime({ offset: true })`: a fresh object-literal argument
 *   is built as the dynamic object itself (nothing else holds it).
 * Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("wasm-top10-paperclip-zod-args");
const pj = (o: unknown): string => JSON.stringify(o);

const PKG: Record<string, string> = {
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/pz/package.json": pj({ name: "pz", version: "1.0.0", type: "module", types: "./index.d.mts", exports: { ".": { types: "./index.d.mts", default: "./index.mjs" } } }),
  "node_modules/pz/index.d.mts": [
    `export interface DatetimeOptions { offset?: boolean; local?: boolean; precision?: number | null; message?: string }`,
    `export interface ZodString {`,
    `  regex(re: RegExp, message?: string | { message?: string }): ZodString;`,
    `  datetime(opts?: DatetimeOptions): ZodString;`,
    `  check(input: string): string;`,
    `}`,
    `export declare function string(): ZodString;`,
  ].join("\n"),
  "node_modules/pz/index.mjs": [
    `class S {`,
    `  constructor(checks) { this.checks = checks; }`,
    `  regex(re, message) { return new S([...this.checks, (v) => { re.lastIndex = 0; return re.test(v) ? null : (typeof message === "string" ? message : message?.message ?? "invalid " + re.source); }]); }`,
    // (zod's own spelling: `datetime(params)`, the options read off an
    // implicit-any parameter)
    `  datetime(params) { const keys = params ? Object.keys(params).join(",") : "-"; return new S([...this.checks, (v) => (params?.offset ? /[+-]\\d\\d:\\d\\d$|Z$/ : /Z$/).test(v) ? null : "bad datetime (" + keys + ")"]); }`,
    `  check(input) { return this.checks.map((c) => c(input)).filter((r) => r !== null).join("|") || "ok"; }`,
    `}`,
    `export function string() { return new S([]); }`,
  ].join("\n"),
};

const ROWS: Row[] = [
  {
    id: "PZA-01 a RegExp and a fresh options literal into a dynamic receiver's methods (zod's .regex / .datetime)",
    npmStatic: ["pz"],
    files: {
      ...PKG,
      "main.ts": [
        `import * as z from "pz";`,
        `const SHA256_HEX_RE = /^[a-f0-9]{64}$/;`,
        `const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);`,
        `const sha = z.string().regex(SHA256_HEX_RE, "sha256 must identify the exact attachment bytes");`,
        `const color = z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, { message: "Color must be a 6-digit hex value" });`,
        `const at = z.string().datetime({ offset: true });`,
        `const plain = z.string().datetime();`,
        `console.log(JSON.stringify([key.check("abc"), key.check("Abc"), sha.check("a".repeat(64)), sha.check("x"), color.check("#12ab"), at.check("2024-01-01T00:00:00+02:00"), at.check("nope"), plain.check("2024-01-01T00:00:00Z")]));`,
        `const g = /a/g;`,
        `const sticky = z.string().regex(g);`,
        `g.lastIndex = 5;`,
        `console.log(JSON.stringify(sticky.check("aa")), g.lastIndex, SHA256_HEX_RE.source.length);`,
      ].join("\n"),
    },
  },
];

// The review's Z08 (copy-vs-share): a literal holding a TYPED object the
// package keeps and mutates later still shares it, as the ordinary crossing
// does.
const SHARE_PKG: Record<string, string> = {
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/pz/package.json": pj({ name: "pz", version: "1.0.0", type: "module", types: "./index.d.mts", exports: { ".": { types: "./index.d.mts", default: "./index.mjs" } } }),
  "node_modules/pz/index.d.mts": [
    `export interface Inner { n: number; tags: string[] }`,
    `export interface Opts { offset?: boolean; inner?: Inner; list?: Inner[]; n?: number; label?: string }`,
    `export interface ZS {`,
    `  take(o: Opts): Opts;`,
    `  keep(o: Opts): ZS;`,
    `  mutate(): ZS;`,
    `  peek(): string;`,
    `  same(o: Opts): boolean;`,
    `  regex(re: RegExp): ZS;`,
    `  run(s: string): string;`,
    `  sameRe(re: RegExp): boolean;`,
    `}`,
    `export declare function string(): ZS;`,
  ].join("\n"),
  "node_modules/pz/index.mjs": [
    `let kept = null; let keptRe = null;`,
    `class S {`,
    `  take(o) { if (o.inner) o.inner.n += 100; if (o.list) o.list[0].tags.push("t"); o.added = 1; return o; }`,
    `  keep(o) { kept = o; return this; }`,
    `  mutate() { kept.n = (kept.n ?? 0) + 1; if (kept.inner) { kept.inner.n = -1; kept.inner.tags.push("m"); } kept.label = "mut"; return this; }`,
    `  peek() { return JSON.stringify(kept); }`,
    `  same(o) { return o === kept; }`,
    `  regex(re) { keptRe = re; return this; }`,
    `  run(s) { const m = keptRe.exec(s); return (m ? m[0] + "@" + m.index : "none") + ":" + keptRe.lastIndex; }`,
    `  sameRe(re) { return re === keptRe; }`,
    `}`,
    `export function string() { return new S(); }`,
  ].join("\n"),
};

ROWS.push({
  id: "PZA-02 a literal holding a typed object the package keeps and mutates later shares it (review Z08)",
  npmStatic: ["pz"],
  files: {
    ...SHARE_PKG,
    "main.ts": [
      `import * as z from "pz";`,
      `import type { Inner } from "pz";`,
      `const inner: Inner = { n: 1, tags: [] };`,
      `z.string().keep({ inner }).mutate();`,
      `console.log(inner.n, inner.tags);`,
    ].join("\n"),
  },
});

describe("paperclip zod arguments on a dynamic receiver (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("paperclip zod arguments on a dynamic receiver (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
