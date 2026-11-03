import { Leaf } from "./leaf.ts";
export class Base {
  kids(): Leaf[] {
    return [];
  }
}
console.log("base end");
