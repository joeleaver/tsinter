/* The width-copy pass's fixed tables (SEMANTICS.md S125): the helper and
 * node-kind classes the use classifiers test, the dynamic world's readers
 * and writers, the (b) refusal reasons, and the small pure helpers over
 * IR nodes and types that need no pass state. */
import { type IrExpr, type IrRecordShape, type IrType, typeKey } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** The interned width helpers: each builds a NEW value of its return type
 * from its one argument. */
export const COPY_HELPER = /^%(rec\.width|obj\.width|cls\.width|arr\.width|tup\.arr|arr\.empty|rec\.capture)\.\d+$/;

export const isCopyHelper = (name: string): boolean => COPY_HELPER.test(name);

/** Lowering helpers that only move or test their arguments (re-tags,
 * narrows), the program's own lambdas, and the array HOF loops (they hand
 * elements to a program callback): their argument positions are
 * transparent. */
export const TRANSPARENT_HELPER = /^%(union\.(retag|narrow|strand|recv)|nullish\.retag|unit\.strand|deferred\.read|fn\d+|obj\.assign|arr\.(map|filter|forEach|reduce|reduceRight|find|findIndex|findLast|findLastIndex|some|every|flatMap|filterNarrow|concat)|object\.groupBy|map\.(groupBy|keys|values|entries)|obj\.fromEntries)(\.|_|$|\d)/;

/** The array HOF loops alone: they read the array's spine. */
export const HOF_HELPER = /^%arr\.(map|filter|forEach|reduce|reduceRight|find|findIndex|findLast|findLastIndex|some|every|flatMap|filterNarrow)\./;

/** Helpers that BUILD a fresh record or map and return it: their own
 * writes construct it (no one else holds it yet). */
export const BUILDER = /^%(object\.groupBy|map\.groupBy|obj\.(fromEntries|keys|values|entries))\./;

/** Array helpers that MUTATE their array argument (sort, reverse, ...):
 * the write is noted at the call; their own bodies are not writes. */
export const ARG_MUTATOR = /^%arr\.(sort|reverse|fill|copyWithin|unshift|splice|push|pop|shift)\.\d+$/;

/** The runtime library families that run no program code: each takes and
 * answers data. Enumerated from every `libCall` family the lowering emits
 * (`fn: "<family>.<member>"`); the rest — emitter, readable/writable/
 * stream, timers, process, dyn, dc, als, async, assert, test, net/http/
 * http2/tls/https/dgram/dns, fs/fsp, child/cp/spawnRes/procStream, rl,
 * stdin, island, watcher, perf, crypto, zlib, global, class, atomics, tp,
 * sp, tlsca, stats, qs ... — can run, or may one day run, a callback, and
 * count as running any of them. */
export const PURE_LIB = /^(math|num|number|string|str|insp|json|path|date|sym|buffer|bytes|error|undef|os|regex|regexp|text|intl|strdec|url)\./;

/** Node kinds that cross into the runtime, the host or the embedded engine
 * with a program value that may be (or hold) a function. */
export const RUNTIME_KINDS = new Set(["dynCall", "dynInvoke", "jsMarshal", "jsExit", "jsView", "jsUnview", "jsBridgePromise", "ffiCall", "hostCall", "newPromise", "promiseWithResolvers", "dynFrom", "dynCheck"]);

/** Pass-through checks: they answer their argument unchanged. */
export const PASS_THROUGH = /^%(undef\.(fence|recv|iter)|in\.undefrecv|u2\.exact)\./;

/** Helpers that only read: printing and formatting (which shows a class's
 * name), key listing and key tests (which show own keys only). */
export const PRINT_HELPER = /^%(util\.|assert\.)/;

export const KEYS_HELPER = /^%(obj\.(keys|values|entries|hasOwn)\.|rec\.haskey\.|in\.)/;

/** GH #132's own-key order bookkeeping (record-order.ts): it reads its
 * records' fields and keys to keep a record's order — part of the write
 * or the copy it rides, never an observation of its own. */
export const ORDER_HELPER = /^%ord\.\d+$/;

/** Node kinds whose operands are only read: printed (console), rendered
 * (`[object Object]`), serialized, or copied into a dynamic value. */
export const PRINT_KINDS = new Set(["intrinsic", "toString", "strConcat"]);

export const KEYS_KINDS = new Set(["jsonStringify", "dynFrom", "arrHasUndef", "recordKeyGet", "recordOvfKeys"]);

export const MUTATING_ARR = new Set(["push", "pushSpread", "pop", "shift", "splice", "sort", "typedSort"]);

/** Array intrinsics whose receiver position is transparent. */
export const READING_ARR = new Set(["length", "slice", "toReversed", "toSpliced", "with", "toSorted", "join", ...MUTATING_ARR]);

export const SPINE_READS = new Set(["length", "slice", "toReversed", "toSpliced", "with", "toSorted", "join"]);

/** Per node kind: the child keys holding a value in a transparent
 * position. */
export const TRANSPARENT: Record<string, readonly string[]> = {
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

/** GH #148 (review): the island spread literals (`{ ...x }` over a dynamic
 * source: the `objSpread` op) a dynamic value `v` may be — itself, or an
 * arm of a `?:`, `&&` or `||` over it, through retypings and a sequence's
 * result. */
export function spreadsIn(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const r = v as Record<string, unknown> | null;
  if (r === null || typeof r !== "object") return out;
  switch (r["kind"]) {
    case "jsOp":
      if (r["op"] === "objSpread") out.push(r);
      return out;
    case "ternary":
      spreadsIn(r["then"], out);
      return spreadsIn(r["else_"], out);
    case "logical":
      spreadsIn(r["left"], out);
      return spreadsIn(r["right"], out);
    case "dynFromJsval":
    case "jsMarshal":
      return spreadsIn(r["value"], out);
    case "call":
      // (U2's exact-fit test passes its argument through)
      if (typeof r["callee"] === "string" && /^%u2\.exact\./.test(r["callee"])) return spreadsIn((r["args"] as unknown[])[0], out);
      return out;
    case "seqExpr":
      return spreadsIn(r["result"], out);
    default:
      return out;
  }
}

/** The closed record shapes a typed exit lands in: the type itself, or a
 * union's record arms; an index-signature or tuple shape keeps every key. */
export function closedRecordArms(L: Lowerer, t: IrType): { t: IrType; shape: IrRecordShape }[] {
  const arms = t.kind === "union" ? (L.unions.get(t.unionId)?.arms ?? []) : [t];
  const out: { t: IrType; shape: IrRecordShape }[] = [];
  for (const a of arms) {
    if (a.kind !== "record") continue;
    const sh = L.shapes.get(a.shapeId);
    if (sh !== undefined && sh.indexValue === undefined && !sh.tuple) out.push({ t: a, shape: sh });
  }
  return out;
}

/** GH #148 (review): may the island spread literal `v` carry an own key
 * that record shape `fields` has no field for? A literal part's keys are
 * known, and so are a TYPED record's (its view, or the record marshaled
 * in: at most its declared fields — one that may be undefined spreads
 * none); any other spread source's are not. */
export function spreadMayCarryExtra(L: Lowerer, v: unknown, fields: Set<string>): boolean {
  const r = v as Record<string, unknown>;
  if (r["kind"] === "jsOp" && r["op"] === "objSpread") return (r["args"] as unknown[]).some((a) => spreadMayCarryExtra(L, a, fields));
  const typed = (r["kind"] === "call" && /^%view\./.test(r["callee"] as string)) ? (r["args"] as IrExpr[])[0]
    : (r["kind"] === "jsMarshal" || r["kind"] === "dynFrom") ? (r["value"] as IrExpr) : undefined;
  if (typed !== undefined && typed.type.kind === "record") {
    const sh = L.shapes.get(typed.type.shapeId);
    return sh === undefined || sh.indexValue !== undefined || sh.fields.some((f) => !fields.has(f.name));
  }
  if (r["kind"] === "jsOp" && r["op"] === "objLit") {
    const args = r["args"] as Record<string, unknown>[];
    for (let i = 0; i < args.length; i += 2) {
      const k = args[i]!;
      const lit = k["kind"] === "jsMarshal" ? (k["value"] as Record<string, unknown>) : k;
      if (lit["kind"] !== "strLit" || !fields.has(lit["value"] as string)) return true;
    }
    return false;
  }
  return true;
}

/** Does a function body hold a dynamic crossing of a composite or a
 * function value? (The pass's cheap entry test.) */
export function hasDynCrossing(n: unknown): boolean {
  if (n === null || typeof n !== "object") return false;
  if (Array.isArray(n)) return n.some(hasDynCrossing);
  const r = n as Record<string, unknown>;
  if (r["kind"] === "dynFrom" || r["kind"] === "dynCheck") {
    const t = (r["kind"] === "dynFrom" ? (r["value"] as IrExpr).type : (r["type"] as IrType)).kind;
    if (t !== "f64" && t !== "string" && t !== "bool" && t !== "dyn" && t !== "jsval" && t !== "undefinedT" && t !== "nullT" && t !== "bytes") return true;
  }
  if (r["kind"] === "jsExit" && spreadsIn(r["value"]).length > 0) return true;
  for (const key of Object.keys(r)) {
    if (key === "type" || key === "loc") continue;
    if (hasDynCrossing(r[key])) return true;
  }
  return false;
}

export const tkey = (t: IrType): string => typeKey(t);

/** A value of this type is an immutable primitive: it has no identity a
 * copy could lose and nothing could write through it (S125-J). */
const SCALAR_KINDS = new Set(["f64", "string", "bool", "bigint", "undefinedT", "nullT"]);
export const isScalar = (t: IrType): boolean => SCALAR_KINDS.has(t.kind);

export const isComposite = (t: IrType | undefined): boolean =>
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
export const DYN_READER = /^(insp\.|json\.|dyn\.(argStr|arrAt|arrLen|errInstanceof|hasKey|hasOwn|iterLive|iterPack|packPush|packPushSpread|packPushSpreadIter|structuredClone|cloneMissing|cloneTransferFail|this|toNumber|toString|toStringCoerce|typeof|objCreateNullProto)$)/;

/** Runtime helpers that write their first (dynamic) argument. */
export const DYN_WRITER = /^dyn\.(keySet|assign|assignAll|defineProps)$/;

/** Runtime helpers that answer a fresh dynamic value. */
export const DYN_FRESH_LIB = /^(json\.parse|dyn\.(structuredClone|objCreateNullProto|objKeys))$/;

/** Dynamic dispatch: methods that write their receiver, and methods that
 * compare by identity. */
export const DYN_MUTATING = new Set(["push", "pop", "shift", "unshift", "reverse", "sort", "splice", "fill", "copyWithin"]);

export const DYN_IDENTITY = new Set(["includes", "indexOf", "lastIndexOf"]);

/** Island operations that write an operand or run code that may. */
export const JS_WRITING_OPS = new Set(["setProp", "setIdx", "callMethod", "callFn", "callSpread", "construct", "defineGetter", "optCallMethod"]);

/** Methods that only read their receiver (the runtime's Array, String,
 * Number and Object.prototype readers): a call through island dispatch
 * writes nothing itself — a callback it runs is a program function whose
 * own writes are noted where they are. */
export const JS_READING_METHODS = new Set([
  "map", "filter", "slice", "concat", "join", "indexOf", "lastIndexOf", "includes", "find", "findIndex", "findLast",
  "findLastIndex", "some", "every", "forEach", "reduce", "reduceRight", "keys", "values", "entries", "toString", "at",
  "flat", "flatMap", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "split", "startsWith", "endsWith",
  "charAt", "charCodeAt", "codePointAt", "substring", "substr", "padStart", "padEnd", "replace", "replaceAll", "match",
  "matchAll", "search", "test", "exec", "hasOwnProperty", "toFixed", "toPrecision", "localeCompare", "repeat",
  "normalize", "toLocaleString", "valueOf", "toSorted", "toReversed", "toSpliced", "with", "getTime", "toISOString",
]);

/** The destructuring helper lowerJsvalBindingPattern and the assignment
 * form build: `new Function("v", ..., "(<pattern> = v); return [...]")`. */
export const isPatternHelper = (e: IrExpr): boolean =>
  e.kind === "jsOp" && e.op === "construct" && e.args[0]?.kind === "jsOp" && e.args[0].op === "globalGet" &&
  e.args[0].name === "Function" && e.args.length >= 3 &&
  ((): boolean => {
    const body = e.args[e.args.length - 1]!;
    return body.kind === "jsMarshal" && body.value.kind === "strLit" && /= v\);return \[[^\]]*\];$/.test(body.value.value);
  })();

/** A static of a builtin global that only reads its arguments. */
export const staticReadsArgs = (g: string | undefined, m: string): boolean =>
  g === "JSON" || g === "Math" || g === "Number" || g === "String" || g === "Boolean" || g === "Array" ||
  (g === "Object" && /^(keys|values|entries|getOwnPropertyNames|getOwnPropertyDescriptor|getOwnPropertyDescriptors|getPrototypeOf|is|hasOwn|fromEntries|isFrozen|isSealed|isExtensible)$/.test(m));

/** Methods that answer a scalar from their receiver: a call reads it once. */
export const JS_SCALAR_METHODS = new Set([
  "join", "toString", "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith", "charAt", "charCodeAt",
  "codePointAt", "toFixed", "toPrecision", "localeCompare", "hasOwnProperty", "test", "search", "toUpperCase",
  "toLowerCase", "trim", "trimStart", "trimEnd", "padStart", "padEnd", "repeat", "substring", "substr", "at",
  "getTime", "toISOString", "valueOf", "some", "every", "findIndex", "findLastIndex",
]);

/** An island-native literal (the one-world lanes' `{...}` / `[...]`). */
export const isIslandLit = (e: IrExpr): boolean => e.kind === "jsOp" && (e.op === "objLit" || e.op === "arrLit" || e.op === "objSpread");

export const isDynType = (t: IrType | undefined): boolean => t !== undefined && (t.kind === "dyn" || t.kind === "jsval");

/* The S125 (b) refusal reasons. UNKNOWN is judgeValue's answer when it
 * cannot follow the copy's binding: the copy is then judged by type. */
export const UNKNOWN = "\0unknown";
export const WRITE_TO = "the program writes to values of the slot's type, and a write through the copy would not reach the original";
export const WRITE_FROM = "the program writes to the original's fields, and the copy would not see the write";
export const IDENTITY = "the program compares values of these types by identity, and the copy is a different object";
export const KEYS = "the program prints, serializes, lists the keys of or tests the class of the copy, which carries only the slot's own fields and class";
