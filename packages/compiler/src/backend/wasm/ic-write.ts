/* U8c: the store cache at a dynamic property write
 * (docs/design/u8-dynamic-speed.md §4, "Writes").
 *
 * A strict-mode write whose key is a compile-time literal (`p.a = v`,
 * `p["a"] = v`) gets a site of IC_WAYS ways (ic-ways.ts). A way is one of:
 *
 *   - an EXISTING-KEY way (shape S, index i >= 0): S holds the key at
 *     entry i, so the write stores the value into that entry in place;
 *   - an APPEND way (shape S, index -1 - k, and the way's own global
 *     t_k = S's child for the key): the key is absent under S, so the write
 *     appends the entry with t_k's canonical key and moves the object to
 *     t_k (a transition).
 *
 * Why a hit is keySet's write. A shaped payload is a plain, extensible
 * object whose every entry is a writable data entry (no `$dynEntryA`, no
 * accessor cell), with no hidden key, no `%` or symbol key (so it is no
 * error encoding) and no exotic subtype (shapes.ts). For such a receiver
 * keySet's arms before the object write pass it through (the BigInt,
 * symbol, typed-array, URL, template-strings, error-prototype and RegExp
 * fences all test kinds or subtypes a shaped payload is not), and then:
 *
 *   - an own key: [[Set]] (objmodel.ts set, or the accessor-live lookup)
 *     finds the own writable data entry first and replaces its value
 *     (objPut), whatever the prototype holds;
 *   - an absent key: [[Set]] walks the prototype chain for a setter or a
 *     read-only key of that name before it appends. An append way is
 *     therefore filled for a receiver with no linked prototype (a
 *     payload that is not `$dynObjLinked`, or one whose link is null),
 *     whose chain ends at once: nothing up it can hold a setter or a
 *     read-only key; and (U8d) for a linked one whose whole chain the walk
 *     proves holds no such key at all (proto-ic.ts). Such a way records
 *     the prototype epoch it was proved at (its global e_k) and hits only
 *     while the epoch is unchanged, since no object on the chain can gain
 *     the key without moving it; a stale way takes the miss path, which
 *     re-proves it in place (at most IC_PROTO_REFRESHES times per site).
 *     The shape tells the two apart: a shape under the root of the objects
 *     with no link is never a linked receiver's (shapes.ts roots).
 *
 * The value must not be an accessor cell (the in-place replace drops the
 * shape for one, shapes.ts emitReplace): where accessors are live, a
 * JSVAL-tagged value takes the miss path, which is keySet.
 *
 * The miss helper (%w.dyn.icSetMiss) is keySet, bracketed: it notes the
 * receiver's shape before the write and after it and offers a way when the
 * write was one of the two above (the shape unchanged and holding the key:
 * existing-key; the new shape the old one's child for the key, with no
 * linked prototype or a chain proved free of the key: append). A write that threw offers nothing. Nullish
 * receivers, frozen, sealed and non-extensible objects, setters,
 * read-only keys, arrays, views and every fence keep keySet's paths and
 * messages, because none of those receivers is shaped.
 *
 * Every write the cache does lands at one of the table's writer
 * chokepoints' rules: the in-place store is objPut's replace (a data
 * value into a plain entry, which keeps the shape) and the append is
 * objPutBody's (dyn.ts emitEntryPush, after the shape walk the way
 * cached).
 *
 * Sloppy-mode writes (a script's) are cached too: a write the cache does
 * itself is never one sloppy code would reject or ignore (a shaped
 * receiver is an extensible plain object, never a primitive or a frozen
 * strings array), so only the uncached paths differ, and they call
 * keySet's sloppy form (dyn.ts sloppySet), each helper in its own sloppy
 * twin. Not cached: `__proto__` and every computed key.
 *
 * SCRIPTC_WASM_SHAPE_CHECK=1 re-proves every write the cache does: after
 * it stores, the payload must keep its (possibly new) shape's promise and
 * keyGet must read back the very box stored (ic-check.ts). */
import type { DynBuilder } from "./dyn.js";
import { DK, DYN_KIND, DYN_REF, ENTRY_VALUE, OBJ_ENTRIES, OBJ_LEN } from "./dyn.js";
import { Code } from "./code.js";
import { IcCheck, shapeCheckOn } from "./ic-check.js";
import { countSetHit, countSetMiss } from "./ic-stats.js";
import { emitFill, emitMayFill, emitWayMatch, IC_PROTO_REFRESHES, IC_WAYS, newIcSite } from "./ic-ways.js";
import { I32, I64 } from "./module.js";
import { WALK_ABSENT } from "./proto-ic.js";
import { SHAPE_COUNT, SHAPE_KEY, SHAPE_PARENT } from "./shapes.js";

export interface WriteIcDeps {
  /** Push the pooled literal `value` onto `c`. */
  pushStrLit: (c: Code, value: string) => void;
}

/** The scratch locals a store site works in. */
export interface WriteIcLocals {
  /** The receiver box and the value box (set by the caller). */
  r: number;
  v: number;
  /** objRef(), the shape ref, i32. */
  p: number;
  sh: number;
  i: number;
}

/** A store site's way code before the match: no way matched. */
const NO_WAY = -0x80000000;

export class WriteIc {
  private fillSG: number | null = null;
  private fillIG: number | null = null;
  private fillTG: number | null = null;
  private fillEG: number | null = null;
  private readonly check = shapeCheckOn();
  private readonly checks: IcCheck;

  constructor(
    private readonly d: DynBuilder,
    private readonly deps: WriteIcDeps,
  ) {
    this.checks = new IcCheck(d);
  }

  private get k() {
    return this.d.shapesKit();
  }

  private shapeGlobal(): number {
    return this.k.mb.addGlobal(this.d.shapes.shapeRef(), true, (w) => {
      w.u8(0xd0); // ref.null $shape
      w.sleb(this.d.shapes.shapeT());
    });
  }

  /** The way the miss helper offers: the shape before the write (null
   * when it offers none), the existing key's index (-1 for an append) and
   * the shape after an append. */
  private fillS(): number {
    this.fillSG ??= this.shapeGlobal();
    return this.fillSG;
  }

  private fillI(): number {
    this.fillIG ??= this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    return this.fillIG;
  }

  private fillT(): number {
    this.fillTG ??= this.shapeGlobal();
    return this.fillTG;
  }

  /** The epoch an append offer was proved at (U8d). */
  private fillE(): number {
    this.fillEG ??= this.i64Global();
    return this.fillEG;
  }

  private i64Global(): number {
    return this.k.mb.addGlobal(I64, true, (w) => {
      w.u8(0x42); // i64.const 0
      w.sleb64(0n);
    });
  }

  /** May a linked payload's prototype link hold something (a setter, a
   * read-only key) an append must see? Only where links exist (the object
   * model's modules are among them, emitter.ts objCreateLive), and there
   * the prototype epoch guards linked appends. */
  private get linksLive(): boolean {
    return this.d.protoLinkLive;
  }

  /** With an OBJ payload in local `p`, leaves i32: does it have a linked
   * prototype (a `$dynObjLinked` payload whose link is not null)? */
  private emitHasLink(c: Code, p: number): void {
    const L = this.d.objLinkedT();
    c.localGet(p);
    c.refTest(L);
    c.ifResult(I32);
    c.localGet(p);
    c.refCast(L);
    c.structGet(L, this.d.olProto());
    c.refIsNull();
    c.i32Eqz();
    c.else_();
    c.i32Const(0);
    c.end();
  }

  /** keySet, or its sloppy-mode form. */
  private setter(sloppy: boolean): number {
    return sloppy ? this.d.sloppySet("keySet") : this.d.keySet();
  }

  /** The write `recv.key = value` (sloppy-mode code's when `sloppy`) with
   * the receiver box in `ls.r` and the value box in `ls.v`; leaves nothing
   * (keySet's error pending on a throw; the caller owns the pending
   * check). */
  emitSet(c: Code, key: string, sloppy: boolean, ls: WriteIcLocals): void {
    const site = newIcSite(this.d);
    const t: number[] = Array.from({ length: IC_WAYS }, () => this.shapeGlobal());
    const links = this.linksLive;
    const e: number[] = links ? Array.from({ length: IC_WAYS }, () => this.i64Global()) : [];
    const rf = links ? this.i32Global() : -1;
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    c.block(); // $out
    c.block(); // $miss
    if (links) {
      // no way matched (a stale append way leaves its code -1 - k here)
      c.i32Const(NO_WAY);
      c.localSet(ls.i);
    }
    if (this.d.accessorsLive) {
      // an accessor cell is never stored by the cache (see the header)
      c.localGet(ls.v);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.JSVAL);
      c.i32Eq();
      c.brIf(0);
    }
    c.localGet(ls.r);
    c.structGet(dynT, DYN_KIND);
    c.i32Const(DK.OBJ);
    c.i32Ne();
    c.brIf(0);
    if (this.d.viewsLive) {
      c.localGet(ls.r);
      c.structGet(dynT, DYN_REF);
      c.refTest(objT);
      c.i32Eqz();
      c.brIf(0);
    }
    c.localGet(ls.r);
    c.structGet(dynT, DYN_REF);
    c.refCast(objT);
    c.localTee(ls.p);
    c.structGet(objT, this.d.objShapeField());
    c.localSet(ls.sh);
    emitWayMatch(c, site, ls.sh, 0);
    c.localTee(ls.i);
    c.i32Const(0);
    c.i32GeS();
    c.ifVoid();
    // an existing key: the value in place
    c.localGet(ls.p);
    c.structGet(objT, OBJ_ENTRIES);
    c.localGet(ls.i);
    c.arrayGet(this.d.entriesArrayType());
    c.localGet(ls.v);
    c.structSet(this.d.entryT(), ENTRY_VALUE);
    if (this.check) {
      c.localGet(ls.r);
      c.localGet(ls.p);
      this.deps.pushStrLit(c, key);
      c.localGet(ls.v);
      c.call(this.checks.answerFn());
      c.drop();
    }
    countSetHit(c);
    c.else_();
    // an append way: its transition, chosen by the way's code -1 - k
    c.localGet(ls.r);
    c.localGet(ls.p);
    for (let k = 0; k < IC_WAYS - 1; k++) {
      c.localGet(ls.i);
      c.i32Const(-1 - k);
      c.i32Eq();
      c.ifResult(this.d.shapes.shapeRef());
      c.globalGet(t[k]!);
      c.else_();
    }
    c.globalGet(t[IC_WAYS - 1]!);
    for (let k = 0; k < IC_WAYS - 1; k++) c.end();
    c.localGet(ls.v);
    this.deps.pushStrLit(c, key);
    if (links) {
      this.emitPickEpoch(c, e, ls.i);
      c.call(this.appendFn(sloppy));
      // a stale way wrote nothing: the miss
      c.i32Eqz();
      c.brIf(1);
    } else {
      c.call(this.appendFn(sloppy));
    }
    c.end();
    c.br(1);
    c.end();
    // the miss: fill while the site may (not megamorphic; a stale append
    // way within its refresh budget), else keySet
    emitMayFill(c, site);
    if (links) {
      this.emitStale(c, ls.i);
      c.globalGet(rf);
      c.i32Const(IC_PROTO_REFRESHES);
      c.i32GeU();
      c.i32And();
      c.i32Eqz();
      c.i32And();
    }
    c.ifVoid();
    c.localGet(ls.r);
    this.deps.pushStrLit(c, key);
    c.localGet(ls.v);
    c.call(this.missFn(sloppy));
    if (links) {
      this.emitStale(c, ls.i);
      c.ifVoid();
      this.emitRefresh(c, { t, e, rf, sh: ls.sh, i: ls.i });
      c.else_();
    }
    c.globalGet(this.fillS());
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    emitFill(c, site, (x, k) => {
      x.globalGet(this.fillS());
      x.globalSet(site.s[k]!);
      x.globalGet(this.fillI());
      x.i32Const(0);
      x.i32GeS();
      x.ifResult(I32);
      x.globalGet(this.fillI());
      x.else_();
      x.i32Const(-1 - k);
      x.end();
      x.globalSet(site.i[k]!);
      x.globalGet(this.fillT());
      x.globalSet(t[k]!);
      if (links) {
        x.globalGet(this.fillE());
        x.globalSet(e[k]!);
      }
    });
    c.end();
    if (links) c.end();
    c.else_();
    countSetMiss(c);
    c.localGet(ls.r);
    this.deps.pushStrLit(c, key);
    c.localGet(ls.v);
    c.call(this.setter(sloppy));
    c.end();
    c.end();
  }

  /** %w.dyn.icAppend(recv, payload, after, value, key[, epoch]): an
   * append way's write. The payload carries the way's shape, `after` is
   * that shape's child for `key`: appends the entry under `after`'s
   * canonical key and moves the payload to `after`. Where links exist it
   * takes the way's epoch and answers i32: 0, writing nothing, when the
   * receiver is linked and the epoch has moved since the way was proved
   * (the site then misses); 1 for the write done. */
  private appendFn(sloppy: boolean): number {
    const objT = this.d.objT();
    const S = this.d.shapes.shapeT();
    const links = this.linksLive;
    const params = [this.d.dynRef(), this.d.objRef(), this.d.shapes.shapeRef(), this.d.dynRef(), this.k.deps.strRef()];
    if (links) params.push(I64);
    return this.k.cached(sloppy ? "icAppend:sloppy" : "icAppend", params, links ? [I32] : [], (idx) => {
      const c = new Code();
      const base = links ? 6 : 5;
      const N = base;
      const NB = base + 1;
      const K = base + 2;
      if (links) {
        this.emitHasLink(c, 1);
        c.ifVoid();
        c.localGet(5);
        c.globalGet(this.d.protoIc.epochG());
        c.i64Ne();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.end();
      }
      c.localGet(1);
      c.structGet(objT, OBJ_LEN);
      c.localSet(N);
      c.localGet(2);
      c.structGet(S, SHAPE_KEY);
      c.localSet(K);
      this.d.emitEntryPush(c, 1, N, K, 3, NB);
      c.localGet(1);
      c.localGet(2);
      c.structSet(objT, this.d.objShapeField());
      if (this.check) {
        c.localGet(0);
        c.localGet(1);
        c.localGet(4);
        c.localGet(3);
        c.call(this.checks.answerFn());
        c.drop();
      }
      countSetHit(c);
      if (links) c.i32Const(1);
      this.k.mb.setBody(
        idx,
        [I32, { kind: "ref", nullable: true, typeIndex: this.d.entriesArrayType() }, this.k.deps.strRef()],
        c.bytes(),
      );
    });
  }

  /** %w.dyn.icSetMiss(recv, key, value): keySet (its sloppy form in the
   * sloppy twin), offering the way the
   * write turned out to be (fillS, fillI, fillT; fillS null for none). */
  private missFn(sloppy: boolean): number {
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    const S = this.d.shapes.shapeT();
    return this.k.cached(sloppy ? "icSetMiss:sloppy" : "icSetMiss", [this.d.dynRef(), this.k.deps.strRef(), this.d.dynRef()], [], (idx) => {
      const c = new Code();
      const P = 3;
      const B = 4;
      const A = 5;
      const J = 6;
      countSetMiss(c);
      // the shape before
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
      c.localSet(B);
      c.end();
      c.end();
      c.localGet(0);
      c.localGet(1);
      c.localGet(2);
      c.call(this.setter(sloppy));
      // keySet can run a setter whose own cached writes miss and offer a
      // way: this write offers only its own.
      c.refNull(S);
      c.globalSet(this.fillS());
      c.globalGet(this.k.deps.excKind());
      c.localGet(B);
      c.refIsNull();
      c.i32Or();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(objT, this.d.objShapeField());
      c.localTee(A);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      // the shape unchanged: an existing key, if the shape holds it
      c.localGet(A);
      c.localGet(B);
      c.refEq();
      c.ifVoid();
      c.localGet(B);
      c.localGet(1);
      c.call(this.indexFn());
      c.localTee(J);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(B);
      c.globalSet(this.fillS());
      c.localGet(J);
      c.globalSet(this.fillI());
      c.end();
      c.return_();
      c.end();
      // the old shape's child for the key: an append, with no link
      c.localGet(A);
      c.structGet(S, SHAPE_PARENT);
      c.localGet(B);
      c.refEq();
      c.ifVoid();
      c.localGet(A);
      c.structGet(S, SHAPE_KEY);
      c.localGet(1);
      c.call(this.k.deps.strEq());
      if (this.linksLive) {
        // no link, or (U8d) a chain proved free of the key, now
        c.ifResult(I32);
        this.emitHasLink(c, P);
        c.ifResult(I32);
        c.localGet(P);
        c.localGet(1);
        c.call(this.d.protoIc.walkFn());
        c.i32Const(WALK_ABSENT);
        c.i32Eq();
        c.else_();
        c.i32Const(1);
        c.end();
        c.else_();
        c.i32Const(0);
        c.end();
      }
      c.ifVoid();
      c.localGet(B);
      c.globalSet(this.fillS());
      c.i32Const(-1);
      c.globalSet(this.fillI());
      c.localGet(A);
      c.globalSet(this.fillT());
      if (this.linksLive) {
        c.globalGet(this.d.protoIc.epochG());
        c.globalSet(this.fillE());
      }
      c.end();
      c.end();
      this.k.mb.setBody(idx, [this.d.objRef(), this.d.shapes.shapeRef(), this.d.shapes.shapeRef(), I32], c.bytes());
    });
  }

  private i32Global(): number {
    return this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
  }

  /** Pushes the epoch global of the append way whose code -1 - k is in
   * local `i`. */
  private emitPickEpoch(c: Code, e: number[], i: number): void {
    for (let k = 0; k < IC_WAYS - 1; k++) {
      c.localGet(i);
      c.i32Const(-1 - k);
      c.i32Eq();
      c.ifResult(I64);
      c.globalGet(e[k]!);
      c.else_();
    }
    c.globalGet(e[IC_WAYS - 1]!);
    for (let k = 0; k < IC_WAYS - 1; k++) c.end();
  }

  /** Leaves i32: did the miss come from a stale append way (local `i`
   * holds a way's code -1 - k, not NO_WAY)? */
  private emitStale(c: Code, i: number): void {
    c.localGet(i);
    c.i32Const(0);
    c.i32LtS();
    c.localGet(i);
    c.i32Const(NO_WAY);
    c.i32Ne();
    c.i32And();
  }

  /** A stale append way -1 - k (local `i`) after the miss helper ran: one
   * attempt of the site's refresh budget; when the offer is an append for
   * the same shape, way k takes its transition and new epoch. */
  private emitRefresh(c: Code, l: { t: number[]; e: number[]; rf: number; sh: number; i: number }): void {
    c.globalGet(l.rf);
    c.i32Const(1);
    c.i32Add();
    c.globalSet(l.rf);
    c.globalGet(this.fillI());
    c.i32Const(0);
    c.i32LtS();
    c.localGet(l.sh);
    c.globalGet(this.fillS());
    c.refEq();
    c.i32And();
    c.ifVoid();
    for (let k = 0; k < IC_WAYS; k++) {
      c.localGet(l.i);
      c.i32Const(-1 - k);
      c.i32Eq();
      c.ifVoid();
      c.globalGet(this.fillT());
      c.globalSet(l.t[k]!);
      c.globalGet(this.fillE());
      c.globalSet(l.e[k]!);
      c.end();
    }
    c.end();
  }

  /** %w.dyn.shapeIndex(shape, key) → i32: the entry index `key` has under
   * `shape` (the depth of the node that appended it, less one), or -1. */
  private indexFn(): number {
    const S = this.d.shapes.shapeT();
    return this.k.cached("shapeIndex", [this.d.shapes.shapeRef(), this.k.deps.strRef()], [I32], (idx) => {
      const c = new Code();
      c.block();
      c.loop();
      c.localGet(0);
      c.structGet(S, SHAPE_COUNT);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(0);
      c.structGet(S, SHAPE_KEY);
      c.localGet(1);
      c.call(this.k.deps.strEq());
      c.ifVoid();
      c.localGet(0);
      c.structGet(S, SHAPE_COUNT);
      c.i32Const(1);
      c.i32Sub();
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(S, SHAPE_PARENT);
      c.localSet(0);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(-1);
      this.k.mb.setBody(idx, [], c.bytes());
    });
  }
}
