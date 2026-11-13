// SEMANTICS.md S144: a leading byte-order mark is kept, as bytes and as text.
import * as pw from "pw";
import { mem } from "tsinter:memory";

export function bom(s: string): string {
  pw.log(s);
  pw.log(String(s.length) + " " + String(s.charCodeAt(0)));
  const p = mem.scratch(6);
  mem.setU8(p, 0xef);
  mem.setU8(p + 1, 0xbb);
  mem.setU8(p + 2, 0xbf);
  mem.setU8(p + 3, 0x41);
  pw.log(String(mem.utf8(p, 4).length));
  return s;
}
