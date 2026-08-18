/* nexttick.ts's RAW-MARKER seam (`enqueueRaw`) — force-emitted directly
 * against ModuleBuilder, NOT through TS compilation, the typedarrays.ts
 * validate-sweep precedent (wasm-bytes-validate.test.ts): no libCall the
 * frontend produces today reaches `enqueueRaw` (it exists for stage B —
 * a future stream tick will push one dispatch marker per deferred
 * emission onto this SAME queue, scr_next_tick_raw's exact shape), so a
 * sweep that only compiles TS source would never exercise it — a bug
 * there would be invisible until stage B and much harder to localize.
 *
 * This file calls `enqueueRaw`/`drain` directly, bypassing the frontend
 * and the WasmEmitter entirely, with trivial structural stubs standing in
 * for the emitter-owned deps (`voidClos`, `excKind`). Two checks, per the
 * precedent's own split: shape (WebAssembly.validate — this is exactly
 * the check that would have caught this stage's own %w.nexttick.drain
 * local-type bug, where `compile()` reported success and only an
 * explicit validate call on the actually-emitted bytes failed) AND
 * behavior (actually running the module: a raw marker's dispatch is a
 * bare `call_ref` with NO closure argument, which is worth proving does
 * the right thing, not just type-checks). */
import { expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder } from "../src/backend/wasm/module.js";
import { NextTickBuilder } from "../src/backend/wasm/nexttick.js";

async function runRawMarkerModule(bytes: Uint8Array): Promise<{ stdout: string }> {
  const chunks: Buffer[] = [];
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(bytes, {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  return { stdout: Buffer.concat(chunks).toString("utf8") };
}

test("nexttick.ts: enqueueRaw + drain emit a VALID module and dispatch the bare funcref correctly (direct, bypassing the frontend)", async () => {
  const mb = new ModuleBuilder();

  // Trivial structural stub for the ONE dep enqueue()/drain() need beyond
  // the raw path itself — a zero-capture `() => void` closure pair, RIGHT
  // TYPE (the real recursive struct/func pair emitter.ts's closPairFor
  // builds — drain()'s CB branch does `structGet(clos, 0); callRef(fn)`,
  // which only type-checks against this exact shape), never instantiated
  // in this test. No enqueue() (CB-shaped entries) is exercised here;
  // that path is already covered end to end by wasm-nexttick.test.ts's
  // real corpus-shaped programs. This file's entire point is the OTHER
  // entry shape.
  const pairBase = mb.recGroup2("test:clospair", (b) => [
    {
      kind: "struct",
      fields: [{ storage: { kind: "ref", nullable: false, typeIndex: b + 1 }, mutable: false }],
      sub: { supers: [], final: false },
    },
    { kind: "func", params: [{ kind: "ref", nullable: true, typeIndex: b }], results: [] },
  ]);
  const closT = pairBase;
  const fnT = pairBase + 1;
  const nextTick = new NextTickBuilder(mb, {
    voidClos: () => ({ clos: closT, fn: fnT }),
    excKind: () => excKindGlobal,
  });

  // The exception cell stub: always 0 (never "an uncaught throw"), so the
  // drain loop's death check is exercised (structurally) without ever
  // tripping it — behavior for THAT branch belongs to wasm-nexttick.
  // test.ts's real "uncaught throw" pin, over real IR.
  const excKindGlobal = mb.addGlobal(I32, true, (w) => {
    w.u8(0x41); // i32.const
    w.sleb(0);
  });

  const writeImport = mb.importFunc("tsinter", "write", mb.funcType([I32, I32, I32], []));
  mb.ensureMemory(1);

  // The raw marker function itself: writes one byte ('R', 0x52) to fd 1 —
  // scr_next_tick_raw's callee shape (`void (*)(void)`, zero args) exactly.
  const rawFn = mb.declareFunc(nextTick.rawFnType(), "%test.rawMarker");
  {
    const c = new Code();
    c.i32Const(0);
    c.i32Const(0x52);
    c.i32Store8();
    c.i32Const(1); // fd
    c.i32Const(0); // ptr
    c.i32Const(1); // len
    c.call(writeImport);
    mb.setBody(rawFn, [], c.bytes());
  }
  mb.declareFuncRef(rawFn); // the declarative element segment ref.func needs

  const enqueueRaw = nextTick.enqueueRaw();
  const drain = nextTick.drain();
  const start = mb.declareFunc(mb.funcType([], []), "%test.start");
  {
    const c = new Code();
    c.refFunc(rawFn);
    c.call(enqueueRaw);
    // A SECOND raw marker, enqueued before the first drains — proves the
    // queue is a real FIFO across the raw shape too, not just a single-
    // shot call-through.
    c.refFunc(rawFn);
    c.call(enqueueRaw);
    c.call(drain);
    mb.setBody(start, [], c.bytes());
  }
  mb.exportFunc("_start", start);
  mb.exportMemory("memory");

  const bytes = mb.emit();
  expect(WebAssembly.validate(bytes)).toBe(true);

  const { stdout } = await runRawMarkerModule(bytes);
  expect(stdout).toBe("RR");
});
