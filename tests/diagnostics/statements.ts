const n: number = 3;
class Widget {
  id = 1;
}
const w = new Widget();
for (const key in w) {
  console.log(key);
}
for (let i = 0, j = n; i < j; i = i + 1) {
  setTimeout(() => console.log(i + j), 0);
}
debugger;
enum Color {
  Red,
}
const m = new Map<string, number>();
pairs: for (const [k, v] of m) {
  if (v > 0) {
    break pairs;
  }
  console.log(k);
}
const [first] = [1];
