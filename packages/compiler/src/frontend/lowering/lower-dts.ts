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
import { BOOL, DYN, STRING, accessorSlotProp, isUnitType, JSVAL, typeEquals, type IrExpr, type IrStmt, type IrType, type SrcLoc } from "../../ir/nodes.js";
import { classUnionExitHelper, classUnview, viewableClass } from "./class-views.js";

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
  if (out.type.kind === "jsval" || out.type.kind === "dyn") {
    // A CLASS the declaration names (commander's `this`-returning builder
    // methods, a `parent: Command | null` field) — and that class's union
    // with unit and scalar arms: the instance the dynamic value views is
    // extracted with a check, exactly the typed exit every dynamic value
    // takes into a class slot (S115 (a)); any other kind ends the program
    // by name — the declaration's claim was false for this value. The
    // program then calls its methods and reads its fields as typed code.
    if (L.sharedDynamic) {
      const v: IrExpr = out.type.kind === "jsval" ? out : { kind: "jsMarshal", value: out, type: JSVAL, loc: out.loc };
      if (declared.kind === "object" && viewableClass(L, declared) !== null) return classUnview(L, v, declared, out.loc);
      if (declared.kind === "union") {
        const helper = classUnionExitHelper(L, declared.unionId, out.loc);
        if (helper !== null) return { kind: "call", callee: helper, args: [v], type: declared, loc: out.loc };
      }
    }
    return out;
  }
  // A promise of a dynamic value (an async method inference types
  // `Promise<any>`): it stays that promise — its settled value is the
  // dynamic value, which crosses where the program uses it.
  if (out.type.kind === "promise" && declared.kind === "promise" && (out.type.inner.kind === "jsval" || out.type.inner.kind === "dyn")) return out;
  // A promise whose settled type the declarations narrow only by unit arms
  // (@clack/prompts' `confirm(): Promise<boolean | symbol>` over an
  // implementation inferred `Promise<boolean | symbol | undefined>`): the
  // implementation's promise is handed over UNCHANGED (its identity, and
  // the ticks it settles on, are Node's: a wrapper settling it again would
  // run late beside other promise jobs). Only for a call the program
  // AWAITS directly: the settled value crosses at that await
  // (dtsAwaitedResult). Every other consumer (Promise.all/race entries, a
  // .then callback, a stored promise) keeps the exactness fence below; a
  // wider gap (an arm the declarations lack that is not a unit) too.
  if (out.type.kind === "promise" && declared.kind === "promise") {
    const armsOf = (t: IrType): IrType[] => (t.kind === "union" ? (L.unions.get(t.unionId)?.arms ?? []) : [t]);
    const declaredArms = armsOf(declared.inner);
    const onlyUnits = armsOf(out.type.inner).every((a) => isUnitType(a) || declaredArms.some((d) => typeEquals(d, a)));
    let parent: ts.Node | undefined = node.parent;
    while (parent !== undefined && ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (onlyUnits && parent !== undefined && ts.isAwaitExpression(parent)) return out;
  }
  const mismatch = (got: string): string =>
    `${pkg}'s declarations type ${what} as '${L.fmt(declared)}', but its implementation produced ${got} (SEMANTICS.md S133) [SC1090 at a declared npm crossing]`;
  // A union the declarations narrow by arms (the settled value of a
  // declared promise: `boolean | symbol | undefined` into `boolean |
  // symbol`): the arms the declared union carries re-tag, an undefined
  // rides (S119), and any other arm ends the program naming the claim.
  if (out.type.kind === "union" && declared.kind === "union") {
    const helper = narrowUnionHelper(L, out.type.unionId, declared.unionId, out.loc, mismatch);
    if (helper !== null) return { kind: "call", callee: helper, args: [out], type: declared, loc: out.loc };
  }
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

/** SEMANTICS.md S133 (o): an implementation's object literal of
 * functions and getters (@clack/prompts' spinner result: `{ start, stop,
 * …, get isCancelled() { return S; } }`) crossing into a declared type the
 * program sees as a dynamic value. It becomes the dynamic object Node's
 * literal is: the functions as its data members and each getter as an
 * accessor property (enumerable, configurable, as a literal's are), in the
 * literal's order. So a read of the member runs the getter, live, and is
 * never a frozen copy. A literal holding data members (whose copy the
 * program could tell from the original), a setter, or a getter before a
 * function member keeps the ordinary refusal (null). */
export function getterRecordIntoDynamic(L: Lowerer, out: IrExpr, declared: IrType): IrExpr | null {
  if (out.type.kind !== "record") return null;
  const shape = L.shapes.get(out.type.shapeId);
  if (shape === undefined) return null;
  const loc = out.loc;
  // the literal's own member order (the shape's fields are name-sorted)
  const ordered: { name: string; type: IrType; optional?: true }[] = [];
  // (memberOrder: accessors at their own positions; an integer-like key
  // would enumerate first in Node, which this order does not model)
  if (shape.memberOrder === undefined || shape.memberOrder.some((n) => /^(0|[1-9][0-9]*)$/.test(n))) return null;
  for (const n of shape.memberOrder) {
    const f = shape.fields.find((x) => x.name === n) ?? shape.fields.find((x) => x.name === `%get:${n}`);
    if (f !== undefined && !ordered.includes(f)) ordered.push(f);
  }
  if (ordered.length !== shape.fields.length) return null;
  let sawGetter = false;
  for (const f of ordered) {
    const acc = accessorSlotProp(f.name);
    if (acc !== null) {
      if (acc.kind !== "get") return null;
      sawGetter = true;
      continue;
    }
    if (f.type.kind !== "func" || sawGetter || f.optional === true) return null;
  }
  if (!sawGetter) return null;
  const recL = L.declareHiddenLocal("%getterRec", out.type);
  const objL = L.declareHiddenLocal("%getterObj", DYN);
  const rec = (): IrExpr => ({ kind: "varRef", localId: recL.id, type: out.type, loc });
  const obj = (): IrExpr => ({ kind: "varRef", localId: objL.id, type: DYN, loc });
  const read = (f: { name: string; type: IrType }): IrExpr => ({ kind: "recordGet", obj: rec(), shapeId: (out.type as { shapeId: string }).shapeId, field: f.name, type: f.type, loc });
  const asDyn = (e: IrExpr): IrExpr | null => {
    const d = L.coerceToExpected(e, DYN);
    return d.type.kind === "dyn" ? d : null;
  };
  const str = (v: string): IrExpr => ({ kind: "dynFrom", value: { kind: "strLit", value: v, type: STRING, loc }, type: DYN, loc });
  const tru = (): IrExpr => ({ kind: "dynFrom", value: { kind: "boolLit", value: true, type: BOOL, loc }, type: DYN, loc });
  const js = (e: IrExpr): IrExpr => ({ kind: "jsMarshal", value: e, type: JSVAL, loc }) as IrExpr;
  const fields: { key: IrExpr; value: IrExpr }[] = [];
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: recL.id, init: out, loc }];
  const defines: IrStmt[] = [];
  for (const f of ordered) {
    const acc = accessorSlotProp(f.name);
    const v = asDyn(read(f));
    if (v === null) return null;
    if (acc === null) {
      fields.push({ key: { kind: "strLit", value: f.name, type: STRING, loc }, value: v });
      continue;
    }
    const desc: IrExpr = {
      kind: "dynObjLit",
      fields: [
        { key: { kind: "strLit", value: "get", type: STRING, loc }, value: v },
        { key: { kind: "strLit", value: "enumerable", type: STRING, loc }, value: tru() },
        { key: { kind: "strLit", value: "configurable", type: STRING, loc }, value: tru() },
      ],
      type: DYN,
      loc,
    };
    defines.push({ kind: "exprStmt", expr: { kind: "libCall", fn: "om.defineProperty", args: [js(obj()), js(str(acc.prop)), js(desc)], type: JSVAL, loc }, loc });
  }
  stmts.push({ kind: "varDecl", localId: objL.id, init: { kind: "dynObjLit", fields, type: DYN, loc }, loc }, ...defines);
  const built: IrExpr = { kind: "seqExpr", stmts, result: obj(), type: DYN, loc };
  return declared.kind === "jsval" ? js(built) : built;
}

/** The interned checked narrowing of union `fromId` into union `toId` for a
 * declared crossing: each source arm the target carries re-tags into it,
 * an undefined rides (S119's slot undefined) when the target lacks it, and
 * any other arm ends the program with `mismatch`. Null when no source arm
 * fits the target (nothing to narrow to). */
function narrowUnionHelper(L: Lowerer, fromId: string, toId: string, loc: SrcLoc, mismatch: (what: string) => string): string | null {
  const from = L.unions.get(fromId)?.arms ?? [];
  const to = L.unions.get(toId)?.arms ?? [];
  if (!from.some((a) => to.some((b) => typeEquals(a, b)))) return null;
  const key = `dtsU:${fromId}=>${toId}:${mismatch("%what%")}`;
  const hit = L.jsinHelpers.get(key);
  if (hit !== undefined) return hit;
  const name = `%dtsU${L.jsinHelpers.size}`;
  L.jsinHelpers.set(key, name);
  const fromT: IrType = { kind: "union", unionId: fromId };
  const toT: IrType = { kind: "union", unionId: toId };
  const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
  const body: IrStmt[] = [];
  from.forEach((arm, i) => {
    const isTag: IrExpr = { kind: "unionIsTag", unionId: fromId, tag: i, negated: false, value: u, type: BOOL, loc };
    let then: IrStmt[];
    if (to.some((b) => typeEquals(b, arm))) {
      const payload: IrExpr = isUnitType(arm) ? { kind: "unitLit", type: arm, loc } as IrExpr : { kind: "unionNarrow", unionId: fromId, tag: i, value: u, type: arm, loc };
      then = [{ kind: "return", value: L.coerceToExpected(payload, toT), loc }];
    } else if (L.undefSlots && arm.kind === "undefinedT") {
      then = [{ kind: "return", value: { kind: "slotUndef", type: toT, loc }, loc }];
    } else {
      const what = isUnitType(arm) ? (arm.kind === "undefinedT" ? "undefined" : "null") : `a '${L.fmt(arm)}' value`;
      then = [
        { kind: "runtimeFence", code: "SC1090", message: mismatch(what), loc },
        { kind: "return", value: { kind: "slotUndef", type: toT, loc }, loc },
      ];
    }
    body.push({ kind: "if", cond: isTag, then, else_: null, loc });
  });
  body.push({ kind: "return", value: { kind: "slotUndef", type: toT, loc }, loc });
  L.liftedFns.push({
    name,
    params: [{ localId: "u.0", name: "u", type: fromT }],
    returnType: toT,
    locals: [{ id: "u.0", name: "u", type: fromT, mutable: false }],
    body,
    loc,
  });
  return name;
}

/** `await <declared call>` whose call handed over the implementation's
 * promise (crossInto): the settled value crosses into the declared payload
 * at the await, naming the package's claim when it does not fit. */
export function dtsAwaitedResult(L: Lowerer, expr: ts.AwaitExpression, awaited: IrExpr): IrExpr {
  if (!dtsViewsActive()) return awaited;
  let operand: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (!ts.isCallExpression(operand)) return awaited;
  const decl = declaredSignatureDecl(L, operand);
  if (decl === undefined) return awaited;
  const declared = L.mapTypeOf(L.typeOf(expr));
  if (declared === null || typeEquals(declared, awaited.type)) return awaited;
  return crossInto(L, expr, awaited, declared, packageOf(decl), `the settled value of ${siteText(operand)}`);
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
