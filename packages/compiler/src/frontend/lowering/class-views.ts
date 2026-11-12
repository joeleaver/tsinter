/* Class-instance views (docs/design/dynamic-values.md §4.2's first U5
 * item; SEMANTICS.md S115's class amendment): a typed class instance
 * entering a dynamic (`any`/`unknown`/JS-residue) slot is SHARED, exactly
 * as in Node — the dynamic value is a live VIEW of the instance, and a
 * dynamic value leaving into a class-typed slot unwraps the instance it
 * views. Commander's own JS (SEMANTICS.md S133's compiled package) pushes
 * `this` into `any[]` arrays, stores Commands in null-initialized fields
 * and hands them to callbacks through `fn.apply(this, args)`; every npm
 * class library does the same.
 *
 * The view is unit H's record view (island-views.ts viewFactory) over the
 * instance's own fields, plus its prototype's methods:
 *   - keys(): the instance's own fields, base class first (super() runs
 *     first in JS), in assignment order;
 *   - get(k): a field's value (lifted: nested composites and instances are
 *     views again); a method — the nearest declaration, dispatched on the
 *     instance's runtime class — as a function bound to the instance; a
 *     getter's value; anything else `undefined`;
 *   - set(k, v): a field's checked store (a value its type cannot hold
 *     ends the program by name, S115/S122); adding any other property
 *     refuses by name.
 * One factory per exact class; the factory of a class with subclasses
 * dispatches on the runtime class first, so a subclass instance seen
 * through a base-typed slot shows its own fields and overrides. The
 * token is the instance itself (two views of one instance are one
 * dynamic value), and a dynamic value leaving into a class slot is
 * `jsUnview`'s class form: a view whose token IS an instance of the slot's
 * class (subclasses included) unwraps; anything else stops by name. */
import type { Lowerer } from "./lowerer.js";
import * as ts from "../ts7/adapter.js";
import { isUndefExpr } from "./lower-exprs.js";
import { emitterRooted } from "./lower-emitter.js";
import { EMITTER_API_MEMBERS, type ClassInfo } from "./lower-classes.js";
import { BOOL, JSVAL, STRING, VOID, typeEquals, typeKey, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/nodes.js";

const str = (value: string, loc: SrcLoc): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const undef = (loc: SrcLoc): IrExpr => ({ kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc });
const fence = (message: string, loc: SrcLoc): IrStmt => ({ kind: "runtimeFence", code: "SC1090", message: `${message} [SC1090 at a class instance shared with dynamic code]`, loc });

/** A user class whose instances can cross as views: a program (or
 * compiled package) class with a body — not the runtime-provided Error,
 * EventEmitter or stream roots themselves, and not a generic family. A
 * user error class (any class over the runtime Error) keeps the error
 * world's own dynamic crossing (an error crosses as the thrown instance
 * the dynamic error readers answer on), never a view. */
export function viewableClass(L: Lowerer, t: IrType): ClassInfo | null {
  if (t.kind !== "object") return null;
  const info = L.classes.get(t.className);
  if (!info || info.decl === null || info.builtinError || info.builtinEmitter || info.builtinStream !== undefined) return null;
  for (let b = info.base; b !== null; b = b.base) if (b.builtinError) return null;
  return info;
}

/** The instance's view: `%cview.<n>(x)`. */
export function classViewOf(L: Lowerer, e: IrExpr, loc: SrcLoc): IrExpr {
  if (e.type.kind !== "object") throw new Error("lowerer bug: class view of a non-instance");
  return { kind: "call", callee: classViewFactory(L, e.type.className, loc), args: [e], type: JSVAL, loc };
}

/** The dynamic value `v` leaving into the class slot `t` (exactly the
 * instance a view of it holds, subclasses included). */
export function classUnview(L: Lowerer, v: IrExpr, t: IrType & { kind: "object" }, loc: SrcLoc): IrExpr {
  const name = t.className.replace(/^%m\d+\./, "").replace(/^%/, "");
  return { kind: "jsUnview", value: v, typeKey: typeKey(t), what: `a '${name}' slot (it holds only '${name}' instances)`, classTest: true, type: t, loc };
}

/** `%cexit.union.<n>(v: jsval): U` — a dynamic value leaving into a union
 * that carries at least one class arm, beside unit and scalar arms only:
 * the value's own kind picks the arm (`undefined`/`null` their unit arms,
 * a class-instance view the first class arm it is an instance of, a
 * string/number/boolean its scalar arm); anything else ends the program by
 * name. Null when the union has no class arm or an arm of another kind. */
export function classUnionExitHelper(L: Lowerer, unionId: string, loc: SrcLoc): string | null {
  const def = L.unions.get(unionId);
  if (!def) return null;
  const classArms = def.arms.filter((a) => viewableClass(L, a) !== null);
  if (classArms.length === 0) return null;
  const ok = def.arms.every((a) => viewableClass(L, a) !== null || a.kind === "undefinedT" || a.kind === "nullT" || a.kind === "string" || a.kind === "f64" || a.kind === "bool");
  if (!ok) return null;
  const key = `cexit:${unionId}`;
  const hit = L.jsinHelpers.get(key);
  if (hit) return hit;
  const name = `%cexit.union.${L.jsinHelpers.size}`;
  L.jsinHelpers.set(key, name);
  const ut: IrType = { kind: "union", unionId };
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: JSVAL, loc });
  const tyOf = (): IrExpr => ({ kind: "jsOp", op: "typeof", args: [v()], type: STRING, loc });
  const tyIs = (t: string): IrExpr => ({ kind: "strEq", negated: false, left: tyOf(), right: str(t, loc), type: BOOL, loc });
  const wrap = (tag: number, value: IrExpr): IrStmt => ({ kind: "return", value: { kind: "unionWrap", unionId, tag, value, type: ut, loc }, loc });
  const body: IrStmt[] = [];
  def.arms.forEach((arm, tag) => {
    if (arm.kind === "undefinedT") {
      body.push({ kind: "if", cond: tyIs("undefined"), then: [wrap(tag, { kind: "unitLit", unit: "undefined", type: arm, loc } as IrExpr)], else_: null, loc });
    } else if (arm.kind === "nullT") {
      const isNull: IrExpr = { kind: "jsOp", op: "eq", args: [v(), { kind: "jsOp", op: "nullLit", args: [], type: JSVAL, loc }], type: BOOL, loc };
      body.push({ kind: "if", cond: isNull, then: [wrap(tag, { kind: "unitLit", unit: "null", type: arm, loc } as IrExpr)], else_: null, loc });
    } else if (arm.kind === "string" || arm.kind === "f64" || arm.kind === "bool") {
      const t = arm.kind === "string" ? "string" : arm.kind === "f64" ? "number" : "boolean";
      body.push({ kind: "if", cond: tyIs(t), then: [wrap(tag, { kind: "jsExit", value: v(), type: arm, loc })], else_: null, loc });
    } else if (arm.kind === "object") {
      body.push({
        kind: "if",
        cond: { kind: "jsViewOfClass", value: v(), className: arm.className, type: BOOL, loc },
        then: [wrap(tag, classUnview(L, v(), arm, loc))],
        else_: null,
        loc,
      });
    }
  });
  body.push(fence(`a dynamic value of another kind leaving into a '${L.fmt(ut)}' slot (it holds only those kinds)`, loc));
  body.push({ kind: "return", value: { kind: "slotUndef", type: ut, loc } as IrExpr, loc });
  L.liftedFns.push({
    name,
    params: [{ localId: "v.0", name: "v", type: JSVAL }],
    returnType: ut,
    locals: [{ id: "v.0", name: "v", type: JSVAL, mutable: true }],
    body,
    loc,
  });
  return name;
}

/** The class-aware lift into a dynamic slot: an instance as its view, a
 * function over instances through its adapter, a union carrying instances
 * (beside units and scalars) arm by arm. Null when `e` carries no class. */
export function classLiftIn(L: Lowerer, e: IrExpr, loc: SrcLoc): IrExpr | null {
  if (!L.sharedDynamic) return null;
  if (viewableClass(L, e.type) !== null) return classViewOf(L, e, loc);
  if (e.type.kind === "func") return classFuncBox(L, e, loc);
  if (e.type.kind === "union") {
    const arms = L.unions.get(e.type.unionId)?.arms ?? [];
    if (arms.some((a) => viewableClass(L, a) !== null) &&
        arms.every((a) => viewableClass(L, a) !== null || a.kind === "undefinedT" || a.kind === "nullT" || a.kind === "string" || a.kind === "f64" || a.kind === "bool")) {
      return { kind: "call", callee: L.unionToJsvalHelper(e.type.unionId, loc), args: [e], type: JSVAL, loc };
    }
  }
  return null;
}

/** Does `t` mention a class instance anywhere a function signature
 * crossing into dynamic code would need it converted? */
function mentionsClass(L: Lowerer, t: IrType): boolean {
  if (viewableClass(L, t) !== null) return true;
  if (t.kind === "union") return (L.unions.get(t.unionId)?.arms ?? []).some((a) => viewableClass(L, a) !== null);
  return false;
}

/** A typed function whose parameters or result carry class instances,
 * crossing into a dynamic slot (a callback handed to JS `Array.map` over
 * an `any[]`, a hook stored in a JS array): the function boxes as an
 * adapter taking dynamic arguments — each checked into the parameter's
 * type, an instance unwrapped from its view — and answering its result
 * lifted (an instance as its view). Null when the signature has no class
 * in it, or a part has no conversion. */
export function classFuncBox(L: Lowerer, e: IrExpr, loc: SrcLoc, force = false): IrExpr | null {
  const ft = e.type;
  if (ft.kind !== "func" || ft.rest === true) return null;
  // Functions over instances, and functions whose own function-typed
  // parameters (a `write` callback handed back in) have no direct
  // marshal: everything else keeps its ordinary box.
  if (!force && !ft.params.some((p) => mentionsClass(L, p) || p.kind === "func") && !mentionsClass(L, ft.ret)) return null;
  const key = `cfbox:${typeKey(ft)}`;
  let name = L.jsinHelpers.get(key);
  if (!name) {
    name = `%cfbox.${L.jsinHelpers.size}`;
    L.jsinHelpers.set(key, name);
    const f = (): IrExpr => ({ kind: "varRef", localId: "f.0", type: ft, loc });
    const cap = { localId: "f.0", name: "f", type: ft as IrType };
    const capLocal = { id: "f.0", name: "f", type: ft as IrType, mutable: false as const, boxed: true as const };
    const params = ft.params.map((_, i) => ({ localId: `a.${i}`, name: `a${i}`, type: JSVAL as IrType }));
    const body: IrStmt[] = [];
    const args: IrExpr[] = [];
    let ok = true;
    ft.params.forEach((p, i) => {
      const a = exitArg(L, { kind: "varRef", localId: `a.${i}`, type: JSVAL, loc }, p);
      if (a === null) ok = false;
      else args.push(a);
    });
    if (!ok) {
      L.jsinHelpers.delete(key);
      return null;
    }
    const call: IrExpr = { kind: "callValue", callee: f(), args, type: ft.ret, loc };
    if (ft.ret.kind === "void") body.push({ kind: "exprStmt", expr: call, loc }, { kind: "return", value: undef(loc), loc });
    else body.push({ kind: "return", value: liftOut(L, call, loc), loc });
    const inner = `${name}.fn`;
    L.liftedFns.push({
      name: inner,
      params,
      returnType: JSVAL,
      captures: [cap],
      locals: [capLocal, ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true }))],
      body,
      loc,
    });
    const innerT: IrType = { kind: "func", params: params.map(() => JSVAL), ret: JSVAL };
    L.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: ft }],
      returnType: JSVAL,
      locals: [capLocal],
      body: [{ kind: "return", value: { kind: "jsMarshal", value: { kind: "closure", fnName: inner, captures: ["f.0"], type: innerT, loc }, type: JSVAL, loc }, loc }],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [e], type: JSVAL, loc };
}

/** Every registered class strictly below `className`, deepest first. */
function subclassesOf(L: Lowerer, className: string): ClassInfo[] {
  const out: { info: ClassInfo; depth: number }[] = [];
  for (const info of L.classes.values()) {
    if (info.def.name === className) continue;
    let depth = 0;
    let found = false;
    for (let c = info.base; c; c = c.base) {
      depth++;
      if (c.def.name === className) {
        found = true;
        break;
      }
    }
    if (found) out.push({ info, depth });
  }
  return out.sort((a, b) => b.depth - a.depth).map((x) => x.info);
}

/** Property names some write in the compiled program may set to
 * `undefined` (a right-hand side whose type admits undefined or is
 * dynamic, a logical assignment, a `delete`), per Lowerer: a late
 * JavaScript property NOT named here holds undefined exactly while it
 * does not exist (Node's own-key answer). */
const undefWritten = new WeakMap<Lowerer, Set<string>>();
function mayBeWrittenUndefined(L: Lowerer, name: string): boolean {
  let names = undefWritten.get(L);
  if (!names) {
    const found = new Set<string>();
    const nameOf = (n: ts.Node): string | null => {
      if (ts.isPropertyAccessExpression(n)) return n.name.text;
      if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)) return n.argumentExpression.text;
      return null;
    };
    const admitsUndef = (t: IrType | null): boolean => {
      if (t === null) return true;
      if (t.kind === "undefinedT" || t.kind === "jsval" || t.kind === "dyn" || t.kind === "void") return true;
      if (t.kind === "union") return (L.unions.get(t.unionId)?.arms ?? []).some((a) => admitsUndef(a));
      return false;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n)) {
        const target = nameOf(n.left);
        if (target !== null) {
          const op = n.operatorToken.kind;
          if (op === ts.SyntaxKind.EqualsToken) {
            if (admitsUndef(L.mapTypeOf(L.checker.getTypeAtLocation(n.right)))) found.add(target);
          } else if (op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
            found.add(target);
          }
        }
      } else if (ts.isDeleteExpression(n)) {
        const target = nameOf(n.expression);
        if (target !== null) found.add(target);
      }
      n.forEachChild(visit);
    };
    for (const sf of L.moduleOrder) sf.forEachChild(visit);
    names = found;
    undefWritten.set(L, names);
  }
  return names.has(name);
}

/** The class chain from the root down to `info`. */
function chainOf(info: ClassInfo): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (let c: ClassInfo | null = info; c; c = c.base) out.unshift(c);
  return out;
}

interface Member {
  name: string;
  kind: "method" | "getter";
}

/** The public methods and getters visible on an instance, nearest
 * declaration first per name. */
function membersOf(info: ClassInfo): Member[] {
  const seen = new Set<string>();
  const out: Member[] = [];
  for (let c: ClassInfo | null = info; c; c = c.base) {
    for (const [key, sig] of c.methods) {
      if (key.includes("#") || key === "constructor" || sig.gen !== undefined) continue;
      if (key.startsWith("set:")) continue;
      const getter = key.startsWith("get:");
      const name = getter ? key.slice(4) : key;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, kind: getter ? "getter" : "method" });
    }
  }
  return out;
}

/** A call of instance method `key` (a method name or "get:x") on `recv`,
 * dispatched like the lowering's own method calls. */
function methodCall(L: Lowerer, info: ClassInfo, key: string, recv: IrExpr, args: IrExpr[], loc: SrcLoc): IrExpr | null {
  const found = L.findMethodOn(info, key);
  if (!found || found.sig.abstract === true) return null;
  if (L.overrideBelow(info, key)) {
    L.noteVirtualEdge(info, key);
    return { kind: "virtualCall", className: info.def.name, method: key, args: [L.upcastTo(recv, info.def.name), ...args], type: found.sig.ret, loc };
  }
  L.noteEdge(`%${found.declarer.def.name}.${key}`);
  return { kind: "call", callee: `%${found.declarer.def.name}.${key}`, args: [L.upcastTo(recv, found.declarer.def.name), ...args], type: found.sig.ret, loc };
}

/** `value`, but the program stops by name when this expression runs: an
 * interned identity helper whose body is the runtime fence (a fence is a
 * statement, which an expression position cannot hold directly). */
export function fencedValue(L: Lowerer, value: IrExpr, code: string, message: string, loc: SrcLoc): IrExpr {
  const key = `fenced:${typeKey(value.type)}:${code}:${message}`;
  let name = L.jsinHelpers.get(key);
  if (!name) {
    name = `%fenced.${L.jsinHelpers.size}`;
    L.jsinHelpers.set(key, name);
    L.liftedFns.push({
      name,
      params: [{ localId: "v.0", name: "v", type: value.type }],
      returnType: value.type,
      locals: [{ id: "v.0", name: "v", type: value.type, mutable: false }],
      body: [
        { kind: "runtimeFence", code: code as "SC1090", message, loc } as IrStmt,
        { kind: "return", value: { kind: "varRef", localId: "v.0", type: value.type, loc }, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [value], type: value.type, loc };
}

/** A typed value lifted into the dynamic world (an instance as its view,
 * a promise boxed, ...): the lowering's own crossing into `any`, or a
 * fence-carrying undefined when that crossing has no conversion. */
function liftOut(L: Lowerer, e: IrExpr, loc: SrcLoc): IrExpr {
  const out = L.coerceToExpected(e, JSVAL);
  if (out.type.kind === "jsval") return out;
  return fencedValue(L, undef(loc), "SC1090", `a '${L.fmt(e.type)}' value reaching dynamic code from a class instance shared with it is not supported yet [SC1090 at a class instance shared with dynamic code]`, loc);
}

/** A dynamic argument converted into a typed parameter, or null when no
 * conversion exists. */
function exitArg(L: Lowerer, v: IrExpr, t: IrType): IrExpr | null {
  if (t.kind === "jsval") return v;
  const out = L.coerceToExpected(v, t);
  return typeEquals(out.type, t) ? out : null;
}

/** The bound-method FUNC for `name` on the instance captured as `x.0`:
 * every parameter takes a dynamic value (checked into the method's own
 * parameter types), the result crosses back lifted. */
function boundMethodFn(L: Lowerer, factory: string, info: ClassInfo, name: string, x: () => IrExpr, cap: { localId: string; name: string; type: IrType }, capLocal: { id: string; name: string; type: IrType; mutable: false; boxed: true }, loc: SrcLoc): IrExpr {
  const found = L.findMethodOn(info, name)!;
  const fnName = `${factory}.m.${name.replace(/[^A-Za-z0-9_$]/g, "_")}`;
  const shapes = found.sig.params;
  const fixed = shapes.filter((p) => p.mode === "required" || p.mode === "omittable");
  const body: IrStmt[] = [];
  const params = fixed.map((_, i) => ({ localId: `a.${i}`, name: `a${i}`, type: JSVAL as IrType }));
  if (fixed.length !== shapes.length) {
    body.push(fence(`calling the method '${name}' (its rest parameter) through a class instance shared with dynamic code is not supported yet`, loc));
    body.push({ kind: "return", value: undef(loc), loc });
  } else {
    const args: IrExpr[] = [];
    let ok = true;
    for (let i = 0; i < fixed.length; i++) {
      const a = exitArg(L, { kind: "varRef", localId: `a.${i}`, type: JSVAL, loc }, fixed[i]!.type);
      if (a === null) {
        ok = false;
        body.push(fence(`calling the method '${name}' through a class instance shared with dynamic code: its parameter ${i + 1} ('${L.fmt(fixed[i]!.type)}') takes no dynamic value yet`, loc));
        body.push({ kind: "return", value: undef(loc), loc });
        break;
      }
      args.push(a);
    }
    if (ok) {
      const call = methodCall(L, info, name, x(), args, loc)!;
      if (call.type.kind === "void") {
        body.push({ kind: "exprStmt", expr: call, loc }, { kind: "return", value: undef(loc), loc });
      } else {
        body.push({ kind: "return", value: liftOut(L, call, loc), loc });
      }
    }
  }
  const fn: IrFunction = {
    name: fnName,
    params,
    returnType: JSVAL,
    captures: [cap],
    locals: [capLocal, ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true }))],
    body,
    loc,
  };
  L.liftedFns.push(fn);
  const fnT: IrType = { kind: "func", params: params.map(() => JSVAL), ret: JSVAL };
  return { kind: "jsMarshal", value: { kind: "closure", fnName, captures: [cap.localId], type: fnT, loc }, fnName: name, type: JSVAL, loc } as IrExpr;
}

/** The interned view factory of one class. */
export function classViewFactory(L: Lowerer, className: string, loc: SrcLoc): string {
  const t: IrType = { kind: "object", className };
  const key = `cview:${className}`;
  const hit = L.jsinHelpers.get(key);
  if (hit) return hit;
  const name = `%cview.${L.jsinHelpers.size}`;
  L.jsinHelpers.set(key, name);
  const info = L.classes.get(className);
  if (!info) throw new Error(`lowerer bug: class view of unknown class ${className}`);
  const label = className.replace(/^%m\d+\./, "").replace(/^%/, "");
  const x = (): IrExpr => ({ kind: "varRef", localId: "x.0", type: t, loc });
  const cap = { localId: "x.0", name: "x", type: t };
  const capLocal = { id: "x.0", name: "x", type: t, mutable: false as const, boxed: true as const };
  const fields: { name: string; type: IrType; owner: ClassInfo; late: boolean; lateExact: boolean }[] = [];
  for (const c of chainOf(info)) {
    for (const f of c.fieldOrder) {
      if (f.redeclared || f.name.startsWith("#") || f.name.startsWith("%")) continue;
      if (fields.some((g) => g.name === f.name)) continue;
      fields.push({ name: f.name, type: info.fields.get(f.name) ?? f.type, owner: c, late: f.late === true, lateExact: f.late === true && !mayBeWrittenUndefined(L, f.name) });
    }
  }
  const members = membersOf(info).filter((m) => !fields.some((f) => f.name === m.name));
  const k = (): IrExpr => ({ kind: "varRef", localId: "k.0", type: STRING, loc });
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: JSVAL, loc });
  const keyIs = (n: string): IrExpr => ({ kind: "strEq", negated: false, left: k(), right: str(n, loc), type: BOOL, loc });
  const fieldRead = (f: { name: string; type: IrType; owner: ClassInfo }): IrExpr =>
    ({ kind: "fieldGet", obj: x(), className, field: f.name, type: f.type, loc });

  // keys(): the own fields, root class first.
  const keysBody: IrStmt[] = [{ kind: "varDecl", localId: "o.0", init: { kind: "jsOp", op: "arrLit", args: [], type: JSVAL, loc }, loc }];
  for (const f of fields) {
    const push: IrStmt = {
      kind: "exprStmt",
      expr: { kind: "jsOp", op: "callMethod", name: "push", args: [{ kind: "varRef", localId: "o.0", type: JSVAL, loc }, { kind: "jsMarshal", value: str(f.name, loc), type: JSVAL, loc }], type: JSVAL, loc },
      loc,
    };
    if (!f.late) {
      keysBody.push(push);
      continue;
    }
    // A JavaScript property first assigned past the constructor's top
    // level is no own property until that write runs (Node). When no
    // write can store undefined, its slot holds undefined exactly while
    // the property is absent; otherwise "never assigned" and "assigned
    // undefined" look alike, so listing it then stops by name.
    keysBody.push({
      kind: "if",
      cond: isUndefExpr(fieldRead(f), false, loc),
      then: f.lateExact ? [] : [fence(`listing the own keys of a '${label}' instance shared with dynamic code while its field '${f.name}' (first assigned outside the constructor) holds undefined is not supported yet`, loc)],
      else_: [push],
      loc,
    });
  }
  keysBody.push({ kind: "return", value: { kind: "varRef", localId: "o.0", type: JSVAL, loc }, loc });

  // get(k)
  const getBody: IrStmt[] = [];
  for (const f of fields) {
    getBody.push({ kind: "if", cond: keyIs(f.name), then: [{ kind: "return", value: liftOut(L, fieldRead(f), loc), loc }], else_: null, loc });
  }
  for (const m of members) {
    let value: IrExpr;
    if (m.kind === "getter") {
      const call = methodCall(L, info, `get:${m.name}`, x(), [], loc);
      if (call === null) continue;
      value = liftOut(L, call, loc);
    } else {
      value = boundMethodFn(L, name, info, m.name, x, cap, capLocal, loc);
    }
    getBody.push({ kind: "if", cond: keyIs(m.name), then: [{ kind: "return", value, loc }], else_: null, loc });
  }
  // `constructor` and `__proto__` — and, for an EventEmitter subclass, the
  // emitter's own methods — are not modelled on the view: reading one
  // stops by name (Node would find the inherited value). The other
  // Object.prototype members answer undefined here, so the dynamic world
  // answers them as for any object (String(x), x.toString(),
  // x.hasOwnProperty(k) over the own fields).
  const protoNames = ["constructor", "__proto__"];
  if (emitterRooted(L, info)) protoNames.push(...EMITTER_API_MEMBERS);
  for (const proto of protoNames) {
    if (fields.some((f) => f.name === proto) || members.some((m) => m.name === proto)) continue;
    getBody.push({ kind: "if", cond: keyIs(proto), then: [fence(`reading the inherited member '${proto}' through a '${label}' instance shared with dynamic code is not supported yet`, loc), { kind: "return", value: undef(loc), loc }], else_: null, loc });
  }
  getBody.push({ kind: "return", value: undef(loc), loc });

  // set(k, v)
  const setBody: IrStmt[] = [];
  const setLocals: { id: string; type: IrType }[] = [];
  fields.forEach((f, j) => {
    const conv = exitArg(L, v(), f.type);
    setLocals.push({ id: `c.${j}`, type: f.type });
    setBody.push({
      kind: "if",
      cond: keyIs(f.name),
      then: conv === null
        ? [fence(`storing into the '${f.name}' field ('${L.fmt(f.type)}') of a '${label}' instance from dynamic code is not supported yet`, loc), { kind: "return", value: null, loc }]
        : [
          { kind: "varDecl", localId: `c.${j}`, init: conv, loc },
          // An exact late property (keys() above) never holds an assigned
          // undefined: a dynamic write of one stops by name.
          ...(f.lateExact
            ? [{
              kind: "if",
              cond: isUndefExpr({ kind: "varRef", localId: `c.${j}`, type: f.type, loc }, false, loc),
              then: [fence(`storing undefined into the '${f.name}' field of a '${label}' instance (first assigned outside the constructor) from dynamic code is not supported yet`, loc)],
              else_: null,
              loc,
            } as IrStmt]
            : []),
          { kind: "fieldSet", obj: x(), className, field: f.name, value: { kind: "varRef", localId: `c.${j}`, type: f.type, loc }, loc },
          { kind: "return", value: null, loc },
        ],
      else_: null,
      loc,
    });
  });
  setBody.push(fence(`Cannot add a property to a '${label}' instance shared from typed code: its class fixes its fields (SEMANTICS.md S115)`, loc));

  // has(k): the prototype's methods and getters (`k in x` beyond the own
  // fields). Its presence also marks the view as a class instance's
  // (dyn.ts classViewPrintFence).
  const bool = (b: boolean): IrExpr => ({ kind: "jsMarshal", value: { kind: "boolLit", value: b, type: BOOL, loc }, type: JSVAL, loc });
  const hasBody: IrStmt[] = members.map((m) => ({ kind: "if", cond: keyIs(m.name), then: [{ kind: "return", value: bool(true), loc }], else_: null, loc }) as IrStmt);
  hasBody.push({ kind: "return", value: bool(false), loc });

  const impls: { suffix: string; params: { id: string; type: IrType }[]; ret: IrType; locals?: { id: string; type: IrType }[]; body: IrStmt[] }[] = [
    { suffix: "keys", params: [], ret: JSVAL, locals: [{ id: "o.0", type: JSVAL }], body: keysBody },
    { suffix: "get", params: [{ id: "k.0", type: STRING }], ret: JSVAL, body: getBody },
    { suffix: "set", params: [{ id: "k.0", type: STRING }, { id: "v.0", type: JSVAL }], ret: VOID, locals: setLocals, body: setBody },
    { suffix: "has", params: [{ id: "k.0", type: STRING }], ret: JSVAL, body: hasBody },
  ];
  const fns: IrExpr[] = [];
  for (const impl of impls) {
    const fnName = `${name}.${impl.suffix}`;
    const params = impl.params.map((p) => ({ localId: p.id, name: p.id.split(".")[0]!, type: p.type }));
    L.liftedFns.push({
      name: fnName,
      params,
      returnType: impl.ret,
      captures: [cap],
      locals: [
        capLocal,
        ...impl.params.map((p) => ({ id: p.id, name: p.id.split(".")[0]!, type: p.type, mutable: true })),
        ...(impl.locals ?? []).map((l) => ({ id: l.id, name: l.id.split(".")[0]!, type: l.type, mutable: true })),
      ],
      body: impl.body,
      loc,
    });
    const fnT: IrType = { kind: "func", params: impl.params.map((p) => p.type), ret: impl.ret };
    fns.push({ kind: "jsMarshal", value: { kind: "closure", fnName, captures: ["x.0"], type: fnT, loc }, type: JSVAL, loc });
  }
  // The factory: the runtime class first (a subclass shows its own view),
  // then this class's own view.
  const body: IrStmt[] = [];
  if (L.undefSlots) {
    body.push({
      kind: "if",
      cond: isUndefExpr(x(), false, loc),
      then: [{ kind: "return", value: undef(loc), loc }],
      else_: null,
      loc,
    });
  }
  if (L.inHierarchy(info)) {
    for (const sub of subclassesOf(L, className)) {
      if (!viewableClass(L, { kind: "object", className: sub.def.name })) continue;
      const subT: IrType = { kind: "object", className: sub.def.name };
      body.push({
        kind: "if",
        cond: { kind: "instanceOf", value: x(), className: sub.def.name, type: BOOL, loc },
        then: [{ kind: "return", value: { kind: "call", callee: classViewFactory(L, sub.def.name, loc), args: [{ kind: "downcast", value: x(), type: subT, loc }], type: JSVAL, loc }, loc }],
        else_: null,
        loc,
      });
    }
  }
  body.push({ kind: "return", value: { kind: "jsView", value: x(), typeKey: typeKey(t), record: true, label, fns, type: JSVAL, loc }, loc });
  L.liftedFns.push({
    name,
    params: [{ localId: "x.0", name: "x", type: t }],
    returnType: JSVAL,
    locals: [capLocal],
    body,
    loc,
  });
  return name;
}
