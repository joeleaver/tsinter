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
 * the old read, keyGet. Nullish receivers, `?.`, getters and every fence
 * keep keyGet's paths and messages.
 *
 * U8d, chain ways (where prototype links exist, proto-ic.ts): after keyGet
 * answers a shaped receiver's read, the miss helper walks the chain and,
 * when the walk proves the very answer keyGet gave (a prototype's data
 * entry, or undefined for a key absent up the whole chain) with no epoch
 * move, offers a chain way: index -1 - k, and the way's `$protoWay`
 * (holder, index, epoch) in its global pw_k. A hit at a chain way checks
 * the epoch and reads the holder's entry. The receiver's shape implies its
 * prototype (shapes.ts roots) and every object on the chain is marked, so
 * the way holds while the epoch stands; a stale way misses and is
 * re-proved in place, at most IC_PROTO_REFRESHES times per site.
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
import { emitFill, emitMayFill, emitWayMatch, IC_PROTO_REFRESHES, IC_WAYS, newIcSite } from "./ic-ways.js";
import { I32, I64, type ValType } from "./module.js";
import { PW_EPOCH, PW_HOLDER, PW_INDEX, WALK_FOUND, WALK_NONE } from "./proto-ic.js";

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

/** May this key's site carry chain ways (U8d)? Not a reserved key (an
 * internal `%` name, a symbol's U+D800 '@@' key): keyGet answers those
 * through its own arms. */
function protoKeyOk(key: string): boolean {
  return !key.startsWith("%") && !key.startsWith("\uD800");
}

export class ReadIc {
  private fillSG: number | null = null;
  private fillIG: number | null = null;
  private fillWG: number | null = null;
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

  /** The way the miss helper offers: the shape (null when it offers
   * none), the entry index (-1 for a chain way) and, for a chain way, its
   * `$protoWay`. */
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

  private fillW(): number {
    this.fillWG ??= this.nullWayGlobal();
    return this.fillWG;
  }

  private nullWayGlobal(): number {
    const pi = this.d.protoIc;
    return this.k.mb.addGlobal(pi.wayRef(), true, (w) => {
      w.u8(0xd0); // ref.null $protoWay
      w.sleb(pi.wayT());
    });
  }

  /** The read `recv.key` with the receiver box on the stack: leaves the
   * value (null with an error pending, as keyGet does; the caller owns the
   * pending check). The site's scratch locals come from `ls`. */
  emitGet(c: Code, key: string, optional: boolean, ls: IcLocals): void {
    const dynRef = this.d.dynRef();
    const objRef = this.d.objRef();
    const shRef = this.d.shapes.shapeRef();
    const proto = this.d.protoIc.live && protoKeyOk(key);
    const r = ls.get(dynRef);
    const p = ls.get(objRef);
    const sh = ls.get(shRef);
    const I = proto ? ls.get(I32) : -1;
    const PW = proto ? ls.get(this.d.protoIc.wayRef()) : -1;
    this.emitSite(c, key, optional, { r, p, sh, I, PW }, proto);
    if (proto) {
      ls.put?.(this.d.protoIc.wayRef(), PW);
      ls.put?.(I32, I);
    }
    ls.put?.(shRef, sh);
    ls.put?.(objRef, p);
    ls.put?.(dynRef, r);
  }

  private emitSite(c: Code, key: string, optional: boolean, l: SiteLocals, proto: boolean): void {
    const site = newIcSite(this.d);
    const pw = proto ? Array.from({ length: IC_WAYS }, () => this.nullWayGlobal()) : [];
    const rf = proto ? this.i32Global() : -1;
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    c.localSet(l.r);
    c.blockResult(this.d.dynRef()); // $out
    c.block(); // $miss
    if (proto) {
      // no way matched (a stale chain way leaves its code -1 - k here)
      c.i32Const(0);
      c.localSet(l.I);
    }
    c.localGet(l.r);
    c.structGet(dynT, DYN_KIND);
    c.i32Const(DK.OBJ);
    c.i32Ne();
    c.brIf(0);
    if (this.d.viewsLive) {
      // An OBJ box's payload is a `$dynObj` unless it is a view (dyn.ts
      // objPayload); a view reads through the miss helper.
      c.localGet(l.r);
      c.structGet(dynT, DYN_REF);
      c.refTest(objT);
      c.i32Eqz();
      c.brIf(0);
    }
    c.localGet(l.r);
    c.structGet(dynT, DYN_REF);
    c.refCast(objT);
    c.localTee(l.p);
    c.structGet(objT, this.d.objShapeField());
    c.localSet(l.sh);
    if (this.check) {
      c.localGet(l.r);
      c.localGet(l.p);
      this.deps.pushStrLit(c, key);
    }
    if (!proto) {
      c.localGet(l.p);
      c.structGet(objT, OBJ_ENTRIES);
      emitWayMatch(c, site, l.sh, 0);
      c.arrayGet(this.d.entriesArrayType());
      c.structGet(this.d.entryT(), ENTRY_VALUE);
    } else {
      emitWayMatch(c, site, l.sh, 0);
      c.localTee(l.I);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(this.d.dynRef());
      // an own way: the entry
      c.localGet(l.p);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(l.I);
      c.arrayGet(this.d.entriesArrayType());
      c.structGet(this.d.entryT(), ENTRY_VALUE);
      c.else_();
      this.emitChainHit(c, pw, l, 1);
      c.end();
    }
    if (this.check) c.call(this.checks.answerFn());
    countIcHit(c);
    c.br(1);
    c.end();
    // the miss: fill while the site may (not megamorphic; a stale chain
    // way within its refresh budget), else the uncached read
    emitMayFill(c, site);
    if (proto) {
      c.localGet(l.I);
      c.i32Const(0);
      c.i32LtS();
      c.globalGet(rf);
      c.i32Const(IC_PROTO_REFRESHES);
      c.i32GeU();
      c.i32And();
      c.i32Eqz();
      c.i32And();
    }
    c.ifResult(this.d.dynRef());
    c.localGet(l.r);
    this.deps.pushStrLit(c, key);
    c.i32Const(optional ? 1 : 0);
    c.call(this.missFn(proto));
    const setWay = (x: Code, k: number): void => {
      x.globalGet(this.fillS());
      x.globalSet(site.s[k]!);
      if (!proto) {
        x.globalGet(this.fillI());
        x.globalSet(site.i[k]!);
        return;
      }
      x.globalGet(this.fillI());
      x.i32Const(0);
      x.i32GeS();
      x.ifVoid();
      x.globalGet(this.fillI());
      x.globalSet(site.i[k]!);
      x.else_();
      x.i32Const(-1 - k);
      x.globalSet(site.i[k]!);
      x.globalGet(this.fillW());
      x.globalSet(pw[k]!);
      x.end();
    };
    const fillOffered = (): void => {
      c.globalGet(this.fillS());
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      emitFill(c, site, setWay);
      c.end();
    };
    if (!proto) {
      fillOffered();
    } else {
      c.localGet(l.I);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      this.emitRefresh(c, pw, rf, l);
      c.else_();
      fillOffered();
      c.end();
    }
    c.else_();
    countIcMiss(c);
    c.localGet(l.r);
    this.deps.pushStrLit(c, key);
    c.i32Const(optional ? 1 : 0);
    c.call(this.d.keyGet());
    c.end();
    c.end();
  }

  private i32Global(): number {
    return this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
  }

  /** A chain way's hit, with its code -1 - k in local I: picks way k's
   * `$protoWay` and, if the epoch is the one it was proved at, answers its
   * holder's entry (undefined for an absent key); a stale way branches to
   * the label `missDepth` levels out. */
  private emitChainHit(c: Code, pw: number[], l: SiteLocals, missDepth: number): void {
    const pi = this.d.protoIc;
    const W = pi.wayT();
    const objT = this.d.objT();
    c.blockResult(pi.wayRef()); // $sel
    for (let k = IC_WAYS - 1; k >= 0; k--) c.block(); // $w3 .. $w0
    c.i32Const(-1);
    c.localGet(l.I);
    c.i32Sub();
    c.brTable(
      Array.from({ length: IC_WAYS }, (_, k) => k),
      IC_WAYS - 1,
    );
    for (let k = 0; k < IC_WAYS; k++) {
      c.end(); // $w_k
      c.globalGet(pw[k]!);
      // the labels left: $w_{k+1} .. $w3, then $sel
      if (k < IC_WAYS - 1) c.br(IC_WAYS - 1 - k);
    }
    c.end(); // $sel
    c.localTee(l.PW);
    c.structGet(W, PW_EPOCH);
    c.globalGet(pi.epochG());
    c.i64Ne();
    c.brIf(missDepth);
    c.localGet(l.PW);
    c.structGet(W, PW_HOLDER);
    c.refIsNull();
    c.ifResult(this.d.dynRef());
    c.globalGet(this.d.undefinedGlobal());
    c.else_();
    c.localGet(l.PW);
    c.structGet(W, PW_HOLDER);
    c.structGet(objT, OBJ_ENTRIES);
    c.localGet(l.PW);
    c.structGet(W, PW_INDEX);
    c.arrayGet(this.d.entriesArrayType());
    c.structGet(this.d.entryT(), ENTRY_VALUE);
    c.end();
  }

  /** A stale chain way -1 - k (local I) after the miss helper ran: one
   * attempt of the site's refresh budget; when the offer is a chain way
   * for the same shape, way k takes its new `$protoWay`. */
  private emitRefresh(c: Code, pw: number[], rf: number, l: SiteLocals): void {
    c.globalGet(rf);
    c.i32Const(1);
    c.i32Add();
    c.globalSet(rf);
    c.globalGet(this.fillI());
    c.i32Const(0);
    c.i32LtS();
    c.localGet(l.sh);
    c.globalGet(this.fillS());
    c.refEq();
    c.i32And();
    c.ifVoid();
    for (let k = 0; k < IC_WAYS; k++) {
      c.localGet(l.I);
      c.i32Const(-1 - k);
      c.i32Eq();
      c.ifVoid();
      c.globalGet(this.fillW());
      c.globalSet(pw[k]!);
      c.end();
    }
    c.end();
  }

  /** %w.dyn.icMiss(recv, key, optional) → the read's value: a shaped
   * receiver's own entry answers and is offered to the site (fillS, fillI);
   * anything else reads through keyGet (null with an error pending, as
   * keyGet) and offers nothing (fillS null), except, in the chain form
   * (`proto`, U8d), a shaped receiver's read the chain walk proves
   * (proto-ic.ts): that offers a chain way (fillI -1, fillW). */
  private missFn(proto: boolean): number {
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    const entryT = this.d.entryT();
    const name = proto ? "icMiss:proto" : "icMiss";
    return this.k.cached(name, [this.d.dynRef(), this.k.deps.strRef(), I32], [this.d.dynRef()], (idx) => {
      const c = new Code();
      const P = 3;
      const S = 4;
      const N = 5;
      const J = 6;
      const E = 7;
      const E0 = 8;
      const ANS = 9;
      const WK = 10;
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
      if (proto) {
        c.globalGet(this.d.protoIc.epochG());
        c.localSet(E0);
      }
      c.localGet(0);
      c.localGet(1);
      c.localGet(2);
      c.call(this.d.keyGet());
      // keyGet can run a getter whose own cached reads miss and offer a
      // pair: this read offers none, unless the chain proves it below.
      c.refNull(this.d.shapes.shapeT());
      c.globalSet(this.fillS());
      if (proto) {
        c.localSet(ANS);
        this.emitChainOffer(c, { P, S, E0, ANS, WK });
        c.localGet(ANS);
      }
      const locals: ValType[] = [this.d.objRef(), this.d.shapes.shapeRef(), I32, I32, this.d.entryRef()];
      if (proto) locals.push(I64, this.d.dynRef(), I32);
      this.k.mb.setBody(idx, locals, c.bytes());
    });
  }

  /** The chain form of the miss helper, after keyGet answered into local
   * ANS: offers a chain way when the receiver (payload P) was shaped (S),
   * the read threw nothing and moved no epoch (E0 before it), the
   * receiver keeps its shape, and the walk from P proves the very answer
   * keyGet gave: the holder's entry, or undefined for a key absent up the
   * whole chain. */
  private emitChainOffer(c: Code, l: { P: number; S: number; E0: number; ANS: number; WK: number }): void {
    const pi = this.d.protoIc;
    c.block(); // $none
    c.localGet(l.S);
    c.refIsNull();
    c.brIf(0);
    c.globalGet(this.k.deps.excKind());
    c.brIf(0);
    c.globalGet(pi.epochG());
    c.localGet(l.E0);
    c.i64Ne();
    c.brIf(0);
    c.localGet(l.P);
    c.structGet(this.d.objT(), this.d.objShapeField());
    c.localGet(l.S);
    c.refEq();
    c.i32Eqz();
    c.brIf(0);
    c.localGet(l.P);
    c.localGet(1);
    c.call(pi.walkFn());
    c.localTee(l.WK);
    c.i32Const(WALK_NONE);
    c.i32Eq();
    c.brIf(0);
    c.localGet(l.WK);
    c.i32Const(WALK_FOUND);
    c.i32Eq();
    c.ifResult(this.d.dynRef());
    pi.emitWalkValue(c);
    c.else_();
    c.globalGet(this.d.undefinedGlobal());
    c.end();
    c.localGet(l.ANS);
    c.refEq();
    c.i32Eqz();
    c.brIf(0);
    // offer the way: the shape, a chain code, its $protoWay
    c.localGet(l.S);
    c.globalSet(this.fillS());
    c.i32Const(-1);
    c.globalSet(this.fillI());
    c.localGet(l.WK);
    c.i32Const(WALK_FOUND);
    c.i32Eq();
    c.ifResult(this.d.objRef());
    c.globalGet(pi.walkH());
    c.else_();
    c.refNull(this.d.objT());
    c.end();
    c.globalGet(pi.walkI());
    c.localGet(l.E0);
    c.structNew(pi.wayT());
    c.globalSet(this.fillW());
    c.end();
  }
}

/** A read site's scratch locals: the receiver box, its payload, its
 * shape and, for a chain-capable site, the way code and a `$protoWay`. */
interface SiteLocals {
  r: number;
  p: number;
  sh: number;
  I: number;
  PW: number;
}
