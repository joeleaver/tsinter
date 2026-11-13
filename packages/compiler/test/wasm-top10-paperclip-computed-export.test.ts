/* paperclip step 19: `module.exports = <call>` — a computed whole export
 * (picocolors ends with `module.exports = createColors()`). The export
 * is one const global assigned at the statement, typed by the value's
 * mapping or the JS checked-dynamic fallback; a requirer's binding IS
 * that value, so its member reads are reads of the value's properties and
 * the module runs once (identity across requires). Rows run under Node
 * and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-computed-export");

const ROWS: Row[] = [
  {
    id: "PC19-01 a typed computed export and its members",
    files: {
      "lib.js": `console.log("lib runs");
function make(n) { return { n: n, label: "v" + n, twice: (x) => x * 2 }; }
module.exports = make(3);`,
      "main.js": `const m = require("./lib.js");
const again = require("./lib.js");
console.log(m.n, m.label, m.twice(21), m === again);`,
    },
  },
  {
    id: "PC19-02 a computed export of implicit-any closures (the dynamic fallback)",
    files: {
      "colors.js": `let wrap = (open, close) => (input) => open + ("" + input) + close;
let createColors = (enabled = false) => {
  let f = enabled ? wrap : () => (input) => "" + input;
  return { isColorSupported: enabled, red: f("<r>", "</r>"), dim: f("<d>", "</d>") };
};
module.exports = createColors();`,
      "main.js": `const pc = require("./colors.js");
console.log(pc.isColorSupported, pc.red("x"), pc.dim(4));`,
    },
  },
];

describe("paperclip: computed module.exports (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: computed module.exports (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

// Later expandos on a computed export keep the load-time fence (the S133
// per-member-crossing unit lifts it with a dynamic export object).
describe("paperclip: a computed export with later expandos stops by name", () => {
  test("PC19-03", async () => {
    const row: Row = {
      id: "PC19-03 module.exports = make(); module.exports.extra = 5",
      files: {
        "lib.js": `function make() { return { n: 1 }; }\nmodule.exports = make();\nmodule.exports.extra = 5;`,
        "main.js": `const m = require("./lib.js");\nconsole.log(m.n, m.extra, Object.keys(m).join(","));`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'module.exports =' with a non-literal value");
  }, 600_000);
});
