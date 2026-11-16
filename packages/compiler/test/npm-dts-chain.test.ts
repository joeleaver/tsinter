/* SEMANTICS.md S133 (m): a viewed package whose declarations import
 * another opted-in package (@clack/prompts over @clack/core): the dependency
 * gets a declared-surface view too, so the type-only names the first
 * package's declarations import exist. Rows run under Node and on both
 * WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-dts-chain");
const pj = (o: unknown): string => JSON.stringify(o);
const esm = (name: string): string =>
  pj({ name, version: "1.0.0", type: "module", main: "./dist/index.mjs", types: "./dist/index.d.mts", exports: { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } });

const CHAIN: Record<string, string> = {
      "package.json": pj({ type: "module" }),
      "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
      "node_modules/pcore/package.json": esm("pcore"),
      "node_modules/pcore/dist/index.d.mts": [
        `export interface PromptOptions { message: string; initialValue?: string }`,
        `export type State = "initial" | "active" | "submit" | "cancel";`,
        `export declare function isCancel(value: unknown): boolean;`,
        `export declare function settle(message: string, initialValue?: string): string;`,
      ].join("\n"),
      "node_modules/pcore/dist/index.mjs": [
        `export function isCancel(value) { return typeof value === "symbol"; }`,
        `export function settle(message, initialValue) { return message + ":" + (initialValue ?? "none"); }`,
      ].join("\n"),
      "node_modules/pprompts/package.json": esm("pprompts"),
      "node_modules/pprompts/dist/index.d.mts": [
        `import { type PromptOptions, type State, isCancel } from "pcore";`,
        `export { isCancel };`,
        `export interface TextOptions extends PromptOptions { placeholder?: string }`,
        `export declare function text(message: string, placeholder?: string): string;`,
        `export declare function stateName(s: State): string;`,
      ].join("\n"),
      "node_modules/pprompts/dist/index.mjs": [
        `import { isCancel, settle } from "pcore";`,
        `export { isCancel };`,
        `export function text(message, placeholder) { return settle(message) + (placeholder ? " [" + placeholder + "]" : ""); }`,
        `export function stateName(s) { return "state:" + s; }`,
      ].join("\n"),
      "main.ts": [
        `import { text, stateName, isCancel, type TextOptions } from "pprompts";`,
        `const o: TextOptions = { message: "name", placeholder: "ann" };`,
        `console.log(text(o.message, o.placeholder));`,
        `console.log(text("port"));`,
        `console.log(stateName("submit"), isCancel("x"));`,
      ].join("\n"),
};

// A diamond: pa imports pb, then pc; pb imports pc and re-exports one of its
// bindings. Node evaluates pc, pb, pa, main.
const DIAMOND: Record<string, string> = {
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/pc/package.json": esm("pc"),
  "node_modules/pc/dist/index.d.mts": `export declare function isC(v: unknown): boolean;\nexport declare function three(): number;`,
  "node_modules/pc/dist/index.mjs": `console.log("c eval");\nexport function isC(v) { return v === "c"; }\nexport function three() { return 3; }`,
  "node_modules/pb/package.json": esm("pb"),
  "node_modules/pb/dist/index.d.mts": `import { isC } from "pc";\nexport { isC };\nexport declare function b(): string;`,
  "node_modules/pb/dist/index.mjs": `import { isC, three } from "pc";\nconsole.log("b eval");\nexport { isC };\nexport function b() { return "b" + three(); }`,
  "node_modules/pa/package.json": esm("pa"),
  "node_modules/pa/dist/index.d.mts": `export { isC } from "pb";\nexport declare function ab(): string;`,
  "node_modules/pa/dist/index.mjs": `import { b, isC } from "pb";\nimport { three } from "pc";\nconsole.log("a eval");\nexport { isC };\nexport function ab() { return "a" + b() + three(); }`,
  "main.ts": `import { ab, isC } from "pa";\nconsole.log("main", ab(), isC("c"), isC("x"));`,
};

const ROWS: Row[] = [
  {
    id: "DCH-01 a prompts-style package over a core package whose declarations it imports (type-only names: an interface base and a type alias)",
    npmStatic: ["pcore", "pprompts"],
    files: CHAIN,
  },
  {
    id: "DCH-02 --npm-static=auto: the program imports only the outer package; auto's transitive pass opts the inner one in",
    npmStatic: "auto",
    files: CHAIN,
  },
  {
    id: "DCH-03 --npm-static=auto over a diamond (pa imports pb then pc; pb re-exports pc's binding): opted in in Node's evaluation order",
    npmStatic: "auto",
    files: DIAMOND,
  },
];

describe("S133 (m): declarations importing another opted-in package (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133 (m): declarations importing another opted-in package (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
