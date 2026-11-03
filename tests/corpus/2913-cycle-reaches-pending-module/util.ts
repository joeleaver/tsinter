const K = "five";
class Box {
  v = 3;
}
const items: string[] = [];
export function read(): string {
  return K;
}
export function readBox(): string {
  return String(new Box().v);
}
export function readItems(): string {
  items.push("x");
  return String(items.length);
}
console.log("util ran", read(), readBox(), readItems());
