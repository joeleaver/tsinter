/* U8b + U8c: the polymorphic inline cache at a dynamic property read
 * (docs/design/u8-dynamic-speed.md §4).
 *
 * A read whose key is a compile-time literal (`p.a`, `p["a"]`, and the typed
 * leaf `const a: number = p.a`, whose check reads the box this read yields)
 * gets a site of IC_WAYS ways (ic-ways.ts): each way a cached shape and
 * the key's entry index under it, plus the site's fill state. The read's
 * fast path is inline at the site: an OBJ box whose payload is a `$dynObj`
 * carrying one of the ways' shapes answers `entries[i]`'s value, with no
 * call. The first way is one compare, as U8b's single-way site was.
 *
 * A miss calls the shared miss helper, which answers and, for a shaped
 * receiver's own entry, leaves the (shape, index) pair in two module
 * globals that the site copies into its next free way. A site whose ways
 * are all taken goes megamorphic on the next offer: from then on it reads
 * every miss through keyGet directly (today's read plus the compares) and
 * keeps hitting its ways. Ways are never replaced, so a site pays at most
 * IC_WAYS fills (a store of a reference is the expensive part of one).
 *
 * Why a hit is keyGet's answer. A shaped payload is a plain object
 * (shapes.ts): never a URL, RegExp, container stand-in, error prototype or
 * the Object.prototype stand-in, has no `%` or symbol key (so no error
 * encoding), no attributed entry, no accessor cell and no hidden key. For
 * such a receiver every keyGet arm before the table scan passes it through,
 * and the scan answers the own entry whose key is the literal, which the
 * shape puts at the way's index. The shape is a fact about the table's
 * keys, so a way stays true for as long as any object carries its shape.
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
 * SCRIPTC_WASM_SHAPE_CHECK=1 re-proves every answer the cache gives, on
 * both paths (ic-check.ts). */
import type { DynBuilder } from "./dyn.js";
import { DK, DYN_KIND, DYN_REF, ENTRY_KEY, ENTRY_VALUE, OBJ_ENTRIES, OBJ_LEN } from "./dyn.js";
import { Code } from "./code.js";
import { IcCheck, shapeCheckOn } from "./ic-check.js";
import { countIcHit, countIcMiss } from "./ic-stats.js";
import { emitFill, emitMayFill, emitWayMatch, newIcSite } from "./ic-ways.js";
import { I32, type ValType } from "./module.js";

/** May a read or store of this literal key carry a cache? `__proto__`
 * keeps its own path (an own data key of that name exists only through
 * JSON.parse, and the accessor's reads and writes are not this cache's
 * business). */
export function icCacheableKey(key: string): boolean {
  return key !== "__proto__";
}

/** Where a cached site takes its scratch locals (and gives them back). */
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
  private readonly checks: IcCheck;

  constructor(
    private readonly d: DynBuilder,
    private readonly deps: ReadIcDeps,
  ) {
    this.checks = new IcCheck(d);
  }

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
    this.fillIG ??= this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    return this.fillIG;
  }

  /** The read `recv.key` with the receiver box on the stack: leaves the
   * value (null with an error pending, as keyGet does; the caller owns the
   * pending check). `r` is a scratch local of dynRef(), `p` of objRef(),
   * `sh` of the shape ref. */
  emitGet(c: Code, key: string, optional: boolean, r: number, p: number, sh: number): void {
    const site = newIcSite(this.d);
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    c.localSet(r);
    c.blockResult(this.d.dynRef()); // $out
    c.block(); // $miss
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
    c.localSet(sh);
    if (this.check) {
      c.localGet(r);
      c.localGet(p);
      this.deps.pushStrLit(c, key);
    }
    c.localGet(p);
    c.structGet(objT, OBJ_ENTRIES);
    emitWayMatch(c, site, sh, 0);
    c.arrayGet(this.d.entriesArrayType());
    c.structGet(this.d.entryT(), ENTRY_VALUE);
    if (this.check) c.call(this.checks.answerFn());
    countIcHit(c);
    c.br(1);
    c.end();
    // the miss: fill while the site may, else the uncached read
    emitMayFill(c, site);
    c.ifResult(this.d.dynRef());
    c.localGet(r);
    this.deps.pushStrLit(c, key);
    c.i32Const(optional ? 1 : 0);
    c.call(this.missFn());
    c.globalGet(this.fillS());
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    emitFill(c, site, (x, k) => {
      x.globalGet(this.fillS());
      x.globalSet(site.s[k]!);
      x.globalGet(this.fillI());
      x.globalSet(site.i[k]!);
    });
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
      if (this.check) c.call(this.checks.answerFn());
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
}
