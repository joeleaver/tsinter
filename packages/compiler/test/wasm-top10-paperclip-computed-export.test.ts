/* paperclip step 19: `module.exports = <call>` — a computed whole export
 * (picocolors ends with `module.exports = createColors()`). The export
 * is one const global assigned at the statement, typed by the value's
 * mapping or the JS checked-dynamic fallback; a requirer's binding IS
 * that value, so its member reads are reads of the value's properties and
 * the module runs once (identity across requires). Rows run under Node
 * and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkFenced, checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

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

// Members the module adds after the replacement (`module.exports.extra =
// 5`, picocolors' createColors) keep their own export storage: a
// requirer's member read sees them and identity holds; a use that would
// see the value WHOLE (Object.keys, passing it on) would miss them, so it
// stops by name (SEMANTICS.md S133's declared-values amendment). A later
// member that OVERWRITES one of the value's own properties keeps the
// load-time fence.
const EXPANDO: Row = {
  id: "PC19-04 module.exports = make(); module.exports.extra = 5, read by member",
  files: {
    "lib.js": `function make() { return { n: 1 }; }\nmodule.exports = make();\nmodule.exports.extra = 5;\nmodule.exports.twice = (x) => x * 2;`,
    "main.js": `const m = require("./lib.js");\nconsole.log(m.n, m.extra, m.twice(4));`,
  },
};

describe("paperclip: members added to a computed export (both lanes vs Node)", () => {
  test("PC19-04 wasm", async () => {
    await checkRow(scratch, EXPANDO, "wasm");
  });
  test("PC19-04 wasm-native", async () => {
    await checkRow(scratch, EXPANDO, "wasm-native");
  }, 600_000);
});

describe("paperclip: computed-export shapes that stop by name", () => {
  test("PC19-03 the value used whole while its module adds members", async () => {
    const row: Row = {
      id: "PC19-03 Object.keys over a computed export with added members",
      files: {
        "lib.js": `function make() { return { n: 1 }; }\nmodule.exports = make();\nmodule.exports.extra = 5;`,
        "main.js": `const m = require("./lib.js");\nconsole.log("before");\nconsole.log(Object.keys(m).join(","));`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "the module value 'm' used whole");
  }, 600_000);
  test("PC19-06 identity of a JavaScript require binding of such a module", async () => {
    await checkRefuses(
      scratch,
      {
        id: "PC19-06",
        files: {
          "lib.js": `function make() { return { n: 1 }; }\nmodule.exports = make();\nmodule.exports.extra = 5;`,
          "main.js": `const m = require("./lib.js");\nconsole.log(m === m);`,
        },
      },
      "it would be a COPY where JavaScript shares the object",
    );
  });
  test("PC19-05 a later member overwriting the value's own property", async () => {
    const row: Row = {
      id: "PC19-05 module.exports = make(); module.exports.n = 2",
      files: {
        "lib.js": `function make() { return { n: 1 }; }\nmodule.exports = make();\nmodule.exports.n = 2;`,
        "main.js": `const m = require("./lib.js");\nconsole.log(m.n);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'module.exports =' with a non-literal value");
  }, 600_000);
});
