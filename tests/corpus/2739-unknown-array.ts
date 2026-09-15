// `unknown[]` is a first-class type now: a dyn ELEMENT makes the whole
// array the checked-dynamic value (the checked-dynamic tree has real arrays; a dyn-element
// static array has no backend slot), so annotations, literals, length,
// index reads AND writes, and the dispatched array methods all ride the
// keyed-dyn paths — TypeScript sources exactly like the JS residue that
// always lowered this way.

// Literal construction into the annotated slot (the dyn array literal).
const u: unknown[] = [1, "two", { three: 3 }, [4], null, undefined, true];
console.log(u.length);
console.log(typeof u[0], typeof u[1], typeof u[2], typeof u[6]);
console.log(u[4] === null, u[5] === undefined, u[7] === undefined);

// Element writes: sets, and extension with undefined-hole padding —
// JS's length growth exactly.
u[0] = 99;
console.log(u[0], u.length);
u[8] = "grew";
console.log(u.length, u[7] === undefined, u[8]);

// The dispatched methods on the dyn array.
u.push("pushed");
console.log(u.length, u[9]);
console.log(u.indexOf("two"), u.includes(99), u.includes("missing"));

// Params and returns keep the type first-class.
function head(xs: unknown[]): unknown {
  return xs[0];
}
console.log(head(u), head(["a", "b"]));

// JSON.parse results validated into the slot are the same value world.
const parsed = JSON.parse('[5, "six", {"seven": 7}]') as unknown[];
console.log(parsed.length, typeof parsed[0], typeof parsed[1], typeof parsed[2]);

// Records with unknown[] fields carry the dyn array in a dyn slot.
interface Bag {
  items: unknown[];
  label: string;
}
const bag: Bag = { items: [true, 2, "three"], label: "bag" };
console.log(bag.label, bag.items.length, typeof bag.items[2]);

// Narrowed element reads validate out (dynCheck, the checked-cast
// machinery) — a typeof guard proves the kind first.
const e0 = parsed[0];
if (typeof e0 === "number") console.log("e0+1:", e0 + 1);
