import "./ring-a.ts";
console.log("ring-b body");
function own(): string {
  return B_TAG;
}
let early = "";
try {
  early = own();
} catch (e) {
  early = e instanceof Error ? `${e.name}: ${e.message}` : "non-error";
}
export function ringB(): string {
  return `${early} | ${own()}`;
}
const B_TAG = "b";
