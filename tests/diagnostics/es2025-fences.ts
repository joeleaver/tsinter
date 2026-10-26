// The es2025-lib surface WITHOUT a lowering fences by name: resizable
// ArrayBuffers and transfer, SharedArrayBuffer.grow, Atomics.waitAsync,
// Float16Array and its Math/DataView companions, first-class iterator
// objects, and the unlowered forms of the implemented statics
// (Promise.try's ...args, groupBy's literal-union keys, a set-like
// non-Set argument).

// Resizable ArrayBuffer + transfer (ES2024).
const ab = new ArrayBuffer(8, { maxByteLength: 16 });
ab.resize(16);
const moved = ab.transfer();

// The resizable form fences by name even in an erasure position (the
// fixed-length new Uint8Array(new ArrayBuffer(8)) lowers).
const rz = new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 }));

// SharedArrayBuffer growth.
const sab = new SharedArrayBuffer(8, { maxByteLength: 16 });
sab.grow(16);

// Atomics.waitAsync.
const ia = new Int32Array(4);
const waited = Atomics.waitAsync(ia, 0, 0, 1);

// Float16 (ES2025): the typed array and the DataView accessors (Math.f16round
// compiles statically on every lane — SEMANTICS.md S100).
const f16 = new Float16Array(4);
const dv = new DataView(new Uint8Array(8).buffer);
dv.setFloat16(0, 1.5);

// First-class iterator objects.
const it = Iterator.from([1, 2, 3].values());

// Promise.try's ...args form (close over the values instead).
const tried = Promise.try((a: number, b: number) => a + b, 1, 2);

// Object.groupBy at a literal-union key type (a fixed-field record).
const grouped = Object.groupBy([1, 2, 3], (n) => (n % 2 === 0 ? "even" : "odd"));

// A set-like argument that isn't a Set.
const s = new Set([1, 2]);
const m = new Map<number, string>([[1, "x"]]);
const u = s.union(m);
