/* GH #109: width copies (SEMANTICS.md S125).
 *
 * Records are monomorphic structs and classes are their own structs, so a
 * value whose representation differs from its typed slot's — a class
 * instance into a record type, a wider record into a narrower one, `P[]`
 * into `{ n: number }[]`, a tuple into an array, a record into an
 * index-signature record — enters the slot as a COPY that an interned
 * width helper builds. JavaScript shares the object. (A direct call of a
 * plain function avoids the copy altogether: widthSpecializedCall binds
 * the parameter to the argument's own type.) A copy is exact only while
 * nothing could tell the two apart, so this post-pass, over the finished
 * function list, finds every copy and refuses by name (SC1090) each one
 * the program could observe:
 *
 *   - a WRITE to a copied field (or an array's elements) through the copy,
 *     which would not reach the original, or through the original after
 *     the copy, which the copy would not see;
 *   - an IDENTITY test (`===`, `includes`, `indexOf`, ...);
 *   - a KEY or PRINT observer (printing, JSON, Object.keys/values/entries,
 *     for-in, `in`, spread, a dynamic crossing, ...) on the copy, when its
 *     own keys or class differ from the original's.
 *
 * Two precisions, both sound:
 *
 *   BY BINDING. When the copy lands in a local (or a global, or a
 *   parameter of a directly called function) that nothing else assigns
 *   and nothing captures, the uses of that binding are the uses of the
 *   copy, so they are checked one by one. When the original is a binding
 *   assigned once from a fresh value (a literal, a `new` whose constructor
 *   keeps `this` to itself) and only ever read, nothing else holds it and
 *   nothing writes it.
 *
 *   BY TYPE, otherwise: a write to a value of the type counts, field by
 *   field (every field and element for an array or index-signature copy).
 *   Every use of a composite value outside the transparent positions below
 *   (field and element reads and writes, storing into locals/fields/
 *   elements, passing to the program's own functions, union wraps, null
 *   tests) is an observer of every type the value can reach, and a writer
 *   too unless it is a known read-only one (printing, JSON, key listing).
 *
 *   ORDER, cheaply: a write in a module initializer's top-level statement
 *   BEFORE the copy's has already happened. A copy handed to a parameter
 *   that never lets it go dies when the call returns, so only a write in a
 *   function that call can run (and the call must not suspend) can meet
 *   it. Nothing else is ordered: loops, other calls and closures count
 *   wherever they are.
 *
 *   A constructor's writes to its OWN instance are construction, unless the
 *   constructor hands `this` away (a call, a closure capturing it). It
 *   over-refuses; it never
 *   under-refuses. */
import { typeKey, type IrExpr, type IrFunction, type IrType, type SrcLoc } from "../../ir/nodes.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";

/** The interned width helpers: each builds a NEW value of its return type
 * from its one argument. */
const COPY_HELPER = /^%(rec\.width|obj\.width|cls\.width|arr\.width|tup\.arr|arr\.empty|rec\.capture)\.\d+$/;

export const isCopyHelper = (name: string): boolean => COPY_HELPER.test(name);

/** Lowering helpers that only move or test their arguments (re-tags,
 * narrows), the program's own lambdas, and the array HOF loops (they hand
 * elements to a program callback): their argument positions are
 * transparent. */
const TRANSPARENT_HELPER = /^%(union\.(retag|narrow|strand|recv)|nullish\.retag|unit\.strand|deferred\.read|fn\d+|obj\.assign|arr\.(map|filter|forEach|reduce|reduceRight|find|findIndex|findLast|findLastIndex|some|every|flatMap|filterNarrow|concat)|object\.groupBy|map\.(groupBy|keys|values|entries)|obj\.fromEntries)(\.|_|$|\d)/;
/** The array HOF loops alone: they read the array's spine. */
const HOF_HELPER = /^%arr\.(map|filter|forEach|reduce|reduceRight|find|findIndex|findLast|findLastIndex|some|every|flatMap|filterNarrow)\./;
/** Helpers that BUILD a fresh record or map and return it: their own
 * writes construct it (no one else holds it yet). */
const BUILDER = /^%(object\.groupBy|map\.groupBy|obj\.(fromEntries|keys|values|entries))\./;
/** Array helpers that MUTATE their array argument (sort, reverse, ...):
 * the write is noted at the call; their own bodies are not writes. */
const ARG_MUTATOR = /^%arr\.(sort|reverse|fill|copyWithin|unshift|splice|push|pop|shift)\.\d+$/;
/** The runtime library families that run no program code: each takes and
 * answers data. Enumerated from every `libCall` family the lowering emits
 * (`fn: "<family>.<member>"`); the rest — emitter, readable/writable/
 * stream, timers, process, dyn, dc, als, async, assert, test, net/http/
 * http2/tls/https/dgram/dns, fs/fsp, child/cp/spawnRes/procStream, rl,
 * stdin, island, watcher, perf, crypto, zlib, global, class, atomics, tp,
 * sp, tlsca, stats, qs ... — can run, or may one day run, a callback, and
 * count as running any of them. */
const PURE_LIB = /^(math|num|number|string|str|insp|json|path|date|sym|buffer|bytes|error|undef|os|regex|regexp|text|intl|strdec|url)\./;
/** Node kinds that cross into the runtime, the host or the embedded engine
 * with a program value that may be (or hold) a function. */
const RUNTIME_KINDS = new Set(["dynCall", "dynInvoke", "jsMarshal", "jsExit", "jsView", "jsUnview", "jsBridgePromise", "ffiCall", "newPromise", "promiseWithResolvers", "dynFrom", "dynCheck"]);
/** Pass-through checks: they answer their argument unchanged. */
const PASS_THROUGH = /^%(undef\.(fence|recv|iter)|in\.undefrecv)\./;
/** Helpers that only read: printing and formatting (which shows a class's
 * name), key listing and key tests (which show own keys only). */
const PRINT_HELPER = /^%(util\.|assert\.)/;
const KEYS_HELPER = /^%(obj\.(keys|values|entries|hasOwn)\.|rec\.haskey\.|in\.)/;
/** Node kinds whose operands are only read: printed (console), rendered
 * (`[object Object]`), serialized, or copied into a dynamic value. */
const PRINT_KINDS = new Set(["intrinsic", "toString", "strConcat"]);
const KEYS_KINDS = new Set(["jsonStringify", "dynFrom", "arrHasUndef", "recordKeyGet", "recordOvfKeys"]);
type Mode = "t" | "r" | "w";

const MUTATING_ARR = new Set(["push", "pushSpread", "pop", "shift", "splice", "sort", "typedSort"]);
/** Array intrinsics whose receiver position is transparent. */
const READING_ARR = new Set(["length", "slice", "toReversed", "toSpliced", "with", "toSorted", "join", ...MUTATING_ARR]);
const SPINE_READS = new Set(["length", "slice", "toReversed", "toSpliced", "with", "toSorted", "join"]);

/** Per node kind: the child keys holding a value in a transparent
 * position. */
const TRANSPARENT: Record<string, readonly string[]> = {
  varDecl: ["init"],
  assign: ["value"],
  assignExpr: ["value"],
  return: ["value"],
  exprStmt: ["expr"],
  recordLit: ["fields"],
  arrayLit: ["elems"],
  recordSet: ["obj", "value"],
  fieldSet: ["obj", "value"],
  fieldIncDec: ["obj"],
  fieldGet: ["obj"],
  arrayGet: ["arr"],
  arraySet: ["arr", "value"],
  unionWrap: ["value"],
  unionNarrow: ["value"],
  unionDisc: ["value"],
  unionIsTag: ["value"],
  ternary: ["then", "else_"],
  logical: ["left", "right"],
  nullish: ["left", "right"],
  orDefault: ["left", "right"],
  seqExpr: ["result"],
  toBool: ["operand"],
  isUndef: ["operand"],
  optChain: ["receiver", "body"],
  upcast: ["value"],
  downcast: ["value"],
  callValue: ["args"],
  virtualCall: ["args"],
  new: ["args"],
  awaitExpr: ["value"],
  forOf: ["iterable"],
  throw: ["value"],
  recordKeySet: ["obj", "value"],
  recordKeyDelete: ["obj"],
};

/** How a binding's one use treats the value: a plain read (a field or
 * element read, a length, a loop over it, a truth or null test), a key
 * observer, a print observer, a copy taken from it, or anything else. */
type Use = "read" | "keys" | "print" | "copy" | "other";

interface Site {
  callee: string;
  arg: IrExpr | undefined;
  loc: SrcLoc;
  where: string;
  /** The index of the function body's top-level statement holding it. */
  top: number;
  /** Where the copy lands: a binding (and whether it is a parameter, which
   * no statement assigns), or null. */
  dest: { key: string; param: boolean } | null;
}

/** A dynamic crossing (S125 (c)): "in" copies typed `t` into a dynamic
 * value, "out" copies a dynamic value into typed `t`. `consumed`: the
 * crossing's result is only read at once (nothing holds it). */
interface DynSite extends Site {
  dir: "in" | "out";
  t: IrType;
  consumed: boolean;
  /** An out-crossing that builds (part of) a `return` statement's value. */
  atReturn?: boolean;
  /** An out-crossing into a sequence expression's own temporary: the
   * sequence node, outside which the copy is never read. */
  scope?: unknown;
  /** An out-crossing whose copy (or a part read straight off it)
   * initializes a local: that local, and the statement list holding its
   * declaration with the declaration's index. */
  holder?: { key: string; list: unknown[]; index: number } | undefined;
  /** The crossing's own IR node (the dynamic copy, for an in-crossing). */
  node: IrExpr;
}

/** Does a function body hold a dynamic crossing of a composite or a
 * function value? (The pass's cheap entry test.) */
function hasDynCrossing(n: unknown): boolean {
  if (n === null || typeof n !== "object") return false;
  if (Array.isArray(n)) return n.some(hasDynCrossing);
  const r = n as Record<string, unknown>;
  if (r["kind"] === "dynFrom" || r["kind"] === "dynCheck") {
    const t = (r["kind"] === "dynFrom" ? (r["value"] as IrExpr).type : (r["type"] as IrType)).kind;
    if (t !== "f64" && t !== "string" && t !== "bool" && t !== "dyn" && t !== "jsval" && t !== "undefinedT" && t !== "nullT" && t !== "bytes") return true;
  }
  for (const key of Object.keys(r)) {
    if (key === "type" || key === "loc") continue;
    if (hasDynCrossing(r[key])) return true;
  }
  return false;
}

/** While an out-crossing's copy is alive: the functions that can run,
 * and (when the copy lives inside one node of its own function) that node. */
interface DynWindow {
  fns: Set<string>;
  inside: unknown[] | null;
}

interface Binding {
  uses: Use[];
  /** For each use that READS a part of the value (`b.f`, `b.f.g`,
   * `b[i]`): the part's type and how that part is used. */
  parts: { t: IrType; use: Use; via?: string }[];
  assigns: IrExpr[];
  captured: boolean;
}

const tkey = (t: IrType): string => typeKey(t);

const isComposite = (t: IrType | undefined): boolean =>
  t !== undefined && (t.kind === "record" || t.kind === "object" || t.kind === "array" || t.kind === "union" ||
    t.kind === "map" || t.kind === "set" || t.kind === "promise");

/* ── Dynamic crossings (SEMANTICS.md S125 (c), S014) ──────────────────────
 *
 * The checked-dynamic world (`unknown`, `object`, and `any` outside
 * `--dynamic`) copies at both of its edges: a typed composite entering a
 * dynamic slot is deep-copied (`dynFrom`), a dynamic value cast or checked
 * back out into a typed composite is copied again (`dynCheck`), and a typed
 * function boxed into a dynamic value receives a copy of each composite
 * argument and hands back a copy of a composite result (its call thunk).
 * JavaScript shares the object at every one of them. They are judged here
 * as one more kind of copy, with the width copies' write, identity and
 * ordering machinery. On the dynamic side a write counts when its receiver
 * may be the copy (or the value a copy was taken from: dynAliasClasses),
 * unless the copy's own binding is only read. What can write a dynamic value: the keyed
 * write, Object.assign/defineProperty onto one, the mutating array methods
 * through dynamic dispatch, island property writes and method calls, and
 * every write the program's own functions make (a boxed program function
 * a dynamic call reaches is read here like any other). The runtime library
 * reads the dynamic values it is handed and hands them on to program
 * callbacks; it writes none outside the helpers listed in DYN_WRITER.
 * Under `--dynamic` a dynamic call may reach island code this pass cannot
 * read, so handing it a dynamic value counts as a write. A write whose
 * receiver is a binding holding a value built fresh (JSON.parse, a dynamic
 * literal) changes only that object, which no copy can be (unless the copy
 * was checked out of that very object). Printing a copy at once, testing
 * it, or reading scalars out of it is not an observation: the copy equals
 * the original at that moment. Width tolerance (a cast keeps only the
 * type's own fields) is S009's, not judged here. */

/** Runtime readers of dynamic values: inspection, JSON, and the dynamic
 * helpers that only read or that build a fresh value. */
const DYN_READER = /^(insp\.|json\.|dyn\.(argStr|arrAt|arrLen|errInstanceof|hasKey|hasOwn|iterLive|iterPack|packPush|packPushSpread|packPushSpreadIter|structuredClone|cloneMissing|cloneTransferFail|this|toNumber|toString|toStringCoerce|typeof|objCreateNullProto)$)/;
/** Runtime helpers that write their first (dynamic) argument. */
const DYN_WRITER = /^dyn\.(keySet|assign|assignAll|defineProps)$/;
/** Runtime helpers that answer a fresh dynamic value. */
const DYN_FRESH_LIB = /^(json\.parse|dyn\.(structuredClone|objCreateNullProto|objKeys))$/;
/** Dynamic dispatch: methods that write their receiver, and methods that
 * compare by identity. */
const DYN_MUTATING = new Set(["push", "pop", "shift", "unshift", "reverse", "sort", "splice", "fill", "copyWithin"]);
const DYN_IDENTITY = new Set(["includes", "indexOf", "lastIndexOf"]);
/** Island operations that write an operand or run code that may. */
const JS_WRITING_OPS = new Set(["setProp", "setIdx", "callMethod", "callFn", "callSpread", "construct", "defineGetter", "optCallMethod"]);

/** Methods that only read their receiver (the runtime's Array, String,
 * Number and Object.prototype readers): a call through island dispatch
 * writes nothing itself — a callback it runs is a program function whose
 * own writes are noted where they are. */
const JS_READING_METHODS = new Set([
  "map", "filter", "slice", "concat", "join", "indexOf", "lastIndexOf", "includes", "find", "findIndex", "findLast",
  "findLastIndex", "some", "every", "forEach", "reduce", "reduceRight", "keys", "values", "entries", "toString", "at",
  "flat", "flatMap", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "split", "startsWith", "endsWith",
  "charAt", "charCodeAt", "codePointAt", "substring", "substr", "padStart", "padEnd", "replace", "replaceAll", "match",
  "matchAll", "search", "test", "exec", "hasOwnProperty", "toFixed", "toPrecision", "localeCompare", "repeat",
  "normalize", "toLocaleString", "valueOf", "toSorted", "toReversed", "toSpliced", "with", "getTime", "toISOString",
]);

/** The destructuring helper lowerJsvalBindingPattern and the assignment
 * form build: `new Function("v", ..., "(<pattern> = v); return [...]")`. */
const isPatternHelper = (e: IrExpr): boolean =>
  e.kind === "jsOp" && e.op === "construct" && e.args[0]?.kind === "jsOp" && e.args[0].op === "globalGet" &&
  e.args[0].name === "Function" && e.args.length >= 3 &&
  ((): boolean => {
    const body = e.args[e.args.length - 1]!;
    return body.kind === "jsMarshal" && body.value.kind === "strLit" && /= v\);return \[[^\]]*\];$/.test(body.value.value);
  })();

/** A static of a builtin global that only reads its arguments. */
const staticReadsArgs = (g: string | undefined, m: string): boolean =>
  g === "JSON" || g === "Math" || g === "Number" || g === "String" || g === "Boolean" || g === "Array" ||
  (g === "Object" && /^(keys|values|entries|getOwnPropertyNames|getOwnPropertyDescriptor|getOwnPropertyDescriptors|getPrototypeOf|is|hasOwn|fromEntries|isFrozen|isSealed|isExtensible)$/.test(m));

/** Methods that answer a scalar from their receiver: a call reads it once. */
const JS_SCALAR_METHODS = new Set([
  "join", "toString", "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith", "charAt", "charCodeAt",
  "codePointAt", "toFixed", "toPrecision", "localeCompare", "hasOwnProperty", "test", "search", "toUpperCase",
  "toLowerCase", "trim", "trimStart", "trimEnd", "padStart", "padEnd", "repeat", "substring", "substr", "at",
  "getTime", "toISOString", "valueOf", "some", "every", "findIndex", "findLastIndex",
]);

/** An island-native literal (the one-world lanes' `{...}` / `[...]`). */
const isIslandLit = (e: IrExpr): boolean => e.kind === "jsOp" && (e.op === "objLit" || e.op === "arrLit" || e.op === "objSpread");

const isDynType = (t: IrType | undefined): boolean => t !== undefined && (t.kind === "dyn" || t.kind === "jsval");

export function widthCopyPass(L: Lowerer, functions: IrFunction[]): void {
  const byName = new Map<string, IrFunction>();
  for (const f of functions) byName.set(f.name, f);
  if (![...byName.keys()].some(isCopyHelper) && !functions.some((f) => hasDynCrossing(f.body))) return;

  const classPrefixes = [...L.classes.keys()].map((c) => `%${c}.`);
  const transparentCallee = (name: string): boolean => {
    if (!name.startsWith("%")) return true;
    if (isCopyHelper(name) || TRANSPARENT_HELPER.test(name) || PASS_THROUGH.test(name)) return true;
    return classPrefixes.some((p) => name.startsWith(p));
  };
  const globals = new Set(L.globalsList.map((g) => g.id));
  const bkey = (fn: string, id: string): string => (globals.has(id) ? `g\0${id}` : `${fn}\0${id}`);

  const sites: Site[] = [];
  /** `record:<shape>:<field>` / `record:<shape>:*`, `object:<root class>:<field>`,
   * and array type keys (the spine or its elements written in place). */
  const written = new Map<string, { fn: string; top: number }[]>();
  const ctorWritten = new Set<string>();
  /** Notes a write under `key`, where it happens. */
  const noteWrite = (key: string): void => {
    let at = written.get(key);
    if (!at) written.set(key, (at = []));
    at.push({ fn: curFn, top: curTop });
  };
  const identity = new Set<string>();
  const escaped: { t: IrType; w: boolean; view: boolean }[] = [];
  const escapedKeys = new Set<string>();
  /** `view`: the value escapes only as the argument of a view factory
   * (island-views.ts) — dynamic code reaches it through the view, whose
   * stores are noted as dynamic writes where they are made. */
  const escape = (t: IrType, w: boolean, view = false): void => {
    const k = `${w ? "w" : "r"}${view ? "v" : ""}${tkey(t)}`;
    if (escapedKeys.has(k)) return;
    escapedKeys.add(k);
    escaped.push({ t, w, view });
  };
  /** Dynamic crossings (S125 (c)): every dynFrom of a value that holds a
   * reference, every dynCheck into one, and every typed function boxed
   * into a dynamic value. */
  const dynSites: DynSite[] = [];
  /** Writes to dynamic values: where, and the receiver when one is known. */
  const dynWrites: { fn: string; top: number; recv: IrExpr | null; anc: unknown[]; method?: string }[] = [];
  const noteDynWrite = (recv: IrExpr | null, method?: string): void => {
    // A view's own accessors (island-views.ts) write only the fresh
    // values they build (a keys list, a snapshot); their stores into the
    // typed value are typed writes, noted as such.
    if (/^%view\./.test(curFn)) return;
    dynWrites.push({ fn: curFn, top: curTop, recv, anc: stack.map((e) => e[0]), ...(method !== undefined ? { method } : {}) });
  };
  /** The program compares dynamic values by identity somewhere. */
  let dynIdentity = false;
  /** Typed composites that entered the island as a view or a marshal
   * (U1a): with any dynamic identity operation in the program, each is
   * identity-observed — an island `===`, `includes`, `indexOf`, a Set or
   * Map key may compare it against a copy. Conservative by design. */
  const islandEntered = new Set<string>();
  /** The dynamic operands of those comparisons (null: a comparison whose
   * operands are not followed — a Map/Set keyed by dynamic values). */
  const dynIdentityOps: ({ e: IrExpr; fn: string } | null)[] = [];
  /** The functions handed to each function-value adapter (`%fn.adapt.N`). */
  const adapterArgs = new Map<string, { e: IrExpr; fn: string }[]>();
  /** Can a dynamic call reach code this pass does not read? Without
   * `--dynamic` every dynamic function is a boxed program function (whose
   * body's writes are noted where they are) or a runtime method that only
   * reads its arguments; with it, an island function may be anything, so
   * handing it a dynamic value counts as a write. */
  const opaqueCalls = L.engine;
  /** Per dynamic binding: how each use treats the value ("ro": read at
   * once, a scalar or a test taken from it; "other": anything else). */
  const dynUses = new Map<string, ("ro" | "other")[]>();
  /** Per dynamic binding: each use as OWNERSHIP sees it — read at once,
   * the receiver of a write or a key/element search (with the values the
   * write stores), an out-crossing, or anything else. */
  const ownUses = new Map<string, { use: "ro" | "recv" | "exit" | "other"; stored?: IrExpr[] }[]>();
  /** Where each dynamic binding is used (its function and top-level statement). */
  const useTops = new Map<string, { fn: string; top: number }[]>();
  /** Per typed reference-holding binding: each use as ownership sees it —
   * a scalar read, a write in place (with the values it stores), a loop or
   * print or key listing that hands no reference on, a crossing, or
   * anything else. */
  const typedOwnUses = new Map<string, { ok: boolean; stored?: IrExpr[] }[]>();
  /** Every closure: where it is made, what it captures, and whether it is
   * handed straight to an array callback loop (which runs it before
   * returning and keeps no hold of it). */
  const closureCaptures: { fnName: string; fn: string; captures: string[]; transient: boolean }[] = [];
  /** The reference-holding types a value of type `t` is or contains (a
   * deep copy copies every one of them), and the function types inside
   * it (boxed with a copying thunk). */
  const refsMemo = new Map<string, { refs: IrType[]; fns: (IrType & { kind: "func" })[] }>();
  const refsOf = (t: IrType): { refs: IrType[]; fns: (IrType & { kind: "func" })[] } => {
    const memo = refsMemo.get(tkey(t));
    if (memo) return memo;
    const out = { refs: [] as IrType[], fns: [] as (IrType & { kind: "func" })[] };
    const seen = new Set<string>();
    const walk = (x: IrType): void => {
      const k = tkey(x);
      if (seen.has(k)) return;
      seen.add(k);
      switch (x.kind) {
        case "record": {
          out.refs.push(x);
          const s = L.shapes.get(x.shapeId);
          for (const f of s?.fields ?? []) walk(f.type);
          if (s?.indexValue) walk(s.indexValue);
          return;
        }
        case "object":
          // The only class the boundary admits is an Error, which crosses
          // through the identity cache (one box per error, `===` holds);
          // that its members are copied at the first crossing is S021's.
          return;
        case "union":
          for (const a of L.unions.get(x.unionId)?.arms ?? []) walk(a);
          return;
        case "func":
          // A function's own parameter and result types are its thunk's
          // business (judged per boxing), not part of this value.
          out.fns.push(x);
          return;
        case "promise":
          // Boxed BY REFERENCE (identity is the promise); a composite
          // settled value is converted at the first dynamic read.
          break;
        case "array":
          // `any[]` is the dynamic array's own vector: shared, never copied.
          if (isDynType(x.elem)) return;
          out.refs.push(x);
          break;
        case "map":
        case "set":
          out.refs.push(x);
          break;
        default:
          break;
      }
      for (const v of Object.values(x as Record<string, unknown>)) {
        if (v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") walk(v as IrType);
      }
    };
    walk(t);
    refsMemo.set(tkey(t), out);
    return out;
  };
  const hasRef = (t: IrType): boolean => refsOf(t).refs.length > 0;
  const bindings = new Map<string, Binding>();
  const binding = (k: string): Binding => {
    let b = bindings.get(k);
    if (!b) bindings.set(k, (b = { uses: [], parts: [], assigns: [], captured: false }));
    return b;
  };
  let curFn = "";
  /** In a constructor: its `this` parameter. */
  let curThis: string | null = null;
  /** The top-level statement of the function being visited. */
  let curTop = 0;
  let building = false;
  /** The kinded ancestors of the node being visited, with the key each
   * holds it under. */
  const stack: [Record<string, unknown>, string][] = [];

  const rootOf = (c: string): string => {
    let info = L.classes.get(c);
    while (info?.base) info = info.base;
    return info?.def.name ?? c;
  };

  /** The use a parent of kind `pk` makes of its child under `key`. */
  const useOf = (parent: Record<string, unknown>, key: string): Use => {
    const pk = parent["kind"] as string;
    switch (pk) {
      case "recordGet":
        return key === "obj" && !parent["spreadCopy"] ? "read" : "other";
      // An index-signature read: a key observation, and — when the value
      // it answers is composite — a part of the record read out (whose
      // own uses are followed like a recordGet's).
      case "recordKeyGet":
        return key === "obj" ? "read" : "other";
      case "fieldGet":
      case "arrayGet":
      case "toBool":
      case "isUndef":
      case "unionDisc":
      case "unionIsTag":
      case "forOf":
        return "read";
      case "arrIntrinsic":
        return key === "receiver" && SPINE_READS.has(parent["method"] as string) ? "read" : "other";
      case "bin": {
        const op = parent["op"] as string;
        const other = (key === "left" ? parent["right"] : parent["left"]) as IrExpr;
        const unit = other.type.kind === "undefinedT" || other.type.kind === "nullT" || other.kind === "unitLit";
        return (op === "===" || op === "!==" || op === "==" || op === "!=") && unit ? "read" : "other";
      }
      case "call": {
        const callee = parent["callee"] as string;
        if (isCopyHelper(callee)) return "copy";
        if (HOF_HELPER.test(callee)) return "read";
        // `a.concat(b)` reads both spines into a fresh array; composite
        // elements would be shared by it, so only scalar ones are a read.
        if (/^%arr\.concat\./.test(callee)) {
          const rt = parent["type"] as IrType;
          return rt.kind === "array" && !isComposite(rt.elem) ? "read" : "other";
        }
        if (PRINT_HELPER.test(callee)) return "print";
        if (KEYS_HELPER.test(callee)) return "keys";
        return "other";
      }
      default:
        if (PRINT_KINDS.has(pk)) return "print";
        if (KEYS_KINDS.has(pk)) return "keys";
        return "other";
    }
  };

  /** The composite parts a use of a `t` value hands to other code: an
   * array's elements to a loop, a callback loop or a method building a new
   * array; a record's field values to Object.values/entries. */
  const exposedParts = (t: IrType, parent: Record<string, unknown>, key: string): { t: IrType; via?: string }[] => {
    const pk = parent["kind"];
    if (t.kind === "array") {
      if (!isComposite(t.elem)) return [];
      // A for-of hands each element to its loop variable.
      if (pk === "forOf" && key === "iterable") return [{ t: t.elem, via: bkey(curFn, parent["localId"] as string) }];
      // A callback loop hands each element to its callback's element
      // parameter — followed when the callback is a literal that does not
      // also take the array itself.
      if (pk === "call" && HOF_HELPER.test(parent["callee"] as string)) {
        const reduce = /^%arr\.reduce/.test(parent["callee"] as string);
        const cb = (parent["args"] as IrExpr[]).find((a) => a.kind === "closure");
        const fn = cb?.kind === "closure" ? byName.get(cb.fnName) : undefined;
        const at = reduce ? 1 : 0;
        // filter/find/reduce/flatMap can also hand an element out as (part
        // of) their result, which is not followed.
        const keeps = !/^%arr\.(map|forEach|some|every|findIndex|findLastIndex)\./.test(parent["callee"] as string);
        if (!keeps && fn && fn.params.length <= at + 2 && fn.params[at]) return [{ t: t.elem, via: `${fn.name}\0${fn.params[at]!.localId}` }];
        return [{ t: t.elem }];
      }
      if (pk === "arrIntrinsic" && key === "receiver" && parent["method"] !== "length" && parent["method"] !== "join") return [{ t: t.elem }];
      return [];
    }
    if (t.kind === "record" && pk === "call" && /^%obj\.(values|entries)\./.test(parent["callee"] as string)) {
      const sh = L.shapes.get(t.shapeId);
      return [...(sh?.fields ?? []).map((f) => f.type), ...(sh?.indexValue ? [sh.indexValue] : [])].filter(isComposite).map((x) => ({ t: x }));
    }
    return [];
  };
  /** The first ancestor (from stack index `i` up) that does not just
   * hand the value on: a pass-through check, a conditional's branch, a
   * `&&`/`||`/`??` operand, a sequence's result, an upcast, a union wrap or narrow. */
  const forwardFrom = (i: number): number => {
    while (i > 0) {
      const [anc, key] = stack[i]!;
      const ak = anc["kind"];
      const forwards =
        (ak === "call" && PASS_THROUGH.test(anc["callee"] as string)) ||
        (ak === "ternary" && (key === "then" || key === "else_")) ||
        ((ak === "logical" || ak === "nullish" || ak === "orDefault") && (key === "left" || key === "right")) ||
        (ak === "seqExpr" && key === "result") ||
        ((ak === "upcast" || ak === "downcast" || ak === "unionNarrow" || ak === "unionWrap") && key === "value");
      if (!forwards) break;
      i--;
    }
    return i;
  };
  /** How the kinded ancestor at stack index `i` (and up) uses a DYNAMIC
   * value it holds: "ro" when the value is only read at once — tested,
   * printed, serialized, compared with a scalar, checked out into a typed
   * value (a copy judged on its own), or a member of it read that way —
   * and "other" otherwise. */
  const dynUseAt = (i: number, consuming = false, self: unknown = null): "ro" | "other" => {
    if (i < 0) return "other";
    i = forwardFrom(i);
    /** The node directly under stack entry `j` on the path. */
    const childOf = (j: number): unknown => (j + 1 < stack.length ? stack[j + 1]![0] : self);
    for (;;) {
      const [anc, key] = stack[i]!;
      const ak = anc["kind"];
      // Island forms of the same steps (the one-world lanes): a member
      // read off the value, and the value retyped between dyn and jsval.
      const islandRead = ak === "jsOp" && key === "args" && (anc["op"] === "getProp" || anc["op"] === "getIdx") &&
        (anc["args"] as unknown[])[0] === childOf(i);
      const retype = (ak === "dynFromJsval" && key === "value") || (ak === "jsMarshal" && key === "value" && isDynType((anc["value"] as IrExpr).type));
      if (!((ak === "dynKeyGet" || ak === "dynDestrCheck") && key === "value") && !islandRead && !retype) break;
      if (i === 0) return "other";
      i = forwardFrom(i - 1);
    }
    const [anc, key] = stack[i]!;
    switch (anc["kind"]) {
      case "jsOp": {
        // Island tests and comparisons read the value at once; a method
        // that answers a scalar reads its receiver.
        const op = anc["op"] as string;
        if (["typeof", "truthy", "not", "eq", "neq", "seq", "sneq", "looseEq", "looseNeq"].includes(op)) return "ro";
        if (op === "callMethod" && (anc["args"] as unknown[])[0] === childOf(i) && JS_SCALAR_METHODS.has(anc["name"] as string)) return "ro";
        return "other";
      }
      case "dynCheck":
        // An out-crossing into a reference-holding type copies the value on:
        // for a value crossing in right there, its copy lives on as that one.
        return consuming && refsOf(anc["type"] as IrType).refs.length > 0 ? "other" : "ro";
      case "dynTest":
      case "dynHasKey":
      case "jsonStringify":
        return "ro";
      case "intrinsic":
        return /^console\./.test(anc["name"] as string) ? "ro" : "other";
      case "dynScalarEq": {
        const other = (key === "left" ? anc["right"] : anc["left"]) as IrExpr;
        return isDynType(other.type) ? "other" : "ro";
      }
      case "libCall":
        // An element read or an iteration hands a part of the value on.
        if (/^dyn\.(arrAt|iterLive|iterPack)$/.test(anc["fn"] as string)) return "other";
        return DYN_READER.test(anc["fn"] as string) || PURE_LIB.test(anc["fn"] as string) ? "ro" : "other";
      case "dynInvoke":
        return key === "recv" && anc["method"] === "join" ? "ro" : "other";
      default:
        return "other";
    }
  };
  /** The use a typed binding's reference makes, for ownership (its kinded
   * parent sits at stack index `i`). */
  const typedOwnUseAt = (i: number, t: IrType): { ok: boolean; stored?: IrExpr[] } => {
    i = forwardFrom(i);
    // A member of a literal that crosses right there is the crossing.
    for (let j = i; j >= 0; j--) {
      const [a, k] = stack[j]!;
      if ((a["kind"] === "recordLit" && k === "fields") || (a["kind"] === "arrayLit" && k === "elems")) continue;
      if (j < i && a["kind"] === "dynFrom") return { ok: true };
      break;
    }
    const [anc, key] = stack[i]!;
    const ak = anc["kind"] as string;
    const elemFree = t.kind !== "array" || !hasRef(t.elem);
    if ((ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr")) {
      return { ok: !hasRef(anc["type"] as IrType) };
    }
    if ((ak === "recordSet" || ak === "fieldSet" || ak === "recordKeySet") && key === "obj") return { ok: true, stored: [anc["value"] as IrExpr] };
    if ((ak === "fieldIncDec" && key === "obj") || ak === "toBool" || ak === "isUndef") return { ok: true };
    if (ak === "arraySet" && key === "arr") return { ok: true, stored: [anc["value"] as IrExpr] };
    if (ak === "arrIntrinsic" && key === "receiver") {
      const m = anc["method"] as string;
      // A spread push stores the source's elements, not the source.
      if (m === "pushSpread") return { ok: elemFree };
      if (MUTATING_ARR.has(m)) return { ok: true, stored: anc["args"] as IrExpr[] };
      return { ok: elemFree };
    }
    if (ak === "call" && key === "args" && HOF_HELPER.test(anc["callee"] as string)) return { ok: elemFree };
    if (ak === "forOf" && key === "iterable") return { ok: elemFree };
    // The crossing itself, or the value leaving the function (the call's
    // result is then its only holder).
    if (ak === "dynFrom" || ak === "return") return { ok: true };
    const u = useOf(anc, key);
    return { ok: u === "print" || u === "keys" };
  };
  /** The use a dynamic binding's reference `ref` makes, for ownership
   * (its kinded parent sits at stack index `i`). */
  const ownUseAt = (i: number, ref: unknown): { use: "ro" | "recv" | "exit" | "other"; stored?: IrExpr[] } => {
    const [anc, key] = stack[i]!;
    const ak = anc["kind"];
    if (ak === "dynInvoke" && key === "recv" && (DYN_MUTATING.has(anc["method"] as string) || DYN_IDENTITY.has(anc["method"] as string) || anc["method"] === "join")) {
      return { use: "recv", stored: anc["args"] as IrExpr[] };
    }
    if (ak === "libCall" && key === "args" && /^dyn\.packPush/.test(anc["fn"] as string) && (anc["args"] as unknown[])[0] === ref) {
      return { use: "recv", stored: (anc["args"] as IrExpr[]).slice(1) };
    }
    if (ak === "libCall" && key === "args" && DYN_WRITER.test(anc["fn"] as string) && (anc["args"] as unknown[])[0] === ref) {
      return { use: "recv", stored: (anc["args"] as IrExpr[]).slice(1) };
    }
    if (ak === "dynCheck") return { use: "exit" };
    // Island writes (the one-world lanes): a member or element store into
    // the value, and a mutating method called on it.
    if (ak === "jsOp" && key === "args" && (anc["args"] as unknown[])[0] === ref) {
      const op = anc["op"] as string;
      const args = anc["args"] as IrExpr[];
      if (op === "setProp" || op === "setIdx") return { use: "recv", stored: [args[args.length - 1]!] };
      if (op === "callMethod" && (DYN_MUTATING.has(anc["name"] as string) || DYN_IDENTITY.has(anc["name"] as string) || anc["name"] === "join")) {
        return { use: "recv", stored: args.slice(1) };
      }
    }
    if (ak === "dynFromJsval" || (ak === "jsMarshal" && isDynType((anc["value"] as IrExpr).type))) {
      // Retyped on its way to a check: the exit itself.
      const up = i > 0 ? stack[i - 1]![0] : null;
      if (up && up["kind"] === "dynCheck") return { use: "exit" };
    }
    // A callback loop hands the callback the elements — and the array
    // itself as the third argument, which a callback of fewer parameters
    // never receives.
    if (ak === "dynInvoke" && key === "recv" && /^(forEach|map|filter|some|every|find|findIndex)$/.test(anc["method"] as string)) {
      const cb = (anc["args"] as IrExpr[])[0];
      const f = cb?.kind === "dynFrom" && cb.value.kind === "closure" ? byName.get(cb.value.fnName) : undefined;
      if (f && f.params.length < 3) return { use: "recv", stored: [] };
    }
    return dynUseAt(i, false, ref) === "ro" ? { use: "ro" } : { use: "other" };
  };
  /** The local an out-crossing's copy (or a part read straight off it)
   * initializes, with the statement list its declaration sits in. */
  const holderAt = (i: number): { key: string; list: unknown[]; index: number } | undefined => {
    if (i < 0) return undefined;
    i = forwardFrom(i);
    for (;;) {
      const [anc, key] = stack[i]!;
      const ak = anc["kind"];
      const read = (ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr");
      if (!read || i === 0) break;
      i = forwardFrom(i - 1);
    }
    const [decl, dkey] = stack[i]!;
    if (decl["kind"] !== "varDecl" || dkey !== "init") return undefined;
    let list: unknown[] | undefined;
    if (i === 0) list = byName.get(curFn)?.body as unknown[] | undefined;
    else {
      const [up, ukey] = stack[i - 1]!;
      const v = up[ukey];
      if (Array.isArray(v)) list = v;
    }
    const index = list ? list.indexOf(decl) : -1;
    if (!list || index < 0) return undefined;
    return { key: bkey(curFn, decl["localId"] as string), list, index };
  };
  /** Does the out-crossing whose parent sits at stack index `i` build
   * (part of) a `return` statement's value? */
  const atReturn = (i: number): boolean => {
    while (i >= 0) {
      i = forwardFrom(i);
      const [anc, key] = stack[i]!;
      const ak = anc["kind"];
      if (ak === "return") return true;
      const builds = (ak === "recordLit" && key === "fields") || (ak === "arrayLit" && key === "elems") || (ak === "unionWrap" && key === "value") || (ak === "upcast" && key === "value");
      if (!builds) return false;
      i--;
    }
    return false;
  };
  /** How the ancestors use a TYPED value an out-crossing just built: true
   * when it is consumed at once without anything holding it or a part of
   * it — a scalar read off it, a print, a key listing. */
  const consumedAt = (i: number, t: IrType): boolean => {
    if (i < 0) return false;
    i = forwardFrom(i);
    let part = t;
    for (;;) {
      const [anc, key] = stack[i]!;
      const ak = anc["kind"];
      const read = (ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr");
      if (!read) break;
      part = anc["type"] as IrType;
      if (!hasRef(part)) return true;
      if (i === 0) return false;
      i = forwardFrom(i - 1);
    }
    const [anc, key] = stack[i]!;
    const use = useOf(anc, key);
    return use === "print" || use === "keys" || (use === "read" && exposedParts(part, anc, key).length === 0);
  };
  /** Visits `n`; `mode` says where a VALUE found directly here sits in
   * its nearest kinded parent: a transparent position ("t"), a read-only
   * observer's operand ("r"), or anything else ("w" — an observer that
   * may also write). `parent`/`pkey` name that parent and the key. */
  const visit = (n: unknown, mode: Mode, parent: Record<string, unknown> | null, pkey: string): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x, mode, parent, pkey);
      return;
    }
    const r = n as Record<string, unknown>;
    const k = r["kind"];
    if (typeof k !== "string") {
      // A plain carrier object (a recordLit field entry): its members keep
      // the parent's position.
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc" || key === "name") continue;
        visit(r[key], mode, parent, pkey);
      }
      return;
    }
    const t = r["type"] as IrType | undefined;
    // A composite VALUE in a non-transparent position escapes.
    if (mode !== "t" && t !== undefined && r["loc"] !== undefined && isComposite(t) && k !== "slotUndef") {
      // (`%jsin.union.N` is the per-arm tag switch whose composite arms
      // enter as views or marshals, each visited in its own body: its
      // argument escapes the way a view factory's does.)
      const viewArg = (parent !== null && parent["kind"] === "call" && pkey === "args" && /^%(view|jsin\.union)\.\d+$/.test(parent["callee"] as string)) ||
        /^%view\./.test(curFn);
      if (viewArg || (parent !== null && parent["kind"] === "jsMarshal")) {
        islandEntered.add(tkey(t));
        if (t.kind === "union") for (const a of L.unions.get(t.unionId)?.arms ?? []) islandEntered.add(tkey(a));
      }
      escape(t, mode === "w", viewArg);
    }
    if (k === "varRef" && parent) {
      // A pass-through check answers its argument: the use is its own
      // parent's.
      let i = stack.length - 1;
      i = forwardFrom(i);
      const [up, upKey] = stack[i]!;
      const b = binding(bkey(curFn, r["localId"] as string));
      b.uses.push(useOf(up, upKey));
      // A chain of reads off the binding: the part it ends at, and that
      // part's own use.
      let j = i;
      let part: IrType | null = null;
      for (;;) {
        const [anc, key] = stack[j]!;
        const ak = anc["kind"];
        const read = (ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr");
        if (!read) break;
        part = anc["type"] as IrType;
        j--;
        if (j >= 0) j = forwardFrom(j);
        if (j < 0) break;
      }
      if (part !== null && isComposite(part)) b.parts.push({ t: part, use: j >= 0 ? useOf(stack[j]![0], stack[j]![1]) : "other" });
      // A loop over an array, a callback loop, or a method building a new
      // array from it hands its ELEMENTS on: they are parts used anyhow.
      if (j >= 0) {
        for (const x of exposedParts(part ?? (r["type"] as IrType), stack[j]![0], stack[j]![1])) {
          b.parts.push(x.via !== undefined ? { t: x.t, use: "other", via: x.via } : { t: x.t, use: "other" });
        }
      }
    }
    if (k === "varRef" && parent && isDynType(t)) {
      const key = bkey(curFn, r["localId"] as string);
      let u = dynUses.get(key);
      if (!u) dynUses.set(key, (u = []));
      u.push(dynUseAt(stack.length - 1, false, r));
      let o = ownUses.get(key);
      if (!o) ownUses.set(key, (o = []));
      o.push(ownUseAt(stack.length - 1, r));
      let ut = useTops.get(key);
      if (!ut) useTops.set(key, (ut = []));
      ut.push({ fn: curFn, top: curTop });
    }
    if (k === "varRef" && parent && t !== undefined && !isDynType(t) && hasRef(t)) {
      const key = bkey(curFn, r["localId"] as string);
      let o = typedOwnUses.get(key);
      if (!o) typedOwnUses.set(key, (o = []));
      o.push(typedOwnUseAt(stack.length - 1, t));
    }
    if (k === "closure") {
      closureCaptures.push({
        fnName: r["fnName"] as string, fn: curFn, captures: (r["captures"] as string[] | undefined) ?? [],
        // (A typed array loop, or a dynamic one: `xs.forEach(cb)` on a
        // dynamic array boxes `cb` and the runtime runs it the same way.)
        transient: parent !== null && ((parent["kind"] === "call" && pkey === "args" && HOF_HELPER.test(parent["callee"] as string)) ||
          (parent["kind"] === "dynFrom" && stack.length >= 2 && stack[stack.length - 2]![0]["kind"] === "dynInvoke" && stack[stack.length - 2]![1] === "args" &&
            /^(forEach|map|filter|some|every|find|findIndex)$/.test(stack[stack.length - 2]![0]["method"] as string))),
      });
    }
    noteDynNode(r, parent, pkey);
    let kids: readonly string[] = Object.hasOwn(TRANSPARENT, k) ? TRANSPARENT[k]! : [];
    let rest: Mode = PRINT_KINDS.has(k) || KEYS_KINDS.has(k) ? "r" : "w";
    switch (k) {
      case "varDecl":
        if (r["init"]) binding(bkey(curFn, r["localId"] as string)).assigns.push(r["init"] as IrExpr);
        break;
      case "assign":
      case "assignExpr":
        binding(bkey(curFn, r["localId"] as string)).assigns.push(r["value"] as IrExpr);
        break;
      case "incDec":
        binding(bkey(curFn, r["localId"] as string)).assigns.push(r as unknown as IrExpr);
        break;
      case "closure":
        for (const c of (r["captures"] as string[] | undefined) ?? []) binding(bkey(curFn, c)).captured = true;
        break;
      case "call": {
        const callee = r["callee"] as string;
        const args = r["args"] as IrExpr[];
        if (isCopyHelper(callee)) sites.push({ callee, arg: args[0], loc: r["loc"] as SrcLoc, where: curFn, top: curTop, dest: destOf(parent, pkey, r) });
        if (ARG_MUTATOR.test(callee) && args[0]) {
          noteWrite(tkey(args[0].type));
          kids = ["args"];
        } else if (transparentCallee(callee)) kids = ["args"];
        else if (PRINT_HELPER.test(callee) || KEYS_HELPER.test(callee)) rest = "r";
        break;
      }
      case "recordGet":
        // A spread's field read lists the source's keys: a key observer.
        if (!r["spreadCopy"]) kids = ["obj"];
        else rest = "r";
        break;
      case "mapIntrinsic":
      case "setIntrinsic": {
        // A Map's values and a Set's elements are stored and handed back
        // as they are; set/add/delete/clear write the container itself.
        const m = r["method"] as string;
        if ((m === "set" || m === "add" || m === "delete" || m === "clear") && !building) noteWrite(tkey((r["receiver"] as IrExpr).type));
        kids = ["receiver", "args"];
        break;
      }
      case "bytesNew":
        // Typed-array construction reads the source array's numbers.
        rest = "r";
        break;
      case "libCall":
        // The data-in, data-out library families read their arguments
        // (`path.join(...)` over a string array, say); they never write one.
        if (/^(math|num|number|string|str|insp|json|path|sym|os|text|strdec)\./.test(r["fn"] as string)) rest = "r";
        break;
      case "recordSet":
        if (!building) noteWrite(`record:${r["shapeId"] as string}:${r["field"] as string}`);
        break;
      case "recordKeySet":
      case "recordKeyDelete":
        if (!building) noteWrite(`record:${r["shapeId"] as string}:*`);
        break;
      case "fieldSet":
      case "fieldIncDec":
      {
        // Construction is a constructor writing its OWN instance; a
        // constructor writing another object is an ordinary write.
        const key = `object:${rootOf(r["className"] as string)}:${r["field"] as string}`;
        const obj = r["obj"] as IrExpr;
        if (curThis !== null && obj.kind === "varRef" && obj.localId === curThis) ctorWritten.add(key);
        else noteWrite(key);
      }
        break;
      case "arraySet":
        noteWrite(tkey((r["arr"] as IrExpr).type));
        break;
      case "arrIntrinsic": {
        const m = r["method"] as string;
        const recv = r["receiver"] as IrExpr;
        if (MUTATING_ARR.has(m) && !building) noteWrite(tkey(recv.type));
        if ((m === "indexOf" || m === "includes") && recv.type.kind === "array") identity.add(tkey(recv.type.elem));
        if (READING_ARR.has(m)) kids = m === "push" || m === "with" ? ["receiver", "args"] : ["receiver"];
        else if (m === "indexOf" || m === "includes") kids = ["receiver", "args"];
        break;
      }
      case "bin": {
        const op = r["op"] as string;
        if (op === "===" || op === "!==" || op === "==" || op === "!=") {
          const l = r["left"] as IrExpr;
          const rt = r["right"] as IrExpr;
          const unit = (e: IrExpr): boolean =>
            e.type.kind === "undefinedT" || e.type.kind === "nullT" || e.kind === "unitLit";
          if (!unit(l) && !unit(rt)) {
            for (const side of [l, rt]) {
              if (!isComposite(side.type)) continue;
              identity.add(tkey(side.type));
              if (side.type.kind === "union") for (const a of L.unions.get(side.type.unionId)?.arms ?? []) identity.add(tkey(a));
            }
          }
          kids = ["left", "right"];
        }
        break;
      }
      default:
        break;
    }
    for (const key of Object.keys(r)) {
      if (key === "type" || key === "loc") continue;
      stack.push([r, key]);
      visit(r[key], kids.includes(key) ? "t" : rest, r, key);
      stack.pop();
    }
  };
  /** Dynamic crossings and dynamic writes at node `r` (S125 (c)). */
  function noteDynNode(r: Record<string, unknown>, parent: Record<string, unknown> | null, pkey: string): void {
    const loc = r["loc"] as SrcLoc;
    // A variadic callback's adapter (restFuncAdapter) calls the boxed
    // function with its arguments crossed, and checks its result back:
    // copies GH #22 already vets (the callback may only read the count and
    // the scalar positions; any other use refuses by name).
    if (/^%fn\.adapt\.\d+\.impl$/.test(curFn) && (isAdapterCall(r) || (parent !== null && pkey === "args" && isAdapterCall(parent)))) return;
    switch (r["kind"]) {
      case "call": {
        const callee = r["callee"] as string;
        const a0 = (r["args"] as IrExpr[])[0];
        if (/^%fn\.adapt\.\d+$/.test(callee) && a0) {
          let at = adapterArgs.get(callee);
          if (!at) adapterArgs.set(callee, (at = []));
          at.push({ e: a0, fn: curFn });
        }
        return;
      }
      case "dynFrom": {
        const v = r["value"] as IrExpr;
        const { refs, fns } = refsOf(v.type);
        if (refs.length === 0 && fns.length === 0) return;
        dynSites.push({
          dir: "in", callee: "%dyn.from", arg: v, t: v.type, loc, where: curFn, top: curTop, node: r as unknown as IrExpr,
          dest: destOf(parent, pkey, r),
          // A source of Object.assign hands on only its own property values.
          consumed: (stack.length > 0 && dynUseAt(stack.length - 1, true, r) === "ro") ||
            (parent !== null && parent["kind"] === "libCall" && pkey === "args" && /^dyn\.assign(All)?$/.test(parent["fn"] as string) &&
              (parent["args"] as unknown[]).indexOf(r) > 0 && refsOf(v.type).refs.every((x) => tkey(x) === tkey(v.type))),
          atReturn: stack.length > 0 && atReturn(stack.length - 1),
        });
        return;
      }
      case "dynCheck": {
        const t = r["type"] as IrType;
        const { refs, fns } = refsOf(t);
        if (refs.length === 0 && fns.length === 0) return;
        dynSites.push({
          dir: "out", callee: "%dyn.check", arg: r["value"] as IrExpr, t, loc, where: curFn, top: curTop, node: r as unknown as IrExpr,
          dest: destOf(parent, pkey, r), consumed: consumedAt(stack.length - 1, t), atReturn: atReturn(stack.length - 1),
          scope: parent?.["kind"] === "varDecl" && pkey === "init" && stack.length >= 2 && stack[stack.length - 2]![0]["kind"] === "seqExpr" &&
            stack[stack.length - 2]![1] === "stmts" ? stack[stack.length - 2]![0] : undefined,
          holder: holderAt(stack.length - 1),
        });
        return;
      }
      case "libCall": {
        const fn = r["fn"] as string;
        const args = r["args"] as IrExpr[];
        if (DYN_WRITER.test(fn)) noteDynWrite(args[0] ?? null);
        return;
      }
      case "dynInvoke": {
        const m = r["method"] as string;
        if (DYN_MUTATING.has(m)) noteDynWrite(r["recv"] as IrExpr, m);
        if (DYN_IDENTITY.has(m)) {
          dynIdentity = true;
          dynIdentityOps.push({ e: r["recv"] as IrExpr, fn: curFn });
          for (const a of r["args"] as IrExpr[]) if (isDynType(a.type)) dynIdentityOps.push({ e: a, fn: curFn });
        }
        if (opaqueCalls && (r["args"] as IrExpr[]).some(passesDyn)) noteDynWrite(null);
        return;
      }
      case "dynCall":
        if (opaqueCalls && (r["args"] as IrExpr[]).some(passesDyn)) noteDynWrite(null);
        return;
      case "dynScalarEq":
        if (isDynType((r["left"] as IrExpr).type) && isDynType((r["right"] as IrExpr).type)) {
          dynIdentity = true;
          dynIdentityOps.push({ e: r["left"] as IrExpr, fn: curFn }, { e: r["right"] as IrExpr, fn: curFn });
        }
        return;
      case "mapIntrinsic":
      case "setIntrinsic": {
        const rt = (r["receiver"] as IrExpr).type;
        if ((rt.kind === "map" && isDynType(rt.key)) || (rt.kind === "set" && isDynType(rt.elem))) {
          dynIdentity = true;
          dynIdentityOps.push(null);
        }
        return;
      }
      case "jsOp": {
        const op = r["op"] as string;
        const args = r["args"] as IrExpr[];
        // A property write or a method call writes (or may write) its
        // receiver; a call writes what it is handed (the callee itself
        // and marshaled scalars hand nothing).
        // On the one-world lanes (sharedDynamic) no engine code runs: a
        // method reached through dynamic dispatch is the runtime's (which
        // writes only its receiver and, for the assign-like statics, the
        // values it is handed) or a boxed program function (whose writes
        // are noted where they are), so the write is pinned to the
        // receiver and to each dynamic value handed on.
        if (L.sharedDynamic && !opaqueCalls && (op === "setProp" || op === "setIdx" || op === "callMethod" || op === "optCallMethod" || op === "defineGetter")) {
          const g0 = args[0]?.kind === "jsOp" && args[0].op === "globalGet" ? args[0].name : undefined;
          const readOnly = (op === "callMethod" || op === "optCallMethod") &&
            (JS_READING_METHODS.has(r["name"] as string) || (g0 !== undefined && staticReadsArgs(g0, r["name"] as string)) || (g0 === "Object" && r["name"] === "assign"));
          if (!readOnly) noteDynWrite(args[0] ?? null, op === "callMethod" || op === "optCallMethod" ? (r["name"] as string) : undefined);
          // A method may write what it is handed (Object.assign's sources
          // are read, its target written — the receiver there is the
          // Object global); a store only stores.
          if (op === "callMethod" || op === "optCallMethod") {
            const g = args[0]?.kind === "jsOp" && args[0].op === "globalGet" ? args[0].name : undefined;
            const m = r["name"] as string;
            if (g === "Object" && m === "assign") noteDynWrite(args[1] ?? null);
            // A reading method reads what it is handed too: a callback it
            // runs is a program function whose own writes are noted where
            // they are (a receiver whose own member of that name is a
            // program function is the same case).
            else if (!readOnly && !(g !== undefined && staticReadsArgs(g, m))) {
              for (const a of args.slice(1)) if (isDynType(a.type) && passesJs(a)) noteDynWrite(a);
            }
          }
        } else if (L.sharedDynamic && !opaqueCalls && JS_WRITING_OPS.has(op)) {
          // The lowering's own destructuring helpers only read their source.
          if (!(op === "callFn" && args[0] !== undefined && isPatternHelper(args[0]))) {
            for (const a of args.slice(1)) if (isDynType(a.type) && passesJs(a)) noteDynWrite(a);
          }
        } else if (op === "setProp" || op === "setIdx" || op === "callMethod" || op === "optCallMethod" || op === "defineGetter") noteDynWrite(null);
        else if (JS_WRITING_OPS.has(op) && args.slice(1).some(passesJs)) noteDynWrite(null);
        if (op === "eq" || op === "neq") {
          dynIdentity = true;
          dynIdentityOps.push(null);
          // An operand that is a typed composite's view (or marshal) is an
          // identity test on that type: a copy of it compares unequal where
          // JavaScript's one object compares equal (U1a).
          for (const a of args) {
            const viewed = a.kind === "call" && /^%view\.\d+$/.test(a.callee) ? a.args[0] : a.kind === "jsMarshal" ? a.value : undefined;
            if (viewed !== undefined && isComposite(viewed.type)) {
              identity.add(tkey(viewed.type));
              if (viewed.type.kind === "union") for (const arm of L.unions.get(viewed.type.unionId)?.arms ?? []) identity.add(tkey(arm));
            }
          }
        }
        return;
      }
      case "jsMarshal":
        // A checked-dynamic value marshaled into the island is the same
        // value there (S014's jsMarshal amendment): island code may write it.
        // On the one-world lanes there is no engine: the marshal is the
        // same value under the island type, written where island ops write.
        if (isDynType((r["value"] as IrExpr).type) && !(L.sharedDynamic && !opaqueCalls)) noteDynWrite(null);
        return;
      default:
        return;
    }
  }
  /** restFuncAdapter's call: `dynCall(dynFrom(f), args...)` over its
   * captured function `f.0` — or the out-crossing of that call's result. */
  function isAdapterCall(n: Record<string, unknown>): boolean {
    const c = (n["kind"] === "dynCheck" ? n["value"] : n) as Record<string, unknown>;
    if (c["kind"] !== "dynCall") return false;
    const callee = c["callee"] as IrExpr;
    return callee.kind === "dynFrom" && callee.value.kind === "varRef" && callee.value.localId === "f.0";
  }
  /** An island argument that hands a VALUE to the callee — not a
   * marshaled scalar. */
  function passesJs(a: IrExpr): boolean {
    if (!isDynType(a.type)) return hasRef(a.type);
    if (a.kind === "jsMarshal") return isDynType(a.value.type) || hasRef(a.value.type) || a.value.type.kind === "func";
    return a.kind !== "strLit" && a.kind !== "numLit";
  }
  /** A dynamic argument that hands a dynamic VALUE to the callee — not a
   * boxed scalar or a boxed function. */
  function passesDyn(a: IrExpr): boolean {
    if (!isDynType(a.type)) return false;
    if (a.kind === "dynFrom") return hasRef(a.value.type);
    return true;
  }
  /** The binding a copy lands in: a local or global it initializes or is
   * assigned to, or the parameter of a directly called program function
   * it is passed as. */
  function destOf(parent: Record<string, unknown> | null, pkey: string, call: Record<string, unknown>): Site["dest"] {
    if (!parent) return null;
    const pk = parent["kind"];
    if ((pk === "varDecl" && pkey === "init") || (pk === "assign" && pkey === "value")) {
      return { key: bkey(curFn, parent["localId"] as string), param: false };
    }
    if (pk === "call" && pkey === "args") {
      const callee = parent["callee"] as string;
      if (isCopyHelper(callee) || PASS_THROUGH.test(callee) || !transparentCallee(callee)) return null;
      const f = byName.get(callee);
      const i = (parent["args"] as unknown[]).indexOf(call);
      const p = f?.params[i];
      return p ? { key: `${callee}\0${p.localId}`, param: true } : null;
    }
    return null;
  }
  for (const f of functions) {
    if (isCopyHelper(f.name) || PASS_THROUGH.test(f.name)) continue;
    curFn = f.name;
    curThis = f.name.endsWith(".constructor") ? (f.params[0]?.localId ?? null) : null;
    building = BUILDER.test(f.name) || ARG_MUTATOR.test(f.name);
    f.body.forEach((st, i) => {
      curTop = i;
      visit(st, "t", null, "");
    });
  }
  // Key questions a lowering answered statically (a folded `in`) leave no
  // reference to the value in the IR: they count for every value of the
  // type, the copy's binding included.
  const foldedKeys = new Set<string>();
  for (const t of L.keyObservedTypes) {
    escape(t, false);
    foldedKeys.add(tkey(t));
  }
  // `instanceof` likewise, asking for the class (printDiffer's question).
  const foldedClass = new Set<string>();
  for (const t of L.classObservedTypes) {
    escape(t, false);
    foldedClass.add(tkey(t));
  }

  // Everything an escaped value can reach counts as observed; as written
  // too when the observer may write.
  const reach = new Set<string>();
  const reachW = new Set<string>();
  let into = reach;
  const reachType = (t: IrType): void => {
    const k = tkey(t);
    if (into.has(k)) return;
    into.add(k);
    switch (t.kind) {
      case "record": {
        const s = L.shapes.get(t.shapeId);
        for (const f of s?.fields ?? []) reachType(f.type);
        if (s?.indexValue) reachType(s.indexValue);
        return;
      }
      case "object": {
        for (let c = L.classes.get(t.className); c; c = c.base ?? undefined) {
          for (const ft of c.fields.values()) reachType(ft);
        }
        return;
      }
      case "union":
        for (const a of L.unions.get(t.unionId)?.arms ?? []) reachType(a);
        return;
      default: {
        for (const v of Object.values(t as Record<string, unknown>)) {
          if (v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") reachType(v as IrType);
        }
      }
    }
  };
  for (const e of escaped) reachType(e.t);
  into = reachW;
  // A view's stores into its typed value run only for a dynamic store made
  // through it (noted as a dynamic write where it is made): a program
  // with no dynamic write anywhere writes through no view (U1b).
  const viewWritesLive = dynWrites.length > 0;
  for (const e of escaped) if (e.w && (!e.view || viewWritesLive)) reachType(e.t);
  // The same, without view-factory escapes (S125 (c)'s judgment: see escape).
  const reachWDyn = new Set<string>();
  into = reachWDyn;
  for (const e of escaped) if (e.w && !e.view) reachType(e.t);

  // A constructor that hands `this` to anything other than its own field
  // accesses (or its base constructor) lets the instance escape before
  // construction finishes: its writes count, and `new` is not fresh.
  const ctorLeaks = new Set<string>();
  for (const [name, info] of L.classes) {
    const ctor = byName.get(`%${name}.constructor`);
    if (!ctor) continue;
    const thisId = ctor.params[0]?.localId;
    if (thisId === undefined) continue;
    let leaks = false;
    const scan = (n: unknown, ok: boolean): void => {
      if (leaks || n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) scan(x, ok);
        return;
      }
      const r = n as Record<string, unknown>;
      if (r["kind"] === "varRef" && r["localId"] === thisId && !ok) {
        leaks = true;
        return;
      }
      // A closure capturing `this` (an arrow field, a callback handed to a
      // timer) holds the instance past construction.
      if (r["kind"] === "closure" && ((r["captures"] as string[] | undefined) ?? []).includes(thisId)) {
        leaks = true;
        return;
      }
      const k = r["kind"];
      const baseCtor = k === "call" && typeof r["callee"] === "string" && (r["callee"] as string).endsWith(".constructor");
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        const safe = ((k === "fieldGet" || k === "fieldSet" || k === "fieldIncDec") && key === "obj") || (baseCtor && key === "args");
        scan(r[key], safe);
      }
    };
    scan(ctor.body, false);
    if (leaks) ctorLeaks.add(rootOf(info.def.name));
  }
  const siteInCtor = new Set<string>();
  for (const s of sites) {
    const m = /^%(.+)\.constructor$/.exec(s.where);
    if (m) siteInCtor.add(rootOf(m[1]!));
  }

  /** The own keys of a value of this type: its declared fields in render
   * order, and whether an index signature's overflow follows them (null:
   * not a keyed value). */
  const ownKeys = (t: IrType): { declared: string[]; overflow: boolean } | null => {
    if (t.kind === "object") {
      const c = L.classes.get(t.className);
      return c ? { declared: c.def.fields.map((f) => f.name).filter((n) => !n.startsWith("%")), overflow: false } : null;
    }
    if (t.kind !== "record") return null;
    const sh = L.shapes.get(t.shapeId);
    if (!sh) return null;
    return { declared: sh.declaredOrder ?? sh.fields.map((f) => f.name), overflow: sh.indexValue !== undefined };
  };
  const fieldNames = (t: IrType): string[] => {
    if (t.kind === "record") return (L.shapes.get(t.shapeId)?.fields ?? []).map((f) => f.name);
    if (t.kind === "object") return [...(L.classes.get(t.className)?.fields.keys() ?? [])];
    return [];
  };
  /** Is a value of type `t` written — any of `fields` (default: all) for a
   * record or class, in place for an array — anywhere a copy taken at
   * `site` could still be held? A write in the same module initializer
   * (which runs once), in a top-level statement before the copy's, has
   * already happened; everything else (a write in any other function, a
   * closure, a later statement) counts. */
  let judgingDyn = false;
  const isWritten = (t: IrType, fields: string[] | undefined, site: Site | null, during: Set<string> | null = null, deadAfter: { fn: string; top: number } | null = null): boolean => {
    if ((judgingDyn ? reachWDyn : reachW).has(tkey(t))) return true;
    // A TRANSIENT copy (handed to a parameter that never lets it go) dies
    // when the call returns: only a write in a function the call can run
    // (`during`) can meet it. A copy whose binding is last read in
    // top-level statement `deadAfter.top` of its function cannot see a
    // write that function makes in a later statement.
    const counts = (key: string): boolean =>
      (written.get(key) ?? []).some((w) =>
        // Judging a dynamic crossing (S125 (c)): a view accessor's own write
        // (island-views.ts) runs only for a store through that view, which
        // is noted as a dynamic write on its receiver where it is made.
        !((judgingDyn || !viewWritesLive) && /^%view\./.test(w.fn)) &&
        !(deadAfter !== null && w.fn === deadAfter.fn && w.top > deadAfter.top) &&
        (during !== null ? during.has(w.fn) : !(site !== null && w.fn === site.where && /^%init\.\d+$/.test(w.fn) && w.top < site.top)));
    const fs = fields ?? fieldNames(t);
    if (t.kind === "object") {
      const root = rootOf(t.className);
      const ctorCounts = ctorLeaks.has(root) || siteInCtor.has(root);
      return counts(`object:${root}:*`) ||
        fs.some((f) => counts(`object:${root}:${f}`) || (ctorCounts && ctorWritten.has(`object:${root}:${f}`)));
    }
    if (t.kind === "record") {
      return counts(`record:${t.shapeId}:*`) || fs.some((f) => counts(`record:${t.shapeId}:${f}`));
    }
    return counts(tkey(t));
  };
  /** The source fields a copy into `to` reads: the target's own fields for
   * a plain record target; every field (and element) for an array or an
   * index-signature target, or an index-signature source. */
  const copiedFields = (from: IrType, to: IrType): string[] | undefined => {
    if (to.kind !== "record") return undefined;
    const ts = L.shapes.get(to.shapeId);
    const fs = from.kind === "record" ? L.shapes.get(from.shapeId) : undefined;
    if (!ts || ts.indexValue || ts.tuple || fs?.indexValue) return undefined;
    return fieldNames(to);
  };
  /** Do the copy's own keys differ from the original's? A target field
   * the source lacks is optional and holds undefined in the copy, which no
   * key observer reports (SEMANTICS.md S091). An index-signature target
   * captures every source key: its own declared fields first, then the
   * source's other declared fields and its overflow, in order (S031). */
  const keysDiffer = (from: IrType, to: IrType): boolean => {
    if (from.kind === "array" && to.kind === "array") return false;
    if (from.kind === "record" && to.kind === "array") return false; // tuple → array: the same elements
    const a = ownKeys(from);
    const b = ownKeys(to);
    if (a === null || b === null) return true;
    const same = (x: string[], y: string[]): boolean => x.join("\0") === y.join("\0");
    // An index-signature target captures every source key, so the copy
    // holds the same keys; that a hybrid shape lists its declared fields
    // before its overflow, whatever the insertion order, is S031's.
    if (b.overflow) return false;
    // The overflow drops with the width.
    if (a.overflow) return true;
    return !same(b.declared.filter((n) => a.declared.includes(n)), a.declared);
  };
  /** Does printing tell them apart — their keys, or a class's name? */
  const printDiffer = (from: IrType, to: IrType): boolean =>
    keysDiffer(from, to) || (from.kind === "object") !== (to.kind === "object") ||
    (from.kind === "object" && to.kind === "object" && from.className !== to.className);
  const fresh = (e: IrExpr | undefined): boolean => {
    if (!e) return false;
    if (e.kind === "recordLit" || e.kind === "arrayLit") return true;
    // An array a typed-array method builds (bytes hold numbers, never an
    // existing array).
    if (e.kind === "bytesIntrinsic" && e.type.kind === "array") return true;
    if (e.kind === "call" && BUILDER.test(e.callee)) return true;
    // A new array of the receiver's elements (map/filter/slice/...): the
    // SPINE is fresh (its elements are judged as the nested copies they are).
    if (e.kind === "call" && /^%arr\.(map|filter|flatMap|filterNarrow|concat)\./.test(e.callee)) return true;
    if (e.kind === "arrIntrinsic" && ["slice", "toSorted", "toReversed", "toSpliced", "with"].includes(e.method)) return true;
    if (e.kind === "new" && e.type.kind === "object") return !ctorLeaks.has(rootOf(e.type.className));
    // GH #118: a direct call of a program function that hands out only
    // values nothing else holds once it returns.
    if (e.kind === "call" && returnsFresh(e.callee)) return true;
    return false;
  };
  /** A literal whose every part is a literal or a scalar, through union
   * wraps: nothing but the literal itself references any of its parts. */
  const deepFresh = (e: IrExpr | undefined): boolean => {
    if (!e) return false;
    switch (e.kind) {
      case "numLit": case "strLit": case "boolLit": case "unitLit":
        return true;
      case "unionWrap":
        return deepFresh(e.value);
      case "arrayLit":
        return !(e.spreads?.length) && e.elems.every((x) => deepFresh(x));
      case "recordLit":
        return e.fields.every((f) => deepFresh(f.value));
      default:
        return false;
    }
  };
  /** GH #118 (chess.js history()): does every `return` of this program
   * function answer a value no one else holds after the call — a fresh
   * value, a fresh-returning call, or a local of its own that it built
   * from a fresh value and only ever filled, read and returned (never
   * captured, reassigned, stored, passed on or handed out by a method that
   * answers its receiver)? Writes the function made to it happened before
   * the call returned, so a copy the caller takes is the only reference
   * left — as unobservable as a copy of a literal. Direct calls only: the
   * callee is exactly this function. */
  const freshMemo = new Map<string, boolean>();
  function returnsFresh(name: string): boolean {
    const memo = freshMemo.get(name);
    if (memo !== undefined) return memo;
    freshMemo.set(name, false); // recursion: assume not
    const f = byName.get(name);
    if (!f || f.async || f.generator) return false;
    const returns: IrExpr[] = [];
    let open = false;
    const owned = new Map<string, number>(); // local id -> fresh varDecl count
    const scanRet = (n: unknown): void => {
      if (open || n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) scanRet(x);
        return;
      }
      const r = n as Record<string, unknown>;
      if (r["kind"] === "return") {
        const v = r["value"] as IrExpr | null | undefined;
        if (!v) open = true;
        else returns.push(v);
      }
      if (r["kind"] === "varDecl" && typeof r["localId"] === "string") {
        owned.set(r["localId"] as string, (owned.get(r["localId"] as string) ?? 0) + (r["init"] && fresh(r["init"] as IrExpr) ? 1 : 1000));
      }
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        scanRet(r[key]);
      }
    };
    scanRet(f.body);
    if (open || returns.length === 0) return false;
    const locals = new Set<string>();
    for (const v of returns) {
      if (v.kind === "varRef" && owned.get(v.localId) === 1 && !f.params.some((p) => p.localId === v.localId)) {
        locals.add(v.localId);
        continue;
      }
      if (!fresh(v)) return false;
    }
    // Every reference to an owned local: a receiver of a method that does
    // not answer it, an element/field read or write, a loop over it, a
    // truth or undefined test, or the `return` itself.
    const SAFE_ARR = new Set(["length", "push", "pop", "shift", "slice", "join", "indexOf", "includes", "toReversed", "toSorted", "toSpliced", "with"]);
    let ok = true;
    const scanUse = (n: unknown, parent: Record<string, unknown> | null, pkey: string): void => {
      if (!ok || n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) scanUse(x, parent, pkey);
        return;
      }
      const r = n as Record<string, unknown>;
      const k = r["kind"];
      if (k === "closure" && ((r["captures"] as string[] | undefined) ?? []).some((c) => locals.has(c))) {
        ok = false;
        return;
      }
      if ((k === "assign" || k === "assignExpr" || k === "incDec") && locals.has(r["localId"] as string)) {
        ok = false;
        return;
      }
      if (k === "varRef" && locals.has(r["localId"] as string)) {
        const pk = parent?.["kind"];
        const objRead = (pk === "recordGet" && !parent!["spreadCopy"]) || pk === "recordSet" || pk === "fieldGet" || pk === "fieldSet";
        const safe =
          (pk === "arrIntrinsic" && pkey === "receiver" && SAFE_ARR.has(parent!["method"] as string)) ||
          ((pk === "arrayGet" || pk === "arraySet") && pkey === "arr") ||
          (objRead && pkey === "obj") ||
          (pk === "forOf" && pkey === "iterable") ||
          ((pk === "isUndef" || pk === "toBool") && pkey === "operand") ||
          (pk === "return" && pkey === "value");
        if (!safe) ok = false;
        return;
      }
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        scanUse(r[key], r, key);
      }
    };
    scanUse(f.body, null, "");
    freshMemo.set(name, ok);
    return ok;
  }
  /** The source binding when the copy reads a plain binding. */
  const sourceBinding = (s: Site): Binding | null => {
    if (s.arg?.kind !== "varRef") return null;
    return bindings.get(bkey(s.where, s.arg.localId)) ?? null;
  };
  /** Nothing else holds the original: its binding was assigned once, from a
   * fresh value, is never captured, and is only read or copied from. */
  const sourceIsSole = (s: Site): boolean => {
    if (fresh(s.arg)) return true;
    const b = sourceBinding(s);
    if (!b || b.captured || b.assigns.length !== 1 || !fresh(b.assigns[0])) return false;
    return b.uses.every((u) => u === "read" || u === "copy" || u === "keys" || u === "print");
  };
  /** The copy's own binding, when every use of the copy is one of it. */
  const destBinding = (s: Site): Binding | null => {
    if (s.dest === null) return null;
    const b = bindings.get(s.dest.key);
    if (!b) return s.dest.param ? { uses: [], parts: [], assigns: [], captured: false } : null;
    if (b.captured) return null;
    // A parameter has no assignment; a local or global exactly this one.
    if (b.assigns.length !== (s.dest.param ? 0 : 1)) return null;
    return b;
  };
  /** Does a value of type `t` contain (or is it) a value of type `inner`? */
  const containsMemo = new Map<string, Set<string>>();
  const contains = (t: IrType, inner: IrType): boolean => {
    let set = containsMemo.get(tkey(t));
    if (!set) {
      const saved = into;
      into = new Set<string>();
      reachType(t);
      set = into;
      into = saved;
      containsMemo.set(tkey(t), set);
    }
    return set.has(tkey(inner));
  };

  /** Why a value of type `t`, held in binding `b` (whose every use is
   * known), lets the program tell a nested copy `p` from its original —
   * through the binding's own uses when `t` is the copy's type, and
   * through the parts read off it (followed into the loop variables and
   * callback parameters they are handed to). Null: it cannot. */
  const judgeValue = (b: Binding, t: IrType, p: { from: IrType; to: IrType }, depth: number): string | null => {
    if (depth > 6) return UNKNOWN;
    const isCopy = tkey(t) === tkey(p.to);
    if (isCopy || contains(t, p.to)) {
      if (b.uses.includes("print") && printDiffer(p.from, p.to)) return KEYS;
      if ((b.uses.includes("keys") || foldedKeys.has(tkey(p.to))) && keysDiffer(p.from, p.to)) return KEYS;
      if (foldedClass.has(tkey(p.to)) && printDiffer(p.from, p.to)) return KEYS;
      if (b.uses.includes("other")) return UNKNOWN;
    }
    for (const part of b.parts) {
      if (!contains(part.t, p.to)) continue;
      if (part.via !== undefined) {
        const vb = bindings.get(part.via) ?? { uses: [], parts: [], assigns: [], captured: false };
        if (vb.captured || vb.assigns.length > 0) return UNKNOWN;
        const why = judgeValue(vb, part.t, p, depth + 1);
        if (why) return why;
        continue;
      }
      if (part.use === "other") return UNKNOWN;
      if (tkey(part.t) === tkey(p.to)) {
        if (part.use === "print" && printDiffer(p.from, p.to)) return KEYS;
        if (part.use === "keys" && keysDiffer(p.from, p.to)) return KEYS;
      } else if (part.use !== "read" && printDiffer(p.from, p.to)) {
        return KEYS;
      }
    }
    return null;
  };

  /** The functions a call of `fn` can run before it returns, and whether
   * that set is OPEN (`suspends`): one of them can suspend (async, a
   * generator) and let other code run, or calls into the runtime, the host
   * or the embedded engine where program callbacks may run (an emitter's
   * `emit`, a stream write, `process.exit`'s listeners, an assert running
   * its function, a promise executor ...). Only the library families on
   * PURE_LIB — data in, data out — are closed; every other libCall family,
   * and every node kind that crosses into the runtime, opens the set.
   * Conservative: a call through a function value can run any function the
   * program makes a value of; a virtual call any method of that name. */
  const valueFns = new Set<string>();
  {
    const scanFns = (n: unknown): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) scanFns(x);
        return;
      }
      const r = n as Record<string, unknown>;
      if (r["kind"] === "closure") valueFns.add(r["fnName"] as string);
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        scanFns(r[key]);
      }
    };
    for (const f of functions) scanFns(f.body);
  }
  const reachMemo = new Map<string, { fns: Set<string>; suspends: boolean }>();
  const callReach = (fn: string): { fns: Set<string>; suspends: boolean } => {
    const memo = reachMemo.get(fn);
    if (memo) return memo;
    const fns = new Set<string>();
    let suspends = false;
    const queue = [fn];
    const add = (name: string): void => {
      if (!fns.has(name)) {
        fns.add(name);
        queue.push(name);
      }
    };
    while (queue.length > 0) {
      const name = queue.pop()!;
      fns.add(name);
      const f = byName.get(name);
      if (!f) {
        suspends = true;
        continue;
      }
      if (f.async || f.generator) suspends = true;
      const scan = (n: unknown): void => {
        if (n === null || typeof n !== "object") return;
        if (Array.isArray(n)) {
          for (const x of n) scan(x);
          return;
        }
        const r = n as Record<string, unknown>;
        const k = r["kind"];
        if (k === "call") add(r["callee"] as string);
        else if (k === "closure") add(r["fnName"] as string);
        else if (k === "new") add(`%${r["className"] as string}.constructor`);
        else if (k === "virtualCall") {
          for (const other of byName.keys()) if (other.endsWith(`.${r["method"] as string}`)) add(other);
        } else if (k === "callValue" || k === "dynCall" || k === "dynInvoke") {
          for (const v of valueFns) add(v);
        } else if (k === "awaitExpr" || k === "awaitUnionExpr" || k === "yieldExpr" || k === "genResume") {
          suspends = true;
        } else if (k === "libCall") {
          // (The dynamic readers run no program code either.)
          if (!PURE_LIB.test(r["fn"] as string) && !DYN_READER.test(r["fn"] as string)) suspends = true;
        } else if (k === "intrinsic") {
          if (!/^console\./.test(r["name"] as string)) suspends = true;
        } else if (k === "arrIntrinsic") {
          // A comparator is a function value.
          if (["sort", "toSorted", "typedSort"].includes(r["method"] as string)) for (const v of valueFns) add(v);
        } else if (RUNTIME_KINDS.has(k as string)) {
          suspends = true;
        }
        for (const key of Object.keys(r)) {
          if (key === "type" || key === "loc") continue;
          scan(r[key]);
        }
      };
      scan(f.body);
    }
    const out = { fns, suspends };
    reachMemo.set(fn, out);
    return out;
  };

  // The (from, to) pairs a helper copies, its nested helpers' included.
  const pairsOf = (name: string, acc: Map<string, { from: IrType; to: IrType }>): void => {
    const f = byName.get(name);
    if (!f || f.params.length === 0) return;
    const key = `${tkey(f.params[0]!.type)}=>${tkey(f.returnType)}`;
    if (acc.has(key)) return;
    acc.set(key, { from: f.params[0]!.type, to: f.returnType });
    const inner = (n: unknown): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) inner(x);
        return;
      }
      const r = n as Record<string, unknown>;
      if (r["kind"] === "call" && isCopyHelper(r["callee"] as string)) pairsOf(r["callee"] as string, acc);
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        inner(r[key]);
      }
    };
    inner(f.body);
  };

  const UNKNOWN = "\0unknown";
  const WRITE_TO = "the program writes to values of the slot's type, and a write through the copy would not reach the original";
  const WRITE_FROM = "the program writes to the original's fields, and the copy would not see the write";
  const IDENTITY = "the program compares values of these types by identity, and the copy is a different object";
  const KEYS = "the program prints, serializes, lists the keys of or tests the class of the copy, which carries only the slot's own fields and class";
  const reported = new Set<string>();
  for (const s of sites) {
    const pairs = [...(() => {
      const acc = new Map<string, { from: IrType; to: IrType }>();
      pairsOf(s.callee, acc);
      return acc;
    })().values()];
    const top = pairs[0];
    if (!top) continue;
    const sole = sourceIsSole(s);
    // The copy is the ONLY reference left: the source is fresh, or a sole
    // binding this copy is the one use of. Writes and identity cannot
    // tell then; only the copy's keys can.
    const unique = fresh(s.arg) || (sole && sourceBinding(s)?.uses.length === 1);
    // A literal built only of literals and scalars (`[undefined, {}, {
    // t: [] }]`): no part has another reference, so a nested copy is as
    // unobservable to writes and identity as the top one (U1b — the JS
    // lane's option-table and case-list literals crossing into island
    // slots); only its keys can tell.
    const allFresh = deepFresh(s.arg);
    const db = destBinding(s);
    const uses = db?.uses ?? null;
    // The copy's PARTS are followed through the binding too, when nothing
    // hands the whole copy anywhere else.
    const partsKnown = db !== null && !db.uses.includes("other");
    // The copy cannot outlive the call it is passed to: a parameter whose
    // value never leaves (no "other" use). Its parts outlive it when one is
    // used otherwise or handed to a binding that lets it go.
    const calleeReach = s.dest?.param === true ? callReach(s.dest.key.split("\0")[0]!) : null;
    const transient = calleeReach !== null && !calleeReach.suspends && partsKnown;
    const partsTransient = transient && db!.parts.every((pt) =>
      pt.via === undefined ? pt.use !== "other" : !(bindings.get(pt.via)?.uses ?? []).includes("other"));
    let reason: string | null = null;
    let blame = top;
    for (const p of pairs) {
      const isTop = p === top;
      let why: string | null = null;
      // By type, flow-insensitively: the fallback wherever the binding
      // does not account for every use.
      const byType = (): string | null =>
        isWritten(p.to, undefined, s) ? WRITE_TO
        : identity.has(tkey(p.to)) ? IDENTITY
        : reach.has(tkey(p.to)) && printDiffer(p.from, p.to) ? KEYS
        : null;
      if (isTop) {
        if (uses !== null) {
          // The copy's uses, one by one ("other" may print as well).
          if ((uses.includes("print") || uses.includes("other")) && printDiffer(p.from, p.to)) why = KEYS;
          else if ((uses.includes("keys") || foldedKeys.has(tkey(p.to))) && keysDiffer(p.from, p.to)) why = KEYS;
          else if (foldedClass.has(tkey(p.to)) && printDiffer(p.from, p.to)) why = KEYS;
          else if (uses.includes("other") && !unique) why = byType();
        } else if (!unique) {
          why = byType();
        } else if (reach.has(tkey(p.to)) && printDiffer(p.from, p.to)) {
          why = KEYS;
        }
      } else if (allFresh) {
        if (reach.has(tkey(p.to)) && printDiffer(p.from, p.to)) why = KEYS;
      } else {
        const j = partsKnown ? judgeValue(db!, top.to, p, 0) : UNKNOWN;
        why = j === UNKNOWN ? byType() : j;
      }
      // (Comparing ORIGINALS involves no copy: a copy's static type is the
      // slot's, so a test that could meet one is on the slot's type.)
      if (!why && !(isTop && sole) && !allFresh && isWritten(p.from, copiedFields(p.from, p.to), s, (isTop ? transient : partsTransient) ? calleeReach!.fns : null)) why = WRITE_FROM;
      if (why) {
        reason = why;
        blame = p;
        break;
      }
    }
    if (!reason) continue;
    const at = `${s.loc.file}:${s.loc.start}`;
    if (reported.has(at)) continue;
    reported.add(at);
    const nested = blame !== top ? ` (inside it, '${L.fmt(blame.from)}' into '${L.fmt(blame.to)}')` : "";
    L.pushDiag(
      unsupportedDiag(
        "SC1090",
        s.loc,
        `a '${L.fmt(top.from)}' value where '${L.fmt(top.to)}' is expected${nested}: the slot would hold a COPY where JavaScript shares the object, and ${reason} (SEMANTICS.md S125)`,
        `give the slot the value's own type ('${L.fmt(top.from)}'), or make the function generic over it (<T extends ${L.fmt(top.to)}>(x: T) keeps the object)`,
      ),
    );
  }
  judgeDynSites();

  /** Which dynamic values may be the same object: a unification
   * (Steensgaard-style, flow- and field-insensitive) over the program's
   * dynamic values. Bindings, parameters, results, the dynamic fields of
   * typed values, and every value built fresh are nodes; an assignment, an
   * argument, a return, a capture, a store into a dynamic container (a
   * keyed write, a push) or a read out of one (a member, an element) puts
   * both sides in one class. Everything the analysis does not follow — a
   * dynamic call, a runtime function that is not a known reader or writer,
   * a throw, the parameters and results of functions used as values, any
   * expression kind not modelled here — meets in one UNKNOWN class. A copy
   * is a fresh node of its own; a crossing never joins the two sides (that
   * is what a copy is), except through the dynamic fields of the typed
   * value, which are shared. */
  function dynAliasClasses(): {
    same: (a: IrExpr, fa: string, b: IrExpr, fb: string) => boolean;
    holders: (e: IrExpr, fn: string) => string[];
    callees: (e: IrExpr, fn: string) => string[] | null;
  } {
    // Function values flow like dynamic ones, so a call through a function
    // value reaches the functions that can flow to its callee.
    const tracked = (t: IrType | undefined): boolean => t !== undefined && (isDynType(t) || t.kind === "func");
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      let c = x;
      while (c !== r) {
        const n = parent.get(c)!;
        parent.set(c, r);
        c = n;
      }
      return r;
    };
    const members = new Map<string, string[]>();
    let changed = false;
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      parent.set(ra, rb);
      const ma = members.get(ra) ?? [ra];
      const mb = members.get(rb) ?? [rb];
      members.set(rb, mb.concat(ma));
      members.delete(ra);
      changed = true;
    };
    const membersOf = (x: string): string[] => {
      const r = find(x);
      return members.get(r) ?? [r];
    };
    /** Calls through function values: the callee's node, the nodes of
     * its tracked arguments (null: untracked), and the call's own node. */
    const valueCalls: { callee: string; args: (string | null)[]; result: string }[] = [];
    const UNKNOWN = "\0unknown";
    let fresh = 0;
    const nodeOf = new Map<unknown, string>();
    const isDyn = (e: IrExpr | undefined): boolean => e !== undefined && tracked(e.type);
    /** The nodes of the dynamic fields a typed value of type `t` carries. */
    const dynFields = (t: IrType, out: string[] = [], seen = new Set<string>()): string[] => {
      const k = tkey(t);
      if (seen.has(k)) return out;
      seen.add(k);
      if (t.kind === "record") {
        const sh = L.shapes.get(t.shapeId);
        for (const f of sh?.fields ?? []) {
          if (tracked(f.type)) out.push(`r:${t.shapeId}:${f.name}`);
          else dynFields(f.type, out, seen);
        }
        if (sh?.indexValue) {
          if (tracked(sh.indexValue)) out.push(`r:${t.shapeId}:*`);
          else dynFields(sh.indexValue, out, seen);
        }
      } else if (t.kind === "object") {
        for (let c = L.classes.get(t.className); c; c = c.base ?? undefined) {
          for (const [n, ft] of c.fields) {
            if (tracked(ft)) out.push(`o:${rootOf(t.className)}:${n}`);
            else dynFields(ft, out, seen);
          }
        }
      } else if (t.kind === "union") {
        for (const a of L.unions.get(t.unionId)?.arms ?? []) dynFields(a, out, seen);
      } else if (t.kind === "array" || t.kind === "map" || t.kind === "set" || t.kind === "promise") {
        const inner = t.kind === "array" ? t.elem : t.kind === "map" ? t.value : t.kind === "set" ? t.elem : t.inner;
        if (tracked(inner)) out.push(`c:${k}`);
        else dynFields(inner, out, seen);
      }
      return out;
    };
    const dynFieldsMemo = new Map<string, string[]>();
    const dynFieldsOf = (t: IrType): string[] => {
      let m = dynFieldsMemo.get(tkey(t));
      if (!m) dynFieldsMemo.set(tkey(t), (m = dynFields(t)));
      return m;
    };
    /** Typed expressions whose dynamic fields this walk follows: built
     * here (literals, constructors, checked out of a dynamic value), read
     * out of a value it follows, or handed on. */
    const TYPED_PRODUCERS = new Set([
      "varRef", "recordLit", "arrayLit", "recordGet", "fieldGet", "arrayGet", "recordKeyGet", "unionWrap", "unionNarrow",
      "upcast", "downcast", "ternary", "logical", "nullish", "orDefault", "seqExpr", "dynCheck", "call", "new",
      "virtualCall", "callValue", "closure", "arrIntrinsic",
    ]);
    const fieldNode = (e: Record<string, unknown>): string | null => {
      const k = e["kind"];
      if (k === "recordGet" || k === "recordSet") return `r:${e["shapeId"] as string}:${e["field"] as string}`;
      if (k === "recordKeyGet" || k === "recordKeySet") return `r:${e["shapeId"] as string}:*`;
      if (k === "fieldGet" || k === "fieldSet") return `o:${rootOf(e["className"] as string)}:${e["field"] as string}`;
      return null;
    };
    const paramKey = (callee: string, i: number): string | null => {
      const f = byName.get(callee);
      const p = f?.params[i];
      return p ? bkey(callee, p.localId) : null;
    };
    /** The node of a dynamic expression (evaluating it for its effects). */
    const node = (e: IrExpr, fn: string): string => {
      const memo = nodeOf.get(e);
      if (memo !== undefined) return memo;
      const r = e as unknown as Record<string, unknown>;
      let n: string;
      switch (e.kind) {
        case "varRef":
          n = bkey(fn, e.localId);
          break;
        case "closure":
          walk(r, fn, null, true);
          n = `\0fn:${e.fnName}`;
          break;
        case "callValue": {
          n = `\0f${fresh++}`;
          valueCallSite(r, fn, n);
          break;
        }
        case "dynKeyGet":
          walk(e.key, fn, null);
          n = node(e.value, fn);
          break;
        case "dynDestrCheck":
        case "dynFromJsval":
          n = node(e.value, fn);
          break;
        case "jsOp":
          if ((e.op === "getProp" || e.op === "getIdx") && e.args[0] && isDyn(e.args[0])) {
            n = node(e.args[0], fn);
            for (const a of e.args.slice(1)) walk(a, fn, null);
          } else if (e.op === "callFn" && e.args[0] !== undefined && isPatternHelper(e.args[0]) && e.args[1] && isDyn(e.args[1])) {
            // The bound values are parts of the source.
            n = node(e.args[1], fn);
            for (const a of e.args.slice(2)) walk(a, fn, null);
          } else if ((e.op === "callMethod" || e.op === "optCallMethod") && e.args[0] && isDyn(e.args[0])) {
            // dynInvoke's rule: a method's result is (a part of) its
            // receiver or of the values it is handed.
            n = node(e.args[0], fn);
            for (const a of e.args.slice(1)) {
              if (isDyn(a)) union(n, node(a, fn));
              else walk(a, fn, null);
            }
          } else if (e.op === "arrLit" || e.op === "objLit" || e.op === "objSpread") {
            // A new value holding what it is built from.
            n = `\0f${fresh++}`;
            for (const x of e.args) {
              if (isDyn(x)) union(n, node(x, fn));
              else walk(x, fn, null);
            }
          } else {
            walk(r, fn, null, true);
            n = UNKNOWN;
          }
          break;
        case "ternary":
          walk(e.cond, fn, null);
          n = node(e.then, fn);
          union(n, node(e.else_, fn));
          break;
        case "logical":
        case "nullish":
        case "orDefault": {
          const l = r["left"] as IrExpr;
          const rt = r["right"] as IrExpr;
          n = isDyn(l) ? node(l, fn) : `\0f${fresh++}`;
          if (!isDyn(l)) walk(l, fn, null);
          if (isDyn(rt)) union(n, node(rt, fn));
          else walk(rt, fn, null);
          break;
        }
        case "seqExpr":
          walk(e.stmts, fn, null);
          n = node(e.result, fn);
          break;
        case "dynFrom": {
          // A copy: a node of its own, sharing only the typed value's
          // dynamic fields.
          n = `\0f${fresh++}`;
          walk(e.value, fn, null);
          for (const f of dynFields(e.value.type)) union(n, f);
          break;
        }
        case "dynArrLit":
          n = `\0f${fresh++}`;
          for (const x of e.elems) {
            if (isDyn(x)) union(n, node(x, fn));
            else walk(x, fn, null);
          }
          break;
        case "dynObjLit":
          n = `\0f${fresh++}`;
          for (const f of e.fields ?? []) {
            walk(f.key, fn, null);
            if (isDyn(f.value)) union(n, node(f.value, fn));
            else walk(f.value, fn, null);
          }
          break;
        case "call": {
          if (PASS_THROUGH.test(e.callee) && e.args[0] && isDyn(e.args[0])) {
            n = node(e.args[0], fn);
            for (const a of e.args.slice(1)) walk(a, fn, null);
            break;
          }
          walk(r, fn, null, true);
          n = byName.has(e.callee) ? `\0ret:${e.callee}` : UNKNOWN;
          break;
        }
        case "libCall":
          if (DYN_FRESH_LIB.test(e.fn)) {
            // Builds a new value from what it reads.
            for (const a of e.args) {
              if (isDynType(a.type)) node(a, fn);
              else walk(a, fn, null);
            }
            n = `\0f${fresh++}`;
          } else if (DYN_READER.test(e.fn) || PURE_LIB.test(e.fn)) {
            // A reader answers its argument or a part of it.
            n = `\0f${fresh++}`;
            for (const a of e.args) {
              if (isDynType(a.type)) union(n, node(a, fn));
              else walk(a, fn, null);
            }
          } else {
            walk(r, fn, null, true);
            n = UNKNOWN;
          }
          break;
        case "dynInvoke":
          walk(r, fn, null, true);
          n = node(e.recv, fn);
          break;
        case "recordGet":
        case "recordKeyGet":
        case "fieldGet": {
          walk(r, fn, null, true);
          n = fieldNode(r) ?? UNKNOWN;
          break;
        }
        default:
          walk(r, fn, null, true);
          n = UNKNOWN;
      }
      nodeOf.set(e, n);
      return n;
    };
    function valueCallSite(r: Record<string, unknown>, fn: string, result: string): void {
      const callee = r["callee"] as IrExpr;
      const args = (r["args"] as IrExpr[]).map((a) => {
        if (tracked(a.type)) return node(a, fn);
        walk(a, fn, null);
        return null;
      });
      valueCalls.push({ callee: tracked(callee.type) ? node(callee, fn) : UNKNOWN, args, result });
    }
    /** Walks `x` for its flows; `into` names the node a dynamic value found
     * here flows to (null: it escapes, unless its parent is modelled).
     * `children`: walk only the children of the kinded node `x`. */
    function walk(x: unknown, fn: string, into: string | null, children = false): void {
      if (x === null || typeof x !== "object") return;
      if (Array.isArray(x)) {
        for (const y of x) walk(y, fn, into);
        return;
      }
      const r = x as Record<string, unknown>;
      const k = r["kind"];
      if (typeof k !== "string") {
        for (const key of Object.keys(r)) if (key !== "type" && key !== "loc" && key !== "name") walk(r[key], fn, into);
        return;
      }
      const e = r as unknown as IrExpr;
      if (!children && r["type"] !== undefined && tracked(r["type"] as IrType)) {
        const n = node(e, fn);
        union(n, into ?? UNKNOWN);
        return;
      }
      // A typed value made where this walk cannot see its dynamic fields
      // filled (a runtime result, an awaited or iterated value, a generator
      // step): those fields meet UNKNOWN.
      if (!children && r["type"] !== undefined && r["loc"] !== undefined && !TYPED_PRODUCERS.has(k)) {
        for (const f of dynFieldsOf(r["type"] as IrType)) union(f, UNKNOWN);
      }
      // A binding something other than a declaration or an assignment
      // fills (a loop variable, a catch binding, a pattern): its values are
      // not followed.
      if (typeof r["localId"] === "string" && k !== "varRef" && k !== "varDecl" && k !== "assign" && k !== "assignExpr" && k !== "incDec") {
        union(bkey(fn, r["localId"] as string), UNKNOWN);
      }
      const sub = (key: string, to: string | null): void => walk(r[key], fn, to);
      switch (k) {
        case "callValue":
          valueCallSite(r, fn, `\0f${fresh++}`);
          return;
        case "varDecl":
          sub("init", bkey(fn, r["localId"] as string));
          return;
        case "assign":
        case "assignExpr":
          sub("value", bkey(fn, r["localId"] as string));
          return;
        case "return":
          sub("value", `\0ret:${fn}`);
          return;
        case "exprStmt": {
          const ex = r["expr"] as IrExpr;
          if (tracked(ex.type)) node(ex, fn);
          else walk(ex, fn, null);
          return;
        }
        case "call": {
          const callee = r["callee"] as string;
          const args = r["args"] as IrExpr[];
          args.forEach((a, i) => walk(a, fn, byName.has(callee) ? paramKey(callee, i) : null));
          return;
        }
        case "closure": {
          const g = byName.get(r["fnName"] as string);
          ((r["captures"] as string[] | undefined) ?? []).forEach((c, i) => {
            const gc = g?.captures?.[i];
            if (gc) union(bkey(fn, c), bkey(g!.name, gc.localId));
            else union(bkey(fn, c), UNKNOWN);
          });
          return;
        }
        case "recordLit": {
          const shapeId = (r["type"] as IrType & { shapeId?: string }).shapeId;
          for (const f of (r["fields"] as { name: string; value: IrExpr }[]) ?? []) {
            walk(f.value, fn, shapeId !== undefined ? `r:${shapeId}:${f.name}` : null);
          }
          return;
        }
        case "recordSet":
        case "recordKeySet":
        case "fieldSet": {
          const fnode = fieldNode(r);
          for (const key of Object.keys(r)) {
            if (key === "type" || key === "loc") continue;
            walk(r[key], fn, key === "value" ? fnode : null);
          }
          return;
        }
        case "dynCheck":
          // A copy out: the typed value shares only its dynamic fields.
          {
            const v = r["value"] as IrExpr;
            const n = node(v, fn);
            for (const f of dynFields(r["type"] as IrType)) union(n, f);
          }
          return;
        case "dynTest":
        case "dynHasKey":
        case "jsonStringify":
        case "dynScalarEq":
        case "dynIterN":
          // Readers.
          for (const key of Object.keys(r)) {
            if (key === "type" || key === "loc") continue;
            const v = r[key];
            if (v && typeof v === "object" && !Array.isArray(v) && tracked((v as IrExpr).type)) node(v as IrExpr, fn);
            else walk(v, fn, null);
          }
          return;
        case "intrinsic":
          if (/^console\./.test(r["name"] as string)) {
            for (const a of r["args"] as IrExpr[]) {
              if (isDynType(a.type)) node(a, fn);
              else walk(a, fn, null);
            }
            return;
          }
          break;
        case "libCall": {
          const lf = r["fn"] as string;
          const args = r["args"] as IrExpr[];
          if (DYN_WRITER.test(lf) && args[0] && tracked(args[0].type)) {
            // A store into the first argument.
            const t = node(args[0], fn);
            for (const a of args.slice(1)) {
              if (tracked(a.type)) union(t, node(a, fn));
              else walk(a, fn, null);
            }
            return;
          }
          if (DYN_READER.test(lf) || PURE_LIB.test(lf)) {
            for (const a of args) {
              if (isDynType(a.type)) node(a, fn);
              else walk(a, fn, null);
            }
            return;
          }
          break;
        }
        case "dynInvoke": {
          const m = r["method"] as string;
          const recv = node(r["recv"] as IrExpr, fn);
          const args = r["args"] as IrExpr[];
          if (m === "sort") {
            // A comparator is called with elements, never stored; a boxed
            // one already met UNKNOWN where it was boxed.
            for (const a of args) {
              if (tracked(a.type)) node(a, fn);
              else walk(a, fn, null);
            }
            return;
          }
          if (DYN_MUTATING.has(m) || DYN_IDENTITY.has(m) || m === "join" || m === "slice" || m === "at" || m === "concat") {
            // Elements stored into (or read out of) the receiver.
            for (const a of args) {
              if (tracked(a.type)) union(recv, node(a, fn));
              else walk(a, fn, null);
            }
            return;
          }
          if (/^(forEach|map|filter|some|every|find|findIndex)$/.test(m)) {
            // The callback's parameters receive the elements (and the
            // receiver itself); its result joins the receiver's class.
            for (const a of args) {
              const g = a.kind === "dynFrom" && a.value.kind === "closure" ? byName.get(a.value.fnName) : undefined;
              if (g) {
                walk((a as IrExpr & { kind: "dynFrom" }).value, fn, null);
                for (const p of g.params) if (tracked(p.type)) union(recv, bkey(g.name, p.localId));
                union(recv, `\0ret:${g.name}`);
              } else if (tracked(a.type)) {
                union(node(a, fn), UNKNOWN);
                union(recv, UNKNOWN);
              } else walk(a, fn, null);
            }
            return;
          }
          union(recv, UNKNOWN);
          for (const a of args) walk(a, fn, null);
          return;
        }
        default:
          break;
      }
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        walk(r[key], fn, null);
      }
    }
    // The functions every call of which this walk sees as a direct `call`
    // (whose arguments it joins to the parameters, and whose returns to the
    // call's value). Every other function — used as a value, a constructor
    // (`new`), a method (virtual calls, `super`), an async function or a
    // generator (their results reach the caller through a promise or an
    // iterator) — is called by code the walk does not follow.
    const direct = new Set<string>();
    {
      const scan = (n: unknown): void => {
        if (n === null || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(scan);
        const r = n as Record<string, unknown>;
        if (r["kind"] === "call") direct.add(r["callee"] as string);
        for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
      };
      for (const f of functions) scan(f.body);
    }
    for (const f of functions) walk(f.body, f.name, null);
    // To a fixpoint: a function some code this walk does not follow can
    // call (its value met UNKNOWN, or it is not reached only by direct
    // calls and calls through values) has its parameters and its result in
    // UNKNOWN; a call through a value whose callee class is known joins
    // the arguments to each function's parameters and its result.
    const notFollowed = (f: IrFunction): boolean =>
      (!direct.has(f.name) && !valueFns.has(f.name)) || !!f.async || !!f.generator || f.name.endsWith(".constructor") ||
      classPrefixes.some((pre) => f.name.startsWith(pre)) ||
      (valueFns.has(f.name) && find(`\0fn:${f.name}`) === find(UNKNOWN));
    do {
      changed = false;
      for (const f of functions) {
        if (!notFollowed(f)) continue;
        for (const p of f.params) if (tracked(p.type)) union(bkey(f.name, p.localId), UNKNOWN);
        union(`\0ret:${f.name}`, UNKNOWN);
      }
      for (const c of valueCalls) {
        if (find(c.callee) === find(UNKNOWN)) {
          for (const a of c.args) if (a !== null) union(a, UNKNOWN);
          union(c.result, UNKNOWN);
          continue;
        }
        for (const m of membersOf(c.callee)) {
          if (!m.startsWith("\0fn:")) continue;
          const g = byName.get(m.slice(4));
          if (!g) continue;
          c.args.forEach((a, i) => {
            const p = g.params[i];
            if (a !== null && p && tracked(p.type)) union(a, bkey(g.name, p.localId));
          });
          union(c.result, `\0ret:${g.name}`);
        }
      }
    } while (changed);
    return {
      holders: (e, fn) => membersOf(node(e, fn)).filter((m) => !m.startsWith("\0f") && !m.startsWith("\0ret:")),
      callees: (e, fn) => {
        const n = node(e, fn);
        if (find(n) === find(UNKNOWN)) return null;
        return membersOf(n).filter((m) => m.startsWith("\0fn:")).map((m) => m.slice(4));
      },
      same: (a, fa, b, fb) => {
        const na = node(a, fa);
        const nb = node(b, fb);
        return find(na) === find(nb);
      },
    };
  }

  /** S125 (c): every dynamic crossing the program could observe refuses
   * by name. */
  function judgeDynSites(): void {
    if (dynSites.length === 0) return;
    const DYN_WRITE_TO = "the program writes to dynamic values, and a write through the copy would not reach the original";
    const DYN_WRITE_FROM = "the program writes to dynamic values, and the copy would not see the write";
    /** A record type with no member named `m` and no index signature. */
    const recordLacks = (t: IrType, m: string): boolean => {
      if (t.kind !== "record") return false;
      const sh = L.shapes.get(t.shapeId);
      return sh !== undefined && sh.indexValue === undefined && !sh.fields.some((f) => f.name === m);
    };
    const DYN_SAME = "the program compares dynamic values by identity, and the copy is a different object";
    const ORIG_WRITTEN = "the program writes to values of the original's type, and the copy would not see the write";
    const COPY_WRITTEN = "the program writes to values of the copy's type, and a write through the copy would not reach the dynamic value";
    const COPY_IDENTITY = "the program compares values of the copy's type by identity, and the copy is a different object";
    const unwrap = (e: IrExpr | undefined): IrExpr | undefined => {
      // (jsMarshal of a dynamic value is the same value retyped — one world.)
      while (e && ((e.kind === "call" && PASS_THROUGH.test(e.callee)) || e.kind === "upcast" || e.kind === "downcast" || e.kind === "dynDestrCheck" || e.kind === "dynFromJsval" ||
        (e.kind === "jsMarshal" && isDynType(e.value.type)))) {
        e = e.kind === "call" ? e.args[0] : e.value;
      }
      return e;
    };
    /** A binding assigned exactly once, never captured, with that value. */
    const onlyValue = (fn: string, id: string): IrExpr | null => {
      const b = bindings.get(bkey(fn, id));
      return b && !b.captured && b.assigns.length === 1 ? b.assigns[0]! : null;
    };
    /** A typed value no one else holds ALL THE WAY DOWN (a deep copy
     * copies every part): a literal whose reference-holding members are
     * themselves such values, a new array of scalars, or a binding
     * initialized with one whose only use is this. */
    const deepFresh = (e: IrExpr | undefined, fn: string, depth = 0): boolean => {
      e = unwrap(e);
      if (!e || depth > 8) return false;
      if (!hasRef(e.type)) return true;
      switch (e.kind) {
        case "recordLit":
          return e.fields.every((f) => deepFresh(f.value, fn, depth + 1));
        case "arrayLit":
          return e.elems.every((x) => x !== null && typeof x === "object" && "kind" in x && deepFresh(x as IrExpr, fn, depth + 1));
        case "unionWrap":
        case "upcast":
          return deepFresh(e.value, fn, depth + 1);
        case "ternary":
          return deepFresh(e.then, fn, depth + 1) && deepFresh(e.else_, fn, depth + 1);
        case "logical":
        case "nullish":
        case "orDefault": {
          const r = e as unknown as { left: IrExpr; right: IrExpr };
          return deepFresh(r.left, fn, depth + 1) && deepFresh(r.right, fn, depth + 1);
        }
        case "arrIntrinsic":
          // sort, reverse, fill and copyWithin answer their receiver.
          if (["sort", "typedSort", "reverse", "fill", "copyWithin"].includes(e.method)) return deepFresh(e.receiver, fn, depth + 1);
          return fresh(e) && (e.type.kind !== "array" || !hasRef(e.type.elem));
        case "seqExpr":
          // A temporary the sequence builds and answers.
          return ownedTyped(e.result, fn, depth + 1);
        case "callValue": {
          // A call through a function value: every function that can flow
          // to the callee returns a value it built from its own locals.
          const gs = alias.callees(e.callee, fn);
          return gs !== null && gs.length > 0 && gs.every((g) => byName.has(g) && returnsOwned(g, depth + 1));
        }
        case "strIntrinsic":
        case "regexIntrinsic":
          // String and regex methods build what they return (`s.split("")`,
          // a match array of strings).
          return true;
        case "varRef": {
          const b = bindings.get(bkey(fn, e.localId));
          return !!b && !b.captured && b.assigns.length === 1 && b.uses.length === 1 && deepFresh(b.assigns[0], fn, depth + 1);
        }
        case "libCall":
          // The runtime builds the composites it returns (`s.split(" ")`, a
          // directory listing, a regex match); none is a program value.
          // (process.argv and the like answer one shared value.)
          return !/^(dyn|process|global|emitter|stdin)\./.test(e.fn);
        case "call":
          // A program function every return of which builds a value from
          // its own locals.
          if ((!e.callee.startsWith("%") || /^%fn\d+$/.test(e.callee)) && byName.has(e.callee)) return returnsOwned(e.callee, depth + 1);
          return fresh(e) && (e.type.kind !== "array" || !hasRef(e.type.elem));
        default:
          // A fresh spine (map/filter/slice, a builder, `new`) of scalars.
          return fresh(e) && (e.type.kind !== "array" || !hasRef(e.type.elem));
      }
    };
    const returnsOwnedMemo = new Map<string, boolean>();
    const returnsOwned = (name: string, depth: number): boolean => {
      const memo = returnsOwnedMemo.get(name);
      if (memo !== undefined) return memo;
      returnsOwnedMemo.set(name, false); // recursion: not proven
      const f = byName.get(name)!;
      // (An async function's promise settles with what it returns; a
      // generator hands values out before it returns.)
      if (f.generator || depth > 6) return false;
      const rets: IrExpr[] = [];
      let bare = false;
      const scan = (n: unknown): void => {
        if (n === null || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(scan);
        const r = n as Record<string, unknown>;
        if (r["kind"] === "return") {
          if (r["value"]) rets.push(r["value"] as IrExpr);
          else bare = true;
        }
        for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
      };
      scan(f.body);
      const ok = !bare && rets.length > 0 && rets.every((v) => ownedTyped(v, name, depth));
      returnsOwnedMemo.set(name, ok);
      return ok;
    };
    /** A dynamic value nothing else holds: built fresh (JSON.parse, a
     * dynamic literal of such values, a crossing of a deeply fresh typed
     * value), a member of one, or a binding holding one whose only use is
     * this. */
    const uniqueDyn = (e: IrExpr | undefined, fn: string, depth = 0): boolean => {
      e = unwrap(e);
      if (!e || depth > 8) return false;
      if (!isDynType(e.type)) return !hasRef(e.type);
      switch (e.kind) {
        case "libCall":
          // Object.assign answers its target, which takes the sources' own
          // property values: fresh when the target is and those values
          // are scalars or themselves fresh.
          if (e.fn === "dyn.assign" || e.fn === "dyn.assignAll") {
            return uniqueDyn(e.args[0], fn, depth + 1) && e.args.slice(1).every((a) => shallowFresh(a, fn, depth + 1));
          }
          return DYN_FRESH_LIB.test(e.fn);
        case "dynArrLit":
          return e.elems.every((x) => uniqueDyn(x, fn, depth + 1));
        case "dynObjLit":
          return (e.fields ?? []).every((f) => uniqueDyn(f.value, fn, depth + 1));
        case "dynFrom":
          return deepFresh(e.value, fn, depth + 1);
        // A typed value marshaled into the island (a literal's scalar
        // member): as fresh as the value (a dyn one unwraps above).
        case "jsMarshal":
          return deepFresh(e.value, fn, depth + 1);
        case "dynKeyGet":
          return uniqueDyn(e.value, fn, depth + 1);
        case "seqExpr":
          return uniqueDyn(e.result, fn, depth + 1);
        case "jsOp":
          // An island literal of such values (its marshaled keys are
          // strings), a member of one, or a spread completion onto one.
          if (e.op === "arrLit" || e.op === "objLit") return e.args.every((x) => uniqueDyn(x, fn, depth + 1));
          if (e.op === "getProp" || e.op === "getIdx") return uniqueDyn(e.args[0], fn, depth + 1);
          if (e.op === "objSpread") return uniqueDyn(e.args[0], fn, depth + 1) && e.args.slice(1).every((a) => shallowFresh(a, fn, depth + 1));
          return false;
        case "dynInvoke":
          // sort and reverse answer their receiver.
          return (e.method === "sort" || e.method === "reverse") && uniqueDyn(e.recv, fn, depth + 1);
        case "varRef": {
          const b = bindings.get(bkey(fn, e.localId));
          // One read in all: every value the binding ever holds is fresh
          // (an evolving `let flags = []` reassigned from a fresh result),
          // so the one read takes a value nothing else holds.
          if (!b || b.captured || b.assigns.length === 0 || (dynUses.get(bkey(fn, e.localId)) ?? []).length !== 1) return false;
          return b.assigns.every((a) => uniqueDyn(a, fn, depth + 1));
        }
        default:
          return false;
      }
    };
    /** A value whose own property VALUES nothing else holds (Object.assign
     * and spreads take those, not the value itself). */
    const shallowFresh = (a: IrExpr | undefined, fn: string, depth: number): boolean => {
      const v = unwrap(a);
      if (!v) return false;
      if (v.kind === "dynFrom") {
        const top = tkey(v.value.type);
        return refsOf(v.value.type).refs.every((r) => tkey(r) === top);
      }
      // Object.assign's argument pack: an array built here of sources
      // pushed in, handed to the one call.
      if (v.kind === "varRef") {
        const key = bkey(fn, v.localId);
        const init = unwrap(onlyValue(fn, v.localId) ?? undefined);
        const uses = ownUses.get(key) ?? [];
        if (init?.kind === "dynArrLit" && init.elems.length === 0 && uses.filter((u) => u.use === "other").length === 1 &&
            uses.every((u) => u.use === "other" || (u.use === "recv" && (u.stored ?? []).every((x) => shallowFresh(x, fn, depth + 1))))) {
          return true;
        }
      }
      return uniqueDyn(v, fn, depth);
    };
    /** A dynamic value built fresh and held only by the binding `e` names:
     * a write to ITS OWN members changes no copy. */
    const freshRooted = (e: IrExpr | null, fn: string): boolean => {
      const v = unwrap(e ?? undefined);
      if (!v) return false;
      // A receiver built right there (`JSON.parse(s).sort(f)`) is a new object
      // at the moment of the write.
      if ((v.kind === "libCall" && DYN_FRESH_LIB.test(v.fn)) || v.kind === "dynArrLit" || v.kind === "dynObjLit" || isIslandLit(v)) return true;
      if (v.kind !== "varRef") return false;
      const init = onlyValue(fn, v.localId);
      const i = unwrap(init ?? undefined);
      if (!i) return false;
      if (!((i.kind === "libCall" && DYN_FRESH_LIB.test(i.fn)) || i.kind === "dynArrLit" || i.kind === "dynObjLit" || isIslandLit(i))) return false;
      // ...and the binding never hands the object anywhere (an alias, an
      // argument, an element pushed elsewhere would make it reachable as
      // something a copy was taken from).
      return (ownUses.get(bkey(fn, v.localId)) ?? []).every((u) => u.use !== "other");
    };
    /** The binding a dynamic expression reads from (through member reads). */
    const rootKey = (e: IrExpr | null | undefined, fn: string): string | null => {
      let v = unwrap(e ?? undefined);
      while (v && (v.kind === "dynKeyGet" || (v.kind === "jsOp" && (v.op === "getProp" || v.op === "getIdx")))) {
        v = unwrap(v.kind === "dynKeyGet" ? v.value : v.args[0]);
      }
      return v?.kind === "varRef" ? bkey(fn, v.localId) : null;
    };
    const alias = dynAliasClasses();
    /** Is a dynamic value written where a copy taken at `site` could still
     * be held (`during`: only in these functions)? The width copies'
     * ordering rule: an earlier top-level statement of the same module
     * initializer has already run. A write to the own members of a
     * fresh-rooted binding counts only for a copy taken OUT of that
     * binding's value (`outOf`). With `value` (the copy, or the value a
     * copy was taken from), only a write whose receiver may be that value
     * counts (dynAliasClasses). */
    const dynWritten = (site: Site | null, during: Set<string> | DynWindow | null, outOf: string | null = null, value: { e: IrExpr; fn: string } | null = null, dead: { fn: string; top: number } | null = null, refs: IrType[] | null = null): boolean =>
      dynWrites.some((w) => {
        if (dead !== null && w.fn === dead.fn && w.top > dead.top) return false;
        // An array mutator called by name changes only its receiver, and
        // only a receiver that has that method: a copy made of records
        // with no member of that name (and no index signature) cannot be
        // the receiver, so the call cannot write it. (Not with --dynamic:
        // an engine object's own method of that name may be anything.)
        if (!opaqueCalls && refs !== null && w.method !== undefined && DYN_MUTATING.has(w.method) && refs.every((t) => recordLacks(t, w.method!))) return false;
        if (value !== null && w.recv !== null && !alias.same(w.recv, w.fn, value.e, value.fn)) return false;
        if (freshRooted(w.recv, w.fn) && !(outOf !== null && rootKey(w.recv, w.fn) === outOf)) return false;
        if (during === null) return !(site !== null && w.fn === site.where && /^%init\.\d+$/.test(w.fn) && w.top < site.top);
        if (during instanceof Set) return during.has(w.fn);
        // A window: in the crossing's own function only inside its scope.
        if (site !== null && w.fn === site.where && during.inside !== null) return w.anc.some((a) => during.inside!.includes(a));
        return during.fns.has(w.fn);
      });
    /** A local dynamic binding that owns its value all the way down: built
     * fresh, never captured, and only read, written in place (storing
     * values nothing else holds) or crossed out. Once the function returns
     * nothing can reach it, so a copy built for the `return` is the only
     * holder left. */
    const ownedLocal = (e: IrExpr | undefined, fn: string): boolean => {
      const v = unwrap(e);
      if (!v || v.kind !== "varRef") return false;
      const key = bkey(fn, v.localId);
      if (key.startsWith("g\0")) return false;
      const b = bindings.get(key);
      if (!b || b.captured || b.assigns.length === 0 || !b.assigns.every((a) => uniqueDyn(a, fn))) return false;
      return (ownUses.get(key) ?? []).every((u) =>
        u.use === "ro" || u.use === "exit" || (u.use === "recv" && (u.stored ?? []).every((x) => !passesDyn(x) || uniqueDyn(x, fn))));
    };
    /** The functions that can run while an out-crossing's copy is alive,
     * when its binding is a local nothing captures and every use of it is
     * known (null: anything can). */
    const copyWindow = (s: DynSite): DynWindow | null => {
      // A sequence's temporary lives while the sequence evaluates.
      if (s.scope !== undefined && s.dest !== null) {
        const db = destBinding(s);
        if (db === null || db.uses.includes("other") || db.parts.some((p) => p.use === "other" || p.via !== undefined)) return null;
        const reach = nodeReach(s.scope);
        return reach.suspends ? null : { fns: reach.fns, inside: [s.scope] };
      }
      // A local (holding the copy or a part of it) read only in the
      // statements from its declaration to its last use, all in one list:
      // the copy lives while those statements run.
      const h = s.holder;
      if (!h || h.key.startsWith("g\0")) return null;
      const hb = holderBinding(s);
      if (hb === null) return null;
      const id = h.key.split("\0")[1]!;
      let seen = 0;
      let last = h.index;
      for (let k = h.index; k < h.list.length; k++) {
        const c = countRefs(h.list[k], id);
        if (c > 0) last = k;
        seen += c;
      }
      if (seen !== hb.uses.length) return null;
      const nodes = h.list.slice(h.index, last + 1);
      const reach = nodeReach(nodes);
      return reach.suspends ? null : { fns: reach.fns, inside: nodes };
    };
    /** The binding of an out-crossing's holder, when nothing captures or
     * reassigns it and every use of it (and of its parts) only reads. */
    const holderBinding = (s: DynSite): Binding | null => {
      const h = s.holder;
      if (!h) return null;
      const b = bindings.get(h.key);
      if (!b || b.captured || b.assigns.length !== 1 || b.uses.includes("other")) return null;
      if (b.parts.some((p) => p.use === "other" || p.via !== undefined)) return null;
      return b;
    };
    const countRefs = (n: unknown, id: string): number => {
      if (n === null || typeof n !== "object") return 0;
      if (Array.isArray(n)) return n.reduce((a: number, x) => a + countRefs(x, id), 0);
      const r = n as Record<string, unknown>;
      let c = r["kind"] === "varRef" && r["localId"] === id ? 1 : 0;
      for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") c += countRefs(r[key], id);
      return c;
    };
    /** Does the program define an accessor a property read could run
     * (an island getter, Object.defineProperty on a dynamic value)? */
    let accessorsMemo: boolean | null = null;
    const accessorsDefined = (): boolean => {
      if (accessorsMemo !== null) return accessorsMemo;
      let found = false;
      const scan = (n: unknown): void => {
        if (found || n === null || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(scan);
        const r = n as Record<string, unknown>;
        if ((r["kind"] === "jsOp" && r["op"] === "defineGetter") || (r["kind"] === "libCall" && r["fn"] === "dyn.defineProps")) {
          found = true;
          return;
        }
        for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
      };
      for (const f of functions) scan(f.body);
      return (accessorsMemo = found);
    };
    /** The functions evaluating `node` can run, and whether that set is
     * open (callReach's rules, for one node). */
    const nodeReach = (node: unknown): { fns: Set<string>; suspends: boolean } => {
      const fns = new Set<string>();
      let suspends = false;
      const enter = (name: string): void => {
        if (fns.has(name)) return;
        const r = callReach(name);
        for (const f of r.fns) fns.add(f);
        suspends ||= r.suspends;
      };
      const scan = (n: unknown): void => {
        if (n === null || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(scan);
        const r = n as Record<string, unknown>;
        const k = r["kind"];
        if (k === "call") enter(r["callee"] as string);
        else if (k === "closure") enter(r["fnName"] as string);
        else if (k === "new") enter(`%${r["className"] as string}.constructor`);
        else if (k === "virtualCall") {
          for (const other of byName.keys()) if (other.endsWith(`.${r["method"] as string}`)) enter(other);
        } else if (k === "callValue" || k === "dynCall" || k === "dynInvoke") {
          for (const v of valueFns) enter(v);
        } else if (k === "awaitExpr" || k === "awaitUnionExpr" || k === "yieldExpr" || k === "genResume") suspends = true;
        else if (k === "libCall") {
          if (!PURE_LIB.test(r["fn"] as string) && !DYN_READER.test(r["fn"] as string)) suspends = true;
        } else if (k === "intrinsic") {
          if (!/^console\./.test(r["name"] as string)) suspends = true;
        } else if (k === "arrIntrinsic") {
          if (["sort", "toSorted", "typedSort"].includes(r["method"] as string)) for (const v of valueFns) enter(v);
        } else if (k === "dynFrom" || k === "dynCheck") {
          // A crossing runs code only through a function it boxes or unboxes.
          const t = k === "dynFrom" ? (r["value"] as IrExpr).type : (r["type"] as IrType);
          if (t.kind === "func" || refsOf(t).fns.length > 0) suspends = true;
        } else if (k === "jsExit" || k === "jsUnview" || k === "jsMarshal" || k === "jsView") {
          // Checking, viewing or marshaling a value runs no code (a function
          // value is boxed or unboxed, not called).
        } else if (k === "jsOp") {
          // Island operations run code (a call, a setter, a valueOf), except
          // tests, literals and plain reads — and a read runs a getter only
          // where the program defines one.
          const op = r["op"] as string;
          const pure = ["typeof", "truthy", "not", "objLit", "arrLit", "tplStrings", "globalGet"].includes(op) ||
            ((op === "getProp" || op === "getIdx") && !accessorsDefined());
          if (!pure) suspends = true;
        } else if (RUNTIME_KINDS.has(k as string)) suspends = true;
        for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
      };
      scan(node);
      return { fns, suspends };
    };
    /** Is the original written while the in-crossing's copy is held? The
     * copy's alias class says where it can be held: nowhere (it is read
     * where it is made, before the original can change), only by
     * parameters of functions that read it and return (while such a call
     * runs), or by anything else (then by type, as ever). */
    const origWrittenWhileHeld = (s: DynSite, types: IrType[], dead: { fn: string; top: number } | null): boolean => {
      const holders = alias.holders(s.node, s.where);
      if (holders.length === 0) return false;
      const during = new Set<string>();
      for (const h of holders) {
        const [fname, id] = h.split("\0");
        // The printing and formatting helpers only read what they are handed.
        if (fname !== undefined && PRINT_HELPER.test(fname)) continue;
        const f = fname !== undefined && id !== undefined ? byName.get(fname) : undefined;
        const isParam = !!f && f.params.some((p) => p.localId === id);
        const b = bindings.get(h);
        const ro = (dynUses.get(h) ?? []).every((u) => u === "ro");
        if (!isParam || !ro || (b && (b.captured || b.assigns.length > 0))) return anyWritten(types, s, null, dead);
        const r = callReach(f!.name);
        if (r.suspends) return anyWritten(types, s, null, dead);
        for (const g of r.fns) during.add(g);
      }
      // Held only while printers read it: nothing else runs then.
      if (during.size === 0) return false;
      return anyWritten(types, s, during, null);
    };
    const anyWritten = (types: IrType[], site: Site | null, during: Set<string> | null = null, dead: { fn: string; top: number } | null = null): boolean =>
      types.some((t) => isWritten(t, undefined, site, during, dead));
    /** For a copy landing in a local dynamic binding nothing captures: the
     * last top-level statement of its function that reads it (later
     * statements of that function cannot observe it). */
    const lastUse = (s: DynSite): { fn: string; top: number } | null => {
      if (s.dest === null || s.dest.param || s.dest.key.startsWith("g\0")) return null;
      const b = bindings.get(s.dest.key);
      if (!b || b.captured || b.assigns.length !== 1) return null;
      // Every use reads it at once, so the copy goes nowhere else.
      if (!(dynUses.get(s.dest.key) ?? []).every((u) => u === "ro")) return null;
      const tops = useTops.get(s.dest.key) ?? [];
      if (tops.some((u) => u.fn !== s.where)) return null;
      return { fn: s.where, top: Math.max(s.top, ...tops.map((u) => u.top)) };
    };
    /** A typed value built from locals of the function that nothing else
     * can reach once it returns: literals of such values, and local
     * bindings initialized fresh, used only by reads of scalars, writes in
     * place storing such values, loops handing on no reference, printing,
     * and crossings — and captured only by callbacks an array loop runs
     * before returning. */
    const ownedTyped = (e: IrExpr | undefined, fn: string, depth = 0): boolean => {
      e = unwrap(e);
      if (!e || depth > 6) return false;
      if (!hasRef(e.type) || deepFresh(e, fn)) return true;
      if (e.kind === "recordLit") return e.fields.every((f) => ownedTyped(f.value, fn, depth + 1));
      if (e.kind === "arrayLit") return e.elems.every((x) => x !== null && typeof x === "object" && "kind" in x && ownedTyped(x as IrExpr, fn, depth + 1));
      if (e.kind !== "varRef") return false;
      const key = bkey(fn, e.localId);
      if (key.startsWith("g\0")) return false;
      const b = bindings.get(key);
      if (!b || b.assigns.length === 0 || !b.assigns.every((a) => ownedTyped(a, fn, depth + 1))) return false;
      const keys = [key];
      if (b.captured) {
        for (const c of closureCaptures) {
          const i = c.fn === fn ? c.captures.indexOf(e.localId) : -1;
          if (i < 0) continue;
          const g = byName.get(c.fnName);
          const gc = g?.captures?.[i];
          if (!c.transient || !gc) return false;
          keys.push(bkey(c.fnName, gc.localId));
        }
      }
      return keys.every((k) => (typedOwnUses.get(k) ?? []).every((u) =>
        u.ok && (u.stored ?? []).every((x) => !hasRef(x.type) || ownedTyped(x, k.split("\0")[0]!, depth + 1))));
    };
    const anyIdentity = (types: IrType[]): boolean => types.some((t) => identity.has(tkey(t)));
    /** The uses of a dynamic binding a crossing lands in, when they are
     * all known and all read at once. */
    const dynDestReadOnly = (s: Site): boolean => {
      if (s.dest === null) return false;
      const b = bindings.get(s.dest.key);
      if (b && (b.captured || b.assigns.length !== (s.dest.param ? 0 : 1))) return false;
      return (dynUses.get(s.dest.key) ?? []).every((u) => u === "ro");
    };
    /** Is the TYPED copy (or a part of it) written, or handed where it
     * could be? Through its binding when every use is known, else by
     * type. */
    const typedSideWritten = (s: Site, t: IrType, during: Set<string> | null): boolean => {
      const db = destBinding(s);
      if (db !== null && !db.uses.includes("other")) {
        const partsOk = db.parts.every((p) => {
          if (p.via === undefined) return p.use !== "other";
          const vb = bindings.get(p.via);
          return !vb || (!vb.captured && vb.assigns.length === 0 && !vb.uses.includes("other") && vb.parts.every((q) => q.use !== "other" && q.via === undefined));
        });
        if (partsOk) return false;
      }
      return anyWritten(refsOf(t).refs, s, during);
    };
    /** A function value boxed into (or out of) the dynamic world: its
     * thunk copies each composite argument and its composite result. By
     * type: a copy any write or identity test could meet. */
    const fnTypeObservable = (f: IrType & { kind: "func" }): string | null => {
      for (const pt of [...f.params, f.ret]) {
        const refs = refsOf(pt).refs;
        if (refs.length === 0) continue;
        if (anyWritten(refs, null)) return COPY_WRITTEN;
        if (anyIdentity(refs)) return COPY_IDENTITY;
        if (dynWritten(null, null)) return DYN_WRITE_FROM;
        if (dynIdentity) return DYN_SAME;
      }
      return null;
    };
    /** The program functions a boxed value carries, when they can be
     * named; `open` when some function inside cannot. */
    const boxedFns = (e: IrExpr | undefined, fn: string, depth = 0): { fns: string[]; open: boolean } => {
      e = unwrap(e);
      if (!e || depth > 6) return { fns: [], open: true };
      if (!isDynType(e.type) && refsOf(e.type).fns.length === 0 && e.type.kind !== "func") return { fns: [], open: false };
      const merge = (xs: IrExpr[]): { fns: string[]; open: boolean } => {
        const out = { fns: [] as string[], open: false };
        for (const x of xs) {
          const r = boxedFns(x, fn, depth + 1);
          out.fns.push(...r.fns);
          out.open ||= r.open;
        }
        return out;
      };
      switch (e.kind) {
        case "closure":
          return byName.has(e.fnName) ? { fns: [e.fnName], open: false } : { fns: [], open: true };
        case "dynFrom":
          // Boxed right here (an out-crossing of a function just boxed).
          return boxedFns(e.value, fn, depth + 1);
        case "recordLit":
          return merge(e.fields.map((f) => f.value));
        case "arrayLit":
          return merge(e.elems.filter((x): x is IrExpr => x !== null && typeof x === "object" && "kind" in x));
        case "ternary":
          return merge([e.then, e.else_]);
        case "varRef": {
          // A function adapter's captured function: whatever its callers hand it.
          const adapter = /^(%fn\.adapt\.\d+)\.impl$/.exec(fn);
          if (adapter && e.localId === "f.0") {
            const given = adapterArgs.get(adapter[1]!) ?? [];
            const out = { fns: [] as string[], open: given.length === 0 };
            for (const g of given) {
              const r = boxedFns(g.e, g.fn, depth + 1);
              out.fns.push(...r.fns);
              out.open ||= r.open;
            }
            return out;
          }
          const init = onlyValue(fn, e.localId);
          return init ? boxedFns(init, fn, depth + 1) : { fns: [], open: true };
        }
        default:
          return { fns: [], open: true };
      }
    };
    /** A program function boxed into a dynamic value: each composite
     * parameter receives a copy of the dynamic argument, and a composite
     * result goes back as a copy. */
    const judgeBoxedFn = (name: string): { why: string; what: string } | null => {
      const f = byName.get(name)!;
      for (const p of f.params) {
        const refs = refsOf(p.type).refs;
        if (refs.length === 0) continue;
        const ps: Site = { callee: "%dyn.param", arg: undefined, loc: f.loc, where: name, top: 0, dest: { key: `${name}\0${p.localId}`, param: true } };
        const db = destBinding(ps);
        const reachFns = callReach(name);
        const transient = !reachFns.suspends && db !== null && !db.uses.includes("other");
        const what = `its parameter '${p.name}' typed '${L.fmt(p.type)}'`;
        if (typedSideWritten(ps, p.type, null)) return { why: COPY_WRITTEN, what };
        if (anyIdentity(refs)) return { why: COPY_IDENTITY, what };
        if (dynWritten(null, transient ? reachFns.fns : null, null, null, null, refs)) return { why: DYN_WRITE_FROM, what };
      }
      const rrefs = refsOf(f.returnType).refs;
      if (rrefs.length > 0) {
        const rets: IrExpr[] = [];
        const scan = (n: unknown): void => {
          if (n === null || typeof n !== "object") return;
          if (Array.isArray(n)) return n.forEach(scan);
          const r = n as Record<string, unknown>;
          if (r["kind"] === "return" && r["value"]) rets.push(r["value"] as IrExpr);
          for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
        };
        scan(f.body);
        const what = `its result typed '${L.fmt(f.returnType)}'`;
        for (const v0 of rets) {
          const v = unwrap(v0);
          if (!v || deepFresh(v, name)) continue;
          if (anyWritten(refsOf(v.type).refs, null)) return { why: ORIG_WRITTEN, what };
          if (dynWritten(null, null)) return { why: DYN_WRITE_TO, what };
          if (dynIdentity || anyIdentity(refsOf(v.type).refs)) return { why: DYN_SAME, what };
        }
      }
      return null;
    };

    const reportedDyn = new Set<string>();
    const judgedFns = new Map<string, { why: string; what: string } | null>();
    if (dynIdentity) for (const k of islandEntered) identity.add(k);
    judgingDyn = true;
    for (const s of dynSites) {
      let why: string | null = null;
      let feature = "";
      let hint = "";
      const refs = refsOf(s.t).refs;
      if (s.dir === "in") {
        feature = `a '${L.fmt(s.t)}' value converted to a dynamic ('unknown', 'any' or 'object') value`;
        hint = "keep the value typed where it is shared, or hand the dynamic slot a value nothing else holds (a literal, a spread, structuredClone)";
        const x = unwrap(s.arg);
        const src = x?.kind === "varRef" ? bindings.get(bkey(s.where, x.localId)) : undefined;
        const sole = x !== undefined && (fresh(x) || (src !== undefined && !src.captured && src.assigns.length === 1 && fresh(src.assigns[0]) && src.uses.every((u) => u === "read" || u === "copy" || u === "keys" || u === "print")));
        // Nothing else holds the value: fresh all the way down, or (at a
        // return) built from locals of the function that die with it.
        const unique = deepFresh(x, s.where) || (s.atReturn === true && ownedTyped(x, s.where));
        if (refs.length > 0 && !unique && !s.consumed) {
          // The original is still held: a write on the dynamic side is
          // lost to it, and a write to it (or to anything inside it) is
          // lost to the copy.
          const destRO = dynDestReadOnly(s);
          const dead = lastUse(s);
          if (!destRO && dynWritten(s, null, null, { e: s.node, fn: s.where }, dead)) why = DYN_WRITE_TO;
          // (A copy no binding, field or unknown code ever holds is read where it
          // is made, before the original can change.)
          else if (origWrittenWhileHeld(s, sole ? refs.filter((r) => tkey(r) !== tkey(s.t)) : refs, dead)) why = ORIG_WRITTEN;
          else if (!destRO && dynIdentityOps.some((o) => o === null || alias.same(o.e, o.fn, s.node, s.where))) why = DYN_SAME;
        }
      } else {
        feature = `a dynamic ('unknown', 'any' or 'object') value checked into '${L.fmt(s.t)}'`;
        hint = "keep the value dynamic and read its members through it, or cast a value nothing else holds (JSON.parse(text) as T)";
        // A new array a dynamic map/filter/slice/concat just built, checked
        // into an array of scalars: its spine is all the copy holds.
        const src = unwrap(s.arg);
        const freshSpine = s.t.kind === "array" && !hasRef(s.t.elem) && src?.kind === "dynInvoke" && /^(map|filter|slice|concat)$/.test(src.method);
        // Object.assign onto a fresh target, checked into a type of scalar
        // fields: the copy takes only scalars from the sources.
        const assignSrc = src?.kind === "seqExpr" ? unwrap(src.result) : src;
        const freshAssign = assignSrc?.kind === "libCall" && /^dyn\.assign(All)?$/.test(assignSrc.fn) && uniqueDyn(assignSrc.args[0], s.where) &&
          refsOf(s.t).refs.every((x) => tkey(x) === tkey(s.t));
        if (refs.length > 0 && !s.consumed && !freshSpine && !freshAssign && !uniqueDyn(s.arg, s.where) && !(s.atReturn && ownedLocal(s.arg, s.where))) {
          // While the copy is alive: only the function its local binding
          // lives in (and what that can call) runs, unless it suspends.
          const window = copyWindow(s);
          const viaHolder = s.dest === null && holderBinding(s) !== null;
          if (!viaHolder && typedSideWritten(s, s.t, null)) why = COPY_WRITTEN;
          else if (dynWritten(s, window, rootKey(s.arg, s.where), { e: s.arg!, fn: s.where })) {
            why = DYN_WRITE_FROM;
          }
          else if (anyIdentity(refs)) why = COPY_IDENTITY;
        }
      }
      // Functions boxed with the value (or unboxed from it).
      if (!why) {
        const fnTypes = refsOf(s.t).fns;
        if (fnTypes.length > 0) {
          const boxed = boxedFns(s.arg, s.where);
          for (const name of boxed.fns) {
            if (!judgedFns.has(name)) judgedFns.set(name, judgeBoxedFn(name));
            const j = judgedFns.get(name);
            if (j) {
              why = j.why;
              feature = `a function crossing into a dynamic value, ${j.what}`;
              hint = "leave the parameter dynamic ('unknown' or 'any') or return a fresh value, so dynamic code and the function share one object";
              break;
            }
          }
          if (!why && boxed.open) {
            for (const f of fnTypes) {
              const j = fnTypeObservable(f);
              if (j) {
                why = j;
                feature = `a '${L.fmt(f)}' function crossing ${s.dir === "in" ? "into" : "out of"} a dynamic value (its composite arguments and result cross as copies)`;
                hint = "type the function's composite parameters and result as 'unknown' or 'any', so both sides share one object";
                break;
              }
            }
          }
        }
      }
      if (!why) continue;
      const at = `${s.loc.file}:${s.loc.start}`;
      if (reportedDyn.has(at)) continue;
      reportedDyn.add(at);
      L.pushDiag(unsupportedDiag("SC1090", s.loc, `${feature}: it would be a COPY where JavaScript shares the object, and ${why} (SEMANTICS.md S125)`, hint));
    }
    judgingDyn = false;
  }
}
