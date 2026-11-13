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
import { BOOL, ERRV_PROBE, F64, JSVAL, STRING, VOID, typeEquals, typeKey, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/nodes.js";

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

/** `x.constructor.name` over a statically typed instance of a program class
 * (commander's `this.name = this.constructor.name`): the run-time class's
 * JS name — the instance's own class, tested deepest first. Null (the
 * existing lowering decides) for a class with no declaration, an instance
 * with its own `constructor` member, or a class in the family declaring a
 * static `name` (the constructor's name is then no class name). */
export function lowerConstructorName(L: Lowerer, recv: ts.Expression, loc: SrcLoc): IrExpr | null {
  const t = L.mapTypeOf(L.typeOf(recv));
  if (t?.kind !== "object") return null;
  const info = L.classes.get(t.className);
  if (!info || info.decl === null || info.generic !== undefined) return null;
  if (info.fields.has("constructor")) return null;
  if (info.def.staticNameOrLength === true) return null;
  const key = `cname:${info.def.name}`;
  let name = L.jsinHelpers.get(key);
  if (!name) {
    name = `%cname.${L.jsinHelpers.size}`;
    L.jsinHelpers.set(key, name);
    // the body waits for every class (finishConstructorNames): a subclass
    // registered later (a class expression) is a possible run-time class
    const fn: IrFunction = {
      name,
      params: [{ localId: "x.0", name: "x", type: t }],
      returnType: STRING,
      locals: [{ id: "x.0", name: "x", type: t, mutable: false }],
      body: [],
      loc,
    };
    L.liftedFns.push(fn);
    const pending = cnamePending.get(L) ?? [];
    pending.push({ fn, info, t, loc });
    cnamePending.set(L, pending);
  }
  return { kind: "call", callee: name, args: [L.lowerExpr(recv)], type: STRING, loc };
}

const cnamePending = new WeakMap<Lowerer, { fn: IrFunction; info: ClassInfo; t: IrType; loc: SrcLoc }[]>();

/** The `%cname` helpers' bodies, once every class is registered: the
 * instance's class tested deepest first, each answering its JS name. A
 * subclass declaring a static `name` (or `length`), or one with no
 * declaration, makes the helper stop by name instead. */
export function finishConstructorNames(L: Lowerer): void {
  for (const { fn, info, t, loc } of cnamePending.get(L) ?? []) {
    const subs = L.inHierarchy(info) ? subclassesOf(L, info.def.name) : [];
    const x = (): IrExpr => ({ kind: "varRef", localId: "x.0", type: t, loc });
    const body: IrStmt[] = [];
    for (const s of subs) {
      const answer: IrStmt[] = s.def.staticNameOrLength === true || s.decl === null
        ? [fence(`reading 'constructor.name' of an instance whose class declares a static 'name' or 'length' is not supported yet`, loc), { kind: "return", value: str("", loc), loc }]
        : [{ kind: "return", value: str(s.def.jsName ?? "", loc), loc }];
      body.push({ kind: "if", cond: { kind: "instanceOf", value: x(), className: s.def.name, type: BOOL, loc }, then: answer, else_: null, loc });
    }
    body.push({ kind: "return", value: str(info.def.jsName ?? "", loc), loc });
    fn.body = body;
  }
  cnamePending.delete(L);
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

/* ── GH #191: a user Error subclass's own members in its dynamic encoding ──
 *
 * An error crossing into a dynamic value becomes the `%error` encoding
 * (dyn.ts fromError). For an instance of a program's own `extends Error`
 * class the encoding MIRRORS the instance: its own keys are entries in
 * Node's order, values read live, writes go through to the typed fields.
 * Four program-wide helpers over any error answer for the classes here
 * (the backend calls them; 0 / undefined for every other error):
 *   - kind(e, k): 0 not the instance's, 1 an own property present, 2 one
 *     not yet present, 3 a prototype method or accessor, 4 an own property
 *     whose presence or place in a listing is unknown;
 *   - get(e, k): the member's value (a field lifted, a method bound to the
 *     instance, a getter's answer);
 *   - set(e, k, v): 1 when `k` is the instance's (a checked store into the
 *     field, a setter's call), 0 for any other key (an expando);
 *   - keys(e): the own keys present, in Node's order — an array, or
 *     undefined for an error none of these classes built.
 * Node's order (define semantics, measured under the top-10 loader and
 * `--experimental-transform-types`): per class, root first — parameter
 * properties, then every field declaration (present from construction,
 * undefined when uninitialized), then what the constructor's top level
 * assigns, in statement order. A key first assigned anywhere else (a
 * `declare` field, a method, a conditional) is "late": present once
 * assigned. */

interface ErrKey {
  name: string;
  late: boolean;
  /** A late key provably first assigned after construction (nowhere in a
   * constructor or field initializer of the chain, and no constructor lets
   * `this` escape): when present at the crossing it is the last own key. */
  afterCtor?: boolean;
}

/** Does `n` contain a `return` or `throw` (outside nested functions and
 * classes) — a statement after which a constructor may have left? */
function canLeave(n: ts.Node): boolean {
  let found = false;
  const visit = (x: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(x) || ts.isThrowStatement(x)) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(x) || (ts.isClassDeclaration(x) || ts.isClassExpression(x))) return;
    x.forEachChild(visit);
  };
  visit(n);
  return found;
}

/** Does constructor-time code `n` let `this` escape (a method call on it, a
 * `super.m()` call, `this` passed, stored or returned, or a read or write
 * of `this.<m>` where `m` is a method or accessor on the chain — a getter
 * or setter runs code) — so code outside the constructor may run before
 * construction ends? */
function thisEscapes(n: ts.Node, members: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (x: ts.Node): void => {
    if (found) return;
    if (x.kind === ts.SyntaxKind.ThisKeyword) {
      const p = x.parent;
      const member = p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === x;
      const called = member && p.parent !== undefined && ts.isCallExpression(p.parent) && p.parent.expression === p;
      if (!member || called || members.has(p.name.text)) found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(x) && x.expression.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    if (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || (ts.isClassDeclaration(x) || ts.isClassExpression(x))) return;
    x.forEachChild(visit);
  };
  visit(n);
  return found;
}

/** The keys an error class's instances own, in Node's order, or null when
 * one of them has no field this view can read. */
function errOwnKeys(info: ClassInfo): ErrKey[] | null {
  const out: ErrKey[] = [];
  const seen = new Set<string>();
  // the chain index of the class giving each static key; per class, where
  // its constructor's last top-level key assignment ends
  let ci = -1;
  let lastStaticClass = -1;
  const lastStaticEnd = new Map<number, number>();
  const add = (name: string, late: boolean): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, late });
    if (!late) lastStaticClass = Math.max(lastStaticClass, ci);
  };
  // a late key's constructor-time assignment sites: the one class whose
  // constructor body holds them all and the earliest, or "mixed" (several
  // constructors, a field initializer)
  const ctorSites = new Map<string, { ci: number; pos: number } | "mixed">();
  const nameOf = (nm: ts.PropertyName | undefined): string | undefined =>
    nm === undefined ? undefined : ts.isIdentifier(nm) || ts.isStringLiteralLike(nm) ? nm.text : undefined;
  const lateNames: string[] = [];
  // late keys some constructor-time code assigns, and whether any
  // constructor-time code lets `this` escape
  const ctorAssigned = new Set<string>();
  let escapes = false;
  // every method and accessor name on the chain (a read or write of one
  // through `this` during construction runs code)
  const members = new Set<string>();
  for (const c of chainOf(info)) {
    for (const key of c.methods.keys()) members.add(key.startsWith("get:") || key.startsWith("set:") ? key.slice(4) : key);
  }
  for (const c of chainOf(info)) {
    ci++;
    const decl = c.decl;
    if (decl === null) continue;
    const ctor = (decl.members as ts.NodeArray<ts.ClassElement>).find((m) => ts.isConstructorDeclaration(m)) as ts.ConstructorDeclaration | undefined;
    if (ctor?.body !== undefined && thisEscapes(ctor.body, members)) escapes = true;
    for (const m of decl.members as ts.NodeArray<ts.ClassElement>) {
      if (ts.isPropertyDeclaration(m) && m.initializer !== undefined && !(ts.getCombinedModifierFlags(m as unknown as ts.Declaration) & ts.ModifierFlags.Static) && thisEscapes(m.initializer, members)) escapes = true;
    }
    for (const p of ctor?.parameters ?? []) {
      const pf = ts.getCombinedModifierFlags(p);
      if ((pf & (ts.ModifierFlags.Public | ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Readonly)) && ts.isIdentifier(p.name)) add(p.name.text, false);
    }
    for (const m of decl.members as ts.NodeArray<ts.ClassElement>) {
      if (!ts.isPropertyDeclaration(m)) continue;
      const flags = ts.getCombinedModifierFlags(m as unknown as ts.Declaration);
      if (flags & (ts.ModifierFlags.Static | ts.ModifierFlags.Abstract)) continue;
      const n = nameOf(m.name);
      if (n === undefined) {
        if (ts.isPrivateIdentifier(m.name)) continue;
        return null;
      }
      if (flags & ts.ModifierFlags.Ambient) lateNames.push(n);
      else add(n, false);
    }
    const isThisAssign = (e: ts.Node, eqOnly: boolean): string | null => {
      if (!ts.isBinaryExpression(e)) return null;
      const op = e.operatorToken.kind;
      if (eqOnly ? op !== ts.SyntaxKind.EqualsToken : op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return null;
      const l = e.left;
      if (ts.isPropertyAccessExpression(l) && l.expression.kind === ts.SyntaxKind.ThisKeyword) return ts.isPrivateIdentifier(l.name) ? "%private" : l.name.text;
      if (ts.isElementAccessExpression(l) && l.expression.kind === ts.SyntaxKind.ThisKeyword) return "%computed";
      return null;
    };
    // The constructor's top-level `this.x = …` statements, up to the first
    // statement that can leave it (a `return` or `throw`): past that, an
    // assignment may not have run — late.
    const topLevel = new Set<ts.Node>();
    for (const st of ctor?.body?.statements ?? []) {
      if (canLeave(st)) break;
      if (!ts.isExpressionStatement(st)) continue;
      const n = isThisAssign(st.expression, true);
      if (n === null || n === "%private") continue;
      if (n === "%computed") return null;
      topLevel.add(st.expression);
      add(n, false);
      lastStaticEnd.set(ci, st.end);
    }
    // every other `this.x <op>= …` in the class body: late
    let computed = false;
    let inCtor = false;
    let inCtorBody = false;
    const visit = (n: ts.Node): void => {
      if (computed) return;
      if (!topLevel.has(n)) {
        const a = isThisAssign(n, false);
        if (a === "%computed") {
          computed = true;
          return;
        }
        if (a !== null && a !== "%private") {
          lateNames.push(a);
          if (inCtor) {
            ctorAssigned.add(a);
            const prev = ctorSites.get(a);
            if (!inCtorBody || prev === "mixed" || (prev !== undefined && prev.ci !== ci)) ctorSites.set(a, "mixed");
            else if (prev === undefined || n.pos < prev.pos) ctorSites.set(a, { ci, pos: n.pos });
          }
        }
      }
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) return;
      n.forEachChild(visit);
    };
    for (const m of decl.members as ts.NodeArray<ts.ClassElement>) {
      const flags = ts.canHaveModifiers(m) ? ts.getCombinedModifierFlags(m as unknown as ts.Declaration) : 0;
      if (flags & ts.ModifierFlags.Static) continue;
      inCtor = ts.isConstructorDeclaration(m) || ts.isPropertyDeclaration(m);
      inCtorBody = ts.isConstructorDeclaration(m);
      m.forEachChild(visit);
    }
    if (computed) return null;
    for (const f of c.fieldOrder) if (f.late === true) lateNames.push(f.name);
  }
  for (const n of lateNames) add(n, true);
  for (const k of out) {
    if (!k.late || escapes) continue;
    // provably the last own key: assigned only after construction, or only
    // in the constructor of the deepest class that gives keys, after that
    // constructor's last top-level key assignment
    const site = ctorSites.get(k.name);
    if (!ctorAssigned.has(k.name)) k.afterCtor = true;
    else if (site !== undefined && site !== "mixed" && site.ci >= lastStaticClass && site.pos >= (lastStaticEnd.get(site.ci) ?? -1)) k.afterCtor = true;
  }
  // every key must be a field the struct holds (name and message: errT's)
  for (const k of out) if (!info.fields.has(k.name)) return null;
  return out;
}

type ErrMember = { name: string; kind: "method" | "getter" | "setterOnly" | "unsupported" };

/** The prototype member names of an error class's chain (nearest first):
 * methods and getters it can answer, and the rest (setter-only accessors,
 * generator methods) by name. */
function errProtoMembers(info: ClassInfo): ErrMember[] {
  const out: ErrMember[] = [];
  const seen = new Set<string>();
  for (let c: ClassInfo | null = info; c && !c.builtinError; c = c.base) {
    const names = new Map<string, Set<string>>();
    for (const [key, sig] of c.methods) {
      if (key.includes("#") || key === "constructor") continue;
      const getter = key.startsWith("get:");
      const setter = key.startsWith("set:");
      const name = getter || setter ? key.slice(4) : key;
      const s = names.get(name) ?? new Set<string>();
      s.add(sig.gen !== undefined ? "gen" : getter ? "get" : setter ? "set" : "method");
      names.set(name, s);
    }
    for (const [name, s] of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, kind: s.has("gen") ? "unsupported" : s.has("method") ? "method" : s.has("get") ? "getter" : "setterOnly" });
    }
  }
  return out;
}

/** The user Error classes whose instances mirror into their encoding,
 * deepest first, each with its own keys. A class whose keys this view
 * cannot read is left out (its crossing keeps SEMANTICS.md S138's stop). */
function errViewClasses(L: Lowerer): { info: ClassInfo; keys: ErrKey[] }[] {
  const out: { info: ClassInfo; keys: ErrKey[]; depth: number }[] = [];
  for (const info of L.classes.values()) {
    // (an abstract class has no instances of its own: its concrete
    // subclasses, deeper, answer first)
    if (info.decl === null || info.builtinError || info.def.abstract === true || info.generic !== undefined) continue;
    let depth = 0;
    let isErr = false;
    for (let b = info.base; b; b = b.base) {
      depth++;
      if (b.builtinError) isErr = true;
    }
    if (!isErr) continue;
    const keys = errOwnKeys(info);
    if (keys === null) continue;
    out.push({ info, keys, depth });
  }
  return out.sort((a, b) => b.depth - a.depth);
}

/** GH #191, discovery (Lowerer.discover): the methods and accessors the
 * mirror helpers call, for every mirrored class something constructs —
 * their bodies are reachable through any error crossing. */
export function noteErrorViewEdges(L: Lowerer, reachable: ReadonlySet<string>): void {
  if (!L.sharedDynamic) return;
  for (const { info } of errViewClasses(L)) {
    if (!reachable.has(`%${info.def.name}.constructor`)) continue;
    for (const m of errProtoMembers(info)) {
      for (const key of [m.name, `get:${m.name}`, `set:${m.name}`]) {
        if (L.findMethodOn(info, key)) L.noteVirtualEdge(info, key);
      }
    }
  }
}

/** GH #191: builds the four helpers (see above) and marks each class they
 * cover (IrClassDef.errView); null when the program has no such class. */
export function buildErrorViews(L: Lowerer): { kind: string; get: string; set: string; keys: string } | null {
  if (!L.sharedDynamic) return null;
  const classes = errViewClasses(L);
  if (classes.length === 0) return null;
  const root = [...L.classes.values()].find((c) => c.builtinError && c.base === null);
  if (root === undefined) return null;
  const loc = classes[0]!.info.def.loc;
  const rootT: IrType = { kind: "object", className: root.def.name };
  const e = (): IrExpr => ({ kind: "varRef", localId: "e.0", type: rootT, loc });
  const k = (): IrExpr => ({ kind: "varRef", localId: "k.0", type: STRING, loc });
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: JSVAL, loc });
  const keyIs = (n: string): IrExpr => ({ kind: "strEq", negated: false, left: k(), right: str(n, loc), type: BOOL, loc });
  const num = (n: number): IrExpr => ({ kind: "numLit", value: n, type: F64, loc });
  const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });
  const iff = (cond: IrExpr, then: IrStmt[]): IrStmt => ({ kind: "if", cond, then, else_: null, loc });
  const names = { kind: "%errv.kind", get: "%errv.get", set: "%errv.set", keys: "%errv.keys" };
  type Op = keyof typeof names;
  type Local = { id: string; name: string; type: IrType; mutable: boolean; boxed?: true };
  const bodies: Record<Op, IrStmt[]> = { kind: [], get: [], set: [], keys: [] };
  const locals: Record<Op, Local[]> = { kind: [], get: [], set: [], keys: [] };
  classes.forEach(({ info, keys }, ci) => {
    const t: IrType = { kind: "object", className: info.def.name };
    const label = info.def.name.replace(/^%m\d+\./, "").replace(/^%/, "");
    const xid = `x.${ci}`;
    const x = (): IrExpr => ({ kind: "varRef", localId: xid, type: t, loc });
    const cap = { localId: xid, name: "x", type: t };
    const capLocal = { id: xid, name: "x", type: t, mutable: false as const, boxed: true as const };
    const enter = (op: Op, inner: IrStmt[]): void => {
      locals[op].push(capLocal);
      bodies[op].push(iff({ kind: "instanceOf", value: e(), className: info.def.name, type: BOOL, loc }, [
        { kind: "varDecl", localId: xid, init: { kind: "downcast", value: e(), type: t, loc }, loc },
        ...inner,
      ]));
    };
    const fieldRead = (name: string): IrExpr => ({ kind: "fieldGet", obj: x(), className: info.def.name, field: name, type: info.fields.get(name)!, loc });
    const members = errProtoMembers(info).filter((m) => !keys.some((kk) => kk.name === m.name));
    const lateUnknown = (name: string): boolean => mayBeWrittenUndefined(L, name);
    // kind
    {
      const inner: IrStmt[] = [iff(keyIs(ERRV_PROBE), [ret(num(9))])];
      for (const key of keys) {
        if (key.name === "name" || key.name === "message") {
          // errT's own slots always hold a value: a late assignment's
          // presence is unknown; `message` is own (and enumerable) as
          // Node has it only depending on what super() was given.
          inner.push(iff(keyIs(key.name), [ret(num(key.late || key.name === "message" ? 4 : 1))]));
          continue;
        }
        if (!key.late) {
          inner.push(iff(keyIs(key.name), [ret(num(1))]));
          continue;
        }
        inner.push(iff(keyIs(key.name), [
          { kind: "if", cond: isUndefExpr(fieldRead(key.name), false, loc), then: [ret(num(lateUnknown(key.name) ? 4 : 2))], else_: [ret(num(1))], loc },
        ]));
      }
      // 5: a method — called through the value it runs; read as a value
      // (a function Node hands out unbound) it stops by name
      for (const m of members) inner.push(iff(keyIs(m.name), [ret(num(m.kind === "method" ? 5 : 3))]));
      inner.push(ret(num(0)));
      enter("kind", inner);
    }
    // get
    {
      const inner: IrStmt[] = [];
      for (const key of keys) inner.push(iff(keyIs(key.name), [ret(liftOut(L, fieldRead(key.name), loc))]));
      for (const m of members) {
        let stmts: IrStmt[];
        if (m.kind === "method" && L.findMethodOn(info, m.name)?.sig.abstract !== true) {
          stmts = [ret(boundMethodFn(L, `%errv.${ci}`, info, m.name, x, cap, capLocal, loc))];
        } else if (m.kind === "method") {
          stmts = [fence(`reading the method '${m.name}' of a '${label}' error held in a dynamic value is not supported yet`, loc), ret(undef(loc))];
        } else if (m.kind === "getter") {
          const call = methodCall(L, info, `get:${m.name}`, x(), [], loc);
          stmts = call === null
            ? [fence(`reading the accessor '${m.name}' of a '${label}' error held in a dynamic value is not supported yet`, loc), ret(undef(loc))]
            : [ret(liftOut(L, call, loc))];
        } else if (m.kind === "setterOnly") {
          stmts = [ret(undef(loc))];
        } else {
          stmts = [fence(`reading the generator method '${m.name}' of a '${label}' error held in a dynamic value is not supported yet`, loc), ret(undef(loc))];
        }
        inner.push(iff(keyIs(m.name), stmts));
      }
      inner.push(ret(undef(loc)));
      enter("get", inner);
    }
    // set
    {
      const inner: IrStmt[] = [];
      keys.forEach((key, j) => {
        if (key.name === "name" || key.name === "message") return; // the slots' own write-through
        const ft = info.fields.get(key.name)!;
        const conv = exitArg(L, v(), ft);
        const cid = `c.${ci}.${j}`;
        if (conv !== null) locals.set.push({ id: cid, name: "c", type: ft, mutable: true });
        inner.push(iff(keyIs(key.name), conv === null
          ? [fence(`storing into the '${key.name}' field ('${L.fmt(ft)}') of a '${label}' error from dynamic code is not supported yet`, loc), ret(num(1))]
          : [
            { kind: "varDecl", localId: cid, init: conv, loc },
            { kind: "fieldSet", obj: x(), className: info.def.name, field: key.name, value: { kind: "varRef", localId: cid, type: ft, loc }, loc },
            ret(num(1)),
          ]));
      });
      for (const m of members) {
        const setter = L.findMethodOn(info, `set:${m.name}`);
        if (setter && setter.sig.params.length === 1) {
          const a = exitArg(L, v(), setter.sig.params[0]!.type);
          const call = a === null ? null : methodCall(L, info, `set:${m.name}`, x(), [a], loc);
          if (call !== null) {
            inner.push(iff(keyIs(m.name), [{ kind: "exprStmt", expr: call, loc }, ret(num(1))]));
            continue;
          }
        }
        inner.push(iff(keyIs(m.name), [fence(`assigning '${m.name}' (a method or accessor of its class) on a '${label}' error held in a dynamic value is not supported yet`, loc), ret(num(1))]));
      }
      inner.push(ret(num(0)));
      enter("set", inner);
    }
    // keys
    {
      const oid = `o.${ci}`;
      const nid = `n.${ci}`;
      const o = (): IrExpr => ({ kind: "varRef", localId: oid, type: JSVAL, loc });
      const n = (): IrExpr => ({ kind: "varRef", localId: nid, type: F64, loc });
      locals.keys.push({ id: oid, name: "o", type: JSVAL, mutable: true }, { id: nid, name: "n", type: F64, mutable: true });
      const push = (name: string): IrStmt => ({
        kind: "exprStmt",
        expr: { kind: "jsOp", op: "callMethod", name: "push", args: [o(), { kind: "jsMarshal", value: str(name, loc), type: JSVAL, loc }], type: JSVAL, loc },
        loc,
      });
      const inner: IrStmt[] = [
        { kind: "varDecl", localId: oid, init: { kind: "jsOp", op: "arrLit", args: [], type: JSVAL, loc }, loc },
        { kind: "varDecl", localId: nid, init: num(0), loc },
      ];
      for (const key of keys) {
        // `message`, and a late `name`: the encoding's own entry (kind 4)
        if (key.name === "message" || (key.name === "name" && key.late)) continue;
        if (!key.late) {
          inner.push(push(key.name));
          continue;
        }
        inner.push({
          kind: "if",
          cond: isUndefExpr(fieldRead(key.name), false, loc),
          then: lateUnknown(key.name)
            ? [fence(`an error of class '${label}' crossing into a dynamic value while its property '${key.name}' (first assigned outside the constructor's top level) holds undefined: whether it exists is unknown (SEMANTICS.md S138)`, loc)]
            : [],
          else_: key.afterCtor === true
            ? [
              push(key.name),
              { kind: "assign", localId: nid, value: { kind: "bin", op: "+", left: n(), right: num(1), type: F64, loc }, loc },
            ]
            : [fence(`an error of class '${label}' crossing into a dynamic value after its property '${key.name}' was assigned during construction where its place among the own properties is unknown (SEMANTICS.md S138)`, loc)],
          loc,
        });
      }
      inner.push(iff({ kind: "bin", op: ">=", left: n(), right: num(2), type: BOOL, loc }, [
        fence(`an error of class '${label}' crossing into a dynamic value with two or more properties first assigned outside the constructor's top level: their order is unknown (SEMANTICS.md S138)`, loc),
      ]));
      inner.push(ret(o()));
      enter("keys", inner);
    }
    info.def.errView = true;
  });
  bodies.kind.push(ret(num(0)));
  bodies.get.push(ret(undef(loc)));
  bodies.set.push(ret(num(0)));
  bodies.keys.push(ret(undef(loc)));
  const ek = [{ localId: "e.0", name: "e", type: rootT }, { localId: "k.0", name: "k", type: STRING }];
  const sig: Record<Op, { params: { localId: string; name: string; type: IrType }[]; ret: IrType }> = {
    kind: { params: ek, ret: F64 },
    get: { params: ek, ret: JSVAL },
    set: { params: [...ek, { localId: "v.0", name: "v", type: JSVAL }], ret: F64 },
    keys: { params: [ek[0]!], ret: JSVAL },
  };
  for (const op of ["kind", "get", "set", "keys"] as const) {
    L.liftedFns.push({
      name: names[op],
      params: sig[op].params,
      returnType: sig[op].ret,
      locals: [...sig[op].params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })), ...locals[op]],
      body: bodies[op],
      loc,
    });
  }
  return names;
}
