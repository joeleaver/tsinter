// Call overhead: naive recursive fib and a float loop (the design study's b3).
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
let acc = 0;
for (let i = 0; i < 3_000_000; i++) acc += Math.sqrt(i) * 0.5;
console.log(fib(32), Math.round(acc));
