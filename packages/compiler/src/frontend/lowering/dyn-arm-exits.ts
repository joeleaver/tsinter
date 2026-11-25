/* Unit U2a (dyn-arm.ts): where a judged exit's CONTAINED SLOT is.
 *
 * Every judged copy of a dynamic value into typed storage (an S115 (d)
 * exit) passes through noteDynArmExit, which finds the slot the value
 * lands in. When that slot can hold the dynamic value itself, the exit is
 * recorded under the slot's key (`dynArmExitNodes`); S125 (c)'s judgement
 * (judge-dyn-sites.ts) then turns a refused exit into a dynamic-arm site of
 * the next lowering pass (`dynArmRetry`), and an accepted one into a soft
 * site that pass tries too (`dynArmSoft`).
 *
 * The contained slots and their keys (SEMANTICS.md S125, the U2 amendment,
 * paperclip slice A and amendment (K)):
 *   - a cast used in place, its own key — also when the cast is of a
 *     checked-dynamic (`unknown`) value, whose exit is judged at the cast's
 *     operand (Lowerer.dynExitGate);
 *   - a `const`/`let` binding's initializer, the initializer's key;
 *   - an argument of a direct call, its own key (the callee's per-call-site
 *     instance binds the parameter on the arm: width-instances.ts);
 *   - a plain function's `return` or expression body, `ret:<function>`;
 *   - a `const` for-of loop binding, `forof:<name>`;
 *   - (K) a `let` declared without its value, assigned only by plain `=`
 *     statements, `let:<name>` (dyn-arm.ts deferredLetBinding);
 *   - (K) a name of a `const` destructuring pattern, `pat:<name>`
 *     (dyn-arm.ts constPatternBinding);
 *   - (K) an operand of `?:`, `??`, `||` or `&&` whose other value operands
 *     are fresh literals or dynamic values, when the outermost such
 *     expression is itself in one of the slots above: the key of that
 *     outermost expression, which the next pass lowers as a dynamic value
 *     (dyn-arm-rooted.ts armRooted) — its slot then takes the arm through
 *     its own exit.
 * Fields and elements never take the arm (decision J4).
 *
 * And the exact-fit guard (S128 (a2)/(a3)): a copy taken FROM a value on
 * the arm, or at a slot whose arm did not build, copies only a value of
 * exactly its type's shape and stops by name otherwise. */
import * as ts from "../ts7/adapter.js";
import { BOOL, JSVAL, type IrExpr } from "../../ir/nodes.js";
import { typeKey } from "../types.js";
import type { Lowerer } from "./lowerer.js";
import { jsonDocCopyDrops } from "./lower-exprs.js";
import { armableBinding, constPatternBinding, deferredLetBinding, dynArmKey, forOfConstBinding, isDynArmSite, packageCallResult } from "./dyn-arm.js";
import { armRooted } from "./dyn-arm-rooted.js";

/** The parent of `n`, past parentheses and non-null assertions (neither
 * changes the value), with the child it was reached from. */
function valueParent(n: ts.Node): { up: ts.Node | undefined; child: ts.Node } {
  let child = n;
  let up = n.parent;
  while (up !== undefined && (ts.isParenthesizedExpression(up) || ts.isNonNullExpression(up))) {
    child = up;
    up = up.parent;
  }
  return { up, child };
}

function stripValue(e: ts.Node): ts.Node {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return cur;
}

/** A value operand that can sit beside a dynamic one in a conditional or
 * logical expression on the arm without a copy anyone could observe: a
 * literal made only of literals (nothing else holds it, so its dynamic
 * form cannot be told from it), or a value that is already dynamic (the
 * checker types it `any`/`unknown`, it is a statically compiled
 * package's result, or it is rooted at a dynamic-arm value) and so crosses
 * as itself. */
function passiveOperand(L: Lowerer, e: ts.Expression): boolean {
  const x = stripValue(e);
  switch (x.kind) {
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return true;
  }
  // `undefined`, `void 0`, or any value typed only `null`/`undefined`:
  // holds no object, so its dynamic form cannot be told from it.
  if (ts.isExpression(x) && (L.typeOf(x).flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) === 0) return true;
  if (ts.isArrayLiteralExpression(x)) {
    return x.elements.every((el) => !ts.isSpreadElement(el) && !ts.isOmittedExpression(el) && passiveLiteral(L, el));
  }
  if (ts.isObjectLiteralExpression(x)) return passiveLiteral(L, x);
  if (!ts.isExpression(x)) return false;
  if ((L.typeOf(x).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
  // A package's result (dyn-arm.ts packageCallResult) is its own value.
  if (packageCallResult(L, x)) return true;
  return armRooted(L, x);
}

/** A literal all the way down (no binding, call or spread inside). */
function passiveLiteral(L: Lowerer, e: ts.Expression): boolean {
  const x = stripValue(e);
  if (ts.isObjectLiteralExpression(x)) {
    return x.properties.every((p) =>
      ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && passiveLiteral(L, p.initializer));
  }
  if (ts.isArrayLiteralExpression(x) || ts.isObjectLiteralExpression(x)) return passiveOperand(L, x as ts.Expression);
  switch (x.kind) {
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return true;
  }
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken) return ts.isNumericLiteral(x.operand);
  return false;
}

/** (K) From an operand `n`, the outermost `?:` (a branch, never the
 * condition), `??`, `||` or `&&` expression it is a value of, climbing only
 * while every other value operand is passive (`a && b`'s left operand is
 * its value only when falsy, so never an object, and needs no test). */
function armChainTop(L: Lowerer, n: ts.Node): ts.Node {
  let cur = n;
  for (;;) {
    const { up, child } = valueParent(cur);
    if (up === undefined) return cur;
    if (ts.isConditionalExpression(up) && up.condition !== child) {
      if (!passiveOperand(L, up.whenTrue === child ? up.whenFalse : up.whenTrue)) return cur;
      cur = up;
      continue;
    }
    if (ts.isBinaryExpression(up)) {
      const k = up.operatorToken.kind;
      if (k !== ts.SyntaxKind.QuestionQuestionToken && k !== ts.SyntaxKind.BarBarToken && k !== ts.SyntaxKind.AmpersandAmpersandToken) return cur;
      const otherIsLeft = up.right === child;
      const other = otherIsLeft ? up.left : up.right;
      if (!(k === ts.SyntaxKind.AmpersandAmpersandToken && otherIsLeft) && !passiveOperand(L, other)) return cur;
      cur = up;
      continue;
    }
    return cur;
  }
}

/** The plain function (a declaration or function literal; not generic,
 * async or a generator) whose result `n` is: the value of one of its
 * `return`s, or an arrow's expression body. */
function plainResultOf(n: ts.Node, up: ts.Node | undefined): ts.FunctionLikeDeclaration | null {
  let fn: ts.Node | undefined;
  if (up !== undefined && ts.isReturnStatement(up)) {
    fn = up.parent;
    while (fn !== undefined && !ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn) && !ts.isMethodDeclaration(fn) &&
      !ts.isConstructorDeclaration(fn) && !ts.isAccessor(fn) && !ts.isClassStaticBlockDeclaration(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
  } else if (up !== undefined && ts.isArrowFunction(up) && up.body === n) {
    fn = up;
  }
  if (fn === undefined || !(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))) return null;
  if (fn.typeParameters !== undefined || fn.asteriskToken !== undefined || (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  return fn;
}

/** (K) The `let` a plain `x = value` statement assigns `value` to, when
 * that binding is a deferred-let slot (dyn-arm.ts deferredLetBinding). */
function deferredLetAssigned(L: Lowerer, value: ts.Node): ts.VariableDeclaration | null {
  const { up, child } = valueParent(value);
  if (up === undefined || !ts.isBinaryExpression(up) || up.operatorToken.kind !== ts.SyntaxKind.EqualsToken || up.right !== child) return null;
  if (!ts.isExpressionStatement(up.parent) || !ts.isIdentifier(up.left)) return null;
  const sym = L.checker.getSymbolAtLocation(up.left);
  if (sym === undefined) return null;
  const decls = L.checker.declarationsOf(sym);
  if (decls.length !== 1) return null;
  const d = decls[0]!;
  return ts.isVariableDeclaration(d) && deferredLetBinding(L, d) ? d : null;
}

type Slot = { key: string; retFn: ts.FunctionLikeDeclaration | null };

function stripParens(e: ts.Node): ts.Node {
  let cur = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function parentPastParens(n: ts.Node): ts.Node | undefined {
  let up = n.parent;
  while (up !== undefined && ts.isParenthesizedExpression(up)) up = up.parent;
  return up;
}

/** The contained slot an exit at `node` lands in — its key, and the plain
 * function whose result it is, if any — or null when the slot cannot hold
 * the dynamic value. */
function containedSlot(L: Lowerer, node: ts.Node): Slot | null {
  let n = stripParens(node);
  let up = parentPastParens(n);
  // A declaration's own exit may be lowered against its name (a module
  // global's assignment): the binding's key is its initializer's.
  if (up !== undefined && ts.isVariableDeclaration(up) && up.name === n && up.initializer !== undefined) n = stripParens(up.initializer);
  // (K) A cast of a checked-dynamic (`unknown`) value is judged at its
  // operand (Lowerer.dynExitGate): the slot is the cast itself, which the
  // next pass lowers on the arm (lower-exprs.ts lowerAsExpression's
  // `isDynArmSite` test).
  if (up !== undefined && (ts.isAsExpression(up) || ts.isTypeAssertion(up)) && stripParens(up.expression) === n) {
    n = up;
    up = parentPastParens(n);
  }
  // S125: a `const` for-of loop binding, or (K) a `const` pattern's name.
  if (forOfConstBinding(n)) return { key: `forof:${dynArmKey(n)}`, retFn: null };
  if (constPatternBinding(n)) return { key: `pat:${dynArmKey(n)}`, retFn: null };
  const direct = directSlot(L, n, up, node);
  if (direct !== null) return direct;
  // (K) an operand of a conditional or logical expression: the slot is the
  // outermost one's, and only one that holds a value itself (its own exit
  // then reaches a return or a deferred `let` in the next pass).
  const top = armChainTop(L, n);
  if (top === n) return null;
  const atTop = directSlot(L, top, parentPastParens(top), top);
  return atTop === null ? null : { key: dynArmKey(top), retFn: null };
}

/** The contained slot whose value is `n` itself, `up` its parent past
 * parentheses. */
function directSlot(L: Lowerer, n: ts.Node, up: ts.Node | undefined, node: ts.Node): Slot | null {
  // S125 A1 (a plain function's result): an exit at a `return` of a plain
  // function, or at an arrow's expression body — the function's RESULT
  // takes the dynamic arm in the next pass (a `ret:` site, as a boxed
  // literal's result does), so every caller receives the shared value and
  // checks only where it must enter typed storage. (The result's exit
  // keeps the exact-fit guard — a copy taken from an arm value, or at a
  // `ret:` slot whose arm did not build.)
  const retFn = plainResultOf(n, up);
  if (retFn !== null) return { key: `ret:${dynArmKey(retFn)}`, retFn };
  // (K) A cast already on the arm whose value a deferred `let` is assigned
  // (`cfg = u as T`): its exit now lands in the `let`.
  const armedCast = (ts.isAsExpression(n) || ts.isTypeAssertion(n)) && isDynArmSite(L, n);
  if (armedCast) {
    const letDecl = deferredLetAssigned(L, n);
    if (letDecl !== null) return { key: `let:${dynArmKey(letDecl.name)}`, retFn: null };
  }
  const contained =
    ts.isAsExpression(n) || ts.isTypeAssertion(n) ||
    (up !== undefined && ts.isVariableDeclaration(up) && up.initializer !== undefined && ts.isIdentifier(up.name) && armableBinding(up)) ||
    // An argument of a direct call: the callee's per-call-site instance
    // takes the parameter on the arm (widthSpecializedCall).
    (up !== undefined && ts.isCallExpression(up) && ts.isIdentifier(up.expression) && up.arguments.some((a) => a === n || a === node));
  if (contained) return { key: dynArmKey(n), retFn: null };
  // (K) a deferred `let`, assigned by a plain `=` statement.
  const letDecl = deferredLetAssigned(L, n);
  if (letDecl !== null) return { key: `let:${dynArmKey(letDecl.name)}`, retFn: null };
  return null;
}

/** Records a judged exit at a contained slot so that, if S125 (c) refuses
 * it, the next pass lowers it on the dynamic arm. Answers the exit — with
 * the exact-fit guard where U2 asks for it. */
export function noteDynArmExit(L: Lowerer, exit: IrExpr, node: ts.Node): IrExpr {
  const slot = containedSlot(L, node);
  let n = stripParens(node);
  // A declaration's own exit may be lowered against its name: the value is
  // its initializer's.
  const decl = parentPastParens(n);
  if (decl !== undefined && ts.isVariableDeclaration(decl) && decl.name === n && decl.initializer !== undefined) n = stripParens(decl.initializer);
  const key = slot?.key ?? dynArmKey(n);
  const armable = slot !== null;
  const retFn = slot?.retFn ?? null;
  if (armable) L.dynArmExitNodes.set(exit, key);
  // pc-json: a copy of a JSON document held as the dynamic value (the
  // documents are known at build time) that would drop a key the document
  // holds takes the dynamic arm in the next pass where the slot can hold
  // it — the arm keeps the document itself, and a failed arm falls back to
  // the exact-fit copy below, which stops by name — and refuses by name
  // anywhere else. A copy that drops nothing keeps the type's key order
  // (S041's checked-conversion rule).
  if (L.dynJsonImportSyms.size > 0 && exit.kind === "dynCheck" && ts.isExpression(n)) {
    const dropped = jsonDocCopyDrops(L, ts.isAsExpression(n) || ts.isTypeAssertion(n) ? n.expression : n, exit.type);
    if (dropped !== null) {
      if (!armable) L.unsupported("SC1090", dropped.node, dropped.why);
      if (!L.exactSites.has(key)) L.dynArmSoft.add(key);
    }
  }
  // Never a silent width copy where U2 is in play: a copy taken FROM a
  // dynamic-arm value, or one at a slot whose arm did not build (the
  // fallback pass's exactSites), copies only a value of exactly its
  // type's shape, and stops by name otherwise (SEMANTICS.md S128 (a2)).
  if (exit.kind === "dynCheck") {
    // (Review: an object literal or spread returned from a plain function
    // is a NEW object: a key its type does not declare is GH #148's to
    // judge (a printed copy refuses by name; spreadsIn reads through this
    // guard), so its guard skips undeclared keys; the declared ones keep
    // the exact test, a missing one its S119 mark.)
    const freshRet = retFn !== null && ts.isObjectLiteralExpression(n);
    const fromArm = exitFromArm(L, node);
    if ((fromArm || (armable && L.exactSites.has(key))) && L.copiesOnCrossing(exit.type) && L.boundaryExitSafe(exit.type)) {
      return exactGuard(L, exit, fromArm
        ? "a dynamic value held in a typed slot (SEMANTICS.md S128) copied into typed storage it does not fit exactly (a key the type does not declare, keys out of the type's order, an absent required key that is not a plain number, string or boolean, an optional key holding undefined, or a mistyped value): the copy would differ from the object"
        : "a dynamic value that does not have exactly its typed slot's shape, in a slot whose uses this build cannot compile on the dynamic arm yet (SEMANTICS.md S128 (a3))", freshRet && exit.type.kind === "record");
    }
  }
  return exit;
}

/** Unit U2: is the value an exit at `node` copies a dynamic-arm value
 * (the exit's own expression, a declaration's initializer, a literal
 * member's value, a spread's source, or — for a destructured binding —
 * the declaration's initializer)? */
export function exitFromArm(L: Lowerer, node: ts.Node): boolean {
  if (!L.dynArmActive) return false;
  let n: ts.Node = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  let up: ts.Node = n.parent;
  while (up !== undefined && ts.isParenthesizedExpression(up)) up = up.parent;
  if (up !== undefined && ts.isVariableDeclaration(up) && up.name === n && up.initializer !== undefined) {
    n = up.initializer;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
  } else if (up !== undefined && ts.isBindingElement(up) && up.name === n) {
    // A destructured binding's exit is lowered against its own name: the
    // value is read off the declaration's initializer.
    let d: ts.Node = up;
    while (ts.isBindingElement(d) || ts.isObjectBindingPattern(d) || ts.isArrayBindingPattern(d)) d = d.parent;
    if (!ts.isVariableDeclaration(d) || d.initializer === undefined) return false;
    n = d.initializer;
  }
  if (ts.isAsExpression(n) || ts.isTypeAssertion(n)) n = n.expression;
  if (ts.isShorthandPropertyAssignment(n)) n = n.name;
  else if (ts.isPropertyAssignment(n)) n = n.initializer;
  else if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) n = n.expression;
  return ts.isExpression(n) && armRooted(L, n);
}

/** `exit` (a dynCheck), preceded by U2's exact-fit test: a value that does
 * not have exactly the target's shape ends the program by name instead
 * of becoming a width-tolerant copy. The test is an interned pass-through
 * helper around the checked value (`%u2.exact.N`), so S125 (c)'s judgement
 * sees the same crossing as before. */
export function exactGuard(L: Lowerer, exit: IrExpr & { kind: "dynCheck" }, why: string, width = false): IrExpr {
  const loc = exit.loc;
  const vt = exit.value.type;
  const key = `u2exact:${typeKey(vt)}:${typeKey(exit.type)}:${why}${width ? ":width" : ""}`;
  let name = L.retagHelpers.get(key);
  if (name === undefined) {
    name = `%u2.exact.${L.retagHelpers.size}`;
    L.retagHelpers.set(key, name);
    const x: IrExpr = { kind: "varRef", localId: "x.0", type: vt, loc };
    const asJs: IrExpr = vt.kind === "jsval" ? x : { kind: "jsMarshal", value: x, type: JSVAL, loc };
    L.liftedFns.push({
      name,
      params: [{ localId: "x.0", name: "x", type: vt }],
      returnType: vt,
      locals: [{ id: "x.0", name: "x", type: vt, mutable: false }],
      body: [
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: { kind: "jsFits", value: asJs, target: exit.type, type: BOOL, lenient: true, ...(width ? { width: true as const } : {}), loc }, type: BOOL, loc },
          then: [{ kind: "runtimeFence", code: "SC1100", message: why, loc }],
          else_: null,
          loc,
        },
        { kind: "return", value: x, loc },
      ],
      loc,
    });
  }
  const result: IrExpr = { ...exit, value: { kind: "call", callee: name, args: [exit.value], type: vt, loc } };
  const k = L.dynArmExitNodes.get(exit);
  if (k !== undefined) L.dynArmExitNodes.set(result, k);
  return result;
}
