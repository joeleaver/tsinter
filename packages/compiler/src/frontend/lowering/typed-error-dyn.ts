/* GH #193 (SEMANTICS.md S080, S138): an Error held in a TYPED slot, used
 * where Node walks or extends its own properties, takes the error's
 * dynamic encoding — the same JS value (dyn.ts fromError's identity
 * cache), whose user view (dyn.ts errUserView, backend/wasm/err-own.ts)
 * lists what Node lists: an own `name` or `code` the program wrote, in
 * write order; never the non-enumerable `message` and `stack` or the
 * inherited `name`.
 *
 * A JavaScript tag's `const e = new Error("m"); e.code = "E"` is the
 * common case: the checker types `e` as Error, so without this the write
 * stopped at "assignment to non-variables" and a listing at "no scriptc
 * lowering", where the same error held as `any` already answered as
 * Node. The constructs routed here, on the WasmGC lanes' one dynamic
 * world (omActive) only:
 *  - an expando write `e.k = v` (a key the type does not declare, or the
 *    builtin `stack`/`cause`; `name` and `message` keep their typed slot
 *    writes, which mark the encoding themselves);
 *  - `Object.keys`/`values`/`entries(e)`;
 *  - `for (k in e)`;
 *  - a JavaScript object literal spreading `...e`.
 * Everything else about a typed error keeps its typed lowering. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { DYN, JSVAL, STRING, VOID, type IrExpr, type IrStmt } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import { omActive } from "./lower-objmodel.js";

/** Builtin Error members whose write is an ordinary own property in Node
 * and has no typed slot here: they live in the encoding. */
const ENCODING_MEMBERS: ReadonlySet<string> = new Set(["stack", "cause"]);

/** Is `node` statically an instance of the Error hierarchy (a builtin
 * error class or a program's `extends Error` subclass), on a lane whose
 * dynamic world holds the error's encoding? */
export function isTypedErrorNode(L: Lowerer, node: ts.Expression): boolean {
  if (!omActive(L)) return false;
  let m;
  try {
    m = L.mapTypeOf(L.typeOf(node));
  } catch {
    return false;
  }
  return m?.kind === "object" && L.errorHierarchyClassOf(m.className);
}

/** The error `node` evaluates to as its dynamic encoding, or null when
 * `node` is not a typed error (isTypedErrorNode). */
export function typedErrorAsDyn(L: Lowerer, node: ts.Expression): IrExpr | null {
  if (!isTypedErrorNode(L, node)) return null;
  const v = L.lowerExpr(node);
  if (v.type.kind === "dyn") return v;
  if (v.type.kind !== "object" || !L.errorHierarchyClassOf(v.type.className)) L.badType(node, L.typeOf(node));
  return { kind: "dynFrom", value: L.upcastTo(v, "%Error"), type: DYN, loc: v.loc };
}

/** typedErrorAsDyn as the object model's value (a for-in receiver). */
export function typedErrorAsJsval(L: Lowerer, node: ts.Expression): IrExpr | null {
  const d = typedErrorAsDyn(L, node);
  return d === null ? null : { kind: "jsMarshal", value: d, type: JSVAL, loc: d.loc };
}

/** `e.k = v` in statement position over a typed error whose type gives
 * `k` no slot: the write lands on the error's encoding (dyn.keySet, which
 * writes through to the error, dyn.ts objPutW), an own enumerable property
 * as in Node. Null for any other target: a member a program's class
 * declares (its field, accessor or method) keeps the typed paths. */
export function lowerTypedErrorExpandoWrite(L: Lowerer, left: ts.PropertyAccessExpression, right: ts.Expression, loc: IrExpr["loc"]): IrStmt | null {
  if (left.questionDotToken || !ts.isIdentifier(left.name)) return null;
  if (!isTypedErrorNode(L, left.expression)) return null;
  const key = left.name.text;
  if (key === "name" || key === "message") return null;
  const sym = L.checker.getPropertyOfType(L.typeOf(left.expression), key);
  if (sym !== undefined && !(L.isStdlibSymbol(sym) && ENCODING_MEMBERS.has(key))) return null;
  const recv = typedErrorAsDyn(L, left.expression)!;
  const keyIr: IrExpr = { kind: "strLit", value: key, type: STRING, loc: locOf(left.name) };
  const value = L.lowerExprExpecting(right, DYN);
  return { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.keySet", args: [recv, keyIr, value], type: VOID, loc }, loc };
}
