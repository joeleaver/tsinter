/* paperclip step 17: a JavaScript function with a defaulted parameter as
 * a VALUE when its own type has no static mapping. picocolors'
 * `let createColors = (enabled = isColorSupported) => ({ ...formatters })`
 * returns a table of implicit-any closures, so the binding types by the
 * JS checked-dynamic fallback; that fallback now spells an optional or
 * defaulted parameter as the undefined-armed slot (mapType's completed
 * signature), and the exact-arity check judges the value by the same
 * fallback. Short calls through the value complete with undefined, which
 * runs the default. Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-default-param-value");

const ROWS: Row[] = [
  {
    id: "PC17-01 a defaulted-parameter factory exported and called as a value",
    files: {
      "colors.js": `let supported = process.argv.length > 99;
let wrap = (open, close) => (input) => open + ("" + input) + close;
let createColors = (enabled = supported) => {
  let f = enabled ? wrap : () => (input) => "" + input;
  return { isColorSupported: enabled, red: f("<r>", "</r>"), bold: f("<b>", "</b>") };
};
module.exports.createColors = createColors;
module.exports.pick = (on = true, tag) => (on ? "on:" : "off:") + String(tag);`,
      "main.js": `const c = require("./colors.js");
const plain = c.createColors();
const rich = c.createColors(true);
console.log(plain.isColorSupported, plain.red("x"), plain.bold("y"));
console.log(rich.isColorSupported, rich.red("x"), rich.bold("y"));
const make = c.createColors;
console.log(make(false).red("z"), c.pick(), c.pick(false, 3), c.pick(undefined, "t"));`,
    },
  },
];

describe("paperclip: defaulted-parameter functions as values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: defaulted-parameter functions as values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
