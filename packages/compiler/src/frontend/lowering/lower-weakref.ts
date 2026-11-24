/* WeakRef and FinalizationRegistry (paperclip's stdlib batch 3,
 * SEMANTICS.md S151): a WeakRef holds its target strongly and deref()
 * answers it; a registry evaluates its cleanup callback and every
 * register() argument, then checks the target as Node does (Node's
 * CanBeHeldWeakly: an object, a function or a symbol not registered with
 * Symbol.for), and never calls
 * the callback (the WasmGC heap reports no collection to the program —
 * the spec's "may never be called"). types.ts maps both to one-field
 * records. unregister and the other members keep the SC2020 fence. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { dynUndefinedExpr, nodeThrowExpr } from "./lowerer.js";
import { locOf } from "../program.js";
import { BOOL, DYN, F64, STRING, SYMBOL_T, UNDEFINED_T, typeKey, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/nodes.js";

function recordField(L: Lowerer, t: ReturnType<Lowerer["mapTypeOf"]>, field: string) {
  if (t?.kind !== "record") return null;
  const f = L.shapes.get(t.shapeId)?.fields.find((x) => x.name === field);
  return f === undefined ? null : { rec: t, field: f };
}

/** `new WeakRef(target)` / `new FinalizationRegistry(cleanup)` on the
 * stdlib globals; null for anything else. */
export function lowerWeakRefNew(L: Lowerer, expr: ts.NewExpression, symbol: ts.Symbol | undefined): IrExpr | null {
  if (!L.sharedDynamic || !symbol || (symbol.name !== "WeakRef" && symbol.name !== "FinalizationRegistry") || !L.isStdlibSymbol(symbol)) return null;
  const loc = locOf(expr);
  const args = expr.arguments ?? [];
  const t = L.mapTypeOf(L.typeOf(expr));
  if (symbol.name === "FinalizationRegistry") {
    const slot = recordField(L, t, "%finreg");
    if (slot === null) return L.badType(expr, L.typeOf(expr));
    if (args.length !== 1 || ts.isSpreadElement(args[0]!)) return L.noLowering(`new FinalizationRegistry with ${args.length} arguments`, expr);
    const cb = L.lowerExpr(args[0]!);
    if (cb.type.kind !== "func") {
      return L.noLowering("new FinalizationRegistry with a cleanup that is not a function value", args[0]!);
    }
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: cb, loc }],
      result: { kind: "recordLit", fields: [{ name: "%finreg", value: { kind: "numLit", value: 0, type: F64, loc } }], type: slot.rec, loc },
      type: slot.rec,
      loc,
    };
  }
  const slot = recordField(L, t, "%weakref");
  if (slot === null) return L.badType(expr, L.typeOf(expr));
  if (args.length !== 1 || ts.isSpreadElement(args[0]!)) return L.noLowering(`new WeakRef with ${args.length} arguments`, expr);
  const target = L.coerceToExpected(L.lowerExpr(args[0]!), slot.field.type);
  const stmts: IrStmt[] = [];
  let value = target;
  if (target.type.kind === "dyn" || target.type.kind === "symbol") {
    const d = L.declareHiddenLocal("%wrTarget", target.type);
    stmts.push({ kind: "varDecl", localId: d.id, init: target, loc });
    value = { kind: "varRef", localId: d.id, type: target.type, loc };
    stmts.push(weakTargetCheck(L, value, "WeakRef: invalid target", loc));
  }
  const lit: IrExpr = { kind: "recordLit", fields: [{ name: "%weakref", value }], type: slot.rec, loc };
  return stmts.length === 0 ? lit : { kind: "seqExpr", stmts, result: lit, type: slot.rec, loc };
}

/** Node's CanBeHeldWeakly over `v` (a dyn or a symbol read): an object, a
 * function, or a symbol not registered with `Symbol.for`. */
function canBeHeldWeakly(L: Lowerer, v: IrExpr, loc: SrcLoc): IrExpr {
  const or = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "logical", op: "||", left, right, type: BOOL, loc });
  const unregistered = (sym: IrExpr): IrExpr => {
    // Symbol.keyFor's `string | undefined` (canonical arm order)
    const unionId = L.unions.intern([STRING, UNDEFINED_T].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1)));
    const keyT = { kind: "union" as const, unionId };
    return {
      kind: "unionIsTag",
      unionId,
      tag: L.armTag(unionId, UNDEFINED_T),
      negated: false,
      value: { kind: "libCall", fn: "sym.keyFor", args: [sym], type: keyT, loc },
      type: BOOL,
      loc,
    };
  };
  if (v.type.kind === "symbol") return unregistered(v);
  const isSymbol: IrExpr = {
    kind: "strEq",
    negated: false,
    left: { kind: "libCall", fn: "dyn.typeof", args: [v], type: STRING, loc },
    right: { kind: "strLit", value: "symbol", type: STRING, loc },
    type: BOOL,
    loc,
  };
  // dynTest "object" follows typeof, so it is true for null: CanBeHeldWeakly
  // rejects null (Node's "invalid target"), so the object arm excludes it.
  const object: IrExpr = {
    kind: "logical",
    op: "&&",
    left: { kind: "dynTest", test: "object", value: v, type: BOOL, loc },
    right: { kind: "dynTest", test: "null", negated: true, value: v, type: BOOL, loc },
    type: BOOL,
    loc,
  };
  return or(
    or(object, { kind: "dynTest", test: "function", value: v, type: BOOL, loc }),
    { kind: "logical", op: "&&", left: isSymbol, right: unregistered({ kind: "dynCheck", value: v, type: SYMBOL_T, loc }), type: BOOL, loc },
  );
}

/** `if (!CanBeHeldWeakly(v)) throw new TypeError(message)` */
function weakTargetCheck(L: Lowerer, v: IrExpr, message: string, loc: SrcLoc): IrStmt {
  return {
    kind: "if",
    cond: { kind: "unary", op: "!", operand: canBeHeldWeakly(L, v, loc), type: BOOL, loc },
    then: [{ kind: "exprStmt", expr: nodeThrowExpr(1, "", message, F64, loc), loc }],
    else_: null,
    loc,
  };
}

/** `ref.deref()` and `registry.register(target, holdings, token?)`; null
 * for any other call. */
export function lowerWeakRefCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  const recvT = L.mapTypeOf(L.typeOf(access.expression));
  const ref = recordField(L, recvT, "%weakref");
  const reg = ref === null ? recordField(L, recvT, "%finreg") : null;
  if ((ref === null && reg === null) || !L.sharedDynamic) return null;
  const loc = locOf(call);
  const member = access.name.text;
  if (call.questionDotToken || access.questionDotToken) return null;
  if (ref !== null) {
    if (member !== "deref" || call.arguments.length !== 0) return null;
    const receiver = L.lowerExpr(access.expression);
    const get: IrExpr = { kind: "recordGet", obj: receiver, shapeId: ref.rec.shapeId, field: "%weakref", type: ref.field.type, loc };
    const want = L.mapTypeOf(L.typeOf(call));
    return want === null ? get : L.coerceToExpected(get, want);
  }
  if (member !== "register") return null;
  const args = call.arguments;
  if (args.length < 2 || args.length > 3 || args.some((a) => ts.isSpreadElement(a))) {
    return L.noLowering(`FinalizationRegistry.register with ${args.length} arguments`, call);
  }
  // A fresh holdings literal can never be the target (Node's SameValue
  // check); any other holdings expression refuses by name.
  let h: ts.Expression = args[1]!;
  while (ts.isParenthesizedExpression(h)) h = h.expression;
  if (!ts.isObjectLiteralExpression(h)) {
    return L.noLowering("FinalizationRegistry.register with holdings other than an object literal", args[1]!);
  }
  const stmts: IrStmt[] = [{ kind: "exprStmt", expr: L.lowerExpr(access.expression), loc }];
  // Node evaluates every argument, then checks the target.
  let target = L.lowerExpr(args[0]!);
  if (target.type.kind === "jsval") target = { kind: "dynFromJsval", value: target, type: DYN, loc };
  let check: IrStmt | null = null;
  if (target.type.kind === "dyn" || target.type.kind === "symbol") {
    const d = L.declareHiddenLocal("%frTarget", target.type);
    stmts.push({ kind: "varDecl", localId: d.id, init: target, loc });
    check = weakTargetCheck(L, { kind: "varRef", localId: d.id, type: target.type, loc }, "FinalizationRegistry.prototype.register: invalid target", loc);
  } else if (target.type.kind !== "record" && target.type.kind !== "object" && target.type.kind !== "func" && target.type.kind !== "array" && target.type.kind !== "map" && target.type.kind !== "set") {
    return L.noLowering(`FinalizationRegistry.register of a '${L.fmt(target.type)}' target`, args[0]!);
  } else {
    stmts.push({ kind: "exprStmt", expr: target, loc });
  }
  stmts.push({ kind: "exprStmt", expr: L.lowerExpr(args[1]!), loc });
  if (args.length === 3) {
    const tok = L.lowerExpr(args[2]!);
    if (tok.type.kind !== "record" && tok.type.kind !== "object") {
      return L.noLowering(`FinalizationRegistry.register with a '${L.fmt(tok.type)}' unregister token`, args[2]!);
    }
    stmts.push({ kind: "exprStmt", expr: tok, loc });
  }
  if (check !== null) stmts.push(check);
  // register answers undefined: the dyn undefined (a statement drops it)
  return { kind: "seqExpr", stmts, result: dynUndefinedExpr(loc), type: DYN, loc };
}
