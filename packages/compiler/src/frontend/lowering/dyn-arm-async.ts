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

/** Per program (every lowering pass): for each async function declaration
 * (asyncDecl), the first reference to it that is not an awaited direct
 * call, or null when every one is (blockerIndex). */
const indexes = new WeakMap<object, Map<ts.FunctionDeclaration, ts.Node | null>>();
/** Blockers that are a module namespace used as a value (or a module loaded
 * by `import(…)` / `require(…)`), for the M0 text. */
const namespaceEscapes = new WeakSet<ts.Node>();

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
  const at = firstBlocker(L, fn);
  if (at === null) return null;
  const sf = at.getSourceFile();
  const name = fn.name!.text;
  const spelled = at.getText(sf);
  const what = spelled.length <= 40 ? spelled : `${spelled.slice(0, 40)}…`;
  const text = namespaceEscapes.has(at)
    ? `the namespace '${what}' of its module is used as a value, so '${name}' may be reached other than as \`await ${name}(…)\``
    : what === name ? `'${name}' is used other than as \`await ${name}(…)\`` : `'${name}' is used other than as \`await ${name}(…)\` (as '${what}')`;
  return {
    text,
    at: { file: sf.fileName, line: ts.getLineAndCharacterOfPosition(sf, at.getStart()).line + 1 },
  };
}

function firstBlocker(L: Lowerer, fn: ts.FunctionDeclaration): ts.Node | null {
  return blockerIndex(L).get(fn) ?? null;
}

/** One walk over every source file of the program, judging each reference
 * by the symbol it resolves to (through every import, export and namespace
 * alias), not by its spelling: `import { f as g }`, `export { f as h }`, a
 * default import and `M.f` through `import * as M` all reach `f`. A
 * reference is fine only as the callee of a direct call awaited in place
 * (`await f(…)`, `await M.f(…)`). Anything else blocks: a call used any
 * other way, the function as a value, `M["f"]`, and a namespace object of
 * f's module used other than to read a member (`const N = M`,
 * `Object.values(M)`, `import("./m")`, `require("./m")`), since its members
 * then escape where no reference can be judged. Import and export
 * specifiers and `export default f` are no uses themselves: the names they
 * bind are judged where they are used. */
function blockerIndex(L: Lowerer): Map<ts.FunctionDeclaration, ts.Node | null> {
  let index = indexes.get(L.program);
  if (index !== undefined) return index;
  const out = new Map<ts.FunctionDeclaration, ts.Node | null>();
  index = out;
  indexes.set(L.program, out);
  const files = L.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile);
  const byFile = new Map<ts.SourceFile, ts.FunctionDeclaration[]>();
  // The spellings a reference to one of them can take: its own name, and
  // every name an import or export binds (an alias may rename it).
  const spellings = new Set<string>(["default"]);
  for (const sf of files) {
    const visit = (n: ts.Node): void => {
      if (asyncDecl(n)) {
        out.set(n, null);
        spellings.add(n.name!.text);
        const list = byFile.get(sf) ?? [];
        list.push(n);
        byFile.set(sf, list);
      } else if (ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) {
        spellings.add(n.name.text);
      } else if ((ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isNamespaceExport(n)) && n.name !== undefined) {
        spellings.add(n.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  if (out.size === 0) return out;
  const block = (fn: ts.FunctionDeclaration, at: ts.Node): void => {
    if (out.get(fn) === null) out.set(fn, at);
  };
  const target = (s: ts.Symbol | undefined): ts.Symbol | undefined =>
    s !== undefined && s.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(s) : s;
  const fnOf = (s: ts.Symbol | undefined): ts.FunctionDeclaration | null => {
    for (const d of s !== undefined ? L.checker.declarationsOf(s) : []) if (ts.isFunctionDeclaration(d) && out.has(d)) return d;
    return null;
  };
  const moduleOf = (s: ts.Symbol | undefined): ts.SourceFile | null => {
    for (const d of s !== undefined ? L.checker.declarationsOf(s) : []) if (ts.isSourceFile(d)) return d;
    return null;
  };
  const escapeModule = (sf: ts.SourceFile | null, at: ts.Node): void => {
    namespaceEscapes.add(at);
    for (const fn of sf !== null ? byFile.get(sf) ?? [] : []) block(fn, at);
  };
  for (const sf of files) {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        judgeIdentifier(n);
        return;
      }
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
        const fn = fnOf(target(L.checker.getSymbolAtLocation(n.argumentExpression)));
        if (fn !== null) block(fn, n);
      }
      if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]!) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        escapeModule(moduleOf(target(L.checker.getSymbolAtLocation(n.arguments[0]!))), n);
      }
      ts.forEachChild(n, visit);
    };
    const judgeIdentifier = (id: ts.Identifier): void => {
      if (!spellings.has(id.text)) return;
      const p = id.parent;
      if (p === undefined) return;
      // A declaration's own name, and the names imports and exports bind.
      if (ts.isFunctionDeclaration(p) && p.name === id) return;
      if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isNamespaceExport(p)) return;
      if (ts.isExportAssignment(p) && p.expression === id && !p.isExportEquals) return;
      const raw = ts.isShorthandPropertyAssignment(p) && p.name === id
        ? L.checker.getShorthandAssignmentValueSymbol(p)
        : L.checker.getSymbolAtLocation(id);
      const s = target(raw);
      const fn = fnOf(s);
      if (fn !== null) {
        const callee: ts.Node = ts.isPropertyAccessExpression(p) && p.name === id ? p : id;
        if (!awaitedCallee(callee)) block(fn, id);
        return;
      }
      // A namespace object of a module holding such functions: fine only as
      // the receiver of a member read (judged at the member) or a type's
      // qualifier.
      const mod = moduleOf(s);
      if (mod === null || !byFile.has(mod)) return;
      // `M.N` (a namespace re-exported with `export * as N`) is itself a
      // namespace: fine as the receiver of a further member read.
      const ref: ts.Node = (ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id) ? p : id;
      const up = ref.parent;
      if (up !== undefined && ts.isPropertyAccessExpression(up) && up.expression === ref) return;
      if (up !== undefined && ts.isQualifiedName(up) && up.left === ref) return;
      escapeModule(mod, ref);
    };
    visit(sf);
  }
  return out;
}

/** `callee` (an identifier, or `M.f`) is the callee of a direct call whose
 * result is awaited in place. */
function awaitedCallee(callee0: ts.Node): boolean {
  let callee: ts.Node = callee0;
  while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
  const call = callee.parent;
  if (call === undefined || !ts.isCallExpression(call) || call.expression !== callee) return false;
  let up: ts.Node = call.parent;
  while (up !== undefined && ts.isParenthesizedExpression(up)) up = up.parent;
  return up !== undefined && ts.isAwaitExpression(up);
}
