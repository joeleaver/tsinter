/* Library mode on the WasmGC lane: a call of a host-module function
 * (`import * as pw from "pw"; pw.get_f32(e, c, f)`, or a named import of
 * one) lowers to a `hostCall` IR node — a wasm import call
 * (docs/design/wasm-library-mode.md §2.3). The classes come from the
 * profile, or (without one) from the TypeScript declaration: number is f64,
 * bigint s64, boolean bool, string string, the typed arrays their lists. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import { locOf } from "../program.js";
import { typeEquals, VOID, WASMLIB_MEMORY_FNS, wasmLibClassType, type IrExpr, type IrType, type IrWasmLibClass } from "../../ir/nodes.js";
import { wasmLibSignatureDiag, wasmLibUnboundDiag } from "../../diagnostics/diagnostic.js";
import { libHost, MEMORY_MODULE, type HostImport } from "../lib-host.js";

/** The host module and function a callee resolves to, or null. */
function hostTargetOf(L: Lowerer, callee: ts.Expression): { module: string; decl: ts.FunctionDeclaration; name: string } | null {
  const host = libHost();
  if (host === null) return null;
  const ident = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? callee.name : null;
  if (ident === null) return null;
  const sym = L.resolveValueSymbol(ident);
  if (sym === null) return null;
  const decls = L.checker.declarationsOf(sym);
  const decl = decls[0];
  if (decl === undefined || !ts.isFunctionDeclaration(decl) || decl.name === undefined) return null;
  const block = decl.parent;
  if (block === undefined || !ts.isModuleBlock(block)) return null;
  const md = block.parent;
  if (md === undefined || !ts.isModuleDeclaration(md) || !ts.isStringLiteral(md.name)) return null;
  if (md.name.text === MEMORY_MODULE || !host.isHostModule(md.name.text, L.program)) return null;
  return { module: md.name.text, decl, name: decl.name.text };
}

/** The default class of a TypeScript value type (no profile). */
function defaultClassOf(t: IrType): IrWasmLibClass | null {
  switch (t.kind) {
    case "f64":
      return "f64";
    case "bool":
      return "bool";
    case "bigint":
      return "s64";
    case "string":
      return "string";
    case "bytes":
      return t.elem === "u8" ? "list<u8>" : t.elem === "u32" ? "list<u32>" : t.elem === "i32" ? "list<s32>" : "list<f32>";
    default:
      return null;
  }
}

/** Resolve (once per function) a host function's classes against its
 * declaration: the profile's, checked against the TypeScript types, or the
 * defaults. Pushes SC4003/SC4024 and poisons on a misfit. */
function resolveHostImport(L: Lowerer, module: string, name: string, decl: ts.FunctionDeclaration, loc: ReturnType<typeof locOf>): HostImport {
  const host = libHost()!;
  const key = `${module}.${name}`;
  const what = `host import ${key}`;
  const fail = (d: ReturnType<typeof wasmLibSignatureDiag>): never => {
    L.pushDiag(d);
    throw new PoisonError();
  };
  const sym = L.checker.getSymbolAtLocation(decl.name!);
  const sigs = sym !== undefined ? L.checker.getCallSignatures(L.checker.getTypeOfSymbol(sym)) : [];
  if (sigs.length !== 1) fail(wasmLibSignatureDiag(what, `has ${sigs.length} call signatures; a host function has exactly one`, loc));
  if ((decl.typeParameters?.length ?? 0) > 0) fail(wasmLibSignatureDiag(what, "is generic; a host function has one concrete signature", loc));
  const sig = sigs[0]!;
  const tsParams = sig.getParameters().map((p) => L.mapTypeOf(L.checker.getTypeOfSymbol(p)));
  const rt = L.checker.getReturnTypeOfSignature(sig);
  const tsResult = (rt.flags & ts.TypeFlags.Void) !== 0 ? VOID : L.mapTypeOf(rt);
  if (decl.parameters.some((p) => p.questionToken !== undefined || p.dotDotDotToken !== undefined || p.initializer !== undefined)) {
    fail(wasmLibSignatureDiag(what, "has an optional or rest parameter; a host function's parameters are fixed", loc));
  }
  const prof = host.profile;
  if (prof !== null) {
    const entry = prof.imports.get(module)?.get(name);
    if (entry === undefined) fail(wasmLibUnboundDiag(`'${key}'`, `the profile's imports.${module} does not declare '${name}'`, loc));
    if (entry!.params.length !== tsParams.length) {
      fail(wasmLibSignatureDiag(what, `the declaration has ${tsParams.length} parameter(s), the profile ${entry!.params.length}`, loc));
    }
    entry!.params.forEach((p, i) => {
      const want = wasmLibClassType(p.cls as IrWasmLibClass);
      const got = tsParams[i];
      if (want === null) fail(wasmLibSignatureDiag(what, `parameter ${i + 1}'s class ${p.cls} has no value in this tier yet`, loc));
      if (got === null || got === undefined || !typeEquals(got, want!)) {
        fail(wasmLibSignatureDiag(what, `parameter ${i + 1} is '${got ? L.fmt(got) : "?"}', which does not fit class ${p.cls}`, loc));
      }
    });
    const want = entry!.result === null ? VOID : wasmLibClassType(entry!.result as IrWasmLibClass);
    if (want === null || tsResult === null || !typeEquals(tsResult, want)) {
      fail(wasmLibSignatureDiag(what, `the result is '${tsResult ? L.fmt(tsResult) : "?"}', which does not fit ${entry!.result === null ? "no result" : `class ${entry!.result}`}`, loc));
    }
    return host.imports().find((i) => i.module === module && i.name === name)!;
  }
  const known = host.used.get(key);
  if (known !== undefined) return known;
  const params: IrWasmLibClass[] = [];
  tsParams.forEach((t, i) => {
    const cls = t === null ? null : defaultClassOf(t);
    if (cls === null) fail(wasmLibSignatureDiag(what, `parameter ${i + 1} is '${t ? L.fmt(t) : "?"}', which has no class (number, bigint, boolean, string or a typed array)`, loc));
    params.push(cls!);
  });
  let result: IrWasmLibClass | null = null;
  if (tsResult === null || tsResult.kind !== "void") {
    result = tsResult === null ? null : defaultClassOf(tsResult);
    if (result === null) fail(wasmLibSignatureDiag(what, `the result is '${tsResult ? L.fmt(tsResult) : "?"}', which has no class`, loc));
  }
  const imp: HostImport = { module, name, params, result, role: null };
  host.used.set(key, imp);
  return imp;
}

/** `mem.<fn>(...)` where `mem` is tsinter:memory's export. */
function memTargetOf(L: Lowerer, callee: ts.Expression): string | null {
  if (libHost() === null || !ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || !ts.isIdentifier(callee.name)) return null;
  const sym = L.resolveValueSymbol(callee.expression);
  if (sym === null) return null;
  const decl = L.checker.declarationsOf(sym)[0];
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return null;
  let n: ts.Node | undefined = decl.parent;
  while (n !== undefined && !ts.isModuleBlock(n)) n = n.parent;
  const md = n?.parent;
  if (md === undefined || !ts.isModuleDeclaration(md) || !ts.isStringLiteral(md.name) || md.name.text !== MEMORY_MODULE) return null;
  return callee.name.text;
}

function lowerMemCall(L: Lowerer, expr: ts.CallExpression, name: string): IrExpr {
  const loc = locOf(expr);
  const m = WASMLIB_MEMORY_FNS.get(name);
  const fail = (detail: string): never => {
    L.pushDiag(wasmLibSignatureDiag(`tsinter:memory's mem.${name}`, detail, loc));
    throw new PoisonError();
  };
  if (m === undefined) fail(`is not a tsinter:memory function (${[...WASMLIB_MEMORY_FNS.keys()].join(", ")})`);
  if (expr.questionDotToken !== undefined || expr.arguments.some(ts.isSpreadElement) || expr.arguments.length !== m!.params.length) {
    fail(`takes exactly ${m!.params.length} argument(s), called directly`);
  }
  const t = L.mapTypeOf(L.typeOf(expr));
  if (m!.result.kind === "void" ? false : t === null || !typeEquals(t, m!.result)) fail(`is declared to return '${t ? L.fmt(t) : "?"}', not '${L.fmt(m!.result)}'`);
  const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, m!.params[i]!));
  return { kind: "hostCall", module: MEMORY_MODULE, name, args, type: m!.result, loc };
}

export function lowerHostCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const memFn = memTargetOf(L, expr.expression);
  if (memFn !== null) return lowerMemCall(L, expr, memFn);
  const target = hostTargetOf(L, expr.expression);
  if (target === null) return null;
  const loc = locOf(expr);
  const key = `${target.module}.${target.name}`;
  if (expr.questionDotToken !== undefined || expr.typeArguments !== undefined || expr.arguments.some(ts.isSpreadElement)) {
    L.pushDiag(wasmLibSignatureDiag(`host import ${key}`, "is called through ?., type arguments or a spread; a host call is a direct call", loc));
    throw new PoisonError();
  }
  const imp = resolveHostImport(L, target.module, target.name, target.decl, loc);
  if (expr.arguments.length !== imp.params.length) {
    L.pushDiag(wasmLibSignatureDiag(`host import ${key}`, `this call passes ${expr.arguments.length} argument(s), the import takes ${imp.params.length}`, loc));
    throw new PoisonError();
  }
  const args = expr.arguments.map((a, i) => L.lowerExprExpecting(a, wasmLibClassType(imp.params[i]!)!));
  const type = imp.result === null ? VOID : wasmLibClassType(imp.result)!;
  return { kind: "hostCall", module: target.module, name: target.name, args, type, loc };
}
