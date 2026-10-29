// The only diagnostic is a cascade ("inherit the blocker on its declaration") whose root is never reported.
function variadic(...xs: unknown[]): number {
  return xs.length;
}
console.log([5, 6].map(variadic).join(","));
