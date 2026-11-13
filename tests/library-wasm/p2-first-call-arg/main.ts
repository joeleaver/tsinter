// The first call carries a string while the module's top level allocates:
// the argument is decoded before module evaluation, so the heap can grow.
import * as pw from "pw";
import { mem } from "tsinter:memory";

const table = mem.alloc(4096);
mem.setU32(table, 5);

export function echo(s: string): string {
  pw.log(s + " " + mem.u32(table));
  return "<" + s + ">";
}

export function two(s: string, t: string): string {
  const p = mem.alloc(70000);
  mem.setU8(p, 1);
  return s + "|" + t;
}
