import { aValue } from "./pair-a.ts";
export function bValue(): number {
  return aValue * 10 + B_BONUS;
}
export const B_BONUS = 5;
