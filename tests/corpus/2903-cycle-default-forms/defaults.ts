import { report } from "./readers.ts";
console.log("defaults start");
export function helper(n: number): number {
  return n * 100;
}
const ready = "ready";
export const alias = ready;
console.log("defaults mid", report());
export default function named(n: number): number {
  return n + 1;
}
