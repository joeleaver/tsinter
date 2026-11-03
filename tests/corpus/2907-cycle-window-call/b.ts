import { aye } from "./a.ts";
export function bee(n: number): number {
  return n <= 0 ? 0 : aye(n - 1) + 1;
}
