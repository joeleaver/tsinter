import { warn } from "./index.ts";
export const LEVELS: string[] = ["info", "warn", "error"];
export function levelName(i: number): string {
  return LEVELS[i] ?? "?";
}
warn("levels loaded");
console.log("levels", levelName(2));
