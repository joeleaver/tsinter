/* Intl.DateTimeFormat (paperclip's stdlib batch 3, SEMANTICS.md S151):
 * one formatter form with a built-in formatting — paperclip's routine
 * timestamp,
 *
 *   new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long",
 *     day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
 *     timeZone: "UTC", timeZoneName: "short" })
 *
 * whose `format(date)` is ICU's "April 28, 2026 at 12:17 PM UTC" (CLDR's
 * en-US pattern "MMMM d, y 'at' h:mm a z"; Node 24 puts a plain space before
 * the day period).
 * A value is a one-field record naming the form (types.ts); construction
 * with any other locale or options bag refuses by name, and `format` is
 * the one member (the rest keep the SC2020 fence). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { nodeThrowExpr } from "./lowerer.js";
import { locOf } from "../program.js";
import { BOOL, DYN, F64, STRING, arrayOf, type IrExpr, type IrStmt, type IrType, type SrcLoc } from "../../ir/nodes.js";

const PAPERCLIP_FORM = "en-US:MMMMdyhmmaz:UTC";
const PAPERCLIP_OPTIONS: Readonly<Record<string, string | boolean>> = {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
  timeZoneName: "short",
};

/** True when `expr` is `new Intl.DateTimeFormat(...)` on the stdlib Intl. */
export function isIntlDtfNew(L: Lowerer, expr: ts.NewExpression): boolean {
  const c = expr.expression;
  return L.sharedDynamic && ts.isPropertyAccessExpression(c) && c.name.text === "DateTimeFormat" && ts.isIdentifier(c.expression) &&
    L.isStdlibGlobal(c.expression, "Intl");
}

/** The record a supported construction builds; refuses every other form. */
export function lowerIntlDtfNew(L: Lowerer, expr: ts.NewExpression): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments ?? [];
  const ok =
    args.length === 2 &&
    ts.isStringLiteral(args[0]!) && args[0].text === "en-US" &&
    ts.isObjectLiteralExpression(args[1]!) &&
    (() => {
      const bag = args[1] as ts.ObjectLiteralExpression;
      const seen = new Set<string>();
      for (const p of bag.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return false;
        const want = PAPERCLIP_OPTIONS[p.name.text];
        if (want === undefined || seen.has(p.name.text)) return false;
        seen.add(p.name.text);
        const v = p.initializer;
        const got = ts.isStringLiteral(v) ? v.text : v.kind === ts.SyntaxKind.TrueKeyword ? true : v.kind === ts.SyntaxKind.FalseKeyword ? false : null;
        if (got !== want) return false;
      }
      return seen.size === Object.keys(PAPERCLIP_OPTIONS).length;
    })();
  if (!ok) {
    L.noLowering(
      "new Intl.DateTimeFormat beyond the built-in form",
      expr,
      'the built-in form is new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC", timeZoneName: "short" }) — other locales and options are ICU data the binary does not carry',
    );
  }
  const t = L.mapTypeOf(L.typeOf(expr));
  if (t?.kind !== "record") L.badType(expr, L.typeOf(expr));
  // the options bag is a literal of literals: nothing in it evaluates
  return { kind: "recordLit", fields: [{ name: "%dtf", value: { kind: "strLit", value: PAPERCLIP_FORM, type: STRING, loc } }], type: t, loc };
}

/** `dtf.format(date?)` on a DateTimeFormat value. Null for other calls. */
export function lowerIntlDtfCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  const recvT = L.mapTypeOf(L.typeOf(access.expression));
  if (!L.sharedDynamic || recvT?.kind !== "record" || !L.shapes.get(recvT.shapeId)?.fields.some((f) => f.name === "%dtf")) return null;
  if (access.name.text !== "format" || call.questionDotToken || access.questionDotToken) return null;
  const loc = locOf(call);
  if (call.arguments.length > 1 || call.arguments.some((a) => ts.isSpreadElement(a))) {
    L.noLowering(`DateTimeFormat.format with ${call.arguments.length} arguments`, call);
  }
  const receiver = L.lowerExpr(access.expression);
  const stmts: IrStmt[] = [{ kind: "exprStmt", expr: receiver, loc }];
  // ToNumber of the date (a Date's time value; undefined is now)
  let ms: IrExpr;
  const now: IrExpr = { kind: "libCall", fn: "date.now", args: [], type: F64, loc };
  if (call.arguments.length === 0) ms = now;
  else {
    const a = L.lowerExpr(call.arguments[0]!);
    if (a.type.kind === "f64") ms = a;
    else if (a.type.kind === "dyn" || a.type.kind === "jsval") {
      const d = L.declareHiddenLocal("%dtfArg", DYN);
      const dv: IrExpr = a.type.kind === "dyn" ? a : { kind: "dynFrom", value: a, type: DYN, loc };
      stmts.push({ kind: "varDecl", localId: d.id, init: dv, loc });
      const ref: IrExpr = { kind: "varRef", localId: d.id, type: DYN, loc };
      ms = {
        kind: "ternary",
        cond: { kind: "dynTest", test: "undefined", value: ref, type: BOOL, loc },
        then: now,
        else_: { kind: "libCall", fn: "dyn.toNumber", args: [ref], type: F64, loc },
        type: F64,
        loc,
      };
    } else {
      return L.noLowering(`DateTimeFormat.format of '${L.fmt(a.type)}' values`, call.arguments[0]!);
    }
  }
  return { kind: "seqExpr", stmts, result: { kind: "call", callee: dtfHelper(L), args: [ms], type: STRING, loc }, type: STRING, loc };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `%intl.dtf.paperclip(ms) -> string`, the formatting itself. */
function dtfHelper(L: Lowerer): string {
  const name = "%intl.dtf.paperclip";
  if (L.liftedFns.some((f) => f.name === name)) return name;
  const loc: SrcLoc = { file: "<builtin>", start: 0, end: 0 };
  const n = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F64, loc });
  const s = (v: string): IrExpr => ({ kind: "strLit", value: v, type: STRING, loc });
  const v = (id: string): IrExpr => ({ kind: "varRef", localId: id, type: F64, loc });
  const bin = (op: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | "===", a: IrExpr, b: IrExpr): IrExpr =>
    ({ kind: "bin", op, left: a, right: b, type: op === "<" || op === "<=" || op === ">" || op === "===" ? BOOL : F64, loc });
  const floor = (a: IrExpr): IrExpr => ({ kind: "libCall", fn: "math.floor", args: [a], type: F64, loc });
  const cat = (...parts: IrExpr[]): IrExpr => parts.reduce((x, y) => ({ kind: "strConcat", left: x, right: y, type: STRING, loc }));
  const str = (a: IrExpr): IrExpr => ({ kind: "toString", operand: a, type: STRING, loc });
  const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [];
  const body: IrStmt[] = [];
  const let_ = (id: string, init: IrExpr): void => {
    locals.push({ id, name: id, type: F64, mutable: false });
    body.push({ kind: "varDecl", localId: id, init, loc });
  };
  // TimeClip: NaN or beyond ±8.64e15 is Node's RangeError
  body.push({
    kind: "if",
    cond: {
      kind: "logical",
      op: "||",
      left: { kind: "unary", op: "!", operand: bin("===", v("ms.0"), v("ms.0")), type: BOOL, loc },
      right: bin(">", { kind: "libCall", fn: "math.abs", args: [v("ms.0")], type: F64, loc }, n(8.64e15)),
      type: BOOL,
      loc,
    },
    then: [{ kind: "exprStmt", expr: nodeThrowExpr(2, "", "Invalid time value", F64, loc), loc }],
    else_: null,
    loc,
  });
  let_("t.0", { kind: "libCall", fn: "math.trunc", args: [v("ms.0")], type: F64, loc });
  let_("days.0", floor(bin("/", v("t.0"), n(864e5))));
  let_("rem.0", bin("-", v("t.0"), bin("*", v("days.0"), n(864e5))));
  let_("h.0", floor(bin("/", v("rem.0"), n(36e5))));
  let_("mi.0", floor(bin("/", bin("-", v("rem.0"), bin("*", v("h.0"), n(36e5))), n(6e4))));
  // civil_from_days (H. Hinnant), in exact f64 integer arithmetic
  let_("z.0", bin("+", v("days.0"), n(719468)));
  let_("era.0", floor(bin("/", v("z.0"), n(146097))));
  let_("doe.0", bin("-", v("z.0"), bin("*", v("era.0"), n(146097))));
  let_("yoe.0", floor(bin("/", bin("-", bin("+", bin("-", v("doe.0"), floor(bin("/", v("doe.0"), n(1460)))), floor(bin("/", v("doe.0"), n(36524)))), floor(bin("/", v("doe.0"), n(146096)))), n(365))));
  let_("doy.0", bin("-", v("doe.0"), bin("-", bin("+", bin("*", n(365), v("yoe.0")), floor(bin("/", v("yoe.0"), n(4)))), floor(bin("/", v("yoe.0"), n(100))))));
  let_("mp.0", floor(bin("/", bin("+", bin("*", n(5), v("doy.0")), n(2)), n(153))));
  let_("d.0", bin("+", bin("-", v("doy.0"), floor(bin("/", bin("+", bin("*", n(153), v("mp.0")), n(2)), n(5)))), n(1)));
  let_("m.0", { kind: "ternary", cond: bin("<", v("mp.0"), n(10)), then: bin("+", v("mp.0"), n(3)), else_: bin("-", v("mp.0"), n(9)), type: F64, loc });
  let_("y.0", bin("+", bin("+", v("yoe.0"), bin("*", v("era.0"), n(400))), { kind: "ternary", cond: bin("<=", v("m.0"), n(2)), then: n(1), else_: n(0), type: F64, loc }));
  // ICU writes years before 1 with its era form: not built in
  body.push({
    kind: "if",
    cond: bin("<", v("y.0"), n(1)),
    then: [{ kind: "runtimeFence", code: "SC2020", message: "Intl.DateTimeFormat format of a date before the year 1 (ICU's era form) is not supported yet (SEMANTICS.md S151) [SC2020 at Intl.DateTimeFormat.format]", loc }],
    else_: null,
    loc,
  });
  locals.push({ id: "mon.0", name: "mon", type: arrayOf(STRING), mutable: false });
  body.push({ kind: "varDecl", localId: "mon.0", init: { kind: "arrayLit", elems: MONTHS.map(s), type: arrayOf(STRING), loc }, loc });
  const h12: IrExpr = {
    kind: "ternary",
    cond: bin("===", bin("-", v("h.0"), bin("*", floor(bin("/", v("h.0"), n(12))), n(12))), n(0)),
    then: n(12),
    else_: bin("-", v("h.0"), bin("*", floor(bin("/", v("h.0"), n(12))), n(12))),
    type: F64,
    loc,
  };
  const mm: IrExpr = { kind: "ternary", cond: bin("<", v("mi.0"), n(10)), then: cat(s("0"), str(v("mi.0"))), else_: str(v("mi.0")), type: STRING, loc };
  const ampm: IrExpr = { kind: "ternary", cond: bin("<", v("h.0"), n(12)), then: s(" AM"), else_: s(" PM"), type: STRING, loc };
  const month: IrExpr = { kind: "arrayGet", arr: { kind: "varRef", localId: "mon.0", type: arrayOf(STRING), loc }, index: bin("-", v("m.0"), n(1)), type: STRING, loc };
  body.push({
    kind: "return",
    value: cat(month, s(" "), str(v("d.0")), s(", "), str(v("y.0")), s(" at "), str(h12), s(":"), mm, ampm, s(" UTC")),
    loc,
  });
  L.liftedFns.push({ name, params: [{ localId: "ms.0", name: "ms", type: F64 }], returnType: STRING, locals: [{ id: "ms.0", name: "ms", type: F64, mutable: false }, ...locals], body, loc });
  return name;
}
