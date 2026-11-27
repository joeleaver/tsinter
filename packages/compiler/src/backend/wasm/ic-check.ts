/* SCRIPTC_WASM_SHAPE_CHECK=1 (compile time, never on by default): the
 * shape-check mode of the U8 caches (docs/design/u8-dynamic-speed.md §9).
 *
 * Every answer a cache gives, and every object a cached path builds or
 * writes, is re-proved against the uncached machinery, and a difference
 * traps:
 *
 *   - promise(payload): the payload keeps its shape's promise (shapes.ts):
 *     a plain payload (no exotic subtype, prototype code 0 or 1), no hidden
 *     key, extensible, `len == count`, and entry i is the very key of the
 *     shape node at depth i + 1, a plain `$dynEntry` holding data;
 *   - answer(recv, payload, key, value) → value: the promise, and keyGet
 *     answers `recv[key]` with the very same box. A read hit (ic-read.ts)
 *     checks the box it answers; a store hit (ic-write.ts) checks the box
 *     it stored, after storing it, so a write the uncached [[Set]] would
 *     have refused or sent elsewhere reads back differently and traps;
 *   - an object literal built on its cached final shape (lit-shape.ts)
 *     checks its promise.
 *
 * keyGet runs no code here: a shaped receiver's own data entry answers
 * before any getter or fence. */
import type { DynBuilder } from "./dyn.js";
import { ENTRY_KEY, ENTRY_VALUE, OBJ_ENTRIES, OBJ_LEN, OBJ_PROTO, OBJ_PROTO_NULL } from "./dyn.js";
import { Code } from "./code.js";
import { I32 } from "./module.js";
import { SHAPE_COUNT, SHAPE_KEY, SHAPE_PARENT } from "./shapes.js";

/** Is the shape-check mode on for this build? Read per build, from the
 * compiler's environment (as SCRIPTC_WASM_IC_STATS is). */
export function shapeCheckOn(): boolean {
  return process.env["SCRIPTC_WASM_SHAPE_CHECK"] === "1";
}

export class IcCheck {
  constructor(private readonly d: DynBuilder) {}

  private get k() {
    return this.d.shapesKit();
  }

  /** %w.ic.promise(payload): traps unless the payload keeps its shape's
   * promise (a null shape traps too: only shaped payloads are checked). */
  promiseFn(): number {
    const objT = this.d.objT();
    const entryT = this.d.entryT();
    const S = this.d.shapes.shapeT();
    return this.k.cached("icPromise", [this.d.objRef()], [], (idx) => {
      const c = new Code();
      const N = 1;
      const NODE = 2;
      const E = 3;
      const trapIf = (): void => {
        c.ifVoid();
        c.unreachable();
        c.end();
      };
      // a plain payload: no exotic subtype, prototype code 0 or 1
      const exotic: number[] = [];
      if (this.d.urlLive) exotic.push(this.d.objUrlT());
      if (this.d.regexLive) exotic.push(this.d.objRegexT());
      if (this.d.builtinTablesLive) exotic.push(this.d.objBuiltinT());
      for (const t of exotic) {
        c.localGet(0);
        c.refTest(t);
        trapIf();
      }
      c.localGet(0);
      c.structGet(objT, OBJ_PROTO);
      c.i32Const(OBJ_PROTO_NULL);
      c.i32GtU();
      trapIf();
      // the object model's promises: no hidden key, extensible
      if (this.d.objModelLive) {
        const L = this.d.objLinkedT();
        c.localGet(0);
        c.refTest(L);
        c.ifVoid();
        c.localGet(0);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 2);
        c.localGet(0);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 3);
        c.i32Or();
        trapIf();
        c.end();
      }
      // len == count, and each entry is the shape's key, plain and data
      c.localGet(0);
      c.structGet(objT, this.d.objShapeField());
      c.localTee(NODE);
      c.refIsNull();
      trapIf();
      c.localGet(0);
      c.structGet(objT, OBJ_LEN);
      c.localTee(N);
      c.localGet(NODE);
      c.structGet(S, SHAPE_COUNT);
      c.i32Ne();
      trapIf();
      c.block();
      c.loop();
      c.localGet(N);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(N);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(N);
      c.arrayGet(this.d.entriesArrayType());
      c.localTee(E);
      c.structGet(entryT, ENTRY_KEY);
      c.localGet(NODE);
      c.structGet(S, SHAPE_KEY);
      c.refEq();
      c.i32Eqz();
      trapIf();
      if (this.d.objModelLive) {
        c.localGet(E);
        c.refTest(this.d.om.entryAT());
        trapIf();
      }
      if (this.d.accessorsLive) {
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        this.d.isAccessorCell(c);
        trapIf();
      }
      c.localGet(NODE);
      c.structGet(S, SHAPE_PARENT);
      c.localSet(NODE);
      c.br(0);
      c.end();
      c.end();
      this.k.mb.setBody(idx, [I32, this.d.shapes.shapeRef(), this.d.entryRef()], c.bytes());
    });
  }

  /** %w.ic.check(recv, payload, key, value) → value, trapping unless the
   * payload keeps its shape's promise and keyGet answers the very same
   * box. */
  answerFn(): number {
    const params = [this.d.dynRef(), this.d.objRef(), this.k.deps.strRef(), this.d.dynRef()];
    return this.k.cached("icCheck", params, [this.d.dynRef()], (idx) => {
      const c = new Code();
      c.localGet(1);
      c.call(this.promiseFn());
      c.localGet(0);
      c.localGet(2);
      c.i32Const(0);
      c.call(this.d.keyGet());
      c.localGet(3);
      c.refEq();
      c.i32Eqz();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.localGet(3);
      this.k.mb.setBody(idx, [], c.bytes());
    });
  }
}
