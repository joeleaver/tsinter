import { Leaf } from "./nodes.ts";
let count = 0;
export class Base {
  constructor() {
    count++;
  }
  describe(): string {
    return "base";
  }
}
export function created(): number {
  return count;
}
export function make(n: number): Base {
  return new Leaf(n);
}
let probe = "";
try {
  probe = make(1).describe();
} catch (e) {
  probe = `${(e as Error).name}: ${(e as Error).message}`;
}
export const early = probe;
console.log("base done", early);
