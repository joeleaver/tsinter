// @transform-types
// Parameter properties (`constructor(public x: number)`): pure sugar — the
// parameter declares a field and assigns it. Node's transform hoists the
// field DEFINITIONS above every declared field (inspect order) and injects
// the ASSIGNMENTS at the top of the constructor body — after super() and
// after the field initializers ran. Visibility and readonly are type-world;
// the properties are ordinary at runtime (private ones print).
import { inspect } from "node:util";

// All modifier spellings; defaulted and optional parameter properties.
class Point {
  tag = "pt";
  constructor(
    public x: number,
    private y: number,
    protected z: number,
    readonly w: number,
    public readonly label: string = "L",
    public alt?: string,
  ) {}
  sum(): number {
    return this.x + this.y + this.z + this.w;
  }
}
const p = new Point(1, 2, 3, 4);
console.log(inspect(p));
console.log(p.sum(), p.x, p.w, p.label, `${p.alt}`);
const q = new Point(5, 6, 7, 8, "Q", "A");
console.log(inspect(q), q.sum());

// Layout/inspect order: parameter properties define FIRST, before declared
// fields — even fields declared ABOVE the constructor.
class Order {
  a = "a";
  constructor(public first: number, private second: string) {}
  b = this.a + "b";
  secondOf(): string {
    return this.second;
  }
}
const o = new Order(1, "s");
console.log(inspect(o), o.secondOf());

// Assignment order: parameter defaults → super() → field initializers →
// parameter-property assignments → constructor body (each step logs).
function logged<T>(msg: string, v: T): T {
  console.log(msg);
  return v;
}
class Base {
  constructor() {
    console.log("base ctor");
  }
}
class Timing extends Base {
  seen = logged("field init", "s");
  constructor(public x: number = logged("default eval", 9)) {
    super();
    console.log(`body:${this.x} ${this.seen}`);
  }
}
const t = new Timing();
console.log(inspect(t));

// Derived chains: base parameter properties assign during super(), so the
// derived class's field initializers can read them.
class Vehicle {
  constructor(public wheels: number) {}
}
class Truck extends Vehicle {
  kind = `truck${this.wheels}`;
  constructor(public load: number) {
    super(6);
  }
}
console.log(inspect(new Truck(1000)));

// Constructor body uses: reads, writes, method calls over the fields.
class Counter {
  constructor(private count: number, public step: number) {
    this.count = this.count + this.step;
  }
  value(): number {
    return this.count;
  }
}
const c = new Counter(10, 5);
console.log(c.value(), c.step);

// Parameter property defaults evaluate left-to-right and may read earlier
// parameters.
class Rect {
  constructor(public w: number, public h: number = w * 2) {}
  area(): number {
    return this.w * this.h;
  }
}
console.log(new Rect(3).area(), new Rect(3, 4).area());

// Class expressions with parameter properties. (Their inspect display
// name is a pre-existing divergence — cx-qualified vs NamedEvaluation —
// so this pins the field values, not the inspect form.)
const Pair = class {
  constructor(public a: string, public b: string) {}
};
const pr = new Pair("x", "y");
console.log(pr.a + pr.b);

// Generic classes: the parameter property's field is per-instantiation.
class Box<T> {
  constructor(public value: T, public name: string) {}
  get(): T {
    return this.value;
  }
}
const bn = new Box(41, "n");
const bs = new Box("s", "t");
console.log(bn.get() + 1, bs.get(), bn.name, bs.name, inspect(bn));

// RC stress: ref-typed parameter properties retain/release through
// construction, reassignment, and drop.
class Holder {
  constructor(public items: string[], private extra: string[]) {}
  total(): number {
    return this.items.length + this.extra.length;
  }
}
for (let i = 0; i < 100; i++) {
  const h = new Holder([`a${i}`, "b"], ["c"]);
  h.items = [...h.items, "d"];
  if (i === 99) console.log(h.total(), inspect(h));
}
