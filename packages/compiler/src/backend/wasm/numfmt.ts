/* JS-exact double → string, emitted as wasm: the Ryū digit core (a port
 * of the vendored packages/runtime/vendor/ryu/d2s.c — same tables, same
 * branch structure, so the two lanes cannot drift apart silently) plus
 * the ECMA-262 placement rules from scr_number.c. The port takes the
 * plain-C shapes: umul128 by 32-bit halves, mulShiftAll64 as three
 * mulShift64 calls, and native i64 division/remainder where the C dodges
 * them for 32-bit-platform performance only.
 *
 * Layout: the two power-of-five tables live in the module's passive data
 * blob and materialize ONCE into immutable (array i64) globals on the
 * first call; digits and the composed string build in two module-global
 * scratch arrays (single-threaded, and nothing here re-enters), then
 * copy into an exact-length result. All output characters are ASCII, so
 * the result is ordinary UTF-16 string storage.
 *
 * Correctness bar: byte-exact against Node — S001's fuzz gate pins the
 * emitted formatter over 10^5 doubles plus the edge corpus in the wasm
 * emitter unit test, and every claimed corpus program re-checks it. */
import { Code } from "./code.js";
import { F64, I32, I64, ModuleBuilder, type ValType } from "./module.js";
import {
  DOUBLE_POW5_BITCOUNT,
  DOUBLE_POW5_INV_BITCOUNT,
  DOUBLE_POW5_INV_SPLIT,
  DOUBLE_POW5_SPLIT,
} from "./ryu-tables.js";

function tableBytes(entries: readonly bigint[]): Uint8Array {
  const bytes = new Uint8Array(entries.length * 8);
  entries.forEach((v, i) => {
    for (let b = 0; b < 8; b++) bytes[i * 8 + b] = Number((v >> BigInt(b * 8)) & 0xffn);
  });
  return bytes;
}

function litUnits(s: string): Uint8Array {
  const units = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    units[i * 2] = u & 0xff;
    units[i * 2 + 1] = u >> 8;
  }
  return units;
}

/** Declares and emits the %w.f64ToStr(f64) → (ref null str) family into
 * `mb`, returning f64ToStr's function index. Call at most once per
 * module (the emitter caches). */
export function buildF64ToStr(mb: ModuleBuilder, strType: number, strRef: ValType): number {
  const i64Arr = mb.arrayType(I64, false);
  const tableRef: ValType = { kind: "ref", nullable: true, typeIndex: i64Arr };

  const invOffset = mb.internData(tableBytes(DOUBLE_POW5_INV_SPLIT));
  const powOffset = mb.internData(tableBytes(DOUBLE_POW5_SPLIT));

  const gInv = mb.addGlobal(tableRef, true, (w) => {
    w.u8(0xd0);
    w.sleb(i64Arr);
  });
  const gPow = mb.addGlobal(tableRef, true, (w) => {
    w.u8(0xd0);
    w.sleb(i64Arr);
  });
  // 18 digit slots; 32 covers the longest JS rendering (24 chars) + slack.
  const gDig = mb.addGlobal(strRef, true, (w) => {
    w.u8(0xd0);
    w.sleb(strType);
  });
  const gOut = mb.addGlobal(strRef, true, (w) => {
    w.u8(0xd0);
    w.sleb(strType);
  });

  /* ── %w.mulShift64(m, mulLo, mulHi, j) → i64 ─────────────────────────
   * (m × the 128-bit table entry) >> j, exactly d2s_intrinsics.h's plain-C
   * lane: two umul128s by 32-bit halves, carry, shiftright128 (j-64 is in
   * [49, 58], so both shift counts stay in range). */
  const mulShift64 = mb.declareFunc(mb.funcType([I64, I64, I64, I32], [I64]), "%w.mulShift64");
  {
    const c = new Code();
    const M = 0;
    const LO = 1;
    const HI = 2;
    const J = 3;
    const SUM = 4; // i64
    const HIGH1 = 5; // i64
    const HIGH0 = 6; // i64
    const T = 7; // i64 scratch for umul128 internals
    // umul128(a, b) leaving (pLo → stack? no —) writes pLo into `loDst`
    // and pHi into `hiDst`.
    const umul128 = (aLocal: number, bLocal: number, loDst: number | null, hiDst: number): void => {
      // b00 = aLo*bLo; b01 = aLo*bHi; b10 = aHi*bLo; b11 = aHi*bHi.
      // mid1 = b10 + (b00>>32); mid2 = b01 + (mid1 & M32);
      // pHi = b11 + (mid1>>32) + (mid2>>32); pLo = (mid2 << 32) | (b00 & M32).
      const aLo = (): void => {
        c.localGet(aLocal);
        c.i64Const(0xffff_ffffn);
        c.i64And();
      };
      const aHi = (): void => {
        c.localGet(aLocal);
        c.i64Const(32n);
        c.i64ShrU();
      };
      const bLo = (): void => {
        c.localGet(bLocal);
        c.i64Const(0xffff_ffffn);
        c.i64And();
      };
      const bHi = (): void => {
        c.localGet(bLocal);
        c.i64Const(32n);
        c.i64ShrU();
      };
      // T = b00
      aLo();
      bLo();
      c.i64Mul();
      c.localSet(T);
      // HIGH0 (reused as mid1 accumulator) = b10 + (b00 >> 32)
      aHi();
      bLo();
      c.i64Mul();
      c.localGet(T);
      c.i64Const(32n);
      c.i64ShrU();
      c.i64Add();
      c.localSet(hiDst); // mid1, provisionally in the hi destination
      // SUM (reused as mid2) = b01 + (mid1 & M32) — via stack juggling into
      // the destination temporaries to keep the local count flat.
      aLo();
      bHi();
      c.i64Mul();
      c.localGet(hiDst);
      c.i64Const(0xffff_ffffn);
      c.i64And();
      c.i64Add();
      // stack: mid2. pLo first (needs mid2 & M32, plus b00's low half).
      if (loDst !== null) {
        c.localSet(loDst); // park mid2
        c.localGet(loDst);
        c.i64Const(32n);
        c.i64Shl();
        c.localGet(T);
        c.i64Const(0xffff_ffffn);
        c.i64And();
        c.i64Or();
        // stack: [pLo]. pHi = b11 + (mid1 >> 32) + (mid2 >> 32).
        c.localGet(hiDst); // mid1
        c.i64Const(32n);
        c.i64ShrU();
        aHi();
        bHi();
        c.i64Mul();
        c.i64Add();
        c.localGet(loDst); // mid2 (still parked)
        c.i64Const(32n);
        c.i64ShrU();
        c.i64Add();
        c.localSet(hiDst);
        c.localSet(loDst); // the pLo computed above
      } else {
        // hi only: pHi = b11 + (mid1 >> 32) + (mid2 >> 32)
        c.i64Const(32n);
        c.i64ShrU();
        c.localGet(hiDst);
        c.i64Const(32n);
        c.i64ShrU();
        c.i64Add();
        aHi();
        bHi();
        c.i64Mul();
        c.i64Add();
        c.localSet(hiDst);
      }
    };
    // low1/high1 = umul128(m, mulHi)
    umul128(M, HI, SUM, HIGH1); // SUM = low1
    // high0 = umul128(m, mulLo).hi
    umul128(M, LO, null, HIGH0);
    // sum = high0 + low1; carry into high1
    c.localGet(HIGH0);
    c.localGet(SUM);
    c.i64Add();
    c.localSet(SUM);
    c.localGet(SUM);
    c.localGet(HIGH0);
    c.i64LtU();
    c.ifVoid();
    c.localGet(HIGH1);
    c.i64Const(1n);
    c.i64Add();
    c.localSet(HIGH1);
    c.end();
    // shiftright128(sum, high1, j - 64)
    c.localGet(HIGH1);
    c.i32Const(64);
    c.localGet(J);
    c.i32Sub(); // 64 - (j - 64) = 128 - j
    c.i32Const(64);
    c.i32Add(); // 128 - j ... wait: dist = j - 64; left count = 64 - dist = 128 - j
    c.i64ExtendI32S();
    c.i64Shl();
    c.localGet(SUM);
    c.localGet(J);
    c.i32Const(64);
    c.i32Sub();
    c.i64ExtendI32S();
    c.i64ShrU();
    c.i64Or();
    mb.setBody(mulShift64, [I64, I64, I64, I64], c.bytes());
  }

  /* ── %w.pow5Factor(v) → i32 ──────────────────────────────────────────── */
  const pow5Factor = mb.declareFunc(mb.funcType([I64], [I32]), "%w.pow5Factor");
  {
    const c = new Code();
    const V = 0;
    const COUNT = 1; // i32
    c.i32Const(0);
    c.localSet(COUNT);
    c.block();
    c.loop();
    c.localGet(V);
    c.i64Const(BigInt.asIntN(64, 14757395258967641293n)); // 5⁻¹ mod 2⁶⁴
    c.i64Mul();
    c.localSet(V);
    c.localGet(V);
    c.i64Const(3689348814741910323n); // ⌊2⁶⁴/5⌋
    c.i64GtU();
    c.brIf(1);
    c.localGet(COUNT);
    c.i32Const(1);
    c.i32Add();
    c.localSet(COUNT);
    c.br(0);
    c.end();
    c.end();
    c.localGet(COUNT);
    mb.setBody(pow5Factor, [I32], c.bytes());
  }

  /* ── %w.d2d(ieeeMantissa, ieeeExponent) → [mantissa, exponent] ───────
   * The shortest/closest/ties-even digit string, d2s.c's d2d verbatim. */
  const d2d = mb.declareFunc(mb.funcType([I64, I32], [I64, I32]), "%w.d2d");
  {
    const c = new Code();
    const MANT = 0; // i64 param
    const EXP = 1; // i32 param
    const E2 = 2; // i32
    const M2 = 3; // i64
    const ACCEPT = 4; // i32
    const MV = 5; // i64
    const MMSHIFT = 6; // i32
    const VR = 7; // i64
    const VP = 8; // i64
    const VM = 9; // i64
    const E10 = 10; // i32
    const VMTZ = 11; // i32
    const VRTZ = 12; // i32
    const Q = 13; // i32
    const II = 14; // i32 (the table index / shift accumulator)
    const REMOVED = 15; // i32
    const LASTD = 16; // i32
    const OUTPUT = 17; // i64
    const TLO = 18; // i64 (table lo)
    const THI = 19; // i64 (table hi)
    const locals: ValType[] = [I32, I64, I32, I64, I32, I64, I64, I64, I32, I32, I32, I32, I32, I32, I32, I64, I64, I64];

    // e2 / m2 split (the -2 gives the bounds computation two extra bits).
    c.localGet(EXP);
    c.i32Eqz();
    c.ifVoid();
    c.i32Const(1 - 1023 - 52 - 2);
    c.localSet(E2);
    c.localGet(MANT);
    c.localSet(M2);
    c.else_();
    c.localGet(EXP);
    c.i32Const(1023 + 52 + 2);
    c.i32Sub();
    c.localSet(E2);
    c.localGet(MANT);
    c.i64Const(1n << 52n);
    c.i64Or();
    c.localSet(M2);
    c.end();
    // acceptBounds = even = (m2 & 1) == 0
    c.localGet(M2);
    c.i64Const(1n);
    c.i64And();
    c.i64Eqz();
    c.localSet(ACCEPT);
    // mv = 4 * m2
    c.localGet(M2);
    c.i64Const(2n);
    c.i64Shl();
    c.localSet(MV);
    // mmShift = mantissa != 0 || exponent <= 1
    c.localGet(MANT);
    c.i64Eqz();
    c.i32Eqz();
    c.localGet(EXP);
    c.i32Const(1);
    c.i32LeS();
    c.i32Or();
    c.localSet(MMSHIFT);
    c.i32Const(0);
    c.localSet(VMTZ);
    c.i32Const(0);
    c.localSet(VRTZ);

    /** vp/vm/vr = mulShift64(4m+{2,-1-mmShift,0}, (TLO,THI), shift). */
    const mulShiftAll = (shiftLocal: number): void => {
      c.localGet(M2);
      c.i64Const(2n);
      c.i64Shl();
      c.i64Const(2n);
      c.i64Add();
      c.localGet(TLO);
      c.localGet(THI);
      c.localGet(shiftLocal);
      c.call(mulShift64);
      c.localSet(VP);
      c.localGet(M2);
      c.i64Const(2n);
      c.i64Shl();
      c.i64Const(1n);
      c.i64Sub();
      c.localGet(MMSHIFT);
      c.i64ExtendI32U();
      c.i64Sub();
      c.localGet(TLO);
      c.localGet(THI);
      c.localGet(shiftLocal);
      c.call(mulShift64);
      c.localSet(VM);
      c.localGet(M2);
      c.i64Const(2n);
      c.i64Shl();
      c.localGet(TLO);
      c.localGet(THI);
      c.localGet(shiftLocal);
      c.call(mulShift64);
      c.localSet(VR);
    };
    /** table[2q] / table[2q+1] → TLO/THI from the given table global. */
    const loadTable = (global: number, indexLocal: number): void => {
      c.globalGet(global);
      c.localGet(indexLocal);
      c.i32Const(1);
      c.i32Shl();
      c.arrayGet(i64Arr);
      c.localSet(TLO);
      c.globalGet(global);
      c.localGet(indexLocal);
      c.i32Const(1);
      c.i32Shl();
      c.i32Const(1);
      c.i32Add();
      c.arrayGet(i64Arr);
      c.localSet(THI);
    };

    c.localGet(E2);
    c.i32Const(0);
    c.i32GeS();
    c.ifVoid();
    {
      // q = log10Pow2(e2) - (e2 > 3)
      c.localGet(E2);
      c.i32Const(78913);
      c.i32Mul();
      c.i32Const(18);
      c.i32ShrU();
      c.localGet(E2);
      c.i32Const(3);
      c.i32GtS();
      c.i32Sub();
      c.localSet(Q);
      c.localGet(Q);
      c.localSet(E10);
      // i = -e2 + q + (INV_BITCOUNT + pow5bits(q) - 1)
      c.i32Const(0);
      c.localGet(E2);
      c.i32Sub();
      c.localGet(Q);
      c.i32Add();
      c.localGet(Q);
      c.i32Const(1217359);
      c.i32Mul();
      c.i32Const(19);
      c.i32ShrU();
      c.i32Const(1);
      c.i32Add(); // pow5bits(q)
      c.i32Const(DOUBLE_POW5_INV_BITCOUNT - 1);
      c.i32Add();
      c.i32Add();
      c.localSet(II);
      loadTable(gInv, Q);
      mulShiftAll(II);
      // if (q <= 21) trailing-zero corrections
      c.localGet(Q);
      c.i32Const(21);
      c.i32LeS();
      c.ifVoid();
      {
        c.localGet(MV);
        c.i64Const(5n);
        c.i64RemU();
        c.i64Eqz();
        c.ifVoid();
        c.localGet(MV);
        c.call(pow5Factor);
        c.localGet(Q);
        c.i32GeS();
        c.localSet(VRTZ);
        c.else_();
        c.localGet(ACCEPT);
        c.ifVoid();
        c.localGet(MV);
        c.i64Const(1n);
        c.i64Sub();
        c.localGet(MMSHIFT);
        c.i64ExtendI32U();
        c.i64Sub();
        c.call(pow5Factor);
        c.localGet(Q);
        c.i32GeS();
        c.localSet(VMTZ);
        c.else_();
        c.localGet(VP);
        c.localGet(MV);
        c.i64Const(2n);
        c.i64Add();
        c.call(pow5Factor);
        c.localGet(Q);
        c.i32GeS();
        c.i64ExtendI32U();
        c.i64Sub();
        c.localSet(VP);
        c.end();
        c.end();
      }
      c.end();
    }
    c.else_();
    {
      // q = log10Pow5(-e2) - (-e2 > 1)
      c.i32Const(0);
      c.localGet(E2);
      c.i32Sub();
      c.i32Const(732923);
      c.i32Mul();
      c.i32Const(20);
      c.i32ShrU();
      c.i32Const(0);
      c.localGet(E2);
      c.i32Sub();
      c.i32Const(1);
      c.i32GtS();
      c.i32Sub();
      c.localSet(Q);
      // e10 = q + e2
      c.localGet(Q);
      c.localGet(E2);
      c.i32Add();
      c.localSet(E10);
      // i = -e2 - q (the POW5 table index)
      c.i32Const(0);
      c.localGet(E2);
      c.i32Sub();
      c.localGet(Q);
      c.i32Sub();
      c.localSet(II);
      loadTable(gPow, II);
      // j = q - (pow5bits(i) - POW5_BITCOUNT)  → reuse II? j goes into the
      // shift argument; II must stay the table index until loadTable ran
      // (it did), so II can now hold j.
      c.localGet(Q);
      c.localGet(II);
      c.i32Const(1217359);
      c.i32Mul();
      c.i32Const(19);
      c.i32ShrU();
      c.i32Const(1);
      c.i32Add(); // pow5bits(i)
      c.i32Const(DOUBLE_POW5_BITCOUNT);
      c.i32Sub();
      c.i32Sub();
      c.localSet(II); // j
      mulShiftAll(II);
      // trailing zeros
      c.localGet(Q);
      c.i32Const(1);
      c.i32LeS();
      c.ifVoid();
      {
        c.i32Const(1);
        c.localSet(VRTZ);
        c.localGet(ACCEPT);
        c.ifVoid();
        c.localGet(MMSHIFT);
        c.i32Const(1);
        c.i32Eq();
        c.localSet(VMTZ);
        c.else_();
        c.localGet(VP);
        c.i64Const(1n);
        c.i64Sub();
        c.localSet(VP);
        c.end();
      }
      c.else_();
      {
        c.localGet(Q);
        c.i32Const(63);
        c.i32LtS();
        c.ifVoid();
        // vrTZ = (mv & ((1 << q) - 1)) == 0
        c.localGet(MV);
        c.i64Const(1n);
        c.localGet(Q);
        c.i64ExtendI32U();
        c.i64Shl();
        c.i64Const(1n);
        c.i64Sub();
        c.i64And();
        c.i64Eqz();
        c.localSet(VRTZ);
        c.end();
      }
      c.end();
    }
    c.end();

    c.i32Const(0);
    c.localSet(REMOVED);
    c.i32Const(0);
    c.localSet(LASTD);

    // Step 4: shortest representation in the interval.
    c.localGet(VMTZ);
    c.localGet(VRTZ);
    c.i32Or();
    c.ifVoid();
    {
      // General (rare) path.
      c.block();
      c.loop();
      c.localGet(VP);
      c.i64Const(10n);
      c.i64DivU();
      c.localGet(VM);
      c.i64Const(10n);
      c.i64DivU();
      c.i64LeU();
      c.brIf(1);
      c.localGet(VMTZ);
      c.localGet(VM);
      c.i64Const(10n);
      c.i64RemU();
      c.i64Eqz();
      c.i32And();
      c.localSet(VMTZ);
      c.localGet(VRTZ);
      c.localGet(LASTD);
      c.i32Eqz();
      c.i32And();
      c.localSet(VRTZ);
      c.localGet(VR);
      c.i64Const(10n);
      c.i64RemU();
      c.i32WrapI64();
      c.localSet(LASTD);
      c.localGet(VR);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(VR);
      c.localGet(VP);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(VP);
      c.localGet(VM);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(VM);
      c.localGet(REMOVED);
      c.i32Const(1);
      c.i32Add();
      c.localSet(REMOVED);
      c.br(0);
      c.end();
      c.end();
      c.localGet(VMTZ);
      c.ifVoid();
      {
        c.block();
        c.loop();
        c.localGet(VM);
        c.i64Const(10n);
        c.i64RemU();
        c.i64Eqz();
        c.i32Eqz();
        c.brIf(1);
        c.localGet(VRTZ);
        c.localGet(LASTD);
        c.i32Eqz();
        c.i32And();
        c.localSet(VRTZ);
        c.localGet(VR);
        c.i64Const(10n);
        c.i64RemU();
        c.i32WrapI64();
        c.localSet(LASTD);
        c.localGet(VR);
        c.i64Const(10n);
        c.i64DivU();
        c.localSet(VR);
        c.localGet(VP);
        c.i64Const(10n);
        c.i64DivU();
        c.localSet(VP);
        c.localGet(VM);
        c.i64Const(10n);
        c.i64DivU();
        c.localSet(VM);
        c.localGet(REMOVED);
        c.i32Const(1);
        c.i32Add();
        c.localSet(REMOVED);
        c.br(0);
        c.end();
        c.end();
      }
      c.end();
      // Round even on an exact .....50..0 tail.
      c.localGet(VRTZ);
      c.localGet(LASTD);
      c.i32Const(5);
      c.i32Eq();
      c.i32And();
      c.localGet(VR);
      c.i64Const(1n);
      c.i64And();
      c.i64Eqz();
      c.i32And();
      c.ifVoid();
      c.i32Const(4);
      c.localSet(LASTD);
      c.end();
      // output = vr + ((vr == vm && (!accept || !vmTZ)) || lastRemoved >= 5)
      c.localGet(VR);
      c.localGet(VR);
      c.localGet(VM);
      c.i64Eq();
      c.localGet(ACCEPT);
      c.i32Eqz();
      c.localGet(VMTZ);
      c.i32Eqz();
      c.i32Or();
      c.i32And();
      c.localGet(LASTD);
      c.i32Const(5);
      c.i32GeS();
      c.i32Or();
      c.i64ExtendI32U();
      c.i64Add();
      c.localSet(OUTPUT);
    }
    c.else_();
    {
      // Common path: no trailing-zero bookkeeping, roundUp only. LASTD
      // doubles as roundUp here.
      // Two digits at a time first.
      c.localGet(VP);
      c.i64Const(100n);
      c.i64DivU();
      c.localGet(VM);
      c.i64Const(100n);
      c.i64DivU();
      c.i64GtU();
      c.ifVoid();
      c.localGet(VR);
      c.i64Const(100n);
      c.i64RemU();
      c.i64Const(50n);
      c.i64GeU();
      c.localSet(LASTD);
      c.localGet(VR);
      c.i64Const(100n);
      c.i64DivU();
      c.localSet(VR);
      c.localGet(VP);
      c.i64Const(100n);
      c.i64DivU();
      c.localSet(VP);
      c.localGet(VM);
      c.i64Const(100n);
      c.i64DivU();
      c.localSet(VM);
      c.localGet(REMOVED);
      c.i32Const(2);
      c.i32Add();
      c.localSet(REMOVED);
      c.end();
      c.block();
      c.loop();
      c.localGet(VP);
      c.i64Const(10n);
      c.i64DivU();
      c.localGet(VM);
      c.i64Const(10n);
      c.i64DivU();
      c.i64LeU();
      c.brIf(1);
      c.localGet(VR);
      c.i64Const(10n);
      c.i64RemU();
      c.i64Const(5n);
      c.i64GeU();
      c.localSet(LASTD);
      c.localGet(VR);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(VR);
      c.localGet(VP);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(VP);
      c.localGet(VM);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(VM);
      c.localGet(REMOVED);
      c.i32Const(1);
      c.i32Add();
      c.localSet(REMOVED);
      c.br(0);
      c.end();
      c.end();
      // output = vr + (vr == vm || roundUp)
      c.localGet(VR);
      c.localGet(VR);
      c.localGet(VM);
      c.i64Eq();
      c.localGet(LASTD);
      c.i32Or();
      c.i64ExtendI32U();
      c.i64Add();
      c.localSet(OUTPUT);
    }
    c.end();

    c.localGet(OUTPUT);
    c.localGet(E10);
    c.localGet(REMOVED);
    c.i32Add();
    mb.setBody(d2d, locals, c.bytes());
  }

  /* ── %w.f64ToStr(x) → (ref null str) ─────────────────────────────────
   * ECMA-262 Number::toString placement over the Ryū digits, exactly
   * scr_number.c's scr_f64_to_str. */
  const f64ToStr = mb.declareFunc(mb.funcType([F64], [strRef]), "%w.f64ToStr");
  {
    const c = new Code();
    const X = 0; // f64 param (mutated to |x|)
    const BITS = 1; // i64
    const M = 2; // i64 (digits mantissa)
    const E = 3; // i32 (decimal exponent)
    const NEG = 4; // i32
    const SMALL = 5; // i32
    const E2S = 6; // i32
    const K = 7; // i32
    const N = 8; // i32
    const IDX = 9; // i32
    const I = 10; // i32
    const T = 11; // i64
    const EXPO = 12; // i32 (printed exponent)
    const RES = 13; // strRef
    const locals: ValType[] = [I64, I64, I32, I32, I32, I32, I32, I32, I32, I32, I64, I32, strRef];

    const lit = (s: string): void => {
      const off = mb.internData(litUnits(s));
      c.i32Const(off);
      c.i32Const(s.length);
      c.arrayNewData(strType, 0);
    };
    /** out[idx++] = <push unit> */
    const put = (push: () => void): void => {
      c.globalGet(gOut);
      c.localGet(IDX);
      push();
      c.arraySet(strType);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localSet(IDX);
    };
    const putChar = (ch: string): void => put(() => c.i32Const(ch.charCodeAt(0)));
    /** out[idx++] = dig[<push index>] */
    const putDigitAt = (pushIndex: () => void): void =>
      put(() => {
        c.globalGet(gDig);
        pushIndex();
        c.arrayGetU(strType);
      });

    // Lazy one-time materialization of tables and scratch.
    c.globalGet(gInv);
    c.refIsNull();
    c.ifVoid();
    c.i32Const(invOffset);
    c.i32Const(DOUBLE_POW5_INV_SPLIT.length);
    c.arrayNewData(i64Arr, 0);
    c.globalSet(gInv);
    c.i32Const(powOffset);
    c.i32Const(DOUBLE_POW5_SPLIT.length);
    c.arrayNewData(i64Arr, 0);
    c.globalSet(gPow);
    c.i32Const(18);
    c.arrayNewDefault(strType);
    c.globalSet(gDig);
    c.i32Const(32);
    c.arrayNewDefault(strType);
    c.globalSet(gOut);
    c.end();

    // Specials, in scr_number.c's order.
    c.localGet(X);
    c.localGet(X);
    c.f64Ne();
    c.ifVoid();
    lit("NaN");
    c.return_();
    c.end();
    c.localGet(X);
    c.f64Const(0);
    c.f64Eq();
    c.ifVoid();
    lit("0"); // covers -0
    c.return_();
    c.end();
    c.localGet(X);
    c.f64Const(0);
    c.f64Lt();
    c.localSet(NEG);
    c.localGet(NEG);
    c.ifVoid();
    c.localGet(X);
    c.f64Neg();
    c.localSet(X);
    c.end();
    c.localGet(X);
    c.f64Const(Infinity);
    c.f64Eq();
    c.ifVoid();
    c.localGet(NEG);
    c.ifResult(strRef);
    lit("-Infinity");
    c.else_();
    lit("Infinity");
    c.end();
    c.return_();
    c.end();

    // Decode (x is positive and finite here, so no sign bit).
    c.localGet(X);
    c.i64ReinterpretF64();
    c.localSet(BITS);

    // d2d_small_int: integers in [1, 2^53) read their digits directly.
    c.i32Const(0);
    c.localSet(SMALL);
    c.localGet(BITS);
    c.i64Const(52n);
    c.i64ShrU();
    c.i32WrapI64();
    c.i32Const(1075);
    c.i32Sub();
    c.localSet(E2S);
    c.localGet(E2S);
    c.i32Const(0);
    c.i32LeS();
    c.localGet(E2S);
    c.i32Const(-52);
    c.i32GeS();
    c.i32And();
    c.ifVoid();
    {
      // m2 = (1<<52) | mantissa; fraction = m2 & ((1 << -e2s) - 1)
      c.localGet(BITS);
      c.i64Const(0xf_ffff_ffff_ffffn);
      c.i64And();
      c.i64Const(1n << 52n);
      c.i64Or();
      c.localSet(T);
      c.localGet(T);
      c.i64Const(1n);
      c.i32Const(0);
      c.localGet(E2S);
      c.i32Sub();
      c.i64ExtendI32S();
      c.i64Shl();
      c.i64Const(1n);
      c.i64Sub();
      c.i64And();
      c.i64Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(SMALL);
      c.localGet(T);
      c.i32Const(0);
      c.localGet(E2S);
      c.i32Sub();
      c.i64ExtendI32S();
      c.i64ShrU();
      c.localSet(M);
      c.i32Const(0);
      c.localSet(E);
      c.end();
    }
    c.end();

    c.localGet(SMALL);
    c.ifVoid();
    {
      // Fold trailing decimal zeros into the exponent.
      c.block();
      c.loop();
      c.localGet(M);
      c.i64Const(10n);
      c.i64RemU();
      c.i64Eqz();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(M);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(M);
      c.localGet(E);
      c.i32Const(1);
      c.i32Add();
      c.localSet(E);
      c.br(0);
      c.end();
      c.end();
    }
    c.else_();
    {
      c.localGet(BITS);
      c.i64Const(0xf_ffff_ffff_ffffn);
      c.i64And();
      c.localGet(BITS);
      c.i64Const(52n);
      c.i64ShrU();
      c.i32WrapI64();
      c.call(d2d);
      c.localSet(E);
      c.localSet(M);
    }
    c.end();

    // k = digit count; n = E + k (value = 0.digits × 10^n).
    c.i32Const(1);
    c.localSet(K);
    c.localGet(M);
    c.localSet(T);
    c.block();
    c.loop();
    c.localGet(T);
    c.i64Const(10n);
    c.i64LtU();
    c.brIf(1);
    c.localGet(T);
    c.i64Const(10n);
    c.i64DivU();
    c.localSet(T);
    c.localGet(K);
    c.i32Const(1);
    c.i32Add();
    c.localSet(K);
    c.br(0);
    c.end();
    c.end();
    c.localGet(E);
    c.localGet(K);
    c.i32Add();
    c.localSet(N);

    // dig[k-1..0] ← M's digits, low to high.
    c.localGet(K);
    c.localSet(I);
    c.block();
    c.loop();
    c.localGet(I);
    c.i32Eqz();
    c.brIf(1);
    c.localGet(I);
    c.i32Const(1);
    c.i32Sub();
    c.localSet(I);
    c.globalGet(gDig);
    c.localGet(I);
    c.i32Const(0x30);
    c.localGet(M);
    c.i64Const(10n);
    c.i64RemU();
    c.i32WrapI64();
    c.i32Add();
    c.arraySet(strType);
    c.localGet(M);
    c.i64Const(10n);
    c.i64DivU();
    c.localSet(M);
    c.br(0);
    c.end();
    c.end();

    // ECMA placement.
    c.i32Const(0);
    c.localSet(IDX);
    c.localGet(NEG);
    c.ifVoid();
    putChar("-");
    c.end();

    /** for (i = <from>; i < <toLocal>; i++) out[idx++] = dig[i] */
    const copyDigits = (from: () => void, until: () => void): void => {
      from();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      until();
      c.i32GeS();
      c.brIf(1);
      putDigitAt(() => c.localGet(I));
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
    };

    c.localGet(K);
    c.localGet(N);
    c.i32LeS();
    c.localGet(N);
    c.i32Const(21);
    c.i32LeS();
    c.i32And();
    c.ifVoid();
    {
      // Integer: digits then n-k zeros.
      copyDigits(() => c.i32Const(0), () => c.localGet(K));
      c.localGet(N);
      c.localGet(K);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Eqz();
      c.brIf(1);
      putChar("0");
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
    }
    c.else_();
    {
      c.i32Const(0);
      c.localGet(N);
      c.i32LtS();
      c.localGet(N);
      c.i32Const(21);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      {
        // ddd.ddd
        copyDigits(() => c.i32Const(0), () => c.localGet(N));
        putChar(".");
        copyDigits(() => c.localGet(N), () => c.localGet(K));
      }
      c.else_();
      {
        c.i32Const(-6);
        c.localGet(N);
        c.i32LtS();
        c.localGet(N);
        c.i32Const(0);
        c.i32LeS();
        c.i32And();
        c.ifVoid();
        {
          // 0.000ddd
          putChar("0");
          putChar(".");
          c.i32Const(0);
          c.localGet(N);
          c.i32Sub();
          c.localSet(I);
          c.block();
          c.loop();
          c.localGet(I);
          c.i32Eqz();
          c.brIf(1);
          putChar("0");
          c.localGet(I);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(I);
          c.br(0);
          c.end();
          c.end();
          copyDigits(() => c.i32Const(0), () => c.localGet(K));
        }
        c.else_();
        {
          // d.ddde±e
          putDigitAt(() => c.i32Const(0));
          c.localGet(K);
          c.i32Const(1);
          c.i32GtS();
          c.ifVoid();
          putChar(".");
          copyDigits(() => c.i32Const(1), () => c.localGet(K));
          c.end();
          putChar("e");
          c.localGet(N);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(EXPO);
          c.localGet(EXPO);
          c.i32Const(0);
          c.i32LtS();
          c.ifVoid();
          putChar("-");
          c.i32Const(0);
          c.localGet(EXPO);
          c.i32Sub();
          c.localSet(EXPO);
          c.else_();
          putChar("+");
          c.end();
          // ≤ 3 exponent digits (|e| ≤ 308).
          c.localGet(EXPO);
          c.i32Const(100);
          c.i32GeS();
          c.ifVoid();
          put(() => {
            c.i32Const(0x30);
            c.localGet(EXPO);
            c.i32Const(100);
            c.i32DivS();
            c.i32Add();
          });
          c.end();
          c.localGet(EXPO);
          c.i32Const(10);
          c.i32GeS();
          c.ifVoid();
          put(() => {
            c.i32Const(0x30);
            c.localGet(EXPO);
            c.i32Const(10);
            c.i32DivS();
            c.i32Const(10);
            c.i32RemS();
            c.i32Add();
          });
          c.end();
          put(() => {
            c.i32Const(0x30);
            c.localGet(EXPO);
            c.i32Const(10);
            c.i32RemS();
            c.i32Add();
          });
        }
        c.end();
      }
      c.end();
    }
    c.end();

    // result = out[0, idx)
    c.localGet(IDX);
    c.arrayNewDefault(strType);
    c.localSet(RES);
    c.localGet(RES);
    c.i32Const(0);
    c.globalGet(gOut);
    c.i32Const(0);
    c.localGet(IDX);
    c.arrayCopy(strType, strType);
    c.localGet(RES);
    mb.setBody(f64ToStr, locals, c.bytes());
  }

  return f64ToStr;
}
