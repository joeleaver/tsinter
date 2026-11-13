/* Units U3 + U4 (docs/design/dynamic-values.md §4.6, "U3 + U4 plan as
 * built"): the ES5 object model on dynamic values — property attributes,
 * accessors with setters, defineProperty and its readers, delete, for-in,
 * mutable prototype links, and the dynamic constructors of ES5 code.
 *
 * Present ONLY in a module whose IR reaches an object-model operation
 * (DynDeps.objModel, the emitter's prescan), so every other module is
 * byte-identical. Where live:
 *
 *  - every OBJ payload is the A2 LINKED struct, widened with a mutable
 *    prototype box, a HIDDEN entry table (the non-enumerable keys) and an
 *    object-flags word (bit 0: not extensible). A null prototype box ends
 *    the chain at Object.prototype; the interned `null` box (or the
 *    Object.prototype stand-in) means the chain ends there.
 *  - enumerable keys stay in `entries`, so every existing walker honors
 *    enumerability by construction; only own-key readers consult `hidden`.
 *  - a key whose writable/configurable is not the default rides a
 *    `$dynEntryA` subtype entry carrying flags (F_RO, F_NC; a hidden
 *    entry also F_HID and, above bit 8, its position among the enumerable
 *    keys at insertion — getOwnPropertyNames' combined order).
 *  - an accessor property is the A2 cell; one with a setter is the
 *    `$dynAcc` subtype (the getter in the ref slot, either half may be the
 *    `undefined` box). */
import type { DynBuilder } from "./dyn.js";
import { DK, DYN_KIND, DYN_NUM, DYN_REF, ENTRY_KEY, ENTRY_VALUE, FN_ARITY, FN_CLOS, FN_NAME, FN_PROTO, FN_SIG, OBJ_ENTRIES, OBJ_LEN, OBJ_PROTO, OBJ_PROTO_NULL } from "./dyn.js";
import { Code } from "./code.js";
import { emitFlatCast } from "./strings.js";
import { F64, I32, type ValType } from "./module.js";

/** The own-property key a well-known symbol's property is stored under
 * (a lone surrogate first: no string the program writes can be it; the
 * key walkers skip it). */
export const SYM_KEY_PREFIX = "\uD800@@";
export const SYM_HAS_INSTANCE = SYM_KEY_PREFIX + "hasInstance";

export const F_RO = 1;
export const F_NC = 2;
export const F_HID = 4;
const MARK_SHIFT = 8;

/** Linked-object field indices beyond `$dynObj`'s three. */
export const OF_NONEXT = 1;

/** Descriptor field masks (`omDefine`'s mask operand). */
const HAS_VALUE = 1;
const HAS_GET = 2;
const HAS_SET = 4;
const HAS_WRITABLE = 8;
const HAS_ENUM = 16;
const HAS_CONF = 32;
const A_W = 64;
const A_E = 128;
const A_C = 256;

const EQ_HEAP = -0x13;

export class ObjModel {
  private entryAType: number | null = null;
  private accType: number | null = null;
  private objProtoG: number | null = null;
  private sloppyG: number | null = null;

  constructor(private readonly d: DynBuilder) {}

  private get k() {
    return this.d.omKit();
  }

  private fn(name: string, params: ValType[], results: ValType[], locals: ValType[], body: (c: Code) => void): number {
    return this.k.cached(`om.${name}`, params, results, (idx) => {
      const c = new Code();
      body(c);
      this.k.mb.setBody(idx, locals, c.bytes());
    });
  }

  private lit(c: Code, s: string): void {
    this.k.deps.lit(c, s);
  }

  private concat(c: Code): void {
    c.call(this.k.deps.concat());
  }

  private strRef(): ValType {
    return this.k.deps.strRef();
  }

  private entriesRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.d.entriesArrayType() };
  }

  private linkedRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.d.objLinkedT() };
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  entryAT(): number {
    this.entryAType ??= this.k.mb.subStructType(
      "dyn:entryA",
      [
        { storage: this.strRef(), mutable: false },
        { storage: this.d.dynRef(), mutable: true },
        { storage: I32, mutable: true },
      ],
      this.d.entryT(),
    );
    return this.entryAType;
  }

  accT(): number {
    this.accType ??= this.k.mb.subStructType(
      "dyn:acc",
      [
        { storage: I32, mutable: false },
        { storage: F64, mutable: false },
        { storage: { kind: "ref", nullable: true, typeIndex: EQ_HEAP }, mutable: false },
        { storage: this.d.dynRef(), mutable: false },
      ],
      this.d.dynT(),
    );
    return this.accType;
  }

  /** The interned Object.prototype stand-in: a null-prototype linked OBJ
   * box (Node prints it `[Object: null prototype] {}`). Its members are
   * not modeled: it serves as the identity getPrototypeOf answers. */
  objectProto(): number {
    if (this.objProtoG !== null) return this.objProtoG;
    const g = this.k.mb.addGlobal(this.d.dynRef(), true, (w) => {
      w.u8(0xd0);
      w.sleb(this.d.dynT());
    });
    this.objProtoG = this.fn("objectProto", [], [this.d.dynRef()], [], (c) => {
      c.globalGet(g);
      c.refIsNull();
      c.ifVoid();
      this.d.boxObj(c, (x) => this.d.pushNewObj(x, true));
      c.globalSet(g);
      c.end();
      c.globalGet(g);
    });
    return this.objProtoG;
  }

  /** The strictness of the write in flight: 1 while a sloppy-mode site's
   * property write runs (its rejections are silent), else 0. */
  sloppyGlobal(): number {
    this.sloppyG ??= this.k.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.sloppyG;
  }

  /* ── small emit helpers ─────────────────────────────────────────────── */

  /** for (i = 0; i < n; i++) body — `n` pushed by the caller's thunk each
   * iteration. */
  private forI(c: Code, i: number, pushN: (c: Code) => void, body: () => void): void {
    c.i32Const(0);
    c.localSet(i);
    c.block();
    c.loop();
    c.localGet(i);
    pushN(c);
    c.i32GeS();
    c.brIf(1);
    body();
    c.localGet(i);
    c.i32Const(1);
    c.i32Add();
    c.localSet(i);
    c.br(0);
    c.end();
    c.end();
  }

  private throwType(c: Code, push: (c: Code) => void): void {
    this.k.deps.throwTypeError(c, push);
  }

  /* ── own-entry lookup ────────────────────────────────────────────────── */

  /** %w.om.ownIdx(obj, key) → i32: >= 0 the main-table index, <= -2 the
   * hidden-table index as -(i + 2), -1 absent. */
  ownIdx(): number {
    const objT = this.d.objT();
    const entries = this.d.entriesArrayType();
    const entryT = this.d.entryT();
    const L = this.d.objLinkedT();
    return this.fn("ownIdx", [this.d.objRef(), this.strRef()], [I32], [I32, this.linkedRef()], (c) => {
      const I = 2;
      const LO = 3;
      this.forI(c, I, (x) => { x.localGet(0); x.structGet(objT, OBJ_LEN); }, () => {
        c.localGet(0);
        c.structGet(objT, OBJ_ENTRIES);
        c.localGet(I);
        c.arrayGet(entries);
        c.structGet(entryT, ENTRY_KEY);
        c.localGet(1);
        c.call(this.k.deps.strEq());
        c.ifVoid();
        c.localGet(I);
        c.return_();
        c.end();
      });
      c.localGet(0);
      c.refTest(L);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(-1);
      c.return_();
      c.end();
      c.localGet(0);
      c.refCast(L);
      c.localSet(LO);
      this.forI(c, I, (x) => { x.localGet(LO); x.structGet(L, this.d.olProto() + 2); }, () => {
        c.localGet(LO);
        c.structGet(L, this.d.olProto() + 1);
        c.localGet(I);
        c.arrayGet(entries);
        c.structGet(entryT, ENTRY_KEY);
        c.localGet(1);
        c.call(this.k.deps.strEq());
        c.ifVoid();
        c.i32Const(-2);
        c.localGet(I);
        c.i32Sub();
        c.return_();
        c.end();
      });
      c.i32Const(-1);
    });
  }

  /** The entry at code `idx` (ownIdx's answer, not -1) of obj. */
  private pushEntryAt(c: Code, obj: number, idx: number): void {
    const objT = this.d.objT();
    const L = this.d.objLinkedT();
    const entries = this.d.entriesArrayType();
    c.localGet(idx);
    c.i32Const(0);
    c.i32GeS();
    c.ifResult(this.d.entryRef());
    c.localGet(obj);
    c.structGet(objT, OBJ_ENTRIES);
    c.localGet(idx);
    c.arrayGet(entries);
    c.else_();
    c.localGet(obj);
    c.refCast(L);
    c.structGet(L, this.d.olProto() + 1);
    c.i32Const(-2);
    c.localGet(idx);
    c.i32Sub();
    c.arrayGet(entries);
    c.end();
  }

  /** Replace the entry at code `idx` by the entry the caller pushes. */
  private setEntryAt(c: Code, obj: number, idx: number, pushEntry: (c: Code) => void): void {
    const objT = this.d.objT();
    const L = this.d.objLinkedT();
    const entries = this.d.entriesArrayType();
    c.localGet(idx);
    c.i32Const(0);
    c.i32GeS();
    c.ifVoid();
    c.localGet(obj);
    c.structGet(objT, OBJ_ENTRIES);
    c.localGet(idx);
    pushEntry(c);
    c.arraySet(entries);
    c.else_();
    c.localGet(obj);
    c.refCast(L);
    c.structGet(L, this.d.olProto() + 1);
    c.i32Const(-2);
    c.localGet(idx);
    c.i32Sub();
    pushEntry(c);
    c.arraySet(entries);
    c.end();
  }

  /** %w.om.ownEntry(obj, key) → the own entry (either table) or null. */
  ownEntry(): number {
    return this.fn("ownEntry", [this.d.objRef(), this.strRef()], [this.d.entryRef()], [I32], (c) => {
      const IDX = 2;
      c.localGet(0);
      c.localGet(1);
      c.call(this.ownIdx());
      c.localTee(IDX);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.refNull(this.d.entryT());
      c.return_();
      c.end();
      this.pushEntryAt(c, 0, IDX);
    });
  }

  /** With an entry on the stack: its flags (0 for a plain entry). */
  entryFlags(c: Code): void {
    c.call(
      this.fn("entryFlags", [this.d.entryRef()], [I32], [], (x) => {
        x.localGet(0);
        x.refTest(this.entryAT());
        x.ifResult(I32);
        x.localGet(0);
        x.refCast(this.entryAT());
        x.structGet(this.entryAT(), 2);
        x.else_();
        x.i32Const(0);
        x.end();
      }),
    );
  }

  /** A fresh entry (key, value, flags): plain when flags is 0. */
  private pushNewEntry(c: Code, key: number, value: (c: Code) => void, flags: number): void {
    c.localGet(flags);
    c.ifResult(this.d.entryRef());
    c.localGet(key);
    value(c);
    c.localGet(flags);
    c.structNew(this.entryAT());
    c.else_();
    c.localGet(key);
    value(c);
    c.structNew(this.d.entryT());
    c.end();
  }

  /** %w.om.hiddenPush(lobj, entry) — append to the hidden table. */
  private hiddenPush(): number {
    const L = this.d.objLinkedT();
    const entries = this.d.entriesArrayType();
    return this.fn("hiddenPush", [this.linkedRef(), this.d.entryRef()], [], [I32, this.entriesRef()], (c) => {
      const N = 2;
      const NB = 3;
      c.localGet(0);
      c.structGet(L, this.d.olProto() + 2);
      c.localSet(N);
      c.localGet(0);
      c.structGet(L, this.d.olProto() + 1);
      c.refIsNull();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.localGet(N);
      c.localGet(0);
      c.structGet(L, this.d.olProto() + 1);
      c.arrayLen();
      c.i32GeU();
      c.end();
      c.ifVoid();
      c.localGet(N);
      c.i32Const(2);
      c.i32Mul();
      c.i32Const(4);
      c.i32Add();
      c.arrayNewDefault(entries);
      c.localSet(NB);
      c.localGet(N);
      c.ifVoid();
      c.localGet(NB);
      c.i32Const(0);
      c.localGet(0);
      c.structGet(L, this.d.olProto() + 1);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(entries, entries);
      c.end();
      c.localGet(0);
      c.localGet(NB);
      c.structSet(L, this.d.olProto() + 1);
      c.end();
      c.localGet(0);
      c.structGet(L, this.d.olProto() + 1);
      c.localGet(N);
      c.localGet(1);
      c.arraySet(entries);
      c.localGet(0);
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.structSet(L, this.d.olProto() + 2);
    });
  }

  /** %w.om.mainInsert(obj, at, entry) — insert into the main table at
   * position `at` (shifting later entries; hidden markers past it move). */
  private mainInsert(): number {
    const objT = this.d.objT();
    const L = this.d.objLinkedT();
    const entries = this.d.entriesArrayType();
    const entryT = this.d.entryT();
    return this.fn("mainInsert", [this.d.objRef(), I32, this.d.entryRef(), I32], [], [I32, I32, this.d.entryRef()], (c) => {
      // params: obj, at, entry, selfHidden (the hidden index the entry
      // leaves, -1 for none; markers equal to `at` after it shift too)
      const N = 4;
      const I = 5;
      const E = 6;
      // Append (objPut grows the table), then rotate into place.
      c.localGet(0);
      c.structGet(objT, OBJ_LEN);
      c.localSet(N);
      c.localGet(0);
      c.localGet(2);
      c.structGet(entryT, ENTRY_KEY);
      c.globalGet(this.d.undefinedGlobal());
      c.call(this.appendFn());
      // entries[at+1..N] = entries[at..N-1]; entries[at] = entry
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(1);
      c.i32Const(1);
      c.i32Add();
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(1);
      c.localGet(N);
      c.localGet(1);
      c.i32Sub();
      c.arrayCopy(entries, entries);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(1);
      c.localGet(2);
      c.arraySet(entries);
      // Hidden markers at or past `at` move one along (those equal to it
      // and before the entry's own former hidden slot stay put).
      c.localGet(0);
      c.refTest(L);
      c.ifVoid();
      this.forI(c, I, (x) => { x.localGet(0); x.refCast(L); x.structGet(L, this.d.olProto() + 2); }, () => {
        c.localGet(0);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 1);
        c.localGet(I);
        c.arrayGet(entries);
        c.localTee(E);
        c.refTest(this.entryAT());
        c.ifVoid();
        c.localGet(E);
        c.refCast(this.entryAT());
        c.structGet(this.entryAT(), 2);
        c.i32Const(MARK_SHIFT);
        c.i32ShrU();
        c.localGet(1);
        c.i32GtS();
        c.localGet(E);
        c.refCast(this.entryAT());
        c.structGet(this.entryAT(), 2);
        c.i32Const(MARK_SHIFT);
        c.i32ShrU();
        c.localGet(1);
        c.i32Eq();
        c.localGet(I);
        c.localGet(3);
        c.i32GtS();
        c.localGet(3);
        c.i32Const(0);
        c.i32GeS();
        c.i32And();
        c.i32And();
        c.i32Or();
        c.ifVoid();
        c.localGet(E);
        c.refCast(this.entryAT());
        c.localGet(E);
        c.refCast(this.entryAT());
        c.structGet(this.entryAT(), 2);
        c.i32Const(1 << MARK_SHIFT);
        c.i32Add();
        c.structSet(this.entryAT(), 2);
        c.end();
        c.end();
      });
      c.end();
    });
  }

  /** objPut's append path, as a function: (obj, key, value). Appends even
   * when the key exists (callers ensured it does not). */
  private appendFn(): number {
    return this.d.objAppend();
  }

  /** %w.om.removeAt(obj, idx) — remove the own entry at code idx. */
  private removeAt(): number {
    const objT = this.d.objT();
    const L = this.d.objLinkedT();
    const entries = this.d.entriesArrayType();
    return this.fn("removeAt", [this.d.objRef(), I32], [], [I32, I32, this.d.entryRef(), I32], (c) => {
      const N = 2;
      const I = 3;
      const E = 4;
      const H = 5;
      c.localGet(1);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(0);
      c.structGet(objT, OBJ_LEN);
      c.localSet(N);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(1);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(1);
      c.i32Const(1);
      c.i32Add();
      c.localGet(N);
      c.localGet(1);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.arrayCopy(entries, entries);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.refNull(this.d.entryT());
      c.arraySet(entries);
      c.localGet(0);
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.structSet(objT, OBJ_LEN);
      // Hidden markers past the removed position move back one.
      c.localGet(0);
      c.refTest(L);
      c.ifVoid();
      this.forI(c, I, (x) => { x.localGet(0); x.refCast(L); x.structGet(L, this.d.olProto() + 2); }, () => {
        c.localGet(0);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 1);
        c.localGet(I);
        c.arrayGet(entries);
        c.localTee(E);
        c.refCast(this.entryAT());
        c.structGet(this.entryAT(), 2);
        c.i32Const(MARK_SHIFT);
        c.i32ShrU();
        c.localGet(1);
        c.i32GtS();
        c.ifVoid();
        c.localGet(E);
        c.refCast(this.entryAT());
        c.localGet(E);
        c.refCast(this.entryAT());
        c.structGet(this.entryAT(), 2);
        c.i32Const(1 << MARK_SHIFT);
        c.i32Sub();
        c.structSet(this.entryAT(), 2);
        c.end();
      });
      c.end();
      c.return_();
      c.end();
      // Hidden: shift down.
      c.i32Const(-2);
      c.localGet(1);
      c.i32Sub();
      c.localSet(H);
      c.localGet(0);
      c.refCast(L);
      c.structGet(L, this.d.olProto() + 2);
      c.localSet(N);
      c.localGet(0);
      c.refCast(L);
      c.structGet(L, this.d.olProto() + 1);
      c.localGet(H);
      c.localGet(0);
      c.refCast(L);
      c.structGet(L, this.d.olProto() + 1);
      c.localGet(H);
      c.i32Const(1);
      c.i32Add();
      c.localGet(N);
      c.localGet(H);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.arrayCopy(entries, entries);
      c.localGet(0);
      c.refCast(L);
      c.structGet(L, this.d.olProto() + 1);
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.refNull(this.d.entryT());
      c.arraySet(entries);
      c.localGet(0);
      c.refCast(L);
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.structSet(L, this.d.olProto() + 2);
    });
  }

  /* ── accessor cells ─────────────────────────────────────────────────── */

  /** A fresh accessor cell from getter and setter boxes (either may be the
   * undefined box). */
  pushCell(c: Code, get: number, set: number): void {
    c.i32Const(DK.JSVAL);
    c.f64Const(0);
    c.localGet(get);
    c.localGet(set);
    c.structNew(this.accT());
  }

  /** %w.om.cellText(cell) → Node's inspect text for an accessor:
   * `[Getter/Setter]`, `[Getter]` or `[Setter]`. */
  cellText(): number {
    return this.fn("cellText", [this.d.dynRef()], [this.strRef()], [I32, I32], (c) => {
      const G = 1;
      const S = 2;
      c.localGet(0);
      this.cellGetter(c);
      c.structGet(this.d.dynT(), DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.localSet(G);
      c.localGet(0);
      this.cellSetter(c);
      c.structGet(this.d.dynT(), DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.localSet(S);
      c.localGet(G);
      c.localGet(S);
      c.i32And();
      c.ifResult(this.strRef());
      this.lit(c, "[Getter/Setter]");
      c.else_();
      c.localGet(S);
      c.ifResult(this.strRef());
      this.lit(c, "[Setter]");
      c.else_();
      this.lit(c, "[Getter]");
      c.end();
      c.end();
    });
  }

  /** With a cell on the stack: its getter box (undefined box when none). */
  cellGetter(c: Code): void {
    c.structGet(this.d.dynT(), DYN_REF);
    c.refCast(this.d.dynT());
  }

  /** With a cell on the stack: its setter box (undefined box when none). */
  cellSetter(c: Code): void {
    c.call(
      this.fn("cellSetter", [this.d.dynRef()], [this.d.dynRef()], [], (x) => {
        x.localGet(0);
        x.refTest(this.accT());
        x.ifResult(this.d.dynRef());
        x.localGet(0);
        x.refCast(this.accT());
        x.structGet(this.accT(), 3);
        x.else_();
        x.globalGet(this.d.undefinedGlobal());
        x.end();
      }),
    );
  }

  /** %w.om.callSetter(recv, cell, value) → i32: 1 when a setter ran (or
   * threw: the error pending), 0 when the cell has no setter. */
  callSetter(): number {
    const dynT = this.d.dynT();
    return this.fn("callSetter", [this.d.dynRef(), this.d.dynRef(), this.d.dynRef()], [I32], [this.d.dynRef(), this.d.arrRef()], (c) => {
      const S = 3;
      const A = 4;
      c.localGet(1);
      this.cellSetter(c);
      c.localTee(S);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      this.d.pushNewArr(c);
      c.localSet(A);
      c.localGet(A);
      c.localGet(2);
      c.call(this.k.deps.arrPush());
      c.localGet(0);
      c.call(this.d.thisPush());
      c.localGet(S);
      c.localGet(A);
      this.lit(c, "setter");
      c.call(this.d.callFn());
      c.drop();
      c.call(this.d.thisPop());
      c.i32Const(1);
    });
  }

  /* ── the receiver's printed name in V8's write errors ───────────────── */

  /** %w.om.ctorNameOf(obj box) → "#<Name>" — V8's receiver spelling in
   * "Cannot assign to read only property 'x' of object '#<Object>'". */
  ctorNameOf(): number {
    return this.fn("ctorNameOf", [this.d.dynRef()], [this.strRef()], [this.strRef()], (c) => {
      const N = 1;
      c.localGet(0);
      c.call(this.ctorName());
      c.localTee(N);
      c.refIsNull();
      c.ifResult(this.strRef());
      this.lit(c, "#<Object>");
      c.else_();
      this.lit(c, "#<");
      c.localGet(N);
      this.concat(c);
      this.lit(c, ">");
      this.concat(c);
      c.end();
    });
  }

  /** %w.om.ctorName(box) → the name of the first `constructor` an OBJ's
   * prototype chain owns (as inspect and V8 find it), or null for
   * Object / none. */
  ctorName(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    return this.fn("ctorName", [this.d.dynRef()], [this.strRef()], [this.d.dynRef(), this.d.entryRef(), this.d.dynRef(), I32, this.strRef()], (c) => {
      const P = 1;
      const E = 2;
      const F = 3;
      const GUARD = 4;
      const N = 5;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.ifVoid();
      c.refNull(this.k.deps.strType());
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.protoBox());
      c.localSet(P);
      c.block();
      c.loop();
      c.localGet(P);
      c.refIsNull();
      c.brIf(1);
      c.localGet(GUARD);
      c.i32Const(1000);
      c.i32GtU();
      c.brIf(1);
      c.localGet(GUARD);
      c.i32Const(1);
      c.i32Add();
      c.localSet(GUARD);
      c.localGet(P);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.d.objT());
      this.lit(c, "constructor");
      c.call(this.ownEntry());
      c.localTee(E);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(E);
      c.structGet(this.d.entryT(), ENTRY_VALUE);
      c.localTee(F);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.ifVoid();
      // its `name` as a read sees it (a defined own `name` first)
      c.localGet(F);
      this.lit(c, "name");
      c.i32Const(0);
      c.call(this.d.keyGet());
      c.localTee(P);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.k.deps.strType());
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Ne();
      c.ifVoid();
      c.refNull(this.k.deps.strType());
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(dynT, DYN_REF);
      emitFlatCast(c, this.k.deps.strType());
      c.localTee(N);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.k.deps.strType());
      c.return_();
      c.end();
      // an anonymous constructor (and Object's own) names nothing
      c.localGet(N);
      this.lit(c, "");
      c.call(this.k.deps.strEq());
      c.localGet(N);
      this.lit(c, "Object");
      c.call(this.k.deps.strEq());
      c.i32Or();
      c.ifVoid();
      c.refNull(this.k.deps.strType());
      c.return_();
      c.end();
      c.localGet(N);
      c.return_();
      c.end();
      c.refNull(this.k.deps.strType());
      c.return_();
      c.end();
      c.localGet(P);
      c.call(this.protoBox());
      c.localSet(P);
      c.br(0);
      c.end();
      c.end();
      void L;
      c.refNull(this.k.deps.strType());
    });
  }

  /** %w.om.protoBox(box) → the OBJ box an OBJ's own prototype link holds,
   * or null where the chain ends (Object.prototype, a null prototype, a
   * non-object box, an unlinked object). */
  protoBox(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    return this.fn("protoBox", [this.d.dynRef()], [this.d.dynRef()], [this.d.dynRef()], (c) => {
      const P = 1;
      c.localGet(0);
      c.structGet(dynT, DYN_REF);
      c.refTest(L);
      c.i32Eqz();
      c.ifVoid();
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(dynT, DYN_REF);
      c.refCast(L);
      c.structGet(L, this.d.olProto());
      c.localTee(P);
      c.refIsNull();
      c.ifVoid();
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.localGet(P);
      c.structGet(dynT, DYN_REF);
      c.call(this.objectProto());
      c.structGet(dynT, DYN_REF);
      c.refEq();
      c.i32Or();
      c.ifVoid();
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(P);
    });
  }

  /** %w.om.protoEnd(obj payload) → i32: 0 the chain ends at
   * Object.prototype, 1 the object's own prototype is null, 2 a prototype
   * further up the chain is null-prototyped. */
  protoEnd(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    return this.fn("protoEnd", [this.d.objRef()], [I32], [this.d.objRef(), this.d.dynRef(), I32], (c) => {
      const O = 1;
      const P = 2;
      const DEPTH = 3;
      c.localGet(0);
      c.localSet(O);
      c.block();
      c.loop();
      c.localGet(DEPTH);
      c.i32Const(100000);
      c.i32GtU();
      c.brIf(1);
      // a null-prototype payload (Object.create(null))
      c.localGet(O);
      c.structGet(this.d.objT(), OBJ_PROTO);
      c.i32Const(OBJ_PROTO_NULL);
      c.i32Eq();
      c.ifVoid();
      c.localGet(DEPTH);
      c.ifResult(I32);
      c.i32Const(2);
      c.else_();
      c.i32Const(1);
      c.end();
      c.return_();
      c.end();
      c.localGet(O);
      c.refTest(L);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(O);
      c.refCast(L);
      c.structGet(L, this.d.olProto());
      c.localTee(P);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.ifVoid();
      c.localGet(DEPTH);
      c.ifResult(I32);
      c.i32Const(2);
      c.else_();
      c.i32Const(1);
      c.end();
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.localGet(P);
      c.structGet(dynT, DYN_REF);
      c.call(this.objectProto());
      c.structGet(dynT, DYN_REF);
      c.refEq();
      c.i32Or();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(P);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.d.objT());
      c.localSet(O);
      c.localGet(DEPTH);
      c.i32Const(1);
      c.i32Add();
      c.localSet(DEPTH);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
    });
  }

  /* ── [[Set]] ────────────────────────────────────────────────────────── */

  /** The rejection of a write: a TypeError in strict code (the message the
   * caller pushes), nothing in sloppy code. The caller returns after. */
  private reject(c: Code, push: (c: Code) => void, sloppyLocal?: number): void {
    if (sloppyLocal !== undefined) c.localGet(sloppyLocal);
    else c.globalGet(this.sloppyGlobal());
    c.i32Eqz();
    c.ifVoid();
    this.throwType(c, push);
    c.end();
  }

  /** %w.om.set(recvBox, key, value) — [[Set]] on an OBJ receiver: an own
   * data property (writable) is replaced, an own or inherited accessor
   * runs its setter, a read-only one (own or inherited) or a new key on a
   * non-extensible object is rejected; else the key appends. */
  set(): number {
    const dynT = this.d.dynT();
    const entryT = this.d.entryT();
    const L = this.d.objLinkedT();
    return this.fn(
      "set",
      [this.d.dynRef(), this.strRef(), this.d.dynRef()],
      [],
      [this.d.objRef(), I32, this.d.entryRef(), this.d.dynRef(), I32, I32],
      (c) => {
        const O = 3;
        const IDX = 4;
        const E = 5;
        const P = 6;
        const OWN = 7;
        const SL = 8;
        c.globalGet(this.sloppyGlobal());
        c.localSet(SL);
        c.i32Const(0);
        c.globalSet(this.sloppyGlobal());
        this.d.objPayload(c, (x) => x.localGet(0));
        c.localSet(O);
        c.i32Const(1);
        c.localSet(OWN);
        c.localGet(0);
        c.localSet(P);
        c.block();
        c.loop();
        this.d.objPayload(c, (x) => x.localGet(P));
        c.localGet(1);
        c.call(this.ownIdx());
        c.localTee(IDX);
        c.i32Const(-1);
        c.i32Ne();
        c.ifVoid();
        // Found on this object of the chain.
        this.d.objPayload(c, (x) => x.localGet(P));
        c.localSet(O);
        this.pushEntryAt(c, O, IDX);
        c.localTee(E);
        c.structGet(entryT, ENTRY_VALUE);
        this.d.isAccessorCell(c);
        c.ifVoid();
        c.localGet(0);
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        c.localGet(2);
        c.call(this.callSetter());
        c.i32Eqz();
        c.ifVoid();
        this.reject(c, (x) => {
          this.lit(x, "Cannot set property ");
          x.localGet(1);
          this.concat(x);
          this.lit(x, " of ");
          this.concat(x);
          x.localGet(0);
          x.call(this.ctorNameOf());
          this.concat(x);
          this.lit(x, " which has only a getter");
          this.concat(x);
        }, SL);
        c.end();
        c.return_();
        c.end();
        c.localGet(E);
        this.entryFlags(c);
        c.i32Const(F_RO);
        c.i32And();
        c.ifVoid();
        this.reject(c, (x) => {
          this.lit(x, "Cannot assign to read only property '");
          x.localGet(1);
          this.concat(x);
          this.lit(x, "' of object '");
          this.concat(x);
          x.localGet(0);
          x.call(this.ctorNameOf());
          this.concat(x);
          this.lit(x, "'");
          this.concat(x);
        }, SL);
        c.return_();
        c.end();
        c.localGet(OWN);
        c.ifVoid();
        // through objPutW: an error's encoding keeps name/message in step
        c.localGet(O);
        c.localGet(1);
        c.localGet(2);
        c.call(this.d.objPutW());
        c.return_();
        c.end();
        // An inherited writable data property: shadow it (fall out).
        c.br(2);
        c.end();
        c.localGet(P);
        c.call(this.protoBox());
        c.localTee(P);
        c.refIsNull();
        c.brIf(1);
        c.i32Const(0);
        c.localSet(OWN);
        c.br(0);
        c.end();
        c.end();
        this.d.objPayload(c, (x) => x.localGet(0));
        c.localTee(O);
        c.refTest(L);
        c.ifVoid();
        c.localGet(O);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 3);
        c.i32Const(OF_NONEXT);
        c.i32And();
        c.ifVoid();
        this.reject(c, (x) => {
          this.lit(x, "Cannot add property ");
          x.localGet(1);
          this.concat(x);
          this.lit(x, ", object is not extensible");
          this.concat(x);
        }, SL);
        c.return_();
        c.end();
        c.end();
        c.localGet(O);
        c.localGet(1);
        c.localGet(2);
        c.call(this.d.objPutW());
        void dynT;
        void entryT;
      },
    );
  }

  /* ── defineProperty ─────────────────────────────────────────────────── */

  /** %w.om.define(obj, key, value, get, set, mask) → i32 ok: the
   * ValidateAndApplyPropertyDescriptor subset over one OBJ payload. On
   * failure the TypeError is pending and 0 answers. */
  define(): number {
    const dynT = this.d.dynT();
    const entryT = this.d.entryT();
    const L = this.d.objLinkedT();
    const objT = this.d.objT();
    return this.fn(
      "define",
      [this.d.objRef(), this.strRef(), this.d.dynRef(), this.d.dynRef(), this.d.dynRef(), I32],
      [I32],
      [I32, this.d.entryRef(), I32, I32, I32, I32, this.d.dynRef(), this.d.dynRef(), this.d.dynRef(), I32, I32],
      (c) => {
        const IDX = 6;
        const E = 7;
        const CF = 8; // current flags
        const CACC = 9; // current is accessor
        const NF = 10; // new flags
        const NACC = 11; // new is accessor
        const NV = 12;
        const G = 13;
        const S = 14;
        const ENUMNEW = 15;
        const ENUMCUR = 16;
        const M = 5;
        const fail = (msgKey: boolean): void => {
          this.throwType(c, (x) => {
            this.lit(x, "Cannot redefine property: ");
            x.localGet(1);
            this.concat(x);
          });
          void msgKey;
          c.i32Const(0);
          c.return_();
        };
        const has = (bit: number): void => {
          c.localGet(M);
          c.i32Const(bit);
          c.i32And();
          c.i32Const(0);
          c.i32Ne();
        };
        c.localGet(0);
        c.localGet(1);
        c.call(this.ownIdx());
        c.localTee(IDX);
        c.i32Const(-1);
        c.i32Eq();
        c.ifVoid();
        // ── a new property ──
        c.localGet(0);
        c.refTest(L);
        c.ifVoid();
        c.localGet(0);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 3);
        c.i32Const(OF_NONEXT);
        c.i32And();
        c.ifVoid();
        this.throwType(c, (x) => {
          this.lit(x, "Cannot define property ");
          x.localGet(1);
          this.concat(x);
          this.lit(x, ", object is not extensible");
          this.concat(x);
        });
        c.i32Const(0);
        c.return_();
        c.end();
        c.end();
        has(HAS_GET | HAS_SET);
        c.localSet(NACC);
        c.localGet(NACC);
        c.ifResult(this.d.dynRef());
        has(HAS_GET);
        c.ifResult(this.d.dynRef());
        c.localGet(3);
        c.else_();
        c.globalGet(this.d.undefinedGlobal());
        c.end();
        c.localSet(G);
        has(HAS_SET);
        c.ifResult(this.d.dynRef());
        c.localGet(4);
        c.else_();
        c.globalGet(this.d.undefinedGlobal());
        c.end();
        c.localSet(S);
        this.pushCell(c, G, S);
        c.else_();
        has(HAS_VALUE);
        c.ifResult(this.d.dynRef());
        c.localGet(2);
        c.else_();
        c.globalGet(this.d.undefinedGlobal());
        c.end();
        c.end();
        c.localSet(NV);
        // flags: RO unless writable (data only), NC unless configurable
        c.i32Const(0);
        c.localGet(NACC);
        c.i32Eqz();
        has(A_W);
        c.i32Eqz();
        c.i32And();
        c.ifResult(I32);
        c.i32Const(F_RO);
        c.else_();
        c.i32Const(0);
        c.end();
        c.i32Or();
        has(A_C);
        c.i32Eqz();
        c.ifResult(I32);
        c.i32Const(F_NC);
        c.else_();
        c.i32Const(0);
        c.end();
        c.i32Or();
        c.localSet(NF);
        has(A_E);
        c.ifVoid();
        // enumerable: append to the main table
        c.localGet(0);
        c.localGet(1);
        c.localGet(NV);
        c.call(this.d.objAppend());
        c.localGet(NF);
        c.ifVoid();
        c.localGet(0);
        c.structGet(objT, OBJ_ENTRIES);
        c.localGet(0);
        c.structGet(objT, OBJ_LEN);
        c.i32Const(1);
        c.i32Sub();
        c.localGet(1);
        c.localGet(NV);
        c.localGet(NF);
        c.structNew(this.entryAT());
        c.arraySet(this.d.entriesArrayType());
        c.end();
        c.else_();
        c.localGet(0);
        c.refTest(L);
        c.i32Eqz();
        c.ifVoid();
        this.k.deps.fence(c, (x) => this.lit(x, "defining a non-enumerable property on this kind of dynamic object is not supported yet"));
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(0);
        c.refCast(L);
        c.localGet(1);
        c.localGet(NV);
        c.localGet(NF);
        c.i32Const(F_HID);
        c.i32Or();
        c.localGet(0);
        c.structGet(objT, OBJ_LEN);
        c.i32Const(MARK_SHIFT);
        c.i32Shl();
        c.i32Or();
        c.structNew(this.entryAT());
        c.call(this.hiddenPush());
        c.end();
        c.i32Const(1);
        c.return_();
        c.end();
        // ── an existing property ──
        this.pushEntryAt(c, 0, IDX);
        c.localTee(E);
        this.entryFlags(c);
        c.localSet(CF);
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        this.d.isAccessorCell(c);
        c.localSet(CACC);
        c.localGet(CF);
        c.i32Const(F_HID);
        c.i32And();
        c.i32Eqz();
        c.localSet(ENUMCUR);
        has(HAS_GET | HAS_SET);
        c.i32Const(0);
        c.i32Ne();
        c.localSet(NACC);
        // Non-configurable: the checks that fail.
        c.localGet(CF);
        c.i32Const(F_NC);
        c.i32And();
        c.ifVoid();
        has(HAS_CONF);
        has(A_C);
        c.i32And();
        c.ifVoid();
        fail(true);
        c.end();
        has(HAS_ENUM);
        c.ifVoid();
        has(A_E);
        c.i32Const(0);
        c.i32Ne();
        c.localGet(ENUMCUR);
        c.i32Ne();
        c.ifVoid();
        fail(true);
        c.end();
        c.end();
        // a kind change (data <-> accessor)
        c.localGet(NACC);
        has(HAS_VALUE | HAS_WRITABLE);
        c.i32Const(0);
        c.i32Ne();
        c.i32Or();
        c.ifVoid();
        c.localGet(NACC);
        c.localGet(CACC);
        c.i32Ne();
        c.ifVoid();
        fail(true);
        c.end();
        c.end();
        c.localGet(CACC);
        c.ifVoid();
        has(HAS_GET);
        c.ifVoid();
        c.localGet(3);
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        this.cellGetter(c);
        c.call(this.d.sameValueDyn());
        c.i32Eqz();
        c.ifVoid();
        fail(true);
        c.end();
        c.end();
        has(HAS_SET);
        c.ifVoid();
        c.localGet(4);
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        this.cellSetter(c);
        c.call(this.d.sameValueDyn());
        c.i32Eqz();
        c.ifVoid();
        fail(true);
        c.end();
        c.end();
        c.else_();
        c.localGet(CF);
        c.i32Const(F_RO);
        c.i32And();
        c.ifVoid();
        has(HAS_WRITABLE);
        has(A_W);
        c.i32And();
        c.ifVoid();
        fail(true);
        c.end();
        has(HAS_VALUE);
        c.ifVoid();
        c.localGet(2);
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        c.call(this.d.sameValueDyn());
        c.i32Eqz();
        c.ifVoid();
        fail(true);
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        // ── apply ──
        // the new value
        c.localGet(NACC);
        c.ifResult(this.d.dynRef());
        has(HAS_GET);
        c.ifResult(this.d.dynRef());
        c.localGet(3);
        c.else_();
        c.localGet(CACC);
        c.ifResult(this.d.dynRef());
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        this.cellGetter(c);
        c.else_();
        c.globalGet(this.d.undefinedGlobal());
        c.end();
        c.end();
        c.localSet(G);
        has(HAS_SET);
        c.ifResult(this.d.dynRef());
        c.localGet(4);
        c.else_();
        c.localGet(CACC);
        c.ifResult(this.d.dynRef());
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        this.cellSetter(c);
        c.else_();
        c.globalGet(this.d.undefinedGlobal());
        c.end();
        c.end();
        c.localSet(S);
        this.pushCell(c, G, S);
        c.else_();
        has(HAS_VALUE);
        c.ifResult(this.d.dynRef());
        c.localGet(2);
        c.else_();
        c.localGet(CACC);
        c.ifResult(this.d.dynRef());
        c.globalGet(this.d.undefinedGlobal());
        c.else_();
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        c.end();
        c.end();
        c.end();
        c.localSet(NV);
        // the new flags
        c.i32Const(0);
        // RO
        c.localGet(NACC);
        c.ifResult(I32);
        c.i32Const(0);
        c.else_();
        has(HAS_WRITABLE);
        c.ifResult(I32);
        has(A_W);
        c.ifResult(I32);
        c.i32Const(0);
        c.else_();
        c.i32Const(F_RO);
        c.end();
        c.else_();
        c.localGet(CACC);
        c.ifResult(I32);
        c.i32Const(F_RO);
        c.else_();
        c.localGet(CF);
        c.i32Const(F_RO);
        c.i32And();
        c.end();
        c.end();
        c.end();
        c.i32Or();
        // NC
        has(HAS_CONF);
        c.ifResult(I32);
        has(A_C);
        c.ifResult(I32);
        c.i32Const(0);
        c.else_();
        c.i32Const(F_NC);
        c.end();
        c.else_();
        c.localGet(CF);
        c.i32Const(F_NC);
        c.i32And();
        c.end();
        c.i32Or();
        c.localSet(NF);
        has(HAS_ENUM);
        c.ifResult(I32);
        has(A_E);
        c.i32Const(0);
        c.i32Ne();
        c.else_();
        c.localGet(ENUMCUR);
        c.end();
        c.localSet(ENUMNEW);
        c.localGet(ENUMNEW);
        c.localGet(ENUMCUR);
        c.i32Eq();
        c.ifVoid();
        // same table: replace in place (keeping a hidden entry's marker)
        c.localGet(ENUMCUR);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(NF);
        c.localGet(CF);
        c.i32Const(~0xff);
        c.i32And();
        c.i32Or();
        c.i32Const(F_HID);
        c.i32Or();
        c.localSet(NF);
        c.end();
        this.setEntryAt(c, 0, IDX, (x) => this.pushNewEntry(x, 1, (y) => y.localGet(NV), NF));
        c.i32Const(1);
        c.return_();
        c.end();
        c.localGet(ENUMCUR);
        c.ifVoid();
        // main -> hidden, at its position
        c.localGet(0);
        c.refTest(L);
        c.i32Eqz();
        c.ifVoid();
        this.k.deps.fence(c, (x) => this.lit(x, "making a property non-enumerable on this kind of dynamic object is not supported yet"));
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(0);
        c.localGet(IDX);
        c.call(this.removeAt());
        c.localGet(0);
        c.refCast(L);
        c.localGet(1);
        c.localGet(NV);
        c.localGet(NF);
        c.i32Const(F_HID);
        c.i32Or();
        c.localGet(IDX);
        c.i32Const(MARK_SHIFT);
        c.i32Shl();
        c.i32Or();
        c.structNew(this.entryAT());
        c.call(this.hiddenPush());
        c.else_();
        // hidden -> main, at its marker
        c.localGet(0);
        c.localGet(CF);
        c.i32Const(MARK_SHIFT);
        c.i32ShrU();
        this.pushNewEntry(c, 1, (y) => y.localGet(NV), NF);
        c.i32Const(-2);
        c.localGet(IDX);
        c.i32Sub();
        c.call(this.mainInsert());
        // drop the hidden one (its index is unchanged by the insert)
        c.localGet(0);
        c.localGet(IDX);
        c.call(this.removeAt());
        c.end();
        c.i32Const(1);
        void dynT;
      },
    );
  }

  /** %w.om.toDesc(target box, key, desc box) → i32 ok: ToPropertyDescriptor
   * over `desc` (field reads in the spec's order, through [[Get]] so a
   * prototype or a getter answers), then the define on the target. */
  defineFromDesc(): number {
    const dynT = this.d.dynT();
    return this.fn(
      "defineFromDesc",
      [this.d.dynRef(), this.strRef(), this.d.dynRef()],
      [I32],
      [I32, I32, this.d.dynRef(), this.d.dynRef(), this.d.dynRef(), this.d.dynRef(), I32],
      (c) => {
        const M = 3;
        const DK_ = 4;
        const V = 5;
        const G = 6;
        const S = 7;
        const T = 8;
        const TK = 9;
        c.localGet(2);
        c.structGet(dynT, DYN_KIND);
        c.localTee(DK_);
        c.i32Const(DK.OBJ);
        c.i32Ne();
        c.localGet(DK_);
        c.i32Const(DK.FUNC);
        c.i32Ne();
        c.i32And();
        c.localGet(DK_);
        c.i32Const(DK.ARR);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        this.throwType(c, (x) => {
          this.lit(x, "Property description must be an object: ");
          x.localGet(2);
          x.call(this.d.toStr());
          this.concat(x);
        });
        c.i32Const(0);
        c.return_();
        c.end();
        const field = (name: string, hasBit: number, onPresent: () => void): void => {
          c.localGet(2);
          this.lit(c, name);
          c.call(this.d.hasKey());
          c.ifVoid();
          c.localGet(M);
          c.i32Const(hasBit);
          c.i32Or();
          c.localSet(M);
          c.localGet(2);
          this.lit(c, name);
          c.i32Const(0);
          c.call(this.d.keyGet());
          c.localTee(T);
          c.refIsNull();
          c.ifVoid();
          c.i32Const(0);
          c.return_();
          c.end();
          onPresent();
          c.end();
        };
        const flagBit = (attr: number): void => {
          c.localGet(T);
          c.call(this.d.truthy());
          c.ifVoid();
          c.localGet(M);
          c.i32Const(attr);
          c.i32Or();
          c.localSet(M);
          c.end();
        };
        c.globalGet(this.d.undefinedGlobal());
        c.localSet(V);
        c.globalGet(this.d.undefinedGlobal());
        c.localSet(G);
        c.globalGet(this.d.undefinedGlobal());
        c.localSet(S);
        field("enumerable", HAS_ENUM, () => flagBit(A_E));
        field("configurable", HAS_CONF, () => flagBit(A_C));
        field("value", HAS_VALUE, () => {
          c.localGet(T);
          c.localSet(V);
        });
        field("writable", HAS_WRITABLE, () => flagBit(A_W));
        const accessor = (name: string, bit: number, local: number, what: string): void =>
          field(name, bit, () => {
            c.localGet(T);
            c.structGet(dynT, DYN_KIND);
            c.localTee(TK);
            c.i32Const(DK.FUNC);
            c.i32Ne();
            c.localGet(TK);
            c.i32Const(DK.UNDEF);
            c.i32Ne();
            c.i32And();
            c.ifVoid();
            this.throwType(c, (x) => {
              this.lit(x, `${what} must be a function: `);
              x.localGet(T);
              x.call(this.d.toStr());
              this.concat(x);
            });
            c.i32Const(0);
            c.return_();
            c.end();
            c.localGet(T);
            c.localSet(local);
          });
        accessor("get", HAS_GET, G, "Getter");
        accessor("set", HAS_SET, S, "Setter");
        c.localGet(M);
        c.i32Const(HAS_GET | HAS_SET);
        c.i32And();
        c.i32Const(0);
        c.i32Ne();
        c.localGet(M);
        c.i32Const(HAS_VALUE | HAS_WRITABLE);
        c.i32And();
        c.i32Const(0);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        this.throwType(c, (x) =>
          this.lit(x, "Invalid property descriptor. Cannot both specify accessors and a value or writable attribute, #<Object>"));
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(0);
        c.localGet(1);
        c.localGet(V);
        c.localGet(G);
        c.localGet(S);
        c.localGet(M);
        c.call(this.defineOn());
      },
    );
  }

  /** %w.om.defineOn(target box, key, value, get, set, mask) → i32 ok:
   * dispatch by the target's kind. */
  defineOn(): number {
    const dynT = this.d.dynT();
    return this.fn(
      "defineOn",
      [this.d.dynRef(), this.strRef(), this.d.dynRef(), this.d.dynRef(), this.d.dynRef(), I32],
      [I32],
      [I32, this.k.fnPropsRef()],
      (c) => {
      this.d.errMirrorGuard(c, (x) => x.localGet(0), (x) => x.localGet(1), "Object.defineProperty (or defineProperties, or an assignment through it) on a member");
        const K = 6;
        const FP = 7;
        // A well-known symbol's property is modeled only non-enumerable
        // (Node's inspect, spread and assign would show an enumerable one).
        c.localGet(1);
        c.call(this.isSymKey());
        c.localGet(5);
        c.i32Const(A_E);
        c.i32And();
        c.i32Const(0);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        this.k.deps.fence(c, (x) => this.lit(x, "an enumerable symbol-keyed property on a dynamic value is not supported yet"));
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.localSet(K);
        this.k.arm(c, K, [DK.OBJ], () => {
          if (this.d.viewsLive) {
            this.d.isView(c, (x) => x.localGet(0));
            c.ifVoid();
            this.k.deps.fence(c, (x) => this.lit(x, "Object.defineProperty on a typed value shared into a dynamic slot is not supported yet"));
            c.i32Const(0);
            c.return_();
            c.end();
          }
          this.d.objPayload(c, (x) => x.localGet(0));
          for (let i = 1; i <= 5; i++) c.localGet(i);
          c.call(this.define());
        });
        this.k.arm(c, K, [DK.FUNC], () => {
          // A function's own table: enumerable keys in enumT, the rest in
          // its hidden table (keyGet/hasOwn read both).
          this.d.fnPayload(c, (x) => x.localGet(0));
          c.structGet(this.d.fnT(), FN_CLOS);
          c.call(this.k.fnPropsEnsure());
          c.localSet(FP);
          c.localGet(1);
          this.lit(c, "prototype");
          c.call(this.k.deps.strEq());
          c.ifVoid();
          c.localGet(0);
          c.call(this.fnPrototype());
          c.drop();
          c.end();
          this.d.objPayload(c, (x) => {
            x.localGet(FP);
            x.structGet(this.k.fnPropsT(), 1);
          });
          for (let i = 1; i <= 5; i++) c.localGet(i);
          c.call(this.define());
        });
        this.k.arm(c, K, [DK.ARR], () => {
          this.k.deps.fence(c, (x) => this.lit(x, "Object.defineProperty on an array is not supported yet"));
          c.i32Const(0);
        });
        this.throwType(c, (x) => this.lit(x, "Object.defineProperty called on non-object"));
        c.i32Const(0);
      },
    );
  }

  /** %w.om.defineProperty(target, key box, desc) → target (null pending). */
  defineProperty(): number {
    return this.fn("defineProperty", [this.d.dynRef(), this.d.dynRef(), this.d.dynRef()], [this.d.dynRef()], [this.strRef()], (c) => {
      const KS = 3;
      c.localGet(1);
      c.call(this.d.toPropertyKey());
      c.localTee(KS);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.d.dynT());
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(this.d.dynT(), DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.localGet(0);
      c.structGet(this.d.dynT(), DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.i32And();
      c.localGet(0);
      c.structGet(this.d.dynT(), DYN_KIND);
      c.i32Const(DK.ARR);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      this.throwType(c, (x) => this.lit(x, "Object.defineProperty called on non-object"));
      c.refNull(this.d.dynT());
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(KS);
      c.localGet(2);
      c.call(this.defineFromDesc());
      c.ifResult(this.d.dynRef());
      c.localGet(0);
      c.else_();
      c.refNull(this.d.dynT());
      c.end();
    });
  }

  /** %w.om.defineProperties(target, props) → target: every descriptor is
   * read before any is defined (the spec's two passes). */
  defineProperties(): number {
    const dynT = this.d.dynT();
    return this.fn(
      "defineProperties",
      [this.d.dynRef(), this.d.dynRef()],
      [this.d.dynRef()],
      [this.d.dynRef(), I32, this.d.dynRef(), this.d.dynRef(), this.d.arrRef()],
      (c) => {
        const KEYS = 2;
        const I = 3;
        const KB = 4;
        const DESC = 5;
        const DS = 6;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.OBJ);
        c.i32Ne();
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        this.throwType(c, (x) => this.lit(x, "Object.defineProperties called on non-object"));
        c.refNull(dynT);
        c.return_();
        c.end();
        c.localGet(1);
        c.i32Const(0);
        c.call(this.d.objWalk());
        c.localTee(KEYS);
        c.refIsNull();
        c.ifVoid();
        c.refNull(dynT);
        c.return_();
        c.end();
        // pass 1: read every descriptor
        this.d.pushNewArr(c);
        c.localSet(DS);
        const nKeys = (x: Code): void => this.d.arrLen(x, (y) => this.d.arrPayload(y, (z) => z.localGet(KEYS)));
        this.forI(c, I, nKeys, () => {
          this.d.arrAt(c, (x) => this.d.arrPayload(x, (y) => y.localGet(KEYS)), (x) => x.localGet(I));
          c.localSet(KB);
          c.localGet(1);
          c.localGet(KB);
          c.structGet(dynT, DYN_REF);
          emitFlatCast(c, this.k.deps.strType());
          c.i32Const(0);
          c.call(this.d.keyGet());
          c.localTee(DESC);
          c.refIsNull();
          c.ifVoid();
          c.refNull(dynT);
          c.return_();
          c.end();
          c.localGet(DS);
          c.localGet(DESC);
          c.call(this.k.deps.arrPush());
        });
        // pass 2: define
        this.forI(c, I, nKeys, () => {
          c.localGet(0);
          this.d.arrAt(c, (x) => this.d.arrPayload(x, (y) => y.localGet(KEYS)), (x) => x.localGet(I));
          c.structGet(dynT, DYN_REF);
          emitFlatCast(c, this.k.deps.strType());
          this.d.arrAt(c, (x) => x.localGet(DS), (x) => x.localGet(I));
          c.call(this.defineFromDesc());
          c.i32Eqz();
          c.ifVoid();
          c.refNull(dynT);
          c.return_();
          c.end();
        });
        c.localGet(0);
      },
    );
  }

  /* ── descriptors and own names ──────────────────────────────────────── */

  /** A fresh descriptor object from an own entry. */
  private pushDescOf(c: Code, entry: number, flagsLocal: number, tmp: number): void {
    const entryT = this.d.entryT();
    const put = (key: string, val: (x: Code) => void): void => {
      c.localGet(tmp);
      this.lit(c, key);
      val(c);
      c.call(this.d.objAppend());
    };
    const bool = (x: Code, bit: number, invert: boolean): void => {
      x.localGet(flagsLocal);
      x.i32Const(bit);
      x.i32And();
      if (invert) x.i32Eqz();
      else {
        x.i32Const(0);
        x.i32Ne();
      }
      x.ifResult(this.d.dynRef());
      x.globalGet(this.d.boolGlobal(true));
      x.else_();
      x.globalGet(this.d.boolGlobal(false));
      x.end();
    };
    this.d.pushNewObj(c, false);
    c.localSet(tmp);
    c.localGet(entry);
    c.structGet(entryT, ENTRY_VALUE);
    this.d.isAccessorCell(c);
    c.ifVoid();
    put("get", (x) => { x.localGet(entry); x.structGet(entryT, ENTRY_VALUE); this.cellGetter(x); });
    put("set", (x) => { x.localGet(entry); x.structGet(entryT, ENTRY_VALUE); this.cellSetter(x); });
    c.else_();
    put("value", (x) => { x.localGet(entry); x.structGet(entryT, ENTRY_VALUE); });
    put("writable", (x) => bool(x, F_RO, true));
    c.end();
    put("enumerable", (x) => bool(x, F_HID, true));
    put("configurable", (x) => bool(x, F_NC, true));
    this.d.boxObj(c, (x) => x.localGet(tmp));
  }

  /** %w.om.ownDesc(target, key str) → the descriptor box or undefined. */
  ownDesc(): number {
    const dynT = this.d.dynT();
    return this.fn(
      "ownDesc",
      [this.d.dynRef(), this.strRef()],
      [this.d.dynRef()],
      [I32, this.d.entryRef(), I32, this.d.objRef(), this.k.fnPropsRef(), I32],
      (c) => {
        const K = 2;
        const E = 3;
        const F = 4;
        const TMP = 5;
        const FP = 6;
        const IX = 7;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.localSet(K);
        const fromObj = (pushObj: (x: Code) => void, extraFlags: number): void => {
          pushObj(c);
          c.localGet(1);
          c.call(this.ownEntry());
          c.localTee(E);
          c.refIsNull();
          c.i32Eqz();
          c.ifVoid();
          c.localGet(E);
          this.entryFlags(c);
          c.i32Const(extraFlags);
          c.i32Or();
          c.localSet(F);
          this.pushDescOf(c, E, F, TMP);
          c.return_();
          c.end();
        };
        this.k.arm(c, K, [DK.OBJ], () => {
          fromObj((x) => this.d.objPayload(x, (y) => y.localGet(0)), 0);
          c.globalGet(this.d.undefinedGlobal());
        });
        this.k.arm(c, K, [DK.FUNC], () => {
          c.localGet(1);
          this.lit(c, "prototype");
          c.call(this.k.deps.strEq());
          c.ifVoid();
          c.localGet(0);
          c.call(this.fnPrototype());
          c.drop();
          c.end();
          this.d.fnPayload(c, (x) => x.localGet(0));
          c.structGet(this.d.fnT(), FN_CLOS);
          c.call(this.k.fnPropsFind());
          c.localTee(FP);
          c.refIsNull();
          c.i32Eqz();
          c.ifVoid();
          fromObj((x) => this.d.objPayload(x, (y) => { y.localGet(FP); y.structGet(this.k.fnPropsT(), 1); }), 0);
          fromObj((x) => this.d.objPayload(x, (y) => { y.localGet(FP); y.structGet(this.k.fnPropsT(), 2); }), F_HID);
          c.end();
          // name and length: { value, writable: false, enumerable: false, configurable: true }
          for (const nm of ["name", "length"]) {
            c.localGet(1);
            this.lit(c, nm);
            c.call(this.k.deps.strEq());
            c.ifVoid();
            this.d.pushNewObj(c, false);
            c.localSet(TMP);
            c.localGet(TMP);
            this.lit(c, "value");
            c.localGet(0);
            this.lit(c, nm);
            c.i32Const(0);
            c.call(this.d.keyGet());
            c.call(this.d.objAppend());
            for (const [k, v] of [["writable", false], ["enumerable", false], ["configurable", true]] as const) {
              c.localGet(TMP);
              this.lit(c, k);
              c.globalGet(this.d.boolGlobal(v));
              c.call(this.d.objAppend());
            }
            this.d.boxObj(c, (x) => x.localGet(TMP));
            c.return_();
            c.end();
          }
          c.globalGet(this.d.undefinedGlobal());
        });
        this.k.arm(c, K, [DK.ARR], () => {
          c.localGet(1);
          c.call(this.d.canonIdx());
          c.localTee(IX);
          c.i32Const(0);
          c.i32GeS();
          c.ifVoid();
          c.localGet(IX);
          this.d.arrLen(c, (x) => this.d.arrPayload(x, (y) => y.localGet(0)));
          c.i32LtU();
          c.ifVoid();
          this.d.pushNewObj(c, false);
          c.localSet(TMP);
          c.localGet(TMP);
          this.lit(c, "value");
          this.d.arrAt(c, (x) => this.d.arrPayload(x, (y) => y.localGet(0)), (x) => x.localGet(IX));
          c.call(this.d.objAppend());
          for (const k of ["writable", "enumerable", "configurable"]) {
            c.localGet(TMP);
            this.lit(c, k);
            c.globalGet(this.d.boolGlobal(true));
            c.call(this.d.objAppend());
          }
          this.d.boxObj(c, (x) => x.localGet(TMP));
          c.return_();
          c.end();
          c.end();
          c.localGet(1);
          this.lit(c, "length");
          c.call(this.k.deps.strEq());
          c.ifVoid();
          this.d.pushNewObj(c, false);
          c.localSet(TMP);
          c.localGet(TMP);
          this.lit(c, "value");
          c.localGet(0);
          this.lit(c, "length");
          c.i32Const(0);
          c.call(this.d.keyGet());
          c.call(this.d.objAppend());
          for (const [k, v] of [["writable", true], ["enumerable", false], ["configurable", false]] as const) {
            c.localGet(TMP);
            this.lit(c, k);
            c.globalGet(this.d.boolGlobal(v));
            c.call(this.d.objAppend());
          }
          this.d.boxObj(c, (x) => x.localGet(TMP));
          c.return_();
          c.end();
          c.globalGet(this.d.undefinedGlobal());
        });
        this.k.arm(c, K, [DK.UNDEF, DK.NULL], () => {
          this.throwType(c, (x) => this.lit(x, "Cannot convert undefined or null to object"));
          c.refNull(dynT);
        });
        this.k.arm(c, K, [DK.NUM, DK.BOOL], () => c.globalGet(this.d.undefinedGlobal()));
        this.k.deps.fence(c, (x) => this.lit(x, "Object.getOwnPropertyDescriptor on this kind of dynamic value is not supported yet"));
        c.refNull(dynT);
      },
    );
  }

  /** %w.om.getOwnPropertyDescriptor(target, key box) → desc or undefined. */
  getOwnPropertyDescriptor(): number {
    return this.fn("gopd", [this.d.dynRef(), this.d.dynRef()], [this.d.dynRef()], [this.strRef()], (c) => {
      c.localGet(1);
      c.call(this.d.toPropertyKey());
      c.localTee(2);
      c.refIsNull();
      c.ifVoid();
      c.refNull(this.d.dynT());
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(2);
      c.call(this.ownDesc());
    });
  }

  /** %w.om.isSymKey(key) → i32: a well-known symbol's reserved key
   * (SYM_KEY_PREFIX), which no string-key walker lists. */
  isSymKey(): number {
    const strT = this.k.deps.strType();
    return this.fn("isSymKey", [this.strRef()], [I32], [{ kind: "ref", nullable: true, typeIndex: strT }], (c) => {
      c.localGet(0);
      emitFlatCast(c, strT);
      c.localTee(1);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(1);
      c.i32Const(0);
      c.arrayGetU(strT);
      c.i32Const(0xd800);
      c.i32Eq();
    });
  }

  /** %w.om.ownNames(target) → a fresh ARR of every own string key in
   * Node's order (array indices ascending, then creation order, the
   * non-enumerable keys included). */
  ownNames(): number {
    const dynT = this.d.dynT();
    const objT = this.d.objT();
    const L = this.d.objLinkedT();
    const entries = this.d.entriesArrayType();
    const entryT = this.d.entryT();
    return this.fn(
      "ownNames",
      [this.d.dynRef()],
      [this.d.dynRef()],
      [I32, this.d.objRef(), this.d.objRef(), I32, I32, this.d.entryRef(), I32, this.k.fnPropsRef(), this.d.dynRef(), this.d.arrRef()],
      (c) => {
        const K = 1;
        const O = 2;
        const TMP = 3;
        const I = 4;
        const J = 5;
        const E = 6;
        const HN = 7;
        const FP = 8;
        const R = 9;
        const A = 10;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.localSet(K);
        // Merge one object's two tables into TMP in creation order.
        const merge = (): void => {
          c.localGet(O);
          c.refTest(L);
          c.ifResult(I32);
          c.localGet(O);
          c.refCast(L);
          c.structGet(L, this.d.olProto() + 2);
          c.else_();
          c.i32Const(0);
          c.end();
          c.localSet(HN);
          // for each main index i (0..len): first the hidden entries whose
          // marker is i, then main[i].
          c.i32Const(0);
          c.localSet(I);
          c.block();
          c.loop();
          c.localGet(I);
          c.localGet(O);
          c.structGet(objT, OBJ_LEN);
          c.i32GtS();
          c.brIf(1);
          this.forI(c, J, (x) => x.localGet(HN), () => {
            c.localGet(O);
            c.refCast(L);
            c.structGet(L, this.d.olProto() + 1);
            c.localGet(J);
            c.arrayGet(entries);
            c.localTee(E);
            this.entryFlags(c);
            c.i32Const(MARK_SHIFT);
            c.i32ShrU();
            c.localGet(I);
            c.i32Eq();
            c.localGet(E);
            c.structGet(entryT, ENTRY_KEY);
            c.call(this.isSymKey());
            c.i32Eqz();
            c.i32And();
            c.ifVoid();
            c.localGet(TMP);
            c.localGet(E);
            c.structGet(entryT, ENTRY_KEY);
            c.globalGet(this.d.undefinedGlobal());
            c.call(this.d.objAppend());
            c.end();
          });
          c.localGet(I);
          c.localGet(O);
          c.structGet(objT, OBJ_LEN);
          c.i32LtS();
          c.ifVoid();
          c.localGet(TMP);
          c.localGet(O);
          c.structGet(objT, OBJ_ENTRIES);
          c.localGet(I);
          c.arrayGet(entries);
          c.structGet(entryT, ENTRY_KEY);
          c.globalGet(this.d.undefinedGlobal());
          c.call(this.d.objAppend());
          c.end();
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
          c.br(0);
          c.end();
          c.end();
        };
        this.k.arm(c, K, [DK.OBJ], () => {
          this.d.pushNewObj(c, false);
          c.localSet(TMP);
          this.d.objPayload(c, (x) => x.localGet(0));
          c.localSet(O);
          merge();
          this.d.boxObj(c, (x) => x.localGet(TMP));
          c.i32Const(0);
          c.call(this.d.objWalk());
        });
        this.k.arm(c, K, [DK.FUNC], () => {
          // Node: length, name, then the program's own keys in creation
          // order — for an arrow or a method. An ordinary function also
          // lists `prototype` (and, sloppy, `arguments`/`caller`), which
          // this walk does not model: it stops by name.
          this.d.fnPayload(c, (x) => x.localGet(0));
          c.structGet(this.d.fnT(), FN_PROTO);
          c.i32Const(3);
          c.i32And();
          c.i32Const(2);
          c.i32Ne();
          c.ifVoid();
          this.k.deps.fence(c, (x) => this.lit(x, "Object.getOwnPropertyNames of an ordinary function is not supported yet"));
          c.end();
          this.d.pushNewArr(c);
          c.localSet(A);
          for (const nm of ["length", "name"]) {
            c.localGet(A);
            this.d.boxStr(c, (x) => this.lit(x, nm));
            c.call(this.k.deps.arrPush());
          }
          this.d.fnPayload(c, (x) => x.localGet(0));
          c.structGet(this.d.fnT(), FN_CLOS);
          c.call(this.k.fnPropsFind());
          c.localTee(FP);
          c.refIsNull();
          c.i32Eqz();
          c.ifVoid();
          this.d.pushNewObj(c, false);
          c.localSet(TMP);
          for (const f of [2, 1]) {
            this.d.objPayload(c, (x) => { x.localGet(FP); x.structGet(this.k.fnPropsT(), f); });
            c.localSet(O);
            merge();
          }
          this.d.boxObj(c, (x) => x.localGet(TMP));
          c.i32Const(0);
          c.call(this.d.objWalk());
          c.localSet(R);
          this.forI(c, I, (x) => this.d.arrLen(x, (y) => this.d.arrPayload(y, (z) => z.localGet(R))), () => {
            c.localGet(A);
            this.d.arrAt(c, (x) => this.d.arrPayload(x, (y) => y.localGet(R)), (x) => x.localGet(I));
            c.call(this.k.deps.arrPush());
          });
          c.end();
          this.d.boxArr(c, (x) => x.localGet(A));
        });
        this.k.arm(c, K, [DK.ARR], () => {
          c.localGet(0);
          c.i32Const(0);
          c.call(this.d.objWalk());
          c.localSet(R);
          this.d.arrPayload(c, (x) => x.localGet(R));
          c.localSet(A);
          c.localGet(A);
          this.d.boxStr(c, (x) => this.lit(x, "length"));
          c.call(this.k.deps.arrPush());
          c.localGet(R);
        });
        this.k.arm(c, K, [DK.UNDEF, DK.NULL], () => {
          this.throwType(c, (x) => this.lit(x, "Cannot convert undefined or null to object"));
          c.refNull(dynT);
        });
        c.localGet(0);
        c.i32Const(0);
        c.call(this.d.objWalk());
      },
    );
  }

  /** %w.om.getOwnPropertyDescriptors(target) → { key: desc, ... }. */
  getOwnPropertyDescriptors(): number {
    return this.fn(
      "gopds",
      [this.d.dynRef()],
      [this.d.dynRef()],
      [this.d.dynRef(), this.d.objRef(), I32, this.d.dynRef(), this.d.dynRef()],
      (c) => {
        const NAMES = 1;
        const OUT = 2;
        const I = 3;
        const KB = 4;
        const D = 5;
        // Node lists symbol keys here too; one held under the reserved key
        // stops by name rather than going missing.
        c.localGet(0);
        c.structGet(this.d.dynT(), DYN_KIND);
        c.i32Const(DK.OBJ);
        c.i32Eq();
        c.localGet(0);
        c.structGet(this.d.dynT(), DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Eq();
        c.i32Or();
        c.ifVoid();
        c.localGet(0);
        this.lit(c, SYM_HAS_INSTANCE);
        c.call(this.ownDesc());
        c.structGet(this.d.dynT(), DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Ne();
        c.ifVoid();
        this.k.deps.fence(c, (x) => this.lit(x, "Object.getOwnPropertyDescriptors of an object with a symbol-keyed property is not supported yet"));
        c.end();
        c.end();
        c.localGet(0);
        c.call(this.ownNames());
        c.localTee(NAMES);
        c.refIsNull();
        c.ifVoid();
        c.refNull(this.d.dynT());
        c.return_();
        c.end();
        this.d.pushNewObj(c, false);
        c.localSet(OUT);
        this.forI(c, I, (x) => this.d.arrLen(x, (y) => this.d.arrPayload(y, (z) => z.localGet(NAMES))), () => {
          this.d.arrAt(c, (x) => this.d.arrPayload(x, (y) => y.localGet(NAMES)), (x) => x.localGet(I));
          c.localSet(KB);
          c.localGet(0);
          c.localGet(KB);
          c.structGet(this.d.dynT(), DYN_REF);
          emitFlatCast(c, this.k.deps.strType());
          c.call(this.ownDesc());
          c.localTee(D);
          c.refIsNull();
          c.ifVoid();
          c.refNull(this.d.dynT());
          c.return_();
          c.end();
          c.localGet(OUT);
          c.localGet(KB);
          c.structGet(this.d.dynT(), DYN_REF);
          emitFlatCast(c, this.k.deps.strType());
          c.localGet(D);
          c.call(this.d.objAppend());
        });
        this.d.boxObj(c, (x) => x.localGet(OUT));
      },
    );
  }

  /* ── delete ─────────────────────────────────────────────────────────── */

  /** %w.om.delete(target, key str) → i32 (the delete's boolean; a strict
   * non-configurable delete leaves the TypeError pending and answers 0). */
  deleteKey(): number {
    const dynT = this.d.dynT();
    return this.fn(
      "delete",
      [this.d.dynRef(), this.strRef()],
      [I32],
      [I32, this.d.objRef(), I32, this.k.fnPropsRef(), I32],
      (c) => {
      this.d.errMirrorGuard(c, (x) => x.localGet(0), (x) => x.localGet(1), "'delete' of a member");
        const K = 2;
        const O = 3;
        const IDX = 4;
        const FP = 5;
        const IX = 6;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.localSet(K);
        const delFrom = (): void => {
          c.localGet(O);
          c.localGet(1);
          c.call(this.ownIdx());
          c.localTee(IDX);
          c.i32Const(-1);
          c.i32Ne();
          c.ifVoid();
          this.pushEntryAt(c, O, IDX);
          this.entryFlags(c);
          c.i32Const(F_NC);
          c.i32And();
          c.ifVoid();
          this.reject(c, (x) => {
            this.lit(x, "Cannot delete property '");
            x.localGet(1);
            this.concat(x);
            this.lit(x, "' of ");
            this.concat(x);
            x.localGet(0);
            x.call(this.ctorNameOf());
            this.concat(x);
          });
          c.i32Const(0);
          c.return_();
          c.end();
          c.localGet(O);
          c.localGet(IDX);
          c.call(this.removeAt());
          c.i32Const(1);
          c.return_();
          c.end();
        };
        this.k.arm(c, K, [DK.OBJ], () => {
          if (this.d.viewsLive) {
            this.d.isView(c, (x) => x.localGet(0));
            c.ifVoid();
            this.k.deps.fence(c, (x) => this.lit(x, "'delete' on a typed value shared into a dynamic slot is not supported yet"));
            c.i32Const(0);
            c.return_();
            c.end();
          }
          this.d.objPayload(c, (x) => x.localGet(0));
          c.localSet(O);
          delFrom();
          c.i32Const(1);
        });
        this.k.arm(c, K, [DK.FUNC], () => {
          this.d.fnPayload(c, (x) => x.localGet(0));
          c.structGet(this.d.fnT(), FN_CLOS);
          c.call(this.k.fnPropsFind());
          c.localTee(FP);
          c.refIsNull();
          c.i32Eqz();
          c.ifVoid();
          for (const f of [1, 2]) {
            this.d.objPayload(c, (x) => { x.localGet(FP); x.structGet(this.k.fnPropsT(), f); });
            c.localSet(O);
            delFrom();
          }
          c.end();
          for (const nm of ["name", "length", "prototype"]) {
            c.localGet(1);
            this.lit(c, nm);
            c.call(this.k.deps.strEq());
            c.ifVoid();
            this.k.deps.fence(c, (x) => this.lit(x, `deleting a function's '${nm}' is not supported yet`));
            c.end();
          }
          c.i32Const(1);
        });
        this.k.arm(c, K, [DK.ARR], () => {
          c.localGet(1);
          c.call(this.d.canonIdx());
          c.localTee(IX);
          c.i32Const(0);
          c.i32GeS();
          c.ifVoid();
          c.localGet(IX);
          this.d.arrLen(c, (x) => this.d.arrPayload(x, (y) => y.localGet(0)));
          c.i32LtU();
          c.ifVoid();
          this.k.deps.fence(c, (x) => this.lit(x, "'delete' of an array element (the hole Node leaves) is not supported yet"));
          c.end();
          c.end();
          c.localGet(1);
          this.lit(c, "length");
          c.call(this.k.deps.strEq());
          c.ifVoid();
          this.reject(c, (x) => this.lit(x, "Cannot delete property 'length' of [object Array]"));
          c.i32Const(0);
          c.return_();
          c.end();
          c.i32Const(1);
        });
        this.k.arm(c, K, [DK.UNDEF, DK.NULL], () => {
          this.throwType(c, (x) => this.lit(x, "Cannot convert undefined or null to object"));
          c.i32Const(0);
        });
        this.k.arm(c, K, [DK.NUM, DK.BOOL], () => c.i32Const(1));
        this.k.deps.fence(c, (x) => this.lit(x, "'delete' on this kind of dynamic value is not supported yet"));
        c.i32Const(0);
      },
    );
  }

  /* ── prototypes ─────────────────────────────────────────────────────── */

  /** %w.om.getProto(v) → the prototype: an OBJ's link, the
   * Object.prototype stand-in, or null. */
  getProto(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    return this.fn("getProto", [this.d.dynRef()], [this.d.dynRef()], [I32, this.d.dynRef()], (c) => {
      const K = 1;
      const P = 2;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.k.arm(c, K, [DK.OBJ], () => {
        // the stand-in itself: null
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.call(this.objectProto());
        c.structGet(dynT, DYN_REF);
        c.refEq();
        c.ifVoid();
        c.globalGet(this.d.nullGlobal());
        c.return_();
        c.end();
        this.d.objPayload(c, (x) => x.localGet(0));
        c.refTest(L);
        c.ifVoid();
        this.d.objPayload(c, (x) => x.localGet(0));
        c.refCast(L);
        c.structGet(L, this.d.olProto());
        c.localTee(P);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(P);
        c.return_();
        c.end();
        c.end();
        this.d.objPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.objT(), OBJ_PROTO);
        c.i32Const(OBJ_PROTO_NULL);
        c.i32Eq();
        c.ifResult(this.d.dynRef());
        c.globalGet(this.d.nullGlobal());
        c.else_();
        c.call(this.objectProto());
        c.end();
      });
      this.k.arm(c, K, [DK.UNDEF, DK.NULL], () => {
        this.throwType(c, (x) => this.lit(x, "Cannot convert undefined or null to object"));
        c.refNull(dynT);
      });
      this.k.deps.fence(c, (x) => this.lit(x, "Object.getPrototypeOf of a non-plain dynamic value (an array, function or primitive) is not supported yet"));
      c.refNull(dynT);
    });
  }

  /** %w.om.setProto(o, p) → o. */
  setProto(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    return this.fn("setProto", [this.d.dynRef(), this.d.dynRef()], [this.d.dynRef()], [I32, this.d.dynRef(), I32], (c) => {
      this.d.errMirrorGuard(c, (x) => x.localGet(0), null, "Object.setPrototypeOf");
      const PK = 2;
      const W = 3;
      const G = 4;
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.localSet(PK);
      c.localGet(PK);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.localGet(PK);
      c.i32Const(DK.NULL);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      this.throwType(c, (x) => {
        this.lit(x, "Object prototype may only be an Object or null: ");
        x.localGet(1);
        x.call(this.d.toStr());
        this.concat(x);
      });
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.ifVoid();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      this.throwType(c, (x) => this.lit(x, "Object.setPrototypeOf called on null or undefined"));
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.ifVoid();
      this.k.deps.fence(c, (x) => this.lit(x, "Object.setPrototypeOf on a function is not supported yet"));
      c.end();
      c.localGet(0);
      c.return_();
      c.end();
      this.d.objPayload(c, (x) => x.localGet(0));
      c.refTest(L);
      c.i32Eqz();
      c.ifVoid();
      this.k.deps.fence(c, (x) => this.lit(x, "Object.setPrototypeOf on this kind of dynamic object is not supported yet"));
      c.refNull(dynT);
      c.return_();
      c.end();
      // A cycle: V8's "Cyclic __proto__ value".
      c.localGet(1);
      c.localSet(W);
      c.block();
      c.loop();
      c.localGet(W);
      c.refIsNull();
      c.brIf(1);
      c.localGet(W);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.brIf(1);
      c.localGet(W);
      c.structGet(dynT, DYN_REF);
      c.localGet(0);
      c.structGet(dynT, DYN_REF);
      c.refEq();
      c.ifVoid();
      this.throwType(c, (x) => this.lit(x, "Cyclic __proto__ value"));
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(W);
      c.call(this.protoBox());
      c.localSet(W);
      c.localGet(G);
      c.i32Const(1);
      c.i32Add();
      c.localTee(G);
      c.i32Const(100000);
      c.i32GtU();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      this.d.objPayload(c, (x) => x.localGet(0));
      c.refCast(L);
      c.localGet(PK);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.ifResult(this.d.dynRef());
      c.globalGet(this.d.nullGlobal());
      c.else_();
      // the Object.prototype stand-in is the default link
      c.localGet(1);
      c.structGet(dynT, DYN_REF);
      c.call(this.objectProto());
      c.structGet(dynT, DYN_REF);
      c.refEq();
      c.ifResult(this.d.dynRef());
      c.refNull(dynT);
      c.else_();
      c.localGet(1);
      c.end();
      c.end();
      c.structSet(L, this.d.olProto());
      c.localGet(0);
    });
  }

  /** %w.om.create(proto, props) → Object.create(proto, props). */
  create(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    return this.fn("create", [this.d.dynRef(), this.d.dynRef()], [this.d.dynRef()], [this.d.dynRef(), I32], (c) => {
      const O = 2;
      const PK = 3;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localTee(PK);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.ifVoid();
      this.d.boxObj(c, (x) => this.d.pushNewObj(x, true));
      c.localSet(O);
      c.else_();
      c.localGet(PK);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.ifVoid();
      this.throwType(c, (x) => {
        this.lit(x, "Object prototype may only be an Object or null: ");
        x.localGet(0);
        x.call(this.d.toStr());
        this.concat(x);
      });
      c.refNull(dynT);
      c.return_();
      c.end();
      this.d.boxObj(c, (x) => this.d.pushNewObj(x, false));
      c.localTee(O);
      c.localGet(0);
      c.call(this.setProto());
      c.drop();
      c.end();
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.UNDEF);
      c.i32Ne();
      c.ifVoid();
      c.localGet(O);
      c.localGet(1);
      c.call(this.defineProperties());
      c.refIsNull();
      c.ifVoid();
      c.refNull(dynT);
      c.return_();
      c.end();
      c.end();
      c.localGet(O);
      void L;
    });
  }

  /* ── for-in ─────────────────────────────────────────────────────────── */

  /** %w.om.forInKeys(v) → a fresh ARR of the keys for-in visits: each
   * object's own enumerable keys in order, up the chain, a key seen on a
   * nearer object (enumerable or not) skipped. */
  forInKeys(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    const entries = this.d.entriesArrayType();
    const entryT = this.d.entryT();
    return this.fn(
      "forInKeys",
      [this.d.dynRef()],
      [this.d.dynRef()],
      [I32, this.d.arrRef(), this.d.objRef(), this.d.dynRef(), this.d.dynRef(), I32, this.d.dynRef(), this.d.objRef(), I32],
      (c) => {
        const K = 1;
        const OUT = 2;
        const SEEN = 3;
        const P = 4;
        const KEYS = 5;
        const I = 6;
        const KB = 7;
        const O = 8;
        const GUARD = 9;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.localSet(K);
        this.k.arm(c, K, [DK.UNDEF, DK.NULL], () => this.d.boxArr(c, (x) => this.d.pushNewArr(x)));
        c.localGet(K);
        c.i32Const(DK.OBJ);
        c.i32Ne();
        c.ifVoid();
        // arrays, strings, functions: own enumerable keys (no modeled
        // prototype carries enumerable keys)
        c.localGet(K);
        c.i32Const(DK.NUM);
        c.i32Eq();
        c.localGet(K);
        c.i32Const(DK.BOOL);
        c.i32Eq();
        c.i32Or();
        c.ifVoid();
        this.d.boxArr(c, (x) => this.d.pushNewArr(x));
        c.return_();
        c.end();
        c.localGet(0);
        c.i32Const(0);
        c.call(this.d.objWalk());
        c.return_();
        c.end();
        this.d.pushNewArr(c);
        c.localSet(OUT);
        this.d.pushNewObj(c, false);
        c.localSet(SEEN);
        c.localGet(0);
        c.localSet(P);
        c.block();
        c.loop();
        c.localGet(P);
        c.refIsNull();
        c.brIf(1);
        c.localGet(GUARD);
        c.i32Const(1);
        c.i32Add();
        c.localTee(GUARD);
        c.i32Const(100000);
        c.i32GtU();
        c.brIf(1);
        c.localGet(P);
        c.i32Const(0);
        // GH #191 / #193: an error's encoding lists as the program sees it
        c.call(this.d.objWalkUser());
        c.localTee(KEYS);
        c.refIsNull();
        c.ifVoid();
        c.refNull(dynT);
        c.return_();
        c.end();
        this.forI(c, I, (x) => this.d.arrLen(x, (y) => this.d.arrPayload(y, (z) => z.localGet(KEYS))), () => {
          this.d.arrAt(c, (x) => this.d.arrPayload(x, (y) => y.localGet(KEYS)), (x) => x.localGet(I));
          c.localSet(KB);
          c.localGet(SEEN);
          c.localGet(KB);
          c.structGet(dynT, DYN_REF);
          emitFlatCast(c, this.k.deps.strType());
          c.call(this.ownIdx());
          c.i32Const(-1);
          c.i32Eq();
          c.ifVoid();
          c.localGet(OUT);
          c.localGet(KB);
          c.call(this.k.deps.arrPush());
          c.end();
        });
        // every own key of this level (both tables) is now seen
        this.d.objPayload(c, (x) => x.localGet(P));
        c.localSet(O);
        this.forI(c, I, (x) => { x.localGet(O); x.structGet(this.d.objT(), OBJ_LEN); }, () => {
          c.localGet(SEEN);
          c.localGet(O);
          c.structGet(this.d.objT(), OBJ_ENTRIES);
          c.localGet(I);
          c.arrayGet(entries);
          c.structGet(entryT, ENTRY_KEY);
          c.globalGet(this.d.undefinedGlobal());
          c.call(this.d.objAppend());
        });
        c.localGet(O);
        c.refTest(L);
        c.ifVoid();
        this.forI(c, I, (x) => { x.localGet(O); x.refCast(L); x.structGet(L, this.d.olProto() + 2); }, () => {
          c.localGet(SEEN);
          c.localGet(O);
          c.refCast(L);
          c.structGet(L, this.d.olProto() + 1);
          c.localGet(I);
          c.arrayGet(entries);
          c.structGet(entryT, ENTRY_KEY);
          c.globalGet(this.d.undefinedGlobal());
          c.call(this.d.objAppend());
        });
        c.end();
        c.localGet(P);
        c.call(this.protoBox());
        c.localSet(P);
        c.br(0);
        c.end();
        c.end();
        this.d.boxArr(c, (x) => x.localGet(OUT));
      },
    );
  }

  /* ── integrity levels ───────────────────────────────────────────────── */

  /** %w.om.integrity(o, level) → o: 0 preventExtensions, 1 seal, 2 freeze. */
  integrity(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    const objT = this.d.objT();
    const entries = this.d.entriesArrayType();
    const entryT = this.d.entryT();
    return this.fn(
      "integrity",
      [this.d.dynRef(), I32],
      [this.d.dynRef()],
      [this.d.objRef(), I32, this.d.entryRef(), I32, I32],
      (c) => {
      this.d.errMirrorGuard(c, (x) => x.localGet(0), null, "Object.freeze, seal or preventExtensions");
        const O = 2;
        const I = 3;
        const E = 4;
        const F = 5;
        const IDX = 6;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.OBJ);
        c.i32Ne();
        c.ifVoid();
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.ARR);
        c.i32Eq();
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Eq();
        c.i32Or();
        c.ifVoid();
        this.k.deps.fence(c, (x) => this.lit(x, "Object.freeze/seal/preventExtensions of a dynamic array or function is not supported yet"));
        c.end();
        c.localGet(0);
        c.return_();
        c.end();
        this.d.objPayload(c, (x) => x.localGet(0));
        c.localTee(O);
        c.refTest(L);
        c.i32Eqz();
        c.ifVoid();
        this.k.deps.fence(c, (x) => this.lit(x, "Object.freeze/seal/preventExtensions of this kind of dynamic object is not supported yet"));
        c.localGet(0);
        c.return_();
        c.end();
        c.localGet(O);
        c.refCast(L);
        c.localGet(O);
        c.refCast(L);
        c.structGet(L, this.d.olProto() + 3);
        c.i32Const(OF_NONEXT);
        c.i32Or();
        c.structSet(L, this.d.olProto() + 3);
        c.localGet(1);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(0);
        c.return_();
        c.end();
        const each = (pushN: (x: Code) => void, pushTable: (x: Code) => void, codeOf: (x: Code) => void): void => {
          this.forI(c, I, pushN, () => {
            pushTable(c);
            c.localGet(I);
            c.arrayGet(entries);
            c.localTee(E);
            this.entryFlags(c);
            c.i32Const(F_NC);
            c.i32Or();
            c.localGet(1);
            c.i32Const(2);
            c.i32Eq();
            c.localGet(E);
            c.structGet(entryT, ENTRY_VALUE);
            this.d.isAccessorCell(c);
            c.i32Eqz();
            c.i32And();
            c.ifResult(I32);
            c.i32Const(F_RO);
            c.else_();
            c.i32Const(0);
            c.end();
            c.i32Or();
            c.localSet(F);
            codeOf(c);
            c.localSet(IDX);
            this.setEntryAt(c, O, IDX, (x) => {
              x.localGet(E);
              x.structGet(entryT, ENTRY_KEY);
              x.localGet(E);
              x.structGet(entryT, ENTRY_VALUE);
              x.localGet(F);
              x.structNew(this.entryAT());
            });
          });
        };
        each((x) => { x.localGet(O); x.structGet(objT, OBJ_LEN); }, (x) => { x.localGet(O); x.structGet(objT, OBJ_ENTRIES); }, (x) => x.localGet(I));
        each(
          (x) => { x.localGet(O); x.refCast(L); x.structGet(L, this.d.olProto() + 2); },
          (x) => { x.localGet(O); x.refCast(L); x.structGet(L, this.d.olProto() + 1); },
          (x) => { x.i32Const(-2); x.localGet(I); x.i32Sub(); },
        );
        c.localGet(0);
      },
    );
  }

  /** %w.om.isIntegrity(o, level) → i32: 0 isExtensible, 1 isSealed, 2
   * isFrozen. */
  isIntegrity(): number {
    const dynT = this.d.dynT();
    const L = this.d.objLinkedT();
    const objT = this.d.objT();
    const entries = this.d.entriesArrayType();
    const entryT = this.d.entryT();
    return this.fn("isIntegrity", [this.d.dynRef(), I32], [I32], [this.d.objRef(), I32, this.d.entryRef()], (c) => {
      const O = 2;
      const I = 3;
      const E = 4;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.ifVoid();
      // primitives: not extensible, sealed and frozen; arrays/functions
      // here are never sealed or frozen
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.ARR);
      c.i32Eq();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.i32Or();
      c.ifResult(I32);
      c.localGet(1);
      c.i32Eqz();
      c.else_();
      c.localGet(1);
      c.i32Const(0);
      c.i32Ne();
      c.end();
      c.return_();
      c.end();
      this.d.objPayload(c, (x) => x.localGet(0));
      c.localTee(O);
      c.refTest(L);
      c.ifResult(I32);
      c.localGet(O);
      c.refCast(L);
      c.structGet(L, this.d.olProto() + 3);
      c.i32Const(OF_NONEXT);
      c.i32And();
      c.else_();
      c.i32Const(0);
      c.end();
      c.i32Eqz();
      c.ifVoid();
      // extensible
      c.localGet(1);
      c.i32Eqz();
      c.return_();
      c.end();
      c.localGet(1);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      const check = (pushN: (x: Code) => void, pushTable: (x: Code) => void): void => {
        this.forI(c, I, pushN, () => {
          pushTable(c);
          c.localGet(I);
          c.arrayGet(entries);
          c.localTee(E);
          this.entryFlags(c);
          c.i32Const(F_NC);
          c.i32And();
          c.i32Eqz();
          c.ifVoid();
          c.i32Const(0);
          c.return_();
          c.end();
          c.localGet(1);
          c.i32Const(2);
          c.i32Eq();
          c.ifVoid();
          c.localGet(E);
          c.structGet(entryT, ENTRY_VALUE);
          this.d.isAccessorCell(c);
          c.i32Eqz();
          c.localGet(E);
          this.entryFlags(c);
          c.i32Const(F_RO);
          c.i32And();
          c.i32Eqz();
          c.i32And();
          c.ifVoid();
          c.i32Const(0);
          c.return_();
          c.end();
          c.end();
        });
      };
      check((x) => { x.localGet(O); x.structGet(objT, OBJ_LEN); }, (x) => { x.localGet(O); x.structGet(objT, OBJ_ENTRIES); });
      check((x) => { x.localGet(O); x.refCast(L); x.structGet(L, this.d.olProto() + 2); }, (x) => { x.localGet(O); x.refCast(L); x.structGet(L, this.d.olProto() + 1); });
      c.i32Const(1);
    });
  }

  /* ── U4: dynamic constructors ───────────────────────────────────────── */

  /** %w.om.fnPrototype(F) → F.prototype, created on first use (a fresh
   * object with a non-enumerable `constructor` back-link, held as F's
   * non-enumerable, non-configurable own `prototype`); undefined for a
   * function that has none (an arrow, a method). */
  fnPrototype(): number {
    const dynT = this.d.dynT();
    return this.fn("fnPrototypeRead", [this.d.dynRef()], [this.d.dynRef()], [], (c) => {
      // S132's Function value: Node's Function.prototype is itself a
      // function (no model here)
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.ifVoid();
      this.d.fnPayload(c, (x) => x.localGet(0));
      c.structGet(this.d.fnT(), FN_SIG);
      c.i32Const(-4);
      c.i32Eq();
      c.ifVoid();
      this.k.deps.fence(c, (x) => this.lit(x, "Function.prototype read through the Function constructor taken as a value is not supported yet"));
      c.end();
      c.end();
      c.localGet(0);
      c.call(this.fnPrototypeRaw());
    });
  }

  /** fnPrototype without the S132 fence: construction's own read (the
   * Function value throws its EvalError before any prototype is used). */
  private fnPrototypeRaw(): number {
    const dynT = this.d.dynT();
    return this.fn(
      "fnPrototype",
      [this.d.dynRef()],
      [this.d.dynRef()],
      [this.k.fnPropsRef(), this.d.objRef(), this.d.entryRef(), this.d.objRef(), this.strRef()],
      (c) => {
        const FP = 1;
        const T = 2;
        const E = 3;
        const P = 4;
        const KEY = 5;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Ne();
        c.ifVoid();
        c.globalGet(this.d.undefinedGlobal());
        c.return_();
        c.end();
        this.d.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.fnT(), FN_CLOS);
        c.call(this.k.fnPropsEnsure());
        c.localSet(FP);
        this.lit(c, "prototype");
        c.localSet(KEY);
        // enumT (an assigned prototype) or its hidden table
        this.d.objPayload(c, (x) => { x.localGet(FP); x.structGet(this.k.fnPropsT(), 1); });
        c.localTee(T);
        c.localGet(KEY);
        c.call(this.ownEntry());
        c.localTee(E);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(E);
        c.structGet(this.d.entryT(), ENTRY_VALUE);
        c.return_();
        c.end();
        this.d.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.fnT(), FN_PROTO);
        c.i32Const(3);
        c.i32And();
        c.i32Const(2);
        c.i32Eq();
        c.ifVoid();
        c.globalGet(this.d.undefinedGlobal());
        c.return_();
        c.end();
        this.d.pushNewObj(c, false);
        c.localTee(P);
        c.refCast(this.d.objLinkedT());
        this.lit(c, "constructor");
        c.localGet(0);
        c.i32Const(F_HID);
        c.structNew(this.entryAT());
        c.call(this.hiddenPush());
        c.localGet(T);
        c.refCast(this.d.objLinkedT());
        c.localGet(KEY);
        this.d.boxObj(c, (x) => x.localGet(P));
        c.i32Const(F_HID | F_NC);
        c.localGet(T);
        c.structGet(this.d.objT(), OBJ_LEN);
        c.i32Const(MARK_SHIFT);
        c.i32Shl();
        c.i32Or();
        c.structNew(this.entryAT());
        c.call(this.hiddenPush());
        c.localGet(T);
        c.localGet(KEY);
        c.call(this.ownEntry());
        c.structGet(this.d.entryT(), ENTRY_VALUE);
      },
    );
  }

  /** %w.om.construct(F, args, what) → `new F(...args)`. */
  construct(): number {
    const dynT = this.d.dynT();
    return this.fn(
      "construct",
      [this.d.dynRef(), this.d.arrRef(), this.strRef()],
      [this.d.dynRef()],
      [this.d.dynRef(), this.d.dynRef(), this.d.dynRef(), I32],
      (c) => {
        const PR = 3;
        const O = 4;
        const R = 5;
        const RK = 6;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Ne();
        c.ifVoid();
        this.throwType(c, (x) => {
          x.localGet(2);
          this.lit(x, " is not a constructor");
          this.concat(x);
        });
        c.refNull(dynT);
        c.return_();
        c.end();
        // A bound function constructs its target with the bound arguments
        // first (its bound `this` is ignored, as in Node).
        this.d.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.fnT(), FN_SIG);
        c.i32Const(-5);
        c.i32Eq();
        c.ifVoid();
        this.d.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.fnT(), FN_CLOS);
        c.refCast(this.boundT());
        c.structGet(this.boundT(), 0);
        this.d.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.fnT(), FN_CLOS);
        c.refCast(this.boundT());
        c.structGet(this.boundT(), 2);
        c.localGet(1);
        c.call(this.concatArgs());
        c.localGet(2);
        c.call(this.construct());
        c.return_();
        c.end();
        // A builtin's stand-in (SIG -2/-3: a constructor read from a
        // dynamic value, String/Number/Boolean as function values): `new`
        // would build Node's wrapper object or class instance, which this
        // tier does not model.
        this.d.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.fnT(), FN_SIG);
        c.i32Const(-2);
        c.i32Eq();
        this.d.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.d.fnT(), FN_SIG);
        c.i32Const(-3);
        c.i32Eq();
        c.i32Or();
        c.ifVoid();
        this.k.deps.fence(c, (x) => this.lit(x, "constructing a builtin read as a function value (`new String(...)` builds a wrapper object) is not supported yet"));
        c.refNull(dynT);
        c.return_();
        c.end();
        c.localGet(0);
        c.call(this.fnPrototypeRaw());
        c.localTee(PR);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.ifVoid();
        this.throwType(c, (x) => {
          x.localGet(2);
          this.lit(x, " is not a constructor");
          this.concat(x);
        });
        c.refNull(dynT);
        c.return_();
        c.end();
        this.d.boxObj(c, (x) => this.d.pushNewObj(x, false));
        c.localSet(O);
        c.localGet(PR);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.OBJ);
        c.i32Eq();
        c.ifVoid();
        c.localGet(O);
        c.localGet(PR);
        c.call(this.setProto());
        c.drop();
        c.end();
        c.localGet(O);
        c.call(this.d.thisPush());
        c.localGet(0);
        c.localGet(1);
        c.localGet(2);
        c.call(this.d.callFn());
        c.localSet(R);
        c.call(this.d.thisPop());
        c.localGet(R);
        c.refIsNull();
        c.ifVoid();
        c.refNull(dynT);
        c.return_();
        c.end();
        c.localGet(R);
        c.structGet(dynT, DYN_KIND);
        c.localTee(RK);
        c.i32Const(DK.OBJ);
        c.i32Eq();
        c.localGet(RK);
        c.i32Const(DK.ARR);
        c.i32Eq();
        c.i32Or();
        c.localGet(RK);
        c.i32Const(DK.FUNC);
        c.i32Eq();
        c.i32Or();
        c.ifResult(this.d.dynRef());
        c.localGet(R);
        c.else_();
        c.localGet(O);
        c.end();
      },
    );
  }

  /** %w.om.instanceOf(v, F) → i32, or 0 with a TypeError pending. */
  instanceOf(): number {
    const dynT = this.d.dynT();
    return this.fn("instanceOf", [this.d.dynRef(), this.d.dynRef()], [I32], [this.d.dynRef(), this.d.dynRef(), I32, this.d.dynRef(), this.d.arrRef()], (c) => {
      const PR = 2;
      const W = 3;
      const G = 4;
      const H = 5;
      const A = 6;
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.i32And();
      c.ifVoid();
      this.throwType(c, (x) => this.lit(x, "Right-hand side of 'instanceof' is not an object"));
      c.i32Const(0);
      c.return_();
      c.end();
      // A defined Symbol.hasInstance answers first (its truthiness), on any
      // object; only then must the right side be callable.
      c.localGet(1);
      this.lit(c, SYM_HAS_INSTANCE);
      c.i32Const(0);
      c.call(this.d.keyGet());
      c.localTee(H);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(H);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.ifVoid();
      this.d.pushNewArr(c);
      c.localSet(A);
      c.localGet(A);
      c.localGet(0);
      c.call(this.k.deps.arrPush());
      c.localGet(1);
      c.call(this.d.thisPush());
      c.localGet(H);
      c.localGet(A);
      this.lit(c, "[Symbol.hasInstance]");
      c.call(this.d.callFn());
      c.localSet(H);
      c.call(this.d.thisPop());
      c.localGet(H);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(H);
      c.call(this.d.truthy());
      c.return_();
      c.end();
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Ne();
      c.ifVoid();
      this.throwType(c, (x) => this.lit(x, "Right-hand side of 'instanceof' is not callable"));
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(1);
      c.call(this.fnPrototype());
      c.localTee(PR);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.ifVoid();
      this.throwType(c, (x) => this.lit(x, "Function has non-object prototype 'undefined' in instanceof check"));
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.protoBox());
      c.localSet(W);
      c.block();
      c.loop();
      c.localGet(W);
      c.refIsNull();
      c.brIf(1);
      c.localGet(W);
      c.structGet(dynT, DYN_REF);
      c.localGet(PR);
      c.structGet(dynT, DYN_REF);
      c.refEq();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(G);
      c.i32Const(1);
      c.i32Add();
      c.localTee(G);
      c.i32Const(100000);
      c.i32GtU();
      c.brIf(1);
      c.localGet(W);
      c.call(this.protoBox());
      c.localSet(W);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
      void DYN_NUM;
      void DYN_KIND;
    });
  }

  /** %w.om.concatArgs(a, b) → a fresh vector of a's elements then b's. */
  private concatArgs(): number {
    return this.fn("concatArgs", [this.d.arrRef(), this.d.arrRef()], [this.d.arrRef()], [this.d.arrRef(), I32], (c) => {
      const V = 2;
      const I = 3;
      this.d.pushNewArr(c);
      c.localSet(V);
      for (const src of [0, 1]) {
        this.forI(c, I, (x) => this.d.arrLen(x, (y) => y.localGet(src)), () => {
          c.localGet(V);
          this.d.arrAt(c, (x) => x.localGet(src), (x) => x.localGet(I));
          c.call(this.k.deps.arrPush());
        });
      }
      c.localGet(V);
    });
  }

  private boundType: number | null = null;

  private boundT(): number {
    this.boundType ??= this.k.mb.openStructType("om:bound", [
      { storage: this.d.dynRef(), mutable: false },
      { storage: this.d.dynRef(), mutable: false },
      { storage: this.d.arrRef(), mutable: false },
    ]);
    return this.boundType;
  }

  /** %w.om.bindFn(F, thisArg, boundArgs vec) → `F.bind(thisArg, ...args)`:
   * a FUNC whose calls run F with `this` = thisArg and the bound
   * arguments first; its name is "bound " + F's, its length F's less the
   * bound count. */
  bindFn(): number {
    const dynT = this.d.dynT();
    const fnT = this.d.fnT();
    const B = this.boundT();
    const thunk = this.fn("boundThunk", [{ kind: "ref", nullable: true, typeIndex: EQ_HEAP }, this.d.arrRef()], [this.d.dynRef()], [{ kind: "ref", nullable: true, typeIndex: B }, this.d.arrRef(), I32, this.d.dynRef()], (c) => {
      const BC = 2;
      const V = 3;
      const I = 4;
      const R = 5;
      c.localGet(0);
      c.refCast(B);
      c.localSet(BC);
      this.d.pushNewArr(c);
      c.localSet(V);
      this.forI(c, I, (x) => this.d.arrLen(x, (y) => { y.localGet(BC); y.structGet(B, 2); }), () => {
        c.localGet(V);
        this.d.arrAt(c, (x) => { x.localGet(BC); x.structGet(B, 2); }, (x) => x.localGet(I));
        c.call(this.k.deps.arrPush());
      });
      this.forI(c, I, (x) => this.d.arrLen(x, (y) => y.localGet(1)), () => {
        c.localGet(V);
        this.d.arrAt(c, (x) => x.localGet(1), (x) => x.localGet(I));
        c.call(this.k.deps.arrPush());
      });
      c.localGet(BC);
      c.structGet(B, 1);
      c.call(this.d.thisPush());
      c.localGet(BC);
      c.structGet(B, 0);
      c.localGet(V);
      this.lit(c, "bound function");
      c.call(this.d.callFn());
      c.localSet(R);
      c.call(this.d.thisPop());
      c.localGet(R);
    });
    this.k.mb.declareFuncRef(thunk);
    return this.fn("bindFn", [this.d.dynRef(), this.d.dynRef(), this.d.arrRef()], [this.d.dynRef()], [I32, this.strRef()], (c) => {
      const AR = 3;
      const NM = 4;
      this.d.fnPayload(c, (x) => x.localGet(0));
      c.structGet(fnT, FN_ARITY);
      this.d.arrLen(c, (x) => x.localGet(2));
      c.i32Sub();
      c.localTee(AR);
      c.i32Const(0);
      c.localGet(AR);
      c.i32Const(0);
      c.i32GtS();
      c.select();
      c.localSet(AR);
      this.lit(c, "bound ");
      this.d.fnPayload(c, (x) => x.localGet(0));
      c.structGet(fnT, FN_NAME);
      c.localTee(NM);
      c.refIsNull();
      c.ifResult(this.strRef());
      this.lit(c, "");
      c.else_();
      c.localGet(NM);
      c.end();
      this.concat(c);
      c.localSet(NM);
      this.d.boxFunc(c, (x) => {
        x.localGet(0);
        x.localGet(1);
        x.localGet(2);
        x.structNew(B);
        x.refFunc(thunk);
        x.i32Const(-5);
        x.localGet(NM);
        x.localGet(AR);
        x.refNull(this.k.deps.strType());
        x.i32Const(2);
        x.structNew(fnT);
      });
      void dynT;
    });
  }
}
