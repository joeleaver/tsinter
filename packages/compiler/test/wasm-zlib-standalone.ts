/* A standalone module around backend/wasm/zlib.ts's two entry points, for
 * the in-process differential against Node's own zlib (wasm-zlib.test.ts):
 * the builder's real functions, linked into a minimal module whose input
 * and output cross through linear memory. The work area sits at the
 * staging cursor (0 here); inputs and outputs are staged far above it. */
import { ModuleBuilder, I32, type ValType } from "../src/backend/wasm/module.js";
import { Code } from "../src/backend/wasm/code.js";
import { ZlibBuilder, ZLIB_ERRORS } from "../src/backend/wasm/zlib.js";

/** Where inputs are staged (well past the ~290 KB work area). */
const IO_BASE = 1 << 20;

export interface ZlibModule {
  deflate(data: Uint8Array, level?: number): Buffer;
  /** The inflated bytes, or the error Node would throw (message, code). */
  inflate(data: Uint8Array): Buffer | { message: string; code: string };
}

export async function buildZlibModule(): Promise<ZlibModule> {
  const mb = new ModuleBuilder();
  mb.ensureMemory(1);
  mb.exportMemory("memory");
  const cursor = mb.addGlobal(I32, true, (w) => {
    w.u8(0x41);
    w.sleb(0);
  });
  const buf = mb.arrayType("i8", true);
  const bufNN: ValType = { kind: "ref", nullable: false, typeIndex: buf };
  const bytes = mb.structType([
    { storage: bufNN, mutable: false },
    { storage: I32, mutable: false },
    { storage: I32, mutable: false },
  ]);
  const ensure = (c: Code, need: () => void): void => {
    c.globalGet(cursor);
    need();
    c.i32Add();
    c.memorySize();
    c.i32Const(16);
    c.i32Shl();
    c.i32GtU();
    c.ifVoid();
    c.globalGet(cursor);
    need();
    c.i32Add();
    c.memorySize();
    c.i32Const(16);
    c.i32Shl();
    c.i32Sub();
    c.i32Const(0xffff);
    c.i32Add();
    c.i32Const(16);
    c.i32ShrU();
    c.memoryGrow();
    c.i32Const(-1);
    c.i32Eq();
    c.ifVoid();
    c.unreachable();
    c.end();
    c.end();
  };
  const z = new ZlibBuilder(mb, { bufType: () => buf, bytesType: () => bytes, ensureCapacity: ensure, stageCursor: () => cursor });
  const bytesRef: ValType = { kind: "ref", nullable: true, typeIndex: bytes };

  /** (inPtr, len) -> bytes: memory → a fresh array */
  const load = mb.declareFunc(mb.funcType([I32, I32], [bytesRef]), "load");
  {
    const c = new Code();
    const A = 2;
    const J = 3;
    c.localGet(1);
    c.arrayNewDefault(buf);
    c.localSet(A);
    c.block();
    c.loop();
    c.localGet(J);
    c.localGet(1);
    c.i32GeU();
    c.brIf(1);
    c.localGet(A);
    c.localGet(J);
    c.localGet(0);
    c.localGet(J);
    c.i32Add();
    c.i32Load8U();
    c.arraySet(buf);
    c.localGet(J);
    c.i32Const(1);
    c.i32Add();
    c.localSet(J);
    c.br(0);
    c.end();
    c.end();
    c.localGet(A);
    c.refAsNonNull();
    c.i32Const(0);
    c.localGet(1);
    c.structNew(bytes);
    mb.setBody(load, [{ kind: "ref", nullable: true, typeIndex: buf }, I32], c.bytes());
  }
  /** (bytes, outPtr) -> len: a result back into memory */
  const store = mb.declareFunc(mb.funcType([bytesRef, I32], [I32]), "store");
  {
    const c = new Code();
    const J = 2;
    const N = 3;
    c.localGet(0);
    c.structGet(bytes, 2);
    c.localSet(N);
    c.block();
    c.loop();
    c.localGet(J);
    c.localGet(N);
    c.i32GeU();
    c.brIf(1);
    c.localGet(1);
    c.localGet(J);
    c.i32Add();
    c.localGet(0);
    c.structGet(bytes, 0);
    c.localGet(0);
    c.structGet(bytes, 1);
    c.localGet(J);
    c.i32Add();
    c.arrayGetU(buf);
    c.i32Store8();
    c.localGet(J);
    c.i32Const(1);
    c.i32Add();
    c.localSet(J);
    c.br(0);
    c.end();
    c.end();
    c.localGet(N);
    mb.setBody(store, [I32, I32], c.bytes());
  }
  /** The last result, held until take() copies it out. */
  const held = mb.addGlobal(bytesRef, true, (w) => {
    w.u8(0xd0);
    w.sleb(bytes);
  });
  /** deflate(inPtr, len, level) -> outLen */
  const def = mb.declareFunc(mb.funcType([I32, I32, I32], [I32]), "deflate");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.call(load);
    c.localGet(2);
    c.call(z.deflateSyncFn());
    c.globalSet(held);
    c.globalGet(held);
    c.structGet(bytes, 2);
    mb.setBody(def, [], c.bytes());
  }
  /** inflate(inPtr, len) -> outLen | -errId */
  const inf = mb.declareFunc(mb.funcType([I32, I32], [I32]), "inflate");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.call(load);
    c.call(z.inflateSyncFn());
    c.globalSet(held);
    c.globalGet(held);
    c.refIsNull();
    c.ifVoid();
    c.i32Const(0);
    c.globalGet(z.errGlobal());
    c.i32Sub();
    c.return_();
    c.end();
    c.globalGet(held);
    c.structGet(bytes, 2);
    mb.setBody(inf, [], c.bytes());
  }
  /** take(outPtr): the held result into memory */
  const take = mb.declareFunc(mb.funcType([I32], [I32]), "take");
  {
    const c = new Code();
    c.globalGet(held);
    c.localGet(0);
    c.call(store);
    mb.setBody(take, [], c.bytes());
  }
  mb.exportFunc("take", take);
  mb.exportFunc("deflate", def);
  mb.exportFunc("inflate", inf);
  const { instance } = await WebAssembly.instantiate(mb.emit(), {});
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const fDeflate = instance.exports["deflate"] as (p: number, n: number, l: number) => number;
  const fInflate = instance.exports["inflate"] as (p: number, n: number) => number;
  const fTake = instance.exports["take"] as (p: number) => number;
  const room = (need: number): void => {
    const have = memory.buffer.byteLength;
    if (need > have) memory.grow(Math.ceil((need - have) / 65536));
  };
  const stage = (data: Uint8Array): void => {
    room(IO_BASE + data.length);
    new Uint8Array(memory.buffer).set(data, IO_BASE);
  };
  const takeOut = (n: number): Buffer => {
    room(IO_BASE + n);
    fTake(IO_BASE);
    return Buffer.from(new Uint8Array(memory.buffer, IO_BASE, n));
  };
  return {
    deflate(data, level = -1) {
      stage(data);
      return takeOut(fDeflate(IO_BASE, data.length, level));
    },
    inflate(data) {
      stage(data);
      const n = fInflate(IO_BASE, data.length);
      if (n < 0) {
        const row = ZLIB_ERRORS.find((r) => r[0] === -n);
        if (row === undefined) throw new Error(`unknown zlib error id ${-n}`);
        return { message: row[1], code: row[2] };
      }
      return takeOut(n);
    },
  };
}
