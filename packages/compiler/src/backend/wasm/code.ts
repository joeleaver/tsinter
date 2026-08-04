/* The instruction-level opcode knowledge, one method per instruction the
 * tier emits — shared by the emitter walk and the runtime-helper builders
 * (numfmt.ts). Declaration-level bytes live in ModuleBuilder; integer
 * encodings in ByteWriter. */
import { ByteWriter } from "./bytes.js";
import type { ValType } from "./module.js";




export class Code {
  readonly w = new ByteWriter();

  bytes(): Uint8Array {
    return this.w.bytes();
  }

  unreachable(): void {
    this.w.u8(0x00);
  }
  loop(): void {
    this.w.u8(0x03);
    this.w.u8(0x40); // void block type
  }
  block(): void {
    this.w.u8(0x02);
    this.w.u8(0x40);
  }
  ifVoid(): void {
    this.w.u8(0x04);
    this.w.u8(0x40);
  }
  /** if with one result — blocktype is the valtype encoding (allowed by
   * the blocktype grammar alongside 0x40 and s33 type indices). */
  ifResult(t: ValType): void {
    this.w.u8(0x04);
    switch (t.kind) {
      case "i32":
        this.w.u8(0x7f);
        break;
      case "i64":
        this.w.u8(0x7e);
        break;
      case "f64":
        this.w.u8(0x7c);
        break;
      case "ref":
        this.w.u8(t.nullable ? 0x63 : 0x64);
        this.w.sleb(t.typeIndex);
        break;
    }
  }
  else_(): void {
    this.w.u8(0x05);
  }
  end(): void {
    this.w.u8(0x0b);
  }
  br(depth: number): void {
    this.w.u8(0x0c);
    this.w.uleb(depth);
  }
  brIf(depth: number): void {
    this.w.u8(0x0d);
    this.w.uleb(depth);
  }
  return_(): void {
    this.w.u8(0x0f);
  }
  call(funcIndex: number): void {
    this.w.u8(0x10);
    this.w.uleb(funcIndex);
  }
  /** Indirect call through a typed function reference. */
  callRef(typeIndex: number): void {
    this.w.u8(0x14);
    this.w.uleb(typeIndex);
  }
  refFunc(funcIndex: number): void {
    this.w.u8(0xd2);
    this.w.uleb(funcIndex);
  }
  /** ref.cast (ref $t) — traps when the value isn't a $t (the closure
   * env downcast can never fail by construction). */
  refCast(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x16);
    this.w.sleb(typeIndex);
  }
  drop(): void {
    this.w.u8(0x1a);
  }
  localGet(i: number): void {
    this.w.u8(0x20);
    this.w.uleb(i);
  }
  localSet(i: number): void {
    this.w.u8(0x21);
    this.w.uleb(i);
  }
  globalGet(i: number): void {
    this.w.u8(0x23);
    this.w.uleb(i);
  }
  globalSet(i: number): void {
    this.w.u8(0x24);
    this.w.uleb(i);
  }
  i32Store8(): void {
    this.w.u8(0x3a);
    this.w.uleb(0); // alignment (2^0 — byte access)
    this.w.uleb(0); // offset
  }
  memorySize(): void {
    this.w.u8(0x3f);
    this.w.uleb(0);
  }
  memoryGrow(): void {
    this.w.u8(0x40);
    this.w.uleb(0);
  }
  localTee(i: number): void {
    this.w.u8(0x22);
    this.w.uleb(i);
  }
  i32Const(n: number): void {
    this.w.u8(0x41);
    this.w.sleb(n);
  }
  i64Const(n: bigint): void {
    this.w.u8(0x42);
    this.w.sleb64(n);
  }
  f64Const(v: number): void {
    this.w.u8(0x44);
    this.w.f64(v);
  }
  i32Eqz(): void {
    this.w.u8(0x45);
  }
  i32Eq(): void {
    this.w.u8(0x46);
  }
  i32Ne(): void {
    this.w.u8(0x47);
  }
  i32LtS(): void {
    this.w.u8(0x48);
  }
  i32LtU(): void {
    this.w.u8(0x49);
  }
  i32GtS(): void {
    this.w.u8(0x4a);
  }
  i32GtU(): void {
    this.w.u8(0x4b);
  }
  i32LeS(): void {
    this.w.u8(0x4c);
  }
  i32LeU(): void {
    this.w.u8(0x4d);
  }
  i32GeS(): void {
    this.w.u8(0x4e);
  }
  i32GeU(): void {
    this.w.u8(0x4f);
  }
  i64Eqz(): void {
    this.w.u8(0x50);
  }
  i64Eq(): void {
    this.w.u8(0x51);
  }
  i64Ne(): void {
    this.w.u8(0x52);
  }
  i64LtS(): void {
    this.w.u8(0x53);
  }
  i64LtU(): void {
    this.w.u8(0x54);
  }
  i64GtU(): void {
    this.w.u8(0x56);
  }
  i64LeU(): void {
    this.w.u8(0x58);
  }
  i64GeS(): void {
    this.w.u8(0x59);
  }
  i64GeU(): void {
    this.w.u8(0x5a);
  }
  f64Eq(): void {
    this.w.u8(0x61);
  }
  f64Ne(): void {
    this.w.u8(0x62);
  }
  f64Lt(): void {
    this.w.u8(0x63);
  }
  f64Gt(): void {
    this.w.u8(0x64);
  }
  f64Le(): void {
    this.w.u8(0x65);
  }
  f64Ge(): void {
    this.w.u8(0x66);
  }
  i32Add(): void {
    this.w.u8(0x6a);
  }
  i32Sub(): void {
    this.w.u8(0x6b);
  }
  i32Mul(): void {
    this.w.u8(0x6c);
  }
  i32DivS(): void {
    this.w.u8(0x6d);
  }
  i32RemS(): void {
    this.w.u8(0x6f);
  }
  i32And(): void {
    this.w.u8(0x71);
  }
  i32Or(): void {
    this.w.u8(0x72);
  }
  i32Xor(): void {
    this.w.u8(0x73);
  }
  i32Shl(): void {
    this.w.u8(0x74);
  }
  i32ShrS(): void {
    this.w.u8(0x75);
  }
  i32ShrU(): void {
    this.w.u8(0x76);
  }
  i64Add(): void {
    this.w.u8(0x7c);
  }
  i64Sub(): void {
    this.w.u8(0x7d);
  }
  i64Mul(): void {
    this.w.u8(0x7e);
  }
  i64DivU(): void {
    this.w.u8(0x80);
  }
  i64RemU(): void {
    this.w.u8(0x82);
  }
  i64And(): void {
    this.w.u8(0x83);
  }
  i64Or(): void {
    this.w.u8(0x84);
  }
  i64Shl(): void {
    this.w.u8(0x86);
  }
  i64ShrS(): void {
    this.w.u8(0x87);
  }
  i64ShrU(): void {
    this.w.u8(0x88);
  }
  f64Neg(): void {
    this.w.u8(0x9a);
  }
  f64Add(): void {
    this.w.u8(0xa0);
  }
  f64Sub(): void {
    this.w.u8(0xa1);
  }
  f64Mul(): void {
    this.w.u8(0xa2);
  }
  f64Div(): void {
    this.w.u8(0xa3);
  }
  i32WrapI64(): void {
    this.w.u8(0xa7);
  }
  i64ExtendI32S(): void {
    this.w.u8(0xac);
  }
  i64ExtendI32U(): void {
    this.w.u8(0xad);
  }
  f64ConvertI32S(): void {
    this.w.u8(0xb7);
  }
  f64ConvertI32U(): void {
    this.w.u8(0xb8);
  }
  f64ConvertI64U(): void {
    this.w.u8(0xba);
  }
  i64ReinterpretF64(): void {
    this.w.u8(0xbd);
  }
  f64ReinterpretI64(): void {
    this.w.u8(0xbf);
  }
  refEq(): void {
    this.w.u8(0xd3);
  }
  refNull(typeIndex: number): void {
    this.w.u8(0xd0);
    this.w.sleb(typeIndex);
  }
  refIsNull(): void {
    this.w.u8(0xd1);
  }
  /** Traps on null, yields the non-null ref — the absent-slot read trap. */
  refAsNonNull(): void {
    this.w.u8(0xd4);
  }
  structNew(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x00);
    this.w.uleb(typeIndex);
  }
  structNewDefault(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x01);
    this.w.uleb(typeIndex);
  }
  structGet(typeIndex: number, fieldIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x02);
    this.w.uleb(typeIndex);
    this.w.uleb(fieldIndex);
  }
  structSet(typeIndex: number, fieldIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x05);
    this.w.uleb(typeIndex);
    this.w.uleb(fieldIndex);
  }
  /** array.new_fixed — pops N operands, the literal fast path. */
  arrayNewFixed(typeIndex: number, count: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x08);
    this.w.uleb(typeIndex);
    this.w.uleb(count);
  }
  f64Trunc(): void {
    this.w.u8(0x9d);
  }
  /** Traps on NaN/out-of-range — callers bound-check first. */
  i32TruncF64S(): void {
    this.w.u8(0xaa);
  }
  arrayNewDefault(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x07);
    this.w.uleb(typeIndex);
  }
  arrayNewData(typeIndex: number, dataIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x09);
    this.w.uleb(typeIndex);
    this.w.uleb(dataIndex);
  }
  arraySet(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x0e);
    this.w.uleb(typeIndex);
  }
  arrayCopy(destTypeIndex: number, srcTypeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x11);
    this.w.uleb(destTypeIndex);
    this.w.uleb(srcTypeIndex);
  }
  /** Plain array.get — unpacked element types (i64 table entries). */
  arrayGet(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x0b);
    this.w.uleb(typeIndex);
  }
  arrayGetU(typeIndex: number): void {
    this.w.u8(0xfb);
    this.w.uleb(0x0d);
    this.w.uleb(typeIndex);
  }
  arrayLen(): void {
    this.w.u8(0xfb);
    this.w.uleb(0x0f);
  }
}
