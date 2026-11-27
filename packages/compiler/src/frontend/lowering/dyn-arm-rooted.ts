/* Unit U2 (dyn-arm.ts): which expressions are on the dynamic arm in this
 * lowering pass — a binding, parameter or cast the arm holds, and what is
 * read, called or combined off one — and so answer `any` to the lowering's
 * checker-type questions (Lowerer.typeOf); and the casts and block-scoped
 * bindings that join the arm because their value is already on it. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { IrType } from "../../ir/nodes.js";
import { PoisonError } from "./lowerer.js";
import { dynArmResult, isDynArmSite, stripParens } from "./dyn-arm.js";
import { armBag } from "./dyn-arm-bag.js";

/** A cast of a value already on the dynamic arm to a typed composite: in
 * Node a cast is no conversion, so the result stays the dynamic value. */
export function armCast(L: Lowerer, node: ts.AsExpression | ts.TypeAssertion): boolean {
  if (!L.dynArmActive || !armRooted(L, node.expression)) return false;
  try {
    const t = L.mapTypeOf(L.checker.getTypeFromTypeNode(node.type));
    return t !== null && L.copiesOnCrossing(t);
  } catch (e) {
    if (e instanceof PoisonError) return false;
    throw e;
  }
}

/** S125 A1: a cast whose value is what a function returns (directly, or
 * through parentheses and a conditional's branches), where that function's
 * RESULT is on the dynamic arm (a `ret:` site): the cast is no conversion,
 * the result is the dynamic value itself. */
export function armRetCast(L: Lowerer, node: ts.Expression): boolean {
  if (L.dynArmSites.size === 0) return false;
  let n: ts.Node = node;
  let up: ts.Node | undefined = n.parent;
  while (up !== undefined && (ts.isParenthesizedExpression(up) || (ts.isConditionalExpression(up) && up.condition !== n))) {
    n = up;
    up = up.parent;
  }
  let fn: ts.Node | undefined;
  if (up !== undefined && ts.isReturnStatement(up)) {
    fn = up.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
  } else if (up !== undefined && ts.isArrowFunction(up) && up.body === n) {
    fn = up;
  }
  return fn !== undefined && (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && dynArmResult(L, fn);
}

/** A block-scoped local whose initializer is already on the dynamic arm
 * and whose declared type is a typed composite: the binding joins the arm
 * (it would otherwise be a judged copy of the arm's value). */
export function armInitDecl(L: Lowerer, decl: ts.VariableDeclaration): boolean {
  if (!L.dynArmActive || decl.initializer === undefined || !ts.isIdentifier(decl.name)) return false;
  if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) === 0) return false;
  if (!armRooted(L, decl.initializer)) return false;
  // An unannotated local takes whatever its initializer is: on the arm, the
  // dynamic value (`const r = p.s + 1` is 6 where `p.s` holds 5).
  if (decl.type === undefined) return true;
  try {
    const t = L.mapTypeOf(L.typeOf(decl.name));
    return t !== null && L.copiesOnCrossing(t);
  } catch (e) {
    if (e instanceof PoisonError) return false;
    throw e;
  }
}

/** The bindings a destructuring declaration over a dynamic-arm value
 * binds: each holds what the pattern reads off the dynamic value itself
 * (a member, or a rest object in the value's own key order), so each joins
 * the arm for as long as its statement list lowers, as armInitDecl's
 * locals do. Module globals and `var`s keep their typed slots (their
 * copies are exact-guarded: dyn-arm-exits.ts noteDynArmExit). */
export function armPatternSyms(L: Lowerer, decl: ts.VariableDeclaration): ts.Symbol[] {
  if (!L.dynArmActive || decl.initializer === undefined || ts.isIdentifier(decl.name)) return [];
  if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) === 0) return [];
  if (!armRooted(L, decl.initializer)) return [];
  const out: ts.Symbol[] = [];
  const walk = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) {
      const s = L.checker.getSymbolAtLocation(n);
      if (s !== undefined) out.push(s);
      return;
    }
    for (const el of n.elements) if (!ts.isOmittedExpression(el) && el.name !== undefined) walk(el.name);
  };
  walk(decl.name);
  return out;
}

/** `typeOf`'s dynamic-arm answer for `node`: the `any` type when the
 * expression is rooted at a dynamic-arm value (which the checker never
 * saw: it still spells the declared type), else null. */
export function dynArmTypeOf(L: Lowerer, node: ts.Node): ts.Type | null {
  return armRooted(L, node) ? L.checker.getAnyType() : null;
}

function isAsyncDecl(d: ts.FunctionDeclaration): boolean {
  return (ts.getModifiers(d) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

const hasRetSites = new WeakMap<ReadonlySet<string>, boolean>();

/** The symbol a call's callee names: an identifier, through an import's
 * alias ((K): the result arm is the function's own, whichever module calls
 * it), or a member of a module namespace (`M.f` through `import * as M`,
 * or `M.N.f` through `export * as N`, (L)), so every caller agrees with the function on its result. */
function calleeFunctionSymbol(L: Lowerer, callee: ts.Expression): ts.Symbol | null {
  if (ts.isIdentifier(callee)) return L.resolveValueSymbol(callee);
  if (!ts.isPropertyAccessExpression(callee) || !isNamespaceRef(L, callee.expression)) return null;
  return aliasTarget(L, L.checker.getSymbolAtLocation(callee.name)) ?? null;
}

function aliasTarget(L: Lowerer, s: ts.Symbol | undefined): ts.Symbol | undefined {
  return s !== undefined && s.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(s) : s;
}

/** `M` (`import * as M`) or `M.N` (N re-exported with `export * as N`):
 * an expression naming a module's namespace. */
function isNamespaceRef(L: Lowerer, e: ts.Expression): boolean {
  let at: ts.Node;
  if (ts.isIdentifier(e)) at = e;
  else if (ts.isPropertyAccessExpression(e) && isNamespaceRef(L, e.expression)) at = e.name;
  else return false;
  const s = aliasTarget(L, L.checker.getSymbolAtLocation(at));
  return s !== undefined && L.checker.declarationsOf(s).some((d) => ts.isSourceFile(d));
}

/** S125 A1: a direct call of a function whose RESULT is on the dynamic arm
 * (a declaration, or a binding of a function literal, with a `ret:` site):
 * the call answers the dynamic value itself. */
function armResultCall(L: Lowerer, call: ts.CallExpression, awaited = false): boolean {
  if (L.dynArmSites.size === 0) return false;
  let has = hasRetSites.get(L.dynArmSites);
  if (has === undefined) {
    has = [...L.dynArmSites].some((k) => k.startsWith("ret:"));
    hasRetSites.set(L.dynArmSites, has);
  }
  if (!has) return false;
  const sym = calleeFunctionSymbol(L, stripParens(call.expression));
  if (sym === null) return false;
  for (const d of L.checker.declarationsOf(sym)) {
    // (L) an async function's call is its promise; `await` of it is the
    // dynamic value (armRooted's AwaitExpression case).
    if (ts.isFunctionDeclaration(d) && dynArmResult(L, d)) return isAsyncDecl(d) === awaited;
    if (!awaited && ts.isVariableDeclaration(d) && d.initializer !== undefined) {
      const init = stripParens(d.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && dynArmResult(L, init)) return true;
    }
  }
  return false;
}

/** Is `node` rooted at a dynamic-arm value: a dynamic-arm binding or
 * parameter, a dynamic-arm cast, or a member or element read, a call, or
 * one of the operators TypeScript types `any` over `any` (`+`, `&&`,
 * `||`, `??`, `?:`, assignment), over one? Comparisons, arithmetic and the
 * like keep the checker's answer (boolean, number): TypeScript's own
 * answer over `any`. */
export function armRooted(L: Lowerer, node: ts.Node): boolean {
  if (ts.isIdentifier(node)) {
    const p = node.parent;
    // The declaration's own name reads its declared type (collection).
    if (p !== undefined && (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === node) return false;
    if (p !== undefined && ts.isPropertyAccessExpression(p) && p.name === node) return false;
    if (p !== undefined && ts.isPropertyAssignment(p) && p.name === node) return false;
    // Cheap name filter before the checker's symbol query (typeOf runs
    // this on every identifier while an arm is in play).
    const name = node.text;
    let named = false;
    for (const s of L.dynArmSyms) if (s.name === name) { named = true; break; }
    if (!named && L.implicitParamTypes !== null) for (const s of L.widthBoundParams) if (s.name === name) { named = true; break; }
    if (!named) return false;
    const s = p !== undefined && ts.isShorthandPropertyAssignment(p)
      ? L.checker.getShorthandAssignmentValueSymbol(p)
      : L.checker.getSymbolAtLocation(node);
    if (s === undefined) return false;
    if (L.dynArmSyms.has(s)) return true;
    // A parameter of a per-call-site instance bound to a dynamic-arm
    // argument (S125 (a)'s vehicle, the argument's own type being `any`).
    return L.dynArmBoundParam(s);
  }
  if (!ts.isExpression(node)) return false;
  if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) return isDynArmSite(L, node) || armCast(L, node);
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return armRooted(L, node.expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return armRooted(L, node.expression);
  if (ts.isCallExpression(node)) return armRooted(L, stripParens(node.expression)) || armResultCall(L, node);
  // (L) `await f(…)` of an async function on the result arm (dyn-arm-async.ts).
  if (ts.isAwaitExpression(node)) {
    const call = stripParens(node.expression);
    return ts.isCallExpression(call) && armResultCall(L, call, true);
  }
  // (K) a conditional or logical expression whose operand's exit was
  // refused (dyn-arm-exits.ts armChainTop) is the dynamic value itself.
  if (ts.isConditionalExpression(node)) return isDynArmSite(L, node) || armRooted(L, node.whenTrue) || armRooted(L, node.whenFalse);
  // GH #132 / U2: an object literal spreading a dynamic-arm value is `any`
  // to TypeScript, so it builds the dynamic object (its keys in the
  // spread's own order), never a typed record read field by field.
  if (ts.isObjectLiteralExpression(node)) {
    // (L) an options bag on the arm is the dynamic object (dyn-arm-bag.ts).
    if (armBag(L, node)) return true;
    return node.properties.some((p) => ts.isSpreadAssignment(p) && armRooted(L, p.expression) && armStored(L, p.expression));
  }
  if (ts.isBinaryExpression(node)) {
    const k = node.operatorToken.kind;
    if (k === ts.SyntaxKind.PlusToken) {
      // `any + string` is a string to TypeScript; `any + number` is `any`.
      const l = armRooted(L, node.left);
      const r = armRooted(L, node.right);
      if (!l && !r) return false;
      if (l && r) return true;
      const other = L.checker.getTypeAtLocation(l ? node.right : node.left);
      return (other.flags & ts.TypeFlags.StringLike) === 0;
    }
    if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.QuestionQuestionToken) {
      return isDynArmSite(L, node) || armRooted(L, node.left) || armRooted(L, node.right);
    }
    if (k === ts.SyntaxKind.CommaToken || k === ts.SyntaxKind.EqualsToken) return armRooted(L, node.right);
    return false;
  }
  return false;
}

/** Does the binding at the root of `e` (an arm-rooted expression) hold
 * the dynamic value in this pass? A binding whose arm did not build (the
 * fallback passes) keeps its typed storage while its symbol stays
 * registered: a literal spreading it builds the typed record. */
function armStored(L: Lowerer, e: ts.Expression): boolean {
  let r: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r) || ts.isPropertyAccessExpression(r) || ts.isElementAccessExpression(r)) r = r.expression;
    else if (ts.isAsExpression(r) || ts.isTypeAssertion(r)) r = r.expression;
    else break;
  }
  if (!ts.isIdentifier(r)) return true;
  const s = L.checker.getSymbolAtLocation(r);
  if (s === undefined) return true;
  const dynamicKind = (t: IrType): boolean => t.kind === "jsval" || t.kind === "dyn";
  const g = L.globalsBySymbol.get(s);
  if (g !== undefined) return dynamicKind(g.type);
  for (let i = L.fnStack.length - 1; i >= 0; i--) {
    const b = L.bindingIn(L.fnStack[i]!, s);
    if (b !== null) return dynamicKind(b.type);
  }
  const b = L.bindingIn(L.ctx, s);
  return b === null || dynamicKind(b.type);
}
