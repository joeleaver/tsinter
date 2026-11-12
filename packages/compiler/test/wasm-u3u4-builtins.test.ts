/* Units U3 + U4, follow-up: the standard library's Error, Object and
 * globalThis taken as dynamic values, and `class X extends <dynamic>`
 * (the shapes zod 4's core.js and util.js use at startup, written here
 * from scratch). Compared with Node byte for byte on the wasm and
 * wasm-native lanes (u3u4-rows.ts). */
import { defineRows, type Row } from "./u3u4-rows.js";

const ROWS: Row[] = [
  { id: "U34B-ERR-01 Error's statics through the value: in, typeof, stackTraceLimit read and written", entry: "main.mjs", src: `let _E = "captureStackTrace" in Error ? Error : null;\nconsole.log(_E === Error, typeof Error.captureStackTrace, "stackTraceLimit" in Error, "nope" in Error);\nconst saved = _E.stackTraceLimit;\ntry { _E.stackTraceLimit = 0; console.log(typeof saved, _E.stackTraceLimit); } finally { _E.stackTraceLimit = saved; }\nconsole.log(Error.stackTraceLimit, Error.prepareStackTrace, Error.captureStackTrace.name, Error.captureStackTrace.length);` },
  { id: "U34B-ERR-02 captureStackTrace gives an object a non-enumerable own stack", entry: "main.mjs", src: `const capture = "captureStackTrace" in Error ? Error.captureStackTrace : () => {};\nconst o = { a: 1 };\ncapture(o);\nconsole.log(Object.keys(o), "stack" in o, Object.getOwnPropertyDescriptor(o, "stack").enumerable, JSON.stringify(o));\ntry { Error.captureStackTrace(5); } catch (e) { console.log(e.name, e.message); }` },
  { id: "U34B-ERR-03 the Error value constructs errors", entry: "main.mjs", src: `const E = Error;\nconst e = new E("boom");\nconsole.log(e.message, e.name, e instanceof Error, e instanceof E, Error.isError(e), Error.isError({}));\nconst f = E("plain call");\nconsole.log(f.message, f instanceof Error);` },
  { id: "U34B-OBJ-01 the Object value: identity, prototype, construction", entry: "main.mjs", src: `function pick(p) { return p ?? Object; }\nconst Parent = pick(undefined);\nconsole.log(Parent === Object, typeof Parent, Parent.name, Parent.prototype === Object.prototype);\nconst o = new Parent();\nconst p = { k: 1 };\nconsole.log(o, Parent(p) === p, Object.getPrototypeOf(o) === Object.prototype);` },
  { id: "U34B-GT-01 globalThis as an object the program writes to", entry: "main.mjs", src: `var _a;\n(_a = globalThis).__cfg ?? (_a.__cfg = {});\nexport const cfg = globalThis.__cfg;\ncfg.x = 1;\nconsole.log(cfg, globalThis.__cfg === cfg, globalThis.__cfg.x, "__cfg" in globalThis, "console" in globalThis);\nconst pp = globalThis.__zod_like?.postProcessor;\nconsole.log(pp);` },
  { id: "U34B-CLS-01 a member-less class over a dynamic base (the $constructor shape)", entry: "main.mjs", src: `function mk(params) {\n  const Parent = params?.Parent ?? Object;\n  class Definition extends Parent {}\n  Object.defineProperty(Definition, "name", { value: "X" });\n  return Definition;\n}\nconst D = mk(undefined);\nconst d = new D();\nconsole.log(d instanceof D, D.name, Object.keys(d), d);\nconst DE = mk({ Parent: Error });\nconst de = new DE();\nconsole.log(de instanceof DE, de instanceof Error, DE.name);\ntry { D(); } catch (e) { console.log(e.name, e.message); }` },
  { id: "U34B-CLS-02 over an ES5 base function", src: `function Base() { this.b = 1; }\nBase.prototype.hi = function () { return "hi " + this.b; };\nfunction mk(params) {\n  const P = params.P;\n  class Definition extends P {}\n  return Definition;\n}\nconst D = mk({ P: Base });\nconst d = new D();\nconsole.log(typeof D, d.b, d.hi(), d instanceof D, d instanceof Base);` },
];

defineRows("U3+U4: builtins as dynamic values", ROWS);
