/* Paperclip's stdlib batch 3, its built-in class instances and strict deep
 * equality (SEMANTICS.md S151): Intl.DateTimeFormat#format over dynamic
 * dates, the hidden slot of a DateTimeFormat, WeakRef or
 * FinalizationRegistry record refusing by name on every surface that would
 * show it, Node's CanBeHeldWeakly and argument order for WeakRef and
 * register, and the strict comparison's own-key check.
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
];

describeRows("Paperclip's stdlib batch: built-in instances and strict deep equality", ROWS);
