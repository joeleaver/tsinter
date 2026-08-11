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
    toInt32: () => toInt32Fn,
    f64Vec: () => f64VecInfo,
    f64VecNewLen: () => vecs.newLen(f64VecInfo),
    f64VecPush1: () => vecs.pushOne(f64VecInfo),
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
    toInt32: () => toInt32Fn,
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
