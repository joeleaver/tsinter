// P1 review: a binding no write ever placed (its only write reads itself)
// is unknown to its readers, not empty — locals.
function run(n: number): number {
  let s!: number;
  let last = 0;
  let z = 0;
  for (let r = 0; r < n; r++) {
    s = ((s | 0) + 12345) | 0;
    last = s & 0xffff;
    z = last * 100000;
  }
  return z;
}
console.log(run(2));
