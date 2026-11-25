/* The width-copy pass's reach sets (SEMANTICS.md S125): what an escaped
 * value can reach (as observed, and as written), the constructors that
 * leak `this`, the functions made into values, and what a call can run
 * before it returns. */
import type { IrType } from "../../ir/nodes.js";
import { DYN_READER, isCopyHelper, PURE_LIB, RUNTIME_KINDS, tkey } from "./width-copy-tables.js";
import type { WidthCx } from "./width-cx.js";
import { escape, rootOf } from "./width-uses.js";

export function reachType(cx: WidthCx, t: IrType): void {
  const k = tkey(t);
  if (cx.into.has(k)) return;
  cx.into.add(k);
  switch (t.kind) {
    case "record": {
      const s = cx.L.shapes.get(t.shapeId);
      for (const f of s?.fields ?? []) reachType(cx, f.type);
      if (s?.indexValue) reachType(cx, s.indexValue);
      return;
    }
    case "object": {
      for (let c = cx.L.classes.get(t.className); c; c = c.base ?? undefined) {
        for (const ft of c.fields.values()) reachType(cx, ft);
      }
      return;
    }
    case "union":
      for (const a of cx.L.unions.get(t.unionId)?.arms ?? []) reachType(cx, a);
      return;
    default: {
      for (const v of Object.values(t as Record<string, unknown>)) {
        if (v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") reachType(cx, v as IrType);
      }
    }
  }
}

/** The functions a call of `fn` can run before it returns, and whether
 * that set is OPEN (`suspends`): one of them can suspend (async, a
 * generator) and let other code run, or calls into the runtime, the host
 * or the embedded engine where program callbacks may run (an emitter's
 * `emit`, a stream write, `process.exit`'s listeners, an assert running
 * its function, a promise executor ...). Only the library families on
 * PURE_LIB — data in, data out — are closed; every other libCall family,
 * and every node kind that crosses into the runtime, opens the set.
 * Conservative: a call through a function value can run any function the
 * program makes a value of; a virtual call any method of that name. */
export function callReach(cx: WidthCx, fn: string): { fns: Set<string>; suspends: boolean } {
  const memo = cx.reachMemo.get(fn);
  if (memo) return memo;
  const fns = new Set<string>();
  let suspends = false;
  const queue = [fn];
  const add = (name: string): void => {
    if (!fns.has(name)) {
      fns.add(name);
      queue.push(name);
    }
  };
  while (queue.length > 0) {
    const name = queue.pop()!;
    fns.add(name);
    const f = cx.byName.get(name);
    if (!f) {
      suspends = true;
      continue;
    }
    if (f.async || f.generator) suspends = true;
    const scan = (n: unknown): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) scan(x);
        return;
      }
      const r = n as Record<string, unknown>;
      const k = r["kind"];
      if (k === "call") add(r["callee"] as string);
      else if (k === "closure") add(r["fnName"] as string);
      else if (k === "new") add(`%${r["className"] as string}.constructor`);
      else if (k === "virtualCall") {
        for (const other of cx.byName.keys()) if (other.endsWith(`.${r["method"] as string}`)) add(other);
      } else if (k === "callValue" || k === "dynCall" || k === "dynInvoke") {
        for (const v of cx.valueFns) add(v);
      } else if (k === "awaitExpr" || k === "awaitUnionExpr" || k === "yieldExpr" || k === "genResume") {
        suspends = true;
      } else if (k === "libCall") {
        // (The dynamic readers run no program code either.)
        if (!PURE_LIB.test(r["fn"] as string) && !DYN_READER.test(r["fn"] as string)) suspends = true;
      } else if (k === "intrinsic") {
        if (!/^console\./.test(r["name"] as string)) suspends = true;
      } else if (k === "arrIntrinsic") {
        // A comparator is a function value.
        if (["sort", "toSorted", "typedSort"].includes(r["method"] as string)) for (const v of cx.valueFns) add(v);
      } else if (RUNTIME_KINDS.has(k as string)) {
        suspends = true;
      }
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        scan(r[key]);
      }
    };
    scan(f.body);
  }
  const out = { fns, suspends };
  cx.reachMemo.set(fn, out);
  return out;
}

// The (from, to) pairs a helper copies, its nested helpers' included.
export function pairsOf(cx: WidthCx, name: string, acc: Map<string, { from: IrType; to: IrType }>): void {
  const f = cx.byName.get(name);
  if (!f || f.params.length === 0) return;
  const key = `${tkey(f.params[0]!.type)}=>${tkey(f.returnType)}`;
  if (acc.has(key)) return;
  acc.set(key, { from: f.params[0]!.type, to: f.returnType });
  const inner = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) inner(x);
      return;
    }
    const r = n as Record<string, unknown>;
    if (r["kind"] === "call" && isCopyHelper(r["callee"] as string)) pairsOf(cx, r["callee"] as string, acc);
    for (const key of Object.keys(r)) {
      if (key === "type" || key === "loc") continue;
      inner(r[key]);
    }
  };
  inner(f.body);
}

/** The key and class questions a lowering answered statically (a folded
 * `in`, an `instanceof`): each escapes its type as read-only and is noted
 * in foldedKeys / foldedClass. */
export function noteFoldedObservers(cx: WidthCx): void {
  for (const t of cx.L.keyObservedTypes) {
    escape(cx, t, false);
    cx.foldedKeys.add(tkey(t));
  }
  for (const t of cx.L.classObservedTypes) {
    escape(cx, t, false);
    cx.foldedClass.add(tkey(t));
  }
}

/** Everything an escaped value can reach counts as observed; as written
 * too when the observer may write. Fills reach, reachNoSpec, reachW and
 * reachWDyn (each through `into`), and settles viewWritesLive. */
export function buildReachSets(cx: WidthCx): void {
  for (const e of cx.escaped) reachType(cx, e.t);
  cx.into = cx.reachNoSpec;
  for (const e of cx.escaped) if (!e.spec) reachType(cx, e.t);
  cx.into = cx.reachW;
  // A view's stores into its typed value run only for a dynamic store made
  // through it (noted as a dynamic write where it is made): a program
  // with no dynamic write anywhere writes through no view (U1b).
  cx.viewWritesLive = cx.dynWrites.length > 0;
  for (const e of cx.escaped) if (e.w && (!e.view || cx.viewWritesLive)) reachType(cx, e.t);
  cx.into = cx.reachWDyn;
  for (const e of cx.escaped) if (e.w && !e.view) reachType(cx, e.t);
}

/** A constructor that hands `this` to anything other than its own field
 * accesses (or its base constructor) lets the instance escape before
 * construction finishes: its writes count, and `new` is not fresh. Fills
 * ctorLeaks, and siteInCtor with the root classes whose constructors hold
 * a copy site. */
export function findCtorLeaks(cx: WidthCx): void {
  for (const [name, info] of cx.L.classes) {
    const ctor = cx.byName.get(`%${name}.constructor`);
    if (!ctor) continue;
    const thisId = ctor.params[0]?.localId;
    if (thisId === undefined) continue;
    let leaks = false;
    const scan = (n: unknown, ok: boolean): void => {
      if (leaks || n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) scan(x, ok);
        return;
      }
      const r = n as Record<string, unknown>;
      if (r["kind"] === "varRef" && r["localId"] === thisId && !ok) {
        leaks = true;
        return;
      }
      // A closure capturing `this` (an arrow field, a callback handed to a
      // timer) holds the instance past construction.
      if (r["kind"] === "closure" && ((r["captures"] as string[] | undefined) ?? []).includes(thisId)) {
        leaks = true;
        return;
      }
      const k = r["kind"];
      const baseCtor = k === "call" && typeof r["callee"] === "string" && (r["callee"] as string).endsWith(".constructor");
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        const safe = ((k === "fieldGet" || k === "fieldSet" || k === "fieldIncDec") && key === "obj") || (baseCtor && key === "args");
        scan(r[key], safe);
      }
    };
    scan(ctor.body, false);
    if (leaks) cx.ctorLeaks.add(rootOf(cx, info.def.name));
  }
  for (const s of cx.sites) {
    const m = /^%(.+)\.constructor$/.exec(s.where);
    if (m) cx.siteInCtor.add(rootOf(cx, m[1]!));
  }
}

/** Fills valueFns: every function the program makes a closure value of. */
export function collectValueFns(cx: WidthCx): void {
  {
    const scanFns = (n: unknown): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) scanFns(x);
        return;
      }
      const r = n as Record<string, unknown>;
      if (r["kind"] === "closure") cx.valueFns.add(r["fnName"] as string);
      for (const key of Object.keys(r)) {
        if (key === "type" || key === "loc") continue;
        scanFns(r[key]);
      }
    };
    for (const f of cx.functions) scanFns(f.body);
  }
}
