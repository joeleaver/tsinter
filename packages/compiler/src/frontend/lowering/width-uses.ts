/* The width-copy pass's notes and use classifiers (SEMANTICS.md S125): how
 * the collection walk records a write, an escape or a dynamic write, the
 * reference-holding types of a value, and what each parent node makes of
 * its child — the binding uses, exposed parts, dynamic and ownership uses
 * the judgements read. */
import type { IrExpr, IrType } from "../../ir/nodes.js";
import { DYN_IDENTITY, DYN_MUTATING, DYN_READER, DYN_WRITER, HOF_HELPER, isComposite, isCopyHelper, isDynType, JS_SCALAR_METHODS, KEYS_HELPER, KEYS_KINDS, MUTATING_ARR, ORDER_HELPER, PASS_THROUGH, PRINT_HELPER, PRINT_KINDS, PURE_LIB, SPINE_READS, tkey, TRANSPARENT_HELPER } from "./width-copy-tables.js";
import type { Binding, Use, WidthCx } from "./width-cx.js";

/** A program function of any module: the entry's are bare names, every
 * other module's carry its file tag (`%m<i>.`, lowerer.ts fileTag) —
 * the same kind of function either way. (S125: paperclip's real sites
 * live in tagged modules, where the bare-name test made every call into
 * another module "unknown code" whose arguments escape with writes.) */
export function programFn(cx: WidthCx, name: string): boolean {
  return !name.startsWith("%") || (/^%m\d+\.[^%]/.test(name) && cx.byName.has(name));
}

export function transparentCallee(cx: WidthCx, name: string): boolean {
  if (programFn(cx, name)) return true;
  if (isCopyHelper(name) || TRANSPARENT_HELPER.test(name) || PASS_THROUGH.test(name)) return true;
  return cx.classPrefixes.some((p) => name.startsWith(p));
}

export function bkey(cx: WidthCx, fn: string, id: string): string {
  return (cx.globals.has(id) ? `g\0${id}` : `${fn}\0${id}`);
}

/** Notes a write under `key`, where it happens. */
export function noteWrite(cx: WidthCx, key: string): void {
  let at = cx.written.get(key);
  if (!at) cx.written.set(key, (at = []));
  at.push({ fn: cx.curFn, top: cx.curTop });
}

/** `view`: the value escapes only as the argument of a view factory
 * (island-views.ts) — dynamic code reaches it through the view, whose
 * stores are noted as dynamic writes where they are made. */
export function escape(cx: WidthCx, t: IrType, w: boolean, view = false, spec = false): void {
  const k = `${w ? "w" : "r"}${view ? "v" : ""}${spec ? "s" : ""}${tkey(t)}`;
  if (cx.escapedKeys.has(k)) return;
  cx.escapedKeys.add(k);
  cx.escaped.push({ t, w, view, spec });
}

export function noteDynWrite(cx: WidthCx, recv: IrExpr | null, method?: string, key?: string): void {
  // A view's own accessors (island-views.ts) write only the fresh
  // values they build (a keys list, a snapshot); their stores into the
  // typed value are typed writes, noted as such.
  if (/^%view\./.test(cx.curFn)) return;
  // The dynamic Object.fromEntries writes only the fresh object it builds.
  if (/^%obj\.fromEntries\.dyn\./.test(cx.curFn)) return;
  cx.dynWrites.push({ fn: cx.curFn, top: cx.curTop, recv, anc: cx.stack.map((e) => e[0]), ...(method !== undefined ? { method } : {}), ...(key !== undefined ? { key } : {}) });
}

/** The reference-holding types a value of type `t` is or contains (a
 * deep copy copies every one of them), and the function types inside
 * it (boxed with a copying thunk). */
export function refsOf(cx: WidthCx, t: IrType): { refs: IrType[]; fns: (IrType & { kind: "func" })[] } {
  const memo = cx.refsMemo.get(tkey(t));
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
        const s = cx.L.shapes.get(x.shapeId);
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
        for (const a of cx.L.unions.get(x.unionId)?.arms ?? []) walk(a);
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
  cx.refsMemo.set(tkey(t), out);
  return out;
}

export function hasRef(cx: WidthCx, t: IrType): boolean {
  return refsOf(cx, t).refs.length > 0;
}

export function binding(cx: WidthCx, k: string): Binding {
  let b = cx.bindings.get(k);
  if (!b) cx.bindings.set(k, (b = { uses: [], useAt: [], parts: [], assigns: [], captured: false }));
  return b;
}

export function rootOf(cx: WidthCx, c: string): string {
  let info = cx.L.classes.get(c);
  while (info?.base) info = info.base;
  return info?.def.name ?? c;
}

/** The use a parent of kind `pk` makes of its child under `key`. */
export function useOf(cx: WidthCx, parent: Record<string, unknown>, key: string): Use {
  const pk = parent["kind"] as string;
  switch (pk) {
    // GH #132: the own-key order slot is bookkeeping, not a field.
    case "recordOrder":
      return "read";
    case "recordGet":
      return key === "obj" && !parent["spreadCopy"] ? "read" : "other";
    // A folded tuple `t.length` (tuple-length.ts): the arity read.
    case "numLit":
      return key === "tupleOf" ? "read" : "other";
    // A value evaluated for effect and discarded (a tuple `.length`
    // receiver that may run a getter, tuple-length.ts): read, never kept.
    case "exprStmt":
      return "read";
    // An index-signature read: a key observation, and — when the value
    // it answers is composite — a part of the record read out (whose
    // own uses are followed like a recordGet's).
    case "recordKeyGet":
      return key === "obj" ? "read" : "other";
    // S125 (paperclip's zod callbacks, `new Set(ids).size === ids.length`):
    // a Set built from an array of scalars reads its spine and keeps
    // only the scalar elements (composite ones are exposed parts below).
    case "setNew":
      return key === "seed" ? "read" : "other";
    case "fieldGet":
    case "arrayGet":
    case "toBool":
    case "isUndef":
    case "unionDisc":
    case "unionIsTag":
    case "forOf":
    // A typed-array construction copies its source's numbers (GH #149).
    case "bytesNew":
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
      if (ORDER_HELPER.test(callee)) return "read";
      return "other";
    }
    default:
      if (PRINT_KINDS.has(pk)) return "print";
      if (KEYS_KINDS.has(pk)) return "keys";
      return "other";
  }
}

/** The composite parts a use of a `t` value hands to other code: an
 * array's elements to a loop, a callback loop or a method building a new
 * array; a record's field values to Object.values/entries. */
export function exposedParts(cx: WidthCx, t: IrType, parent: Record<string, unknown>, key: string): { t: IrType; via?: string }[] {
  const pk = parent["kind"];
  if (t.kind === "array") {
    if (!isComposite(t.elem)) return [];
    // A for-of hands each element to its loop variable.
    if (pk === "forOf" && key === "iterable") return [{ t: t.elem, via: bkey(cx, cx.curFn, parent["localId"] as string) }];
    // A callback loop hands each element to its callback's element
    // parameter — followed when the callback is a literal that does not
    // also take the array itself.
    if (pk === "call" && HOF_HELPER.test(parent["callee"] as string)) {
      const reduce = /^%arr\.reduce/.test(parent["callee"] as string);
      const cb = (parent["args"] as IrExpr[]).find((a) => a.kind === "closure");
      const fn = cb?.kind === "closure" ? cx.byName.get(cb.fnName) : undefined;
      const at = reduce ? 1 : 0;
      // filter/find/reduce/flatMap can also hand an element out as (part
      // of) their result, which is not followed.
      const keeps = !/^%arr\.(map|forEach|some|every|findIndex|findLastIndex)\./.test(parent["callee"] as string);
      if (!keeps && fn && fn.params.length <= at + 2 && fn.params[at]) return [{ t: t.elem, via: `${fn.name}\0${fn.params[at]!.localId}` }];
      return [{ t: t.elem }];
    }
    if (pk === "arrIntrinsic" && key === "receiver" && parent["method"] !== "length" && parent["method"] !== "join") return [{ t: t.elem }];
    // A Set seeded from the array stores its elements.
    if (pk === "setNew" && key === "seed") return [{ t: t.elem }];
    return [];
  }
  if (t.kind === "record" && pk === "call" && /^%obj\.(values|entries)\./.test(parent["callee"] as string)) {
    const sh = cx.L.shapes.get(t.shapeId);
    return [...(sh?.fields ?? []).map((f) => f.type), ...(sh?.indexValue ? [sh.indexValue] : [])].filter(isComposite).map((x) => ({ t: x }));
  }
  return [];
}

/** The first ancestor (from stack index `i` up) that does not just
 * hand the value on: a pass-through check, a conditional's branch, a
 * `&&`/`||`/`??` operand, a sequence's result, an upcast, a union wrap or narrow. */
export function forwardFrom(cx: WidthCx, i: number): number {
  while (i > 0) {
    const [anc, key] = cx.stack[i]!;
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
}

/** How the kinded ancestor at stack index `i` (and up) uses a DYNAMIC
 * value it holds: "ro" when the value is only read at once — tested,
 * printed, serialized, compared with a scalar, checked out into a typed
 * value (a copy judged on its own), or a member of it read that way —
 * and "other" otherwise. */
export function dynUseAt(cx: WidthCx, i: number, consuming = false, self: unknown = null): "ro" | "other" {
  if (i < 0) return "other";
  i = forwardFrom(cx, i);
  /** The node directly under stack entry `j` on the path. */
  const childOf = (j: number): unknown => (j + 1 < cx.stack.length ? cx.stack[j + 1]![0] : self);
  for (;;) {
    const [anc, key] = cx.stack[i]!;
    const ak = anc["kind"];
    // Island forms of the same steps (the one-world lanes): a member
    // read off the value, and the value retyped between dyn and jsval.
    const islandRead = ak === "jsOp" && key === "args" && (anc["op"] === "getProp" || anc["op"] === "getIdx") &&
      (anc["args"] as unknown[])[0] === childOf(i);
    const retype = (ak === "dynFromJsval" && key === "value") || (ak === "jsMarshal" && key === "value" && isDynType((anc["value"] as IrExpr).type));
    if (!((ak === "dynKeyGet" || ak === "dynDestrCheck") && key === "value") && !islandRead && !retype) break;
    if (i === 0) return "other";
    i = forwardFrom(cx, i - 1);
  }
  const [anc, key] = cx.stack[i]!;
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
      return consuming && refsOf(cx, anc["type"] as IrType).refs.length > 0 ? "other" : "ro";
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
}

/** The use a typed binding's reference makes, for ownership (its kinded
 * parent sits at stack index `i`). */
export function typedOwnUseAt(cx: WidthCx, i: number, t: IrType): { ok: boolean; stored?: IrExpr[] } {
  i = forwardFrom(cx, i);
  // A member of a literal that crosses right there is the crossing.
  for (let j = i; j >= 0; j--) {
    const [a, k] = cx.stack[j]!;
    if ((a["kind"] === "recordLit" && k === "fields") || (a["kind"] === "arrayLit" && k === "elems")) continue;
    if (j < i && a["kind"] === "dynFrom") return { ok: true };
    break;
  }
  const [anc, key] = cx.stack[i]!;
  const ak = anc["kind"] as string;
  const elemFree = t.kind !== "array" || !hasRef(cx, t.elem);
  if ((ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr")) {
    return { ok: !hasRef(cx, anc["type"] as IrType) };
  }
  if ((ak === "recordSet" || ak === "fieldSet" || ak === "recordKeySet") && key === "obj") return { ok: true, stored: [anc["value"] as IrExpr] };
  if ((ak === "fieldIncDec" && key === "obj") || ak === "toBool" || ak === "isUndef" || (ak === "numLit" && key === "tupleOf") || ak === "exprStmt") return { ok: true };
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
  const u = useOf(cx, anc, key);
  return { ok: u === "print" || u === "keys" };
}

/** The use a dynamic binding's reference `ref` makes, for ownership
 * (its kinded parent sits at stack index `i`). */
export function ownUseAt(cx: WidthCx, i: number, ref: unknown): { use: "ro" | "recv" | "exit" | "other"; stored?: IrExpr[] } {
  const [anc, key] = cx.stack[i]!;
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
    const up = i > 0 ? cx.stack[i - 1]![0] : null;
    if (up && up["kind"] === "dynCheck") return { use: "exit" };
  }
  // A callback loop hands the callback the elements — and the array
  // itself as the third argument, which a callback of fewer parameters
  // never receives.
  if (ak === "dynInvoke" && key === "recv" && /^(forEach|map|filter|some|every|find|findIndex)$/.test(anc["method"] as string)) {
    const cb = (anc["args"] as IrExpr[])[0];
    const f = cb?.kind === "dynFrom" && cb.value.kind === "closure" ? cx.byName.get(cb.value.fnName) : undefined;
    if (f && f.params.length < 3) return { use: "recv", stored: [] };
  }
  return dynUseAt(cx, i, false, ref) === "ro" ? { use: "ro" } : { use: "other" };
}

/** The local an out-crossing's copy (or a part read straight off it)
 * initializes, with the statement list its declaration sits in. */
export function holderAt(cx: WidthCx, i: number): { key: string; list: unknown[]; index: number } | undefined {
  if (i < 0) return undefined;
  i = forwardFrom(cx, i);
  for (;;) {
    const [anc, key] = cx.stack[i]!;
    const ak = anc["kind"];
    const read = (ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr");
    if (!read || i === 0) break;
    i = forwardFrom(cx, i - 1);
  }
  const [decl, dkey] = cx.stack[i]!;
  if (decl["kind"] !== "varDecl" || dkey !== "init") return undefined;
  let list: unknown[] | undefined;
  if (i === 0) list = cx.byName.get(cx.curFn)?.body as unknown[] | undefined;
  else {
    const [up, ukey] = cx.stack[i - 1]!;
    const v = up[ukey];
    if (Array.isArray(v)) list = v;
  }
  const index = list ? list.indexOf(decl) : -1;
  if (!list || index < 0) return undefined;
  return { key: bkey(cx, cx.curFn, decl["localId"] as string), list, index };
}

/** Does the out-crossing whose parent sits at stack index `i` build
 * (part of) a `return` statement's value? */
export function atReturn(cx: WidthCx, i: number): boolean {
  while (i >= 0) {
    i = forwardFrom(cx, i);
    const [anc, key] = cx.stack[i]!;
    const ak = anc["kind"];
    if (ak === "return") return true;
    const builds = (ak === "recordLit" && key === "fields") || (ak === "arrayLit" && key === "elems") || (ak === "unionWrap" && key === "value") || (ak === "upcast" && key === "value");
    if (!builds) return false;
    i--;
  }
  return false;
}

/** How the ancestors use a TYPED value an out-crossing just built: true
 * when it is consumed at once without anything holding it or a part of
 * it — a scalar read off it, a print, a key listing. */
export function consumedAt(cx: WidthCx, i: number, t: IrType): boolean {
  if (i < 0) return false;
  i = forwardFrom(cx, i);
  let part = t;
  for (;;) {
    const [anc, key] = cx.stack[i]!;
    const ak = anc["kind"];
    const read = (ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr");
    if (!read) break;
    part = anc["type"] as IrType;
    if (!hasRef(cx, part)) return true;
    if (i === 0) return false;
    i = forwardFrom(cx, i - 1);
  }
  const [anc, key] = cx.stack[i]!;
  const use = useOf(cx, anc, key);
  return use === "print" || use === "keys" || (use === "read" && exposedParts(cx, part, anc, key).length === 0);
}
