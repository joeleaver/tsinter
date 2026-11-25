/* A TUPLE value the checker types as an ARRAY (SEMANTICS.md S125
 * amendment (J)).
 *
 * `MODES as readonly string[]`, `t as unknown as number[]`: in JavaScript
 * a cast converts nothing, so the array IS the tuple. Here a tuple is a
 * fixed-shape record and an array a growable one, so a value that leaves
 * a cast as an array must be rebuilt as one; erasing the cast handed the
 * tuple record to array code (`.length`, `[i]`, `[i] = v`, `.sort()`) and
 * the backend stopped at "arrIntrinsic … on non-array record".
 *
 * The rebuild is a copy where JavaScript has one object, so it is a width
 * copy like every tuple-into-array slot (%tup.arr.N) and is JUDGED by S125
 * (b): a write through it, or an identity test on it, refuses by name
 * while the original is still observed. Two uses are exempt, because a
 * fresh copy dropped on the spot cannot be told from the original:
 *
 *   - a `.length` or element READ straight off the cast (no assignment,
 *     ++/--, delete or destructuring target): the inline copy
 *     (tupleAsArray) is read once and discarded;
 *   - a receiver lower-containers.ts already proved a read-only method
 *     cannot betray (tupleArrayRecv): lowerMemberRecv makes that same
 *     inline copy.
 *
 * A union that may hold a tuple has no one array rebuilding every arm,
 * and refuses by name. */
import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrType } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import { tupleAsArray } from "./lower-containers.js";
import type { Lowerer } from "./lowerer.js";

/** The value of the cast `expr` (lowered to `inner`, a static value) when
 * it carries a tuple into an array type; null when no rebuild is due and
 * the cast erases. */
export function tupleCastToArray(L: Lowerer, expr: ts.AsExpression | ts.TypeAssertion, inner: IrExpr, target: IrType | null): IrExpr | null {
  if (target === null || !arrayLike(L, target)) return null;
  const tuple = isTuple(L, inner.type);
  if (!tuple && !hasTupleArm(L, inner.type)) return null;
  const { top, parent } = consumer(expr);
  if (ts.isPropertyAccessExpression(parent) && parent.expression === top && L.tupleArrayRecv.has(parent)) return null;
  if (!tuple) return refuseTupleUnion(L, expr, inner.type, target);
  if (target.kind === "array" && readOff(top, parent)) return tupleAsArray(L, inner, locOf(expr), target.elem);
  return judgedCopy(L, expr, inner, target);
}

/** A receiver the checker types as an array whose value is still a tuple
 * (one no cast rebuilt): the judged copy, as at a cast. */
export function tupleUnderArrayType(L: Lowerer, e: ts.Expression, value: IrExpr): IrExpr {
  const tuple = isTuple(L, value.type);
  if (!tuple && !hasTupleArm(L, value.type)) return value;
  const want = L.mapTypeOf(L.typeOf(e));
  if (want === null || !arrayLike(L, want)) return value;
  return tuple ? judgedCopy(L, e, value, want) : refuseTupleUnion(L, e, value.type, want);
}

const isTuple = (L: Lowerer, t: IrType): boolean => t.kind === "record" && L.shapes.get(t.shapeId)?.tuple === true;

const hasTupleArm = (L: Lowerer, t: IrType): boolean =>
  t.kind === "union" && (L.unions.get(t.unionId)?.arms ?? []).some((a) => isTuple(L, a));

/** An array, or a union with an array arm (`string[] | undefined`). */
const arrayLike = (L: Lowerer, t: IrType): boolean =>
  t.kind === "array" || (t.kind === "union" && (L.unions.get(t.unionId)?.arms ?? []).some((a) => a.kind === "array"));

/** The width copy into `want` (a %tup.arr.N site the S125 (b) judgement
 * sees), or a named stop when no copy reaches it. */
function judgedCopy(L: Lowerer, at: ts.Expression, value: IrExpr, want: IrType): IrExpr {
  const out = L.coerceToExpected(value, want);
  if (!isTuple(L, out.type)) return out;
  return L.unsupported(
    "SC1090",
    at,
    `a '${L.fmt(value.type)}' tuple where '${L.fmt(want)}' is expected (no array of that element type rebuilds it — copy it with [...x])`,
  );
}

function refuseTupleUnion(L: Lowerer, at: ts.Expression, t: IrType, want: IrType): never {
  return L.unsupported(
    "SC1090",
    at,
    `a '${L.fmt(t)}' value cast to '${L.fmt(want)}' (a tuple arm is a fixed shape the cast does not convert — narrow to one tuple first, or copy it with [...x])`,
  );
}

/** The node that consumes the cast's value, past parentheses and `!`. */
function consumer(expr: ts.Expression): { top: ts.Expression; parent: ts.Node } {
  let top: ts.Expression = expr;
  while (ts.isParenthesizedExpression(top.parent) || ts.isNonNullExpression(top.parent)) top = top.parent;
  return { top, parent: top.parent };
}

/** `(x as T[]).length` or `(x as T[])[i]`, read and nothing else. */
function readOff(top: ts.Expression, parent: ts.Node): boolean {
  const read =
    (ts.isPropertyAccessExpression(parent) && parent.expression === top && parent.name.text === "length") ||
    (ts.isElementAccessExpression(parent) && parent.expression === top);
  return read && !writePosition(parent as ts.Expression);
}

/** Is `n` written: an assignment's target (a destructuring pattern's
 * included), ++/--, delete, or a for-in/of initializer? */
function writePosition(n: ts.Expression): boolean {
  let cur: ts.Node = n;
  for (;;) {
    const p: ts.Node = cur.parent;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      return p.left === cur && k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
    }
    if (ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) {
      return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isDeleteExpression(p)) return true;
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === cur;
    if (
      ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isShorthandPropertyAssignment(p) ||
      ts.isObjectLiteralExpression(p) || (ts.isPropertyAssignment(p) && p.initializer === cur)
    ) {
      cur = p;
      continue;
    }
    return false;
  }
}
