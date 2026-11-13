/* paperclip step 16: unary `~` over a dynamic value in a JavaScript
 * source. picocolors' formatter runs `~index` / `while (~index)` over
 * values its untyped parameters carry; the operand checks as a number and
 * complements natively (the checked-number stance, SEMANTICS.md S015's
 * step-16 amendment). Rows run under Node and on both WasmGC lanes; the
 * last one pins the registered divergence: a non-number stops at the
 * SC1100 "expected number" fence, where Node ToNumber-coerces. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-bitnot-dyn");

const ROWS: Row[] = [
  {
    id: "PC16-01 ~ over parsed and untyped-parameter values",
    files: {
      "main.js": `const v = JSON.parse("-1");
const w = JSON.parse("[5, 2.7, -3.2, 4294967296]");
console.log(~v, ~w[0], ~w[1], ~w[2], ~w[3]);
let replaceClose = (string, close, replace, index) => {
  let result = "", cursor = 0;
  do {
    result += string.substring(cursor, index) + replace;
    cursor = index + close.length;
    index = string.indexOf(close, cursor);
  } while (~index);
  return result + string.substring(cursor);
};
const s = JSON.parse('"a]b]c"');
console.log(replaceClose(s, "]", "|", s.indexOf("]")));
console.log(~JSON.parse("-1") ? "found" : "missing");`,
    },
  },
];

describe("paperclip: ~ over a dynamic value (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: ~ over a dynamic value (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: ~ over a non-number dynamic value stops by name", () => {
  test("PC16-02", async () => {
    const row: Row = {
      id: "PC16-02 ~ over a parsed string",
      files: { "main.js": `console.log("before");\nconst v = JSON.parse('"x"');\nconsole.log(~v);` },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "expected number at $, got string");
  }, 600_000);
});
