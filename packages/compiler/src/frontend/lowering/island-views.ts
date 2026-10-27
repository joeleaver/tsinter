/* Unit H (boards #259/#268, Joe's ruling D2 as approved 2026-10-26):
 * typed composites and the island share, never copy, wherever the island
 * can hold the typed value itself (SEMANTICS.md S115).
 *
 * LIFTS — a typed array, tuple or record entering an `any` slot — become
 * live VIEWS: one island value per static value (jsView), whose reads box
 * the typed elements on access and whose writes store into the typed
 * storage after the declared-type check. The view's operations are
 * ordinary compiled functions built here, per static type, as closures over
 * the static value (len/get/set/truncate for arrays and tuples, keys/get/
 * set for records): every backend runs the same code; a backend only
 * supplies the container (a dyn VIEW kind on wasm, an engine Proxy on the
 * native lanes) and the identity rule (two views of one static value are
 * one island value).
 *
 * EXITS — an island value entering a typed composite slot — would have to
 * COPY (typed storage cannot be an engine value). They are allowed only
 * where the copy is unobservable because the island value is FRESH: built
 * right there and held by nothing else (`exitIsFresh`). Every other exit
 * is refused at compile time, by name (SC1090, the same text on every
 * lane). Inside a view's own set accessor an island value entering a
 * nested typed slot must BE a view of that slot's type (jsUnview — it
 * unwraps, no copy) or the write throws a named TypeError. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  BOOL, DYN, F64, JSVAL, STRING, VOID, arrayOf, canExitIslandToType, isUnitType, typeKey,
  type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc,
} from "../../ir/nodes.js";
import { UNSUPPORTED, type ScrDiagnostic } from "../../diagnostics/diagnostic.js";

/** Does a value of this IR type cross the island boundary as typed
 * storage (an array, a tuple or record, or a union carrying one)? */
export function isTypedComposite(L: Lowerer, t: IrType): boolean {
  if (t.kind === "array" || t.kind === "record") return true;
  if (t.kind === "union") {
    return (L.unions.get(t.unionId)?.arms ?? []).some((a) => a.kind === "array" || a.kind === "record");
  }
  return false;
}

/** A type as the unit-H messages spell it: a record's fields in their
 * DECLARATION order (the program's own spelling), optional ones with
 * `?`; everything else as the compiler's usual rendering. */
function fmtS(L: Lowerer, t: IrType): string {
  if (t.kind === "record") {
    const shape = L.shapes.get(t.shapeId);
    if (shape && !shape.tuple && !shape.fields.some((f) => f.name.startsWith("%"))) {
      const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
      const members = order
        .map((nm) => shape.fields.find((f) => f.name === nm))
        .filter((f): f is NonNullable<typeof f> => f !== undefined)
        .map((f) => {
          if (f.optional && f.type.kind === "union") {
            const arms = (L.unions.get(f.type.unionId)?.arms ?? []).filter((a) => a.kind !== "undefinedT");
            if (arms.length === 1) return `${f.name}?: ${L.fmt(arms[0]!)}`;
          }
          return `${f.name}${f.optional ? "?" : ""}: ${L.fmt(f.type)}`;
        });
      if (shape.indexValue) members.push(`[key: string]: ${L.fmt(shape.indexValue)}`);
      return members.length === 0 ? "{}" : `{ ${members.join("; ")} }`;
    }
  }
  return L.fmt(t);
}

const num = (value: number, loc: SrcLoc): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const str = (value: string, loc: SrcLoc): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string, type: IrType, loc: SrcLoc): IrExpr => ({ kind: "varRef", localId, type, loc });
const undef = (loc: SrcLoc): IrExpr => ({ kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc });
const throwStmt = (kind: 0 | 1 | 2, message: IrExpr, loc: SrcLoc): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "libCall", fn: "error.nodeThrow", args: [num(kind, loc), str("", loc), message], type: VOID, loc },
  loc,
});
const cat = (...parts: IrExpr[]): IrExpr =>
  parts.reduce((a, b) => ({ kind: "strConcat", left: a, right: b, type: STRING, loc: a.loc }));

/** The island value `v` (a jsval local) stored into a typed slot of type
 * `t`: the declared-type check, then the static value — or a named
 * TypeError (SEMANTICS.md S115 (b)). `what` renders the container. */
function convertIn(
  L: Lowerer,
  v: IrExpr,
  t: IrType,
  what: string,
  loc: SrcLoc,
  current: () => IrExpr,
): { stmts: IrStmt[]; value: IrExpr } {
  const tyOf: IrExpr = { kind: "jsOp", op: "typeof", args: [v], type: STRING, loc };
  const refuse = (expected: string): IrStmt =>
    throwStmt(1, cat(str("Cannot store ", loc), tyOf, str(` into ${what} shared from typed code (it holds ${expected} only — SEMANTICS.md S115)`, loc)), loc);
  const prim = (tag: string, expected: string, exitT: IrType): { stmts: IrStmt[]; value: IrExpr } => ({
    stmts: [{
      kind: "if",
      cond: { kind: "strEq", negated: true, left: tyOf, right: str(tag, loc), type: BOOL, loc },
      then: [refuse(expected)],
      else_: null,
      loc,
    }],
    value: { kind: "jsExit", value: v, type: exitT, loc },
  });
  if (t.kind === "f64") return prim("number", "numbers", F64);
  if (t.kind === "string") return prim("string", "strings", STRING);
  if (t.kind === "bool") return prim("boolean", "booleans", BOOL);
  if (t.kind === "dyn") return { stmts: [], value: { kind: "dynFromJsval", value: v, type: DYN, loc } };
  if (t.kind === "array" || t.kind === "record") {
    return {
      stmts: [],
      value: { kind: "jsUnview", value: v, typeKey: typeKey(t), what: `${what} (a '${fmtS(L, t)}' slot takes only a value shared from a typed '${fmtS(L, t)}')`, type: t, loc },
    };
  }
  if (
    isUnitType(t) ||
    (t.kind === "union" && !isTypedComposite(L, t) && L.boundaryExitSafe(t) &&
      canExitIslandToType(t, (id) => L.shapes.get(id), (id) => L.unions.get(id)))
  ) {
    return { stmts: [], value: { kind: "jsExit", value: v, type: t, loc } };
  }
  // No conversion: the write refuses by name; `current` (the slot's own
  // value, never reached) keeps the store well-typed.
  return {
    stmts: [throwStmt(1, str(`Cannot store into ${what} shared from typed code: a '${fmtS(L, t)}' slot cannot be written from dynamic code yet (SEMANTICS.md S115)`, loc), loc)],
    value: current(),
  };
}

/** The island value of a typed `e`: a view for composites, the ordinary
 * lift for everything else. */
function liftOut(L: Lowerer, e: IrExpr, loc: SrcLoc): IrExpr {
  return L.jsvalLiftExpr(e, loc);
}

/** The interned VIEW factory for static type `t` (an array, a tuple or a
 * record): `%view.<n>(x: t): jsval`. */
export function viewFactory(L: Lowerer, t: IrType, loc: SrcLoc, frozen = false): string {
  const key = `${frozen ? "viewfrozen" : "view"}:${typeKey(t)}`;
  const hit = L.jsinHelpers.get(key);
  if (hit) return hit;
  const name = `%view.${L.jsinHelpers.size}`;
  L.jsinHelpers.set(key, name);
  const shape = t.kind === "record" ? L.shapes.get(t.shapeId) : undefined;
  if (t.kind === "record" && !shape) throw new Error(`lowerer bug: view of unknown shape ${t.shapeId}`);
  const x = (): IrExpr => ref("x.0", t, loc);
  const cap = { localId: "x.0", name: "x", type: t };
  const capLocal = { id: "x.0", name: "x", type: t, mutable: false, boxed: true as const };
  const what = `a '${fmtS(L, t)}'`;
  const impls: { suffix: string; params: { id: string; type: IrType }[]; ret: IrType; locals?: { id: string; type: IrType }[]; body: IrStmt[] }[] = [];
  const arrayLike = t.kind === "array" || shape?.tuple === true;
  if (t.kind === "array") {
    const elem = t.elem;
    const len = (): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: x(), args: [], type: F64, loc });
    const i = ref("i.0", F64, loc);
    const n = ref("n.0", F64, loc);
    const v = ref("v.0", JSVAL, loc);
    const conv = convertIn(L, v, elem, `${what} element`, loc, () => ({ kind: "arrayGet", arr: x(), index: i, type: elem, loc }));
    impls.push({ suffix: "len", params: [], ret: F64, body: [{ kind: "return", value: len(), loc }] });
    impls.push({
      suffix: "get",
      params: [{ id: "i.0", type: F64 }],
      ret: JSVAL,
      body: [
        {
          kind: "if",
          cond: { kind: "bin", op: "<", left: i, right: len(), type: BOOL, loc },
          then: [{ kind: "return", value: liftOut(L, { kind: "arrayGet", arr: x(), index: i, type: elem, loc }, loc), loc }],
          else_: null,
          loc,
        },
        { kind: "return", value: undef(loc), loc },
      ],
    });
    impls.push({
      suffix: "set",
      params: [{ id: "i.0", type: F64 }, { id: "v.0", type: JSVAL }],
      ret: VOID,
      locals: [{ id: "c.0", type: elem }],
      body: [
        {
          kind: "if",
          cond: { kind: "bin", op: ">", left: i, right: len(), type: BOOL, loc },
          then: [throwStmt(0, str(`Writing past the end of ${what} shared from typed code would leave holes, which typed storage cannot hold (SEMANTICS.md S115)`, loc), loc)],
          else_: null,
          loc,
        },
        ...conv.stmts,
        { kind: "varDecl", localId: "c.0", init: conv.value, loc },
        {
          kind: "if",
          cond: { kind: "bin", op: "===", left: i, right: len(), type: BOOL, loc },
          then: [{ kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "push", receiver: x(), args: [ref("c.0", elem, loc)], type: F64, loc }, loc }],
          else_: [{ kind: "arraySet", arr: x(), index: i, value: ref("c.0", elem, loc), loc }],
          loc,
        },
      ],
    });
    impls.push({
      suffix: "trunc",
      params: [{ id: "n.0", type: F64 }],
      ret: VOID,
      body: [
        {
          kind: "if",
          cond: { kind: "bin", op: ">", left: n, right: len(), type: BOOL, loc },
          then: [throwStmt(0, str(`Growing the length of ${what} shared from typed code would leave holes, which typed storage cannot hold (SEMANTICS.md S115)`, loc), loc)],
          else_: null,
          loc,
        },
        {
          kind: "while",
          cond: { kind: "bin", op: ">", left: len(), right: n, type: BOOL, loc },
          body: [{ kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "pop", receiver: x(), args: [], type: elem, loc }, loc }],
          loc,
        },
      ],
    });
  } else if (shape?.tuple) {
    const arity = shape.fields.length;
    const i = ref("i.0", F64, loc);
    const v = ref("v.0", JSVAL, loc);
    impls.push({ suffix: "len", params: [], ret: F64, body: [{ kind: "return", value: num(arity, loc), loc }] });
    const getBody: IrStmt[] = shape.fields.map((f) => ({
      kind: "if",
      cond: { kind: "bin", op: "===", left: i, right: num(Number(f.name), loc), type: BOOL, loc },
      then: [{ kind: "return", value: liftOut(L, { kind: "recordGet", obj: x(), shapeId: shape.id, field: f.name, type: f.type, loc }, loc), loc }],
      else_: null,
      loc,
    }));
    getBody.push({ kind: "return", value: undef(loc), loc });
    impls.push({ suffix: "get", params: [{ id: "i.0", type: F64 }], ret: JSVAL, body: getBody });
    const setBody: IrStmt[] = [];
    const locals: { id: string; type: IrType }[] = [];
    shape.fields.forEach((f, k) => {
      const conv = convertIn(L, v, f.type, `${what} position ${f.name}`, loc, () => ({ kind: "recordGet", obj: x(), shapeId: shape.id, field: f.name, type: f.type, loc }));
      locals.push({ id: `c.${k}`, type: f.type });
      setBody.push({
        kind: "if",
        cond: { kind: "bin", op: "===", left: i, right: num(Number(f.name), loc), type: BOOL, loc },
        then: [
          ...conv.stmts,
          { kind: "varDecl", localId: `c.${k}`, init: conv.value, loc },
          { kind: "recordSet", obj: x(), shapeId: shape.id, field: f.name, value: ref(`c.${k}`, f.type, loc), loc },
          { kind: "return", value: null, loc },
        ],
        else_: null,
        loc,
      });
    });
    setBody.push(throwStmt(0, str(`${what} shared from typed code is a tuple: its length is fixed (SEMANTICS.md S115)`, loc), loc));
    impls.push({ suffix: "set", params: [{ id: "i.0", type: F64 }, { id: "v.0", type: JSVAL }], ret: VOID, locals, body: setBody });
    impls.push({
      suffix: "trunc",
      params: [{ id: "n.0", type: F64 }],
      ret: VOID,
      body: [{
        kind: "if",
        cond: { kind: "bin", op: "!==", left: ref("n.0", F64, loc), right: num(arity, loc), type: BOOL, loc },
        then: [throwStmt(0, str(`${what} shared from typed code is a tuple: its length is fixed (SEMANTICS.md S115)`, loc), loc)],
        else_: null,
        loc,
      }],
    });
  } else if (shape) {
    const fields = (shape.declaredOrder ?? shape.fields.map((f) => f.name))
      .map((n) => shape.fields.find((f) => f.name === n)!)
      .filter((f) => f !== undefined && !f.name.startsWith("%"));
    if (shape.fields.some((f) => f.name.startsWith("%"))) {
      throw new Error("lowerer bug: views of accessor-carrying records are refused before the factory");
    }
    const k = ref("k.0", STRING, loc);
    const v = ref("v.0", JSVAL, loc);
    const outT = JSVAL;
    // keys(): the own keys in declaration order (an optional field holding
    // undefined is not an own key — S091), then the overflow's.
    const keysBody: IrStmt[] = [{ kind: "varDecl", localId: "o.0", init: { kind: "jsOp", op: "arrLit", args: [], type: JSVAL, loc }, loc }];
    for (const f of fields) {
      const push: IrStmt = {
        kind: "exprStmt",
        expr: { kind: "jsOp", op: "callMethod", name: "push", args: [ref("o.0", outT, loc), { kind: "jsMarshal", value: str(f.name, loc), type: JSVAL, loc }], type: JSVAL, loc },
        loc,
      };
      const ft = f.type;
      const undefTag = ft.kind === "union" ? (L.unions.get(ft.unionId)?.arms ?? []).findIndex((a) => a.kind === "undefinedT") : -1;
      if (f.optional && ft.kind === "union" && undefTag >= 0) {
        keysBody.push({
          kind: "if",
          cond: {
            kind: "unionIsTag", unionId: ft.unionId, tag: undefTag, negated: true,
            value: { kind: "recordGet", obj: x(), shapeId: shape.id, field: f.name, type: ft, loc }, type: BOOL, loc,
          },
          then: [push],
          else_: null,
          loc,
        });
      } else {
        keysBody.push(push);
      }
    }
    const ksT = arrayOf(STRING);
    if (shape.indexValue) {
      keysBody.push(
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: x(), shapeId: shape.id, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "j.0", init: num(0, loc), loc },
          cond: {
            kind: "bin", op: "<", left: ref("j.0", F64, loc),
            right: { kind: "arrIntrinsic", method: "length", receiver: ref("ks.0", ksT, loc), args: [], type: F64, loc },
            type: BOOL, loc,
          },
          update: { kind: "assign", localId: "j.0", value: { kind: "bin", op: "+", left: ref("j.0", F64, loc), right: num(1, loc), type: F64, loc }, loc },
          body: [{
            kind: "exprStmt",
            expr: {
              kind: "jsOp", op: "callMethod", name: "push",
              args: [ref("o.0", outT, loc), { kind: "jsMarshal", value: { kind: "arrayGet", arr: ref("ks.0", ksT, loc), index: ref("j.0", F64, loc), type: STRING, loc }, type: JSVAL, loc }],
              type: JSVAL, loc,
            },
            loc,
          }],
          loc,
        },
      );
    }
    keysBody.push({ kind: "return", value: ref("o.0", outT, loc), loc });
    impls.push({
      suffix: "keys",
      params: [],
      ret: JSVAL,
      locals: [{ id: "o.0", type: JSVAL }, ...(shape.indexValue ? [{ id: "ks.0", type: ksT }, { id: "j.0", type: F64 }] : [])],
      body: keysBody,
    });
    // An overflow key test: the loop over the overflow keys (no declared
    // name reaches it).
    const ovfHas = (): IrStmt[] => [
      { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: x(), shapeId: shape.id, type: ksT, loc }, loc },
      { kind: "varDecl", localId: "h.0", init: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
      {
        kind: "for",
        init: { kind: "varDecl", localId: "j.0", init: num(0, loc), loc },
        cond: {
          kind: "bin", op: "<", left: ref("j.0", F64, loc),
          right: { kind: "arrIntrinsic", method: "length", receiver: ref("ks.0", ksT, loc), args: [], type: F64, loc },
          type: BOOL, loc,
        },
        update: { kind: "assign", localId: "j.0", value: { kind: "bin", op: "+", left: ref("j.0", F64, loc), right: num(1, loc), type: F64, loc }, loc },
        body: [{
          kind: "if",
          cond: { kind: "strEq", negated: false, left: { kind: "arrayGet", arr: ref("ks.0", ksT, loc), index: ref("j.0", F64, loc), type: STRING, loc }, right: k, type: BOOL, loc },
          then: [{ kind: "assign", localId: "h.0", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc }],
          else_: null,
          loc,
        }],
        loc,
      },
    ];
    const ovfLocals = shape.indexValue ? [{ id: "ks.0", type: ksT }, { id: "h.0", type: BOOL }, { id: "j.0", type: F64 }] : [];
    const getBody: IrStmt[] = fields.map((f) => ({
      kind: "if",
      cond: { kind: "strEq", negated: false, left: k, right: str(f.name, loc), type: BOOL, loc },
      then: [{ kind: "return", value: liftOut(L, { kind: "recordGet", obj: x(), shapeId: shape.id, field: f.name, type: f.type, loc }, loc), loc }],
      else_: null,
      loc,
    }));
    if (shape.indexValue) {
      getBody.push(...ovfHas(), {
        kind: "if",
        cond: ref("h.0", BOOL, loc),
        then: [{ kind: "return", value: liftOut(L, { kind: "recordKeyGet", obj: x(), shapeId: shape.id, key: k, overflowOnly: true, type: shape.indexValue, loc }, loc), loc }],
        else_: null,
        loc,
      });
    }
    getBody.push({ kind: "return", value: undef(loc), loc });
    impls.push({ suffix: "get", params: [{ id: "k.0", type: STRING }], ret: JSVAL, locals: ovfLocals, body: getBody });
    const setBody: IrStmt[] = [];
    const setLocals: { id: string; type: IrType }[] = [];
    fields.forEach((f, j) => {
      const conv = convertIn(L, v, f.type, `the '${f.name}' field of ${what}`, loc, () => ({ kind: "recordGet", obj: x(), shapeId: shape.id, field: f.name, type: f.type, loc }));
      setLocals.push({ id: `c.${j}`, type: f.type });
      setBody.push({
        kind: "if",
        cond: { kind: "strEq", negated: false, left: k, right: str(f.name, loc), type: BOOL, loc },
        then: [
          ...conv.stmts,
          { kind: "varDecl", localId: `c.${j}`, init: conv.value, loc },
          { kind: "recordSet", obj: x(), shapeId: shape.id, field: f.name, value: ref(`c.${j}`, f.type, loc), loc },
          { kind: "return", value: null, loc },
        ],
        else_: null,
        loc,
      });
    });
    if (shape.indexValue) {
      const ivT = shape.indexValue;
      const conv = convertIn(L, v, ivT, `an entry of ${what}`, loc, () => ({ kind: "recordKeyGet", obj: x(), shapeId: shape.id, key: k, overflowOnly: true, type: ivT, loc }));
      setLocals.push({ id: "c.ov", type: shape.indexValue });
      setBody.push(
        ...conv.stmts,
        { kind: "varDecl", localId: "c.ov", init: conv.value, loc },
        { kind: "recordKeySet", obj: x(), shapeId: shape.id, key: k, value: ref("c.ov", shape.indexValue, loc), overflowOnly: true, loc },
      );
    } else {
      setBody.push(throwStmt(1, cat(str("Cannot add property '", loc), k, str(`': ${what} shared from typed code has a fixed shape (SEMANTICS.md S115)`, loc)), loc));
    }
    impls.push({ suffix: "set", params: [{ id: "k.0", type: STRING }, { id: "v.0", type: JSVAL }], ret: VOID, locals: setLocals, body: setBody });
  }
  // A FROZEN array (a template literal's strings array — Object.freeze'd
  // in JS): every write throws V8's strict-mode texts.
  if (frozen && t.kind === "array") {
    const i = ref("i.0", F64, loc);
    const len = (): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: x(), args: [], type: F64, loc });
    const idx: IrExpr = { kind: "toString", operand: i, type: STRING, loc };
    for (const impl of impls) {
      if (impl.suffix === "set") {
        impl.locals = [];
        impl.body = [
          // Storing the value a slot already holds is the write-back of an
          // Array method that did not change it (the wasm lane's
          // snapshot): nothing to refuse.
          {
            kind: "if",
            cond: {
              kind: "logical", op: "&&",
              left: { kind: "bin", op: "<", left: i, right: len(), type: BOOL, loc },
              right: {
                kind: "jsOp", op: "eq", type: BOOL, loc,
                args: [ref("v.0", JSVAL, loc), liftOut(L, { kind: "arrayGet", arr: x(), index: i, type: t.elem, loc }, loc)],
              },
              type: BOOL, loc,
            },
            then: [{ kind: "return", value: null, loc }],
            else_: null,
            loc,
          },
          {
            kind: "if",
            cond: { kind: "bin", op: "<", left: i, right: len(), type: BOOL, loc },
            then: [throwStmt(1, cat(str("Cannot assign to read only property '", loc), idx, str("' of object '[object Array]'", loc)), loc)],
            else_: null,
            loc,
          },
          throwStmt(1, cat(str("Cannot add property ", loc), { kind: "toString", operand: i, type: STRING, loc }, str(", object is not extensible", loc)), loc),
        ];
      }
      if (impl.suffix === "trunc") {
        impl.body = [throwStmt(1, str("Cannot assign to read only property 'length' of object '[object Array]'", loc), loc)];
      }
    }
  }
  // The impl closures over the boxed capture, then the factory.
  const fns: IrExpr[] = [];
  for (const impl of impls) {
    const fnName = `${name}.${impl.suffix}`;
    const params = impl.params.map((p) => ({ localId: p.id, name: p.id.split(".")[0]!, type: p.type }));
    const fn: IrFunction = {
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
    };
    L.liftedFns.push(fn);
    const fnT: IrType = { kind: "func", params: impl.params.map((p) => p.type), ret: impl.ret };
    fns.push({ kind: "jsMarshal", value: { kind: "closure", fnName, captures: ["x.0"], type: fnT, loc }, type: JSVAL, loc });
  }
  L.liftedFns.push({
    name,
    params: [{ localId: "x.0", name: "x", type: t }],
    returnType: JSVAL,
    locals: [capLocal],
    body: [{
      kind: "return",
      value: { kind: "jsView", value: x(), typeKey: typeKey(t), record: !arrayLike, label: what, fns, type: JSVAL, loc },
      loc,
    }],
    loc,
  });
  return name;
}

/** The interned wrapper factory for a compiled function of type `ft`
 * (typed-composite result) crossing into the island:
 * `%viewret.<n>(f: ft): jsval` hands the island a host function calling
 * `f` and answering its result's VIEW — shared, as in Node. */
function viewResultFactory(L: Lowerer, ft: IrType & { kind: "func" }, loc: SrcLoc, shallow = false): string {
  const key = `${shallow ? "viewretsh" : "viewret"}:${typeKey(ft)}`;
  const hit = L.jsinHelpers.get(key);
  if (hit) return hit;
  const name = `%viewret.${L.jsinHelpers.size}`;
  L.jsinHelpers.set(key, name);
  const f = (): IrExpr => ref("f.0", ft, loc);
  const capLocal = { id: "f.0", name: "f", type: ft as IrType, mutable: false, boxed: true as const };
  const params = ft.params.map((t, i) => ({ localId: `p.${i}`, name: `p${i}`, type: t }));
  const implT: IrType = { kind: "func", params: ft.params, ret: JSVAL };
  L.liftedFns.push({
    name: `${name}.call`,
    params,
    returnType: JSVAL,
    captures: [{ localId: "f.0", name: "f", type: ft }],
    locals: [capLocal, ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true }))],
    body: [{
      kind: "return",
      value: (shallow && ft.ret.kind === "array" ? shallowArrayLift : (e: IrExpr, l: SrcLoc) => L.jsvalLiftExpr(e, l))(
        { kind: "callValue", callee: f(), args: params.map((p) => ref(p.localId, p.type, loc)), type: ft.ret, loc },
        loc,
        L,
      ),
      loc,
    }],
    loc,
  });
  // The wrapper forwards its arguments to `f`, whose parameters were
  // checked where `f` crossed: its own marshal needs no second check.
  const marshal: IrExpr = { kind: "jsMarshal", value: { kind: "closure", fnName: `${name}.call`, captures: ["f.0"], type: implT, loc }, type: JSVAL, loc };
  L.checkedHostMarshals.add(marshal);
  L.liftedFns.push({
    name,
    params: [{ localId: "f.0", name: "f", type: ft }],
    returnType: JSVAL,
    locals: [capLocal],
    body: [{ kind: "return", value: marshal, loc }],
    loc,
  });
  return name;
}

/** A FRESH typed array's island form: a fresh island array of its
 * elements' lifts (views for typed composites) — the container is not
 * shared with anything, the elements are. */
function shallowArrayLift(e: IrExpr, loc: SrcLoc, L?: Lowerer): IrExpr {
  const l = L!;
  if (e.type.kind !== "array") return l.jsvalLiftExpr(e, loc);
  const key = `shallow:${typeKey(e.type)}`;
  let name = l.jsinHelpers.get(key);
  if (!name) {
    name = `%shallow.${l.jsinHelpers.size}`;
    l.jsinHelpers.set(key, name);
    const at = e.type;
    const x = (): IrExpr => ref("x.0", at, loc);
    const o = (): IrExpr => ref("o.0", JSVAL, loc);
    const j = (): IrExpr => ref("j.0", F64, loc);
    l.liftedFns.push({
      name,
      params: [{ localId: "x.0", name: "x", type: at }],
      returnType: JSVAL,
      locals: [
        { id: "x.0", name: "x", type: at, mutable: false },
        { id: "o.0", name: "o", type: JSVAL, mutable: true },
        { id: "j.0", name: "j", type: F64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "o.0", init: { kind: "jsOp", op: "arrLit", args: [], type: JSVAL, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "j.0", init: num(0, loc), loc },
          cond: { kind: "bin", op: "<", left: j(), right: { kind: "arrIntrinsic", method: "length", receiver: x(), args: [], type: F64, loc }, type: BOOL, loc },
          update: { kind: "assign", localId: "j.0", value: { kind: "bin", op: "+", left: j(), right: num(1, loc), type: F64, loc }, loc },
          body: [{
            kind: "exprStmt",
            expr: {
              kind: "jsOp", op: "callMethod", name: "push",
              args: [o(), l.jsvalLiftExpr({ kind: "arrayGet", arr: x(), index: j(), type: at.elem, loc }, loc)],
              type: JSVAL, loc,
            },
            loc,
          }],
          loc,
        },
        { kind: "return", value: o(), loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [e], type: JSVAL, loc };
}

/** `e` (a typed array/tuple/record) as its island VIEW. */
export function viewOf(L: Lowerer, e: IrExpr, loc: SrcLoc, frozen = false): IrExpr {
  if (frozen && e.type.kind === "array") {
    return { kind: "call", callee: viewFactory(L, e.type, loc, true), args: [e], type: JSVAL, loc };
  }
  // A LITERAL lifted straight into an `any` slot is fresh — nothing else
  // holds it — so it is built as the island literal Node would build (no
  // type lock): its parts lift one by one, a nested literal the same way
  // and anything else as its view.
  const isUndef = (x: IrExpr): boolean =>
    (x.kind === "unitLit" && x.unit === "undefined") || (x.kind === "unionWrap" && isUndef(x.value));
  if (e.kind === "arrayLit" && !(e.spreads && e.spreads.length > 0)) {
    return { kind: "jsOp", op: "arrLit", args: e.elems.map((x) => L.jsvalLiftExpr(x, loc)), type: JSVAL, loc };
  }
  if (e.kind === "recordLit" && e.type.kind === "record" && e.fields.every((f) => !f.overflow && !f.drop && !f.name.startsWith("%"))) {
    const shape = L.shapes.get(e.type.shapeId);
    if (shape?.tuple) {
      return { kind: "jsOp", op: "arrLit", args: e.fields.map((f) => L.jsvalLiftExpr(f.value, loc)), type: JSVAL, loc };
    }
    if (shape && !shape.indexValue && !shape.fields.some((f) => f.name.startsWith("%"))) {
      const args: IrExpr[] = [];
      for (const f of e.fields) {
        if (isUndef(f.value)) continue;
        args.push({ kind: "jsMarshal", value: str(f.name, loc), type: JSVAL, loc }, L.jsvalLiftExpr(f.value, loc));
      }
      return { kind: "jsOp", op: "objLit", args, type: JSVAL, loc };
    }
  }
  if (e.type.kind === "record") {
    const shape = L.shapes.get(e.type.shapeId);
    if (shape && shape.fields.some((f) => f.name.startsWith("%"))) {
      L.pushDiag(s115Diag(loc, `a typed record with accessors crossing into an 'any' slot cannot be shared with dynamic code yet (SEMANTICS.md S115)`));
    }
  }
  return { kind: "call", callee: viewFactory(L, e.type, loc), args: [e], type: JSVAL, loc };
}

/* ── exits: the FRESH rule ───────────────────────────────────────────── */

const ARRAY_BUILDERS = new Set([
  "map", "filter", "slice", "concat", "flat", "flatMap", "toSorted", "toReversed", "toSpliced", "with",
]);
const RECEIVER_RETURNING = new Set(["sort", "reverse", "fill", "copyWithin"]);

function unwrapTs(e: ts.Expression): ts.Expression {
  let n = e;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) {
    n = n.expression;
  }
  return n;
}

/** The composite parts of `t` whose ELEMENTS / FIELDS are themselves
 * typed composites (a copy of their container would share them). */
function partsShared(L: Lowerer, t: IrType): boolean {
  if (t.kind === "array") return isTypedComposite(L, t.elem);
  if (t.kind === "record") {
    const s = L.shapes.get(t.shapeId);
    return !s || s.fields.some((f) => isTypedComposite(L, f.type)) || (s.indexValue !== undefined && isTypedComposite(L, s.indexValue));
  }
  if (t.kind === "union") return (L.unions.get(t.unionId)?.arms ?? []).some((a) => partsShared(L, a));
  return false;
}

function elemType(L: Lowerer, t: IrType): IrType | null {
  if (t.kind === "array") return t.elem;
  if (t.kind === "union") {
    const arms = (L.unions.get(t.unionId)?.arms ?? []).filter((a) => a.kind === "array");
    return arms.length === 1 ? (arms[0] as IrType & { kind: "array" }).elem : null;
  }
  return null;
}

function fieldType(L: Lowerer, t: IrType, name: string): IrType | null {
  const recs = t.kind === "record" ? [t] : t.kind === "union" ? (L.unions.get(t.unionId)?.arms ?? []).filter((a) => a.kind === "record") : [];
  if (recs.length !== 1) return null;
  const s = L.shapes.get((recs[0] as IrType & { kind: "record" }).shapeId);
  const f = s?.fields.find((x) => x.name === name);
  return f ? f.type : s?.indexValue ?? null;
}

/* Freshness is proven by PROVENANCE, never by spelling (surfaces.ts's
 * rule): a callee counts only when its resolved symbol is the standard
 * library's own, on a receiver whose static type is the builtin itself,
 * and a user function only when it cannot be replaced or overridden. */

/** Every declaration of `sym` is the standard library's (a user
 * declaration MERGING with a lib global — a script-scope
 * `function structuredClone` — disqualifies it). */
function pureStd(L: Lowerer, sym: ts.Symbol | undefined): boolean {
  if (!sym) return false;
  const decls = L.checker.declarationsOf(sym);
  return decls.length > 0 && decls.some((d) => L.isStdlibFile(d.getSourceFile())) && decls.every((d) =>
    L.isStdlibFile(d.getSourceFile()) || d.getSourceFile().isDeclarationFile ||
    !((ts.isFunctionDeclaration(d) && d.body !== undefined) || (ts.isVariableDeclaration(d) && d.initializer !== undefined) ||
      ts.isClassDeclaration(d) || ts.isMethodDeclaration(d)));
}

/** `<obj>.<member>(...)` where `<obj>` IS the standard-library global. */
function isStdCall(L: Lowerer, e: ts.CallExpression, obj: string, member: string): boolean {
  const c = e.expression;
  return ts.isPropertyAccessExpression(c) && L.stdlibGlobalMember(c, obj) === member &&
    pureStd(L, L.checker.getSymbolAtLocation(c.name));
}

/** A method call whose resolved method symbol is the standard library's
 * own declaration (not an own property, an override or a user type's). */
function stdMethod(L: Lowerer, callee: ts.PropertyAccessExpression): boolean {
  return !callee.questionDotToken && pureStd(L, L.checker.getSymbolAtLocation(callee.name));
}

/** The receiver's static type is the builtin Array (or a tuple) itself —
 * never `any`, never a user subclass. */
function builtinArrayReceiver(L: Lowerer, e: ts.Expression): boolean {
  const t = L.typeOf(e);
  if ((t.flags & ts.TypeFlags.Any) !== 0) return false;
  return L.checker.isArrayType(t) || L.checker.isTupleType(t);
}

/** The user function a call can only ever reach — a function
 * declaration (TypeScript forbids reassigning one) or a `const` binding of
 * a function literal; never a method (overridable), a `let`, a
 * parameter, an async function or a generator. */
function fixedUserFunction(L: Lowerer, e: ts.CallExpression): ts.FunctionLikeDeclaration | null {
  if (!ts.isIdentifier(e.expression)) return null;
  const sym = L.resolveValueSymbol(e.expression);
  const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
  if (!decl || decl.getSourceFile().isDeclarationFile) return null;
  let fn: ts.FunctionLikeDeclaration | null = null;
  if (ts.isFunctionDeclaration(decl) && decl.body) fn = decl;
  else if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0) {
    const init = unwrapTs(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
  }
  if (!fn) return null;
  if ((ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  if ((fn as { asteriskToken?: unknown }).asteriskToken) return null;
  return fn;
}

/** Is the island value `node` evaluates to FRESH — built right here and
 * held by nothing else, at every level a copy into `t` would rebuild?
 * When in doubt: not fresh. */
export function exitIsFresh(L: Lowerer, node: ts.Expression, t: IrType, seen: Set<ts.Node> = new Set()): boolean {
  if (!isTypedComposite(L, t)) return true;
  const n = unwrapTs(node);
  if (seen.has(n)) return false;
  seen.add(n);
  if (ts.isCallExpression(n)) {
    if (n.questionDotToken) return false;
    if (isStdCall(L, n, "JSON", "parse") && n.arguments.length === 1) return true;
    if (ts.isIdentifier(n.expression) && L.isStdlibGlobal(n.expression, "structuredClone") &&
        pureStd(L, L.checker.getSymbolAtLocation(n.expression))) return true;
    if (isStdCall(L, n, "Object", "keys")) return true;
    // `Object.assign({}, ...sources)`: a fresh empty target taking the
    // sources' own members — fresh when no member is a typed composite.
    if (isStdCall(L, n, "Object", "assign") && n.arguments.length >= 1 && !partsShared(L, t)) {
      const target = unwrapTs(n.arguments[0]!);
      if (ts.isObjectLiteralExpression(target) && target.properties.length === 0) return true;
    }
    if (isStdCall(L, n, "Array", "from") || isStdCall(L, n, "Object", "values") || isStdCall(L, n, "Object", "entries")) {
      return n.arguments.length === 1 && !partsShared(L, t);
    }
    const callee = n.expression;
    if (ts.isPropertyAccessExpression(callee) && stdMethod(L, callee) && builtinArrayReceiver(L, callee.expression)) {
      const m = callee.name.text;
      if (ARRAY_BUILDERS.has(m)) {
        if (!partsShared(L, t)) return true;
        // A map whose literal callback returns fresh parts.
        const cb = n.arguments[0] ? unwrapTs(n.arguments[0]) : undefined;
        const et = elemType(L, t);
        if (m === "map" && cb && et && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          return returnsFresh(L, cb, et, seen);
        }
        return false;
      }
      // The in-place methods answer their receiver: fresh exactly when it
      // is (`xs.slice().sort(...)`).
      if (RECEIVER_RETURNING.has(m)) return exitIsFresh(L, callee.expression, t, seen);
      return false;
    }
    if (ts.isPropertyAccessExpression(callee) && stdMethod(L, callee) &&
        (callee.name.text === "split" || callee.name.text === "match") &&
        (L.typeOf(callee.expression).flags & ts.TypeFlags.StringLike) !== 0) {
      return true;
    }
    // A user function that cannot be replaced, every return of which is
    // fresh.
    const fn = fixedUserFunction(L, n);
    return fn !== null && returnsFresh(L, fn, t, seen);
  }
  if (ts.isArrayLiteralExpression(n)) {
    const et = elemType(L, t);
    return n.elements.every((el) => {
      if (ts.isOmittedExpression(el)) return true;
      if (ts.isSpreadElement(el)) return et !== null && !isTypedComposite(L, et);
      return et === null ? !isTypedComposite(L, L.mapTypeOf(L.typeOf(el)) ?? JSVAL) : exitIsFresh(L, el, et, seen);
    });
  }
  if (ts.isObjectLiteralExpression(n)) {
    return n.properties.every((p) => {
      if (ts.isPropertyAssignment(p)) {
        const ft = fieldType(L, t, p.name.getText().replace(/^["']|["']$/g, ""));
        return ft === null ? false : exitIsFresh(L, p.initializer, ft, seen);
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        const ft = fieldType(L, t, p.name.getText());
        return ft !== null && !isTypedComposite(L, ft);
      }
      if (ts.isSpreadAssignment(p)) return !partsShared(L, t);
      return false;
    });
  }
  // `await response.json()` on the standard library's own Response /
  // Request: a fresh parse of the body, like JSON.parse.
  if (ts.isAwaitExpression(n)) {
    const c = unwrapTs(n.expression);
    if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "json" &&
        stdMethod(L, c.expression)) {
      const recvSym = L.typeOf(c.expression.expression).getSymbol();
      if (pureStd(L, recvSym) && (recvSym!.name === "Response" || recvSym!.name === "Request")) return true;
    }
    return false;
  }
  if (ts.isConditionalExpression(n)) return exitIsFresh(L, n.whenTrue, t, seen) && exitIsFresh(L, n.whenFalse, t, seen);
  if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return exitIsFresh(L, n.left, t, seen) && exitIsFresh(L, n.right, t, seen);
  }
  return false;
}

/** Is the ARRAY `node` builds a fresh container (its elements may be
 * shared): a literal, or a standard Array-building method on a builtin
 * array. Lifted into the island, such a value is a fresh island array of
 * its elements' views — Node's own answer. */
function arrayContainerFresh(L: Lowerer, node: ts.Expression): boolean {
  const n = unwrapTs(node);
  if (ts.isArrayLiteralExpression(n)) return true;
  if (ts.isConditionalExpression(n)) return arrayContainerFresh(L, n.whenTrue) && arrayContainerFresh(L, n.whenFalse);
  if (!ts.isCallExpression(n) || n.questionDotToken) return false;
  if (isStdCall(L, n, "Array", "from") || isStdCall(L, n, "Object", "values")) return true;
  const callee = n.expression;
  if (ts.isPropertyAccessExpression(callee) && stdMethod(L, callee) && builtinArrayReceiver(L, callee.expression)) {
    if (ARRAY_BUILDERS.has(callee.name.text)) return true;
    if (RECEIVER_RETURNING.has(callee.name.text)) return arrayContainerFresh(L, callee.expression);
  }
  return false;
}

/** Every return of the array-returning function `fn` builds a fresh
 * container (arrayContainerFresh). */
export function fnReturnsFreshArray(fn: ts.Node, L: Lowerer): boolean {
  const body = (fn as { body?: ts.Node }).body;
  if (!body) return false;
  if (ts.isExpression(body)) return arrayContainerFresh(L, body);
  const rets: ts.Expression[] = [];
  let bare = false;
  const visit = (x: ts.Node): void => {
    if (ts.isFunctionLike(x)) return;
    if (ts.isReturnStatement(x)) {
      if (x.expression) rets.push(x.expression);
      else bare = true;
    }
    x.forEachChild(visit);
  };
  body.forEachChild(visit);
  return !bare && rets.length > 0 && rets.every((r) => arrayContainerFresh(L, r));
}

/** Every return of the function `fn` is fresh (exitIsFresh's rules). */
export function fnReturnsFresh(L: Lowerer, fn: ts.Node, t: IrType): boolean {
  return returnsFresh(L, fn, t, new Set());
}

function returnsFresh(L: Lowerer, fn: ts.Node, t: IrType, seen: Set<ts.Node>): boolean {
  const body = (fn as { body?: ts.Node }).body;
  if (!body) return false;
  if (ts.isExpression(body)) return exitIsFresh(L, body, t, seen);
  const rets: ts.Expression[] = [];
  let bare = false;
  const visit = (x: ts.Node): void => {
    if (ts.isFunctionLike(x)) return;
    if (ts.isReturnStatement(x)) {
      if (x.expression) rets.push(x.expression);
      else bare = true;
    }
    x.forEachChild(visit);
  };
  body.forEachChild(visit);
  return !bare && rets.length > 0 && rets.every((r) => exitIsFresh(L, r, t, seen));
}

/** Is `node` an island value whose typed copy is consumed on the spot by
 * a builtin that keeps only its ELEMENTS — the seed of `new Set(x)` /
 * `new Map(x)`, the source of `Array.from(x)` — with elements that are
 * not themselves typed composites? Nothing can then hold or see the copy. */
export function exitIsConsumedCopy(L: Lowerer, node: ts.Expression, t: IrType): boolean {
  if (partsShared(L, t)) return false;
  let n: ts.Node = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isNonNullExpression(n.parent))) n = n.parent;
  const p = n.parent;
  if (!p) return false;
  // `for (const x of <copy>)`: the loop reads the elements once.
  if (ts.isForOfStatement(p) && p.expression === n) return true;
  if (ts.isNewExpression(p) && p.arguments?.[0] === n &&
      (L.isStdlibGlobal(p.expression, "Set") || L.isStdlibGlobal(p.expression, "Map"))) {
    return true;
  }
  return ts.isCallExpression(p) && p.arguments[0] === n && isStdCall(L, p, "Array", "from");
}

/** Is the island value `node` evaluates to necessarily a VIEW of a static
 * value of exactly type `t` — so the exit UNWRAPS it (jsUnview, no copy)?
 * Two forms the compiler can see: a `const` binding (typed `any`)
 * initialized from a non-literal expression of static type `t` (`const
 * d: any = point; d as P`), and a member of one of the program's own
 * compiled modules whose declaration has type `t` (a dynamic import's
 * namespace member). The unwrap still checks at run time and throws the
 * named TypeError should a view of another type ever arrive. */
export function exitIsOwnView(L: Lowerer, node: ts.Expression, t: IrType): boolean {
  if (t.kind !== "array" && t.kind !== "record") return false;
  const n = unwrapTs(node);
  const want = typeKey(t);
  const sameStatic = (e: ts.Node): boolean => {
    const it = L.mapTypeOf(L.typeOf(e));
    return it !== null && it !== undefined && (it.kind === "array" || it.kind === "record") && typeKey(it) === want;
  };
  if (ts.isIdentifier(n)) {
    const sym = L.checker.getSymbolAtLocation(n);
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false;
    const init = unwrapTs(decl.initializer);
    if (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init)) return false;
    return sameStatic(init);
  }
  if (ts.isPropertyAccessExpression(n)) {
    const sym = L.checker.getSymbolAtLocation(n.name);
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (!decl || decl.getSourceFile().isDeclarationFile || !ts.isVariableDeclaration(decl)) return false;
    if (!ts.isSourceFile(decl.parent.parent.parent)) return false;
    return sameStatic(decl.name) && sameStatic(n);
  }
  return false;
}

/** The jsUnview `what` of an exit into a typed `t` slot. */
export const unviewWhat = (L: Lowerer, t: IrType): string =>
  `a '${fmtS(L, t)}' slot (it takes only a value shared from a typed '${fmtS(L, t)}')`;

/** Is `node` (lifted into an `any` slot) a template literal's strings
 * array — frozen in JS, so its view must refuse every write? */
export function isTemplateStrings(L: Lowerer, node: ts.Node): boolean {
  if (!ts.isExpression(node)) return false;
  return L.typeOf(node).getSymbol()?.name === "TemplateStringsArray";
}

/** A unit-H refusal: SC1090 carrying the full sentence (the generic
 * "is not supported yet" tail would garble it). */
export function s115Diag(loc: SrcLoc, message: string): ScrDiagnostic {
  return { code: "SC1090", message, loc, milestone: UNSUPPORTED["SC1090"]!.milestone };
}

export const exitRefusal = (L: Lowerer, t: IrType, what = "an 'any'"): string =>
  `${what} value flowing into a typed '${fmtS(L, t)}' slot: typed storage cannot hold an island value, so this would be a COPY, ` +
  `and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so both sides share one value, ` +
  `or copy explicitly where the copy is meant: [...x] or { ...x } (JSON.parse(JSON.stringify(x)) for nested data)`;

/* ── the post-pass ───────────────────────────────────────────────────── */

/** Over the finished function list: every remaining marshal of a typed
 * composite becomes its view, and every composite exit the lowering did
 * not prove fresh is refused (SC1090 at the exit's location). Runs to a
 * fixpoint — view factories lowered here may need factories of their
 * own. */
export function islandViewPass(L: Lowerer, functions: IrFunction[]): void {
  if (!L.dynamic) return;
  const done = new Set<IrFunction>();
  const reported = new Set<string>();
  const seenNodes = new WeakSet<object>();
  const rewrite = (node: Record<string, unknown>): Record<string, unknown> => {
    walk(node);
    const k = node["kind"];
    if (k === "jsMarshal") {
      const value = node["value"] as IrExpr;
      if (value.type.kind === "array" || value.type.kind === "record") {
        return viewOf(L, value, node["loc"] as SrcLoc) as unknown as Record<string, unknown>;
      }
      if (value.type.kind === "union" && isTypedComposite(L, value.type)) {
        const helper = L.unionToJsvalHelper(value.type.unionId, node["loc"] as SrcLoc);
        return { kind: "call", callee: helper, args: [value], type: JSVAL, loc: node["loc"] };
      }
      // A host function whose typed-composite parameter would take a copy
      // of each island argument refuses; one whose result the lowering did
      // not prove fresh hands the island that result's VIEW (a wrapper).
      if (value.type.kind === "func" && !L.checkedHostMarshals.has(node)) {
        const ft = value.type;
        const loc = node["loc"] as SrcLoc;
        if (ft.params.some((p) => isTypedComposite(L, p)) ||
            (ft.rest === true && isTypedComposite(L, ft.ret))) {
          L.pushDiag(s115Diag(loc,
            `a function crossing into dynamic code with a typed '${fmtS(L, ft)}' signature: its typed-composite parameters would receive COPIES of the dynamic arguments (SEMANTICS.md S115) — type them 'any' so they share the caller's values, or copy explicitly inside the function with [...x] / { ...x }`));
        } else if (isTypedComposite(L, ft.ret) && !L.checkedHostMarshals.has(node)) {
          const shallow = L.shallowHostMarshals.has(node);
          return { kind: "call", callee: viewResultFactory(L, ft, loc, shallow), args: [value], type: JSVAL, loc } as unknown as Record<string, unknown>;
        }
      }
    }
    if (k === "jsExit" && !node["fresh"] && isTypedComposite(L, node["type"] as IrType)) {
      const loc = node["loc"] as SrcLoc;
      const key = `${loc.file}:${loc.start}`;
      if (!reported.has(key)) {
        reported.add(key);
        L.pushDiag(s115Diag(loc, exitRefusal(L, node["type"] as IrType)));
      }
    }
    return node;
  };
  const walk = (node: Record<string, unknown>): void => {
    if (seenNodes.has(node)) return;
    seenNodes.add(node);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc") continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const item = v[i];
          if (item !== null && typeof item === "object") {
            if (typeof (item as { kind?: unknown }).kind === "string") v[i] = rewrite(item as Record<string, unknown>);
            else walk(item as Record<string, unknown>);
          }
        }
      } else if (v !== null && typeof v === "object") {
        if (typeof (v as { kind?: unknown }).kind === "string") node[key] = rewrite(v as Record<string, unknown>);
        else walk(v as Record<string, unknown>);
      }
    }
  };
  for (;;) {
    const before = L.liftedFns.length;
    for (const fn of [...functions, ...L.liftedFns]) {
      if (done.has(fn)) continue;
      done.add(fn);
      fn.body = fn.body.map((s) => rewrite(s as unknown as Record<string, unknown>) as unknown as IrStmt);
    }
    if (L.liftedFns.length === before) break;
  }
}
