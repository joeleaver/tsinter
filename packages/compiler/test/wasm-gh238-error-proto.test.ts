/* GH #238 (SEMANTICS.md S149 amendment): Error.prototype in JavaScript is
 * the Error kind's prototype object — the same object Object.getPrototypeOf
 * answers for an Error — and an error's prototype is its builtin kind's
 * (Error, TypeError, RangeError, SyntaxError). Only identity is modeled;
 * every other use of such a prototype stops by name. zod 4.6.7's
 * v4/core/errors.js seeds `new WeakSet([Object.prototype, Error.prototype])`
 * at module load. */
import { defineRows } from "./u3u4-rows.js";

const main = `import { t } from "./z.js";\nconsole.log(t());`;
const row = (id: string, body: string, extra: object = {}) => ({ id, entry: "main.ts", src: main, files: { "z.js": `${body}` }, ...extra });

defineRows("GH #238 error prototypes", [
  row("GH238-01 the issue's repro: Error.prototype is an object", `export function t() {
  const a = Object.prototype; const b = Error.prototype;
  return [typeof a, typeof b, b === undefined].join(",");
}`),
  row("GH238-02 zod's seeded WeakSet: Object.prototype and Error.prototype are members, a caught Error's prototype is Error.prototype", `const seeded = new WeakSet([Object.prototype, Error.prototype]);
export function t() {
  let p = null;
  try { throw new Error("q"); } catch (e) { p = Object.getPrototypeOf(e); }
  const fresh = {};
  return [seeded.has(Error.prototype), seeded.has(Object.prototype), seeded.has(fresh), seeded.has(p), p === Error.prototype, p === Object.prototype].join(",");
}`),
  row("GH238-03 a caught TypeError: its prototype chain is TypeError.prototype, Error.prototype, Object.prototype; instanceof Error and TypeError", `export function t() {
  try { JSON.parse("null").x; } catch (e) {
    const p = Object.getPrototypeOf(e);
    const pp = Object.getPrototypeOf(p);
    return [typeof p, p === Error.prototype, p === Object.prototype, pp === Error.prototype, Object.getPrototypeOf(pp) === Object.prototype, e instanceof Error, e instanceof TypeError].join(",");
  }
}`),
  row("GH238-04 constructed errors crossing into dynamic code: prototypes by kind, instanceof by kind", `function protoOf(x) { return Object.getPrototypeOf(x); }
function isErr(x) { return x instanceof Error; }
function isType(x) { return x instanceof TypeError; }
function isRange(x) { return x instanceof RangeError; }
export function t() {
  const e = new Error("a"), te = new TypeError("b"), re = new RangeError("c");
  const pe = protoOf(e), pt = protoOf(te), pr = protoOf(re);
  return [pe === Error.prototype, pt === pe, protoOf(pt) === Error.prototype, protoOf(pr) === Error.prototype, pt === pr, protoOf(protoOf(new SyntaxError("d"))) === Error.prototype,
    isErr(e), isType(e), isErr(te), isType(te), isRange(re), isType(re)].join(",");
}`),
  row("GH238-05 a caught RangeError and a JSON.parse SyntaxError chain to Error.prototype", `export function t() {
  const out = [];
  try { "x".repeat(-1); } catch (e) { out.push(Object.getPrototypeOf(Object.getPrototypeOf(e)) === Error.prototype, e instanceof RangeError); }
  try { JSON.parse("{"); } catch (e) { out.push(Object.getPrototypeOf(Object.getPrototypeOf(e)) === Error.prototype, e instanceof SyntaxError); }
  return out.join(",");
}`),
  row("GH238-06 a member read of Error.prototype stops by name", `export function t() {
  console.log("before");
  return Error.prototype.name;
}`, { fence: { text: /reading a member of an error prototype .* held as a dynamic value is not supported yet/, stdout: "before\n" } }),
  row("GH238-07 a write to Error.prototype stops by name", `export function t() {
  console.log("before");
  Error.prototype.extra = 1;
  return "after";
}`, { fence: { text: /assigning a member of an error prototype .* is not supported yet/, stdout: "before\n" } }),
  row("GH238-08 printing a caught error's prototype stops by name", `export function t() {
  console.log("before");
  try { JSON.parse("null").x; } catch (e) { console.log(Object.getPrototypeOf(e)); }
  return "after";
}`, { fence: { text: /reflecting over .* an error prototype .* is not supported yet/, stdout: "before\n" } }),
  row("GH238-09 a program's own Error subclass: Object.getPrototypeOf through a dynamic value stops by name", `class MyErr extends Error {}
function protoOf(x) { return Object.getPrototypeOf(x); }
export function t() {
  console.log("before");
  return protoOf(new MyErr("m")) === Error.prototype;
}`, { fence: { text: /Object\.getPrototypeOf of an error held as a dynamic value whose class is not Error, TypeError, RangeError or SyntaxError/, stdout: "before\n" } }),
  row("GH238-10 (review) a URIError the runtime builds is not an Error: its prototype stops by name, zod's seeded set never answers true for it", `const seen = new WeakSet([Object.prototype, Error.prototype]);
export function t() {
  let e;
  try { decodeURIComponent("%"); } catch (x) { e = x; }
  console.log("before");
  return seen.has(Object.getPrototypeOf(e));
}`, { fence: { text: /Object\.getPrototypeOf of an error .* URIError, ReferenceError/, stdout: "before\n" } }),
  row("GH238-11 (review) the TDZ ReferenceError's prototype stops by name", `function f() { return zz; }
let e;
try { f(); } catch (x) { e = x; }
let zz = 1;
export function t() {
  console.log("before");
  return Object.getPrototypeOf(e) === Error.prototype;
}`, { fence: { text: /Object\.getPrototypeOf of an error .* is not supported yet/, stdout: "before\n" } }),
  row("GH238-12 (review) Object.create(Error.prototype) stops by name", `export function t() {
  console.log("before");
  const o = Object.create(Error.prototype);
  return o instanceof Error;
}`, { fence: { text: /linking an object .* to an error prototype/, stdout: "before\n" } }),
  row("GH238-13 (review) Object.setPrototypeOf(o, Error.prototype) stops by name", `export function t() {
  const o = {};
  console.log("before");
  Object.setPrototypeOf(o, Error.prototype);
  return o.name;
}`, { fence: { text: /linking an object .* to an error prototype/, stdout: "before\n" } }),
  row("GH238-14 (review) a constructor whose prototype is Error.prototype: a member read through new F() stops by name", `function F(m) { this.message = m; }
export function t() {
  console.log("before");
  F.prototype = Error.prototype;
  const o = new F("hi");
  return o.name;
}`, { fence: { text: /an error prototype/, stdout: "before\n" } }),
  row("GH238-15 (review) String(Error.prototype) stops by name", `export function t() {
  console.log("before");
  return String(Error.prototype);
}`, { fence: { text: /converting to a string an error prototype/, stdout: "before\n" } }),
  row("GH238-16 (review) Error.prototype.toString() and toLocaleString() stop by name", `export function t() {
  console.log("before");
  return Error.prototype.toString();
}`, { fence: { text: /an error prototype/, stdout: "before\n" } }),
  row("GH238-17 (review) Error.prototype.isPrototypeOf stops by name", `export function t() {
  console.log("before");
  return Error.prototype.isPrototypeOf(new TypeError("x"));
}`, { fence: { text: /an error prototype/, stdout: "before\n" } }),
  row("GH238-18 (review) hasOwnProperty.call(Error.prototype, k) and Object.hasOwn stop by name", `export function t() {
  console.log("before");
  return Object.prototype.hasOwnProperty.call(Error.prototype, "name");
}`, { fence: { text: /an error prototype/, stdout: "before\n" } }),
  row("GH238-19 (review) a literal-key `in` on Error.prototype stops by name", `export function t() {
  console.log("before");
  return "name" in Error.prototype;
}`, { fence: { text: /an error prototype/, stdout: "before\n" } }),
  row("GH238-20 (review) a caught error's prototype converted to a string stops by name", `export function t() {
  let p;
  try { JSON.parse("null").x; } catch (e) { p = Object.getPrototypeOf(e); }
  console.log("before");
  return \`\${p}\`;
}`, { fence: { text: /an error prototype/, stdout: "before\n" } }),
  row("GH238-21 (review) a caught error's prototype on the left of instanceof stops by name", `function protoOf(x) { return Object.getPrototypeOf(x); }
export function t() {
  let e; try { JSON.parse("{"); } catch (x) { e = x; }
  const p = protoOf(e);
  console.log("before");
  return p instanceof Error;
}`, { fence: { text: /'instanceof' with, on its left, an error prototype/, stdout: "before\n" } }),
  row("GH238-22 (review) a caught error's prototype on the left of instanceof SyntaxError stops by name", `function protoOf(x) { return Object.getPrototypeOf(x); }
export function t() {
  let e; try { JSON.parse("{"); } catch (x) { e = x; }
  const p = protoOf(e);
  console.log("before");
  return p instanceof SyntaxError;
}`, { fence: { text: /'instanceof' with, on its left, an error prototype/, stdout: "before\n" } }),
  row("GH238-23 (review) the bracket spelling Error['prototype'] is Error.prototype", `export function t() {
  const a = Error["prototype"];
  let p; try { throw new Error("q"); } catch (e) { p = Object.getPrototypeOf(e); }
  return [typeof a, a === undefined, a === Error.prototype, p === a].join(",");
}`),
  row("GH238-24 (review, GH #244) a `__proto__: value` entry in a JavaScript object literal stops by name where it runs", `export function t() {
  console.log("before");
  const o = { __proto__: Error.prototype, a: 1 };
  return Object.keys(o).join();
}`, { fence: { text: /a `__proto__: value` entry in an object literal|objLit-proto-key/, stdout: "before\n" } }),
  { id: "GH238-25 (review, GH #244) a quoted `\"__proto__\": value` entry in a TypeScript object literal is refused by name", entry: "main.ts",
    src: `const o = { "__proto__": null, a: 1 };\nconsole.log(Object.keys(o).join());`, refused: /a `__proto__: value` entry in an object literal/ },
  row("GH238-26 (review) globalThis.Error.prototype in JavaScript stops by name where it runs rather than reading undefined", `export function t() {
  console.log("before");
  const b = globalThis.Error.prototype;
  return typeof b;
}`, { fence: { text: /Error\.prototype read through the global object/, stdout: "before\n" } }),
  { id: "GH238-27 (review) globalThis.Error.prototype in TypeScript is refused by name", entry: "main.ts",
    src: `const b: unknown = globalThis.Error.prototype;\nconsole.log(typeof b);`, refused: /Error\.prototype read through the global object/ },
  { id: "GH238-28 (review r3, GH #244) a top-level JavaScript literal `{ __proto__: null }` with the object model live stops by name where it runs",
    src: `const EP = Error.prototype;\nconsole.log("before");\nconst o = { __proto__: null, a: 1 };\nconsole.log(Object.keys(o).join(), EP === Error.prototype);`,
    fence: { text: /a `__proto__: value` entry in an object literal|objLit-proto-key/, stdout: "before\n" } },
  { id: "GH238-29 (review r3, GH #244) a top-level JavaScript literal `{ \"__proto__\": Error.prototype }` stops by name where it runs",
    src: `console.log("before");\nconst o = { "__proto__": Error.prototype };\nconsole.log(o instanceof Error);`,
    fence: { text: /a `__proto__: value` entry in an object literal|objLit-proto-key/, stdout: "before\n" } },
  { id: "GH238-30 (review r3) a JavaScript binding of Error['prototype'] (bracket and template spellings) holds Error.prototype",
    src: "const a = Error[\"prototype\"];\nconst b = Error[`prototype`];\nconsole.log(typeof a, a === undefined, a === b, a === Error.prototype);" },
  { id: "GH238-31 (review r3) a run-time key read of the Error constructor stops by name where it runs",
    src: `console.log("before");\nconst k = "proto" + "type";\nconsole.log(typeof Error[k]);`,
    fence: { text: /a run-time key read of the Error constructor's members/, stdout: "before\n" } },
  { id: "GH238-32 (review r3) Object.getOwnPropertyDescriptor(Error, 'prototype') stops by name where it runs",
    src: `console.log("before");\nconsole.log(typeof Object.getOwnPropertyDescriptor(Error, "prototype"));`,
    fence: { text: /Object\.getOwnPropertyDescriptor over the Error constructor/, stdout: "before\n" } },
]);
