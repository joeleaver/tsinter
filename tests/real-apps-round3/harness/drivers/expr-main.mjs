// Expression evaluation through expr-eval 2.0.2 as published (UMD bundle, --npm-static expr-eval).
import { Parser } from "expr-eval";

const p = new Parser();
const cases = [
  ["2 + 3 * 4", {}],
  ["x ^ 2 + y", { x: 3, y: 1 }],
  ["sin(0) + cos(0)", {}],
  ["max(1, 5, 3) - min(2, 4)", {}],
  ["a > b ? a : b", { a: 2, b: 7 }],
  ["sqrt(16) + abs(-3) + floor(2.7)", {}],
  ['"abc" || "def"', {}],
  ['length("hello")', {}],
  ["f(x) = x * 2; f(21)", {}],
  ["[1, 2, 3][1]", {}],
  ["x == 3 and y != 2", { x: 3, y: 1 }],
  ["not (1 < 2)", {}],
  ["10 % 3 + 4!", {}],
  ["log(E)", {}],
  ["roundTo(3.14159, 2)", {}],
  ["1 +", {}],
  ["undefinedVar * 2", {}],
];
for (const [e, v] of cases) {
  try {
    console.log(e, "=>", JSON.stringify(p.evaluate(e, v)));
  } catch (err) {
    console.log(e, "!!", err.message);
  }
}
const ex = Parser.parse("2 * x + y");
console.log(ex.toString(), "|", ex.variables().join(","), "|", ex.simplify({ x: 4 }).toString(), "|", ex.substitute("y", "x + 1").toString());
console.log(Parser.evaluate("z * 3", { z: 5 }));
