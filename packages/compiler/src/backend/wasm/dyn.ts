/* The checked-dynamic value (`unknown`) over WasmGC: ONE struct with an
 * explicit KIND TAG, plus the interned helpers that dispatch on it. The
 * increment's design doc, distilled — read this before changing layout.
 *
 * THE STRUCT. `mapType(dyn)` is `(ref null $dyn)`, and `$dyn` is
 * `{ kind: i32, num: f64, ref: (ref null eq) }` with every field
 * IMMUTABLE: a dyn value is construction-complete, so the box can be
 * interned, shared, and compared without a single write after
 * `struct.new`. That is the exception cell's shape (a tag plus one
 * numeric and one reference slot), which the increment-10 work already
 * proved carries every payload this tier has. The C runtime's ScrDyn is
 * the same idea with a refcount head the GC makes unnecessary.
 *
 * The reference slot is `eq`, not `any`, and that is the one deliberate
 * departure from the cell's spelling: `scr_dyn_strict_eq` compares
 * PROMISE payloads (and, later, every composite payload) by pointer, and
 * `ref.eq` only accepts eq-comparable operands. Every payload this
 * representation can ever hold — the string array, a promise struct, a
 * future entry-table struct — is a GC object and therefore eq; the only
 * things `any` admits that `eq` does not are host externrefs, which no
 * payload is. So `eq` costs nothing and buys identity comparison without
 * a cast at every site that needs it.
 *
 * THE KIND IDS ARE A CROSS-LANE CONTRACT. They are ScrDynKind's numeric
 * values (scr_runtime.h), the same table `backend/llvm/dyn.ts` hardcodes
 * as `DK` and the C runtime switches on. NEVER renumber them: a value
 * built by one lane's rules and read by another's must agree, and the
 * numbers are the agreement.
 *
 * PAYLOAD CONVENTIONS. NUM keeps its double in `num`. BOOL keeps 0 or 1
 * there too (so strict equality and truthiness read one slot for both
 * scalar kinds, exactly as the C union does). STR puts the tier's string
 * — the raw `(array (mut i16))` of UTF-16 code units, S002 — directly in
 * `ref`. NULL and UNDEF carry no payload at all.
 *
 * COMPOSITE PAYLOADS RIDE `ref` AS TYPED STRUCTS, and FLAGS RIDE
 * PAYLOADS — never extra kind ids. C's ScrDyn carries `null_proto` and
 * `buffer` as bits beside the kind; here OBJ's payload struct carries the
 * null-prototype flag and BYTES' will carry the Buffer flag, because a
 * new kind id would break the cross-lane numbering above and would make
 * every kind compare in the tier wrong by one arm.
 *
 * ARR's payload is the tier's ORDINARY VECTOR (arrays.ts) over a
 * `(ref null $dyn)` element — not a private array type. Any two vectors
 * over the same element are one wasm type because the module builder
 * interns struct/array types BY SHAPE (module.ts), so nothing here can
 * drift from what a static vector of dyn boxes would be — and the
 * growth, push and slice helpers come free. (A static `dyn[]` never
 * actually exists: the frontend collapses `unknown[]` to a bare dyn.)
 *
 * OBJ's payload is a flat entry table walked by LINEAR SCAN, which is
 * what the C runtime does: `scr_dyn_obj_get` is a memcmp walk, and the
 * dyn path has no hashmap and no shape cache. Porting one would be a
 * different data structure answering a different question about
 * iteration order, and iteration order here is OBSERVABLE (Object.keys,
 * for-in, JSON). `scr_dyn_obj_put`'s rule comes with it: a repeated key
 * replaces the VALUE in place and the surviving entry keeps its ORIGINAL
 * key — later duplicates win, insertion order is the first insertion's.
 *
 * THE TYPE-DIRECTED WALKERS LIVE AT THE EMITTER, not here. Converting a
 * record into an OBJ or validating an ARR back into a typed vector needs
 * record structs, vector types and union tags — emitter knowledge. This
 * file owns the representation and the primitives over it; emitter.ts's
 * `dynFromHelper` / `dynCheckHelper` / `dynMatchHelper` own the type
 * direction, interned per typeKey exactly as the C emitter interns
 * sc_td_N / sc_dc_N / sc_dm_N.
 *
 * INTERNED CONSTANTS. `undefined` is THE immortal undefined — one
 * module-level constant global, the direct analog of the C runtime's
 * `scr_dyn_undefined()` singleton (rc == SIZE_MAX, allocated never).
 * `null`, `true` and `false` intern beside it for the same reason it is
 * free to do so: `scr_dyn_strict_eq` answers for scalar kinds BY VALUE,
 * so sharing one box among every `true` is unobservable. `struct.new` is
 * a constant expression in WasmGC (the interned union unit-arm trick,
 * proven in increment 7), so all four are const-initialized globals with
 * no runtime construction anywhere.
 *
 * DYNCHECK'S FAILURE PATH. `scr_dyn_check_fail` renders
 * "expected <want> at <path>, got <kind>" and throws a catchable
 * TypeError. `want` is a compile-time string (the C emitter's `dynDesc`,
 * ported at the emitter); the PATH is a runtime linked list, because a
 * nested walker has to name where in the tree it failed. C stack-
 * allocates those nodes and LLVM used entry allocas; the GC heap is our
 * answer — `$dynPath` is a self-referential struct and the nodes are
 * ordinary garbage. A null path renders as the root `$`, which is what
 * every scalar call site passes.
 *
 * WHAT IS NOT HERE. HANDLE and JSVAL values are unconstructible on this
 * tier (they enter only through libCalls the wasm backend refuses), so
 * the arms that would read their payloads are `unreachable` rather than
 * guesses. FUNC boxes arrive with dynCall and BYTES with the typed-array
 * work; until then their arms say so. The dyn tree's ERROR encoding — an
 * OBJ carrying the reserved "%error" key — has no producer until
 * caughtToDyn lands, and `toStr` TRAPS on one rather than answering
 * "[object Object]": a wrong answer there would be silent, and the trap
 * is what makes the missing arm impossible to forget. */
import type { VecInfo } from "./arrays.js";
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

/** ScrDynKind's numeric values (scr_runtime.h), shared verbatim with
 * `backend/llvm/dyn.ts`'s `DK` and the C runtime. A CROSS-LANE CONTRACT —
 * see the header: never renumber, never insert. */
export const DK = {
  NULL: 0,
  BOOL: 1,
  NUM: 2,
  STR: 3,
  ARR: 4,
  OBJ: 5,
  UNDEF: 6,
  BYTES: 7,
  FUNC: 8,
  HANDLE: 9,
  PROMISE: 10,
  JSVAL: 11,
} as const;

/** `$dyn`'s field indices. */
export const DYN_KIND = 0;
export const DYN_NUM = 1;
export const DYN_REF = 2;

/** `$dynPath`'s field indices: the parent link, the object key (null on
 * an ARRAY step), and the array index (meaningful only when key is null).
 * C's ScrDynPath exactly. */
export const PATH_PARENT = 0;
export const PATH_KEY = 1;
export const PATH_INDEX = 2;

/** `$dynEntry`'s field indices — one OBJ member. The KEY is immutable
 * (a replaced member keeps its original key string, C's rule) and the
 * VALUE is mutable, which is exactly what `scr_dyn_obj_put`'s in-place
 * replacement needs. */
export const ENTRY_KEY = 0;
export const ENTRY_VALUE = 1;

/** `$dynObj`'s field indices. `nullProto` is the flag C carries beside the
 * kind — it rides the PAYLOAD here (the header's rule: flags never become
 * kind ids) and is false everywhere until `Object.create(null)` lands. */
export const OBJ_LEN = 0;
export const OBJ_ENTRIES = 1;
export const OBJ_NULL_PROTO = 2;

/** `eq`'s s33 encoding — the payload slot's heap type. Every GC object is
 * a subtype, and unlike `any` it admits `ref.eq` (see the header). */
const EQ_HEAP = -0x13;

/** arrays.ts's vector field indices, repeated here because the ARR
 * payload reads them directly (its loops carry their own bounds, so the
 * checked vec helpers would be dead work). */
const VEC_LEN = 0;
const VEC_BUF = 1;

export interface DynDeps {
  /** The tier's string valtype — `(ref null (array (mut i16)))`. */
  strRef: () => ValType;
  /** The string ARRAY type index (payload casts and `array.len`). */
  strType: () => number;
  /** %w.strEq — raw-unit UTF-16 content equality, which IS JS `===` on
   * strings (S002's storage makes them the same question). */
  strEq: () => number;
  /** %w.concat — the runtime message builder. */
  concat: () => number;
  /** %w.f64ToStr — the path renderer's index digits. */
  f64ToStr: () => number;
  /** Push an interned string literal onto `c`'s stack. */
  lit: (c: Code, s: string) => void;
  /** Fill the exception cell with a fresh TypeError whose message is
   * built AT RUNTIME by `pushMessage`. The CALLER unwinds (check_fail is
   * an ordinary void helper; dynCheck is may-throw-seeded, so the pending
   * checks around it come free). */
  throwTypeError: (c: Code, pushMessage: (c: Code) => void) => void;
  /** The ARR payload's vector (arrays.ts). Injected rather than built
   * here because vector types are the EMITTER's to intern — `vecKeyFor`
   * already answers the distinct key "dyn" for a dyn element, so the dyn
   * array and a (hypothetical) static `dyn[]` are one type by
   * construction rather than by coincidence. */
  arrVec: () => VecInfo;
  /** %w.vec.push1:dyn — the unchecked append the builders use. */
  arrPush: () => number;
  /** %w.vec.newLen:dyn — a fresh vector of n ABSENT slots; every caller
   * here passes 0 and fills by push, which is `scr_dyn_new_arr`. */
  arrNewLen: () => number;
  /** %w.str.cpAt — the string iterator's step (a paired high surrogate
   * brings its low half along). The ITERATION surfaces walk code POINTS,
   * unlike the keyed read's code units. */
  strCpAt: () => number;
}

export class DynBuilder {
  private dynType: number | null = null;
  private pathType: number | null = null;
  private entryType: number | null = null;
  private objType: number | null = null;
  private objEntriesType: number | null = null;
  private readonly consts = new Map<string, number>();
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: DynDeps,
  ) {}

  /** `$dyn` — { kind, num, ref }, all const. Keyed by MEANING rather
   * than interned by shape: identity here is a representation decision,
   * not a coincidence of field types, and a later `ref.cast` must be able
   * to name this type alone. */
  dynT(): number {
    this.dynType ??= this.mb.openStructType("dyn", [
      { storage: I32, mutable: false },
      { storage: F64, mutable: false },
      { storage: { kind: "ref", nullable: true, typeIndex: EQ_HEAP }, mutable: false },
    ]);
    return this.dynType;
  }

  dynRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.dynT() };
  }

  /** `$dynPath` — the heap path node C stack-allocates. Self-referential,
   * so it is its own singleton recursive group. */
  pathT(): number {
    if (this.pathType !== null) return this.pathType;
    // selfStructType's contract: nothing inside `make` may intern a type,
    // so both operands resolve first.
    const strRef = this.deps.strRef();
    this.pathType = this.mb.selfStructType("dyn:path", (self) => [
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: false },
      { storage: strRef, mutable: false },
      { storage: I32, mutable: false },
    ]);
    return this.pathType;
  }

  pathRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.pathT() };
  }

  /** Build a `$dynPath` node the caller's operands describe: an OBJECT
   * step (`key` non-null, index ignored) or an ARRAY step (`key` null).
   * C stack-allocates these one per frame; ours are ordinary garbage. */
  pushPathKey(c: Code, pushParent: (c: Code) => void, pushKey: (c: Code) => void): void {
    pushParent(c);
    pushKey(c);
    c.i32Const(0);
    c.structNew(this.pathT());
  }

  pushPathIndex(c: Code, pushParent: (c: Code) => void, pushIndex: (c: Code) => void): void {
    pushParent(c);
    c.refNull(this.deps.strType());
    pushIndex(c);
    c.structNew(this.pathT());
  }

  /* ── the ARR payload ────────────────────────────────────────────────── */

  arrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.deps.arrVec().struct };
  }

  /** Wrap a dyn VECTOR the caller pushes into an ARR box. */
  boxArr(c: Code, pushVec: (c: Code) => void): void {
    c.i32Const(DK.ARR);
    c.f64Const(0);
    pushVec(c);
    c.structNew(this.dynT());
  }

  /** From a `$dyn` the caller pushes, its ARR payload vector. The kind is
   * the caller's to establish first (C reads `d->v.arr` the same way). */
  arrPayload(c: Code, pushDyn: (c: Code) => void): void {
    pushDyn(c);
    c.structGet(this.dynT(), DYN_REF);
    c.refCast(this.deps.arrVec().struct);
  }

  /** The payload vector's length, as an i32. */
  arrLen(c: Code, pushVec: (c: Code) => void): void {
    pushVec(c);
    c.structGet(this.deps.arrVec().struct, VEC_LEN);
  }

  /** Element `i` — the UNCHECKED read, C's `d->v.arr.items[i]`. Walker
   * loops carry the bound themselves, so the vec helper's index check
   * would be dead work (and its trap the wrong answer). */
  arrAt(c: Code, pushVec: (c: Code) => void, pushIndex: (c: Code) => void): void {
    const v = this.deps.arrVec();
    pushVec(c);
    c.structGet(v.struct, VEC_BUF);
    pushIndex(c);
    c.arrayGet(v.bufType);
  }

  /** Element `i` = a value — the UNCHECKED write, C's
   * `d->v.arr.items[i] = ...`. The vector is pushed FRESH by the caller
   * (a preceding pad loop may have grown and REPLACED the buffer, so the
   * buffer read has to happen after it, not before). */
  arrSet(c: Code, pushVec: (c: Code) => void, pushIndex: (c: Code) => void, pushValue: (c: Code) => void): void {
    const v = this.deps.arrVec();
    pushVec(c);
    c.structGet(v.struct, VEC_BUF);
    pushIndex(c);
    pushValue(c);
    c.arraySet(v.bufType);
  }

  /** A fresh empty dyn VECTOR — `scr_dyn_new_arr`'s payload. */
  pushNewArr(c: Code): void {
    c.f64Const(0);
    c.call(this.deps.arrNewLen());
  }

  /* ── the OBJ payload ────────────────────────────────────────────────── */

  /** One OBJ member: `{ key, value }` — the key immutable, the value not
   * (obj_put replaces in place). */
  entryT(): number {
    this.entryType ??= this.mb.openStructType("dyn:entry", [
      { storage: this.deps.strRef(), mutable: false },
      { storage: this.dynRef(), mutable: true },
    ]);
    return this.entryType;
  }

  entryRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.entryT() };
  }

  /** The OBJ payload: a flat entry table with a LINEAR SCAN, which is
   * exactly what the C runtime does (`scr_dyn_obj_get` is a memcmp walk —
   * the dyn path has no hashmap and no shape cache, and porting one here
   * would be a different data structure answering different questions
   * about iteration order). */
  objT(): number {
    if (this.objType !== null) return this.objType;
    const entries = this.mb.arrayType(this.entryRef(), true);
    this.objEntriesType = entries;
    this.objType = this.mb.openStructType("dyn:obj", [
      { storage: I32, mutable: true },
      { storage: { kind: "ref", nullable: true, typeIndex: entries }, mutable: true },
      { storage: I32, mutable: false },
    ]);
    return this.objType;
  }

  objRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.objT() };
  }

  private entriesArrayType(): number {
    this.objT();
    if (this.objEntriesType === null) throw new Error("wasm dyn builder: entries array type unresolved");
    return this.objEntriesType;
  }

  /** A fresh empty OBJ payload (C's `scr_dyn_new_obj` /
   * `scr_dyn_new_obj_null_proto`): len 0, no buffer yet — obj_put
   * allocates the first one, matching C's `cap ? cap * 2 : 4`. */
  pushNewObj(c: Code, nullProto: boolean): void {
    c.i32Const(0);
    c.refNull(this.entriesArrayType());
    c.i32Const(nullProto ? 1 : 0);
    c.structNew(this.objT());
  }

  /** Wrap an OBJ payload the caller pushes into an OBJ box. */
  boxObj(c: Code, pushObj: (c: Code) => void): void {
    c.i32Const(DK.OBJ);
    c.f64Const(0);
    pushObj(c);
    c.structNew(this.dynT());
  }

  /** From a `$dyn` the caller pushes, its OBJ payload. */
  objPayload(c: Code, pushDyn: (c: Code) => void): void {
    pushDyn(c);
    c.structGet(this.dynT(), DYN_REF);
    c.refCast(this.objT());
  }

  /** %w.vec.push1:dyn — the ARR builders' append. */
  arrPush(): number {
    return this.deps.arrPush();
  }

  /** %w.dyn.objGet(obj, key) → the member, or NULL when absent — the
   * linear scan of `scr_dyn_obj_get`. A null answer is what the record
   * walkers test for (C's `if (!m)`), and kindName renders it
   * "undefined", so a missing member reports exactly like a present
   * undefined one. */
  objGet(): number {
    return this.cached("objGet", [this.objRef(), this.deps.strRef()], [this.dynRef()], (idx) => {
      const objT = this.objT();
      const entries = this.entriesArrayType();
      const entryT = this.entryT();
      const c = new Code();
      const I = 2;
      const N = 3;
      const E = 4;
      c.localGet(0);
      c.structGet(objT, OBJ_LEN);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(I);
      c.arrayGet(entries);
      c.localTee(E);
      c.structGet(entryT, ENTRY_KEY);
      c.localGet(1);
      c.call(this.deps.strEq());
      c.ifVoid();
      c.localGet(E);
      c.structGet(entryT, ENTRY_VALUE);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.refNull(this.dynT());
      this.mb.setBody(idx, [I32, I32, this.entryRef()], c.bytes());
    });
  }

  /** %w.dyn.objPut(obj, key, value) — `scr_dyn_obj_put` ported, LATER
   * DUPLICATES WIN: an existing key has its VALUE replaced in place and
   * the surviving entry keeps its ORIGINAL key string (C frees the new
   * key buffer and leaves `e->key` alone; we simply never store the new
   * one). Otherwise the entry appends, growing `cap ? cap * 2 : 4`. */
  objPut(): number {
    return this.cached("objPut", [this.objRef(), this.deps.strRef(), this.dynRef()], [], (idx) => {
      const objT = this.objT();
      const entries = this.entriesArrayType();
      const entryT = this.entryT();
      const c = new Code();
      const I = 3;
      const N = 4;
      const E = 5;
      const NB = 6;
      c.localGet(0);
      c.structGet(objT, OBJ_LEN);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(I);
      c.arrayGet(entries);
      c.localTee(E);
      c.structGet(entryT, ENTRY_KEY);
      c.localGet(1);
      c.call(this.deps.strEq());
      c.ifVoid();
      // Replace the VALUE; the entry keeps the key it was created with.
      c.localGet(E);
      c.localGet(2);
      c.structSet(entryT, ENTRY_VALUE);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // Append. Capacity is the buffer's length; C starts at 4 and
      // doubles, and a null buffer is the "no capacity yet" state.
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.refIsNull();
      c.ifResult(I32);
      c.i32Const(1); // no buffer yet — C's `cap == 0`
      c.else_();
      c.localGet(N);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.arrayLen();
      c.i32GeU();
      c.end();
      c.ifVoid();
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.refIsNull();
      c.ifResult(I32);
      c.i32Const(4);
      c.else_();
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.arrayLen();
      c.i32Const(2);
      c.i32Mul();
      c.end();
      c.arrayNewDefault(entries);
      c.localSet(NB);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(NB);
      c.i32Const(0);
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(entries, entries);
      c.end();
      c.localGet(0);
      c.localGet(NB);
      c.structSet(objT, OBJ_ENTRIES);
      c.end();
      c.localGet(0);
      c.structGet(objT, OBJ_ENTRIES);
      c.localGet(N);
      c.localGet(1);
      c.localGet(2);
      c.structNew(entryT);
      c.arraySet(entries);
      c.localGet(0);
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.structSet(objT, OBJ_LEN);
      this.mb.setBody(
        idx,
        [I32, I32, this.entryRef(), { kind: "ref", nullable: true, typeIndex: entries }],
        c.bytes(),
      );
    });
  }

  /* ── the interned constants ─────────────────────────────────────────── */

  /** THE immortal `undefined` — one const-initialized global, the C
   * runtime's `scr_dyn_undefined()` singleton. */
  undefinedGlobal(): number {
    return this.constGlobal(DK.UNDEF, 0);
  }

  nullGlobal(): number {
    return this.constGlobal(DK.NULL, 0);
  }

  /** `true`/`false` — scalar identity is by VALUE (scr_dyn_strict_eq), so
   * one shared box per value is unobservable. */
  boolGlobal(value: boolean): number {
    return this.constGlobal(DK.BOOL, value ? 1 : 0);
  }

  private constGlobal(kind: number, num: number): number {
    const key = `${kind}:${num}`;
    const existing = this.consts.get(key);
    if (existing !== undefined) return existing;
    const dynT = this.dynT();
    const index = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: dynT }, false, (w) => {
      w.u8(0x41); // i32.const kind
      w.sleb(kind);
      w.u8(0x44); // f64.const num
      w.f64(num);
      w.u8(0xd0); // ref.null eq
      w.sleb(EQ_HEAP);
      w.u8(0xfb); // struct.new $dyn
      w.uleb(0x00);
      w.uleb(dynT);
    });
    this.consts.set(key, index);
    return index;
  }

  /* ── construction (the scalar arms of the C emitter's to-dyn walkers) ── */

  /** Box an f64 the caller pushes: `scr_dyn_new_num`. */
  boxNum(c: Code, pushValue: (c: Code) => void): void {
    c.i32Const(DK.NUM);
    pushValue(c);
    c.refNull(EQ_HEAP);
    c.structNew(this.dynT());
  }

  /** Box an i32 boolean the caller pushes: `scr_dyn_new_bool`. The flag
   * widens into `num` — see the header's payload conventions. */
  boxBool(c: Code, pushValue: (c: Code) => void): void {
    c.i32Const(DK.BOOL);
    pushValue(c);
    c.f64ConvertI32U();
    c.refNull(EQ_HEAP);
    c.structNew(this.dynT());
  }

  /** Box a string the caller pushes: `scr_dyn_new_str`. The tier's string
   * IS the payload — no copy, no wrapper (they are immutable). */
  boxStr(c: Code, pushValue: (c: Code) => void): void {
    c.i32Const(DK.STR);
    c.f64Const(0);
    pushValue(c);
    c.structNew(this.dynT());
  }

  /** Declare-then-build, interned by NAME: the index is published before
   * the body runs, so a helper may call itself (pathRender recurses) and
   * may pull in the others without re-entering here. */
  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.dyn.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /** Emits `if (kind == k) { arm(); return }` — the shape every helper
   * below is a list of, and C's switch arms one for one. */
  private arm(c: Code, kindLocal: number, kinds: number[], arm: () => void): void {
    kinds.forEach((k, i) => {
      c.localGet(kindLocal);
      c.i32Const(k);
      c.i32Eq();
      if (i > 0) c.i32Or();
    });
    c.ifVoid();
    arm();
    c.return_();
    c.end();
  }

  /* ── the dispatch helpers ───────────────────────────────────────────── */

  /** %w.dyn.strictEq(a, b) → i32 — JS `===` over two dyn values, exactly
   * `scr_dyn_strict_eq`: differing kinds never equal; the units equal by
   * kind alone; BOOL and NUM compare their shared `num` slot with `f64.eq`
   * (which hands us NaN !== NaN and +0 === -0 for free, both JS-exact);
   * strings compare CONTENT; PROMISE compares the PAYLOAD because a
   * promise crossing the boundary twice may be reboxed and is still one
   * JS value; and ARR/OBJ/BYTES — C's `default` arm and nothing else —
   * compare the BOXES, which is C's stance for the kinds it never reboxes.
   * The three kinds with payload-identity arms in C (FUNC, HANDLE, JSVAL)
   * are unconstructible here and trap rather than borrow that answer.
   *
   * Its caller is `dynScalarEq` with BOTH operands dyn. The FUNC arm's
   * trap stays reachable-in-principle from there, which is safe only
   * because no FUNC box exists yet: `f === f` cannot arrive until stage 4
   * builds one, and that stage owes this arm C's compare before it does
   * (see the note on the arm itself). */
  strictEq(): number {
    return this.cached("strictEq", [this.dynRef(), this.dynRef()], [I32], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 2;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localTee(K);
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      this.arm(c, K, [DK.UNDEF, DK.NULL], () => c.i32Const(1));
      this.arm(c, K, [DK.BOOL, DK.NUM], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.localGet(1);
        c.structGet(dynT, DYN_NUM);
        c.f64Eq();
      });
      this.arm(c, K, [DK.STR], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.localGet(1);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.call(this.deps.strEq());
      });
      // FUNC: identity is the boxed CLOSURE, never the box — one closure
      // crossing the boundary twice is still one JS function value. There
      // is nothing to compare until FUNC boxes exist (stage 4), and an
      // unconstructible kind reaching here is a bug, not a false answer.
      //
      // STAGE 4 MUST REPLACE THIS ARM with C's compare (scr_json.c:2292 —
      // `a == b || a->v.fn.clo == b->v.fn.clo`, i.e. the payload's closure
      // slot). Wiring a caller to strictEq while this still traps would
      // turn `f === f` on a boxed function into an abort.
      this.arm(c, K, [DK.FUNC], () => c.unreachable());
      this.arm(c, K, [DK.PROMISE], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.localGet(1);
        c.structGet(dynT, DYN_REF);
        c.refEq();
      });
      // HANDLE and JSVAL have their OWN arms in C and do NOT fall into the
      // default: a handle compares its payload (tag + pointer,
      // scr_json.c:2297) and an island value routes to the ENGINE's
      // strict equality (scr_json.c:2304). Neither is constructible on
      // this tier, so neither may borrow the box-identity answer below —
      // that would be a wrong answer rather than a loud one.
      this.arm(c, K, [DK.HANDLE, DK.JSVAL], () => c.unreachable());
      // ARR/OBJ/BYTES — and ONLY those three: C's `default: return a == b`
      // (scr_json.c:2310). Node identity is the dyn tree's object identity
      // because those kinds are never reboxed.
      c.localGet(0);
      c.localGet(1);
      c.refEq();
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** %w.dyn.truthy(d) → i32 — ToBoolean over a dyn value, `scr_dyn_truthy`
   * ported: bools by value, numbers falsy exactly for 0/-0/NaN, strings
   * falsy exactly when empty, every object-shaped kind true, the units
   * false. */
  truthy(): number {
    return this.cached("truthy", [this.dynRef()], [I32], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 1;
      const X = 2;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.BOOL], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.f64Const(0);
        c.f64Ne();
      });
      this.arm(c, K, [DK.NUM], () => {
        // (x == x) & (x != 0) — false for NaN, 0 and -0.
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.localTee(X);
        c.localGet(X);
        c.f64Eq();
        c.localGet(X);
        c.f64Const(0);
        c.f64Ne();
        c.i32And();
      });
      this.arm(c, K, [DK.STR], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.arrayLen();
        c.i32Const(0);
        c.i32Ne();
      });
      this.arm(c, K, [DK.UNDEF, DK.NULL], () => c.i32Const(0));
      // An island value's ToBoolean is the ENGINE's answer (the bigint 0n
      // edge); nothing constructs one on this tier.
      this.arm(c, K, [DK.JSVAL], () => c.unreachable());
      c.i32Const(1); // OBJ, ARR, BYTES, FUNC, HANDLE, PROMISE
      this.mb.setBody(idx, [I32, F64], c.bytes());
    });
  }

  /** %w.dyn.typeof(d) → the JS `typeof` answer, `scr_dyn_typeof` ported.
   * `null` answers "object" — JS's oldest wart, preserved. The trailing
   * "undefined" is C's own default arm, which its exhaustive switch makes
   * dead; it is transcribed rather than dropped so the port reads against
   * the original. */
  typeOf(): number {
    return this.cached("typeof", [this.dynRef()], [this.deps.strRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 1;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      // C tests the island kind BEFORE the switch and early-returns into
      // the engine's own typeof (scr_json.c:1122) — so JSVAL has no answer
      // this tier can spell, and it must not fall through to the default's
      // "undefined". Unconstructible here, so it traps instead of guessing
      // (truthy's JSVAL arm, same stance, same reason).
      this.arm(c, K, [DK.JSVAL], () => c.unreachable());
      this.arm(c, K, [DK.UNDEF], () => this.deps.lit(c, "undefined"));
      this.arm(c, K, [DK.BOOL], () => this.deps.lit(c, "boolean"));
      this.arm(c, K, [DK.NUM], () => this.deps.lit(c, "number"));
      this.arm(c, K, [DK.STR], () => this.deps.lit(c, "string"));
      this.arm(c, K, [DK.FUNC], () => this.deps.lit(c, "function"));
      this.arm(c, K, [DK.NULL, DK.OBJ, DK.ARR, DK.BYTES, DK.HANDLE, DK.PROMISE], () =>
        this.deps.lit(c, "object"),
      );
      this.deps.lit(c, "undefined");
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** %w.dyn.toStr(d) → `String(u)` over a dyn value — the C emitter's
   * `sc_ds` walker. Note how it differs from `typeof`'s table and from
   * the METHOD spelling `u.toString()`: numbers spell NaN and Infinity
   * out (JSON's `null` is a serializer-ism, not a ToString one), arrays
   * run Array.prototype.toString (join with "," where null and undefined
   * ELEMENTS render EMPTY and nested arrays flatten through the
   * recursion), and plain objects are "[object Object]".
   *
   * C accumulates into a byte buffer; this concatenates, which is
   * quadratic on a long array but is the only string-building primitive
   * the tier has (%w.concat is the one place string storage is written).
   * The union ToString helper made the same trade. */
  toStr(): number {
    return this.cached("toStr", [this.dynRef()], [this.deps.strRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 1;
      const OUT = 2;
      const I = 3;
      const N = 4;
      const A = 5;
      const E = 6;
      const concat = this.deps.concat();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.STR], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
      });
      this.arm(c, K, [DK.UNDEF], () => this.deps.lit(c, "undefined"));
      this.arm(c, K, [DK.NULL], () => this.deps.lit(c, "null"));
      this.arm(c, K, [DK.BOOL], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.f64Const(0);
        c.f64Ne();
        c.ifResult(this.deps.strRef());
        this.deps.lit(c, "true");
        c.else_();
        this.deps.lit(c, "false");
        c.end();
      });
      this.arm(c, K, [DK.NUM], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.call(this.deps.f64ToStr());
      });
      this.arm(c, K, [DK.ARR], () => {
        this.deps.lit(c, "");
        c.localSet(OUT);
        this.arrPayload(c, (x) => x.localGet(0));
        c.localSet(A);
        this.arrLen(c, (x) => x.localGet(A));
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        c.localGet(I);
        c.i32Const(0);
        c.i32Ne();
        c.ifVoid();
        c.localGet(OUT);
        this.deps.lit(c, ",");
        c.call(concat);
        c.localSet(OUT);
        c.end();
        this.arrAt(c, (x) => x.localGet(A), (x) => x.localGet(I));
        c.localTee(E);
        c.structGet(dynT, DYN_KIND);
        // K is the OUTER dispatch's local, reused for the element kind.
        // Safe only because every arm above returns, so nothing after
        // this point reads the receiver's kind again — if an arm ever
        // falls through instead of returning, this needs its own local.
        c.localSet(K);
        // A null or undefined ELEMENT renders EMPTY — unlike the same
        // value at the top level, which spells itself out.
        c.localGet(K);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.localGet(K);
        c.i32Const(DK.NULL);
        c.i32Eq();
        c.i32Or();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(OUT);
        c.localGet(E);
        c.call(idx);
        c.call(concat);
        c.localSet(OUT);
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
      });
      this.arm(c, K, [DK.OBJ], () => {
        // The dyn tree's ERROR encoding — an object carrying the reserved
        // "%error" key — renders as Error.prototype.toString ("Name:
        // message"), not "[object Object]". Its only producer is
        // caughtToDyn, which does not exist yet; until it does, meeting
        // one means the encoding arrived by a route nobody designed, and
        // a trap is the honest answer where "[object Object]" would be a
        // quietly wrong one.
        this.objPayload(c, (x) => x.localGet(0));
        this.deps.lit(c, "%error");
        c.call(this.objGet());
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.unreachable();
        c.end();
        this.deps.lit(c, "[object Object]");
      });
      // Object.prototype.toString with the Promise @@toStringTag.
      this.arm(c, K, [DK.PROMISE], () => this.deps.lit(c, "[object Promise]"));
      // The runtime handles inherit Object.prototype.toString.
      this.arm(c, K, [DK.HANDLE], () => this.deps.lit(c, "[object Object]"));
      // FUNC's text embeds the boxed function's NAME and BYTES' depends on
      // the Buffer flag — both live in payloads that arrive with their own
      // stages (4 and the bytes work). Unconstructible until then.
      c.unreachable();
      this.mb.setBody(
        idx,
        [I32, this.deps.strRef(), I32, I32, this.arrRef(), this.dynRef()],
        c.bytes(),
      );
    });
  }

  /** %w.dyn.canonIdx(k) → the array index `k` names, or -1 when it is not
   * a CANONICAL index spelling. JS only treats a string key as an index
   * when it round-trips: digits only, and no leading zero unless the whole
   * key is "0" — so `a["01"]` and `a["1.0"]` are ordinary (absent) named
   * properties, not element 1. The overflow guard makes a key longer than
   * any possible length answer "not an index" rather than wrapping, which
   * reaches the same undefined by a safe route.
   *
   * NOT REUSABLE FOR KEY ORDERING, and the difference is measurable. The
   * ordering rule (`Object.keys` putting integer-like keys first) accepts
   * the full array-index range [0, 2^32-2], while the guard here bails
   * around 2^31. Verified against Node: with keys {z, 4294967295,
   * 4294967294, 0} the answer is ["0","4294967294","z","4294967295"] —
   * 2^32-2 sorts as an index and 2^32-1 does not. That is harmless for
   * READS (no array on this tier has 2^31 elements, so both rules answer
   * undefined) and WRONG for ordering, which needs its own wider
   * predicate. */
  canonIdx(): number {
    return this.cached("canonIdx", [this.deps.strRef()], [I32], (idx) => {
      const c = new Code();
      const N = 1;
      const I = 2;
      const V = 3;
      const U = 4;
      c.localGet(0);
      c.arrayLen();
      c.localTee(N);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(-1);
      c.return_();
      c.end();
      // A leading zero disqualifies everything except "0" itself.
      c.localGet(N);
      c.i32Const(1);
      c.i32GtU();
      c.ifVoid();
      c.localGet(0);
      c.i32Const(0);
      c.arrayGetU(this.deps.strType());
      c.i32Const(0x30);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(-1);
      c.return_();
      c.end();
      c.end();
      c.i32Const(0);
      c.localSet(V);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.i32Const(0x30);
      c.i32Sub();
      c.localTee(U);
      c.i32Const(9);
      c.i32GtU();
      // (0x7fffffff - 9) / 10 — past this the next step would overflow.
      c.localGet(V);
      c.i32Const(214748363);
      c.i32GtU();
      c.i32Or();
      c.ifVoid();
      c.i32Const(-1);
      c.return_();
      c.end();
      c.localGet(V);
      c.i32Const(10);
      c.i32Mul();
      c.localGet(U);
      c.i32Add();
      c.localSet(V);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(V);
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
    });
  }

  /** Is `k` exactly "length"? */
  private pushIsLength(c: Code, pushKey: (c: Code) => void): void {
    pushKey(c);
    this.deps.lit(c, "length");
    c.call(this.deps.strEq());
  }

  /** %w.dyn.keyGet(d, k, opt) → `d[k]`, the type-independent keyed read
   * (`scr_dyn_key_get`). A missing member is THE undefined immortal, which
   * is JS's own-property answer — prototype members like `toString` read
   * undefined too. An undefined or null RECEIVER throws Node's catchable
   * TypeError naming the key, unless `opt` (a `?.` step) short-circuits to
   * undefined instead. */
  keyGet(): number {
    return this.cached(
      "keyGet",
      [this.dynRef(), this.deps.strRef(), I32],
      [this.dynRef()],
      (idx) => {
        const dynT = this.dynT();
        const c = new Code();
        const K = 3;
        const IDX = 4;
        const M = 5;
        const MSG = 6;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.localSet(K);
        // Nullish receiver: short-circuit, or Node's message.
        c.localGet(K);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.localGet(K);
        c.i32Const(DK.NULL);
        c.i32Eq();
        c.i32Or();
        c.ifVoid();
        c.localGet(2);
        c.ifVoid();
        c.globalGet(this.undefinedGlobal());
        c.return_();
        c.end();
        c.localGet(K);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.ifResult(this.deps.strRef());
        this.deps.lit(c, "Cannot read properties of undefined (reading '");
        c.else_();
        this.deps.lit(c, "Cannot read properties of null (reading '");
        c.end();
        c.localGet(1);
        c.call(this.deps.concat());
        this.deps.lit(c, "')");
        c.call(this.deps.concat());
        c.localSet(MSG);
        this.deps.throwTypeError(c, (x) => x.localGet(MSG));
        c.refNull(dynT);
        c.return_();
        c.end();
        // Objects answer their own members.
        this.arm(c, K, [DK.OBJ], () => {
          this.objPayload(c, (x) => x.localGet(0));
          c.localGet(1);
          c.call(this.objGet());
          c.localTee(M);
          c.refIsNull();
          c.ifResult(this.dynRef());
          c.globalGet(this.undefinedGlobal());
          c.else_();
          c.localGet(M);
          c.end();
        });
        this.arm(c, K, [DK.ARR], () => {
          this.pushIsLength(c, (x) => x.localGet(1));
          c.ifVoid();
          this.boxNum(c, (x) => {
            this.arrLen(x, (y) => this.arrPayload(y, (z) => z.localGet(0)));
            x.f64ConvertI32U();
          });
          c.return_();
          c.end();
          c.localGet(1);
          c.call(this.canonIdx());
          c.localTee(IDX);
          c.i32Const(0);
          c.i32GeS();
          c.ifVoid();
          c.localGet(IDX);
          this.arrLen(c, (x) => this.arrPayload(x, (y) => y.localGet(0)));
          c.i32LtU();
          c.ifVoid();
          this.arrAt(
            c,
            (x) => this.arrPayload(x, (y) => y.localGet(0)),
            (x) => x.localGet(IDX),
          );
          c.return_();
          c.end();
          c.end();
          c.globalGet(this.undefinedGlobal());
        });
        this.arm(c, K, [DK.STR], () => {
          this.pushIsLength(c, (x) => x.localGet(1));
          c.ifVoid();
          this.boxNum(c, (x) => {
            x.localGet(0);
            x.structGet(dynT, DYN_REF);
            x.refCast(this.deps.strType());
            x.arrayLen();
            x.f64ConvertI32U();
          });
          c.return_();
          c.end();
          c.localGet(1);
          c.call(this.canonIdx());
          c.localTee(IDX);
          c.i32Const(0);
          c.i32GeS();
          c.ifVoid();
          c.localGet(IDX);
          c.localGet(0);
          c.structGet(dynT, DYN_REF);
          c.refCast(this.deps.strType());
          c.arrayLen();
          c.i32LtU();
          c.ifVoid();
          // One code unit as its own string — JS's "abc"[1].
          this.boxStr(c, (x) => {
            x.i32Const(1);
            x.arrayNewDefault(this.deps.strType());
            x.localSet(MSG);
            x.localGet(MSG);
            x.i32Const(0);
            x.localGet(0);
            x.structGet(dynT, DYN_REF);
            x.refCast(this.deps.strType());
            x.localGet(IDX);
            x.arrayGetU(this.deps.strType());
            x.arraySet(this.deps.strType());
            x.localGet(MSG);
          });
          c.return_();
          c.end();
          c.end();
          c.globalGet(this.undefinedGlobal());
        });
        // FUNC's own props plus name/length arrive with the boxes (stage
        // 4); BYTES, HANDLE and JSVAL are unconstructible on this tier.
        this.arm(c, K, [DK.FUNC, DK.BYTES, DK.HANDLE, DK.JSVAL], () => c.unreachable());
        // NUM and BOOL have no own properties: JS reads undefined.
        c.globalGet(this.undefinedGlobal());
        this.mb.setBody(idx, [I32, I32, this.dynRef(), this.deps.strRef()], c.bytes());
      },
    );
  }

  /** %w.dyn.keySet(d, k, v) — `d[k] = v`, `scr_dyn_key_set` ported. OBJ
   * writes through objPut (later duplicates win, the surviving entry
   * keeps its original key); an ARR takes CANONICAL INDEX writes, holes
   * padding with undefined exactly like JS length growth. Every other
   * receiver THROWS Node's catchable TypeError — the nullish
   * "Cannot set properties of undefined (setting 'k')" and, for the rest,
   * strict mode's "Cannot create property 'k' on number '5'" (the
   * primitive kinds quote their own rendering after the kind word).
   *
   * SEMANTICS.md S016: a NON-INDEX key on a dyn array throws where Node
   * adds an expando (the ARR payload is a bare vector with no property
   * table beside it), and an index at or past 2^31 — where canonIdx bails
   * — throws where Node grows the array. C would instead push undefined
   * two billion times, so the throw is the same disagreement arriving in
   * finite time. Every OTHER receiver's refusal is Node's own text. */
  keySet(): number {
    return this.cached("keySet", [this.dynRef(), this.deps.strRef(), this.dynRef()], [], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 3;
      const IDX = 4;
      const A = 5;
      const MSG = 6;
      const concat = this.deps.concat();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.OBJ], () => {
        this.objPayload(c, (x) => x.localGet(0));
        c.localGet(1);
        c.localGet(2);
        c.call(this.objPut());
      });
      // An ARR takes index writes and FALLS THROUGH on any other key —
      // the one arm that is not a full dispatch, so `arm` cannot spell it.
      c.localGet(K);
      c.i32Const(DK.ARR);
      c.i32Eq();
      c.ifVoid();
      c.localGet(1);
      c.call(this.canonIdx());
      c.localTee(IDX);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      this.arrPayload(c, (x) => x.localGet(0));
      c.localSet(A);
      // Pad to the index: C's `while (len <= idx) push(undefined)`.
      c.block();
      c.loop();
      this.arrLen(c, (x) => x.localGet(A));
      c.localGet(IDX);
      c.i32GtU();
      c.brIf(1);
      c.localGet(A);
      c.globalGet(this.undefinedGlobal());
      c.call(this.deps.arrPush());
      c.br(0);
      c.end();
      c.end();
      this.arrSet(
        c,
        (x) => x.localGet(A),
        (x) => x.localGet(IDX),
        (x) => x.localGet(2),
      );
      c.return_();
      c.end();
      c.end();
      // HANDLE routes to the tag's installed setters and JSVAL writes the
      // REAL engine object; neither is constructible here, and neither may
      // borrow the throw below (that would be a wrong answer, not a loud
      // one).
      this.arm(c, K, [DK.HANDLE, DK.JSVAL], () => c.unreachable());
      c.localGet(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      this.deps.lit(c, "Cannot set properties of ");
      c.localGet(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "undefined");
      c.else_();
      this.deps.lit(c, "null");
      c.end();
      c.call(concat);
      this.deps.lit(c, " (setting '");
      c.call(concat);
      c.localGet(1);
      c.call(concat);
      this.deps.lit(c, "')");
      c.call(concat);
      c.localSet(MSG);
      c.else_();
      this.deps.lit(c, "Cannot create property '");
      c.localGet(1);
      c.call(concat);
      this.deps.lit(c, "' on ");
      c.call(concat);
      c.localGet(0);
      c.call(this.kindName());
      c.call(concat);
      c.localSet(MSG);
      // V8 quotes the primitive's OWN rendering after the kind word —
      // "on number '5'", "on string 'abc'", "on boolean 'true'". Every
      // other kind stops at the kind word.
      this.arm(c, K, [DK.NUM, DK.STR, DK.BOOL], () => {
        c.localGet(MSG);
        this.deps.lit(c, " '");
        c.call(concat);
        c.localGet(K);
        c.i32Const(DK.NUM);
        c.i32Eq();
        c.ifResult(this.deps.strRef());
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.call(this.deps.f64ToStr());
        c.else_();
        c.localGet(K);
        c.i32Const(DK.STR);
        c.i32Eq();
        c.ifResult(this.deps.strRef());
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.else_();
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.f64Const(0);
        c.f64Ne();
        c.ifResult(this.deps.strRef());
        this.deps.lit(c, "true");
        c.else_();
        this.deps.lit(c, "false");
        c.end();
        c.end();
        c.end();
        c.call(concat);
        this.deps.lit(c, "'");
        c.call(concat);
        c.localSet(MSG);
        // `arm` closes with a `return`; the throw has to happen inside.
        this.deps.throwTypeError(c, (x) => x.localGet(MSG));
      });
      c.end();
      this.deps.throwTypeError(c, (x) => x.localGet(MSG));
      this.mb.setBody(idx, [I32, I32, this.arrRef(), this.deps.strRef()], c.bytes());
    });
  }

  /** %w.dyn.hasOwn(d, k) → i32 — `Object.hasOwn(d, k)`,
   * `scr_dyn_has_own` ported: OBJ answers own-member presence (a member
   * holding undefined still answers true — the tree stores PRESENCE),
   * ARR and STR answer "length" and canonical in-range indices, every
   * other kind answers false, and a NULLISH receiver throws ToObject's
   * catchable "Cannot convert undefined or null to object".
   *
   * THE STR ARM IS NOT IN THE C RUNTIME, deliberately. `scr_dyn_has_own`
   * has OBJ and ARR arms and stops, so it answers false where Node
   * answers true for `Object.hasOwn("abc", "length")` — while
   * `scr_dyn_key_get` DOES model string length and index reads, which
   * S015 names as the forms that work — answering false for them would
   * contradict the register's own stated boundary. That reads as an
   * omission rather than a stance, so this lane matches NODE. The C lane
   * lacks this arm today; the convergence is task-tracked, and matching
   * Node REMOVES a divergence rather than adding one, so there is nothing
   * to register here. */
  hasOwn(): number {
    return this.cached("hasOwn", [this.dynRef(), this.deps.strRef()], [I32], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 2;
      const IDX = 3;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.UNDEF, DK.NULL], () => {
        this.pushToObjectFail(c);
        c.i32Const(0);
      });
      this.arm(c, K, [DK.OBJ], () => {
        this.objPayload(c, (x) => x.localGet(0));
        c.localGet(1);
        c.call(this.objGet());
        c.refIsNull();
        c.i32Eqz();
      });
      this.arm(c, K, [DK.ARR, DK.STR], () => {
        this.pushIsLength(c, (x) => x.localGet(1));
        c.ifResult(I32);
        c.i32Const(1);
        c.else_();
        c.localGet(1);
        c.call(this.canonIdx());
        c.localTee(IDX);
        c.i32Const(0);
        c.i32GeS();
        c.ifResult(I32);
        c.localGet(IDX);
        c.localGet(K);
        c.i32Const(DK.ARR);
        c.i32Eq();
        c.ifResult(I32);
        this.arrLen(c, (x) => this.arrPayload(x, (y) => y.localGet(0)));
        c.else_();
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.arrayLen();
        c.end();
        c.i32LtU();
        c.else_();
        c.i32Const(0);
        c.end();
        c.end();
      });
      // C routes an island receiver to the ENGINE's own Object.hasOwn;
      // unconstructible here, and `false` would be a silent wrong answer.
      this.arm(c, K, [DK.JSVAL], () => c.unreachable());
      c.i32Const(0);
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  /** ToObject's refusal, shared by every walk that takes a receiver:
   * leaves a catchable TypeError in the cell, caller unwinds. */
  private pushToObjectFail(c: Code): void {
    this.deps.throwTypeError(c, (x) => this.deps.lit(x, "Cannot convert undefined or null to object"));
  }

  /** %w.dyn.idxKey(k) → the ARRAY-INDEX number `k` spells, or -1 when it
   * spells none — the ORDERING predicate, deliberately distinct from
   * `canonIdx`. Object.keys puts integer-like keys first, and the range
   * that qualifies is the full [0, 2^32-2]: canonIdx's overflow guard
   * bails around 2^31, which is harmless for reads (both rules answer
   * undefined) and WRONG here. Verified against Node with keys
   * {z, "4294967295", "4294967294", "0"} → ["0","4294967294","z",
   * "4294967295"]: 2^32-2 sorts as an index and 2^32-1 does not.
   * `scr_dyn_key_is_index` exactly, accumulating in f64 because the
   * answers do not fit i32. */
  idxKey(): number {
    return this.cached("idxKey", [this.deps.strRef()], [F64], (idx) => {
      const c = new Code();
      const N = 1;
      const I = 2;
      const V = 3;
      const U = 4;
      c.localGet(0);
      c.arrayLen();
      c.localTee(N);
      c.i32Eqz();
      c.localGet(N);
      c.i32Const(10); // 4294967294 is ten digits; anything longer cannot be one
      c.i32GtU();
      c.i32Or();
      c.ifVoid();
      c.f64Const(-1);
      c.return_();
      c.end();
      c.localGet(N);
      c.i32Const(1);
      c.i32GtU();
      c.ifVoid();
      c.localGet(0);
      c.i32Const(0);
      c.arrayGetU(this.deps.strType());
      c.i32Const(0x30);
      c.i32Eq();
      c.ifVoid();
      c.f64Const(-1);
      c.return_();
      c.end();
      c.end();
      c.f64Const(0);
      c.localSet(V);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.i32Const(0x30);
      c.i32Sub();
      c.localTee(U);
      c.i32Const(9);
      c.i32GtU();
      c.ifVoid();
      c.f64Const(-1);
      c.return_();
      c.end();
      c.localGet(V);
      c.f64Const(10);
      c.f64Mul();
      c.localGet(U);
      c.f64ConvertI32U();
      c.f64Add();
      c.localSet(V);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(V);
      c.f64Const(4294967294);
      c.f64Gt();
      c.ifVoid();
      c.f64Const(-1);
      c.return_();
      c.end();
      c.localGet(V);
      this.mb.setBody(idx, [I32, I32, F64, I32], c.bytes());
    });
  }

  /** One `objWalk` step, per mode: KEYS pushes the key, VALUES the value,
   * ENTRIES a fresh two-element pair. `pair` is the caller's scratch. */
  private walkPush(
    c: Code,
    mode: number,
    out: number,
    pair: number,
    pushKey: (c: Code) => void,
    pushValue: (c: Code) => void,
  ): void {
    const push = this.deps.arrPush();
    c.localGet(mode);
    c.i32Eqz(); // KEYS
    c.ifVoid();
    c.localGet(out);
    this.boxStr(c, pushKey);
    c.call(push);
    c.else_();
    c.localGet(mode);
    c.i32Const(1); // VALUES
    c.i32Eq();
    c.ifVoid();
    c.localGet(out);
    pushValue(c);
    c.call(push);
    c.else_();
    this.pushNewArr(c);
    c.localSet(pair);
    c.localGet(pair);
    this.boxStr(c, pushKey);
    c.call(push);
    c.localGet(pair);
    pushValue(c);
    c.call(push);
    c.localGet(out);
    this.boxArr(c, (x) => x.localGet(pair));
    c.call(push);
    c.end();
    c.end();
  }

  /** %w.dyn.objWalk(d, mode) → the fresh dyn array behind Object.keys
   * (mode 0), Object.values (1) and Object.entries (2) — `scr_dyn_objwalk`
   * ported. OBJ walks its members in JS OWN-KEY ORDER: array-index keys
   * ascending FIRST (the `idxKey` range, not canonIdx's), then everything
   * else in insertion order. ARR answers its dense indices; a nullish
   * receiver throws ToObject's TypeError; the scalar kinds have no own
   * enumerable string keys and answer the empty array.
   *
   * Two departures from the C body, neither observable:
   *  - C precomputes each key's index-ness into a scratch array and
   *    selection-scans that; the scan here re-derives it per pass, which
   *    is the same order without the allocation (dyn objects are small
   *    and index keys in them are rare).
   *  - STRING receivers list one key PER UTF-16 CODE UNIT, which is
   *    Node's own answer. C walks code POINTS over its UTF-8 storage and
   *    says so in a comment ("one entry where JS lists two lone
   *    surrogates"); S002's storage makes the exact answer free here, and
   *    the two agree on every string without an astral character — which
   *    is every string a corpus program can hold, since the C lane would
   *    already fail the differential on one. */
  objWalk(): number {
    return this.cached("objWalk", [this.dynRef(), I32], [this.dynRef()], (idx) => {
      const dynT = this.dynT();
      const objT = this.objT();
      const entries = this.entriesArrayType();
      const entryT = this.entryT();
      const c = new Code();
      const MODE = 1; // the walk selector, parameter 1
      const K = 2;
      const OUT = 3;
      const O = 4;
      const N = 5;
      const I = 6;
      const E = 7;
      const PAIR = 8;
      const BEST = 9;
      const BESTV = 10;
      const LAST = 11;
      const IV = 12;
      const A = 13;
      const S = 14;
      const CP = 15;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.UNDEF, DK.NULL], () => {
        this.pushToObjectFail(c);
        c.refNull(dynT);
      });
      // The ENGINE walks its own object in C (own-key order, getters
      // running); a BYTES receiver lists its byte indices. Neither is
      // constructible here.
      this.arm(c, K, [DK.BYTES, DK.JSVAL, DK.HANDLE], () => c.unreachable());
      this.pushNewArr(c);
      c.localSet(OUT);
      this.arm(c, K, [DK.OBJ], () => {
        this.objPayload(c, (x) => x.localGet(0));
        c.localSet(O);
        c.localGet(O);
        c.structGet(objT, OBJ_LEN);
        c.localSet(N);
        // Pass 1: index keys, ascending. Each round picks the smallest
        // index strictly greater than the last one emitted.
        c.f64Const(-1);
        c.localSet(LAST);
        c.block();
        c.loop();
        c.i32Const(-1);
        c.localSet(BEST);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        c.localGet(O);
        c.structGet(objT, OBJ_ENTRIES);
        c.localGet(I);
        c.arrayGet(entries);
        c.structGet(entryT, ENTRY_KEY);
        c.call(this.idxKey());
        c.localTee(IV);
        c.localGet(LAST);
        c.f64Gt();
        c.ifVoid();
        // `best < 0 || iv < bestv` — BESTV is only meaningful once BEST
        // is set, so the two tests nest rather than `or`.
        c.localGet(BEST);
        c.i32Const(0);
        c.i32LtS();
        c.ifResult(I32);
        c.i32Const(1);
        c.else_();
        c.localGet(IV);
        c.localGet(BESTV);
        c.f64Lt();
        c.end();
        c.ifVoid();
        c.localGet(I);
        c.localSet(BEST);
        c.localGet(IV);
        c.localSet(BESTV);
        c.end();
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(BEST);
        c.i32Const(0);
        c.i32LtS();
        c.brIf(1);
        c.localGet(BESTV);
        c.localSet(LAST);
        c.localGet(O);
        c.structGet(objT, OBJ_ENTRIES);
        c.localGet(BEST);
        c.arrayGet(entries);
        c.localSet(E);
        this.walkPush(
          c,
          MODE,
          OUT,
          PAIR,
          (x) => {
            x.localGet(E);
            x.structGet(entryT, ENTRY_KEY);
          },
          (x) => {
            x.localGet(E);
            x.structGet(entryT, ENTRY_VALUE);
          },
        );
        c.br(0);
        c.end();
        c.end();
        // Pass 2: everything else, in insertion order.
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        c.localGet(O);
        c.structGet(objT, OBJ_ENTRIES);
        c.localGet(I);
        c.arrayGet(entries);
        c.localTee(E);
        c.structGet(entryT, ENTRY_KEY);
        c.call(this.idxKey());
        c.f64Const(0);
        c.f64Lt();
        c.ifVoid();
        this.walkPush(
          c,
          MODE,
          OUT,
          PAIR,
          (x) => {
            x.localGet(E);
            x.structGet(entryT, ENTRY_KEY);
          },
          (x) => {
            x.localGet(E);
            x.structGet(entryT, ENTRY_VALUE);
          },
        );
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        this.boxArr(c, (x) => x.localGet(OUT));
      });
      this.arm(c, K, [DK.ARR], () => {
        this.arrPayload(c, (x) => x.localGet(0));
        c.localSet(A);
        this.arrLen(c, (x) => x.localGet(A));
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        this.walkPush(
          c,
          MODE,
          OUT,
          PAIR,
          (x) => {
            x.localGet(I);
            x.f64ConvertI32U();
            x.call(this.deps.f64ToStr());
          },
          (x) => this.arrAt(x, (y) => y.localGet(A), (y) => y.localGet(I)),
        );
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        this.boxArr(c, (x) => x.localGet(OUT));
      });
      this.arm(c, K, [DK.STR], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.localTee(S);
        c.arrayLen();
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        // One code UNIT as its own string — keyGet's "abc"[1].
        c.i32Const(1);
        c.arrayNewDefault(this.deps.strType());
        c.localSet(CP);
        c.localGet(CP);
        c.i32Const(0);
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.deps.strType());
        c.arraySet(this.deps.strType());
        this.walkPush(
          c,
          MODE,
          OUT,
          PAIR,
          (x) => {
            x.localGet(I);
            x.f64ConvertI32U();
            x.call(this.deps.f64ToStr());
          },
          (x) => this.boxStr(x, (y) => y.localGet(CP)),
        );
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        this.boxArr(c, (x) => x.localGet(OUT));
      });
      // NUM, BOOL, FUNC, PROMISE: no own enumerable string keys.
      this.boxArr(c, (x) => x.localGet(OUT));
      this.mb.setBody(
        idx,
        [
          I32,
          this.arrRef(),
          this.objRef(),
          I32,
          I32,
          this.entryRef(),
          this.arrRef(),
          I32,
          F64,
          F64,
          F64,
          this.arrRef(),
          this.deps.strRef(),
          this.deps.strRef(),
        ],
        c.bytes(),
      );
    });
  }

  /** %w.dyn.assign(target, src) → the target — `Object.assign` over dyn
   * values, `scr_dyn_assign` plus its `assign_from` helper. A nullish
   * TARGET throws ToObject's TypeError; a non-OBJ target copies nothing
   * (a dyn array has no property table); nullish sources copy nothing
   * (Node skips them); an OBJ source copies its members directly, last
   * write winning; the index-keyed kinds ride the ENTRIES walk, so the
   * copied key set is exactly what Object.keys answers for them. */
  assign(): number {
    return this.cached("assign", [this.dynRef(), this.dynRef()], [this.dynRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 2;
      const O = 3;
      const N = 4;
      const I = 5;
      const E = 6;
      const PAIRS = 7;
      const P = 8;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localTee(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      this.pushToObjectFail(c);
      c.refNull(dynT);
      c.return_();
      c.end();
      // An ENGINE target runs the copy engine-side in C; unconstructible.
      this.arm(c, K, [DK.JSVAL], () => c.unreachable());
      c.localGet(K);
      c.i32Const(DK.OBJ);
      c.i32Ne();
      c.ifVoid();
      c.localGet(0);
      c.return_();
      c.end();
      this.objPayload(c, (x) => x.localGet(0));
      c.localSet(O);
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.OBJ], () => {
        const objT = this.objT();
        const entries = this.entriesArrayType();
        const entryT = this.entryT();
        this.objPayload(c, (x) => x.localGet(1));
        c.structGet(objT, OBJ_LEN);
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        this.objPayload(c, (x) => x.localGet(1));
        c.structGet(objT, OBJ_ENTRIES);
        c.localGet(I);
        c.arrayGet(entries);
        c.localSet(E);
        c.localGet(O);
        c.localGet(E);
        c.structGet(entryT, ENTRY_KEY);
        c.localGet(E);
        c.structGet(entryT, ENTRY_VALUE);
        c.call(this.objPut());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(0);
      });
      // The index-keyed sources go through their own ENTRIES walk, which
      // is what makes the copied keys agree with Object.keys by
      // construction. (BYTES belongs here in C; objWalk traps on one.)
      this.arm(c, K, [DK.ARR, DK.STR, DK.BYTES], () => {
        c.localGet(1);
        c.i32Const(2); // ENTRIES
        c.call(this.objWalk());
        c.localSet(PAIRS);
        this.arrLen(c, (x) => this.arrPayload(x, (y) => y.localGet(PAIRS)));
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        this.arrAt(
          c,
          (x) => this.arrPayload(x, (y) => y.localGet(PAIRS)),
          (x) => x.localGet(I),
        );
        c.localSet(P);
        c.localGet(O);
        this.arrAt(
          c,
          (x) => this.arrPayload(x, (y) => y.localGet(P)),
          (x) => x.i32Const(0),
        );
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        this.arrAt(
          c,
          (x) => this.arrPayload(x, (y) => y.localGet(P)),
          (x) => x.i32Const(1),
        );
        c.call(this.objPut());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(0);
      });
      // Nullish sources copy nothing; the scalar kinds have no own
      // enumerable string keys. Either way the target answers unchanged.
      c.localGet(0);
      this.mb.setBody(
        idx,
        [I32, this.objRef(), I32, I32, this.entryRef(), this.dynRef(), this.dynRef()],
        c.bytes(),
      );
    });
  }

  /** %w.dyn.iterFail(d) — GetIterator's refusal in its VALUE-DESCRIBING
   * form: "<desc> is not iterable (cannot read property
   * Symbol(Symbol.iterator))" where desc names the value ("undefined",
   * "object null", "number 5", "boolean true", "function", bare "object" —
   * Node says the last one for a plain `{}` too, not only for nullish).
   * Every word of THAT form is V8's, verified.
   *
   * It is the FALLBACK, not the whole story: where V8 can render the
   * source expression it says "arr[0] is not iterable" instead, and
   * iterPack takes a compile-time spelling for exactly that reason. The
   * lowering supplies one for an identifier and a dotted member but not
   * for a computed access, so a `for...of` over `arr[0]` lands here and
   * answers the kind wording where Node names the source —
   * SEMANTICS.md S017. Leaves the TypeError in the cell; the caller
   * unwinds. */
  iterFail(): number {
    return this.cached("iterFail", [this.dynRef()], [], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 1;
      const D = 2;
      const concat = this.deps.concat();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      c.localGet(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "undefined");
      c.else_();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "object null");
      c.else_();
      c.localGet(K);
      c.i32Const(DK.BOOL);
      c.i32Eq();
      c.ifResult(this.deps.strRef());
      c.localGet(0);
      c.structGet(dynT, DYN_NUM);
      c.f64Const(0);
      c.f64Ne();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "boolean true");
      c.else_();
      this.deps.lit(c, "boolean false");
      c.end();
      c.else_();
      c.localGet(K);
      c.i32Const(DK.NUM);
      c.i32Eq();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "number ");
      c.localGet(0);
      c.structGet(dynT, DYN_NUM);
      c.call(this.deps.f64ToStr());
      c.call(concat);
      c.else_();
      c.localGet(K);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "function");
      c.else_();
      this.deps.lit(c, "object"); // OBJ, HANDLE, PROMISE — C's default arm
      c.end();
      c.end();
      c.end();
      c.end();
      c.end();
      this.deps.lit(c, " is not iterable (cannot read property Symbol(Symbol.iterator))");
      c.call(concat);
      c.localSet(D);
      this.deps.throwTypeError(c, (x) => x.localGet(D));
      this.mb.setBody(idx, [I32, this.deps.strRef()], c.bytes());
    });
  }

  /** Push every element of an ITERABLE dyn (ARR or STR) onto the vector
   * in `out` — the shared body of the destructuring pack and its
   * first-N cousin. Strings step by CODE POINT (an astral character
   * arrives unsplit, the string iterator's contract, unlike a keyed
   * read's code unit); `limit` < 0 drains, otherwise it stops after that
   * many steps and PADS with undefined. */
  private emitIterSteps(
    c: Code,
    out: number,
    kindLocal: number,
    /** The local holding the step count, or null to drain the source. */
    limit: number | null,
    locals: { A: number; N: number; I: number; S: number; CP: number; AT: number },
  ): void {
    const dynT = this.dynT();
    const { A, N, I, S, CP, AT } = locals;
    const push = this.deps.arrPush();
    c.localGet(kindLocal);
    c.i32Const(DK.ARR);
    c.i32Eq();
    c.ifVoid();
    this.arrPayload(c, (x) => x.localGet(0));
    c.localSet(A);
    this.arrLen(c, (x) => x.localGet(A));
    c.localSet(N);
    c.i32Const(0);
    c.localSet(I);
    c.block();
    c.loop();
    c.localGet(I);
    c.localGet(limit ?? N);
    c.i32GeU();
    c.brIf(1);
    c.localGet(out);
    c.localGet(I);
    c.localGet(N);
    c.i32LtU();
    c.ifResult(this.dynRef());
    this.arrAt(c, (x) => x.localGet(A), (x) => x.localGet(I));
    c.else_();
    c.globalGet(this.undefinedGlobal());
    c.end();
    c.call(push);
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end();
    c.end();
    c.else_();
    // STR: a running cursor over the code POINTS. C restarts the walk at
    // every step (its own O(n²) shape); the cursor answers identically.
    c.localGet(0);
    c.structGet(dynT, DYN_REF);
    c.refCast(this.deps.strType());
    c.localTee(S);
    c.arrayLen();
    c.localSet(N);
    c.i32Const(0);
    c.localSet(AT);
    c.i32Const(0);
    c.localSet(I);
    c.block();
    c.loop();
    if (limit === null) {
      // Draining: the cursor reaching the end IS the exit.
      c.localGet(AT);
      c.localGet(N);
    } else {
      c.localGet(I);
      c.localGet(limit);
    }
    c.i32GeU();
    c.brIf(1);
    c.localGet(out);
    c.localGet(AT);
    c.localGet(N);
    c.i32LtU();
    c.ifResult(this.dynRef());
    c.localGet(S);
    c.localGet(AT);
    c.f64ConvertI32U();
    c.call(this.deps.strCpAt());
    c.localSet(CP);
    c.localGet(AT);
    c.localGet(CP);
    c.arrayLen();
    c.i32Add();
    c.localSet(AT);
    this.boxStr(c, (x) => x.localGet(CP));
    c.else_();
    c.globalGet(this.undefinedGlobal());
    c.end();
    c.call(push);
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end();
    c.end();
    c.end();
  }

  /** The locals `emitIterSteps` works in, in the order both callers
   * declare them (both take the dyn value as parameter 0). */
  private iterLocals(base: number): { A: number; N: number; I: number; S: number; CP: number; AT: number } {
    return { A: base, N: base + 1, I: base + 2, S: base + 3, CP: base + 4, AT: base + 5 };
  }

  private iterLocalTypes(): ValType[] {
    return [this.arrRef(), I32, I32, this.deps.strRef(), this.deps.strRef(), I32];
  }

  /** %w.dyn.iterN(d, n) → a fresh dyn array of exactly `n` elements —
   * GetIterator plus the first N steps, as ARRAY DESTRUCTURING sees it
   * (`sc_dyn_iter_n`). Arrays step by index, strings by code point, and
   * everything past the end is undefined (which is what makes a pattern
   * longer than its source bind undefined rather than throw). A
   * non-iterable throws V8's wording through iterFail. */
  iterN(): number {
    return this.cached("iterN", [this.dynRef(), I32], [this.dynRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 2;
      const OUT = 3;
      const L = this.iterLocals(4);
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      // Buffers step by BYTE in C; unconstructible here, and the
      // not-iterable throw below would be a wrong claim about one.
      this.arm(c, K, [DK.BYTES, DK.JSVAL], () => c.unreachable());
      c.localGet(K);
      c.i32Const(DK.ARR);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(0);
      c.call(this.iterFail());
      c.refNull(dynT);
      c.return_();
      c.end();
      this.pushNewArr(c);
      c.localSet(OUT);
      this.emitIterSteps(c, OUT, K, 1, L);
      this.boxArr(c, (x) => x.localGet(OUT));
      this.mb.setBody(idx, [I32, this.arrRef(), ...this.iterLocalTypes()], c.bytes());
    });
  }

  /** %w.dyn.iterPack(d, msg) → the WHOLE source as a fresh dyn array —
   * the for-of / rest-pattern drain (`scr_dyn_iter_pack`). Same iterable
   * kinds and same steps as iterN; the difference is the terminator and
   * the refusal, which prefers the caller's compile-time `msg` (the
   * destructuring form, which names the SOURCE spelling) and falls back
   * to iterFail's value wording when that string is empty. */
  iterPack(): number {
    return this.cached("iterPack", [this.dynRef(), this.deps.strRef()], [this.dynRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 2;
      const OUT = 3;
      const L = this.iterLocals(4);
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.BYTES, DK.JSVAL], () => c.unreachable());
      c.localGet(K);
      c.i32Const(DK.ARR);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      // `msg != NULL && msg->len > 0` — the length read must not run on a
      // null reference, and wasm's i32.and does NOT short-circuit, so the
      // two tests NEST (json.ts's pushCurOr0, same trap avoided).
      c.localGet(1);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(1);
      c.arrayLen();
      c.ifVoid();
      this.deps.throwTypeError(c, (x) => x.localGet(1));
      c.refNull(dynT);
      c.return_();
      c.end();
      c.end();
      c.localGet(0);
      c.call(this.iterFail());
      c.refNull(dynT);
      c.return_();
      c.end();
      this.pushNewArr(c);
      c.localSet(OUT);
      this.emitIterSteps(c, OUT, K, null, L);
      this.boxArr(c, (x) => x.localGet(OUT));
      this.mb.setBody(idx, [I32, this.arrRef(), ...this.iterLocalTypes()], c.bytes());
    });
  }

  /** %w.dyn.kindName(d) → the noun a check failure reports, verbatim from
   * `scr_dyn_kind_name`. A NULL box is "undefined" — C's missing-object-
   * member case, which reaches this the same way. */
  kindName(): number {
    return this.cached("kindName", [this.dynRef()], [this.deps.strRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 1;
      c.localGet(0);
      c.refIsNull();
      c.ifVoid();
      this.deps.lit(c, "undefined"); // a missing object member
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.NULL], () => this.deps.lit(c, "null"));
      this.arm(c, K, [DK.BOOL], () => this.deps.lit(c, "boolean"));
      this.arm(c, K, [DK.NUM], () => this.deps.lit(c, "number"));
      this.arm(c, K, [DK.STR], () => this.deps.lit(c, "string"));
      this.arm(c, K, [DK.ARR], () => this.deps.lit(c, "array"));
      this.arm(c, K, [DK.OBJ], () => this.deps.lit(c, "object"));
      this.arm(c, K, [DK.UNDEF], () => this.deps.lit(c, "undefined"));
      this.arm(c, K, [DK.BYTES], () => this.deps.lit(c, "Uint8Array"));
      this.arm(c, K, [DK.FUNC], () => this.deps.lit(c, "function"));
      this.arm(c, K, [DK.PROMISE], () => this.deps.lit(c, "Promise"));
      this.arm(c, K, [DK.JSVAL], () => this.deps.lit(c, "an island value"));
      // HANDLE alone is left: C answers the handle's runtime class name
      // ("got IncomingMessage"), a registry lookup with no producer on
      // this tier.
      c.unreachable();
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** %w.dyn.pathRender(p) → the failure path, `scr_dyn_path_render`'s
   * grammar: `$` at the root, `.key` per object step, `[idx]` per array
   * step, rendered outermost-first by recursing into the parent. */
  pathRender(): number {
    return this.cached("pathRender", [this.pathRef()], [this.deps.strRef()], (idx) => {
      const pathT = this.pathT();
      const c = new Code();
      const HEAD = 1;
      c.localGet(0);
      c.refIsNull();
      c.ifVoid();
      this.deps.lit(c, "$");
      c.return_();
      c.end();
      c.localGet(0);
      c.structGet(pathT, PATH_PARENT);
      c.call(idx); // the parent renders first
      c.localSet(HEAD);
      c.localGet(0);
      c.structGet(pathT, PATH_KEY);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(HEAD);
      this.deps.lit(c, ".");
      c.call(this.deps.concat());
      c.localGet(0);
      c.structGet(pathT, PATH_KEY);
      c.call(this.deps.concat());
      c.return_();
      c.end();
      c.localGet(HEAD);
      this.deps.lit(c, "[");
      c.call(this.deps.concat());
      c.localGet(0);
      c.structGet(pathT, PATH_INDEX);
      c.f64ConvertI32U(); // C's "%zu" — indices are non-negative
      c.call(this.deps.f64ToStr());
      c.call(this.deps.concat());
      this.deps.lit(c, "]");
      c.call(this.deps.concat());
      this.mb.setBody(idx, [this.deps.strRef()], c.bytes());
    });
  }

  /** %w.dyn.checkFail(path, want, got) — `scr_dyn_check_fail`: render
   * "expected <want> at <path>, got <kind>" and leave a catchable
   * TypeError in the exception cell. Returns normally; the CALLER unwinds
   * (see DynDeps.throwTypeError). */
  checkFail(): number {
    return this.cached("checkFail", [this.pathRef(), this.deps.strRef(), this.dynRef()], [], (idx) => {
      const c = new Code();
      const MSG = 3;
      const concat = this.deps.concat();
      this.deps.lit(c, "expected ");
      c.localGet(1);
      c.call(concat);
      this.deps.lit(c, " at ");
      c.call(concat);
      c.localGet(0);
      c.call(this.pathRender());
      c.call(concat);
      this.deps.lit(c, ", got ");
      c.call(concat);
      c.localGet(2);
      c.call(this.kindName());
      c.call(concat);
      c.localSet(MSG);
      this.deps.throwTypeError(c, (w) => w.localGet(MSG));
      this.mb.setBody(idx, [this.deps.strRef()], c.bytes());
    });
  }
}
