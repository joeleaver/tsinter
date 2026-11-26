/* S125-L, M5 (SEMANTICS.md S125 amendment (L)): an async plain function's
 * composite result on the dynamic arm.
 *
 * A plain function whose `return` would copy a dynamic value into its typed
 * result takes U2's result arm (`ret:`, S125 A1): it returns the dynamic
 * value itself. M5 gives an ASYNC function declaration the same arm: its
 * result becomes `Promise<jsval>`, the promise settling with the very
 * object the body returned, and `await f(…)` is the dynamic value at each
 * caller (dyn-arm-rooted.ts armRooted), so a binding of it joins the arm
 * and a field or element it is stored into keeps its judged copy (J4).
 *
 * The promise itself must mean the same thing everywhere it is seen, so the
 * arm is taken only when EVERY reference to the function, in every module,
 * is a direct call awaited in place (`await f(…)`, parentheses aside).
 * Anything else that would see the promise or the function as a value —
 * `f().then(…)`, `Promise.all([f(), …])`, `return f()`, `const p = f()`,
 * passing `f` as a callback or storing it — keeps the typed promise, and
 * the `return`'s copy keeps its refusal by name. Generators, generic
 * functions, methods and function literals are not covered (their result
 * stays typed, as before). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { FailureText } from "./arm-failures.js";

/** Per declaration (one ts.Program, every lowering pass): the first
 * reference that is not an awaited direct call, or null when every one is. */
const blockers = new WeakMap<ts.FunctionDeclaration, ts.Identifier | null>();

function isAsync(fn: ts.FunctionDeclaration): boolean {
  return (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** An async function declaration: not generic, not a generator, with a
 * body and a name. */
export function asyncDecl(fn: ts.Node): fn is ts.FunctionDeclaration {
  return ts.isFunctionDeclaration(fn) && isAsync(fn) && fn.asteriskToken === undefined && fn.typeParameters === undefined && fn.body !== undefined && fn.name !== undefined;
}

/** An async function declaration (asyncDecl) every reference to which is
 * `await f(…)`. */
export function asyncResultArmable(L: Lowerer, fn: ts.Node): fn is ts.FunctionDeclaration {
  return asyncDecl(fn) && firstBlocker(L, fn) === null;
}

/** M0 for (L): why an async function declaration's result cannot take the
 * arm — its first use other than `await f(…)` — or null when it can. */
export function asyncArmBlocker(L: Lowerer, fn: ts.FunctionDeclaration): FailureText | null {
  const id = firstBlocker(L, fn);
  if (id === null) return null;
  const sf = id.getSourceFile();
  return {
    text: `'${id.text}' is used other than as \`await ${id.text}(…)\``,
    at: { file: sf.fileName, line: ts.getLineAndCharacterOfPosition(sf, id.getStart()).line + 1 },
  };
}

function firstBlocker(L: Lowerer, fn: ts.FunctionDeclaration): ts.Identifier | null {
  const memo = blockers.get(fn);
  if (memo !== undefined) return memo;
  const sym = L.checker.getSymbolAtLocation(fn.name!);
  let found: ts.Identifier | null = sym === undefined ? fn.name! : null;
  if (sym !== undefined) {
    const name = fn.name!.text;
    for (const sf of L.program.getSourceFiles()) {
      if (found !== null) break;
      if (sf.isDeclarationFile || !sf.text.includes(name)) continue;
      const visit = (n: ts.Node): void => {
        if (found !== null) return;
        if (ts.isIdentifier(n) && n.text === name && n !== fn.name && refersTo(L, n, sym)) {
          if (!awaitedCallee(n)) found = n;
          return;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  blockers.set(fn, found);
  return found;
}

/** Does `id` name the function `sym` (directly, or through an import's
 * alias)? An import or export specifier's own name is no use of it. */
function refersTo(L: Lowerer, id: ts.Identifier, sym: ts.Symbol): boolean {
  const p = id.parent;
  if (p !== undefined && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p))) return false;
  if (p !== undefined && ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (p !== undefined && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === id) return false;
  const s = ts.isShorthandPropertyAssignment(p) ? L.checker.getShorthandAssignmentValueSymbol(p) : L.resolveValueSymbol(id);
  return s === sym;
}

/** `id` is the callee of a direct call whose result is awaited in place. */
function awaitedCallee(id: ts.Identifier): boolean {
  let callee: ts.Node = id;
  while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
  const call = callee.parent;
  if (call === undefined || !ts.isCallExpression(call) || call.expression !== callee) return false;
  let up: ts.Node = call.parent;
  while (up !== undefined && ts.isParenthesizedExpression(up)) up = up.parent;
  return up !== undefined && ts.isAwaitExpression(up);
}
