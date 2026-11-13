// The heap grows below the scratch arena, so a heap block that must grow it
// while this call's scratch is live is a fence (a tsinter limit, S122):
// Node's shim has no such limit, so this row's output is recorded.
import * as pw from "pw";
import { mem } from "tsinter:memory";

export function ok(): void {
  const a = mem.alloc(16);
  const s = mem.scratch(16);
  mem.setU8(s, 1);
  mem.free(a);
  const b = mem.alloc(16);
  pw.note_f64(mem.u8(s));
  mem.free(b);
}

export function bad(): void {
  const s = mem.scratch(16);
  mem.setU8(s, 1);
  mem.alloc(100000);
}
