/* S125 (b)'s judgement (SEMANTICS.md S125): every width copy, and every
 * island spread into a declared record shape, that the program could
 * observe refuses by name (SC1090). */
import type { IrType } from "../../ir/nodes.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { armFailureNote } from "./arm-failures.js";
import { freshLiteralKeysDiffer } from "./fresh-literal-keys.js";
import { readonlyCopyUnobserved } from "./readonly-copies.js";
import { copiedFields, deepFresh, destBinding, fresh, isWritten, judgeValue, keysDiffer, printDiffer, retagArgsFresh, sourceBinding, sourceIsSole } from "./width-copy-fresh.js";
import { IDENTITY, isComposite, KEYS, tkey, UNKNOWN, WRITE_FROM, WRITE_TO } from "./width-copy-tables.js";
import type { WidthCx } from "./width-cx.js";
import { callReach, pairsOf } from "./width-reach.js";
import { refsOf } from "./width-uses.js";

/** S125 (b): every width copy the program could observe refuses by name
 * (SC1090), and so does GH #148's island spread into a declared record
 * shape that may lack some of its keys. */
export function judgeWidthSites(cx: WidthCx): void {
  const reported = new Set<string>();
  // (fb73ae21 review) A typed value that crosses into a dynamic slot (an
  // `object`-typed binding, a Set<object> element, a WeakMap<object, …>
  // key) carries its identity there: where the program compares dynamic
  // values by identity, every type so crossed is identity-observed, so a
  // width copy of it (S125 (b)) — a different object in the slot — is
  // refused rather than compared unequal.
  if (cx.dynIdentity) {
    // (the one-world lanes: a typed composite enters the island as its
    // view or marshal — islandEntered)
    for (const k of cx.islandEntered) cx.identity.add(k);
    for (const d of cx.dynSites) {
      if (d.dir !== "in") continue;
      for (const t of [d.t, ...refsOf(cx, d.t).refs]) {
        if (!isComposite(t)) continue;
        cx.identity.add(tkey(t));
        if (t.kind === "union") for (const a of cx.L.unions.get(t.unionId)?.arms ?? []) cx.identity.add(tkey(a));
      }
    }
  }
  for (const s of cx.sites) {
    const pairs = [...(() => {
      const acc = new Map<string, { from: IrType; to: IrType }>();
      pairsOf(cx, s.callee, acc);
      return acc;
    })().values()];
    const top = pairs[0];
    if (!top) continue;
    // S125-J (M1): a read-only tuple into a read-only array slot that
    // nothing writes, lets go or compares by identity.
    if (readonlyCopyUnobserved(cx, s, pairs)) continue;
    const sole = sourceIsSole(cx, s);
    // The copy is the ONLY reference left: the source is fresh, or a sole
    // binding this copy is the one use of. Writes and identity cannot
    // tell then; only the copy's keys can.
    const unique = fresh(cx, s.arg) || (sole && sourceBinding(cx, s)?.uses.length === 1) ||
      // A union retag helper's arm, when every caller hands it a fresh
      // value (moment's `(minutes <= 1 && ['m']) || ...`): the copy of the
      // narrowed arm is the only reference left.
      (s.arg?.kind === "unionNarrow" && s.arg.value.kind === "varRef" && retagArgsFresh(cx, s.where));
    // A literal built only of literals and scalars (`[undefined, {}, {
    // t: [] }]`): no part has another reference, so a nested copy is as
    // unobservable to writes and identity as the top one (U1b — the JS
    // lane's option-table and case-list literals crossing into island
    // slots); only its keys can tell.
    const allFresh = deepFresh(cx, s.arg);
    const db = destBinding(cx, s);
    const uses = db?.uses ?? null;
    // The copy's PARTS are followed through the binding too, when nothing
    // hands the whole copy anywhere else.
    const partsKnown = db !== null && !db.uses.includes("other");
    // The copy cannot outlive the call it is passed to: a parameter whose
    // value never leaves (no "other" use). Its parts outlive it when one is
    // used otherwise or handed to a binding that lets it go.
    const calleeReach = s.dest?.param === true ? callReach(cx, s.dest.key.split("\0")[0]!) : null;
    const transient = calleeReach !== null && !calleeReach.suspends && partsKnown;
    const partsTransient = transient && db!.parts.every((pt) =>
      pt.via === undefined ? pt.use !== "other" : !(cx.bindings.get(pt.via)?.uses ?? []).includes("other"));
    // S125-J (M2): a deep-fresh literal's own keys are known statically
    // (S091), so a key observer is judged against the literal itself, not
    // against the declared shape it was lowered at.
    const litKeys = (p: { from: IrType; to: IrType }): boolean | null => allFresh ? freshLiteralKeysDiffer(cx, s.arg, p.from, p.to) : null;
    const kd = (p: { from: IrType; to: IrType }): boolean => litKeys(p) ?? keysDiffer(cx, p.from, p.to);
    const pd = (p: { from: IrType; to: IrType }): boolean => litKeys(p) ?? printDiffer(cx, p.from, p.to);
    let reason: string | null = null;
    let blame = top;
    for (const p of pairs) {
      const isTop = p === top;
      let why: string | null = null;
      // By type, flow-insensitively: the fallback wherever the binding
      // does not account for every use.
      const byType = (): string | null =>
        isWritten(cx, p.to, undefined, s) ? WRITE_TO
        : cx.identity.has(tkey(p.to)) ? IDENTITY
        : cx.reach.has(tkey(p.to)) && pd(p) ? KEYS
        : null;
      if (isTop) {
        if (uses !== null) {
          // The copy's uses, one by one ("other" may print as well).
          if ((uses.includes("print") || uses.includes("other")) && pd(p)) why = KEYS;
          else if ((uses.includes("keys") || cx.foldedKeys.has(tkey(p.to))) && kd(p)) why = KEYS;
          else if (cx.foldedClass.has(tkey(p.to)) && pd(p)) why = KEYS;
          else if (uses.includes("other") && !unique) why = byType();
          // (fb73ae21 review) a copy whose type crosses into dynamic slots
          // the program compares by identity (an `object` binding, a
          // Set<object> element, a WeakMap<object, …> key — the crossing
          // is a "keys" use here): a different object where JavaScript's
          // is the same, so the copy refuses.
          else if (!unique && uses.length > 0 && cx.identity.has(tkey(p.to))) why = IDENTITY;
        } else if (!unique) {
          why = byType();
        } else if (cx.reach.has(tkey(p.to)) && pd(p)) {
          why = KEYS;
        }
      } else if (allFresh) {
        if (cx.reach.has(tkey(p.to)) && pd(p)) why = KEYS;
      } else {
        const j = partsKnown ? judgeValue(cx, db!, top.to, p, 0) : UNKNOWN;
        why = j === UNKNOWN ? byType() : j;
      }
      // (Comparing ORIGINALS involves no copy: a copy's static type is the
      // slot's, so a test that could meet one is on the slot's type.)
      if (!why && !(isTop && sole) && !allFresh && isWritten(cx, p.from, copiedFields(cx, p.from, p.to), s, (isTop ? transient : partsTransient) ? calleeReach!.fns : null)) why = WRITE_FROM;
      if (why) {
        reason = why;
        blame = p;
        break;
      }
    }
    if (!reason) continue;
    const at = `${s.loc.file}:${s.loc.start}`;
    if (reported.has(at)) continue;
    reported.add(at);
    const nested = blame !== top ? ` (inside it, '${cx.L.fmt(blame.from)}' into '${cx.L.fmt(blame.to)}')` : "";
    cx.L.pushDiag(
      unsupportedDiag(
        "SC1090",
        s.loc,
        `a '${cx.L.fmt(top.from)}' value where '${cx.L.fmt(top.to)}' is expected${nested}: the slot would hold a COPY where JavaScript shares the object, and ${reason} (SEMANTICS.md S125)${armFailureNote(cx.L, s.loc)}`,
        `give the slot the value's own type ('${cx.L.fmt(top.from)}'), or make the function generic over it (<T extends ${cx.L.fmt(top.to)}>(x: T) keeps the object)`,
      ),
    );
  }
  // GH #148 (review): `{ ...x }` over a dynamic source into a declared
  // record shape keeps only the shape's fields, where Node's object keeps
  // every key: judged like a (b) copy by its keys alone (the literal is
  // fresh, so writes and identity cannot tell). Its own binding's uses when
  // it has one; otherwise any printer or key listing reaching the type.
  for (const s of cx.spreadExits) {
    const db = s.dest === null ? null : destBinding(cx, { callee: "%dyn.spread", arg: undefined, loc: s.loc, where: "", top: 0, dest: s.dest });
    const types = [s.t, ...s.arms];
    const observed = db !== null
      ? db.uses.some((u) => u === "print" || u === "keys") ||
        db.uses.filter((u) => u === "other").length > (db.fieldWrites ?? 0) ||
        types.some((t) => cx.foldedKeys.has(tkey(t)) || cx.foldedClass.has(tkey(t)))
      : types.some((t) => cx.reachNoSpec.has(tkey(t)) || cx.foldedKeys.has(tkey(t)));
    if (!observed) continue;
    const at = `${s.loc.file}:${s.loc.start}`;
    if (reported.has(at)) continue;
    reported.add(at);
    cx.L.pushDiag(
      unsupportedDiag(
        "SC1090",
        s.loc,
        `an object spread of a dynamic value into '${cx.L.fmt(s.t)}': the record keeps only the type's own fields where JavaScript's object keeps every key the source has, and ${KEYS} (SEMANTICS.md S125)`,
        `give the slot a dynamic type ('any' or 'unknown') to keep every key, or copy the fields you need explicitly ({ b: x.b })`,
      ),
    );
  }
}
