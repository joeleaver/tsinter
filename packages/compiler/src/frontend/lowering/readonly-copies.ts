/* Unit S125-J, M1 (SEMANTICS.md S125 amendment (J)): a read-only tuple
 * copied into a read-only array slot.
 *
 * `const MODES = ["a", "b"] as const` is a monomorphic tuple; handed to a
 * `readonly T[]` parameter it is REBUILT as an array (%tup.arr.N, S125
 * (b)), where JavaScript passes the same frozen-by-type object. The copy
 * could only be told apart from the original by a write through either
 * one (the other would not see it) or by an identity test, since an array
 * of scalars prints and lists its keys the same either way. The (b)
 * judgement answers writes BY TYPE wherever a binding's uses are not all
 * known, so any `string[]` written anywhere in the program (`values.push`)
 * refused paperclip's `parseEnum(raw, DEPLOYMENT_MODES)`.
 *
 * This judgement proves instead that neither side is ever written and
 * that nothing compares the array's type by identity:
 *
 *   - TypeScript types both sides read-only: the source expression is a
 *     `readonly [...]` tuple and its contextual type a `readonly T[]` (or
 *     ReadonlyArray), so no TypeScript code holding them as typed writes;
 *   - a cast could still alias either one as a mutable array, so every
 *     use of the source's binding and of the copy's binding is followed
 *     by the binding-use analysis (width-collect.ts) and must be one that
 *     neither writes nor lets the array go: an element or length read, a
 *     loop, a truth or nullish test, a print, a Set built from it, a
 *     non-mutating array method, another width copy (a new object), or a
 *     direct call of a program function whose parameter's own uses pass
 *     the same test. Anything else (a store, a return, a capture, a
 *     cast's assignment, a dynamic crossing, a call of unknown code)
 *     keeps the (b) judgement's answer;
 *   - no identity test (`===`, `includes` of arrays, a Set or Map key)
 *     applies to either side's IR type.
 *
 * The source must be a deep-fresh literal, or a binding assigned exactly
 * once from one and never captured; the copy must land in a binding that
 * nothing else assigns or captures. */
import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";
import { deepFresh, destBinding } from "./width-copy-fresh.js";
import { isCopyHelper, isScalar, tkey } from "./width-copy-tables.js";
import type { Binding, Site, UseSite, WidthCx } from "./width-cx.js";
import { bkey } from "./width-uses.js";

/** Array methods that read the receiver's spine and hand on no reference
 * to it (their results are scalars or fresh arrays of its scalars). */
const NON_MUTATING_METHODS = new Set(["length", "slice", "toReversed", "toSpliced", "with", "toSorted", "join", "indexOf", "includes"]);

/** The printing helpers console.log and util.format/inspect lower to:
 * they format the value into a string and keep nothing. */
const FORMAT_HELPER = /^%util\.(fmtcall|fmtapply|fmtarg|fmtv|insp)\./;

/** How deep the parameter-following recursion goes before it gives up. */
const MAX_DEPTH = 6;

/** Is the (b) copy at `s` — the only pair `from` into `to` — the
 * read-only-tuple-into-read-only-array copy no program can observe? */
export function readonlyCopyUnobserved(cx: WidthCx, s: Site, pairs: { from: IrType; to: IrType }[]): boolean {
  if (!/^%tup\.arr\.\d+$/.test(s.callee) || pairs.length !== 1) return false;
  const p = pairs[0]!;
  if (p.to.kind !== "array" || p.from.kind !== "record" || !isScalar(p.to.elem)) return false;
  const shape = cx.L.shapes.get(p.from.shapeId);
  if (!shape?.tuple || shape.fields.some((f) => !isScalar(f.type))) return false;
  if (cx.identity.has(tkey(p.to)) || cx.identity.has(tkey(p.from))) return false;
  if (!readonlyOnBothSides(cx.L, s.loc)) return false;
  if (!sourceNeverWritten(cx, s)) return false;
  const db = destBinding(cx, s);
  if (db === null) return false;
  return usesLeaveIt(cx, db, new Set([s.dest!.key]), 0);
}

/** The source of the copy is a fresh literal, or a binding assigned once
 * from one, never captured, whose every use leaves the array alone. */
function sourceNeverWritten(cx: WidthCx, s: Site): boolean {
  const arg = s.arg;
  if (arg === undefined) return false;
  if (deepFresh(cx, arg)) return true;
  if (arg.kind !== "varRef") return false;
  const key = bkey(cx, s.where, arg.localId);
  const b = cx.bindings.get(key);
  if (!b || b.captured || b.assigns.length !== 1 || !deepFresh(cx, b.assigns[0])) return false;
  return usesLeaveIt(cx, b, new Set([key]), 0);
}

/** Does every use of `b` leave the array unwritten and unshared? */
function usesLeaveIt(cx: WidthCx, b: Binding, seen: Set<string>, depth: number): boolean {
  if (b.useAt.length !== b.uses.length) return false;
  return b.useAt.every((u) => useLeavesIt(cx, u, seen, depth));
}

/** One use: reads, prints and copies leave the array alone; a direct call
 * of a program function does when its parameter's own uses do. */
function useLeavesIt(cx: WidthCx, u: UseSite, seen: Set<string>, depth: number): boolean {
  const pk = u.up["kind"] as string;
  switch (pk) {
    case "recordGet":
      return u.key === "obj" && !u.up["spreadCopy"];
    case "recordOrder":
    case "fieldGet":
      return u.key === "obj";
    // A folded tuple `t.length` (tuple-length.ts) reads the arity.
    case "numLit":
      return u.key === "tupleOf";
    // A value evaluated for effect and discarded (tuple-length.ts).
    case "exprStmt":
      return true;
    case "arrayGet":
      return u.key === "arr";
    case "forOf":
      return u.key === "iterable";
    case "setNew":
      return u.key === "seed";
    case "bytesNew":
      return u.key === "source";
    case "toBool":
    case "isUndef":
    case "toString":
    case "strConcat":
      return true;
    case "bin": {
      const op = u.up["op"] as string;
      const other = (u.key === "left" ? u.up["right"] : u.up["left"]) as IrExpr;
      const unit = other.type.kind === "undefinedT" || other.type.kind === "nullT" || other.kind === "unitLit";
      return (op === "===" || op === "!==" || op === "==" || op === "!=") && unit;
    }
    case "intrinsic":
      return u.key === "args" && (u.up["name"] === "console.log" || u.up["name"] === "console.error");
    case "jsonStringify":
      return true;
    case "arrIntrinsic":
      return u.key === "receiver" && NON_MUTATING_METHODS.has(u.up["method"] as string);
    // A local alias (`const t = xs`, a loop's own temporary) that nothing
    // else assigns or captures, whose own uses leave the array alone.
    case "varDecl":
      return u.key === "init" && aliasLeavesIt(cx, bkey(cx, u.fn, u.up["localId"] as string), seen, depth);
    case "call": {
      const callee = u.up["callee"] as string;
      if (u.key !== "args") return false;
      // Another width copy builds a new object from it.
      if (isCopyHelper(callee)) return true;
      // console.log's and util.format's formatting helpers print it.
      if (FORMAT_HELPER.test(callee)) return true;
      return paramLeavesIt(cx, u, callee, seen, depth);
    }
    default:
      return false;
  }
}

/** A direct call of a program function passing the array straight to a
 * parameter: that parameter's binding, never assigned or captured, must
 * leave it alone in turn. */
function paramLeavesIt(cx: WidthCx, u: UseSite, callee: string, seen: Set<string>, depth: number): boolean {
  if (depth >= MAX_DEPTH) return false;
  const fn = cx.byName.get(callee);
  if (fn === undefined || callee.startsWith("%")) return false;
  const args = u.up["args"] as unknown[];
  const i = args.indexOf(u.child);
  // (Past a pass-through check the argument is the check, which answers
  // its own argument.)
  if (i < 0 || i >= fn.params.length) return false;
  const key = bkey(cx, callee, fn.params[i]!.localId);
  if (seen.has(key)) return true;
  const b = cx.bindings.get(key);
  if (b === undefined) return true;
  if (b.captured || b.assigns.length !== 0) return false;
  seen.add(key);
  return usesLeaveIt(cx, b, seen, depth + 1);
}

/** A binding the array is stored into: assigned only that once, never
 * captured, and every use of it leaves the array alone. */
function aliasLeavesIt(cx: WidthCx, key: string, seen: Set<string>, depth: number): boolean {
  if (depth >= MAX_DEPTH) return false;
  if (seen.has(key)) return true;
  const b = cx.bindings.get(key);
  if (b === undefined) return true;
  if (b.captured || b.assigns.length !== 1) return false;
  seen.add(key);
  return usesLeaveIt(cx, b, seen, depth + 1);
}

/** TypeScript types the copied expression a read-only tuple and its
 * slot a read-only array. */
function readonlyOnBothSides(L: Lowerer, loc: SrcLoc): boolean {
  const node = expressionAt(L, loc);
  if (node === null) return false;
  let src: ts.Type;
  let ctx: ts.Type | undefined;
  try {
    src = L.checker.getTypeAtLocation(node);
    ctx = L.checker.getContextualType(node);
  } catch {
    return false;
  }
  return ctx !== undefined && readonlyParts(L, src) && readonlyParts(L, ctx);
}

/** Every part of `t` but null and undefined is a read-only array or tuple. */
function readonlyParts(L: Lowerer, t: ts.Type): boolean {
  const parts = (t.isUnionType() ? t.getTypes() : [t]).filter((p) => (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
  return parts.length > 0 && parts.every((p) => {
    if ((p.flags & ts.TypeFlags.Object) === 0) return false;
    const str = L.checker.typeToString(p);
    return str.startsWith("readonly ") || str.startsWith("ReadonlyArray<");
  });
}

/** The innermost expression spanning exactly `loc` (a copy's loc is its
 * argument's: node.getStart() to its end). */
function expressionAt(L: Lowerer, loc: SrcLoc): ts.Expression | null {
  const sf = L.program.getSourceFile(loc.file);
  if (sf === undefined) return null;
  let found: ts.Expression | null = null;
  ts.walkPreorder(sf, (n) => {
    if (n.pos > loc.start || n.end < loc.end) return "skip";
    if (n.getStart() === loc.start && n.end === loc.end && ts.isExpression(n)) found = n;
    return undefined;
  });
  return found;
}
