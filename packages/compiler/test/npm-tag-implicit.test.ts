/* A tagged template whose tag is an implicit-any JavaScript function
 * (drizzle's `sql(strings, ...params)`, with members merged onto it
 * afterwards): the strings argument is the site's own DYNAMIC array —
 * frozen, carrying its frozen `raw` array, one object per site on every
 * evaluation — so whatever the tag's body does with it (reads in and out of
 * range, aliases, stores, identity caches, writes) is Node's answer from the
 * dynamic object model (SEMANTICS.md S080). Rows run under Node and on both
 * WasmGC lanes; the unmodeled object-model surface stops by name. */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile } from "../src/index.js";
import { checkRow, nativeRun, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("npm-tag-implicit");
const pj = (o: unknown): string => JSON.stringify(o);

const TG_DTS = `export interface SQL { readonly text: string; readonly params: unknown[]; }
export declare function sql(strings: TemplateStringsArray, ...params: unknown[]): SQL;
export declare namespace sql {
  function raw(s: string): SQL;
  function empty(): SQL;
}
export declare function joined(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function rawOf(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function frozen(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function walk(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function idx(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function sw(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function oor(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function loop9(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function nullish(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function dw(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function forin(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function hoist(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function restPush(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function restSplice(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function restReassign(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function headK(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function named(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function dk(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function helper(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function stored(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function nested(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function computed(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function destr(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function ret(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function methods(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function ident(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function shadow(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function cached(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function weakCached(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function writes(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function parse(txt: string): unknown;
export declare function assigns(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function enumer(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function same(strings: TemplateStringsArray, ...params: unknown[]): string[];
export declare function frozenMore(strings: TemplateStringsArray, ...params: unknown[]): unknown;
export declare function symCopy(): string;
`;

const TG_JS = String.raw`
function sql(strings, ...params) {
  if (!(params.length > 0 || strings.length > 0 && strings[0] !== "")) return { text: "", params };
  let text = strings[0];
  for (let i = 0; i < params.length; i++) text += "$" + (i + 1) + strings[i + 1];
  return { text, params };
}
((sql2) => {
  function raw(s) { return { text: s, params: [] }; }
  sql2.raw = raw;
  function empty() { return { text: "", params: [] }; }
  sql2.empty = empty;
})(sql || (sql = {}));
export function joined(strings, ...params) {
  return strings.raw.join("|") + "#" + strings.join("|") + "#" + params.length;
}
export function rawOf(strings, ...params) {
  return JSON.stringify([strings.length, strings[0], strings.raw[0], strings.raw.length, params.length]);
}
export function frozen(strings) {
  return Object.isFrozen(strings) && Object.isFrozen(strings.raw);
}
export function walk(strings, ...params) {
  let out = "";
  for (let i = 0; i < strings.length; i++) out += "[" + strings[i] + "|" + strings.raw[i] + "]";
  for (const [k, p] of params.entries()) out += String(p) + "~" + strings[k + 1];
  return out;
}
// round 4: indexes past the end read undefined, as in Node
export function idx(strings) {
  let i = 4;
  const x = strings[i];
  return String(x ?? "d") + "|" + parseInt(strings[3]) + "|" + isNaN(strings[3]) + "|" + String(strings[2] === undefined);
}
export function sw(strings) {
  const v = strings[5];
  if (v === undefined) return "u";
  return "x";
}
export function oor(strings) {
  const out = [];
  for (const f of [() => strings[5].length, () => strings[5].toUpperCase(), () => strings[6].includes("a"), () => strings[3] !== "" && strings[3].length]) {
    try { out.push(String(f())); } catch (e) { out.push(e.constructor.name + ": " + e.message); }
  }
  return out.join("; ");
}
export function loop9(strings) {
  let o = "";
  for (let i = 0; i < 9; i++) o += strings[i];
  return o;
}
// round 3
export function nullish(strings) {
  return String(strings[7] ?? "n") + "|" + String(strings[7]?.length) + "|" + String(strings.raw[9]?.x) + "|" + strings.join(1) + "|" + strings.raw.join(true);
}
// round 5: writes to the index variable and the rest array
export function dw(strings) {
  let i = 0;
  const t = [i + 5];
  [i] = t;
  const a = strings[i];
  const o = { i: 9 };
  ({ i } = o);
  return String(a) + "|" + String(strings[i]);
}
export function forin(strings) {
  let i;
  let o = "";
  for (i of [3, 0]) o += String(strings[i]) + ",";
  for (i in { 7: 1 }) o += String(strings[i]);
  return o;
}
export function hoist(strings) {
  var i = 0;
  function bump() { i = 8; }
  let o = "";
  for (i = 0; i < strings.length; i++) { bump(); o += String(strings[i]); }
  return o;
}
export function restPush(strings, ...v) {
  let o = "";
  for (const [k] of v.entries()) { if (k === 0) v.push("x", "y"); o += String(strings[k + 1]) + ","; }
  return o;
}
export function restSplice(strings, ...v) {
  let o = "";
  for (let k = 0; k < v.length; k++) { if (k === 0) { v.unshift("a"); v.splice(1, 0, "b"); } o += String(strings[k + 1]) + ","; }
  return o;
}
export function restReassign(strings, ...v) {
  v = [1, 2, 3, 4];
  let o = "";
  for (let k = 0; k < v.length; k++) o += String(strings[k + 1]) + ",";
  v.length = 1;
  for (const [k] of v.entries()) o += String(strings[k + 1] ?? "e");
  return o;
}
export function headK(strings, ...v) {
  let o = "";
  for (let [k, p] of v.entries()) { k = k + 5; o += String(strings[k + 1]) + String(p); }
  return o;
}
export function named(s, a, ...rest) {
  let o = s[0];
  for (const [k] of rest.entries()) o += String(s[k + 1]);
  return o + "|" + String(a);
}
export function dk(strings, ...rest) {
  let o = strings[0];
  for (const [k] of rest.entries()) o += String(strings[k + 1] ?? "d");
  return o;
}
export function parse(txt) { return JSON.parse(txt); }
// rounds 1 and 2: aliases, stores, callbacks, identity
function inner(s) { return s.raw[0]; }
export function helper(strings, ...v) { return inner(strings, ...v); }
let saved;
export function stored(strings) { saved = strings; return saved.length + ":" + saved.raw[1]; }
export function nested(strings) { const f = () => strings.raw[0]; return f(); }
export function computed(strings) { const k = "raw"; return strings["raw"][0] + "," + strings[k][1]; }
export function destr(strings) { const { raw, length } = strings; return raw[0] + "," + length; }
export function ret(strings) { return strings; }
export function methods(strings) {
  const c = strings.concat(["q"]);
  c.push("r");
  return strings.at(-1) + "|" + c.length + c.join() + "|" + strings.map((x, i, a) => a.raw[i]).join() + "|" + strings.slice(1).join();
}
let prev;
export function ident(strings) { const same = prev === strings; prev = strings; return same; }
export function shadow(strings) { const Object = { isFrozen: () => "fake" }; return Object.isFrozen(strings); }
const cache = new Map();
export function cached(strings, ...v) {
  let c = cache.get(strings);
  if (c === undefined) { c = { n: 0, text: strings.join("?") }; cache.set(strings, c); }
  c.n++;
  return c.text + ":" + c.n + ":" + cache.size;
}
const weak = new WeakMap();
export function weakCached(strings) {
  const hit = weak.has(strings);
  if (!hit) weak.set(strings, strings.raw.join("/"));
  return hit + ":" + weak.get(strings);
}
// writes: a frozen array (strict module code throws)
export function writes(strings) {
  const out = [];
  const tries = [
    () => { strings[0] = "x"; }, () => { strings[5] = "x"; }, () => { strings.length = 0; }, () => { strings.foo = 1; },
    () => { strings.raw = []; }, () => { strings.raw[0] = "z"; }, () => strings.push("a"), () => strings.push(), () => strings.pop(),
    () => strings.raw.push("q"),
  ];
  for (const f of tries) {
    try { f(); out.push("ok"); } catch (e) { out.push(e.constructor.name + ": " + e.message); }
  }
  out.push(String([Object.isFrozen(strings), Object.isSealed(strings), Object.isExtensible(strings), Object.isFrozen(strings.raw), Object.isExtensible(strings.raw)]));
  out.push(String([Object.freeze(strings) === strings, "raw" in strings, "raw" in strings.raw, Object.hasOwn(strings, "raw"), Object.hasOwn(strings.raw, "raw"), strings.raw.raw, Array.isArray(strings), strings[0]]));
  return out.join("\n");
}
// review: Object.assign onto the frozen arrays, and their enumerability
function kv(k, v) { const o = {}; o[k] = v; return o; }
export function assigns(strings) {
  const out = [];
  let calls = 0;
  const tries = [
    () => Object.assign(strings, { get g1() { calls++; return 1; }, get g2() { calls++; return 2; } }),
    () => Object.assign(strings, kv(0, "x")), () => Object.assign(strings, { foo: 1 }), () => Object.assign(strings.raw, kv(0, "x")),
    () => Object.assign(strings, "q"), () => Object.assign(strings, {}) === strings, () => Object.assign(strings, null) === strings,
    () => Object.assign(strings, []) === strings, () => JSON.stringify(Object.assign({}, strings)), () => JSON.stringify(Object.assign({}, strings.raw)),
  ];
  for (const f of tries) {
    try { out.push(String(f())); } catch (e) { out.push(e.constructor.name + ": " + e.message); }
  }
  return out.join("\n") + "\n" + strings[0] + strings.raw[0] + Object.keys(strings) + " getters run: " + calls;
}
export function enumer(strings) {
  let o = "";
  for (const k in strings) o += k + "+";
  return String([strings.propertyIsEnumerable("raw"), strings.propertyIsEnumerable("0"), strings.propertyIsEnumerable("length"), strings.raw.propertyIsEnumerable("raw"),
    strings.raw.propertyIsEnumerable(0), strings.hasOwnProperty("raw"), Object.keys(strings).join("+"), o]);
}
export function same(strings) { return strings; }
// review 2: symbol-keyed and other sources, length/pop/for-in writes, the arrays' own listings
function symSrc(desc, more) { const o = {}; if (more) o.a = 1; o[Symbol(desc)] = 1; return o; }
export function frozenMore(strings) {
  const out = [];
  for (const a of [strings, strings.raw]) {
    const tries = [
      () => Object.assign(a, symSrc("s")), () => Object.assign(a, symSrc("t", true)),
      () => { a.length = 5; }, () => a.pop(), () => { for (const k in { 0: 1, q: 2 }) a[k] = "w"; },
      () => Object.assign(a, 5) === a, () => Object.assign(a, true) === a, () => Object.assign(a, "xy"), () => Object.assign(a, "") === a,
      () => Object.assign(a, { length: 0 }), () => Object.assign(a, { raw: [] }),
      () => JSON.stringify(a), () => JSON.stringify([...a]), () => Object.keys(a).join("+"), () => { a[Symbol("w")] = 1; },
    ];
    for (const f of tries) {
      try { out.push(String(f())); } catch (e) { out.push(e.constructor.name + ": " + e.message); }
    }
  }
  return out.join("\n") + "\n" + strings.join() + "|" + strings.raw.join() + "|" + strings.length + "|" + strings.raw.length;
}
export function symCopy() {
  const s = Symbol("k");
  const src = { a: 1 };
  src[s] = 2;
  const t = Object.assign({}, src);
  return [Object.keys(t).join(), Object.getOwnPropertySymbols(t).length, t[s], Object.getOwnPropertySymbols(t)[0] === s].join("|");
}
export { sql };
`;

const TG: Record<string, string> = {
  "node_modules/tg/package.json": pj({ name: "tg", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/tg/index.d.ts": TG_DTS,
  "node_modules/tg/index.js": TG_JS,
  "package.json": pj({ type: "module" }),
  "tsconfig.json": pj({ compilerOptions: { strict: true, module: "nodenext", skipLibCheck: true, noEmit: true } }),
};

const ROWS: Row[] = [
  {
    id: "TAG-01 drizzle's sql tag (members merged onto it): mixed substitutions, a nested tag result, zero substitutions",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { sql } from "tg";`,
      `const id = 7;`,
      `const name = "ann";`,
      `const inner = sql\`now()\`;`,
      `const q = sql\`select * from t where id = \${id} and name = \${name} and at > \${inner}\`;`,
      `console.log(q.text, JSON.stringify(q.params));`,
      `const z = sql\`select 1\`;`,
      `console.log(z.text, z.params.length);`,
    ].join("\n") },
  },
  {
    id: "TAG-02 .raw.join, and a template whose source has CRLF line breaks (raw normalised to LF, as Node does)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": "import { joined, rawOf } from \"tg\";\nconsole.log(joined`a\\n${1}b\\t${2}c`);\nconsole.log(rawOf`x\r\ny`);\nconsole.log(joined``);" },
  },
  {
    id: "TAG-03 .raw carries the raw spans (escapes cooked versus raw, \\u sequences); both arrays are frozen",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { rawOf, frozen } from "tg";`,
      `console.log(rawOf\`a\\nb\${1}c\`);`,
      `console.log(rawOf\`\\u0041\\u{1F600}\\t\`);`,
      `console.log(frozen\`x\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-04 a for loop bounded by the array's length, and drizzle's rest index + 1 over params.entries()",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { walk } from "tg";`,
      `console.log(walk\`a\\n\${1}b\${"x"}c\`);`,
      `console.log(walk\`only\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-05 indexes past the end read undefined (round 4): a variable index with ??, parseInt/isNaN, a test against undefined, member reads that throw, a loop bounded by 9",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { idx, sw, oor, loop9 } from "tg";`,
      `console.log(idx\`y\${1}z\`);`,
      `console.log(sw\`y\${1}z\`);`,
      `console.log(oor\`y\${1}z\`);`,
      `console.log(loop9\`y\${1}z\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-06 ?? and ?. over out-of-range elements, join with a number or boolean separator (round 3)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { nullish } from "tg";`,
      `console.log(nullish\`a\${1}b\${2}c\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-07 the index variable written by destructuring, by for-of/for-in targets, and by a hoisted function (round 5)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { dw, forin, hoist } from "tg";`,
      `console.log(dw\`y\${1}z\`);`,
      `console.log(forin\`a\${1}b\${2}c\${3}d\`);`,
      `console.log(hoist\`y\${1}z\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-08 the rest array pushed, unshifted, spliced, reassigned and shortened around the loop; a reassigned `let [k, p]` head (round 5)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { restPush, restSplice, restReassign, headK } from "tg";`,
      `console.log(restPush\`a\${1}b\${2}c\`);`,
      `console.log(restSplice\`a\${1}b\${2}c\`);`,
      `console.log(restReassign\`a\${1}b\`);`,
      `console.log(headK\`a\${1}b\${2}c\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-09 a named parameter before the rest; the tag called directly with a plain array (Node's undefined elements); an unrelated implicit-any function called directly (round 5)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { named, dk, parse } from "tg";`,
      `console.log(named\`a\${1}b\${2}c\${3}d\`);`,
      `console.log(dk\`q\${1}r\${2}s\`);`,
      `console.log(dk(["q"] as unknown as TemplateStringsArray, 1, 2));`,
      `console.log(parse("[1,2,3]"));`,
    ].join("\n") },
  },
  {
    id: "TAG-10 the strings array forwarded to a helper, stored in a module variable, read in a nested function, through computed and destructured reads, returned (rounds 1 and 2)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { helper, stored, nested, computed, destr, ret } from "tg";`,
      `console.log(helper\`a\\t\${1}b\`, stored\`a\${1}b\`, nested\`c\\n\`, computed\`d\${1}e\`, destr\`f\\x41\`);`,
      `const r = ret\`g\${1}h\`;`,
      `console.log(r, Array.isArray(r), (r as string[]).length);`,
    ].join("\n") },
  },
  {
    id: "TAG-11 concat, at, slice and a map callback reading its array argument's raw (rounds 1 and 2)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { methods } from "tg";`,
      `console.log(methods\`a\\n\${1}b\${2}c\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-12 identity: one array per site on every evaluation, distinct between sites; a Map and a WeakMap cache keyed by it; a shadowed Object (rounds 1 and 2)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { ident, cached, weakCached, shadow } from "tg";`,
      `for (let i = 0; i < 3; i++) console.log(ident\`s\${i}t\`, cached\`u\${i}v\`, weakCached\`w\${i}\`);`,
      `console.log(ident\`s\${0}t\`, cached\`u\${0}v\`, weakCached\`w\${0}\`, shadow\`x\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-13 writes into the frozen arrays throw Node's TypeErrors (an element, past the end, length, a new key, raw, raw's element, push, pop); the integrity answers, `in`, Object.hasOwn",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { writes } from "tg";`,
      `console.log(writes\`a\${1}b\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-21 TypeScript's writes through a returned strings array held as any (number, variable and string indexes, past the end, raw's element, a loop, an any[] binding, length) throw Node's TypeErrors",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { ret } from "tg";`,
      `const a = ret\`a\${1}b\` as any;`,
      `const b: any[] = ret\`c\${2}d\` as any;`,
      `const tries: (() => void)[] = [`,
      `  () => { a[0] = "y"; }, () => { a[1] = "y"; }, () => { a.raw[0] = "y"; }, () => { a[5] = "y"; }, () => { a.raw[3] = "y"; },`,
      `  () => { const i = 1; a[i] = "z"; }, () => { a["0"] = "w"; },`,
      `  () => { for (let i = 0; i < 2; i++) a[i] = "l"; }, () => { b[0] = 1; }, () => { b.length = 0; },`,
      `];`,
      `for (const f of tries) {`,
      `  try { f(); console.log("ok"); } catch (e) { console.log((e as Error).name + ": " + (e as Error).message); }`,
      `}`,
      `console.log(a[0], a[1], a.raw[0], a.length, b[0], b.length);`,
    ].join("\n") },
  },
  {
    id: "TAG-22 Object.assign onto the frozen arrays (an element key, a new key, raw's element, a string source, a source of getters read once) throws Node's TypeErrors; empty and nullish sources copy nothing; the arrays as sources copy their elements, not raw",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { assigns, ret } from "tg";`,
      `console.log(assigns\`a\${1}b\`);`,
      `const a = ret\`e\${1}f\` as any;`,
      `try { Object.assign(a, { z: 1 }); console.log("ok"); } catch (e) { console.log((e as Error).message); }`,
      `console.log(a[1]);`,
    ].join("\n") },
  },
  {
    id: "TAG-23 raw is the strings array's own non-enumerable member (propertyIsEnumerable, for-in, Object.keys); the island tag of unit A2 answers the same",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { enumer } from "tg";`,
      `console.log(enumer\`a\${1}b\`);`,
      `const isl: any = (s: any, ...v: unknown[]): string => String([s.propertyIsEnumerable("raw"), s.propertyIsEnumerable("0"), s.raw.propertyIsEnumerable("raw")]);`,
      `console.log(isl\`x\${1}y\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-24 a strings array returned into a typed string[] slot and only read (join, length, an element)",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { same } from "tg";`,
      `const r = same\`a\${1}b\`;`,
      `console.log(r.join("|"), r.length, r[1]);`,
    ].join("\n") },
  },
  {
    id: "TAG-25 a strings array returned into a typed string[] slot (the binding takes S125's dynamic arm, sharing the frozen array) and written: Node's TypeError, the element unchanged",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { same } from "tg";`,
      `const r = same\`a\${1}b\`;`,
      `try { r[0] = "x"; } catch (e) { console.log((e as Error).message); }`,
      `console.log(r[0]);`,
    ].join("\n") },
  },
  {
    id: "TAG-27 Object.assign onto the frozen arrays from a symbol-keyed source (Node's TypeError names the symbol), a source whose string key comes before its symbol, number, boolean, string, empty-string, {length} and {raw} sources; length, pop and for-in writes; JSON, spread, Object.keys and a symbol-keyed write",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { frozenMore } from "tg";`,
      `console.log(frozenMore\`a\${1}b\`);`,
    ].join("\n") },
  },
  {
    id: "TAG-28 Object.assign onto a plain object copies a source's own enumerable symbol-keyed member",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": `import { symCopy } from "tg";\nconsole.log(symCopy());` },
  },
  {
    id: "TAG-29 TypeScript writes a returned strings array (and its raw) through an any parameter, sets its length, pops it and Object.assigns a symbol-keyed source onto it: Node's TypeErrors",
    npmStatic: ["tg"],
    files: { ...TG, "main.ts": [
      `import { ret } from "tg";`,
      `const a = ret\`a\${1}b\` as any;`,
      `const w = (x: any): void => { x[0] = "p"; };`,
      `const wk = (x: any): void => { x.q = "p"; };`,
      `const so: any = {};`,
      `so[Symbol("s")] = 1;`,
      `const tries: (() => unknown)[] = [() => w(a), () => w(a.raw), () => wk(a), () => wk(a.raw), () => { a.length = 5; }, () => a.pop(), () => Object.assign(a, so), () => Object.assign(a.raw, so)];`,
      `for (const f of tries) {`,
      `  try { f(); console.log("ok"); } catch (e) { console.log((e as Error).name + ": " + (e as Error).message); }`,
      `}`,
      `console.log(a.join(), a.raw.join(), a.length, JSON.stringify(a), JSON.stringify([...a]), Object.keys(a).join());`,
    ].join("\n") },
  },
];

describe("implicit-any JavaScript tags (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  }, 600_000);
});

describe("implicit-any JavaScript tags (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

function writeProject(files: Record<string, string>, tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`));
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), src);
  }
  return dir;
}

describe("implicit-any JavaScript tags: an invalid escape (cooked undefined) refuses by name", () => {
  test("TAG-14 an invalid escape in a tagged template", async () => {
    const dir = writeProject({ ...TG, "main.ts": `import { rawOf } from "tg";\nconsole.log(rawOf\`\\unicode\`);` }, "tag14");
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["tg"] });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(/invalid escape sequences/);
  }, 600_000);
});

describe("implicit-any JavaScript tags: a strings array checked into a typed field or element and written through it refuses by name (S125 (c))", () => {
  test("TAG-26 a typed record field and an array element holding a returned strings array, written", async () => {
    const dir = writeProject({ ...TG, "main.ts": [
      `import { same } from "tg";`,
      `const h: { r: string[] } = { r: same\`c\${1}d\` };`,
      `try { h.r[0] = "x"; } catch (e) { console.log((e as Error).message); }`,
      `const xs: string[][] = [same\`e\${1}f\`];`,
      `try { xs[0]![0] = "x"; } catch (e) { console.log((e as Error).message); }`,
      `console.log(h.r[0], xs[0]![0]);`,
    ].join("\n") }, "tag26");
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["tg"] });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(/checked into 'string\[\]': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy's type/);
  }, 600_000);
});

describe("implicit-any JavaScript tags: the frozen arrays' unmodeled object-model surface stops by name at run time", () => {
  test.for([
    ["TAG-15 sort", "return strings.sort().join();", /'Array\.prototype\.sort' on a tagged template's frozen strings array is not supported yet/],
    ["TAG-16 Object.getOwnPropertyNames", "return Object.getOwnPropertyNames(strings).join();", /Object\.getOwnPropertyNames \(or Reflect\.ownKeys\) on a tagged template's frozen strings array is not supported yet/],
    ["TAG-17 Object.getOwnPropertyDescriptor", "return JSON.stringify(Object.getOwnPropertyDescriptor(strings, \"0\"));", /Object\.getOwnPropertyDescriptor on a tagged template's frozen strings array is not supported yet/],
    ["TAG-18 Object.defineProperty", "Object.defineProperty(strings, \"k\", { value: 1 }); return \"no\";", /Object\.defineProperty on a tagged template's frozen strings array is not supported yet/],
    ["TAG-20 a switch over an element (a switch on a JavaScript dynamic value)", "switch (strings[5]) { case undefined: return \"u\"; default: return \"x\"; }", /switch statements on 'unknown' values/],
    ["TAG-19 arithmetic over an element (a JavaScript dynamic operand of `+ 1` is checked to a number)", "return String(strings[1] + 1);", /expected number/],
    ["TAG-34 Object.assign from a Map onto the array (a typed Map source has no Object.assign lowering)", "return String(Object.assign(strings, new Map([[\"k\", 1]])) === strings);", /'Object\.assign' is part of the standard library types but has no scriptc lowering yet/],
  ] as const)("%s", async ([, body, re]) => {
    const dir = writeProject({
      ...TG,
      "node_modules/tg/index.js": `${TG_JS}\nexport function bad(strings) { ${body} }\n`,
      "node_modules/tg/index.d.ts": `${TG_DTS}\nexport declare function bad(strings: TemplateStringsArray, ...v: unknown[]): unknown;\n`,
      "main.ts": `import { bad } from "tg";\nconsole.log("before");\nconsole.log(bad\`y\${1}z\`);`,
    }, "tagx");
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["tg"] });
    if (!res.ok) throw new Error(`refused at compile time: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
    const got = await nativeRun(res.binaryPath!, []);
    expect(got.stdout, got.stderr).toBe("before\n");
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(re);
  }, 600_000);
});

describe("implicit-any JavaScript tags: the frozen arrays' other mutating methods called from TypeScript stop by name at run time", () => {
  test.for([
    ["TAG-30 copyWithin on the array held as any", "a.copyWithin(0, 1)", /'Array\.prototype\.copyWithin' on a tagged template's frozen strings array is not supported yet/],
    ["TAG-31 splice on its raw", "a.raw.splice(0, 1)", /'Array\.prototype\.splice' on a tagged template's frozen strings array is not supported yet/],
    ["TAG-32 shift through a typed string[] binding", "r.shift()", /'Array\.prototype\.shift' on a tagged template's frozen strings array is not supported yet/],
    ["TAG-33 unshift on the array held as any", "a.unshift(\"x\")", /'Array\.prototype\.unshift' on a tagged template's frozen strings array is not supported yet/],
  ] as const)("%s", async ([, expr, re]) => {
    const dir = writeProject({ ...TG, "main.ts": [
      `import { ret, same } from "tg";`,
      `const a = ret\`a\${1}b\` as any;`,
      `const r = same\`c\${1}d\`;`,
      `console.log("before");`,
      `try { console.log(String(${expr})); } catch (e) { console.log((e as Error).message); }`,
      `console.log(a.join(), r.join());`,
    ].join("\n") }, "tagts");
    const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", npmStatic: ["tg"] });
    if (!res.ok) throw new Error(`refused at compile time: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
    const got = await nativeRun(res.binaryPath!, []);
    expect(got.stdout, got.stderr).toBe("before\n");
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(re);
  }, 600_000);
});
