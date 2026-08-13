/* unions.ts's UnionBuilder, force-emitted directly against ModuleBuilder —
 * NOT through IR/the emitter — the SAME reason wasm-bytes-validate.test.ts
 * calls BytesBuilder directly: this is the sole way to reach `retag`
 * before any IR-level caller exists in the compiled pipeline. Increment
 * 19's %gen.suspend/%gen.complete (statemachine.ts's yieldT/retT-into-V
 * retagging) are `retag`'s first real callers, but the retag MECHANISM
 * itself has no generator dependency at all — testing it here, against a
 * bare pair of hand-built unions, isolates the one thing that matters most
 * for correctness: a wrong TAG NUMBER here is a SILENT MISCOMPILE (the
 * wrong arm-struct gets read back downstream), never a validation failure,
 * so "WebAssembly.validate passes" alone is not enough — this file also
 * calls the retag helper through a real WebAssembly.instantiate and reads
 * BOTH the resulting tag and the payload back, for every FROM arm. */
import { expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { F64, I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { UnionBuilder } from "../src/backend/wasm/unions.js";
import type { IrType } from "../src/ir/nodes.js";

const F64_T: IrType = { kind: "f64" };
const BOOL_T: IrType = { kind: "bool" };
const UNDEFINED_T: IrType = { kind: "undefinedT" };

test("unions.ts: retag re-tags every FROM arm into its TO position, tag AND payload both correct — direct, bypassing IR entirely", async () => {
  const mb = new ModuleBuilder();
  // Trivial structural stubs (wrong behavior, right types) for the deps
  // retag() never actually calls — it only uses armStruct/unitGlobal/
  // dispatch/mapTypeSoft, none of which touch strEq/f64ToStr/
  // bytesToStrUtf8/strRef/lit. Present only because UnionDeps requires
  // them structurally.
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: mb.arrayType("i16", true) };
  const unions = new UnionBuilder(mb, {
    strEq: () => {
      throw new Error("not used by retag");
    },
    f64ToStr: () => {
      throw new Error("not used by retag");
    },
    bytesToStrUtf8: () => {
      throw new Error("not used by retag");
    },
    strRef: () => strRef,
    lit: () => {
      throw new Error("not used by retag");
    },
  });

  // FROM union: [f64, bool] — structurally the SAME shape as 2014-
  // generators-values.ts's mixed(): Generator<number | string, void,
  // unknown> yield channel (two payload-carrying arms, each its own wasm
  // VALUE TYPE), with bool substituted for string to skip unrelated
  // string-type scaffolding — the mechanism under test (dispatch, extract,
  // re-wrap) does not care which concrete arm kinds it moves.
  const fromArms: IrType[] = [F64_T, BOOL_T];
  // TO union (V): [f64, bool, undefined] — the retT=void channel's
  // unconditional undefined arm, exactly genResultRecord's own rule.
  const toArms: IrType[] = [F64_T, BOOL_T, UNDEFINED_T];
  const toTag = (t: IrType): number => toArms.findIndex((a) => a.kind === t.kind);
  const mapTypeSoft = (t: IrType): ValType => (t.kind === "f64" ? F64 : I32);

  const retagIdx = unions.retag("from-key", fromArms, "to-key", toTag, mapTypeSoft);
  const fromF64Struct = unions.armStruct("from-key", 0, F64);
  const fromBoolStruct = unions.armStruct("from-key", 1, I32);
  const toF64Struct = unions.armStruct("to-key", 0, F64);
  const toBoolStruct = unions.armStruct("to-key", 1, I32);

  const exported: string[] = [];
  function wrapperFn(name: string, resultType: ValType, build: (c: Code) => void): void {
    const idx = mb.declareFunc(mb.funcType([], [resultType]), name);
    const c = new Code();
    build(c);
    mb.setBody(idx, [], c.bytes());
    mb.exportFunc(name, idx);
    exported.push(name);
  }

  // FROM tag 0 (f64, payload 3.5) -> retag -> read the TO tag AND payload.
  wrapperFn("test_f64_tag", I32, (c) => {
    c.i32Const(0);
    c.f64Const(3.5);
    c.structNew(fromF64Struct);
    c.call(retagIdx);
    c.structGet(unions.base(), 0);
  });
  wrapperFn("test_f64_payload", F64, (c) => {
    c.i32Const(0);
    c.f64Const(3.5);
    c.structNew(fromF64Struct);
    c.call(retagIdx);
    c.refCast(toF64Struct);
    c.structGet(toF64Struct, 1);
  });
  // FROM tag 1 (bool, payload true) -> retag -> read the TO tag AND payload.
  wrapperFn("test_bool_tag", I32, (c) => {
    c.i32Const(1);
    c.i32Const(1);
    c.structNew(fromBoolStruct);
    c.call(retagIdx);
    c.structGet(unions.base(), 0);
  });
  wrapperFn("test_bool_payload", I32, (c) => {
    c.i32Const(1);
    c.i32Const(1);
    c.structNew(fromBoolStruct);
    c.call(retagIdx);
    c.refCast(toBoolStruct);
    c.structGet(toBoolStruct, 1);
  });

  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);
  const { instance } = await WebAssembly.instantiate(bytes, {});

  // TAG: f64 lands at TO position 0, bool at TO position 1 — exactly
  // toArms' own typeKey-independent order here (this test picks it
  // directly; %gen.suspend/%gen.complete's real callers derive it from
  // computeGenResultArms, covered separately in wasm-statemachine.test.ts).
  expect((instance.exports["test_f64_tag"] as () => number)()).toBe(0);
  expect((instance.exports["test_bool_tag"] as () => number)()).toBe(1);
  // PAYLOAD: the value itself survives the re-wrap unchanged — the
  // silent-miscompile risk this file exists to rule out is a WRONG TAG,
  // not a corrupted payload, but pinning both leaves no gap.
  expect((instance.exports["test_f64_payload"] as () => number)()).toBe(3.5);
  expect((instance.exports["test_bool_payload"] as () => number)()).toBe(1);
});
