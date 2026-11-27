/* U8b: shapes for dynamic objects (docs/design/u8-dynamic-speed.md §3).
 *
 * Every OBJ payload (`$dynObj` and its subtypes) carries one mutable field,
 * `shape: (ref null $shape)`. The entry table stays exactly as it was:
 * entry structs in insertion order, read by every walker as before. A
 * non-null shape is a PROMISE about that table:
 *
 *   - `len == shape.count`, and entry `i`'s key is the key of the shape
 *     node at depth `i + 1` (the very string: the append stores the
 *     node's canonical key, so a later compare is a `ref.eq`);
 *   - every entry is a plain `$dynEntry` (no `$dynEntryA` attributes)
 *     whose value is not an accessor cell;
 *   - there is no hidden (non-enumerable) entry, the object is extensible
 *     and its prototype has not been replaced;
 *   - the payload is a plain object (prototype code 0 or 1): never a URL,
 *     RegExp, Map/WeakMap/WeakSet stand-in, the Object.prototype stand-in
 *     or an error prototype object, whose reads keyGet answers through its
 *     own arms before the table scan.
 *
 * Null is DICTIONARY MODE, which is exactly the behavior before U8b, and it
 * is never left once entered. So the default is safe: only the payload
 * constructors that name a plain object start at the root (dyn.ts
 * pushNewObj / pushNewLinkedObj), and every writer of the entry table
 * either keeps the promise or drops it:
 *
 *   - the append (dyn.ts objPutBody) walks the transition for its key, or
 *     drops the shape for a reserved key (a `%` internal key such as the
 *     error encoding's `%error`, or a symbol's U+D800 '@@' key) or an
 *     accessor-cell value;
 *   - an in-place value replacement (objPut) drops it when the new value
 *     is an accessor cell;
 *   - the object model's writers (objmodel.ts): defineProperty, an entry
 *     replaced by an attributed one (freeze/seal), a hidden-table push, a
 *     positional insert, preventExtensions and a prototype write drop it;
 *     deleting the LAST-added key rolls back to the parent shape, any other
 *     delete drops it.
 *
 * Transitions. A shape's children form a list (`kid`, the newest, then each
 * child's `sib`); appending key k looks k up there (strEq, whose `ref.eq`
 * fast path answers the canonical keys) and creates the child on a miss.
 * The caps of §3: a shape with 64 keys, a parent with 32 children, or
 * 65,536 shapes in all make the append drop to dictionary mode instead.
 * Shapes live as long as the program (J4).
 *
 * One root serves every prototype. The U8b caches answer only OWN data
 * entries, which depend on the receiver's table alone; per-prototype roots
 * are U8d's (§5), where a cache answers from the chain.
 *
 * Nothing here is observable: the table, its order and its keys' contents
 * are unchanged, and string identity is not observable (SEMANTICS.md
 * S002). */
import { OBJ_LEN, type DynBuilder } from "./dyn.js";
import { Code } from "./code.js";
import { countShape } from "./ic-stats.js";
import { I32, type ValType } from "./module.js";
import { emitFlatCast } from "./strings.js";

/** `$shape`'s field indices. */
export const SHAPE_PARENT = 0;
export const SHAPE_KEY = 1;
export const SHAPE_COUNT = 2;
export const SHAPE_KID = 3;
export const SHAPE_SIB = 4;
export const SHAPE_NKIDS = 5;

/** The caps (§3): keys per shape, children per shape, shapes in all. */
export const SHAPE_MAX_KEYS = 64;
export const SHAPE_MAX_KIDS = 32;
export const SHAPE_MAX_TOTAL = 65536;

export class Shapes {
  private shapeType: number | null = null;
  private rootGl: number | null = null;
  private noShapeGl: number | null = null;
  private totalGl: number | null = null;

  constructor(private readonly d: DynBuilder) {}

  private get k() {
    return this.d.shapesKit();
  }

  /** `$shape { parent, key, count, kid (mut), sib, nkids (mut) }`: a node
   * of the transition tree. `count` is the number of keys (the depth);
   * `key` the key this node appended (null at the root); `kid` the newest
   * child and `sib` the next older sibling; `nkids` the children made. */
  shapeT(): number {
    if (this.shapeType !== null) return this.shapeType;
    const str = this.k.deps.strRef();
    this.shapeType = this.k.mb.selfStructType("dyn:shape", (self) => {
      const ref: ValType = { kind: "ref", nullable: true, typeIndex: self };
      return [
        { storage: ref, mutable: false },
        { storage: str, mutable: false },
        { storage: I32, mutable: false },
        { storage: ref, mutable: true },
        { storage: ref, mutable: false },
        { storage: I32, mutable: true },
      ];
    });
    return this.shapeType;
  }

  shapeRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.shapeT() };
  }

  /** An immutable global holding a fresh, childless shape node. */
  private nodeGlobal(): number {
    const t = this.shapeT();
    return this.k.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: t }, false, (w) => {
      w.u8(0xfb); // struct.new_default $shape
      w.uleb(0x01);
      w.uleb(t);
    });
  }

  /** The root: the shape of every plain object with no key yet. */
  rootG(): number {
    this.rootGl ??= this.nodeGlobal();
    return this.rootGl;
  }

  /** A node no object ever carries: the empty way of a read cache, so an
   * empty cache never matches (a dictionary object's null shape included). */
  noShapeG(): number {
    this.noShapeGl ??= this.nodeGlobal();
    return this.noShapeGl;
  }

  private totalG(): number {
    this.totalGl ??= this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.totalGl;
  }

  /** The `shape` field of a fresh payload: the root, or null. */
  pushInitial(c: Code, shaped: boolean): void {
    if (shaped) c.globalGet(this.rootG());
    else c.refNull(this.shapeT());
  }

  /** Moves the payload `pushObj` pushes to dictionary mode. */
  drop(c: Code, pushObj: (c: Code) => void): void {
    pushObj(c);
    c.refNull(this.shapeT());
    c.structSet(this.d.objT(), this.d.objShapeField());
  }

  /** %w.dyn.shapeNext(shape, key) → the child of `shape` for `key`, made on
   * a miss; null when a cap stops it (the caller drops to dictionary). */
  next(): number {
    const S = this.shapeT();
    return this.k.cached("shapeNext", [this.shapeRef(), this.k.deps.strRef()], [this.shapeRef()], (idx) => {
      const c = new Code();
      const K = 2;
      const N = 3;
      c.localGet(0);
      c.structGet(S, SHAPE_KID);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.refIsNull();
      c.brIf(1);
      c.localGet(K);
      c.structGet(S, SHAPE_KEY);
      c.localGet(1);
      c.call(this.k.deps.strEq());
      c.ifVoid();
      c.localGet(K);
      c.return_();
      c.end();
      c.localGet(K);
      c.structGet(S, SHAPE_SIB);
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();
      // A new child, unless a cap says dictionary mode.
      c.localGet(0);
      c.structGet(S, SHAPE_COUNT);
      c.i32Const(SHAPE_MAX_KEYS);
      c.i32GeU();
      c.localGet(0);
      c.structGet(S, SHAPE_NKIDS);
      c.i32Const(SHAPE_MAX_KIDS);
      c.i32GeU();
      c.i32Or();
      c.globalGet(this.totalG());
      c.i32Const(SHAPE_MAX_TOTAL);
      c.i32GeU();
      c.i32Or();
      c.ifVoid();
      c.refNull(S);
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(1);
      c.localGet(0);
      c.structGet(S, SHAPE_COUNT);
      c.i32Const(1);
      c.i32Add();
      c.refNull(S);
      c.localGet(0);
      c.structGet(S, SHAPE_KID);
      c.i32Const(0);
      c.structNew(S);
      c.localSet(N);
      c.localGet(0);
      c.localGet(N);
      c.structSet(S, SHAPE_KID);
      c.localGet(0);
      c.localGet(0);
      c.structGet(S, SHAPE_NKIDS);
      c.i32Const(1);
      c.i32Add();
      c.structSet(S, SHAPE_NKIDS);
      c.globalGet(this.totalG());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.totalG());
      countShape(c);
      c.localGet(N);
      this.k.mb.setBody(idx, [this.shapeRef(), this.shapeRef()], c.bytes());
    });
  }

  /** %w.dyn.shapeKeyOk(key) → i32: may a shaped object take this key? Not
   * a reserved key: an internal `%` name (the error encoding, S021) or a
   * symbol's U+D800 '@@' key, which keyGet reads through its own arms. */
  private keyOk(): number {
    const s = this.k.deps.strType();
    return this.k.cached("shapeKeyOk", [this.k.deps.strRef()], [I32], (idx) => {
      const c = new Code();
      const F = 1;
      const U = 2;
      c.localGet(0);
      emitFlatCast(c, s);
      c.localTee(F);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(F);
      c.i32Const(0);
      c.arrayGetU(s);
      c.localTee(U);
      c.i32Const(0x25); // '%'
      c.i32Ne();
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32Ne();
      c.i32And();
      this.k.mb.setBody(idx, [{ kind: "ref", nullable: true, typeIndex: s }, I32], c.bytes());
    });
  }

  /** objPutBody's append, before the entry is stored: with the payload in
   * local `obj`, the key in local `key` and the value in local `value`,
   * walks the payload's shape to the child for the key (or drops it to
   * dictionary mode) and, when shaped, replaces `key` by the child's
   * canonical key string. `sh` is a scratch local of shapeRef(). */
  emitAppend(c: Code, obj: number, key: number, value: number, sh: number): void {
    const S = this.shapeT();
    const objT = this.d.objT();
    const field = this.d.objShapeField();
    c.localGet(obj);
    c.structGet(objT, field);
    c.localTee(sh);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(obj);
    c.localGet(key);
    c.call(this.keyOk());
    if (this.d.accessorsLive) {
      c.localGet(value);
      this.d.isAccessorCell(c);
      c.i32Eqz();
      c.i32And();
    }
    c.ifResult(this.shapeRef());
    c.localGet(sh);
    c.localGet(key);
    c.call(this.next());
    c.else_();
    c.refNull(S);
    c.end();
    c.localTee(sh);
    c.structSet(objT, field);
    c.localGet(sh);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(sh);
    c.structGet(S, SHAPE_KEY);
    c.localSet(key);
    c.end();
    c.end();
  }

  /** An in-place value replacement (objPut): with the payload in local
   * `obj` and the new value in local `value`, an accessor cell drops the
   * shape (a shaped entry holds data only). Nothing where accessors are
   * not live: no value is ever a cell there. */
  emitReplace(c: Code, obj: number, value: number): void {
    if (!this.d.accessorsLive) return;
    c.localGet(value);
    this.d.isAccessorCell(c);
    c.ifVoid();
    this.drop(c, (x) => x.localGet(obj));
    c.end();
  }

  /** objmodel.ts removeAt, before the entry at code `idx` (>= 0: the main
   * table) leaves the payload in local `obj`: removing the last-added key
   * rolls the shape back to its parent; any other removal drops it. `sh`
   * is a scratch local of shapeRef(). */
  emitRemove(c: Code, obj: number, idx: number, sh: number): void {
    const objT = this.d.objT();
    const field = this.d.objShapeField();
    c.localGet(obj);
    c.structGet(objT, field);
    c.localTee(sh);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(obj);
    c.localGet(idx);
    c.localGet(obj);
    c.structGet(objT, OBJ_LEN);
    c.i32Const(1);
    c.i32Sub();
    c.i32Eq();
    c.ifResult(this.shapeRef());
    c.localGet(sh);
    c.structGet(this.shapeT(), SHAPE_PARENT);
    c.else_();
    c.refNull(this.shapeT());
    c.end();
    c.structSet(objT, field);
    c.end();
  }
}
