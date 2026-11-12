/* ArrayBuffer steps 1-3 (docs/design/arraybuffer.md): ArrayBuffer is a value
 * on the WasmGC lanes — the storage array its views share. new
 * ArrayBuffer(n) (ToIndex, Node's "Invalid array buffer length"
 * RangeError), byteLength, slice (a fresh copy over relative/clamped
 * indices), a view's .buffer, and identity (two reads of one view's .buffer
 * are ===). Step 2: views over an ArrayBuffer (typed arrays, Buffer.from,
 * DataView) with Node's RangeErrors, ArrayBuffer.isView, instanceof, and
 * ArrayBuffer | view unions. Step 3: util.inspect/console.log, JSON.stringify,
 * String(), TextDecoder.decode, structuredClone, Map/Set identity, and
 * ArrayBufferView. Rows run under Node and on both WasmGC lanes; the S035 row pins
 * this tier's no-pool answer. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";
import { runWasm } from "./wasm-host.js";

const scratch = scratchDir("arraybuffer");

const ROWS: Row[] = [
  {
    id: "AB1-01 new ArrayBuffer(n): ToIndex lengths and the RangeError",
    nodeTypes: false,
    files: {
      "main.ts": `const ab = new ArrayBuffer(8);
console.log(ab.byteLength, new ArrayBuffer(1.9).byteLength, new ArrayBuffer(NaN).byteLength, new ArrayBuffer().byteLength);
for (const n of [-1, -0.5, 2 ** 53, -Infinity]) {
  try {
    console.log(new ArrayBuffer(n).byteLength);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message, e instanceof RangeError);
  }
}`,
    },
  },
  {
    id: "AB1-02 a view's .buffer: the shared storage, identity across reads and subarrays, every element kind",
    nodeTypes: false,
    files: {
      "main.ts": `const u = new Uint8Array([1, 2, 3, 4]);
const b = u.buffer;
console.log(b === u.buffer, b.byteLength, u.subarray(1).buffer === b, b === new Uint8Array(4).buffer);
console.log(new Uint32Array(3).buffer.byteLength, new Int32Array(2).buffer.byteLength, new Float32Array(5).buffer.byteLength);
const keep: ArrayBuffer[] = [b];
console.log(keep[0] === u.buffer, keep.includes(b));
function len(x: ArrayBuffer): number {
  return x.byteLength;
}
console.log(len(b), len(new ArrayBuffer(3)));`,
    },
  },
  {
    id: "AB1-03 slice: a fresh copy over relative and clamped indices",
    nodeTypes: false,
    files: {
      "main.ts": `const b = new Uint8Array([10, 20, 30, 40, 50]).buffer;
const s = b.slice(1, -1);
console.log(s.byteLength, s === b, b.slice(-2).byteLength, b.slice(3, 1).byteLength, b.slice().byteLength, b.slice(2).byteLength);
console.log(b.slice(-100, 100).byteLength, b.slice(NaN).byteLength, b.slice(undefined, 2).byteLength);
// cosmokit's fromSource: a view's exact bytes out of its buffer.
const v = new Uint8Array([1, 2, 3, 4, 5, 6]).subarray(2, 5);
const exact = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
console.log(exact.byteLength, exact === v.buffer);`,
    },
  },
  {
    id: "AB2-01 typed-array views over an ArrayBuffer share its storage",
    nodeTypes: false,
    files: {
      "main.ts": `const ab = new ArrayBuffer(8);
const u8 = new Uint8Array(ab);
const u32 = new Uint32Array(ab, 4, 1);
const mid = new Uint8Array(ab, 2, 4);
u8[4] = 1;
u8[5] = 2;
console.log(u32[0], mid.byteOffset, mid.length, mid[2], mid[3], u32.byteOffset, u32.length);
u32[0] = 0xffffffff;
console.log(u8.join(","), mid.buffer === ab, u32.buffer === ab, u8.buffer === ab);
const f = new Float32Array(ab);
f[0] = 1.5;
console.log(new Int32Array(ab)[0], new Uint8Array(ab, 1.9, 2.5).byteOffset, new Uint8Array(ab, undefined, 3).length, new Uint8Array(ab, NaN).length);
// a view of a view's buffer is a view of the whole buffer
const sub = u8.subarray(3);
console.log(new Uint8Array(sub.buffer).length, new Uint8Array(sub.buffer, sub.byteOffset, sub.length)[1]);`,
    },
  },
  {
    id: "AB2-02 typed-array views over an ArrayBuffer: V8's RangeErrors, in order; optional (number | undefined) indices",
    nodeTypes: false,
    files: {
      "main.ts": `const ab = new ArrayBuffer(10);
function attempt(make: () => number[]): void {
  try {
    console.log("ok", make().join(" "));
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
const u8 = (off?: number, len?: number): number[] => {
  const v = new Uint8Array(ab, off, len);
  return [v.byteOffset, v.length];
};
const u32 = (off: number, len?: number): number[] => {
  const v = new Uint32Array(ab, off, len);
  return [v.byteOffset, v.length];
};
attempt(() => u8(11));
attempt(() => u8(10));
attempt(() => u8(3, 8));
attempt(() => u8(-1.5));
attempt(() => u8(0, -1.5));
attempt(() => u8(Infinity));
attempt(() => u8(0, Infinity));
attempt(() => u8(2 ** 53));
attempt(() => u8(undefined, 4));
attempt(() => u32(0));
attempt(() => u32(2));
attempt(() => u32(4, 1));
attempt(() => u32(4, 2));
attempt(() => u32(-4));
attempt(() => u32(12, 0));
attempt(() => {
  const v = new Float32Array(new ArrayBuffer(8), 0);
  return [v.byteOffset, v.length];
});
attempt(() => {
  const v = new Int32Array(ab, 4, 1.5);
  return [v.byteOffset, v.length];
});`,
    },
  },
  {
    id: "AB2-03 Buffer.from(ab, byteOffset?, length?): Node's fromArrayBuffer",
    files: {
      "main.ts": `const ab = new Uint8Array([104, 101, 108, 108, 111, 33, 33, 33, 33, 33]).buffer;
const b = Buffer.from(ab, 1, 4);
console.log(b.toString(), b.byteOffset, b.length, Buffer.from(ab).length, Buffer.from(ab, 3).toString());
b[0] = 69;
console.log(Buffer.from(ab).toString(), b.buffer === ab);
const tries: Array<() => Buffer> = [
  () => Buffer.from(ab, 11),
  () => Buffer.from(ab, 3, 8),
  () => Buffer.from(ab, -1.5),
  () => Buffer.from(ab, 0, -3),
  () => Buffer.from(ab, 0, Infinity),
  () => Buffer.from(ab, Infinity),
  () => Buffer.from(ab, 10.5),
  () => Buffer.from(ab, 0, 2.5),
  () => Buffer.from(ab, undefined, 4),
  () => Buffer.from(ab, 2, NaN),
  () => Buffer.from(ab, -20),
];
for (const t of tries) {
  try {
    const v = t();
    console.log("ok", v.byteOffset, v.length);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(err.name, err.code, err.message);
  }
}`,
    },
  },
  {
    id: "AB2-04 DataView over an ArrayBuffer value",
    nodeTypes: false,
    files: {
      "main.ts": `const ab = new ArrayBuffer(8);
const dv = new DataView(ab, 2);
dv.setUint16(0, 0x1234);
console.log(new Uint8Array(ab).join(","), dv.byteOffset, dv.byteLength, dv.buffer === ab);
const n = 4 + ab.byteLength;
const dv2 = new DataView(new ArrayBuffer(n));
dv2.setFloat64(0, Math.PI);
console.log(dv2.byteLength, dv2.getFloat64(0));
try {
  new DataView(ab, 9);
} catch (e) {
  console.log((e as Error).message);
}`,
    },
  },
  {
    id: "AB2-05 ArrayBuffer.isView, instanceof, and ArrayBuffer | view unions",
    nodeTypes: false,
    files: {
      "main.ts": `type Source = ArrayBuffer | Uint8Array;
function bytes(x: Source): Uint8Array {
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return x;
}
function isV(x: Source): boolean {
  return ArrayBuffer.isView(x);
}
const ab = new ArrayBuffer(4);
const u = new Uint8Array([1, 2]);
console.log(bytes(ab).length, bytes(u).length, isV(ab), isV(u), ArrayBuffer.isView(u), ArrayBuffer.isView(ab));
const xs: Source[] = [ab, u];
console.log(xs.map((x) => (x instanceof Uint8Array ? "view" : "buffer")).join(","));`,
    },
  },
  {
    id: "AB2-06 cosmokit's Source helpers: isView/instanceof narrowing, a union's byteLength, ArrayBuffer Map keys",
    files: {
      "main.ts": `function toUint8(source: ArrayBuffer | Uint8Array): Uint8Array {
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return new Uint8Array(source);
}
function fromSource(source: ArrayBuffer | Uint8Array): ArrayBufferLike {
  if (source instanceof ArrayBuffer) return source;
  return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
}
const ab = new Uint8Array([1, 2, 3, 4, 5]).buffer;
const view = new Uint8Array(ab, 1, 3);
console.log(toUint8(ab).join(), toUint8(view).join(), fromSource(view).byteLength, fromSource(ab) === ab);
const buf = Buffer.from("hey");
console.log(buf instanceof Uint8Array, ArrayBuffer.isView(buf), buf.buffer instanceof ArrayBuffer, view instanceof Uint32Array);
const mixed: Array<ArrayBuffer | Uint32Array | Uint8Array> = [ab, new Uint32Array(2), view];
for (const m of mixed) {
  console.log(m instanceof ArrayBuffer, m instanceof Uint8Array, m instanceof Uint32Array, ArrayBuffer.isView(m), m.byteLength);
}
const views = new Map<ArrayBuffer, number>();
views.set(ab, 1);
console.log(views.get(view.buffer), views.has(new ArrayBuffer(5)));`,
    },
  },
  {
    id: "AB3-01 printing, JSON, String(), TextDecoder, structuredClone, and Set identity",
    nodeTypes: false,
    files: {
      "main.ts": `const ab = new Uint8Array([104, 105, 0, 255]).buffer;
console.log(ab);
console.log(new ArrayBuffer(0), new ArrayBuffer(3));
console.log([ab], { ab });
console.log(JSON.stringify(ab), JSON.stringify(ab, null, 2));
console.log(new TextDecoder().decode(new Uint8Array([104, 105]).buffer));
const c = structuredClone(ab);
console.log(c === ab, c.byteLength, new Uint8Array(c)[0]);
const set = new Set<ArrayBuffer>([ab, ab, new ArrayBuffer(4)]);
console.log(set.size, set.has(ab));
console.log(String(ab), \`\${ab}\`);`,
    },
  },
  {
    id: "AB3-02 inspect layout: the single-line budget, the 100-byte cap, nesting and depth",
    files: {
      "main.ts": `import { inspect } from "node:util";
for (const n of [6, 7, 8, 20, 99, 100, 101, 102, 150]) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 37) % 256;
  console.log(u.buffer);
}
const small = new Uint8Array([1, 2]).buffer;
console.log({ a: { b: { c: small } } }, [[small, small]]);
console.log({ a: { b: { c: { d: small } } } });
console.log(inspect(small), inspect({ x: small }, { depth: 0 }));
const many: ArrayBuffer[] = [new ArrayBuffer(3), new ArrayBuffer(4), new ArrayBuffer(5)];
console.log(many);`,
    },
  },
  {
    id: "AB3-04 a runtime-undefined slice index or DataView length is an omitted one",
    nodeTypes: false,
    files: {
      "main.ts": `const ab = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
function f(s?: number, e?: number): number[] {
  return [...new Uint8Array(ab.slice(s, e))];
}
console.log(f(2), f(undefined, 3), f(), f(-2, undefined), f(1, 4));
function g(off: number, len?: number): number {
  return new DataView(ab, off, len).byteLength;
}
console.log(g(2), g(2, 3), g(0));
function h(off?: number, len?: number): number {
  return new DataView(new Uint8Array(8).buffer, off, len).byteLength;
}
console.log(h(), h(3), h(undefined, 2), h(1, undefined));
const u = new Uint8Array(10);
function k(len?: number): number {
  return new DataView(u.buffer, 1, len).byteLength;
}
console.log(k(), k(4));
try {
  g(2, 9);
} catch (e) {
  console.log((e as Error).message);
}`,
    },
  },
  {
    id: "AB3-05 ArrayBufferView: cosmokit's ArrayBuffer | ArrayBufferView Source, and the view members",
    files: {
      "main.ts": `type Source = ArrayBuffer | ArrayBufferView;
function toBytes(source: Source): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}
function bufferOf(source: Source): ArrayBufferLike {
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  return source;
}
const base = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
const views: Source[] = [base.buffer, base.subarray(2, 5), new Uint32Array(base.buffer, 4, 1), new DataView(base.buffer, 1, 2), Buffer.from("hi")];
for (const v of views) {
  console.log(toBytes(v).join(","), bufferOf(v).byteLength, ArrayBuffer.isView(v), v instanceof ArrayBuffer, v.byteLength);
}
function viewLen(v: ArrayBufferView): number {
  return v.byteLength + v.byteOffset;
}
console.log(viewLen(base), viewLen(new Float32Array(3)), viewLen(new DataView(base.buffer, 3)));`,
    },
  },
  {
    id: "AB3-07 instanceof over generic and aliased receivers whose types exclude DataView answers statically",
    files: {
      "main.ts": `function isU8<T extends Uint8Array | Uint32Array>(x: T): boolean {
  return x instanceof Uint8Array;
}
function isAb<T extends ArrayBuffer | ArrayBufferView>(x: T): boolean {
  return x instanceof ArrayBuffer;
}
type Typed = Uint8Array | Float32Array;
function isU8b(x: Typed | undefined): boolean {
  return x instanceof Uint8Array;
}
console.log(isU8(new Uint8Array(2)), isU8(new Uint32Array(2)), isAb(new ArrayBuffer(1)), isAb(new DataView(new ArrayBuffer(1))), isU8b(new Float32Array(1)), isU8b(undefined), isU8b(Buffer.from("a")));`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`ArrayBuffer (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}

/* SEMANTICS.md S035 (amendment): no pool — a pooled Buffer's .buffer is
 * its own storage here (Node's is the 65536-byte pool slab). OUR answer,
 * not Node's. */
test("AB1-S035 a pooled Buffer.from's .buffer is its own storage (no pool)", async () => {
  const file = join(scratch, "ab1-s035.ts");
  writeFileSync(file, 'const b = Buffer.from("hi");\nconsole.log(b.buffer.byteLength, b.byteOffset, Buffer.from("x".repeat(40000)).buffer.byteLength);\n');
  const res = await compile(file, { outPath: join(scratch, "ab1-s035.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | "));
  const run = await runWasm(res.binaryPath);
  expect(String(run.stdout)).toBe("2 0 40000\n");
}, 600_000);

/* structuredClone with options may transfer (detach) the buffer, and
 * detached buffers are not modelled: it refuses by name. */
test("AB3-03 structuredClone of an ArrayBuffer with options refuses", async () => {
  await checkRefuses(scratch, {
    id: "AB3-03",
    nodeTypes: false,
    files: { "main.ts": "const ab = new ArrayBuffer(4);\nconst c = structuredClone(ab, { transfer: [ab] });\nconsole.log(c.byteLength, ab.byteLength);" },
  }, "structuredClone of an ArrayBuffer with options");
}, 600_000);

/* A DataView rides the Uint8Array representation, so `instanceof
 * Uint8Array` over a type that admits one has no static answer. */
test("AB3-06 instanceof Uint8Array on an ArrayBufferView refuses", async () => {
  await checkRefuses(scratch, {
    id: "AB3-06",
    nodeTypes: false,
    files: { "main.ts": "function isU8(v: ArrayBufferView): boolean {\n  return v instanceof Uint8Array;\n}\nconsole.log(isU8(new DataView(new ArrayBuffer(2))));" },
  }, "'instanceof Uint8Array' on a 'ArrayBufferView");
}, 600_000);

/* Generic receivers: the static answer needs every part known not to be a
 * DataView, a type parameter by its constraint; anything that may hold one
 * refuses by name (a DataView instantiates on the Uint8Array
 * representation). */
describe("AB3-08 instanceof Uint8Array on generic receivers that may hold a DataView refuses", () => {
  const U8 = "'instanceof Uint8Array' on a 'T' value";
  test.for([
    ["T extends ArrayBufferView", "function k<T extends ArrayBufferView>(x: T): boolean {\n  return x instanceof Uint8Array;\n}\nconsole.log(k(new DataView(new ArrayBuffer(2))));"],
    ["T extends Uint8Array | DataView", "function k<T extends Uint8Array | DataView>(x: T): boolean {\n  return x instanceof Uint8Array;\n}\nconsole.log(k(new DataView(new ArrayBuffer(2))));"],
    ["T extends ArrayBuffer | ArrayBufferView", "function k<T extends ArrayBuffer | ArrayBufferView>(x: T): boolean {\n  return x instanceof Uint8Array;\n}\nconsole.log(k(new DataView(new ArrayBuffer(2))));"],
    ["an unconstrained T given an ArrayBufferView", "function k<T>(x: T): boolean {\n  return x instanceof Uint8Array;\n}\nconst v: ArrayBufferView = new DataView(new ArrayBuffer(2));\nconsole.log(k(v));"],
  ] as const)("%s", async ([id, src]) => {
    await checkRefuses(scratch, { id, nodeTypes: false, files: { "main.ts": src } }, U8);
  }, 600_000);
});
