// Per-field width lifts beyond copy/wrap/narrow: 'unknown' destination
// fields (the static->dyn deep copy), derived->base class fields (the
// prefix-layout upcast), and function fields whose signatures differ
// only by clean mechanical conversions. Reads happen after the narrow,
// where the copy is observationally identical to Node's aliasing.

// 'unknown' destination field: the source's typed field converts.
type Env = { v: number; n: number };
const env: Env = { v: 5, n: 1 };
const holder: { v: unknown } = env;
console.log(typeof holder.v, (holder.v as number) + 1);

// Nested: an array of records reshaping where the element's field is
// 'unknown' (the dynIn lift riding the per-element copy).
type Item = { v: number; w: number };
const items: Item[] = [
  { v: 1, w: 10 },
  { v: 2, w: 20 },
];
const loose: { v: unknown }[] = items;
console.log(loose.length, (loose[0]!.v as number) + (loose[1]!.v as number));

// Derived -> base field: the upcast keeps dynamic dispatch.
class Base {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
  describe(): string {
    return `base:${this.x}`;
  }
}
class Derived extends Base {
  describe(): string {
    return `derived:${this.x}`;
  }
}
type HasDerived = { p: Derived; tag: string };
const hd: HasDerived = { p: new Derived(4), tag: "t" };
const hb: { p: Base } = hd;
console.log(hb.p.describe(), hb.p.x);

// Function field with FEWER parameters than the slot (JS drops extras).
type Handlers = { f: () => number; name: string };
const hs: Handlers = { f: () => 7, name: "seven" };
const slot: { f: (x: number) => number } = hs;
console.log(slot.f(3));

// Function field whose RESULT widens into the slot's union arm.
type Producer = { get: () => number };
const prod: Producer = { get: () => 42 };
const optional: { get: () => number | undefined } = prod;
const got = optional.get();
console.log(got === undefined ? "none" : got + 1);

// The lifts compose through nesting: an inner record with an unknown
// field and a func field, reshaped as part of an outer width copy.
type Inner = { calc: () => number; note: string };
type Outer = { inner: Inner; count: number };
const outer: Outer = { inner: { calc: () => 6, note: "n" }, count: 2 };
const narrowed: { inner: { calc: (x: number) => number } } = outer;
console.log(narrowed.inner.calc(99));
