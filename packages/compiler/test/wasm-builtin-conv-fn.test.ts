/* The builtin conversion functions as values in JavaScript sources:
 * String, Number and Boolean read as a VALUE where no builtin-token use
 * covers the site are the conversion function itself — on the WasmGC
 * lanes, the ONE interned function the tier answers for a primitive's
 * `constructor`, so identity holds across every read (`JSON.parse('""').constructor ===
 * String`). Held dynamically (an untyped object's member, an `any` slot,
 * a value read back from a dynamic table), a call follows JS argument
 * count: `String()` is "", `Number()` is 0, `Boolean()` is false; with an
 * argument, the conversion of the first one (ToString with a symbol's
 * description rule, ToNumber with Number's BigInt rule, ToBoolean); extra
 * arguments are ignored. `name` and `length` are Node's ("String", 1).
 * A binding the checker types as the constructor itself
 * (`const f = mk()` with `mk = () => String`) keeps the typed coercion
 * closure's one signature `(value: string) => primitive` (types.ts): a
 * one-string-argument call is exact and other arities refuse by name.
 * `new` through the value refuses by name (Node builds a wrapper object). picocolors
 * returns `String` itself as its no-color formatter (`() => String`). Rows
 * run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("builtin-conv-fn");

const ROWS: Row[] = [
  {
    id: "CONV-01 String held dynamically: argc, conversions, name, length, identity",
    files: {
      "main.js": `const h = JSON.parse("{}");
h.s = String;
console.log(JSON.stringify([h.s("x"), h.s(), h.s(12), h.s(-0), h.s(null), h.s(undefined), h.s(true), h.s([1, [2, 3]]), h.s({}), h.s(10n)]));
console.log(h.s.name, h.s.length, typeof h.s, h.s === String, h.s === JSON.parse('""').constructor, h.s === Number);
h.o = { toString() { return "custom"; } };
console.log(h.s(h.o), h.s("a", "b"));`,
    },
  },
  {
    id: "CONV-02 Number and Boolean held dynamically",
    files: {
      "main.js": `const h = JSON.parse("{}");
h.n = Number;
h.b = Boolean;
console.log(JSON.stringify([h.n(), h.n("12"), h.n(" 7 "), h.n("12px"), h.n(null), h.n(true), h.n([]), h.n(["5"]), h.n(10n), h.n("0x1f")]));
console.log(String(h.n(undefined)), String(h.n({})));
console.log(JSON.stringify([h.b(), h.b(0), h.b(""), h.b("0"), h.b({}), h.b(NaN), h.b(null), h.b([])]));
console.log(h.n.name, h.n.length, h.b.name, h.b.length, h.n === Number, h.b === Boolean, h.n !== h.b);`,
    },
  },
  {
    id: "CONV-03 the picocolors no-color formatter and the constructor read",
    files: {
      "main.js": `let formatter = (open, close) => (input) => open + ("" + input) + close;
let createColors = (enabled) => {
  let f = enabled ? formatter : () => String;
  return { red: f("<r>", "</r>"), bold: f("<b>", "</b>") };
};
const plain = createColors(process.argv.length > 99), rich = createColors(true);
console.log(plain.red("x"), plain.bold(3), rich.red("x"));
const five = JSON.parse("5");
console.log(five.constructor === Number, five.constructor(" 9 "), JSON.parse('"s"').constructor(4) + "!", JSON.parse("true").constructor());`,
    },
  },
  {
    id: "CONV-04 the typed binding: one string argument",
    files: {
      "main.js": `let mk = () => String;
const s = mk();
console.log(s("x"), s("12"));
let num = () => Number;
console.log(num()("  4 "), num()("x"));`,
    },
  },
];

describe("builtin conversion functions as values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("builtin conversion functions as values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("conversion-function shapes that stop by name", () => {
  test("CONV-05 a typed binding called with no argument", async () => {
    const row: Row = {
      id: "CONV-05",
      files: { "main.js": `let mk = () => String;\nconsole.log("before");\nconst s = mk();\nconsole.log(s());` },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "calls omitting a non-optional parameter of the callee's type");
  }, 600_000);
  test("CONV-06 new through the value", async () => {
    const row: Row = {
      id: "CONV-06",
      files: { "main.js": `const h = JSON.parse("{}");\nh.S = String;\nconsole.log("before");\nconsole.log(typeof new h.S("x"));` },
    };
    await checkFenced(scratch, row, "wasm-native", "before\n", "constructing a builtin read as a function value");
  }, 600_000);
});
