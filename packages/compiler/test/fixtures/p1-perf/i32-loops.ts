// P1 item 2: integer lowering in functions — counters, masks, indices.
function sum(a: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]!; return s; }
function rsum(a: number[]): number { let s = 0; for (let i = a.length - 1; i >= 0; i--) s += a[i]! * i; return s; }
function popcount(x: number): number { let c = 0; for (let b = 0; b < 32; b++) if ((x & (1 << b)) !== 0) c++; return c; }
function fnv(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function djb(s: string): number { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; }
function stepBy(n: number, k: number): number { let c = 0; for (let i = 0; i < n; i += 3) c += i; return c + k; }
function counterAfter(): number[] { let i = 0; for (i = 0; i < 5; i++) {} let j = 10; for (; j > 0; j -= 4) {} return [i, j]; }
function shadow(): number { let t = 0; for (let i = 0; i < 3; i++) { for (let i = 10; i < 12; i++) t += i; t += i; } return t; }
function mixed(n: number): number { let k = 0; for (let i = 0; i < 4; i++) { k = i * n; } return k; }
function negZero(): boolean[] { let z = 0; for (let i = 0; i < 2; i++) z = i - i; return [Object.is(z, 0), Object.is(z * -1, -0), Object.is(-z, -0)]; }
function bound(xs: number[]): number[] { const out: number[] = []; for (let i = 0; i <= xs.length; i++) out.push(xs[i] ?? -1); return out; }
function signed(): number[] { const r: number[] = []; for (let i = -3; i < 3; i++) r.push(i >> 1, i >>> 30, i % 2, -i, i * i); return r; }
function nested(): number { let t = 0; for (let i = 0; i < 50; i++) for (let j = i; j < 50; j++) t = (t + i * j) | 0; return t; }
function bytes(): number[] { const out: number[] = []; let x = 0xdeadbeef; for (let i = 0; i < 4; i++) { out.push(x & 0xff); x >>>= 8; } return out; }
function u32(): number[] { let x = 1; const r: number[] = []; for (let i = 0; i < 34; i += 11) { r.push(x << i, (x << i) >>> 0, 1 << i); } return r; }
function bigIndex(a: number[]): (number | undefined)[] { const i = 2147483647; return [a[i], a[i - 2147483647], a[(i + 1) | 0], a[-0]]; }
const data = [3, 1, 4, 1, 5, 9, 2, 6];
console.log(sum(data), rsum(data), popcount(0xf0f0), popcount(-1), popcount(2.9), fnv("hello"), djb("hello world"));
console.log(stepBy(10, 1), stepBy(0, 1), stepBy(-5, 2), stepBy(2.5, 0), counterAfter(), shadow(), mixed(2.5), mixed(-0), Object.is(mixed(-0), -0));
console.log(negZero(), bound([7, 8]), signed(), nested(), bytes(), u32(), bigIndex(data));
let g = 0;
function bump(): void { g = (g + 1) | 0; }
for (let i = 0; i < 10; i++) bump();
console.log(g);
let big = 2147483600;
for (let i = 0; i < 100; i++) big++;
console.log(big, big | 0, big >>> 0);
// a counter written in its own loop body is no longer guarded by the test
function jump(): number { let i = 0; for (i = 0; i < 10; i++) { if (i === 3) i = 2147483647; } return i; }
function jump2(): number { let n = 0; for (let i = 0; i < 10; i++) { n++; if (i === 2) i += 2147483640; if (n > 5) return i; } return -1; }
console.log(jump(), jump2(), jump() | 0);
