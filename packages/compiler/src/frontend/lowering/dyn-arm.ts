/* Unit U2 (docs/design/dynamic-values.md §4.3): maybe-dynamic typed slots.
 *
 * A dynamic value entering a typed composite slot used to be a CHECKED
 * COPY that S125 (c) judged, refusing every copy the program could tell
 * from the original (SEMANTICS.md S115 (d)'s U1a amendment). U2a gives
 * the contained slots a DYNAMIC ARM instead: the slot holds the dynamic
 * value itself, shared exactly as in Node, and every use of it lowers as
 * the island operations a value typed `any` takes. Only a value that must
 * enter typed storage (a number into an f64 local, a record into a typed
 * field) is checked, at that leaf.
 *
 * The contained slots (§4.3 "containment"): a `const`/`let` binding (a
 * local, or a module global), a cast used in place (`(u as T[]).push(x)`),
 * the typed parameter of a function literal that crosses into dynamic code,
 * and the parameter of a plain function a dynamic-arm value is passed to
 * (through S125 (a)'s per-call-site instance, the parameter typed by the
 * argument's own — dynamic — type). Fields and elements never take the
 * arm (decision J4): a non-fresh dynamic value bound for one is S125 (c)'s
 * judged copy, as before.
 *
 * WHICH sites take the arm: exactly the ones S125 (c) refused. The
 * lowering runs as before; the width-copy pass records every refused
 * crossing at a contained slot (`dynArmRetry`), and lowerToIr lowers the
 * program again with those sites (`dynArmSites`) on the dynamic arm,
 * until no new site appears. A program no crossing of which was refused
 * lowers exactly as before, byte for byte.
 *
 * HOW the arm reads: the lowering's checker-type questions go through
 * `Lowerer.typeOf`, and for an expression rooted at a dynamic-arm value
 * that answers `any` — the binding itself, a member or element read off
 * it, a method call on it, and the operators TypeScript types `any` over
 * `any`. Every lowering keyed on the checker type (the folds §7 item 1
 * lists: presence tests, `?.`/`!` elision, Array.isArray, instanceof,
 * narrowing) therefore sees `any` and takes the island path, which
 * consults the value at run time.
 *
 * The arm's code is split by responsibility:
 *   dyn-arm.ts         the site keys and the slots that take the arm
 *                      (bindings, parameters, results, loop bindings);
 *   dyn-arm-rooted.ts  which expressions are on the arm this pass
 *                      (armRooted, typeOf's `any`) and the casts and
 *                      bindings that join it from such a value;
 *   dyn-arm-exits.ts   where a judged exit's contained slot is (the
 *                      key the next pass arms) and the exact-fit guard;
 *   dyn-arm-spec.ts    U2b's speculative typed arm. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { DYN, JSVAL, type IrExpr, type IrStmt, type IrType } from "../../ir/nodes.js";
import { asDynOperand } from "./lower-exprs.js";
import { isJsSourceFile } from "../program.js";
import { npmStaticPackageOfPath } from "../npm-static.js";


/** The key of a source node across lowering passes (one ts.Program). */
export function dynArmKey(node: ts.Node): string {
  return `${node.getSourceFile().fileName}:${node.getStart()}:${node.end}`;
}

export function stripParens(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/** Is this cast (or initializer) a dynamic-arm site of this pass? */
export function isDynArmSite(L: Lowerer, node: ts.Node): boolean {
  return L.dynArmSites.size > 0 && L.dynArmSites.has(dynArmKey(node));
}

/** A `const`/`let` declaration whose binding takes the dynamic arm: its
 * initializer (parentheses aside) is a recorded site. */
export function dynArmDecl(L: Lowerer, decl: ts.VariableDeclaration): boolean {
  if (L.dynArmSites.size === 0 || !ts.isIdentifier(decl.name)) return false;
  if (decl.initializer === undefined) return dynArmLet(L, decl);
  if (!armableBinding(decl)) return false;
  return L.dynArmSites.has(dynArmKey(stripParens(decl.initializer))) || L.dynArmSites.has(dynArmKey(decl.initializer)) || dynArmLet(L, decl);
}

/** (K) A deferred `let` on the dynamic arm this pass (deferredLetBinding):
 * one of its `=` statements' exits was refused. */
export function dynArmLet(L: Lowerer, decl: ts.VariableDeclaration): boolean {
  return L.dynArmSites.size > 0 && ts.isIdentifier(decl.name) && L.dynArmSites.has(`let:${dynArmKey(decl.name)}`) && deferredLetBinding(L, decl);
}

/** A binding that can hold the dynamic arm: a `const`/`let`, or (in a
 * JavaScript source) a function's own `var` — one function-scoped slot,
 * which holds the dynamic value as a `let` would. */
export function armableBinding(decl: ts.VariableDeclaration): boolean {
  if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) !== 0) return true;
  if (!isJsSourceFile(decl.getSourceFile()) || !ts.isIdentifier(decl.name)) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(list.parent)) return false;
  for (let p: ts.Node = list.parent.parent; !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
  }
  return false;
}

/** A module-scope dynArmDecl whose initializer is a dynamic value in this
 * pass (a cast, an `any`/`unknown` value, or one rooted at a binding that
 * holds the dynamic value): its global holds the dynamic value. A site
 * recorded while its source was on the arm, read in a pass where that
 * source kept typed storage, binds a typed value and keeps a typed slot. */
export function dynArmGlobalDecl(L: Lowerer, decl: ts.VariableDeclaration): boolean {
  if (!dynArmDecl(L, decl)) return false;
  // A JavaScript source keeps its checked-dynamic bindings (S014's U1b
  // amendment): the checker's inferred types there are no storage.
  if (isJsSourceFile(decl.getSourceFile())) return true;
  const init = stripParens(decl.initializer!);
  if (ts.isAsExpression(init) || ts.isTypeAssertion(init)) return true;
  // A module-scope speculative binding (read, or spread): its arm is fixed
  // only where the region lowers, so the global holds whichever value it
  // built.
  const specRooted = (e: ts.Expression): boolean => {
    let r: ts.Expression = e;
    while (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r) || ts.isPropertyAccessExpression(r) || ts.isElementAccessExpression(r)) r = r.expression;
    const sym = ts.isIdentifier(r) ? L.checker.getSymbolAtLocation(r) : undefined;
    return sym !== undefined && L.specBindings.has(sym);
  };
  if (specRooted(init)) return true;
  // (K) a package's result (packageCallResult) is the package's own value
  // in every pass.
  if (packageCallResult(L, init)) return true;
  if (ts.isObjectLiteralExpression(init) && init.properties.some((p) => ts.isSpreadAssignment(p) && specRooted(p.expression))) return true;
  return (L.typeOf(init).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** (K) A call (or an awaited one) of a function or method a statically
 * compiled package declares (zod's `schema.parse(…)`): its result is the
 * package's own value, held by the package as it is, in every pass — so a
 * module global initialized by it can hold that value itself. */
export function packageCallResult(L: Lowerer, init: ts.Expression): boolean {
  let e: ts.Expression = stripParens(init);
  if (ts.isAwaitExpression(e)) e = stripParens(e.expression);
  if (!ts.isCallExpression(e)) return false;
  const sig = L.checker.getResolvedSignature(e);
  const decl = sig === undefined ? undefined : L.checker.signatureDeclaration(sig);
  return decl !== undefined && npmStaticPackageOfPath(decl.getSourceFile().fileName) !== null;
}

/** S125 (paperclip's superRefine loops): a `const` for-of loop binding — the
 * loop variable itself, or a name inside its destructuring pattern (no
 * default, no rest) — is a contained slot: where S125 (c) refuses the
 * element's checked copy, the next pass binds the dynamic element itself. */
export function forOfConstBinding(id: ts.Node): boolean {
  if (!ts.isIdentifier(id)) return false;
  let n: ts.Node = id;
  let p: ts.Node | undefined = id.parent;
  if (p !== undefined && ts.isBindingElement(p)) {
    if (p.name !== n || p.initializer !== undefined || p.dotDotDotToken !== undefined) return false;
    while (p !== undefined && (ts.isBindingElement(p) || ts.isArrayBindingPattern(p) || ts.isObjectBindingPattern(p))) {
      if (ts.isBindingElement(p) && (p.initializer !== undefined || p.dotDotDotToken !== undefined)) return false;
      n = p;
      p = p.parent;
    }
  }
  if (p === undefined || !ts.isVariableDeclaration(p) || p.name !== n) return false;
  const list = p.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false;
  return ts.isForOfStatement(list.parent) && list.parent.initializer === list;
}

/** (K) A deferred `let`: a function's own `let` (not a loop's) whose every
 * write is a plain `x = value` statement — no compound assignment, `++`,
 * `--`, destructuring assignment or loop target, in the function or in a
 * closure. Each assignment's exit is then a contained slot (keyed on the
 * declaration, `let:`): where S125 (c) refuses one, the next pass gives the
 * binding the dynamic value's storage, and every assignment stores its
 * value as it is (an assignment statement's result is unused, so nothing
 * else observes the stored form). */
export function deferredLetBinding(L: Lowerer, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Let) return false;
  if (!ts.isVariableStatement(list.parent)) return false;
  if (!insideFunction(list.parent)) return false;
  const memo = L.deferredLets.get(decl);
  if (memo !== undefined) return memo;
  const sym = L.checker.getSymbolAtLocation(decl.name);
  let ok = sym !== undefined;
  if (sym !== undefined) {
    const visit = (n: ts.Node): void => {
      if (!ok) return;
      if (ts.isIdentifier(n) && n !== decl.name && L.checker.getSymbolAtLocation(n) === sym) {
        if (!plainReadOrStatementWrite(n)) ok = false;
      } else ts.forEachChild(n, visit);
    };
    visit(decl.getSourceFile());
  }
  L.deferredLets.set(decl, ok);
  return ok;
}

/** A statement inside a function body (not at module scope). */
function insideFunction(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration(p)) return true;
  }
  return false;
}

/** A reference that reads the binding, or is the target of a plain
 * `x = value` expression statement — anything else that may write it
 * (compound assignment, `++`/`--`, a destructuring or loop target, a
 * parenthesized target) answers false. */
function plainReadOrStatementWrite(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isBinaryExpression(p) && p.left === id && isAssignmentOperator(p.operatorToken.kind)) {
    return p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isExpressionStatement(p.parent);
  }
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return false;
  // A target reached through parentheses, an assertion or a destructuring
  // literal (a default inside one, `[x = 1] = a`, is caught above: its
  // `=` is no statement).
  let cur: ts.Node = id;
  let up: ts.Node = p;
  while (ts.isParenthesizedExpression(up) || ts.isNonNullExpression(up) || ts.isAsExpression(up) || ts.isTypeAssertion(up) || ts.isSatisfiesExpression(up) ||
    ts.isArrayLiteralExpression(up) || ts.isObjectLiteralExpression(up) || ts.isSpreadElement(up) || ts.isSpreadAssignment(up) ||
    ts.isShorthandPropertyAssignment(up) || (ts.isPropertyAssignment(up) && up.initializer === cur)) {
    cur = up;
    up = up.parent;
  }
  if (cur !== id) {
    if (ts.isBinaryExpression(up) && up.left === cur && isAssignmentOperator(up.operatorToken.kind)) return false;
    if ((ts.isPrefixUnaryExpression(up) || ts.isPostfixUnaryExpression(up)) &&
      (up.operator === ts.SyntaxKind.PlusPlusToken || up.operator === ts.SyntaxKind.MinusMinusToken)) return false;
  }
  if ((ts.isForOfStatement(up) || ts.isForInStatement(up)) && up.initializer === cur) return false;
  return true;
}

function isAssignmentOperator(k: ts.SyntaxKind): boolean {
  return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
}

/** (K) A name of a `const` destructuring declaration in a function — no
 * default and no rest at any level of the pattern — is a contained slot,
 * as a `const` for-of binding's is (forOfConstBinding): where S125 (c)
 * refuses the element's checked copy, the next pass binds the dynamic
 * element itself (`pat:`). */
export function constPatternBinding(id: ts.Node): boolean {
  if (!ts.isIdentifier(id)) return false;
  let n: ts.Node = id;
  let p: ts.Node | undefined = id.parent;
  if (p === undefined || !ts.isBindingElement(p) || p.name !== n) return false;
  while (p !== undefined && (ts.isBindingElement(p) || ts.isArrayBindingPattern(p) || ts.isObjectBindingPattern(p))) {
    if (ts.isBindingElement(p) && (p.initializer !== undefined || p.dotDotDotToken !== undefined)) return false;
    n = p;
    p = p.parent;
  }
  if (p === undefined || !ts.isVariableDeclaration(p) || p.name !== n || p.initializer === undefined) return false;
  const list = p.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false;
  return ts.isVariableStatement(list.parent) && insideFunction(list.parent);
}

/** A pattern name on the dynamic arm this pass (constPatternBinding). */
export function dynArmPattern(L: Lowerer, id: ts.Node): boolean {
  return L.dynArmSites.size > 0 && ts.isIdentifier(id) && L.dynArmSites.has(`pat:${dynArmKey(id)}`) && constPatternBinding(id);
}

/** Binds a loop or pattern name on the dynamic arm this pass (dynArmForOf,
 * dynArmPattern) to the dynamic element itself, shared as in Node: a
 * jsval local (checked-dynamic storage in a JavaScript source, S014's U1b
 * amendment). A pattern's element read off typed storage crosses as itself
 * (its live view, S115's unit H). False when the name is not on the arm. */
export function bindArmName(L: Lowerer, name: ts.Identifier, value: IrExpr, isLet: boolean, out: IrStmt[]): boolean {
  const dynamic = value.type.kind === "jsval" || value.type.kind === "dyn";
  const forOf = dynArmForOf(L, name) && dynamic;
  if (!forOf && !dynArmPattern(L, name)) return false;
  const loc = value.loc;
  const js = isJsSourceFile(name.getSourceFile());
  const dynValue: IrExpr = dynamic ? value : L.coerceInto(name, value, JSVAL);
  const v: IrExpr = js ? asDynOperand(dynValue) : dynValue.type.kind === "dyn" ? { kind: "jsMarshal", value: dynValue, type: JSVAL, loc } : dynValue;
  const local = L.declareLocal(name, name.text, js ? DYN : JSVAL, isLet);
  out.push({ kind: "varDecl", localId: local.id, init: v, loc });
  return true;
}

/** A for-of loop binding on the dynamic arm this pass (forOfConstBinding). */
export function dynArmForOf(L: Lowerer, id: ts.Node): boolean {
  return L.dynArmSites.size > 0 && ts.isIdentifier(id) && L.dynArmSites.has(`forof:${dynArmKey(id)}`) && forOfConstBinding(id);
}

/** A function literal's parameter that takes the dynamic arm. */
export function dynArmParam(L: Lowerer, param: ts.ParameterDeclaration): boolean {
  return L.dynArmSites.size > 0 && L.dynArmSites.has(`param:${dynArmKey(param)}`);
}

/** A function literal whose result takes the dynamic arm: it crossed into
 * dynamic code, and the copy its composite result would make there was
 * refused (the result slot is contained like its parameters). */
export function dynArmResult(L: Lowerer, fn: ts.Node): boolean {
  // GH #204: a JavaScript function returning a widened array binding.
  if (L.es5 !== null && L.es5.rets.has(fn)) return true;
  return L.dynArmSites.size > 0 && L.dynArmSites.has(`ret:${dynArmKey(fn)}`);
}

/** The result type of a function literal on the result arm (a plain,
 * non-async, non-generator function): the dynamic value — `dyn` in a
 * JavaScript source (S014's U1b storage rule), `jsval` otherwise. Null when
 * the literal's result is not on the arm. The type mapper asks this for
 * every function type whose signature the literal declares, so a binding,
 * a call result and the closure itself agree. */
export function dynArmResultType(L: Lowerer, fn: ts.Node): IrType | null {
  if (!dynArmResult(L, fn)) return null;
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn))) return null;
  if (fn.asteriskToken !== undefined || fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) return null;
  return isJsSourceFile(fn.getSourceFile()) ? DYN : JSVAL;
}

/** Registers every binding and parameter this pass's sites put on the
 * dynamic arm, before anything lowers (a function declared before the
 * binding's statement may reference it). */
export function collectDynArmSyms(L: Lowerer): void {
  if (L.dynArmSites.size === 0) return;
  const files = new Set([...L.dynArmSites].map((k) => k.replace(/^(param|dparam|ret|dret|forof|let|pat):/, "").replace(/:\d+:\d+$/, "")));
  for (const sf of L.program.getSourceFiles()) {
    if (sf.isDeclarationFile || !files.has(sf.fileName)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && dynArmDecl(L, n)) {
        const s = L.checker.getSymbolAtLocation(n.name);
        if (s !== undefined) L.dynArmSyms.add(s);
      } else if (ts.isParameter(n) && ts.isIdentifier(n.name) && dynArmParam(L, n)) {
        const s = L.checker.getSymbolAtLocation(n.name);
        if (s !== undefined) L.dynArmSyms.add(s);
      }
      else if (ts.isIdentifier(n) && (dynArmForOf(L, n) || dynArmPattern(L, n))) {
        const s = L.checker.getSymbolAtLocation(n);
        if (s !== undefined) L.dynArmSyms.add(s);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}
