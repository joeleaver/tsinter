/* The island's util.inspect (Node's lib/internal/util/inspect.js, ported
 * into the shared web prelude — SEMANTICS.md S108 (a), S114) against Node,
 * live: a matrix of island programs printing values through console.log,
 * the format specifiers, console.dir under every inspect option,
 * console.table, errors, proxies, promises, class instances, null
 * prototypes, circular structures, holes, truncation and line breaking.
 *
 * Every row runs on every lane — the c and llvm lanes' island and the
 * wasm lane's engine — and must print the SAME bytes on all of them
 * (stdout and stderr, engine stack frames included: the engines are one
 * quickjs-ng and the eval names one file). Against Node the rows compare
 * byte for byte with the engine's stack-frame lines set aside (S114: a
 * frame names the engine's functions and positions, not V8's — the lines
 * starting `    at `, and the frame-derived "... N lines matching cause
 * stack trace ..." summary). Rows marked `residue` are S114's registered
 * differences: lane-identical, and their Node difference is asserted to
 * be exactly the one registered.
 *
 * The fence rows (what the island cannot preview, the Node globals and
 * locale methods it lacks) have no Node oracle; their named errors are
 * stated here, identical on every lane.
 *
 * SCRIPTC_SAN=1 runs the native lanes only (sanitizing is a native
 * concept). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";
import { runWasm } from "../../packages/compiler/test/wasm-host.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

type Lane = "c" | "llvm" | "wasm";
const lanes: Lane[] = sanitize ? ["c", "llvm"] : ["c", "llvm", "wasm"];

interface Out { stdout: string; stderr: string; exitCode: number }

/** Builds `__island_eval(<js>)` on a lane and runs it. */
async function runIsland(lane: Lane, name: string, js: string): Promise<Out> {
  const source = `__island_eval(${JSON.stringify(js)});\n`;
  const key = createHash("sha256").update(source).update(lane).update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `inspect-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  if (lane === "wasm") {
    const res = await compile(file, { outPath: join(outDir, `${name}.wasm`), outDir, backend: "wasm", dynamic: true });
    if (!res.ok) throw new Error(`${name} refused on wasm:\n` + res.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const r = await runWasm(res.binaryPath);
    return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
  }
  const res = await compile(file, { outPath: join(outDir, `${name}.${lane}`), outDir, backend: lane, dynamic: true, sanitize });
  if (!res.ok) throw new Error(`${name} failed to compile on ${lane}:\n` + res.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  try {
    const { stdout, stderr } = await execFileAsync(res.binaryPath, [], { encoding: "utf8", maxBuffer: 1 << 26 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

/** The same island text under Node: the oracle shim's indirect eval. */
async function runNode(js: string): Promise<Out> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", `(0, eval)(${JSON.stringify(js)})`], { encoding: "utf8", maxBuffer: 1 << 26 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

/** S114: engine stack frames are the engine's, not V8's. */
const framesAside = (s: string): string =>
  s.split("\n").filter((l) => !/^\s+at /.test(l.replace(/\u001b\[\d+m/g, "")) && !/^\s+\.\.\. \d+ lines matching cause stack trace \.\.\.$/.test(l)).join("\n");

/* ── the rows ──────────────────────────────────────────────────────────
 * Each row is island source; rows run one after another in one program
 * per group, each behind a `--- name` marker line, each in its own
 * try/catch so a throw prints its message and the group goes on. */
interface Row { name: string; js: string }

const VALUES: [string, string][] = [
  ["prims", `[1, -0, NaN, Infinity, -1.5e-7, 2 ** 64, 10n, -5n, true, null, undefined, 'str', Symbol('s'), Symbol(), Symbol.iterator]`],
  ["strings", `['', 'it\\'s', 'say "hi"', 'both \\' and "', 'all \\' " \`', 'ctl \\x00\\x07\\x1b\\x7f\\x85', 'lone \\ud800 x \\udc00', 'pair \\ud83d\\ude00', 'tab\\tnl\\nback\\\\']`],
  ["long-string", `'word '.repeat(40) + '\\nsecond line ' + 'x'.repeat(30)`],
  ["nested", `{ a: 1, b: { c: { d: { e: { f: 1 } } } }, arr: [[[[[1]]]]] }`],
  ["mixed-array", `[1, 'a', null, undefined, [2, [3]], { k: 'v' }, true]`],
  ["holes", `(() => { const a = [, 1, , , 2, , ]; a[20] = 3; a.extra = 'e'; a[-1] = 'neg'; return a; })()`],
  ["long-array", `Array.from({ length: 130 }, (_, i) => i * 7)`],
  ["grouped-strings", `Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i).repeat(i % 7 + 1))`],
  ["grouped-wide", `['日本語', '中文字', 'ab', '한국어', 'éé', 'e\\u0301', 'ｆｕｌｌ', '😀😀', 'x', 'yz', 'w\\u200bw']`],
  ["many-keys", `Object.fromEntries(Array.from({ length: 28 }, (_, i) => ['key' + i, i % 3 ? i : 'v' + i]))`],
  ["odd-keys", `({ 'a-b': 1, '0': 2, 12: 3, valid_id: 4, $d: 5, '': 6, 'sp ace': 7, __proto__x: 8, [Symbol('sym')]: 9, [Symbol.for('reg')]: 10, 'q\\'k': 11 })`],
  ["proto-key", `JSON.parse('{"__proto__": 1, "b": 2}')`],
  ["accessors", `({ get a() { return 1; }, set b(v) {}, get c() { return { deep: [1] }; }, set c(v) {}, get d() { return null; }, get t() { throw new Error('getter threw'); } })`],
  ["map-set", `[new Map([[1, { a: 1 }], ['k', [1, 2]], [{ o: 1 }, new Set([1])]]), new Set(['a', 1, null, [2]]), new Map(), new Set()]`],
  ["big-map", `new Map(Array.from({ length: 105 }, (_, i) => [i, 'v' + i]))`],
  ["typed", `[new Uint8Array([1, 2, 255]), new Int16Array([-1, 2]), new Float32Array([1.5, -0, NaN]), new Float64Array(3), new BigInt64Array([1n, -2n]), new BigUint64Array(1), new Uint8ClampedArray(2), new Uint8Array(130)]`],
  ["buffers", `(() => { const ab = new ArrayBuffer(8); new Uint8Array(ab).set([1, 2, 254, 255]); return [ab, new DataView(ab, 2, 4), new ArrayBuffer(0), new ArrayBuffer(120), new Uint8Array(ab).subarray(2, 5)]; })()`],
  ["dates-regexps", `[new Date(0), new Date(1700000000123), new Date(NaN), /a+b/gi, /[/]\\d/y, new RegExp('x', 'dsu')]`],
  ["boxed", `[new Number(3), new Number(-0), new String('ab'), new String(''), new Boolean(false), Object(5n), Object(Symbol('q')), Object.assign(new String('hi'), { extra: 1 })]`],
  ["functions", `[function foo() {}, function () {}, () => {}, async function af() {}, function* gf() {}, async function* agf() {}, async () => {}, class A {}, class extends Map {}, class B extends class C {} {}, Math.max, Symbol, Object.assign(function withProps() {}, { p: 1, q: 'x' })]`],
  ["fn-names", `(() => { const f = function () {}; Object.defineProperty(f, 'name', { value: 42 }); const g = () => {}; Object.defineProperty(g, 'name', { value: '' }); return [f, g, ({ m() {}, get gg() { return 1; }, ['comp' + 'uted']() {} }).m]; })()`],
  ["classes", `(() => { class Animal { constructor() { this.legs = 4; } static create() {} } class Dog extends Animal { constructor() { super(); this.name = 'rex'; } bark() {} } return [new Dog(), Dog, new Animal(), Object.getPrototypeOf(new Dog()), Dog.prototype]; })()`],
  ["class-tags", `(() => { class T { get [Symbol.toStringTag]() { return 'TT'; } } class U { constructor() { this[Symbol.toStringTag] = 'own'; } } return [new T(), new U(), { [Symbol.toStringTag]: 'Tagged', a: 1 }, Object.defineProperty({}, Symbol.toStringTag, { value: 'Hidden' })]; })()`],
  ["null-proto", `(() => { const o = Object.create(null); o.x = 1; return [o, Object.create(null), Object.setPrototypeOf([1, 2], null), Object.setPrototypeOf(new Map([[1, 2]]), null), Object.setPrototypeOf(new Set([1]), null), Object.setPrototypeOf(new Date(0), null), Object.setPrototypeOf(/x/g, null), Object.setPrototypeOf(new Uint8Array(2), null), Object.setPrototypeOf(function nf() {}, null), Object.create(Object.create(null))]; })()`],
  ["circular", `(() => { const a = { name: 'a' }; const b = { a, list: [a] }; a.b = b; a.self = a; const m = new Map(); m.set('m', m); const arr = [1]; arr.push(arr); return [a, m, arr]; })()`],
  ["promises", `(() => { const r = Promise.reject(new Error('rej')); r.catch(() => {}); const s = Promise.reject(7); s.catch(() => {}); return [Promise.resolve(4), Promise.resolve({ a: [1] }), new Promise(() => {}), r, s]; })()`],
  ["proxies", `(() => { const rev = Proxy.revocable({}, {}); rev.revoke(); return [new Proxy({ a: 1 }, { get() { return 5; } }), new Proxy([1, 2], {}), new Proxy(function pf() {}, {}), rev.proxy, new Proxy(new Proxy({ n: 1 }, {}), {})]; })()`],
  ["arguments", `(function () { return [arguments, (function () { 'use strict'; return arguments; })(1)]; })(1, 'two')`],
  ["weak", `[new WeakMap(), new WeakSet(), new WeakRef({})]`],
  ["custom-inspect", `(() => { const ci = Symbol.for('nodejs.util.inspect.custom'); return [{ [ci](depth, opts, inspect) { return 'CUSTOM d=' + depth + ' ' + typeof inspect + ' ' + opts.breakLength; } }, { [ci]() { return { replaced: [1, 2] }; } }, { [ci]() { return 'multi\\nline'; }, }, { nest: { [ci](d) { return 'depth ' + d; } } }]; })()`],
  ["inherited", `Object.assign(Object.create({ inherited: 1, f() {} }), { own: 2 })`],
  ["non-enumerable", `Object.defineProperties({ v: 1 }, { hidden: { value: 2 }, [Symbol('hs')]: { value: 3 } })`],
  ["global-objects", `[Math, JSON, Reflect, Object.prototype, Array.prototype, Function.prototype]`],
  ["objects-in-arrays", `[{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }, { a: 7, b: 8, c: 9 }, { a: 10, b: 11, c: 12 }, { a: 13, b: 14, c: 15 }, { a: 16, b: 17, c: 18 }, { a: 19, b: 20, c: 21 }]`],
  ["long-key-value", `({ k: 'x'.repeat(76), short: 1, nested: { deeper: 'y'.repeat(60), list: ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)] } })`],
  ["numbers-grouping", `[Array.from({ length: 30 }, (_, i) => i * 1001), Array.from({ length: 8 }, (_, i) => -i * 0.5), [1n, 22n, 333n, 4444n, 55555n, 666666n, 7777777n]]`],
];

/* console.dir under each inspect option (functions and errors stay out of
 * showHidden: S114's residue rows hold those). */
const OPTION_SETS = [
  "{}", "{ depth: 0 }", "{ depth: null }", "{ depth: -1 }", "{ compact: false }", "{ compact: true }", "{ compact: 1 }",
  "{ breakLength: 40 }", "{ breakLength: Infinity }", "{ sorted: true }", "{ maxArrayLength: 2 }", "{ maxArrayLength: 0 }",
  "{ maxStringLength: 4 }", "{ getters: true }", "{ getters: 'set' }", "{ numericSeparator: true }", "{ colors: true }",
  "{ customInspect: false }", "{ showProxy: true }",
];
const HIDDEN_OK = new Set(["prims", "strings", "nested", "mixed-array", "holes", "map-set", "typed", "buffers", "dates-regexps", "boxed", "circular", "odd-keys", "non-enumerable"])

const valueRows: Row[] = VALUES.map(([name, expr]) => ({
  name: `value ${name}`,
  js: `const v = ${expr}; console.log(v); console.log('%s|%O', v, v); ` +
    OPTION_SETS.map((o) => `console.dir(v, ${o});`).join(" ") +
    (HIDDEN_OK.has(name) ? ` console.dir(v, { showHidden: true }); console.log('%o', v);` : ""),
}));

const ERRORS = `(() => {
  const e1 = new Error('boom');
  const e2 = new TypeError('bad', { cause: e1 });
  const e3 = Object.assign(new RangeError('r'), { code: 'E_X', extra: { n: 1 } });
  const e4 = new AggregateError([new Error('a'), 'b'], 'agg');
  class MyErr extends Error { constructor(m) { super(m); this.name = 'MyErr'; } }
  const e6 = new Error('renamed'); e6.name = 'Custom';
  const e9 = new Error('st'); e9.stack = 'assigned stack';
  const e10 = Object.create(Error.prototype);
  const e11 = new Error('nostack'); e11.stack = undefined;
  const e12 = new Error('msg'); e12.message = 'changed later';
  const e13 = new SyntaxError('');
  const e14 = new Error('with cause', { cause: 'plain cause' });
  const e15 = Object.setPrototypeOf(new Error('np'), null);
  const e16 = new Error('multi\\nline message');
  return [e1, e2, e3, e4, new MyErr('mine'), e6, new Error(''), e9, e10, e11, e12, e13, e14, e15, e16];
})()`;

const rows: Row[][] = [
  valueRows.slice(0, 12),
  valueRows.slice(12, 24),
  valueRows.slice(24),
  [
    { name: "errors log", js: `for (const e of ${ERRORS}) console.log(e);` },
    { name: "errors nested", js: `const es = ${ERRORS}; console.log({ err: es[0] }, [es[1]]); console.log(new Map([['e', es[2]]])); console.dir(es[3], { depth: 0 });` },
    { name: "errors %s %o", js: `const es = ${ERRORS}; console.log('%s', es[0]); console.log('%s|%s', es[2], es[5]); console.error(es[0]);` },
    { name: "error thrown by a getter", js: `console.dir({ get g() { throw new TypeError('inner'); } }, { getters: true });` },
    { name: "format specifiers", js: [
      `console.log('%s %d %i %f %j %o %O %%', 'str', 42, 42.9, '3.5', { a: 1 }, [1], { b: 2 });`,
      `console.log('%s', null, undefined, 1n, Symbol('x'), [1, [2]], { a: { b: { c: 1 } } });`,
      `console.log('%d %i %f', '0x10', '42.5abc', 'abc', 'extra', { e: 1 });`,
      `console.log('%d %i', 5n, Symbol('q'));`,
      `console.log('%s|%s|%s', class A { toString() { return 'cls'; } }, new (class B { toString() { return 'inst'; } })(), new (class C {})());`,
      `console.log('%s', new Date(0), new Map([[1, 2]]), new Error('in %s'));`,
      `console.log('%j', { toJSON() { return 'j'; } }); const cj = {}; cj.c = cj; console.log('%j', cj);`,
      `console.log('%c styled %c', 'color: red', 'x', 'tail');`,
      `console.log('no specifiers', { a: 1 }, 'str', 2);`,
      `console.log({ a: 1 }, '%s', 'not a format');`,
      `console.log('%', '%z', 1, '%%s', 2);`,
      `console.log('%o', { a: [1, 2, { b: 3 }], s: 'x' });`,
      `console.log('%o', [1, 2, 3]);`,
    ].join("\n") },
    { name: "console methods", js: [
      `console.dir({ a: { b: { c: { d: 1 } } } });`,
      `console.dir({ [Symbol.for('nodejs.util.inspect.custom')]() { return 'nope'; } });`,
      `console.dirxml('x', { y: 1 }, [2]);`,
      `console.info({ i: 1 }); console.debug([1]); console.warn({ w: 1 }); console.error(new Map([[1, 2]]));`,
      `console.group({ g: 1 }); console.log({ inner: { a: [1, 2, 3] }, s: 'x'.repeat(70) }); console.groupEnd();`,
      `console.assert(false, { failed: true }); console.assert(false, '%o', [1]);`,
    ].join("\n") },
    { name: "console.table", js: [
      `console.table([{ a: 1, b: 'x' }, { a: 2, c: true }]);`,
      `console.table([{ a: 1, b: 'x' }, { a: 2, c: true }], ['a']);`,
      `console.table({ r1: { c: 1 }, r2: { c: 2, d: [1, 2, 3, 4] } });`,
      `console.table(new Map([['k', 1], ['l', { o: 1 }]]));`,
      `console.table(new Set(['a', 'b']));`,
      `console.table([1, 'two', null, [3]]);`,
      `console.table([[1, 2], [3, 4, 5]]);`,
      `console.table(['日本', 'ab', 'é']);`,
      `console.table('not tabular'); console.table(null); console.table(5);`,
      `console.table([{ deep: { a: { b: 1 } }, many: { x: 1, y: 2, z: 3 } }]);`,
    ].join("\n") },
    { name: "error-message quoting", js: [
      `try { new MessageEvent('x', { source: {} }); } catch (e) { console.log(e.message); }`,
      `try { ReadableStream.from({}); } catch (e) { console.log(e.message); }`,
      `try { new TextDecoder('utf-8', Object.create(null)).decode(5); } catch (e) { console.log(e.message); }`,
      `try { structuredClone(1, 5); } catch (e) { console.log(e.message); }`,
    ].join("\n") },
    { name: "brands a program cannot fake, getters that throw or count", js: [
      `const MI = Object.getPrototypeOf(new Map().entries()); const SI = Object.getPrototypeOf(new Set().values());`,
      `console.log(Object.create(MI), Object.create(SI), [Object.setPrototypeOf({ a: 1 }, MI)]);`,
      `let calls = 0; const tagThrows = { get [Symbol.toStringTag]() { calls++; throw new Error('tag'); }, x: 1 }; console.log(tagThrows, calls);`,
      `calls = 0; const tagCounts = { get [Symbol.toStringTag]() { calls++; return 'Counted'; }, y: 2 }; console.log(tagCounts, calls);`,
      `console.log({ [Symbol.toStringTag]: 'Arguments', 0: 'a' });`,
      `(function () { arguments[Symbol.toStringTag] = 'Nope'; console.log(arguments); })(1, 2);`,
      `(function (a) { console.log(arguments); })(1, 2);`,
      `console.log(Object.preventExtensions(Object.defineProperty(Object.create(null), Symbol.toStringTag, { value: 'Module' })));`,
    ].join("\n") },
    { name: "an error's header is fixed at the first read of its stack, as V8's", js: [
      `const e = new Error('m'); Object.defineProperty(e, 'name', { get() { throw new Error('nm'); } }); console.log(e);`,
      `class E2 extends Error { get name() { throw 1; } } console.log([new E2('y')]);`,
      `const e3 = new Error('z'); e3.stack; Object.defineProperty(e3, 'name', { get() { throw 1; } }); console.log(e3);`,
      `const f = new Error('a'); f.message = 'b'; console.log(f);`,
      `const g2 = new Error('a'); g2.stack; g2.message = 'b'; console.log(g2);`,
      `try { const h = new Error('x'); Object.defineProperty(h, 'name', { get() { throw new Error('n'); } }); h.stack; console.log('no throw'); } catch (x) { console.log('threw', x.message); }`,
    ].join("\n") },
    { name: "a replaced fenced global takes Node's enumerability", js: [
      `const pick = () => Object.keys(globalThis).filter((k) => ['Intl', 'process', 'fetch', 'navigator', 'URL', 'WebSocket'].includes(k)).sort().join(',');`,
      `globalThis['In' + 'tl'] = 1; globalThis['proc' + 'ess'] = 2; globalThis['fe' + 'tch'] = 3; globalThis['navi' + 'gator'] = 4; globalThis['Web' + 'Socket'] = 5;`,
      `console.log(pick());`,
    ].join("\n") },
    { name: "performance.now", js: `console.log(typeof performance.now(), performance.now() >= 0, Object.keys(performance).join(','), typeof performance.timeOrigin, Math.abs(performance.timeOrigin + performance.now() - Date.now()) < 1000);` },
  ],
];

/* S114 residue: lane-identical, and Node differs exactly so. */
const RESIDUE: { name: string; js: string; node: (s: string) => string }[] = [
  {
    // V8's sloppy functions own `arguments` and `caller` (null); the
    // engine's inherit them from Function.prototype's accessors.
    name: "residue: %o of a sloppy function",
    js: `console.log('%o', function foo() {});`,
    node: (s) => s.replace("  [arguments]: null,\n  [caller]: null,\n", ""),
  },
  {
    // V8 names a null-prototype object after the constructor that built
    // it (the object's map); JavaScript cannot see it.
    name: "residue: a class instance whose prototype was set to null",
    js: `class Foo {}; console.log(Object.setPrototypeOf(Object.assign(new Foo(), { a: 1 }), null));`,
    node: (s) => s.replace("[Foo: null prototype]", "[Object: null prototype]"),
  },
  {
    // V8's stack is an accessor OWNED by each error (S108 (i)): showHidden
    // lists it.
    name: "residue: showHidden over an error",
    js: `console.dir(new Error('x'), { showHidden: true });`,
    node: (s) => s.replace("  [stack]: [Getter/Setter],\n", ""),
  },
  {
    // QuickJS's Function.prototype.toString of a native function is three
    // lines (S108 (j)); `%s` of a builtin or bound function prints it.
    name: "residue: %s of a builtin and a bound function",
    js: `console.log('%s|%s', Math.max, Math.max.bind(null));`,
    node: (s) => s.replace("function max() { [native code] }|function () { [native code] }",
      "function max() {\n    [native code]\n}|function bound max() {\n    [native code]\n}"),
  },
  {
    // A function's kind is read from its intrinsic prototype.
    name: "residue: an async or generator function whose prototype was replaced",
    js: `const a = async function a() {}; const g = function* g() {}; Object.setPrototypeOf(a, Function.prototype); Object.setPrototypeOf(g, Function.prototype); console.log(a, g);`,
    node: (s) => s.replace("[AsyncFunction: a] Function [GeneratorFunction: g] Function", "[Function: a] [Function: g]"),
  },
];

const marked = (group: Row[]): string =>
  group.map((r) => `console.log(${JSON.stringify(`--- ${r.name}`)}); try { ${r.js}\n} catch (e) { console.log('THREW', e && e.message); }`).join("\n");

describe(`island util.inspect = Node's (${lanes.join(", ")}${sanitize ? ", sanitized" : ""})`, () => {
  rows.forEach((group, gi) => {
    test(`group ${gi}: ${group.map((r) => r.name).join(", ")}`, async () => {
      const js = marked(group);
      const node = await runNode(js);
      expect(node.exitCode).toBe(0);
      const outs = await Promise.all(lanes.map((l) => runIsland(l, `inspect-g${gi}`, js)));
      const dump = process.env["INSPECT_DUMP"];
      if (dump) {
        writeFileSync(join(dump, `g${gi}.node`), node.stdout + "\n<<stderr>>\n" + node.stderr);
        lanes.forEach((l, i) => writeFileSync(join(dump, `g${gi}.${l}`), outs[i]!.stdout + "\n<<stderr>>\n" + outs[i]!.stderr));
      }
      for (let i = 0; i < lanes.length; i++) {
        // every lane prints the same bytes, frames included
        expect(outs[i], `${lanes[i]} vs ${lanes[0]}`).toEqual(outs[0]);
      }
      expect(framesAside(outs[0]!.stdout)).toBe(framesAside(node.stdout));
      expect(framesAside(outs[0]!.stderr)).toBe(framesAside(node.stderr));
      expect(outs[0]!.exitCode).toBe(0);
    });
  });

  for (const r of RESIDUE) {
    test(r.name, async () => {
      const node = await runNode(r.js);
      const outs = await Promise.all(lanes.map((l) => runIsland(l, "inspect-residue", r.js)));
      for (const o of outs) expect(o).toEqual(outs[0]);
      expect(framesAside(outs[0]!.stdout)).toBe(r.node(framesAside(node.stdout)));
    });
  }

  test("ONE nesting cap on every lane: past 100 levels Node's interrupted-inspection text (S114 (f))", async () => {
    const js = [
      `const mk = (n) => { const r = {}; let d = r; for (let i = 0; i < n; i++) { d.n = {}; d = d.n; } return r; };`,
      `const mkA = (n) => { const r = []; let d = r; for (let i = 0; i < n; i++) { const x = []; d.push(x); d = x; } return r; };`,
      `for (const n of [99, 100, 101, 2000]) { console.log('#' + n); console.dir(mk(n), { depth: Infinity, breakLength: Infinity }); console.dir(mkA(n), { depth: null, breakLength: Infinity }); }`,
    ].join("\n");
    const outs = await Promise.all(lanes.map((l) => runIsland(l, "inspect-depth", js)));
    for (const o of outs) expect(o).toEqual(outs[0]);
    const sections = outs[0]!.stdout.split(/^#\d+$/m).slice(1);
    const interrupted = (s: string) => (s.match(/\[(Object|Array): Inspection interrupted prematurely\. Maximum call stack size exceeded\.\]/g) ?? []).length;
    // 99 and 100 levels print whole (as Node does); 101 and 2000 stop at
    // the cap, once each for the object and the array.
    expect(sections.map(interrupted)).toEqual([0, 0, 2, 2]);
  });

  test("the fences: what the island cannot preview, and the Node globals and locale methods it lacks (S114, S103 (b))", async () => {
    const js = [
      `const grab = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.message; } };`,
      `console.log(grab(() => console.log(new Map([[1, 2]]).entries())));`,
      `console.log(grab(() => console.log([new Set([1]).values()])));`,
      `console.log(grab(() => console.log('%o', new WeakMap())));`,
      `console.log(grab(() => console.dir(new WeakSet(), { showHidden: true })));`,
      `console.log(grab(() => console.table(new Map([[1, 2]]).keys())));`,
      `for (const n of ['Intl', 'process', 'Buffer', 'WebSocket', 'navigator', 'setImmediate']) console.log(grab(() => globalThis[n]), grab(() => typeof globalThis[n]));`,
      `console.log(grab(() => (1234.5).toLocaleString()), grab(() => 'a'.localeCompare('b')), String.prototype.localeCompare.length);`,
      `console.log(grab(() => [1, 2].toLocaleString()), grab(() => new Date(0).toLocaleDateString()), grab(() => 'I'.toLocaleLowerCase()));`,
      `const I = 'In' + 'tl'; globalThis[I] = 'mine'; console.log(globalThis[I]);`,
    ].join("\n");
    const outs = await Promise.all(lanes.map((l) => runIsland(l, "inspect-fences", js)));
    if (process.env["INSPECT_DUMP"]) lanes.forEach((l, i) => writeFileSync(join(process.env["INSPECT_DUMP"]!, `fences.${l}`), outs[i]!.stdout + "\n<<stderr>>\n" + outs[i]!.stderr));
    for (const o of outs) expect(o).toEqual(outs[0]);
    const g = (n: string) => `${n} inside the scriptc island is not supported yet (SEMANTICS.md S103)`;
    const p = (what: string) => `util.inspect of ${what}'s entries inside the scriptc island is not supported yet (SEMANTICS.md S114)`;
    expect(outs[0]!.stdout).toBe(
      [
        p("a Map iterator"), p("a Set iterator"), p("a WeakMap"), p("a WeakSet"), p("a Map iterator"),
        ...["Intl", "process", "Buffer", "WebSocket", "navigator", "setImmediate"].map((n) => `${g(n)} ${g(n)}`),
        `${g("Number.prototype.toLocaleString")} ${g("String.prototype.localeCompare")} 1`,
        `${g("Number.prototype.toLocaleString")} ${g("Date.prototype.toLocaleDateString")} ${g("String.prototype.toLocaleLowerCase")}`,
        "mine",
        "",
      ].join("\n"),
    );
  });
});
