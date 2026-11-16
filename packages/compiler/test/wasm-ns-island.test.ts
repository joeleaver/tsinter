/* A program module's namespace binding is never an island value: zod's JS
 * calls `core.$constructor(...)`, `core.config()` and `new
 * core.$ZodAsyncError()` inside its functions, and a namespace with one
 * `any`-typed export (zod's `globalConfig`) mapped to jsval, so the island
 * method-call path lowered `core` itself as a value and fenced
 * ("module namespace objects as first-class values"). Members resolve
 * statically; a genuine value use keeps the fence. Rows run under Node and
 * on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("wasm-ns-island");

const CORE: Record<string, string> = {
  "package.json": JSON.stringify({ type: "module" }),
  "core.js": [
    `export const NEVER = Object.freeze({ status: "aborted" });`,
    `export class $ZodAsyncError extends Error { constructor() { super("async"); } }`,
    `export const globalConfig = JSON.parse('{"locale":"en"}');`,
    `export function $constructor(name, init) {`,
    `  return function make(def) { const inst = { name, def }; init(inst, def); return inst; };`,
    `}`,
    `export function config(next) { if (next) globalConfig.locale = next.locale; return globalConfig; }`,
  ].join("\n"),
  "util.js": `export function normalize(p) { return typeof p === "string" ? { error: p } : p ?? {}; }`,
  "index.js": `export * from "./core.js";\nexport * as util from "./util.js";`,
};

const ROWS: Row[] = [
  {
    id: "NSI-01 namespace member calls, a nested namespace and an any-typed export inside function bodies (zod's core.*)",
    files: {
      ...CORE,
      "main.js": [
        `import * as core from "./index.js";`,
        `export const ZodString = core.$constructor("ZodString", (inst, def) => {`,
        `  inst.kind = "string:" + core.util.normalize(def).error;`,
        `});`,
        `export function string(params) {`,
        `  const s = ZodString(params);`,
        `  if (s.kind === "x") throw new core.$ZodAsyncError();`,
        `  return s.kind + " " + core.config({ locale: "fr" }).locale + " " + core.globalConfig.locale + " " + core.util.normalize(params).error;`,
        `}`,
        `function check(v) {`,
        `  try { if (v) throw new core.$ZodAsyncError(); return "ok"; } catch (e) { return e instanceof Error ? e.message : "?"; }`,
        `}`,
        `console.log(string("bad"), core.NEVER.status, check(false), check(true));`,
      ].join("\n"),
    },
  },
];

describe("namespace bindings are never island values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("namespace bindings are never island values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("a namespace used as a value still stops by name", () => {
  test("NSI-R1 the namespace passed on inside a function", async () => {
    const row: Row = {
      id: "NSI-R1",
      files: {
        ...CORE,
        "main.js": `import * as core from "./index.js";\nfunction keys(ns) { return Object.keys(ns).length; }\nfunction run() { return keys(core); }\nconsole.log("before");\nconsole.log(run());`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "module namespace objects as first-class values");
  }, 600_000);
});
