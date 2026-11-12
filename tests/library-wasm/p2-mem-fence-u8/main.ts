// tsinter:memory's checks: a fence, never a silent wrap or an engine trap.
import * as pw from "pw";
import { mem } from "tsinter:memory";

export function run(): void {
  pw.note_f64(1);
  mem.setU8(mem.scratch(4), 300);
}
