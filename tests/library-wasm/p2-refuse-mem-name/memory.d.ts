// The program types tsinter:memory itself (the module is tsinter's; the
// Node column's shim implements the same names).
declare module "tsinter:memory" {
  export const mem: {
    scratch(n: number): number;
    alloc(n: number): number;
    free(p: number): void;
    zap(p: number): void;
    u8(p: number): number;
    i32(p: number): number;
    u32(p: number): number;
    f32(p: number): number;
    f64(p: number): number;
    setU8(p: number, v: number): void;
    setI32(p: number, v: number): void;
    setU32(p: number, v: number): void;
    setF32(p: number, v: number): void;
    setF64(p: number, v: number): void;
    utf8(p: number, len: number): string;
    copyU8(p: number, n: number): Uint8Array;
    copyI32(p: number, n: number): Int32Array;
    copyU32(p: number, n: number): Uint32Array;
    copyF32(p: number, n: number): Float32Array;
  };
}
