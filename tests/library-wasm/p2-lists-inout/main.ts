// Lists both ways: views send their own elements, NaN elements are
// canonical (S146), a list result lands in the result buffer.
import * as pw from "pw";

export function send(): void {
  const f = new Float32Array([Math.asin(2), -(0 / 0), 1.5, NaN]);
  pw.put_f32s(f);
  pw.put_f32s(f.subarray(1, 3));
  const u8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  pw.put_bytes(u8.subarray(1, 8));
  const u = new Uint32Array([1, 2, 3, 4]);
  pw.put_u32s(u.subarray(1));
}

export function echoB(b: Uint8Array): Uint8Array {
  pw.put_bytes(b);
  return b.subarray(1);
}

export function sumU(b: Uint32Array): number {
  let t = 0;
  for (const x of b) t += x;
  return t;
}
