/* GH #132: a record's own-key ORDER, as V8 keeps it.
 *
 * Node orders an object's own keys by when each was created (integer-index
 * keys ascending first); a record here renders its shape's declared order
 * (SEMANTICS.md S041). The two agree for every record whose keys are
 * created in declared order — the FAST PATH, which costs nothing: such a
 * record carries no order (its order slot holds the array slot's undefined,
 * IR `recordOrder`), and every key surface walks the declared order under
 * the S091 key rule (an optional field is an own key while it does not hold
 * undefined). A second slot, the HIGH-WATER MARK (`recordOrder` with `hi`),
 * remembers the highest field number holding a key, so "does a later field
 * already have its key?" is one compare (computed by one scan the first
 * time it is asked, kept up to date by every fast-path write after).
 *
 * A record leaves the fast path the first time Node's order and the fast
 * path's part: an optional field gaining its key while a later field (in
 * the order-field numbering, ir/nodes.ts recordOrderFields) has one, an
 * explicit `undefined` stored into an optional field (Node keeps that key;
 * the S091 rule would drop it), a `delete`, an object literal whose spelling
 * is not the declared order (or that holds undefined in a field it spells,
 * or leaves out an optional dynamic field whose absence the slot cannot
 * hold), and every object spread. The record then stores its own keys as a
 * number[]: one presence flag per field, then the field numbers of its own
 * keys in creation order. Presence is one read, appending is one push.
 *
 * Every key surface asks `orderedFieldStmts` for its per-field walk: the
 * fast walk it always had, or — when the record carries an order — the same
 * per-field bodies driven by the stored field numbers through a balanced
 * dispatch (log n compares per key). All the code here is per SHAPE, never
 * per field: one write helper takes the field number.
 *
 * Scope: plain declared records (no tuples, no index signatures — S031 keeps
 * those) on the WasmGC lanes (`undefSlots`), the backend's `recordOrderSlot`
 * rule. */
import type { Lowerer } from "./lowerer.js";
import {
  BOOL, DYN, F64, STRING, VOID, arrayOf, isArrayIndexKey, isUnitType, recordOrderFields,
  type IrExpr, type IrFunction, type IrRecordShape, type IrStmt, type IrType, type SrcLoc,
} from "../../ir/nodes.js";

const NUMS: IrType = arrayOf(F64);
type Field = IrRecordShape["fields"][number];

const num = (value: number, loc: SrcLoc): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType, loc: SrcLoc): IrExpr => ({ kind: "varRef", localId, type, loc });
const isUndef = (e: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "isUndef", operand: e, type: BOOL, loc });
const not = (e: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "unary", op: "!", operand: e, type: BOOL, loc });
const or = (a: IrExpr, b: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "logical", op: "||", left: a, right: b, type: BOOL, loc });
const bin = (op: "<" | ">" | ">=" | "!==" | "===" | "+" | "-", left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr =>
  ({ kind: "bin", op, left, right, type: op === "+" || op === "-" ? F64 : BOOL, loc });
const ifThen = (cond: IrExpr, then: IrStmt[], loc: SrcLoc, else_: IrStmt[] | null = null): IrStmt => ({ kind: "if", cond, then, else_, loc });
const arrLen = (a: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc });
const push = (a: IrExpr, v: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "push", receiver: a, args: [v], type: F64, loc }, loc });
const at = (a: IrExpr, i: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "arrayGet", arr: a, index: i, type: F64, loc });
const setAt = (a: IrExpr, i: IrExpr, v: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "arraySet", arr: a, index: i, value: v, loc });
const assign = (localId: string, value: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "assign", localId, value, loc });
const decl = (localId: string, init: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "varDecl", localId, init, loc });
const ret = (value: IrExpr | null, loc: SrcLoc): IrStmt => ({ kind: "return", value, loc });
const whileLoop = (cond: IrExpr, body: IrStmt[], loc: SrcLoc): IrStmt => ({ kind: "while", cond, body, loc });

/** Can this field type be asked "do you hold undefined"? */
const testable = (t: IrType): boolean => !isUnitType(t) && t.kind !== "void" && t.kind !== "caught";

/** `read` (of a testable type) holds undefined. */
function undefTest(read: IrExpr, loc: SrcLoc): IrExpr {
  if (read.type.kind === "dyn") return { kind: "dynTest", test: "undefined", value: read, type: BOOL, loc };
  if (read.type.kind === "jsval") return { kind: "dynTest", test: "undefined", value: { kind: "dynFromJsval", value: read, type: DYN, loc }, type: BOOL, loc };
  return isUndef(read, loc);
}

/** The shape when its records may carry an order: the backend's slot rule
 * (a plain declared record with an optional field), on the WasmGC lanes,
 * every optional field testable for undefined. */
export function orderedShape(L: Lowerer, shapeId: string): IrRecordShape | null {
  if (!L.undefSlots) return null;
  const shape = L.shapes.get(shapeId);
  if (!shape || shape.tuple === true || shapeId.startsWith("%")) return null;
  const visible = shape.fields.filter((f) => f.internal !== true);
  // GH #227: a hybrid (declared fields AND an index signature) keeps an order
  // whether or not a field is optional — a literal spelling an added key
  // first, or a capture, already reorders it. Its markers stand for the
  // added keys.
  if (shape.indexValue !== undefined) {
    if (visible.length === 0) return null;
  } else if (!visible.some((f) => f.optional === true) && shape.literalKeys !== true) return null;
  if (visible.some((f) => f.name.startsWith("%get:") || f.name.startsWith("%set:"))) return null;
  if (visible.some((f) => f.optional === true && !testable(f.type))) return null;
  return shape;
}

/** The order-field numbering (ir/nodes.ts recordOrderFields). */
export function orderFields(shape: IrRecordShape): Field[] {
  return recordOrderFields(shape);
}

/** Back-compat name for the readers: the own-key fields, numbered. */
export const declaredFields = orderFields;

const getF = (o: IrExpr, shapeId: string, f: Field, loc: SrcLoc): IrExpr => ({ kind: "recordGet", obj: o, shapeId, field: f.name, type: f.type, loc });

/** The fast path's presence of `f` on `o` (the S091 key rule), or null for
 * an always-present (required) field. */
function fastPresent(f: Field, o: IrExpr, shapeId: string, loc: SrcLoc): IrExpr | null {
  if (f.optional !== true) return null;
  if (!testable(f.type)) return { kind: "boolLit", value: false, type: BOOL, loc };
  return not(undefTest(getF(o, shapeId, f, loc), loc), loc);
}

function lift(L: Lowerer, key: string, params: { id: string; type: IrType }[], locals: { id: string; type: IrType }[], retT: IrType, loc: SrcLoc, build: () => IrStmt[]): string {
  const hit = L.retagHelpers.get(key);
  if (hit !== undefined) return hit;
  const name = `%ord.${L.retagHelpers.size}`;
  L.retagHelpers.set(key, name);
  L.liftedFns.push({
    name,
    params: params.map((p) => ({ localId: p.id, name: p.id.split(".")[0]!, type: p.type })),
    returnType: retT,
    locals: [...params, ...locals].map((p) => ({ id: p.id, name: p.id.split(".")[0]!, type: p.type, mutable: true })),
    body: build(),
    loc,
  });
  return name;
}

const ordOf = (o: IrExpr, shapeId: string, loc: SrcLoc): IrExpr => ({ kind: "recordOrder", obj: o, shapeId, type: NUMS, loc });
const STRS: IrType = arrayOf(STRING);
/** GH #227: a hybrid record's non-index added keys, in insertion order —
 * what its order vector's markers (-1) stand for. */
export const namedKeysOf = (o: IrExpr, shapeId: string, loc: SrcLoc): IrExpr => ({ kind: "recordOvfKeys", obj: o, shapeId, part: "named", type: STRS, loc } as IrExpr);
const indexKeysOf = (o: IrExpr, shapeId: string, loc: SrcLoc): IrExpr => ({ kind: "recordOvfKeys", obj: o, shapeId, part: "index", type: STRS, loc } as IrExpr);
/** The order vector's marker for "the next non-index added key". */
const MARKER = -1;
/** May string `k` be an array-index key? (A leading digit: every index key
 * has one; the precise test is the overflow's own.) */
const digitLead = (k: IrExpr, loc: SrcLoc): IrExpr => {
  const c0: IrExpr = { kind: "strIntrinsic", method: "charCodeAt", receiver: k, args: [num(0, loc)], type: F64, loc } as IrExpr;
  return { kind: "logical", op: "&&", left: bin(">=", c0, num(48, loc), loc), right: bin("<", c0, num(58, loc), loc), type: BOOL, loc } as IrExpr;
};
const hiOf = (o: IrExpr, shapeId: string, loc: SrcLoc): IrExpr => ({ kind: "recordOrder", obj: o, shapeId, hi: true, type: F64, loc });
const setOrd = (o: IrExpr, shapeId: string, v: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "recordOrderSet", obj: o, shapeId, value: v, loc });
const setHi = (o: IrExpr, shapeId: string, v: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "recordOrderSet", obj: o, shapeId, value: v, hi: true, loc });

/** An order vector with every presence flag 0 and no keys. */
const emptyOrder = (n: number, loc: SrcLoc): IrExpr => ({ kind: "arrayLit", elems: Array.from({ length: n }, () => num(0, loc)), type: NUMS, loc });

/** Statements adding field number `i` (an f64 expression, re-readable) to
 * the order vector `a` (a pure read) when it is not an own key yet:
 * flagged and appended, or — for an integer-index field (`ix`, an f64 0/1
 * expression) — inserted among the leading integer keys in ascending
 * place. `c`/`j` name two F64 scratch locals. */
function addKey(n: number, a: IrExpr, i: IrExpr, ix: IrExpr, c: string, j: string, loc: SrcLoc): IrStmt[] {
  const cRef = ref(c, F64, loc);
  const jRef = ref(j, F64, loc);
  return [ifThen(bin("===", at(a, i, loc), num(0, loc), loc), [
    setAt(a, i, num(1, loc), loc),
    push(a, i, loc),
    ifThen(bin("!==", ix, num(0, loc), loc), [
      // Integer fields number first, ascending: the ones below i that are
      // own keys come before it.
      assign(c, num(0, loc), loc),
      assign(j, num(0, loc), loc),
      whileLoop(bin("<", jRef, i, loc), [
        assign(c, bin("+", cRef, at(a, jRef, loc), loc), loc),
        assign(j, bin("+", jRef, num(1, loc), loc), loc),
      ], loc),
      assign(c, bin("+", cRef, num(n, loc), loc), loc),
      assign(j, bin("-", arrLen(a, loc), num(1, loc), loc), loc),
      whileLoop(bin(">", jRef, cRef, loc), [
        setAt(a, jRef, at(a, bin("-", jRef, num(1, loc), loc), loc), loc),
        assign(j, bin("-", jRef, num(1, loc), loc), loc),
      ], loc),
      setAt(a, cRef, i, loc),
    ], loc),
  ], loc)];
}

/** `%ord.<n>(o) -> number[]`: the record's own keys as the fast path sees
 * them — what an order starts from. */
function materializeHelper(L: Lowerer, shape: IrRecordShape, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  return lift(L, `ord.mat:${shape.id}`, [{ id: "o.0", type: recT }], [{ id: "a.0", type: NUMS }, { id: "n.0", type: F64 }], NUMS, loc, () => {
    const o = ref("o.0", recT, loc);
    const a = ref("a.0", NUMS, loc);
    const fields = orderFields(shape);
    const body: IrStmt[] = [decl("a.0", emptyOrder(fields.length, loc), loc)];
    fields.forEach((f, i) => {
      const put = [setAt(a, num(i, loc), num(1, loc), loc), push(a, num(i, loc), loc)];
      const has = fastPresent(f, o, shape.id, loc);
      body.push(...(has === null ? put : [ifThen(has, put, loc)]));
    });
    if (shape.indexValue !== undefined) {
      // GH #227: the fast path lists every added key after the declared
      // fields — one marker each.
      body.push(
        decl("n.0", arrLen(namedKeysOf(o, shape.id, loc), loc), loc),
        whileLoop(bin(">", ref("n.0", F64, loc), num(0, loc), loc), [
          push(a, num(MARKER, loc), loc),
          assign("n.0", bin("-", ref("n.0", F64, loc), num(1, loc), loc), loc),
        ], loc),
      );
    }
    body.push(ret(a, loc));
    return body;
  });
}

/** `%ord.<n>(o) -> number`: the fast path's high-water mark, by one scan:
 * 2 + the highest non-index field number holding its key, else 1. */
function highHelper(L: Lowerer, shape: IrRecordShape, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  return lift(L, `ord.hi:${shape.id}`, [{ id: "o.0", type: recT }], [], F64, loc, () => {
    const o = ref("o.0", recT, loc);
    const body: IrStmt[] = [];
    const fields = orderFields(shape);
    for (let i = fields.length - 1; i >= 0; i--) {
      const f = fields[i]!;
      if (isArrayIndexKey(f.name)) break; // the integer fields number first
      const has = fastPresent(f, o, shape.id, loc);
      if (has === null) { body.push(ret(num(i + 2, loc), loc)); return body; }
      body.push(ifThen(has, [ret(num(i + 2, loc), loc)], loc));
    }
    body.push(ret(num(1, loc), loc));
    return body;
  });
}

/** `%ord.<n>(o, i, vUndef, fUndef, ix)`: the one write helper of a shape,
 * called BEFORE a write to optional field number `i` (`vUndef`: the value
 * is undefined; `fUndef`: the field holds undefined now; `ix`: it is an
 * integer-index field) — only off the in-order fast path (the caller's
 * inline test). */
function writeHelper(L: Lowerer, shape: IrRecordShape, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  const n = orderFields(shape).length;
  return lift(L, `ord.w:${shape.id}`,
    [{ id: "o.0", type: recT }, { id: "i.0", type: F64 }, { id: "u.0", type: BOOL }, { id: "f.0", type: BOOL }, { id: "x.0", type: F64 }],
    [{ id: "a.0", type: NUMS }, { id: "h.0", type: F64 }, { id: "c.0", type: F64 }, { id: "j.0", type: F64 }], VOID, loc, () => {
      const o = ref("o.0", recT, loc);
      const i = ref("i.0", F64, loc);
      const vUndef = ref("u.0", BOOL, loc);
      const fUndef = ref("f.0", BOOL, loc);
      const ix = ref("x.0", F64, loc);
      const a = ref("a.0", NUMS, loc);
      const h = ref("h.0", F64, loc);
      const mat: IrExpr = { kind: "call", callee: materializeHelper(L, shape, loc), args: [o], type: NUMS, loc };
      const leave: IrStmt[] = [assign("a.0", mat, loc), ...addKey(n, a, i, ix, "c.0", "j.0", loc), setOrd(o, shape.id, a, loc), ret(null, loc)];
      return [
        // Off the fast path: a key it lacks is added (a key it has keeps
        // its place, whatever the value).
        assign("a.0", ordOf(o, shape.id, loc), loc),
        ifThen(not(isUndef(a, loc), loc), [...addKey(n, a, i, ix, "c.0", "j.0", loc), ret(null, loc)], loc),
        // The field has its key (it holds a value): an explicit undefined
        // keeps it, which the fast path's rule would not.
        ifThen(not(fUndef, loc), [ifThen(vUndef, [setOrd(o, shape.id, mat, loc)], loc), ret(null, loc)], loc),
        // A new key holding undefined: only an order can show it.
        ifThen(vUndef, leave, loc),
        // A new integer key takes its ascending place: no order change.
        ifThen(bin("!==", ix, num(0, loc), loc), [ret(null, loc)], loc),
        // A new key: Node appends it — past every key there is now, which
        // the fast path matches only when no later field has one (and, on a
        // hybrid, no added key exists yet: GH #227).
        ...(shape.indexValue !== undefined
          ? [ifThen(bin(">", arrLen(namedKeysOf(o, shape.id, loc), loc), num(0, loc), loc), leave, loc)]
          : []),
        assign("h.0", hiOf(o, shape.id, loc), loc),
        ifThen(bin("===", h, num(0, loc), loc), [assign("h.0", { kind: "call", callee: highHelper(L, shape, loc), args: [o], type: F64, loc }, loc)], loc),
        ifThen(bin(">", h, bin("+", i, num(2, loc), loc), loc), leave, loc),
        setHi(o, shape.id, bin("+", i, num(2, loc), loc), loc),
      ];
    });
}

/** The statements that keep `o`'s order Node's around a write of `value`
 * to optional field `field` — empty when the shape keeps no order. `o` and
 * `value` must be pure (re-readable) reads. The inline test is the fast
 * path: a record carrying no order, whose field already holds a value,
 * written a value — the updating writes pay one slot read and two undefined
 * tests; filling a field calls the shape's one helper. */
export function orderNoteWrite(L: Lowerer, o: IrExpr, shapeId: string, field: string, value: IrExpr, loc: SrcLoc): IrStmt[] {
  const shape = orderedShape(L, shapeId);
  if (shape === null) return [];
  const fields = orderFields(shape);
  const i = fields.findIndex((x) => x.name === field);
  const f = fields[i];
  if (f === undefined) return [];
  // (#235 review) A REQUIRED field whose key a `delete` removed (the record
  // then carries an order without it) gets its key back, appended as Node
  // appends it; on the fast path every required key is present already.
  if (f.optional !== true) {
    const call: IrStmt = {
      kind: "exprStmt",
      expr: { kind: "call", callee: writeHelper(L, shape, loc), args: [o, num(i, loc), { kind: "boolLit", value: false, type: BOOL, loc }, { kind: "boolLit", value: false, type: BOOL, loc }, num(isArrayIndexKey(field) ? 1 : 0, loc)], type: VOID, loc },
      loc,
    };
    return [ifThen(not(isUndef(ordOf(o, shapeId, loc), loc), loc), [call], loc)];
  }
  const vUndef: IrExpr = isUnitType(value.type)
    ? { kind: "boolLit", value: value.type.kind === "undefinedT", type: BOOL, loc }
    : testable(value.type) ? undefTest(value, loc) : { kind: "boolLit", value: false, type: BOOL, loc };
  const fUndef = undefTest(getF(o, shapeId, f, loc), loc);
  const cond = or(or(not(isUndef(ordOf(o, shapeId, loc), loc), loc), fUndef, loc), vUndef, loc);
  const call: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "call", callee: writeHelper(L, shape, loc), args: [o, num(i, loc), vUndef, fUndef, num(isArrayIndexKey(field) ? 1 : 0, loc)], type: VOID, loc },
    loc,
  };
  return [ifThen(cond, [call], loc)];
}

/** (#235 review) After a run-time keyed write `o[k] = v` on an ordered
 * shape with no index signature (`k` a string, `o` and `k` pure reads): a
 * key a `delete` removed comes back, appended as Node appends it. Only an
 * ordered record can lack a declared key; on the fast path every required
 * key is present and an optional one takes the dot write's note. */
export function orderNoteKeyedWrite(L: Lowerer, o: IrExpr, shapeId: string, key: IrExpr, loc: SrcLoc): IrStmt[] {
  const shape = orderedShape(L, shapeId);
  if (shape === null || shape.indexValue !== undefined) return [];
  const fields = orderFields(shape);
  const recT: IrType = { kind: "record", shapeId };
  const n = fields.length;
  const helper = lift(L, `ord.kw:${shapeId}`, [{ id: "o.0", type: recT }, { id: "k.0", type: STRING }], [{ id: "a.0", type: NUMS }, { id: "c.0", type: F64 }, { id: "j.0", type: F64 }], VOID, loc, () => {
    const r = ref("o.0", recT, loc);
    const k = ref("k.0", STRING, loc);
    const a = ref("a.0", NUMS, loc);
    const body: IrStmt[] = [decl("a.0", ordOf(r, shapeId, loc), loc), ifThen(isUndef(a, loc), [ret(null, loc)], loc)];
    fields.forEach((f, i) => {
      const eq: IrExpr = { kind: "strEq", negated: false, left: k, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc } as IrExpr;
      body.push(ifThen(eq, [...addKey(n, a, num(i, loc), num(isArrayIndexKey(f.name) ? 1 : 0, loc), "c.0", "j.0", loc), ret(null, loc)], loc));
    });
    return body;
  });
  return [{ kind: "exprStmt", expr: { kind: "call", callee: helper, args: [o, key], type: VOID, loc }, loc }];
}

/** `delete o.field` on an ordered record (after the slot write): the key
 * leaves the order — on the fast path the record takes its remaining keys
 * as its order, so printing, which shows every field there, shows Node's. */
export function orderNoteDelete(L: Lowerer, o: IrExpr, shapeId: string, field: string, loc: SrcLoc): IrStmt[] {
  const shape = orderedShape(L, shapeId);
  if (shape === null) return [];
  const fields = orderFields(shape);
  const fi = fields.findIndex((x) => x.name === field);
  if (fi < 0) return [];
  const recT: IrType = { kind: "record", shapeId };
  const n = fields.length;
  const helper = lift(L, `ord.del:${shapeId}`, [{ id: "o.0", type: recT }, { id: "i.0", type: F64 }], [{ id: "a.0", type: NUMS }, { id: "k.0", type: F64 }], VOID, loc, () => {
    const r = ref("o.0", recT, loc);
    const i = ref("i.0", F64, loc);
    const a = ref("a.0", NUMS, loc);
    const k = ref("k.0", F64, loc);
    return [
      decl("a.0", ordOf(r, shapeId, loc), loc),
      // (#235 review) off the fast path for the first time: the record's
      // keys as the fast path sees them — a required field among them —
      // then the deleted key leaves below like any other.
      ifThen(isUndef(a, loc), [
        assign("a.0", { kind: "call", callee: materializeHelper(L, shape, loc), args: [r], type: NUMS, loc }, loc),
        setOrd(r, shapeId, a, loc),
      ], loc),
      ifThen(bin("===", at(a, i, loc), num(0, loc), loc), [ret(null, loc)], loc),
      setAt(a, i, num(0, loc), loc),
      // find i among the keys, then close the gap
      decl("k.0", num(n, loc), loc),
      whileLoop(bin("!==", at(a, k, loc), i, loc), [assign("k.0", bin("+", k, num(1, loc), loc), loc)], loc),
      whileLoop(bin("<", k, bin("-", arrLen(a, loc), num(1, loc), loc), loc), [
        setAt(a, k, at(a, bin("+", k, num(1, loc), loc), loc), loc),
        assign("k.0", bin("+", k, num(1, loc), loc), loc),
      ], loc),
      { kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "pop", receiver: a, args: [], type: F64, loc }, loc },
    ];
  });
  return [{ kind: "exprStmt", expr: { kind: "call", callee: helper, args: [o, num(fi, loc)], type: VOID, loc }, loc }];
}

/** The order an object literal's own keys take when the literal spells
 * `names` in that order: integer keys ascending first, then as spelled. */
function spelledOrder(fields: Field[], names: string[]): number[] {
  const idx = names.map((n) => fields.findIndex((f) => f.name === n)).filter((i) => i >= 0);
  const seen = new Set<number>();
  const uniq = idx.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
  const ints = uniq.filter((i) => isArrayIndexKey(fields[i]!.name)).sort((a, b) => a - b);
  return [...ints, ...uniq.filter((i) => !isArrayIndexKey(fields[i]!.name))];
}

/** An object literal of an ordered shape spelling `names` (no spreads):
 * Node gives every spelled key its place in spelling order, an undefined
 * value included. The record takes the literal's order when the spelling
 * is not the fast path's (statically: a spelling out of declared order, or
 * an optional dynamic field left out), or when a spelled optional field in
 * `maybeUndef` holds undefined at run time. Answers `lit` itself, through
 * an interned `%ord.<n>(t) -> t`, or `lit` unchanged when nothing can need
 * it. */
export function orderNoteLiteral(L: Lowerer, lit: IrExpr, shapeId: string, names: string[], maybeUndef: string[], loc: SrcLoc): IrExpr {
  const shape = orderedShape(L, shapeId);
  if (shape === null) return lit;
  const fields = orderFields(shape);
  const order = spelledOrder(fields, names);
  const fastOrder = fields.map((_, i) => i).filter((i) => order.includes(i));
  const leftOutDyn = fields.some((f, i) => f.optional === true && (f.type.kind === "dyn" || f.type.kind === "jsval") && !order.includes(i));
  // GH #227: on a hybrid, a spelled added key (non-index) is a marker at its
  // first spelling; the fast path holds only while every declared key is
  // spelled before every added one.
  const seq: number[] = [...order];
  if (shape.indexValue !== undefined) {
    const firstAdded = names.findIndex((n) => !fields.some((f) => f.name === n) && !isArrayIndexKey(n));
    const seen = new Set<string>();
    const markers: { at: number }[] = [];
    names.forEach((n, k) => {
      if (fields.some((f) => f.name === n) || isArrayIndexKey(n) || seen.has(n)) return;
      seen.add(n);
      markers.push({ at: k });
    });
    if (firstAdded >= 0) {
      // rebuild the sequence in spelling order: declared field numbers (as
      // spelledOrder ranks them: index fields first) and markers
      const ints = order.filter((i) => isArrayIndexKey(fields[i]!.name));
      const rest: number[] = [];
      const placed = new Set<number>();
      const mset = new Set(markers.map((m) => m.at));
      names.forEach((n, k) => {
        const i = fields.findIndex((f) => f.name === n);
        if (i >= 0 && !isArrayIndexKey(n) && !placed.has(i)) {
          placed.add(i);
          rest.push(i);
        } else if (mset.has(k)) rest.push(MARKER);
      });
      seq.length = 0;
      seq.push(...ints, ...rest);
    }
  }
  const hybridReorders = seq.some((v, k) => v === MARKER && seq.slice(k + 1).some((x) => x !== MARKER)) ||
    (shape.indexValue !== undefined && names.some((n) => isArrayIndexKey(n) && !fields.some((f) => f.name === n)));
  const always = leftOutDyn || hybridReorders || order.some((v, k) => v !== fastOrder[k]);
  const tested = always ? [] : maybeUndef.map((nm) => fields.find((f) => f.name === nm)).filter((f): f is Field => f !== undefined && f.optional === true);
  if (!always && tested.length === 0) return lit;
  const recT: IrType = { kind: "record", shapeId };
  const vec: IrExpr = {
    kind: "arrayLit",
    elems: [...fields.map((_, i) => num(order.includes(i) ? 1 : 0, loc)), ...seq.map((i) => num(i, loc))],
    type: NUMS,
    loc,
  };
  const helper = lift(L, `ord.lit:${shapeId}:${seq.join(",")}:${always ? "*" : tested.map((f) => f.name).join(",")}`, [{ id: "t.0", type: recT }], [], recT, loc, () => {
    const t = ref("t.0", recT, loc);
    if (always) return [setOrd(t, shapeId, vec, loc), ret(t, loc)];
    const cond = tested.map((f) => undefTest(getF(t, shapeId, f, loc), loc)).reduce((x, y) => or(x, y, loc));
    return [ifThen(cond, [setOrd(t, shapeId, vec, loc)], loc), ret(t, loc)];
  });
  return { kind: "call", callee: helper, args: [lit], type: recT, loc };
}

/** An object literal with spreads (`{ ...o, k: v }`) of an ordered shape:
 * Node's result has the contributors' keys in contribution order — each
 * spread source's own keys in ITS order, each property's name — a key
 * keeping its first position, an undefined value included. The result
 * always takes that order (a spread copies anyway). Spread sources are
 * records (`shapeId`, a pure read); a source key the result shape lacks
 * drops, the spread's width rule. */
export type SpreadPart = { name: string } | { spread: IrExpr; shapeId: string; snap?: true };

export function orderNoteSpread(L: Lowerer, lit: IrExpr, shapeId: string, parts: SpreadPart[], loc: SrcLoc, fastSkip = false, risky: string[] = []): IrExpr {
  const shape = orderedShape(L, shapeId);
  if (shape === null) return lit;
  const fields = orderFields(shape);
  const n = fields.length;
  const recT: IrType = { kind: "record", shapeId };
  const spreads = parts.filter((x): x is { spread: IrExpr; shapeId: string; snap?: true } => "spread" in x);
  const params = [{ id: "t.0", type: recT }, ...spreads.map((x, k) => ({ id: `s${k}.0`, type: x.snap === true ? NUMS : { kind: "record", shapeId: x.shapeId } as IrType }))];
  const key = `ord.spr:${shapeId}:${parts.map((x) => ("name" in x ? x.name : `...${x.snap === true ? "#" : ""}${x.shapeId}`)).join(",")}${fastSkip ? `:skip:${risky.join(",")}` : ""}`;
  const helper = lift(L, key, params,
    [{ id: "a.0", type: NUMS }, { id: "ks.0", type: NUMS }, { id: "k.0", type: F64 }, { id: "v.0", type: F64 }, { id: "c.0", type: F64 }, { id: "j.0", type: F64 }], recT, loc, () => {
      const t = ref("t.0", recT, loc);
      const a = ref("a.0", NUMS, loc);
      const ks = ref("ks.0", NUMS, loc);
      const k = ref("k.0", F64, loc);
      const v = ref("v.0", F64, loc);
      const add = (i: number): IrStmt[] => addKey(n, a, num(i, loc), num(isArrayIndexKey(fields[i]!.name) ? 1 : 0, loc), "c.0", "j.0", loc);
      const body: IrStmt[] = [];
      if (fastSkip) {
        // every source on the fast path: the copy's fast path already
        // answers its keys in Node's order
        // (a copy's sources are records, never snapshots)
        const anyOrdered = spreads
          .map((x, k) => (orderedShape(L, x.shapeId) === null ? null : not(isUndef(ordOf(ref(`s${k}.0`, params[k + 1]!.type, loc), x.shapeId, loc), loc), loc)))
          .filter((e): e is IrExpr => e !== null);
        // a source field holding undefined that the copy makes optional:
        // only an order keeps its key
        for (const name of risky) {
          const srcShape = L.shapes.get(spreads[0]!.shapeId)!;
          const sf = srcShape.fields.find((f) => f.name === name);
          if (sf !== undefined && testable(sf.type)) anyOrdered.push(undefTest(getF(ref("s0.0", params[1]!.type, loc), spreads[0]!.shapeId, sf, loc), loc));
        }
        if (anyOrdered.length === 0) return [ret(t, loc)];
        body.push(ifThen(not(anyOrdered.reduce((x, y) => or(x, y, loc)), loc), [ret(t, loc)], loc));
      }
      body.push(decl("a.0", emptyOrder(n, loc), loc));
      let sj = 0;
      for (const part of parts) {
        if ("name" in part) {
          const i = fields.findIndex((f) => f.name === part.name);
          if (i >= 0) body.push(...add(i));
          continue;
        }
        const srcShape = L.shapes.get(part.shapeId)!;
        const srcFields = orderFields(srcShape);
        const src = ref(`s${sj}.0`, params[sj + 1]!.type, loc);
        const srcOrdered = part.snap === true || orderedShape(L, part.shapeId) !== null;
        // the source's keys: the snapshot taken at the spread, its order, or
        // the fast path's materialized
        if (srcOrdered) {
          body.push(
            ...(part.snap === true
              ? [assign("ks.0", src, loc)]
              : [
                  assign("ks.0", ordOf(src, part.shapeId, loc), loc),
                  ifThen(isUndef(ks, loc), [assign("ks.0", { kind: "call", callee: materializeHelper(L, srcShape, loc), args: [src], type: NUMS, loc }, loc)], loc),
                ]),
            assign("k.0", num(srcFields.length, loc), loc),
            whileLoop(bin("<", k, arrLen(ks, loc), loc), [
              assign("v.0", at(ks, k, loc), loc),
              assign("k.0", bin("+", k, num(1, loc), loc), loc),
              ifThen(bin(">=", v, num(0, loc), loc), dispatch(v, srcFields.length, (si) => {
                const ti = fields.findIndex((f) => f.name === srcFields[si]!.name);
                return ti >= 0 ? add(ti) : [];
              }, loc), loc),
            ], loc),
          );
        } else {
          // a source that keeps no order: its declared fields, S091 rule
          srcFields.forEach((sf) => {
            const ti = fields.findIndex((f) => f.name === sf.name);
            if (ti < 0) return;
            const has = fastPresent(sf, src, part.shapeId, loc);
            body.push(...(has === null ? add(ti) : [ifThen(has, add(ti), loc)]));
          });
        }
        sj++;
      }
      body.push(setOrd(t, shapeId, a, loc), ret(t, loc));
      return body;
    });
  return { kind: "call", callee: helper, args: [lit, ...spreads.map((x) => x.spread)], type: recT, loc };
}

/** The order snapshots spreads take at their own position (the spread's
 * AST node → the hidden local holding it), read by the literal's order note
 * (lower-exprs.ts withLiteralOrder): Node reads a spread source's own keys
 * where the spread stands, so a later property that deletes, adds or clears
 * one of them must not change the result. */
export const spreadSnapshots = new WeakMap<object, { snap: IrExpr; shapeId: string }>();

/** `%ord.<n>(o) -> number[]`: a copy of `o`'s own keys as an order vector —
 * its stored order, or the fast path's materialized (any record shape). */
function snapshotHelper(L: Lowerer, shape: IrRecordShape, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  const n = orderFields(shape).length;
  return lift(L, `ord.snap:${shape.id}`, [{ id: "o.0", type: recT }], [{ id: "a.0", type: NUMS }], NUMS, loc, () => {
    const o = ref("o.0", recT, loc);
    const a = ref("a.0", NUMS, loc);
    const mat: IrExpr = { kind: "call", callee: materializeHelper(L, shape, loc), args: [o], type: NUMS, loc };
    if (orderedShape(L, shape.id) === null) return [ret(mat, loc)];
    void n;
    return [
      decl("a.0", ordOf(o, shape.id, loc), loc),
      ifThen(not(isUndef(a, loc), loc), [ret({ kind: "arrIntrinsic", method: "slice", receiver: a, args: [num(0, loc)], type: NUMS, loc }, loc)], loc),
      ret(mat, loc),
    ];
  });
}

/** The recordLit entry that snapshots spread source `src` (a pure read of
 * shape `srcShapeId`) at the spread's own position, for a literal of
 * ordered shape `resultShapeId`: a dropped entry assigning the snapshot to
 * a hidden local, recorded under `node` for the literal's order note. Null
 * when the result keeps no order. */
export function spreadSnapshotEntry(L: Lowerer, node: object, src: IrExpr, srcShapeId: string, resultShapeId: string, loc: SrcLoc): { name: string; value: IrExpr; drop: true } | null {
  if (orderedShape(L, resultShapeId) === null) return null;
  const srcShape = L.shapes.get(srcShapeId);
  if (!srcShape || srcShape.tuple === true || srcShape.indexValue !== undefined) return null;
  const t = L.declareHiddenLocal("%ordsnap", NUMS);
  t.mutable = true; // assigned by the dropped entry, in place
  const snap: IrExpr = { kind: "call", callee: snapshotHelper(L, srcShape, loc), args: [src], type: NUMS, loc };
  spreadSnapshots.set(node, { snap: ref(t.id, NUMS, loc), shapeId: srcShapeId });
  return { name: `%ordsnap.${t.id}`, value: { kind: "assignExpr", localId: t.id, value: snap, type: NUMS, loc } as IrExpr, drop: true };
}

/** A width copy (`%rec.width`) of a record of shape `fromId` (`src`, a
 * pure read) into a fresh record of shape `toId` (`copy`): Node shares the
 * object, so the copy must answer the source's own keys in the source's
 * order. The copy's fast path already does that when the source is on its
 * fast path and the shared fields number in the same relative order (and
 * no optional dynamic field of the target is left out); otherwise the copy
 * takes the source's keys as its order. */
export function orderNoteCopy(L: Lowerer, copy: IrExpr, toId: string, src: IrExpr, fromId: string, loc: SrcLoc): IrExpr {

  const to = orderedShape(L, toId);
  const from = L.shapes.get(fromId);
  if (to === null || !from) return copy;
  const tf = orderFields(to);
  const sf = orderFields(from);
  const shared = sf.map((f) => tf.findIndex((g) => g.name === f.name)).filter((i) => i >= 0);
  const sameOrder = shared.every((v, k) => k === 0 || v > shared[k - 1]!);
  const leftOutDyn = tf.some((f) => f.optional === true && (f.type.kind === "dyn" || f.type.kind === "jsval") && !sf.some((g) => g.name === f.name));
  // A source field the source always has as a key (required) but whose
  // value may be undefined, landing in a field the copy makes optional: the
  // copy's fast path would drop that key.
  const risky = sf.filter((f) => f.optional !== true && testable(f.type) && tf.find((g) => g.name === f.name)?.optional === true).map((f) => f.name);
  const compatible = sameOrder && !leftOutDyn;
  if (compatible && orderedShape(L, fromId) === null && risky.length === 0) return copy;
  return orderNoteSpread(L, copy, toId, [{ spread: src, shapeId: fromId }], loc, compatible, risky);
}

/** A balanced dispatch on field number `v` (an f64 read) over 0..n-1:
 * `body(i)` runs for v === i, in log n compares. */
function dispatch(v: IrExpr, n: number, body: (i: number) => IrStmt[], loc: SrcLoc): IrStmt[] {
  const build = (lo: number, hi: number): IrStmt[] => {
    if (lo >= hi) return [];
    if (hi - lo === 1) return body(lo);
    const mid = (lo + hi) >> 1;
    const left = build(lo, mid);
    const right = build(mid, hi);
    return [ifThen(bin("<", v, num(mid, loc), loc), left, loc, right.length > 0 ? right : null)];
  };
  return build(0, n);
}

/** A key surface's per-field walk over record `o` (a pure read): `fast`
 * is the walk it always emits (declared order, S091 presence); `each(f)`
 * is one field's body WITHOUT a presence test — off the fast path the
 * stored order decides both presence and position. `local(name, type)`
 * declares a scratch local in the surface's function and answers its id. */
export function orderedFieldStmts(
  L: Lowerer,
  o: IrExpr,
  shapeId: string,
  fast: IrStmt[],
  each: (f: Field) => IrStmt[],
  local: (name: string, type: IrType) => string,
  loc: SrcLoc,
  /** GH #227: a hybrid's added-key body (the key, a string read): the walk
   * then lists EVERY own key — index added keys first, then declared fields
   * and added keys interleaved as created. Without it, a hybrid's walk lists
   * only its declared fields (the caller appends the added keys). */
  ovf?: (key: IrExpr) => IrStmt[],
  /** false: skip the index added keys (a key list that needs no order). */
  withIndexKeys = true,
): IrStmt[] {
  const shape = orderedShape(L, shapeId);
  if (shape === null) return fast;
  const fields = orderFields(shape);
  const ordId = local("%ord", NUMS);
  const kId = local("%ordi", F64);
  const vId = local("%ordk", F64);
  const ord = ref(ordId, NUMS, loc);
  const k = ref(kId, F64, loc);
  const v = ref(vId, F64, loc);
  const merged = shape.indexValue !== undefined && ovf !== undefined;
  // the added keys: the index prefix, then the named ones a cursor walks
  const ixId = merged ? local("%ordix", STRS) : "";
  const nkId = merged ? local("%ordnk", STRS) : "";
  const cId = merged ? local("%ordc", F64) : "";
  const ix = ref(ixId, STRS, loc);
  const nk = ref(nkId, STRS, loc);
  const cur = ref(cId, F64, loc);
  const keyAt = (a: IrExpr, i: IrExpr): IrExpr => ({ kind: "arrayGet", arr: a, index: i, type: STRING, loc });
  const nextNamed: IrStmt[] = merged
    ? [ifThen(bin("<", cur, arrLen(nk, loc), loc), [...ovf!(keyAt(nk, cur)), assign(cId, bin("+", cur, num(1, loc), loc), loc)], loc)]
    : [];
  const slow: IrStmt[] = [
    assign(kId, num(fields.length, loc), loc),
    whileLoop(bin("<", k, arrLen(ord, loc), loc), [
      assign(vId, at(ord, k, loc), loc),
      assign(kId, bin("+", k, num(1, loc), loc), loc),
      // a marker: the next added key (skipped by a declared-only walk)
      ifThen(bin("<", v, num(0, loc), loc), nextNamed, loc, dispatch(v, fields.length, (i) => each(fields[i]!), loc)),
    ], loc),
  ];
  if (!merged) {
    return [
      assign(ordId, ordOf(o, shapeId, loc), loc),
      ifThen(isUndef(ord, loc), fast, loc, slow),
    ];
  }
  const restNamed: IrStmt[] = [
    whileLoop(bin("<", cur, arrLen(nk, loc), loc), [
      ...ovf!(keyAt(nk, cur)),
      assign(cId, bin("+", cur, num(1, loc), loc), loc),
    ], loc),
  ];
  // The fast path holds no index added key (one leaves it: kpostHelper,
  // the literal and capture notes), so its keys are the declared fields,
  // then every added key — one key snapshot, the walk it always had.
  const allId = local("%ordks", STRS);
  const all = ref(allId, STRS, loc);
  const fastBranch: IrStmt[] = [
    ...fast,
    assign(allId, { kind: "recordOvfKeys", obj: o, shapeId, type: STRS, loc } as IrExpr, loc),
    assign(cId, num(0, loc), loc),
    whileLoop(bin("<", cur, arrLen(all, loc), loc), [
      ...ovf!(keyAt(all, cur)),
      assign(cId, bin("+", cur, num(1, loc), loc), loc),
    ], loc),
  ];
  const slowBranch: IrStmt[] = [
    // one key snapshot; the index/named split only when its first key (the
    // index keys come first) may be an index key
    assign(allId, { kind: "recordOvfKeys", obj: o, shapeId, type: STRS, loc } as IrExpr, loc),
    ifThen({ kind: "logical", op: "&&", left: bin(">", arrLen(all, loc), num(0, loc), loc), right: digitLead(keyAt(all, num(0, loc)), loc), type: BOOL, loc } as IrExpr,
      [assign(ixId, indexKeysOf(o, shapeId, loc), loc), assign(nkId, namedKeysOf(o, shapeId, loc), loc)], loc,
      [assign(ixId, { kind: "arrayLit", elems: [], type: STRS, loc }, loc), assign(nkId, all, loc)]),
    // index added keys first (JS lists every integer key ahead)
    assign(cId, num(0, loc), loc),
    ...(withIndexKeys ? [whileLoop(bin("<", cur, arrLen(ix, loc), loc), [
      ...ovf!(keyAt(ix, cur)),
      assign(cId, bin("+", cur, num(1, loc), loc), loc),
    ], loc)] : []),
    assign(cId, num(0, loc), loc),
    ...slow,
    // the named added keys not yet listed
    ...restNamed,
  ];
  return [
    assign(ordId, ordOf(o, shapeId, loc), loc),
    ifThen(isUndef(ord, loc), fastBranch, loc, slowBranch),
  ];
}

/** Off the fast path, is `field` an own key of `o` (a pure read)? Answers
 * `fastTest` on the fast path and the presence flag off it; `fastTest`
 * unchanged when the shape keeps no order. */
export function orderedPresence(L: Lowerer, o: IrExpr, shapeId: string, field: string, fastTest: IrExpr, loc: SrcLoc): IrExpr {
  const shape = orderedShape(L, shapeId);
  if (shape === null) return fastTest;
  const i = orderFields(shape).findIndex((f) => f.name === field);
  if (i < 0) return fastTest;
  const ord = ordOf(o, shapeId, loc);
  return {
    kind: "ternary",
    cond: isUndef(ord, loc),
    then: fastTest,
    else_: bin("!==", at(ord, num(i, loc), loc), num(0, loc), loc),
    type: BOOL,
    loc,
  };
}

/* ── GH #227: added-key writes and deletes on a hybrid's order ───────────
 *
 * Every keyed write (`recordKeySet`) and delete (`recordKeyDelete`) on a
 * hybrid that keeps an order is wrapped, over the finished function list:
 * BEFORE, a key naming an optional declared field takes that field's order
 * note (the dot write's), and an ordered record notes whether the key was
 * already an added one; AFTER, a NEW non-index added key on an ordered
 * record appends its marker, and a deleted one drops its marker. Records on
 * the fast path pay one slot read. */

function kpreHelper(L: Lowerer, shape: IrRecordShape, overflowOnly: boolean, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  const fields = orderFields(shape);
  return lift(L, `ord.kpre:${shape.id}:${overflowOnly ? "o" : "k"}`,
    [{ id: "o.0", type: recT }, { id: "k.0", type: STRING }, { id: "u.0", type: BOOL }], [], F64, loc, () => {
      const o = ref("o.0", recT, loc);
      const k = ref("k.0", STRING, loc);
      const u = ref("u.0", BOOL, loc);
      const body: IrStmt[] = [];
      if (!overflowOnly) {
        fields.forEach((f, i) => {
          if (f.optional !== true) return;
          const fUndef: IrExpr = testable(f.type) ? undefTest(getF(o, shape.id, f, loc), loc) : { kind: "boolLit", value: false, type: BOOL, loc };
          const call: IrStmt = {
            kind: "exprStmt",
            expr: { kind: "call", callee: writeHelper(L, shape, loc), args: [o, num(i, loc), u, fUndef, num(isArrayIndexKey(f.name) ? 1 : 0, loc)], type: VOID, loc },
            loc,
          };
          const cond = or(or(not(isUndef(ordOf(o, shape.id, loc), loc), loc), fUndef, loc), u, loc);
          body.push(ifThen({ kind: "strEq", negated: false, left: k, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc } as IrExpr,
            [ifThen(cond, [call], loc), ret(num(-2, loc), loc)], loc));
        });
      }
      body.push(
        ifThen(isUndef(ordOf(o, shape.id, loc), loc), [ret(num(-2, loc), loc)], loc),
        // -1: not an added key yet (one key snapshot; index keys included)
        ret({ kind: "arrIntrinsic", method: "indexOf", receiver: { kind: "recordOvfKeys", obj: o, shapeId: shape.id, type: STRS, loc } as IrExpr, args: [k], type: F64, loc }, loc),
      );
      return body;
    });
}

function kpostHelper(L: Lowerer, shape: IrRecordShape, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  return lift(L, `ord.kpost:${shape.id}`,
    [{ id: "o.0", type: recT }, { id: "k.0", type: STRING }, { id: "r.0", type: F64 }], [{ id: "a.0", type: NUMS }], VOID, loc, () => {
      const o = ref("o.0", recT, loc);
      const k = ref("k.0", STRING, loc);
      const r = ref("r.0", F64, loc);
      const a = ref("a.0", NUMS, loc);
      return [
        decl("a.0", ordOf(o, shape.id, loc), loc),
        // the fast path holds no index added key: a new one leaves it
        ifThen(isUndef(a, loc), [
          ifThen(bin(">=", { kind: "arrIntrinsic", method: "indexOf", receiver: indexKeysOf(o, shape.id, loc), args: [k], type: F64, loc }, num(0, loc), loc),
            [setOrd(o, shape.id, { kind: "call", callee: materializeHelper(L, shape, loc), args: [o], type: NUMS, loc }, loc)], loc),
          ret(null, loc),
        ], loc),
        ifThen(bin("!==", r, num(-1, loc), loc), [ret(null, loc)], loc),
        // a new added key: a marker unless it is an index key
        ifThen(digitLead(k, loc), [
          ifThen(bin(">=", { kind: "arrIntrinsic", method: "indexOf", receiver: indexKeysOf(o, shape.id, loc), args: [k], type: F64, loc }, num(0, loc), loc),
            [ret(null, loc)], loc),
        ], loc),
        push(a, num(MARKER, loc), loc),
      ];
    });
}

function dpreHelper(L: Lowerer, shape: IrRecordShape, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  return lift(L, `ord.dpre:${shape.id}`, [{ id: "o.0", type: recT }, { id: "k.0", type: STRING }], [], F64, loc, () => {
    const o = ref("o.0", recT, loc);
    const k = ref("k.0", STRING, loc);
    return [
      ifThen(isUndef(ordOf(o, shape.id, loc), loc), [ret(num(-2, loc), loc)], loc),
      ret({ kind: "arrIntrinsic", method: "indexOf", receiver: namedKeysOf(o, shape.id, loc), args: [k], type: F64, loc }, loc),
    ];
  });
}

function dpostHelper(L: Lowerer, shape: IrRecordShape, loc: SrcLoc): string {
  const recT: IrType = { kind: "record", shapeId: shape.id };
  const nf = orderFields(shape).length;
  return lift(L, `ord.dpost:${shape.id}`, [{ id: "o.0", type: recT }, { id: "r.0", type: F64 }],
    [{ id: "a.0", type: NUMS }, { id: "k.0", type: F64 }, { id: "m.0", type: F64 }], VOID, loc, () => {
      const o = ref("o.0", recT, loc);
      const r = ref("r.0", F64, loc);
      const a = ref("a.0", NUMS, loc);
      const k = ref("k.0", F64, loc);
      const m = ref("m.0", F64, loc);
      return [
        ifThen(bin("<", r, num(0, loc), loc), [ret(null, loc)], loc),
        decl("a.0", ordOf(o, shape.id, loc), loc),
        ifThen(isUndef(a, loc), [ret(null, loc)], loc),
        // find the r-th marker, then close the gap
        decl("k.0", num(nf, loc), loc),
        decl("m.0", num(-1, loc), loc),
        whileLoop(bin("<", k, arrLen(a, loc), loc), [
          ifThen(bin("<", at(a, k, loc), num(0, loc), loc), [assign("m.0", bin("+", m, num(1, loc), loc), loc)], loc),
          ifThen(bin("===", m, r, loc), [
            whileLoop(bin("<", k, bin("-", arrLen(a, loc), num(1, loc), loc), loc), [
              setAt(a, k, at(a, bin("+", k, num(1, loc), loc), loc), loc),
              assign("k.0", bin("+", k, num(1, loc), loc), loc),
            ], loc),
            { kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "pop", receiver: a, args: [], type: F64, loc }, loc },
            ret(null, loc),
          ], loc),
          assign("k.0", bin("+", k, num(1, loc), loc), loc),
        ], loc),
      ];
    });
}

/** The pass: wrap every keyed write and delete on an ordered hybrid. */
export function hybridWritePass(L: Lowerer, functions: IrFunction[]): void {
  if (!L.undefSlots) return;
  for (const fn of functions) {
    if (fn.name.startsWith("%ord.")) continue; // the helpers' own bodies
    let n = 0;
    const hidden = (base: string, type: IrType): string => {
      const id = `%hk${base}.${n++}`;
      fn.locals.push({ id, name: id, type, mutable: true });
      return id;
    };
    const once = (e: IrExpr, out: IrStmt[], base: string): IrExpr => {
      if (e.kind === "varRef" || e.kind === "strLit" || e.kind === "numLit" || e.kind === "boolLit") return e;
      const id = hidden(base, e.type);
      out.push({ kind: "varDecl", localId: id, init: e, loc: e.loc } as IrStmt);
      return ref(id, e.type, e.loc);
    };
    const rewrite = (st: Record<string, unknown>): IrStmt[] | null => {
      const kind = st["kind"];
      if (kind !== "recordKeySet" && kind !== "recordKeyDelete") return null;
      const shapeId = st["shapeId"] as string;
      const shape = orderedShape(L, shapeId);
      if (shape === null || shape.indexValue === undefined) return null;
      const loc = st["loc"] as SrcLoc;
      const out: IrStmt[] = [];
      const o = once(st["obj"] as IrExpr, out, "o");
      const k = once(st["key"] as IrExpr, out, "k");
      const r = hidden("r", F64);
      if (kind === "recordKeyDelete") {
        out.push({ kind: "varDecl", localId: r, init: { kind: "call", callee: dpreHelper(L, shape, loc), args: [o, k], type: F64, loc }, loc } as IrStmt);
        out.push({ ...(st as unknown as IrStmt), obj: o, key: k } as IrStmt);
        out.push({ kind: "exprStmt", expr: { kind: "call", callee: dpostHelper(L, shape, loc), args: [o, ref(r, F64, loc)], type: VOID, loc }, loc });
        return out;
      }
      const v = once(st["value"] as IrExpr, out, "v");
      const vUndef: IrExpr = isUnitType(v.type)
        ? { kind: "boolLit", value: v.type.kind === "undefinedT", type: BOOL, loc }
        : testable(v.type) ? undefTest(v, loc) : { kind: "boolLit", value: false, type: BOOL, loc };
      const overflowOnly = st["overflowOnly"] === true;
      // Cheap on the fast path: no order and no optional declared field the
      // key could name means nothing to note before the write; after it,
      // only an index key can leave the fast path (statically known for a
      // literal key, a leading digit otherwise).
      const mayNameOptional = !overflowOnly && orderFields(shape).some((f) => f.optional === true);
      const kpre: IrExpr = { kind: "call", callee: kpreHelper(L, shape, overflowOnly, loc), args: [o, k, vUndef], type: F64, loc };
      out.push({ kind: "varDecl", localId: r, init: mayNameOptional ? kpre : { kind: "ternary", cond: isUndef(ordOf(o, shapeId, loc), loc), then: num(-2, loc), else_: kpre, type: F64, loc } as IrExpr, loc } as IrStmt);
      out.push({ ...(st as unknown as IrStmt), obj: o, key: k, value: v } as IrStmt);
      const rr = ref(r, F64, loc);
      const maybeIndex: IrExpr = k.kind === "strLit"
        ? { kind: "boolLit", value: isArrayIndexKey(k.value), type: BOOL, loc }
        : digitLead(k, loc);
      const post: IrStmt = { kind: "exprStmt", expr: { kind: "call", callee: kpostHelper(L, shape, loc), args: [o, k, rr], type: VOID, loc }, loc };
      out.push(ifThen(or(bin("===", rr, num(-1, loc), loc), maybeIndex, loc), [post], loc));
      return out;
    };
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const el = node[i] as Record<string, unknown> | null;
          if (el !== null && typeof el === "object" && !Array.isArray(el)) {
            const rep = rewrite(el);
            if (rep !== null) {
              node.splice(i, 1, ...rep);
              // the operands may hold writes of their own
              for (const x of rep) for (const key of Object.keys(x)) if (key !== "type" && key !== "loc") visit((x as unknown as Record<string, unknown>)[key]);
              i += rep.length - 1;
              continue;
            }
          }
          visit(el);
        }
        return;
      }
      const r = node as Record<string, unknown>;
      for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") visit(r[key]);
    };
    visit(fn.body);
  }
}

/* ── GH #227: an own-key list, and an order taken from one ─────────────── */

/** `%ord.keys:<S>(o) -> string[]`: record `o`'s own NON-INDEX keys in
 * Node's order (index keys need no order: JS lists them first) — a hybrid's
 * merged walk, a pure index-signature shape's named overflow keys, a plain
 * record's present fields in its order. */
export function ownKeysHelper(L: Lowerer, shapeId: string, loc: SrcLoc): string {
  const shape = L.shapes.get(shapeId)!;
  const recT: IrType = { kind: "record", shapeId };
  const extra: { id: string; type: IrType }[] = [];
  const name = lift(L, `ord.keys:${shapeId}`, [{ id: "o.0", type: recT }], [{ id: "out.0", type: STRS }], STRS, loc, () => {
    const o = ref("o.0", recT, loc);
    const out = ref("out.0", STRS, loc);
    const pushK = (k: IrExpr): IrStmt => push(out, k, loc);
    const body: IrStmt[] = [decl("out.0", { kind: "arrayLit", elems: [], type: STRS, loc }, loc)];
    const fields = orderFields(shape);
    if (fields.length === 0 && shape.indexValue !== undefined) {
      body.push(assign("out.0", namedKeysOf(o, shapeId, loc), loc), ret(out, loc));
      return body;
    }
    const name = (f: Field): IrExpr => ({ kind: "strLit", value: f.name, type: STRING, loc });
    const fast: IrStmt[] = fields.map((f) => {
      const has = fastPresent(f, o, shapeId, loc);
      return has === null ? pushK(name(f)) : ifThen(has, [pushK(name(f))], loc);
    });
    body.push(...orderedFieldStmts(L, o, shapeId, fast, (f) => [pushK(name(f))], (n0, type) => {
      const id = `${n0.slice(1)}.0`;
      extra.push({ id, type });
      return id;
    }, loc, shape.indexValue !== undefined ? (k) => [pushK(k)] : undefined, false));
    if (shape.indexValue !== undefined && orderedShape(L, shapeId) === null) {
      // (an unordered hybrid lists its added keys after its fields)
      body.push(decl("ks.0", namedKeysOf(o, shapeId, loc), loc));
      extra.push({ id: "ks.0", type: STRS }, { id: "i.0", type: F64 });
      body.push(decl("i.0", num(0, loc), loc), whileLoop(bin("<", ref("i.0", F64, loc), arrLen(ref("ks.0", STRS, loc), loc), loc), [
        pushK({ kind: "arrayGet", arr: ref("ks.0", STRS, loc), index: ref("i.0", F64, loc), type: STRING, loc }),
        assign("i.0", bin("+", ref("i.0", F64, loc), num(1, loc), loc), loc),
      ], loc));
    }
    body.push(ret(out, loc));
    return body;
  });
  // (the walk's scratch locals, declared as it built)
  const fn = L.liftedFns.find((x) => x.name === name);
  for (const e of extra) if (fn && !fn.locals.some((l) => l.id === e.id)) fn.locals.push({ id: e.id, name: e.id.split(".")[0]!, type: e.type, mutable: true });
  return name;
}

/** The statements giving fresh hybrid record `out` (shape `toId`, a pure
 * read) the own-key order of the key list `keys` (a string[] expression,
 * Node's order of the value it was copied from): set only when that order
 * is not the fast path's. Empty when the shape keeps no order. */
export function orderFromKeys(L: Lowerer, out: IrExpr, toId: string, keys: IrExpr, loc: SrcLoc): IrStmt[] {
  const shape = orderedShape(L, toId);
  if (shape === null || shape.indexValue === undefined) return [];
  const fields = orderFields(shape);
  const nf = fields.length;
  const recT: IrType = { kind: "record", shapeId: toId };
  const helper = lift(L, `ord.fromKeys:${toId}`, [{ id: "t.0", type: recT }, { id: "ks.0", type: STRS }],
    [{ id: "a.0", type: NUMS }, { id: "i.0", type: F64 }, { id: "k.0", type: STRING }, { id: "s.0", type: BOOL }, { id: "r.0", type: BOOL }, { id: "l.0", type: F64 }],
    VOID, loc, () => {
      const t = ref("t.0", recT, loc);
      const ks = ref("ks.0", STRS, loc);
      const a = ref("a.0", NUMS, loc);
      const i = ref("i.0", F64, loc);
      const k = ref("k.0", STRING, loc);
      const saw = ref("s.0", BOOL, loc);
      const re = ref("r.0", BOOL, loc);
      const last = ref("l.0", F64, loc);
      const t_ = (v: boolean): IrExpr => ({ kind: "boolLit", value: v, type: BOOL, loc });
      const perKey: IrStmt[] = [assign("k.0", { kind: "arrayGet", arr: ks, index: i, type: STRING, loc }, loc)];
      // a declared key: flag, append, note a reorder; else a marker (the
      // list holds no index key)
      let chain: IrStmt[] = [push(a, num(MARKER, loc), loc), assign("s.0", t_(true), loc)];
      for (let j = nf - 1; j >= 0; j--) {
        const f = fields[j]!;
        chain = [ifThen({ kind: "strEq", negated: false, left: k, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc } as IrExpr, [
          ifThen(bin("===", at(a, num(j, loc), loc), num(0, loc), loc), [
            setAt(a, num(j, loc), num(1, loc), loc),
            push(a, num(j, loc), loc),
            ifThen(or(saw, bin(">", last, num(j, loc), loc), loc), [assign("r.0", t_(true), loc)], loc),
            assign("l.0", num(j, loc), loc),
          ], loc),
        ], loc, chain)];
      }
      perKey.push(...chain, assign("i.0", bin("+", i, num(1, loc), loc), loc));
      return [
        decl("a.0", emptyOrder(nf, loc), loc),
        decl("i.0", num(0, loc), loc),
        decl("s.0", t_(false), loc),
        decl("r.0", t_(false), loc),
        decl("l.0", num(-1, loc), loc),
        whileLoop(bin("<", i, arrLen(ks, loc), loc), perKey, loc),
        // (the fast path holds no index added key)
        ifThen(bin(">", arrLen(indexKeysOf(t, toId, loc), loc), num(0, loc), loc), [assign("r.0", t_(true), loc)], loc),
        ifThen(re, [setOrd(t, toId, a, loc)], loc),
      ];
    });
  return [{ kind: "exprStmt", expr: { kind: "call", callee: helper, args: [out, keys], type: VOID, loc }, loc }];
}
