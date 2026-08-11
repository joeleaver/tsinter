// Uint8Array/Buffer values crossing into `unknown`: the checked-dynamic tree's bytes kind —
// construction ALIASES the source's storage on the way in and a checked-
// cast extraction on the way out hands back that SAME reference (S014's
// bytes amendment, increment 18 stage C — every OTHER composite kind
// still copies both ways), Node-exact String() (elements joined) and
// JSON.stringify (the index-keyed object form). The stdin
// toBytes(chunk: unknown) pattern.

function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  return new TextEncoder().encode(String(chunk));
}

const src = new Uint8Array([104, 105, 33]);
const u: unknown = src;
const back = u as Uint8Array;
console.log(back.length, back[0], back[1], back[2]);
console.log(String(u));
console.log(toBytes("hey").length, toBytes(u).length, toBytes(7).length);

// typeof over the bytes kind: every scalar kind test misses.
console.log(typeof u === "string", typeof u === "number", typeof u === "undefined");
console.log(u === null, u !== undefined);

// Under an unknown-valued index signature, and through unknown params.
const scratch: Record<string, unknown> = {};
scratch.buf = new Uint8Array([1, 2, 3]);
console.log(String(scratch.buf), (scratch.buf as Uint8Array).length);
console.log(JSON.stringify(scratch));

// Extraction hands back the SAME `$bytes` reference each time (S014's
// bytes amendment: both directions of the boundary alias, never copy —
// pinned by identity, not just value, in the wasm emitter unit test).
// Nothing mutates `scratch.buf` between the two reads below, so the
// printed sum is the same whether this tier aliases or copies; the
// aliasing itself is what the unit test asserts, not this program.
const again = scratch.buf as Uint8Array;
console.log(again[0] + again[1] + again[2]);

// Buffer is bytes<u8> too. (String() of an unknown holding a BUFFER joins
// the elements like a Uint8Array — Node decodes UTF-8 there; the checked-dynamic tree
// cannot tell the two apart, on any lane, at this generic crossing site.
// SEMANTICS.md S037 documents it; not asserted here where Node is the
// oracle.)
const buf = Buffer.from("hi");
const ub: unknown = buf;
console.log((ub as Uint8Array).length, (ub as Uint8Array)[0]);

// Empty payloads.
const empty: unknown = new Uint8Array(0);
console.log(String(empty) === "", (empty as Uint8Array).length);
