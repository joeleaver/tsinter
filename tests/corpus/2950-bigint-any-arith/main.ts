// GH #187: arithmetic over `any` in a program that holds a bigint. The
// checker types `-x`, `x % y` and an untyped function's `a - b` as number;
// Node answers a bigint for bigint operands (and a number for numbers).
import { sub, neg, rem, square, less, pow, gap } from "./arith.js";

const raw: any = JSON.parse("[10, 3]");
const big: any = raw[0] === 10 ? 10n : 0;
const small: any = raw[1];

// Un-annotated bindings of any arithmetic.
const r = -big;
console.log(r, typeof r);
const n = -small;
console.log(n, typeof n);
const m = (big % 3n).toString();
console.log(m, (small % 2).toString());
let w = big - 1n;
console.log(w, typeof w);
w = w * 2n;
console.log(w);
const chained = r * r;
console.log(chained, typeof chained);

// Un-annotated functions returning any arithmetic.
function halve(x: any) { return x / 2n; }
const twice = (x: any) => x * 2;
console.log(halve(big), typeof halve(big));
console.log(twice(small), twice(7));

// The untyped JavaScript module.
console.log(sub(10n, 3n), sub(10, 3), typeof sub(10n, 3n));
console.log(neg(5n), neg(5));
console.log(rem(10n, 4n), rem(10, 4));
console.log(square(12n), square(12));
console.log(less(1n, 2n), less(3n, 2n), less(1, 2));
console.log(pow(2n, 70n), pow(2, 10));
console.log(gap(5, 2), gap(5n, 2n));
const d = sub(big, 4n);
console.log(String(d), d === (6n as any));

// Mixing a bigint with a number throws Node's TypeError.
try {
  console.log(sub(1n, 2));
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
try {
  console.log(-big + small);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}

// The globals' own coercions over an any holding a bigint.
try {
  console.log(isNaN(big));
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
console.log(isNaN(small), isNaN("x" as any), parseInt(big), parseInt(big, 16), parseInt(small));
