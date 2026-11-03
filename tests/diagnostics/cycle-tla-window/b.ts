import { total } from "./a.ts";
export function bump(n: number): number {
  return n + 1;
}
console.log(typeof total, bump(2));
