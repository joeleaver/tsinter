import { warn, LEVELS } from "./index.ts";
let calls = 0;
export function prefix(): string {
  calls++;
  return `#${calls} `;
}
export function formatAll(items: string[]): string {
  return items.map((s, i) => `${LEVELS[i % LEVELS.length]}:${s}`).join(", ");
}
try {
  warn("format loaded");
} catch (e) {
  console.log("format init:", (e as Error).message);
}
