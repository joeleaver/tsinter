/* Deep equality under Node's strict rules: assert.deepStrictEqual /
 * notDeepStrictEqual's structural comparison and util.isDeepStrictEqual's
 * verdict (lib/internal/util/comparisons.js, kStrict), synthesized per
 * static type. Split out of lower-assert.ts, which owns the assert
 * surface and calls in here. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { typeReachesItself } from "./lower-inspect.js";
import { recordFieldOwnTest } from "./lower-calls.js";
import { holeFenceStmt } from "./lower-exprs.js";
import { BOOL, F64, IrExpr, IrStmt, IrType, SrcLoc, VOID, accessorSlotProp, isOpaqueBuiltinShape, isUnitType, typeEquals, typeKey } from "../../ir/nodes.js";

/* ── deep equality (deepStrictEqual / notDeepStrictEqual) ──────────────── */

/** Why `t` has no honest deep comparison, or null when it lowers. The
 * fence names the FIRST unsupported constituent — never a silent
 * miscompare. Recursive record shapes terminate through `visiting`
 * (a shape being checked is assumed fine; its own walk decides). */
export function deepUnsupportedReason(L: Lowerer, t: IrType, visiting: Set<string>): string | null {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "undefinedT":
    case "nullT":
      return null;
    case "array":
      return deepUnsupportedReason(L, t.elem, visiting);
    case "record": {
      if (visiting.has(t.shapeId)) return null;
      visiting.add(t.shapeId);
      const shape = L.shapes.get(t.shapeId);
      if (!shape) return "this record shape has no deep comparison";
      // compared by class alone (deepEqHelper)
      if (isOpaqueBuiltinShape(shape)) return null;
      if (shape.indexValue !== undefined) {
        return "index-signature records have no deep comparison (their key sets are dynamic)";
      }
      for (const f of shape.fields) {
        const why = deepUnsupportedReason(L, f.type, visiting);
        if (why !== null) return why;
      }
      return null;
    }
    case "map": {
      const keyWhy = deepUnsupportedReason(L, t.key, visiting);
      if (keyWhy !== null) return keyWhy;
      return deepUnsupportedReason(L, t.value, visiting);
    }
    case "set":
      return t.elem.kind === "f64" || t.elem.kind === "string" || t.elem.kind === "bool"
        ? null
        : "Sets of non-scalar elements have no deep comparison (Node matches object members structurally)";
    case "union": {
      const def = L.unions.get(t.unionId);
      if (!def) return "this union has no deep comparison";
      for (const arm of def.arms) {
        const why = deepUnsupportedReason(L, arm, visiting);
        if (why !== null) return why;
      }
      return null;
    }
    case "func":
      // Node's deep equality over functions is reference identity (two
      // distinct functions are never deep-equal; the same reference is) —
      // a pointer compare carries it faithfully.
      return null;
    case "symbol":
      // Symbols deep-compare by identity (SameValue primitives) — the
      // pointer IS the identity.
      return null;
    case "bytes":
      // NESTED bytes (an array element, a record field): the Buffer-vs-
      // Uint8Array brand Node compares lives in the checker type of a
      // TOP-LEVEL argument only — no brand survives into shapes.
      return "typed arrays inside composites have no deep comparison (Node compares constructors, which the static element/field type does not carry)";
    case "object":
      return "class instances have no deep comparison (Node compares prototypes and own properties)";
    default:
      return `'${L.fmt(t)}' values have no deep comparison`;
  }
}

/** The interned per-type deep-equality helper `%assert.deq.<n>(a, b):
 * boolean` — Node's strict deep rules over the static type: Object.is
 * numbers, byte-equal strings, per-element arrays, per-field records,
 * tag+payload unions, SameValueZero-keyed Maps with deep values, scalar
 * Sets by membership. Registered in the cache BEFORE the body builds, so
 * recursive record shapes call themselves by name. */
export function deepEqHelper(L: Lowerer, t: IrType, loc: SrcLoc): string {
  const key = `assert.deq:${typeKey(t)}`;
  const existing = L.assertHelpers.get(key);
  if (existing) return existing;
  const name = `%assert.deq.${L.assertHelpers.size}`;
  L.assertHelpers.set(key, name);

  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const a = (): IrExpr => ref("a.0", t);
  const b = (): IrExpr => ref("b.0", t);
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const boolLit = (value: boolean): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
  const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
  const retFalse: IrStmt = ret(boolLit(false));
  const not = (operand: IrExpr): IrExpr => ({ kind: "unary", op: "!", operand, type: BOOL, loc });
  const neq = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "!==", left, right, type: BOOL, loc });
  /** if (cond) return false; */
  const bailIf = (cond: IrExpr): IrStmt => ({ kind: "if", cond, then: [retFalse], else_: null, loc });
  /** Deep-compare two same-typed exprs through the per-type helper. */
  const deq = (elemT: IrType, x: IrExpr, y: IrExpr): IrExpr =>
    isUnitType(elemT)
      ? boolLit(true)
      : { kind: "call", callee: deepEqHelper(L, elemT, loc), args: [x, y], type: BOOL, loc };

  let locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
    { id: "a.0", name: "a", type: t, mutable: false },
    { id: "b.0", name: "b", type: t, mutable: false },
  ];
  let body: IrStmt[];

  switch (t.kind) {
    case "f64":
      body = [ret({ kind: "libCall", fn: "assert.sameValue", args: [a(), b()], type: BOOL, loc })];
      break;
    case "string":
      body = [ret({ kind: "strEq", negated: false, left: a(), right: b(), type: BOOL, loc })];
      break;
    case "bool":
      body = [ret({ kind: "bin", op: "===", left: a(), right: b(), type: BOOL, loc })];
      break;
    case "func":
    case "symbol":
      // Reference identity — Node's deep equality over functions; a
      // symbol IS its pointer identity.
      body = [ret({ kind: "bin", op: "===", left: a(), right: b(), type: BOOL, loc })];
      break;
    case "array": {
      const len = (arr: IrExpr): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: arr, args: [], type: F64, loc });
      const at = (arr: IrExpr, i: IrExpr): IrExpr => ({ kind: "arrayGet", arr, index: i, type: t.elem, loc });
      locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
      body = [
        // Strict mode compares own keys, so a HOLE is not an undefined
        // element (`[, 1]` vs `[undefined, 1]` is false). This tier stores a
        // hole as the element's undefined: once the program has made a hole,
        // an array holding undefined stops at S119's named fence.
        ...(L.undefSlots ? [holeFenceStmt(a(), "a strict deep comparison", loc), holeFenceStmt(b(), "a strict deep comparison", loc)] : []),
        bailIf(neq(len(a()), len(b()))),
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: { kind: "bin", op: "<", left: ref("i.0", F64), right: len(a()), type: BOOL, loc },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: ref("i.0", F64), right: num(1), type: F64, loc }, loc },
          body: [bailIf(not(deq(t.elem, at(a(), ref("i.0", F64)), at(b(), ref("i.0", F64)))))],
          loc,
        },
        ret(boolLit(true)),
      ];
      break;
    }
    case "record": {
      const shape = L.shapes.get(t.shapeId);
      if (!shape) throw new Error(`assert deep-equal of unknown shape ${t.shapeId}`);
      // A WeakRef, Intl.DateTimeFormat or FinalizationRegistry: its state
      // lives in internal slots Node's comparison never reads, and it has
      // no own keys, so two of one class are always deep-equal.
      if (isOpaqueBuiltinShape(shape)) {
        body = [ret(boolLit(true))];
        break;
      }
      const get = (obj: IrExpr, field: string, type: IrType): IrExpr => ({ kind: "recordGet", obj, shapeId: t.shapeId, field, type, loc });
      body = [];
      // Strict mode compares own KEYS, not just values: an own key holding
      // undefined is not a missing key (`{ a: undefined }` vs `{}` is
      // false), so a field whose key can be absent compares its presence
      // first, as Object.hasOwn answers it. A tuple's positions are always
      // present.
      if (shape.tuple !== true) {
        for (const f of shape.fields) {
          if (f.internal === true || accessorSlotProp(f.name) !== null) continue;
          const pa = recordFieldOwnTest(L, a(), t.shapeId, f, loc);
          if (pa === null) continue;
          const pb = recordFieldOwnTest(L, b(), t.shapeId, f, loc)!;
          body.push(bailIf(neq(pa, pb)));
        }
      }
      for (const f of shape.fields) {
        if (isUnitType(f.type)) continue; // a unit field is equal by type
        body.push(bailIf(not(deq(f.type, get(a(), f.name, f.type), get(b(), f.name, f.type)))));
      }
      body.push(ret(boolLit(true)));
      break;
    }
    case "union": {
      const def = L.unions.get(t.unionId);
      if (!def) throw new Error(`assert deep-equal of unknown union ${t.unionId}`);
      const isTag = (v: IrExpr, tag: number, negated: boolean): IrExpr => ({ kind: "unionIsTag", unionId: t.unionId, tag, negated, value: v, type: BOOL, loc });
      const narrow = (v: IrExpr, tag: number, armT: IrType): IrExpr => ({ kind: "unionNarrow", unionId: t.unionId, tag, value: v, type: armT, loc });
      body = [];
      def.arms.forEach((arm, tag) => {
        body.push({
          kind: "if",
          cond: isTag(a(), tag, false),
          then: [
            bailIf(isTag(b(), tag, true)),
            ret(deq(arm, narrow(a(), tag, arm), narrow(b(), tag, arm))),
          ],
          else_: null,
          loc,
        });
      });
      body.push(retFalse); // unreachable: some arm always matches
      break;
    }
    case "map": {
      const mi = (method: "size" | "iterCount" | "iterLive" | "iterKey" | "iterValue" | "has" | "get", receiver: IrExpr, args: IrExpr[], type: IrType): IrExpr => ({ kind: "mapIntrinsic", method, receiver, args, type, loc });
      const valueT = t.value;
      const hasUndefArm =
        valueT.kind === "union" &&
        (L.unions.get(valueT.unionId)?.arms.some((arm) => arm.kind === "undefinedT") ?? false);
      const getT = hasUndefArm ? valueT : L.withUndefinedArm(valueT);
      locals.push(
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "k.0", name: "k", type: t.key, mutable: false },
        { id: "av.0", name: "av", type: valueT, mutable: false },
        { id: "bv.0", name: "bv", type: getT, mutable: false },
      );
      const i = (): IrExpr => ref("i.0", F64);
      const k = (): IrExpr => ref("k.0", t.key);
      // The b-side value: get() answers `V | undefined`; has() already
      // proved presence, so a plain V narrows through the value arm.
      const bValue: IrExpr =
        getT === valueT
          ? ref("bv.0", getT)
          : {
              kind: "unionNarrow",
              unionId: (getT as IrType & { kind: "union" }).unionId,
              tag: L.armTag((getT as IrType & { kind: "union" }).unionId, valueT),
              value: ref("bv.0", getT),
              type: valueT,
              loc,
            };
      body = [
        bailIf(neq(mi("size", a(), [], F64), mi("size", b(), [], F64))),
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: { kind: "bin", op: "<", left: i(), right: mi("iterCount", a(), [], F64), type: BOOL, loc },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: i(), right: num(1), type: F64, loc }, loc },
          body: [
            { kind: "if", cond: not(mi("iterLive", a(), [i()], BOOL)), then: [{ kind: "continue", loc }], else_: null, loc },
            { kind: "varDecl", localId: "k.0", init: mi("iterKey", a(), [i()], t.key), loc },
            bailIf(not(mi("has", b(), [k()], BOOL))),
            { kind: "varDecl", localId: "av.0", init: mi("iterValue", a(), [i()], valueT), loc },
            { kind: "varDecl", localId: "bv.0", init: mi("get", b(), [k()], getT), loc },
            bailIf(not(deq(valueT, ref("av.0", valueT), bValue))),
          ],
          loc,
        },
        ret(boolLit(true)),
      ];
      break;
    }
    case "set": {
      const si = (method: "size" | "iterCount" | "iterLive" | "iterKey" | "has", receiver: IrExpr, args: IrExpr[], type: IrType): IrExpr => ({ kind: "setIntrinsic", method, receiver, args, type, loc });
      locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
      const i = (): IrExpr => ref("i.0", F64);
      body = [
        bailIf(neq(si("size", a(), [], F64), si("size", b(), [], F64))),
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0), loc },
          cond: { kind: "bin", op: "<", left: i(), right: si("iterCount", a(), [], F64), type: BOOL, loc },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: i(), right: num(1), type: F64, loc }, loc },
          body: [
            { kind: "if", cond: not(si("iterLive", a(), [i()], BOOL)), then: [{ kind: "continue", loc }], else_: null, loc },
            bailIf(not(si("has", b(), [si("iterKey", a(), [i()], t.elem)], BOOL))),
          ],
          loc,
        },
        ret(boolLit(true)),
      ];
      break;
    }
    default:
      throw new Error(`assert deep-equal helper over unexpected type ${typeKey(t)}`);
  }

  // CYCLE-CAPABLE containers (recursive record types and their arrays/
  // maps) wrap the structural walk in the runtime CYCLE MEMO: identical
  // references are deep-equal without walking (Node's own val1===val2
  // shortcut, innerDeepEqual's first line), and deqEnter's 3-way
  // verdict decides the rest — Node's REAL two-phase memo
  // (lib/internal/util/comparisons.js handleCycles, lifted directly;
  // SEMANTICS.md S056 has the full measured record), not a simple
  // "this pair is already open" memo (undershoots: cannot tell a
  // genuine cycle-of-cycles match from two same-labeled cyclic
  // structures of DIFFERENT period, where Node throws) and not a
  // single set-of-values rule applied from the first comparison either
  // (nodes.ts's own doc comment on "assert.deqEnter" has the full
  // phase table and the fix-round history). This wrapper's own shape —
  // enter, fast-return on a definitive verdict, else walk then leave —
  // is unchanged by that history; only deqEnter/deqLeave's internal
  // state machine carries the phases. The walk moves into a sibling
  // function; `name` becomes the memo wrapper every caller (recursion
  // included) enters through.
  if ((t.kind === "record" || t.kind === "array" || t.kind === "map") && typeReachesItself(L, t)) {
    const walkName = `${name}.walk`;
    L.liftedFns.push({
      name: walkName,
      params: [
        { localId: "a.0", name: "a", type: t },
        { localId: "b.0", name: "b", type: t },
      ],
      returnType: BOOL,
      locals,
      body,
      loc,
    });
    locals = [
      { id: "a.0", name: "a", type: t, mutable: false },
      { id: "b.0", name: "b", type: t, mutable: false },
      { id: "dq.0", name: "dq", type: F64, mutable: false },
      { id: "eq.0", name: "eq", type: BOOL, mutable: false },
    ];
    body = [
      { kind: "if", cond: { kind: "bin", op: "===", left: a(), right: b(), type: BOOL, loc }, then: [ret(boolLit(true))], else_: null, loc },
      {
        kind: "varDecl",
        localId: "dq.0",
        init: { kind: "libCall", fn: "assert.deqEnter", args: [a(), b()], type: F64, loc },
        loc,
      },
      {
        kind: "if",
        cond: { kind: "bin", op: "===", left: ref("dq.0", F64), right: num(1), type: BOOL, loc },
        then: [ret(boolLit(true))],
        else_: null,
        loc,
      },
      {
        kind: "if",
        cond: { kind: "bin", op: "===", left: ref("dq.0", F64), right: num(2), type: BOOL, loc },
        then: [ret(boolLit(false))],
        else_: null,
        loc,
      },
      { kind: "varDecl", localId: "eq.0", init: { kind: "call", callee: walkName, args: [a(), b()], type: BOOL, loc }, loc },
      { kind: "exprStmt", expr: { kind: "libCall", fn: "assert.deqLeave", args: [], type: VOID, loc }, loc },
      ret(ref("eq.0", BOOL)),
    ];
  }

  L.liftedFns.push({
    name,
    params: [
      { localId: "a.0", name: "a", type: t },
      { localId: "b.0", name: "b", type: t },
    ],
    returnType: BOOL,
    locals,
    body,
    loc,
  });
  return name;
}

/** `util.isDeepStrictEqual(a, b)` (paperclip's config store): the verdict
 * assert.deepStrictEqual computes — the same per-type structural
 * comparison under Node's strict rules (Object.is for numbers), over two
 * operands of ONE static type; anything the comparison cannot carry
 * faithfully refuses by name, as assert's own fence does. */
export function lowerIsDeepStrictEqualCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (expr.arguments.length !== 2 || expr.arguments.some((x) => ts.isSpreadElement(x))) {
    L.noLowering(`util.isDeepStrictEqual with ${expr.arguments.length} arguments`, expr);
  }
  const a = L.lowerExpr(expr.arguments[0]!);
  const b = L.lowerExpr(expr.arguments[1]!);
  if (!typeEquals(a.type, b.type)) {
    L.noLowering(
      `util.isDeepStrictEqual of '${L.fmt(a.type)}' and '${L.fmt(b.type)}' values`,
      expr,
      "deep equality lowers when both sides have the SAME static type",
    );
  }
  const unsupported = isUnitType(a.type) || a.type.kind === "dyn" || a.type.kind === "jsval"
    ? "dynamic and unit values have no static deep comparison here"
    : deepUnsupportedReason(L, a.type, new Set());
  if (unsupported !== null) L.noLowering(`util.isDeepStrictEqual of '${L.fmt(a.type)}' values`, expr, unsupported);
  return { kind: "call", callee: deepEqHelper(L, a.type, loc), args: [a, b], type: BOOL, loc };
}
