/* A thin expression layer over Code for the hand-built runtime families
 * (http.ts): a value is a thunk that pushes it, so an expression reads as
 * a tree — `$.if($.eq($.get(T, F, $.l(S)), $.i(0)), () => ...)` — while the
 * bytes stay exactly what the equivalent straight-line Code calls emit.
 * Nothing here knows any runtime type; it only spells instructions. */
import { Code } from "./code.js";
import { emitFlat } from "./strings.js";
import { F64, I32, I64, type ValType } from "./module.js";

/** A value: pushes its result(s) onto the stack when called. */
export type X = () => void;

/** One function under construction: its Code and its extra locals. */
export class Fn {
  readonly c = new Code();
  private readonly extra: ValType[] = [];
  constructor(readonly nparams: number) {}
  local(t: ValType): number {
    this.extra.push(t);
    return this.nparams + this.extra.length - 1;
  }
  get locals(): ValType[] {
    return this.extra;
  }
}

export class A {
  constructor(readonly f: Fn) {}

  get c(): Code {
    return this.f.c;
  }

  local(t: ValType): number {
    return this.f.local(t);
  }

  /* ── leaves ─────────────────────────────────────────────────────── */

  l(i: number): X {
    return () => this.c.localGet(i);
  }
  i(n: number): X {
    return () => this.c.i32Const(n);
  }
  d(n: number): X {
    return () => this.c.f64Const(n);
  }
  j(n: bigint): X {
    return () => this.c.i64Const(n);
  }
  g(idx: number): X {
    return () => this.c.globalGet(idx);
  }
  nul(typeIndex: number): X {
    return () => this.c.refNull(typeIndex);
  }
  /** A raw emitter as a value. */
  raw(fn: (c: Code) => void): X {
    return () => fn(this.c);
  }

  /* ── struct / array access ──────────────────────────────────────── */

  get(T: number, field: number, o: X): X {
    return () => {
      o();
      this.c.structGet(T, field);
    };
  }
  set(T: number, field: number, o: X, v: X): void {
    o();
    v();
    this.c.structSet(T, field);
  }
  aget(T: number, a: X, i: X): X {
    return () => {
      a();
      i();
      this.c.arrayGet(T);
    };
  }
  agetU(T: number, a: X, i: X): X {
    return () => {
      a();
      i();
      this.c.arrayGetU(T);
    };
  }
  aset(T: number, a: X, i: X, v: X): void {
    a();
    i();
    v();
    this.c.arraySet(T);
  }
  alen(a: X): X {
    return () => {
      a();
      this.c.arrayLen();
    };
  }
  anew(T: number, n: X): X {
    return () => {
      n();
      this.c.arrayNewDefault(T);
    };
  }
  new_(T: number, ...fields: X[]): X {
    return () => {
      for (const x of fields) x();
      this.c.structNew(T);
    };
  }
  cast(T: number, o: X): X {
    return () => {
      o();
      this.c.refCast(T);
    };
  }
  /** A string VALUE made flat `$chars` (strings.ts emitFlat): `strType`
   * is the flat array type. */
  flat(strType: number, o: X): X {
    return () => {
      o();
      emitFlat(this.c, strType);
    };
  }
  test(T: number, o: X): X {
    return () => {
      o();
      this.c.refTest(T);
    };
  }
  isNull(o: X): X {
    return () => {
      o();
      this.c.refIsNull();
    };
  }
  notNull(o: X): X {
    return () => {
      o();
      this.c.refIsNull();
      this.c.i32Eqz();
    };
  }
  refEq(a: X, b: X): X {
    return () => {
      a();
      b();
      this.c.refEq();
    };
  }

  /* ── i32 arithmetic and tests ───────────────────────────────────── */

  private bin(op: (c: Code) => void, a: X, b: X): X {
    return () => {
      a();
      b();
      op(this.c);
    };
  }
  add(a: X, b: X): X {
    return this.bin((c) => c.i32Add(), a, b);
  }
  sub(a: X, b: X): X {
    return this.bin((c) => c.i32Sub(), a, b);
  }
  mul(a: X, b: X): X {
    return this.bin((c) => c.i32Mul(), a, b);
  }
  and(a: X, b: X): X {
    return this.bin((c) => c.i32And(), a, b);
  }
  or(a: X, b: X): X {
    return this.bin((c) => c.i32Or(), a, b);
  }
  xor(a: X, b: X): X {
    return this.bin((c) => c.i32Xor(), a, b);
  }
  shl(a: X, b: X): X {
    return this.bin((c) => c.i32Shl(), a, b);
  }
  shrU(a: X, b: X): X {
    return this.bin((c) => c.i32ShrU(), a, b);
  }
  eq(a: X, b: X): X {
    return this.bin((c) => c.i32Eq(), a, b);
  }
  ne(a: X, b: X): X {
    return this.bin((c) => c.i32Ne(), a, b);
  }
  lt(a: X, b: X): X {
    return this.bin((c) => c.i32LtS(), a, b);
  }
  le(a: X, b: X): X {
    return this.bin((c) => c.i32LeS(), a, b);
  }
  gt(a: X, b: X): X {
    return this.bin((c) => c.i32GtS(), a, b);
  }
  ge(a: X, b: X): X {
    return this.bin((c) => c.i32GeS(), a, b);
  }
  ltU(a: X, b: X): X {
    return this.bin((c) => c.i32LtU(), a, b);
  }
  geU(a: X, b: X): X {
    return this.bin((c) => c.i32GeU(), a, b);
  }
  gtU(a: X, b: X): X {
    return this.bin((c) => c.i32GtU(), a, b);
  }
  leU(a: X, b: X): X {
    return this.bin((c) => c.i32LeU(), a, b);
  }
  not(a: X): X {
    return () => {
      a();
      this.c.i32Eqz();
    };
  }
  /** a && b as 0/1 values (both evaluated — i32.and does not short-circuit). */
  both(a: X, b: X): X {
    return this.and(a, b);
  }
  /** a || b as 0/1 values (both evaluated). */
  either(a: X, b: X): X {
    return this.or(a, b);
  }
  /** Short-circuit a && b (b runs only when a holds). */
  andThen(a: X, b: X): X {
    return () => {
      a();
      this.c.ifResult(I32);
      b();
      this.c.else_();
      this.c.i32Const(0);
      this.c.end();
    };
  }
  /** Short-circuit a || b. */
  orElse(a: X, b: X): X {
    return () => {
      a();
      this.c.ifResult(I32);
      this.c.i32Const(1);
      this.c.else_();
      b();
      this.c.end();
    };
  }
  /** (o.field & mask) != 0 */
  bit(T: number, field: number, o: X, mask: number): X {
    return this.ne(this.and(this.get(T, field, o), this.i(mask)), this.i(0));
  }
  bitSet(T: number, field: number, o: X, mask: number): void {
    this.set(T, field, o, this.or(this.get(T, field, o), this.i(mask)));
  }
  bitClr(T: number, field: number, o: X, mask: number): void {
    this.set(T, field, o, this.and(this.get(T, field, o), this.i(~mask)));
  }
  /** o.field += n (i32) */
  inc(T: number, field: number, o: X, n = 1): void {
    this.set(T, field, o, this.add(this.get(T, field, o), this.i(n)));
  }

  /* ── f64 ────────────────────────────────────────────────────────── */

  dadd(a: X, b: X): X {
    return this.bin((c) => c.f64Add(), a, b);
  }
  dsub(a: X, b: X): X {
    return this.bin((c) => c.f64Sub(), a, b);
  }
  deq(a: X, b: X): X {
    return this.bin((c) => c.f64Eq(), a, b);
  }
  dne(a: X, b: X): X {
    return this.bin((c) => c.f64Ne(), a, b);
  }
  dlt(a: X, b: X): X {
    return this.bin((c) => c.f64Lt(), a, b);
  }
  dgt(a: X, b: X): X {
    return this.bin((c) => c.f64Gt(), a, b);
  }
  dle(a: X, b: X): X {
    return this.bin((c) => c.f64Le(), a, b);
  }
  dge(a: X, b: X): X {
    return this.bin((c) => c.f64Ge(), a, b);
  }
  i2d(a: X): X {
    return () => {
      a();
      this.c.f64ConvertI32S();
    };
  }
  d2i(a: X): X {
    return () => {
      a();
      this.c.i32TruncF64S();
    };
  }

  /* ── calls ──────────────────────────────────────────────────────── */

  call(fn: number, ...args: X[]): X {
    return () => {
      for (const a of args) a();
      this.c.call(fn);
    };
  }
  /** Statement form of a call (the result, if any, is dropped by the caller). */
  run(fn: number, ...args: X[]): void {
    for (const a of args) a();
    this.c.call(fn);
  }

  /* ── statements ─────────────────────────────────────────────────── */

  do(...xs: X[]): void {
    for (const x of xs) x();
  }
  drop(x: X): void {
    x();
    this.c.drop();
  }
  put(local: number, v: X): void {
    v();
    this.c.localSet(local);
  }
  tee(local: number, v: X): X {
    return () => {
      v();
      this.c.localTee(local);
    };
  }
  gput(idx: number, v: X): void {
    v();
    this.c.globalSet(idx);
  }
  if(cond: X, then: () => void, els?: () => void): void {
    cond();
    this.c.ifVoid();
    then();
    if (els !== undefined) {
      this.c.else_();
      els();
    }
    this.c.end();
  }
  /** A value chosen by `cond` (if with one result). */
  sel(t: ValType, cond: X, a: X, b: X): X {
    return () => {
      cond();
      this.c.ifResult(t);
      a();
      this.c.else_();
      b();
      this.c.end();
    };
  }
  /** while (cond) body — `body` must not branch out of the loop. */
  while(cond: X, body: () => void): void {
    const c = this.c;
    c.block();
    c.loop();
    cond();
    c.i32Eqz();
    c.brIf(1);
    body();
    c.br(0);
    c.end();
    c.end();
  }
  /** for (i = from; i < to; i++) body — `to` is re-read every turn. */
  for(i: number, from: X, to: X, body: () => void): void {
    this.put(i, from);
    this.while(this.lt(this.l(i), to), () => {
      body();
      this.put(i, this.add(this.l(i), this.i(1)));
    });
  }
  ret(v?: X): void {
    if (v !== undefined) v();
    this.c.return_();
  }
  trap(): void {
    this.c.unreachable();
  }
}

export { F64, I32, I64 };
