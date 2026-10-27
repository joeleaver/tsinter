// Module-scope temporal dead zone (board #265): a file-scope const / let /
// class exists from module entry but is uninitialized until its
// declaration runs. A function the module calls EARLIER that reads,
// writes, or typeof-tests the binding throws Node's catchable
// ReferenceError "Cannot access 'x' before initialization" — and once the
// declaration ran, the same functions see the value. Covered: reads,
// writes (the RHS evaluates first), ++ / += / destructuring / for-of
// targets, typeof, classes (new, statics, as a value, instanceof, the
// class's own inner binding), instance field initializers, closures,
// generators and async functions, per-declarator and per-pattern-element
// initialization order,
// a dependency module's own early reads, import cycles (a
// declaration-only cluster and one whose members run code), and a timer
// firing during a dependency's top-level await.
import { earlyReport, lateReport, describeLimit, bump, counter } from "./early.ts";
import { pairSum } from "./pair-a.ts";
import { ringReport } from "./ring-a.ts";
import { tlaLog } from "./tla.ts";

function msg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : "non-error";
}
function attempt(label: string, f: () => void): void {
  try {
    f();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, msg(e));
  }
}
function side(v: number): number {
  console.log("  rhs evaluated", v);
  return v;
}

const readTotal = (): number => total;
function writeLevel(): void {
  level = side(4);
}
function bumpLevel(): void {
  level++;
}
function addLevel(): void {
  level += 2;
}
function swapLevels(): void {
  [level, depth] = [7, 8];
}
function loopLevel(): void {
  for (level of [1, 2]) console.log("  iter", level);
}
function loopNone(): void {
  for (level of []) console.log("  never");
}
function kindOfName(): string {
  return typeof name;
}
function guardedKind(): string {
  return typeof name === "string" ? "string" : "other";
}
function makeShape(): number {
  return new Shape(2).area;
}
function shapeUnit(): number {
  return Shape.unit;
}
function shapeScale(n: number): number {
  return Shape.scale(n);
}
function shapeName(): string {
  const s = Shape;
  return s.name;
}
function isShape(o: Base): boolean {
  return o instanceof Shape;
}
function makeHolder(): number {
  return new Holder().seen;
}
// Reads lowering folds or aliases away still throw.
function unsetCheck(): boolean {
  return config === undefined;
}
function voidRead(): string {
  void config;
  return "read";
}
function viaAlias(): number {
  return ShapeAlias.unit;
}
function viaClosure(): number {
  const inner = (): number => total * 2;
  return inner();
}
function* totals(): Generator<number> {
  yield total;
}
async function laterTotal(): Promise<number> {
  return total;
}

// Declared (initialized) before the early calls: only what they read is not.
class Base {
  tag = "base";
}
class Holder {
  seen = later + 1;
}

console.log("-- before the declarations");
attempt("read const", () => console.log(" ", readTotal()));
attempt("write let", writeLevel);
attempt("let ++", bumpLevel);
attempt("let +=", addLevel);
attempt("destructure", swapLevels);
attempt("for-of target", loopLevel);
attempt("for-of empty", loopNone);
attempt("typeof", () => console.log(" ", kindOfName()));
attempt("typeof test", () => console.log(" ", guardedKind()));
attempt("new class", () => console.log(" ", makeShape()));
attempt("static field", () => console.log(" ", shapeUnit()));
attempt("static method", () => console.log(" ", shapeScale(2)));
attempt("class value", () => console.log(" ", shapeName()));
attempt("instanceof", () => console.log(" ", isShape(new Base())));
attempt("field init", () => console.log(" ", makeHolder()));
attempt("folded === undefined", () => console.log(" ", unsetCheck()));
attempt("folded void", () => console.log(" ", voidRead()));
attempt("class alias", () => console.log(" ", viaAlias()));
attempt("closure", () => console.log(" ", viaClosure()));
attempt("generator", () => console.log(" ", totals().next().value));
laterTotal()
  .then((v) => console.log("async", v))
  .catch((e: unknown) => console.log("async", msg(e)));

// Declarators initialize left to right: readTotal sees total already.
const total = 10,
  doubled = readTotal() * 2;
let level = 1;
let depth = 0;
const name = "tsinter";
class Shape extends Base {
  static unit = 1;
  static scale(n: number): number {
    return n * Shape.unit * 3;
  }
  area: number;
  constructor(side: number) {
    super();
    this.area = side * side;
  }
  // The class's own inner binding: never a TDZ read.
  static one(): number {
    return new Shape(1).area;
  }
}
const later = 41;
const config: { v: number } | undefined = { v: 1 };
const ShapeAlias = Shape;

// Destructuring binds element by element: a default may read an earlier
// element while a later one is still uninitialized.
function firstOf(): number {
  return first;
}
function lastOf(): number {
  return last;
}
function tryLast(): number {
  try {
    return lastOf();
  } catch (e) {
    console.log(" ", msg(e));
    return -1;
  }
}
const { first = 1, second = firstOf() + 1, early = tryLast(), last = 9 } = {} as {
  first?: number;
  second?: number;
  early?: number;
  last?: number;
};
console.log("pattern", first, second, early, last);

console.log("-- after the declarations");
console.log(total, doubled, level, depth, name);
attempt("read const", () => console.log(" ", readTotal()));
attempt("write let", writeLevel);
attempt("let ++", bumpLevel);
attempt("let +=", addLevel);
attempt("destructure", swapLevels);
attempt("for-of target", loopLevel);
attempt("typeof", () => console.log(" ", kindOfName()));
attempt("typeof test", () => console.log(" ", guardedKind()));
attempt("new class", () => console.log(" ", makeShape()));
attempt("static field", () => console.log(" ", shapeUnit()));
attempt("static method", () => console.log(" ", shapeScale(2)));
attempt("class value", () => console.log(" ", shapeName()));
attempt("instanceof", () => console.log(" ", isShape(new Shape(3))));
attempt("inner binding", () => console.log(" ", Shape.one()));
attempt("field init", () => console.log(" ", makeHolder()));
attempt("folded === undefined", () => console.log(" ", unsetCheck()));
attempt("folded void", () => console.log(" ", voidRead()));
attempt("class alias", () => console.log(" ", viaAlias()));
attempt("closure", () => console.log(" ", viaClosure()));
attempt("generator", () => console.log(" ", totals().next().value));
console.log("level", level, "depth", depth);

console.log("-- modules");
console.log(earlyReport);
console.log(lateReport);
console.log(describeLimit(), bump(), bump(), counter);
console.log("pair", pairSum());
console.log(ringReport());
console.log(tlaLog());
