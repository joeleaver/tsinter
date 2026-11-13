/* paperclip step 11: import.meta.url / .filename / .dirname. paperclip's
 * CLI locates its own package files from `import.meta.url`
 * (`fileURLToPath(new URL("../package.json", import.meta.url))`), which
 * fenced as module-loader metadata. They are now per-module compile-time
 * constants, the module's REAL source location at build time (SEMANTICS.md
 * S139, symlinks resolved as Node's loader resolves them; __filename and
 * __dirname likewise): Node's exact values when the binary runs beside the
 * tree it was built from, as these rows do. import.meta.resolve, the
 * import.meta object itself, and import.meta in a CommonJS module (Node's
 * SyntaxError) refuse by name. Rows run under Node and on both WasmGC
 * lanes; a helper module checks the value is per module. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-import-meta");

const ROWS: Row[] = [
  {
    id: "PC11-01 import.meta.url, filename and dirname, per module",
    files: {
      "lib/where.ts": `export const here = import.meta.url;
export const dir = import.meta.dirname;`,
      "main.ts": `import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { here, dir } from "./lib/where.ts";
const self = fileURLToPath(import.meta.url);
console.log(import.meta.url.startsWith("file://"), self === import.meta.filename, path.dirname(self) === import.meta.dirname);
console.log(path.basename(self), path.basename(fileURLToPath(here)), path.relative(import.meta.dirname, dir));
const pkg = fileURLToPath(new URL("./package.json", import.meta.url));
console.log(path.relative(import.meta.dirname, pkg));`,
    },
  },
  {
    // The entry is reached through a symlinked directory: Node names the
    // module by its real path, and so do the compiled constants.
    id: "PC11-02 import.meta through a symlinked directory",
    links: { via: "real" },
    entry: "via/main.ts",
    files: {
      "real/main.ts": `import * as path from "node:path";
import { fileURLToPath } from "node:url";
console.log(path.basename(import.meta.dirname), path.basename(path.dirname(fileURLToPath(import.meta.url))), path.basename(path.dirname(import.meta.filename)));`,
    },
  },
  {
    id: "PC11-03 __dirname / __filename through a symlinked directory (CommonJS)",
    links: { via: "real" },
    entry: "via/main.cjs",
    files: {
      "real/main.cjs": `const path = require("node:path");
console.log(path.basename(__dirname), path.basename(path.dirname(__filename)), path.basename(__filename));`,
    },
  },
];

describe("paperclip: import.meta (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: import.meta (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: the rest of import.meta keeps the fence", () => {
  test("PC11-R2 import.meta in a CommonJS module", async () => {
    await checkRefuses(scratch, { id: "PC11-R2", files: { "main.cts": `console.log(import.meta.url);` } }, "'import.meta' in a CommonJS module");
  });
  test("PC11-R1 import.meta.resolve", async () => {
    await checkRefuses(scratch, { id: "PC11-R1", files: { "main.ts": `console.log(import.meta.resolve("./x.js"));` } }, "ImportMeta.resolve");
  });
});
