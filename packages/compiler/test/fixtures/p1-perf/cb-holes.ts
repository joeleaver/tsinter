// P1 item 4: inlined callbacks over arrays that read past their end and
// arrays grown by a write past the end (undefined, not holes, on the wasm
// lanes: such reads give undefined in both engines).
const a: (number | undefined)[] = [1, undefined, 3];
console.log(a.map((x) => (x === undefined ? "u" : x * 2)), a.filter((x) => x !== undefined), a.findIndex((x) => x === undefined), a.some((x) => x === undefined));
const b = [1, 2, 3];
console.log(b.map((x, i, arr) => arr[i + 1] ?? -1), b.reduce((acc, x, i, arr) => acc + (arr[i + 5] ?? 0) + x, 0));
const c: number[] = [10, 20];
let visited = 0;
c.forEach((x, i, arr) => { visited++; if (i === 0) arr.push(30); });
console.log(visited, c);
