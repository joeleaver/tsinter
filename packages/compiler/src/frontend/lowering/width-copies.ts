/* GH #109: width copies (SEMANTICS.md S125).
 *
 * Records are monomorphic structs and classes are their own structs, so a
 * value whose representation differs from its typed slot's — a class
 * instance into a record type, a wider record into a narrower one, `P[]`
 * into `{ n: number }[]`, a tuple into an array, a record into an
 * index-signature record — enters the slot as a COPY that an interned
 * width helper builds. JavaScript shares the object. (A direct call of a
 * plain function avoids the copy altogether: widthSpecializedCall binds
 * the parameter to the argument's own type.) A copy is exact only while
 * nothing could tell the two apart, so this post-pass, over the finished
 * function list, finds every copy and refuses by name (SC1090) each one
 * the program could observe:
 *
 *   - a WRITE to a copied field (or an array's elements) through the copy,
 *     which would not reach the original, or through the original after
 *     the copy, which the copy would not see;
 *   - an IDENTITY test (`===`, `includes`, `indexOf`, ...);
 *   - a KEY or PRINT observer (printing, JSON, Object.keys/values/entries,
 *     for-in, `in`, spread, a dynamic crossing, ...) on the copy, when its
 *     own keys or class differ from the original's.
 *
 * Two precisions, both sound:
 *
 *   BY BINDING. When the copy lands in a local (or a global, or a
 *   parameter of a directly called function) that nothing else assigns
 *   and nothing captures, the uses of that binding are the uses of the
 *   copy, so they are checked one by one. When the original is a binding
 *   assigned once from a fresh value (a literal, a `new` whose constructor
 *   keeps `this` to itself) and only ever read, nothing else holds it and
 *   nothing writes it.
 *
 *   BY TYPE, otherwise: a write to a value of the type counts, field by
 *   field (every field and element for an array or index-signature copy).
 *   Every use of a composite value outside the transparent positions below
 *   (field and element reads and writes, storing into locals/fields/
 *   elements, passing to the program's own functions, union wraps, null
 *   tests) is an observer of every type the value can reach, and a writer
 *   too unless it is a known read-only one (printing, JSON, key listing).
 *
 *   ORDER, cheaply: a write in a module initializer's top-level statement
 *   BEFORE the copy's has already happened. A copy handed to a parameter
 *   that never lets it go dies when the call returns, so only a write in a
 *   function that call can run (and the call must not suspend) can meet
 *   it. Nothing else is ordered: loops, other calls and closures count
 *   wherever they are.
 *
 *   A constructor's writes to its OWN instance are construction, unless the
 *   constructor hands `this` away (a call, a closure capturing it). It
 *   over-refuses; it never
 *   under-refuses.
 *
 * Where it lives. This file is the entry, widthCopyPass, which runs the
 * phases in order over one shared state (width-cx.ts's WidthCx):
 *
 *   width-collect.ts      the collection walk over every function body,
 *                         with width-uses.ts's notes and use classifiers;
 *   width-reach.ts        the reach sets, ctor leaks, value functions and
 *                         what a call can run (callReach, pairsOf);
 *   judge-width-sites.ts  S125 (b)'s judgement, asking width-copy-fresh.ts
 *                         (writes, keys, freshness, bindings);
 *   judge-dyn-sites.ts    S125 (c)'s judgement of the dynamic crossings,
 *                         asking dyn-alias-classes.ts (the unification),
 *                         dyn-copy-fresh.ts (ownership) and
 *                         dyn-copy-written.ts (writes and lifetimes).
 *
 * width-copy-tables.ts holds the fixed helper and node-kind tables. */
import type { IrFunction } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";
import { judgeDynSites } from "./judge-dyn-sites.js";
import { judgeWidthSites } from "./judge-width-sites.js";
import { collectUses } from "./width-collect.js";
import { hasDynCrossing, isCopyHelper } from "./width-copy-tables.js";
import { newWidthCx } from "./width-cx.js";
import { buildReachSets, collectValueFns, findCtorLeaks, noteFoldedObservers } from "./width-reach.js";

export { isCopyHelper } from "./width-copy-tables.js";

/** Finds every width copy and dynamic crossing in the finished function
 * list and refuses by name (SC1090) each one the program could observe. */
export function widthCopyPass(L: Lowerer, functions: IrFunction[]): void {
  const byName = new Map<string, IrFunction>();
  for (const f of functions) byName.set(f.name, f);
  if (![...byName.keys()].some(isCopyHelper) && !functions.some((f) => hasDynCrossing(f.body))) return;

  const cx = newWidthCx(L, functions, byName);
  collectUses(cx);
  noteFoldedObservers(cx);
  buildReachSets(cx);
  findCtorLeaks(cx);
  collectValueFns(cx);
  judgeWidthSites(cx);
  judgeDynSites(cx);
}
