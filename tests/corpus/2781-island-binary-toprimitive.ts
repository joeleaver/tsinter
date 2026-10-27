// @dynamic
// Board #251: the binary operators on island ('any') values run
// ToPrimitive on each operand before they add, compare or do arithmetic —
// an object's own valueOf, then its own toString, is called (left operand
// first, both converted before the operator decides string vs number), a
// throw from either propagates catchably, and neither giving a primitive is
// a TypeError. Plain objects without the members keep "[object Object]".
const o: any = JSON.parse('{"a":1}');
o.valueOf = () => 42;
console.log(String(o + 1), String(1 + o), String("s" + o), String(o + "s"));
console.log(String(o - 1), String(o * 2), String(o / 2), String(o % 5), String(o ** 2));
console.log(String(o < 50), String(o > 50), String(o <= 42), String(o >= 43));
const n: number = 3;
console.log(String(n + o), String(n * o), String(n < o));

const both: any = { valueOf() { return 7; }, toString() { return "T"; } };
console.log(String(both + 1), String(both * 3), String(both + "x"));
const strOnly: any = { toString() { return "9"; } };
console.log(String(strOnly - 1), String(strOnly + 1), String(strOnly < 10));
const plain: any = JSON.parse('{"x":1}');
console.log(String(plain + 1), String(plain * 2), String(plain < 1));

const log: string[] = [];
const a: any = { valueOf() { log.push("a"); return 2; } };
const b: any = { valueOf() { log.push("b"); return 3; } };
console.log(String(a + b), String(a > b), String(a - b), String(a ** b), String(b >= a));
console.log(log.join(","));

const bad: any = { valueOf() { throw new Error("boom"); } };
try {
  const r: any = bad + b;
  console.log("no throw", String(r));
} catch (e) {
  console.log("caught", (e as Error).message);
}
try {
  const r: any = a < bad;
  console.log("no throw", String(r));
} catch (e) {
  console.log("caught", (e as Error).message);
}
console.log(log.join(","));
// The engine's own message for this one differs on the native lanes
// (SEMANTICS.md S104 (d)), so only the error's name prints.
const noprim: any = { valueOf() { return {}; }, toString() { return {}; } };
try {
  const r: any = noprim * 2;
  console.log("no throw", String(r));
} catch (e) {
  console.log("caught", (e as Error).name);
}
