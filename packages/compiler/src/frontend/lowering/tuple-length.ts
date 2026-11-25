/* `t.length` on a TUPLE: the arity constant, with the receiver evaluated
 * exactly when JavaScript's evaluation of it could be observed.
 *
 * Tuples are fixed-shape records and the checker types `t.length` as the
 * literal arity, so the read itself is a constant. The receiver is not:
 * `new C().t.length` runs C's getter (and logs, throws or counts) before
 * the length is read, and so does a getter anywhere along a chain
 * (`a.g.t.length`), a static getter, an object-literal accessor, or a
 * Proxy behind an `any`. The fold therefore drops the receiver's
 * evaluation only when every link is PROVEN a plain data read, twice
 * over:
 *
 *   - by the checker: the root is `this` or a binding past its temporal
 *     dead zone (a read that may throw Node's ReferenceError is a side
 *     effect too: tdzLocal), and every member
 *     of the chain resolves to a property declared with storage in this
 *     program's source (a class field, a constructor parameter property,
 *     an object-literal property, a namespace or module binding) on a
 *     receiver the checker types (not `any`/`unknown`). An accessor, an
 *     `accessor` field, a member known only from a type (an interface or
 *     type-literal member, which a getter may implement) or from a
 *     declaration file (whose JavaScript may define it as an accessor)
 *     proves nothing;
 *   - by the lowering: the receiver lowered to plain binding, `this` and
 *     field reads only, so nothing the lowering itself routes through a
 *     call, an accessor slot or a dynamic read is skipped.
 *
 * The folded constant keeps the receiver it lowered as `tupleOf`, a read
 * nothing evaluates, so the S125 width pass still sees the tuple observed
 * (lower-exprs.ts' S125-J notes). Any other receiver is evaluated once,
 * for effect, before the constant: a discarded expression statement the
 * width pass counts as a read too (width-uses.ts). A folded receiver that
 * later gains a TDZ check (a module binding read before its declaration)
 * is evaluated after all, by module-tdz.ts, so Node's ReferenceError
 * throws. GH #274. */
import * as ts from "../ts7/adapter.js";
import { F64, type IrExpr } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** The value of `expr` (`<recv>.length`) when `recv` is a tuple of
 * `arity` elements. */
export function lowerTupleLength(L: Lowerer, expr: ts.PropertyAccessExpression, arity: number): IrExpr {
  const loc = locOf(expr);
  const recv = L.lowerExpr(expr.expression);
  if (plainDataChain(L, expr.expression) && pureRead(recv)) {
    return { kind: "numLit", value: arity, tupleOf: recv, type: F64, loc };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: recv, loc: locOf(expr.expression) }],
    result: { kind: "numLit", value: arity, type: F64, loc },
    type: F64,
    loc,
  };
}

/** Whether the checker proves evaluating `e` reads plain data only. */
export function plainDataChain(L: Lowerer, e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) return plainDataChain(L, e.expression);
  if (ts.isIdentifier(e)) return !tdzLocal(L, e);
  if (e.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (!ts.isPropertyAccessExpression(e) || e.questionDotToken) return false;
  return plainDataLink(L, e) && plainDataChain(L, e.expression);
}

/** Whether `ident` reads a local that may still be in its temporal dead
 * zone: a const captured by a function lowered before its declaration
 * (predeclareForwardCapture, lower-stmts.ts) is a TDZ box whose every read
 * checks it, and that check runs only where the read is evaluated. A
 * module binding's TDZ check is placed after lowering, by module-tdz.ts,
 * which evaluates a folded receiver that gained one. */
function tdzLocal(L: Lowerer, ident: ts.Identifier): boolean {
  if (L.peekLocal(ident)?.tdz === true) return true;
  const sym = L.checker.getSymbolAtLocation(ident);
  return sym !== undefined && L.tdzPredeclared.has(sym);
}

/** Whether the checker proves the member read `link` is a plain data
 * read: a typed receiver and a property declared with storage in this
 * program's own source. */
export function plainDataLink(L: Lowerer, link: ts.PropertyAccessExpression): boolean {
  if ((L.typeOf(link.expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
  let sym = L.checker.getSymbolAtLocation(link.name);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
  if (!sym || sym.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) return false;
  const decls = L.checker.declarationsOf(sym);
  return decls.length > 0 && decls.every((d) => storageDeclaration(d));
}

/** A declaration that gives its property storage, in program source. */
function storageDeclaration(d: ts.Node): boolean {
  if (d.getSourceFile().isDeclarationFile) return false;
  if (ts.isPropertyDeclaration(d)) {
    return !(ts.getModifiers(d) ?? []).some((m) => m.kind === ts.SyntaxKind.AccessorKeyword || m.kind === ts.SyntaxKind.DeclareKeyword);
  }
  return (
    ts.isPropertyAssignment(d) ||
    ts.isShorthandPropertyAssignment(d) ||
    ts.isParameter(d) ||
    ts.isVariableDeclaration(d) ||
    ts.isEnumMember(d)
  );
}

/** Whether the lowered receiver reads bindings, `this` and data fields
 * only: no call, accessor slot, dynamic or keyed read. */
function pureRead(e: IrExpr): boolean {
  switch (e.kind) {
    case "varRef":
    case "selfRef":
    case "classRef":
      return true;
    case "upcast":
      return pureRead(e.value);
    case "fieldGet":
      return !e.field.startsWith("%") && pureRead(e.obj);
    case "recordGet":
      return !e.field.startsWith("%") && !e.spreadCopy && pureRead(e.obj);
    default:
      return false;
  }
}
