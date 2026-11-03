import { bump } from "./b.ts";
export async function total(): Promise<number> {
  return bump(1);
}
await Promise.resolve();
