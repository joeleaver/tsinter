// Math is static on every lane (SEMANTICS.md S100, S104): no --dynamic, and
// every lane computes V8's own code -- the transcendentals from the one
// vendored copy of V8's ieee754.cc -- so results print RAW, last bit and all.
// Several inputs here are ones on which a system libm (glibc) or the original
// fdlibm answers differently from Node.
const id = (v: number): number => v;
console.log(Math.log(id(3)), Math.cbrt(id(2)), Math.sin(id(-3.1902814782969835)), Math.exp(id(1)));
console.log(Math.cosh(id(1)), Math.tanh(id(1.0487516560492713e-13)), Math.cbrt(id(0.9991103149666114)));
console.log(Math.sin(id(1)), Math.cos(id(1)), Math.tan(id(1)), Math.asin(id(0.5)), Math.acos(id(0.5)), Math.atan(id(1)));
console.log(Math.atan2(id(1), 1), Math.atan2(id(-1), -1), Math.atan2(id(0), -0), Math.atan2(id(-0), -1));
console.log(Math.sinh(id(1)), Math.asinh(id(1)), Math.acosh(id(2)), Math.atanh(id(0.5)));
console.log(Math.log1p(id(1)), Math.expm1(id(1)), Math.expm1(id(1e-10)), Math.log2(id(10)), Math.log10(id(2)));
console.log(Math.sin(id(1e22)), Math.cos(id(1e300)), Math.tan(id(Math.PI / 2)), Math.exp(id(709.7)), Math.exp(id(-745.2)));
console.log(Math.hypot(id(1e300), 1e300), Math.hypot(id(3), 4, 12), Math.hypot(id(0.1), 0.2, 0.3, 0.4), Math.hypot(id(NaN), Infinity));
// pow and ** are V8's math::pow: ECMA-262's NaN for |x| = 1 with an infinite
// exponent (board #207), and its x*x / sqrt(x + 0) pre-cases.
console.log(Math.pow(id(1), Infinity), id(-1) ** -Infinity, 1 ** Infinity, Math.pow(id(-8), 1 / 3), id(1.1) ** 2, id(2) ** 0.5);
console.log(Math.pow(id(2.5), 7.3), id(0.75) ** -12.5, Math.pow(id(-Infinity), 0.5), id(-0) ** 0.5, 10 ** -5, 2 ** 53 + 1);
console.log(Math.sqrt(id(2)), Math.sign(id(-0)), Math.fround(id(5.05)), Math.f16round(id(5.0005)), Math.clz32(id(1000)), Math.imul(id(0xffffffff), 7));
console.log(Math.PI, Math.E, Math.LN2, Math.LN10, Math.LOG2E, Math.LOG10E, Math.SQRT2, Math.SQRT1_2);
console.log(Math.max(), Math.min(), Math.max(id(1), 3, 2), Math.min(id(-0), 0), Math.max(id(NaN)), Math.hypot());
// Outside the domains: NaN, whatever the payload, prints NaN.
console.log(Math.log(id(-1)), Math.acos(id(2)), Math.atanh(id(2)), Math.sqrt(id(-1)), Math.sin(id(Infinity)));
// `any` arguments convert with ToNumber, as Node's Math does (board #263).
const xs: any = JSON.parse('["-7.5", " 16 ", "", "abc", null, true, [], [9], [1, 2], {"a": 1}, "0x10", "1e400"]');
for (const x of xs) {
  console.log(Math.abs(x), Math.floor(x), Math.round(x), Math.max(x, 0), Math.min(x), Math.sqrt(x), Math.cbrt(x), Math.atan2(x, 1), Math.hypot(x, 2), Math.pow(x, 2), Math.clz32(x));
}
// Results chain into ordinary arithmetic.
let acc = 0;
for (let i = 1; i <= 50; i++) acc += Math.sin(i) * Math.exp(-i / 10) + Math.log1p(i) / Math.cosh(i / 25);
console.log(acc);
