// Sort with a comparator: records by two keys, numbers descending.
// (Sized small: the static lowering's sort is an insertion sort today, quadratic.)
interface Rec {
  k: number;
  name: string;
}
let seed = 12345;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed;
}
let check = 0;
for (let round = 0; round < 5; round++) {
  const recs: Rec[] = [];
  for (let i = 0; i < 4_000; i++) recs.push({ k: rnd() % 1000, name: "n" + (rnd() % 5000) });
  recs.sort((a, b) => a.k - b.k || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const nums: number[] = [];
  for (let i = 0; i < 8_000; i++) nums.push(rnd() % 100_000);
  nums.sort((a, b) => b - a);
  check += recs[0]!.k + recs[recs.length - 1]!.k + nums[0]! + nums[nums.length - 1]! + recs[777]!.name.length;
}
console.log(check);
