/* S125 (b)'s questions about one copy (SEMANTICS.md S125): is its type
 * written while the copy is held, do the two sides' keys or print differ,
 * is the original fresh (nothing else holds it), and what the copy's and
 * the original's bindings do with it. */
import type { IrExpr, IrType } from "../../ir/nodes.js";
import { BUILDER, isScalar, KEYS, tkey, UNKNOWN } from "./width-copy-tables.js";
import type { Binding, Site, WidthCx } from "./width-cx.js";
import { orderNoted } from "./fresh-literal-keys.js";
import { reachType } from "./width-reach.js";
import { bkey, hasRef, rootOf } from "./width-uses.js";

/** The own keys of a value of this type: its declared fields in render
 * order, and whether an index signature's overflow follows them (null:
 * not a keyed value). */
function ownKeys(cx: WidthCx, t: IrType): { declared: string[]; overflow: boolean } | null {
  if (t.kind === "object") {
    const c = cx.L.classes.get(t.className);
    return c ? { declared: c.def.fields.map((f) => f.name).filter((n) => !n.startsWith("%")), overflow: false } : null;
  }
  if (t.kind !== "record") return null;
  const sh = cx.L.shapes.get(t.shapeId);
  if (!sh) return null;
  return { declared: sh.declaredOrder ?? sh.fields.map((f) => f.name), overflow: sh.indexValue !== undefined };
}

function fieldNames(cx: WidthCx, t: IrType): string[] {
  if (t.kind === "record") return (cx.L.shapes.get(t.shapeId)?.fields ?? []).map((f) => f.name);
  if (t.kind === "object") return [...(cx.L.classes.get(t.className)?.fields.keys() ?? [])];
  return [];
}

/** Is a value of type `t` written — any of `fields` (default: all) for a
 * record or class, in place for an array — anywhere a copy taken at
 * `site` could still be held? A write in the same module initializer
 * (which runs once), in a top-level statement before the copy's, has
 * already happened; everything else (a write in any other function, a
 * closure, a later statement) counts. */
export function isWritten(cx: WidthCx, t: IrType, fields: string[] | undefined, site: Site | null, during: Set<string> | null = null, deadAfter: { fn: string; top: number } | null = null): boolean {
  if ((cx.judgingDyn ? cx.reachWDyn : cx.reachW).has(tkey(t))) return true;
  // A TRANSIENT copy (handed to a parameter that never lets it go) dies
  // when the call returns: only a write in a function the call can run
  // (`during`) can meet it. A copy whose binding is last read in
  // top-level statement `deadAfter.top` of its function cannot see a
  // write that function makes in a later statement.
  const counts = (key: string): boolean =>
    (cx.written.get(key) ?? []).some((w) =>
      // Judging a dynamic crossing (S125 (c)): a view accessor's own write
      // (island-views.ts) runs only for a store through that view, which
      // is noted as a dynamic write on its receiver where it is made.
      !((cx.judgingDyn || !cx.viewWritesLive) && /^%view\./.test(w.fn)) &&
      !(deadAfter !== null && w.fn === deadAfter.fn && w.top > deadAfter.top) &&
      (during !== null ? during.has(w.fn) : !(site !== null && w.fn === site.where && /^%init\.\d+$/.test(w.fn) && w.top < site.top)));
  const fs = fields ?? fieldNames(cx, t);
  if (t.kind === "object") {
    const root = rootOf(cx, t.className);
    const ctorCounts = cx.ctorLeaks.has(root) || cx.siteInCtor.has(root);
    return counts(`object:${root}:*`) ||
      fs.some((f) => counts(`object:${root}:${f}`) || (ctorCounts && cx.ctorWritten.has(`object:${root}:${f}`)));
  }
  if (t.kind === "record") {
    return counts(`record:${t.shapeId}:*`) || fs.some((f) => counts(`record:${t.shapeId}:${f}`));
  }
  return counts(tkey(t));
}

/** The source fields a copy into `to` reads: the target's own fields for
 * a plain record target; every field (and element) for an array or an
 * index-signature target, or an index-signature source. */
export function copiedFields(cx: WidthCx, from: IrType, to: IrType): string[] | undefined {
  if (to.kind !== "record") return undefined;
  const ts = cx.L.shapes.get(to.shapeId);
  const fs = from.kind === "record" ? cx.L.shapes.get(from.shapeId) : undefined;
  if (!ts || ts.indexValue || ts.tuple || fs?.indexValue) return undefined;
  return fieldNames(cx, to);
}

/** Do the copy's own keys differ from the original's? A target field
 * the source lacks is optional and holds undefined in the copy, which no
 * key observer reports (SEMANTICS.md S091). An index-signature target
 * captures every source key: its own declared fields first, then the
 * source's other declared fields and its overflow, in order (S031). */
export function keysDiffer(cx: WidthCx, from: IrType, to: IrType): boolean {
  if (from.kind === "array" && to.kind === "array") return false;
  if (from.kind === "record" && to.kind === "array") return false; // tuple → array: the same elements
  const a = ownKeys(cx, from);
  const b = ownKeys(cx, to);
  if (a === null || b === null) return true;
  const same = (x: string[], y: string[]): boolean => x.join("\0") === y.join("\0");
  // An index-signature target captures every source key, so the copy
  // holds the same keys; that a hybrid shape lists its declared fields
  // before its overflow, whatever the insertion order, is S031's.
  if (b.overflow) return false;
  // The overflow drops with the width.
  if (a.overflow) return true;
  return !same(b.declared.filter((n) => a.declared.includes(n)), a.declared);
}

/** Does printing tell them apart — their keys, or a class's name? */
export function printDiffer(cx: WidthCx, from: IrType, to: IrType): boolean {
  return keysDiffer(cx, from, to) || (from.kind === "object") !== (to.kind === "object") ||
    (from.kind === "object" && to.kind === "object" && from.className !== to.className);
}

export function fresh(cx: WidthCx, e: IrExpr | undefined): boolean {
  if (!e) return false;
  if (e.kind === "recordLit" || e.kind === "arrayLit") return true;
  // S125-J: GH #132's order note answers the literal it notes.
  const noted = orderNoted(e);
  if (noted !== null) return fresh(cx, noted);
  // An array a typed-array method builds (bytes hold numbers, never an
  // existing array).
  if (e.kind === "bytesIntrinsic" && e.type.kind === "array") return true;
  if (e.kind === "call" && BUILDER.test(e.callee)) return true;
  // A new array of the receiver's elements (map/filter/slice/...): the
  // SPINE is fresh (its elements are judged as the nested copies they are).
  if (e.kind === "call" && /^%arr\.(map|filter|flatMap|filterNarrow|concat)\./.test(e.callee)) return true;
  if (e.kind === "arrIntrinsic" && ["slice", "toSorted", "toReversed", "toSpliced", "with"].includes(e.method)) return true;
  if (e.kind === "new" && e.type.kind === "object") return !cx.ctorLeaks.has(rootOf(cx, e.type.className));
  // GH #118: a direct call of a program function that hands out only
  // values nothing else holds once it returns.
  if (e.kind === "call" && returnsFresh(cx, e.callee)) return true;
  return false;
}

/** A literal whose every part is a literal or a scalar value, through
 * union wraps, upcasts and union retags: nothing but the literal itself
 * references any of its parts. */
export function deepFresh(cx: WidthCx, e: IrExpr | undefined): boolean {
  if (!e) return false;
  switch (e.kind) {
    case "numLit": case "strLit": case "boolLit": case "unitLit":
      return true;
    case "unionWrap":
    // S125-J (M2): an `as const` retag of a fresh value is that value.
    case "upcast":
      return deepFresh(cx, e.value);
    case "call": {
      if (/^%(union|nullish)\.retag\.\d+$/.test(e.callee) && e.args.length === 1) return deepFresh(cx, e.args[0]);
      // (GH #132's order note answers the literal it notes.)
      const noted = orderNoted(e);
      return noted !== null ? deepFresh(cx, noted) : isScalar(e.type);
    }
    case "arrayLit":
      return !(e.spreads?.length) && e.elems.every((x) => deepFresh(cx, x));
    case "recordLit":
      return e.fields.every((f) => deepFresh(cx, f.value));
    default:
      // S125-J (M2): a scalar (`label` read from a string binding) holds
      // no reference, so nothing else can reach it through the literal.
      return isScalar(e.type);
  }
}

/** A value nothing else holds, through the union-building forms a
 * logical or conditional expression lowers to: a fresh literal or
 * builder, a scalar, or `&&` / `||` / `??` / `?:` of such values. */
function freshUnionArg(cx: WidthCx, e: IrExpr | undefined, depth = 0): boolean {
  if (!e || depth > 8) return false;
  if (deepFresh(cx, e) || fresh(cx, e)) return true;
  switch (e.kind) {
    case "unionWrap":
    case "upcast":
      return freshUnionArg(cx, e.value, depth + 1);
    case "ternary":
      return freshUnionArg(cx, e.then, depth + 1) && freshUnionArg(cx, e.else_, depth + 1);
    case "logical":
    case "nullish":
    case "orDefault": {
      const r = e as unknown as { left: IrExpr; right: IrExpr };
      return freshUnionArg(cx, r.left, depth + 1) && freshUnionArg(cx, r.right, depth + 1);
    }
    case "bin":
    case "unary":
      return !hasRef(cx, e.type);
    default:
      return !hasRef(cx, e.type);
  }
}

/** A `%union.retag.N` helper every call of which (they are all direct)
 * passes a value nothing else holds. */
export function retagArgsFresh(cx: WidthCx, name: string): boolean {
  if (!/^%union\.retag\.\d+$/.test(name)) return false;
  const memo = cx.retagMemo.get(name);
  if (memo !== undefined) return memo;
  let ok = true;
  let seen = 0;
  const scan = (n: unknown): void => {
    if (!ok || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) scan(x);
      return;
    }
    const r = n as Record<string, unknown>;
    if (r["kind"] === "call" && r["callee"] === name) {
      seen++;
      const args = r["args"] as IrExpr[];
      if (args.length !== 1 || !freshUnionArg(cx, args[0])) ok = false;
    } else if (r["kind"] === "orDefault" && r["retag"] === name) {
      // `u || d` retags its truthy left through the helper.
      seen++;
      if (!freshUnionArg(cx, r["left"] as IrExpr)) ok = false;
    } else if (r["kind"] === "funcRef" && r["name"] === name) {
      ok = false;
    }
    for (const key of Object.keys(r)) {
      if (key === "type" || key === "loc") continue;
      scan(r[key]);
    }
  };
  for (const f of cx.byName.values()) scan(f.body);
  const res = ok && seen > 0;
  cx.retagMemo.set(name, res);
  return res;
}

/** GH #118 (chess.js history()): does every `return` of this program
 * function answer a value no one else holds after the call — a fresh
 * value, a fresh-returning call, or a local of its own that it built
 * from a fresh value and only ever filled, read and returned (never
 * captured, reassigned, stored, passed on or handed out by a method that
 * answers its receiver)? Writes the function made to it happened before
 * the call returned, so a copy the caller takes is the only reference
 * left — as unobservable as a copy of a literal. Direct calls only: the
 * callee is exactly this function. */
function returnsFresh(cx: WidthCx, name: string): boolean {
  const memo = cx.freshMemo.get(name);
  if (memo !== undefined) return memo;
  cx.freshMemo.set(name, false); // recursion: assume not
  const f = cx.byName.get(name);
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
      owned.set(r["localId"] as string, (owned.get(r["localId"] as string) ?? 0) + (r["init"] && fresh(cx, r["init"] as IrExpr) ? 1 : 1000));
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
    if (!fresh(cx, v)) return false;
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
  cx.freshMemo.set(name, ok);
  return ok;
}

/** The source binding when the copy reads a plain binding. */
export function sourceBinding(cx: WidthCx, s: Site): Binding | null {
  if (s.arg?.kind !== "varRef") return null;
  return cx.bindings.get(bkey(cx, s.where, s.arg.localId)) ?? null;
}

/** Nothing else holds the original: its binding was assigned once, from a
 * fresh value, is never captured, and is only read or copied from. */
export function sourceIsSole(cx: WidthCx, s: Site): boolean {
  if (fresh(cx, s.arg)) return true;
  const b = sourceBinding(cx, s);
  if (!b || b.captured || b.assigns.length !== 1 || !fresh(cx, b.assigns[0])) return false;
  return b.uses.every((u) => u === "read" || u === "copy" || u === "keys" || u === "print");
}

/** The copy's own binding, when every use of the copy is one of it. */
export function destBinding(cx: WidthCx, s: Site): Binding | null {
  if (s.dest === null) return null;
  const b = cx.bindings.get(s.dest.key);
  if (!b) return s.dest.param ? { uses: [], useAt: [], parts: [], assigns: [], captured: false } : null;
  if (b.captured) return null;
  // A parameter has no assignment; a local or global exactly this one.
  if (b.assigns.length !== (s.dest.param ? 0 : 1)) return null;
  return b;
}

/** Does a value of type `t` contain (or is it) a value of type `inner`? */
function contains(cx: WidthCx, t: IrType, inner: IrType): boolean {
  let set = cx.containsMemo.get(tkey(t));
  if (!set) {
    const saved = cx.into;
    cx.into = new Set<string>();
    reachType(cx, t);
    set = cx.into;
    cx.into = saved;
    cx.containsMemo.set(tkey(t), set);
  }
  return set.has(tkey(inner));
}

/** Why a value of type `t`, held in binding `b` (whose every use is
 * known), lets the program tell a nested copy `p` from its original —
 * through the binding's own uses when `t` is the copy's type, and
 * through the parts read off it (followed into the loop variables and
 * callback parameters they are handed to). Null: it cannot. */
export function judgeValue(cx: WidthCx, b: Binding, t: IrType, p: { from: IrType; to: IrType }, depth: number): string | null {
  if (depth > 6) return UNKNOWN;
  const isCopy = tkey(t) === tkey(p.to);
  if (isCopy || contains(cx, t, p.to)) {
    if (b.uses.includes("print") && printDiffer(cx, p.from, p.to)) return KEYS;
    if ((b.uses.includes("keys") || cx.foldedKeys.has(tkey(p.to))) && keysDiffer(cx, p.from, p.to)) return KEYS;
    if (cx.foldedClass.has(tkey(p.to)) && printDiffer(cx, p.from, p.to)) return KEYS;
    if (b.uses.includes("other")) return UNKNOWN;
  }
  for (const part of b.parts) {
    if (!contains(cx, part.t, p.to)) continue;
    if (part.via !== undefined) {
      const vb = cx.bindings.get(part.via) ?? { uses: [], useAt: [], parts: [], assigns: [], captured: false };
      if (vb.captured || vb.assigns.length > 0) return UNKNOWN;
      const why = judgeValue(cx, vb, part.t, p, depth + 1);
      if (why) return why;
      continue;
    }
    if (part.use === "other") return UNKNOWN;
    if (tkey(part.t) === tkey(p.to)) {
      if (part.use === "print" && printDiffer(cx, p.from, p.to)) return KEYS;
      if (part.use === "keys" && keysDiffer(cx, p.from, p.to)) return KEYS;
    } else if (part.use !== "read" && printDiffer(cx, p.from, p.to)) {
      return KEYS;
    }
  }
  return null;
}
