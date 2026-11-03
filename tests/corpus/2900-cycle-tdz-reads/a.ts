import { late } from "./b.ts";
console.log("a start");
const x = 1;
export { x as y };
export default x + 1;
export class Z {
  k = 3;
}
export { Z as z };
export var v = 7;
export enum E {
  A = 1,
  B,
}
export let count = 0;
export function bump(): void {
  count += 10;
}
console.log("a late", late());
