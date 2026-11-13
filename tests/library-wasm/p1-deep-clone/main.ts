// SEMANTICS.md S142: the runtime's recursive helpers count depth too, so a
// structured clone nested past max_depth stops by the counter on every
// engine (V8's own stack would end near 5,000 and wasmtime's near 6,000).
// Node clones far deeper, so this row's output is recorded.
import * as pw from "pw";

type N = { c: N | null; v: number };

export function clone(n: number): void {
  let t: N | null = null;
  for (let i = 0; i < n; i++) t = { c: t, v: i };
  const u = structuredClone(t);
  pw.note_f64(u === null ? -1 : u.v);
}
