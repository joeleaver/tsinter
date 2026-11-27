/* U8d: what the prototype caches stand on (docs/design/u8-dynamic-speed.md
 * §5): the prototype mark, the prototype epoch and the chain walk that
 * proves a cache way. Built only where prototype links exist
 * (DynBuilder.protoLinkLive); every other module is byte-identical.
 *
 * The mark. Every OBJ payload carries a `proot` field (dyn.ts
 * objProotField): null until something links to the object, then the root
 * shape of the objects linked to it (shapes.ts protoRoot), or the no-shape
 * sentinel past the shape cap. So "is a prototype" and "has a prototype
 * root" are one fact and cannot disagree. Every way of linking marks the
 * new prototype: a fresh linked payload (dyn.ts pushNewLinkedObj, the
 * island's Object.create) and the object model's one link writer,
 * setProto (shapes.ts emitRelink), which Object.create, setPrototypeOf,
 * `__proto__` and `new F` (construct, over `F.prototype`) all go through.
 *
 * The epoch. One i64 global, moved by every key-structure change of a
 * marked object (emitBump): an append (dyn.ts emitEntryPush, which the
 * store cache's append shares), every dictionary drop (shapes.ts drop:
 * defineProperty, an attributed or replaced entry, a hidden key, a
 * reorder, preventExtensions, a data value turned accessor), a removal
 * (shapes.ts emitRemove) and a prototype write (emitRelink). A value
 * replaced in place does not move it: a cache way records WHERE a member
 * is (holder and index), never its value. 64 bits, so it cannot wrap.
 *
 * The walk (walkFn) is how a way is proved, after the uncached read or
 * write has answered: from a receiver's prototype up, every object must be
 * a marked `$dynObj` (never a view, whose payload is a snapshot), and the
 * key must be absent from each, or found on one as a data value in its
 * main table. Anything else (an accessor, a hidden key, an unmarked or
 * view prototype) proves nothing and the site is not filled. Because the
 * receiver's shape implies its prototype (shapes.ts roots) and every
 * object up the chain is marked, a way stays true while the receiver's
 * shape and the epoch are what they were when it was proved: no object on
 * the chain can gain, lose or re-attribute a key, or change its link,
 * without moving the epoch. */
import type { DynBuilder } from "./dyn.js";
import { DK, DYN_KIND, DYN_REF, ENTRY_KEY, ENTRY_VALUE, OBJ_ENTRIES, OBJ_LEN } from "./dyn.js";
import { Code } from "./code.js";
import { countProtoBump } from "./ic-stats.js";
import { I32, I64, type ValType } from "./module.js";

/** `$protoWay`'s fields: the holder of the member (null for an absent
 * key), its main-table index, and the epoch the way was proved at. */
export const PW_HOLDER = 0;
export const PW_INDEX = 1;
export const PW_EPOCH = 2;

/** walkFn's answers. */
export const WALK_ABSENT = 0;
export const WALK_FOUND = 1;
export const WALK_NONE = -1;

export class ProtoIc {
  private epochGl: number | null = null;
  private wayType: number | null = null;
  private walkHG: number | null = null;
  private walkIG: number | null = null;

  constructor(private readonly d: DynBuilder) {}

  private get k() {
    return this.d.shapesKit();
  }

  /** Are there prototype links (and so a mark, an epoch, proto ways)? */
  get live(): boolean {
    return this.d.protoLinkLive;
  }

  /** The prototype epoch: i64, from 0. */
  epochG(): number {
    this.epochGl ??= this.k.mb.addGlobal(I64, true, (w) => {
      w.u8(0x42); // i64.const 0
      w.sleb64(0n);
    });
    return this.epochGl;
  }

  /** A key-structure change of the payload `pushObj` pushes: moves the
   * epoch when the payload is a prototype. Nothing where links do not
   * exist. */
  emitBump(c: Code, pushObj: (c: Code) => void): void {
    if (!this.live) return;
    pushObj(c);
    c.structGet(this.d.objT(), this.d.objProotField());
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.globalGet(this.epochG());
    c.i64Const(1n);
    c.i64Add();
    c.globalSet(this.epochG());
    countProtoBump(c);
    c.end();
  }

  /** `$protoWay { holder, index, epoch }`, immutable: a read way proved
   * from the chain (made once per fill). */
  wayT(): number {
    this.wayType ??= this.k.mb.openStructType("dyn:protoWay", [
      { storage: this.d.objRef(), mutable: false },
      { storage: I32, mutable: false },
      { storage: I64, mutable: false },
    ]);
    return this.wayType;
  }

  wayRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.wayT() };
  }

  /** What walkFn found: the holder payload and the member's index. */
  walkH(): number {
    this.walkHG ??= this.k.mb.addGlobal(this.d.objRef(), true, (w) => {
      w.u8(0xd0); // ref.null $dynObj
      w.sleb(this.d.objT());
    });
    return this.walkHG;
  }

  walkI(): number {
    this.walkIG ??= this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    return this.walkIG;
  }

  /** %w.dyn.protoWalk(payload, key) → i32: walks the chain above the
   * payload (its prototype, then that one's, as keyGet's member lookup
   * does) for `key`. WALK_ABSENT: no object on it holds the key;
   * WALK_FOUND: the first that does holds it as a data value at main-table
   * index walkI of payload walkH; WALK_NONE: nothing is proved (an
   * accessor, a hidden key, a view or an unmarked object on the way). */
  walkFn(): number {
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    const entryT = this.d.entryT();
    const entries = this.d.entriesArrayType();
    const params = [this.d.objRef(), this.k.deps.strRef()];
    return this.k.cached("protoWalk", params, [I32], (idx) => {
      const c = new Code();
      const NEXT = 2;
      const H = 3;
      const J = 4;
      const N = 5;
      const E = 6;
      c.block(); // $none
      c.loop();
      // the next object up, as keyGet's member lookup steps
      if (this.d.objModelLive) {
        this.d.boxObj(c, (x) => x.localGet(0));
        c.call(this.d.om.protoBox());
      } else {
        c.localGet(0);
        c.call(this.d.protoOf());
      }
      c.localTee(NEXT);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(WALK_ABSENT);
      c.return_();
      c.end();
      c.localGet(NEXT);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.brIf(1);
      c.localGet(NEXT);
      c.structGet(dynT, DYN_REF);
      c.refTest(objT);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(NEXT);
      c.structGet(dynT, DYN_REF);
      c.refCast(objT);
      c.localTee(H);
      c.structGet(objT, this.d.objProotField());
      c.refIsNull();
      c.brIf(1);
      // the key on this object: its main-table index, or -1
      if (this.d.objModelLive) {
        // ownIdx answers either table; a hidden key (<= -2) proves nothing
        c.localGet(H);
        c.localGet(1);
        c.call(this.d.om.ownIdx());
        c.localTee(J);
        c.i32Const(-1);
        c.i32LtS();
        c.brIf(1);
      } else {
        c.i32Const(-1);
        c.localSet(J);
        c.localGet(H);
        c.structGet(objT, OBJ_LEN);
        c.localSet(N);
        c.block();
        c.loop();
        c.localGet(J);
        c.i32Const(1);
        c.i32Add();
        c.localTee(J);
        c.localGet(N);
        c.i32GeU();
        c.ifVoid();
        c.i32Const(-1);
        c.localSet(J);
        c.br(2);
        c.end();
        c.localGet(H);
        c.structGet(objT, OBJ_ENTRIES);
        c.localGet(J);
        c.arrayGet(entries);
        c.structGet(entryT, ENTRY_KEY);
        c.localGet(1);
        c.call(this.k.deps.strEq());
        c.brIf(1);
        c.br(0);
        c.end();
        c.end();
      }
      c.localGet(J);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(H);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(J);
      c.arrayGet(entries);
      c.localTee(E);
      if (this.d.accessorsLive) {
        c.structGet(entryT, ENTRY_VALUE);
        this.d.isAccessorCell(c);
        c.brIf(2);
      } else {
        c.drop();
      }
      c.localGet(H);
      c.globalSet(this.walkH());
      c.localGet(J);
      c.globalSet(this.walkI());
      c.i32Const(WALK_FOUND);
      c.return_();
      c.end();
      c.localGet(H);
      c.localSet(0);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(WALK_NONE);
      this.k.mb.setBody(idx, [this.d.dynRef(), this.d.objRef(), I32, I32, this.d.entryRef()], c.bytes());
    });
  }

  /** The value the walk's WALK_FOUND names: walkH's entry walkI. */
  emitWalkValue(c: Code): void {
    c.globalGet(this.walkH());
    c.structGet(this.d.objT(), OBJ_ENTRIES);
    c.globalGet(this.walkI());
    c.arrayGet(this.d.entriesArrayType());
    c.structGet(this.d.entryT(), ENTRY_VALUE);
  }
}
