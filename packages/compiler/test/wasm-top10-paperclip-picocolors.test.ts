/* paperclip: picocolors, the real vendored package (1.1.1), compiled
 * statically (--npm-static) while the program types against its shipped
 * declarations (SEMANTICS.md S133). The declarations say
 * `declare const picocolors: Colors & { createColors }; export =
 * picocolors`; the implementation is `module.exports = createColors()`
 * plus the `module.exports.createColors = createColors` expando. The
 * program's `pc` IS the implementation's value: member reads read its
 * members and cross each into the declared member type, so identity holds
 * and the expando is visible; a use that would see the value whole
 * (passing it on, enumerating it) refuses by name, since it would miss the
 * expando. Rows run under Node and on both WasmGC lanes with the colour
 * switches picocolors' probe reads (NO_COLOR, FORCE_COLOR, --color; the
 * rows' stdout is a pipe, never a TTY). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-picocolors");
const vendored = join(import.meta.dirname, "../../../tests/fixtures/npm-static/node_modules/picocolors");
const pkg: Record<string, string> = Object.fromEntries(
  ["package.json", "picocolors.js", "picocolors.d.ts", "types.d.ts"].map((f) => [
    `node_modules/picocolors/${f}`,
    readFileSync(join(vendored, f), "utf8"),
  ]),
);

const MAIN = `import pc from "picocolors";
console.log(JSON.stringify([pc.green("ok"), pc.red("fail"), pc.bold(pc.blue("deep")), pc.dim(3), pc.italic(null), pc.underline(undefined)]));
console.log(String(pc.isColorSupported), String(pc === pc));
const rich = pc.createColors(true);
console.log(JSON.stringify([rich.red("r"), rich.bold(rich.red("nested")), rich.isColorSupported]));
const plain = pc.createColors(false);
console.log(plain.green("g"), String(plain.isColorSupported));`;

const SWITCHES: [string, Record<string, string | undefined>][] = [
  ["unset (piped)", { NO_COLOR: undefined, FORCE_COLOR: undefined, CI: undefined }],
  ["FORCE_COLOR=1", { NO_COLOR: undefined, FORCE_COLOR: "1", CI: undefined }],
  ["NO_COLOR=1", { NO_COLOR: "1", FORCE_COLOR: undefined, CI: undefined }],
  // (NO_COLOR and FORCE_COLOR together: Node's own stderr warning that it
  // ignores NO_COLOR belongs to its console-colour machinery — GH #207.)
];

const ROWS: Row[] = SWITCHES.map(([label, env], i) => ({
  id: `PCC-0${i + 1} member reads, calls and createColors — ${label}`,
  npmStatic: ["picocolors"],
  env,
  files: { ...pkg, "main.ts": MAIN },
}));

describe("paperclip: picocolors through its declarations (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: picocolors through its declarations (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: picocolors used whole refuses by name", () => {
  test("PCC-R1 passing the module value on", async () => {
    await checkRefuses(
      scratch,
      {
        id: "PCC-R1",
        npmStatic: ["picocolors"],
        files: {
          ...pkg,
          "main.ts": `import pc from "picocolors";\nfunction paint(c: typeof pc, s: string): string { return c.cyan(s); }\nconsole.log(paint(pc, "x"));`,
        },
      },
      "the module value 'pc' used whole",
    );
  });
});
