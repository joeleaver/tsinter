/* The isBuffer=true flag path, forced directly at the builder level — NOT
 * through TS compilation. SEMANTICS.md S037: the frontend has no surface
 * that can ever set the BYTES payload's isBuffer flag to true today (the
 * generic `unknown`-crossing site pins it `false` unconditionally, because
 * Buffer and Uint8Array collapse to the identical IR type upstream of
 * `dynFrom`), so every Buffer-flavored consumer arm — `dyn.ts`'s kindName
 * and toStr, `json.ts`'s putDyn, `inspect.ts`'s dyn walker — is UNREACHABLE
 * from any compiled program. The A1 lesson applies exactly: an arm no test
 * can reach is where the next silent bug lives. This file builds a
 * `$dynBytes` payload with isBuffer HARD-CODED true, bypassing the
 * frontend's gate entirely (the same "force-emitted directly against
 * ModuleBuilder" method wasm-bytes-validate.test.ts uses, combined with
 * wasm-inspect.test.ts's harness-1 into/outOf string-reflection idiom),
 * and asserts each consumer's Buffer-flavored output against Node's
 * MEASURED forms — so the day board #25 wires a real provenance flag
 * through the frontend, these arms are proven correct in advance rather
 * than merely written and hoped. Deps unrelated to the BYTES arm (the
 * ARR/OBJ/FUNC/error machinery every one of these kind-dispatch functions
 * ALSO builds, since each is a single function covering every DK kind) are
 * STRUCTURAL stubs — this file checks the BYTES arm's behavior, not the
 * others'. */
import { expect, test } from "vitest";
import { VecBuilder } from "../src/backend/wasm/arrays.js";
import { Code } from "../src/backend/wasm/code.js";
import { DynBuilder } from "../src/backend/wasm/dyn.js";
import { InspectBuilder } from "../src/backend/wasm/inspect.js";
import { JsonBuilder } from "../src/backend/wasm/json.js";
import { F64, I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { buildF64ToStr } from "../src/backend/wasm/numfmt.js";
import { BytesBuilder } from "../src/backend/wasm/typedarrays.js";

interface Drivers {
  dyn: DynBuilder;
  json: JsonBuilder;
  insp: InspectBuilder;
  bytesB: BytesBuilder;
}

/** Builds one module wiring bytes/dyn/json/inspect together (REAL literal
 * encoding and f64ToStr; structural stubs for everything the BYTES arm
 * itself never touches), with one exported driver per entry in `drivers`:
 * each receives (Code, {dyn, json, insp}, dynLocalIndex) for a `$dyn`
 * BYTES box ALREADY constructed over `bytes` with the CALLER-CHOSEN
 * isBuffer flag (the export takes isBuffer as its own i32 parameter), and
 * must leave a strRef on the stack as the function's result. Returns a map
 * from driver name to a `(isBuffer: boolean) => string` reader that drives
 * the export and threads the result back through len/at into a real JS
 * string. */
async function buildHarness(
  bytes: number[],
  drivers: Record<string, (c: Code, b: Drivers, dynLocal: number) => void>,
): Promise<Record<string, (isBuffer: boolean) => string>> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const lit = (c: Code, s: string): void => {
    const units = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    c.i32Const(mb.internData(units));
    c.i32Const(s.length);
    c.arrayNewData(strType, 0);
  };
  let f2s: number | null = null;
  const f64ToStr = (): number => (f2s ??= buildF64ToStr(mb, strType, strRef));

  // A trivial stub: a function of the given signature whose body is
  // structurally valid (default/zero results) but never meant to run —
  // every dep wired this way is one the BYTES-only driver paths below
  // never call at runtime, only reference while OTHER kind arms build
  // (kindName/toStr/putDyn/the dyn walker are single functions covering
  // every DK kind, not just BYTES).
  const stub = (params: ValType[], results: ValType[], name: string): number => {
    const idx = mb.declareFunc(mb.funcType(params, results), name);
    const c = new Code();
    for (const r of results) {
      if (r === F64) c.f64Const(0);
      else if (r === I32) c.i32Const(0);
      else c.refNull(r.typeIndex);
    }
    mb.setBody(idx, [], c.bytes());
    return idx;
  };

  const toInt32Fn = stub([F64], [I32], "%stub.toInt32");
  const strSliceFn = stub([strRef, F64, F64], [strRef], "%stub.strSlice");
  // REAL, not a stub: toStr's comma-join branch (the isBuffer=false half,
  // already exercised by real corpus programs) genuinely calls this at
  // runtime, unlike the deps below that only need to resolve to SOME
  // valid function index because toStr/kindName/etc. are single functions
  // covering every DK kind — a null-returning stub here isn't "unused
  // scaffolding", it silently breaks the one branch this file exists to
  // let run (found the hard way: `dereferencing a null pointer` two
  // levels away from the code that was actually wrong).
  const concatFn = mb.declareFunc(mb.funcType([strRef, strRef], [strRef]), "%real.concat");
  {
    const cc = new Code();
    const A = 0, B = 1, LA = 2, LB = 3, OUT = 4;
    cc.localGet(A);
    cc.arrayLen();
    cc.localSet(LA);
    cc.localGet(B);
    cc.arrayLen();
    cc.localSet(LB);
    cc.localGet(LA);
    cc.localGet(LB);
    cc.i32Add();
    cc.arrayNewDefault(strType);
    cc.localSet(OUT);
    cc.localGet(OUT);
    cc.i32Const(0);
    cc.localGet(A);
    cc.i32Const(0);
    cc.localGet(LA);
    cc.arrayCopy(strType, strType);
    cc.localGet(OUT);
    cc.localGet(LA);
    cc.localGet(B);
    cc.i32Const(0);
    cc.localGet(LB);
    cc.arrayCopy(strType, strType);
    cc.localGet(OUT);
    mb.setBody(concatFn, [I32, I32, strRef], cc.bytes());
  }
  const strEqFn = stub([strRef, strRef], [I32], "%stub.strEq");
  const strCpAtFn = stub([strRef, I32], [I32], "%stub.strCpAt");
  const strCmpU16Fn = stub([strRef, strRef], [I32], "%stub.strCmpU16");
  const strIndexOfFn = stub([strRef, strRef, F64], [F64], "%stub.strIndexOf");
  const strMatchAtFn = stub([strRef, strRef, I32], [I32], "%stub.strMatchAt");

  const vecs = new VecBuilder(mb, { strEq: () => strEqFn, f64ToStr, concat: () => concatFn, lit });
  const f64VecInfo = vecs.info("vec(f64)", F64, F64, "f64");
  const bytesB = new BytesBuilder(mb, {
    concat: () => concatFn,
    f64ToStr,
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

  // Forward-referenced exactly like bytesB.bytesVec above: arrVec is only
  // CALLED once dyn's own ARR-adjacent arms build, by which time `dyn` is
  // assigned below.
  let dyn!: DynBuilder;
  const dynVecInfo = () => vecs.info("dyn", dyn.dynRef(), dyn.dynRef(), "ref");
  dyn = new DynBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    strEq: () => strEqFn,
    concat: () => concatFn,
    f64ToStr,
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
    bytesLen: () => bytesB.length(),
    bytesGet: () => bytesB.get("u8"),
    bytesSet: () => bytesB.setElem("u8"),
    bytesToStrUtf8: () => bytesB.toStrHelper("utf8"),
  });

  const json = new JsonBuilder(mb, {
    strRef: () => strRef,
    strType: () => strType,
    concat: () => concatFn,
    f64ToStr,
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
    f64ToStr,
    errT: () => errT,
    errName: () => 1,
    errMessage: () => 2,
    errCode: () => 3,
    dyn: () => dyn,
    inspF64: () => stub([F64], [strRef], "%stub.inspF64"),
    throwError: (c, _cn, _n, pushMessage) => {
      pushMessage(c);
      c.drop();
    },
    excKind: () => excKindG,
    bytesRefU8: () => bytesB.bytesRef(),
    bytesLen: () => bytesB.length(),
    bytesGet: () => bytesB.get("u8"),
  });

  const simple = (name: string, params: ValType[], results: ValType[], body: (c: Code) => void): void => {
    const idx = mb.declareFunc(mb.funcType(params, results), name);
    const c = new Code();
    body(c);
    mb.setBody(idx, [], c.bytes());
    mb.exportFunc(name, idx);
  };
  simple("len", [strRef], [I32], (c) => {
    c.localGet(0);
    c.arrayLen();
  });
  simple("at", [strRef, I32], [I32], (c) => {
    c.localGet(0);
    c.localGet(1);
    c.arrayGetU(strType);
  });

  const arrRefNN: ValType = { kind: "ref", nullable: false, typeIndex: bytesB.bufType() };

  // The shared BYTES payload driver: build a `$bytes` struct holding the
  // given byte values, wrap it in a `$dynBytes{bytes, isBuffer}` payload
  // (isBuffer taken from the export's OWN i32 parameter, so one export
  // serves both the true and false case), box it into a `$dyn`, and hand
  // it to `build`, which calls the consumer under test and leaves its
  // strRef result on the stack.
  for (const [name, build] of Object.entries(drivers)) {
    const idx = mb.declareFunc(mb.funcType([I32], [strRef]), `%test.${name}`);
    const c = new Code();
    const IS_BUFFER = 0; // param
    const D = 1;
    const ARR = 2;
    const BYTES_LOCAL = 3;
    c.i32Const(bytes.length);
    c.arrayNewDefault(bytesB.bufType());
    c.localSet(ARR);
    bytes.forEach((b, i) => {
      c.localGet(ARR);
      c.i32Const(i);
      c.i32Const(b);
      c.arraySet(bytesB.bufType());
    });
    c.localGet(ARR);
    c.i32Const(0);
    c.i32Const(bytes.length);
    c.structNew(bytesB.bytesType());
    c.localSet(BYTES_LOCAL);
    dyn.boxBytes(c, (x) => {
      dyn.pushNewBytesPayload(
        x,
        (y) => y.localGet(BYTES_LOCAL),
        (y) => y.localGet(IS_BUFFER),
      );
    });
    c.localSet(D);
    build(c, { dyn, json, insp, bytesB }, D);
    mb.setBody(idx, [dyn.dynRef(), arrRefNN, bytesB.bytesRef()], c.bytes());
    mb.exportFunc(`%test.${name}`, idx);
  }

  const emitted = mb.emit();
  expect(WebAssembly.validate(emitted)).toBe(true);
  const { instance } = await WebAssembly.instantiate(emitted, {});
  const exp = instance.exports as Record<string, (...args: unknown[]) => unknown>;
  const outOf = (r: unknown): string => {
    const n = exp["len"]!(r) as number;
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCharCode(exp["at"]!(r, i) as number);
    return out;
  };
  const readers: Record<string, (isBuffer: boolean) => string> = {};
  for (const name of Object.keys(drivers)) {
    readers[name] = (isBuffer) => outOf(exp[`%test.${name}`]!(isBuffer ? 1 : 0));
  }
  return readers;
}

test("dyn.ts kindName: the isBuffer flag forces \"Buffer\" vs \"Uint8Array\" — the flag-false half is what keySet's fallthrough message already prints for a real corpus program (measured passing in wasm-emitter.test.ts's 'Cannot create property... on Uint8Array' case); this pins the flag-true half, which no compiled program can reach today (S037) and which has nothing to check against Node either way (Node never throws for a Buffer OR Uint8Array expando write — S016's precedent — so 'Buffer' here is OUR tier's own consistent noun, not a Node answer)", async () => {
  const readers = await buildHarness([1, 2, 3], {
    kindName: (c, b, d) => {
      c.localGet(d);
      c.call(b.dyn.kindName());
    },
  });
  expect(readers["kindName"]!(true)).toBe("Buffer");
  expect(readers["kindName"]!(false)).toBe("Uint8Array");
});

test("dyn.ts toStr: the isBuffer flag forces UTF-8 decode vs comma-join — measured against Node (String(Buffer.from([104,105,33])) is 'hi!', String(new Uint8Array([104,105,33])) is '104,105,33')", async () => {
  const readers = await buildHarness([104, 105, 33], {
    toStr: (c, b, d) => {
      c.localGet(d);
      c.call(b.dyn.toStr());
    },
  });
  expect(readers["toStr"]!(true)).toBe("hi!");
  expect(readers["toStr"]!(false)).toBe("104,105,33");
});

test("json.ts putDyn: the isBuffer flag forces {\"type\":\"Buffer\",\"data\":[...]} vs the numeric-keyed object form — measured against Node (JSON.stringify(Buffer.from([1,2,3])) vs JSON.stringify(new Uint8Array([1,2,3])))", async () => {
  const readers = await buildHarness([1, 2, 3], {
    stringify: (c, b, d) => {
      c.localGet(d);
      c.call(b.json.stringifyDyn());
    },
  });
  expect(readers["stringify"]!(true)).toBe('{"type":"Buffer","data":[1,2,3]}');
  expect(readers["stringify"]!(false)).toBe('{"0":1,"1":2,"2":3}');
});

test("inspect.ts's dyn walker: the isBuffer flag forces bufferForm's <Buffer aa bb cc> hex form vs the array-grid Uint8Array(N) [...] form — measured against Node (util.inspect(Buffer.from([1,2,3])) vs util.inspect(new Uint8Array([1,2,3]))), at the SAME (recurse=0, depth=2) top-level call the frontend's insp.buffer/insp.dyn sites use", async () => {
  const readers = await buildHarness([1, 2, 3], {
    inspect: (c, b, d) => {
      c.localGet(d);
      c.f64Const(0); // recurse
      c.f64Const(2); // depth — Node's default
      c.call(b.insp.dyn());
    },
  });
  expect(readers["inspect"]!(true)).toBe("<Buffer 01 02 03>");
  expect(readers["inspect"]!(false)).toBe("Uint8Array(3) [ 1, 2, 3 ]");
});

test("inspect.ts's dyn walker: the depth boundary, BOTH flavors, at the exact recurse values a real nested object would pass — measured against Node directly (util.inspect({a:{b:X}}) and {a:{b:{c:X}}} for X = Buffer.from([1,2,3]) and new Uint8Array([1,2,3])). Buffer stays depth-INSENSITIVE past the point where Uint8Array collapses to '[Uint8Array]' — the handoff's original 'Buffer ignores depth entirely' phrasing was corrected mid-round: the insensitivity is bufferForm's own, not a property of the surrounding walk, which still collapses ONE level further regardless of flavor (untestable through THIS direct-call harness, since that collapse belongs to the ENCLOSING object's own recurse/depth check, one level up from the bytes payload itself — see wasm-emitter.test.ts's object-nesting tests for that half)", async () => {
  const readers = await buildHarness([1, 2, 3], {
    // recurse=2, depth=2 (2 > 2 is false): the boundary itself. Node:
    // { a: { b: <Buffer 01 02 03> } } / { a: { b: Uint8Array(3) [ 1, 2, 3 ] } }
    // — neither flavor has collapsed yet.
    atBoundary: (c, b, d) => {
      c.localGet(d);
      c.f64Const(2); // recurse
      c.f64Const(2); // depth
      c.call(b.insp.dyn());
    },
    // recurse=3, depth=2 (3 > 2 is true): ONE PAST the boundary. Node:
    // Buffer still renders in full; Uint8Array collapses to "[Uint8Array]".
    // This is the exact line the handoff's uncorrected claim would have
    // gotten wrong for Uint8Array if "ignores depth" had been read as
    // "the bytes payload never collapses" rather than "bufferForm alone
    // never collapses" — the two flavors diverge exactly here.
    pastBoundary: (c, b, d) => {
      c.localGet(d);
      c.f64Const(3); // recurse
      c.f64Const(2); // depth
      c.call(b.insp.dyn());
    },
  });
  expect(readers["atBoundary"]!(true)).toBe("<Buffer 01 02 03>");
  expect(readers["atBoundary"]!(false)).toBe("Uint8Array(3) [ 1, 2, 3 ]");
  expect(readers["pastBoundary"]!(true)).toBe("<Buffer 01 02 03>");
  expect(readers["pastBoundary"]!(false)).toBe("[Uint8Array]");
});
