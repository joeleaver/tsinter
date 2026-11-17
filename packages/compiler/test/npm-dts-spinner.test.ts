/* SEMANTICS.md S133 (o): @clack/prompts' `spinner` shape. Its options
 * parameter destructures `{ output: n = process.stdout, …, ...I } = {}`, and
 * its result is an object literal of functions with a trailing getter
 * (`get isCancelled() { return S; }`). The parameter is the caller's
 * dynamic value. The result is the dynamic object Node's literal is, so the
 * program reads `isCancelled` through the getter, live. Rows run under Node
 * and on both lanes; the fence rows pin the shapes left out. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-dts-spinner");
const pj = (o: unknown): string => JSON.stringify(o);

const pkg = (js: string[], dts: string[]): Record<string, string> => ({
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
  "node_modules/ps/package.json": pj({ name: "ps", version: "1.0.0", type: "module", types: "./index.d.mts", exports: { ".": { types: "./index.d.mts", default: "./index.mjs" } } }),
  "node_modules/ps/index.d.mts": dts.join("\n"),
  "node_modules/ps/index.mjs": js.join("\n"),
});

// clack's spinner, cut down to what runs without a terminal: the options
// destructure (defaults, a rest, the `= {}` default, `output` defaulting to
// process.stdout), its message/stop/cancel closures over shared state, and
// the result literal with the trailing getter.
const SPINNER_JS = [
  `const settings = { withGuide: true, messages: { cancel: "Canceled", error: "Something went wrong" } };`,
  `export const spinner = ({ indicator: l = "dots", onCancel: h, output: n = process.stdout, cancelMessage: G, errorMessage: O, frames: E = ["a", "b"], delay: F = 80, signal: m, ...I } = {}) => {`,
  `  let d = false, S = false, s = "";`,
  `  const N = I.withGuide ?? settings.withGuide, C = (e) => e.replace(/\\.+$/, "");`,
  `  const P = (e = "") => { d = true, s = C(e), n.write(\`\${N ? "| " : ""}\${E[0]} \${s} (\${l}, \${F})\\n\`); };`,
  `  const a = (e = "", r = 0) => {`,
  `    if (!d) return;`,
  `    d = false, s = e || s, S = r === 1;`,
  `    n.write(\`\${r === 0 ? "o" : r === 1 ? "x" : "!"}  \${s}\${r === 1 ? " " + (G ?? settings.messages.cancel) : r === 2 ? " " + (O ?? settings.messages.error) : ""}\\n\`);`,
  `    S && typeof h == "function" && h();`,
  `  };`,
  `  return {`,
  `    start: P,`,
  `    stop: (e = "") => a(e, 0),`,
  `    message: (e = "") => { s = C(e ?? s); },`,
  `    cancel: (e = "") => a(e, 1),`,
  `    error: (e = "") => a(e, 2),`,
  `    clear: () => a("", 0),`,
  `    get isCancelled() { return S; }`,
  `  };`,
  `};`,
];

const SPINNER_DTS = [
  // @clack/prompts' own declarations for these names
  `import type { Readable, Writable } from "node:stream";`,
  `interface CommonOptions { input?: Readable; output?: Writable; signal?: AbortSignal; withGuide?: boolean }`,
  `export interface SpinnerOptions extends CommonOptions { indicator?: 'dots' | 'timer'; onCancel?: () => void; cancelMessage?: string; errorMessage?: string; frames?: string[]; delay?: number; styleFrame?: (frame: string) => string }`,
  `export interface SpinnerResult { start(msg?: string): void; stop(msg?: string): void; cancel(msg?: string): void; error(msg?: string): void; message(msg?: string): void; clear(): void; readonly isCancelled: boolean }`,
  `export declare const spinner: ({ indicator, onCancel, output, cancelMessage, errorMessage, frames, delay, signal, ...opts }?: SpinnerOptions) => SpinnerResult;`,
];

const ROWS: Row[] = [
  {
    id: "SPB-01 clack's spinner from TypeScript: options, closures over shared state, the live getter",
    npmStatic: ["ps"],
    files: {
      ...pkg(SPINNER_JS, SPINNER_DTS),
      "main.ts": [
        `import * as p from "ps";`,
        `const s = p.spinner();`,
        `console.log(s.isCancelled, typeof s.start, Object.keys(s).join(","));`,
        `s.start("Working...");`,
        `s.message("Still working..");`,
        `s.stop();`,
        `console.log(s.isCancelled);`,
        `const t = p.spinner();`,
        `t.start("Seeding");`,
        `t.cancel();`,
        `console.log(t.isCancelled, s.isCancelled);`,
        `const u = p.spinner();`,
        `u.start("Removing");`,
        `u.error("failed");`,
        `u.clear();`,
        `console.log(u.isCancelled);`,
      ].join("\n"),
    },
  },
  {
    id: "SPB-02 a spinner that is never started (paperclip's onboard/worktree shapes in a branch the run skips)",
    npmStatic: ["ps"],
    files: {
      ...pkg(SPINNER_JS, SPINNER_DTS),
      "main.ts": [
        `import * as p from "ps";`,
        `async function seed(run: boolean): Promise<void> {`,
        `  if (!run) return;`,
        `  const spinner = p.spinner();`,
        `  spinner.start("Seeding...");`,
        `  try { spinner.stop("Seeded."); } catch { spinner.stop("Failed."); }`,
        `}`,
        `await seed(process.argv.length > 99);`,
        `console.log("done");`,
      ].join("\n"),
    },
  },
];

describe("S133 (o): clack's spinner shape (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("S133 (o): clack's spinner shape (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("S133 (o): getter results outside the modeled shape refuse by name", () => {
  test("SPB-R1 a result literal with a data member beside its getter", async () => {
    await checkRefuses(scratch, {
      id: "SPB-R1",
      npmStatic: ["ps"],
      files: {
        ...pkg(
          [`export const mk = ({ start: s0 = 1, ...rest } = {}) => { let S = s0; return { inc: () => { S++; }, label: "c", get n() { return S; } }; };`],
          [`export interface Counter { inc(): void; label: string; readonly n: number }`, `export declare const mk: ({ start }?: { start?: number }) => Counter;`],
        ),
        "main.ts": [`import { mk } from "ps";`, `console.log("before");`, `const c = mk();`, `c.inc();`, `console.log(c.n);`].join("\n"),
      },
    }, "passing a value of type '{ get n(): number; inc: () => void; label: string }' into dynamically-executed ('any'-typed) code");
  }, 600_000);
});
