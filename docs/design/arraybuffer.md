# ArrayBuffer as a first-class value (WasmGC lanes)

Status: approved by Joe (2026-11-12): no Buffer pool; the `.buffer`
consequences are registered as an amendment to SEMANTICS.md S035.

## Why

deepseek's vendored utility package (cosmokit) types binary data as
`Source<ArrayBufferLike> = ArrayBuffer | ArrayBufferView`. It returns
ArrayBuffers from its base64 and hex decoders (`Uint8Array.from(buf).buffer`,
`source.buffer.slice(byteOffset, byteOffset + byteLength)`), tests
`ArrayBuffer.isView(x)`, and builds views over a buffer with
`new Uint8Array(ab)` and `Buffer.from(ab)`. Those helpers are reached while
the package loads. Today none of it compiles: there is no ArrayBuffer value
(S035, and the surfaces.ts hints: "no free-standing ArrayBuffer value
exists"), and `.buffer` lowers only as the first argument of
`new DataView(x.buffer, ...)` and `Buffer.from(x.buffer, ...)`.

## What exists

Every typed array and Buffer is one WasmGC struct
`$bytes { storage: (ref (array (mut i8))), off: i32, len: i32 }`. The
storage is a shared byte array; `subarray` and DataView already alias it;
the element kind (u8/u32/i32/f32) is static and never stored
(backend/wasm/typedarrays.ts). The shared-storage machinery an ArrayBuffer
needs is already there; what is missing is a value that names a whole
storage.

## Design

1. **The value.** A new IR type `arraybuffer`, represented as the
   storage array itself, `(ref null (array (mut i8)))`, the array every
   view of it already points at. No new wasm type. (An earlier draft used
   a `$bytes` struct with `off = 0`; the bare array makes identity the
   array's for free, so two reads of one view's `.buffer` are `===`.)
   - `x.buffer` is `x.storage`.
   - `new ArrayBuffer(n)` allocates zeroed storage (Node's RangeError for
     an invalid length).
   - `ab.byteLength` reads `len`.
   - `ab.slice(a?, b?)` copies into fresh storage with Node's clamping
     (negative indices count from the end).
2. **Views share storage.** `new Uint8Array(ab, off?, len?)`, the other
   element kinds' constructors, `Buffer.from(ab, off?, len?)` and
   `new DataView(ab, off?, len?)` point into `ab.storage`, with Node's
   RangeErrors (alignment for multi-byte kinds, bounds). A write through
   any view is visible through every other view and through `ab`.
3. **Identity.** `a.buffer === b.buffer` is `ref.eq` on the storage
   arrays, so `x.buffer === x.buffer` and `x.subarray(1).buffer ===
   x.buffer` are true; Map keys and Set members of the type compare the
   same way.
4. **Unions and type tests.** `ArrayBuffer | Uint8Array` is two arms over
   the same wasm struct, so it takes the existing tagged-union boxing.
   `ArrayBuffer.isView(x)` and `x instanceof ArrayBuffer` answer from the
   static arm or the tag.
5. **Printing and serialization.** `util.inspect`/`console.log` print
   Node's `ArrayBuffer { [Uint8Contents]: <..>, byteLength: n }`;
   `JSON.stringify` gives `{}`; `structuredClone` copies;
   `TextDecoder.decode(ab)` reads it.
6. **Refused by name.** Resizable buffers (`maxByteLength`, `resize`),
   `transfer`/`transferToFixedLength`/`detached`, SharedArrayBuffer beyond
   S094's Atomics shape, and the C lanes (the WasmGC tier's keys, like the
   recent fs keys).

## S035 amendment (no pool)

Node carves small `Buffer.from(...)`/`Buffer.allocUnsafe(...)` buffers
(below 32768 bytes) out of a shared pool slab of `Buffer.poolSize` bytes
(65536 on Node 24.18), so `buf.buffer` is the whole slab (`byteLength`
65536, a non-zero `buf.byteOffset`, and two small Buffers can share one
`.buffer`). tsinter has no pool: S035 already registers
`byteOffset` as 0. With `.buffer` a value, the difference becomes
observable, and the amendment registers it: `buf.buffer.byteLength` is the
Buffer's own length, two small Buffers never share a `.buffer`, and
nothing outside the Buffer is reachable through it. The common idiom,
`buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)`,
answers Node's exact bytes either way.

## Cost

- No change to how typed arrays are represented, read or written.
- A new IR type and its type-mapper entry; the union, equality, Map-key
  and inspect hooks above.
- About ten new intrinsics (construction, byteLength, slice, the view
  constructors, isView), mostly thin over existing `$bytes` helpers
  (`dataViewNew`, `subarray`, copy).
- The DataView and `Buffer.from(x.buffer)` peels become ordinary value
  flow and keep working.
- Risk is concentrated in identity and union tagging; element access is
  untouched.

## Steps

1. The value: `new ArrayBuffer(n)`, `byteLength`, `slice`, `x.buffer`,
   identity; this document; the S035 amendment.
2. Views over an ArrayBuffer; `ArrayBuffer.isView` and `instanceof`;
   `ArrayBuffer | view` unions.
3. inspect, `structuredClone`, `TextDecoder`, Map/Set identity.
