/* Unit S125-J, M2 (SEMANTICS.md S125 amendment (J)): the keys of a copy
 * of a fresh literal, judged from the literal itself.
 *
 * A literal written straight into a call (`select({ options: [{ value:
 * "a" as const, label }] })`, `iso.datetime({ offset: true })`) is lowered
 * at the parameter's declared shape and then width-copied (S125 (b)) into
 * the type the callee's instance takes. The literal is deep-fresh, so
 * writes and identity cannot tell the copy from it; only its keys can
 * (keysDiffer). keysDiffer answers from the two TYPES, and a declared
 * shape with optional fields the literal never spelled
 * (`{ local?; message?; offset?; precision? }`) lists keys the copy
 * lacks, so every such call refused.
 *
 * The literal's own keys are known statically. By S091 an optional field
 * is an own key exactly while it does not hold undefined, and a required
 * one always is, so for every field of either side this asks whether the
 * original and the copy agree on owning it:
 *
 *   - a field both sides declare: alike when both are optional or both
 *     required; otherwise only when the literal's value is statically
 *     never undefined (then both own it);
 *   - a field only the original declares: the copy lacks it, so the
 *     original must not own it — optional, holding a static undefined;
 *   - a field only the copy declares: the copy holds undefined there, so
 *     it must be optional.
 *
 * And the keys both may own must come in the same order on both sides:
 * the fast path's, and every order a GH #132 order note (`%ord.<n>`)
 * around the literal may store, must be the target's.
 * Every literal of the pair's source type inside the copied value is
 * checked (a nested pair's originals are all literals: the value is
 * deep-fresh). A pair with no literal of its source type found keeps the
 * type-based answer. */
import { type IrExpr, type IrRecordShape, type IrType, recordOrderFields } from "../../ir/nodes.js";
import type { WidthCx } from "./width-cx.js";
import { tkey } from "./width-copy-tables.js";

type RecordLit = IrExpr & { kind: "recordLit" };

/** A literal of the pair's source type, and the key orders it may have:
 * the fast path's (the shape's render order), and — when GH #132's
 * `%ord.<n>(lit)` notes its spelling — the order it stores. Null orders:
 * an order note this judgement cannot read. */
interface FoundLit {
  lit: RecordLit;
  orders: number[][] | null;
}

/** Could a key observer tell the copy of the fresh literal `arg` (or of
 * the literals of `from` inside it) from the original? Null: no literal
 * of `from` was found, so the question stays with the types. */
export function freshLiteralKeysDiffer(cx: WidthCx, arg: IrExpr | undefined, from: IrType, to: IrType): boolean | null {
  if (arg === undefined || from.kind !== "record" || to.kind !== "record") return null;
  const fromShape = cx.L.shapes.get(from.shapeId);
  const toShape = cx.L.shapes.get(to.shapeId);
  if (!fromShape || !toShape || fromShape.tuple || toShape.tuple || fromShape.indexValue !== undefined || toShape.indexValue !== undefined) return null;
  if (fromShape.fields.some((f) => f.internal) || toShape.fields.some((f) => f.internal)) return null;
  const found: FoundLit[] = [];
  collectLiterals(cx, arg, tkey(from), found, undefined, 0);
  if (found.length === 0) return null;
  const fromOpt = new Map(fromShape.fields.map((f) => [f.name, f.optional === true]));
  const toOpt = new Map(toShape.fields.map((f) => [f.name, f.optional === true]));
  const fromFields = recordOrderFields(fromShape).map((f) => f.name);
  const toOrder = recordOrderFields(toShape).map((f) => f.name);
  for (const { lit, orders } of found) {
    if (orders === null) return true;
    if (lit.fields.some((f) => f.overflow || f.drop)) return true;
    const value = (name: string): IrExpr | undefined => lit.fields.find((f) => f.name === name)?.value;
    const owned: string[] = [];
    for (const name of new Set([...fromOpt.keys(), ...toOpt.keys()])) {
      const fo = fromOpt.get(name);
      const to_ = toOpt.get(name);
      const v = value(name);
      if (fo !== undefined && to_ !== undefined) {
        if (fo !== to_ && undefinedness(v) !== "never") return true;
        if (!(fo && undefinedness(v) === "always")) owned.push(name);
      } else if (fo !== undefined) {
        if (!(fo && undefinedness(v) === "always")) return true;
      } else if (!to_) {
        return true;
      }
    }
    // The copy renders the target's order, or (GH #132's orderNoteCopy)
    // the original's: every order the original may have must be the
    // target's, over the keys either side may own.
    const want = toOrder.filter((n) => owned.includes(n)).join("\0");
    const fast = fromFields.filter((n) => owned.includes(n));
    if (orders.some((seq) => seq.some((i) => fromFields[i] === undefined))) return true;
    for (const o of [fast, ...orders.map((seq) => seq.map((i) => fromFields[i]!).filter((n) => owned.includes(n)))]) {
      if (o.join("\0") !== want) return true;
    }
  }
  return false;
}

/** Every record literal of type key `k` in a deep-fresh value, with the
 * order note wrapping it (`orders`: what it may store, null unread). */
function collectLiterals(cx: WidthCx, e: IrExpr, k: string, out: FoundLit[], orders: number[][] | null | undefined, depth: number): void {
  if (depth > 16) return;
  switch (e.kind) {
    case "recordLit":
      if (tkey(e.type) === k) out.push({ lit: e, orders: orders === undefined ? [] : orders });
      for (const f of e.fields) collectLiterals(cx, f.value, k, out, undefined, depth + 1);
      return;
    case "arrayLit":
      for (const x of e.elems) collectLiterals(cx, x, k, out, undefined, depth + 1);
      return;
    case "unionWrap":
    case "upcast":
      collectLiterals(cx, e.value, k, out, undefined, depth + 1);
      return;
    case "call": {
      const noted = orderNoted(e);
      if (/^%(union|nullish)\.retag\.\d+$/.test(e.callee) && e.args[0]) collectLiterals(cx, e.args[0], k, out, undefined, depth + 1);
      else if (noted !== null) collectLiterals(cx, noted, k, out, notedOrders(cx, e.callee), depth + 1);
      return;
    }
    default:
      return;
  }
}

/** GH #132's `%ord.<n>(lit) -> lit` (record-order.ts orderNoteLiteral):
 * the literal itself, with its spelling noted as its key order. Answers
 * the noted value, or null when `e` is not such a note. */
export function orderNoted(e: IrExpr): IrExpr | null {
  if (e.kind !== "call" || !/^%ord\.\d+$/.test(e.callee) || e.args.length !== 1) return null;
  const v = e.args[0]!;
  return e.type.kind === "record" && v.type.kind === "record" && tkey(e.type) === tkey(v.type) ? v : null;
}

/** The key orders an order note may store: each order vector it sets
 * (presence flags, then the field numbers in creation order). Null when
 * a vector is not a literal this can read. */
function notedOrders(cx: WidthCx, callee: string): number[][] | null {
  const fn = cx.byName.get(callee);
  if (fn === undefined) return null;
  const out: number[][] = [];
  let unread = false;
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const r = n as Record<string, unknown>;
    if (r["kind"] === "recordOrderSet" && r["hi"] !== true) {
      const v = r["value"] as IrExpr;
      const shape = cx.L.shapes.get(r["shapeId"] as string);
      if (v.kind !== "arrayLit" || shape === undefined || v.elems.some((x) => x.kind !== "numLit")) {
        unread = true;
        return;
      }
      const nums = v.elems.map((x) => (x as IrExpr & { kind: "numLit" }).value);
      out.push(nums.slice(fieldCount(shape)));
      return;
    }
    for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") walk(r[key]);
  };
  walk(fn.body);
  return unread ? null : out;
}

const fieldCount = (shape: IrRecordShape): number => recordOrderFields(shape).length;

/** Is a literal field's value undefined: always (it is absent, or a
 * static undefined), never (its type has no undefined), or only maybe? */
function undefinedness(v: IrExpr | undefined): "always" | "never" | "maybe" {
  if (v === undefined || v.kind === "slotUndef") return "always";
  if (v.kind === "unitLit") return v.unit === "undefined" ? "always" : "never";
  if (v.type.kind === "undefinedT") return "always";
  if (v.kind === "unionWrap") return undefinedness(v.value);
  return mayHoldUndefined(v.type) ? "maybe" : "never";
}

function mayHoldUndefined(t: IrType): boolean {
  switch (t.kind) {
    case "undefinedT":
    case "union":
    case "jsval":
    case "dyn":
      return true;
    default:
      return false;
  }
}
