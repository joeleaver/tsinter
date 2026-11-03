import { prefix, levelName } from "./index.ts";
export const warnings: string[] = [];
export function warn(msg: string): void {
  const line = `${prefix()}[${levelName(1)}] ${msg}`;
  warnings.push(line);
  console.log(line);
}
try {
  warn("debug loaded");
} catch (e) {
  console.log("debug init:", (e as Error).message);
}
