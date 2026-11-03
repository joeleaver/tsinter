import { isDigit, describe, even } from "./main.ts";
console.log("parser start");
// Hoisted function declarations of a module still evaluating: callable.
console.log("isDigit", isDigit("4"), isDigit("q"), even(10));
try {
  console.log(describe());
} catch (e) {
  console.log("describe:", (e as Error).name, (e as Error).message);
}
export const registry: string[] = [];
export function parse(s: string): number {
  let n = 0;
  for (const c of s) if (isDigit(c)) n = n * 10 + Number(c);
  return n;
}
export class Parser {
  static readonly tag: string = register("Parser", even(4));
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }
  value(): number {
    return parse(this.src);
  }
}
function register(name: string, ok: boolean): string {
  registry.push(`${name}:${ok}`);
  return name;
}
console.log("parser end", Parser.tag);
