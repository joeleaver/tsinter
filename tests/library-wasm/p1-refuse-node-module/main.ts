import { cpus } from "node:os";
export function run(): number {
  return cpus().length;
}
