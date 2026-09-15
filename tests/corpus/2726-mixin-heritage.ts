// Mixin heritage: `class D extends f(Base)` — the class inside the mixin
// function instantiates per call site with the ARGUMENT class as its base,
// so a derived class composes fields and methods from every layer, super
// chains run bottom-up, and instanceof answers through the whole
// monomorphized chain. The forwarding constructor (`constructor(...args)
// { super(...args); … }`) adopts the base's signature exactly.
type Constructor<T = object> = new (...args: any[]) => T;

class Base {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  sum() {
    return this.x + this.y;
  }
}

// The local-class spelling: define, return by name.
function Tagged<T extends Constructor<object>>(superClass: T) {
  class C extends superClass {
    _tag: string;
    constructor(...args: any[]) {
      super(...args);
      this._tag = "tagged";
    }
    tag() {
      return this._tag;
    }
  }
  return C;
}

class D extends Tagged(Base) {
  d: number;
  constructor() {
    super(3, 4);
    this.d = 100;
  }
}

const d = new D();
console.log(d.sum(), d.tag(), d.d);
console.log(d instanceof D, d instanceof Base);

// The direct return-a-class-expression spelling, with a field initializer
// layer and NO constructor: the synthesized ctor forwards the base's params.
function Counted<T extends Constructor<object>>(B: T) {
  return class extends B {
    count = 0;
    bump() {
      this.count++;
      return this.count;
    }
  };
}

class E extends Counted(Base) {
  label() {
    return `E(${this.x},${this.y})#${this.count}`;
  }
}

const e = new E(7, 8);
console.log(e.label(), e.bump(), e.bump(), e.label());
console.log(e.sum(), e instanceof E, e instanceof Base, d instanceof E);

// Layered heritage from two mixins over one base: the two instantiations
// are DISTINCT classes with their own intervals.
class F extends Tagged(Base) {
  constructor() {
    super(1, 1);
  }
}
console.log(new F().tag(), new F() instanceof D, d instanceof F);

// A mixin over a class that is itself derived: three inheritance layers
// below the mixin's own.
class Derived extends Base {
  z: number;
  constructor(x: number, y: number, z: number) {
    super(x, y);
    this.z = z;
  }
  sum() {
    return super.sum() + this.z;
  }
}

class G extends Counted(Derived) {
  constructor() {
    super(10, 20, 30);
  }
}
const g = new G();
console.log(g.sum(), g.z, g.bump());
console.log(g instanceof G, g instanceof Derived, g instanceof Base, g instanceof E);

// Mixin methods dispatch virtually: a base-typed slot holding the mixin
// subclass calls the override.
class H extends Counted(Base) {
  bump() {
    this.count += 10;
    return this.count;
  }
}
const bases: Base[] = [new E(1, 2), new H(3, 4)];
console.log(bases.map((b) => b.sum()).join(","));
const counted: E[] = [new E(0, 0)];
console.log(counted[0]!.bump());

// A throwing base constructor unwinds through the mixin layer's forwarding.
class Strict {
  v: number;
  constructor(v: number) {
    if (v < 0) throw new RangeError("neg");
    this.v = v;
  }
}
class SafeStrict extends Tagged(Strict) {
  constructor(v: number) {
    super(v);
  }
}
try {
  new SafeStrict(-5);
} catch (err) {
  if (err instanceof RangeError) console.log("caught:", err.message);
}
console.log(new SafeStrict(5).v, new SafeStrict(6).tag());
