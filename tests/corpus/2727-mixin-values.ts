// Mixin RESULTS as first-class values: a top-level `const X = M(Base)`
// binding IS that call's immortal class object — construction, statics,
// `.name`, `extends`, instanceof (direct and through classval slots), and
// intersection-typed instances all resolve through it. Each call site
// mints its OWN class: same-shape results are distinct identities.
type Constructor<T = object> = new (...args: any[]) => T;

class Base {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

class Derived extends Base {
  z: number;
  constructor(x: number, y: number, z: number) {
    super(x, y);
    this.z = z;
  }
}

// The arrow-function mixin spelling, statics-bearing: static declaration-
// time code runs when the call evaluates.
const Printable = <T extends Constructor<Base>>(superClass: T) =>
  class extends superClass {
    static message = "hello";
    print() {
      return this.x + "," + this.y;
    }
  };

function Tagged<T extends Constructor<object>>(superClass: T) {
  class C extends superClass {
    _tag: string;
    constructor(...args: any[]) {
      super(...args);
      this._tag = "tagged";
    }
  }
  return C;
}

const Thing1 = Tagged(Derived);
const Thing2 = Tagged(Printable(Derived));
console.log(Thing2.message);
// NamedEvaluation through a mixin: the inner class declaration's own name;
// the anonymous class-expression spelling has none.
const Anon = Printable(Base);
console.log(Thing1.name, Thing2.name, Anon.name === "");

// Intersection-typed instances (`Tagged.C & Derived`): the chain structure
// picks the one instantiation each type describes.
function f1() {
  const thing = new Thing1(1, 2, 3);
  console.log(thing.x, thing.z, thing._tag);
}
function f2() {
  const thing = new Thing2(4, 5, 6);
  console.log(thing.x, thing._tag, thing.print());
}
f1();
f2();

// Extending a const-bound result, statics reachable through the subclass.
class Thing3 extends Thing2 {
  constructor(tag: string) {
    super(10, 20, 30);
    this._tag = tag;
  }
  test() {
    return this.print();
  }
}
const t3 = new Thing3("t3");
console.log(t3.test(), t3._tag, t3.z, Thing3.message);
console.log(t3 instanceof Thing3, t3 instanceof Thing2, t3 instanceof Derived, t3 instanceof Base);
// Distinct call sites are distinct classes: Thing1's subtree never
// contains Thing2's instances.
console.log(t3 instanceof Thing1, new Thing1(0, 0, 0) instanceof Thing2);

// instanceof through a classval SLOT holding a mixin result (the slot's
// class shares Thing1's constructor ABI — the classval flow rule).
const slot: Constructor<Derived> = Thing1;
console.log(new Thing1(9, 9, 9) instanceof slot, t3 instanceof slot);

// Construction through a constructor-typed parameter.
function build(C: new (x: number, y: number, z: number) => Derived): Derived {
  return new C(2, 3, 4);
}
console.log(build(Thing1).z, build(Thing1) instanceof Thing1, build(Derived) instanceof Thing1);

// Statics-bearing mixin base directly in a heritage clause: its static
// initializer runs at the class statement, before the derived class's own.
class Labeled extends Printable(Derived) {
  static label = Labeled.message + "!";
  constructor() {
    super(1, 2, 3);
  }
}
console.log(Labeled.label, new Labeled().print());
