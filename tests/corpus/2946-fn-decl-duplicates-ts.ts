// @ts-nocheck
// GH #111 (TypeScript with checking off): a nested function declared twice
// in one function body is the last declaration from the body's entry on.
function outer(): number {
  function f(): number { return 1; }
  const a = f();
  function f(): number { return 2; }
  return a + f();
}
console.log(outer());

function viaValue(): string {
  const run = pick;
  function pick(n: number): string { return "first" + n; }
  function pick(n: number): string { return "last" + n; }
  return run(1) + " " + pick(2);
}
console.log(viaValue());
