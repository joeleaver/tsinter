// The ENTRY module sits inside the cycle (main → parser → main). Node
// evaluates parser.ts first, while main.ts is mid-evaluation: main's
// function DECLARATIONS are hoisted (initialized at link), so parser's
// top level may call them — and their reads of main's own let/const
// bindings are the TDZ hazard. Mutual recursion across the cycle and a
// class whose static initializer calls into the other module.
import { parse, Parser, registry } from "./parser.ts";
console.log("main start", registry.length);
export function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
export function describe(): string {
  return `table has ${table.length}`;
}
export function even(n: number): boolean {
  return n === 0 ? true : odd(n - 1);
}
function odd(n: number): boolean {
  return n === 0 ? false : even(n - 1);
}
export const table: string[] = ["x", "y"];
console.log(parse("12a3"), describe(), new Parser("7").value());
console.log("main end", registry.join(","));
