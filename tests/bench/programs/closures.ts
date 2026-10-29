// Closures and higher-order calls: counters, composed functions, map/filter/reduce.
function counter(step: number): () => number {
  let n = 0;
  return () => (n = n + step);
}
function compose(f: (x: number) => number, g: (x: number) => number): (x: number) => number {
  return (x) => g(f(x));
}
let total = 0;
for (let i = 0; i < 200_000; i++) {
  const c = counter(i % 5);
  c();
  total += c();
}
const inc = (x: number): number => x + 1;
const dbl = (x: number): number => x * 2;
let f = compose(inc, dbl);
for (let i = 0; i < 8; i++) f = compose(f, i % 2 === 0 ? inc : dbl);
for (let i = 0; i < 300_000; i++) total += f(i % 3) % 1000;
const xs: number[] = [];
for (let i = 0; i < 100_000; i++) xs.push(i);
for (let r = 0; r < 20; r++) {
  total += xs
    .map((x) => x * 3)
    .filter((x) => x % 2 === 0)
    .reduce((s, x) => s + (x % 7), 0);
}
console.log(total);
