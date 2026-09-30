/* `**`'s general-exponent core, as Node computes it on Linux x86-64 with the GNU C
 * Library 2.43's FMA build of `pow` (SEMANTICS.md S079).
 *
 * A transcription of ARM optimized-routines
 * (https://github.com/ARM-software/optimized-routines, commit
 * 375f32ed2f7098090f41795ad363822752a25a65): math/pow.c, math/pow_common.h and
 * math/math_config.h, with the tables of math/pow_log_data.c and math/exp_data.c
 * (pow-tables.ts) -- the upstream of the GNU C Library's pow. It follows the fma
 * code path (HAVE_FAST_FMA), and the x86-64 rounding path of exp (TOINT_INTRINSICS
 * off: kd = z + Shift, ki = its bits, kd -= Shift). Every a*b+c that glibc 2.43's
 * x86-64 FMA build of pow fuses (21 sites: the source's three explicit fma calls and
 * eighteen its compiler contracted) is computed by an EXACT software fused
 * multiply-add, and the four a*b+c it leaves unfused are a product then a sum; the
 * site list below names each one. WebAssembly has no fma instruction (relaxed-simd's
 * madd is not deterministic), so the exact fma is built from IEEE-754 double
 * operations: an exact two-product (Veltkamp split, Dekker), an exact TwoSum, a
 * round-to-odd sum of the two low parts, and one final round-to-nearest sum
 * (Boldo and Melquiond, "Emulation of FMA and correctly rounded sums: proved
 * algorithms using rounding to odd", IEEE Transactions on Computers 57(4), 2008).
 * Its preconditions -- |a|, |b| < 2^995, and a*b zero or at least 2^-969 in
 * magnitude -- hold at every site of this core by construction.
 *
 * The same specification is transcribed twice here: once as WebAssembly
 * (buildPowCore, the run-time core behind %w.jsPow), once as TypeScript
 * (jsPowValue, the value tryFoldFloatConst folds a literal-literal `**` to). Both
 * read the one table module and the one SITE list; the TypeScript uses only
 * IEEE-754 binary64 + - * / and a correctly rounded Math.sqrt, so a folded value
 * equals the run-time value on every engine the compiler runs on and never
 * depends on the compiling host's own pow.
 *
 * Upstream notice (math/pow.c):
 *   Copyright (c) 2018-2026, Arm Limited.
 *   SPDX-License-Identifier: MIT OR Apache-2.0 WITH LLVM-exception
 */

import { Code } from "./code.js";
import { F64, I32, I64, ModuleBuilder, type ValType } from "./module.js";
import {
  EXP_INVLN2N,
  EXP_NEGLN2HIN,
  EXP_NEGLN2LON,
  EXP_POLY,
  EXP_SHIFT,
  EXP_TAB,
  POW_LOG_LN2HI,
  POW_LOG_LN2LO,
  POW_LOG_POLY,
  POW_LOG_TAB,
} from "./pow-tables.js";

/** The a*b+c sites of the core, numbered in source order. F01-F21 are fused in
 * glibc 2.43's x86-64 FMA build of pow (each an exact software fma here); N01-N04
 * are left unfused there (a rounded product, then a sum). Both transcriptions
 * below name every site by this list, exactly once each. */
export const SITE = {
  F01: 1, // log: r = fma(z, invc, -1)
  F02: 2, // log: t1 = kd*Ln2hi + logc
  F03: 3, // log: lo1 = kd*Ln2lo + logctail
  F04: 4, // log: lo3 = fma(ar, r, -ar2)
  F05: 5, // log: A[1] + r*A[2]
  F06: 6, // log: A[3] + r*A[4]
  F07: 7, // log: A[5] + r*A[6]
  F08: 8, // log: (A[3] + r*A[4]) + ar2*(A[5] + r*A[6])
  F09: 9, // log: (A[1] + r*A[2]) + ar2*(F08)
  F10: 10, // log: lo = lo1 + lo2 + lo3 + lo4 + ar3*(F09), fused into the last addition
  F11: 11, // pow: fma(y, hi, -ehi)
  F12: 12, // pow: elo = y*lo + F11
  F13: 13, // exp: kd = InvLn2N*x + Shift
  F14: 14, // exp: x + kd*NegLn2hiN
  F15: 15, // exp: r = F14 + kd*NegLn2loN
  F16: 16, // exp: C2 + r*C3
  F17: 17, // exp: C4 + r*C5
  F18: 18, // exp: (tail + r) + r2*F16
  F19: 19, // exp: tmp = F18 + (r2*r2)*F17
  F20: 20, // exp: scale + scale*tmp
  F21: 21, // specialcase, k > 0: scale + scale*tmp
  N01: 101, // log: hi = t2 + ar2 (ar2 = r*ar)
  N02: 102, // log: lo4 = t2 - hi + ar2
  N03: 103, // specialcase, k < 0: y = scale + scale*tmp
  N04: 104, // specialcase, k < 0: lo = scale - y + scale*tmp
} as const;

const SPLIT = 134217729; // 2^27 + 1, the Veltkamp split constant
const OFF = 0x3fe6955500000000n;
const M64 = 0xffffffffffffffffn;
const ONE_BITS = 0x3ff0000000000000n;
const INF_BITS2 = 0xffe0000000000000n; // 2 * the bits of +Infinity (mod 2^64)
const SIGN_BIAS = 0x40000; // 0x800 << EXP_TABLE_BITS

/** The TypeScript core, built once on first use (its typed-array scratch lives in
 * the closure makeCore returns, not at module scope). */
const cache: { core: ((x: number, y: number) => number) | null } = { core: null };

function makeCore(): (x: number, y: number) => number {
  const F = new Float64Array(1);
  const U = new BigUint64Array(F.buffer);
  const asd = (u: bigint): number => {
    U[0] = u;
    return F[0]!;
  };
  const asu = (d: number): bigint => {
    F[0] = d;
    return U[0]!;
  };
  /** 2^e for a normal-range e, from its bits. */
  const p2 = (e: number): number => asd(BigInt(e + 1023) << 52n);
  const TWO769 = p2(769);
  const TWOM767 = p2(-767);
  const TWO1009 = p2(1009);
  const TWOM1022 = p2(-1022);
  const TWO52 = p2(52);
  const LN2HI = asd(POW_LOG_LN2HI);
  const LN2LO = asd(POW_LOG_LN2LO);
  const A = POW_LOG_POLY.map(asd);
  const TAB = POW_LOG_TAB.map(asd);
  const INVLN2N = asd(EXP_INVLN2N);
  const NEGLN2HIN = asd(EXP_NEGLN2HIN);
  const NEGLN2LON = asd(EXP_NEGLN2LON);
  const SHIFT = asd(EXP_SHIFT);
  const C = EXP_POLY.map(asd);

  /** The exact fused multiply-add (see the file header). */
  const fma = (a: number, b: number, c: number): number => {
    const p = a * b;
    if (p === 0) return p + c; // a or b is zero: the sum is exact, signed zeros included
    const ta = SPLIT * a;
    const ah = ta - (ta - a);
    const al = a - ah;
    const tb = SPLIT * b;
    const bh = tb - (tb - b);
    const bl = b - bh;
    const pl = al * bl - (((p - ah * bh) - al * bh) - ah * bl);
    const th = c + p;
    const bb = th - c;
    const tl = (c - (th - bb)) + (p - bb);
    let s = tl + pl;
    const sb = s - tl;
    const e = (tl - (s - sb)) + (pl - sb);
    if (e !== 0) {
      let u = asu(s);
      if ((u & 1n) === 0n) {
        u = (e > 0) === (s > 0) ? u + 1n : u - 1n;
        s = asd(u);
      }
    }
    return th + s;
  };
  /** A site glibc's FMA build fuses. */
  const fmaAt = (_site: number, a: number, b: number, c: number): number => fma(a, b, c);
  /** A site glibc's FMA build leaves unfused: the rounded product, then the sum. */
  const mulAdd = (_site: number, a: number, b: number, c: number): number => a * b + c;

  const oflow = (neg: boolean): number => (neg ? -TWO769 : TWO769) * TWO769;
  const uflow = (neg: boolean): number => (neg ? -TWOM767 : TWOM767) * TWOM767;
  /** 0: not an integer, 1: odd, 2: even; iy is a nonzero finite double's bits. */
  const checkint = (iy: bigint): number => {
    const e = Number((iy >> 52n) & 0x7ffn);
    if (e < 0x3ff) return 0;
    if (e > 0x3ff + 52) return 2;
    const sh = BigInt(0x3ff + 52 - e);
    if ((iy & ((1n << sh) - 1n)) !== 0n) return 0;
    if ((iy & (1n << sh)) !== 0n) return 1;
    return 2;
  };
  const zeroinfnan = (i: bigint): boolean => ((2n * i - 1n) & M64) >= ((INF_BITS2 - 1n) & M64);
  const top12 = (d: number): number => Number(asu(d) >> 52n);

  return (x: number, y: number): number => {
    let signBias = 0;
    let ix = asu(x);
    const iy = asu(y);
    let topx = top12(x);
    const topy = top12(y);
    if (((topx - 0x001) >>> 0) >= 0x7ff - 0x001 || (((topy & 0x7ff) - 0x3be) >>> 0) >= 0x43e - 0x3be) {
      if (zeroinfnan(iy)) {
        if (((2n * iy) & M64) === 0n) return 1.0;
        if (ix === ONE_BITS) return 1.0;
        if (((2n * ix) & M64) > INF_BITS2 || ((2n * iy) & M64) > INF_BITS2) return x + y;
        if (((2n * ix) & M64) === 2n * ONE_BITS) return 1.0;
        if ((((2n * ix) & M64) < 2n * ONE_BITS) === (iy >> 63n === 0n)) return 0.0;
        return y * y;
      }
      if (zeroinfnan(ix)) {
        let x2 = x * x;
        if (ix >> 63n !== 0n && checkint(iy) === 1) x2 = -x2;
        return iy >> 63n !== 0n ? 1 / x2 : x2;
      }
      if (ix >> 63n !== 0n) {
        const yint = checkint(iy);
        if (yint === 0) return (x - x) / (x - x);
        if (yint === 1) signBias = SIGN_BIAS;
        ix &= 0x7fffffffffffffffn;
        topx &= 0x7ff;
      }
      if ((((topy & 0x7ff) - 0x3be) >>> 0) >= 0x43e - 0x3be) {
        if (ix === ONE_BITS) return 1.0;
        if ((topy & 0x7ff) < 0x3be) return ix > ONE_BITS ? 1.0 + y : 1.0 - y;
        return (ix > ONE_BITS) === (topy < 0x800) ? oflow(false) : uflow(false);
      }
      if (topx === 0) {
        ix = asu(x * TWO52) & 0x7fffffffffffffffn;
        ix = (ix - (52n << 52n)) & M64;
      }
    }
    // log_inline: ly + ltail = log(|x|)
    const tmp = (ix - OFF) & M64;
    const i = Number((tmp >> 45n) & 127n);
    const kd = Number(BigInt.asIntN(64, tmp) >> 52n);
    const iz = (ix - (tmp & (0xfffn << 52n))) & M64;
    const z = asd(iz);
    const invc = TAB[3 * i]!;
    const logc = TAB[3 * i + 1]!;
    const logctail = TAB[3 * i + 2]!;
    const r = fmaAt(SITE.F01, z, invc, -1.0);
    const t1 = fmaAt(SITE.F02, kd, LN2HI, logc);
    const t2 = t1 + r;
    const lo1 = fmaAt(SITE.F03, kd, LN2LO, logctail);
    const lo2 = t1 - t2 + r;
    const ar = A[0]! * r;
    const ar2 = r * ar;
    const ar3 = r * ar2;
    const hi = mulAdd(SITE.N01, r, ar, t2);
    const lo3 = fmaAt(SITE.F04, ar, r, -ar2);
    const lo4 = mulAdd(SITE.N02, r, ar, t2 - hi);
    const q12 = fmaAt(SITE.F05, r, A[2]!, A[1]!);
    const q34 = fmaAt(SITE.F06, r, A[4]!, A[3]!);
    const q56 = fmaAt(SITE.F07, r, A[6]!, A[5]!);
    const q36 = fmaAt(SITE.F08, ar2, q56, q34);
    const q = fmaAt(SITE.F09, ar2, q36, q12);
    let sum = lo1 + lo2;
    sum = sum + lo3;
    sum = sum + lo4;
    const lo = fmaAt(SITE.F10, ar3, q, sum);
    const ly = hi + lo;
    const ltail = hi - ly + lo;
    // exp_inline(ehi, elo, signBias)
    const ehi = y * ly;
    let abstop = top12(ehi) & 0x7ff;
    if (((abstop - 0x3c9) >>> 0) >= 0x408 - 0x3c9) {
      if (((abstop - 0x3c9) >>> 0) >= 0x80000000) {
        const one = 1.0 + ehi;
        return signBias !== 0 ? -one : one;
      }
      if (abstop >= 0x409) return asu(ehi) >> 63n !== 0n ? uflow(signBias !== 0) : oflow(signBias !== 0);
      abstop = 0;
    }
    const xtail = fmaAt(SITE.F12, y, ltail, fmaAt(SITE.F11, y, ly, -ehi));
    const zk = fmaAt(SITE.F13, INVLN2N, ehi, SHIFT);
    const ki = asu(zk);
    const kd2 = zk - SHIFT;
    const rr = fmaAt(SITE.F14, kd2, NEGLN2HIN, ehi);
    let er = fmaAt(SITE.F15, kd2, NEGLN2LON, rr);
    er = er + xtail;
    const idx = Number(2n * (ki & 127n));
    const top = ((ki + BigInt(signBias)) << 45n) & M64;
    const tail = asd(EXP_TAB[idx]!);
    let sbits = (EXP_TAB[idx + 1]! + top) & M64;
    const r2 = er * er;
    const c23 = fmaAt(SITE.F16, er, C[1]!, C[0]!);
    const c45 = fmaAt(SITE.F17, er, C[3]!, C[2]!);
    const t = fmaAt(SITE.F18, r2, c23, tail + er);
    const r4 = r2 * r2;
    const etmp = fmaAt(SITE.F19, r4, c45, t);
    if (abstop === 0) {
      // specialcase(etmp, sbits, ki)
      if ((ki & 0x80000000n) === 0n) {
        const sc = asd((sbits - (1009n << 52n)) & M64);
        const yk = fmaAt(SITE.F21, sc, etmp, sc);
        return yk * TWO1009;
      }
      sbits = (sbits + (1022n << 52n)) & M64;
      const sc = asd(sbits);
      let yk = mulAdd(SITE.N03, sc, etmp, sc);
      if (Math.abs(yk) < 1.0) {
        const one = yk < 0.0 ? -1.0 : 1.0;
        let lok = mulAdd(SITE.N04, sc, etmp, sc - yk);
        const hik = one + yk;
        lok = one - hik + yk + lok;
        yk = hik + lok - one;
        if (yk === 0) yk = asd(sbits & 0x8000000000000000n);
      }
      return TWOM1022 * yk;
    }
    const scale = asd(sbits);
    return fmaAt(SITE.F20, scale, etmp, scale);
  };
}

/** glibc's pow on every operand pair (the core the helper's last arm reaches). */
export function powCoreValue(x: number, y: number): number {
  if (cache.core === null) cache.core = makeCore();
  return cache.core(x, y);
}

/** Is v an odd integer? The helper's pushIsOddInteger: 0 for a non-finite v. */
function isOddInteger(v: number): boolean {
  if (v - v !== 0) return false;
  const t = Math.trunc(v);
  if (t !== v) return false;
  return t - Math.trunc(t / 2) * 2 !== 0;
}

/** `x ** y` exactly as %w.jsPow computes it, arm for arm (emitter.ts,
 * jsPowHelper): the ECMA-262 ladder, V8's y === 2 and y === 0.5 pre-cases, then
 * the core. A NaN result's payload is not modelled (the fold substitutes the
 * canonical NaN, S036). */
export function jsPowValue(x: number, y: number): number {
  if (y !== y) return NaN;
  if (y === 0) return 1;
  if (x !== x) return NaN;
  if (x === Infinity) return y > 0 ? Infinity : 0;
  if (y === Infinity) {
    const ax = Math.abs(x);
    return ax > 1 ? Infinity : ax < 1 ? 0 : NaN;
  }
  if (y === -Infinity) {
    const ax = Math.abs(x);
    return ax > 1 ? 0 : ax < 1 ? Infinity : NaN;
  }
  if (x === -Infinity) {
    if (y > 0) return isOddInteger(y) ? -Infinity : Infinity;
    return isOddInteger(y) ? -0 : 0;
  }
  if (x === 0) {
    if (1 / x === -Infinity) {
      if (y > 0) return isOddInteger(y) ? -0 : 0;
      return isOddInteger(y) ? -Infinity : Infinity;
    }
    return y > 0 ? 0 : Infinity;
  }
  if (x < 0 && Math.trunc(y) !== y) return NaN;
  if (y === 2) return x * x;
  if (y === 0.5) return Math.sqrt(x + 0);
  return powCoreValue(x, y);
}

/** The table bytes for a passive data segment: each u64 little-endian. */
function tableBytes(entries: readonly bigint[]): Uint8Array {
  const bytes = new Uint8Array(entries.length * 8);
  entries.forEach((v, i) => {
    for (let b = 0; b < 8; b++) bytes[i * 8 + b] = Number((v >> BigInt(b * 8)) & 0xffn);
  });
  return bytes;
}

/** A double from its bits, for an f64.const immediate. */
function f64Of(bits: bigint): number {
  const f = new Float64Array(1);
  new BigUint64Array(f.buffer)[0] = bits;
  return f[0]!;
}

/** Declares %w.fmaExact and %w.powCore in `mb` and returns %w.powCore's index:
 * (x: f64, y: f64) -> f64, glibc's pow on every operand pair. Call at most once
 * per module (the emitter caches the index). */
export function buildPowCore(mb: ModuleBuilder): number {
  const i64Arr = mb.arrayType(I64, false);
  const tabRef: ValType = { kind: "ref", nullable: true, typeIndex: i64Arr };
  const logOffset = mb.internData(tableBytes(POW_LOG_TAB));
  const expOffset = mb.internData(tableBytes(EXP_TAB));
  const gLog = mb.addGlobal(tabRef, true, (w) => {
    w.u8(0xd0);
    w.sleb(i64Arr);
  });
  const gExp = mb.addGlobal(tabRef, true, (w) => {
    w.u8(0xd0);
    w.sleb(i64Arr);
  });

  // ── %w.fmaExact(a, b, c) → f64: the exact fused multiply-add ─────────────
  const fmaFn = mb.declareFunc(mb.funcType([F64, F64, F64], [F64]), "%w.fmaExact");
  {
    const c = new Code();
    const A = 0, B = 1, CC = 2;
    const P = 3, TA = 4, AH = 5, AL = 6, TB = 7, BH = 8, BL = 9, PL = 10, TH = 11, BB = 12, TL = 13, S = 14, SB = 15, E = 16;
    const U = 17; // i64
    // p = a*b; a zero product returns p + c
    c.localGet(A);
    c.localGet(B);
    c.f64Mul();
    c.localTee(P);
    c.f64Const(0);
    c.f64Eq();
    c.ifVoid();
    c.localGet(P);
    c.localGet(CC);
    c.f64Add();
    c.return_();
    c.end();
    // Veltkamp split of a and b
    c.f64Const(SPLIT);
    c.localGet(A);
    c.f64Mul();
    c.localSet(TA);
    c.localGet(TA);
    c.localGet(TA);
    c.localGet(A);
    c.f64Sub();
    c.f64Sub();
    c.localSet(AH);
    c.localGet(A);
    c.localGet(AH);
    c.f64Sub();
    c.localSet(AL);
    c.f64Const(SPLIT);
    c.localGet(B);
    c.f64Mul();
    c.localSet(TB);
    c.localGet(TB);
    c.localGet(TB);
    c.localGet(B);
    c.f64Sub();
    c.f64Sub();
    c.localSet(BH);
    c.localGet(B);
    c.localGet(BH);
    c.f64Sub();
    c.localSet(BL);
    // pl = al*bl - (((p - ah*bh) - al*bh) - ah*bl)
    c.localGet(AL);
    c.localGet(BL);
    c.f64Mul();
    c.localGet(P);
    c.localGet(AH);
    c.localGet(BH);
    c.f64Mul();
    c.f64Sub();
    c.localGet(AL);
    c.localGet(BH);
    c.f64Mul();
    c.f64Sub();
    c.localGet(AH);
    c.localGet(BL);
    c.f64Mul();
    c.f64Sub();
    c.f64Sub();
    c.localSet(PL);
    // TwoSum(c, p): th + tl
    c.localGet(CC);
    c.localGet(P);
    c.f64Add();
    c.localTee(TH);
    c.localGet(CC);
    c.f64Sub();
    c.localSet(BB);
    c.localGet(CC);
    c.localGet(TH);
    c.localGet(BB);
    c.f64Sub();
    c.f64Sub();
    c.localGet(P);
    c.localGet(BB);
    c.f64Sub();
    c.f64Add();
    c.localSet(TL);
    // s = RO(tl + pl): TwoSum, then step to the odd neighbour when inexact and even
    c.localGet(TL);
    c.localGet(PL);
    c.f64Add();
    c.localTee(S);
    c.localGet(TL);
    c.f64Sub();
    c.localSet(SB);
    c.localGet(TL);
    c.localGet(S);
    c.localGet(SB);
    c.f64Sub();
    c.f64Sub();
    c.localGet(PL);
    c.localGet(SB);
    c.f64Sub();
    c.f64Add();
    c.localTee(E);
    c.f64Const(0);
    c.f64Ne();
    c.ifVoid();
    {
      c.localGet(S);
      c.i64ReinterpretF64();
      c.localTee(U);
      c.i64Const(1n);
      c.i64And();
      c.i64Eqz();
      c.ifVoid();
      {
        // one step away from zero when e and s share a sign, else toward it
        c.localGet(U);
        c.localGet(E);
        c.f64Const(0);
        c.f64Gt();
        c.localGet(S);
        c.f64Const(0);
        c.f64Gt();
        c.i32Eq();
        c.ifResult(I64);
        c.i64Const(1n);
        c.else_();
        c.i64Const(-1n);
        c.end();
        c.i64Add();
        c.f64ReinterpretI64();
        c.localSet(S);
      }
      c.end();
    }
    c.end();
    // th + s
    c.localGet(TH);
    c.localGet(S);
    c.f64Add();
    mb.setBody(fmaFn, [F64, F64, F64, F64, F64, F64, F64, F64, F64, F64, F64, F64, F64, F64, I64], c.bytes());
  }

  // ── %w.powCore(x, y) → f64 ───────────────────────────────────────────────
  const coreFn = mb.declareFunc(mb.funcType([F64, F64], [F64]), "%w.powCore");
  const c = new Code();
  const locals: ValType[] = [];
  const X = 0, Y = 1;
  const local = (t: ValType): number => {
    locals.push(t);
    return 1 + locals.length;
  };
  const IX = local(I64), IY = local(I64), TMP = local(I64), IZ = local(I64), KI = local(I64), SBITS = local(I64);
  const TOPX = local(I32), TOPY = local(I32), SIGNB = local(I32), YINT = local(I32), IDX = local(I32), ABSTOP = local(I32), E = local(I32);
  const Z = local(F64), KD = local(F64), INVC = local(F64), LOGC = local(F64), LOGCTAIL = local(F64), R = local(F64);
  const T1 = local(F64), T2 = local(F64), LO1 = local(F64), LO2 = local(F64), AR = local(F64), AR2 = local(F64), AR3 = local(F64);
  const HI = local(F64), LO3 = local(F64), LO4 = local(F64), Q12 = local(F64), Q34 = local(F64), Q56 = local(F64), Q36 = local(F64);
  const Q = local(F64), SUM = local(F64), LO = local(F64), LY = local(F64), LTAIL = local(F64), EHI = local(F64), XTAIL = local(F64);
  const ZK = local(F64), KD2 = local(F64), RR = local(F64), ER = local(F64), R2 = local(F64), TAIL = local(F64), C23 = local(F64);
  const C45 = local(F64), T = local(F64), R4 = local(F64), ETMP = local(F64), SC = local(F64), YK = local(F64), ONE = local(F64);
  const LOK = local(F64), HIK = local(F64), X2 = local(F64);
  /** An i64.const from a u64 bit pattern (the encoder takes the signed range). */
  const i64k = (v: bigint): void => c.i64Const(BigInt.asIntN(64, v));
  const get = (l: number) => (): void => c.localGet(l);
  const k = (v: number) => (): void => c.f64Const(v);
  /** A site glibc's FMA build fuses: push a, b, c; call the exact fma. */
  const emitFmaAt = (_site: number, a: () => void, b: () => void, cc: () => void): void => {
    a();
    b();
    cc();
    c.call(fmaFn);
  };
  /** A site glibc's FMA build leaves unfused: a*b rounded, then + c. */
  const emitMulAdd = (_site: number, a: () => void, b: () => void, cc: () => void): void => {
    a();
    b();
    c.f64Mul();
    cc();
    c.f64Add();
  };
  const neg = (f: () => void) => (): void => {
    f();
    c.f64Neg();
  };
  /** checkint(IY) into YINT: 0 not an integer, 1 odd, 2 even. */
  const emitCheckint = (): void => {
    c.localGet(IY);
    i64k(52n);
    c.i64ShrU();
    c.i32WrapI64();
    c.i32Const(0x7ff);
    c.i32And();
    c.localSet(E);
    c.localGet(E);
    c.i32Const(0x3ff);
    c.i32LtU();
    c.ifResult(I32);
    c.i32Const(0);
    c.else_();
    c.localGet(E);
    c.i32Const(0x3ff + 52);
    c.i32GtU();
    c.ifResult(I32);
    c.i32Const(2);
    c.else_();
    // mask bits below the unit bit: (1 << (0x433 - e)) - 1
    c.localGet(IY);
    i64k(1n);
    c.i32Const(0x3ff + 52);
    c.localGet(E);
    c.i32Sub();
    c.i64ExtendI32U();
    c.i64Shl();
    i64k(1n);
    c.i64Sub();
    c.i64And();
    c.i64Eqz();
    c.ifResult(I32);
    {
      c.localGet(IY);
      i64k(1n);
      c.i32Const(0x3ff + 52);
      c.localGet(E);
      c.i32Sub();
      c.i64ExtendI32U();
      c.i64Shl();
      c.i64And();
      c.i64Eqz();
      c.ifResult(I32);
      c.i32Const(2);
      c.else_();
      c.i32Const(1);
      c.end();
    }
    c.else_();
    c.i32Const(0);
    c.end();
    c.end();
    c.end();
    c.localSet(YINT);
  };
  /** (neg ? -2^769 : 2^769) * 2^769 -- an overflow to the signed infinity. */
  const emitOflow = (negFlag: () => void): void => {
    negFlag();
    c.ifResult(F64);
    c.f64Const(-f64Of(BigInt(769 + 1023) << 52n));
    c.else_();
    c.f64Const(f64Of(BigInt(769 + 1023) << 52n));
    c.end();
    c.f64Const(f64Of(BigInt(769 + 1023) << 52n));
    c.f64Mul();
  };
  /** (neg ? -2^-767 : 2^-767) * 2^-767 -- an underflow to the signed zero. */
  const emitUflow = (negFlag: () => void): void => {
    negFlag();
    c.ifResult(F64);
    c.f64Const(-f64Of(BigInt(-767 + 1023) << 52n));
    c.else_();
    c.f64Const(f64Of(BigInt(-767 + 1023) << 52n));
    c.end();
    c.f64Const(f64Of(BigInt(-767 + 1023) << 52n));
    c.f64Mul();
  };
  const tabGet = (g: number, idx: () => void): void => {
    c.globalGet(g);
    idx();
    c.arrayGet(i64Arr);
  };

  // the tables, materialised on first use
  c.globalGet(gLog);
  c.refIsNull();
  c.ifVoid();
  c.i32Const(logOffset);
  c.i32Const(POW_LOG_TAB.length);
  c.arrayNewData(i64Arr, 0);
  c.globalSet(gLog);
  c.i32Const(expOffset);
  c.i32Const(EXP_TAB.length);
  c.arrayNewData(i64Arr, 0);
  c.globalSet(gExp);
  c.end();

  c.i32Const(0);
  c.localSet(SIGNB);
  c.localGet(X);
  c.i64ReinterpretF64();
  c.localTee(IX);
  i64k(52n);
  c.i64ShrU();
  c.i32WrapI64();
  c.localSet(TOPX);
  c.localGet(Y);
  c.i64ReinterpretF64();
  c.localTee(IY);
  i64k(52n);
  c.i64ShrU();
  c.i32WrapI64();
  c.localSet(TOPY);
  // the special-input gate: x subnormal/zero/inf/nan/negative, or |y| outside [2^-65, 2^63)
  c.localGet(TOPX);
  c.i32Const(1);
  c.i32Sub();
  c.i32Const(0x7ff - 1);
  c.i32GeU();
  c.localGet(TOPY);
  c.i32Const(0x7ff);
  c.i32And();
  c.i32Const(0x3be);
  c.i32Sub();
  c.i32Const(0x43e - 0x3be);
  c.i32GeU();
  c.i32Or();
  c.ifVoid();
  {
    // y is zero, infinity or nan
    c.localGet(IY);
    i64k(1n);
    c.i64Shl();
    i64k(1n);
    c.i64Sub();
    i64k((INF_BITS2 - 1n) & M64);
    c.i64GeU();
    c.ifVoid();
    {
      c.localGet(IY);
      i64k(1n);
      c.i64Shl();
      c.i64Eqz();
      c.ifVoid();
      c.f64Const(1);
      c.return_();
      c.end();
      c.localGet(IX);
      i64k(ONE_BITS);
      c.i64Eq();
      c.ifVoid();
      c.f64Const(1);
      c.return_();
      c.end();
      c.localGet(IX);
      i64k(1n);
      c.i64Shl();
      i64k(INF_BITS2);
      c.i64GtU();
      c.localGet(IY);
      i64k(1n);
      c.i64Shl();
      i64k(INF_BITS2);
      c.i64GtU();
      c.i32Or();
      c.ifVoid();
      c.localGet(X);
      c.localGet(Y);
      c.f64Add();
      c.return_();
      c.end();
      c.localGet(IX);
      i64k(1n);
      c.i64Shl();
      i64k((2n * ONE_BITS) & M64);
      c.i64Eq();
      c.ifVoid();
      c.f64Const(1);
      c.return_();
      c.end();
      // (|x| < 1) == (y positive) -> +0
      c.localGet(IX);
      i64k(1n);
      c.i64Shl();
      i64k((2n * ONE_BITS) & M64);
      c.i64LtU();
      c.localGet(IY);
      i64k(63n);
      c.i64ShrU();
      c.i64Eqz();
      c.i32Eq();
      c.ifVoid();
      c.f64Const(0);
      c.return_();
      c.end();
      c.localGet(Y);
      c.localGet(Y);
      c.f64Mul();
      c.return_();
    }
    c.end();
    // x is zero, infinity or nan
    c.localGet(IX);
    i64k(1n);
    c.i64Shl();
    i64k(1n);
    c.i64Sub();
    i64k((INF_BITS2 - 1n) & M64);
    c.i64GeU();
    c.ifVoid();
    {
      c.localGet(X);
      c.localGet(X);
      c.f64Mul();
      c.localSet(X2);
      c.localGet(IX);
      i64k(63n);
      c.i64ShrU();
      c.i64Eqz();
      c.i32Eqz();
      c.ifVoid();
      emitCheckint();
      c.localGet(YINT);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(X2);
      c.f64Neg();
      c.localSet(X2);
      c.end();
      c.end();
      c.localGet(IY);
      i64k(63n);
      c.i64ShrU();
      c.i64Eqz();
      c.ifResult(F64);
      c.localGet(X2);
      c.else_();
      c.f64Const(1);
      c.localGet(X2);
      c.f64Div();
      c.end();
      c.return_();
    }
    c.end();
    // finite negative x
    c.localGet(IX);
    i64k(63n);
    c.i64ShrU();
    c.i64Eqz();
    c.i32Eqz();
    c.ifVoid();
    {
      emitCheckint();
      c.localGet(YINT);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(X);
      c.localGet(X);
      c.f64Sub();
      c.localGet(X);
      c.localGet(X);
      c.f64Sub();
      c.f64Div();
      c.return_();
      c.end();
      c.localGet(YINT);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(SIGN_BIAS);
      c.localSet(SIGNB);
      c.end();
      c.localGet(IX);
      i64k(0x7fffffffffffffffn);
      c.i64And();
      c.localSet(IX);
      c.localGet(TOPX);
      c.i32Const(0x7ff);
      c.i32And();
      c.localSet(TOPX);
    }
    c.end();
    // |y| < 2^-65 or |y| >= 2^63
    c.localGet(TOPY);
    c.i32Const(0x7ff);
    c.i32And();
    c.i32Const(0x3be);
    c.i32Sub();
    c.i32Const(0x43e - 0x3be);
    c.i32GeU();
    c.ifVoid();
    {
      c.localGet(IX);
      i64k(ONE_BITS);
      c.i64Eq();
      c.ifVoid();
      c.f64Const(1);
      c.return_();
      c.end();
      c.localGet(TOPY);
      c.i32Const(0x7ff);
      c.i32And();
      c.i32Const(0x3be);
      c.i32LtU();
      c.ifVoid();
      c.localGet(IX);
      i64k(ONE_BITS);
      c.i64GtU();
      c.ifResult(F64);
      c.f64Const(1);
      c.localGet(Y);
      c.f64Add();
      c.else_();
      c.f64Const(1);
      c.localGet(Y);
      c.f64Sub();
      c.end();
      c.return_();
      c.end();
      c.localGet(IX);
      i64k(ONE_BITS);
      c.i64GtU();
      c.localGet(TOPY);
      c.i32Const(0x800);
      c.i32LtU();
      c.i32Eq();
      c.ifResult(F64);
      emitOflow(() => c.i32Const(0));
      c.else_();
      emitUflow(() => c.i32Const(0));
      c.end();
      c.return_();
    }
    c.end();
    // subnormal x: normalise so the exponent becomes negative
    c.localGet(TOPX);
    c.i32Eqz();
    c.ifVoid();
    c.localGet(X);
    c.f64Const(f64Of(BigInt(52 + 1023) << 52n));
    c.f64Mul();
    c.i64ReinterpretF64();
    i64k(0x7fffffffffffffffn);
    c.i64And();
    i64k(52n << 52n);
    c.i64Sub();
    c.localSet(IX);
    c.end();
  }
  c.end();

  // ── log_inline: LY + LTAIL = log(|x|) ──
  c.localGet(IX);
  i64k(OFF);
  c.i64Sub();
  c.localTee(TMP);
  i64k(45n);
  c.i64ShrU();
  i64k(127n);
  c.i64And();
  c.i32WrapI64();
  c.i32Const(3);
  c.i32Mul();
  c.localSet(IDX);
  c.localGet(TMP);
  i64k(52n);
  c.i64ShrS();
  c.f64ConvertI64S();
  c.localSet(KD);
  c.localGet(IX);
  c.localGet(TMP);
  i64k(0xfffn << 52n);
  c.i64And();
  c.i64Sub();
  c.localTee(IZ);
  c.f64ReinterpretI64();
  c.localSet(Z);
  tabGet(gLog, () => c.localGet(IDX));
  c.f64ReinterpretI64();
  c.localSet(INVC);
  tabGet(gLog, () => {
    c.localGet(IDX);
    c.i32Const(1);
    c.i32Add();
  });
  c.f64ReinterpretI64();
  c.localSet(LOGC);
  tabGet(gLog, () => {
    c.localGet(IDX);
    c.i32Const(2);
    c.i32Add();
  });
  c.f64ReinterpretI64();
  c.localSet(LOGCTAIL);
  const A0 = f64Of(POW_LOG_POLY[0]!), A1 = f64Of(POW_LOG_POLY[1]!), A2 = f64Of(POW_LOG_POLY[2]!), A3 = f64Of(POW_LOG_POLY[3]!);
  const A4 = f64Of(POW_LOG_POLY[4]!), A5 = f64Of(POW_LOG_POLY[5]!), A6 = f64Of(POW_LOG_POLY[6]!);
  emitFmaAt(SITE.F01, get(Z), get(INVC), k(-1));
  c.localSet(R);
  emitFmaAt(SITE.F02, get(KD), k(f64Of(POW_LOG_LN2HI)), get(LOGC));
  c.localTee(T1);
  c.localGet(R);
  c.f64Add();
  c.localSet(T2);
  emitFmaAt(SITE.F03, get(KD), k(f64Of(POW_LOG_LN2LO)), get(LOGCTAIL));
  c.localSet(LO1);
  c.localGet(T1);
  c.localGet(T2);
  c.f64Sub();
  c.localGet(R);
  c.f64Add();
  c.localSet(LO2);
  c.f64Const(A0);
  c.localGet(R);
  c.f64Mul();
  c.localSet(AR);
  c.localGet(R);
  c.localGet(AR);
  c.f64Mul();
  c.localSet(AR2);
  c.localGet(R);
  c.localGet(AR2);
  c.f64Mul();
  c.localSet(AR3);
  emitMulAdd(SITE.N01, get(R), get(AR), get(T2));
  c.localSet(HI);
  emitFmaAt(SITE.F04, get(AR), get(R), neg(get(AR2)));
  c.localSet(LO3);
  emitMulAdd(SITE.N02, get(R), get(AR), () => {
    c.localGet(T2);
    c.localGet(HI);
    c.f64Sub();
  });
  c.localSet(LO4);
  emitFmaAt(SITE.F05, get(R), k(A2), k(A1));
  c.localSet(Q12);
  emitFmaAt(SITE.F06, get(R), k(A4), k(A3));
  c.localSet(Q34);
  emitFmaAt(SITE.F07, get(R), k(A6), k(A5));
  c.localSet(Q56);
  emitFmaAt(SITE.F08, get(AR2), get(Q56), get(Q34));
  c.localSet(Q36);
  emitFmaAt(SITE.F09, get(AR2), get(Q36), get(Q12));
  c.localSet(Q);
  c.localGet(LO1);
  c.localGet(LO2);
  c.f64Add();
  c.localGet(LO3);
  c.f64Add();
  c.localGet(LO4);
  c.f64Add();
  c.localSet(SUM);
  emitFmaAt(SITE.F10, get(AR3), get(Q), get(SUM));
  c.localSet(LO);
  c.localGet(HI);
  c.localGet(LO);
  c.f64Add();
  c.localSet(LY);
  c.localGet(HI);
  c.localGet(LY);
  c.f64Sub();
  c.localGet(LO);
  c.f64Add();
  c.localSet(LTAIL);

  // ── exp_inline(EHI, elo, SIGNB) ──
  c.localGet(Y);
  c.localGet(LY);
  c.f64Mul();
  c.localTee(EHI);
  c.i64ReinterpretF64();
  i64k(52n);
  c.i64ShrU();
  c.i32WrapI64();
  c.i32Const(0x7ff);
  c.i32And();
  c.localTee(ABSTOP);
  c.i32Const(0x3c9);
  c.i32Sub();
  c.i32Const(0x408 - 0x3c9);
  c.i32GeU();
  c.ifVoid();
  {
    // |ehi| < 2^-54: 1 + ehi, signed
    c.localGet(ABSTOP);
    c.i32Const(0x3c9);
    c.i32Sub();
    c.i32Const(0x80000000 | 0);
    c.i32GeU();
    c.ifVoid();
    c.f64Const(1);
    c.localGet(EHI);
    c.f64Add();
    c.localSet(ONE);
    c.localGet(SIGNB);
    c.ifResult(F64);
    c.localGet(ONE);
    c.f64Neg();
    c.else_();
    c.localGet(ONE);
    c.end();
    c.return_();
    c.end();
    // |ehi| >= 1024: overflow or underflow
    c.localGet(ABSTOP);
    c.i32Const(0x409);
    c.i32GeU();
    c.ifVoid();
    c.localGet(EHI);
    c.i64ReinterpretF64();
    i64k(63n);
    c.i64ShrU();
    c.i64Eqz();
    c.ifResult(F64);
    emitOflow(() => c.localGet(SIGNB));
    c.else_();
    emitUflow(() => c.localGet(SIGNB));
    c.end();
    c.return_();
    c.end();
    c.i32Const(0);
    c.localSet(ABSTOP);
  }
  c.end();
  // elo, formed once ehi is in range
  emitFmaAt(SITE.F12, get(Y), get(LTAIL), () => emitFmaAt(SITE.F11, get(Y), get(LY), neg(get(EHI))));
  c.localSet(XTAIL);
  emitFmaAt(SITE.F13, k(f64Of(EXP_INVLN2N)), get(EHI), k(f64Of(EXP_SHIFT)));
  c.localTee(ZK);
  c.i64ReinterpretF64();
  c.localSet(KI);
  c.localGet(ZK);
  c.f64Const(f64Of(EXP_SHIFT));
  c.f64Sub();
  c.localSet(KD2);
  emitFmaAt(SITE.F14, get(KD2), k(f64Of(EXP_NEGLN2HIN)), get(EHI));
  c.localSet(RR);
  emitFmaAt(SITE.F15, get(KD2), k(f64Of(EXP_NEGLN2LON)), get(RR));
  c.localGet(XTAIL);
  c.f64Add();
  c.localSet(ER);
  c.localGet(KI);
  i64k(127n);
  c.i64And();
  c.i32WrapI64();
  c.i32Const(2);
  c.i32Mul();
  c.localSet(IDX);
  tabGet(gExp, () => c.localGet(IDX));
  c.f64ReinterpretI64();
  c.localSet(TAIL);
  tabGet(gExp, () => {
    c.localGet(IDX);
    c.i32Const(1);
    c.i32Add();
  });
  c.localGet(KI);
  c.localGet(SIGNB);
  c.i64ExtendI32U();
  c.i64Add();
  i64k(45n);
  c.i64Shl();
  c.i64Add();
  c.localSet(SBITS);
  c.localGet(ER);
  c.localGet(ER);
  c.f64Mul();
  c.localSet(R2);
  const C2 = f64Of(EXP_POLY[0]!), C3 = f64Of(EXP_POLY[1]!), C4 = f64Of(EXP_POLY[2]!), C5 = f64Of(EXP_POLY[3]!);
  emitFmaAt(SITE.F16, get(ER), k(C3), k(C2));
  c.localSet(C23);
  emitFmaAt(SITE.F17, get(ER), k(C5), k(C4));
  c.localSet(C45);
  emitFmaAt(SITE.F18, get(R2), get(C23), () => {
    c.localGet(TAIL);
    c.localGet(ER);
    c.f64Add();
  });
  c.localSet(T);
  c.localGet(R2);
  c.localGet(R2);
  c.f64Mul();
  c.localSet(R4);
  emitFmaAt(SITE.F19, get(R4), get(C45), get(T));
  c.localSet(ETMP);
  // specialcase: the result may overflow (k > 0) or land in the subnormal range (k < 0)
  c.localGet(ABSTOP);
  c.i32Eqz();
  c.ifVoid();
  {
    c.localGet(KI);
    i64k(0x80000000n);
    c.i64And();
    c.i64Eqz();
    c.ifVoid();
    c.localGet(SBITS);
    i64k(1009n << 52n);
    c.i64Sub();
    c.f64ReinterpretI64();
    c.localSet(SC);
    emitFmaAt(SITE.F21, get(SC), get(ETMP), get(SC));
    c.f64Const(f64Of(BigInt(1009 + 1023) << 52n));
    c.f64Mul();
    c.return_();
    c.end();
    c.localGet(SBITS);
    i64k(1022n << 52n);
    c.i64Add();
    c.localTee(SBITS);
    c.f64ReinterpretI64();
    c.localSet(SC);
    emitMulAdd(SITE.N03, get(SC), get(ETMP), get(SC));
    c.localTee(YK);
    c.f64Abs();
    c.f64Const(1);
    c.f64Lt();
    c.ifVoid();
    {
      c.localGet(YK);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(F64);
      c.f64Const(-1);
      c.else_();
      c.f64Const(1);
      c.end();
      c.localSet(ONE);
      emitMulAdd(SITE.N04, get(SC), get(ETMP), () => {
        c.localGet(SC);
        c.localGet(YK);
        c.f64Sub();
      });
      c.localSet(LOK);
      c.localGet(ONE);
      c.localGet(YK);
      c.f64Add();
      c.localSet(HIK);
      c.localGet(ONE);
      c.localGet(HIK);
      c.f64Sub();
      c.localGet(YK);
      c.f64Add();
      c.localGet(LOK);
      c.f64Add();
      c.localSet(LOK);
      c.localGet(HIK);
      c.localGet(LOK);
      c.f64Add();
      c.localGet(ONE);
      c.f64Sub();
      c.localTee(YK);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.localGet(SBITS);
      i64k(0x8000000000000000n);
      c.i64And();
      c.f64ReinterpretI64();
      c.localSet(YK);
      c.end();
    }
    c.end();
    c.f64Const(f64Of(BigInt(-1022 + 1023) << 52n));
    c.localGet(YK);
    c.f64Mul();
    c.return_();
  }
  c.end();
  c.localGet(SBITS);
  c.f64ReinterpretI64();
  c.localSet(SC);
  emitFmaAt(SITE.F20, get(SC), get(ETMP), get(SC));
  mb.setBody(coreFn, locals, c.bytes());
  return coreFn;
}
