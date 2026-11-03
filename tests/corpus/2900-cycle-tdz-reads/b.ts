import d, { y as yy, z, v, E, count } from "./a.ts";
import * as ns from "./a.ts";
console.log("b start");
function attempt(label: string, f: () => string): string {
  try {
    return `${label}: ${f()}`;
  } catch (e) {
    return `${label}: ${(e as Error).name} ${(e as Error).message}`;
  }
}
console.log(attempt("alias", () => `${yy}`));
console.log(attempt("default", () => `${d}`));
console.log(attempt("class", () => `${new z().k}`));
console.log(attempt("ns member", () => `${ns.y}`));
console.log(attempt("ns default", () => `${ns.default}`));
console.log(attempt("typeof", () => typeof yy));
console.log(attempt("live let", () => `${count}`));
export const early = attempt("top-level alias", () => `${yy + 1}`);
export function late(): string {
  return `${yy} ${d} ${new z().k} ${v} ${E.A} ${E.B} ${ns.y} ${count}`;
}
