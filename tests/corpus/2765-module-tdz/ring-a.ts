// An import cycle whose members RUN code (ring-a <-> ring-b, closed by
// ring-b's side-effect import): ring-b evaluates first, and its own early
// call into a function reading a later binding throws the TDZ error.
import { ringB } from "./ring-b.ts";
console.log("ring-a body");
export function ringReport(): string {
  return `ring ${ringB()} ${A_TAG}`;
}
export const A_TAG = "a";
