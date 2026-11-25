/* S125 (c)'s write and lifetime questions (SEMANTICS.md S125): is a
 * dynamic or typed value written while a crossing's copy may be held, how
 * long that copy lives, and whether it is compared by identity. */
import type { IrExpr, IrType } from "../../ir/nodes.js";
import { freshRooted, rootKey, uniqueDyn, unwrap } from "./dyn-copy-fresh.js";
import { passesDyn } from "./width-collect.js";
import { destBinding, isWritten } from "./width-copy-fresh.js";
import { DYN_MUTATING, DYN_READER, PRINT_HELPER, PURE_LIB, RUNTIME_KINDS, tkey } from "./width-copy-tables.js";
import type { Binding, DynJudgeCx, DynSite, DynWindow, Site } from "./width-cx.js";
import { callReach } from "./width-reach.js";
import { bkey, refsOf } from "./width-uses.js";

/** A record type with no member named `m` and no index signature. */
function recordLacks(cx: DynJudgeCx, t: IrType, m: string): boolean {
  if (t.kind !== "record") return false;
  const sh = cx.L.shapes.get(t.shapeId);
  return sh !== undefined && sh.indexValue === undefined && !sh.fields.some((f) => f.name === m);
}

/** Is a dynamic value written where a copy taken at `site` could still
 * be held (`during`: only in these functions)? The width copies'
 * ordering rule: an earlier top-level statement of the same module
 * initializer has already run. A write to the own members of a
 * fresh-rooted binding counts only for a copy taken OUT of that
 * binding's value (`outOf`). With `value` (the copy, or the value a
 * copy was taken from), only a write whose receiver may be that value
 * counts (dynAliasClasses). */
export function dynWritten(cx: DynJudgeCx, site: Site | null, during: Set<string> | DynWindow | null, outOf: string | null = null, value: { e: IrExpr; fn: string } | null = null, dead: { fn: string; top: number } | null = null, refs: IrType[] | null = null): boolean {
  return cx.dynWrites.some((w) => {
      if (dead !== null && w.fn === dead.fn && w.top > dead.top) return false;
      // An array mutator called by name changes only its receiver, and
      // only a receiver that has that method: a copy made of records
      // with no member of that name (and no index signature) cannot be
      // the receiver, so the call cannot write it. (Not with --dynamic:
      // an engine object's own method of that name may be anything.)
      if (!cx.opaqueCalls && refs !== null && w.method !== undefined && DYN_MUTATING.has(w.method) && refs.every((t) => recordLacks(cx, t, w.method!))) return false;
      // A store into a NAMED member changes only that member: a copy made
      // of records with no member of that name (and no index signature)
      // holds nothing the store could change, and whether the original
      // carries the member is a width question (DYN_WIDTH, judged on its
      // own). (`BLOCK_RE.lastIndex = i` over a RegExp shared into dynamic
      // code against a copy of `{ width, index, truncated, ellipsed }`.)
      if (!cx.opaqueCalls && refs !== null && refs.length > 0 && w.key !== undefined && refs.every((t) => recordLacks(cx, t, w.key!))) return false;
      if (value !== null && w.recv !== null && !cx.alias.same(w.recv, w.fn, value.e, value.fn)) return false;
      if (freshRooted(cx, w.recv, w.fn) && !(outOf !== null && rootKey(cx, w.recv, w.fn) === outOf)) return false;
      if (during === null) return !(site !== null && w.fn === site.where && /^%init\.\d+$/.test(w.fn) && w.top < site.top);
      if (during instanceof Set) return during.has(w.fn);
      // A window: in the crossing's own function only inside its scope.
      if (site !== null && w.fn === site.where && during.inside !== null) return w.anc.some((a) => during.inside!.includes(a));
      return during.fns.has(w.fn);
    });
}

/** A local dynamic binding that owns its value all the way down: built
 * fresh, never captured, and only read, written in place (storing
 * values nothing else holds) or crossed out. Once the function returns
 * nothing can reach it, so a copy built for the `return` is the only
 * holder left. */
export function ownedLocal(cx: DynJudgeCx, e: IrExpr | undefined, fn: string): boolean {
  const v = unwrap(cx, e);
  if (!v || v.kind !== "varRef") return false;
  const key = bkey(cx, fn, v.localId);
  if (key.startsWith("g\0")) return false;
  const b = cx.bindings.get(key);
  if (!b || b.captured || b.assigns.length === 0 || !b.assigns.every((a) => uniqueDyn(cx, a, fn))) return false;
  return (cx.ownUses.get(key) ?? []).every((u) =>
    u.use === "ro" || u.use === "exit" || (u.use === "recv" && (u.stored ?? []).every((x) => !passesDyn(cx, x) || uniqueDyn(cx, x, fn))));
}

/** The functions that can run while an out-crossing's copy is alive,
 * when its binding is a local nothing captures and every use of it is
 * known (null: anything can). */
export function copyWindow(cx: DynJudgeCx, s: DynSite): DynWindow | null {
  // A sequence's temporary lives while the sequence evaluates.
  if (s.scope !== undefined && s.dest !== null) {
    const db = destBinding(cx, s);
    if (db === null || db.uses.includes("other") || db.parts.some((p) => p.use === "other" || p.via !== undefined)) return null;
    const reach = nodeReach(cx, s.scope);
    return reach.suspends ? null : { fns: reach.fns, inside: [s.scope] };
  }
  // A local (holding the copy or a part of it) read only in the
  // statements from its declaration to its last use, all in one list:
  // the copy lives while those statements run.
  const h = s.holder;
  if (!h || h.key.startsWith("g\0")) return null;
  const hb = holderBinding(cx, s);
  if (hb === null) return null;
  const id = h.key.split("\0")[1]!;
  let seen = 0;
  let last = h.index;
  for (let k = h.index; k < h.list.length; k++) {
    const c = countRefs(cx, h.list[k], id);
    if (c > 0) last = k;
    seen += c;
  }
  if (seen !== hb.uses.length) return null;
  const nodes = h.list.slice(h.index, last + 1);
  const reach = nodeReach(cx, nodes);
  return reach.suspends ? null : { fns: reach.fns, inside: nodes };
}

/** The binding of an out-crossing's holder, when nothing captures or
 * reassigns it and every use of it (and of its parts) only reads. */
export function holderBinding(cx: DynJudgeCx, s: DynSite): Binding | null {
  const h = s.holder;
  if (!h) return null;
  const b = cx.bindings.get(h.key);
  if (!b || b.captured || b.assigns.length !== 1 || b.uses.includes("other")) return null;
  if (b.parts.some((p) => p.use === "other" || p.via !== undefined)) return null;
  return b;
}

function countRefs(cx: DynJudgeCx, n: unknown, id: string): number {
  if (n === null || typeof n !== "object") return 0;
  if (Array.isArray(n)) return n.reduce((a: number, x) => a + countRefs(cx, x, id), 0);
  const r = n as Record<string, unknown>;
  let c = r["kind"] === "varRef" && r["localId"] === id ? 1 : 0;
  for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") c += countRefs(cx, r[key], id);
  return c;
}

/** Does the program define an accessor a property read could run
 * (an island getter, Object.defineProperty on a dynamic value)? */
function accessorsDefined(cx: DynJudgeCx): boolean {
  if (cx.accessorsMemo !== null) return cx.accessorsMemo;
  let found = false;
  const scan = (n: unknown): void => {
    if (found || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(scan);
    const r = n as Record<string, unknown>;
    if ((r["kind"] === "jsOp" && r["op"] === "defineGetter") || (r["kind"] === "libCall" && r["fn"] === "dyn.defineProps")) {
      found = true;
      return;
    }
    for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
  };
  for (const f of cx.functions) scan(f.body);
  return (cx.accessorsMemo = found);
}

/** The functions evaluating `node` can run, and whether that set is
 * open (callReach's rules, for one node). */
function nodeReach(cx: DynJudgeCx, node: unknown): { fns: Set<string>; suspends: boolean } {
  const fns = new Set<string>();
  let suspends = false;
  const enter = (name: string): void => {
    if (fns.has(name)) return;
    const r = callReach(cx, name);
    for (const f of r.fns) fns.add(f);
    suspends ||= r.suspends;
  };
  const scan = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(scan);
    const r = n as Record<string, unknown>;
    const k = r["kind"];
    if (k === "call") enter(r["callee"] as string);
    else if (k === "closure") enter(r["fnName"] as string);
    else if (k === "new") enter(`%${r["className"] as string}.constructor`);
    else if (k === "virtualCall") {
      for (const other of cx.byName.keys()) if (other.endsWith(`.${r["method"] as string}`)) enter(other);
    } else if (k === "callValue" || k === "dynCall" || k === "dynInvoke") {
      for (const v of cx.valueFns) enter(v);
    } else if (k === "awaitExpr" || k === "awaitUnionExpr" || k === "yieldExpr" || k === "genResume") suspends = true;
    else if (k === "libCall") {
      if (!PURE_LIB.test(r["fn"] as string) && !DYN_READER.test(r["fn"] as string)) suspends = true;
    } else if (k === "intrinsic") {
      if (!/^console\./.test(r["name"] as string)) suspends = true;
    } else if (k === "arrIntrinsic") {
      if (["sort", "toSorted", "typedSort"].includes(r["method"] as string)) for (const v of cx.valueFns) enter(v);
    } else if (k === "dynFrom" || k === "dynCheck") {
      // A crossing runs code only through a function it boxes or unboxes.
      const t = k === "dynFrom" ? (r["value"] as IrExpr).type : (r["type"] as IrType);
      if (t.kind === "func" || refsOf(cx, t).fns.length > 0) suspends = true;
    } else if (k === "jsExit" || k === "jsUnview" || k === "jsMarshal" || k === "jsView") {
      // Checking, viewing or marshaling a value runs no code (a function
      // value is boxed or unboxed, not called).
    } else if (k === "jsOp") {
      // Island operations run code (a call, a setter, a valueOf), except
      // tests, literals and plain reads — and a read runs a getter only
      // where the program defines one.
      const op = r["op"] as string;
      const pure = ["typeof", "truthy", "not", "objLit", "arrLit", "tplStrings", "globalGet"].includes(op) ||
        ((op === "getProp" || op === "getIdx") && !accessorsDefined(cx));
      if (!pure) suspends = true;
    } else if (RUNTIME_KINDS.has(k as string)) suspends = true;
    for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
  };
  scan(node);
  return { fns, suspends };
}

/** Is the original written while the in-crossing's copy is held? The
 * copy's alias class says where it can be held: nowhere (it is read
 * where it is made, before the original can change), only by
 * parameters of functions that read it and return (while such a call
 * runs), or by anything else (then by type, as ever). */
export function origWrittenWhileHeld(cx: DynJudgeCx, s: DynSite, types: IrType[], dead: { fn: string; top: number } | null): boolean {
  const holders = cx.alias.holders(s.node, s.where);
  if (holders.length === 0) return false;
  const during = new Set<string>();
  for (const h of holders) {
    const [fname, id] = h.split("\0");
    // The printing and formatting helpers only read what they are handed.
    if (fname !== undefined && PRINT_HELPER.test(fname)) continue;
    const f = fname !== undefined && id !== undefined ? cx.byName.get(fname) : undefined;
    const isParam = !!f && f.params.some((p) => p.localId === id);
    const b = cx.bindings.get(h);
    const ro = (cx.dynUses.get(h) ?? []).every((u) => u === "ro");
    if (!isParam || !ro || (b && (b.captured || b.assigns.length > 0))) return anyWritten(cx, types, s, null, dead);
    const r = callReach(cx, f!.name);
    if (r.suspends) return anyWritten(cx, types, s, null, dead);
    for (const g of r.fns) during.add(g);
  }
  // Held only while printers read it: nothing else runs then.
  if (during.size === 0) return false;
  return anyWritten(cx, types, s, during, null);
}

export function anyWritten(cx: DynJudgeCx, types: IrType[], site: Site | null, during: Set<string> | null = null, dead: { fn: string; top: number } | null = null): boolean {
  return types.some((t) => isWritten(cx, t, undefined, site, during, dead));
}

/** For a copy landing in a local dynamic binding nothing captures: the
 * last top-level statement of its function that reads it (later
 * statements of that function cannot observe it). */
export function lastUse(cx: DynJudgeCx, s: DynSite): { fn: string; top: number } | null {
  if (s.dest === null || s.dest.param || s.dest.key.startsWith("g\0")) return null;
  const b = cx.bindings.get(s.dest.key);
  if (!b || b.captured || b.assigns.length !== 1) return null;
  // Every use reads it at once, so the copy goes nowhere else.
  if (!(cx.dynUses.get(s.dest.key) ?? []).every((u) => u === "ro")) return null;
  const tops = cx.useTops.get(s.dest.key) ?? [];
  if (tops.some((u) => u.fn !== s.where)) return null;
  return { fn: s.where, top: Math.max(s.top, ...tops.map((u) => u.top)) };
}

export function anyIdentity(cx: DynJudgeCx, types: IrType[]): boolean {
  return types.some((t) => cx.identity.has(tkey(t)));
}

/** The uses of a dynamic binding a crossing lands in, when they are
 * all known and all read at once. */
export function dynDestReadOnly(cx: DynJudgeCx, s: Site): boolean {
  if (s.dest === null) return false;
  const b = cx.bindings.get(s.dest.key);
  if (b && (b.captured || b.assigns.length !== (s.dest.param ? 0 : 1))) return false;
  return (cx.dynUses.get(s.dest.key) ?? []).every((u) => u === "ro");
}

/** Is the TYPED copy (or a part of it) written, or handed where it
 * could be? Through its binding when every use is known, else by
 * type. */
export function typedSideWritten(cx: DynJudgeCx, s: Site, t: IrType, during: Set<string> | null): boolean {
  const db = destBinding(cx, s);
  if (db !== null && !db.uses.includes("other")) {
    const partsOk = db.parts.every((p) => {
      if (p.via === undefined) return p.use !== "other";
      const vb = cx.bindings.get(p.via);
      return !vb || (!vb.captured && vb.assigns.length === 0 && !vb.uses.includes("other") && vb.parts.every((q) => q.use !== "other" && q.via === undefined));
    });
    if (partsOk) return false;
  }
  return anyWritten(cx, refsOf(cx, t).refs, s, during);
}
