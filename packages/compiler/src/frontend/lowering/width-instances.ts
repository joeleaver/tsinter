/* GH #109 / units U2a and A4 (SEMANTICS.md S125 (a), S128): the
 * per-call-site instances that let a call share a value its slot's type
 * cannot hold — a plain function's parameter typed by a class instance's or
 * wider record's own type, a dynamic-arm argument bound as the dynamic
 * value itself, and a declared function's boxed instance crossing into a
 * dynamic value. An instance whose body does not lower falls back to the
 * ordinary judged copy; M0 (arm-failures.ts) records why at the site. */
import * as ts from "../ts7/adapter.js";
import { DYN, IrExpr, IrFunction, IrType, JSVAL, SrcLoc, typeEquals } from "../../ir/nodes.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { isJsSourceFile, locOf } from "../program.js";
import { typeKey } from "../types.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import { armRooted, dynArmKey, isDynArmSite, stripParens } from "./dyn-arm.js";
import { type ArmTry, describeDiag, noteArmFailure } from "./arm-failures.js";
import {
  FnSig, GenericFnInfo, GenericInstance, ParamShape, arrayParamUsesBindable, bodyReadsArguments, carriesFields, castsParam,
  implicitDeclaredReturn, instanceBoundExceeded, instanceParent, isThisParameter, paramWrittenInBody,
} from "./lower-calls.js";

/** M0: why a failed instance failed, for the later sites that reuse it. */
const failures = new WeakMap<GenericInstance, string>();

/** GH #109 (SEMANTICS.md S125): a direct call of a plain TypeScript
 * function passing a CLASS INSTANCE or a WIDER RECORD where a parameter
 * is typed by a record (`bump(p)` against `function bump(o: { n: number
 * })`). The slot's record struct cannot hold the caller's object, and a
 * width copy would lose its identity and writes — so the call names an
 * instance of the function lowered with that parameter typed by the
 * ARGUMENT's own type, the implicit-any machinery's per-site
 * monomorphization: the body reads, writes, prints and compares the
 * caller's object itself. Null (the ordinary call, whose copies
 * widthCopyPass checks) unless some argument binds. A parameter binds
 * when it is a plain identifier the body never reassigns, its declared
 * type maps to a record with no method fields, and the argument's own
 * type is a class or record carrying every one of those fields with the
 * same type. */
export function widthSpecializedCall(L: Lowerer, expr: ts.CallExpression, sig: FnSig, loc: SrcLoc): IrExpr | null {
  if (!ts.isIdentifier(expr.expression)) return null;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return null;
  const sym = L.resolveValueSymbol(expr.expression);
  const decls = sym ? L.checker.declarationsOf(sym) : [];
  if (decls.length !== 1) return null;
  const decl = decls[0]!;
  if (!ts.isFunctionDeclaration(decl) || !decl.body || decl.typeParameters !== undefined) return null;
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile) return null;
  // A JavaScript function (its parameters typed by JSDoc): only the
  // dynamic-arm binding below, its parameter in checked-dynamic storage
  // (S014's U1b amendment); the record-width binding is TypeScript's.
  const js = isJsSourceFile(sf);
  if (bodyReadsArguments(decl)) return null;
  if (decl.parameters.length !== sig.params.length) return null;
  const bindings = new Map<ts.Symbol, ts.Type>();
  // M0: the arguments bound, by what was tried (the arm or S125 (a)'s share)
  const tried: { arg: ts.Expression; kind: ArmTry }[] = [];
  const shapes: ParamShape[] = sig.params.slice();
  decl.parameters.forEach((param, i) => {
    const arg = expr.arguments[i];
    const shape = sig.params[i]!;
    // Unit U2a (dyn-arm.ts): a dynamic-arm argument into a typed composite
    // parameter — the instance's parameter holds the dynamic value itself
    // (S125 (a)'s vehicle, the argument's own type being `any`).
    if (arg && L.dynArmActive && shape.mode === "required" && L.copiesOnCrossing(shape.type) && (armRooted(L, arg) || isDynArmSite(L, stripParens(arg))) &&
        ts.isIdentifier(param.name) && !param.dotDotDotToken && !param.questionToken && !param.initializer && !isThisParameter(param)) {
      const psym = L.checker.getSymbolAtLocation(param.name);
      if (psym) {
        bindings.set(psym, L.checker.getAnyType());
        shapes[i] = { type: js ? DYN : JSVAL, mode: "required" };
        tried.push({ arg, kind: "arm" });
      }
      return;
    }
    if (js) return;
    // (paperclip's summarizePlanCounts: an ARRAY of wider records into an
    // array-of-record parameter binds like a record parameter — the body
    // reads the caller's elements; its filter callbacks bind the element
    // parameter the same way, lower-containers.ts hofCallbackArg. A body
    // the instance cannot lower falls back to the judged copy.)
    const arrayOfRecord = shape.type.kind === "array" && shape.type.elem.kind === "record";
    if (!arg || (shape.type.kind !== "record" && !arrayOfRecord) || shape.mode !== "required") return;
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken || param.questionToken || param.initializer) return;
    if (isThisParameter(param)) return;
    const psym = L.checker.getSymbolAtLocation(param.name);
    if (!psym || paramWrittenInBody(L, decl.body!, psym, param.name.text) || castsParam(L, decl.body!, psym, param.name.text)) return;
    let a: ts.Expression = arg;
    while (ts.isParenthesizedExpression(a)) a = a.expression;
    // Literals lower against the slot's own shape: no copy to avoid.
    if (ts.isObjectLiteralExpression(a) || ts.isArrayLiteralExpression(a)) return;
    const at = L.typeOf(arg);
    let ir: IrType | null;
    try {
      ir = L.mapTypeOf(at);
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      return;
    }
    if (!ir || typeEquals(ir, shape.type)) return;
    if (shape.type.kind === "array") {
      const pe = shape.type.elem;
      if (ir.kind !== "array" || pe.kind !== "record" || !carriesFields(L, ir.elem, pe.shapeId)) return;
      if (!arrayParamUsesBindable(L, decl.body!, psym, param.name.text)) return;
    } else if (shape.type.kind !== "record" || !carriesFields(L, ir, shape.type.shapeId)) return;
    bindings.set(psym, at);
    shapes[i] = { type: ir, mode: "required" };
    tried.push({ arg, kind: "share" });
  });
  if (bindings.size === 0) return null;
  let info = L.widthSpecInfos.get(decl);
  if (!info) {
    info = {
      decl,
      baseName: expr.expression.text,
      qualifiedName: `${sig.name}%w`,
      typeParams: [],
      instances: new Map(),
      implicitParams: decl.parameters.map(() => null),
    };
    L.widthSpecInfos.set(decl, info);
  }
  for (const b of bindings.keys()) L.widthBoundParams.add(b);
  const inst = widthInstance(L, info, shapes, bindings, undefined, (text) => {
    for (const t of tried) noteArmFailure(L, [locOf(t.arg), locOf(stripParens(t.arg))], t.kind, text);
  });
  if (inst === null) return null;
  const args = L.completeArgs(expr.arguments, inst.params, loc, expr);
  return { kind: "call", callee: inst.name, args, type: inst.returnType, loc };
}

/** S125 share-vs-copy, A4 (the commander collector shape, design "C"): a
 * DECLARED function's closure crossing into a dynamic value, whose refused
 * composite parameters are recorded `dparam:` sites, boxes its BOXED
 * instance instead — the same per-call-site machinery as S125 (a), with
 * those parameters bound to `any` (dynamic-arm slots), so dynamic code and
 * the body share the argument. Direct calls keep the typed function. The
 * closure as is when nothing applies (or the instance does not lower). */
export function dynboxClosure(L: Lowerer, e: IrExpr): IrExpr {
  if (e.kind !== "closure" || L.dynArmSites.size === 0 || e.captures.length > 0) return e;
  const hit = L.declByFnName(e.fnName);
  if (hit === undefined) return e;
  const { decl, sig } = hit;
  // (S125 A4 extension: an async declared function too — commander's async
  // actions; its promise result stays typed)
  if (decl.typeParameters !== undefined || sig.generator !== undefined || decl.asteriskToken !== undefined) return e;
  if (bodyReadsArguments(decl) || decl.parameters.length !== sig.params.length) return e;
  const js = isJsSourceFile(decl.getSourceFile());
  const bindings = new Map<ts.Symbol, ts.Type>();
  const shapes: ParamShape[] = sig.params.slice();
  decl.parameters.forEach((param, i) => {
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken || isThisParameter(param)) return;
    if (!L.dynArmSites.has(`dparam:${dynArmKey(param)}`)) return;
    const psym = L.checker.getSymbolAtLocation(param.name);
    if (psym === undefined) return;
    bindings.set(psym, L.checker.getAnyType());
    const t = js ? DYN : JSVAL;
    // (a defaulted parameter picks its default on the dynamic tier's undefined)
    shapes[i] = param.initializer ? { type: t, mode: "omittable", bodyType: t } : { type: t, mode: shapes[i]!.mode };
  });
  // a refused composite result: the boxed instance returns the dynamic value
  const retArm = !sig.isAsync && sig.returnType.kind !== "void" && L.dynArmSites.has(`dret:${dynArmKey(decl)}`) ? (js ? DYN : JSVAL) : undefined;
  if (bindings.size === 0 && retArm === undefined) return e;
  let info = L.widthSpecInfos.get(decl);
  if (!info) {
    info = {
      decl,
      baseName: decl.name?.text ?? sig.name,
      qualifiedName: `${sig.name}%w`,
      typeParams: [],
      instances: new Map(),
      implicitParams: decl.parameters.map(() => null),
    };
    L.widthSpecInfos.set(decl, info);
  }
  for (const b of bindings.keys()) L.widthBoundParams.add(b);
  const inst = widthInstance(L, info, shapes, bindings, retArm, (text) => noteArmFailure(L, [e.loc], "arm", text));
  if (inst === null) return e;
  L.dynboxDecls.set(inst.name, hit);
  return { kind: "closure", fnName: inst.name, captures: [], type: { kind: "func", params: inst.params.map((p) => p.type), ret: inst.returnType }, loc: e.loc };
}

/** The instance of `info` over `shapes`, lowered eagerly at first demand
 * (internImplicitInstance's discipline), or null when the body does not
 * lower over the bound types (a construct the class instance does not
 * support — `JSON.stringify` of an instance, say): the call then keeps its
 * ordinary path, whose copy widthCopyPass judges. Nothing the failed
 * attempt reported survives it. */
function widthInstance(L: Lowerer, info: GenericFnInfo, shapes: ParamShape[], argTypes: Map<ts.Symbol, ts.Type>, retOverride: IrType | undefined, onFail: (text: string) => void): GenericInstance | null {
  const key = shapes.map((s) => typeKey(s.type)).join(",") + (retOverride !== undefined ? `|ret=${typeKey(retOverride)}` : "");
  const existing = info.instances.get(key);
  if (existing) {
    if (existing.implicitState === "failed") {
      const why = failures.get(existing);
      if (why !== undefined) onFail(why);
      return null;
    }
    if (existing.implicitState === "lowering") existing.returnPinned = true;
    return existing;
  }
  const bound = instanceBoundExceeded(info, "width");
  if (bound !== null) {
    onFail(bound);
    return null;
  }
  const rendered = shapes.map((s) => L.fmt(s.type)).join(", ");
  const declared = retOverride ?? implicitDeclaredReturn(L, info);
  if (declared === null) return null;
  const inst: GenericInstance = {
    name: `${info.qualifiedName}%${info.instances.size}`,
    ordinal: info.instances.size,
    ...instanceParent(),
    params: shapes,
    returnType: declared,
    bindings: new Map(),
    typeArgsText: `(${rendered.length > 80 ? rendered.slice(0, 77) + "..." : rendered})`,
    implicitArgTypes: argTypes,
    implicitState: "lowering",
    widthInstance: true,
  };
  info.instances.set(key, inst);
  const savedSink = L.diagSink;
  const captured: ScrDiagnostic[] = [];
  L.diagSink = captured;
  const liftedBefore = L.liftedFns.length;
  let fn: IrFunction | null = null;
  try {
    fn = L.lowerGenericInstance(info, inst);
  } catch (e) {
    if (!(e instanceof PoisonError)) {
      L.diagSink = savedSink;
      throw e;
    }
  } finally {
    L.diagSink = savedSink;
  }
  if (fn === null || captured.length > 0) {
    inst.implicitState = "failed";
    const why = captured.length > 0 ? describeDiag(L, captured[0]!) : "its body did not lower over the bound types";
    failures.set(inst, why);
    onFail(why);
    // A function lifted out of the failed body (a lambda) that calls the
    // instance would name a function that never exists: keep the failure.
    if (L.liftedFns.slice(liftedBefore).some((f) => JSON.stringify(f.body).includes(JSON.stringify(inst.name)))) {
      for (const d of captured) L.pushDiag(d);
      throw new PoisonError();
    }
    return null;
  }
  inst.implicitState = "done";
  L.implicitFns.push(fn);
  return inst;
}
