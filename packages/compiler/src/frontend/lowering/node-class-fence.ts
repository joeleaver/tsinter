/* Built-in class instances that map to records (types.ts: StringDecoder,
 * TextEncoder, TextDecoder, Intl.DateTimeFormat, WeakRef,
 * FinalizationRegistry) keep their state in a hidden internal slot. Node's
 * object has no such key: its state lives in internal slots, so it lists
 * no own keys and walks none. Every key walk over such a record refuses by
 * name here instead of showing the hidden slot (ir/nodes.ts
 * isNodeClassShape covers JSON text, inspection, String() and the dynamic
 * crossing). A crossing into any OTHER record or class type (a double cast
 * `w as unknown as Record<string, unknown>`, an index-signature or plain
 * record parameter) refuses by name too: the copy would be program data,
 * whose keys, `String()` and printing are not the instance's. */
import type * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { nodeClassLabel, type IrType, type SrcLoc } from "../../ir/nodes.js";

/** Refuse `surface` (a key walk: "Object.keys", "for-in", "Object.hasOwn",
 * the `in` operator, "Object.assign", "structuredClone") over a value of
 * type `t` when `t` is a built-in class instance's record; a no-op for any
 * other type. */
export function fenceNodeClassKeyWalk(L: Lowerer, t: IrType | null | undefined, node: ts.Node, surface: string): void {
  if (t?.kind !== "record") return;
  const shape = L.shapes.get(t.shapeId);
  const label = shape === undefined ? null : nodeClassLabel(shape);
  if (label === null) return;
  L.unsupported(
    "SC1090",
    node,
    `${surface} over ${label} instances (Node's object keeps its state in internal slots and has no own keys; the compiled record's hidden slot would show)`,
  );
}

/** The class label when a value of record shape `fromId` (a built-in class
 * instance's record) cannot cross into the type `to`: any type but a record
 * of the same class (`WeakRef<A>` into `WeakRef<object>` keeps the class and
 * reshapes only the slot). Null when the crossing is not a built-in
 * instance's, or keeps its class. */
export function nodeClassCrossingLabel(L: Lowerer, fromId: string, to: IrType): string | null {
  const from = L.shapes.get(fromId);
  const label = from === undefined ? null : nodeClassLabel(from);
  if (label === null) return null;
  if (to.kind === "record") {
    const toShape = L.shapes.get(to.shapeId);
    if (toShape !== undefined && nodeClassLabel(toShape) === label) return null;
  }
  return label;
}

/** Refuse a width crossing of a built-in class instance's record into the
 * record or class type `to` (an index-signature record, a plain record, a
 * class) by name; a no-op for any other pair (nodeClassCrossingLabel). */
export function fenceNodeClassCrossing(L: Lowerer, from: IrType, to: IrType, loc: SrcLoc): void {
  if (from.kind !== "record" || (to.kind !== "record" && to.kind !== "object")) return;
  const label = nodeClassCrossingLabel(L, from.shapeId, to);
  if (label === null) return;
  L.pushDiag(
    unsupportedDiag(
      "SC1090",
      loc,
      `${label} instances crossing into '${L.fmt(to)}' (Node's object keeps its state in internal slots and has no own keys; the copy into this type would be program data, its keys, printing and String() not the instance's)`,
    ),
  );
  throw new PoisonError();
}
