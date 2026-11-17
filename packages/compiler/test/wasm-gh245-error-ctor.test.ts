/* GH #245 (SEMANTICS.md S149's GH #245 amendment): the own properties of
 * the Error-family constructor values. `name` and `length` answer Node's
 * values; the other own-property questions (hasOwnProperty,
 * propertyIsEnumerable, `in`, Object.assign / getOwnPropertySymbols and
 * the other reflection statics over one) stop by name. They read silently
 * wrong before (undefined, 15, false, no keys) or crashed the compiler. */
import { defineRows } from "./u3u4-rows.js";

const main = `import { t } from "./z.js";\nconsole.log(t());`;
const row = (id: string, body: string, extra: object = {}) => ({ id, entry: "main.ts", src: main, files: { "z.js": body }, ...extra });
const stop = (rx: RegExp) => ({ fence: { text: rx, stdout: "before\n" } });

defineRows("GH #245 Error constructor own properties", [
  row("GH245-01 the issue's repro: name and length of the Error-family constructors", `export function t() {
  return [Error.name, Error.length, TypeError.name, TypeError.length, RangeError.name, SyntaxError.length, ReferenceError.name, URIError.name, EvalError.length, AggregateError.name, AggregateError.length, typeof Error.name].join(",");
}`),
  { id: "GH245-02 name and length in TypeScript", entry: "main.ts",
    src: `const n: string = Error.name;\nconsole.log(n, Error.length, TypeError.name.toUpperCase(), (RangeError).length + 1);` },
  row("GH245-03 Error.hasOwnProperty('prototype') stops by name", `export function t() {
  console.log("before");
  return Error.hasOwnProperty("prototype");
}`, stop(/Error\.hasOwnProperty\(…\)/)),
  row("GH245-04 own keys `in` an Error-family constructor answer true (zod's module-load `\"captureStackTrace\" in Error`)", `export function t() {
  return ["prototype" in Error, "captureStackTrace" in Error, "stackTraceLimit" in TypeError, "name" in RangeError, "length" in SyntaxError].join(",");
}`),
  row("GH245-04b another key `in` Error stops by name", `export function t() {
  console.log("before");
  return "prepareStackTrace" in Error;
}`, stop(/'in' on the Error constructor for a key other than/)),
  row("GH245-05 Object.assign({}, Error) stops by name", `export function t() {
  console.log("before");
  const o = Object.assign({}, Error);
  return typeof o;
}`, stop(/Object\.assign over the Error constructor/)),
  row("GH245-06 Object.getOwnPropertySymbols(Error) stops by name (it crashed the compiler)", `export function t() {
  console.log("before");
  return Object.getOwnPropertySymbols(Error).length;
}`, stop(/Object\.getOwnPropertySymbols over the Error constructor/)),
  row("GH245-07 zod 4.6.7's module-load lines run as Node: `let _E = \"captureStackTrace\" in Error ? Error : null` and util's captureStackTrace binding (defined, not called)", `let _E = "captureStackTrace" in Error ? Error : null;
const captureStackTrace = ("captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => { });
export function t() {
  return ["captureStackTrace" in Error, "ok"].join(",");
}`),
  row("GH245-08 (review) the bracket and optional spellings: Error['name'], Error?.name, TypeError['length'], Error?.length", `export function t() {
  return [Error["name"], Error?.name, TypeError["length"], Error?.length, RangeError[\`name\`]].join(",");
}`),
  row("GH245-09 (review) globalThis.Error.name stops by name (it read undefined)", `export function t() {
  console.log("before");
  return globalThis.Error.name;
}`, stop(/Error\.name read through the global object/)),
  row("GH245-10 (review) globalThis.TypeError.length stops by name", `export function t() {
  console.log("before");
  return globalThis.TypeError.length;
}`, stop(/TypeError\.length read through the global object/)),
  row("GH245-11 (review) Error.toString() stops by name (it threw a catchable 'not a function')", `export function t() {
  console.log("before");
  return Error.toString().slice(0, 16);
}`, stop(/Error\.toString\(…\)/)),
  row("GH245-12 (review) Error.captureStackTrace on a plain JavaScript object builds (it was an internal compiler error at the later typeof o.stack) and stops by name where it runs (its own stack property has no slot)", `export function t() {
  const o = {};
  console.log("before");
  Error.captureStackTrace(o);
  return typeof o.stack;
}`, stop(/Object\.defineProperty on a typed value shared into a dynamic slot/)),
  row("GH245-13 (review) typeof of an absent member of a JavaScript literal is 'undefined' (it was an internal compiler error)", `export function t() {
  const o = {};
  const p = { a: 1 };
  return [typeof o.stack, typeof p.zz, typeof p.a].join(",");
}`),
  row("GH245-14 a key on nothing in the constructor's chain answers false, as before (U34B-ERR-01's `\"nope\" in Error`)", `export function t() {
  return ["nope" in Error, "zz" in Error, "message" in Error].join(",");
}`),
  row("GH245-15 an inherited Function.prototype / Object.prototype name `in` Error stops by name", `export function t() {
  console.log("before");
  return ["call" in Error, "hasOwnProperty" in TypeError].join(",");
}`, stop(/'in' on the (Error|TypeError) constructor for a key other than/)),
]);
