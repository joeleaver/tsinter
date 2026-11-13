/* deepseek round 2, step 1: cosmokit's Binary helpers (vendor/cosmokit/
 * src/types.ts). `Source<ArrayBufferLike>` = ArrayBuffer | SharedArrayBuffer
 * | ArrayBufferView flattens to the ArrayBuffer and view arms (no
 * SharedArrayBuffer value exists here); %TypedArray%.from collects its
 * source then maps it; ArrayBuffer.isView reads a dynamic value's bytes
 * kind. Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("deepseek-binary");

const ROWS: Row[] = [
  {
    id: "DSB-01 cosmokit's Binary: Source<ArrayBufferLike>, fromSource, base64 and hex round trips",
    files: {
      "main.ts": `export type Source<T extends ArrayBufferLike = ArrayBufferLike> = T | ArrayBufferView<T>;
export function fromSource<T extends ArrayBufferLike>(source: Source<T>): T {
  if (ArrayBuffer.isView(source)) {
    return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as T;
  } else {
    return source;
  }
}
export function toBase64(source: Source) {
  source = fromSource(source);
  return Buffer.from(source).toString("base64");
}
export function fromBase64(source: string) {
  if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
  return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
}
export function toHex(source: Source) {
  source = fromSource(source);
  return Buffer.from(source).toString("hex");
}
export function fromHex(source: string) {
  const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
  const buffer: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    buffer.push(parseInt(\`\${hex[i]}\${hex[i + 1]}\`, 16));
  }
  return Uint8Array.from(buffer).buffer;
}
const view = new Uint8Array([104, 105, 33, 0, 255]).subarray(1, 4);
console.log(toBase64(view), toHex(view), toBase64(view.buffer), toHex(new Uint32Array([1, 258])));
const back = fromBase64(toBase64(view));
console.log(back instanceof ArrayBuffer, back.byteLength, toHex(fromHex("0aff10e")), fromHex("abcd").byteLength);
function isSource(value: any): boolean {
  return ArrayBuffer.isView(value);
}
console.log(isSource(new Uint8Array(1)), isSource("x"), isSource(3), isSource(Buffer.from("a")));
console.log(isSource(new Uint32Array(2)), isSource(new Int32Array(1)), isSource(new Float32Array(3)), isSource([1, 2]), isSource({ byteLength: 1 }));
function notView(value: unknown): boolean {
  return !ArrayBuffer.isView(value);
}
console.log(notView(new Uint32Array(1)), notView(new Int32Array(1)), notView(new Float32Array(1)), notView(new Uint8Array(1)), notView(null), notView("s"));
const bag: unknown[] = [new Float32Array(1), new Int32Array(2), "t"];
console.log(bag.map((b) => ArrayBuffer.isView(b)).join(","));`,
    },
  },
  {
    id: "DSB-02 %TypedArray%.from: sources, mappers over a snapshot, element coercion",
    nodeTypes: false,
    files: {
      "main.ts": `function i32(a: Int32Array): string {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(a[i]);
  return out.join(",");
}
function u32(a: Uint32Array): string {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(a[i]);
  return out.join(",");
}
function f32(a: Float32Array): string {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(a[i]);
  return out.join(",");
}
console.log(Uint8Array.from([1, 2, 300, -1, 2.7]).join(","), i32(Int32Array.from([2 ** 31, -1.5])), f32(Float32Array.from([0.1])));
console.log(Uint8Array.from("hé€", (c) => c.charCodeAt(0)).join(","), u32(Uint32Array.from("ab", (c, k) => c.charCodeAt(0) * 1000 + k)));
const src = [1, 2, 3];
const mapped = Uint8Array.from(src, (v, k) => {
  src.push(v);
  return v * 10 + k;
});
console.log(mapped.join(","), src.length);
const u = Uint8Array.from(new Uint8Array([7, 8]));
console.log(u.join(","), Uint8Array.from([]).length, Uint8Array.from("😀x", (c) => c.length).join(","));`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`deepseek round 2 step 1: cosmokit Binary (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}
