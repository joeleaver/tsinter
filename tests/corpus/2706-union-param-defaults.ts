// Parameter defaults on UNION-typed parameters: the ABI arms the body
// union with undefined, and a present argument re-tags back into the body
// union in the prologue (interned retag helper — the undefined arm is the
// one stranded, unreachable case). Both omission and an explicit
// undefined trigger the default, JS-exact.
function norm(tlds: string | string[] = "localhost"): string {
  if (typeof tlds === "string") return tlds;
  return tlds.join("|");
}
console.log(norm(), norm("dev"), norm(["a", "b"]), norm(undefined));

// A null-armed union default whose default VALUE is another union read.
let active: string | null = null;
function upd(next: string | null, prev: string | null = active): string {
  return `${next ?? "-"}|${prev ?? "-"}`;
}
console.log(upd("a"), upd(null, "z"), upd("b", null));
active = "now";
console.log(upd("c"));

// Const-lambda values with defaults: the completed-signature contract —
// the value's type spells `T | undefined`, the default lives in the
// closure prologue, calls through the value complete omitted args with
// the undefined arm.
const scale = (x: number, factor: number | undefined = 2): number => x * factor;
console.log(scale(5), scale(5, 3), scale(5, undefined));

const label = (v: string | number, prefix: string | string[] = ["p", "q"]): string => {
  const p = typeof prefix === "string" ? prefix : prefix.join("");
  return `${p}:${v}`;
};
console.log(label(1), label("x", "L"), label(2, ["a", "b", "c"]));

// The default expression evaluates ONLY when the argument is absent
// (JS's per-call evaluation), observed via a counter.
let evals = 0;
function tick(): string {
  evals++;
  return "d";
}
function count(v: number | string = tick()): string {
  return `${v}`;
}
count(1);
count("s");
count();
count(undefined);
console.log(evals);

// Function declarations used as values keep working when the signature
// spells out the completed union slots.
const fn: (tlds: string | string[] | undefined) => string = norm;
console.log(fn(undefined), fn(["z", "w"]));
