/* SEMANTICS.md S133 (n): a namespace import of a viewed package
 * (`import * as p from "@clack/prompts"`, paperclip's spelling): member reads
 * and calls through `p` resolve to the implementation as a program module's
 * do — a function call, a member of an exported object (`p.log.info`), a
 * nested namespace export's member (`p.util.f`). The namespace as a VALUE
 * keeps its fence. Rows run under Node and on both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/index.js";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-dts-namespace");
const pj = (o: unknown): string => JSON.stringify(o);

const PKG: Record<string, string> = {
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/pp/package.json": pj({ name: "pp", version: "1.0.0", type: "module", types: "./dist/index.d.mts", exports: { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } }),
  "node_modules/pp/dist/index.d.mts": [
    `export interface IntroOptions { output?: string }`,
    `export declare function intro(title?: string): void;`,
    `export declare function outro(message?: string): void;`,
    `export declare const log: { info(message: string): void; step(message: string): void; warn(message: string): void };`,
    `export declare function isCancel(value: unknown): boolean;`,
    `export * as util from "./util.mjs";`,
  ].join("\n"),
  "node_modules/pp/dist/util.d.mts": `export declare function width(s: string): number;`,
  "node_modules/pp/dist/util.mjs": `export function width(s) { return s.length; }`,
  "node_modules/pp/dist/index.mjs": [
    `export function intro(title) { console.log("┌  " + (title ?? "")); }`,
    `export function outro(message) { console.log("└  " + (message ?? "")); }`,
    `export const log = {`,
    `  info(message) { console.log("│  " + message); },`,
    `  step(message) { console.log("◇  " + message); },`,
    `  warn(message) { console.log("▲  " + message); },`,
    `};`,
    `export function isCancel(value) { return typeof value === "symbol"; }`,
    `export * as util from "./util.mjs";`,
  ].join("\n"),
};

const ROWS: Row[] = [
  {
    id: "DNS-01 paperclip's clack spellings through `import * as p`: calls, an exported object's methods, a nested namespace member",
    npmStatic: ["pp"],
    files: {
      ...PKG,
      "main.ts": [
        `import * as p from "pp";`,
        `p.intro("paperclip env");`,
        `p.log.info("Config file missing");`,
        `p.log.step("loading");`,
        `p.log.warn("careful");`,
        `console.log(p.isCancel("x"), p.util.width("abcd"));`,
        `p.outro("done");`,
      ].join("\n"),
    },
  },
];

describe("S133 (n): a namespace import of a viewed package (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133 (n): a namespace import of a viewed package (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

/** A package `sp` whose JS entry is `export *` over the given modules, its
 * declarations declaring each name directly. */
const STAR = (dts: string, entry: string, mods: Record<string, string>): Record<string, string> => ({
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true, allowJs: true } }),
  "node_modules/sp/package.json": pj({ name: "sp", version: "1.0.0", type: "module", types: "./dist/index.d.mts", exports: { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } }),
  "node_modules/sp/dist/index.d.mts": dts,
  "node_modules/sp/dist/index.mjs": entry,
  ...Object.fromEntries(Object.entries(mods).map(([k, v]) => [`node_modules/sp/dist/${k}`, v])),
});
const AMBIG = STAR(
  `export declare const dup: string;\nexport declare const onlyA: string;`,
  `export * from "./a.mjs";\nexport * from "./b.mjs";`,
  { "a.mjs": `export const dup = "A";\nexport const onlyA = "a";`, "b.mjs": `export const dup = "B";` },
);

const ROWS2: Row[] = [
  {
    id: "DNS-02 star exports that are not ambiguous: a local export shadows a star; two stars re-export one binding",
    npmStatic: ["sp"],
    files: {
      ...STAR(
        `export declare const dup: string;\nexport declare const same: string;\nexport declare const onlyA: string;`,
        `export * from "./a.mjs";\nexport * from "./b.mjs";\nexport * from "./c.mjs";\nexport const dup = "LOCAL";`,
        { "a.mjs": `export const dup = "A";\nexport const onlyA = "a";`, "b.mjs": `export { same } from "./c.mjs";`, "c.mjs": `export const same = "C";` },
      ),
      "main.ts": `import * as p from "sp";\nimport { same } from "sp";\nconsole.log(p.dup, p.same, same, p.onlyA);`,
    },
  },
];

describe("S133 (n): star exports that are not ambiguous (both lanes vs Node)", () => {
  test.for(ROWS2.map((r) => [r.id, r] as const))("%s wasm", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
  test.for(ROWS2.map((r) => [r.id, r] as const))("%s wasm-native", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

async function refusal(files: Record<string, string>, entry: string, npmStatic: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dns-"));
  for (const [n, s] of Object.entries(files)) {
    mkdirSync(join(dir, n, ".."), { recursive: true });
    writeFileSync(join(dir, n), s);
  }
  const res = await compile(join(dir, entry), { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", npmStatic });
  expect(res.ok).toBe(false);
  return (res.diagnostics ?? []).map((d) => d.message).join("\n");
}

describe("GH #243: a name two `export *` sources both export is ambiguous (Node leaves it out; a named import fails at link)", () => {
  test("DNS-R2 a namespace read of it through a viewed package refuses by name", async () => {
    const text = await refusal({ ...AMBIG, "main.ts": `import * as p from "sp";\nconsole.log(p.onlyA, typeof p.dup, p.dup);` }, "main.ts", ["sp"]);
    expect(text).toContain("reading 'dup' through the namespace of 'sp'");
  }, 600_000);
  test("DNS-R3 a named import of it from a viewed package refuses by name", async () => {
    const text = await refusal({ ...AMBIG, "main.ts": `import { onlyA, dup } from "sp";\nconsole.log(onlyA, dup);` }, "main.ts", ["sp"]);
    expect(text).toContain("importing 'dup' from 'sp'");
  }, 600_000);
  test("DNS-R4 plain program JavaScript: a named import of it refuses by name (Node: conflicting star exports)", async () => {
    const files = {
      "package.json": pj({ type: "module" }),
      "idx.mjs": `export * from "./a.mjs";\nexport * from "./b.mjs";`,
      "a.mjs": `export const dup = "A";\nexport const onlyA = "a";`,
      "b.mjs": `export const dup = "B";`,
      "main.mjs": `import { onlyA, dup } from "./idx.mjs";\nconsole.log(onlyA, dup);`,
    };
    const text = await refusal(files, "main.mjs", []);
    expect(text).toContain("importing 'dup' from './idx.mjs'");
  }, 600_000);
  test("DNS-R4b a program module's namespace read of it refuses by name", async () => {
    const files = {
      "package.json": pj({ type: "module" }),
      "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true, allowJs: true } }),
      "idx.mjs": `export * from "./a.mjs";\nexport * from "./b.mjs";`,
      "a.mjs": `export const dup = "A";\nexport const onlyA = "a";`,
      "b.mjs": `export const dup = "B";`,
      "main.ts": `import * as p from "./idx.mjs";\nconsole.log(p.onlyA, typeof p.dup, p.dup);`,
    };
    const text = await refusal(files, "main.ts", []);
    expect(text).toContain("reading 'dup' through the namespace of './idx.mjs'");
  }, 600_000);
});

describe("S133 (n): the namespace as a value keeps its fence", () => {
  test("DNS-R1 passing `p` on refuses by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dns-r1-"));
    const files: Record<string, string> = { ...PKG, "main.ts": `import * as p from "pp";\nconst q = p;\nconsole.log(typeof q);` };
    for (const [n, s] of Object.entries(files)) {
      mkdirSync(join(dir, n, ".."), { recursive: true });
      writeFileSync(join(dir, n), s);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", npmStatic: ["pp"] });
    expect(res.ok).toBe(false);
    expect((res.diagnostics ?? []).map((d) => d.message).join("\n")).toContain("namespace objects as first-class values");
  }, 600_000);
  test("DNS-R5 a member with no compiled binding (`p.default(...)`) names the member", async () => {
    const files = {
      ...PKG,
      "node_modules/pp/dist/index.d.mts": `export default function hello(n: string): string;\nexport declare const x: number;`,
      "node_modules/pp/dist/index.mjs": `export default function hello(n) { return "hi " + n; }\nexport const x = 1;`,
      "main.ts": `import * as p from "pp";\nconsole.log(p.default("a"), p.x);`,
    };
    const dir = mkdtempSync(join(tmpdir(), "dns-r5-"));
    for (const [n, s] of Object.entries(files)) {
      mkdirSync(join(dir, n, ".."), { recursive: true });
      writeFileSync(join(dir, n), s);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", npmStatic: ["pp"] });
    if (!res.ok) {
      const text = (res.diagnostics ?? []).map((d) => d.message).join("\n");
      expect(text).not.toContain("namespace objects as first-class values");
      expect(text).toContain("default");
    }
  }, 600_000);
});
