/* Built-in class instances that map to records (types.ts: StringDecoder,
 * TextEncoder, TextDecoder, Intl.DateTimeFormat, WeakRef,
 * FinalizationRegistry) keep their state in a hidden internal slot. Node's
 * object has no such key: its state lives in internal slots, so it lists
 * no own keys and walks none. Every key walk over such a record refuses by
 * name here instead of showing the hidden slot (ir/nodes.ts
 * isNodeClassShape covers JSON text, inspection, String() and the dynamic
 * crossing). */
import type * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { nodeClassLabel, type IrType } from "../../ir/nodes.js";

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
