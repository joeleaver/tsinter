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

// Declarations that claim a re-export while the JS ships its own wrapper (a
// shape bundled dists produce): Node's import from pprompts runs the wrapper.
const WRAPPER: Record<string, string> = {
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/pcore/package.json": esm("pcore"),
  "node_modules/pcore/dist/index.d.mts": `export declare function isCancel(v: unknown): boolean;`,
  "node_modules/pcore/dist/index.mjs": `export function isCancel(v) { return typeof v === "symbol"; }`,
  "node_modules/pprompts/package.json": esm("pprompts"),
  "node_modules/pprompts/dist/index.d.mts": `export { isCancel } from "pcore";`,
  "node_modules/pprompts/dist/index.mjs": `import { isCancel as base } from "pcore";\nexport function isCancel(v) { console.log("wrapped"); return base(v); }`,
  "main.ts": `import { isCancel } from "pprompts";\nimport { isCancel as c2 } from "pcore";\nconsole.log(isCancel("x"));\nconsole.log(c2("y"));`,
};

const WRAPPER_NS: Record<string, string> = {
  ...WRAPPER,
  "main.ts": `import * as pp from "pprompts";\nimport * as pc from "pcore";\nconsole.log(pp.isCancel("x"));\nconsole.log(pc.isCancel("y"));`,
};
// pthird re-exports pprompts' (wrapper) export once more: two views in a chain.
const WRAPPER_THIRD: Record<string, string> = {
  ...WRAPPER,
  "node_modules/pthird/package.json": esm("pthird"),
  "node_modules/pthird/dist/index.d.mts": `export { isCancel } from "pprompts";`,
  "node_modules/pthird/dist/index.mjs": `export { isCancel } from "pprompts";`,
  "main.ts": `import { isCancel } from "pthird";\nimport { isCancel as c2 } from "pcore";\nconsole.log(isCancel("x"));\nconsole.log(c2("y"));`,
};
// A program module re-exports the wrapper and the core name.
const WRAPPER_PROGRAM: Record<string, string> = {
  ...WRAPPER,
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true } }),
  "util.ts": `export { isCancel } from "pprompts";\nexport { isCancel as coreIs } from "pcore";`,
  "main.ts": `import { isCancel, coreIs } from "./util.ts";\nimport * as u from "./util.ts";\nconsole.log(isCancel("x"));\nconsole.log(coreIs("y"));\nconsole.log(u.isCancel("z"));`,
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
  {
    id: "DCH-04 GH #237: an explicit opt-in list with the dependent first builds the same (a re-exported dependency binding resolves to its implementation)",
    npmStatic: ["pprompts", "pcore"],
    files: CHAIN,
  },
  {
    id: "DCH-05 GH #237 through a namespace import: `p.isCancel(...)` where pprompts re-exports pcore's binding (paperclip's clack spelling)",
    npmStatic: ["pprompts", "pcore"],
    files: { ...CHAIN, "main.ts": `import * as p from "pprompts";\nconsole.log(p.text("name", "ann"), p.stateName("submit"), p.isCancel("x"));` },
  },
  {
    id: "DCH-06 GH #237 over the diamond with an explicit list in the reverse of Node's order",
    npmStatic: ["pa", "pb", "pc"],
    files: DIAMOND,
  },
  { id: "DCH-07 declarations re-export, the JS ships its own wrapper: each package's name answers its own export (order pcore, pprompts)", npmStatic: ["pcore", "pprompts"], files: WRAPPER },
  { id: "DCH-07b the same with the order pprompts, pcore", npmStatic: ["pprompts", "pcore"], files: WRAPPER },
  { id: "DCH-07c the same under --npm-static=auto", npmStatic: "auto", files: WRAPPER },
  { id: "DCH-08 the wrapper through a namespace import (`pp.isCancel`), order pcore, pprompts", npmStatic: ["pcore", "pprompts"], files: WRAPPER_NS },
  { id: "DCH-08b the same, order pprompts, pcore", npmStatic: ["pprompts", "pcore"], files: WRAPPER_NS },
  { id: "DCH-08c the same under --npm-static=auto", npmStatic: "auto", files: WRAPPER_NS },
  { id: "DCH-09 a third package re-exporting the wrapper, order pcore, pprompts, pthird", npmStatic: ["pcore", "pprompts", "pthird"], files: WRAPPER_THIRD },
  { id: "DCH-09b the same, order pthird, pprompts, pcore", npmStatic: ["pthird", "pprompts", "pcore"], files: WRAPPER_THIRD },
  { id: "DCH-09c the same under --npm-static=auto", npmStatic: "auto", files: WRAPPER_THIRD },
  { id: "DCH-10 a program module re-exporting the wrapper (named and namespace reads), order pprompts, pcore", npmStatic: ["pprompts", "pcore"], files: WRAPPER_PROGRAM },
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
