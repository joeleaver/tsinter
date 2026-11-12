// Typed arrays to the host: copied element by element, little-endian;
// a view sends only its own elements.
import * as pw from "pw";

export function send(): void {
  const b = new Uint8Array([1, 2, 3, 250, 255]);
  pw.put_bytes(b);
  pw.put_bytes(b.subarray(1, 3));
  pw.put_bytes(new Uint8Array(0));
  pw.put_u32s(new Uint32Array([0, 1, 4294967295, 123456789]));
  pw.put_f32s(new Float32Array([0.5, -0, 1e-45, 3.4e38, 0.1]));
  const big = new Uint32Array(1000);
  for (let i = 0; i < big.length; i++) big[i] = i * 3;
  pw.put_u32s(big.subarray(995));
}
