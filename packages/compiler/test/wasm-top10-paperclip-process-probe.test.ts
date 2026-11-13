/* paperclip step 15: picocolors' process probe. It opens with
 * `let p = process || {}` and reads `(p.stdout || {}).isTTY`. `process` is
 * an object (always truthy, never nullish), so `process || x` /
 * `process ?? x` IS process, and a `let` the program never writes again
 * aliases it exactly like a const (stdlibGlobalAliasDecl). The stream
 * probe `(process.stdout || {}).isTTY` reads the stream's own isTTY (Node:
 * undefined on a pipe, as these rows run). Rows run under Node and on
 * both WasmGC lanes, from an untyped JavaScript module and from
 * TypeScript. A `let` the program writes later is no alias: its first
 * value is the process object itself, which has no runtime value form, so
 * the build stops there by name. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-process-probe");

const WRITTEN: Row = {
  id: "PC15-03 a let over process the program writes later",
  files: {
    "main.js": `let p = process || {};
const before = typeof p.platform;
p = { platform: "elsewhere" };
console.log(before, p.platform);`,
  },
};

const ROWS: Row[] = [
  {
    id: "PC15-01 let p = process || {} and the stream probe (JavaScript)",
    files: {
      "probe.js": `let p = process || {}, argv = p.argv || [], env = p.env || {};
let tty = (p.stdout || {}).isTTY;
let color = !(!!env.NO_COLOR_PC15 || argv.includes("--no-color")) && (!!env.FORCE_COLOR_PC15 || argv.includes("--color") || p.platform === "win32" || (tty && env.TERM !== "dumb"));
module.exports = { color: !!color, tty: String(tty), plat: p.platform === process.platform, n: argv.length > 0 };`,
      "main.js": `const probe = require("./probe.js");
console.log(probe.color, probe.tty, probe.plat, probe.n);`,
    },
  },
  {
    id: "PC15-02 process ?? {} and a let alias in TypeScript",
    files: {
      "main.ts": `let p = process ?? {};
console.log(typeof p.platform, String((p.stderr || {}).isTTY), typeof p.argv.length);`,
    },
  },
];

describe("paperclip: the process probe (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: the process probe (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: a written let over process stops by name", () => {
  test("PC15-03", async () => {
    await checkFenced(scratch, WRITTEN, "wasm-native", "", "the builtin 'process' used as a value");
  }, 600_000);
});
