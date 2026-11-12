/* SEMANTICS.md S133: the crossings between a program and an npm package it
 * types against the package's SHIPPED declarations while the package's JS
 * compiles (npm-static.ts "the declared-surface view", dts-bridge.ts).
 *
 * The checker types the program's side by the declarations; the lowering
 * compiles the implementation (the checker facade maps each declaration
 * to the JS that implements it). A value the implementation produces
 * therefore carries the IMPLEMENTATION's type (what inference made of the
 * JS), and where it enters the program — a call's result, a property
 * read — it crosses into the DECLARED type:
 *
 *   - equal types: nothing to do, the typed storage is the proof;
 *   - a dynamic value (inference left it `any`/`unknown`): it stays the
 *     dynamic value, exactly as U2 (S128) holds any dynamic value in a
 *     contained typed slot — every use asks it at run time and only a
 *     leaf that must enter typed storage checks its kind;
 *   - a union the declaration narrows (commander's `name(): string |
 *     Command` getter/setter against its `name(str): this` overload): the
 *     declared arm is extracted with a check, and any other arm ends the
 *     program by name (S122's fence) — the declaration's claim was false
 *     for this value, which Node would have let flow;
 *   - anything else: the ordinary coercion, which converts or refuses by
 *     name at compile time.
 *
 * Arguments cross the other way — the program's declared-type values into
 * the implementation's parameters — through the same coercions every call
 * applies (completeArgs), so a program callback whose parameters the
 * declarations type meets the implementation's function type through the
 * function adapters. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isDtsMirrorPath, npmStaticDtsViews } from "../npm-static.js";
import { npmPackageNameOf } from "../shared.js";
import { isUnitType, typeEquals, type IrExpr, type IrType } from "../../ir/nodes.js";

/** Is the declared-surface view active in this compile at all? */
export function dtsViewsActive(): boolean {
  return npmStaticDtsViews().size > 0;
}

function declaredIn(node: ts.Node | undefined): boolean {
  return node !== undefined && isDtsMirrorPath(node.getSourceFile().fileName);
}

function packageOf(node: ts.Node): string {
  return npmPackageNameOf(node.getSourceFile().fileName) ?? "the package";
}

/** The resolved signature's declaration when it is a mirrored one. */
function declaredSignatureDecl(L: Lowerer, expr: ts.CallExpression | ts.NewExpression): ts.Node | undefined {
  const rsig = L.checker.getResolvedSignature(expr);
  const rdecl = rsig ? L.checker.signatureDeclaration(rsig) : undefined;
  return declaredIn(rdecl) ? rdecl : undefined;
}

/** The program-facing spelling of a crossing site, for the fence text. */
function siteText(expr: ts.Expression): string {
  const callee = ts.isCallExpression(expr) || ts.isNewExpression(expr) ? expr.expression : expr;
  let text = callee.getText().replace(/\s+/g, " ");
  if (text.length > 60) {
    text = ts.isPropertyAccessExpression(callee) ? `….${callee.name.text}` : `${text.slice(0, 57)}…`;
  }
  if (ts.isNewExpression(expr)) return `'new ${text}(…)'`;
  return ts.isCallExpression(expr) ? `'${text}(…)'` : `'${text}'`;
}

/** Cross an implementation-typed value into its declared type. */
function crossInto(L: Lowerer, node: ts.Expression, out: IrExpr, declared: IrType | null, pkg: string, what: string): IrExpr {
  if (declared === null || declared.kind === "void" || isUnitType(declared) || typeEquals(declared, out.type)) return out;
  if (out.type.kind === "jsval" || out.type.kind === "dyn") return out;
  // A promise of a dynamic value (an async method inference types
  // `Promise<any>`): it stays that promise — its settled value is the
  // dynamic value, which crosses where the program uses it.
  if (out.type.kind === "promise" && declared.kind === "promise" && (out.type.inner.kind === "jsval" || out.type.inner.kind === "dyn")) return out;
  const mismatch = (got: string): string =>
    `${pkg}'s declarations type ${what} as '${L.fmt(declared)}', but its implementation produced ${got} (SEMANTICS.md S133) [SC1090 at a declared npm crossing]`;
  if (out.type.kind === "union" && declared.kind !== "union") {
    const helper = L.narrowedArmHelper(out.type.unionId, declared, out.loc, mismatch);
    if (helper) return { kind: "call", callee: helper, args: [out], type: declared, loc: out.loc };
  }
  // A union the declarations narrow to a SMALLER union (`name(): string`
  // seen through an optional chain is `string | undefined` against the
  // implementation's `string | Command`): when the declared union has one
  // non-unit arm the implementation's union carries, that arm is taken
  // with the check (the unit arms of the declared type are the chain's).
  if (out.type.kind === "union" && declared.kind === "union") {
    const darms = L.unions.get(declared.unionId)?.arms ?? [];
    const data = darms.filter((a) => !isUnitType(a));
    if (data.length === 1 && L.armTag(out.type.unionId, data[0]!) >= 0) {
      const helper = L.narrowedArmHelper(out.type.unionId, data[0]!, out.loc, mismatch);
      if (helper) return L.coerceInto(node, { kind: "call", callee: helper, args: [out], type: data[0]!, loc: out.loc }, declared);
    }
  }
  return L.coerceInto(node, out, declared);
}

/** A call (or `new`) the checker resolved against a mirrored declaration:
 * its result crosses into the declared return type. */
export function dtsCallResult(L: Lowerer, expr: ts.CallExpression | ts.NewExpression, out: IrExpr): IrExpr {
  if (!dtsViewsActive()) return out;
  const decl = declaredSignatureDecl(L, expr);
  if (decl === undefined) return out;
  const rsig = L.checker.getResolvedSignature(expr)!;
  const declaredT = L.checker.getReturnTypeOfSignature(rsig);
  // `never` (commander's `error()`): the call does not return normally —
  // nothing crosses.
  if ((declaredT.flags & ts.TypeFlags.Never) !== 0) return out;
  const declared = L.mapTypeOf(declaredT);
  return crossInto(L, expr, out, declared, packageOf(decl), `the result of ${siteText(expr)}`);
}

/** A property read whose member the declarations declare: the value
 * crosses into the declared type of the read. */
export function dtsPropertyRead(L: Lowerer, expr: ts.PropertyAccessExpression, out: IrExpr): IrExpr {
  if (!dtsViewsActive()) return out;
  const sym = L.checker.getSymbolAtLocation(expr.name);
  if (sym === undefined) return out;
  const decl = L.checker.rawDeclarationsOf(sym)[0];
  if (!declaredIn(decl)) return out;
  // Methods read as values keep the implementation's function type (a
  // later call through them crosses at its own site).
  if (decl !== undefined && (ts.isMethodDeclaration(decl) || decl.kind === ts.SyntaxKind.MethodSignature)) return out;
  const declared = L.mapTypeOf(L.typeOf(expr));
  return crossInto(L, expr, out, declared, packageOf(decl!), siteText(expr));
}
