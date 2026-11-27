/* U8a, loop plumbing on `any` (docs/design/u8-dynamic-speed.md §8).
 *
 * The island operators box their operands: `i < xs.length` with a typed
 * `i` marshals `i` into a fresh `$dyn` (jsMarshal), the `length` read
 * boxes the array's length, and the generic relational code then runs
 * ToPrimitive and ToNumber on each, two allocations and several calls per
 * loop iteration. Here an operator whose operand is a typed number, or a
 * `length` read, keeps its numbers unboxed:
 *
 *   - a typed number (`jsMarshal` of an f64) is evaluated into an f64
 *     local and is never boxed on the fast path;
 *   - `r.length` on an island ARRAY (or an array view, through its
 *     accessor) reads the length as an f64; any other receiver runs the
 *     generic `length` read, unchanged;
 *   - any other operand is evaluated into a `$dyn` local as before.
 *
 * Operands evaluate left to right exactly as the generic code evaluates
 * them, and each dynamic operand leaves a flag saying whether it is a
 * number (an array's length, or a box of kind NUM) with its value in an
 * f64 local. When every operand is a number the operator runs in f64: a
 * relational op is the IEEE compare (false for any NaN, JS's own rule), an
 * arithmetic op computes the f64 and boxes its result once (the result is
 * a jsval). Otherwise each unboxed operand is boxed (the box the generic
 * code would have built) and the generic operator runs on the two boxes,
 * so strings, BigInt, objects with valueOf/toString, undefined and null
 * answer exactly as before. ToPrimitive of a number is the number itself,
 * so boxing late changes nothing observable.
 *
 * Also here, for the same loops:
 *   - `xs[i]` with a number index (emitNumIndex, unit H's read and write,
 *     moved out of emitter.ts): an island array with an integral index in
 *     range reads or writes its slot; everything else takes the generic
 *     keyed route over the number's ToString;
 *   - `x === null` / `x === undefined` (emitNullishEq): strict equality
 *     with a null or undefined literal is a kind test (dyn.ts strictEq
 *     answers equal kinds UNDEF / NULL true and any two different kinds
 *     false, a view included), with no call;
 *   - `jsExit(f64, r.length)`, `const n: number = xs.length`
 *     (emitLengthExit).
 *
 * Only the generic paths can throw, so only they run the pending check.
 * The hot loops of a program's top level run once, in V8's baseline tier
 * (wasm has no on-stack replacement), so the fast paths are kept to few
 * instructions. */
import type { Code } from "./code.js";
import { DK, DYN_KIND, DYN_NUM, type DynBuilder } from "./dyn.js";
import { F64, I32, type ValType } from "./module.js";
import type { WExpr } from "./statemachine.js";

/** The relational and arithmetic island ops this module answers. */
export type NumRelOp = "lt" | "le" | "gt" | "ge";
export type NumArithOp = "add" | "sub" | "mul" | "div" | "mod";

export interface LoopNumDeps {
  code: () => Code;
  dyn: DynBuilder;
  /** Does the module hold array views (`$dynView`)? */
  viewsLive: () => boolean;
  /** Does the module build tag-call strings arrays (S080's frozen arrays)? */
  tplLive: () => boolean;
  walkExpr: (e: WExpr) => void;
  acquireScratch: (t: ValType) => number;
  releaseScratch: (t: ValType, index: number) => void;
  /** The emitter's control-tracked if/else (break depths stay right). */
  openIfResult: (t: ValType) => void;
  openIf: () => void;
  close: () => void;
  /** The generic `<recv>.length` read: the receiver box on the stack →
   * the property's box (may throw; the caller runs the pending check). */
  genericLength: (c: Code, loc: WExpr["loc"]) => void;
  emitPendingCheck: () => void;
  /** The generic relational op on two `$dyn` locals → i32. */
  genericRel: (op: NumRelOp, a: number, b: number) => void;
  /** The generic arithmetic op on two `$dyn` locals → a `$dyn`. */
  genericArith: (op: NumArithOp, a: number, b: number) => void;
  /** `%w.fmod(f64, f64) -> f64` (JS `%`). */
  fmod: () => number;
}

/** One evaluated operand. `f` holds its number when it is one. A typed
 * number (`n` -1) always is, and has no box until the slow path builds
 * one in `d`. A dynamic operand has the flag `n` (1: a number, in `f`) and
 * its box in `d`. A `length` read (`len`) that is a number may have no box
 * (an array's length is read unboxed), so the slow path boxes `f` for it
 * whenever its flag holds: a second box of a number the generic read
 * boxed is never observable (ToPrimitive of a number is the number). */
interface Operand {
  f: number;
  d: number;
  n: number;
  len: boolean;
}

/** A typed number marshalled into an island op. */
function typedNum(e: WExpr): WExpr | null {
  return e.kind === "jsMarshal" && e.value.type.kind === "f64" ? e.value : null;
}

/** A `<recv>.length` read in the island world. */
function lengthRead(e: WExpr): WExpr | null {
  return e.kind === "jsOp" && e.op === "getProp" && e.name === "length" && e.args.length === 1 ? e.args[0]! : null;
}

/** A null or undefined literal in the island world: the kind it is. */
function nullishLit(e: WExpr): number | null {
  if (e.kind !== "jsOp") return null;
  return e.op === "nullLit" ? DK.NULL : e.op === "undefLit" ? DK.UNDEF : null;
}

export class LoopNum {
  constructor(private readonly deps: LoopNumDeps) {}

  /** Does this module take over the op with these operands? Only when one
   * of them is a typed number or a `length` read: those are the operands
   * this saves a box on. */
  applies(args: readonly WExpr[]): boolean {
    return args.length === 2 && args.some((a) => typedNum(a) !== null || lengthRead(a) !== null);
  }

  /** `a <op> b`, leaving the i32 answer. */
  emitRel(op: NumRelOp, args: readonly WExpr[], loc: WExpr["loc"]): void {
    const code = this.deps.code();
    const a = this.operand(args[0]!, loc);
    const b = this.operand(args[1]!, loc);
    const fast = (): void => {
      code.localGet(a.f);
      code.localGet(b.f);
      if (op === "lt") code.f64Lt();
      else if (op === "le") code.f64Le();
      else if (op === "gt") code.f64Gt();
      else code.f64Ge();
    };
    this.decide(a, b, I32, fast, () => this.deps.genericRel(op, a.d, b.d));
    this.release(a);
    this.release(b);
  }

  /** `a <op> b`, leaving the result box. */
  emitArith(op: NumArithOp, args: readonly WExpr[], loc: WExpr["loc"]): void {
    const dyn = this.deps.dyn;
    const a = this.operand(args[0]!, loc);
    const b = this.operand(args[1]!, loc);
    const fast = (): void =>
      dyn.boxNum(this.deps.code(), (c) => {
        c.localGet(a.f);
        c.localGet(b.f);
        if (op === "add") c.f64Add();
        else if (op === "sub") c.f64Sub();
        else if (op === "mul") c.f64Mul();
        else if (op === "div") c.f64Div();
        else c.call(this.deps.fmod());
      });
    this.decide(a, b, dyn.dynRef(), fast, () => this.deps.genericArith(op, a.d, b.d));
    this.release(a);
    this.release(b);
  }

  /** `a === b` / `a !== b` where one operand is a null or undefined
   * literal: a kind test on the other, leaving the i32 answer. False when
   * neither operand is such a literal (the caller emits strictEq). */
  emitNullishEq(negated: boolean, args: readonly WExpr[]): boolean {
    if (args.length !== 2) return false;
    const litL = nullishLit(args[0]!);
    const litR = nullishLit(args[1]!);
    const kind = litR ?? litL;
    if (kind === null) return false;
    const code = this.deps.code();
    // The literal evaluates to nothing observable, so only the other
    // operand is evaluated (in its place: the literal has no effects).
    this.deps.walkExpr(litR !== null ? args[0]! : args[1]!);
    code.structGet(this.deps.dyn.dynT(), DYN_KIND);
    code.i32Const(kind);
    if (negated) code.i32Ne();
    else code.i32Eq();
    return true;
  }

  /** `jsExit(f64, <recv>.length)`: an island array's length straight to
   * the f64; `rest` runs the exit's generic check over the box in `d`
   * (`d` is set first), for every other receiver. */
  emitLengthExit(value: WExpr, d: number, rest: () => void): boolean {
    const recv = lengthRead(value);
    if (recv === null) return false;
    const code = this.deps.code();
    const dynRef = this.deps.dyn.dynRef();
    const r = this.deps.acquireScratch(dynRef);
    this.deps.walkExpr(recv);
    code.localSet(r);
    this.arrayTest(r);
    this.deps.openIfResult(F64);
    this.pushArrayLength(r);
    code.else_();
    code.localGet(r);
    this.deps.genericLength(code, value.loc);
    this.deps.emitPendingCheck();
    code.localSet(d);
    rest();
    this.deps.close();
    this.deps.releaseScratch(dynRef, r);
    return true;
  }

  /* ── operands ─────────────────────────────────────────────────────── */

  private operand(e: WExpr, loc: WExpr["loc"]): Operand {
    const code = this.deps.code();
    const dyn = this.deps.dyn;
    const dynRef = dyn.dynRef();
    const f = this.deps.acquireScratch(F64);
    const d = this.deps.acquireScratch(dynRef);
    const num = typedNum(e);
    if (num !== null) {
      this.deps.walkExpr(num);
      code.localSet(f);
      return { f, d, n: -1, len: false };
    }
    const n = this.deps.acquireScratch(I32);
    const recv = lengthRead(e);
    if (recv !== null) {
      // The receiver box goes in `d` for the test; an array leaves its
      // length in `f` (`d` is then dead: the slow path boxes `f`), anything
      // else the generic read's box.
      this.deps.walkExpr(recv);
      code.localSet(d);
      this.arrayTest(d);
      code.localTee(n);
      this.deps.openIf();
      this.pushArrayLength(d);
      code.localSet(f);
      code.else_();
      code.localGet(d);
      this.deps.genericLength(code, e.loc ?? loc);
      this.deps.emitPendingCheck();
      code.localSet(d);
      this.numFlag(d, f, n);
      this.deps.close();
    } else {
      this.deps.walkExpr(e);
      code.localSet(d);
      this.numFlag(d, f, n);
    }
    return { f, d, n, len: recv !== null };
  }

  /** `n` = is the box in `d` a NUM; `f` = its num field (every box has
   * one; it is read only where `n` holds). */
  private numFlag(d: number, f: number, n: number): void {
    const code = this.deps.code();
    const dynT = this.deps.dyn.dynT();
    code.localGet(d);
    code.structGet(dynT, DYN_KIND);
    code.i32Const(DK.NUM);
    code.i32Eq();
    code.localSet(n);
    code.localGet(d);
    code.structGet(dynT, DYN_NUM);
    code.localSet(f);
  }

  /** Every operand a number → `fast`, else box the unboxed ones and run
   * `slow` on the two boxes; both leave a `result`. */
  private decide(a: Operand, b: Operand, result: ValType, fast: () => void, slow: () => void): void {
    const code = this.deps.code();
    const flags = [a, b].filter((o) => o.n >= 0);
    flags.forEach((o, i) => {
      code.localGet(o.n);
      if (i > 0) code.i32And();
    });
    // `applies` guarantees a typed number or a length read, so at least
    // one operand is not a plain box; with two typed numbers there is no
    // flag at all (a typed op lowers to `bin`, not here, but stay total).
    if (flags.length === 0) {
      fast();
      return;
    }
    this.deps.openIfResult(result);
    fast();
    code.else_();
    this.boxIn(a);
    this.boxIn(b);
    slow();
    this.deps.close();
  }

  /** The slow path's box for an operand that has none. */
  private boxIn(o: Operand): void {
    const code = this.deps.code();
    const box = (): void => {
      this.deps.dyn.boxNum(code, (c) => c.localGet(o.f));
      code.localSet(o.d);
    };
    if (o.n < 0) {
      box();
      return;
    }
    if (!o.len) return;
    code.localGet(o.n);
    code.ifVoid();
    box();
    code.end();
  }

  private release(o: Operand): void {
    if (o.n >= 0) this.deps.releaseScratch(I32, o.n);
    this.deps.releaseScratch(this.deps.dyn.dynRef(), o.d);
    this.deps.releaseScratch(F64, o.f);
  }

  /* ── arrays ───────────────────────────────────────────────────────── */

  /** i32: is the box in local `r` an island ARRAY (a view included)? */
  private arrayTest(r: number): void {
    const code = this.deps.code();
    code.localGet(r);
    code.structGet(this.deps.dyn.dynT(), DYN_KIND);
    code.i32Const(DK.ARR);
    code.i32Eq();
  }

  /** The f64 length of the ARR box in local `r`: a view's accessor's, else
   * its vector's (the generic getProp "length" arm's two reads). */
  private pushArrayLength(r: number): void {
    const code = this.deps.code();
    const dyn = this.deps.dyn;
    if (this.deps.viewsLive()) {
      dyn.isView(code, (x) => x.localGet(r));
      code.ifResult(I32);
      code.localGet(r);
      code.call(dyn.viewLen());
      code.else_();
      dyn.arrLen(code, (x) => dyn.arrPayload(x, (y) => y.localGet(r)));
      code.end();
    } else {
      dyn.arrLen(code, (x) => dyn.arrPayload(x, (y) => y.localGet(r)));
    }
    code.f64ConvertI32U();
  }

  /** jsOp getIdx (`value` null) / setIdx over a NUMBER index (unit H, the
   * `any[]` loops): receiver and index evaluate once, in order (then the
   * value, for a write; `keepRecv` >= 0 also keeps the receiver there, an
   * element call's `this`, GH #133). An island array (not a view, and for
   * a write not S080's frozen strings array) with an integral index in
   * [0, length) reads or writes its slot directly (a hole reads
   * undefined); an array view with an integral index in [0, 2^31) goes to
   * its element accessor; every other case (other kinds, fractions,
   * negatives, NaN, out of range: a write past the end grows the array)
   * runs the generic keyed route over the number's ToString. Same answers,
   * no key string on the hot path. */
  emitNumIndex(recvExpr: WExpr, indexExpr: WExpr, value: WExpr | null, keepRecv = -1): void {
    const code = this.deps.code();
    const dyn = this.deps.dyn;
    const dynT = dyn.dynT();
    const dynRef = dyn.dynRef();
    const views = this.deps.viewsLive();
    const r = this.deps.acquireScratch(dynRef);
    const f = this.deps.acquireScratch(F64);
    const u = this.deps.acquireScratch(I32);
    const v = value !== null ? this.deps.acquireScratch(dynRef) : -1;
    const pv = this.deps.acquireScratch(dyn.arrRef());
    this.deps.walkExpr(recvExpr);
    code.localSet(r);
    if (keepRecv >= 0) {
      code.localGet(r);
      code.localSet(keepRecv);
    }
    this.deps.walkExpr(indexExpr);
    code.localSet(f);
    if (value !== null) {
      this.deps.walkExpr(value);
      code.localSet(v);
    }
    const open = (): void => (value === null ? this.deps.openIfResult(dynRef) : this.deps.openIf());
    // The payload vector, read (and cast) once per access into `pv`. The
    // vector struct is stable; arrSet reads its buffer after the value.
    const vec = (c: Code): void => c.localGet(pv);
    // i32: is `f` an integer in [-2^31, 2^31) (-0 is 0)? Its truncation
    // goes to `u`. Read as unsigned, `u` is then a valid index exactly
    // when it is below a length (a negative integer is 2^31 or more).
    const integral = (): void => {
      code.localGet(f);
      code.i32TruncSatF64S();
      code.localTee(u);
      code.f64ConvertI32S();
      code.localGet(f);
      code.f64Eq();
    };
    const slow = (): void => {
      code.localGet(r);
      dyn.boxNum(code, (c) => c.localGet(f));
      code.call(dyn.toStr());
      if (value === null) {
        code.i32Const(0);
        code.call(dyn.keyGet());
      } else {
        code.localGet(v);
        code.call(dyn.islandSetIdx());
      }
      this.deps.emitPendingCheck();
    };
    const isView = (): void => dyn.isView(code, (c) => c.localGet(r));
    // ARR (a view or not), then the index test.
    this.arrayTest(r);
    open();
    integral();
    open();
    if (views) {
      // A view: its element accessor (undefined past the end; a write
      // owns the hole and type refusals), for a non-negative index.
      isView();
      open();
      code.localGet(u);
      code.i32Const(0);
      code.i32GeS();
      open();
      code.localGet(r);
      code.localGet(u);
      if (value !== null) code.localGet(v);
      code.call(value === null ? dyn.viewGetI() : dyn.viewSetI());
      this.deps.emitPendingCheck();
      code.else_();
      slow();
      this.deps.close();
      code.else_();
    }
    if (value !== null && this.deps.tplLive()) {
      // S080: a tag call's FROZEN strings array (or its raw) is never
      // written in place: the keyed route's write guard throws Node's
      // TypeError (strict code; a sloppy write never takes this path).
      code.localGet(r);
      code.refTest(dyn.tplT());
      open();
      slow();
      code.else_();
    }
    dyn.arrPayload(code, (x) => x.localGet(r));
    code.localSet(pv);
    code.localGet(u);
    dyn.arrLen(code, vec);
    code.i32LtU();
    open();
    if (value === null) {
      dyn.arrAt(code, vec, (c) => c.localGet(u));
      code.localTee(r);
      code.refIsNull();
      code.ifResult(dynRef);
      code.globalGet(dyn.undefinedGlobal());
      code.else_();
      code.localGet(r);
      code.end();
    } else {
      dyn.arrSet(code, vec, (c) => c.localGet(u), (c) => c.localGet(v));
    }
    code.else_();
    slow();
    this.deps.close();
    if (value !== null && this.deps.tplLive()) this.deps.close();
    if (views) this.deps.close();
    code.else_();
    slow();
    this.deps.close();
    code.else_();
    slow();
    this.deps.close();
    this.deps.releaseScratch(dyn.arrRef(), pv);
    if (value !== null) this.deps.releaseScratch(dynRef, v);
    this.deps.releaseScratch(I32, u);
    this.deps.releaseScratch(F64, f);
    this.deps.releaseScratch(dynRef, r);
  }
}
