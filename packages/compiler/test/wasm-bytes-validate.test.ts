/* The typedarrays.ts (BytesBuilder) helper surface, force-emitted directly
 * against ModuleBuilder — NOT through TS compilation. A sweep that only
 * compiles TS source only forces the (elem, method) combinations the
 * LOWERING actually routes (u8-only join/with/toReversed/equals; non-u8-
 * only fillElem) — a bug in an arm the frontend never reaches (e.g.
 * withHelper("f32"), which no lowering ever constructs since `.with()`
 * gates to u8 receivers) would be invisible to that sweep. This file
 * calls every BytesBuilder method across every BytesElem UNCONDITIONALLY,
 * bypassing the frontend/lowering gates entirely, and asserts the emitted
 * module is a VALID wasm module (WebAssembly.validate) and instantiates
 * cleanly — the check that would have caught A1 (equalsHelper's local-
 * type bug: `compile()` reported success; only an explicit
 * WebAssembly.validate call on the actually-emitted bytes catches an
 * invalid module). Deps are minimal STRUCTURAL stubs (wrong behavior,
 * right types) — this file checks shape, not semantics; wasm-emitter.
 * test.ts's bytes tests cover behavior. */
import { expect, test } from "vitest";
import { VecBuilder } from "../src/backend/wasm/arrays.js";
import { Code } from "../src/backend/wasm/code.js";
import { DynBuilder } from "../src/backend/wasm/dyn.js";
import { InspectBuilder } from "../src/backend/wasm/inspect.js";
import { JsonBuilder } from "../src/backend/wasm/json.js";
import { F64, I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { BytesBuilder, type BytesElem } from "../src/backend/wasm/typedarrays.js";

test("typedarrays.ts: every BytesBuilder helper, every elem kind, emits a VALID module (direct, bypassing the frontend)", async () => {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };

  // Trivial structural stubs — right types, wrong (irrelevant) behavior.
  const strEqFn = mb.declareFunc(mb.funcType([strRef, strRef], [I32]), "%stub.strEq");
  mb.setBody(strEqFn, [], (() => {
    const c = new Code();
    c.i32Const(1);
    return c.bytes();
  })());
  const f64ToStrFn = mb.declareFunc(mb.funcType([F64], [strRef]), "%stub.f64ToStr");
  mb.setBody(f64ToStrFn, [], (() => {
    const c = new Code();
    c.refNull(strType);
    return c.bytes();
  })());
  const concatFn = mb.declareFunc(mb.funcType([strRef, strRef], [strRef]), "%stub.concat");
  mb.setBody(concatFn, [], (() => {
    const c = new Code();
    c.localGet(0);
    return c.bytes();
  })());
  const toInt32Fn = mb.declareFunc(mb.funcType([F64], [I32]), "%stub.toInt32");
  mb.setBody(toInt32Fn, [], (() => {
    const c = new Code();
    c.i32Const(0);
    return c.bytes();
  })());
  const strSliceFn = mb.declareFunc(mb.funcType([strRef, F64, F64], [strRef]), "%stub.strSlice");
  mb.setBody(strSliceFn, [], (() => {
    const c = new Code();
    c.localGet(0);
    return c.bytes();
  })());
  const lit = (c: Code, _s: string): void => c.refNull(strType);

  const vecs = new VecBuilder(mb, {
    strEq: () => strEqFn,
    f64ToStr: () => f64ToStrFn,
    concat: () => concatFn,
    lit,
  });
  const f64VecInfo = vecs.info("vec(f64)", F64, F64, "f64");

  const bytesB = new BytesBuilder(mb, {
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    strRef: () => strRef,
    strType: () => strType,
    toInt32: () => toInt32Fn,
    strSlice: () => strSliceFn,
    f64Vec: () => f64VecInfo,
    f64VecNewLen: () => vecs.newLen(f64VecInfo),
    f64VecPush1: () => vecs.pushOne(f64VecInfo),
    // Self-referencing closure: bytesVec is only ever CALLED later (once
    // `bytesB` is fully assigned below), never during construction, so
    // capturing `bytesB` here is safe — the same pattern emitter.ts uses.
    bytesVec: () => vecs.info("vec(bytes:u8)", bytesB.bytesRef(), bytesB.bytesRef(), "ref"),
    // Consume whatever pushMessage produced and keep the stack balanced —
    // this stub never actually sets an exception cell (there is none
    // here), it only needs to be STRUCTURALLY valid at the call site.
    throwError: (c, _className, _name, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
  });

  const elems: BytesElem[] = ["u8", "u32", "i32", "f32"];
  for (const elem of elems) {
    // Every method the design doc scopes to stage A, called UNCONDITIONALLY
    // — including combinations the lowering never constructs (with/
    // toReversed/join on non-u8; fillElem on u8), which is the entire point.
    bytesB.byteLength(elem);
    bytesB.get(elem);
    bytesB.setElem(elem);
    bytesB.newLen(elem);
    bytesB.fromArrLit(elem);
    bytesB.sliceHelper(elem);
    bytesB.subarrayHelper(elem);
    bytesB.setFromHelper(elem);
    bytesB.toArrayHelper(elem);
    bytesB.joinHelper(elem);
    bytesB.withHelper(elem);
    bytesB.toReversedHelper(elem);
    bytesB.fillElemHelper(elem);
  }
  // Elem-kind-independent — interned once regardless of the loop above.
  bytesB.length();
  bytesB.byteOffset();
  bytesB.equalsHelper();
  // Stage B: the encoding surface, both directions, every encoding —
  // toString(enc) is u8-only at the lowering, but (like the elem sweep
  // above) this file calls every combination unconditionally.
  const encodings = ["hex", "base64", "base64url", "latin1", "ascii", "utf16le", "utf8"];
  for (const enc of encodings) {
    bytesB.toStrHelper(enc);
    bytesB.fromStrHelper(enc);
  }
  // Stage B: the fixed-width integer readNum/writeNum family (f32/f64
  // kinds are follow-up work — named-refused at the emitter, never built).
  const numKinds = ["u8", "i8", "u16be", "u16le", "i16be", "i16le", "u32be", "u32le", "i32be", "i32le"];
  for (const kind of numKinds) {
    bytesB.readNumHelper(kind);
    bytesB.writeNumHelper(kind);
  }
  // numReceivedHelper is only reached TRANSITIVELY today, through every
  // error path above (boundsErrorHelper, writeNumHelper's range check) —
  // if a future edit made any one of those paths conditional in a way
  // that stops emitting the error branch, this sweep would silently lose
  // coverage of numReceivedHelper without any test failing. Calling it
  // directly pins its own presence independent of who currently reaches it.
  bytesB.numReceivedHelper();
  // Round B2, slice 1: swap16/32/64 and the indexOf/lastIndexOf/includes
  // (+Num) search family — u8-only at the lowering, forced here anyway.
  bytesB.swapHelper(2);
  bytesB.swapHelper(4);
  bytesB.swapHelper(8);
  bytesB.indexOfHelper(true);
  bytesB.indexOfHelper(false);
  bytesB.indexOfNumHelper(true);
  bytesB.indexOfNumHelper(false);
  // Round B2, slice 2: the validateOffHelper substrate and its consumers
  // (compareBuf, fill/fillNum/fillStr, copy, writeStr).
  bytesB.validateOffHelper();
  bytesB.compareBufHelper();
  bytesB.fillHelper();
  bytesB.fillNumHelper();
  bytesB.copyHelper();
  for (const enc of encodings) {
    bytesB.fillStrHelper(enc);
    bytesB.writeStrHelper(enc);
  }
  // Round B3: byteLenStr/isEncoding, toString:range, concat/concatLen.
  bytesB.isEncodingHelper();
  for (const enc of encodings) {
    bytesB.byteLenStrHelper(enc);
    bytesB.toStrRangeHelper(enc);
  }
  bytesB.concatHelper();
  bytesB.concatLenHelper();
  // Round B4: float readNum/writeNum kinds, readNumVar/writeNumVar (the
  // 1-6 byte variable-width family), and byteLengthErrorHelper — like
  // numReceivedHelper, only reached transitively today (through every
  // readNumVar/writeNumVar byteLength check), so pinned directly too.
  const floatKinds = ["f32be", "f32le", "f64be", "f64le"];
  for (const kind of floatKinds) {
    bytesB.readNumFloatHelper(kind);
    bytesB.writeNumFloatHelper(kind);
  }
  const varKinds = ["ube", "ule", "ibe", "ile"];
  for (const kind of varKinds) {
    bytesB.readNumVarHelper(kind);
    bytesB.writeNumVarHelper(kind);
  }
  bytesB.byteLengthErrorHelper();
  // Increment 18 stage C, round R1: DataView. dataViewNew is NOT elem-
  // templated (it bounds against the shared STORAGE array's own
  // array.len, not the receiver's BLEN — the fix for the "view over a
  // view's .buffer" rebasing bug the corpus census caught), so it's
  // called once; every dvGet*/dvSet* method operates on an already-
  // constructed u8-elem view, likewise called once each.
  bytesB.dataViewNewHelper();
  const dvIntGetters = ["dvGetUint8", "dvGetInt8", "dvGetUint16", "dvGetInt16", "dvGetUint32", "dvGetInt32"];
  const dvIntSetters = ["dvSetUint8", "dvSetInt8", "dvSetUint16", "dvSetInt16", "dvSetUint32", "dvSetInt32"];
  for (const method of dvIntGetters) bytesB.dvGetIntHelper(method);
  for (const method of dvIntSetters) bytesB.dvSetIntHelper(method);
  bytesB.dvGetFloatHelper("dvGetFloat32");
  bytesB.dvGetFloatHelper("dvGetFloat64");
  bytesB.dvSetFloatHelper("dvSetFloat32");
  bytesB.dvSetFloatHelper("dvSetFloat64");
  bytesB.dvGetBigHelper("dvGetBigUint64Number");
  bytesB.dvGetBigHelper("dvGetBigInt64Number");

  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  await expect(WebAssembly.instantiate(bytes, {})).resolves.toBeDefined();
});

test("S034: fromArrLit's allocation-cap guard traps for a u32 source claiming ≥2^29 elements", async () => {
  // The SAME 2^31-byte cap as newLen's, reached from the OTHER allocation
  // root: a `number[]` source whose element count times esize (u32/i32/
  // f32's esize=4) would be ≥2^31 bytes. Actually allocating 2^29+
  // f64 slots (4+ GiB) to exercise this honestly is impractical (S008's
  // own precedent for not chasing multi-GB test appetites) — but the
  // guard reads ONLY the vec's LEN field before touching its backing
  // array at all, and LEN is independent of the backing array's REAL
  // capacity in this growable-vector design (arrays.ts's own `reserveAppend`
  // discipline: LEN can be far below BUF's allocated length, and here we
  // build the reverse — a fake vec struct whose LEN claims 2^29 elements
  // over a REAL backing array of length 0). This exercises the exact
  // instruction sequence fromArrLit's call site reaches, with N GiB of
  // memory never entering the picture.
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const concatFn = mb.declareFunc(mb.funcType([strRef, strRef], [strRef]), "%stub.concat");
  mb.setBody(concatFn, [], (() => {
    const c = new Code();
    c.localGet(0);
    return c.bytes();
  })());
  const f64ToStrFn = mb.declareFunc(mb.funcType([F64], [strRef]), "%stub.f64ToStr");
  mb.setBody(f64ToStrFn, [], (() => {
    const c = new Code();
    c.refNull(strType);
    return c.bytes();
  })());
  const toInt32Fn = mb.declareFunc(mb.funcType([F64], [I32]), "%stub.toInt32");
  mb.setBody(toInt32Fn, [], (() => {
    const c = new Code();
    c.i32Const(0);
    return c.bytes();
  })());
  const strEqFn = mb.declareFunc(mb.funcType([strRef, strRef], [I32]), "%stub.strEq");
  mb.setBody(strEqFn, [], (() => {
    const c = new Code();
    c.i32Const(1);
    return c.bytes();
  })());
  const strSliceFn = mb.declareFunc(mb.funcType([strRef, F64, F64], [strRef]), "%stub.strSlice");
  mb.setBody(strSliceFn, [], (() => {
    const c = new Code();
    c.localGet(0);
    return c.bytes();
  })());
  const lit = (c: Code, _s: string): void => c.refNull(strType);

  const vecs = new VecBuilder(mb, {
    strEq: () => strEqFn,
    f64ToStr: () => f64ToStrFn,
    concat: () => concatFn,
    lit,
  });
  const f64VecInfo = vecs.info("vec(f64)", F64, F64, "f64");

  const bytesB = new BytesBuilder(mb, {
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    strRef: () => strRef,
    strType: () => strType,
    toInt32: () => toInt32Fn,
    strSlice: () => strSliceFn,
    f64Vec: () => f64VecInfo,
    f64VecNewLen: () => vecs.newLen(f64VecInfo),
    f64VecPush1: () => vecs.pushOne(f64VecInfo),
    throwError: (c, _className, _name, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
  });
  const fromArrLitU32 = bytesB.fromArrLit("u32");

  // The driver: build a FAKE vec(f64) — LEN = 2^29 (536,870,912 elements;
  // ×4 bytes = exactly 2^31, the cap's own boundary), BUF = a REAL but
  // EMPTY backing array — then call fromArrLit on it.
  const driver = mb.declareFunc(mb.funcType([], []), "%test.fromArrLitTrap");
  {
    const c = new Code();
    c.i32Const(536870912);
    c.i32Const(0);
    c.arrayNewDefault(f64VecInfo.bufType);
    c.structNew(f64VecInfo.struct);
    c.call(fromArrLitU32);
    c.drop();
    mb.setBody(driver, [], c.bytes());
  }
  mb.exportFunc("trap", driver);

  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as { trap: () => void };
  // Match the SPECIFIC trap, not just "some RuntimeError happened": a
  // below-cap fake vec (a bug that moved the guard's boundary, or
  // dropped it) still traps here, but with a DIFFERENT message —
  // "array element access out of bounds", from actually walking off the
  // real length-0 backing array once the (broken) guard let execution
  // through. `unreachable`'s trap message is the literal string
  // "unreachable"; asserting it is what proves this test is catching
  // `emitByteSizeGuard`'s own trap and not some other failure downstream.
  expect(() => ex.trap()).toThrow(/unreachable/);
});

/** Increment 18 stage C: the dyn↔bytes crossing grew a BYTES arm in seven
 * dyn.ts functions, one json.ts function, and one inspect.ts function —
 * every one of them a single function covering EVERY dyn KIND, built once
 * and cached, so a structural bug in the BYTES arm specifically breaks the
 * WHOLE function's validity even though a corpus program exercising only
 * NUM/ARR/OBJ would never call it (exactly A1's shape, one level up: this
 * round's own objWalk bug — a local declared as the ARR-payload type but
 * fed a `$bytes` ref — passed `compile()` and was only caught when
 * WebAssembly.instantiate() rejected the actual module). This sweep
 * forces every one of those functions to build UNCONDITIONALLY, the same
 * discipline the BytesBuilder sweep above applies to typedarrays.ts.
 * Deps are structural stubs exactly as above — this checks shape, not
 * semantics; wasm-bytes-flag.test.ts covers the BYTES arm's BEHAVIOR
 * (including the isBuffer=true branches no compiled program can reach),
 * wasm-emitter.test.ts covers the reachable (isBuffer=false) behavior
 * through real compiled programs. */
test("dyn.ts/json.ts/inspect.ts: every function with a BYTES arm emits a VALID module (direct, bypassing the frontend)", async () => {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const lit = (c: Code, _s: string): void => c.refNull(strType);

  const strEqFn = mb.declareFunc(mb.funcType([strRef, strRef], [I32]), "%stub.strEq");
  mb.setBody(strEqFn, [], (() => {
    const c = new Code();
    c.i32Const(1);
    return c.bytes();
  })());
  const f64ToStrFn = mb.declareFunc(mb.funcType([F64], [strRef]), "%stub.f64ToStr");
  mb.setBody(f64ToStrFn, [], (() => {
    const c = new Code();
    c.refNull(strType);
    return c.bytes();
  })());
  const concatFn = mb.declareFunc(mb.funcType([strRef, strRef], [strRef]), "%stub.concat");
  mb.setBody(concatFn, [], (() => {
    const c = new Code();
    c.localGet(0);
    return c.bytes();
  })());
  const toInt32Fn = mb.declareFunc(mb.funcType([F64], [I32]), "%stub.toInt32");
  mb.setBody(toInt32Fn, [], (() => {
    const c = new Code();
    c.i32Const(0);
    return c.bytes();
  })());
  const strSliceFn = mb.declareFunc(mb.funcType([strRef, F64, F64], [strRef]), "%stub.strSlice");
  mb.setBody(strSliceFn, [], (() => {
    const c = new Code();
    c.localGet(0);
    return c.bytes();
  })());
  const strCpAtFn = mb.declareFunc(mb.funcType([strRef, I32], [I32]), "%stub.strCpAt");
  mb.setBody(strCpAtFn, [], (() => {
    const c = new Code();
    c.i32Const(0);
    return c.bytes();
  })());
  const strCmpU16Fn = mb.declareFunc(mb.funcType([strRef, strRef], [I32]), "%stub.strCmpU16");
  mb.setBody(strCmpU16Fn, [], (() => {
    const c = new Code();
    c.i32Const(0);
    return c.bytes();
  })());
  const strIndexOfFn = mb.declareFunc(mb.funcType([strRef, strRef, F64], [F64]), "%stub.strIndexOf");
  mb.setBody(strIndexOfFn, [], (() => {
    const c = new Code();
    c.f64Const(-1);
    return c.bytes();
  })());
  const strMatchAtFn = mb.declareFunc(mb.funcType([strRef, strRef, I32], [I32]), "%stub.strMatchAt");
  mb.setBody(strMatchAtFn, [], (() => {
    const c = new Code();
    c.i32Const(0);
    return c.bytes();
  })());

  const vecs = new VecBuilder(mb, { strEq: () => strEqFn, f64ToStr: () => f64ToStrFn, concat: () => concatFn, lit });
  const f64VecInfo = vecs.info("vec(f64)", F64, F64, "f64");
  const bytesB = new BytesBuilder(mb, {
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    strRef: () => strRef,
    strType: () => strType,
    toInt32: () => toInt32Fn,
    strSlice: () => strSliceFn,
    f64Vec: () => f64VecInfo,
    f64VecNewLen: () => vecs.newLen(f64VecInfo),
    f64VecPush1: () => vecs.pushOne(f64VecInfo),
    bytesVec: () => vecs.info("vec(bytes:u8)", bytesB.bytesRef(), bytesB.bytesRef(), "ref"),
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

  let dyn!: DynBuilder;
  // Self-referencing closure (this file's own established pattern, see
  // bytesVec above): json is only ever CALLED later, never during dyn's
  // own construction, so capturing it here — before it exists — is safe.
  let json!: JsonBuilder;
  const dynVecInfo = () => vecs.info("dyn", dyn.dynRef(), dyn.dynRef(), "ref");
  // Trivial structural stub (review round 1's DynDeps.jsToNumber
  // addition) — right type, wrong (irrelevant) behavior, matching every
  // other dep in this file.
  let jsToNumberFn: number | null = null;
  const jsToNumber = (): number => {
    if (jsToNumberFn !== null) return jsToNumberFn;
    const idx = mb.declareFunc(mb.funcType([dyn.dynRef()], [F64]), "%stub.jsToNumber");
    jsToNumberFn = idx;
    mb.setBody(idx, [], (() => {
      const c = new Code();
      c.f64Const(0);
      return c.bytes();
    })());
    return idx;
  };
  // Increment 23 P2a's own DynDeps additions — trivial structural stubs,
  // matching every other dep in this file: this test never reaches
  // sameValueDyn/deepEqDyn, so only the SHAPE needs to satisfy DynDeps.
  // EQ_HEAP (-0x13) directly, not dyn.dynRef(), for deqEnter/deqLeave's
  // params: their REAL signature is `eq`-typed (dyn.ts's own header
  // note), not the concrete dyn struct.
  const EQ_HEAP_STUB = -0x13;
  const sameValueF64Fn = mb.declareFunc(mb.funcType([F64, F64], [I32]), "%stub.sameValueF64");
  mb.setBody(sameValueF64Fn, [], (() => {
    const c = new Code();
    c.i32Const(1);
    return c.bytes();
  })());
  const deqEnterFn = mb.declareFunc(
    mb.funcType(
      [
        { kind: "ref", nullable: true, typeIndex: EQ_HEAP_STUB },
        { kind: "ref", nullable: true, typeIndex: EQ_HEAP_STUB },
      ],
      [F64],
    ),
    "%stub.deqEnter",
  );
  mb.setBody(deqEnterFn, [], (() => {
    const c = new Code();
    c.f64Const(0);
    return c.bytes();
  })());
  const deqLeaveFn = mb.declareFunc(mb.funcType([], []), "%stub.deqLeave");
  mb.setBody(deqLeaveFn, [], new Code().bytes());
  dyn = new DynBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
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
    strCmpU16: () => strCmpU16Fn,
    strSlice: () => strSliceFn,
    strIndexOf: () => strIndexOfFn,
    strMatchAt: () => strMatchAtFn,
    bytesRefU8: () => bytesB.bytesRef(),
    bytesTypeU8: () => bytesB.bytesType(),
    bytesEquals: () => bytesB.equalsHelper(),
    bytesLen: () => bytesB.length(),
    bytesGet: () => bytesB.get("u8"),
    bytesSet: () => bytesB.setElem("u8"),
    bytesToStrUtf8: () => bytesB.toStrHelper("utf8"),
    jsToNumber,
    jsonQuoteStr: () => json.quoteStr(),
    sameValueF64: () => sameValueF64Fn,
    deqEnter: () => deqEnterFn,
    deqLeave: () => deqLeaveFn,
  });

  json = new JsonBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    concat: () => concatFn,
    f64ToStr: () => f64ToStrFn,
    lit,
    throwError: (c, _cn, _n, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    excKind: () => excKindG,
    clearExc: (c) => {
      c.i32Const(0);
      c.globalSet(excKindG);
    },
    newDynVec: (c) => {
      c.f64Const(0);
      c.call(vecs.newLen(dynVecInfo()));
    },
    dyn: () => dyn,
    bytesRefU8: () => bytesB.bytesRef(),
    bytesGet: () => bytesB.get("u8"),
  });

  const insp = new InspectBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    lit,
    f64ToStr: () => f64ToStrFn,
    errT: () => errT,
    errName: () => 1,
    errMessage: () => 2,
    errCode: () => 3,
    dyn: () => dyn,
    inspF64: () => f64ToStrFn,
    throwError: (c, _cn, _n, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    excKind: () => excKindG,
    bytesRefU8: () => bytesB.bytesRef(),
    bytesLen: () => bytesB.length(),
    bytesGet: () => bytesB.get("u8"),
    // Right-shaped stub ((strRef,strRef)->i32) — this file never forces
    // the renderer's own entry-sort arm, so the WRONG comparator
    // semantics (equality, not a -1/0/1 order) are never observed.
    strCmpU16: () => strEqFn,
  });

  // Every dyn.ts function whose BYTES arm this increment added, plus
  // json.ts's stringifyDyn (putDyn's entry point) and inspect.ts's dyn
  // walker — forced UNCONDITIONALLY, the sweep's whole point.
  dyn.strictEq();
  dyn.hasOwn();
  dyn.objWalk();
  dyn.keyGet();
  dyn.keySet();
  dyn.toStr();
  dyn.kindName();
  dyn.specificType();
  json.stringifyDyn();
  insp.dyn();

  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  await expect(WebAssembly.instantiate(bytes, {})).resolves.toBeDefined();
});
