/* Paperclip's stdlib batch 3, its built-in class instances and strict deep
 * equality (SEMANTICS.md S151): Intl.DateTimeFormat#format over dynamic
 * dates, the hidden slot of a DateTimeFormat, WeakRef or
 * FinalizationRegistry record refusing by name on every surface that would
 * show it or that would copy it into another record type, Node's
 * CanBeHeldWeakly (null included, for WeakMap and WeakSet keys too) and
 * argument order for WeakRef and register, ToNumber of a BigInt date, and
 * the strict comparison's own-key check (array holes at S119's fence).
 *
 * Every row equals Node (spawned at test time), on the wasm lane and, in
 * the second describe, on the wasm-native lane, or stops or refuses by
 * name where noted. */
import { describeRows, type Row } from "./stdlib-batch-harness.js";

const DTF = `const H = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC", timeZoneName: "short" });`;
const WR = `const w = new WeakRef({ a: 1 });`;
const FR = `const fin = new FinalizationRegistry<string>(() => {});`;

/** A build that refuses by name: `src` after the instance declarations. */
function refusal(id: string, src: string, refusedMsg: string): Row {
  return { id, nodeTypes: true, src: `${DTF}\n${WR}\n${FR}\n${src}`, refusedMsg };
}

const ROWS: Row[] = [
  {
    id: "SB-33 DateTimeFormat.format over a Date-typed value holding JSON's string and over an 'any' (paperclip's timestamps): Node's ToNumber of the value; a new Date never reached builds",
    nodeTypes: true,
    src: `${DTF}
function show(d: Date): string { return H.format(d); }
const v: any = JSON.parse('"86400000"');
console.log(show(JSON.parse('"86400000"')), "|", H.format(v), "|", H.format(JSON.parse('"86400000"')));
if (process.argv.length > 99) console.log(H.format(new Date(1777378620000)));`,
  },
  {
    id: "SB-34 DateTimeFormat.format(new Date(ms)) reached stops by name at the Date object (SEMANTICS.md S149)",
    nodeTypes: true,
    src: `${DTF}
console.log("before");
console.log(H.format(new Date(1777378620000)));`,
    fence: "new Date(...) as a value",
  },
  refusal("SB-35a JSON.stringify of a DateTimeFormat refuses by name (Node writes {})", "console.log(JSON.stringify(H));", "JSON.stringify of '{ %dtf: string }' values"),
  refusal("SB-35b console.log of a WeakRef refuses by name (Node prints WeakRef {})", "console.log(w);", "WeakRef instances have no inspect lowering"),
  refusal("SB-35c console.log of a DateTimeFormat refuses by name", "console.log(H);", "Intl.DateTimeFormat instances have no inspect lowering"),
  refusal("SB-35d Object.keys of a DateTimeFormat refuses by name (Node lists no own keys)", "console.log(Object.keys(H));", "Object.keys over Intl.DateTimeFormat instances"),
  refusal("SB-35e Object.entries of a WeakRef refuses by name", "console.log(Object.entries(w).length);", "Object.entries over WeakRef instances"),
  refusal("SB-35f for-in over a WeakRef refuses by name (Node visits nothing)", "let n = 0;\nfor (const k in w) n++;\nconsole.log(n);", "for-in over WeakRef instances"),
  refusal("SB-35g Object.hasOwn on a FinalizationRegistry refuses by name", 'console.log(Object.hasOwn(fin, "x"));', "Object.hasOwn over FinalizationRegistry instances"),
  refusal("SB-35h the 'in' operator on a WeakRef refuses by name (Node finds the prototype's deref)", 'console.log("deref" in w);', "the 'in' operator over WeakRef instances"),
  refusal("SB-35i Object.assign from a FinalizationRegistry refuses by name", "console.log(Object.assign({}, fin));", "Object.assign over FinalizationRegistry instances"),
  refusal("SB-35j structuredClone of a DateTimeFormat refuses by name (Node throws DataCloneError)", "console.log(typeof structuredClone(H));", "structuredClone over Intl.DateTimeFormat instances"),
  refusal("SB-35k String() of a FinalizationRegistry refuses by name (Node writes [object FinalizationRegistry])", "console.log(String(fin));", "string conversions of FinalizationRegistry instances"),
  refusal("SB-35l a spread of a WeakRef refuses by name", "const s = { ...w };\nconsole.log(s);", "object spread of a key ('%weakref')"),
  {
    id: "SB-36 util.isDeepStrictEqual of two WeakRefs, DateTimeFormats or FinalizationRegistries is true (internal slots only); TextDecoders still compare their options",
    nodeTypes: true,
    src: `import { isDeepStrictEqual } from "node:util";
const f = () => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC", timeZoneName: "short" });
console.log(isDeepStrictEqual(new WeakRef({ a: 1 }), new WeakRef({ a: 2 })), isDeepStrictEqual(f(), f()), isDeepStrictEqual(new FinalizationRegistry<string>(() => {}), new FinalizationRegistry<string>(() => {})));
console.log(isDeepStrictEqual(new TextDecoder(), new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })), isDeepStrictEqual(new TextDecoder(), new TextDecoder()));`,
  },
  {
    id: "SB-37 FinalizationRegistry.register evaluates every argument, then checks the target (Node's order)",
    nodeTypes: true,
    src: `const reg = new FinalizationRegistry<{ id: number }>(() => {});
function f(): number { console.log("holdings evaluated"); return 1; }
function tok(): { k: number } { console.log("token evaluated"); return { k: 1 }; }
try { reg.register(JSON.parse("1"), { id: f() }); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const t: any = "s";
try { reg.register(t, { id: f() }, tok()); } catch (e) { console.log((e as Error).name, (e as Error).message); }`,
  },
  {
    id: "SB-38 a symbol not registered with Symbol.for is a WeakRef or register target, a registered one throws Node's TypeError (static and dynamic symbols)",
    nodeTypes: true,
    src: `const s = Symbol("x");
const w = new WeakRef(s);
console.log(w.deref() === s);
try { new WeakRef(Symbol.for("y")); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const v: any = Symbol("x");
console.log(typeof new WeakRef<object>(v).deref());
const r: any = Symbol.for("q");
try { new WeakRef<object>(r); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const p: any = 5;
try { new WeakRef<object>(p); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const reg = new FinalizationRegistry<{ id: number }>(() => {});
reg.register(Symbol("a"), { id: 1 });
console.log("registered a symbol");
try { reg.register(Symbol.for("b"), { id: 2 }); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const d: any = Symbol("c");
reg.register(d, { id: 3 });
console.log("registered a dynamic symbol");
const e2: any = Symbol.for("c");
try { reg.register(e2, { id: 4 }); } catch (e) { console.log((e as Error).name, (e as Error).message); }
reg.register(JSON.parse("{}"), { id: 5 });
console.log("registered a dynamic object");`,
  },
  {
    id: "SB-39 util.isDeepStrictEqual: an own key holding undefined is not a missing key (top level, in an array, in a nested record, from JSON)",
    nodeTypes: true,
    src: `import { isDeepStrictEqual } from "node:util";
type R = { a?: number; b: string };
console.log(isDeepStrictEqual({ a: undefined, b: "s" } as R, { b: "s" } as R), isDeepStrictEqual({ b: "s" } as R, { b: "s" } as R), isDeepStrictEqual({ a: undefined, b: "s" } as R, { a: undefined, b: "s" } as R), isDeepStrictEqual({ a: 1, b: "s" } as R, { a: 1, b: "s" } as R));
const x: R[] = [{ b: "s" }];
const y: R[] = [{ a: undefined, b: "s" }];
console.log(isDeepStrictEqual(x, y), isDeepStrictEqual({ r: x[0]! }, { r: y[0]! }), isDeepStrictEqual(x, [{ b: "s" }] as R[]));
type Q = { a: number | undefined; b: string };
const q1: Q = JSON.parse('{"b":"s"}');
const q2: Q = JSON.parse('{"b":"s"}');
const q3: Q = JSON.parse('{"a":1,"b":"s"}');
console.log(isDeepStrictEqual(q1, q2), isDeepStrictEqual(q1, q3));`,
  },
  {
    id: "SB-40 assert.deepStrictEqual and notDeepStrictEqual: an own key holding undefined is not a missing key",
    nodeTypes: true,
    src: `import assert from "node:assert";
type R = { a?: number; b: string };
try { assert.deepStrictEqual({ a: undefined, b: "s" } as R, { b: "s" } as R); console.log("equal"); } catch (e) { console.log("not equal", (e as Error).name); }
assert.deepStrictEqual({ b: "s" } as R, { b: "s" } as R);
assert.notDeepStrictEqual({ b: "s" } as R, { a: undefined, b: "s" } as R);
try { assert.notDeepStrictEqual({ a: undefined, b: "s" } as R, { a: undefined, b: "s" } as R); } catch (e) { console.log("equal", (e as Error).name); }
console.log("done");`,
  },
  {
    id: "SB-41 loose assert.deepEqual keeps its named refusal",
    nodeTypes: true,
    src: `import assert from "node:assert";
type R = { a?: number; b: string };
try { assert.deepEqual({ a: undefined, b: "s" } as R, { b: "s" } as R); console.log("equal"); } catch (e) { console.log("not equal", (e as Error).name); }`,
    refusedMsg: "'assert.deepEqual' is typed by @types/node but has no scriptc lowering yet",
  },
  {
    id: "SB-42 a null WeakRef or register target throws Node's TypeError (an 'any' null, `null as any`, JSON's null); a dynamic object still registers",
    nodeTypes: true,
    src: `const reg = new FinalizationRegistry<{ id: number }>(() => {});
const t: any = null;
try { reg.register(t, { id: 1 }); console.log("registered null"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
try { reg.register(JSON.parse("null"), { id: 2 }); console.log("registered JSON null"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
try { new WeakRef(null as any); console.log("made a null WeakRef"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
try { new WeakRef<object>(t); console.log("made a null WeakRef"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const n: any = JSON.parse("null");
try { new WeakRef<object>(n); console.log("made a JSON null WeakRef"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const o: any = JSON.parse("{}");
console.log(typeof new WeakRef<object>(o).deref());
reg.register(o, { id: 3 });
console.log("registered an object");`,
  },
  {
    id: "SB-43 a null WeakMap key or WeakSet element: set/add throw Node's TypeError, get/has/delete answer undefined/false",
    nodeTypes: true,
    src: `const k: any = null;
const wm = new WeakMap<object, number>();
try { wm.set(k, 1); console.log("set a null key"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
console.log(wm.get(k), wm.has(k), wm.delete(k));
const ws = new WeakSet<object>();
try { ws.add(k); console.log("added null"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
console.log(ws.has(k), ws.delete(k));
const j: any = JSON.parse("null");
try { wm.set(j, 2); console.log("set JSON null"); } catch (e) { console.log((e as Error).name, (e as Error).message); }`,
  },
  {
    id: "SB-44 a null key in a JavaScript source's WeakMap and WeakSet throws Node's TypeError",
    nodeTypes: true,
    entry: "main.js",
    src: `const k = JSON.parse("null");
const wm = new WeakMap();
try { wm.set(k, 1); console.log("set a null key"); } catch (e) { console.log(e.name, e.message); }
console.log(wm.get(k), wm.has(k), wm.delete(k));
const ws = new WeakSet();
try { ws.add(k); console.log("added null"); } catch (e) { console.log(e.name, e.message); }
console.log(ws.has(k), ws.delete(k));`,
  },
  refusal("SB-45a a WeakRef cast `as unknown as Record<string, unknown>` refuses by name (Node lists no own keys)", "const o = w as unknown as Record<string, unknown>;\nconsole.log(Object.keys(o).length);", "WeakRef instances crossing into"),
  refusal("SB-45b a DateTimeFormat cast `as any as { [k: string]: unknown }` refuses by name", "const o = H as any as { [k: string]: unknown };\nconsole.log(Object.keys(o).length);", "Intl.DateTimeFormat instances crossing into"),
  refusal(
    "SB-45c a FinalizationRegistry passed to a Record<string, unknown> parameter through a double cast refuses by name",
    "function count(r: Record<string, unknown>): number { return Object.keys(r).length; }\nconsole.log(count(fin as unknown as Record<string, unknown>));",
    "FinalizationRegistry instances crossing into",
  ),
  refusal("SB-45d a WeakRef cast to a plain record refuses by name (Node's String() is [object WeakRef])", "const o = w as unknown as { x?: number };\nconsole.log(String(o));", "WeakRef instances crossing into"),
  refusal("SB-45e a WeakRef annotated into a Record<string, unknown> binding through `as unknown` refuses by name", "const o: Record<string, unknown> = w as unknown as Record<string, unknown>;\nfor (const k in o) console.log(k);", "WeakRef instances crossing into"),
  refusal("SB-45f a WeakRef cast `as unknown as object` refuses by name at the dynamic crossing", "const o = w as unknown as object;\nconsole.log(Object.keys(o).length);", "passing a value of type '{ %weakref: { a: number } }' into dynamically-executed"),
  refusal(
    "SB-45g a WeakRef nested in a record cast to an index-signature field type refuses by name",
    "const o = { r: w } as unknown as { r: Record<string, unknown> };\nconsole.log(Object.keys(o.r).length);",
    "field 'r': '{ %weakref: { a: number } }' does not lift into '{ [key: string]: unknown }'",
  ),
  {
    id: "SB-45h a WeakRef keeps its class across a reshape of its target type",
    nodeTypes: true,
    src: `const w: WeakRef<{ a: number }> = new WeakRef({ a: 1 });
const v: WeakRef<object> = w;
console.log(typeof v.deref(), w.deref()!.a);`,
  },
  {
    id: "SB-46 DateTimeFormat.format of a BigInt (an 'any', through a union, from a cast) throws Node's TypeError; Number() still converts one",
    nodeTypes: true,
    src: `${DTF}
const x: any = 1n;
try { console.log(H.format(x)); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const u: number | bigint = process.argv.length > 99 ? 5 : 5n;
try { console.log(H.format(u as any)); } catch (e) { console.log((e as Error).name, (e as Error).message); }
try { console.log(H.format(2n as any)); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const s: any = "86400000";
console.log(H.format(s), "|", H.format(0 as any), "|", Number(x));`,
  },
  {
    id: "SB-47 strict deep comparison of arrays holding undefined in a program without holes answers Node (no fence)",
    nodeTypes: true,
    src: `import assert from "node:assert";
import { isDeepStrictEqual } from "node:util";
const a: (number | undefined)[] = [undefined, 1];
const b: (number | undefined)[] = [undefined, 1];
const c: (number | undefined)[] = [2, 1];
console.log(isDeepStrictEqual(a, b), isDeepStrictEqual(a, c), isDeepStrictEqual({ r: a }, { r: b }));
assert.deepStrictEqual(a, b);
console.log("done");`,
  },
  {
    id: "SB-48a assert.deepStrictEqual([, 1], [undefined, 1]) stops at S119's named hole fence (Node throws: a hole is not an undefined element)",
    nodeTypes: true,
    src: `import assert from "node:assert";
console.log("before");
try { assert.deepStrictEqual([, 1], [undefined, 1]); console.log("equal"); } catch (e) { console.log("not equal", (e as Error).name); }`,
    fence: "a strict deep comparison over an array that may hold holes",
  },
  {
    id: "SB-48b util.isDeepStrictEqual over a record whose array field holds a hole stops at the fence",
    nodeTypes: true,
    src: `import { isDeepStrictEqual } from "node:util";
const x: { a: (number | undefined)[] } = { a: [, 1] };
const y: { a: (number | undefined)[] } = { a: [undefined, 1] };
console.log("before");
console.log(isDeepStrictEqual(x, y));`,
    fence: "a strict deep comparison over an array that may hold holes",
  },
  {
    id: "SB-48c a write past an array's end leaves a hole: notDeepStrictEqual against the undefined-filled array stops at the fence",
    nodeTypes: true,
    src: `import assert from "node:assert";
const xs: number[] = [1];
xs[2] = 3;
console.log("before", xs.length);
assert.notDeepStrictEqual(xs, [1, undefined as unknown as number, 3]);
console.log("not equal");`,
    fence: "a strict deep comparison over an array that may hold holes",
  },
];

describeRows("Paperclip's stdlib batch: built-in instances and strict deep equality", ROWS);
