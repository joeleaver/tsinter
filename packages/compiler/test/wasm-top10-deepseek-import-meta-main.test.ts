/* deepseek step 1: `import.meta.main`. deepseek's CLI entry (apps/cli/src/bin.ts)
 * runs its main only `if (import.meta.main)`; Node 24 answers true in the
 * module it was started with and false everywhere else, so the read is a
 * compile-time constant per file. Synthetic rows written from reading the
 * project; each runs under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("ds-import-meta-main");

const ROWS: Row[] = [
  {
    id: "DS1-01 the entry sees true, an imported module false; the guard runs main once",
    files: {
      "lib.ts": `export const libIsMain: boolean = import.meta.main;
export function run(tag: string): void {
  console.log("run", tag, import.meta.main);
}
if (import.meta.main) console.log("never: lib is not the entry");`,
      "main.ts": `import { libIsMain, run } from "./lib.ts";
console.log("entry", import.meta.main, "lib", libIsMain);
if (import.meta.main) {
  run("cli");
}
const flags = [import.meta.main, !import.meta.main];
console.log(JSON.stringify(flags), typeof import.meta.main);`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`deepseek step 1: import.meta.main (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}
