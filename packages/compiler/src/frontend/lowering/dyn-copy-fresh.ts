/* S125 (c)'s ownership questions (SEMANTICS.md S125): is a value crossing
 * into or out of the dynamic world held by no one else — fresh, deeply
 * fresh, or the sole owner of its parts. */
import type { IrExpr } from "../../ir/nodes.js";
import { dynArmKey } from "./dyn-arm.js";
import { fresh } from "./width-copy-fresh.js";
import { DYN_FRESH_LIB, isDynType, isIslandLit, PASS_THROUGH, tkey } from "./width-copy-tables.js";
import type { DynJudgeCx } from "./width-cx.js";
import { bkey, hasRef, programFn, refsOf } from "./width-uses.js";

export function unwrap(cx: DynJudgeCx, e: IrExpr | undefined): IrExpr | undefined {
  // (jsMarshal of a dynamic value is the same value retyped — one world.)
  while (e && ((e.kind === "call" && PASS_THROUGH.test(e.callee)) || e.kind === "upcast" || e.kind === "downcast" || e.kind === "dynDestrCheck" || e.kind === "dynFromJsval" ||
    (e.kind === "jsMarshal" && isDynType(e.value.type)))) {
    e = e.kind === "call" ? e.args[0] : e.value;
  }
  return e;
}

/** A module global read inside a function other than a module's init:
 * the binding still holds the value after the function returns (and
 * across its calls), so a value read from it is never one nothing else
 * holds. */
function heldElsewhere(cx: DynJudgeCx, fn: string, id: string): boolean {
  return cx.globals.has(id) && !/^%init\./.test(fn);
}

/** A function literal whose result is on the dynamic arm this pass. */
export function resultOnArm(cx: DynJudgeCx, fn: string): boolean {
  const n = cx.L.dynArmFnNodes.get(fn);
  return n !== undefined && cx.L.dynArmSites.has(`ret:${dynArmKey(n)}`);
}

/** A binding assigned exactly once, never captured, with that value. */
export function onlyValue(cx: DynJudgeCx, fn: string, id: string): IrExpr | null {
  const b = cx.bindings.get(bkey(cx, fn, id));
  return b && !b.captured && b.assigns.length === 1 ? b.assigns[0]! : null;
}

/** A typed value no one else holds ALL THE WAY DOWN (a deep copy
 * copies every part): a literal whose reference-holding members are
 * themselves such values, a new array of scalars, or a binding
 * initialized with one whose only use is this. */
export function dynDeepFresh(cx: DynJudgeCx, e: IrExpr | undefined, fn: string, depth = 0): boolean {
  e = unwrap(cx, e);
  if (!e || depth > 8) return false;
  if (!hasRef(cx, e.type)) return true;
  switch (e.kind) {
    case "recordLit":
      return e.fields.every((f) => dynDeepFresh(cx, f.value, fn, depth + 1));
    case "arrayLit":
      return e.elems.every((x) => x !== null && typeof x === "object" && "kind" in x && dynDeepFresh(cx, x as IrExpr, fn, depth + 1));
    case "unionWrap":
    case "upcast":
      return dynDeepFresh(cx, e.value, fn, depth + 1);
    case "dynCheck":
      // The checked copy of a dynamic value nothing else holds (a
      // JavaScript literal `[]` or `Object.keys(o)` checked into its
      // inferred type): the copy is all there is.
      return uniqueDyn(cx, e.value, fn, depth + 1);
    case "ternary":
      return dynDeepFresh(cx, e.then, fn, depth + 1) && dynDeepFresh(cx, e.else_, fn, depth + 1);
    case "logical":
    case "nullish":
    case "orDefault": {
      const r = e as unknown as { left: IrExpr; right: IrExpr };
      return dynDeepFresh(cx, r.left, fn, depth + 1) && dynDeepFresh(cx, r.right, fn, depth + 1);
    }
    case "arrIntrinsic":
      // sort, reverse, fill and copyWithin answer their receiver.
      if (["sort", "typedSort", "reverse", "fill", "copyWithin"].includes(e.method)) return dynDeepFresh(cx, e.receiver, fn, depth + 1);
      return fresh(cx, e) && (e.type.kind !== "array" || !hasRef(cx, e.type.elem));
    case "seqExpr":
      // A temporary the sequence builds and answers.
      return ownedTyped(cx, e.result, fn, depth + 1);
    case "callValue": {
      // A call through a function value: every function that can flow
      // to the callee returns a value it built from its own locals.
      const gs = cx.alias.callees(e.callee, fn);
      return gs !== null && gs.length > 0 && gs.every((g) => cx.byName.has(g) && returnsOwned(cx, g, depth + 1));
    }
    case "strIntrinsic":
    case "regexIntrinsic":
      // String and regex methods build what they return (`s.split("")`,
      // a match array of strings).
      return true;
    case "varRef": {
      const b = cx.bindings.get(bkey(cx, fn, e.localId));
      return !!b && !b.captured && !heldElsewhere(cx, fn, e.localId) && b.assigns.length === 1 && b.uses.length === 1 && dynDeepFresh(cx, b.assigns[0], fn, depth + 1);
    }
    case "libCall":
      // The runtime builds the composites it returns (`s.split(" ")`, a
      // directory listing, a regex match); none is a program value.
      // (process.argv and the like answer one shared value.)
      return !/^(dyn|process|global|emitter|stdin)\./.test(e.fn);
    case "call":
      // A map whose callback returns values it built (paperclip's
      // `names.map((n) => [n, one(n)])`): a fresh spine of owned values.
      if (/^%arr\.map\.\d+$/.test(e.callee) && e.args.length === 2) {
        const cb = unwrap(cx, e.args[1]);
        if (cb?.kind === "closure" && cx.byName.has(cb.fnName)) return returnsOwned(cx, cb.fnName, depth + 1);
      }
      // A program function every return of which builds a value from
      // its own locals.
      if ((programFn(cx, e.callee) || /^%fn\d+$/.test(e.callee)) && cx.byName.has(e.callee)) return returnsOwned(cx, e.callee, depth + 1);
      return fresh(cx, e) && (e.type.kind !== "array" || !hasRef(cx, e.type.elem));
    default:
      // A fresh spine (map/filter/slice, a builder, `new`) of scalars.
      return fresh(cx, e) && (e.type.kind !== "array" || !hasRef(cx, e.type.elem));
  }
}

function returnsOwned(cx: DynJudgeCx, name: string, depth: number): boolean {
  const memo = cx.returnsOwnedMemo.get(name);
  if (memo !== undefined) return memo;
  cx.returnsOwnedMemo.set(name, false); // recursion: not proven
  const f = cx.byName.get(name)!;
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
  const ok = !bare && rets.length > 0 && rets.every((v) => ownedTyped(cx, v, name, depth));
  cx.returnsOwnedMemo.set(name, ok);
  return ok;
}

/** A dynamic value nothing else holds: built fresh (JSON.parse, a
 * dynamic literal of such values, a crossing of a deeply fresh typed
 * value), a member of one, or a binding holding one whose only use is
 * this. */
export function uniqueDyn(cx: DynJudgeCx, e: IrExpr | undefined, fn: string, depth = 0): boolean {
  e = unwrap(cx, e);
  if (!e || depth > 8) return false;
  if (!isDynType(e.type)) return !hasRef(cx, e.type);
  switch (e.kind) {
    case "libCall":
      // Object.assign answers its target, which takes the sources' own
      // property values: fresh when the target is and those values
      // are scalars or themselves fresh.
      if (e.fn === "dyn.assign" || e.fn === "dyn.assignAll" || e.fn === "dyn.assignExcept") {
        return uniqueDyn(cx, e.args[0], fn, depth + 1) && e.args.slice(1).every((a) => shallowFresh(cx, a, fn, depth + 1));
      }
      return DYN_FRESH_LIB.test(e.fn);
    case "dynArrLit":
      return e.elems.every((x) => uniqueDyn(cx, x, fn, depth + 1));
    case "dynObjLit":
      return (e.fields ?? []).every((f) => uniqueDyn(cx, f.value, fn, depth + 1));
    case "dynFrom":
      return dynDeepFresh(cx, e.value, fn, depth + 1);
    // A typed value marshaled into the island (a literal's scalar
    // member): as fresh as the value (a dyn one unwraps above).
    case "jsMarshal":
      return dynDeepFresh(cx, e.value, fn, depth + 1);
    case "dynKeyGet":
      return uniqueDyn(cx, e.value, fn, depth + 1);
    case "seqExpr":
      return uniqueDyn(cx, e.result, fn, depth + 1);
    case "jsOp":
      // An island literal of such values (its marshaled keys are
      // strings), a member of one, or a spread completion onto one.
      if (e.op === "arrLit" || e.op === "objLit") return e.args.every((x) => uniqueDyn(cx, x, fn, depth + 1));
      if (e.op === "getProp" || e.op === "getIdx") return uniqueDyn(cx, e.args[0], fn, depth + 1);
      if (e.op === "objSpread") return uniqueDyn(cx, e.args[0], fn, depth + 1) && e.args.slice(1).every((a) => shallowFresh(cx, a, fn, depth + 1));
      return false;
    case "dynInvoke":
      // sort and reverse answer their receiver.
      return (e.method === "sort" || e.method === "reverse") && uniqueDyn(cx, e.recv, fn, depth + 1);
    case "call":
      // An island view of a typed value (U1b: a JS evolving binding
      // reassigned from a typed result) shares that value's storage:
      // nothing else holds it when nothing else holds the typed value.
      // The dynamic Object.fromEntries (lower-containers.ts) builds a
      // fresh object holding the pairs' values: nothing else holds it
      // when nothing else holds the pairs.
      if (/^%obj\.fromEntries\.dyn\.\d+$/.test(e.callee)) {
        const a = unwrap(cx, e.args[0]);
        if (a !== undefined && a.kind === "jsMarshal") return dynDeepFresh(cx, a.value, fn, depth + 1);
        return uniqueDyn(cx, e.args[0], fn, depth + 1);
      }
      return /^%view\.\d+$/.test(e.callee) && dynDeepFresh(cx, e.args[0], fn, depth + 1);
    case "varRef": {
      const b = cx.bindings.get(bkey(cx, fn, e.localId));
      // One read in all: every value the binding ever holds is fresh
      // (an evolving `let flags = []` reassigned from a fresh result),
      // so the one read takes a value nothing else holds.
      if (!b || b.captured || heldElsewhere(cx, fn, e.localId) || b.assigns.length === 0 || (cx.dynUses.get(bkey(cx, fn, e.localId)) ?? []).length !== 1) return false;
      return b.assigns.every((a) => uniqueDyn(cx, a, fn, depth + 1));
    }
    default:
      return false;
  }
}

/** A value whose own property VALUES nothing else holds (Object.assign
 * and spreads take those, not the value itself). */
function shallowFresh(cx: DynJudgeCx, a: IrExpr | undefined, fn: string, depth: number): boolean {
  const v = unwrap(cx, a);
  if (!v) return false;
  if (v.kind === "dynFrom") {
    const top = tkey(v.value.type);
    return refsOf(cx, v.value.type).refs.every((r) => tkey(r) === top);
  }
  // Object.assign's argument pack: an array built here of sources
  // pushed in, handed to the one call.
  if (v.kind === "varRef") {
    const key = bkey(cx, fn, v.localId);
    const init = unwrap(cx, onlyValue(cx, fn, v.localId) ?? undefined);
    const uses = cx.ownUses.get(key) ?? [];
    if (init?.kind === "dynArrLit" && init.elems.length === 0 && uses.filter((u) => u.use === "other").length === 1 &&
        uses.every((u) => u.use === "other" || (u.use === "recv" && (u.stored ?? []).every((x) => shallowFresh(cx, x, fn, depth + 1))))) {
      return true;
    }
  }
  return uniqueDyn(cx, v, fn, depth);
}

/** A dynamic value built fresh and held only by the binding `e` names:
 * a write to ITS OWN members changes no copy. */
export function freshRooted(cx: DynJudgeCx, e: IrExpr | null, fn: string): boolean {
  const v = unwrap(cx, e ?? undefined);
  if (!v) return false;
  // A receiver built right there (`JSON.parse(s).sort(f)`) is a new object
  // at the moment of the write.
  if ((v.kind === "libCall" && DYN_FRESH_LIB.test(v.fn)) || v.kind === "dynArrLit" || v.kind === "dynObjLit" || isIslandLit(v)) return true;
  if (v.kind !== "varRef") return false;
  const init = onlyValue(cx, fn, v.localId);
  const i = unwrap(cx, init ?? undefined);
  if (!i) return false;
  if (!((i.kind === "libCall" && DYN_FRESH_LIB.test(i.fn)) || i.kind === "dynArrLit" || i.kind === "dynObjLit" || isIslandLit(i))) return false;
  // ...and the binding never hands the object anywhere (an alias, an
  // argument, an element pushed elsewhere would make it reachable as
  // something a copy was taken from).
  return (cx.ownUses.get(bkey(cx, fn, v.localId)) ?? []).every((u) => u.use !== "other");
}

/** The binding a dynamic expression reads from (through member reads). */
export function rootKey(cx: DynJudgeCx, e: IrExpr | null | undefined, fn: string): string | null {
  let v = unwrap(cx, e ?? undefined);
  while (v && (v.kind === "dynKeyGet" || (v.kind === "jsOp" && (v.op === "getProp" || v.op === "getIdx")))) {
    v = unwrap(cx, v.kind === "dynKeyGet" ? v.value : v.args[0]);
  }
  return v?.kind === "varRef" ? bkey(cx, fn, v.localId) : null;
}

/** A typed value built from locals of the function that nothing else
 * can reach once it returns: literals of such values, and local
 * bindings initialized fresh, used only by reads of scalars, writes in
 * place storing such values, loops handing on no reference, printing,
 * and crossings — and captured only by callbacks an array loop runs
 * before returning. */
export function ownedTyped(cx: DynJudgeCx, e: IrExpr | undefined, fn: string, depth = 0): boolean {
  e = unwrap(cx, e);
  if (!e || depth > 6) return false;
  if (!hasRef(cx, e.type) || dynDeepFresh(cx, e, fn)) return true;
  if (e.kind === "recordLit") return e.fields.every((f) => ownedTyped(cx, f.value, fn, depth + 1));
  if (e.kind === "arrayLit") return e.elems.every((x) => x !== null && typeof x === "object" && "kind" in x && ownedTyped(cx, x as IrExpr, fn, depth + 1));
  if (e.kind !== "varRef") return false;
  const key = bkey(cx, fn, e.localId);
  if (key.startsWith("g\0")) return false;
  const b = cx.bindings.get(key);
  if (!b || b.assigns.length === 0 || !b.assigns.every((a) => ownedTyped(cx, a, fn, depth + 1))) return false;
  const keys = [key];
  if (b.captured) {
    for (const c of cx.closureCaptures) {
      const i = c.fn === fn ? c.captures.indexOf(e.localId) : -1;
      if (i < 0) continue;
      const g = cx.byName.get(c.fnName);
      const gc = g?.captures?.[i];
      if (!c.transient || !gc) return false;
      keys.push(bkey(cx, c.fnName, gc.localId));
    }
  }
  return keys.every((k) => (cx.typedOwnUses.get(k) ?? []).every((u) =>
    u.ok && (u.stored ?? []).every((x) => !hasRef(cx, x.type) || ownedTyped(cx, x, k.split("\0")[0]!, depth + 1))));
}
