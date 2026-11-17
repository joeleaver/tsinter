/* SEMANTICS.md S133: a declared promise result whose settled type the
 * declarations narrow (@clack/prompts' `confirm(): Promise<boolean |
 * symbol>` over an implementation inferred `Promise<boolean | symbol |
 * undefined>`): the program awaits a promise of the declared payload; the
 * implementation's settled value crosses into it with the usual checks (an
 * undefined rides, as S119 lets it and Node does; another arm the claim does
 * not cover ends the program by name where it settles). Rows run under Node
 * and on both WasmGC lanes. */
import { describe, expect, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-dts-promise");
const pj = (o: unknown): string => JSON.stringify(o);

const PKG: Record<string, string> = {
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/pq/package.json": pj({ name: "pq", version: "1.0.0", type: "module", types: "./dist/index.d.mts", exports: { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } }),
  "node_modules/pq/dist/index.d.mts": [
    `export interface ConfirmOptions { message: string; initialValue?: boolean; cancel?: boolean }`,
    `export interface TextOptions { message: string; initialValue?: string; cancel?: boolean }`,
    `export declare const confirm: (opts: ConfirmOptions) => Promise<boolean | symbol>;`,
    `export declare const text: (opts: TextOptions) => Promise<string | symbol>;`,
    `export declare function isCancel(v: unknown): v is symbol;`,
  ].join("\n"),
  "node_modules/pq/dist/index.mjs": [
    `const CANCEL = Symbol("clack:cancel");`,
    // Inference types these Promise<boolean | symbol | undefined> and
    // Promise<string | symbol | undefined>, as it does clack's.
    `export const confirm = async (opts) => { if (opts.cancel) return CANCEL; return opts.initialValue === true ? true : opts.initialValue === false ? false : undefined; };`,
    `export const text = async (opts) => { if (opts.cancel) return CANCEL; return typeof opts.initialValue === "string" ? String(opts.initialValue) : undefined; };`,
    `export function isCancel(v) { return typeof v === "symbol"; }`,
  ].join("\n"),
};

const ROWS: Row[] = [
  {
    id: "DPR-01 awaited declared promises of a narrower union (paperclip's p.confirm / p.text shapes)",
    npmStatic: ["pq"],
    files: {
      ...PKG,
      "main.ts": [
        `import * as p from "pq";`,
        `async function main(): Promise<void> {`,
        `  const backup = await p.confirm({ message: "Enable backups?", initialValue: true });`,
        `  if (p.isCancel(backup)) return;`,
        `  console.log("backup", backup);`,
        `  const dir = await p.text({ message: "Directory", initialValue: "/var/db" });`,
        `  if (!p.isCancel(dir)) console.log("dir", dir.toUpperCase());`,
        `  const cancelled = await p.confirm({ message: "Go?", cancel: true });`,
        `  console.log("cancelled", p.isCancel(cancelled));`,
        `}`,
        `void main();`,
      ].join("\n"),
    },
  },
];

describe("S133: a declared promise result narrower than the implementation's (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133: a declared promise result narrower than the implementation's (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

// Timing: the program's promise IS the implementation's (identity, ticks),
// so its settlement interleaves with other promise jobs exactly as in Node.
const TPKG: Record<string, string> = {
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/pr/package.json": pj({ name: "pr", version: "1.0.0", type: "module", types: "./dist/index.d.mts", exports: { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } }),
  "node_modules/pr/dist/index.d.mts": [
    `export declare const confirm: (flag: boolean) => Promise<boolean | symbol>;`,
    `export declare function same(flag: boolean): Promise<boolean>;`,
    `export declare function confirmN(flag: boolean | null): Promise<boolean | symbol>;`,
  ].join("\n"),
  "node_modules/pr/dist/index.mjs": [
    `export const confirm = async (flag) => { const r = flag === true ? true : flag === false ? false : undefined; return r; };`,
    `export async function same(flag) { return flag === true; }`,
    `export async function confirmN(flag) { return flag === true ? true : flag === false ? false : null; }`,
  ].join("\n"),
};
const CHAIN = `Promise.resolve().then(() => console.log("m1")).then(() => console.log("m2")).then(() => console.log("m3")).then(() => console.log("m4")).then(() => console.log("m5"));`;
const T = (main: string): Record<string, string> => ({ ...TPKG, "main.ts": `import { confirm, confirmN, same } from "pr";\n${main}` });
const ROWS3: Row[] = [
  { id: "DPR-T1 await beside a .then chain", npmStatic: ["pr"], files: T(`async function main(): Promise<void> {\n  ${CHAIN}\n  queueMicrotask(() => console.log("q1"));\n  const v = await confirm(true);\n  console.log("got", v);\n}\nvoid main();`) },
  { id: "DPR-T1b control: the same with no payload mismatch", npmStatic: ["pr"], files: T(`async function main(): Promise<void> {\n  ${CHAIN}\n  const v = await same(true);\n  console.log("got", v);\n}\nvoid main();`) },
  { id: "DPR-T8 awaits in a loop keep Node's interleaving", npmStatic: ["pr"], files: T(`async function main(): Promise<void> {\n  ${CHAIN}\n  for (let i = 0; i < 3; i++) { const v = await confirm(i % 2 === 0); console.log("i", i, v); }\n}\nvoid main();`) },
];

// Consumers other than `await` (a typed .then callback, Promise.race entries)
// would need the settled value converted in a promise reaction; they refuse
// by name rather than run late (a wrapper's extra settle) or misread.
describe("S133: other consumers of a narrower declared promise refuse by name", () => {
  const refusal = async (id: string, main: string, expected: string): Promise<void> => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { compile } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), `${id}-`));
    for (const [n, s] of Object.entries(T(main))) {
      mkdirSync(join(dir, n, ".."), { recursive: true });
      writeFileSync(join(dir, n), s);
    }
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", npmStatic: ["pr"] });
    expect(res.ok).toBe(false);
    expect((res.diagnostics ?? []).map((d) => d.message).join("\n")).toContain(expected);
  };
  test("DPR-T2 a declaration-typed .then callback", async () => {
    await refusal("dpr-t2", `confirm(true).then((v) => console.log("then", v));\n${CHAIN}`, "is expected");
  }, 600_000);
  test("DPR-T3 Promise.race over it", async () => {
    await refusal("dpr-t3", `async function main(): Promise<void> {\n  const r = await Promise.race([confirm(true), Promise.resolve("other")]);\n  console.log("race", r);\n}\nvoid main();`, "is expected");
  }, 600_000);
  test("DPR-T4 Promise.all over it refuses by name (no internal error)", async () => {
    await refusal("dpr-t4", `async function main(): Promise<void> {\n  const [a, b] = await Promise.all([confirm(true), confirm(false)]);\n  console.log(a, b);\n}\nvoid main();`, "is expected");
  }, 600_000);
});

describe("S133: a narrower declared promise keeps the implementation's promise (timing vs Node)", () => {
  test.for(ROWS3.map((r) => [r.id, r] as const))("%s wasm", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
  test.for(ROWS3.map((r) => [r.id, r] as const))("%s wasm-native", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

// An undefined the implementation settles with under the narrower claim rides
// as Node lets it (SEMANTICS.md S119: a plain slot holds undefined on these
// lanes); the next step that needs a value is where Node itself would throw.
const ROWS2: Row[] = [
  {
    id: "DPR-02 confirm() settling undefined (no initialValue) under a Promise<boolean | symbol> claim: the undefined rides, as in Node",
    npmStatic: ["pq"],
    files: {
      ...PKG,
      "main.ts": `import * as p from "pq";\nconsole.log("before");\nconst v = await p.confirm({ message: "?" });\nconsole.log(typeof v, v === undefined);`,
    },
  },
];

describe("S133: a settled value outside the declared payload stops naming the claim", () => {
  test("DPR-R2 confirmN() settling null under a Promise<boolean | symbol> claim", async () => {
    const row: Row = { id: "DPR-R2", npmStatic: ["pr"], files: T(`console.log("before");\nconst v = await confirmN(null);\nconsole.log(typeof v);`) };
    await checkFenced(scratch, row, "wasm-native", "before\n", "pr's declarations type the settled value of 'confirmN(…)' as 'boolean | symbol', but its implementation produced null");
  }, 600_000);
});

describe("S133: an undefined settled value under a narrower declared promise (both lanes vs Node)", () => {
  test.for(ROWS2.map((r) => [r.id, r] as const))("%s wasm", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
  test.for(ROWS2.map((r) => [r.id, r] as const))("%s wasm-native", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
