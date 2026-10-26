// @dynamic
// The rest of Node 24's Math object, in a --dynamic build (it compiles
// statically there too, SEMANTICS.md S100): the six other constants, the
// integer and rounding members, the hyperbolics, log1p/expm1, and hypot at
// every arity. Everything prints RAW: every lane computes V8's own code.
console.log(Math.LN10, Math.LN2, Math.LOG10E, Math.LOG2E, Math.SQRT1_2, Math.SQRT2);
console.log(Math.clz32(1), Math.clz32(0), Math.clz32(-1), Math.clz32(0.5), Math.clz32(2 ** 32 + 8));
console.log(Math.imul(3, 4), Math.imul(0xffffffff, 5), Math.imul(2 ** 31, 2), Math.imul(-7.9, 3.2));
console.log(Math.fround(5.5), Math.fround(5.05), Math.fround(2 ** 128), 1 / Math.fround(-0));
console.log(Math.f16round(5.0005), Math.f16round(65504), Math.f16round(65519.99), Math.f16round(65520));
console.log(Math.f16round(2.0009765625), Math.f16round(2.0029296875), Math.f16round(5.960464477539063e-8), 1 / Math.f16round(-1e-8));
console.log(Math.sign(-0.5), Math.sign(7), 1 / Math.sign(-0), Math.sign(NaN));
console.log(Math.hypot(), Math.hypot(-3), Math.hypot(3, 4), Math.hypot(2, 3, 6), Math.hypot(1, 2, 2, 4));
console.log(Math.hypot(NaN, Infinity), Math.hypot(NaN, 1), Math.hypot(1, 2, 3, 4, NaN, -Infinity), Math.hypot(0, -0, 0));
console.log(Math.sinh(1), Math.cosh(1), Math.tanh(0.5));
console.log(Math.asinh(1), Math.acosh(2), Math.atanh(0.5));
console.log(Math.log1p(1), Math.expm1(1), Math.expm1(1e-10) * 1e10);
console.log(Math.tanh(Infinity), Math.atanh(1), Math.acosh(0.5), 1 / Math.sinh(-0), Math.log1p(-1), Math.expm1(-Infinity), Math.cosh(0));
// A dynamic value converts with ToNumber, as Node's Math does.
const s: any = JSON.parse('"16"');
console.log(Math.sqrt(s), Math.clz32(s), Math.hypot(s, 12), Math.cbrt(s), Math.imul(s, s), Math.fround(s));
// Results chain into static arithmetic like any number.
const r = Math.hypot(5, 12) + Math.clz32(256) * Math.SQRT2;
console.log(r.toFixed(6), Math.round(Math.log1p(Math.E - 1) * 100));
