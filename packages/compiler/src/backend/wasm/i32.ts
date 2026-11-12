/* Integer lowering (perf unit P1, item 2): which f64 bindings may live in
 * an i32 slot, and the exact-integer range of an f64 expression.
 *
 * Every JS number is a double, and the IR keeps it so (`f64`). A binding
 * whose every value is provably an int32 — never a fraction, NaN, -0 or
 * a value outside [-2^31, 2^31) — is held as an i32 instead: the value
 * set is the same, so nothing observable changes, and loop counters,
 * bitmask tests and array indices stop converting between f64 and i32 at
 * every use. The proof is a range analysis over the module:
 *
 * - An expression's RANGE is an interval of exact integers its value is
 *   always in, with -0 excluded (`exprRange`; null when unknown). Literals,
 *   `.length`, the bitwise operators (their results are int32 by
 *   definition, `>>>` uint32), and `+ - * %` over ranged operands where
 *   the exact result is representable and cannot be -0.
 * - A CANDIDATE is an f64 local (not a parameter, not boxed by a closure,
 *   not TDZ-checked) or an f64 module global. Every write to it must be a
 *   varDecl/assign/assignExpr/incDec naming it; any other mention of its
 *   id anywhere (a capture list, a for-of binding, a state-machine slot…)
 *   disqualifies it.
 * - A candidate's range is the hull of its writes' ranges, iterated to a
 *   fixpoint from the empty interval (widened to the int32 bounds after a
 *   few rounds). A write with no range, or a hull leaving int32,
 *   disqualifies it — and so, at the next round, every candidate whose
 *   writes read it.
 * - A loop counter's own update is GUARDED: in `for (…; i < B; i += k)`
 *   over a local `i` with no other write of `i` in the loop, the update runs only after a
 *   true `i < B`, so it yields at most B.hi - 1 + k. `>`, `>=`, `<=` and
 *   decrements likewise. Without the guard, `i += 1` would widen to the
 *   int32 bound and fail.
 *
 * The emitter (emitter.ts, `walkI32`) uses the ranges twice: to give the
 * proven bindings i32 slots, and to evaluate ranged expressions directly
 * as i32 where an i32 is consumed — a bitwise operand (ToInt32), an
 * integer comparison, an array index. */
import type { IrExpr, IrModule } from "../../ir/nodes.js";

export const I32_MIN = -2147483648;
export const I32_MAX = 2147483647;
const U32_MAX = 4294967295;
/** Exact-integer bound for intermediate f64 results (2^53). */
const EXACT = 9007199254740992;

export interface Range {
  lo: number;
  hi: number;
}

const FULL: Range = { lo: I32_MIN, hi: I32_MAX };
const BOTTOM: Range = { lo: Infinity, hi: -Infinity };

export function isBottom(r: Range): boolean {
  return r.lo > r.hi;
}

/** r ⊆ int32 (the empty range included). */
export function inInt32(r: Range | null): r is Range {
  return r !== null && (isBottom(r) || (r.lo >= I32_MIN && r.hi <= I32_MAX));
}

function hull(a: Range, b: Range): Range {
  if (isBottom(a)) return b;
  if (isBottom(b)) return a;
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
}

function exact(r: Range): Range | null {
  if (isBottom(r)) return r;
  return r.lo >= -EXACT && r.hi <= EXACT ? r : null;
}

/** The range of ToInt32(x) for x in r (r null: unknown). */
function toI32Range(r: Range | null): Range {
  if (r === null) return FULL;
  if (isBottom(r)) return r;
  return r.lo >= I32_MIN && r.hi <= I32_MAX ? r : FULL;
}

/** 2^bitlength(x) - 1 for x ≥ 0. */
function mask(x: number): number {
  let m = 0;
  while (m < x) m = m * 2 + 1;
  return m;
}

/** The literal shift count of a shift's right operand, masked to 5 bits. */
function shiftCount(e: IrExpr): number | null {
  if (e.kind !== "numLit" || !Number.isInteger(e.value)) return null;
  return ((e.value % 32) + 32) % 32;
}

/** A binding's range (an i32 binding), or null (any other binding). */
export type RangeLookup = (localId: string) => Range | null;

/** The exact-integer range of an f64-typed expression, or null. */
export function exprRange(e: IrExpr, lookup: RangeLookup): Range | null {
  if (e.type.kind !== "f64") return null;
  switch (e.kind) {
    case "numLit": {
      const v = e.value;
      if (!Number.isInteger(v) || Object.is(v, -0) || Math.abs(v) > EXACT) return null;
      return { lo: v, hi: v };
    }
    case "varRef":
      return lookup(e.localId);
    case "assignExpr":
      return lookup(e.localId) === null ? null : exprRange(e.value, lookup);
    case "ternary": {
      const a = exprRange(e.then, lookup);
      const b = exprRange(e.else_, lookup);
      return a === null || b === null ? null : hull(a, b);
    }
    case "arrIntrinsic":
      return e.method === "length" ? { lo: 0, hi: I32_MAX } : null;
    case "strIntrinsic":
      return e.method === "length" ? { lo: 0, hi: I32_MAX } : null;
    case "unary": {
      if (e.op === "~") return FULL;
      if (e.op !== "-") return null;
      const a = exprRange(e.operand, lookup);
      if (a === null) return null;
      if (isBottom(a)) return a;
      // -x is -0 for x = 0; a range clear of 0 negates exactly
      if (a.lo >= 1 || a.hi <= -1) return { lo: -a.hi, hi: -a.lo };
      return null;
    }
    case "bin":
      return binRange(e, lookup);
    default:
      return null;
  }
}

function binRange(e: Extract<IrExpr, { kind: "bin" }>, lookup: RangeLookup): Range | null {
  switch (e.op) {
    case "+":
    case "-":
    case "*":
    case "%": {
      const a = exprRange(e.left, lookup);
      const b = exprRange(e.right, lookup);
      if (a === null || b === null) return null;
      if (isBottom(a) || isBottom(b)) return BOTTOM;
      if (e.op === "+") return exact({ lo: a.lo + b.lo, hi: a.hi + b.hi });
      if (e.op === "-") return exact({ lo: a.lo - b.hi, hi: a.hi - b.lo });
      if (e.op === "*") {
        // 0 × negative is -0
        const aZero = a.lo <= 0 && a.hi >= 0;
        const bZero = b.lo <= 0 && b.hi >= 0;
        if ((aZero && b.lo < 0) || (bZero && a.lo < 0)) return null;
        const ps = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
        return exact({ lo: Math.min(...ps), hi: Math.max(...ps) });
      }
      // %: a non-negative dividend and a positive divisor (no NaN, no -0)
      if (a.lo < 0 || b.lo < 1) return null;
      return { lo: 0, hi: Math.min(a.hi, b.hi - 1) };
    }
    case "&": {
      const a = toI32Range(exprRange(e.left, lookup));
      const b = toI32Range(exprRange(e.right, lookup));
      if (isBottom(a) || isBottom(b)) return BOTTOM;
      if (a.lo >= 0 && b.lo >= 0) return { lo: 0, hi: Math.min(a.hi, b.hi) };
      if (a.lo >= 0) return { lo: 0, hi: a.hi };
      if (b.lo >= 0) return { lo: 0, hi: b.hi };
      return FULL;
    }
    case "|":
    case "^": {
      const a = toI32Range(exprRange(e.left, lookup));
      const b = toI32Range(exprRange(e.right, lookup));
      if (isBottom(a) || isBottom(b)) return BOTTOM;
      if (a.lo >= 0 && b.lo >= 0) return { lo: 0, hi: mask(Math.max(a.hi, b.hi)) };
      return FULL;
    }
    case "<<": {
      const a = toI32Range(exprRange(e.left, lookup));
      if (isBottom(a)) return BOTTOM;
      const k = shiftCount(e.right);
      if (k !== null && a.lo >= 0 && a.hi * 2 ** k <= I32_MAX) return { lo: a.lo * 2 ** k, hi: a.hi * 2 ** k };
      return FULL;
    }
    case ">>": {
      const a = toI32Range(exprRange(e.left, lookup));
      if (isBottom(a)) return BOTTOM;
      const k = shiftCount(e.right);
      if (k !== null) return { lo: Math.floor(a.lo / 2 ** k), hi: Math.floor(a.hi / 2 ** k) };
      return { lo: Math.min(a.lo, 0), hi: Math.max(a.hi, 0) };
    }
    case ">>>": {
      const a = toI32Range(exprRange(e.left, lookup));
      if (isBottom(a)) return BOTTOM;
      const k = shiftCount(e.right);
      if (a.lo >= 0) return k === null ? { lo: 0, hi: a.hi } : { lo: Math.floor(a.lo / 2 ** k), hi: Math.floor(a.hi / 2 ** k) };
      return { lo: 0, hi: k === null ? U32_MAX : Math.floor(U32_MAX / 2 ** k) };
    }
    default:
      return null;
  }
}

/** The plan: per function, its i32 locals; and the module's i32 globals. */
export interface I32Plan {
  locals: Map<string, Map<string, Range>>;
  globals: Map<string, Range>;
  /** The guarded loop updates' value nodes (`i + k`): their result is in
   * the counter's range by the loop test, not by its own range. */
  guardedSteps: Set<object>;
}

type Node = Record<string, unknown> & { kind?: unknown };

interface Def {
  key: string;
  fn: string;
  /** A plain write: the value's range. */
  value?: IrExpr;
  /** An incDec: the binding's own range ± 1. */
  step?: number;
  /** A guarded loop update (see the header). */
  guard?: { k: number; bound: IrExpr; op: "<" | "<=" | ">" | ">="; value: object };
}

const DEF_KINDS = new Set(["varDecl", "assign", "assignExpr", "incDec"]);

/** The loop-update shape `v = v + k` / `v = v - k` (k a positive integer
 * literal): the signed step, or null. */
function updateStep(s: Node, id: string): number | null {
  if (s.kind !== "assign" || s.localId !== id) return null;
  const v = s.value as IrExpr;
  if (v.kind !== "bin" || (v.op !== "+" && v.op !== "-")) return null;
  if (v.left.kind !== "varRef" || v.left.localId !== id) return null;
  if (v.right.kind !== "numLit" || !Number.isInteger(v.right.value) || v.right.value < 1 || v.right.value > 65536) return null;
  return v.op === "+" ? v.right.value : -v.right.value;
}

/** Does any write of `id` occur under `v`? */
function writes(v: unknown, id: string, seen = new Set<object>()): boolean {
  if (v === null || typeof v !== "object" || seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => writes(x, id, seen));
  const o = v as Node;
  if (typeof o.kind === "string" && DEF_KINDS.has(o.kind) && o.localId === id) return true;
  return Object.values(o).some((x) => writes(x, id, seen));
}

export function planI32(mod: IrModule): I32Plan {
  const candidates = new Set<string>();
  const globalIds = new Set<string>();
  for (const g of mod.globals ?? []) {
    if (g.type.kind === "f64") {
      candidates.add(g.id);
      globalIds.add(g.id);
    }
  }
  const fnLocals = new Map<string, Set<string>>();
  for (const fn of mod.functions) {
    const params = new Set(fn.params.map((p) => p.localId));
    const ids = new Set<string>();
    for (const l of fn.locals) {
      if (l.type.kind !== "f64" || l.boxed === true || l.tdz === true || params.has(l.id)) continue;
      ids.add(l.id);
      candidates.add(`${fn.name}\u0000${l.id}`);
    }
    fnLocals.set(fn.name, ids);
  }
  const keyOf = (fn: string, id: string): string | null => {
    if (globalIds.has(id)) return id;
    return fnLocals.get(fn)?.has(id) === true ? `${fn}\u0000${id}` : null;
  };

  const out = new Set<string>();
  const defs: Def[] = [];
  const guarded = new Set<object>();

  const scan = (root: unknown, fn: string | null): void => {
    const seen = new Set<object>();
    const visit = (v: unknown): void => {
      if (v === null || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        for (const x of v) {
          if (typeof x === "string") mention(x);
          else visit(x);
        }
        return;
      }
      const o = v as Node;
      const k = o.kind;
      if (k === "for" && fn !== null) forLoop(o, fn);
      for (const [field, x] of Object.entries(o)) {
        if (typeof x === "string") {
          const isRef = field === "localId" && (k === "varRef" || (typeof k === "string" && DEF_KINDS.has(k)));
          if (!isRef) mention(x);
          continue;
        }
        visit(x);
      }
      if (fn !== null && typeof k === "string" && DEF_KINDS.has(k) && typeof o.localId === "string") {
        const key = keyOf(fn, o.localId);
        if (key === null || guarded.has(o)) return;
        if (k === "incDec") defs.push({ key, fn, step: o.op === "+" ? 1 : -1 });
        else if (k === "varDecl") {
          if (o.init !== null) defs.push({ key, fn, value: o.init as IrExpr });
        } else defs.push({ key, fn, value: o.value as IrExpr });
      }
    };
    const mention = (s: string): void => {
      if (globalIds.has(s)) out.add(s);
      else if (fn !== null && fnLocals.get(fn)?.has(s) === true) out.add(`${fn}\u0000${s}`);
    };
    const forLoop = (o: Node, fn: string): void => {
      const cond = o.cond as IrExpr | null;
      const update = o.update as Node | null;
      if (cond === null || update === null || cond.kind !== "bin") return;
      let id: string;
      let bound: IrExpr;
      let op: "<" | "<=" | ">" | ">=";
      const flip = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as const;
      if (cond.op !== "<" && cond.op !== "<=" && cond.op !== ">" && cond.op !== ">=") return;
      if (cond.left.kind === "varRef") {
        id = cond.left.localId;
        bound = cond.right;
        op = cond.op;
      } else if (cond.right.kind === "varRef") {
        id = cond.right.localId;
        bound = cond.left;
        op = flip[cond.op];
      } else return;
      // Locals only: a global counter could be written by a function the
      // body calls, between the test and the update.
      if (globalIds.has(id)) return;
      const key = keyOf(fn, id);
      if (key === null) return;
      const step = updateStep(update, id);
      if (step === null) return;
      if ((step > 0) !== (op === "<" || op === "<=")) return;
      // No other write of the counter between the test and the update.
      if (writes(cond, id) || writes(o.body, id) || writes(bound, id)) return;
      guarded.add(update);
      defs.push({ key, fn, guard: { k: step, bound, op, value: update.value as object } });
    };
    visit(root);
  };
  for (const fn of mod.functions) {
    // A for-loop's guard is decided before its update node is visited
    // (the `for` node is visited first, its children after).
    // Its declarations (locals, params) are not mentions.
    const { locals: _l, params: _p, ...body } = fn as unknown as Record<string, unknown>;
    void _l;
    void _p;
    scan(body, fn.name);
  }
  // Everything else in the module (class and record tables…) only
  // mentions; the global declarations themselves don't count.
  const { functions: _f, globals: _g, ...rest } = mod as unknown as Record<string, unknown>;
  void _f;
  void _g;
  scan(rest, null);

  // The fixpoint.
  const range = new Map<string, Range | null>();
  for (const c of candidates) range.set(c, out.has(c) ? null : BOTTOM);
  const changes = new Map<string, number>();
  const lookupIn = (fn: string): RangeLookup => (id) => {
    const key = keyOf(fn, id);
    return key === null ? null : (range.get(key) ?? null);
  };
  const defRange = (d: Def): Range | null => {
    const lookup = lookupIn(d.fn);
    const self = range.get(d.key) ?? null;
    if (self === null) return null;
    if (d.value !== undefined) return exprRange(d.value, lookup);
    if (d.step !== undefined) return isBottom(self) ? self : { lo: self.lo + d.step, hi: self.hi + d.step };
    const g = d.guard!;
    const b = exprRange(g.bound, lookup);
    if (b === null) return null;
    if (isBottom(b) || isBottom(self)) return BOTTOM;
    if (g.op === "<") return { lo: self.lo + g.k, hi: b.hi - 1 + g.k };
    if (g.op === "<=") return { lo: self.lo + g.k, hi: b.hi + g.k };
    if (g.op === ">") return { lo: b.lo + 1 + g.k, hi: self.hi + g.k };
    return { lo: b.lo + g.k, hi: self.hi + g.k };
  };
  for (let round = 0; round < 200; round++) {
    let changed = false;
    const next = new Map<string, Range>();
    const dead = new Set<string>();
    for (const d of defs) {
      if (range.get(d.key) === null || dead.has(d.key)) continue;
      const r = defRange(d);
      if (!inInt32(r)) {
        dead.add(d.key);
        continue;
      }
      next.set(d.key, hull(next.get(d.key) ?? BOTTOM, r));
    }
    for (const c of candidates) {
      const cur = range.get(c);
      if (cur === null || cur === undefined) continue;
      if (dead.has(c)) {
        range.set(c, null);
        changed = true;
        continue;
      }
      let nr = hull(cur, next.get(c) ?? BOTTOM);
      if (nr.lo !== cur.lo || nr.hi !== cur.hi) {
        const n = (changes.get(c) ?? 0) + 1;
        changes.set(c, n);
        if (n > 3 && !isBottom(cur)) nr = { lo: nr.lo < cur.lo ? I32_MIN : nr.lo, hi: nr.hi > cur.hi ? I32_MAX : nr.hi };
        range.set(c, nr);
        changed = true;
      }
    }
    if (!changed) break;
    if (round === 199) for (const c of candidates) range.set(c, null);
  }

  // Re-verify with the emitter's own view: a binding left at the empty
  // range was never placed (no write ever produced a value — a `let x!`
  // read before any write, or writes that only read each other), so it
  // stays f64 and reads as unknown. Every planned binding's every write
  // must then still be an int32 inside its planned range; a failure drops
  // the binding, which can fail its readers' writes — iterate to a fixpoint.
  for (const c of candidates) {
    const r = range.get(c);
    if (r !== null && r !== undefined && isBottom(r)) range.set(c, null);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of defs) {
      const self = range.get(d.key) ?? null;
      if (self === null) continue;
      const r = defRange(d);
      if (r === null || isBottom(r) || !inInt32(r) || r.lo < self.lo || r.hi > self.hi) {
        range.set(d.key, null);
        changed = true;
      }
    }
  }

  const plan: I32Plan = { locals: new Map(), globals: new Map(), guardedSteps: new Set() };
  for (const d of defs) {
    const r = range.get(d.key);
    if (d.guard !== undefined && r !== null && r !== undefined && !isBottom(r)) plan.guardedSteps.add(d.guard.value);
  }
  for (const [c, r] of range) {
    // A binding never written keeps BOTTOM: its slot is only ever the
    // zero default, which an i32 holds too, but there is nothing to win.
    if (r === null || isBottom(r)) continue;
    const sep = c.indexOf("\u0000");
    if (sep < 0) plan.globals.set(c, r);
    else {
      const fn = c.slice(0, sep);
      let m = plan.locals.get(fn);
      if (m === undefined) plan.locals.set(fn, (m = new Map()));
      m.set(c.slice(sep + 1), r);
    }
  }
  return plan;
}
