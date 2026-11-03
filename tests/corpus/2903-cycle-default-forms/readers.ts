import named, { helper } from "./defaults.ts";
import Shape from "./shapes.ts";
import lbl from "./label.ts";
import { default as again } from "./label.ts";
console.log("readers start");
function attempt(f: () => string): string {
  try {
    return f();
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
}
export function report(): string {
  return [
    attempt(() => `named=${named(1)}`),
    attempt(() => `helper=${helper(1)}`),
    attempt(() => `shape=${new Shape().area()}`),
    attempt(() => `label=${lbl}`),
    attempt(() => `again=${again.length}`),
  ].join(" | ");
}
console.log("readers", report());
