// Array numeric: dense matrix multiply and a 1-D stencil, over number[].
const N = 160;
const a: number[] = [];
const b: number[] = [];
for (let i = 0; i < N * N; i++) {
  a.push((i % 17) * 0.25);
  b.push((i % 23) * 0.5);
}
const c: number[] = [];
for (let i = 0; i < N * N; i++) c.push(0);
for (let rep = 0; rep < 3; rep++) {
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      const aik = a[i * N + k]!;
      for (let j = 0; j < N; j++) c[i * N + j] = c[i * N + j]! + aik * b[k * N + j]!;
    }
  }
}
let trace = 0;
for (let i = 0; i < N; i++) trace += c[i * N + i]!;
const M = 1 << 16;
let u: number[] = [];
let v: number[] = [];
for (let i = 0; i < M; i++) {
  u.push((i % 100) / 100);
  v.push(0);
}
for (let step = 0; step < 200; step++) {
  for (let i = 1; i < M - 1; i++) v[i] = (u[i - 1]! + u[i]! + u[i + 1]!) / 3;
  const t = u;
  u = v;
  v = t;
}
let s = 0;
for (let i = 0; i < M; i++) s += u[i]!;
console.log(trace, s.toFixed(6));
