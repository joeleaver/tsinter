/* Library mode's export resolution input: what the ENTRY source file exports
 * as function declarations. Resolution runs on the frontend's program
 * object after preflight (design §5.3) — the export map may only name
 * exports of the profile's one entry module, and today's compilable export
 * surface for functions is exactly `export function f(...)` declarations
 * (export lists and re-exports are SC1014-fenced, so nothing else can
 * reach a compiled program). The per-declaration facts collected here are
 * what the SC4002/SC4004/SC4007 refusals key on; the marshalling check
 * (SC4003) runs later against the lowered IrFunction's types. */
import * as ts from "./ts7/adapter.js";
import type { SrcLoc } from "../ir/nodes.js";

export interface EntryExportInfo {
  name: string;
  loc: SrcLoc;
  /** Declared type parameters — SC4007 (a profile entry needs one concrete
   * compiled signature). */
  generic: boolean;
  /** `async function` — SC4004. */
  async: boolean;
  /** `function*` — SC4004. */
  generator: boolean;
}

/** Every `export function f(...)` of the entry file, by exported name.
 * Overload signatures collapse onto one entry (same name, one body). */
export function entryFunctionExports(entry: ts.SourceFile): Map<string, EntryExportInfo> {
  const out = new Map<string, EntryExportInfo>();
  for (const stmt of entry.statements) {
    if (!ts.isFunctionDeclaration(stmt) || stmt.name === undefined) continue;
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    const name = stmt.name.text;
    if (out.has(name) && stmt.body === undefined) continue; // overload signature
    out.set(name, {
      name,
      loc: { file: entry.fileName, start: stmt.getStart(), end: stmt.end },
      generic: (stmt.typeParameters?.length ?? 0) > 0,
      async: mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true,
      generator: stmt.asteriskToken !== undefined,
    });
  }
  return out;
}

/** Library mode on the WasmGC lane (docs/design/wasm-library-mode.md, the
 * lead's rulings of 2026-11-12): an exported function whose body is ONE
 * `return <expr>` where <expr> is a literal (a number, a negated number, a
 * string, true/false) or an identifier bound to a module-level `const`
 * initialized by such a literal (followed through imports) is a CONSTANT
 * export. It answers its value without running module evaluation, so a host
 * may ask a fresh instance (pw_abi_version before a restore). Syntax only:
 * a type assertion, a call or a computed value is an ordinary export. */
export function entryConstantExports(entry: ts.SourceFile, checker: ts.TypeChecker): Map<string, number | string | boolean> {
  const out = new Map<string, number | string | boolean>();
  for (const stmt of entry.statements) {
    if (!ts.isFunctionDeclaration(stmt) || stmt.name === undefined || stmt.body === undefined) continue;
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) !== true) continue;
    if (mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || stmt.asteriskToken !== undefined || stmt.parameters.length > 0) continue;
    const body = stmt.body.statements;
    if (body.length !== 1) continue;
    const ret = body[0]!;
    if (!ts.isReturnStatement(ret) || ret.expression === undefined) continue;
    const v = constantValueOf(ret.expression, checker);
    if (v !== null) out.set(stmt.name.text, v);
  }
  return out;
}

/** A literal's value, or (one hop) a module `const`'s literal initializer. */
function constantValueOf(e: ts.Expression, checker: ts.TypeChecker): number | string | boolean | null {
  const lit = literalValueOf(e);
  if (lit !== null || !ts.isIdentifier(e)) return lit;
  let sym = checker.getSymbolAtLocation(e);
  if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) sym = checker.getAliasedSymbol(sym);
  const decl = sym !== undefined ? checker.declarationsOf(sym)[0] : undefined;
  if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return null;
  const list = decl.parent;
  if (list === undefined || !ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  const vs = list.parent;
  if (vs === undefined || !ts.isVariableStatement(vs) || vs.parent === undefined || !ts.isSourceFile(vs.parent)) return null;
  if (!ts.isIdentifier(decl.name)) return null;
  return literalValueOf(decl.initializer);
}

function literalValueOf(e: ts.Expression): number | string | boolean | null {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
  return null;
}
