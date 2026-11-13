// SEMANTICS.md S146: a NaN stored into a typed array has the canonical
// payload, whatever the engine produced (Math.asin(2) is a NaN whose bits
// differ between Node and the module's own Math). Node's typed-array stores
// cannot be hooked, so this row's output is recorded.
import * as pw from "pw";

export function store(x: number): void {
  const f = new Float32Array(2);
  f[0] = Math.asin(x);
  f[1] = 0 / 0;
  const dv = new DataView(f.buffer);
  for (let i = 0; i < 8; i++) pw.note_f64(dv.getUint8(i));
}
