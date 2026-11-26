/* S125-L, M4 (SEMANTICS.md S125 amendment (L)): an options bag on the
 * dynamic arm.
 *
 * An object literal passed directly to a plain function (`seed({ src, tgt,
 * n: 1 })`) whose field would otherwise take a judged copy of a dynamic
 * value (`src` a package's result held on the arm) cannot hold that value in
 * a typed record field: fields never take the arm (decision J4, kept by Joe
 * on 2026-11-26). Instead the WHOLE literal is the arm site: the next pass
 * builds it as an island literal — a dynamic object, as Node builds it —
 * and the callee's per-call-site instance binds the parameter on the arm
 * (width-instances.ts widthSpecializedCall), so the callee reads and writes
 * the very object the caller built:
 *   - a dynamic field value enters as itself (shared);
 *   - a typed field value enters as its live view (S115 (a)), so a write
 *     through the bag reaches the caller's typed value and back;
 *   - the literal's keys, their order and every `undefined`-valued key are
 *     the literal's own, as in Node (S091's typed-record rule, which drops
 *     an optional key holding undefined, does not apply to a dynamic
 *     object), and its values evaluate left to right.
 * The key is the literal's own (`dynArmKey(literal)`): the same key a
 * judged copy of the literal at its argument slot uses, so when the
 * callee's instance does not lower, that copy and its refusal come back by
 * name (with M0's attribution, arm-failures.ts).
 *
 * Left typed (the field's copy keeps its refusal by name): a literal with
 * a spread, a computed key, a method or an accessor; a literal any of whose
 * field values is (or holds) a class instance, whose crossing would be by
 * copy (decision Q1); a literal in any other position (a nested literal, a
 * method's argument, a returned literal: J4); and a callee the per-call-site
 * instance cannot bind (generic, a declaration file's, reads `arguments`,
 * a rest, optional or destructured parameter at the literal's position). */
import * as ts from "../ts7/adapter.js";
import type { IrType } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import { isDynArmSite } from "./dyn-arm.js";
import { bodyReadsArguments, isThisParameter } from "./lower-calls.js";

function parentPastParens(n: ts.Node): { up: ts.Node | undefined; child: ts.Node } {
  let child = n;
  let up = n.parent;
  while (up !== undefined && (ts.isParenthesizedExpression(up) || ts.isNonNullExpression(up))) {
    child = up;
    up = up.parent;
  }
  return { up, child };
}

/** The object literal whose field's value `n` is (`{ k: n }`, or the
 * shorthand `{ n }` reached at its name or the shorthand itself), or null. */
function fieldLiteralOf(n: ts.Node): ts.ObjectLiteralExpression | null {
  if (ts.isShorthandPropertyAssignment(n)) return ts.isObjectLiteralExpression(n.parent) ? n.parent : null;
  const { up, child } = parentPastParens(n);
  if (up === undefined) return null;
  if (ts.isShorthandPropertyAssignment(up) && up.name === child) return ts.isObjectLiteralExpression(up.parent) ? up.parent : null;
  if (ts.isPropertyAssignment(up) && up.initializer === child) return ts.isObjectLiteralExpression(up.parent) ? up.parent : null;
  return null;
}

/** Does the IR type hold a class instance (itself, a union arm, a field or
 * an element)? Such a value would cross into the bag by copy. */
function holdsClassInstance(L: Lowerer, t: IrType | null, seen = new Set<string>()): boolean {
  if (t === null) return false;
  if (t.kind === "object") return true;
  if (t.kind === "array") return holdsClassInstance(L, t.elem, seen);
  if (t.kind === "union") return (L.unions.get(t.unionId)?.arms ?? []).some((a) => holdsClassInstance(L, a, seen));
  if (t.kind !== "record" || seen.has(t.shapeId)) return false;
  seen.add(t.shapeId);
  const shape = L.shapes.get(t.shapeId);
  return shape !== undefined && (shape.fields.some((f) => holdsClassInstance(L, f.type, seen)) ||
    (shape.indexValue !== undefined && holdsClassInstance(L, shape.indexValue, seen)));
}

/** The literal's own form fits the island literal: only `name: value` and
 * shorthand entries under identifier or string keys, no value a class
 * instance. */
function bagForm(L: Lowerer, lit: ts.ObjectLiteralExpression): boolean {
  for (const p of lit.properties) {
    if (ts.isShorthandPropertyAssignment(p)) {
      if (p.objectAssignmentInitializer !== undefined) return false;
    } else if (ts.isPropertyAssignment(p)) {
      if (!(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return false;
      if (p.name.text === "__proto__") return false;
    } else return false;
    const value: ts.Node = ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer;
    try {
      if (holdsClassInstance(L, L.mapTypeOf(L.typeOf(value)))) return false;
    } catch (e) {
      if (e instanceof PoisonError) return false;
      throw e;
    }
  }
  return true;
}

/** The literal is a direct argument of a direct call of a plain function
 * whose parameter at its position the per-call-site instance can bind on
 * the arm (widthSpecializedCall's own conditions). */
function bagCallSlot(L: Lowerer, lit: ts.ObjectLiteralExpression): boolean {
  const { up, child } = parentPastParens(lit);
  if (up === undefined || !ts.isCallExpression(up) || !ts.isIdentifier(up.expression)) return false;
  const i = up.arguments.indexOf(child as ts.Expression);
  if (i < 0 || up.arguments.some((a) => ts.isSpreadElement(a))) return false;
  const sym = L.resolveValueSymbol(up.expression);
  const decls = sym ? L.checker.declarationsOf(sym) : [];
  if (decls.length !== 1) return false;
  const decl = decls[0]!;
  if (!ts.isFunctionDeclaration(decl) || decl.body === undefined || decl.typeParameters !== undefined || decl.asteriskToken !== undefined) return false;
  if (decl.getSourceFile().isDeclarationFile || bodyReadsArguments(decl)) return false;
  const param = decl.parameters[i];
  if (param === undefined || !ts.isIdentifier(param.name) || param.dotDotDotToken !== undefined || param.questionToken !== undefined || isThisParameter(param)) return false;
  return true;
}

/** M4: the options-bag literal a judged exit at `n` (a field's value) lands
 * in, when that literal can be the arm site; null otherwise. */
export function bagLiteralOf(L: Lowerer, n: ts.Node): ts.ObjectLiteralExpression | null {
  const lit = fieldLiteralOf(n);
  if (lit === null || !bagCallSlot(L, lit) || !bagForm(L, lit)) return null;
  return lit;
}

/** M4: is this object literal an options bag on the dynamic arm this pass
 * (built as the island literal, its argument bound on the arm)? */
export function armBag(L: Lowerer, lit: ts.ObjectLiteralExpression): boolean {
  return isDynArmSite(L, lit) && bagCallSlot(L, lit) && bagForm(L, lit);
}
