/* Array-callback inlining (perf unit P1, item 4).
 *
 * The frontend lowers `arr.filter(cb)` (and map, every, some, find,
 * findIndex, forEach, reduce) to a call of an interned IR helper,
 * `%arr.<method>.<n>(a, f[, init])`, whose loop calls `f` through a
 * function value (`callValue`): one closure allocation per evaluation and
 * one call_ref per element. The helper's body IS the method's semantics —
 * the length read once, the `i < a.length` re-check that skips elements a
 * callback removed, the (element, index, array) arguments, the early exits.
 *
 * When the callback is a closure LITERAL (an arrow written at the call),
 * this pass replaces the call with the helper's body, cloned into the
 * caller, and each `f(args)` in it with the callback's body, cloned too:
 *
 *   seqExpr {
 *     a' = <receiver>; [init' = <init>]
 *     block L {
 *       <helper body>, where   return v   →  ret = v; break L
 *                       and    f(args)    →  seqExpr { p' = args…;
 *                                               block C { <callback body>,
 *                                                 return v → cr = v; break C }
 *                                             } → cr
 *     }
 *   } → ret
 *
 * Every local of both bodies is renamed apart into the caller; the
 * callback's captures become the caller's own (boxed) bindings the
 * closure would have carried. Evaluation order is unchanged: the receiver,
 * then the closure (no effects — nothing to keep), then the remaining
 * arguments, then the loop. Nothing is reimplemented, so holes, mutation
 * during iteration, the index and array arguments and the early exits
 * behave exactly as the helper does. An exception thrown in the callback
 * unwinds from the same point, now without the two intermediate frames.
 *
 * Declined (the call stays): a callback that is not a closure literal; a
 * helper or callback using try/catch/finally, `this` from the ambient receiver
 * (function expressions — arrows capture `this` lexically), a lowering
 * node (`%…`), selfRef; a type mismatch between the helper's call and the
 * callback's signature; a void helper/callback in value position.
 *
 * Afterwards, a caller binding that was boxed only because the inlined
 * closure captured it (no closure left in the caller names it) is
 * unboxed — the caller's copy of the local entry, never a shared one. */
import type { IrExpr, IrLocal, IrStmt, IrType } from "../../ir/nodes.js";
import type { WFunction, WModule } from "./statemachine.js";

const METHODS = new Set(["filter", "map", "every", "some", "find", "findIndex", "forEach", "reduce"]);
const HELPER = /^%arr\.([A-Za-z]+)\.\d+$/;
/** Nested inlining depth (a callback holding another inlinable call). */
const MAX_DEPTH = 3;

type Node = Record<string, unknown>;

function sameType(a: IrType, b: IrType): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Does the tree hold a construct this pass declines? */
function declines(v: unknown): boolean {
  const seen = new Set<object>();
  const visit = (x: unknown): boolean => {
    if (x === null || typeof x !== "object" || seen.has(x)) return false;
    seen.add(x);
    if (Array.isArray(x)) return x.some(visit);
    const o = x as Node;
    const k = o["kind"];
    if (typeof k === "string") {
      if (k.startsWith("%") || k === "tryCatch" || k === "selfRef" || k === "yieldExpr" || k === "awaitExpr" || k === "awaitUnionExpr") return true;
      if (k === "libCall" && typeof o["fn"] === "string" && /this|arguments/.test(o["fn"])) return true;
      if ((k === "callValue" || k === "call") && o["keepThis"] === true) return true;
      if (typeof o["catchLocalId"] === "string") return true;
    }
    for (const [key, val] of Object.entries(o)) if (key !== "loc" && key !== "type" && visit(val)) return true;
    return false;
  };
  return visit(v);
}

/** Every node naming `id` other than as a `callValue` callee varRef. */
function otherUses(body: unknown, id: string): boolean {
  const visit = (x: unknown, calleePos: boolean): boolean => {
    if (x === null || typeof x !== "object") return false;
    if (Array.isArray(x)) return x.some((y) => visit(y, false));
    const o = x as Node;
    if (o["kind"] === "varRef" && o["localId"] === id) return !calleePos;
    for (const [key, val] of Object.entries(o)) {
      if (key === "loc" || key === "type") continue;
      if (typeof val === "string") {
        if (val === id) return true;
        continue;
      }
      if (Array.isArray(val) && val.includes(id)) return true;
      if (visit(val, o["kind"] === "callValue" && key === "callee")) return true;
    }
    return false;
  };
  return visit(body, false);
}

/** Deep clone, renaming local ids (localId fields and closure captures). */
function cloneRenamed<T>(v: T, ren: ReadonlyMap<string, string>): T {
  const go = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(go);
    const o = x as Node;
    const out: Node = {};
    for (const [key, val] of Object.entries(o)) {
      if (key === "loc" || key === "type") {
        out[key] = val; // immutable leaves, shared
        continue;
      }
      if (key === "localId" && typeof val === "string") {
        out[key] = ren.get(val) ?? val;
        continue;
      }
      if (key === "captures" && o["kind"] === "closure" && Array.isArray(val)) {
        out[key] = (val as string[]).map((c) => ren.get(c) ?? c);
        continue;
      }
      out[key] = go(val);
    }
    return out;
  };
  return go(v) as T;
}

/** In place: every `return` in a statement tree becomes `ret = v; break L`
 * (or `break L` for a bare return). `ret` null: the function is void. */
function rewriteReturns(stmts: unknown[], ret: { id: string } | null, label: string): void {
  const visit = (x: unknown): void => {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        const s = x[i] as Node | null;
        if (s !== null && typeof s === "object" && s["kind"] === "return") {
          const loc = s["loc"];
          const br = { kind: "break", label, loc } as unknown as IrStmt;
          const value = s["value"] as IrExpr | null;
          if (value !== null && ret !== null) {
            x[i] = { kind: "block", body: [{ kind: "assign", localId: ret.id, value, loc }, br], loc } as unknown as IrStmt;
          } else if (value !== null) {
            x[i] = { kind: "block", body: [{ kind: "exprStmt", expr: value, loc }, br], loc } as unknown as IrStmt;
          } else {
            x[i] = br;
          }
          continue;
        }
        visit(s);
      }
      return;
    }
    const o = x as Node;
    for (const [key, val] of Object.entries(o)) if (key !== "loc" && key !== "type") visit(val);
  };
  visit(stmts);
}

interface Ctx {
  fns: ReadonlyMap<string, WFunction>;
  /** The caller's new locals, appended as sites are inlined. */
  locals: IrLocal[];
  next: { n: number; done: number };
}

/** The inlined form of `call` (a helper call with a closure literal), or
 * null when it is declined. `stmtPos`: the call is an exprStmt's whole
 * expression (a void helper may inline only there). */
function inlineSite(call: Node, ctx: Ctx, depth: number): { stmts: IrStmt[]; result: IrExpr | null } | null {
  const callee = call["callee"];
  if (typeof callee !== "string") return null;
  const m = HELPER.exec(callee);
  if (m === null || !METHODS.has(m[1]!)) return null;
  const args = call["args"] as IrExpr[];
  const clo = args[1] as (IrExpr & { kind: "closure" }) | undefined;
  if (clo === undefined || clo.kind !== "closure") return null;
  const h = ctx.fns.get(callee);
  const cb = ctx.fns.get(clo.fnName);
  if (h === undefined || cb === undefined) return null;
  if (h.async === true || h.generator !== undefined || cb.async === true || cb.generator !== undefined) return null;
  if ((h.captures ?? []).length > 0 || h.params.length !== args.length || h.params.length < 2) return null;
  const caps = cb.captures ?? [];
  if (caps.length !== clo.captures.length) return null;
  if (declines(h.body) || declines(cb.body)) return null;
  const fId = h.params[1]!.localId;
  if (otherUses(h.body, fId)) return null;
  // Every call of f must match the callback's signature exactly.
  const calls: Node[] = [];
  const findCalls = (x: unknown): void => {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      x.forEach(findCalls);
      return;
    }
    const o = x as Node;
    if (o["kind"] === "callValue" && (o["callee"] as Node)["kind"] === "varRef" && (o["callee"] as Node)["localId"] === fId) calls.push(o);
    for (const [key, val] of Object.entries(o)) if (key !== "loc" && key !== "type") findCalls(val);
  };
  findCalls(h.body);
  for (const c of calls) {
    const cargs = c["args"] as IrExpr[];
    if (cargs.length !== cb.params.length) return null;
    if (!cargs.every((a, i) => sameType(a.type, cb.params[i]!.type))) return null;
    const ct = c["type"] as IrType;
    if (!sameType(ct, cb.returnType) && cb.returnType.kind !== "void" && ct.kind !== "void") return null;
  }

  const n = ctx.next.n++;
  const mark = ctx.locals.length;
  const tag = `@p1i${n}`;
  const hLabel = `%p1h${n}`;
  // The helper's locals, renamed apart (f dropped).
  const hRen = new Map<string, string>();
  for (const l of h.locals) {
    if (l.id === fId) continue;
    const id = `${l.id}${tag}h`;
    hRen.set(l.id, id);
    ctx.locals.push({ ...l, id, mutable: true });
  }
  const body = cloneRenamed(h.body, hRen);
  let ret: { id: string } | null = null;
  if (h.returnType.kind !== "void") {
    ret = { id: `%ret${tag}` };
    ctx.locals.push({ id: ret.id, name: "%ret", type: h.returnType, mutable: true });
  }
  rewriteReturns(body, ret, hLabel);

  // Each f(args) in the cloned helper body: the callback's body, inline.
  let k = 0;
  let bad = false;
  const inlineCalls = (x: unknown, parent: Node | unknown[] | null, key: string | number | null): void => {
    if (bad || x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) inlineCalls(x[i], x, i);
      return;
    }
    const o = x as Node;
    const isF = o["kind"] === "callValue" && (o["callee"] as Node)["kind"] === "varRef" && (o["callee"] as Node)["localId"] === fId;
    if (!isF) {
      for (const [kk, val] of Object.entries(o)) if (kk !== "loc" && kk !== "type") inlineCalls(val, o, kk);
      return;
    }
    // Its arguments first (they may not hold f — otherUses checked).
    const cTag = `${tag}c${k++}`;
    const cLabel = `%p1c${n}.${k}`;
    const cRen = new Map<string, string>();
    caps.forEach((c, i) => cRen.set(c.localId, clo.captures[i]!));
    const capIds = new Set(caps.map((c) => c.localId));
    for (const l of cb.locals) {
      if (capIds.has(l.id)) continue;
      const id = `${l.id}${cTag}`;
      cRen.set(l.id, id);
      ctx.locals.push({ ...l, id, mutable: true });
    }
    const loc = o["loc"];
    const stmts: IrStmt[] = (o["args"] as IrExpr[]).map(
      (a, i) => ({ kind: "varDecl", localId: cRen.get(cb.params[i]!.localId)!, init: a, loc }) as unknown as IrStmt,
    );
    const cbody = cloneRenamed(cb.body, cRen);
    let cret: { id: string } | null = null;
    if (cb.returnType.kind !== "void") {
      cret = { id: `%cbret${cTag}` };
      ctx.locals.push({ id: cret.id, name: "%cbret", type: cb.returnType, mutable: true });
    }
    rewriteReturns(cbody, cret, cLabel);
    stmts.push({ kind: "block", body: cbody, labels: [cLabel], loc } as unknown as IrStmt);
    let replacement: unknown;
    const voidCall = (o["type"] as IrType).kind === "void";
    const stmtParent = parent !== null && !Array.isArray(parent) && (parent as Node)["kind"] === "exprStmt" && key === "expr";
    if (voidCall && !stmtParent) {
      bad = true;
      return;
    }
    if (cret !== null) {
      replacement = { kind: "seqExpr", stmts, result: { kind: "varRef", localId: cret.id, type: cb.returnType, loc }, type: cb.returnType, loc };
    } else {
      // A void callback: only as a whole statement.
      const st = parent as Node | null;
      if (st === null || Array.isArray(st) || st["kind"] !== "exprStmt" || key !== "expr") {
        bad = true;
        return;
      }
      st["kind"] = "block";
      delete st["expr"];
      st["body"] = stmts;
      return;
    }
    if (parent === null || key === null) {
      bad = true;
      return;
    }
    (parent as Record<string | number, unknown>)[key] = replacement;
  };
  inlineCalls(body, null, null);
  if (bad || k !== calls.length) {
    ctx.locals.length = mark;
    return null;
  }
  ctx.next.done++;

  const loc = call["loc"];
  const stmts: IrStmt[] = [];
  h.params.forEach((p, i) => {
    if (i === 1) return;
    stmts.push({ kind: "varDecl", localId: hRen.get(p.localId)!, init: args[i]!, loc } as unknown as IrStmt);
  });
  stmts.push({ kind: "block", body, labels: [hLabel], loc } as unknown as IrStmt);
  // Nested sites in what was just built (a callback holding another one).
  if (depth < MAX_DEPTH) for (const s of stmts) inlineIn(s, ctx, depth + 1);
  return { stmts, result: ret === null ? null : ({ kind: "varRef", localId: ret.id, type: h.returnType, loc } as unknown as IrExpr) };
}

/** In place: every inlinable site under `root`. */
function inlineIn(root: unknown, ctx: Ctx, depth: number): void {
  const visit = (x: unknown, parent: Node | unknown[] | null, key: string | number | null): void => {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) visit(x[i], x, i);
      return;
    }
    const o = x as Node;
    // Arguments first: an inner site in a receiver is inlined on its own.
    for (const [kk, val] of Object.entries(o)) if (kk !== "loc" && kk !== "type") visit(val, o, kk);
    if (o["kind"] !== "call" || parent === null || key === null) return;
    const stmtPos = !Array.isArray(parent) && parent["kind"] === "exprStmt" && key === "expr";
    if ((o["type"] as IrType).kind === "void" && !stmtPos) return;
    const r = inlineSite(o, ctx, depth);
    if (r === null) return;
    if (r.result === null) {
      if (!stmtPos) return;
      const st = parent as Node;
      st["kind"] = "block";
      delete st["expr"];
      st["body"] = r.stmts;
      return;
    }
    (parent as Record<string | number, unknown>)[key] = { kind: "seqExpr", stmts: r.stmts, result: r.result, type: o["type"], loc: o["loc"] };
  };
  visit(root, null, null);
}

/** Does any closure under `root` capture `id`? */
function captured(root: unknown, id: string): boolean {
  const visit = (x: unknown): boolean => {
    if (x === null || typeof x !== "object") return false;
    if (Array.isArray(x)) return x.some(visit);
    const o = x as Node;
    if (o["kind"] === "closure" && Array.isArray(o["captures"]) && (o["captures"] as string[]).includes(id)) return true;
    for (const [key, val] of Object.entries(o)) if (key !== "loc" && key !== "type" && visit(val)) return true;
    return false;
  };
  return visit(root);
}

/** Has an inlinable site at all (cheap pre-scan, before cloning). */
function hasSite(root: unknown, fns: ReadonlyMap<string, WFunction>): boolean {
  const visit = (x: unknown): boolean => {
    if (x === null || typeof x !== "object") return false;
    if (Array.isArray(x)) return x.some(visit);
    const o = x as Node;
    if (o["kind"] === "call" && typeof o["callee"] === "string") {
      const m = HELPER.exec(o["callee"]);
      const a1 = (o["args"] as Node[] | undefined)?.[1];
      if (m !== null && METHODS.has(m[1]!) && a1?.["kind"] === "closure" && fns.has(o["callee"])) return true;
    }
    for (const [key, val] of Object.entries(o)) if (key !== "loc" && key !== "type" && visit(val)) return true;
    return false;
  };
  return visit(root);
}

export function inlineArrayCallbacks(mod: WModule): WModule {
  if (process.env["SCRIPTC_WASM_NO_CBINLINE"] === "1") return mod;
  const fns = new Map<string, WFunction>();
  for (const f of mod.functions) fns.set(f.name, f);
  let changed = false;
  const next = { n: 0, done: 0 };
  const functions = mod.functions.map((f) => {
    if (!hasSite(f.body, fns)) return f;
    const body = cloneRenamed(f.body, new Map());
    const ctx: Ctx = { fns, locals: [], next };
    inlineIn(body, ctx, 0);
    if (ctx.locals.length === 0) return f;
    changed = true;
    // Unbox a binding no remaining closure captures — not a capture of
    // this function itself (its box comes from the env), not a TDZ box,
    // and not in a resumable function (its boxes are frame residency).
    const own = new Set((f.captures ?? []).map((c) => c.localId));
    const resumable = declines(body);
    const locals = [...f.locals, ...ctx.locals].map((l) =>
      l.boxed === true && l.tdz !== true && !own.has(l.id) && !resumable && !captured(body, l.id)
        ? (() => {
            const { boxed: _b, ...rest } = l;
            void _b;
            return rest as IrLocal;
          })()
        : l,
    );
    return { ...f, body, locals } as WFunction;
  });
  if (process.env["SCRIPTC_WASM_P1_DEBUG"] === "1") process.stderr.write(`inline-hof: ${next.done} site(s) inlined\n`);
  return changed ? { ...mod, functions } : mod;
}

