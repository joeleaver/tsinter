/* U8b: the single-shape inline cache at a dynamic property read
 * (docs/design/u8-dynamic-speed.md §4).
 *
 * A read whose key is a compile-time literal (`p.a`, `p["a"]`, and the typed
 * leaf `const a: number = p.a`, whose check reads the box this read yields)
 * gets three mutable globals of its own:
 *
 *   s0: ref null $shape   the cached shape (starts as the $noShape
 *                         sentinel, which no object carries)
 *   i0: i32               the key's entry index under s0
 *   fills: i32            how many times the site has been filled
 *
 * Plain globals rather than one struct, because the hit path then loads
 * each straight from the instance. The read's fast path is inline at the
 * site: an OBJ box whose payload is a `$dynObj` carrying shape `s0`
 * answers `entries[i0]`'s value, with no call.
 *
 * A miss calls the shared miss helper, which answers and, for a shaped
 * receiver's own entry, leaves the (shape, index) pair in two module
 * globals that the site copies into its own. A site that has been filled
 * IC_FILL_LIMIT times stops refilling and reads every miss through keyGet
 * directly: a site that sees a new shape on every read (poly2, poly4) then
 * costs today's read plus one compare, never a refill per read (a store of
 * a reference is the expensive part of a fill). It keeps hitting the last
 * shape it cached. The 2-4-way caches are U8c's.
 *
 * Why a hit is keyGet's answer. A shaped payload is a plain object
 * (shapes.ts): never a URL, RegExp, container stand-in, error prototype or
 * the Object.prototype stand-in, has no `%` or symbol key (so no error
 * encoding), no attributed entry, no accessor cell and no hidden key. For
 * such a receiver every keyGet arm before the table scan passes it through,
 * and the scan answers the own entry whose key is the literal, which the
 * shape puts at index `i0`. The shape is a fact about the table's keys, so
 * (s0, i0) stays true for as long as any object carries s0.
 *
 * The miss helper (%w.dyn.icMiss) scans a shaped receiver's own entries for
 * the key: found, it offers (shape, index) and answers the entry's value;
 * otherwise (dictionary mode, an absent key, any other kind) it is exactly
 * the old read, keyGet. Nullish receivers, `?.`, getters, prototype reads
 * and every fence keep keyGet's paths and messages.
 *
 * Not cached: names the prototype fence tables model and `constructor`
 * (emitter.ts emitDynGetProp keeps them on their helpers), `__proto__`, and
 * every computed key.
 *
 * SCRIPTC_WASM_SHAPE_CHECK=1 (compile time, never on by default) re-proves
 * every answer the cache gives, on both paths: the receiver's whole table
 * against its shape's promise, and the answer against keyGet's own (the
 * same box). A broken promise traps. */
import type { DynBuilder } from "./dyn.js";
import { DK, DYN_KIND, DYN_REF, ENTRY_KEY, ENTRY_VALUE, OBJ_ENTRIES, OBJ_LEN, OBJ_PROTO, OBJ_PROTO_NULL } from "./dyn.js";
import { Code } from "./code.js";
import { countIcHit, countIcMiss } from "./ic-stats.js";
import { I32, type ValType } from "./module.js";
import { SHAPE_COUNT, SHAPE_KEY, SHAPE_PARENT } from "./shapes.js";

/** How many times a site fills before it stops refilling (see above). */
export const IC_FILL_LIMIT = 16;

/** Is the shape-check mode on for this build? Read per build, from the
 * compiler's environment (as SCRIPTC_WASM_IC_STATS is). */
export function shapeCheckOn(): boolean {
  return process.env["SCRIPTC_WASM_SHAPE_CHECK"] === "1";
}

/** May a read of this literal key carry a cache? `__proto__` keeps its own
 * path (an own data key of that name exists only through JSON.parse, and
 * the accessor's reads are not this cache's business). */
export function icCacheableKey(key: string): boolean {
  return key !== "__proto__";
}

/** Where a cached read takes its two scratch locals (and gives them back). */
export interface IcLocals {
  get: (t: ValType) => number;
  put?: (t: ValType, index: number) => void;
}

export interface ReadIcDeps {
  /** Push the pooled literal `value` onto `c`. */
  pushStrLit: (c: Code, value: string) => void;
}

export class ReadIc {
  private fillSG: number | null = null;
  private fillIG: number | null = null;
  private readonly check = shapeCheckOn();

  constructor(
    private readonly d: DynBuilder,
    private readonly deps: ReadIcDeps,
  ) {}

  private get k() {
    return this.d.shapesKit();
  }

  /** The pair the miss helper offers: the shape (null when it offers
   * none) and the entry index. */
  private fillS(): number {
    this.fillSG ??= this.k.mb.addGlobal(this.d.shapes.shapeRef(), true, (w) => {
      w.u8(0xd0); // ref.null $shape
      w.sleb(this.d.shapes.shapeT());
    });
    return this.fillSG;
  }

  private fillI(): number {
    this.fillIG ??= this.i32Global();
    return this.fillIG;
  }

  private i32Global(): number {
    return this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
  }

  /** A fresh site's globals: s0 the no-shape sentinel, i0 and fills 0. */
  private newSite(): { s0: number; i0: number; fills: number } {
    const none = this.d.shapes.noShapeG();
    const s0 = this.k.mb.addGlobal(this.d.shapes.shapeRef(), true, (w) => {
      w.u8(0x23); // global.get $noShape
      w.uleb(none);
    });
    return { s0, i0: this.i32Global(), fills: this.i32Global() };
  }

  /** The read `recv.key` with the receiver box on the stack: leaves the
   * value (null with an error pending, as keyGet does; the caller owns the
   * pending check). `r` is a scratch local of dynRef(), `p` of objRef(). */
  emitGet(c: Code, key: string, optional: boolean, r: number, p: number): void {
    const site = this.newSite();
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    c.localSet(r);
    c.blockResult(this.d.dynRef());
    c.block();
    c.localGet(r);
    c.structGet(dynT, DYN_KIND);
    c.i32Const(DK.OBJ);
    c.i32Ne();
    c.brIf(0);
    if (this.d.viewsLive) {
      // An OBJ box's payload is a `$dynObj` unless it is a view (dyn.ts
      // objPayload); a view reads through the miss helper.
      c.localGet(r);
      c.structGet(dynT, DYN_REF);
      c.refTest(objT);
      c.i32Eqz();
      c.brIf(0);
    }
    c.localGet(r);
    c.structGet(dynT, DYN_REF);
    c.refCast(objT);
    c.localTee(p);
    c.structGet(objT, this.d.objShapeField());
    c.globalGet(site.s0);
    c.refEq();
    c.i32Eqz();
    c.brIf(0);
    if (this.check) {
      c.localGet(r);
      c.localGet(p);
      this.deps.pushStrLit(c, key);
    }
    c.localGet(p);
    c.structGet(objT, OBJ_ENTRIES);
    c.globalGet(site.i0);
    c.arrayGet(this.d.entriesArrayType());
    c.structGet(this.d.entryT(), ENTRY_VALUE);
    if (this.check) c.call(this.checkFn());
    countIcHit(c);
    c.br(1);
    c.end();
    // the miss: fill while the site may, else the uncached read
    c.globalGet(site.fills);
    c.i32Const(IC_FILL_LIMIT);
    c.i32LtU();
    c.ifResult(this.d.dynRef());
    c.localGet(r);
    this.deps.pushStrLit(c, key);
    c.i32Const(optional ? 1 : 0);
    c.call(this.missFn());
    c.globalGet(this.fillS());
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.globalGet(this.fillS());
    c.globalSet(site.s0);
    c.globalGet(this.fillI());
    c.globalSet(site.i0);
    c.globalGet(site.fills);
    c.i32Const(1);
    c.i32Add();
    c.globalSet(site.fills);
    c.end();
    c.else_();
    countIcMiss(c);
    c.localGet(r);
    this.deps.pushStrLit(c, key);
    c.i32Const(optional ? 1 : 0);
    c.call(this.d.keyGet());
    c.end();
    c.end();
  }

  /** %w.dyn.icMiss(recv, key, optional) → the read's value: a shaped
   * receiver's own entry answers and is offered to the site (fillS, fillI);
   * anything else reads through keyGet (null with an error pending, as
   * keyGet) and offers nothing (fillS null). */
  private missFn(): number {
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    const entryT = this.d.entryT();
    return this.k.cached("icMiss", [this.d.dynRef(), this.k.deps.strRef(), I32], [this.d.dynRef()], (idx) => {
      const c = new Code();
      const P = 3;
      const S = 4;
      const N = 5;
      const J = 6;
      const E = 7;
      countIcMiss(c);
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Eq();
      c.ifVoid();
      c.localGet(0);
      c.structGet(dynT, DYN_REF);
      c.refTest(objT);
      c.ifVoid();
      c.localGet(0);
      c.structGet(dynT, DYN_REF);
      c.refCast(objT);
      c.localTee(P);
      c.structGet(objT, this.d.objShapeField());
      c.localTee(S);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(P);
      c.structGet(objT, OBJ_LEN);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(J);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(P);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(J);
      c.arrayGet(this.d.entriesArrayType());
      c.localTee(E);
      c.structGet(entryT, ENTRY_KEY);
      c.localGet(1);
      c.call(this.k.deps.strEq());
      c.ifVoid();
      if (this.check) {
        c.localGet(0);
        c.localGet(P);
        c.localGet(1);
      }
      c.localGet(E);
      c.structGet(entryT, ENTRY_VALUE);
      if (this.check) c.call(this.checkFn());
      // offered last, after anything that can run code
      c.localGet(S);
      c.globalSet(this.fillS());
      c.localGet(J);
      c.globalSet(this.fillI());
      c.return_();
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.end();
      c.end();
      c.end();
      c.localGet(0);
      c.localGet(1);
      c.localGet(2);
      c.call(this.d.keyGet());
      // keyGet can run a getter whose own cached reads miss and offer a
      // pair: this read offers none.
      c.refNull(this.d.shapes.shapeT());
      c.globalSet(this.fillS());
      this.k.mb.setBody(idx, [this.d.objRef(), this.d.shapes.shapeRef(), I32, I32, this.d.entryRef()], c.bytes());
    });
  }

  /** SCRIPTC_WASM_SHAPE_CHECK=1: %w.ic.check(recv, payload, key, value) →
   * value, trapping unless the payload keeps its shape's promise and
   * keyGet answers the very same box. */
  private checkFn(): number {
    const objT = this.d.objT();
    const entryT = this.d.entryT();
    const S = this.d.shapes.shapeT();
    const params = [this.d.dynRef(), this.d.objRef(), this.k.deps.strRef(), this.d.dynRef()];
    return this.k.cached("icCheck", params, [this.d.dynRef()], (idx) => {
      const c = new Code();
      const N = 4;
      const NODE = 5;
      const E = 6;
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
        c.localGet(1);
        c.refTest(t);
        trapIf();
      }
      c.localGet(1);
      c.structGet(objT, OBJ_PROTO);
      c.i32Const(OBJ_PROTO_NULL);
      c.i32GtU();
      trapIf();
      // the object model's promises: no hidden key, extensible
      if (this.d.objModelLive) {
        const L = this.d.objLinkedT();
        c.localGet(1);
        c.refTest(L);
        c.ifVoid();
        c.localGet(1);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 2);
        c.localGet(1);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 3);
        c.i32Or();
        trapIf();
        c.end();
      }
      // len == count, and each entry is the shape's key, plain and data
      c.localGet(1);
      c.structGet(objT, this.d.objShapeField());
      c.localTee(NODE);
      c.refIsNull();
      trapIf();
      c.localGet(1);
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
      c.localGet(1);
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
      // the answer is keyGet's own
      c.localGet(0);
      c.localGet(2);
      c.i32Const(0);
      c.call(this.d.keyGet());
      c.localGet(3);
      c.refEq();
      c.i32Eqz();
      trapIf();
      c.localGet(3);
      this.k.mb.setBody(idx, [I32, this.d.shapes.shapeRef(), this.d.entryRef()], c.bytes());
    });
  }
}
