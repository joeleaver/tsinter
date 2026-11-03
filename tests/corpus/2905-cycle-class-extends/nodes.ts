import { Base } from "./base.ts";
let leaves = 0;
export class Leaf extends Base {
  static kind: string = "leaf-class";
  n: number;
  constructor(n: number) {
    super();
    leaves++;
    this.n = n;
  }
  describe(): string {
    return `leaf${this.n}`;
  }
}
export class Wrapper extends Base {
  inner: Base;
  constructor(inner: Base) {
    super();
    this.inner = inner;
  }
  describe(): string {
    return `wrap(${this.inner.describe()})`;
  }
}
export function leafCount(): number {
  return leaves;
}
console.log("nodes done", new Leaf(2).describe());
