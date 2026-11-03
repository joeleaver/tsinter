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
const TRANSPARENT_HELPER = /^%(union\.(retag|narrow|strand|recv)|nullish\.retag|unit\.strand|deferred\.read|fn\d+|arr\.(map|filter|forEach|reduce|reduceRight|find|findIndex|findLast|findLastIndex|some|every|flatMap|filterNarrow|concat)|object\.groupBy|map\.(groupBy|keys|values|entries)|obj\.fromEntries)(\.|_|$|\d)/;
/** The array HOF loops alone: they read the array's spine. */
const HOF_HELPER = /^%arr\.(map|filter|forEach|reduce|reduceRight|find|findIndex|findLast|findLastIndex|some|every|flatMap|filterNarrow)\./;
/** Helpers that BUILD a fresh record or map and return it: their own
 * writes construct it (no one else holds it yet). */
const BUILDER = /^%(object\.groupBy|map\.groupBy|obj\.fromEntries)\./;
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

export function widthCopyPass(L: Lowerer, functions: IrFunction[]): void {
  const byName = new Map<string, IrFunction>();
  for (const f of functions) byName.set(f.name, f);
  if (![...byName.keys()].some(isCopyHelper)) return;

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
  const escaped: { t: IrType; w: boolean }[] = [];
  const escapedKeys = new Set<string>();
  const escape = (t: IrType, w: boolean): void => {
    const k = `${w ? "w" : "r"}${tkey(t)}`;
    if (escapedKeys.has(k)) return;
    escapedKeys.add(k);
    escaped.push({ t, w });
  };
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
      escape(t, mode === "w");
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
        const read = (ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr");
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
  for (const e of escaped) if (e.w) reachType(e.t);

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
  const isWritten = (t: IrType, fields: string[] | undefined, site: Site | null, during: Set<string> | null = null): boolean => {
    if (reachW.has(tkey(t))) return true;
    // A TRANSIENT copy (handed to a parameter that never lets it go) dies
    // when the call returns: only a write in a function the call can run
    // (`during`) can meet it.
    const counts = (key: string): boolean =>
      (written.get(key) ?? []).some((w) =>
        during !== null ? during.has(w.fn) : !(site !== null && w.fn === site.where && /^%init\.\d+$/.test(w.fn) && w.top < site.top));
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
    return false;
  };
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
          if (!PURE_LIB.test(r["fn"] as string)) suspends = true;
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
      } else {
        const j = partsKnown ? judgeValue(db!, top.to, p, 0) : UNKNOWN;
        why = j === UNKNOWN ? byType() : j;
      }
      // (Comparing ORIGINALS involves no copy: a copy's static type is the
      // slot's, so a test that could meet one is on the slot's type.)
      if (!why && !(isTop && sole) && isWritten(p.from, copiedFields(p.from, p.to), s, (isTop ? transient : partsTransient) ? calleeReach!.fns : null)) why = WRITE_FROM;
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
}
