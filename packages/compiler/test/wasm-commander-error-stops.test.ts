/* Commander's error classes (lib/error.js) on the WasmGC lanes: three
 * shapes that refused by name before.
 *  - `Error.captureStackTrace(this, this.constructor)` over a statically
 *    typed instance: Node gives it a fresh `stack`, which a typed error
 *    never exposes here, so the call's only effects are its arguments'.
 *  - `this.constructor.name` over a typed program-class instance: the
 *    run-time class's own JS name, a subclass's included.
 *  - `x instanceof C` for a program's own Error subclass C on a dynamic
 *    value (a catch binding, any, unknown): an error's encoding answers
 *    through its error's class; anything else is no instance.
 * Every row runs on the wasm and wasm-native lanes against Node. */
import { defineRows } from "./u3u4-rows.js";

defineRows("Commander's error stops", [
  {
    id: "CMDR-ERR-01 commander's CommanderError and InvalidArgumentError, thrown and caught as any",
    src: `class CommanderError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} code
   * @param {string} message
   */
  constructor(exitCode, code, message) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    this.nestedError = undefined;
  }
}
class InvalidArgumentError extends CommanderError {
  /** @param {string} [message] */
  constructor(message) {
    super(1, "commander.invalidArgument", message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
  }
}
/** @returns {any} */
function run(fn) { try { fn(); } catch (err) { return err; } }
const e = run(() => { throw new InvalidArgumentError("bad"); });
console.log(e.name, e.code, e.exitCode, e instanceof CommanderError, e instanceof InvalidArgumentError, Object.keys(e), JSON.stringify(e));
const c = new CommanderError(2, "x", "m");
console.log(c.name, String(c));
const u = run(() => { throw new Error("plain"); });
console.log(u instanceof CommanderError, run(() => { throw "str"; }) instanceof CommanderError);`,
  },
  {
    id: "CMDR-ERR-02 this.constructor.name through a base-class method names the run-time class",
    entry: "main.ts",
    src: `class Base { kind(): string { return this.constructor.name; } }
class A extends Base {}
class B extends A {}
const xs: Base[] = [new Base(), new A(), new B()];
console.log(xs.map((x) => x.kind()), new B().constructor.name);`,
  },
  {
    id: "CMDR-ERR-03 instanceof a user Error subclass over unknown: errors by class, other values false",
    entry: "main.ts",
    src: `class E1 extends Error { constructor(m: string) { super(m); this.name = this.constructor.name; } }
class E2 extends E1 {}
function f(x: unknown) { return [x instanceof E1, x instanceof E2]; }
console.log(f(new E2("a")), f(new E1("b")), f(new Error("c")), f({}), f(null), new E2("z").name);`,
  },
  {
    id: "CMDR-ERR-04 (review) constructor.name over a subclass registered after the method that reads it (a class expression)",
    entry: "main.ts",
    src: `class Base { kind(): string { return this.constructor.name; } }
class A extends Base {}
console.log(new A().kind());
const B = class extends A {};
console.log(new B().kind(), new Base().kind());`,
  },
  {
    id: "CMDR-ERR-05 (review) captureStackTrace over an instance of a class that is not an error keeps its refusal",
    src: `class Plain { constructor() { this.v = 1; } }
const p = new Plain();
Error.captureStackTrace(p);
console.log(Object.keys(p));`,
    fence: { text: /captureStackTrace/, stdout: "" },
  },
  {
    id: "CMDR-ERR-06 (review) a stack a dynamic write gave an error is replaced by captureStackTrace",
    entry: "main.ts",
    src: `declare global { interface ErrorConstructor { captureStackTrace(target: object, ctor?: Function): void } }
class E extends Error { constructor(m: string) { super(m); } }
const e = new E("m");
const a: any = e;
a.stack = "custom";
console.log(a.stack, Object.keys(a));
Error.captureStackTrace(e);
console.log(a.stack === "custom", Object.keys(a));
export {};`,
  },
  {
    id: "CMDR-ERR-09 (re-check) delete of an error's stack through a dynamic value stops by name",
    entry: "main.ts",
    src: `const a: any = new Error("m");
a.stack = "custom";
console.log(Object.keys(a));
delete a.stack;
a.stack = "S";
console.log(Object.keys(a), JSON.stringify(a));`,
    fence: { text: /'delete' of 'stack' of an error held in a dynamic value/, stdout: "[]\n" },
  },
  {
    id: "CMDR-ERR-10 (re-check) defineProperty of an error's stack through a dynamic value stops by name",
    entry: "main.ts",
    src: `const a: any = new Error("m");
console.log(Object.keys(a));
Object.defineProperty(a, "stack", { value: "S", enumerable: true });
console.log(Object.keys(a), JSON.stringify(a));`,
    fence: { text: /Object\.defineProperty \(or defineProperties\) of 'stack' of an error held in a dynamic value/, stdout: "[]\n" },
  },
  {
    id: "CMDR-ERR-07 (review) an anonymous default-exported class declaration is named default",
    entry: "main.mjs",
    src: `import Self from "./main.mjs";
export default class { who() { return this.constructor.name; } }
console.log(Self.name, new Self().who());`,
  },
  {
    id: "CMDR-ERR-08 (review) an anonymous default-exported class expression is named default",
    entry: "main.mjs",
    src: `import Self from "./main.mjs";
export default (class { n() { return this.constructor.name; } });
console.log(Self.name, new Self().n());`,
  },
]);
