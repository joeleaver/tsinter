// A declaration-only import cycle (pair-a <-> pair-b): no member's top
// level runs user code, so nothing can observe a binding early and every
// cross-module read sees the initialized value.
import { bValue } from "./pair-b.ts";
export const aValue = 2;
export function pairSum(): number {
  return aValue + bValue();
}
