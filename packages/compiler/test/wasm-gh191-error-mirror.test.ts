/* GH #191: an instance of a program's own Error subclass, held in a dynamic
 * value (unknown, any, a catch binding), shows its own members as Node does:
 * the dynamic error encoding mirrors the instance — own keys in Node's order
 * (parameter properties, field declarations, the constructor's top-level
 * assignments; a property first assigned elsewhere once it is), values read
 * live, dynamic writes stored into the typed fields, prototype methods and
 * accessors answered through the class. SEMANTICS.md S138 keeps named stops
 * only where Node's answer depends on what no struct holds. Every row runs on
 * the wasm and wasm-native lanes against Node. */
import { defineRows } from "./u3u4-rows.js";

const S138 = /SEMANTICS\.md S138/;

defineRows("GH #191: user Error subclasses in dynamic values", [
  {
    id: "GH191-01 the issue's program: a parameter property read through any, unknown and a catch binding",
    entry: "main.ts",
    src: `class FsError extends Error { constructor(m: string, readonly code: string) { super(m); } }
const e = new FsError("own", "EOWN");
const a: any = e; const u: unknown = e;
console.log(a.code, JSON.stringify(u), (u as Record<string, unknown>)["code"]);
try { throw e; } catch (c: any) { console.log(c.code, c.message, String(c)); }`,
  },
  {
    id: "GH191-02 key order: parameter properties, fields (uninitialized ones too), then the constructor's assignments; methods and getters through the class",
    entry: "main.ts",
    src: `class A extends Error {
  extra: number;
  kind = "k";
  undefd: string | undefined;
  constructor(m: string, readonly code: string, public n2: number) {
    super(m);
    this.name = "AE";
    this.extra = 3;
  }
  hi() { return "hi " + this.code; }
  get g() { return this.n2 * 2; }
}
const a: any = new A("x", "EC", 7);
console.log(Object.keys(a), JSON.stringify(a));
console.log(a.hi(), a.g, "hi" in a, "g" in a, Object.hasOwn(a, "hi"), Object.hasOwn(a, "code"), a.name, a instanceof Error);
a.code = "NEW"; a.zz = 1;
console.log(Object.keys(a), JSON.stringify(a), a.hi());`,
  },
  {
    id: "GH191-03 live both ways: a declare field first assigned after the crossing takes its place, a typed write shows",
    entry: "main.ts",
    src: `class B extends Error {
  declare detail: string;
  count = 0;
  constructor(m: string, d?: string) { super(m); if (d !== undefined) this.detail = d; }
  bump() { this.count++; }
}
const b = new B("m");
const u: any = b;
console.log(Object.keys(u), JSON.stringify(u));
b.detail = "late"; b.bump();
console.log(Object.keys(u), JSON.stringify(u), u.detail, u.count);
const b2: any = new B("n", "D");
console.log(Object.keys(b2), b2.detail);`,
  },
  {
    id: "GH191-04 commander's error classes (JavaScript): own name, code, exitCode, an undefined member; assign, spread, for-in, in, hasOwn",
    src: `class CommanderError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} code
   * @param {string} message
   */
  constructor(exitCode, code, message) {
    super(message);
    this.name = "CommanderError";
    this.code = code;
    this.exitCode = exitCode;
    this.nestedError = undefined;
  }
}
class InvalidArgumentError extends CommanderError {
  /** @param {string} [message] */
  constructor(message) {
    super(1, "commander.invalidArgument", message);
    this.name = "InvalidArgumentError";
  }
}
/** @returns {any} */
function run(fn) { try { fn(); } catch (err) { return err; } }
const e = run(() => { throw new InvalidArgumentError("bad"); });
console.log(e.code, e.exitCode, e.name, e.message, e instanceof Error, Object.keys(e), JSON.stringify(e));
const copy = Object.assign({}, e);
console.log(copy, { ...e });
for (const k in e) console.log("key", k);
console.log("code" in e, "nope" in e, Object.hasOwn(e, "exitCode"));`,
  },
  {
    id: "GH191-05 a toJSON method answers JSON through the class, reading a field written after the crossing",
    entry: "main.ts",
    src: `class E2 extends Error {
  status = 0;
  constructor(m: string) { super(m); }
  toJSON() { return { m: this.message, s: this.status }; }
}
const x = new E2("hello");
const d: unknown = x;
x.status = 5;
console.log(JSON.stringify(d));`,
  },
  {
    id: "GH191-06 an accessor pair: a dynamic write runs the setter, a read the getter; a private field stays unlisted",
    entry: "main.ts",
    src: `class E3 extends Error {
  private _v = 1;
  constructor() { super("e3"); }
  get v() { return this._v; }
  set v(n: number) { this._v = n * 10; }
}
const a: any = new E3();
a.v = 2;
console.log(a.v, Object.keys(a), JSON.stringify(a));`,
  },
  {
    id: "GH191-07 a three-level chain: each instance lists its own class's keys; a subclass method through any",
    entry: "main.ts",
    src: `class Base extends Error { constructor(m: string, public code: string) { super(m); } }
class Mid extends Base { level = 2; }
class Leaf extends Mid { constructor() { super("leaf", "LC"); this.name = "Leaf"; } describe() { return \`\${this.name}:\${this.code}:\${this.level}\`; } }
const show = (a: any): void => { console.log(Object.keys(a), JSON.stringify(a), "describe" in a); };
show(new Base("b", "BC"));
show(new Mid("m", "MC"));
const l: any = new Leaf();
show(l);
console.log(l.describe());`,
  },
  {
    id: "GH191-08 a name assigned conditionally: reads equal Node, a listing stops by name (its presence is unknown)",
    entry: "main.ts",
    src: `class E4 extends Error { constructor(m: string, c: boolean) { super(m); if (c) this.name = "Cond"; } }
const a: any = new E4("m", true);
console.log(a.name, String(a));
console.log(Object.keys(a));`,
    fence: { text: S138, stdout: "Cond Cond: m\n" },
  },
  {
    id: "GH191-09 a message assigned after super(): reads equal Node, a listing stops by name (own only when super() had none)",
    entry: "main.ts",
    src: `class E5 extends Error { constructor() { super(); this.message = "late"; } }
const a: any = new E5();
console.log(a.message, String(a));
console.log(JSON.stringify(a));`,
    fence: { text: S138, stdout: "late Error: late\n" },
  },
  {
    id: "GH191-10 two properties first assigned outside the constructor's top level, both set before the crossing: their order is unknown, a named stop",
    entry: "main.ts",
    src: `class E6 extends Error {
  declare a1: string;
  declare a2: string;
  constructor() { super("e6"); }
  fill() { this.a2 = "two"; this.a1 = "one"; }
}
const e = new E6();
e.fill();
console.log("before");
const d: any = e;
console.log(Object.keys(d));`,
    fence: { text: S138, stdout: "before\n" },
  },
  {
    id: "GH191-12 (review) a late key assigned during construction (a base constructor's method call) before a later field: its place is unknown, a named stop",
    entry: "main.ts",
    src: `class Base extends Error {
  declare detail: string;
  constructor(m: string) { super(m); this.init(); }
  init() { this.detail = "D"; }
}
class Sub extends Base { extra = 1; constructor() { super("s"); } }
const s = new Sub();
console.log("before", s.detail);
const a: any = s;
console.log(Object.keys(a));`,
    fence: { text: S138, stdout: "before D\n" },
  },
  {
    id: "GH191-13 (review) JavaScript: a conditional assignment in the constructor ahead of an unconditional one stops when present",
    src: `class E extends Error {
  /** @param {string} m @param {boolean} c */
  constructor(m, c) {
    super(m);
    if (c) { this.x = 1; }
    this.y = 2;
  }
}
/** @returns {any} */
function id(x) { return x; }
console.log(Object.keys(id(new E("m", false))));
console.log(Object.keys(id(new E("m", true))));`,
    fence: { text: S138, stdout: "[ 'y' ]\n" },
  },
  {
    id: "GH191-14 (review) JavaScript: an assignment after an early return is late; absent, the listing equals Node",
    src: `class E extends Error {
  /** @param {string} m @param {boolean} skip */
  constructor(m, skip) {
    super(m);
    this.a = 1;
    if (skip) return;
    this.b = 2;
  }
}
/** @returns {any} */
function id(x) { return x; }
const e = id(new E("m", true));
console.log(Object.keys(e), JSON.stringify(e), "b" in e);`,
  },
  {
    id: "GH191-15 (review) a late key first assigned by a method after construction is the last own key, exactly",
    entry: "main.ts",
    src: `class E extends Error {
  declare later: string;
  code = 1;
  constructor(m: string) { super(m); }
  setLater() { this.later = "L"; }
}
const e = new E("m");
e.setLater();
const a: any = e;
console.log(Object.keys(a), JSON.stringify(a));`,
  },
  {
    id: "GH191-16 (review) delete of a mirrored member stops by name (its typed field keeps no absent state)",
    entry: "main.ts",
    src: `class E extends Error {
  declare detail: string;
  constructor(m: string) { super(m); }
}
const e = new E("m");
e.detail = "D";
const a: any = e;
console.log(Object.keys(a));
delete a.detail;
console.log(Object.keys(a));`,
    fence: { text: S138, stdout: "[ 'detail' ]\n" },
  },
  {
    id: "GH191-17 (review) a method read as a value (not called) stops by name; a call through the read runs",
    entry: "main.ts",
    src: `class E extends Error {
  constructor(m: string, public code: string) { super(m); }
  describe() { return "d:" + this.code; }
}
const a: any = new E("m", "C");
console.log(a.describe(), "describe" in a, Object.hasOwn(a, "describe"));
const f = a.describe;
console.log(typeof f);`,
    fence: { text: S138, stdout: "d:C true false\n" },
  },
  {
    id: "GH191-18 (review) name written from outside the class, typed or dynamic, before or after the crossing, is listed where Node lists it",
    entry: "main.ts",
    src: `class E extends Error { code = "c"; constructor(m: string) { super(m); } }
const e = new E("m");
const a: any = e;
console.log(Object.keys(a));
e.name = "Outer";
console.log(Object.keys(a), JSON.stringify(a), a.name);
const e2 = new E("m2");
e2.name = "Early";
const b: any = e2;
b.extra = 1;
console.log(Object.keys(b), JSON.stringify(b), String(b));
const c: any = new E("m3");
c.zz = 1;
c.name = "Dyn";
console.log(Object.keys(c), JSON.stringify(c));`,
  },
  {
    id: "GH191-19 (re-check) a getter read on this in a base constructor creates a late key ahead of a subclass field: a named stop",
    entry: "main.ts",
    src: `class Base extends Error {
  declare detail: string;
  get touch(): number { this.detail = "G"; return 1; }
  constructor(m: string) { super(m); const t = this.touch; void t; }
}
class Sub extends Base { extra = 1; constructor() { super("s"); } }
const s = new Sub();
console.log("pre", s.detail, s.extra);
const a: any = s;
console.log(Object.keys(a), JSON.stringify(a));`,
    fence: { text: S138, stdout: "pre G 1\n" },
  },
  {
    id: "GH191-20 (re-check) a getter read on this in a field initializer: a named stop",
    entry: "main.ts",
    src: `class Base extends Error {
  declare detail: string;
  get touch(): number { this.detail = "G"; return 1; }
  constructor(m: string) { super(m); }
}
class Sub extends Base { k = this.touch; extra = 2; constructor() { super("s"); } }
const s = new Sub();
console.log("pre", s.detail, s.k);
const a: any = s;
console.log(Object.keys(a), JSON.stringify(a));`,
    fence: { text: S138, stdout: "pre G 1\n" },
  },
  {
    id: "GH191-21 (re-check) a getter read on this before the constructor sets name: a named stop",
    entry: "main.ts",
    src: `class E extends Error {
  code = "c";
  declare detail: string;
  get touch(): number { this.detail = "G"; return 1; }
  constructor(m: string) { super(m); const t = this.touch; this.name = "N" + t; }
}
const e = new E("m");
console.log("pre", e.detail, e.name);
const a: any = e;
console.log(Object.keys(a), JSON.stringify(a));`,
    fence: { text: S138, stdout: "pre G N1\n" },
  },
  {
    id: "GH191-11 a dynamic write that does not fit the field's type stops by name (typed storage stays typed)",
    entry: "main.ts",
    src: `class Typed extends Error { n = 1; constructor() { super("t"); } }
const t: any = new Typed();
console.log(t.n);
t.n = "str";
console.log(t.n);`,
    fence: { text: /expected number, got string/, stdout: "1\n" },
  },
]);
