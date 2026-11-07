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
 * consults the value at run time. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, JSVAL, typeEquals, type IrExpr, type IrGlobal, type IrLocal, type IrStmt, type IrType } from "../../ir/nodes.js";
import { PoisonError } from "./lowerer.js";
import { exitIsFresh } from "./island-views.js";
import { isJsSourceFile, locOf } from "../program.js";

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
  if (L.dynArmSites.size === 0 || decl.initializer === undefined || !ts.isIdentifier(decl.name)) return false;
  if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) === 0) return false;
  return L.dynArmSites.has(dynArmKey(stripParens(decl.initializer))) || L.dynArmSites.has(dynArmKey(decl.initializer));
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
  if (ts.isObjectLiteralExpression(init) && init.properties.some((p) => ts.isSpreadAssignment(p) && specRooted(p.expression))) return true;
  return (L.typeOf(init).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** A function literal's parameter that takes the dynamic arm. */
export function dynArmParam(L: Lowerer, param: ts.ParameterDeclaration): boolean {
  return L.dynArmSites.size > 0 && L.dynArmSites.has(`param:${dynArmKey(param)}`);
}

/** Registers every binding and parameter this pass's sites put on the
 * dynamic arm, before anything lowers (a function declared before the
 * binding's statement may reference it). */
export function collectDynArmSyms(L: Lowerer): void {
  if (L.dynArmSites.size === 0) return;
  const files = new Set([...L.dynArmSites].map((k) => k.replace(/^param:/, "").replace(/:\d+:\d+$/, "")));
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
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

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
 * copies are exact-guarded: noteDynArmExit). */
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
  if (ts.isCallExpression(node)) return armRooted(L, stripParens(node.expression));
  if (ts.isConditionalExpression(node)) return armRooted(L, node.whenTrue) || armRooted(L, node.whenFalse);
  // GH #132 / U2: an object literal spreading a dynamic-arm value is `any`
  // to TypeScript, so it builds the dynamic object (its keys in the
  // spread's own order), never a typed record read field by field.
  if (ts.isObjectLiteralExpression(node)) {
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
      return armRooted(L, node.left) || armRooted(L, node.right);
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

/* ── U2b: the speculative typed arm (§4.3 step 2) ─────────────────────────
 *
 * `const v = JSON.parse(text) as T` (any FRESH dynamic value, S115 (d)'s
 * provenance rules) is tested once, at the binding, against T's EXACT
 * shape (jsFits: exactly T's keys in T's order, every leaf of its kind).
 * When it fits, the binding takes a typed copy — nothing else holds the
 * value, and a copy of exactly its shape cannot be told from it — and the
 * typed code runs at typed speed. When it does not, the binding takes the
 * dynamic arm: the value itself, read the way an `any` is, so the
 * program's own validation (`typeof v.id`) runs as in Node and a value of
 * the wrong kind is checked only where it must enter typed storage.
 *
 * Both arms are compiled: at the first statement of the binding's list
 * that names it, the rest of the list lowers twice, once with the binding
 * resolving to the typed copy and once to the dynamic value, behind one
 * test of the flag. Containment keeps that sound and bounded: a block-
 * scoped `const` in a function's (or a nested block's) statement list,
 * whose rest holds no declaration that hoists out of it or registers
 * program-wide (functions, classes, `var`), at most SPEC_MAX_DEPTH
 * speculative bindings deep. A pass whose speculation fails to lower
 * (a reference the split did not reach) retries with those bindings on
 * the eager copy, as before U2b. */

export const SPEC_MAX_DEPTH = 2;

export interface SpecBinding {
  key: string;
  /** The typed copy, the dynamic value and the exact-fit flag: locals, or
   * (a module-scope binding) globals. */
  t: IrLocal | IrGlobal;
  d: IrLocal | IrGlobal;
  ok: IrLocal | IrGlobal;
  /** The statement list whose lowering declared it (its lifetime); null
   * for a module-scope binding, which lives for the whole pass. */
  owner: readonly ts.Statement[] | null;
  /** A module-scope binding's declaration statement. */
  declStmt?: ts.Statement;
}

/** Does `n` name `sym` (a reference, not a property name)? */
function mentions(L: Lowerer, n: ts.Node, sym: ts.Symbol, name: string): boolean {
  let hit = false;
  const visit = (x: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(x) && x.text === name) {
      const p = x.parent;
      const s = p !== undefined && ts.isShorthandPropertyAssignment(p) ? L.checker.getShorthandAssignmentValueSymbol(p) : L.checker.getSymbolAtLocation(x);
      if (s === sym) hit = true;
      return;
    }
    ts.forEachChild(x, visit);
  };
  visit(n);
  return hit;
}

/** Constructs whose lowering hoists out of a statement list or registers
 * program-wide — a list holding one is not lowered twice. */
function forbiddenInRest(n: ts.Node, atModule: boolean): boolean {
  let hit = false;
  const visit = (x: ts.Node, nested: boolean): void => {
    if (hit) return;
    // Classes register program-wide wherever they are.
    if (ts.isClassDeclaration(x) || ts.isClassExpression(x)) {
      hit = true;
      return;
    }
    // In this function's own body: a hoisted function, a function-scoped
    // `var` (a module's are globals, assigned on either arm alike), a
    // label, a `yield` (the generator lowering owns its statements).
    if (!nested && (ts.isFunctionDeclaration(x) ||
        (!atModule && ts.isVariableDeclarationList(x) && (x.flags & ts.NodeFlags.BlockScoped) === 0) ||
        ts.isLabeledStatement(x) || x.kind === ts.SyntaxKind.YieldExpression)) {
      hit = true;
      return;
    }
    const inner = nested || ts.isArrowFunction(x) || ts.isFunctionExpression(x) || ts.isMethodDeclaration(x) ||
      ts.isGetAccessorDeclaration(x) || ts.isSetAccessorDeclaration(x);
    ts.forEachChild(x, (c) => visit(c, inner));
  };
  visit(n, false);
  return hit;
}

/** The fresh-cast shape of a `const` declaration: the dynamic expression
 * and the typed composite it is cast (or annotated) to, or null. */
function specShapeOf(L: Lowerer, decl: ts.VariableDeclaration): { inner: ts.Expression; target: IrType } | null {
  if (decl.initializer === undefined) return null;
  const init = stripParens(decl.initializer);
  let inner: ts.Expression;
  let typeNode: ts.TypeNode;
  if (ts.isAsExpression(init) || ts.isTypeAssertion(init)) {
    inner = init.expression;
    typeNode = init.type;
  } else {
    if (decl.type === undefined) return null;
    inner = init;
    typeNode = decl.type;
  }
  // The checker's own answer first: nothing is mapped (no shape interned —
  // collection order decides shapes' printed key order) unless the
  // initializer is a dynamic value at all.
  if ((L.typeOf(inner).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return null;
  const target = L.mapTypeOf(L.checker.getTypeFromTypeNode(typeNode));
  if (target === null || !L.copiesOnCrossing(target) || !L.boundaryExitSafe(target)) return null;
  if (L.mapTypeOf(L.typeOf(inner))?.kind !== "jsval") return null;
  if (!exitIsFresh(L, inner, target)) return null;
  return { inner, target };
}

/** Collection (collectGlobals): a module-scope `const v = <fresh dynamic>
 * as T` of this file takes U2b's two arms — its target type, or null. The
 * global itself then holds the dynamic value (and, once a typed copy is
 * taken, its live view: code that read the binding before its value was
 * known shares the typed copy). */
export function specGlobalTarget(L: Lowerer, decl: ts.VariableDeclaration): IrType | null {
  if (!L.sharedDynamic || !ts.isIdentifier(decl.name)) return null;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0 || list.declarations.length !== 1) return null;
  const stmt = list.parent;
  if (!ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent)) return null;
  if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return null;
  if (L.noSpec.has(`spec:${dynArmKey(decl)}`)) return null;
  const sym = L.checker.getSymbolAtLocation(decl.name);
  if (sym === undefined) return null;
  let target: IrType | null;
  try {
    target = specShapeOf(L, decl)?.target ?? null;
  } catch (e) {
    if (e instanceof PoisonError) return null;
    throw e;
  }
  if (target === null) return null;
  const name = decl.name.text;
  // Nothing of the module's own run ahead of the declaration may reach the
  // binding (a closure built there would fix its arm too early).
  for (const s of stmt.parent.statements) {
    if (s === stmt) break;
    if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) ||
        ts.isImportDeclaration(s)) continue;
    if (mentions(L, s, sym, name)) return null;
  }
  // Nor may a later module-scope binding of a UNION type carrying a
  // composite be initialized from it: on the dynamic arm that global's slot
  // takes a checked copy, and the union's arm matcher (stricter than the
  // record copy about missing keys) would fence where the typed copy ran.
  let after = false;
  for (const s of stmt.parent.statements) {
    if (s === stmt) {
      after = true;
      continue;
    }
    if (!after || !ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (d.initializer === undefined || !mentions(L, d.initializer, sym, name)) continue;
      const tt = L.typeOf(d.name);
      if ((tt.flags & ts.TypeFlags.Union) === 0) continue;
      try {
        const t = L.mapTypeOf(tt);
        if (t === null || (t.kind === "union" && L.copiesOnCrossing(t))) return null;
      } catch (e) {
        if (e instanceof PoisonError) return null;
        throw e;
      }
    }
  }
  return target;
}

/** Collection: registers a module-scope speculative binding's typed copy
 * and flag beside its (dynamic) global `g`. */
export function registerSpecGlobal(L: Lowerer, decl: ts.VariableDeclaration, g: IrGlobal, target: IrType): void {
  const sym = L.checker.getSymbolAtLocation(decl.name)!;
  const t: IrGlobal = { id: `${g.id}%spec.t`, name: `${g.name}%spec.t`, type: target, mutable: true };
  const ok: IrGlobal = { id: `${g.id}%spec.ok`, name: `${g.name}%spec.ok`, type: BOOL, mutable: true };
  L.globalsList.push(t, ok);
  const key = `spec:${dynArmKey(decl)}`;
  L.specBindings.set(sym, { key, t, d: g, ok, owner: null, declStmt: decl.parent.parent as ts.Statement });
  L.specKeys.add(key);
}

/** U2b's binding statement: `const v = <fresh dynamic> as T` (or `const v:
 * T = <fresh dynamic>`) at index `i` of `stmts`. Answers its lowering (the
 * dynamic value, the exact-fit flag and the typed copy), registering the
 * speculative binding, or null when the statement is not one. */
export function lowerSpecDecl(L: Lowerer, stmt: ts.Statement, stmts: readonly ts.Statement[], i: number): IrStmt[] | null {
  if (!L.sharedDynamic || !ts.isVariableStatement(stmt)) return null;
  const list = stmt.declarationList;
  if ((list.flags & ts.NodeFlags.Const) === 0 || list.declarations.length !== 1) return null;
  const decl = list.declarations[0]!;
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  const sym = L.checker.getSymbolAtLocation(decl.name);
  if (sym === undefined) return null;
  const lowerInner = (key: string, inner: ts.Expression): IrExpr => {
    const d = L.lowerExpr(inner);
    const dv: IrExpr = d.type.kind === "dyn" ? { kind: "jsMarshal", value: d, type: JSVAL, loc: d.loc } : d;
    if (dv.type.kind !== "jsval") {
      // Not the dynamic value its type promised: the next pass binds it
      // as before U2b.
      L.specRetry.add(key);
      L.unsupported("SC1090", decl, "a speculative typed binding over a value that is not dynamic (internal: retried without speculation)");
    }
    return dv;
  };
  // A binding whose speculation a previous pass could not compile: the
  // eager copy, but of an exactly-fitting value only — a value the typed
  // copy would differ from stops by name (S128 (b)), never a width copy.
  const nkey = `spec:${dynArmKey(decl)}`;
  // Also a local that cannot be speculated at all: one outside a block's
  // list (a `case` clause), or one a closure ahead of it reaches.
  const local = !L.globalsBySymbol.has(sym) && !L.dynArmSyms.has(sym) && !L.specBindings.has(sym);
  let shape0: { inner: ts.Expression; target: IrType } | null | undefined;
  const shapeOf = (): { inner: ts.Expression; target: IrType } | null => {
    if (shape0 !== undefined) return shape0;
    try {
      shape0 = specShapeOf(L, decl);
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      shape0 = null;
    }
    return shape0;
  };
  const forced = (): boolean =>
    L.sharedDynamic && local && shapeOf() !== null &&
    (!ts.isBlock(stmt.parent) || stmts.slice(0, i).some((p) => mentions(L, p, sym, (decl.name as ts.Identifier).text)));
  if (L.noSpec.has(nkey) || forced()) {
    const shape = shapeOf();
    if (shape === null) return null;
    const loc = locOf(decl);
    const global = L.globalsBySymbol.get(sym);
    if (global !== undefined && !typeEquals(global.type, shape.target)) return null;
    const dv = lowerInner(nkey, shape.inner);
    const tmp = L.declareHiddenLocal(`%spec.e.${decl.name.text}`, JSVAL);
    const ref = (): IrExpr => ({ kind: "varRef", localId: tmp.id, type: JSVAL, loc });
    const copy: IrExpr = { kind: "jsExit", value: ref(), type: shape.target, fresh: true, loc };
    const out: IrStmt[] = [
      { kind: "varDecl", localId: tmp.id, init: dv, loc },
      {
        kind: "if",
        cond: { kind: "unary", op: "!", operand: { kind: "jsFits", value: ref(), target: shape.target, type: BOOL, lenient: true, loc }, type: BOOL, loc },
        then: [{
          kind: "runtimeFence",
          code: "SC1100",
          message: "a parsed value that does not have exactly its cast's shape (a key the type does not declare, keys out of the type's order, an absent required key that is not a plain number, string or boolean, an optional key holding undefined, or a mistyped value), bound where this build cannot compile the binding's uses on the dynamic arm yet (SEMANTICS.md S128 (b))",
          loc,
        }],
        else_: null,
        loc,
      },
    ];
    if (global !== undefined) {
      out.push({ kind: "assign", localId: global.id, value: copy, loc });
      const tdz = L.moduleTdz;
      const b = tdz !== null ? tdz.bySymbol.get(sym) : undefined;
      if (tdz !== null && b !== undefined) out.push(tdz.flagSet(b, loc));
    } else {
      const local = L.declareLocal(decl.name, decl.name.text, shape.target, false);
      out.push({ kind: "varDecl", localId: local.id, init: copy, loc });
    }
    return out;
  }
  // A module-scope binding collection registered (registerSpecGlobal).
  const g = L.specBindings.get(sym);
  if (g !== undefined && g.owner === null) {
    const shape = specShapeOf(L, decl);
    if (shape === null || g.declStmt !== stmt) {
      L.specRetry.add(g.key);
      L.unsupported("SC1090", decl, "a speculative typed binding whose shape changed (internal: retried without speculation)");
    }
    const loc = locOf(decl);
    const ref = (x: IrLocal | IrGlobal): IrExpr => ({ kind: "varRef", localId: x.id, type: x.type, loc });
    const target = shape.target;
    // The module-TDZ init flag (withModuleTdzFlags' identifier rule).
    const tdz = L.moduleTdz;
    const b = tdz !== null ? tdz.bySymbol.get(sym) : undefined;
    const flag: IrStmt[] = tdz !== null && b !== undefined ? [tdz.flagSet(b, loc)] : [];
    return [
      { kind: "assign", localId: g.d.id, value: lowerInner(g.key, shape.inner), loc },
      { kind: "assign", localId: g.ok.id, value: { kind: "jsFits", value: ref(g.d), target, type: BOOL, loc }, loc },
      {
        kind: "if",
        cond: ref(g.ok),
        then: [
          { kind: "assign", localId: g.t.id, value: { kind: "jsExit", value: ref(g.d), type: target, fresh: true, loc }, loc },
          // Code that read the binding before its value was known (a
          // function called from the module's own run) took the dynamic
          // arm: it shares the typed copy through the copy's live view.
          { kind: "assign", localId: g.d.id, value: L.jsvalIn(ref(g.t), decl.initializer), loc },
        ],
        else_: null,
        loc,
      },
      ...flag,
    ];
  }
  if (!ts.isBlock(stmt.parent)) return null;
  const key = `spec:${dynArmKey(decl)}`;
  if (L.noSpec.has(key)) return null;
  if (L.globalsBySymbol.has(sym) || L.dynArmSyms.has(sym)) return null;
  const shape = specShapeOf(L, decl);
  if (shape === null) return null;
  const { inner, target } = shape;
  const loc = locOf(decl);
  const dv = lowerInner(key, inner);
  const dl = L.declareHiddenLocal(`%spec.d.${decl.name.text}`, JSVAL);
  const ok = L.declareHiddenLocal(`%spec.ok.${decl.name.text}`, BOOL);
  const tl = L.declareHiddenLocal(`%spec.t.${decl.name.text}`, target);
  const ref = (l: IrLocal | IrGlobal): IrExpr => ({ kind: "varRef", localId: l.id, type: l.type, loc });
  L.specBindings.set(sym, { key, t: tl, d: dl, ok, owner: stmts });
  L.specKeys.add(key);
  return [
    { kind: "varDecl", localId: dl.id, init: dv, loc },
    { kind: "varDecl", localId: ok.id, init: { kind: "jsFits", value: ref(dl), target, type: BOOL, loc }, loc },
    {
      kind: "varDecl",
      localId: tl.id,
      init: {
        kind: "ternary",
        cond: ref(ok),
        then: { kind: "jsExit", value: ref(dl), type: target, fresh: true, loc },
        else_: { kind: "slotUndef", type: target, loc },
        type: target,
        loc,
      },
      loc,
    },
  ];
}

/** The duplication budget of U2b's splits, per function lowering: the
 * first split of a function spends its region's size once more (both arms);
 * every later split there must fit in what is left of that, counted per
 * copy it lands in. A split over budget, too deep, or over a region that
 * cannot be lowered twice lowers its region ONCE on the dynamic arm
 * ("arm-only") — exact, at dynamic speed — never on an eager copy. */
const MIN_SPEC_BUDGET = 200;

function countNodes(nodes: readonly ts.Node[]): number {
  let n = 0;
  const visit = (x: ts.Node): void => {
    n++;
    ts.forEachChild(x, visit);
  };
  for (const x of nodes) visit(x);
  return n;
}

/** The names a list statement declares at its own level. */
function declaredNames(L: Lowerer, stmt: ts.Statement): ts.Symbol[] {
  const out: ts.Symbol[] = [];
  if (!ts.isVariableStatement(stmt)) return out;
  const walk = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) {
      const s = L.checker.getSymbolAtLocation(n);
      if (s !== undefined) out.push(s);
      return;
    }
    for (const el of n.elements) if (!ts.isOmittedExpression(el) && el.name !== undefined) walk(el.name);
  };
  for (const d of stmt.declarationList.declarations) walk(d.name);
  return out;
}

/** The statements `[i, end]` of `stmts` that must lower per arm: through
 * the last one naming `sym`, and further through the last one naming any
 * binding the region declares (those live in the arm's own scope). */
function splitRegionEnd(L: Lowerer, stmts: readonly ts.Statement[], i: number, sym: ts.Symbol): number {
  let end = i;
  for (let j = stmts.length - 1; j > i; j--) {
    if (mentions(L, stmts[j]!, sym, sym.name)) {
      end = j;
      break;
    }
  }
  for (;;) {
    const decls: ts.Symbol[] = [];
    for (let j = i; j <= end; j++) decls.push(...declaredNames(L, stmts[j]!));
    let next = end;
    for (let j = stmts.length - 1; j > end; j--) {
      if (decls.some((d) => mentions(L, stmts[j]!, d, d.name))) {
        next = j;
        break;
      }
    }
    if (next === end) return end;
    end = next;
  }
}

/** At statement `i` of `stmts`: when it is the first to name a speculative
 * binding not yet fixed, the statements through its region (splitRegionEnd)
 * lowered on both arms behind the binding's flag — or once on the dynamic
 * arm (MIN_SPEC_BUDGET's rule) — and how many statements that consumed;
 * else null. */
export function lowerSpecSplit(L: Lowerer, stmts: readonly ts.Statement[], i: number): { stmt: IrStmt; consumed: number } | null {
  const stmt = stmts[i]!;
  for (const [sym, s] of L.specBindings) {
    if (L.specFixed.has(sym)) continue;
    // A module-scope binding's own declaration lowers once (its list's
    // earlier statements never name it: specGlobalTarget).
    if (s.owner === null && stmt === s.declStmt) continue;
    if (!mentions(L, stmt, sym, sym.name)) continue;
    const end = splitRegionEnd(L, stmts, i, sym);
    const region = stmts.slice(i, end + 1);
    const loc = locOf(stmt);
    const atModule = ts.isSourceFile(stmt.parent);
    const size = countNodes(region);
    const ctx = L.ctx as object;
    let budget = L.specBudget.get(ctx);
    if (budget === undefined) L.specBudget.set(ctx, (budget = Math.max(MIN_SPEC_BUDGET, size)));
    const cost = size * (1 << L.specDepth);
    // A region that also reads another speculative binding not yet fixed
    // gains no typed speed from two arms (its typed arm would still read
    // the other on the dynamic arm): one arm, the dynamic one.
    let others = false;
    for (const [o] of L.specBindings) {
      if (o !== sym && !L.specFixed.has(o) && region.some((r) => mentions(L, r, o, o.name))) {
        others = true;
        break;
      }
    }
    const both = !others && L.specDepth < SPEC_MAX_DEPTH && cost <= budget && !region.some((r) => forbiddenInRest(r, atModule));
    if (both) L.specBudget.set(ctx, budget - cost);
    const global = s.owner === null ? (s.d as IrGlobal) : null;
    const arm = (typed: boolean): IrStmt[] => {
      if (global !== null) L.globalsBySymbol.set(sym, typed ? (s.t as IrGlobal) : global);
      else L.scopes.push(new Map([[sym, (typed ? s.t : s.d) as IrLocal]]));
      L.specFixed.add(sym);
      if (!typed) L.dynArmSyms.add(sym);
      L.specDepth++;
      const stats = L.suppressStats;
      if (!typed && both) L.suppressStats = true;
      try {
        return L.lowerStmts(region);
      } finally {
        L.suppressStats = stats;
        L.specDepth--;
        if (!typed) L.dynArmSyms.delete(sym);
        L.specFixed.delete(sym);
        if (global !== null) L.globalsBySymbol.set(sym, global);
        else L.scopes.pop();
      }
    };
    if (!both) {
      // Arm-only: the dynamic value (for a module-scope binding, the typed
      // copy's live view once the copy exists) — one lowering, Node's
      // answers, no typed arm here.
      return { stmt: { kind: "if", cond: { kind: "boolLit", value: true, type: BOOL, loc }, then: arm(false), else_: null, loc }, consumed: region.length };
    }
    const then = arm(true);
    const else_ = arm(false);
    return { stmt: { kind: "if", cond: { kind: "varRef", localId: s.ok.id, type: BOOL, loc }, then, else_, loc }, consumed: region.length };
  }
  return null;
}
