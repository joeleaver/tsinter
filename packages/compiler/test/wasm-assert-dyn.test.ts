/* Increment 23 P2a — assert.eqDyn's comparison side (design-p2.txt
 * sections 0/B: sameValueDyn, deepEqDyn, isObject, checkOperatorMorph)
 * AND its renderer (section A: cfValue/cfInspect). `assert.eqDyn`
 * ITSELF still refuses by name through P2a/P2b (H-2 — libCall wiring is
 * P2b's job), so NONE of this is reachable through real compiled
 * TypeScript yet — every pin here force-emits directly against a
 * standalone DynBuilder/InspectBuilder pair, mirroring wasm-dyn-
 * specifictype.test.ts's and wasm-bytes-validate.test.ts's own pattern
 * (a minimal ModuleBuilder + builders, bypassing the frontend entirely,
 * to reach machinery no lowering can yet). Every dep these methods
 * actually CALL is a REAL implementation here (strEq, bytesEquals via a
 * real BytesBuilder, sameValueF64, strCmpU16, inspF64 via the real
 * buildF64ToStr), not a stub — EXCEPT deqEnter/deqLeave (comparison
 * side) and the error-struct deps plus throwError/excKind (renderer
 * side, unused by cfValue/cfInspect: neither touches error rendering
 * or the exception cell). deqEnter/deqLeave stand in for P1's own already-exhaustively-
 * proven two-phase memo (SEMANTICS.md S056, F1-F4's own battery) with a
 * DELIBERATELY SIMPLER test-local fixed-depth LIFO STACK memo: this
 * file's job is to prove `deepEqDyn`'s own WIRING discipline (deqEnter
 * matched by deqLeave on EVERY exit, B.4's caveat, across both a
 * genuine self-cycle AND ordinary non-cyclic nesting) — the memo
 * ALGORITHM's own correctness (unbounded depth, the general N-pair
 * case) is P1's territory, unchanged and reused verbatim (via DynDeps
 * injection) once P2b actually wires eqDyn for real. */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { DK, DynBuilder, type DynDeps } from "../src/backend/wasm/dyn.js";
import { InspectBuilder, type InspectDeps } from "../src/backend/wasm/inspect.js";
import { F64, I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { buildF64ToStr } from "../src/backend/wasm/numfmt.js";
import { BytesBuilder } from "../src/backend/wasm/typedarrays.js";
import { VecBuilder } from "../src/backend/wasm/arrays.js";

/** assertion_error.js's own inspect options (design-p2.txt A.0) — the
 * SAME literal object every renderer pin's own Node-side expectation
 * must be measured against, never the ad hoc/default options. */
const ASSERT_INSPECT_OPTS = {
  compact: false,
  customInspect: false,
  depth: 1000,
  maxArrayLength: Infinity,
  showHidden: false,
  showProxy: false,
  sorted: true,
  getters: true,
} as const;

// `eq`'s own s33 heap-type encoding (dyn.ts's own EQ_HEAP — a wasm-gc
// spec constant, not an implementation detail; every `$dyn` box carries
// a nullable `eq` ref for its non-payload slot).
const EQ_HEAP = -0x13;

/** A bare `$dyn{kind, num:0, ref:null}` struct — sufficient for every
 * pin that only exercises a DYN_KIND-driven arm (isObject,
 * checkOperatorMorph, deepEqDyn's own kind switch for the scalar
 * kinds), matching wasm-dyn-specifictype.test.ts's own established
 * technique. */
function bareDyn(c: Code, dynT: number, kind: number): void {
  c.i32Const(kind);
  c.f64Const(0);
  c.refNull(EQ_HEAP);
  c.structNew(dynT);
}

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-assert-dyn-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Harness {
  mb: ModuleBuilder;
  dyn: DynBuilder;
  insp: InspectBuilder;
  strType: number;
  strRef: ValType;
  bytesRef: ValType;
  pushStr: (c: Code, s: string) => void;
  /** Builds a bytes<u8> value from a plain array of byte values, using
   * `tmpLocal` (an I32-index-typed local the CALLER must have declared
   * as `bytesRef` in its own function) as scratch across the newLen +
   * setElem sequence. Leaves the finished bytes<u8> ref on the stack. */
  pushBytesU8: (c: Code, tmpLocal: number, values: number[]) => void;
  emit: () => Uint8Array;
}

/** The shared force-emit rig: a real string type + content-equal +
 * sort-free strCmpU16 stub (unused by the comparison side), a real
 * BytesBuilder (so BYTES-kind pins exercise the ACTUAL payload-alias
 * content check, not a stand-in), a real sameValueF64 (P1's own
 * 6-line Object.is, reproduced here rather than imported — emitter.ts's
 * copy is private), and the test-local single-pair memo described
 * above for deqEnter/deqLeave. */
function makeHarness(): Harness {
  const mb = new ModuleBuilder();
  // Strings are (mut i16) arrays (S002).
  const realStrType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: realStrType };

  const pushStr = (c: Code, s: string): void => {
    const units = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    c.i32Const(mb.internData(units));
    c.i32Const(s.length);
    c.arrayNewData(realStrType, 0);
  };

  // %stub.strEq(a,b) -> i32 — REAL content equality, unit by unit.
  const strEqFn = mb.declareFunc(mb.funcType([strRef, strRef], [I32]), "%real.strEq");
  {
    const c = new Code();
    const A = 0,
      B = 1,
      LA = 2,
      LB = 3,
      I = 4;
    c.localGet(A);
    c.arrayLen();
    c.localSet(LA);
    c.localGet(B);
    c.arrayLen();
    c.localSet(LB);
    c.localGet(LA);
    c.localGet(LB);
    c.i32Ne();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    c.i32Const(0);
    c.localSet(I);
    c.block();
    c.loop();
    c.localGet(I);
    c.localGet(LA);
    c.i32GeU();
    c.brIf(1);
    c.localGet(A);
    c.localGet(I);
    c.arrayGetU(realStrType);
    c.localGet(B);
    c.localGet(I);
    c.arrayGetU(realStrType);
    c.i32Ne();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end();
    c.end();
    c.i32Const(1);
    // Locals beyond the 2 params (A=0, B=1): LA=2, LB=3, I=4 — three
    // additional i32 locals, not one (a pre-existing bug in this
    // harness helper, caught by this file's FIRST actual vitest run:
    // `WebAssembly.Module()` rejected local index 3 as out of range
    // when this array under-declared them).
    mb.setBody(strEqFn, [I32, I32, I32], c.bytes());
  }

  const f64ToStrFn = mb.declareFunc(mb.funcType([F64], [strRef]), "%stub.f64ToStr");
  mb.setBody(
    f64ToStrFn,
    [],
    (() => {
      const c = new Code();
      c.refNull(realStrType);
      return c.bytes();
    })(),
  );
  const concatFn = mb.declareFunc(mb.funcType([strRef, strRef], [strRef]), "%stub.concat");
  mb.setBody(
    concatFn,
    [],
    (() => {
      const c = new Code();
      c.localGet(0);
      return c.bytes();
    })(),
  );
  const strSliceFn = mb.declareFunc(mb.funcType([strRef, F64, F64], [strRef]), "%stub.strSlice");
  mb.setBody(
    strSliceFn,
    [],
    (() => {
      const c = new Code();
      c.localGet(0);
      return c.bytes();
    })(),
  );
  const strIndexOfFn = mb.declareFunc(mb.funcType([strRef, strRef, F64], [F64]), "%stub.strIndexOf");
  mb.setBody(
    strIndexOfFn,
    [],
    (() => {
      const c = new Code();
      c.f64Const(-1);
      return c.bytes();
    })(),
  );
  const strMatchAtFn = mb.declareFunc(mb.funcType([strRef, strRef, I32], [I32]), "%stub.strMatchAt");
  mb.setBody(
    strMatchAtFn,
    [],
    (() => {
      const c = new Code();
      c.i32Const(0);
      return c.bytes();
    })(),
  );
  const strCpAtFn = mb.declareFunc(mb.funcType([strRef, I32], [I32]), "%stub.strCpAt");
  mb.setBody(
    strCpAtFn,
    [],
    (() => {
      const c = new Code();
      c.i32Const(0);
      return c.bytes();
    })(),
  );
  const noopFn = mb.declareFunc(mb.funcType([], []), "%stub.noop");
  mb.setBody(noopFn, [], new Code().bytes());
  const toInt32Fn = mb.declareFunc(mb.funcType([F64], [I32]), "%stub.toInt32");
  mb.setBody(
    toInt32Fn,
    [],
    (() => {
      const c = new Code();
      c.localGet(0);
      c.i32TruncF64S();
      return c.bytes();
    })(),
  );
  const lit = (c: Code, s: string): void => pushStr(c, s);

  const vecs = new VecBuilder(mb, { strEq: () => strEqFn, f64ToStr: () => f64ToStrFn, concat: () => concatFn, lit });
  const f64VecInfo = vecs.info("vec(f64)", F64, F64, "f64");
  let dyn!: DynBuilder;
  const dynVecInfo = () => vecs.info("dyn", dyn.dynRef(), dyn.dynRef(), "ref");

  let bytesB!: BytesBuilder;
  const bytesVecInfo = () => vecs.info("vec(bytes:u8)", bytesB.bytesRef(), bytesB.bytesRef(), "ref");
  bytesB = new BytesBuilder(mb, {
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    strRef: () => strRef,
    strType: () => realStrType,
    toInt32: () => toInt32Fn,
    strSlice: () => strSliceFn,
    f64Vec: () => f64VecInfo,
    f64VecNewLen: () => vecs.newLen(f64VecInfo),
    f64VecPush1: () => vecs.pushOne(f64VecInfo),
    bytesVec: bytesVecInfo,
    throwError: (c, _cn, _n, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
  });

  const errT = mb.structType([
    { storage: I32, mutable: false },
    { storage: strRef, mutable: true },
    { storage: strRef, mutable: true },
    { storage: strRef, mutable: false },
  ]);
  const excKindG = mb.addGlobal(I32, true, (w) => {
    w.u8(0x41);
    w.sleb(0);
  });

  // sameValueF64 — P1's own 6-line Object.is, reproduced (emitter.ts's
  // copy is a private method, not importable).
  const sameValueF64Fn = mb.declareFunc(mb.funcType([F64, F64], [I32]), "%real.sameValueF64");
  {
    const c = new Code();
    const A = 0,
      B = 1;
    c.localGet(A);
    c.localGet(B);
    c.f64Eq();
    c.ifResult(I32);
    c.localGet(A);
    c.f64Const(0);
    c.f64Ne();
    c.ifResult(I32);
    c.i32Const(1);
    c.else_();
    c.localGet(A);
    c.i64ReinterpretF64();
    c.localGet(B);
    c.i64ReinterpretF64();
    c.i64Eq();
    c.end();
    c.else_();
    c.localGet(A);
    c.localGet(A);
    c.f64Ne();
    c.localGet(B);
    c.localGet(B);
    c.f64Ne();
    c.i32And();
    c.end();
    mb.setBody(sameValueF64Fn, [], c.bytes());
  }

  // The test-local memo (see the file header) — A WIRING INSTRUMENT
  // ONLY, standing in for P1's real two-phase algorithm (SEMANTICS.md
  // S056, emitter.ts's deqEnterHelper/deqLeaveHelper — bound to
  // deps.deqEnter/deqLeave in the PRODUCTION `dyn` getter; nothing
  // here replaces or duplicates that memo). This stub exists to prove
  // deepEqDyn's own WIRING discipline against the dyn walk — that
  // deqEnter's 3-way verdict is consumed correctly by both the ARR and
  // OBJ arms, and that deqLeave is called on EVERY exit path (B.4's
  // caveat) — NOT to reproduce Node's own memo's unbounded storage or
  // its correctness on any real comparison. The REAL memo's own rows
  // (the general N-pair case, the period/crossed-depth shapes S056
  // documents) are exercised only END-TO-END through `eqDyn` itself,
  // once P2b wires it — those are P2b's claim-time pins, not this
  // stub's job.
  //
  // Mechanically: a genuine (if depth-bounded) LIFO STACK rather than
  // a single pair — deqEnter/deqLeave nest exactly like ordinary
  // function call/return (every ARR/OBJ arm's own enter is matched by
  // its own leave before the CALLER's leave runs), so a fixed
  // MEMO_DEPTH-slot stack is enough to prove wiring discipline on a
  // genuine self-cycle (a re-entrant pair matching an ALREADY-occupied
  // slot -> EQUAL), ordinary non-cyclic nested composites (a new pair
  // occupying the NEXT free slot while an outer pair is still active
  // -> WALK), AND — reached by a dedicated pin nesting past MEMO_DEPTH
  // (fix round F2-p2a's own P-3 finding: this was previously an
  // asserted-but-untested claim) — exhaustion, which conservatively
  // answers UNEQUAL rather than silently growing past what's proven.
  // deqEnter answers the SAME 3-way verdict `deepEqDyn` expects
  // (0=WALK/1=EQUAL/2=UNEQUAL) the real memo does.
  const eqRefStub: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };
  const MEMO_DEPTH = 4;
  const topG = mb.addGlobal(I32, true, (w) => {
    w.u8(0x41);
    w.sleb(0);
  });
  const memoAG: number[] = [];
  const memoBG: number[] = [];
  for (let i = 0; i < MEMO_DEPTH; i++) {
    memoAG.push(
      mb.addGlobal(eqRefStub, true, (w) => {
        w.u8(0xd0);
        w.sleb(EQ_HEAP);
      }),
    );
    memoBG.push(
      mb.addGlobal(eqRefStub, true, (w) => {
        w.u8(0xd0);
        w.sleb(EQ_HEAP);
      }),
    );
  }
  const deqEnterFn = mb.declareFunc(mb.funcType([eqRefStub, eqRefStub], [F64]), "%test.deqEnter");
  {
    const c = new Code();
    const A = 0,
      B = 1;
    // A match against any OCCUPIED slot (index < top) is a cycle re-entry -> EQUAL.
    for (let i = 0; i < MEMO_DEPTH; i++) {
      c.i32Const(i);
      c.globalGet(topG);
      c.i32LtS();
      c.localGet(A);
      c.globalGet(memoAG[i]!);
      c.refEq();
      c.i32And();
      c.localGet(B);
      c.globalGet(memoBG[i]!);
      c.refEq();
      c.i32And();
      c.ifVoid();
      c.f64Const(1);
      c.return_();
      c.end();
    }
    // Stack exhausted -> conservative bail (never reached by this file's own pins).
    c.globalGet(topG);
    c.i32Const(MEMO_DEPTH);
    c.i32GeS();
    c.ifVoid();
    c.f64Const(2);
    c.return_();
    c.end();
    // Occupy the next free slot (exactly one of these matches `top`).
    for (let i = 0; i < MEMO_DEPTH; i++) {
      c.globalGet(topG);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      c.localGet(A);
      c.globalSet(memoAG[i]!);
      c.localGet(B);
      c.globalSet(memoBG[i]!);
      c.end();
    }
    c.globalGet(topG);
    c.i32Const(1);
    c.i32Add();
    c.globalSet(topG);
    c.f64Const(0);
    mb.setBody(deqEnterFn, [], c.bytes());
  }
  const deqLeaveFn = mb.declareFunc(mb.funcType([], []), "%test.deqLeave");
  {
    const c = new Code();
    // LIFO pop — every deqEnter this file ever issues is matched by
    // exactly one deqLeave before its OWN caller's deqLeave runs, so
    // decrementing top is the whole of it (no need to null the popped
    // slot's refs: a stale ref there is simply unreachable-by-index
    // until re-occupied, and re-occupation always overwrites it).
    c.globalGet(topG);
    c.i32Const(1);
    c.i32Sub();
    c.globalSet(topG);
    mb.setBody(deqLeaveFn, [], c.bytes());
  }

  const deps: DynDeps = {
    strRef: () => strRef,
    strType: () => realStrType,
    strEq: () => strEqFn,
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    throwTypeError: (c, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    arrVec: dynVecInfo,
    arrPush: () => vecs.pushOne(dynVecInfo()),
    arrNewLen: () => vecs.newLen(dynVecInfo()),
    strCpAt: () => strCpAtFn,
    errT: () => errT,
    errName: () => 1,
    errMessage: () => 2,
    errCode: () => 3,
    throwError: (c, _cn, _n, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    excKind: () => excKindG,
    strCmpU16: () => strEqFn,
    strSlice: () => strSliceFn,
    strIndexOf: () => strIndexOfFn,
    strMatchAt: () => strMatchAtFn,
    jsonQuoteStr: () => noopFn,
    bytesRefU8: () => bytesB.bytesRef(),
    bytesTypeU8: () => bytesB.bytesType(),
    bytesEquals: () => bytesB.equalsHelper(),
    bytesLen: () => bytesB.length(),
    bytesGet: () => bytesB.get("u8"),
    bytesSet: () => bytesB.setElem("u8"),
    bytesToStrUtf8: () => bytesB.toStrHelper("utf8"),
    jsToNumber: () => noopFn,
    sameValueF64: () => sameValueF64Fn,
    deqEnter: () => deqEnterFn,
    deqLeave: () => deqLeaveFn,
  };
  dyn = new DynBuilder(mb, deps);

  const pushBytesU8 = (c: Code, tmpLocal: number, values: number[]): void => {
    c.f64Const(values.length);
    c.call(bytesB.newLen("u8"));
    c.localSet(tmpLocal);
    for (let i = 0; i < values.length; i++) {
      c.localGet(tmpLocal);
      c.f64Const(i);
      c.f64Const(values[i]!);
      c.call(bytesB.setElem("u8"));
    }
    c.localGet(tmpLocal);
  };

  // %real.strCmpU16(a,b) -> -1|0|1 — Array.prototype.sort's default
  // comparator (ToString + IsLessThan) over strings ALREADY stored as
  // UTF-16 code units (S002): compare the common prefix unit by unit,
  // then break ties by length. Own hand-roll (the design's own
  // %w.strCmpU16 is emitter.ts's private strCmpHelper, not importable).
  const strCmpU16Fn = mb.declareFunc(mb.funcType([strRef, strRef], [I32]), "%real.strCmpU16");
  {
    const c = new Code();
    const A = 0,
      B = 1,
      LA = 2,
      LB = 3,
      N = 4,
      I = 5,
      UA = 6,
      UB = 7;
    c.localGet(A);
    c.arrayLen();
    c.localSet(LA);
    c.localGet(B);
    c.arrayLen();
    c.localSet(LB);
    c.localGet(LA);
    c.localGet(LB);
    c.i32LtS();
    c.ifResult(I32);
    c.localGet(LA);
    c.else_();
    c.localGet(LB);
    c.end();
    c.localSet(N);
    c.i32Const(0);
    c.localSet(I);
    c.block();
    c.loop();
    c.localGet(I);
    c.localGet(N);
    c.i32GeS();
    c.brIf(1);
    c.localGet(A);
    c.localGet(I);
    c.arrayGetU(realStrType);
    c.localSet(UA);
    c.localGet(B);
    c.localGet(I);
    c.arrayGetU(realStrType);
    c.localSet(UB);
    c.localGet(UA);
    c.localGet(UB);
    c.i32Ne();
    c.ifVoid();
    c.localGet(UA);
    c.localGet(UB);
    c.i32LtU();
    c.ifResult(I32);
    c.i32Const(-1);
    c.else_();
    c.i32Const(1);
    c.end();
    c.return_();
    c.end();
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end();
    c.end();
    c.localGet(LA);
    c.localGet(LB);
    c.i32LtS();
    c.ifResult(I32);
    c.i32Const(-1);
    c.else_();
    c.localGet(LA);
    c.localGet(LB);
    c.i32GtS();
    c.ifResult(I32);
    c.i32Const(1);
    c.else_();
    c.i32Const(0);
    c.end();
    c.end();
    mb.setBody(strCmpU16Fn, [I32, I32, I32, I32, I32, I32], c.bytes());
  }

  // %real.inspF64(f64) -> str — inspF64Helper's own shape reproduced:
  // JS ToString via the REAL buildF64ToStr, except -0 prints "-0".
  const f64ToStrRealFn = buildF64ToStr(mb, realStrType, strRef);
  const inspF64Fn = mb.declareFunc(mb.funcType([F64], [strRef]), "%real.inspF64");
  {
    const c = new Code();
    c.localGet(0);
    c.i64ReinterpretF64();
    c.i64Const(BigInt.asIntN(64, 1n << 63n));
    c.i64Eq();
    c.ifResult(strRef);
    pushStr(c, "-0");
    c.else_();
    c.localGet(0);
    c.call(f64ToStrRealFn);
    c.end();
    mb.setBody(inspF64Fn, [], c.bytes());
  }

  const inspDeps: InspectDeps = {
    strRef: () => strRef,
    strType: () => realStrType,
    lit,
    f64ToStr: () => f64ToStrRealFn,
    // Unused by cfValue/cfInspect (neither touches error rendering or
    // the exception cell) — throwing stubs, matching wasm-inspect.
    // test.ts's own harness-1 idiom for the same reason.
    errT: () => {
      throw new Error("this harness does not build the exception struct");
    },
    errName: () => {
      throw new Error("this harness does not build the exception struct");
    },
    errMessage: () => {
      throw new Error("this harness does not build the exception struct");
    },
    errCode: () => {
      throw new Error("this harness does not build the exception struct");
    },
    dyn: () => dyn,
    inspF64: () => inspF64Fn,
    throwError: () => {
      throw new Error("this harness has no exception cell");
    },
    excKind: () => {
      throw new Error("this harness has no exception cell");
    },
    bytesRefU8: () => bytesB.bytesRef(),
    bytesLen: () => bytesB.length(),
    bytesGet: () => bytesB.get("u8"),
    strCmpU16: () => strCmpU16Fn,
  };
  const insp = new InspectBuilder(mb, inspDeps);

  return {
    mb,
    dyn,
    insp,
    strType: realStrType,
    strRef,
    bytesRef: bytesB.bytesRef(),
    pushBytesU8,
    pushStr,
    emit: () => mb.emit(),
  };
}

async function buildAndRun(
  exports: { name: string; locals?: (h: Harness) => ValType[]; build: (c: Code, h: Harness) => void }[],
): Promise<Record<string, number>> {
  const h = makeHarness();
  for (const e of exports) {
    const idx = h.mb.declareFunc(h.mb.funcType([], [I32]), e.name);
    const c = new Code();
    e.build(c, h);
    h.mb.setBody(idx, e.locals?.(h) ?? [], c.bytes());
    h.mb.exportFunc(e.name, idx);
  }
  const bytes = h.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const path = join(scratch, `${exports[0]!.name}-${Math.random().toString(36).slice(2)}.wasm`);
  await writeFile(path, bytes);
  const { instance } = await WebAssembly.instantiate(bytes);
  const out: Record<string, number> = {};
  for (const e of exports) out[e.name] = (instance.exports[e.name] as () => number)();
  return out;
}

/** The renderer runner — every export returns a `strRef`, so this ALSO
 * exports the alloc/poke/len/at string-marshalling quartet (wasm-
 * inspect.test.ts's own established pattern for round-tripping a wasm
 * `(mut i16) array` string through the reference-typed JS boundary) and
 * decodes every result back to a plain JS string before returning. */
async function buildAndRunStr(
  exports: { name: string; locals?: (h: Harness) => ValType[]; build: (c: Code, h: Harness) => void }[],
): Promise<Record<string, string>> {
  const h = makeHarness();
  for (const e of exports) {
    const idx = h.mb.declareFunc(h.mb.funcType([], [h.strRef]), e.name);
    const c = new Code();
    e.build(c, h);
    h.mb.setBody(idx, e.locals?.(h) ?? [], c.bytes());
    h.mb.exportFunc(e.name, idx);
  }
  const allocFn = h.mb.declareFunc(h.mb.funcType([I32], [h.strRef]), "alloc");
  h.mb.setBody(
    allocFn,
    [],
    (() => {
      const c = new Code();
      c.localGet(0);
      c.arrayNewDefault(h.strType);
      return c.bytes();
    })(),
  );
  h.mb.exportFunc("alloc", allocFn);
  const pokeFn = h.mb.declareFunc(h.mb.funcType([h.strRef, I32, I32], []), "poke");
  h.mb.setBody(
    pokeFn,
    [],
    (() => {
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.localGet(2);
      c.arraySet(h.strType);
      return c.bytes();
    })(),
  );
  h.mb.exportFunc("poke", pokeFn);
  const lenFn = h.mb.declareFunc(h.mb.funcType([h.strRef], [I32]), "len");
  h.mb.setBody(
    lenFn,
    [],
    (() => {
      const c = new Code();
      c.localGet(0);
      c.arrayLen();
      return c.bytes();
    })(),
  );
  h.mb.exportFunc("len", lenFn);
  const atFn = h.mb.declareFunc(h.mb.funcType([h.strRef, I32], [I32]), "at");
  h.mb.setBody(
    atFn,
    [],
    (() => {
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.arrayGetU(h.strType);
      return c.bytes();
    })(),
  );
  h.mb.exportFunc("at", atFn);
  const bytes = h.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const path = join(scratch, `${exports[0]!.name}-${Math.random().toString(36).slice(2)}.wasm`);
  await writeFile(path, bytes);
  const { instance } = await WebAssembly.instantiate(bytes);
  const ex = instance.exports as {
    len: (r: unknown) => number;
    at: (r: unknown, i: number) => number;
    [k: string]: (...a: unknown[]) => unknown;
  };
  const outOf = (r: unknown): string => {
    const n = ex.len(r);
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCharCode(ex.at(r, i));
    return out;
  };
  const out: Record<string, string> = {};
  for (const e of exports) out[e.name] = outOf(ex[e.name]!());
  return out;
}

/* ── dynIsObject (B.3) — every DK kind, own re-measure ────────────────
 * Own-constructed bare `$dyn{kind, num:0, ref:null}` structs (isObject
 * only reads DYN_KIND, so a bare struct is sufficient — matching
 * wasm-dyn-specifictype.test.ts's own HANDLE/JSVAL technique). Node's
 * real typeof answers "object" for ARR/OBJ/BYTES/PROMISE/HANDLE (a
 * resource kind — Node's own analog, e.g. a Socket, is typeof
 * "object" too) and something else for the rest — FUNC is typeof
 * "function", explicitly excluded (own re-measure, 1770 line 22's own
 * shape). JSVAL is permanently unreachable (0.1) — isObject's own
 * logic does not special-case it; recorded for completeness, not as a
 * reachability claim. ────────────────────────────────────────────── */
test("dyn.isObject: all 12 DK kinds — ARR/OBJ/BYTES/PROMISE/HANDLE true, everything else false", async () => {
  const kinds = Object.entries(DK) as [string, number][];
  const out = await buildAndRun(
    kinds.map(([name, kind]) => ({
      name: `isObj_${name}`,
      build: (c: Code, h: Harness) => {
        c.i32Const(kind);
        c.f64Const(0);
        c.refNull(EQ_HEAP);
        c.structNew(h.dyn.dynT());
        c.call(h.dyn.isObject());
      },
    })),
  );
  const expected: Record<string, number> = {
    NULL: 0,
    BOOL: 0,
    NUM: 0,
    STR: 0,
    ARR: 1,
    OBJ: 1,
    UNDEF: 0,
    BYTES: 1,
    FUNC: 0,
    HANDLE: 1,
    PROMISE: 1,
    // isObject()'s own logic (dyn.ts) ORs exactly ARR/OBJ/BYTES/PROMISE/
    // HANDLE — it does NOT special-case JSVAL, so this is 0 (false),
    // matching the file header's own note ("JSVAL is permanently
    // unreachable ... isObject's own logic does not special-case it").
    JSVAL: 0,
  };
  for (const [name] of kinds) expect(out[`isObj_${name}`], name).toBe(expected[name]);
});

/* ── sameValueDyn (0.3/B.1) ────────────────────────────────────────── */

test("dyn.sameValueDyn: NUM routes to SameValue (NaN matches NaN; +0 does NOT match -0), unlike strictEq's f64.eq", async () => {
  const out = await buildAndRun([
    {
      name: "nanEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(NaN));
        h.dyn.boxNum(c, (x) => x.f64Const(NaN));
        c.call(h.dyn.sameValueDyn());
      },
    },
    {
      name: "zeroEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(0));
        h.dyn.boxNum(c, (x) => x.f64Const(-0));
        c.call(h.dyn.sameValueDyn());
      },
    },
    {
      name: "plainEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(5));
        h.dyn.boxNum(c, (x) => x.f64Const(5));
        c.call(h.dyn.sameValueDyn());
      },
    },
  ]);
  expect(out["nanEq"]).toBe(1);
  expect(out["zeroEq"]).toBe(0);
  expect(out["plainEq"]).toBe(1);
});

test("dyn.sameValueDyn: non-NUM kinds route through strictEq unchanged (own re-measure: STR by content, two DIFFERENT box instances)", async () => {
  const out = await buildAndRun([
    {
      name: "strEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, "hello"));
        h.dyn.boxStr(c, (x) => h.pushStr(x, "hello"));
        c.call(h.dyn.sameValueDyn());
      },
    },
    {
      name: "strNe",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, "hello"));
        h.dyn.boxStr(c, (x) => h.pushStr(x, "world"));
        c.call(h.dyn.sameValueDyn());
      },
    },
    {
      name: "boolEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxBool(c, (x) => x.i32Const(1));
        h.dyn.boxBool(c, (x) => x.i32Const(1));
        c.call(h.dyn.sameValueDyn());
      },
    },
  ]);
  expect(out["strEq"]).toBe(1);
  expect(out["strNe"]).toBe(0);
  expect(out["boolEq"]).toBe(1);
});

test("dyn.sameValueDyn: BYTES payload aliasing (S014's assert-side face) — the SAME concrete bytes<u8> boxed into dyn TWICE is SameValue-true; two structurally-equal but DISTINCT bytes<u8> values are not", async () => {
  // strictEq's BYTES arm (dyn.ts) compares past BOTH box and wrapper
  // layers to the shared `$bytes` payload via `ref.eq` — an IDENTITY
  // check, not a content check (S014's bytes amendment: "crossing
  // twice is === through unknown"). This test's job is to confirm
  // sameValueDyn inherits that identity discipline unchanged for the
  // non-NUM route, and to confirm it is genuinely identity-based
  // rather than accidentally content-based (the "distinct" half).
  const out = await buildAndRun([
    {
      name: "aliasEq",
      // ONE underlying bytes<u8> object (built once into local 1),
      // boxed into `$dyn` TWICE via two independent
      // pushNewBytesPayload + boxBytes calls that both alias the SAME
      // local. Two different boxes, two different wrappers, one
      // shared payload — Node's own `u1 === u2` answer for this shape
      // is true (S014). Two locals: TMP=0 is pushBytesU8's own
      // per-call scratch, KEPT=1 holds the finished value across both
      // boxing calls.
      locals: (h) => [h.bytesRef, h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0,
          KEPT = 1;
        h.pushBytesU8(c, TMP, [1, 2]);
        c.localSet(KEPT);
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => y.localGet(KEPT),
            (y) => y.i32Const(0),
          ),
        );
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => y.localGet(KEPT),
            (y) => y.i32Const(0),
          ),
        );
        c.call(h.dyn.sameValueDyn());
      },
    },
    {
      name: "distinctNe",
      // TWO SEPARATELY-CONSTRUCTED bytes<u8> objects with IDENTICAL
      // content [1, 2] — `TMP` is reused only as pushBytesU8's own
      // per-call scratch (each call mints a fresh object via
      // `newLen`, so reusing the scratch slot sequentially is safe;
      // nothing needs both objects alive at once here since each is
      // boxed immediately after its own construction).
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(0),
          ),
        );
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(0),
          ),
        );
        c.call(h.dyn.sameValueDyn());
      },
    },
  ]);
  expect(out["aliasEq"]).toBe(1);
  expect(out["distinctNe"]).toBe(0);
});

/* ── checkOperatorMorph (B.1a) — own re-measure: `deep` short-circuits
 * to 0 before either operand is inspected; otherwise OBJ-vs-OBJ (both
 * isObject-true) morphs, FUNC-vs-FUNC morphs (the FUNC arm, NOT the
 * isObject arm — isObject excludes FUNC by design), FUNC-vs-OBJ does
 * NOT morph (mixed kinds satisfy neither arm), and NUM-vs-NUM does not
 * morph either (neither arm; the plain scalar default). Bare `$dyn`
 * structs suffice throughout — checkOperatorMorph never reads past
 * DYN_KIND for the isObject arm or the FUNC-identity arm's own
 * DYN_KIND-only comparison (it does not call fnPayload/refEq on
 * FUNC's payload — that's strictEq's job, not this gate's). ──────── */
test("dyn.checkOperatorMorph: deep short-circuits to 0; OBJ/OBJ and FUNC/FUNC morph; FUNC/OBJ and NUM/NUM do not", async () => {
  const out = await buildAndRun([
    {
      name: "objObjMorph",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.OBJ);
        bareDyn(c, dynT, DK.OBJ);
        c.i32Const(0);
        c.call(h.dyn.checkOperatorMorph());
      },
    },
    {
      name: "fnFnMorph",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.FUNC);
        bareDyn(c, dynT, DK.FUNC);
        c.i32Const(0);
        c.call(h.dyn.checkOperatorMorph());
      },
    },
    {
      name: "fnObjNoMorph",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.FUNC);
        bareDyn(c, dynT, DK.OBJ);
        c.i32Const(0);
        c.call(h.dyn.checkOperatorMorph());
      },
    },
    {
      name: "numNumNoMorph",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.NUM);
        bareDyn(c, dynT, DK.NUM);
        c.i32Const(0);
        c.call(h.dyn.checkOperatorMorph());
      },
    },
    {
      name: "deepNeverMorphs",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.OBJ);
        bareDyn(c, dynT, DK.OBJ);
        c.i32Const(1);
        c.call(h.dyn.checkOperatorMorph());
      },
    },
  ]);
  expect(out["objObjMorph"]).toBe(1);
  expect(out["fnFnMorph"]).toBe(1);
  expect(out["fnObjNoMorph"]).toBe(0);
  expect(out["numNumNoMorph"]).toBe(0);
  expect(out["deepNeverMorphs"]).toBe(0);
});

/* ── deepEqDyn (B.2) — scalar kinds ────────────────────────────────────
 * Own re-measure per kind: UNDEF/NULL are kind-gated to true (no value
 * to compare); BOOL compares the shared num slot exactly; NUM routes
 * to SameValue (sameF64, own-injected, NOT strict f64.eq — NaN
 * matches, +0 does not match -0, unlike BOOL's own f64.eq arm just
 * above it in the source); STR compares content across two distinct
 * box+array instances (never box identity). A kind MISMATCH (UNDEF vs
 * NULL) is caught by the universal kind-gate before either scalar arm
 * runs, answering false — included for completeness of the gate, not
 * as a scalar-arm claim. ──────────────────────────────────────────── */
test("dyn.deepEqDyn: scalar kinds — UNDEF/NULL/BOOL/NUM/STR, plus a cross-kind mismatch", async () => {
  const out = await buildAndRun([
    {
      name: "undefEq",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.UNDEF);
        bareDyn(c, dynT, DK.UNDEF);
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "nullEq",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.NULL);
        bareDyn(c, dynT, DK.NULL);
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "undefNullNe",
      build: (c: Code, h: Harness) => {
        const dynT = h.dyn.dynT();
        bareDyn(c, dynT, DK.UNDEF);
        bareDyn(c, dynT, DK.NULL);
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "boolEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxBool(c, (x) => x.i32Const(1));
        h.dyn.boxBool(c, (x) => x.i32Const(1));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "boolNe",
      build: (c: Code, h: Harness) => {
        h.dyn.boxBool(c, (x) => x.i32Const(1));
        h.dyn.boxBool(c, (x) => x.i32Const(0));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "numNanEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(NaN));
        h.dyn.boxNum(c, (x) => x.f64Const(NaN));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "numZeroNe",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(0));
        h.dyn.boxNum(c, (x) => x.f64Const(-0));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "strEq",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, "hello"));
        h.dyn.boxStr(c, (x) => h.pushStr(x, "hello"));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "strNe",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, "hello"));
        h.dyn.boxStr(c, (x) => h.pushStr(x, "world"));
        c.call(h.dyn.deepEqDyn());
      },
    },
  ]);
  expect(out["undefEq"]).toBe(1);
  expect(out["nullEq"]).toBe(1);
  expect(out["undefNullNe"]).toBe(0);
  expect(out["boolEq"]).toBe(1);
  expect(out["boolNe"]).toBe(0);
  expect(out["numNanEq"]).toBe(1);
  expect(out["numZeroNe"]).toBe(0);
  expect(out["strEq"]).toBe(1);
  expect(out["strNe"]).toBe(0);
});

/* ── deepEqDyn — FUNC identity (B.1a/B.2) ──────────────────────────────
 * The FUNC arm compares FN_CLOS by ref.eq — the boxed CLOSURE, never
 * the `$dynFn` payload struct and never the outer `$dyn` box (both of
 * those are boundary artifacts, freshly allocated on every crossing).
 * A bare `$dyn` struct stands in for the closure itself (an opaque
 * `eq` value) — mirroring wasm-dyn-specifictype.test.ts's own
 * decoy-payload idiom; nothing here ever calls through it. */
test("dyn.deepEqDyn: FUNC identity — TWO boxes sharing ONE closure are equal; two DIFFERENT closures are not", async () => {
  const out = await buildAndRun([
    {
      name: "fnAliasEq",
      locals: (h) => [h.dyn.dynRef()],
      build: (c: Code, h: Harness) => {
        const SHARED = 0;
        bareDyn(c, h.dyn.dynT(), DK.UNDEF); // an opaque decoy `eq` value
        c.localSet(SHARED);
        h.dyn.boxFn(
          c,
          (x) => x.localGet(SHARED),
          (x) => x.refNull(h.dyn.thunkSig()),
          0,
          (x) => x.refNull(h.strType),
          0,
        );
        h.dyn.boxFn(
          c,
          (x) => x.localGet(SHARED),
          (x) => x.refNull(h.dyn.thunkSig()),
          0,
          (x) => x.refNull(h.strType),
          0,
        );
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "fnDistinctNe",
      build: (c: Code, h: Harness) => {
        const pushDecoy = (x: Code) => bareDyn(x, h.dyn.dynT(), DK.UNDEF);
        h.dyn.boxFn(
          c,
          pushDecoy,
          (x) => x.refNull(h.dyn.thunkSig()),
          0,
          (x) => x.refNull(h.strType),
          0,
        );
        h.dyn.boxFn(
          c,
          pushDecoy,
          (x) => x.refNull(h.dyn.thunkSig()),
          0,
          (x) => x.refNull(h.strType),
          0,
        );
        c.call(h.dyn.deepEqDyn());
      },
    },
  ]);
  expect(out["fnAliasEq"]).toBe(1);
  expect(out["fnDistinctNe"]).toBe(0);
});

/* ── deepEqDyn — ARR (B.2) ──────────────────────────────────────────── */
test("dyn.deepEqDyn: ARR — equal content, unequal content, length mismatch", async () => {
  const out = await buildAndRun([
    {
      name: "arrEq",
      locals: (h) => [h.dyn.arrRef(), h.dyn.arrRef()],
      build: (c: Code, h: Harness) => {
        const VA = 0,
          VB = 1;
        h.dyn.pushNewArr(c);
        c.localSet(VA);
        c.localGet(VA);
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.arrPush());
        c.localGet(VA);
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.arrPush());
        h.dyn.pushNewArr(c);
        c.localSet(VB);
        c.localGet(VB);
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.arrPush());
        c.localGet(VB);
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.arrPush());
        h.dyn.boxArr(c, (x) => x.localGet(VA));
        h.dyn.boxArr(c, (x) => x.localGet(VB));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "arrNe",
      locals: (h) => [h.dyn.arrRef(), h.dyn.arrRef()],
      build: (c: Code, h: Harness) => {
        const VA = 0,
          VB = 1;
        h.dyn.pushNewArr(c);
        c.localSet(VA);
        c.localGet(VA);
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.arrPush());
        c.localGet(VA);
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.arrPush());
        h.dyn.pushNewArr(c);
        c.localSet(VB);
        c.localGet(VB);
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.arrPush());
        c.localGet(VB);
        h.dyn.boxNum(c, (x) => x.f64Const(3));
        c.call(h.dyn.arrPush());
        h.dyn.boxArr(c, (x) => x.localGet(VA));
        h.dyn.boxArr(c, (x) => x.localGet(VB));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "arrLenMismatch",
      locals: (h) => [h.dyn.arrRef(), h.dyn.arrRef()],
      build: (c: Code, h: Harness) => {
        const VA = 0,
          VB = 1;
        h.dyn.pushNewArr(c);
        c.localSet(VA);
        c.localGet(VA);
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.arrPush());
        h.dyn.pushNewArr(c);
        c.localSet(VB);
        c.localGet(VB);
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.arrPush());
        c.localGet(VB);
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.arrPush());
        h.dyn.boxArr(c, (x) => x.localGet(VA));
        h.dyn.boxArr(c, (x) => x.localGet(VB));
        c.call(h.dyn.deepEqDyn());
      },
    },
  ]);
  expect(out["arrEq"]).toBe(1);
  expect(out["arrNe"]).toBe(0);
  expect(out["arrLenMismatch"]).toBe(0);
});

/* ── deepEqDyn — OBJ (B.2) ──────────────────────────────────────────── */
test("dyn.deepEqDyn: OBJ — equal, key-absent, value-mismatch, null-proto gate, nested", async () => {
  const out = await buildAndRun([
    {
      name: "objEq",
      locals: (h) => [h.dyn.objRef(), h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const OA = 0,
          OB = 1;
        h.dyn.pushNewObj(c, false);
        c.localSet(OA);
        c.localGet(OA);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        c.localGet(OA);
        h.pushStr(c, "b");
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, false);
        c.localSet(OB);
        c.localGet(OB);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        c.localGet(OB);
        h.pushStr(c, "b");
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(OA));
        h.dyn.boxObj(c, (x) => x.localGet(OB));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "objKeyAbsentNe",
      locals: (h) => [h.dyn.objRef(), h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const OA = 0,
          OB = 1;
        h.dyn.pushNewObj(c, false);
        c.localSet(OA);
        c.localGet(OA);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, false);
        c.localSet(OB);
        c.localGet(OB);
        h.pushStr(c, "b");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(OA));
        h.dyn.boxObj(c, (x) => x.localGet(OB));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "objValueMismatchNe",
      locals: (h) => [h.dyn.objRef(), h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const OA = 0,
          OB = 1;
        h.dyn.pushNewObj(c, false);
        c.localSet(OA);
        c.localGet(OA);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, false);
        c.localSet(OB);
        c.localGet(OB);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(OA));
        h.dyn.boxObj(c, (x) => x.localGet(OB));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "objNullProtoGateNe",
      locals: (h) => [h.dyn.objRef(), h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const OA = 0,
          OB = 1;
        h.dyn.pushNewObj(c, false);
        c.localSet(OA);
        c.localGet(OA);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, true); // null-proto — same key/value, different gate
        c.localSet(OB);
        c.localGet(OB);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(OA));
        h.dyn.boxObj(c, (x) => x.localGet(OB));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "objNestedEq",
      locals: (h) => [h.dyn.objRef(), h.dyn.objRef(), h.dyn.objRef(), h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const INNER_A = 0,
          INNER_B = 1,
          OA = 2,
          OB = 3;
        h.dyn.pushNewObj(c, false);
        c.localSet(INNER_A);
        c.localGet(INNER_A);
        h.pushStr(c, "x");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, false);
        c.localSet(INNER_B);
        c.localGet(INNER_B);
        h.pushStr(c, "x");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, false);
        c.localSet(OA);
        c.localGet(OA);
        h.pushStr(c, "a");
        h.dyn.boxObj(c, (x) => x.localGet(INNER_A));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, false);
        c.localSet(OB);
        c.localGet(OB);
        h.pushStr(c, "a");
        h.dyn.boxObj(c, (x) => x.localGet(INNER_B));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(OA));
        h.dyn.boxObj(c, (x) => x.localGet(OB));
        c.call(h.dyn.deepEqDyn());
      },
    },
  ]);
  expect(out["objEq"]).toBe(1);
  expect(out["objKeyAbsentNe"]).toBe(0);
  expect(out["objValueMismatchNe"]).toBe(0);
  expect(out["objNullProtoGateNe"]).toBe(0);
  expect(out["objNestedEq"]).toBe(1);
});

/* ── deepEqDyn — BYTES (B.2, distinct from sameValueDyn's identity
 * route): CONTENT-based (two DIFFERENT bytes<u8> objects, same bytes,
 * are equal), gated first by the isBuffer flag (S014's own gate: a
 * Buffer and a same-content Uint8Array are NOT deepEqual). ────────── */
test("dyn.deepEqDyn: BYTES — content equality across distinct objects, isBuffer gate, content mismatch", async () => {
  const out = await buildAndRun([
    {
      name: "bytesContentEq",
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(0),
          ),
        );
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(0),
          ),
        );
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "bytesIsBufferGateNe",
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(0),
          ),
        );
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(1), // isBuffer — same content, different gate
          ),
        );
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "bytesContentMismatchNe",
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(0),
          ),
        );
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 3]),
            (y) => y.i32Const(0),
          ),
        );
        c.call(h.dyn.deepEqDyn());
      },
    },
  ]);
  expect(out["bytesContentEq"]).toBe(1);
  expect(out["bytesIsBufferGateNe"]).toBe(0);
  expect(out["bytesContentMismatchNe"]).toBe(0);
});

/* ── deepEqDyn — self-cycle (B.4's own caveat, the coinductive step) ───
 * TWO DISTINCT top-level boxes (so the fast ref.eq path can't short-
 * circuit the walk before it starts), each a length-1 array whose
 * SOLE element is a reference back to ITS OWN outer box — a
 * self-referencing singleton. The recursive comparison of element 0
 * re-invokes deepEqDyn on the IDENTICAL (A,B) box pair the outer call
 * is already walking; the memo's job is to recognize that re-entrant
 * pair and answer EQUAL without recursing forever. This file's
 * test-local single-pair memo (see the header) is deliberately built
 * to prove exactly this re-entry shape, not the general N-pair case
 * (P1's own territory, unchanged and reused once P2b wires eqDyn). */
test("dyn.deepEqDyn: a self-referencing singleton array compares equal to another (the coinductive cycle step)", async () => {
  const out = await buildAndRun([
    {
      name: "selfCycleEq",
      locals: (h) => [h.dyn.arrRef(), h.dyn.arrRef(), h.dyn.dynRef(), h.dyn.dynRef()],
      build: (c: Code, h: Harness) => {
        const VA = 0,
          VB = 1,
          BOXA = 2,
          BOXB = 3;
        h.dyn.pushNewArr(c);
        c.localSet(VA);
        h.dyn.pushNewArr(c);
        c.localSet(VB);
        h.dyn.boxArr(c, (x) => x.localGet(VA));
        c.localSet(BOXA);
        h.dyn.boxArr(c, (x) => x.localGet(VB));
        c.localSet(BOXB);
        // Push each outer box as its OWN vector's sole element —
        // literally the same box reference the caller will pass to
        // deepEqDyn below, not a fresh wrapper around the same vector.
        c.localGet(VA);
        c.localGet(BOXA);
        c.call(h.dyn.arrPush());
        c.localGet(VB);
        c.localGet(BOXB);
        c.call(h.dyn.arrPush());
        c.localGet(BOXA);
        c.localGet(BOXB);
        c.call(h.dyn.deepEqDyn());
      },
    },
  ]);
  expect(out["selfCycleEq"]).toBe(1);
});

/* ── deepEqDyn — no leak across REPEATED, independent uses (the
 * mutation-check instrument for B.4's own caveat) ─────────────────────
 * Every export in ONE buildAndRun call shares the SAME module, hence
 * the SAME `top`/memo globals, called in array order — so N
 * INDEPENDENT, non-nested, genuinely-equal OBJ comparisons in a row is
 * a direct sensor for a dropped deqLeave: correct code always returns
 * `top` to 0 after each top-level call, so any number of sequential,
 * non-overlapping comparisons must all answer EQUAL regardless of
 * order; a single leaked deqLeave anywhere in the OBJ (or ARR) success
 * path adds +1 to `top` on EVERY call and never gives it back, so by
 * the MEMO_DEPTH+1'th repetition the leaked stack is already full
 * BEFORE that comparison's own deqEnter runs, and it wrongly answers
 * UNEQUAL — this file's own MEMO_DEPTH is 4, so 5 repetitions is
 * sufficient to expose a leak of exactly one slot per call. (Verified
 * by hand during P2a: temporarily dropping the OBJ arm's final
 * `deqLeave()` call in dyn.ts's production deepEqDyn made repetition
 * #5 here fail — expected 1, got 0 — confirming this pin actually
 * catches the class of bug B.4's caveat exists to prevent; reverted
 * before this pin was left green. Not re-run automatically — mutating
 * production code is a one-time hand-verification step, not part of
 * the standing suite.) */
test("dyn.deepEqDyn: MEMO_DEPTH+1 independent, non-nested OBJ comparisons in a row all report equal (no deqEnter/deqLeave leak)", async () => {
  const REPS = 5; // this file's own MEMO_DEPTH (4) + 1
  const buildOne = (c: Code, h: Harness): void => {
    const OA = 0,
      OB = 1;
    h.dyn.pushNewObj(c, false);
    c.localSet(OA);
    c.localGet(OA);
    h.pushStr(c, "a");
    h.dyn.boxNum(c, (x) => x.f64Const(1));
    c.call(h.dyn.objPut());
    h.dyn.pushNewObj(c, false);
    c.localSet(OB);
    c.localGet(OB);
    h.pushStr(c, "a");
    h.dyn.boxNum(c, (x) => x.f64Const(1));
    c.call(h.dyn.objPut());
    h.dyn.boxObj(c, (x) => x.localGet(OA));
    h.dyn.boxObj(c, (x) => x.localGet(OB));
    c.call(h.dyn.deepEqDyn());
  };
  const out = await buildAndRun(
    Array.from({ length: REPS }, (_, i) => ({
      name: `leakRep${i}`,
      locals: (h: Harness) => [h.dyn.objRef(), h.dyn.objRef()],
      build: buildOne,
    })),
  );
  for (let i = 0; i < REPS; i++) expect(out[`leakRep${i}`], `repetition ${i}`).toBe(1);
});

/* ── cfValue/cfInspect (A.1-A.6) — the renderer, own re-measure against
 * REAL Node under assertion_error.js's own options (ASSERT_INSPECT_
 * OPTS) ──────────────────────────────────────────────────────────── */
test("cfInspect: scalar kinds — UNDEF/NULL/BOOL/NUM, against real Node", async () => {
  const out = await buildAndRunStr([
    {
      name: "undef",
      build: (c: Code, h: Harness) => {
        bareDyn(c, h.dyn.dynT(), DK.UNDEF);
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "nul",
      build: (c: Code, h: Harness) => {
        bareDyn(c, h.dyn.dynT(), DK.NULL);
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "boolTrue",
      build: (c: Code, h: Harness) => {
        h.dyn.boxBool(c, (x) => x.i32Const(1));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "boolFalse",
      build: (c: Code, h: Harness) => {
        h.dyn.boxBool(c, (x) => x.i32Const(0));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "zero",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(0));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "negZero",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(-0));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "nan",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(NaN));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "infinity",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(Infinity));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "negInfinity",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(-Infinity));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "pointOne",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(0.1));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "e21",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(1e21));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "eNeg7",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(1e-7));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "denormMin",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(5e-324));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "maxVal",
      build: (c: Code, h: Harness) => {
        h.dyn.boxNum(c, (x) => x.f64Const(1.7976931348623157e308));
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  expect(out["undef"]).toBe(inspect(undefined, ASSERT_INSPECT_OPTS));
  expect(out["nul"]).toBe(inspect(null, ASSERT_INSPECT_OPTS));
  expect(out["boolTrue"]).toBe(inspect(true, ASSERT_INSPECT_OPTS));
  expect(out["boolFalse"]).toBe(inspect(false, ASSERT_INSPECT_OPTS));
  expect(out["zero"]).toBe(inspect(0, ASSERT_INSPECT_OPTS));
  expect(out["negZero"]).toBe(inspect(-0, ASSERT_INSPECT_OPTS));
  expect(out["nan"]).toBe(inspect(NaN, ASSERT_INSPECT_OPTS));
  expect(out["infinity"]).toBe(inspect(Infinity, ASSERT_INSPECT_OPTS));
  expect(out["negInfinity"]).toBe(inspect(-Infinity, ASSERT_INSPECT_OPTS));
  expect(out["pointOne"]).toBe(inspect(0.1, ASSERT_INSPECT_OPTS));
  expect(out["e21"]).toBe(inspect(1e21, ASSERT_INSPECT_OPTS));
  expect(out["eNeg7"]).toBe(inspect(1e-7, ASSERT_INSPECT_OPTS));
  expect(out["denormMin"]).toBe(inspect(5e-324, ASSERT_INSPECT_OPTS));
  expect(out["maxVal"]).toBe(inspect(1.7976931348623157e308, ASSERT_INSPECT_OPTS));
});

test("cfInspect: STR — content, quoting ladder, indent-0 handoff (A.3)", async () => {
  const out = await buildAndRunStr([
    {
      name: "plain",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, "hello"));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "squote",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, "a'b"));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "empty",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, ""));
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  expect(out["plain"]).toBe(inspect("hello", ASSERT_INSPECT_OPTS));
  expect(out["squote"]).toBe(inspect("a'b", ASSERT_INSPECT_OPTS));
  expect(out["empty"]).toBe(inspect("", ASSERT_INSPECT_OPTS));
});

test("cfInspect: FUNC — named and anonymous (A.2)", async () => {
  const out = await buildAndRunStr([
    {
      name: "named",
      build: (c: Code, h: Harness) => {
        h.dyn.boxFn(
          c,
          (x) => x.refNull(h.dyn.dynT()),
          (x) => x.refNull(h.dyn.thunkSig()),
          0,
          (x) => h.pushStr(x, "named"),
          0,
        );
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "anon",
      build: (c: Code, h: Harness) => {
        h.dyn.boxFn(
          c,
          (x) => x.refNull(h.dyn.dynT()),
          (x) => x.refNull(h.dyn.thunkSig()),
          0,
          (x) => x.refNull(h.strType),
          0,
        );
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  // Own Node-side oracle: a factory-returned function has no inferred
  // name (own re-check, plan.txt 2a — `const anon = () => {}` WOULD get
  // name inference from its binding, which is why this uses a factory).
  function makeNamed() {
    return function named() {
      /* noop */
    };
  }
  function makeAnon() {
    return [function () {
      /* noop */
    }][0];
  }
  expect(out["named"]).toBe(inspect(makeNamed(), ASSERT_INSPECT_OPTS));
  expect(out["anon"]).toBe(inspect(makeAnon(), ASSERT_INSPECT_OPTS));
});

test("cfInspect: BYTES — empty/nonempty, Uint8Array vs Buffer flavour (A.2)", async () => {
  const out = await buildAndRunStr([
    {
      name: "u8Empty",
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, []),
            (y) => y.i32Const(0),
          ),
        );
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "u8Two",
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(0),
          ),
        );
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "bufTwo",
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, [1, 2]),
            (y) => y.i32Const(1),
          ),
        );
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "bufEmpty",
      locals: (h) => [h.bytesRef],
      build: (c: Code, h: Harness) => {
        const TMP = 0;
        h.dyn.boxBytes(c, (x) =>
          h.dyn.pushNewBytesPayload(
            x,
            (y) => h.pushBytesU8(y, TMP, []),
            (y) => y.i32Const(1),
          ),
        );
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  expect(out["u8Empty"]).toBe(inspect(new Uint8Array([]), ASSERT_INSPECT_OPTS));
  expect(out["u8Two"]).toBe(inspect(new Uint8Array([1, 2]), ASSERT_INSPECT_OPTS));
  expect(out["bufTwo"]).toBe(inspect(Buffer.from([1, 2]), ASSERT_INSPECT_OPTS));
  expect(out["bufEmpty"]).toBe(inspect(Buffer.from([]), ASSERT_INSPECT_OPTS));
});

test("cfInspect: ARR — empty, numeric, nested composite (A.2)", async () => {
  const out = await buildAndRunStr([
    {
      name: "empty",
      build: (c: Code, h: Harness) => {
        h.dyn.boxArr(c, (x) => h.dyn.pushNewArr(x));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "nums",
      locals: (h) => [h.dyn.arrRef()],
      build: (c: Code, h: Harness) => {
        const V = 0;
        h.dyn.pushNewArr(c);
        c.localSet(V);
        c.localGet(V);
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.arrPush());
        c.localGet(V);
        h.dyn.boxNum(c, (x) => x.f64Const(2));
        c.call(h.dyn.arrPush());
        h.dyn.boxArr(c, (x) => x.localGet(V));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "nested",
      locals: (h) => [h.dyn.arrRef(), h.dyn.arrRef(), h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const V = 0,
          INNER = 1,
          O = 2;
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.pushNewArr(c);
        c.localSet(INNER);
        h.dyn.pushNewArr(c);
        c.localSet(V);
        c.localGet(V);
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.call(h.dyn.arrPush());
        c.localGet(V);
        h.dyn.boxArr(c, (x) => x.localGet(INNER));
        c.call(h.dyn.arrPush());
        h.dyn.boxArr(c, (x) => x.localGet(V));
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  expect(out["empty"]).toBe(inspect([], ASSERT_INSPECT_OPTS));
  expect(out["nums"]).toBe(inspect([1, 2], ASSERT_INSPECT_OPTS));
  expect(out["nested"]).toBe(inspect([{ a: 1 }, []], ASSERT_INSPECT_OPTS));
});

test("cfInspect: OBJ — empty, null-proto, key sort (full-entry-text, not key-only), nested (A.2/A.4)", async () => {
  const out = await buildAndRunStr([
    {
      name: "empty",
      build: (c: Code, h: Harness) => {
        h.dyn.boxObj(c, (x) => h.dyn.pushNewObj(x, false));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "simple",
      locals: (h) => [h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const O = 0;
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "nullProtoEmpty",
      build: (c: Code, h: Harness) => {
        h.dyn.boxObj(c, (x) => h.dyn.pushNewObj(x, true));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "nullProto",
      locals: (h) => [h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const O = 0;
        h.dyn.pushNewObj(c, true);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.call(h.insp.cfInspect());
      },
    },
    {
      // A.4's own ndse-51 proof: comparing KEYS "k1" < "k10" would put
      // k1 first; comparing ENTRY TEXTS "k1: 1" vs "k10: 10" compares
      // ':' (0x3A) against '0' (0x30) at index 2 and puts k10 first.
      name: "ndse",
      locals: (h) => [h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const O = 0;
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        for (const [k, v] of [
          ["k0", 0],
          ["k1", 1],
          ["k10", 10],
          ["k11", 11],
        ] as const) {
          c.localGet(O);
          h.pushStr(c, k);
          h.dyn.boxNum(c, (x) => x.f64Const(v));
          c.call(h.dyn.objPut());
        }
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "nested",
      locals: (h) => [h.dyn.objRef(), h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const INNER = 0,
          O = 1;
        h.dyn.pushNewObj(c, false);
        c.localSet(INNER);
        c.localGet(INNER);
        h.pushStr(c, "x");
        h.dyn.boxNum(c, (x) => x.f64Const(1));
        c.call(h.dyn.objPut());
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        h.dyn.boxObj(c, (x) => x.localGet(INNER));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  expect(out["empty"]).toBe(inspect({}, ASSERT_INSPECT_OPTS));
  expect(out["simple"]).toBe(inspect({ a: 1 }, ASSERT_INSPECT_OPTS));
  expect(out["nullProtoEmpty"]).toBe(inspect(Object.create(null), ASSERT_INSPECT_OPTS));
  const nullProtoObj = Object.create(null) as Record<string, number>;
  nullProtoObj["a"] = 1;
  expect(out["nullProto"]).toBe(inspect(nullProtoObj, ASSERT_INSPECT_OPTS));
  expect(out["ndse"]).toBe(inspect({ k0: 0, k1: 1, k10: 10, k11: 11 }, ASSERT_INSPECT_OPTS));
  expect(out["nested"]).toBe(inspect({ a: { x: 1 } }, ASSERT_INSPECT_OPTS));
});

/* ── cfInspect: the depth-elision MECHANISM (A.1, own-resolved) ────────
 * Real Node CANNOT be the oracle for this specific shape: own
 * re-measurement (plan.txt 2b) found that `inspect(nestObj(1000, leaf),
 * { depth: 1000, ...assertion_error's other options })` already hits
 * Node's OWN V8 stack-exhaustion safety net (the SAME phenomenon
 * SEMANTICS.md's S029 documents for the console.log walker) before the
 * `rt > 1000` boundary the `depth: 1000` OPTION would otherwise draw
 * ever gets evaluated — so a 1001-level chain built via ordinary JS
 * recursion never reaches a clean "[Object]" elision on this Node
 * build; it hits Node's own "Inspection interrupted prematurely..."
 * text instead, at an unpredictable, stack-dependent depth. This pin's
 * oracle is therefore the SPEC ITSELF (assertion_error.js's literal
 * `depth: 1000` option, ported faithfully as `rt > 1000`), not a live
 * Node comparison — built via a WASM-SIDE LOOP (not JS recursion), so
 * only the WASM CALL STACK is exercised, never Node's. This is exactly
 * why ASSERT_RENDER_DEPTH_OPTION is its own constant, independent of
 * MAX_DYN_DEPTH (inspect.ts's own comment on it has the full account,
 * cross-referenced by the pending P2a S-entry, drafted in plan.txt). */
test("cfInspect: depth elision fires past rt=1000 for a genuinely 1002-level chain (own spec-derived oracle, not Node)", async () => {
  const out = await buildAndRunStr([
    {
      name: "deep",
      locals: (h) => [h.dyn.objRef(), h.dyn.dynRef(), I32],
      build: (c: Code, h: Harness) => {
        const O = 0,
          CUR = 1,
          I = 2;
        // 1002 wraps, NOT 1001: the leaf is a NUM, which NEVER elides
        // (A.2: "str/num/emptyobj/emptyarr ... never elide") — so the
        // OBJECT immediately wrapping it must itself be the one
        // evaluated past the boundary. With N wraps, that innermost
        // object is rendered at rt=N-1, so N=1001 lands it AT rt=1000
        // (not > 1000, own first-pass bug caught by running this
        // pin) — N=1002 lands it at rt=1001, past the boundary.
        h.dyn.boxNum(c, (x) => x.f64Const(42));
        c.localSet(CUR);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.i32Const(1002);
        c.i32GeS();
        c.brIf(1);
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        c.localGet(CUR);
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.localSet(CUR);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(CUR);
        c.call(h.insp.cfInspect());
      },
    },
    {
      // The SAME construction with ONE FEWER wrap (1001, not 1002) —
      // the boundary's other side: the innermost object is now
      // rendered at rt=1000 exactly (not > 1000), so it must render
      // the leaf in full, no elision. Own spec-derived oracle for the
      // same reason as "deep" above.
      name: "atBoundary",
      locals: (h) => [h.dyn.objRef(), h.dyn.dynRef(), I32],
      build: (c: Code, h: Harness) => {
        const O = 0,
          CUR = 1,
          I = 2;
        h.dyn.boxNum(c, (x) => x.f64Const(42));
        c.localSet(CUR);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.i32Const(1001);
        c.i32GeS();
        c.brIf(1);
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        c.localGet(CUR);
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.localSet(CUR);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(CUR);
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  // 1002 wraps: elides to "[Object]" at the point rt exceeds 1000; the
  // leaf ("42") is unreachable past the elision.
  expect(out["deep"]!.includes("[Object]")).toBe(true);
  expect(out["deep"]!.includes("42")).toBe(false);
  // 1001 wraps: rt never exceeds 1000, so the leaf renders in full.
  expect(out["atBoundary"]!.includes("[Object]")).toBe(false);
  expect(out["atBoundary"]!.includes("42")).toBe(true);
});

/* ── cfValue: HANDLE/PROMISE/JSVAL are BARE unreachable traps (A.5) ────
 * None is constructible reaching this call on this tier (JSVAL never,
 * 0.1; HANDLE has no producer; PROMISE's producer cannot reach eqDyn —
 * design-p2.txt A.5's own reach claim), so a bare struct with the
 * right DK kind is a faithful enough construction to prove the ARM
 * traps rather than silently borrowing another kind's answer —
 * mirroring wasm-bytes-validate.test.ts's own trap-testing pattern
 * (a raw `WebAssembly.instantiate` + an expected throw, not the
 * buildAndRunStr runner, which assumes every export returns cleanly). */
test("cfInspect: HANDLE, PROMISE, JSVAL all trap with 'unreachable' (A.5, no placeholder)", async () => {
  const h = makeHarness();
  const dynT = h.dyn.dynT();
  for (const [name, kind] of [
    ["handle", DK.HANDLE],
    ["promise", DK.PROMISE],
    ["jsval", DK.JSVAL],
  ] as const) {
    const idx = h.mb.declareFunc(h.mb.funcType([], [h.strRef]), name);
    const c = new Code();
    bareDyn(c, dynT, kind);
    c.call(h.insp.cfInspect());
    h.mb.setBody(idx, [], c.bytes());
    h.mb.exportFunc(name, idx);
  }
  const bytes = h.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const { instance } = await WebAssembly.instantiate(bytes);
  const ex = instance.exports as { handle: () => unknown; promise: () => unknown; jsval: () => unknown };
  expect(() => ex.handle()).toThrow(/unreachable/);
  expect(() => ex.promise()).toThrow(/unreachable/);
  expect(() => ex.jsval()).toThrow(/unreachable/);
});

/** The OS thread stack limit in KB, or `Infinity` for "unlimited" — read
 * via `ulimit -s` (a shell builtin, hence `bash -c`, not a standalone
 * executable). Used to gate the real-boundary pin below: SEMANTICS.md
 * S057's own fix-round finding (rev-23, F2-p2a) is that `--stack-size`
 * ABOVE the OS thread stack does not raise a catchable RangeError — V8
 * does not detect the overflow before the OS does, and the CHILD
 * PROCESS SEGFAULTS (rc=139) instead. Requiring the OS stack to be
 * comfortably above the chosen `--stack-size` (4x, with margin) avoids
 * ever attempting the raised-stack run on a host where it would crash
 * rather than fail loudly. */
function stackLimitKB(): number {
  const r = spawnSync("bash", ["-c", "ulimit -s"], { encoding: "utf8" });
  const out = r.stdout.trim();
  return out === "unlimited" ? Infinity : Number(out);
}

/* ── cfInspect: THE REAL NODE BOUNDARY, at a raised stack size (P-1(e),
 * fix round F2-p2a) ───────────────────────────────────────────────────
 * SEMANTICS.md S057 (as corrected this fix round): at the DEFAULT V8
 * stack size Node cannot reach the depth:1000 gate via ordinary nesting
 * — its own stack exhausts first, at an unstable, non-reproducible-
 * across-hosts point (own re-measured boundary this pass: n=928 full /
 * n=929 interrupted, isolated binary search, three consistent runs —
 * see S057 for the full account and the chain convention). At a RAISED
 * stack size (`node --stack-size=1200`), Node reaches the REAL gate
 * cleanly: n=1000 renders the leaf in full, n=1001 elides to
 * "[Object]" (own re-measured, `depth-search.mjs`'s `raised-gate` mode,
 * one process per row). This pin is the first one in this file that
 * compares cfInspect's OWN output against Node AT THE REAL THRESHOLD,
 * not a mutated one, using that raised stack as the oracle.
 *
 * CHAIN CONVENTION (S057's own): `n` counts WRAPPER objects placed
 * AROUND a leaf object — `let o = {leaf:1}; for(...) o = {a:o};` — so
 * the leaf sits at depth `n`, and the leaf itself (a genuine OBJECT,
 * not a NUM — unlike the spec-derived pin above, which uses a NUM leaf
 * specifically BECAUSE numbers never elide) is what crosses the
 * boundary at rt=n.
 *
 * SAFETY (the reviewer's own measured hazard, addendum 2):
 * `--stack-size` above the OS thread stack limit does not raise a
 * catchable RangeError — the process SEGFAULTS. Gated on `stackLimitKB
 * () >= 4 * 1200` (a defensible margin, per the reviewer's own
 * recommendation) — SKIPPED BY NAME otherwise. Positive control (own
 * hand-verification, run once per this fix round, not automated):
 * `bash -c 'ulimit -s 1024 && …vitest run … -t "real Node boundary"'`
 * — the gate reads 1024 < 4800 and SKIPS by the named reason; it does
 * NOT attempt the raised-stack spawn and does NOT segfault.
 *
 * THE 4x MARGIN IS DELIBERATELY CONSERVATIVE, NOT A CRASH-BOUNDARY
 * MEASUREMENT (lead addendum to DECISION v1 F2-p2a): the reviewer's
 * own measured crash boundary for `--stack-size=1200` sits BETWEEN
 * ulimit 1024 and 2048 specifically (1024 and 512 segfault, rc=139;
 * 2048 and 8192 run clean) — well inside this gate's own 4800KB
 * floor. A host at ulimit 2048 therefore SKIPS this pin even though
 * it would, in fact, have run cleanly. A SKIP means "the gate was not
 * cleared", NEVER "this host would have crashed" — the two are not
 * the same claim, and the margin exists precisely so the gate does
 * not need to sit exactly on the measured edge to stay safe. This
 * machine's own OS stack limit (8192KB) clears the gate and runs the
 * real comparison; it does not merely skip past the hazard. */
test("cfInspect: real Node boundary at a raised stack size (n=1000/1001 straddle, --stack-size=1200)", async (ctx) => {
  const REQUIRED_STACK_KB = 4 * 1200;
  const stackKB = stackLimitKB();
  if (!(stackKB >= REQUIRED_STACK_KB)) {
    ctx.skip(`OS stack limit ${stackKB === Infinity ? "unlimited" : stackKB + "KB"} — need >= ${REQUIRED_STACK_KB}KB (4x --stack-size=1200) to raise the V8 stack without risking a SIGSEGV`);
    return;
  }

  const nodeInspect = (n: number): string => {
    const script = `
      import { inspect } from "node:util";
      const OPTS = ${JSON.stringify(ASSERT_INSPECT_OPTS)};
      function nestObj(n, leafVal) { let v = leafVal; for (let i = 0; i < n; i++) v = { a: v }; return v; }
      process.stdout.write(JSON.stringify(inspect(nestObj(${n}, { leaf: 1 }), OPTS)));
    `;
    const scriptPath = join(scratch, `real-boundary-${n}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(scriptPath, script);
    // maxBuffer: the FULL (non-elided) n=1000 render is ~2MB (quadratic
    // indentation growth from 1000 levels of "{ a: ... }" wrapping,
    // the same shape S057 documents) — spawnSync's 1MB default silently
    // SIGTERMs the child once exceeded, which a first pass here caught
    // (own re-check: the child produced 0 stdout under the default
    // limit, misread at first as a genuine crash before the actual
    // cause — an undersized buffer, not a stack fault — was found).
    const r = spawnSync(process.execPath, ["--stack-size=1200", scriptPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    // Assert the child exited 0 with PARSEABLE stdout BEFORE
    // interpreting anything — a SIGSEGV (rc=139/null status with a
    // signal) must fail loudly as exactly that, never be silently
    // read as "no elision" by a naive substring check on empty output.
    expect(r.status, `child exit status for n=${n} (signal: ${r.signal})`).toBe(0);
    let parsed: string;
    expect(() => {
      parsed = JSON.parse(r.stdout) as string;
    }, `child stdout for n=${n} must be valid JSON: ${JSON.stringify(r.stdout)}`).not.toThrow();
    return parsed!;
  };

  const wasmInspect = async (n: number): Promise<string> => {
    const out = await buildAndRunStr([
      {
        name: "chain",
        locals: (h) => [h.dyn.objRef(), h.dyn.dynRef(), I32],
        build: (c: Code, h: Harness) => {
          const O = 0,
            CUR = 1,
            I = 2;
          // The leaf is a genuine OBJECT ({leaf: 1}), not a NUM — the
          // straddle sits at rt=n exactly for an object leaf (S057's
          // own raised-gate measurement), one level earlier than the
          // spec-derived pin's NUM-leaf construction needs.
          h.dyn.pushNewObj(c, false);
          c.localSet(O);
          c.localGet(O);
          h.pushStr(c, "leaf");
          h.dyn.boxNum(c, (x) => x.f64Const(1));
          c.call(h.dyn.objPut());
          h.dyn.boxObj(c, (x) => x.localGet(O));
          c.localSet(CUR);
          c.i32Const(0);
          c.localSet(I);
          c.block();
          c.loop();
          c.localGet(I);
          c.i32Const(n);
          c.i32GeS();
          c.brIf(1);
          h.dyn.pushNewObj(c, false);
          c.localSet(O);
          c.localGet(O);
          h.pushStr(c, "a");
          c.localGet(CUR);
          c.call(h.dyn.objPut());
          h.dyn.boxObj(c, (x) => x.localGet(O));
          c.localSet(CUR);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
          c.br(0);
          c.end();
          c.end();
          c.localGet(CUR);
          c.call(h.insp.cfInspect());
        },
      },
    ]);
    return out["chain"]!;
  };

  for (const n of [1000, 1001]) {
    const oracle = nodeInspect(n);
    const actual = await wasmInspect(n);
    expect(actual, `n=${n} (chain convention: ${n} wrappers around {leaf:1})`).toBe(oracle);
  }
});

/* ── cfInspect: the STR arm's INDENT HANDOFF (A.3(b), P-2, fix round
 * F2-p2a) — cfValue must set indentGlobal to ITS OWN current indent
 * BEFORE calling insp.str, so the split gate (indent-independent
 * literal `insp.str` itself owns) and the continuation indent (which
 * DOES depend on nesting) both land at the right column. `insp.str`'s
 * OWN split gate is already pinned (wasm-inspect.test.ts) by calling
 * it directly with indentGlobal pre-set — what neither that pin NOR
 * any pin in this file previously covered was cfValue's OWN handoff of
 * ITS current indent to that call. own re-measurement (not
 * transcribed): nesting 0 splits a newline-bearing string at raw
 * length 77, not 76 (threshold 80-0-4=76); nesting 1 (one level inside
 * an object) splits at 75, not 74 (threshold 80-2-4=74), with a
 * 4-space continuation (indentationLvl 2, +2). ─────────────────────── */
test("cfInspect: STR arm's indent handoff — nesting-1 straddle (P-2, own re-measurement against real Node)", async () => {
  // A newline sits 6 units from the end, matching the design's own
  // straddle-probe shape.
  const mkStr = (len: number): string => "x".repeat(len - 6) + "\n" + "y".repeat(5);
  const out = await buildAndRunStr([
    {
      name: "n0Full",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, mkStr(76)));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "n0Split",
      build: (c: Code, h: Harness) => {
        h.dyn.boxStr(c, (x) => h.pushStr(x, mkStr(77)));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "n1Full",
      locals: (h) => [h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const O = 0;
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        h.dyn.boxStr(c, (x) => h.pushStr(x, mkStr(74)));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.call(h.insp.cfInspect());
      },
    },
    {
      name: "n1Split",
      locals: (h) => [h.dyn.objRef()],
      build: (c: Code, h: Harness) => {
        const O = 0;
        h.dyn.pushNewObj(c, false);
        c.localSet(O);
        c.localGet(O);
        h.pushStr(c, "a");
        h.dyn.boxStr(c, (x) => h.pushStr(x, mkStr(75)));
        c.call(h.dyn.objPut());
        h.dyn.boxObj(c, (x) => x.localGet(O));
        c.call(h.insp.cfInspect());
      },
    },
  ]);
  expect(out["n0Full"]).toBe(inspect(mkStr(76), ASSERT_INSPECT_OPTS));
  expect(out["n0Split"]).toBe(inspect(mkStr(77), ASSERT_INSPECT_OPTS));
  expect(out["n1Full"]).toBe(inspect({ a: mkStr(74) }, ASSERT_INSPECT_OPTS));
  expect(out["n1Split"]).toBe(inspect({ a: mkStr(75) }, ASSERT_INSPECT_OPTS));
});

/* ── deepEqDyn: the test-local memo's EXHAUSTION (verdict 2) arm, ON
 * BOTH the ARR and OBJ walks (P-3, fix round F2-p2a) ───────────────
 * MEMO_DEPTH is 4 slots. Five levels of PURE-kind nesting (all OBJ, or
 * all ARR) accumulate five ACTIVE, unpopped deqEnter frames before any
 * deqLeave runs (each level's own deqEnter/deqLeave pair only closes
 * AFTER its full subtree — including all deeper levels — returns), so
 * the FIFTH level's own deqEnter call sees all 4 slots already
 * occupied by genuinely DIFFERENT (non-matching) pairs and hits the
 * exhaustion branch: verdict 2, i.e. UNEQUAL, regardless of what the
 * comparison would otherwise have found. Both chains below are
 * STRUCTURALLY IDENTICAL (same shape, same leaf value) — a REAL
 * unbounded memo would answer EQUAL, and DOES once P2b wires eqDyn
 * end-to-end; this stub's job is only to prove the exhaustion branch
 * is reached and its verdict is correctly consumed by EACH arm, which
 * is why the WRONG (but fully documented) answer here is the pin's
 * OWN expectation, not a bug. */
test("deepEqDyn: memo exhaustion (verdict 2) reached and correctly consumed on BOTH the OBJ and ARR walks (P-3)", async () => {
  const NEST_PAST_MEMO_DEPTH = 5; // MEMO_DEPTH (4) + 1
  const out = await buildAndRun([
    {
      name: "objExhausted",
      locals: (h) => Array.from({ length: NEST_PAST_MEMO_DEPTH * 2 }, () => h.dyn.objRef()),
      build: (c: Code, h: Harness) => {
        // Build TWO independent, structurally-identical N-level chains
        // of {a: ...} objects (leaf: {a: 1}), innermost first so each
        // outer object can reference the one built just before it.
        const build = (base: number): void => {
          h.dyn.pushNewObj(c, false);
          c.localSet(base);
          c.localGet(base);
          h.pushStr(c, "a");
          h.dyn.boxNum(c, (x) => x.f64Const(1));
          c.call(h.dyn.objPut());
          for (let i = 1; i < NEST_PAST_MEMO_DEPTH; i++) {
            h.dyn.pushNewObj(c, false);
            c.localSet(base + i);
            c.localGet(base + i);
            h.pushStr(c, "a");
            h.dyn.boxObj(c, (x) => x.localGet(base + i - 1));
            c.call(h.dyn.objPut());
          }
        };
        build(0);
        build(NEST_PAST_MEMO_DEPTH);
        h.dyn.boxObj(c, (x) => x.localGet(NEST_PAST_MEMO_DEPTH - 1));
        h.dyn.boxObj(c, (x) => x.localGet(NEST_PAST_MEMO_DEPTH * 2 - 1));
        c.call(h.dyn.deepEqDyn());
      },
    },
    {
      name: "arrExhausted",
      locals: (h) => Array.from({ length: NEST_PAST_MEMO_DEPTH * 2 }, () => h.dyn.arrRef()),
      build: (c: Code, h: Harness) => {
        const build = (base: number): void => {
          h.dyn.pushNewArr(c);
          c.localSet(base);
          c.localGet(base);
          h.dyn.boxNum(c, (x) => x.f64Const(1));
          c.call(h.dyn.arrPush());
          for (let i = 1; i < NEST_PAST_MEMO_DEPTH; i++) {
            h.dyn.pushNewArr(c);
            c.localSet(base + i);
            c.localGet(base + i);
            h.dyn.boxArr(c, (x) => x.localGet(base + i - 1));
            c.call(h.dyn.arrPush());
          }
        };
        build(0);
        build(NEST_PAST_MEMO_DEPTH);
        h.dyn.boxArr(c, (x) => x.localGet(NEST_PAST_MEMO_DEPTH - 1));
        h.dyn.boxArr(c, (x) => x.localGet(NEST_PAST_MEMO_DEPTH * 2 - 1));
        c.call(h.dyn.deepEqDyn());
      },
    },
  ]);
  // The stub's DOCUMENTED, wrong-but-proven-reached answer: exhaustion
  // fires before either walk can find the (genuinely equal) leaves.
  expect(out["objExhausted"], "OBJ arm's verdict-2 consumption").toBe(0);
  expect(out["arrExhausted"], "ARR arm's verdict-2 consumption").toBe(0);
});
