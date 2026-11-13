import { randomBytes } from "crypto";
export function run(): number {
  return randomBytes(4).length;
}
