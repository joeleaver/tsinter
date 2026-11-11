/* R2 (SEMANTICS.md S129): which types and symbols a STUB builtin declares.
 * Checker-level only (no Lowerer), so the type mapper and the lowering
 * share it. */

import * as ts from "./ts7/adapter.js";
import { isNodeTypesPath, stubBuiltinModuleOf } from "./shared.js";

/** The stub module whose own `declare module "<name>"` block in the
 * adopted @types/node declares `sym` (HeapInfo in "v8", DatabaseSync in
 * "sqlite", the readline/promises Interface, the "v8" module symbol
 * itself), or null. Declarations under a `global` augmentation inside the
 * module block (the process global is declared inside `declare module
 * "process"`) are global surface, never a stub's. */
export function stubDeclaredModuleOfSym(checker: ts.TypeChecker, sym: ts.Symbol | null | undefined): string | null {
  if (!sym) return null;
  for (const d of checker.declarationsOf(sym)) {
    const sf = d.getSourceFile();
    if (!sf.isDeclarationFile || !isNodeTypesPath(sf.fileName)) continue;
    let mod: string | null = null;
    for (let n: ts.Node | undefined = d; n !== undefined && !ts.isSourceFile(n); n = n.parent) {
      if (!ts.isModuleDeclaration(n)) continue;
      if (ts.isIdentifier(n.name) && n.name.text === "global") {
        mod = null;
        break;
      }
      if (ts.isStringLiteral(n.name)) mod = n.name.text;
    }
    if (mod !== null && stubBuiltinModuleOf(mod) !== null) return mod;
  }
  return null;
}

/** The stub module a TYPE belongs to: its alias or own symbol is one a stub
 * declares (an interface, a class instance, the module namespace, a
 * function declared there). */
export function stubDeclaredModuleOfType(checker: ts.TypeChecker, t: ts.Type): string | null {
  return stubDeclaredModuleOfSym(checker, t.getAliasSymbol() ?? t.getSymbol());
}
