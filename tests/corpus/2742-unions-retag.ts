// Union→union widening re-tags at runtime: a value of union A flowing into
// a slot of union B (B's arms a superset of A's, canonically) switches on
// the source tag and re-wraps the payload under its tag in B. The payload
// POINTER moves — ref-arm identity and aliasing stay JS-exact.

// Scalar arms, tags shift: string|undefined is [string, undefined] but
// number|string|undefined is [number, string, undefined].
function widen(x: string | undefined): number | string | undefined {
  return x;
}
function show(v: number | string | undefined): string {
  if (v === undefined) return "undef";
  return `${v}`;
}
console.log(show(widen("hi")), show(widen(undefined)), show(widen("")));

// null sorts BETWEEN f64 and string keys: string|null is [null, string],
// number|string|null is [number, null, string] — every tag moves.
function widenNull(x: string | null): number | string | null {
  return x;
}
function showN(v: number | string | null): string {
  if (v === null) return "nil";
  return `${v}`;
}
console.log(showN(widenNull("s")), showN(widenNull(null)));

// Prefix-stable pair too (number|string into number|string|undefined).
function widenNum(x: number | string): number | string | undefined {
  return x;
}
console.log(show(widenNum(42)), show(widenNum("x")), show(widenNum(0 / 0)), show(widenNum(-0)));

// Payload equality survives the re-tag: union-vs-literal comparison reads
// the arm value, not the box.
const round = widen("text");
console.log(round === "text", round === "other", round === undefined);

// Ref arms: the record payload keeps its IDENTITY — mutations through the
// re-tagged value are visible through the original binding, exactly JS.
type Rec = { n: number };
function widenRec(x: Rec | undefined): Rec | null | undefined {
  return x;
}
const rec: Rec = { n: 1 };
const wide = widenRec(rec);
if (wide !== undefined && wide !== null) {
  // tsc narrowed to Rec; the payload is the SAME record.
  console.log(wide === rec, wide.n);
  wide.n = 5;
}
console.log(rec.n);

// Array arms ride the same pointer move.
function widenArr(a: number[] | undefined): number[] | null | undefined {
  return a;
}
const nums = [1, 2];
const wa = widenArr(nums);
if (wa !== undefined && wa !== null) {
  wa.push(3);
}
console.log(nums.length, nums[2]);

// Discriminated-union subset into the full union; narrowing after the
// re-tag dispatches on the DESTINATION tags.
type Ok = { kind: "ok"; value: number };
type Err = { kind: "err"; message: string };
type Full = Ok | Err | undefined;
function intoFull(r: Ok | Err): Full {
  return r;
}
function describeArm(r: Ok | Err): string {
  if (r.kind === "ok") return `ok:${r.value}`;
  return `err:${r.message}`;
}
function describe(f: Full): string {
  if (f === undefined) return "none";
  // tsc narrowed f to the SUB-union Ok | Err; passing it re-tags DOWN
  // (the stranded undefined arm is a trap case sound narrowing never hits).
  return describeArm(f);
}
console.log(describe(intoFull({ kind: "ok", value: 7 })));
console.log(describe(intoFull({ kind: "err", message: "boom" })));
console.log(describe(undefined));

// A union-element ARRAY as an arm: arms map by canonical element type.
function widenArrArm(x: (number | string)[] | undefined): (number | string)[] | boolean | undefined {
  return x;
}
const mixed: (number | string)[] = [1, "two"];
const waa = widenArrArm(mixed);
if (waa !== undefined && waa !== true && waa !== false) {
  console.log(waa.length);
}

// Control-flow narrowing to a SUB-union re-tags on the way back out: tsc
// proves x isn't undefined here, the value still carries the wide type.
function dropUnit(x: number | string | undefined): number | string {
  if (x !== undefined) {
    return x;
  }
  return 0;
}
console.log(`${dropUnit("s")}`, `${dropUnit(3)}`, `${dropUnit(undefined)}`);

// Non-null assertions erase to the same re-tag; sound ones never trap.
function assertPast(x: string | undefined): number | string {
  return x!;
}
console.log(`${assertPast("sure")}`);

// Value-position logical over a union: the falsy side keeps u's own
// number|string type, so the boolean|number|string result re-tags it.
function mkNS(n: number | string): number | string {
  return n;
}
const andTrue = mkNS(1) && true;
const andFalsy = mkNS("") && true;
console.log(andTrue === true, andFalsy === "", `${andTrue}`, `${andFalsy}`);

// Chained widening: A -> B -> C re-tags twice; the payload never copies.
function chain(x: string | undefined): boolean | number | string | undefined {
  const mid: number | string | undefined = widen(x);
  return mid;
}
const c = chain("deep");
console.log(c === "deep", c === undefined);
