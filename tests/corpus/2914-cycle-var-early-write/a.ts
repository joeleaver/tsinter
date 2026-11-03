import "./b.ts";
export var v: number | undefined;
export function setV(): number {
  v = (v ?? 0) + 42;
  return v;
}
console.log("a", v);
