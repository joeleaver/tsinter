/* Symbol-keyed properties on dynamic values (WasmGC lanes; step A of the
 * symbol-keys unit). A symbol crosses into a dynamic value as itself
 * (typeof "symbol", identity), and a symbol-keyed property is stored under
 * the symbol's reserved string key: string-key listings (Object.keys,
 * JSON, for-in) skip it, while Object.assign, rest, spread,
 * Object.getOwnPropertySymbols and inspect show it after the string keys,
 * as Node orders them. A program string key spelled with the reserved
 * prefix stops by name. Converting a symbol to a string (String(sym),
 * sym.toString(), a template) stays a named stop. The shapes follow
 * stream-chain's defs.js. Every
 * row runs on the wasm and wasm-native lanes against Node. */
import { defineRows } from "./u3u4-rows.js";

const STREAM_DEFS = `'use strict';
const none = Symbol.for('object-stream.none');
const finalSymbol = Symbol.for('object-stream.final');
const manySymbol = Symbol.for('object-stream.many');
const flushSymbol = Symbol.for('object-stream.flush');
const fListSymbol = Symbol.for('object-stream.fList');
const finalValue = value => ({[finalSymbol]: 1, value});
const many = values => ({[manySymbol]: 1, values});
const isFinalValue = o => o && o[finalSymbol] === 1;
const isMany = o => o && o[manySymbol] === 1;
const isFlushable = o => o && o[flushSymbol] === 1;
const isFunctionList = o => o && o[fListSymbol] === 1;
const flushable = (write, final = null) => {
  const fn = final ? value => (value === none ? final() : write(value)) : write;
  fn[flushSymbol] = 1;
  return fn;
};
const setFunctionList = (o, fns) => { o.fList = fns; o[fListSymbol] = 1; return o; };
const clearFunctionList = o => { delete o.fList; delete o[fListSymbol]; return o; };
const normalizeMany = o => {
  if (o?.[manySymbol] === 1) { switch (o.values.length) { case 0: return none; case 1: return o.values[0]; } }
  return o;
};`;

defineRows("symbol-keyed properties on dynamic values", [
  {
    id: "SYMK-01 stream-chain's defs: symbol-keyed literals, reads, optional reads, a function's symbol member, write and delete",
    src: `${STREAM_DEFS}
const m = many([1, 2]);
console.log(isMany(m), isFinalValue(m), isMany({}), isMany(null), isFinalValue(finalValue(3)), m.values, normalizeMany(many([7])), normalizeMany(many([])) === none);
const f = flushable(x => x * 2);
console.log(isFlushable(f), f(4), isFlushable(x => x));
const o = setFunctionList({}, [1]);
console.log(isFunctionList(o), Object.keys(o));
clearFunctionList(o);
console.log(isFunctionList(o), Object.keys(o), fListSymbol in o);`,
  },
  {
    id: "SYMK-02 listings: keys, JSON and for-in skip a symbol key; getOwnPropertySymbols, assign and inspect show it after the string keys",
    src: `const s = Symbol.for('k');
const t = Symbol('local');
/** @type {any} */
const o = {[s]: 1, a: 2, [t]: 3, b: 4};
console.log(Object.keys(o), JSON.stringify(o));
for (const k in o) console.log('key', k);
const syms = Object.getOwnPropertySymbols(o);
console.log(syms.length, syms[0] === s, syms[1] === t, syms);
const c = Object.assign({}, o);
console.log(c[s], c[t], Object.keys(c));
console.log(o);`,
  },
  {
    // An object rest over a dynamic source is not lowered yet (a gap that
    // predates symbol keys): pinned at its named stop.
    id: "SYMK-02c an object rest over the same dynamic object stops by name",
    src: `const s = Symbol.for('k');
/** @type {any} */
const o = {[s]: 1, a: 2, b: 4};
console.log(o[s]);
const { a, ...rest } = o;
console.log(a, rest[s], Object.keys(rest));`,
    fence: { text: /rest elements over checked-dynamic sources/, stdout: "1\n" },
  },
  {
    // The same program as real code writes it (no JSDoc `any` on the
    // literal): the checker types the Object.assign copy and the rest
    // binding as static records, which hold no symbol-keyed storage, so
    // their symbol reads stop by name (pinned until they lower).
    id: "SYMK-02b the same listings without a JSDoc annotation: the copies' symbol reads stop by name",
    src: `const s = Symbol.for('k');
const t = Symbol('local');
const o = {[s]: 1, a: 2, [t]: 3, b: 4};
console.log(Object.keys(o), JSON.stringify(o));
for (const k in o) console.log('key', k);
const syms = Object.getOwnPropertySymbols(o);
console.log(syms.length, syms[0] === s, syms[1] === t, syms);
const c = Object.assign({}, o);
console.log(c[s], c[t], Object.keys(c));
const { a, ...rest } = o;
console.log(a, rest[s], rest[t], Object.keys(rest));
console.log(o);`,
    fence: {
      text: /symbol-keyed property access outside class fields/,
      stdout: `[ 'a', 'b' ] {"a":2,"b":4}\nkey a\nkey b\n2 true true [ Symbol(k), Symbol(local) ]\n`,
    },
  },
  {
    id: "SYMK-03 a symbol held in a dynamic value: typeof, identity, description, as a sentinel",
    src: `const none = Symbol.for('object-stream.none');
/** @param {any} v */
const show = (v) => console.log(typeof v, v === none, v === Symbol.for('object-stream.none'), v.description, v);
show(none);
show(Symbol('x'));
/** @type {any[]} */
const arr = [1, 'a'];
arr.push(none);
console.log(arr.indexOf(none), arr.includes(none), arr);`,
  },
  {
    // A mixed literal holding a symbol (`[1, none, 'a']`: a union with a
    // symbol arm, which no dynamic conversion takes yet): pinned at its
    // named stop.
    id: "SYMK-03b a symbol inside a mixed array literal stops by name",
    src: `const none = Symbol.for('object-stream.none');
console.log(typeof none);
/** @type {any[]} */
const arr = [1, none, 'a'];
console.log(arr.indexOf(none), arr);`,
    fence: { text: /converting typed values to 'unknown'/, stdout: "symbol\n" },
  },
  {
    id: "SYMK-04 a dependency module keys by a symbol; the entry's runtime string key spelled with the reserved prefix stops by name",
    entry: "main.mjs",
    files: { "dep.mjs": `export const tag = Symbol.for('dep.tag');
export const make = (v) => ({ [tag]: 1, v });` },
    src: `import { make, tag } from './dep.mjs';
const o = make(5);
console.log(o[tag], o.v);
const k = String.fromCharCode(0xd800) + '@@' + 'x';
o[k] = 1;
console.log('unreached', Object.keys(o));`,
    fence: { text: /a property key beginning with U\+D800 '@@'/, stdout: "1 5\n" },
  },
  /* The review's routes into the object store: every one stops by name. */
  {
    id: "SYMK-05 JSON.parse of a key spelled like a symbol's reserved key stops by name (no aliasing)",
    src: `const s = Symbol('a');
console.log(typeof s);
const text = '{"' + String.fromCharCode(0xd800) + '@@#\\\\u0000\\\\u0000": 5}';
const p = JSON.parse(text);
console.log(Object.keys(p).length);`,
    fence: { text: /a property key beginning with U\+D800 '@@'/, stdout: "symbol\n" },
  },
  {
    id: "SYMK-06 Object.defineProperty with a runtime reserved key stops by name",
    src: `const s = Symbol('a');
const o = { [s]: 1 };
console.log(o[s]);
const k = String.fromCharCode(0xd800, 64, 64, 35, 0, 0);
Object.defineProperty(o, k, { value: 9, enumerable: true });
console.log(o[s]);`,
    fence: { text: /a property key beginning with U\+D800 '@@'/, stdout: "1\n" },
  },
  {
    id: "SYMK-07 Object.getOwnPropertyDescriptor with a runtime reserved key stops by name",
    src: `const s = Symbol('a');
const o = { [s]: 1 };
console.log(o[s]);
const k = String.fromCharCode(0xd800, 64, 64, 35, 0, 0);
console.log(Object.getOwnPropertyDescriptor(o, k));`,
    fence: { text: /a property key beginning with U\+D800 '@@'/, stdout: "1\n" },
  },
  {
    id: "SYMK-08 a string-literal object key spelled with the reserved prefix refuses at compile time",
    src: `const o = { '\\uD800@@#ab': 1 };
console.log(Object.keys(o).length);`,
    refused: /a string literal beginning with U\+D800 '@@'/,
  },
  {
    id: "SYMK-09 getOwnPropertySymbols over a non-enumerable symbol key stops by name; enumerable ones list",
    src: `const s = Symbol('e');
const h = Symbol('h');
const o = { [s]: 1 };
console.log(Object.getOwnPropertySymbols(o).length);
Object.defineProperty(o, h, { value: 2, enumerable: false });
console.log(o[h], Object.keys(o).length);
console.log(Object.getOwnPropertySymbols(o).length);`,
    fence: { text: /Object\.getOwnPropertySymbols over an object with a non-enumerable symbol-keyed property/, stdout: "1\n2 0\n" },
  },
  {
    id: "SYMK-10 a named function expression keeps its own name once it crosses into a dynamic value and carries a symbol member",
    src: `const tag = Symbol.for('tag');
const fn = function named(x) { return x * 2; };
const arrow = (x) => x;
/** @param {any} f */
const mark = (f, v) => { f[tag] = v; return f; };
const a = mark(fn, 1);
const b = mark(arrow, 2);
console.log(a.name, a[tag], a(3), b.name, b[tag]);`,
  },
  {
    id: "SYMK-11 a key that only starts with a lone surrogate is an ordinary string key",
    src: `const s = Symbol('a');
const o = { [s]: 1 };
const k = '\\uD800abc';
o[k] = 2;
console.log(k in o, o[k], Object.keys(o).length, Object.getOwnPropertyNames(o).length, Object.getOwnPropertySymbols(o).length);
Object.defineProperty(o, '\\uD800x', { value: 3, enumerable: false });
console.log('\\uD800x' in o, Object.getOwnPropertyNames(o).length);`,
  },
  {
    id: "SYMK-SW a switch over a dynamic value: all-number and all-string literal cases, other kinds take the default",
    src: `/** @param {any} v */
const n = (v) => { switch (v) { case 0: return 'zero'; case 1: return 'one'; default: return 'other'; } };
/** @param {any} v */
const t = (v) => { switch (v) { case 'a': return 'A'; case 'b': return 'B'; default: return '?'; } };
console.log(n(0), n(1), n('1'), n(null), n([1].length), t('a'), t('b'), t(0), t(undefined));`,
  },
]);
