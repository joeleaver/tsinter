/* paperclip step 18: a method call named like one of String.prototype's
 * legacy HTML methods (bold, italics, link, sub, ...) on a dynamic value.
 * picocolors' color table has a `bold` member; `pc.bold(s)` over the
 * dynamic table used to refuse at compile time, since on a STRING the name
 * is a real method no stored-member read models. It now rides the runtime
 * dispatch: an object's own member is called (this bound), a string
 * receiver stops by name ("'String.prototype.bold' on a dynamic value is
 * not supported yet"), and every other kind throws Node's
 * is-not-a-function. Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-legacy-html");

const ROWS: Row[] = [
  {
    id: "PC18-01 own bold/italics/sub members on a dynamic object",
    files: {
      "main.js": `const o = JSON.parse('{"tag": "b"}');
o.bold = function (s) { return "<" + this.tag + ">" + s + "</" + this.tag + ">"; };
o.italics = (s) => "_" + s + "_";
o.sub = (s) => "[" + s + "]";
console.log(o.bold("x"), o.italics("y"), o.sub("z"));
const n = JSON.parse("[1]");
try { n.bold("q"); } catch (e) { console.log(e instanceof TypeError, e.message); }`,
    },
  },
];

describe("paperclip: legacy-HTML method names on dynamic values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: legacy-HTML method names on dynamic values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: String.prototype.bold on a dynamic string stops by name", () => {
  test("PC18-02", async () => {
    const row: Row = {
      id: "PC18-02 bold on a parsed string",
      files: { "main.js": `console.log("before");\nconst s = JSON.parse('"x"');\nconsole.log(s.bold());` },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "'String.prototype.bold' on a dynamic value is not supported yet");
  }, 600_000);
});
