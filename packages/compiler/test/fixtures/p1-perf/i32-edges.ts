const vals = [0, -0, 1, -1, 2.5, -2.5, 0.9999, NaN, Infinity, -Infinity, 2147483647, 2147483648, -2147483648, -2147483649, 4294967295, 4294967296, 4294967297, 1e10, -1e10, 9007199254740993, 1.8446744073709552e19, 9.3e18, -9.3e18, 1e300, 5e-324];
for (const v of vals) console.log(v, v | 0, v >>> 0, v >> 1, v << 3, ~v, v & 0xff, v ^ -1, (v >>> 0) | 0, Object.is(v | 0, -0), 1 / (v | 0));
let h = 0;
for (let i = 0; i < 1000; i++) h = (h * 31 + (i & 255)) | 0;
console.log(h);
let g = 7;
for (let i = 0; i < 100; i++) g = (g * 1103515245 + 12345) | 0;
console.log(g);
let m = 0;
for (let i = 0; i < 40; i++) m = (m << 1) ^ (i * 2654435761);
console.log(m, m >>> 0, m >>> 31, -1 >>> 0, (-1 >>> 0) + 1, (m >>> 0) * 2);
const a = [10, 20, 30, 40];
let s = 0;
for (let i = 0; i < a.length; i++) s += a[i] * i;
for (let j = a.length - 1; j >= 0; j--) s += a[j] ?? 0;
for (let k = 0; k <= 3; k += 2) s += a[k];
for (let k = 3; k > 0; k -= 1) s -= a[k];
console.log(s, a[1 + 1], a[(1 << 31) >>> 30], a[(7 & 5) - 2]);
let i2 = 0;
for (; i2 < 5; i2++) { if (i2 === 2) continue; if (i2 === 4) break; }
console.log(i2);
let bits = 0;
for (let b = 0; b < 32; b++) bits |= 1 << b;
console.log(bits, bits >>> 0, (bits & (1 << 31)) !== 0, (bits & 8) === 8);
const mask = 0b1011;
console.log((mask & 2) !== 0, (mask & 4) !== 0, (mask & 4) === 0, -(mask & 0), Object.is(-(mask & 0), -0), (mask % 4), -mask % 4, Object.is(-mask % 4, -0), (mask * 0), Object.is((mask & 4) * -1, -0));
let x = 5;
x = x * 3 + 1;
x = x - 20;
console.log(x, Object.is(x * 0, -0), x / 2);
let c = 2147483646;
c++;
console.log(c);
c++;
console.log(c, c | 0);
let n = 0;
const big = 3e9;
for (let i = 0; i < big; i += 1e9) n++;
console.log(n);
function f(lim: number): number { let t = 0; for (let i = 0; i < lim; i++) t += i; return t; }
console.log(f(10), f(2.5), f(-1), f(NaN));
let q = 0;
for (let i = 2147483640; i < 2147483647; i++) q++;
console.log(q);
let w = 0;
for (let i = 2147483640; i <= 2147483647; i++) { w++; if (w > 20) break; }
console.log(w);
let u = 0;
for (let i = -2147483640; i > -2147483648; i--) { u++; if (u > 20) break; }
console.log(u);
let z = 0;
for (let i = 0; i < 10; i++) { z = i % 3; }
console.log(z, -7 % 3, 7 % -3, Object.is(-6 % 3, -0));
let tern = 0;
for (let i = 0; i < 10; i++) tern = i > 5 ? i & 3 : tern | 16;
console.log(tern);
let ae = 0, ae2 = 0;
ae2 = (ae = 3 | 4) + 1;
console.log(ae, ae2);
let inc = 0;
const r1 = inc++, r2 = ++inc, r3 = inc--, r4 = --inc;
console.log(r1, r2, r3, r4, inc);
function lp(): number { let k = 0; let last = -1; for (let i = 0; i < 2147483647; i++) { last = i; if (i > 5) break; } for (k = 0; k < 3; k++) {} return last * 10 + k; }
console.log(lp());
const big2: number[] = [1, 2, 3];
let acc = 0;
for (let i = 0; i < big2.length; i++) { acc += big2[(i + 1) % 3]; acc += big2[i & 1]; acc += big2[i >> 1]; }
console.log(acc);
