/* `switch` over a checked-dynamic discriminant (an implicit-any JavaScript
 * value — zod's `switch (def.type)`) whose cases are all string or all
 * number literals: the typed switch, where a value of another kind matches
 * no case (Node's `===`), so the default runs. Fall-through, grouped cases
 * and a default in the middle keep JS order. Other case shapes keep the
 * named refusal. Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("switch-dyn");

const ROWS: Row[] = [
  {
    id: "SWD-01 string cases over parsed values of every kind",
    files: {
      "main.js": `function kind(def) {
  switch (def.type) {
    case "string": return "S";
    case "number":
    case "bigint": return "N";
    default: return "other:" + typeof def.type;
    case "object": return "O";
  }
}
for (const v of JSON.parse('[{"type":"string"},{"type":"number"},{"type":"bigint"},{"type":"object"},{"type":5},{"type":null},{},{"type":"str"}]')) console.log(kind(v));`,
    },
  },
  {
    id: "SWD-02 number cases, fall-through and a string that looks like a number",
    files: {
      "main.js": `function step(x) {
  let out = "";
  switch (x) {
    case 1: out += "one;";
    case 2: out += "two;"; break;
    case 3: out += "three;"; break;
    default: out += "dflt;";
  }
  return out;
}
for (const v of JSON.parse('[1, 2, 3, 4, "1", true, -0, 0]')) console.log(step(v));`,
    },
  },
];

describe("switch over a dynamic discriminant (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("switch over a dynamic discriminant (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("switch over a dynamic discriminant: other case shapes refuse by name", () => {
  test("SWD-R1 mixed string and number cases", async () => {
    const row: Row = {
      id: "SWD-R1",
      files: { "main.js": `console.log("before");\nconst v = JSON.parse("1");\nswitch (v) { case 1: console.log("n"); break; case "1": console.log("s"); break; }` },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "switch statements on 'unknown' values");
  }, 600_000);
});
