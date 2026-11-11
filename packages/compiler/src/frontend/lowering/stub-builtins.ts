/* R2 (SEMANTICS.md S129): the bindings of a Node builtin this build does
 * not serve are STUBS. Preflight lets the import through (no module edge
 * — stubBuiltinModuleOf names the family); here, every expression whose
 * value would come from a stub binding — the binding itself, a member
 * read or call through it, the same through a program module's
 * re-export — poisons with the module's SC1010 diagnostic, MARKED as a
 * stub touch. lowerStmts (and the concise-arrow lowering) turn a
 * statement whose only diagnostics are stub touches into a runtimeFence
 * in TypeScript as in JavaScript: the program runs as Node does until the
 * first statement that touches a stub, and stops there by name (S122). */

import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError, boundIdentifiersOf } from "./lowerer.js";
import { locOf, requireSpecOf } from "../program.js";
import { stubBuiltinModuleOf, unsupportedModuleFeatureOf } from "../shared.js";
import { stubDeclaredModuleOfSym } from "../stub-types.js";
import { STUB_BUILTIN_EXPORTS } from "../stub-builtin-exports.js";
import { unsupportedDiag, type ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import type { IrExpr, IrType } from "../../ir/nodes.js";

export interface StubIndex {
  /** Every local or exported name that can denote a stub binding — a
   * text pre-filter, so the symbol queries run only on candidate names. */
  names: Set<string>;
  /** The aliased (declaration-side) symbol of every stub import and
   * re-export specifier → the module specifier as written: an alias
   * chain through program modules (re-exports, renamed imports, a
   * namespace import of a re-exporting module) resolves to one of these. */
  targets: Map<ts.Symbol, string>;
}

/** `import process from "node:process"` and `const process =
 * require("node:process")` are the global process object, lowered as
 * `process` (surfaces.ts's stdlib alias) — never stubs. */
function isProcessModuleObject(spec: string): boolean {
  return spec === "process" || spec === "node:process";
}

function stubIndexOf(L: Lowerer): StubIndex {
  if (L.stubIndex !== null) return L.stubIndex;
  const names = new Set<string>();
  const targets = new Map<ts.Symbol, string>();
  const addTarget = (nameNode: ts.Identifier, spec: string): void => {
    names.add(nameNode.text);
    const sym = L.checker.getSymbolAtLocation(nameNode);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      const target = L.checker.getAliasedSymbol(sym);
      if (target) targets.set(target, spec);
    }
  };
  const files = L.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !sf.fileName.endsWith(".json"));
  for (const sf of files) {
    // Fast exit: a file that never spells a stub specifier binds none.
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        if (stubBuiltinModuleOf(spec) === null) continue;
        const clause = stmt.importClause;
        if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
        if (clause.name && !isProcessModuleObject(spec)) addTarget(clause.name, spec);
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) addTarget(nb.name, spec);
        else if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) if (!el.isTypeOnly) addTarget(el.name, spec);
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        !stmt.isTypeOnly &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stubBuiltinModuleOf(stmt.moduleSpecifier.text) !== null &&
        stmt.exportClause !== undefined &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) if (!el.isTypeOnly && ts.isIdentifier(el.name)) addTarget(el.name, stmt.moduleSpecifier.text);
      }
    }
    // The CommonJS twins, at any depth: `const v8 = require("v8")` and
    // `const { serialize } = require("v8")` (their uses resolve through
    // the declaration's initializer — stubModuleOfIdent).
    if (!sf.text.includes("require")) continue;
    ts.walkPreorder(sf, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer !== undefined) {
        const spec = requireSpecOf(n.initializer);
        if (spec !== null && stubBuiltinModuleOf(spec) !== null) {
          if (ts.isIdentifier(n.name) && isProcessModuleObject(spec)) return undefined;
          for (const id of boundIdentifiersOf(n.name)) names.add(id.text);
        }
      }
      return undefined;
    });
  }
  // Names reaching other modules through program-level imports and
  // re-exports (renamed or not): grown to a fixed point over the import
  // and export specifiers whose source-side name is already a candidate.
  if (names.size > 0) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const sf of files) {
        for (const stmt of sf.statements) {
          let els: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[] = [];
          if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
            els = stmt.importClause.namedBindings.elements;
          } else if (ts.isExportDeclaration(stmt) && stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
            els = stmt.exportClause.elements;
          }
          // A program module's DEFAULT export can be a stub (`export
          // default v8`): every default-import binding is a candidate name
          // (the symbol check decides).
          if (ts.isImportDeclaration(stmt) && stmt.importClause?.name && !names.has(stmt.importClause.name.text)) {
            names.add(stmt.importClause.name.text);
            grew = true;
          }
          for (const el of els) {
            const from = (el.propertyName ?? el.name).text;
            if (names.has(from) && !names.has(el.name.text)) {
              names.add(el.name.text);
              grew = true;
            }
          }
        }
      }
    }
  }
  L.stubIndex = { names, targets };
  return L.stubIndex;
}

/** The stub module `ident` denotes, as the import or require wrote it, or
 * null: a direct import/require binding of a stub builtin, or an alias
 * (re-export chain) whose target is one. */
function stubModuleOfIdent(L: Lowerer, ident: ts.Identifier, idx: StubIndex): string | null {
  // A shorthand property `{ v8 }`: the name's own symbol is the PROPERTY;
  // the value read is the binding's.
  const sym = ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident
    ? L.checker.getShorthandAssignmentValueSymbol(ident.parent)
    : L.checker.getSymbolAtLocation(ident);
  if (!sym) return null;
  const decl = L.checker.declarationsOf(sym)[0];
  if (decl !== undefined) {
    const varDecl = ts.isBindingElement(decl) ? enclosingVarDecl(decl) : decl;
    if (varDecl !== null && ts.isVariableDeclaration(varDecl) && varDecl.initializer !== undefined) {
      const spec = requireSpecOf(varDecl.initializer);
      if (spec !== null) {
        if (stubBuiltinModuleOf(spec) === null) return null;
        return ts.isIdentifier(varDecl.name) && isProcessModuleObject(spec) ? null : spec;
      }
    }
  }
  if (!(sym.flags & ts.SymbolFlags.Alias)) return null;
  // Direct ESM forms answer through their target too (addTarget recorded
  // the same aliased symbol for every stub specifier).
  return idx.targets.get(L.checker.getAliasedSymbol(sym)) ?? null;
}

function enclosingVarDecl(el: ts.BindingElement): ts.VariableDeclaration | null {
  let n: ts.Node = el;
  while (ts.isBindingElement(n) || ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n = n.parent;
  return ts.isVariableDeclaration(n) ? n : null;
}

/** Poisons with the stub's SC1010 diagnostic (marked as a stub touch) when
 * `expr` evaluates a stub binding first: the binding itself, or a member
 * read, element read, call, `new` or tagged template whose receiver /
 * callee chain is rooted at one, or a member read that names a stub
 * through a namespace import of a re-exporting module. */
export function stubTouchCheck(L: Lowerer, expr: ts.Expression): void {
  const idx = stubIndexOf(L);
  if (idx.names.size === 0) return;
  let e: ts.Expression = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isAssertionExpression(e) ||
      ts.isElementAccessExpression(e) ||
      ts.isCallExpression(e) ||
      ts.isNewExpression(e)
    ) {
      e = e.expression;
    } else if (ts.isTaggedTemplateExpression(e)) {
      e = e.tag;
    } else if (ts.isPropertyAccessExpression(e)) {
      if (ts.isIdentifier(e.name) && idx.names.has(e.name.text)) {
        const sym = L.checker.getSymbolAtLocation(e.name);
        if (sym && sym.flags & ts.SymbolFlags.Alias) {
          const spec = idx.targets.get(L.checker.getAliasedSymbol(sym));
          if (spec !== undefined) stubTouch(L, e.name, spec);
        }
      }
      e = e.expression;
    } else {
      break;
    }
  }
  if (ts.isIdentifier(e) && idx.names.has(e.text)) {
    const spec = stubModuleOfIdent(L, e, idx);
    if (spec !== null) stubTouch(L, e, spec);
  }
}

function stubKey(d: ScrDiagnostic): string {
  return `${d.code}|${d.loc.file}|${d.loc.start}|${d.loc.end}`;
}

/** Records and throws the stub touch at `node`. */
export function stubTouch(L: Lowerer, node: ts.Node, spec: string): never {
  const d = unsupportedDiag("SC1010", locOf(node), unsupportedModuleFeatureOf(spec));
  L.stubFenceKeys.add(stubKey(d));
  L.pushDiag(d);
  throw new PoisonError();
}

/** Marks a diagnostic as a stub touch's consequence (the SC2004 cascade
 * from a binding whose declaration became a stub fence). */
export function markStubDiag(L: Lowerer, d: ScrDiagnostic): ScrDiagnostic {
  L.stubFenceKeys.add(stubKey(d));
  return d;
}

/** True when every diagnostic in `diags` (non-empty) is a stub touch or
 * its cascade: the statement they poisoned defers to a run-time fence in
 * TypeScript too. */
export function onlyStubTouches(L: Lowerer, diags: readonly ScrDiagnostic[]): boolean {
  return diags.length > 0 && L.stubFenceKeys.size > 0 && diags.every((d) => L.stubFenceKeys.has(stubKey(d)));
}

/** The symbols a statement that became a stub fence would have bound
 * (noteBlockedBindings's set): their later uses are SC2004 cascades the
 * fence also covers. */
export function declaredSymbolsOf(L: Lowerer, stmt: ts.Statement): ts.Symbol[] {
  let list: ts.VariableDeclarationList | null = null;
  if (ts.isVariableStatement(stmt)) list = stmt.declarationList;
  else if (
    (ts.isForStatement(stmt) || ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) &&
    stmt.initializer !== undefined &&
    ts.isVariableDeclarationList(stmt.initializer)
  ) {
    list = stmt.initializer;
  }
  const out: ts.Symbol[] = [];
  for (const decl of list?.declarations ?? []) {
    for (const id of boundIdentifiersOf(decl.name)) {
      const sym = L.checker.getSymbolAtLocation(id);
      if (sym) out.push(sym);
    }
  }
  return out;
}

/** The stub module whose own `declare module "<name>"` block in the
 * adopted @types/node declares `sym` (HeapInfo in "v8", DatabaseSync in
 * "sqlite", the readline/promises Interface), or null. Declarations under
 * a `global` augmentation inside the module block (the process global is
 * declared inside `declare module "process"`) are global surface, never a
 * stub's. A value of such a type, or a member of one, only ever comes out
 * of a stub touch, so its own refusal (badType, the SC2020 member fence)
 * defers with the touch that produced the value. */
export function stubDeclaredModuleOf(L: Lowerer, sym: ts.Symbol | null | undefined): string | null {
  return stubDeclaredModuleOfSym(L.checker, sym);
}

/** `d` (badType's or noLowering's refusal) MARKED as deferring with the
 * stub touches, when its subject belongs to a stub module
 * (stubDeclaredModuleOf on the member, then on the receiver's type); null
 * otherwise. Such a value only exists after a touch (which ends the
 * program first) or as the program's own object of that type, where the
 * refusal stops the run at the use under its own text. */
export function stubDiagFor(L: Lowerer, sym: ts.Symbol | null | undefined, node: ts.Node, d: ScrDiagnostic): ScrDiagnostic | null {
  let mod = stubDeclaredModuleOf(L, sym);
  if (mod === null) {
    let n: ts.Node = node;
    if (ts.isCallExpression(n)) n = n.expression;
    if (ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
    if (ts.isPropertyAccessExpression(n)) {
      const t = L.typeOf(n.expression);
      mod = stubDeclaredModuleOf(L, t.getAliasSymbol() ?? t.getSymbol());
    }
  }
  // The refusal keeps its own text: the value may be the program's own
  // (an object typed HeapInfo), not anything the module produced.
  return mod === null ? null : markStubDiag(L, d);
}

/** The EXPRESSION-level stub fence: when `expr`'s own stub touch (and
 * nothing else) poisoned it and its type maps, `expr` lowers to a call of
 * a lifted function whose body is the runtimeFence — the enclosing
 * statement runs up to the touch (a cold `?:` arm, `&&` operand or
 * argument never evaluated keeps the program going exactly as Node does)
 * and stops there. Null when the statement-level deferral must take it
 * (an unmappable type, a capture in force, other diagnostics). */
export function stubExprFence(L: Lowerer, expr: ts.Expression, err: unknown, diagsBefore: number): IrExpr | null {
  if (!(err instanceof PoisonError) || L.diagSink !== null) return null;
  const captured = L.diags.slice(diagsBefore);
  if (!onlyStubTouches(L, captured)) return null;
  const mapBefore = L.diags.length;
  let t: IrType | null;
  try {
    t = L.mapTypeOf(L.typeOf(expr));
  } catch (e) {
    if (!(e instanceof PoisonError)) throw e;
    t = null;
  }
  L.diags.splice(mapBefore);
  if (t === null) return null;
  L.diags.splice(diagsBefore);
  L.runtimeFences.push(...captured);
  const first = captured[0]!;
  const sf = L.program.getSourceFile(first.loc.file) ?? expr.getSourceFile();
  const line = ts.getLineAndCharacterOfPosition(sf, first.loc.start).line + 1;
  const loc = locOf(expr);
  const name = `%fn${L.lambdaCounter++}_stubfence`;
  L.liftedFns.push({
    name,
    params: [],
    returnType: t,
    locals: [],
    captures: [],
    body: [{ kind: "runtimeFence", code: first.code, message: `${first.message} [${first.code} at ${first.loc.file}:${line}]`, loc }],
    loc,
  });
  return { kind: "call", callee: name, args: [], type: t, loc };
}

/** The stub module an identifier READ denotes (the binding, a shorthand
 * property's value, an alias chain through program modules), or null —
 * for lowering paths that reach an identifier without lowerExpr's check. */
export function stubModuleOf(L: Lowerer, ident: ts.Identifier): string | null {
  const idx = stubIndexOf(L);
  return idx.names.has(ident.text) ? stubModuleOfIdent(L, ident, idx) : null;
}

/** The module a stub binding's OBJECT stands for — a namespace import, a
 * default import, or `const vm = require("vm")` — as its bare name, or
 * null (a named binding, an alias chain, anything else). */
function stubModuleObjectOf(L: Lowerer, ident: ts.Identifier): string | null {
  const sym = L.checker.getSymbolAtLocation(ident);
  const decl = sym ? L.checker.declarationsOf(sym)[0] : undefined;
  if (decl === undefined) return null;
  let spec: string | null = null;
  if (ts.isNamespaceImport(decl) || ts.isImportClause(decl)) {
    let n: ts.Node = decl;
    while (!ts.isImportDeclaration(n) && !ts.isSourceFile(n)) n = n.parent;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
  } else if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer !== undefined) spec = requireSpecOf(decl.initializer);
  if (spec === null || stubModuleOfIdent(L, ident, stubIndexOf(L)) === null) return null;
  return stubBuiltinModuleOf(spec);
}

/** True when `expr` reads an export the stub module does not have in Node
 * (STUB_BUILTIN_EXPORTS): `const { SourceTextModule } = require("vm")`'s
 * binding, or `vm.SourceTextModule` off the module object — `undefined`
 * in Node (the feature-detection pattern), whatever @types/node declares. */
export function stubMissingExport(L: Lowerer, expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const idx = stubIndexOf(L);
  if (idx.names.size === 0) return false;
  const missing = (mod: string | null, name: string): boolean => {
    if (mod === null || !Object.hasOwn(STUB_BUILTIN_EXPORTS, mod)) return false;
    return !STUB_BUILTIN_EXPORTS[mod]!.includes(name);
  };
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && ts.isIdentifier(e.name) && idx.names.has(e.expression.text)) {
    return missing(stubModuleObjectOf(L, e.expression), e.name.text);
  }
  if (ts.isIdentifier(e) && idx.names.has(e.text)) {
    const sym = L.checker.getSymbolAtLocation(e);
    const decl = sym ? L.checker.declarationsOf(sym)[0] : undefined;
    if (decl === undefined || !ts.isBindingElement(decl) || !ts.isObjectBindingPattern(decl.parent)) return false;
    const v = enclosingVarDecl(decl);
    const spec = v?.initializer !== undefined ? requireSpecOf(v.initializer) : null;
    if (spec === null || decl.parent.parent !== v) return false;
    const key: ts.Node | undefined = decl.propertyName ?? decl.name;
    return key !== undefined && ts.isIdentifier(key) && missing(stubBuiltinModuleOf(spec), key.text);
  }
  return false;
}
