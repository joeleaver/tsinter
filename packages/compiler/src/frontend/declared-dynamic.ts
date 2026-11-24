/* SEMANTICS.md S133 (k)/(l): the declared package types whose values are
 * the implementation's own dynamic values on the one-world lanes. A viewed
 * package's shipped declarations describe a value its JavaScript builds
 * (zod's schemas, postgres.js's callable client, drizzle's columns); the
 * program holds that value itself, never a copy: member reads and calls
 * dispatch dynamically, and results cross into the declared member types
 * at the use. The type mapper (types.ts) answers these types JSVAL, and the
 * call lowering (lower-calls.ts) routes their member calls through the
 * implementation's own members by the same predicates. */
import { isDtsMirrorPath } from "./npm-static.js";
import * as ts from "./ts7/adapter.js";
import type { TypeMapperCtx } from "./types.js";

/** SEMANTICS.md S133 (k), "a declared interface over a dynamic
 * implementation": on the one-world lanes, an interface (or object type
 * alias) a viewed package's shipped declarations declare, with a member
 * that is a function (a method, or a function-typed property), is the
 * implementation's own dynamic value — zod's ZodString, ZodObject<Shape>,
 * whose instances are built per-instance by `$constructor` and carry
 * overloaded and generic methods no record shape holds. Identity is kept
 * and nothing is copied: member reads and calls dispatch dynamically, and
 * their results cross into the declared member types at the use. Data-only
 * interfaces keep their record mapping (a checked conversion), declared
 * classes their S115 views, and the program's own types are untouched.
 *
 * The interface may be CALLABLE (S133 (k)'s callable amendment): postgres's
 * `Sql<T>` is a JS function carrying properties, with a generic call
 * signature (it is also a template tag) beside generic and plain methods.
 * Its calls and tagged templates call the dynamic value. A call-only
 * interface (no function member) is not this case: it keeps its function
 * mapping. */
export function declaredInterfaceOverDynamic(widened: ts.Type, ctx: TypeMapperCtx): boolean {
  if (ctx.sharedDynamic !== true) return false;
  const sym = widened.getSymbol() ?? widened.getAliasSymbol();
  if (sym === undefined) return false;
  const checker = ctx.checker;
  // The RAW declarations: the declared-surface redirect would answer a merged
  // `const` export's JS implementation for the symbol (dts-bridge.ts).
  const decls = checker.rawDeclarationsOf(sym);
  if (decls.length === 0) return false;
  // Every declaration comes from the view's mirror, and the TYPE side is an
  // interface or object type (zod merges `interface ZodString` with a
  // `const ZodString` value of the same name; a class is never this case).
  if (!decls.every((d) => isDtsMirrorPath(d.getSourceFile().fileName))) return false;
  if (decls.some((d) => ts.isClassDeclaration(d))) return false;
  if (!decls.some((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isTypeLiteralNode(d))) return false;
  return checker.getPropertiesOfType(widened).some((p) => {
    const pd = checker.declarationsOf(p)[0];
    if (pd !== undefined && (pd.kind === ts.SyntaxKind.MethodSignature || ts.isMethodDeclaration(pd))) return true;
    return checker.getCallSignatures(checker.getNonNullableType(checker.getTypeOfSymbol(p))).length > 0;
  });
}

/** Does a declared class extend `Error` (or a subclass of it), through
 * its heritage clauses? */
function declaredErrorClass(sym: ts.Symbol, checker: ts.TypeChecker, seen: Set<ts.Symbol>): boolean {
  if (seen.has(sym)) return false;
  seen.add(sym);
  for (const d of checker.rawDeclarationsOf(sym)) {
    if (!ts.isClassDeclaration(d)) continue;
    const ext = d.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    if (ext === undefined) continue;
    const e = ext.expression;
    if (ts.isIdentifier(e) && /^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError)$/.test(e.text)) return true;
    let base: ts.Symbol | undefined;
    try {
      base = checker.getSymbolAtLocation(e);
      if (base !== undefined && (base.flags & ts.SymbolFlags.Alias) !== 0) base = checker.getAliasedSymbol(base);
    } catch {
      base = undefined;
    }
    if (base !== undefined && declaredErrorClass(base, checker, seen)) return true;
  }
  return false;
}

/** S133 (k) or (l): a declared type whose values are the implementation's
 * own dynamic values, or a Pick/Omit of such types. */
export function declaredOverDynamic(widened: ts.Type, ctx: TypeMapperCtx): boolean {
  return declaredInterfaceOverDynamic(widened, ctx) || declaredClassOverDynamic(widened, ctx) || declaredPickOverDynamic(widened, ctx);
}

/** S133 (k)'s Pick/Omit amendment: the standard library's `Pick<T, K>` (and
 * `Omit<T, K>`, which is a Pick of the remaining keys), under any alias
 * the program gives it, whose every property is a member declared by a
 * (k) or (l) type, is the dynamic value. paperclip's `SqlExecutor =
 * Pick<ReturnType<typeof postgres>, "unsafe">`: the value a parameter of
 * that type receives is the client itself in JavaScript, so it stays that
 * value (identity kept, no copy), and its members dispatch dynamically
 * as the client's do. A Pick of the program's own types, or one mixing
 * in a member some other type declares, keeps its record mapping. */
export function declaredPickOverDynamic(widened: ts.Type, ctx: TypeMapperCtx): boolean {
  if (ctx.sharedDynamic !== true) return false;
  const sym = widened.getSymbol();
  if (sym === undefined) return false;
  const checker = ctx.checker;
  const mapped = checker.rawDeclarationsOf(sym)[0];
  if (mapped === undefined || !ts.isMappedTypeNode(mapped)) return false;
  const alias = mapped.parent;
  if (!ts.isTypeAliasDeclaration(alias) || alias.name.text !== "Pick" || !ctx.isStdlibFile(alias.getSourceFile())) return false;
  const props = checker.getPropertiesOfType(widened);
  if (props.length === 0) return false;
  const answered = new Map<ts.Symbol, boolean>();
  return props.every((p) => {
    const decls = checker.rawDeclarationsOf(p);
    return decls.length > 0 && decls.every((d) => {
      const owner = declaringTypeSymbol(d, checker);
      if (owner === undefined) return false;
      let ok = answered.get(owner);
      if (ok === undefined) {
        const t = checker.getDeclaredTypeOfSymbol(owner);
        ok = declaredInterfaceOverDynamic(t, ctx) || declaredClassOverDynamic(t, ctx);
        answered.set(owner, ok);
      }
      return ok;
    });
  });
}

/** The interface, class or object type alias whose body declares this
 * member declaration. */
function declaringTypeSymbol(member: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const parent = member.parent;
  if (parent === undefined) return undefined;
  let named: ts.Node | undefined;
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) named = parent.name;
  else if (ts.isTypeLiteralNode(parent) && parent.parent !== undefined && ts.isTypeAliasDeclaration(parent.parent)) named = parent.parent.name;
  return named === undefined ? undefined : checker.getSymbolAtLocation(named);
}

/** SEMANTICS.md S133 (l), "a declared class the program only types
 * against": on the one-world lanes, a class (its instance type) that only a
 * viewed package's shipped declarations declare, which the program's own
 * sources never construct, extend or implement, is the implementation's own
 * dynamic value, as (k) makes a declared interface. drizzle's `PgColumn`:
 * pgTable(...) builds its columns in drizzle's JavaScript (builders and
 * Object.assign), and the program only ever holds them. Identity is kept,
 * members dispatch dynamically, and results cross into the declared member
 * types at the use. A class the program constructs, extends or implements
 * keeps its S115 view. */
export function declaredClassOverDynamic(widened: ts.Type, ctx: TypeMapperCtx): boolean {
  if (ctx.sharedDynamic !== true || ctx.programBuiltClassDecl === undefined) return false;
  const sym = widened.getSymbol();
  if (sym === undefined || (sym.flags & ts.SymbolFlags.Class) === 0) return false;
  const checker = ctx.checker;
  // The instance type only: the class value (`typeof PgColumn`) keeps its
  // own paths.
  if (checker.getConstructSignatures(widened).length > 0) return false;
  const decls = checker.rawDeclarationsOf(sym);
  if (decls.length === 0) return false;
  if (!decls.every((d) => isDtsMirrorPath(d.getSourceFile().fileName))) return false;
  if (!decls.some((d) => ts.isClassDeclaration(d))) return false;
  // A declared ERROR class (`class DeclError extends Error`) keeps its
  // existing mapping: thrown by the package, caught and narrowed by
  // `instanceof` in the program.
  if (declaredErrorClass(sym, checker, new Set())) return false;
  return !decls.some((d) => ctx.programBuiltClassDecl!(d));
}
