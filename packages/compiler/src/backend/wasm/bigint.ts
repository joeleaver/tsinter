/* BigInt on the WasmGC lanes: the value's representation and every helper
 * the emitter calls for it. A module with no bigint pays nothing (the
 * emitter's lazy `big` accessor, the symbols.ts convention).
 *
 * THE VALUE is one immutable struct `$big { v: i64, mag: (ref null $ia) }`:
 *   - mag null: the value IS v (the i64 fast path, every value in
 *     [-2^63, 2^63));
 *   - mag set: the value is bigint-src.ts's sign-magnitude int array (sign
 *     in mag[0], 32-bit limbs after it), and v is 0.
 * The form is CANONICAL: a value that fits in an i64 is always the fast
 * form, so two values are equal exactly when both are small with equal v
 * or both are heap with equal arrays. That is what lets `===`, Map/Set keys
 * (SameValueZero) and hashing compare by value without normalizing first.
 * Values are never mutated after struct.new, so sharing one (a literal's
 * global, an operand handed back unchanged) is unobservable, as in JS.
 *
 * THE ARITHMETIC: add, sub, mul, the bitwise operators, negation, shifts,
 * comparison and equality run inline on the fast form when the result is
 * known to fit (overflow-checked); everything else converts the operands to
 * the array form and calls the C (bigint-src.ts, compiled by csubset.ts),
 * then canonicalizes the result. Both paths are exact; the fast path only
 * saves allocation.
 *
 * THROWS follow the tier's pending-cell convention: a helper that throws
 * sets the exception cell (deps.throwError) and returns a null/zero
 * placeholder, and the emitter's call site runs its pending check. The
 * messages are V8's, byte for byte (measured against Node v24.18.1). The
 * size limit is V8's 2^30 bits ("Maximum BigInt size exceeded"), checked
 * exactly for shifts and products; `**` estimates within two bits
 * (bn_pow_limited), which no program observes short of a result of about
 * 128 MB (SEMANTICS.md S137). */
import { Code } from "./code.js";
import { BIGINT_C } from "./bigint-src.js";
import { CCompiler, parseC } from "./csubset.js";
import { F64, I32, I64, type ModuleBuilder, type ValType } from "./module.js";

export interface BigDeps {
  /** The flat string type `(ref null $chars)` and its array index. */
  strRef: () => ValType;
  strType: () => number;
  lit: (c: Code, s: string) => void;
  concat: () => number;
  /** Number::toString of an f64 (the RangeError message's number). */
  f64ToStr: () => number;
  /** Set the exception cell to a fresh builtin error (no unwind); `code`
   * fills the error's `.code`. */
  throwError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, code?: string) => void;
}

const V = 0;
const MAG = 1;
/** V8's BigInt::kMaxLengthBits. */
const MAX_BITS = 1n << 30n;
const MIN_I64 = -(1n << 63n);

export const BIGINT_SIZE_MSG = "Maximum BigInt size exceeded";

let unitCache: ReturnType<typeof parseC> | null = null;
function unit(): ReturnType<typeof parseC> {
  unitCache ??= parseC(BIGINT_C, {});
  return unitCache;
}

export class BigBuilder {
  private readonly cc: CCompiler;
  readonly bigType: number;
  private readonly fns = new Map<string, number>();
  private readonly lits = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: BigDeps,
  ) {
    this.cc = new CCompiler(mb, unit(), "%w.big.c.");
    // A keyed (open) struct, so no other struct of the same layout can ever
    // share its runtime type.
    this.bigType = mb.openStructType("%big", [
      { storage: I64, mutable: false },
      { storage: this.iaRef(), mutable: false },
    ]);
  }

  bigRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bigType };
  }

  private iaRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.cc.ia };
  }

  private c(name: string): number {
    return this.cc.fn(name);
  }

  /** Declare-once helper: the index is registered before the body is built,
   * so a body may call itself (or a helper that calls back). */
  private def(name: string, params: ValType[], results: ValType[], locals: ValType[], build: (c: Code) => void): number {
    const got = this.fns.get(name);
    if (got !== undefined) return got;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.big.${name}`);
    this.fns.set(name, idx);
    const c = new Code();
    build(c);
    this.mb.setBody(idx, locals, c.bytes());
    return idx;
  }

  /** [i64] -> a fast-form value. */
  small(c: Code): void {
    c.refNull(this.cc.ia);
    c.structNew(this.bigType);
  }

  private v(c: Code): void {
    c.structGet(this.bigType, V);
  }

  private isSmall(c: Code, local: number): void {
    c.localGet(local);
    c.structGet(this.bigType, MAG);
    c.refIsNull();
  }

  private bothSmall(c: Code, a: number, b: number): void {
    this.isSmall(c, a);
    this.isSmall(c, b);
    c.i32And();
  }

  private throwRange(c: Code, msg: string): void {
    this.deps.throwError(c, "%RangeError", "RangeError", (c2) => this.deps.lit(c2, msg));
  }

  /** The literal `<value>n`: an immutable global, built once per module per
   * value (a constant expression: struct.new / array.new_fixed). */
  literal(value: bigint): number {
    const key = value.toString();
    const got = this.lits.get(key);
    if (got !== undefined) return got;
    const big = this.bigType;
    const ia = this.cc.ia;
    const fits = value >= MIN_I64 && value < -MIN_I64;
    const g = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: big }, false, (w) => {
      if (fits) {
        w.u8(0x42);
        w.sleb64(value);
        w.u8(0xd0);
        w.sleb(ia);
      } else {
        w.u8(0x42);
        w.sleb64(0n);
        let m = value < 0n ? -value : value;
        const limbs: number[] = [];
        while (m > 0n) {
          limbs.push(Number(m & 0xffffffffn) | 0);
          m >>= 32n;
        }
        w.u8(0x41);
        w.sleb(value < 0n ? 1 : 0);
        for (const l of limbs) {
          w.u8(0x41);
          w.sleb(l);
        }
        w.u8(0xfb);
        w.uleb(0x08);
        w.uleb(ia);
        w.uleb(limbs.length + 1);
      }
      w.u8(0xfb);
      w.uleb(0x00);
      w.uleb(big);
    });
    this.lits.set(key, g);
    return g;
  }

  /** (big) -> ia: the array form (a fresh array for a fast-form value). */
  toIa(): number {
    const B = this.bigRef();
    return this.def("toIa", [B], [this.iaRef()], [this.iaRef()], (c) => {
      c.localGet(0);
      c.structGet(this.bigType, MAG);
      c.localTee(1);
      c.refIsNull();
      c.ifResult(this.iaRef());
      c.localGet(0);
      this.v(c);
      c.call(this.c("bn_from_bits"));
      c.else_();
      c.localGet(1);
      c.end();
    });
  }

  /** (ia) -> big: canonicalize. */
  fromIa(): number {
    return this.def("fromIa", [this.iaRef()], [this.bigRef()], [], (c) => {
      c.localGet(0);
      c.call(this.c("bn_fits_i64"));
      c.ifResult(this.bigRef());
      c.localGet(0);
      c.call(this.c("bn_to_bits"));
      this.small(c);
      c.else_();
      c.i64Const(0n);
      c.localGet(0);
      c.structNew(this.bigType);
      c.end();
    });
  }

  /** The slow path of a binary operator: both operands as arrays, the C
   * function, canonicalized. */
  private slow2(c: Code, cfn: string, extra?: (c: Code) => void): void {
    c.localGet(0);
    c.call(this.toIa());
    c.localGet(1);
    c.call(this.toIa());
    extra?.(c);
    c.call(this.c(cfn));
    c.call(this.fromIa());
  }

  /** a + b, a - b, a * b. */
  arith(op: "add" | "sub" | "mul"): number {
    const B = this.bigRef();
    return this.def(op, [B, B], [B], [I64, I64, I64, B], (c) => {
      const X = 2;
      const Y = 3;
      const R = 4;
      this.bothSmall(c, 0, 1);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.localSet(X);
      c.localGet(1);
      this.v(c);
      c.localSet(Y);
      if (op === "mul") {
        // both in [-2^31, 2^31): the product fits
        c.localGet(X);
        c.i64Const(1n << 31n);
        c.i64Add();
        c.i64Const(1n << 32n);
        c.i64LtU();
        c.localGet(Y);
        c.i64Const(1n << 31n);
        c.i64Add();
        c.i64Const(1n << 32n);
        c.i64LtU();
        c.i32And();
        c.ifVoid();
        c.localGet(X);
        c.localGet(Y);
        c.i64Mul();
        this.small(c);
        c.return_();
        c.end();
      } else {
        c.localGet(X);
        c.localGet(Y);
        if (op === "add") c.i64Add();
        else c.i64Sub();
        c.localSet(R);
        // signed overflow: add ((x^r)&(y^r)) < 0, sub ((x^y)&(x^r)) < 0
        c.localGet(X);
        if (op === "add") c.localGet(R);
        else c.localGet(Y);
        c.i64Xor();
        if (op === "add") c.localGet(Y);
        else c.localGet(X);
        c.localGet(R);
        c.i64Xor();
        c.i64And();
        c.i64Const(0n);
        c.i64GeS();
        c.ifVoid();
        c.localGet(R);
        this.small(c);
        c.return_();
        c.end();
      }
      c.end();
      if (op !== "mul") {
        this.slow2(c, op === "add" ? "bn_add" : "bn_sub");
        return;
      }
      // V8's size limit, exactly: the product has bitlen(a) + bitlen(b) or
      // one bit fewer, so past the limit by two or more it throws before
      // allocating, and otherwise the result's own length decides
      this.bitlen(c, 0);
      this.bitlen(c, 1);
      c.i64Add();
      c.i64Const(MAX_BITS + 1n);
      c.i64GtU();
      c.ifVoid();
      this.throwRange(c, BIGINT_SIZE_MSG);
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.toIa());
      c.localGet(1);
      c.call(this.toIa());
      c.call(this.c("bn_mul"));
      c.call(this.fromIa());
      c.localSet(5);
      this.bitlen(c, 5);
      c.i64Const(MAX_BITS);
      c.i64GtU();
      c.ifVoid();
      this.throwRange(c, BIGINT_SIZE_MSG);
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(5);
    });
  }

  private zeroCheck(c: Code, local: number): void {
    this.isSmall(c, local);
    c.ifVoid();
    c.localGet(local);
    this.v(c);
    c.i64Eqz();
    c.ifVoid();
    this.throwRange(c, "Division by zero");
    c.refNull(this.bigType);
    c.return_();
    c.end();
    c.end();
  }

  /** a / b (truncating), a % b (sign of a): RangeError on a zero divisor. */
  divRem(op: "div" | "rem"): number {
    const B = this.bigRef();
    return this.def(op, [B, B], [B], [I64, I64], (c) => {
      const X = 2;
      const Y = 3;
      this.zeroCheck(c, 1);
      this.bothSmall(c, 0, 1);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.localSet(X);
      c.localGet(1);
      this.v(c);
      c.localSet(Y);
      if (op === "div") {
        // MIN / -1 is 2^63: the slow path
        c.localGet(X);
        c.i64Const(MIN_I64);
        c.i64Ne();
        c.localGet(Y);
        c.i64Const(-1n);
        c.i64Ne();
        c.i32Or();
        c.ifVoid();
        c.localGet(X);
        c.localGet(Y);
        c.i64DivS();
        this.small(c);
        c.return_();
        c.end();
      } else {
        c.localGet(X);
        c.localGet(Y);
        c.i64RemS();
        this.small(c);
        c.return_();
      }
      c.end();
      this.slow2(c, op === "div" ? "bn_div" : "bn_rem");
    });
  }

  /** 1 when the value is negative. */
  private isNeg(c: Code, local: number): void {
    this.isSmall(c, local);
    c.ifResult(I32);
    c.localGet(local);
    this.v(c);
    c.i64Const(0n);
    c.i64LtS();
    c.else_();
    c.localGet(local);
    c.structGet(this.bigType, MAG);
    c.i32Const(0);
    c.arrayGet(this.cc.ia);
    c.end();
  }

  /** The magnitude's bit length, as an i64. */
  private bitlen(c: Code, local: number): void {
    c.localGet(local);
    c.call(this.toIa());
    c.call(this.c("bn_bitlen"));
    c.i64ExtendI32U();
  }

  /** a ** b. */
  pow(): number {
    const B = this.bigRef();
    return this.def("pow", [B, B], [B], [I64, this.iaRef()], (c) => {
      const E = 2;
      this.isNeg(c, 1);
      c.ifVoid();
      // V8's message, measured: its template's operand is missing
      this.throwRange(c, "undefined must be positive");
      c.refNull(this.bigType);
      c.return_();
      c.end();
      // b == 0: 1n
      this.isSmall(c, 1);
      c.ifVoid();
      c.localGet(1);
      this.v(c);
      c.i64Eqz();
      c.ifVoid();
      c.i64Const(1n);
      this.small(c);
      c.return_();
      c.end();
      c.end();
      // a in {0, 1}: a; a == -1: by parity
      this.isSmall(c, 0);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.i64Const(1n);
      c.i64LeU(); // 0 or 1 (as unsigned)
      c.ifVoid();
      c.localGet(0);
      c.return_();
      c.end();
      c.localGet(0);
      this.v(c);
      c.i64Const(-1n);
      c.i64Eq();
      c.ifVoid();
      // parity of b: its lowest bit (fast form v, else limb 0)
      this.isSmall(c, 1);
      c.ifResult(I32);
      c.localGet(1);
      this.v(c);
      c.i32WrapI64();
      c.else_();
      c.localGet(1);
      c.structGet(this.bigType, MAG);
      c.i32Const(1);
      c.arrayGet(this.cc.ia);
      c.end();
      c.i32Const(1);
      c.i32And();
      c.ifResult(this.bigRef());
      c.localGet(0);
      c.else_();
      c.i64Const(1n);
      this.small(c);
      c.end();
      c.return_();
      c.end();
      c.end();
      // |a| >= 2: the exponent must keep the result under the size limit
      this.isSmall(c, 1);
      c.i32Eqz();
      c.ifVoid();
      this.throwRange(c, BIGINT_SIZE_MSG);
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(1);
      this.v(c);
      c.localTee(E);
      c.i64Const(MAX_BITS);
      c.i64GtU();
      c.ifVoid();
      this.throwRange(c, BIGINT_SIZE_MSG);
      c.refNull(this.bigType);
      c.return_();
      c.end();
      // V8's size limit (bigint-src.ts bn_pow_limited: exact for a
      // power-of-two base, an estimate within two bits otherwise —
      // SEMANTICS.md S137)
      c.localGet(0);
      c.call(this.toIa());
      c.localGet(E);
      c.i32WrapI64();
      c.call(this.c("bn_pow_limited"));
      c.localTee(3);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      this.throwRange(c, BIGINT_SIZE_MSG);
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(3);
      c.call(this.fromIa());
    });
  }

  /** a << b (left 1) and a >> b (left 0): a negative count shifts the
   * other way. */
  shift(left: boolean): number {
    const B = this.bigRef();
    return this.def(left ? "shl" : "sar", [B, B], [B], [I64, I32, I64], (c) => {
      const M = 2; // |b|
      const L = 3; // 1: shift left
      const R = 4;
      // the count's direction
      this.isNeg(c, 1);
      if (left) c.i32Eqz();
      c.localSet(L);
      // a huge count (heap, or past the size limit): 0 / -1 / 0 / RangeError
      this.isSmall(c, 1);
      c.ifResult(I32);
      c.localGet(1);
      this.v(c);
      c.localTee(M);
      c.i64Const(0n);
      c.i64LtS();
      c.ifVoid();
      c.i64Const(0n);
      c.localGet(M);
      c.i64Sub();
      c.localSet(M); // MIN stays negative: huge below
      c.end();
      c.localGet(M);
      c.i64Const(MAX_BITS);
      c.i64GtU();
      c.else_();
      c.i32Const(1);
      c.end();
      c.ifVoid();
      // huge: zero stays zero either way
      this.isSmall(c, 0);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.i64Eqz();
      c.ifVoid();
      c.localGet(0);
      c.return_();
      c.end();
      c.end();
      c.localGet(L);
      c.ifVoid();
      this.throwRange(c, BIGINT_SIZE_MSG);
      c.refNull(this.bigType);
      c.return_();
      c.end();
      this.isNeg(c, 0);
      c.ifResult(this.bigRef());
      c.i64Const(-1n);
      this.small(c);
      c.else_();
      c.i64Const(0n);
      this.small(c);
      c.end();
      c.return_();
      c.end();
      // |b| <= 2^30
      c.localGet(L);
      c.ifVoid();
      // fast: the shifted value round-trips
      this.isSmall(c, 0);
      c.localGet(M);
      c.i64Const(63n);
      c.i64LtU();
      c.i32And();
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.localGet(M);
      c.i64Shl();
      c.localTee(R);
      c.localGet(M);
      c.i64ShrS();
      c.localGet(0);
      this.v(c);
      c.i64Eq();
      c.ifVoid();
      c.localGet(R);
      this.small(c);
      c.return_();
      c.end();
      c.end();
      this.bitlen(c, 0);
      c.localGet(M);
      c.i64Add();
      c.i64Const(MAX_BITS);
      c.i64GtU();
      c.ifVoid();
      this.throwRange(c, BIGINT_SIZE_MSG);
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.toIa());
      c.localGet(M);
      c.i32WrapI64();
      c.call(this.c("bn_shl"));
      c.call(this.fromIa());
      c.return_();
      c.end();
      // right
      this.isSmall(c, 0);
      c.ifVoid();
      c.localGet(M);
      c.i64Const(63n);
      c.i64GtU();
      c.ifResult(I64);
      c.localGet(0);
      this.v(c);
      c.i64Const(63n);
      c.i64ShrS();
      c.else_();
      c.localGet(0);
      this.v(c);
      c.localGet(M);
      c.i64ShrS();
      c.end();
      this.small(c);
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.toIa());
      c.localGet(M);
      c.i32WrapI64();
      c.call(this.c("bn_sar"));
      c.call(this.fromIa());
    });
  }

  /** a & b (0), a | b (1), a ^ b (2). */
  bitop(op: 0 | 1 | 2): number {
    const B = this.bigRef();
    return this.def(`bitop${op}`, [B, B], [B], [], (c) => {
      this.bothSmall(c, 0, 1);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.localGet(1);
      this.v(c);
      if (op === 0) c.i64And();
      else if (op === 1) c.i64Or();
      else c.i64Xor();
      this.small(c);
      c.return_();
      c.end();
      this.slow2(c, "bn_bitop", (c2) => c2.i32Const(op));
    });
  }

  /** ~a. */
  not(): number {
    const B = this.bigRef();
    return this.def("not", [B], [B], [], (c) => {
      this.isSmall(c, 0);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.i64Const(-1n);
      c.i64Xor();
      this.small(c);
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.toIa());
      c.call(this.c("bn_not"));
      c.call(this.fromIa());
    });
  }

  /** -a. */
  neg(): number {
    const B = this.bigRef();
    return this.def("neg", [B], [B], [], (c) => {
      this.isSmall(c, 0);
      c.localGet(0);
      this.v(c);
      c.i64Const(MIN_I64);
      c.i64Ne();
      c.i32And();
      c.ifVoid();
      c.i64Const(0n);
      c.localGet(0);
      this.v(c);
      c.i64Sub();
      this.small(c);
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.toIa());
      c.call(this.c("bn_neg"));
      c.call(this.fromIa());
    });
  }

  /** a === b -> i32 (by value: the canonical form). */
  eq(): number {
    const B = this.bigRef();
    return this.def("eq", [B, B], [I32], [], (c) => {
      this.isSmall(c, 0);
      c.ifVoid();
      this.isSmall(c, 1);
      c.ifResult(I32);
      c.localGet(0);
      this.v(c);
      c.localGet(1);
      this.v(c);
      c.i64Eq();
      c.else_();
      c.i32Const(0);
      c.end();
      c.return_();
      c.end();
      this.isSmall(c, 1);
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(this.bigType, MAG);
      c.localGet(1);
      c.structGet(this.bigType, MAG);
      c.call(this.c("bn_eq"));
    });
  }

  /** The order of a against b -> i32 -1/0/1. */
  cmp(): number {
    const B = this.bigRef();
    return this.def("cmp", [B, B], [I32], [], (c) => {
      this.bothSmall(c, 0, 1);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.localGet(1);
      this.v(c);
      c.i64GtS();
      c.localGet(0);
      this.v(c);
      c.localGet(1);
      this.v(c);
      c.i64LtS();
      c.i32Sub();
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.toIa());
      c.localGet(1);
      c.call(this.toIa());
      c.call(this.c("bn_cmp"));
    });
  }

  /** The order of a against the double d -> i32 -1/0/1, or 2 when d is NaN
   * (every relation is false). */
  cmpF64(): number {
    const B = this.bigRef();
    return this.def("cmpF64", [B, F64], [I32], [F64], (c) => {
      const F = 2;
      c.localGet(1);
      c.localGet(1);
      c.f64Ne();
      c.ifVoid();
      c.i32Const(2);
      c.return_();
      c.end();
      // |v| <= 2^53 converts exactly: compare as doubles
      this.isSmall(c, 0);
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.i64Const(1n << 53n);
      c.i64Add();
      c.i64Const(1n << 54n);
      c.i64LeU();
      c.ifVoid();
      c.localGet(0);
      this.v(c);
      c.f64ConvertI64S();
      c.localTee(F);
      c.localGet(1);
      c.f64Gt();
      c.localGet(F);
      c.localGet(1);
      c.f64Lt();
      c.i32Sub();
      c.return_();
      c.end();
      c.end();
      c.localGet(0);
      c.call(this.toIa());
      c.localGet(1);
      c.call(this.c("bn_cmp_double"));
    });
  }

  /** Number(a): the nearest double, ties to even. */
  toF64(): number {
    const B = this.bigRef();
    return this.def("toF64", [B], [F64], [], (c) => {
      this.isSmall(c, 0);
      c.ifResult(F64);
      c.localGet(0);
      this.v(c);
      c.f64ConvertI64S();
      c.else_();
      c.localGet(0);
      c.structGet(this.bigType, MAG);
      c.call(this.c("bn_to_double"));
      c.end();
    });
  }

  /** BigInt(number): RangeError for a non-integer (NaN and the infinities
   * included). */
  fromF64(): number {
    const B = this.bigRef();
    return this.def("fromF64", [F64], [B], [], (c) => {
      c.localGet(0);
      c.localGet(0);
      c.f64Trunc();
      c.f64Sub();
      c.f64Const(0);
      c.f64Ne();
      c.ifVoid();
      this.deps.throwError(c, "%RangeError", "RangeError", (c2) => {
        this.deps.lit(c2, "The number ");
        c2.localGet(0);
        c2.call(this.deps.f64ToStr());
        c2.call(this.deps.concat());
        this.deps.lit(c2, " cannot be converted to a BigInt because it is not an integer");
        c2.call(this.deps.concat());
      });
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(0);
      c.f64Abs();
      c.f64Const(2 ** 63);
      c.f64Lt();
      c.ifResult(this.bigRef());
      c.localGet(0);
      c.i64TruncF64S();
      this.small(c);
      c.else_();
      c.localGet(0);
      c.call(this.c("bn_from_double"));
      c.call(this.fromIa());
      c.end();
    });
  }

  /** (string) -> ia of its code units. */
  private strToIa(): number {
    return this.def("strToIa", [this.deps.strRef()], [this.iaRef()], [I32, this.iaRef()], (c) => {
      const N = 1;
      const A = 2;
      const I = 1; // reuse: counts down
      c.localGet(0);
      c.arrayLen();
      c.localTee(N);
      c.arrayNewDefault(this.cc.ia);
      c.localSet(A);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.localGet(A);
      c.localGet(I);
      c.localGet(0);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.arraySet(this.cc.ia);
      c.br(0);
      c.end();
      c.end();
      c.localGet(A);
    });
  }

  /** (ia of character codes) -> string. */
  private iaToStr(): number {
    const S = this.deps.strRef();
    return this.def("iaToStr", [this.iaRef()], [S], [I32, S], (c) => {
      const I = 1;
      const R = 2;
      c.localGet(0);
      c.arrayLen();
      c.localTee(I);
      c.arrayNewDefault(this.deps.strType());
      c.localSet(R);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.localGet(R);
      c.localGet(I);
      c.localGet(0);
      c.localGet(I);
      c.arrayGet(this.cc.ia);
      c.arraySet(this.deps.strType());
      c.br(0);
      c.end();
      c.end();
      c.localGet(R);
    });
  }

  /** BigInt(string): StringToBigInt, SyntaxError when it is not one. */
  fromStr(): number {
    const S = this.deps.strRef();
    return this.def("fromStr", [S], [this.bigRef()], [this.iaRef()], (c) => {
      const R = 1;
      c.localGet(0);
      c.call(this.strToIa());
      c.localGet(0);
      c.arrayLen();
      c.call(this.c("bn_parse"));
      c.localTee(R);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      this.deps.throwError(c, "%SyntaxError", "SyntaxError", (c2) => {
        this.deps.lit(c2, "Cannot convert ");
        c2.localGet(0);
        c2.call(this.deps.concat());
        this.deps.lit(c2, " to a BigInt");
        c2.call(this.deps.concat());
      });
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(R);
      c.call(this.fromIa());
    });
  }

  /** a.toString(radix) for an i32 radix already in [2, 36]; `group` gives
   * toLocaleString's en-US grouping (radix 10). */
  toStr(group = false): number {
    const S = this.deps.strRef();
    return this.def(group ? "toLocale" : "toStr", group ? [this.bigRef()] : [this.bigRef(), I32], [S], [], (c) => {
      c.localGet(0);
      c.call(this.toIa());
      if (group) c.i32Const(10);
      else c.localGet(1);
      c.i32Const(group ? 44 : 0);
      c.call(this.c("bn_digits"));
      c.call(this.iaToStr());
    });
  }

  /** (big) -> decimal string. */
  toStr10(): number {
    const S = this.deps.strRef();
    return this.def("toStr10", [this.bigRef()], [S], [], (c) => {
      c.localGet(0);
      c.i32Const(10);
      c.call(this.toStr());
    });
  }

  /** (big) -> inspect's `123n`. */
  inspect(): number {
    const S = this.deps.strRef();
    return this.def("inspect", [this.bigRef()], [S], [], (c) => {
      c.localGet(0);
      c.call(this.toStr10());
      this.deps.lit(c, "n");
      c.call(this.deps.concat());
    });
  }

  /** a.toString(radix) for a number radix: ToIntegerOrInfinity, then the
   * RangeError outside [2, 36]. */
  toStrRadix(): number {
    const S = this.deps.strRef();
    return this.def("toStrRadix", [this.bigRef(), F64], [S], [F64], (c) => {
      const R = 2;
      c.localGet(1);
      c.f64Trunc();
      c.localTee(R);
      c.localGet(R);
      c.f64Eq(); // NaN -> 0 below
      c.ifResult(F64);
      c.localGet(R);
      c.else_();
      c.f64Const(0);
      c.end();
      c.localTee(R);
      c.f64Const(2);
      c.f64Lt();
      c.localGet(R);
      c.f64Const(36);
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      this.throwRange(c, "toString() radix argument must be between 2 and 36");
      c.refNull(this.deps.strType());
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(R);
      c.i32TruncF64S();
      c.call(this.toStr());
    });
  }

  /** BigInt.asIntN(bits, a) (sgn 1) / BigInt.asUintN(bits, a) (sgn 0), with
   * ToIndex(bits)'s RangeError. */
  asN(sgn: 0 | 1): number {
    const B = this.bigRef();
    return this.def(sgn ? "asIntN" : "asUintN", [F64, B], [B], [F64], (c) => {
      const D = 2;
      c.localGet(0);
      c.f64Trunc();
      c.localTee(D);
      c.localGet(D);
      c.f64Eq();
      c.ifResult(F64);
      c.localGet(D);
      c.else_();
      c.f64Const(0);
      c.end();
      c.localTee(D);
      c.f64Const(0);
      c.f64Lt();
      c.localGet(D);
      c.f64Const(2 ** 53 - 1);
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      this.throwRange(c, "Invalid value: not (convertible to) a safe integer");
      c.refNull(this.bigType);
      c.return_();
      c.end();
      c.localGet(D);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.i64Const(0n);
      this.small(c);
      c.return_();
      c.end();
      // past the size limit: a itself, or (asUintN of a negative) too big
      c.localGet(D);
      c.f64Const(Number(MAX_BITS));
      c.f64Gt();
      c.ifVoid();
      if (sgn === 0) {
        this.isNeg(c, 1);
        c.ifVoid();
        this.throwRange(c, BIGINT_SIZE_MSG);
        c.refNull(this.bigType);
        c.return_();
        c.end();
      }
      c.localGet(1);
      c.return_();
      c.end();
      // asIntN(64, small) and asUintN(64, small >= 0) are the value itself
      this.isSmall(c, 1);
      c.localGet(D);
      c.f64Const(64);
      c.f64Eq();
      c.i32And();
      if (sgn === 0) {
        c.localGet(1);
        this.v(c);
        c.i64Const(0n);
        c.i64GeS();
        c.i32And();
      }
      c.ifVoid();
      c.localGet(1);
      c.return_();
      c.end();
      c.localGet(1);
      c.call(this.toIa());
      c.localGet(D);
      c.i32TruncF64U();
      c.i32Const(sgn);
      c.call(this.c("bn_asn"));
      c.call(this.fromIa());
    });
  }

  /** (i64 bits) -> the value: signed (readBigInt64) or unsigned. */
  fromBits(signed: boolean): number {
    return this.def(signed ? "fromBitsS" : "fromBitsU", [I64], [this.bigRef()], [], (c) => {
      if (!signed) {
        c.localGet(0);
        c.i64Const(0n);
        c.i64LtS();
        c.ifVoid();
        c.localGet(0);
        c.call(this.c("bn_from_ubits"));
        c.call(this.fromIa());
        c.return_();
        c.end();
      }
      c.localGet(0);
      this.small(c);
    });
  }

  /** (big) -> its low 64 bits: DataView's setBig(U)int64 (ToBigInt64 /
   * ToBigUint64 wrap, one bit pattern either way). */
  toBitsWrap(): number {
    return this.def("toBitsWrap", [this.bigRef()], [I64], [], (c) => {
      this.isSmall(c, 0);
      c.ifResult(I64);
      c.localGet(0);
      this.v(c);
      c.else_();
      c.localGet(0);
      c.structGet(this.bigType, MAG);
      c.call(this.c("bn_to_bits"));
      c.end();
    });
  }

  /** (big) -> its 64 bits, after Node's checkInt for writeBig(U)Int64:
   * ERR_OUT_OF_RANGE outside [0, 2^64) (unsigned) / [-2^63, 2^63). */
  toBitsChecked(signed: boolean): number {
    return this.def(signed ? "toBitsCheckedS" : "toBitsCheckedU", [this.bigRef()], [I64], [], (c) => {
      // in range?
      if (signed) {
        this.isSmall(c, 0);
      } else {
        // small and >= 0, or heap, positive, two limbs
        this.isSmall(c, 0);
        c.ifResult(I32);
        c.localGet(0);
        this.v(c);
        c.i64Const(0n);
        c.i64GeS();
        c.else_();
        c.localGet(0);
        c.structGet(this.bigType, MAG);
        c.arrayLen();
        c.i32Const(3);
        c.i32Eq();
        c.localGet(0);
        c.structGet(this.bigType, MAG);
        c.i32Const(0);
        c.arrayGet(this.cc.ia);
        c.i32Eqz();
        c.i32And();
        c.end();
      }
      c.ifVoid();
      c.localGet(0);
      c.call(this.toBitsWrap());
      c.return_();
      c.end();
      this.deps.throwError(c, "%RangeError", "RangeError", (c2) => {
        this.deps.lit(c2, `The value of "value" is out of range. It must be ${signed ? ">= -(2n ** 63n) and < 2n ** 63n" : ">= 0n and < 2n ** 64n"}. Received `);
        c2.localGet(0);
        c2.call(this.received());
        c2.call(this.deps.concat());
      }, "ERR_OUT_OF_RANGE");
      c.i64Const(0n);
    });
  }

  /** ERR_OUT_OF_RANGE's `Received` text for a bigint: its decimal digits,
   * grouped by "_" (addNumericalSeparator) past +-2^32, then "n". */
  private received(): number {
    const S = this.deps.strRef();
    return this.def("received", [this.bigRef()], [S], [], (c) => {
      c.localGet(0);
      c.call(this.toIa());
      c.i32Const(10);
      // |v| > 2^32: grouped
      this.isSmall(c, 0);
      c.ifResult(I32);
      c.localGet(0);
      this.v(c);
      c.i64Const(1n << 32n);
      c.i64GtS();
      c.localGet(0);
      this.v(c);
      c.i64Const(-(1n << 32n));
      c.i64LtS();
      c.i32Or();
      c.else_();
      c.i32Const(1);
      c.end();
      c.ifResult(I32);
      c.i32Const(95);
      c.else_();
      c.i32Const(0);
      c.end();
      c.call(this.c("bn_digits"));
      c.call(this.iaToStr());
      this.deps.lit(c, "n");
      c.call(this.deps.concat());
    });
  }

  /** ToBoolean: not 0n. */
  truthy(): number {
    return this.def("truthy", [this.bigRef()], [I32], [], (c) => {
      this.isSmall(c, 0);
      c.ifResult(I32);
      c.localGet(0);
      this.v(c);
      c.i64Const(0n);
      c.i64Ne();
      c.else_();
      c.i32Const(1);
      c.end();
    });
  }

  /** A hash of the value (equal values hash equal: the canonical form). */
  hash(): number {
    return this.def("hash", [this.bigRef()], [I32], [], (c) => {
      this.isSmall(c, 0);
      c.ifResult(I32);
      c.localGet(0);
      this.v(c);
      c.localGet(0);
      this.v(c);
      c.i64Const(32n);
      c.i64ShrU();
      c.i64Xor();
      c.i32WrapI64();
      c.i32Const(0x9e3779b1 | 0);
      c.i32Mul();
      c.else_();
      c.localGet(0);
      c.structGet(this.bigType, MAG);
      c.call(this.c("bn_hash"));
      c.end();
    });
  }
}
