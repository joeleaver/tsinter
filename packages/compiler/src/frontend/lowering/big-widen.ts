/* GH #187: arithmetic over `any` in a program that can hold a bigint.
 *
 * TypeScript types `-x`, `x % y`, `a - b` and the rest of the numeric
 * operators `number` whenever an operand is `any` (only `+` answers `any`),
 * and an un-annotated binding or function return inherits that `number`.
 * Node computes a bigint there when the operand holds one, so a typed f64
 * slot fed by such an expression validates the value out and stops on the
 * bigint (SC1100's "expected number, got bigint") where Node prints it.
 *
 * In a program with a bigint SOURCE (a bigint literal, the BigInt global,
 * a 64-bit Buffer/DataView read, a `{ bigint: true }` options bag), those
 * expressions answer `any` instead — the dynamic value, number or bigint,
 * whose arithmetic the island operators already compute Node-exactly —
 * and so do the un-annotated bindings they initialize and the
 * un-annotated functions that return them. A program without any bigint
 * source can never hold one (JSON, the host and the dynamic world produce
 * none), keeps the checker's `number`, and lowers byte for byte as before.
 *
 * What widens (`Lowerer.typeOf`, for a node the checker types as a number):
 *   - a unary `-`/`~`, or a numeric binary operator (`-` `*` `/` `%` `**`
 *     `&` `|` `^` `<<` `>>`, and `+` over no string), one of whose operands
 *     is `any` (after this widening) or a bigint; never unary `+` or `>>>`,
 *     which throw on a bigint;
 *   - parentheses and non-null assertions around one;
 *   - an identifier bound by an un-annotated variable declaration whose
 *     initializer widens (or is `any`);
 *   - a call to a function with no return annotation one of whose own
 *     returns widens (`declaredReturnType` asks the same question). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { DYN, F64, type IrExpr } from "../../ir/nodes.js";

const SOURCE_TEXT = /\d[\d_]*n\b|0[xXoObB][\da-fA-F_]+n\b|BigInt|[rRwW][a-z]*Big[IU]|getBig|setBig|bigint\s*:/;
const BIG_MEMBERS = /^(read|write)Big(U)?[Ii]nt64(LE|BE)$|^(get|set)Big(U)?[Ii]nt64$/;

const cache = new WeakMap<ts.Program, boolean>();

/** Does any source the program lowers spell a bigint source? */
export function programHoldsBigint(program: ts.Program, files: readonly ts.SourceFile[]): boolean {
  const hit = cache.get(program);
  if (hit !== undefined) return hit;
  let found = false;
  const seen = new Set<ts.SourceFile>();
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isBigIntLiteral(n)) found = true;
    else if (ts.isIdentifier(n)) {
      if (n.text === "BigInt" || n.text === "BigInt64Array" || n.text === "BigUint64Array" || BIG_MEMBERS.test(n.text)) found = true;
    } else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "bigint" && n.initializer.kind !== ts.SyntaxKind.FalseKeyword) found = true;
    if (!found) n.forEachChild(visit);
  };
  const scan = (sf: ts.SourceFile): void => {
    if (found || seen.has(sf) || sf.isDeclarationFile) return;
    seen.add(sf);
    if (SOURCE_TEXT.test(sf.text)) visit(sf);
  };
  for (const sf of files) scan(sf);
  for (const sf of program.getSourceFiles()) scan(sf);
  cache.set(program, found);
  return found;
}

const NUMERIC_BINARY = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.PlusToken,
]);

/** Could this node kind widen at all (the cheap filter typeOf runs first)? */
function candidate(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.CallExpression:
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.NonNullExpression:
      return true;
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const op = (node as ts.PrefixUnaryExpression).operator;
      return op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.TildeToken;
    }
    case ts.SyntaxKind.BinaryExpression:
      return NUMERIC_BINARY.has((node as ts.BinaryExpression).operatorToken.kind);
    default:
      return false;
  }
}

/** The operand holds a value whose arithmetic may yield a bigint. */
function wideOperand(L: Lowerer, e: ts.Expression): boolean {
  return (L.typeOf(e).flags & (ts.TypeFlags.Any | ts.TypeFlags.BigIntLike)) !== 0;
}

/** typeOf's hook: `any` for a number-typed node that widens, else null. */
export function bigWidenTypeOf(L: Lowerer, node: ts.Node, t: ts.Type): ts.Type | null {
  if ((t.flags & ts.TypeFlags.NumberLike) === 0 || !candidate(node)) return null;
  return widens(L, node) ? L.checker.getAnyType() : null;
}

function widens(L: Lowerer, node: ts.Node): boolean {
  const memo = L.bigWidenMemo;
  const hit = memo.get(node);
  if (hit !== undefined) return hit;
  memo.set(node, false); // a cycle (a recursive binding or function) does not widen by itself
  const r = computeWidens(L, node);
  memo.set(node, r);
  return r;
}

function computeWidens(L: Lowerer, node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return (L.typeOf(node.expression).flags & ts.TypeFlags.Any) !== 0;
  }
  if (ts.isPrefixUnaryExpression(node)) return wideOperand(L, node.operand);
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const lt = L.typeOf(node.left), rt = L.typeOf(node.right);
      if (((lt.flags | rt.flags) & ts.TypeFlags.StringLike) !== 0) return false;
    }
    return wideOperand(L, node.left) || wideOperand(L, node.right);
  }
  if (ts.isIdentifier(node)) {
    const p = node.parent;
    if (p !== undefined && ts.isPropertyAccessExpression(p) && p.name === node) return false;
    if (p !== undefined && ts.isPropertyAssignment(p) && p.name === node) return false;
    const sym = L.checker.getSymbolAtLocation(node);
    const decl = sym !== undefined ? L.checker.valueDeclarationOf(sym) : undefined;
    if (decl === undefined || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return false;
    if (decl.type !== undefined || decl.initializer === undefined) return false;
    if (decl.name === node) return (L.typeOf(decl.initializer).flags & ts.TypeFlags.Any) !== 0;
    return widens(L, decl.name);
  }
  if (ts.isCallExpression(node)) {
    const sig = L.checker.getResolvedSignature(node);
    const decl = sig ? L.checker.signatureDeclaration(sig) : undefined;
    return decl !== undefined && returnWidens(L, decl);
  }
  return false;
}

/** Does the function `decl` (no return annotation, a body of its own)
 * return a widened value — `declaredReturnType`'s question too? */
export function returnWidens(L: Lowerer, decl: ts.Node): boolean {
  if (!L.bigWiden) return false;
  if (!(ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl) || ts.isMethodDeclaration(decl))) return false;
  if (decl.type !== undefined || decl.body === undefined) return false;
  if (decl.asteriskToken !== undefined) return false;
  const memo = L.bigWidenFnMemo;
  const hit = memo.get(decl);
  if (hit !== undefined) return hit;
  memo.set(decl, false);
  let r = false;
  const body = decl.body;
  if (!ts.isBlock(body)) r = (L.typeOf(body).flags & ts.TypeFlags.Any) !== 0 && numberReturn(L, decl);
  else if (numberReturn(L, decl)) {
    const walk = (n: ts.Node): void => {
      if (r) return;
      if (ts.isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
      if (ts.isReturnStatement(n) && n.expression !== undefined && (L.typeOf(n.expression).flags & ts.TypeFlags.Any) !== 0) r = true;
      else n.forEachChild(walk);
    };
    body.forEachChild(walk);
  }
  memo.set(decl, r);
  return r;
}

/** The checker infers a number (an async body's promise keeps its type). */
function numberReturn(L: Lowerer, decl: ts.SignatureDeclaration): boolean {
  if (ts.canHaveModifiers(decl) && ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const sig = L.checker.getSignatureFromDeclaration(decl);
  return sig !== undefined && (L.checker.getReturnTypeOfSignature(sig).flags & ts.TypeFlags.NumberLike) !== 0;
}

/** An array or byte index the checker typed as a number that widened to
 * the dynamic value: the number checks out at the index (a bigint there
 * stops at the SC1100 fence, "expected number, got bigint", instead of a compile refusal). */
export function wideIndex(L: Lowerer, e: IrExpr): IrExpr {
  if (!L.bigWiden || (e.type.kind !== "jsval" && e.type.kind !== "dyn")) return e;
  const value: IrExpr = e.type.kind === "jsval" ? { kind: "dynFromJsval", value: e, type: DYN, loc: e.loc } : e;
  return { kind: "dynCheck", value, type: F64, loc: e.loc };
}
