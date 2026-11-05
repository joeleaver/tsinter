/* Step 2B (round-3 survey, `stdlib:js`): standard-library members that had
 * no lowering, each desugared onto machinery that already exists, so every
 * lane gets the same behavior from one place. Every form here is Node's
 * algorithm spelled over existing intrinsics; where a form cannot be exact
 * the function returns null and the member fence keeps the site.
 *
 *   - strings: startsWith/endsWith with a position, split with a limit,
 *     lastIndexOf with a fromIndex, substr, concat, codePointAt,
 *     String.fromCodePoint.
 *   - arrays: unshift, reverse, splice with inserted items. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { BOOL, DYN, F64, STRING, UNDEFINED_T, VOID, arrayOf, typeEquals, typeKey, isUnitType } from "../../ir/nodes.js";
import type { IrExpr, IrLocal, IrStmt, IrType, SrcLoc } from "../../ir/nodes.js";
import { bindOnce, droppableStatic, mayHoldSlotUndef, plainFieldPresent, undefRecvGuard, undefinedAsAbsent, undefinedAsText } from "./lower-exprs.js";
import { nodeThrowExpr } from "./lowerer.js";
import { strCharsCall } from "./lower-containers.js";

/* ── IR spelling helpers ─────────────────────────────────────────────── */

const num = (value: number, loc: SrcLoc): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType, loc: SrcLoc): IrExpr => ({ kind: "varRef", localId, type, loc });
const bin = (op: "+" | "-" | "*" | "/" | "%" | "<" | "<=" | ">" | ">=" | "===" | "!==" | ">>>", left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: op === "+" || op === "-" || op === "*" || op === "/" || op === "%" || op === ">>>" ? F64 : BOOL,
  loc,
});
const or = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "logical", op: "||", left, right, type: BOOL, loc } as IrExpr);
const and = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "logical", op: "&&", left, right, type: BOOL, loc } as IrExpr);
const isNaNOf = (e: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "libCall", fn: "num.isNaN", args: [e], type: BOOL, loc });
const truncOf = (e: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "libCall", fn: "math.trunc", args: [e], type: F64, loc });
const floorOf = (e: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "libCall", fn: "math.floor", args: [e], type: F64, loc });
const ternary = (cond: IrExpr, then: IrExpr, else_: IrExpr, type: IrType, loc: SrcLoc): IrExpr => ({ kind: "ternary", cond, then, else_, type, loc });
const strLen = (s: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "strIntrinsic", method: "length", receiver: s, args: [], type: F64, loc });
const arrLen = (a: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc });
const decl = (localId: string, init: IrExpr | null, loc: SrcLoc): IrStmt => ({ kind: "varDecl", localId, init, loc });
const assign = (localId: string, value: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "assign", localId, value, loc });
const ifThen = (cond: IrExpr, then: IrStmt[], loc: SrcLoc, else_: IrStmt[] | null = null): IrStmt => ({ kind: "if", cond, then, else_, loc });
const ret = (value: IrExpr | null, loc: SrcLoc): IrStmt => ({ kind: "return", value, loc } as IrStmt);
const exprStmt = (expr: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "exprStmt", expr, loc });
const whileLoop = (cond: IrExpr, body: IrStmt[], loc: SrcLoc): IrStmt => ({ kind: "while", cond, body, loc });

/** A lifted helper, interned by `key`: `build` returns the body over the
 * named parameters/locals. Returns the helper's name. */
function internHelper(
  L: Lowerer,
  key: string,
  prefix: string,
  params: { id: string; type: IrType }[],
  locals: { id: string; type: IrType }[],
  returnType: IrType,
  loc: SrcLoc,
  build: () => IrStmt[],
): string {
  const existing = L.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%${prefix}.${L.arrHofHelpers.size}`;
  L.arrHofHelpers.set(key, name);
  const all: IrLocal[] = [
    ...params.map((p) => ({ id: p.id, name: p.id.split(".")[0]!, type: p.type, mutable: true })),
    ...locals.map((p) => ({ id: p.id, name: p.id.split(".")[0]!, type: p.type, mutable: true })),
  ];
  L.liftedFns.push({
    name,
    params: params.map((p) => ({ localId: p.id, name: p.id.split(".")[0]!, type: p.type })),
    returnType,
    locals: all,
    body: build(),
    loc,
  });
  return name;
}

/** An optional numeric argument: a number (whose slot's undefined is the
 * absent value), the `undefined` literal, or `number | undefined` — each
 * answering `absent` where the argument is undefined. Null for anything
 * else (the caller keeps its fence). */
export function optionalNumber(L: Lowerer, node: ts.Expression, absent: IrExpr): IrExpr | null {
  if (ts.isSpreadElement(node)) return null;
  const v = L.lowerExpr(node);
  if (v.type.kind === "f64") return undefinedAsAbsent(L, v, absent);
  if (v.type.kind === "undefinedT" || v.type.kind === "void") {
    if (droppableStatic(v)) return absent;
    return { kind: "seqExpr", stmts: [exprStmt(v, v.loc)], result: absent, type: F64, loc: v.loc };
  }
  if (v.type.kind === "union") {
    const arms = L.unions.get(v.type.unionId)?.arms ?? [];
    if (arms.length === 2 && arms.some((a) => a.kind === "f64") && arms.some((a) => a.kind === "undefinedT")) {
      return { kind: "nullish", left: v, right: absent, type: F64, loc: v.loc };
    }
  }
  return null;
}

/** A string argument, ToString'd where its slot holds undefined. */
function stringArg(L: Lowerer, node: ts.Expression): IrExpr | null {
  if (ts.isSpreadElement(node)) return null;
  const v = L.lowerExpr(node);
  if (v.type.kind !== "string") return null;
  return undefinedAsText(L, v, locOf(node));
}

/** The member's receiver, a slot holding undefined throwing Node's
 * `Cannot read properties of undefined (reading '<member>')` ahead of the
 * arguments. An explicit test, never lowerMemberRecv's binding mark: the
 * mark is honored by the intrinsic operations only, and these members
 * lower to helper calls and concatenation. */
function guardedRecv(L: Lowerer, access: ts.PropertyAccessExpression): IrExpr {
  const r = L.lowerExpr(access.expression);
  if (access.questionDotToken || access.expression.kind === ts.SyntaxKind.ThisKeyword) return r;
  return undefRecvGuard(L, r, access.name.text, locOf(access));
}

/* ── strings ─────────────────────────────────────────────────────────── */

/** The string members above on a stdlib string receiver; null otherwise. */
export function lowerStringMemberExtra(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (L.chainBlocked(access, call)) return null;
  const name = access.name.text;
  const args = call.arguments;
  const n = args.length;
  const wanted =
    ((name === "startsWith" || name === "endsWith" || name === "lastIndexOf" || name === "split") && n === 2) ||
    (name === "substr" && n <= 2) ||
    name === "concat" ||
    (name === "codePointAt" && n === 1);
  if (!wanted) return null;
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "string") return null;
  if (!L.isStdlibMember(access)) return null;
  if (args.some((a) => ts.isSpreadElement(a))) return null;
  const loc = locOf(call);
  // Probe the argument kinds first: a declined form must not leave half a
  // lowering behind (lowering is IR construction, so a probe is free).
  const recv = guardedRecv(L, access);
  if (recv.type.kind !== "string") return null;

  if (name === "startsWith" || name === "endsWith") {
    // String.prototype.startsWith(search, position): the search runs at
    // clamp(ToIntegerOrInfinity(position), 0, len) — exactly the start
    // substring() takes (NaN 0, negatives 0, past the end len), so the
    // suffix's own startsWith is the answer. endsWith(search, endPosition)
    // likewise over the prefix substring(0, end), an absent end being len.
    const search = stringArg(L, args[0]!);
    if (!search) return null;
    const pos = optionalNumber(L, args[1]!, num(name === "startsWith" ? 0 : Infinity, loc));
    if (!pos) return null;
    return bindOnce(L, recv, loc, (r) =>
      bindOnce(L, search, loc, (s) =>
        bindOnce(L, pos, loc, (p) => {
          const part: IrExpr = {
            kind: "strIntrinsic",
            method: "substring",
            receiver: r,
            args: name === "startsWith" ? [p] : [num(0, loc), p],
            type: STRING,
            loc,
          };
          return { kind: "strIntrinsic", method: name, receiver: part, args: [s], type: BOOL, loc };
        }),
      ),
    );
  }

  if (name === "split") {
    // split(separator, limit) over a STRING separator: lim = ToUint32(limit)
    // (2^32 - 1 when undefined); the result is the first lim pieces of the
    // unlimited split, which is the spec's loop stopping at lim (and [] for
    // lim 0). The limit evaluates before the split runs.
    // A separator holding undefined is ABSENT (Node: [S], or [] when lim
    // is 0) — tested on the raw value, before anything ToStrings it.
    if (ts.isSpreadElement(args[0]!)) return null;
    const sep = L.lowerExpr(args[0]!);
    if (sep.type.kind !== "string") return null;
    const lim = optionalNumber(L, args[1]!, num(4294967295, loc));
    if (!lim) return null;
    const resT = arrayOf(STRING);
    return bindOnce(L, recv, loc, (r) =>
      bindOnce(L, sep, loc, (s) =>
        bindOnce(L, bin(">>>", lim, num(0, loc), loc), loc, (l) => {
          const limited: IrExpr = {
            kind: "arrIntrinsic",
            method: "slice",
            receiver: { kind: "strIntrinsic", method: "split", receiver: r, args: [s], type: resT, loc },
            args: [num(0, loc), l],
            type: resT,
            loc,
          };
          if (!mayHoldSlotUndef(L, s)) return limited;
          const whole: IrExpr = { kind: "ternary", cond: bin("===", l, num(0, loc), loc), then: { kind: "arrayLit", elems: [], type: resT, loc }, else_: { kind: "arrayLit", elems: [r], type: resT, loc }, type: resT, loc };
          return { kind: "ternary", cond: { kind: "isUndef", operand: s, type: BOOL, loc }, then: whole, else_: limited, type: resT, loc };
        }),
      ),
    );
  }

  if (name === "lastIndexOf") {
    // lastIndexOf(search, position): numPos = ToNumber(position), NaN is
    // +Infinity; start = clamp(ToIntegerOrInfinity(numPos), 0, len); the
    // answer is the last match at an index <= start — the plain
    // lastIndexOf over the prefix that ends start + searchLen in.
    const search = stringArg(L, args[0]!);
    if (!search) return null;
    const posRaw = L.lowerExpr(args[1]!);
    let pos: IrExpr;
    if (posRaw.type.kind === "f64") pos = posRaw;
    else if (isUnitType(posRaw.type) && posRaw.type.kind === "undefinedT") {
      pos = droppableStatic(posRaw) ? num(NaN, loc) : { kind: "seqExpr", stmts: [exprStmt(posRaw, loc)], result: num(NaN, loc), type: F64, loc };
    } else return null;
    return bindOnce(L, recv, loc, (r) =>
      bindOnce(L, search, loc, (s) =>
        bindOnce(L, pos, loc, (p) =>
          bindOnce(L, ternary(isNaNOf(p, loc), num(Infinity, loc), truncOf(p, loc), F64, loc), loc, (t) => {
            const start = ternary(bin("<", t, num(0, loc), loc), num(0, loc), t, F64, loc);
            const prefix: IrExpr = {
              kind: "strIntrinsic",
              method: "substring",
              receiver: r,
              args: [num(0, loc), bin("+", start, strLen(s, loc), loc)],
              type: STRING,
              loc,
            };
            return { kind: "libCall", fn: "string.lastIndexOf", args: [prefix, s], type: F64, loc };
          }),
        ),
      ),
    );
  }

  if (name === "substr") {
    // Annex B substr(start, length): the start resolves exactly as slice's
    // (negatives from the end, clamped), then the length clamps to what
    // is left (NaN and negatives are 0, an absent length is the rest) —
    // substring(0, length) over the slice is that clamp.
    const start = n >= 1 ? optionalNumber(L, args[0]!, num(0, loc)) : num(0, loc);
    if (!start) return null;
    const len = n >= 2 ? optionalNumber(L, args[1]!, num(Infinity, loc)) : num(Infinity, loc);
    if (!len) return null;
    return bindOnce(L, recv, loc, (r) =>
      bindOnce(L, start, loc, (a) =>
        bindOnce(L, len, loc, (b) => ({
          kind: "strIntrinsic",
          method: "substring",
          receiver: { kind: "strIntrinsic", method: "slice", receiver: r, args: [a], type: STRING, loc },
          args: [num(0, loc), b],
          type: STRING,
          loc,
        })),
      ),
    );
  }

  if (name === "concat") {
    // concat(...strings): ToString of each argument, appended in order.
    let out: IrExpr = recv;
    for (const a of args) {
      const s = stringArg(L, a);
      if (!s) return null;
      out = { kind: "strConcat", left: out, right: s, type: STRING, loc };
    }
    return out;
  }

  if (name === "codePointAt") {
    // codePointAt(pos): ToIntegerOrInfinity(pos); undefined outside
    // [0, len); a lead surrogate followed by a trail answers the pair's
    // code point, anything else the code unit itself.
    const pos = optionalNumber(L, args[0]!, num(0, loc));
    if (!pos) return null;
    const resultT = L.irTypeOf(call);
    if (resultT.kind !== "union") return null;
    const undefTag = L.armTag(resultT.unionId, UNDEFINED_T);
    const numTag = L.armTag(resultT.unionId, F64);
    if (undefTag < 0 || numTag < 0) return null;
    const helper = internHelper(
      L,
      `str.codePointAt:${typeKey(resultT)}`,
      "str.codePointAt",
      [{ id: "s.0", type: STRING }, { id: "i.0", type: F64 }],
      [{ id: "n.0", type: F64 }, { id: "t.0", type: F64 }, { id: "c.0", type: F64 }, { id: "d.0", type: F64 }],
      resultT,
      loc,
      () => {
        const s = ref("s.0", STRING, loc);
        const t = ref("t.0", F64, loc);
        const nn = ref("n.0", F64, loc);
        const c = ref("c.0", F64, loc);
        const d = ref("d.0", F64, loc);
        const wrapNum = (v: IrExpr): IrExpr => ({ kind: "unionWrap", unionId: resultT.unionId, tag: numTag, value: v, type: resultT, loc });
        const miss: IrExpr = {
          kind: "unionWrap",
          unionId: resultT.unionId,
          tag: undefTag,
          value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
          type: resultT,
          loc,
        };
        const at = (i: IrExpr): IrExpr => ({ kind: "strIntrinsic", method: "charCodeAt", receiver: s, args: [i], type: F64, loc });
        return [
          decl("n.0", strLen(s, loc), loc),
          decl("t.0", truncOf(ref("i.0", F64, loc), loc), loc),
          ifThen(isNaNOf(t, loc), [assign("t.0", num(0, loc), loc)], loc),
          ifThen(or(bin("<", t, num(0, loc), loc), bin(">=", t, nn, loc), loc), [ret(miss, loc)], loc),
          decl("c.0", at(t), loc),
          decl("d.0", num(0, loc), loc),
          ifThen(
            and(and(bin(">=", c, num(0xd800, loc), loc), bin("<=", c, num(0xdbff, loc), loc), loc), bin("<", bin("+", t, num(1, loc), loc), nn, loc), loc),
            [
              assign("d.0", at(bin("+", t, num(1, loc), loc)), loc),
              ifThen(
                and(bin(">=", d, num(0xdc00, loc), loc), bin("<=", d, num(0xdfff, loc), loc), loc),
                [ret(wrapNum(bin("+", bin("+", bin("*", bin("-", c, num(0xd800, loc), loc), num(0x400, loc), loc), bin("-", d, num(0xdc00, loc), loc), loc), num(0x10000, loc), loc)), loc)],
                loc,
              ),
            ],
            loc,
          ),
          ret(wrapNum(c), loc),
        ];
      },
    );
    return { kind: "call", callee: helper, args: [recv, pos], type: resultT, loc };
  }
  return null;
}

/** `String.fromCodePoint(...codePoints)` on THE String global: each code
 * point must be an integral number in [0, 0x10FFFF] — anything else throws
 * V8's `RangeError: Invalid code point <ToString(value)>` at that argument;
 * the rest become one code unit or a surrogate pair. Null for other
 * receivers. */
export function lowerStringFromCodePoint(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (L.stdlibGlobalMember(access, "String") !== "fromCodePoint") return null;
  const loc = locOf(call);
  const arrT = arrayOf(F64);
  let packed: IrExpr;
  const spread = call.arguments.find(ts.isSpreadElement);
  if (spread) {
    if (call.arguments.length !== 1) return null;
    const v = L.lowerExpr(spread.expression);
    if (!typeEquals(v.type, arrT)) return null;
    packed = { kind: "arrIntrinsic", method: "slice", receiver: v, args: [], type: arrT, loc };
  } else {
    const elems: IrExpr[] = [];
    for (const a of call.arguments) {
      const v = L.lowerExpr(a);
      if (v.type.kind !== "f64") return null;
      elems.push(v);
    }
    packed = { kind: "arrayLit", elems, type: arrT, loc };
  }
  const helper = internHelper(
    L,
    "str.fromCodePoint",
    "str.fromCodePoint",
    [{ id: "a.0", type: arrT }],
    [{ id: "o.0", type: arrT }, { id: "n.0", type: F64 }, { id: "i.0", type: F64 }, { id: "c.0", type: F64 }],
    STRING,
    loc,
    () => {
      const a = ref("a.0", arrT, loc);
      const o = ref("o.0", arrT, loc);
      const i = ref("i.0", F64, loc);
      const c = ref("c.0", F64, loc);
      const push = (v: IrExpr): IrStmt => exprStmt({ kind: "arrIntrinsic", method: "push", receiver: o, args: [v], type: F64, loc }, loc);
      const invalid = or(or(bin("!==", truncOf(c, loc), c, loc), bin("<", c, num(0, loc), loc), loc), bin(">", c, num(0x10ffff, loc), loc), loc);
      const message: IrExpr = { kind: "strConcat", left: { kind: "strLit", value: "Invalid code point ", type: STRING, loc }, right: { kind: "toString", operand: bin("+", c, num(0, loc), loc), type: STRING, loc }, type: STRING, loc }; // ToNumber first: a slot's undefined reads NaN
      const off = bin("-", c, num(0x10000, loc), loc);
      return [
        decl("o.0", { kind: "arrayLit", elems: [], type: arrT, loc }, loc),
        decl("n.0", arrLen(a, loc), loc),
        decl("i.0", num(0, loc), loc),
        decl("c.0", num(0, loc), loc),
        whileLoop(bin("<", i, ref("n.0", F64, loc), loc), [
          assign("c.0", { kind: "arrayGet", arr: a, index: i, type: F64, loc }, loc),
          ifThen(invalid, [
            exprStmt({
              kind: "libCall",
              fn: "error.nodeThrow",
              args: [num(2, loc), { kind: "strLit", value: "", type: STRING, loc }, message],
              type: VOID,
              loc,
            }, loc),
          ], loc),
          ifThen(
            bin("<", c, num(0x10000, loc), loc),
            [push(c)],
            loc,
            [push(bin("+", floorOf(bin("/", off, num(0x400, loc), loc), loc), num(0xd800, loc), loc)), push(bin("+", bin("%", off, num(0x400, loc), loc), num(0xdc00, loc), loc))],
          ),
          assign("i.0", bin("+", i, num(1, loc), loc), loc),
        ], loc),
        ret({ kind: "libCall", fn: "string.fromCharCode", args: [o], type: STRING, loc }, loc),
      ];
    },
  );
  return { kind: "call", callee: helper, args: [packed], type: STRING, loc };
}

/* ── arrays ──────────────────────────────────────────────────────────── */

/** The inserted items of unshift/splice: plain element arguments, or ONE
 * spread of a same-typed array (copied first — the spread is evaluated
 * into the argument list before the method runs, so `a.unshift(...a)`
 * inserts the old contents). Null for other shapes. */
function insertedItems(L: Lowerer, nodes: readonly ts.Expression[], arrT: IrType & { kind: "array" }, loc: SrcLoc): IrExpr | null {
  if (nodes.some((a) => ts.isSpreadElement(a))) {
    if (nodes.length !== 1) return null;
    const v = L.lowerExpr((nodes[0] as ts.SpreadElement).expression);
    if (!typeEquals(v.type, arrT)) return null;
    return { kind: "arrIntrinsic", method: "slice", receiver: v, args: [], type: arrT, loc };
  }
  const elems: IrExpr[] = [];
  for (const a of nodes) {
    const v = L.lowerExprExpecting(a, arrT.elem);
    if (!typeEquals(v.type, arrT.elem)) return null;
    elems.push(v);
  }
  return { kind: "arrayLit", elems, type: arrT, loc };
}

/** `%arr.unshift.<n>(a, at, items)` (unshift and splice insert through it): items enter a at index `at` (0 <= at <=
 * len), the tail moving up — appended first so the array grows through
 * push, then shifted from the top down, then written in. Returns the new
 * length. */
function insertAtHelper(L: Lowerer, arrT: IrType & { kind: "array" }, loc: SrcLoc): string {
  return internHelper(
    L,
    `arr.insertAt:${typeKey(arrT)}`,
    "arr.unshift", // named for width-copies.ts ARG_MUTATOR: it writes its array argument
    [{ id: "a.0", type: arrT }, { id: "p.0", type: F64 }, { id: "x.0", type: arrT }],
    [{ id: "k.0", type: F64 }, { id: "m.0", type: F64 }, { id: "i.0", type: F64 }],
    F64,
    loc,
    () => {
      const a = ref("a.0", arrT, loc);
      const x = ref("x.0", arrT, loc);
      const p = ref("p.0", F64, loc);
      const k = ref("k.0", F64, loc);
      const i = ref("i.0", F64, loc);
      const get = (arr: IrExpr, idx: IrExpr): IrExpr => ({ kind: "arrayGet", arr, index: idx, type: arrT.elem, loc });
      const set = (idx: IrExpr, value: IrExpr): IrStmt => ({ kind: "arraySet", arr: a, index: idx, value, loc });
      return [
        decl("k.0", arrLen(x, loc), loc),
        decl("m.0", arrLen(a, loc), loc),
        decl("i.0", num(0, loc), loc),
        // grow by k (the items themselves are the placeholders)
        whileLoop(bin("<", i, k, loc), [
          exprStmt({ kind: "arrIntrinsic", method: "push", receiver: a, args: [get(x, i)], type: F64, loc }, loc),
          assign("i.0", bin("+", i, num(1, loc), loc), loc),
        ], loc),
        // move [p, m) up by k, top first
        assign("i.0", bin("-", ref("m.0", F64, loc), num(1, loc), loc), loc),
        whileLoop(bin(">=", i, p, loc), [
          set(bin("+", i, k, loc), get(a, i)),
          assign("i.0", bin("-", i, num(1, loc), loc), loc),
        ], loc),
        // write the items in
        assign("i.0", num(0, loc), loc),
        whileLoop(bin("<", i, k, loc), [
          set(bin("+", p, i, loc), get(x, i)),
          assign("i.0", bin("+", i, num(1, loc), loc), loc),
        ], loc),
        ret(arrLen(a, loc), loc),
      ];
    },
  );
}

/** Array mutators with no intrinsic: unshift(...items), reverse(), and
 * splice(start, deleteCount, ...items). Null for other members/receivers. */
export function lowerArrayMemberExtra(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (L.chainBlocked(access, call)) return null;
  const name = access.name.text;
  if (name !== "unshift" && name !== "reverse" && name !== "splice") return null;
  if (name === "splice" && call.arguments.length < 3) return null;
  if (name === "reverse" && call.arguments.length !== 0) return null;
  const arrT = L.mapTypeOf(L.typeOf(access.expression));
  if (arrT?.kind !== "array") return null;
  if (!L.isStdlibMember(access)) return null;
  const loc = locOf(call);
  const recv = guardedRecv(L, access);
  if (!typeEquals(recv.type, arrT)) return null;

  if (name === "reverse") {
    // In place, the two ends swapping toward the middle; answers the
    // receiver itself.
    const helper = internHelper(
      L,
      `arr.reverse:${typeKey(arrT)}`,
      "arr.reverse",
      [{ id: "a.0", type: arrT }],
      [{ id: "i.0", type: F64 }, { id: "j.0", type: F64 }, { id: "t.0", type: arrT.elem }],
      arrT,
      loc,
      () => {
        const a = ref("a.0", arrT, loc);
        const i = ref("i.0", F64, loc);
        const j = ref("j.0", F64, loc);
        const get = (idx: IrExpr): IrExpr => ({ kind: "arrayGet", arr: a, index: idx, type: arrT.elem, loc });
        const set = (idx: IrExpr, value: IrExpr): IrStmt => ({ kind: "arraySet", arr: a, index: idx, value, loc });
        return [
          decl("i.0", num(0, loc), loc),
          decl("j.0", bin("-", arrLen(a, loc), num(1, loc), loc), loc),
          decl("t.0", null, loc),
          whileLoop(bin("<", i, j, loc), [
            assign("t.0", get(i), loc),
            set(i, get(j)),
            set(j, ref("t.0", arrT.elem, loc)),
            assign("i.0", bin("+", i, num(1, loc), loc), loc),
            assign("j.0", bin("-", j, num(1, loc), loc), loc),
          ], loc),
          ret(a, loc),
        ];
      },
    );
    return { kind: "call", callee: helper, args: [recv], type: arrT, loc };
  }

  if (name === "unshift") {
    // unshift(...items): items enter at index 0 in argument order; the
    // new length is the answer (every argument evaluates first).
    const items = insertedItems(L, call.arguments, arrT, loc);
    if (!items) return null;
    const helper = insertAtHelper(L, arrT, loc);
    return { kind: "call", callee: helper, args: [recv, num(0, loc), items], type: F64, loc };
  }

  // splice(start, deleteCount, ...items): actualStart is start resolved
  // against the ORIGINAL length (negatives from the end, clamped); the
  // removal intrinsic then takes exactly the spec's deleteCount clamp at
  // that non-negative start, and the items enter at actualStart. Answers
  // the removed elements.
  const start = L.lowerExpr(call.arguments[0]!);
  const dc = L.lowerExpr(call.arguments[1]!);
  if (start.type.kind !== "f64" || dc.type.kind !== "f64") return null;
  const items = insertedItems(L, call.arguments.slice(2), arrT, loc);
  if (!items) return null;
  const insert = insertAtHelper(L, arrT, loc);
  const helper = internHelper(
    L,
    `arr.spliceInsert:${typeKey(arrT)}`,
    "arr.splice", // width-copies.ts ARG_MUTATOR
    [{ id: "a.0", type: arrT }, { id: "s.0", type: F64 }, { id: "d.0", type: F64 }, { id: "x.0", type: arrT }],
    [{ id: "n.0", type: F64 }, { id: "t.0", type: F64 }, { id: "r.0", type: arrT }],
    arrT,
    loc,
    () => {
      const a = ref("a.0", arrT, loc);
      const s = ref("s.0", F64, loc);
      const t = ref("t.0", F64, loc);
      const nn = ref("n.0", F64, loc);
      return [
        decl("n.0", arrLen(a, loc), loc),
        // ToIntegerOrInfinity(start)
        decl("t.0", truncOf(s, loc), loc),
        ifThen(isNaNOf(t, loc), [assign("t.0", num(0, loc), loc)], loc),
        ifThen(
          bin("<", t, num(0, loc), loc),
          [assign("t.0", bin("+", nn, t, loc), loc), ifThen(bin("<", t, num(0, loc), loc), [assign("t.0", num(0, loc), loc)], loc)],
          loc,
          [ifThen(bin(">", t, nn, loc), [assign("t.0", nn, loc)], loc)],
        ),
        decl("r.0", { kind: "arrIntrinsic", method: "splice", receiver: a, args: [t, ref("d.0", F64, loc)], type: arrT, loc }, loc),
        exprStmt({ kind: "call", callee: insert, args: [a, t, ref("x.0", arrT, loc)], type: F64, loc }, loc),
        ret(ref("r.0", arrT, loc), loc),
      ];
    },
  );
  return { kind: "call", callee: helper, args: [recv, start, dc, items], type: arrT, loc };
}

/* ── numbers ─────────────────────────────────────────────────────────── */

/** `x.toString(radix)` on a number (already lowered, receiver checked):
 * radix = ToIntegerOrInfinity(radix), 10 when undefined; outside [2, 36]
 * V8's `RangeError: toString() radix argument must be between 2 and 36`; 10 is the
 * ordinary ToString; anything else V8's DoubleToRadixCString
 * (num.toRadix). Null when the radix argument is not a number. */
export function lowerNumberToStringRadix(L: Lowerer, operand: IrExpr, radixNode: ts.Expression, loc: SrcLoc): IrExpr | null {
  const radix = optionalNumber(L, radixNode, num(10, loc));
  if (!radix) return null;
  return bindOnce(L, operand, loc, (x) =>
    bindOnce(L, radix, loc, (r0) =>
      bindOnce(L, ternary(isNaNOf(r0, loc), num(0, loc), truncOf(r0, loc), F64, loc), loc, (r) =>
        ternary(
          or(bin("<", r, num(2, loc), loc), bin(">", r, num(36, loc), loc), loc),
          nodeThrowExpr(2, "", "toString() radix argument must be between 2 and 36", STRING, loc),
          ternary(
            // radix 10, and NaN, the infinities and zero (whose radix
            // texts are the decimal ones), take the ordinary ToString
            or(or(bin("===", r, num(10, loc), loc), bin("===", x, num(0, loc), loc), loc), { kind: "unary", op: "!", operand: { kind: "libCall", fn: "number.isFinite", args: [x], type: BOOL, loc }, type: BOOL, loc } as IrExpr, loc),
            { kind: "toString", operand: x, type: STRING, loc },
            { kind: "libCall", fn: "num.toRadix", args: [x, r], type: STRING, loc },
            STRING,
            loc,
          ),
          STRING,
          loc,
        ),
      ),
    ),
  );
}

/* ── iterables: new Set(iterable), Array.from(iterable[, mapFn]) ──────── */

/** The values `[...x]` takes from x, as an array of `elem` (or of x's own
 * element type when elem is null): a Set drains in insertion order, a
 * class iterable through its own protocol, a string by code points, a
 * typed array by element, a tuple field by field, and an array is itself
 * (`fresh` false: the caller copies where the result must be new). Null
 * for every other source. A source slot holding undefined is tested first,
 * whatever its kind: `undefIter` is V8's not-iterable TypeError text to
 * throw, or null for no values at all (`new Set(u)` is empty). */
export function iterableArray(
  L: Lowerer,
  node: ts.Expression,
  elem: IrType | null,
  loc: SrcLoc,
  undefIter: string | null,
): { arr: IrExpr; fresh: boolean } | null {
  if (ts.isSpreadElement(node)) return null;
  const src = L.lowerExpr(node);
  if (!mayHoldSlotUndef(L, src)) return convertIterable(L, src, elem, loc);
  let converted: { arr: IrExpr; fresh: boolean } | null = null;
  const arr = bindOnce(L, src, loc, (x) => {
    converted = convertIterable(L, x, elem, loc);
    if (converted === null) return x;
    const t = converted.arr.type;
    return {
      kind: "ternary",
      cond: { kind: "isUndef", operand: x, type: BOOL, loc },
      then: undefIter !== null ? nodeThrowExpr(1, "", undefIter, t, loc) : { kind: "arrayLit", elems: [], type: t, loc },
      else_: converted.arr,
      type: t,
      loc,
    };
  });
  const c = converted as { arr: IrExpr; fresh: boolean } | null;
  return c === null ? null : { arr, fresh: c.fresh };
}

/** iterableArray's conversion of a source known to hold a value. */
function convertIterable(L: Lowerer, src: IrExpr, elem: IrType | null, loc: SrcLoc): { arr: IrExpr; fresh: boolean } | null {
  const want = (t: IrType): boolean => elem === null || typeEquals(t, elem);
  switch (src.type.kind) {
    case "set":
      if (!want(src.type.elem)) return null;
      return { arr: { kind: "setIntrinsic", method: "toArray", receiver: src, args: [], type: arrayOf(src.type.elem), loc }, fresh: true };
    case "object": {
      const drained = L.classIteratorDrainCall(src, loc, elem ?? undefined);
      if (!drained || drained.type.kind !== "array" || !want(drained.type.elem)) return null;
      return { arr: drained, fresh: true };
    }
    case "string":
      if (!want(STRING)) return null;
      return { arr: strCharsCall(L, src, loc), fresh: true };
    case "bytes":
      if (!want(F64)) return null;
      return { arr: { kind: "bytesIntrinsic", method: "toArray", receiver: src, args: [], type: arrayOf(F64), loc }, fresh: true };
    case "array": {
      if (want(src.type.elem)) return { arr: src, fresh: false };
      const w = L.widthCoerce(src, arrayOf(elem!));
      return w ? { arr: w, fresh: true } : null;
    }
    case "record": {
      const shape = L.shapes.get(src.type.shapeId);
      if (!shape?.tuple) return null;
      const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
      if (fields.some((f, i) => f.name !== String(i))) return null;
      const target = elem ?? fields[0]?.type ?? null;
      if (target === null) return null;
      const recT = src.type;
      const plan: ((r: IrExpr) => IrExpr)[] = [];
      for (const f of fields) {
        const get = (r: IrExpr): IrExpr => ({ kind: "recordGet", obj: r, shapeId: recT.shapeId, field: f.name, type: f.type, loc });
        if (typeEquals(f.type, target)) plan.push(get);
        else if (target.kind === "union" && f.type.kind !== "union" && L.armTag(target.unionId, f.type) >= 0) {
          const tag = L.armTag(target.unionId, f.type);
          plan.push((r) => ({ kind: "unionWrap", unionId: target.unionId, tag, value: get(r), type: target, loc }));
        } else return null;
      }
      return {
        arr: bindOnce(L, src, loc, (r) => ({ kind: "arrayLit", elems: plan.map((p) => p(r)), type: arrayOf(target), loc })),
        fresh: true,
      };
    }
    case "dyn":
    case "jsval": {
      // One world (U1b): a dynamic array of SCALARS (`Object.keys(obj)`
      // over a dynamic object) seeds through the checked conversion — a
      // scalar copy is unobservable; an element of another kind throws
      // the catchable TypeError, never a silent answer.
      if (!L.sharedDynamic || elem === null || (elem.kind !== "string" && elem.kind !== "f64" && elem.kind !== "bool")) return null;
      const d: IrExpr = src.type.kind === "jsval" ? { kind: "dynFromJsval", value: src, type: DYN, loc } : src;
      return { arr: { kind: "dynCheck", value: d, type: arrayOf(elem), loc }, fresh: true };
    }
    default:
      return null;
  }
}

/** `new Set(iterable)` beyond the array seed: any source iterableArray
 * reads, its values added in order (a source slot holding undefined is no
 * seed — `new Set(u)` is empty). Null when the source has no such form. */
export function lowerSetFromIterable(L: Lowerer, argNode: ts.Expression, setT: IrType & { kind: "set" }, loc: SrcLoc): IrExpr | null {
  const r = iterableArray(L, argNode, setT.elem, loc, null);
  if (!r) return null;
  const seed = r.fresh ? r.arr : undefinedAsAbsent(L, r.arr, { kind: "arrayLit", elems: [], type: r.arr.type, loc });
  return { kind: "setNew", seed, type: setT, loc };
}

const NOT_ITERABLE = "undefined is not iterable (cannot read property Symbol(Symbol.iterator))";

/** `%arr.map.<n>(a, f)` (named as the HOF loop it is): Array.from's mapping loop over an array source —
 * the array iterator's walk (the length re-read at every step, so an
 * element the mapper appends is visited, as in Node), each value and its
 * index handed to the mapper. */
function fromMapHelper(L: Lowerer, arrT: IrType & { kind: "array" }, fnT: IrType & { kind: "func" }, loc: SrcLoc): string {
  const outT = arrayOf(fnT.ret);
  return internHelper(
    L,
    `arr.fromMap:${typeKey(arrT)}:${typeKey(fnT)}`,
    "arr.map", // width-copies.ts: a HOF loop (reads the spine, hands elements to the callback)
    [{ id: "a.0", type: arrT }, { id: "f.0", type: fnT }],
    [{ id: "o.0", type: outT }, { id: "i.0", type: F64 }],
    outT,
    loc,
    () => {
      const a = ref("a.0", arrT, loc);
      const i = ref("i.0", F64, loc);
      const o = ref("o.0", outT, loc);
      const args: IrExpr[] = [{ kind: "arrayGet", arr: a, index: i, type: arrT.elem, loc } as IrExpr, i].slice(0, fnT.params.length);
      return [
        decl("o.0", { kind: "arrayLit", elems: [], type: outT, loc }, loc),
        decl("i.0", num(0, loc), loc),
        whileLoop(bin("<", i, arrLen(a, loc), loc), [
          exprStmt({ kind: "arrIntrinsic", method: "push", receiver: o, args: [{ kind: "callValue", callee: ref("f.0", fnT, loc), args, type: fnT.ret, loc }], type: F64, loc }, loc),
          assign("i.0", bin("+", i, num(1, loc), loc), loc),
        ], loc),
        ret(o, loc),
      ];
    },
  );
}

/** `Array.from(iterable)` and `Array.from(iterable, mapFn)` over the
 * sources iterableArray reads. With a mapper the source must be one the
 * mapper cannot change behind the walk, or one whose live walk the loop
 * reproduces: a string, an array (walked live, as the array iterator
 * does), or a fresh `new Set(...)`. Null otherwise. */
export function lowerArrayFromIterable(L: Lowerer, call: ts.CallExpression): IrExpr | null {
  const args = call.arguments;
  if (args.length < 1 || args.length > 2 || args.some((a) => ts.isSpreadElement(a))) return null;
  const loc = locOf(call);
  const resT = L.mapTypeOf(L.typeOf(call));
  if (resT?.kind !== "array") return null;
  if (args.length === 1) {
    const r = iterableArray(L, args[0]!, resT.elem, loc, NOT_ITERABLE);
    if (!r) return null;
    return r.fresh ? r.arr : { kind: "arrIntrinsic", method: "slice", receiver: r.arr, args: [], type: r.arr.type, loc };
  }
  let srcNode: ts.Expression = args[0]!;
  while (ts.isParenthesizedExpression(srcNode)) srcNode = srcNode.expression;
  const srcT = L.mapTypeOf(L.typeOf(srcNode));
  const freshSet = ts.isNewExpression(srcNode) && srcT?.kind === "set";
  if (srcT?.kind !== "string" && srcT?.kind !== "array" && !freshSet) return null;
  const r = iterableArray(L, srcNode, null, loc, NOT_ITERABLE);
  if (!r || r.arr.type.kind !== "array") return null;
  const f = L.lowerExpr(args[1]!);
  if (f.type.kind !== "func" || f.type.params.length > 2) return null;
  if (f.type.params.length >= 1 && !typeEquals(f.type.params[0]!, r.arr.type.elem)) return null;
  if (f.type.params.length === 2 && f.type.params[1]!.kind !== "f64") return null;
  if (!typeEquals(arrayOf(f.type.ret), resT)) return null;
  const helper = fromMapHelper(L, r.arr.type, f.type, loc);
  return { kind: "call", callee: helper, args: [r.arr, f], type: resT, loc };
}

/* ── Object statics ──────────────────────────────────────────────────── */

/** `%obj.hasOwn.<n>(r, k)`: Object.hasOwn over an INDEX-SIGNATURE
 * record — the `in` helper's own walk (the declared names: accessors and
 * non-optional fields answer true, optional ones their per-value tag test;
 * then the overflow map's live keys), ending in false: hasOwn asks for OWN
 * properties, so no prototype name can answer here. */
export function recordHasOwnIndexHelper(L: Lowerer, shapeId: string, loc: SrcLoc): string {
  const shape = L.shapes.get(shapeId)!;
  const recT: IrType = { kind: "record", shapeId };
  const ksT = arrayOf(STRING);
  return internHelper(
    L,
    `obj.hasOwnIdx:${shapeId}`,
    "obj.hasOwn", // width-copies.ts KEYS_HELPER: a key test, read-only
    [{ id: "r.0", type: recT }, { id: "k.0", type: STRING }],
    [{ id: "ks.0", type: ksT }, { id: "i.0", type: F64 }],
    BOOL,
    loc,
    () => {
      const k = ref("k.0", STRING, loc);
      const r = ref("r.0", recT, loc);
      const ks = ref("ks.0", ksT, loc);
      const i = ref("i.0", F64, loc);
      const t: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
      const body: IrStmt[] = [];
      for (const f of shape.fields) {
        const accessor = f.name.startsWith("%get:") || f.name.startsWith("%set:");
        if (f.name.startsWith("%") && !accessor) continue;
        const name = accessor ? f.name.slice(5) : f.name;
        const eq: IrExpr = { kind: "strEq", negated: false, left: k, right: { kind: "strLit", value: name, type: STRING, loc }, type: BOOL, loc };
        const utag = !accessor && f.type.kind === "union" ? L.armTag(f.type.unionId, UNDEFINED_T) : -1;
        const get: IrExpr = { kind: "recordGet", obj: r, shapeId, field: f.name, type: f.type, loc };
        const answer: IrExpr =
          utag >= 0 && f.type.kind === "union"
            ? L.markPresence({ kind: "unionIsTag", unionId: f.type.unionId, tag: utag, negated: true, value: get, type: BOOL, loc }, shapeId, f.name)
            : (accessor ? null : plainFieldPresent(L, get, loc)) ?? t;
        body.push(ifThen(eq, [ret(answer, loc)], loc));
      }
      body.push(
        decl("ks.0", { kind: "recordOvfKeys", obj: r, shapeId, type: ksT, loc }, loc),
        decl("i.0", num(0, loc), loc),
        whileLoop(bin("<", i, arrLen(ks, loc), loc), [
          ifThen({ kind: "strEq", negated: false, left: k, right: { kind: "arrayGet", arr: ks, index: i, type: STRING, loc }, type: BOOL, loc }, [ret(t, loc)], loc),
          assign("i.0", bin("+", i, num(1, loc), loc), loc),
        ], loc),
        ret({ kind: "boolLit", value: false, type: BOOL, loc }, loc),
      );
      return body;
    },
  );
}

/* ── new Array(length), fill ─────────────────────────────────────────── */

/** The largest `new Array(n)` this tier builds (2^24 holes). */
const NEW_ARRAY_HOLES_MAX = 16777216;

/** `new Array(n)` on the WasmGC lanes: n must be a valid array length
 * (`n === n >>> 0`, else V8's `RangeError: Invalid array length`); the n
 * slots are HOLES, which these lanes hold as the element's undefined — the
 * representation a gap past an array's end already has, so every observer
 * that tells a hole from undefined stops by name (SEMANTICS.md S119). */
export function lowerNewArrayLength(L: Lowerer, lenNode: ts.Expression, arrT: IrType & { kind: "array" }, loc: SrcLoc): IrExpr | null {
  if (!L.undefSlots) return null;
  const n = L.lowerExpr(lenNode);
  if (n.type.kind !== "f64") return null;
  const helper = internHelper(
    L,
    `arr.ofLength:${typeKey(arrT)}`,
    "arr.ofLength",
    [{ id: "n.0", type: F64 }],
    [{ id: "a.0", type: arrT }, { id: "i.0", type: F64 }],
    arrT,
    loc,
    () => {
      const nn = ref("n.0", F64, loc);
      const i = ref("i.0", F64, loc);
      return [
        ifThen(bin("!==", nn, bin(">>>", nn, num(0, loc), loc), loc), [
          exprStmt(nodeThrowExpr(2, "", "Invalid array length", VOID, loc), loc),
        ], loc),
        // Every hole is allocated here, where V8 keeps a large array sparse:
        // past NEW_ARRAY_HOLES_MAX the program stops by name, never a bare
        // out-of-memory trap.
        ifThen(bin(">", nn, num(NEW_ARRAY_HOLES_MAX, loc), loc), [
          {
            kind: "runtimeFence",
            code: "SC1090",
            message: `new Array(n) with n above ${NEW_ARRAY_HOLES_MAX} (this tier allocates every hole, where Node keeps the array sparse — SEMANTICS.md S119) [SC1090 at a new Array]`,
            loc,
          } as IrStmt,
        ], loc),
        // n > 0 makes holes: raise the module's holes flag (an empty
        // literal carrying it), so the hole observers check this array
        ifThen(bin(">", nn, num(0, loc), loc), [exprStmt({ kind: "arrayLit", elems: [], holes: true, type: arrT, loc }, loc)], loc),
        decl("a.0", { kind: "arrayLit", elems: [], type: arrT, loc }, loc),
        decl("i.0", num(0, loc), loc),
        whileLoop(bin("<", i, nn, loc), [
          exprStmt({ kind: "arrIntrinsic", method: "push", receiver: ref("a.0", arrT, loc), args: [{ kind: "slotUndef", type: arrT.elem, loc } as IrExpr], type: F64, loc }, loc),
          assign("i.0", bin("+", i, num(1, loc), loc), loc),
        ], loc),
        ret(ref("a.0", arrT, loc), loc),
      ];
    },
  );
  return { kind: "call", callee: helper, args: [n], type: arrT, loc };
}

/** Array.prototype.fill(value, start, end): relative start and end (the
 * same resolution as slice: ToIntegerOrInfinity, negatives from the end,
 * clamped; end defaults to the length), every index between written;
 * answers the receiver. */
export function lowerArrayFill(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (L.chainBlocked(access, call)) return null;
  if (access.name.text !== "fill") return null;
  const args = call.arguments;
  if (args.length < 1 || args.length > 3 || args.some((a) => ts.isSpreadElement(a))) return null;
  const arrT = L.mapTypeOf(L.typeOf(access.expression));
  if (arrT?.kind !== "array") return null;
  if (!L.isStdlibMember(access)) return null;
  const loc = locOf(call);
  const recv = guardedRecv(L, access);
  if (!typeEquals(recv.type, arrT)) return null;
  const value = L.lowerExprExpecting(args[0]!, arrT.elem);
  if (!typeEquals(value.type, arrT.elem)) return null;
  const start = args.length >= 2 ? optionalNumber(L, args[1]!, num(0, loc)) : num(0, loc);
  if (!start) return null;
  const end = args.length >= 3 ? optionalNumber(L, args[2]!, num(Infinity, loc)) : num(Infinity, loc);
  if (!end) return null;
  const helper = internHelper(
    L,
    `arr.fill:${typeKey(arrT)}`,
    "arr.fill",
    [{ id: "a.0", type: arrT }, { id: "v.0", type: arrT.elem }, { id: "s.0", type: F64 }, { id: "e.0", type: F64 }],
    [{ id: "n.0", type: F64 }, { id: "k.0", type: F64 }, { id: "f.0", type: F64 }],
    arrT,
    loc,
    () => {
      const a = ref("a.0", arrT, loc);
      const nn = ref("n.0", F64, loc);
      const k = ref("k.0", F64, loc);
      const f = ref("f.0", F64, loc);
      const relative = (local: string, from: IrExpr): IrStmt[] => {
        const v = ref(local, F64, loc);
        return [
          decl(local, truncOf(from, loc), loc),
          ifThen(isNaNOf(v, loc), [assign(local, num(0, loc), loc)], loc),
          ifThen(
            bin("<", v, num(0, loc), loc),
            [assign(local, bin("+", nn, v, loc), loc), ifThen(bin("<", v, num(0, loc), loc), [assign(local, num(0, loc), loc)], loc)],
            loc,
            [ifThen(bin(">", v, nn, loc), [assign(local, nn, loc)], loc)],
          ),
        ];
      };
      return [
        decl("n.0", arrLen(a, loc), loc),
        ...relative("k.0", ref("s.0", F64, loc)),
        ...relative("f.0", ref("e.0", F64, loc)),
        whileLoop(bin("<", k, f, loc), [
          { kind: "arraySet", arr: a, index: k, value: ref("v.0", arrT.elem, loc), loc },
          assign("k.0", bin("+", k, num(1, loc), loc), loc),
        ], loc),
        ret(a, loc),
      ];
    },
  );
  return { kind: "call", callee: helper, args: [recv, value, start, end], type: arrT, loc };
}

/** GH #121: Array.prototype.copyWithin(target, start, end) — the three
 * positions resolve like fill's (ToIntegerOrInfinity, negatives from the
 * end, clamped; end defaults to the length); count = min(end - start,
 * length - target) elements move, backwards when the ranges overlap with
 * the source first, so the move reads the original elements. A stored hole
 * moves as the stored value (the S119 hole observers still see it).
 * Answers the receiver. */
export function lowerArrayCopyWithin(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (L.chainBlocked(access, call)) return null;
  if (access.name.text !== "copyWithin") return null;
  const args = call.arguments;
  if (args.length < 1 || args.length > 3 || args.some((a) => ts.isSpreadElement(a))) return null;
  const arrT = L.mapTypeOf(L.typeOf(access.expression));
  if (arrT?.kind !== "array") return null;
  if (!L.isStdlibMember(access)) return null;
  const loc = locOf(call);
  const recv = guardedRecv(L, access);
  if (!typeEquals(recv.type, arrT)) return null;
  const target = optionalNumber(L, args[0]!, num(0, loc));
  if (!target) return null;
  const start = args.length >= 2 ? optionalNumber(L, args[1]!, num(0, loc)) : num(0, loc);
  if (!start) return null;
  const end = args.length >= 3 ? optionalNumber(L, args[2]!, num(Infinity, loc)) : num(Infinity, loc);
  if (!end) return null;
  const helper = internHelper(
    L,
    `arr.copyWithin:${typeKey(arrT)}`,
    "arr.copyWithin", // width-copies.ts ARG_MUTATOR
    [{ id: "a.0", type: arrT }, { id: "t.0", type: F64 }, { id: "s.0", type: F64 }, { id: "e.0", type: F64 }],
    [{ id: "n.0", type: F64 }, { id: "to.0", type: F64 }, { id: "fr.0", type: F64 }, { id: "fi.0", type: F64 }, { id: "c.0", type: F64 }, { id: "d.0", type: F64 }],
    arrT,
    loc,
    () => {
      const a = ref("a.0", arrT, loc);
      const nn = ref("n.0", F64, loc);
      const to = ref("to.0", F64, loc);
      const fr = ref("fr.0", F64, loc);
      const fi = ref("fi.0", F64, loc);
      const c = ref("c.0", F64, loc);
      const d = ref("d.0", F64, loc);
      const relative = (local: string, from: IrExpr): IrStmt[] => {
        const v = ref(local, F64, loc);
        return [
          decl(local, truncOf(from, loc), loc),
          ifThen(isNaNOf(v, loc), [assign(local, num(0, loc), loc)], loc),
          ifThen(
            bin("<", v, num(0, loc), loc),
            [assign(local, bin("+", nn, v, loc), loc), ifThen(bin("<", v, num(0, loc), loc), [assign(local, num(0, loc), loc)], loc)],
            loc,
            [ifThen(bin(">", v, nn, loc), [assign(local, nn, loc)], loc)],
          ),
        ];
      };
      return [
        decl("n.0", arrLen(a, loc), loc),
        ...relative("to.0", ref("t.0", F64, loc)),
        ...relative("fr.0", ref("s.0", F64, loc)),
        ...relative("fi.0", ref("e.0", F64, loc)),
        // count = min(final - from, len - to)
        decl("c.0", bin("-", fi, fr, loc), loc),
        ifThen(bin(">", c, bin("-", nn, to, loc), loc), [assign("c.0", bin("-", nn, to, loc), loc)], loc),
        decl("d.0", num(1, loc), loc),
        ifThen(bin("<", fr, to, loc), [
          ifThen(bin("<", to, bin("+", fr, c, loc), loc), [
            assign("d.0", num(-1, loc), loc),
            assign("fr.0", bin("-", bin("+", fr, c, loc), num(1, loc), loc), loc),
            assign("to.0", bin("-", bin("+", to, c, loc), num(1, loc), loc), loc),
          ], loc),
        ], loc),
        whileLoop(bin(">", c, num(0, loc), loc), [
          { kind: "arraySet", arr: a, index: to, value: { kind: "arrayGet", arr: a, index: fr, type: arrT.elem, loc }, loc },
          assign("fr.0", bin("+", fr, d, loc), loc),
          assign("to.0", bin("+", to, d, loc), loc),
          assign("c.0", bin("-", c, num(1, loc), loc), loc),
        ], loc),
        ret(a, loc),
      ];
    },
  );
  return { kind: "call", callee: helper, args: [recv, target, start, end], type: arrT, loc };
}
