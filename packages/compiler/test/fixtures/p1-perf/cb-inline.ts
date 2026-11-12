const xs = [5, 1, 4, 2, 3];
// index and array arguments
console.log(xs.map((x, i, a) => x * 10 + i + a.length));
console.log(xs.filter((x, i) => i % 2 === 0 && x > 1));
console.log(xs.every((x, i, a) => a[i] === x), xs.some((x, i) => i > 3 && x === 3));
console.log(xs.find((x, i) => i > 1 && x < 4), xs.findIndex((x, i) => x === i), xs.find((x) => x > 100), xs.findIndex((x) => x > 100));
console.log(xs.reduce((acc, x, i) => acc + x * i, 0), xs.reduce((acc, x) => acc * x), [7].reduce((a, x) => a + x), xs.reduce((a, x, i, arr) => a + arr.length - i, 100));
// mutation during iteration
const m1 = [1, 2, 3, 4, 5];
const seen1: number[] = [];
m1.forEach((x, i, a) => { seen1.push(x); if (i === 0) { a.push(99); a.pop(); a.pop(); } });
console.log(seen1, m1);
const m2 = [1, 2, 3];
console.log(m2.map((x, i, a) => { if (i === 0) a.push(4); return x + a.length; }), m2);
const m3 = [1, 2, 3, 4, 5, 6];
console.log(m3.filter((x, i, a) => { if (i === 1) a.splice(2, 2); return x % 2 === 0; }), m3);
const m4 = [3, 2, 1];
console.log(m4.every((x, i, a) => { a[i + 1] = 0; return x >= 0; }), m4);
const m5 = [10, 20, 30];
console.log(m5.some((x, i, a) => { a.shift(); return x === 30; }), m5);
const m6 = [1, 2, 3];
console.log(m6.reduce((acc, x, i, a) => { if (i === 0) a.pop(); return acc + x; }, 0), m6);
const m7 = [1, 2, 3];
console.log(m7.findIndex((x, i, a) => { a.push(3); return x === 3; }), m7);
const m8 = [4, 5, 6];
console.log(m8.find((x, i, a) => { if (i === 0) a[2] = 42; return x === 42; }));
// early exit
let calls = 0;
console.log([1, 2, 3, 4].some((x) => { calls++; return x === 2; }), calls);
calls = 0;
console.log([1, 2, 3, 4].every((x) => { calls++; return x < 2; }), calls);
calls = 0;
console.log([1, 2, 3, 4].find((x) => { calls++; return x === 3; }), calls);
// returns in nested control flow
console.log(xs.map((x) => { for (let k = 0; k < 10; k++) { if (k === x) return k * 2; } return -1; }));
console.log(xs.filter((x) => { switch (x) { case 1: return true; case 2: return false; default: if (x > 4) return true; } return false; }));
// captures: read and write outer bindings
let total = 0;
let mult = 3;
xs.forEach((x) => { total += x * mult; mult = 1; });
console.log(total, mult);
// nested callbacks
const grid = [[1, 2], [3, 4], [5]];
console.log(grid.map((row) => row.filter((v) => v % 2 === 1).map((v) => v * 10)), grid.every((row) => row.some((v) => v > 1)));
console.log(xs.filter((x) => xs.some((y) => y === x + 1)));
// closure inside the callback capturing its parameter
const fns: (() => number)[] = [];
xs.forEach((x, i) => { fns.push(() => x + i); });
console.log(fns.map((f) => f()));
// exceptions thrown from the callback
try {
  xs.forEach((x) => { if (x === 4) throw new Error("boom at " + x); });
} catch (e) {
  console.log("caught", (e as Error).message);
}
try {
  const none: number[] = [];
  console.log(none.reduce((a, x) => a + x));
} catch (e) {
  console.log("caught", (e as Error).name, (e as Error).message);
}
function inner(): number { return xs.map((x) => { if (x === 2) throw new RangeError("r" + x); return x; }).length; }
try { inner(); } catch (e) { console.log("caught", e instanceof RangeError, (e as Error).message); }
// strings, objects, unions
const words = ["pear", "fig", "apple", "kiwi"];
console.log(words.filter((w) => w.length > 3).map((w, i) => w.toUpperCase() + i), words.findIndex((w) => w === "apple"), words.find((w) => w.startsWith("k")));
interface P { name: string; age: number }
const ps: P[] = [{ name: "a", age: 3 }, { name: "b", age: 30 }];
console.log(ps.filter((p) => p.age > 10).map((p) => p.name), ps.reduce((s, p) => s + p.age, 0), ps.some((p) => p.name === "b"));
const us: (number | string)[] = [1, "two", 3];
console.log(us.map((u) => typeof u === "number" ? u * 2 : u.length), us.filter((u) => typeof u === "string"));
// class method using lexical this
class Box {
  base = 100;
  items = [1, 2, 3];
  sum(): number { return this.items.reduce((a, x) => a + x + this.base, 0); }
  big(): number[] { return this.items.filter((x) => x * this.base > 150); }
}
const b = new Box();
console.log(b.sum(), b.big());
// a callback with a default parameter and an unused parameter
console.log([1, 2, 3].map((x, _i) => x + 1));
// empty arrays
const empty: number[] = [];
console.log(empty.map((x) => x), empty.filter((x) => x > 0), empty.every((x) => x > 0), empty.some((x) => x > 0), empty.find((x) => x > 0), empty.findIndex((x) => x > 0), empty.reduce((a, x) => a + x, 7));
let fe = 0;
empty.forEach(() => { fe++; });
console.log(fe);
// a big loop (the hot path)
const big: number[] = [];
for (let i = 0; i < 10000; i++) big.push(i % 97);
let acc = 0;
for (let r = 0; r < 20; r++) acc += big.filter((x) => x > 50).length + big.map((x) => x * 2)[r] + big.reduce((a, x) => a + x, 0);
console.log(acc);
