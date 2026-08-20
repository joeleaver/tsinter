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
 * WHAT IS NOT HERE. HANDLE values are unconstructible on this tier (they
 * enter only through libCalls the wasm backend refuses), so the arms
 * that would read their payload are `unreachable` rather than guesses.
 * BYTES arrives with the typed-array work; until then its arms say so.
 *
 * JSVAL — the payload TAG (DK.JSVAL), not the IR type — stays
 * unconstructible here too, but by DESIGN rather than by gap (increment
 * 21's static island). There is no embedded engine on wasm and never
 * will be, so no dyn box is ever built with kind DK.JSVAL, and the arms
 * above that would read one stay `unreachable` PERMANENTLY — this is
 * not a future producer's TODO the way HANDLE/BYTES are. A `jsval`-
 * TYPED IR value, though, is a REAL, ordinary dyn payload from birth:
 * `mapType(jsval)` answers this SAME `(ref null $dyn)` mapType(dyn)
 * does, `dynFromJsval` is identity, and every any-world value a program
 * builds already carries the NUM/BOOL/STR/NULL/UNDEF/OBJ/ARR/FUNC tag
 * any other dyn value would — never a wrapper kind. Dyn operations on a
 * jsval-origin value therefore hit the ordinary arms above, not a
 * DK.JSVAL one, which is exactly what Node does too (Node has no
 * provenance distinction between "came from the engine" and "was always
 * data" at all — jsval ≡ dyn is Node-exactness by construction, not an
 * approximation of the native lane's engine-handle representation).
 *
 * THE ERROR ENCODING is an OBJ carrying the reserved "%error" key beside
 * name/message (and code where stamped), and `fromError` below is its
 * ONLY builder — both producers (`caughtToDyn` and the error-rooted
 * `dynFrom`) go through it, which is what makes one error crossing twice
 * one JS value. Its members are ordinary own entries, so they ENUMERATE
 * where Node's are hidden: SEMANTICS.md S021. `toStr`'s OBJ arm renders
 * it as Error.prototype.toString rather than "[object Object]", and that
 * arm was filled BEFORE the first producer landed — the sequencing rule
 * below, which is what keeps a wrong answer from ever being reachable.
 *
 * FUNC boxes DO exist now, and the sequencing rule they arrived under is
 * worth keeping — it is the one every stage since has followed, the
 * error encoding included: every arm a new payload makes reachable is
 * filled BEFORE the first producer lands, because an unfilled arm is
 * only loud while nothing can reach it. The FUNC surface is `strictEq` (closure
 * identity), `keyGet` and `hasOwn` (`name`/`length` — present exactly
 * where Node has them, ANSWERING S020's approximations), `toStr` (the
 * native-code form, S019), `typeof`, `truthy` and `objWalk` (which
 * answers the empty key list, Node's own answer for a function) — plus
 * `callFn` and the emitter's per-signature thunks, which are the payload
 * itself doing its job. `keySet` deliberately KEEPS the throw its
 * primitive receivers get: a FUNC payload has no property table to write
 * into (the own-property table C hangs off the closure has no producer
 * here — see `$dynFn` below), so S016 registers the write. */
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

/** `$dynFn`'s field indices — the FUNC payload, C's `ScrDynFn` laid out
 * for a tier with no `strcmp`. CLOS is the boxed closure struct as `eq`
 * (its wasm type is per-SIGNATURE, so the box cannot name it; the thunk
 * casts it back, which is sound exactly because the thunk is emitted per
 * signature and reached only through a matching SIG). THUNK is the
 * emitted call glue. SIG is the INTERNED typeKey id — C compares the
 * signature by `strcmp` on a string literal and LLVM interns; an i32
 * compare is the same question asked once at compile time. NAME and
 * ARITY answer `f.name` and `f.length` — APPROXIMATELY: both are what
 * the lowering could see at the BOX SITE (the binding's spelling, the
 * declared parameter count), not what the engine derives from the
 * function's definition, and SEMANTICS.md S020 registers where the two
 * come apart.
 *
 * C additionally hangs an own-property TABLE off the CLOSURE (not the
 * box), lazily allocated by `Object.defineProperties`. That is the
 * `dyn.defineProps` libCall, which this backend refuses, so nothing can
 * populate one here and the slot is absent rather than always-null. */
export const FN_CLOS = 0;
export const FN_THUNK = 1;
export const FN_SIG = 2;
export const FN_NAME = 3;
export const FN_ARITY = 4;

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

/** `$dynBytes`'s field indices. `isBuffer` is the flag C carries beside
 * the kind (the header's rule: flags never become kind ids) — mirrors
 * `$dynObj`'s `nullProto` exactly. Increment 18 stage C: the flag's
 * value at the ONE generic crossing site is currently always `false`
 * (SEMANTICS.md S037 — the IR has no surviving Buffer-vs-Uint8Array
 * marker by the time a value reaches `dynFrom`, matching a pre-existing
 * gap on the C/LLVM lanes' own generic crossing site), but every
 * CONSUMER here reads the flag for real, so a future provenance fix is a
 * one-line change at the construction site, not a second pass through
 * every arm. */
export const BYTES_PAYLOAD_REF = 0;
export const BYTES_PAYLOAD_IS_BUFFER = 1;

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
  /** The builtin error struct (`class:err`): `{ vt, name, message, %code }`.
   * The `%error` encoding reads name/message/%code out of it, and a user
   * `extends Error` class SUBTYPES it, so one parameter type takes every
   * error this tier can build. */
  errT: () => number;
  /** Field indices into `errT` — the emitter owns the layout, so it names
   * the slots rather than letting this file assume them. */
  errName: () => number;
  errMessage: () => number;
  errCode: () => number;
  /** Fill the exception cell with a fresh error of `className` (its `name`
   * is the JS-visible spelling), message built at runtime. The plain-Error
   * twin of `throwTypeError`: the invoke surface's "not supported yet"
   * fences are `Error`, not `TypeError`, exactly as C throws them. */
  throwError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void) => void;
  /** The exception cell's kind global — 0 when nothing is pending. The
   * invoke helpers test it after a sub-helper that may have thrown, which
   * is C's `if (scr_exc_pending()) return NULL`. */
  excKind: () => number;
  /** %w.strCmpU16 — the ECMAScript code-UNIT ordering. The default
   * `sort` comparator's, and the reason S005's flag exists. */
  strCmpU16: () => number;
  /** %w.str.slice — (s, f64 start, f64 end) → str, relative boundaries. */
  strSlice: () => number;
  /** %w.str.indexOf — (s, needle, f64 from) → f64. */
  strIndexOf: () => number;
  /** %w.str.matchAt — (s, needle, i32 at) → i32. `lastIndexOf`'s backward
   * scan is a loop over it (the tier has no lastIndexOf of its own). */
  strMatchAt: () => number;
  /** The tier's ONE bytes<u8> valtype (typedarrays.ts) — the SAME struct
   * every elem kind shares, needed here as the DK.BYTES payload's element
   * type. Non-u8 elems never reach this file (the emitter's dynFrom/
   * dynMatch/dynCheck refuse them by name before calling in). */
  bytesRefU8: () => ValType;
  /** The bytes<u8> STRUCT type index (refCast on extraction). */
  bytesTypeU8: () => number;
  /** %w.bytes.length:u8 — (bytes<u8>) → f64 element count (== byte count
   * for u8). Reused here rather than re-deriving a BLEN field read, since
   * typedarrays.ts already owns that struct's layout privately. */
  bytesLen: () => number;
  /** %w.bytes.get:u8 — (bytes<u8>, f64 index) → f64 byte value. OOB
   * TRAPS (S003) — every caller here bounds-checks first (canonIdx +
   * bytesLen), matching the ARR/STR arms' own discipline. */
  bytesGet: () => number;
  /** %w.bytes.set:u8 — (bytes<u8>, f64 index, f64 value) → (); OOB TRAPS
   * — every caller here bounds-checks first, same discipline as
   * `bytesGet`. Coerces the value JS-exactly (stage A: modular ToUint8),
   * matching a typed-array element assignment's own coercion. */
  bytesSet: () => number;
  /** %w.bytes.toStr:utf8 — (bytes<u8>) → str; Buffer's default
   * `toString()`/`String(buf)` decode (stage B, already Node-exact WHATWG
   * replacement behavior). Only the ISBUFFER arm of `toStr` calls this —
   * a plain Uint8Array's default stringification joins ELEMENT VALUES
   * with commas instead (measured: `String(new Uint8Array([1,2,3]))` is
   * `"1,2,3"`, not a UTF-8 decode). */
  bytesToStrUtf8: () => number;
  /** %w.jsToNumber — the full ECMA-262 ToNumber over a dyn value (NUM
   * passes through, STR runs StringToNumber, everything else its own
   * documented rule). Injected rather than re-derived here (increment
   * 21 review round 1, SB3/SB4): this tier had "no general dyn
   * ToNumber" (this file's own earlier note, `idxArg`'s precedent) only
   * because nothing NEEDED one yet — a `toFixed`/`toString` ARGUMENT
   * (`(5).toFixed("2")`) is exactly ToNumber's contract, the same
   * conversion the emitter's coercion ops already build. */
  jsToNumber: () => number;
}

export class DynBuilder {
  private dynType: number | null = null;
  private pathType: number | null = null;
  private entryType: number | null = null;
  private objType: number | null = null;
  private objEntriesType: number | null = null;
  private bytesPayloadType: number | null = null;
  private fnType: number | null = null;
  private thunkSigType: number | null = null;
  private readonly consts = new Map<string, number>();
  private readonly fns = new Map<string, number>();
  /** The ambient-`this` stack (thisPush/thisPop/thisGet below): a
   * nullable buffer global plus a separate length global, exactly
   * json.ts's `seen`/`seenLen` circular-check stack shape. */
  private thisStackBufG: number | null = null;
  private thisStackLenG: number | null = null;

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

  /** The OBJ payload's entries-array type index — public because the
   * width-CAPTURE walkers (emitter.ts's dynCheck/dynMatch/dynFrom record
   * arms) iterate a source object's RAW entries directly (storage/
   * insertion order, not objWalk's own-key-order transform), the same way
   * emitter.ts already pokes UnionBuilder's base struct fields directly. */
  entriesArrayType(): number {
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

  /* ── the BYTES payload (increment 18 stage C) ──────────────────────────
   * `$dynBytes` — { bytes: bytes<u8> ref, isBuffer: i32 } — mirrors
   * `$dynObj`'s shape exactly (a payload struct wrapping the real value
   * plus a flag). Unlike every OTHER composite payload, this one ALIASES:
   * `bytes` holds the SAME `$bytes` struct reference the source value
   * already had, never a copy (SEMANTICS.md S014's registered bytes
   * exception — acyclic-by-construction, so the cycle-safety argument
   * that keeps every OTHER composite copying does not apply here). ───── */

  /** `$dynBytes`'s struct type — const fields (construction-complete like
   * `$dyn` itself; nothing here ever needs a write after `struct.new`,
   * since the flag is fixed at crossing time and the aliased ref never
   * changes identity). */
  bytesPayloadT(): number {
    this.bytesPayloadType ??= this.mb.openStructType("dyn:bytes", [
      { storage: this.deps.bytesRefU8(), mutable: false },
      { storage: I32, mutable: false },
    ]);
    return this.bytesPayloadType;
  }

  bytesPayloadRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bytesPayloadT() };
  }

  /** A fresh BYTES payload wrapping the ALIASED `$bytes` ref the caller
   * pushes — PUSH ORDER: (bytesRef, isBuffer already pushed by caller as
   * i32). No copy anywhere in this file; the copy-vs-alias decision was
   * already made by the caller choosing what to push. */
  pushNewBytesPayload(c: Code, pushBytes: (c: Code) => void, pushIsBuffer: (c: Code) => void): void {
    pushBytes(c);
    pushIsBuffer(c);
    c.structNew(this.bytesPayloadT());
  }

  /** Wrap a BYTES payload the caller pushes into a DK.BYTES box. */
  boxBytes(c: Code, pushPayload: (c: Code) => void): void {
    c.i32Const(DK.BYTES);
    c.f64Const(0);
    pushPayload(c);
    c.structNew(this.dynT());
  }

  /** From a `$dyn` the caller pushes, its BYTES payload struct (the
   * `{bytes, isBuffer}` wrapper — NOT the `$bytes` ref itself; callers
   * needing the raw bytes value chain through `bytesPayloadBytes` too). */
  bytesPayload(c: Code, pushDyn: (c: Code) => void): void {
    pushDyn(c);
    c.structGet(this.dynT(), DYN_REF);
    c.refCast(this.bytesPayloadT());
  }

  /** From a `$dyn` the caller pushes, the ALIASED `$bytes` ref directly —
   * the extraction-direction helper (`dynMatch`/`dynCheck`'s bytes<u8>
   * arm): both directions of the boundary alias, so this returns the
   * SAME reference `dynFrom` originally boxed, not a fresh struct. */
  bytesPayloadBytes(c: Code, pushDyn: (c: Code) => void): void {
    this.bytesPayload(c, pushDyn);
    c.structGet(this.bytesPayloadT(), BYTES_PAYLOAD_REF);
  }

  /** The `$bytes` ref's element count as i32 — `deps.bytesLen` returns
   * f64 (typedarrays.ts's own convention), truncated back down for the
   * i32 index-bound comparisons every caller here needs. Public: json.ts's
   * dyn-root stringify walk needs the same bound. */
  bytesLenI32(c: Code, pushBytes: (c: Code) => void): void {
    pushBytes(c);
    c.call(this.deps.bytesLen());
    c.i32TruncF64S();
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

  /* ── the FUNC payload ───────────────────────────────────────────────── */

  /** The uniform call-glue signature every emitted thunk has: the boxed
   * closure (as `eq`, cast back inside), the argument vector, answering an
   * owned dyn. C's `ScrDynThunk` with the (args, argc) pair collapsed into
   * the vector that already carries its own length. A mismatch leaves the
   * catchable path-annotated TypeError pending and answers null, exactly
   * C's contract. */
  thunkSig(): number {
    this.thunkSigType ??= this.mb.funcType(
      [{ kind: "ref", nullable: true, typeIndex: EQ_HEAP }, this.arrRef()],
      [this.dynRef()],
    );
    return this.thunkSigType;
  }

  /** `$dynFn` — the FUNC payload. Keyed by MEANING like `$dyn` itself:
   * a later `ref.cast` has to be able to name this struct alone. */
  fnT(): number {
    this.fnType ??= this.mb.openStructType("dyn:fn", [
      { storage: { kind: "ref", nullable: true, typeIndex: EQ_HEAP }, mutable: false },
      { storage: { kind: "ref", nullable: true, typeIndex: this.thunkSig() }, mutable: false },
      { storage: I32, mutable: false },
      { storage: this.deps.strRef(), mutable: false },
      { storage: I32, mutable: false },
    ]);
    return this.fnType;
  }

  fnRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.fnT() };
  }

  /** Wrap a `$dynFn` payload the caller pushes into a FUNC box. */
  boxFunc(c: Code, pushFn: (c: Code) => void): void {
    c.i32Const(DK.FUNC);
    c.f64Const(0);
    pushFn(c);
    c.structNew(this.dynT());
  }

  /** From a `$dyn` the caller pushes, its FUNC payload. */
  fnPayload(c: Code, pushDyn: (c: Code) => void): void {
    pushDyn(c);
    c.structGet(this.dynT(), DYN_REF);
    c.refCast(this.fnT());
  }

  /** Build the whole FUNC box from its five operands —
   * `scr_dyn_new_func`. The CLOSURE the caller pushes must be the boxed
   * value's OWN closure (the interned per-function global, or the
   * capturing env's `struct.new`), never the calling ABI's dead
   * `ref.null` argument: FN_CLOS is `eq`, `ref.eq(null, null)` is TRUE,
   * and two functions boxed with a null closure would answer `f === g`
   * true. C is immune because a ScrClosure is always a real pointer; here
   * the discipline is the caller's. `pushName` pushes NULL for an
   * anonymous value — never the empty string, which keyGet's `name` arm
   * substitutes at READ time (C's `d->v.fn.name ? : ""`). */
  boxFn(
    c: Code,
    pushClos: (c: Code) => void,
    pushThunk: (c: Code) => void,
    sig: number,
    pushName: (c: Code) => void,
    arity: number,
  ): void {
    this.boxFunc(c, (x) => {
      pushClos(x);
      pushThunk(x);
      x.i32Const(sig);
      pushName(x);
      x.i32Const(arity);
      x.structNew(this.fnT());
    });
  }

  /** %w.dyn.call(d, args, what) → the call's result — `scr_dyn_call`
   * ported. A non-FUNC callee throws Node's catchable
   * "<what> is not a function" (SEMANTICS.md S018: `what` is the source
   * spelling the lowering threaded through, which V8 re-renders from its
   * own AST for a few shapes); a FUNC callee dispatches through its boxed
   * thunk, which owns the per-argument validation because it is the piece
   * compiled per SIGNATURE. Args ride the vector the caller built; a null
   * answer means the thunk left an exception pending, exactly C's
   * contract.
   *
   * PLACEHOLDER RESCUE (increment 21 stage B review watch item): a FUNC
   * value CAN be a `nativeMethodPlaceholderHelper` placeholder — one of
   * the six Number.prototype names extracted via destructuring
   * (`const { toFixed } = 5;`), which is a real FUNC box with a NULL
   * thunk (its whole reason to be a placeholder rather than a real
   * closure). Calling it via the ORIGINAL `callRef` path unconditionally
   * would `call_ref` a null reference — a bare wasm trap where Node
   * either produces real output (`.call`/`.apply` with a Number `this`,
   * 2084's own corpus need) or throws a real, catchable, EXACT-message
   * TypeError (a bare/mismatched-receiver call — oracle-measured,
   * scratchpad/oracle2/watch-item.mjs + placeholder-six.mjs: uniformly
   * "Number.prototype.<name> requires that 'this' be a Number" for all
   * six names). getProp's OWN dispatch helper already fences every OTHER
   * prototype's members at the READ, before a placeholder could ever be
   * minted (F1/F2's own doc) — so a null-thunk FUNC reaching here is
   * ALWAYS one of exactly these six names; the dispatch below does not
   * need to handle any other prototype. */
  callFn(): number {
    return this.cached(
      "call",
      [this.dynRef(), this.arrRef(), this.deps.strRef()],
      [this.dynRef()],
      (idx) => {
        const dynT = this.dynT();
        const fnT = this.fnT();
        const dynRef = this.dynRef();
        const strRef = this.deps.strRef();
        const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.thunkSig() };
        const c = new Code();
        const MSG = 3;
        const THUNK = 4;
        const NAME = 5;
        const RECV = 6;
        const ARG0 = 7;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.FUNC);
        c.i32Ne();
        c.ifVoid();
        c.localGet(2);
        this.deps.lit(c, " is not a function");
        c.call(this.deps.concat());
        c.localSet(MSG);
        this.deps.throwTypeError(c, (x) => x.localGet(MSG));
        c.refNull(dynT);
        c.return_();
        c.end();
        this.fnPayload(c, (x) => x.localGet(0));
        c.structGet(fnT, FN_THUNK);
        c.localTee(THUNK);
        c.refIsNull();
        c.ifResult(dynRef);
        {
          // A placeholder (nativeMethodPlaceholderHelper's null-thunk
          // FUNC): FN_NAME carries the extracted Number.prototype name
          // directly (a plain strRef field, set to the same value as
          // FN_CLOS for exactly this reason). getProp's own dispatch
          // fences every OTHER prototype's members before a placeholder
          // could ever be minted, so this is always one of the six.
          this.fnPayload(c, (x) => x.localGet(0));
          c.structGet(fnT, FN_NAME);
          c.localSet(NAME);
          c.call(this.thisGet());
          c.localSet(RECV);
          // arg 0 (the ONLY argument any modeled name here reads),
          // undefined past the end.
          c.localGet(1);
          c.structGet(this.deps.arrVec().struct, VEC_LEN);
          c.i32Eqz();
          c.ifResult(dynRef);
          c.globalGet(this.undefinedGlobal());
          c.else_();
          this.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(0));
          c.end();
          c.localSet(ARG0);
          c.localGet(RECV);
          c.structGet(dynT, DYN_KIND);
          c.i32Const(DK.NUM);
          c.i32Eq();
          c.ifResult(dynRef);
          {
            c.localGet(NAME);
            this.deps.lit(c, "toFixed");
            c.call(this.deps.strEq());
            c.ifResult(dynRef);
            this.boxStr(c, (x) => {
              x.localGet(RECV);
              x.structGet(dynT, DYN_NUM);
              x.localGet(ARG0);
              // Full ToNumber (review round 1, SB4) — the SAME coercion
              // the invoke() ladder's own toFixed call site now applies,
              // for the SAME reason: a non-NUM argument (a string digits
              // count, `undefined` past the end) is a real shape, not
              // just an unmeasured one.
              x.call(this.deps.jsToNumber());
              x.call(this.toFixed());
            });
            c.else_();
            {
              c.localGet(NAME);
              this.deps.lit(c, "toString");
              c.call(this.deps.strEq());
              c.ifResult(dynRef);
              this.boxStr(c, (x) => {
                x.localGet(RECV);
                x.structGet(dynT, DYN_NUM);
                x.call(this.deps.f64ToStr());
              });
              c.else_();
              {
                c.localGet(NAME);
                this.deps.lit(c, "valueOf");
                c.call(this.deps.strEq());
                c.ifResult(dynRef);
                c.localGet(RECV);
                c.else_();
                // Unmodeled NAME (toLocaleString/toExponential/toPrecision),
                // but `this` genuinely IS a Number here (review round 1,
                // SB10 — sbF1b): Node does NOT throw for
                // `Number.prototype.toPrecision.call(5)` (it answers "5"),
                // so the "requires that 'this' be a Number" text would be
                // a FALSE CLAIM about a receiver that is exactly right. An
                // honest "not supported yet" instead — this file's own
                // S023-style wording, matching `throwUnsupported`'s
                // pattern in the `invoke` ladder above.
                this.pushUnmodeledNumberMethodFence(c, NAME, MSG);
                c.end();
              }
              c.end();
            }
            c.end();
          }
          c.else_();
          // `this` is NOT a Number (the bare/mismatched-receiver call) —
          // Node's own exact, uniform text for all six placeholder names.
          this.pushPlaceholderFence(c, NAME, MSG);
          c.end();
        }
        c.else_();
        {
          this.fnPayload(c, (x) => x.localGet(0));
          c.structGet(fnT, FN_CLOS);
          c.localGet(1);
          c.localGet(THUNK);
          c.callRef(this.thunkSig());
        }
        c.end();
        this.mb.setBody(idx, [strRef, thunkRef, strRef, dynRef, dynRef], c.bytes());
      },
    );
  }

  /** The runtime fence for a placeholder called with a non-Number `this`
   * (the bare/mismatched-receiver call) — Node's own uniform, CORRECT
   * message: oracle-measured, ALL SIX names share the identical
   * "Number.prototype.<name> requires that 'this' be a Number" shape
   * (scratchpad/oracle2/placeholder-six.mjs) — built from the RUNTIME
   * name rather than six per-name compile-time strings. `msgLocal` is
   * the CALLER's own scratch local (this function has no locals of its
   * own — it only emits into whichever body is currently being built).
   * Review round 1, SB10: this text is ONLY correct for a genuinely
   * wrong receiver — see `pushUnmodeledNumberMethodFence` for the
   * SIBLING case (right receiver, unimplemented name) this used to
   * conflate with it. */
  private pushPlaceholderFence(c: Code, nameLocal: number, msgLocal: number): void {
    this.deps.lit(c, "Number.prototype.");
    c.localGet(nameLocal);
    c.call(this.deps.concat());
    this.deps.lit(c, " requires that 'this' be a Number");
    c.call(this.deps.concat());
    c.localSet(msgLocal);
    this.deps.throwTypeError(c, (x) => x.localGet(msgLocal));
    c.refNull(this.dynT());
  }

  /** The "not supported yet" fence for an UNMODELED placeholder name
   * (toLocaleString/toExponential/toPrecision — no measured need) called
   * with a `this` that genuinely IS a Number (review round 1, SB10,
   * sbF1b) — oracle-measured: `Number.prototype.toPrecision.call(5)`
   * does NOT throw in Node (it answers "5"), so `pushPlaceholderFence`'s
   * "requires that 'this' be a Number" text was a FALSE CLAIM about a
   * receiver this tier simply has no implementation for yet. This is
   * this file's own S023-style wording (the `invoke` ladder's
   * `throwUnsupported`, same shape, a plain catchable Error rather than
   * a TypeError so a `catch (e) { e instanceof TypeError }` handler does
   * not mistake a missing feature for the real thing). */
  private pushUnmodeledNumberMethodFence(c: Code, nameLocal: number, msgLocal: number): void {
    this.deps.lit(c, "'Number.prototype.");
    c.localGet(nameLocal);
    c.call(this.deps.concat());
    this.deps.lit(c, "' on a dynamic value is not supported yet");
    c.call(this.deps.concat());
    c.localSet(msgLocal);
    this.deps.throwError(c, "%Error", "Error", (x) => x.localGet(msgLocal));
    c.refNull(this.dynT());
  }

  /* ── the ambient receiver (dyn.this) ─────────────────────────────────
   * scr_json.c:1005-1064's push/pop/get stack, ported: a strictly nested
   * stack of dyn values over the SAME buffer shape json.ts's `seen`
   * circular-check stack uses (nullable buffer global, doubling growth
   * from 8, a separate length global) — one array shorter, since the
   * stored value already IS the payload (no wrapper struct/entry type
   * needed the way a "seen" frame's identity+edge bookkeeping does).
   *
   * PUSH SITES (measured against scr_dyn_invoke.c, matched exactly
   * below): the OBJ arm's own-member call (`invoke()`'s DK.OBJ arm,
   * scr_dyn_invoke.c:358-363 — `scr_dyn_this_push_dyn(recv)`) and FUNC's
   * apply/call (scr_dyn_invoke.c:370-397 — the explicit thisArg,
   * `args[0]` or undefined). C's third FUNC-kind push site — an own
   * property on the FUNC box itself (scr_dyn_invoke.c:406-417, the
   * defineProperties-expando case) — has no wasm arm to bracket: this
   * backend's `invoke()` has no FUNC-own-property fallback at all
   * (unrelated pre-existing gap, falls to the generic not-a-function
   * tail), so there is nothing to wire there.
   *
   * Every push/pop pair below sits around exactly one `callFn()` call,
   * unconditionally popped after it returns — C's shape too: the
   * pending-flag exception protocol (never a wasm try/catch unwind)
   * means `scr_dyn_this_pop()` already runs on the throw path in C
   * because there IS no separate unwind edge, only the one fall-through
   * after the call returns. The wasm port is bracket-for-bracket the
   * same: `callFn()` returns (possibly null, exception pending) exactly
   * like `scr_dyn_call` does, and the pop below runs on that single
   * fall-through path regardless.
   *
   * SUSPENSION HAZARD, FENCED (not ported — statemachine.ts's
   * `checkEligible()`, `libCall:dyn.this:suspending`): a dyn FUNC boxed
   * from an async source function can suspend INSIDE `callFn()`'s
   * `callRef` at its first await and return a pending Promise
   * synchronously (statemachine.ts's wrapper/resume split — calling a
   * resumable function runs only state 0, then returns) — the pop below
   * then runs immediately, before the async body logically finishes.
   * Resumption (promises.ts's `drain()`) calls the stored continuation
   * directly, never through `invoke()`/`callFn()`, so a `dyn.this` read
   * AFTER that first await would see whatever is on the stack when the
   * microtask pump happens to run it, not the receiver this call bound
   * — a silent wrong answer no exact-value pin on the synchronous case
   * would catch. C's fiber-based lane has no such gap: a fiber
   * suspend/resume switches the OS stack under the call rather than
   * returning through it, so the C push/pop bracket really does span
   * the whole async body, awaits included — there is nothing to port
   * for that lane. Because every `this` read refused outright before
   * this file existed, ANY suspendable body reaching a `dyn.this` read
   * is a NEWLY OPENED window, so statemachine.ts's `checkEligible()`
   * refuses the WHOLE body the moment one appears anywhere in it
   * (before/after a suspension point undistinguished — conservative
   * over clever), before any lowering transforms it. See that file for
   * the fence itself; the bracket below stays exactly the C-matching
   * shape for every body that clears it. */

  private thisStackBufType(): number {
    // Exactly arrVec()'s "dyn" element array, reused rather than
    // re-declared: types intern BY SHAPE (module.ts), so a second
    // declaration of `(array (mut (ref null $dyn)))` would collide with
    // this one anyway — asking for it by name is just honest about that.
    return this.deps.arrVec().bufType;
  }

  private thisStackBuf(): number {
    this.thisStackBufG ??= this.mb.addGlobal(
      { kind: "ref", nullable: true, typeIndex: this.thisStackBufType() },
      true,
      (w) => {
        w.u8(0xd0); // ref.null
        w.sleb(this.thisStackBufType());
      },
    );
    return this.thisStackBufG;
  }

  private thisStackLen(): number {
    this.thisStackLenG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const
      w.sleb(0);
    });
    return this.thisStackLenG;
  }

  /** %w.dyn.thisPush(v) — `scr_dyn_this_push_dyn` ported: append v,
   * growing the backing buffer by doubling from 8 on overflow (json.ts's
   * `jbEnter` growth, one array shorter). */
  thisPush(): number {
    return this.cached("thisPush", [this.dynRef()], [], (idx) => {
      const bufT = this.thisStackBufType();
      const c = new Code();
      const V = 0;
      const N = 1;
      const NB = 2;
      c.globalGet(this.thisStackLen());
      c.localSet(N);
      c.globalGet(this.thisStackBuf());
      c.refIsNull();
      c.ifVoid();
      c.i32Const(8);
      c.arrayNewDefault(bufT);
      c.globalSet(this.thisStackBuf());
      c.end();
      c.globalGet(this.thisStackBuf());
      c.arrayLen();
      c.localGet(N);
      c.i32LeU();
      c.ifVoid();
      c.globalGet(this.thisStackBuf());
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.arrayNewDefault(bufT);
      c.localSet(NB);
      c.localGet(NB);
      c.i32Const(0);
      c.globalGet(this.thisStackBuf());
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(bufT, bufT);
      c.localGet(NB);
      c.globalSet(this.thisStackBuf());
      c.end();
      c.globalGet(this.thisStackBuf());
      c.localGet(N);
      c.localGet(V);
      c.arraySet(bufT);
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.thisStackLen());
      this.mb.setBody(idx, [I32, { kind: "ref", nullable: true, typeIndex: bufT }], c.bytes());
    });
  }

  /** %w.dyn.thisPop() — `scr_dyn_this_pop` ported. The vacated slot is
   * left in place (frames are reused across pushes, exactly the
   * "seen" stack's rule) — nothing to release: WasmGC owns the entry,
   * unlike C's manual retain/release pair around the same bracket. */
  thisPop(): number {
    return this.cached("thisPop", [], [], (idx) => {
      const c = new Code();
      c.globalGet(this.thisStackLen());
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(this.thisStackLen());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** %w.dyn.thisGet() — `scr_dyn_this_get` ported: the top-of-stack dyn
   * value, or the interned undefined singleton on an empty stack (the
   * strict-mode plain-call constant lower-exprs.ts's `dyn.this` comment
   * names). */
  thisGet(): number {
    return this.cached("thisGet", [], [this.dynRef()], (idx) => {
      const bufT = this.thisStackBufType();
      const c = new Code();
      c.globalGet(this.thisStackLen());
      c.i32Eqz();
      c.ifResult(this.dynRef());
      c.globalGet(this.undefinedGlobal());
      c.else_();
      c.globalGet(this.thisStackBuf());
      c.refAsNonNull();
      c.globalGet(this.thisStackLen());
      c.i32Const(1);
      c.i32Sub();
      c.arrayGet(bufT);
      c.refAsNonNull();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
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
   * FUNC compares the boxed CLOSURE, C's own payload-identity arm; the
   * two remaining payload-identity kinds (HANDLE, JSVAL) are
   * unconstructible here and trap rather than borrow that answer.
   *
   * Its caller is `dynScalarEq` with BOTH operands dyn, so `f === g` over
   * two boxed functions arrives here — which is exactly why FN_CLOS must
   * be sourced from the closure value itself. Two boxes built over a null
   * closure would answer `true` (ref.eq on two nulls is true), silently;
   * `boxFn` spells the discipline that prevents it. */
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
      // crossing the boundary twice is still ONE JS function value, and
      // the box is a boundary artifact. C's compare exactly
      // (scr_json.c:2292): the boxes, OR the closures they carry.
      this.arm(c, K, [DK.FUNC], () => {
        c.localGet(0);
        c.localGet(1);
        c.refEq();
        this.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.fnT(), FN_CLOS);
        this.fnPayload(c, (x) => x.localGet(1));
        c.structGet(this.fnT(), FN_CLOS);
        c.refEq();
        c.i32Or();
      });
      this.arm(c, K, [DK.PROMISE], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.localGet(1);
        c.structGet(dynT, DYN_REF);
        c.refEq();
      });
      // BYTES compares the ALIASED `$bytes` PAYLOAD, never the `$dynBytes`
      // WRAPPER and never the `$dyn` BOX — deliberately NOT the ARR/OBJ/
      // BYTES box-identity default just below. Those two kinds always
      // COPY on crossing (S014), so a box comparison and a payload
      // comparison coincide for them (every crossing mints a fresh box
      // AND a fresh payload together). BYTES is S014's registered
      // exception: it ALIASES, so the SAME source value crossing `unknown`
      // via two independent `dynFrom` calls produces two DIFFERENT boxes
      // (and, since `pushNewBytesPayload` also runs per call, two
      // different `$dynBytes` wrappers) around the IDENTICAL `$bytes`
      // ref — Node's `u1 === u2` is true there (erased casts hand back
      // the same object), so this must compare past both wrapper layers
      // to the shared payload to agree (SEMANTICS.md's S014 bytes
      // amendment, unit-pinned: "crossing twice is === through unknown").
      this.arm(c, K, [DK.BYTES], () => {
        this.bytesPayloadBytes(c, (x) => x.localGet(0));
        this.bytesPayloadBytes(c, (x) => x.localGet(1));
        c.refEq();
      });
      // HANDLE and JSVAL have their OWN arms in C and do NOT fall into the
      // default: a handle compares its payload (tag + pointer,
      // scr_json.c:2297) and an island value routes to the ENGINE's
      // strict equality (scr_json.c:2304). Neither is constructible on
      // this tier, so neither may borrow the box-identity answer below —
      // that would be a wrong answer rather than a loud one.
      this.arm(c, K, [DK.HANDLE, DK.JSVAL], () => c.unreachable());
      // ARR/OBJ — and ONLY those two now (BYTES has its own arm above):
      // C's `default: return a == b` (scr_json.c:2310). Node identity is
      // the dyn tree's object identity because those kinds are never
      // reboxed.
      c.localGet(0);
      c.localGet(1);
      c.refEq();
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** %w.dyn.svZero(a, b) → i32 — SameValueZero: `===` with exactly one
   * arm changed, NaN matching NaN. `Array.prototype.includes` is the only
   * caller, because it is the only method in this file the spec routes
   * here — `indexOf` and `lastIndexOf` keep strict equality, so
   * `[1,2,NaN].includes(NaN)` is true while `[1,2,NaN].indexOf(NaN)` is
   * -1. That split is JS's own, not an inconsistency of ours. The other
   * direction (+0 matching -0) needs no arm: `f64.eq` already answers it
   * inside `strictEq`, and SameValueZero wants the same answer. */
  svZero(): number {
    return this.cached("svZero", [this.dynRef(), this.dynRef()], [I32], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.call(this.strictEq());
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      // The one pair strict equality answers false for and this answers
      // true: both NUM, both NaN. NaN is the only double failing `n == n`.
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NUM);
      c.i32Eq();
      c.localGet(1);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NUM);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.localGet(0);
      c.structGet(dynT, DYN_NUM);
      c.localGet(0);
      c.structGet(dynT, DYN_NUM);
      c.f64Ne();
      c.localGet(1);
      c.structGet(dynT, DYN_NUM);
      c.localGet(1);
      c.structGet(dynT, DYN_NUM);
      c.f64Ne();
      c.i32And();
      c.return_();
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [], c.bytes());
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
      const O = 7;
      const BP = 8;
      const BR = 9;
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
        // message"), not "[object Object]". Every other object takes the
        // default text.
        this.objPayload(c, (x) => x.localGet(0));
        c.localTee(O);
        this.deps.lit(c, "%error");
        c.call(this.objGet());
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(O);
        c.call(this.errStr());
        c.return_();
        c.end();
        this.deps.lit(c, "[object Object]");
      });
      // Object.prototype.toString with the Promise @@toStringTag.
      this.arm(c, K, [DK.PROMISE], () => this.deps.lit(c, "[object Promise]"));
      // The runtime handles inherit Object.prototype.toString.
      this.arm(c, K, [DK.HANDLE], () => this.deps.lit(c, "[object Object]"));
      // Function.prototype.toString, C's arm exactly: the SOURCE a JS
      // engine would echo is gone in a compiled program, so this renders
      // the native-code form engines print for their own non-JS
      // functions — "function <name>() { [native code] }", with the name
      // simply absent (and its space kept) when the value is anonymous.
      // SEMANTICS.md S019.
      this.arm(c, K, [DK.FUNC], () => {
        this.deps.lit(c, "function ");
        this.fnPayload(c, (x) => x.localGet(0));
        c.structGet(this.fnT(), FN_NAME);
        c.localTee(OUT);
        c.refIsNull();
        c.ifResult(this.deps.strRef());
        this.deps.lit(c, "");
        c.else_();
        c.localGet(OUT);
        c.end();
        c.call(concat);
        this.deps.lit(c, "() { [native code] }");
        c.call(concat);
      });
      // BYTES' text depends on the Buffer flag: a plain Uint8Array joins
      // ELEMENT VALUES with commas (Array.prototype.toString's own rule,
      // typed arrays inherit it — measured: `String(new Uint8Array([1,2,
      // 3]))` is "1,2,3"); a Buffer instead runs its own `toString()`
      // override, a UTF-8 decode (stage B's `toStrHelper("utf8")`,
      // already Node-exact WHATWG replacement behavior) — measured:
      // `String(Buffer.from([1,2,3]))` is three control characters, NOT
      // "1,2,3". The isBuffer flag is currently always false at the one
      // generic crossing site (SEMANTICS.md S037), so only the comma-join
      // half is reachable TODAY — the branch is built anyway so the day
      // the flag can be true, nothing here needs revisiting.
      this.arm(c, K, [DK.BYTES], () => {
        this.bytesPayload(c, (x) => x.localGet(0));
        c.localTee(BP);
        c.structGet(this.bytesPayloadT(), BYTES_PAYLOAD_IS_BUFFER);
        c.ifResult(this.deps.strRef());
        c.localGet(BP);
        c.structGet(this.bytesPayloadT(), BYTES_PAYLOAD_REF);
        c.call(this.deps.bytesToStrUtf8());
        c.else_();
        this.deps.lit(c, "");
        c.localSet(OUT);
        c.localGet(BP);
        c.structGet(this.bytesPayloadT(), BYTES_PAYLOAD_REF);
        c.localSet(BR);
        this.bytesLenI32(c, (x) => x.localGet(BR));
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
        c.localGet(OUT);
        c.localGet(BR);
        c.localGet(I);
        c.f64ConvertI32U();
        c.call(this.deps.bytesGet());
        c.call(this.deps.f64ToStr());
        c.call(concat);
        c.localSet(OUT);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
        c.end();
      });
      // HANDLE and JSVAL remain unconstructible on this tier.
      this.arm(c, K, [DK.HANDLE, DK.JSVAL], () => c.unreachable());
      c.unreachable();
      this.mb.setBody(
        idx,
        [
          I32,
          this.deps.strRef(),
          I32,
          I32,
          this.arrRef(),
          this.dynRef(),
          this.objRef(),
          this.bytesPayloadRef(),
          this.deps.bytesRefU8(),
        ],
        c.bytes(),
      );
    });
  }

  /** %w.dyn.errStr(obj) → the ERROR encoding's text: Error.prototype
   * .toString over the `name`/`message` members the `%error` marker sits
   * beside — Node's `String(err)`, which carries no stack either. The
   * spec's two empty-side rules fall out of C's rendering (name alone,
   * message alone, the ": " only when both are non-empty), and a member
   * that is absent or non-STR simply contributes nothing.
   *
   * SHORT-CIRCUIT HAZARD: the four-way `ens && ens->len && ems &&
   * ems->len` C writes cannot be spelled with `i32.and`, which evaluates
   * BOTH sides — `array.len` on a null string traps. Hence the nest. */
  errStr(): number {
    return this.cached("errStr", [this.objRef()], [this.deps.strRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const NS = 1;
      const MS = 2;
      const OUT = 3;
      const M = 4;
      const concat = this.deps.concat();
      // The two members, each kept only when it is really a string.
      const member = (key: string, slot: number): void => {
        c.localGet(0);
        this.deps.lit(c, key);
        c.call(this.objGet());
        c.localTee(M);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(M);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.STR);
        c.i32Eq();
        c.ifVoid();
        c.localGet(M);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.localSet(slot);
        c.end();
        c.end();
      };
      member("name", NS);
      member("message", MS);
      this.deps.lit(c, "");
      c.localSet(OUT);
      c.localGet(NS);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(NS);
      c.localSet(OUT);
      // ": " only when BOTH sides carry text.
      c.localGet(NS);
      c.arrayLen();
      c.ifVoid();
      c.localGet(MS);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(MS);
      c.arrayLen();
      c.ifVoid();
      c.localGet(OUT);
      this.deps.lit(c, ": ");
      c.call(concat);
      c.localSet(OUT);
      c.end();
      c.end();
      c.end();
      c.end();
      c.localGet(MS);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(OUT);
      c.localGet(MS);
      c.call(concat);
      c.localSet(OUT);
      c.end();
      c.localGet(OUT);
      this.mb.setBody(
        idx,
        [this.deps.strRef(), this.deps.strRef(), this.deps.strRef(), this.dynRef()],
        c.bytes(),
      );
    });
  }

  /** %w.dyn.isError(d) → i32 — `d instanceof Error` over a dyn value: the
   * reserved `%error` key's presence and nothing else, which is what
   * `dynTest` "error" asks (nodes.ts). Only `caughtToDyn` and the
   * error-rooted `dynFrom` mint the encoding, so the marker IS the
   * question. Subclass identity is a different question and a different
   * node (`dyn.errInstanceof`). */
  isError(): number {
    return this.cached("isError", [this.dynRef()], [I32], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.structGet(this.dynT(), DYN_KIND);
      c.i32Const(DK.OBJ);
      c.i32Eq();
      // Nested rather than `i32.and`: the payload cast below is only
      // sound once the kind is known.
      c.ifResult(I32);
      this.objPayload(c, (x) => x.localGet(0));
      this.deps.lit(c, "%error");
      c.call(this.objGet());
      c.refIsNull();
      c.i32Eqz();
      c.else_();
      c.i32Const(0);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
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
        // BYTES: the ARR arm with the element source swapped. "length"
        // still READS correctly here (this is keyGet, not hasOwn/objWalk
        // — being own-key-absent doesn't make it unreadable, exactly
        // like `"abc".length` reading fine despite string length also
        // being non-own on primitives' boxed form). "byteLength" reads
        // the SAME count: this tier's bytes<u8> representation is
        // ALWAYS single-byte elements (canExitIslandToType admits only
        // `elem === "u8"`), so a typed array's `.length` and
        // `.byteLength` are the identical number by construction —
        // measured against Node (both non-own, Object.hasOwn/keys agree
        // unaffected; only the READ gains the second spelling, increment
        // 21 gate 4's own jsExit-composite work newly reaching this
        // shape through an unchecked-overload `Uint8Array`-declared
        // island result).
        this.arm(c, K, [DK.BYTES], () => {
          this.pushIsLength(c, (x) => x.localGet(1));
          c.localGet(1);
          this.deps.lit(c, "byteLength");
          c.call(this.deps.strEq());
          c.i32Or();
          c.ifVoid();
          this.boxNum(c, (x) => {
            this.bytesLenI32(x, (y) => this.bytesPayloadBytes(y, (z) => z.localGet(0)));
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
          this.bytesLenI32(c, (x) => this.bytesPayloadBytes(x, (y) => y.localGet(0)));
          c.i32LtU();
          c.ifVoid();
          this.boxNum(c, (x) => {
            this.bytesPayloadBytes(x, (y) => y.localGet(0));
            x.localGet(IDX);
            x.f64ConvertI32U();
            x.call(this.deps.bytesGet());
          });
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
        // A FUNC box answers the two function-instance members Node
        // defines, `scr_dyn_fn_get` ported: `name` (the empty string when
        // the value is anonymous — C's `d->v.fn.name ? : ""`) and
        // `length` (the declared arity). BOTH are compile-time
        // approximations of Node's answers rather than equal to them —
        // SEMANTICS.md S020 has the cases. C consults an own-property
        // table FIRST, but its only writer is Object.defineProperties,
        // which this backend refuses — so there is no table to consult
        // and no key that could shadow these two. Everything else falls
        // through to undefined, C's NULL answer reaching the same place.
        this.arm(c, K, [DK.FUNC], () => {
          c.localGet(1);
          this.deps.lit(c, "name");
          c.call(this.deps.strEq());
          c.ifVoid();
          this.boxStr(c, (x) => {
            this.fnPayload(x, (y) => y.localGet(0));
            x.structGet(this.fnT(), FN_NAME);
            x.localTee(MSG);
            x.refIsNull();
            x.ifResult(this.deps.strRef());
            this.deps.lit(x, "");
            x.else_();
            x.localGet(MSG);
            x.end();
          });
          c.return_();
          c.end();
          this.pushIsLength(c, (x) => x.localGet(1));
          c.ifVoid();
          this.boxNum(c, (x) => {
            this.fnPayload(x, (y) => y.localGet(0));
            x.structGet(this.fnT(), FN_ARITY);
            x.f64ConvertI32U();
          });
          c.return_();
          c.end();
          c.globalGet(this.undefinedGlobal());
        });
        // BYTES has its OWN arm above now; HANDLE and JSVAL are still
        // unconstructible on this tier.
        this.arm(c, K, [DK.HANDLE, DK.JSVAL], () => c.unreachable());
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
      // BYTES takes index writes too, but UNLIKE ARR does not grow: a
      // canonical numeric index at or past the current length is a
      // SILENT NO-OP (measured: `u[10] = 5` on a length-3 Uint8Array
      // changes nothing, no throw, no growth — typed arrays are FIXED-
      // length, matching the spec's integer-indexed-exotic-object OOB
      // rule; JS arrays instead auto-grow, which is why ARR's arm above
      // pads with undefined and this one does not). A non-canonical key
      // (canonIdx < 0) falls through to the shared throw below, same as
      // ARR's own non-index fallthrough (S016's precedent: this tier's
      // bytes payload has no property table any more than the array
      // payload does, so a named expando write — which Node DOES allow
      // on a real typed array, measured: `u.foo = "x"` becomes a real
      // own property — cannot be represented here either).
      c.localGet(K);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.ifVoid();
      c.localGet(1);
      c.call(this.canonIdx());
      c.localTee(IDX);
      c.i32Const(0);
      c.i32GeS();
      c.ifVoid();
      c.localGet(IDX);
      this.bytesLenI32(c, (x) => this.bytesPayloadBytes(x, (y) => y.localGet(0)));
      c.i32LtU();
      c.ifVoid();
      // The value must already be a NUM to coerce like a typed-array
      // element write — this tier has no general dyn ToNumber (idxArg's
      // own precedent, same file: "Node would ToNumber-coerce it and
      // this tier has no coercion"), so anything else is the SAME loud
      // runtime TypeError idxArg throws, not a silent wrong answer.
      c.localGet(2);
      c.structGet(dynT, DYN_KIND);
      c.i32Const(DK.NUM);
      c.i32Eq();
      c.ifVoid();
      this.bytesPayloadBytes(c, (x) => x.localGet(0));
      c.localGet(IDX);
      c.f64ConvertI32U();
      c.localGet(2);
      c.structGet(dynT, DYN_NUM);
      c.call(this.deps.bytesSet());
      c.else_();
      this.deps.throwTypeError(c, (x) =>
        this.deps.lit(x, "non-number values on a dynamic bytes write are not supported yet"),
      );
      c.end();
      c.return_();
      c.end();
      // Numeric but out of range: silent no-op, matching Node exactly.
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
   * THE STR AND FUNC ARMS ARE NOT IN THE C RUNTIME, deliberately.
   * `scr_dyn_has_own` has OBJ and ARR arms and stops, so it answers false
   * where Node answers true for `Object.hasOwn("abc", "length")` and for
   * `Object.hasOwn(f, "name")` — while `scr_dyn_key_get` DOES model
   * string length and index reads AND the two function-instance members,
   * which S015 names as the forms that work — answering false for them
   * would contradict the register's own stated boundary. That reads as an
   * omission rather than a stance, so this lane matches NODE (verified:
   * Node answers true for `name` and `length` on a function, false for
   * any other own key, and `"call" in f` stays false here because `call`
   * is a PROTOTYPE member, which is S015's divergence and not this
   * arm's). The C lane lacks both arms today; the convergence is
   * task-tracked, and matching Node REMOVES a divergence rather than
   * adding one, so there is nothing to register here. */
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
      // BYTES: canonical in-range indices ONLY — NOT "length", unlike the
      // ARR/STR arm just above. Measured directly: `Object.hasOwn([1,2],
      // "length")` and `Object.hasOwn("ab", "length")` are both true
      // (array/string length IS a real own property, non-enumerable but
      // present), while `Object.hasOwn(new Uint8Array(2), "length")` is
      // FALSE — `Object.getOwnPropertyNames(new Uint8Array(n))` lists only
      // the numeric indices; TypedArray's `length` is an INHERITED
      // prototype accessor, not an own slot. `keyGet`'s "length" handling
      // is unaffected (reading `u["length"]` still answers correctly —
      // this is only about OWN-ness, not readability).
      this.arm(c, K, [DK.BYTES], () => {
        c.localGet(1);
        c.call(this.canonIdx());
        c.localTee(IDX);
        c.i32Const(0);
        c.i32GeS();
        c.ifResult(I32);
        c.localGet(IDX);
        this.bytesLenI32(c, (x) => this.bytesPayloadBytes(x, (y) => y.localGet(0)));
        c.i32LtU();
        c.else_();
        c.i32Const(0);
        c.end();
      });
      // The two members a FUNC box owns — keyGet's arm, asked the other
      // way round. Every other key falls through to false.
      this.arm(c, K, [DK.FUNC], () => {
        c.localGet(1);
        this.deps.lit(c, "name");
        c.call(this.deps.strEq());
        this.pushIsLength(c, (x) => x.localGet(1));
        c.i32Or();
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
      const AB = 16;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.UNDEF, DK.NULL], () => {
        this.pushToObjectFail(c);
        c.refNull(dynT);
      });
      // The ENGINE walks its own object in C. Neither JSVAL nor HANDLE is
      // constructible here.
      this.arm(c, K, [DK.JSVAL, DK.HANDLE], () => c.unreachable());
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
      // BYTES lists its byte indices, ARR's arm with the element source
      // swapped — own keys are numeric indices ONLY (measured:
      // `Object.getOwnPropertyNames(new Uint8Array(n))` never includes
      // "length", unlike arrays/strings — hasOwn's arm has the same
      // measurement).
      this.arm(c, K, [DK.BYTES], () => {
        this.bytesPayloadBytes(c, (x) => x.localGet(0));
        c.localSet(AB);
        this.bytesLenI32(c, (x) => x.localGet(AB));
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
          (x) => {
            this.boxNum(x, (y) => {
              y.localGet(AB);
              y.localGet(I);
              y.f64ConvertI32U();
              y.call(this.deps.bytesGet());
            });
          },
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
          this.deps.bytesRefU8(),
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
      // construction. (BYTES belongs here in C too; its own objWalk arm
      // — increment 18 stage C — answers this correctly now, no special
      // case needed here.)
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
      const c = new Code();
      const D = 1;
      c.localGet(0);
      c.call(this.v8Desc());
      this.deps.lit(c, " is not iterable (cannot read property Symbol(Symbol.iterator))");
      c.call(this.deps.concat());
      c.localSet(D);
      this.deps.throwTypeError(c, (x) => x.localGet(D));
      this.mb.setBody(idx, [this.deps.strRef()], c.bytes());
    });
  }

  /** %w.dyn.v8Desc(d) → V8's TYPED rendering of a value inside a message:
   * "undefined", "object null", "boolean true", "number 5",
   * `string "abc"`, "function", and bare "object" for every object —
   * arrays, plain objects and errors alike. Verified against Node.
   *
   * TWO messages share it, which is why it is a helper rather than
   * iterFail's inline nest: the not-iterable text above and the callable-
   * callback gate below ("<desc> is not a function" from `arr.map(5)`).
   * The C runtime renders the gate's operand with `scr_dyn_display_buf`
   * instead — ToString, so "5" where V8 says "number 5" and "abc" where
   * it says `string "abc"` — an inherited approximation this lane does
   * not need, having the renderer already. The STRING arm is reachable
   * only from the gate: iterFail never sees one, because strings iterate. */
  v8Desc(): number {
    return this.cached("v8Desc", [this.dynRef()], [this.deps.strRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 1;
      const concat = this.deps.concat();
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.UNDEF], () => this.deps.lit(c, "undefined"));
      this.arm(c, K, [DK.NULL], () => this.deps.lit(c, "object null"));
      this.arm(c, K, [DK.BOOL], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.f64Const(0);
        c.f64Ne();
        c.ifResult(this.deps.strRef());
        this.deps.lit(c, "boolean true");
        c.else_();
        this.deps.lit(c, "boolean false");
        c.end();
      });
      this.arm(c, K, [DK.NUM], () => {
        this.deps.lit(c, "number ");
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.call(this.deps.f64ToStr());
        c.call(concat);
      });
      this.arm(c, K, [DK.STR], () => {
        // V8 QUOTES the string and escapes nothing inside it — an
        // embedded quote lands raw ('a"b' renders `string "a"b"`).
        this.deps.lit(c, 'string "');
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(this.deps.strType());
        c.call(concat);
        this.deps.lit(c, '"');
        c.call(concat);
      });
      this.arm(c, K, [DK.FUNC], () => this.deps.lit(c, "function"));
      // ARR, OBJ, BYTES, PROMISE, HANDLE, JSVAL — V8's "object".
      this.deps.lit(c, "object");
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** %w.dyn.v8Str(d) → the text V8 folds a whole VALUE into an error
   * message with: `Object::NoSideEffectsToString`, which is deliberately
   * NOT `String(d)` — building a message must not run user code, so a
   * user `toString` is never called and V8 falls back to a description of
   * the value's SHAPE. Measured against Node, arm by arm: a plain object
   * renders as the constructor form `#<Object>` (and `{toString(){...}}`
   * renders `[object Object]`, the one case this tier cannot reach —
   * a dyn object has no user prototype to carry a `toString`); an array
   * renders `[object Array]`; a promise `#<Promise>`; an Error renders
   * through Error.prototype.toString, which is what the `%error`
   * encoding's shape gives for free (`String(err)` and this agree, and
   * both agree with Node for an error that crossed the boundary — see
   * S021, and S025 for what a user object spelling `%error` gets
   * instead). Scalars are their ordinary ToString image, so they simply
   * fall through to `toStr`.
   *
   * `sort`'s comparator gate is the only caller — the one message in this
   * file that folds in a value rather than naming its type the way
   * `v8Desc` does. */
  v8Str(): number {
    return this.cached("v8Str", [this.dynRef()], [this.deps.strRef()], (idx) => {
      const dynT = this.dynT();
      const c = new Code();
      const K = 1;
      const O = 2;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);
      this.arm(c, K, [DK.ARR], () => this.deps.lit(c, "[object Array]"));
      this.arm(c, K, [DK.PROMISE], () => this.deps.lit(c, "#<Promise>"));
      this.arm(c, K, [DK.OBJ], () => {
        this.objPayload(c, (x) => x.localGet(0));
        c.localTee(O);
        this.deps.lit(c, "%error");
        c.call(this.objGet());
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(O);
        c.call(this.errStr());
        c.return_();
        c.end();
        this.deps.lit(c, "#<Object>");
      });
      c.localGet(0);
      c.call(this.toStr());
      this.mb.setBody(idx, [I32, this.objRef()], c.bytes());
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
      // This function's OWN consumer (keySet's "Cannot create property
      // 'x' on Y" fallthrough — a divergence to begin with, S016's
      // precedent: Node never throws there for a real Buffer OR a plain
      // Uint8Array, so there is nothing in Node to check either flavor's
      // wording against) still needs the RIGHT noun, not just A noun —
      // Node's broader convention of naming values by their EXACT
      // constructor (measured elsewhere: `Buffer.compare(a, new
      // Uint32Array(1))` → "...Received an instance of Uint32Array", a
      // DIFFERENT message family kindName does not feed today — board
      // #26) is what justifies making the flag decide "Buffer" vs
      // "Uint8Array" here too, not a fixed literal.
      this.arm(c, K, [DK.BYTES], () => {
        this.bytesPayload(c, (x) => x.localGet(0));
        c.structGet(this.bytesPayloadT(), BYTES_PAYLOAD_IS_BUFFER);
        c.ifResult(this.deps.strRef());
        this.deps.lit(c, "Buffer");
        c.else_();
        this.deps.lit(c, "Uint8Array");
        c.end();
      });
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

  /* ── the ERROR encoding, and the identity that rides it ───────────────
   *
   * An error crossing into `unknown` becomes an OBJ carrying the reserved
   * `%error` key beside `name`, `message` and — when stamped — `code`.
   * Both producers (`caughtToDyn` and the error-rooted `dynFrom`) build it
   * HERE, through one cache, because JS identity says the same error is
   * one value however often it crosses: `scr_dyn_from_error`'s
   * `scr_errdyn_cache` answered that natively and this is the same
   * algorithm — a linear scan, an entry per error, alive for the process.
   * Without it `x === y` over two crossings of one error would answer
   * false where BOTH Node and the C lane answer true, which is the
   * cross-lane disagreement S014's rationale rules out.
   *
   * The cache is a LIST, not C's growable array, purely because a list
   * needs no growth arithmetic; it asks the identical question by the
   * identical scan. It deliberately does not live on `errT` — appending a
   * slot there would land inside the field prefix a user `extends Error`
   * class subtypes (emitter.ts's errFields), and this cache is not part of
   * an error's shape. */

  private errDynType: number | null = null;
  private errDynHeadGlobal: number | null = null;

  /** `$errDyn` — one cache entry: the error, its box, and the next link. */
  private errDynT(): number {
    if (this.errDynType !== null) return this.errDynType;
    // selfStructType's contract: nothing inside `make` may intern a type.
    const errRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.errT() };
    const dynRef = this.dynRef();
    this.errDynType = this.mb.selfStructType("dyn:errDyn", (self) => [
      { storage: errRef, mutable: false },
      { storage: dynRef, mutable: false },
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: false },
    ]);
    return this.errDynType;
  }

  private errDynHead(): number {
    if (this.errDynHeadGlobal !== null) return this.errDynHeadGlobal;
    const t = this.errDynT();
    this.errDynHeadGlobal = this.mb.addGlobal(
      { kind: "ref", nullable: true, typeIndex: t },
      true,
      (w) => {
        w.u8(0xd0); // ref.null $errDyn
        w.sleb(t);
      },
    );
    return this.errDynHeadGlobal;
  }

  /** %w.dyn.fromError(e) → the `%error` OBJ for this error instance, the
   * SAME box every time — `scr_dyn_from_error` ported. `e` may be any
   * error the tier can build: the builtin `errT` or a user class that
   * subtypes it, and both read their name/message/%code from errT's own
   * slots. A null `name` or `message` contributes the empty string rather
   * than a STR box over a null payload (C's fields are never null; ours
   * are typed nullable, so the guard is the honest reading).
   *
   * The members it writes are ordinary own entries, so they ENUMERATE
   * where Node's Error hides its own — SEMANTICS.md S021. */
  fromError(): number {
    return this.cached(
      "fromError",
      [{ kind: "ref", nullable: true, typeIndex: this.deps.errT() }],
      [this.dynRef()],
      (idx) => {
        const errT = this.deps.errT();
        const entryT = this.errDynT();
        const head = this.errDynHead();
        const c = new Code();
        const N = 1;
        const O = 2;
        const D = 3;
        const S = 4;
        // The scan: this error's box if it has one already.
        c.globalGet(head);
        c.localSet(N);
        c.block();
        c.loop();
        c.localGet(N);
        c.refIsNull();
        c.brIf(1);
        c.localGet(N);
        c.structGet(entryT, 0);
        c.localGet(0);
        c.refEq();
        c.ifVoid();
        c.localGet(N);
        c.structGet(entryT, 1);
        c.return_();
        c.end();
        c.localGet(N);
        c.structGet(entryT, 2);
        c.localSet(N);
        c.br(0);
        c.end();
        c.end();
        // A first crossing builds the encoding.
        this.pushNewObj(c, false);
        c.localSet(O);
        const put = (key: string, pushValue: () => void): void => {
          c.localGet(O);
          this.deps.lit(c, key);
          pushValue();
          c.call(this.objPut());
        };
        // The marker's VALUE is unobservable through any surface but the
        // keyed read; C stores `true` and so does this.
        put("%error", () => c.globalGet(this.boolGlobal(true)));
        const strSlot = (slot: number): void => {
          this.boxStr(c, (x) => {
            x.localGet(0);
            x.structGet(errT, slot);
            x.localTee(S);
            x.refIsNull();
            x.ifResult(this.deps.strRef());
            this.deps.lit(x, "");
            x.else_();
            x.localGet(S);
            x.end();
          });
        };
        put("name", () => strSlot(this.deps.errName()));
        put("message", () => strSlot(this.deps.errMessage()));
        // `code` is present only when stamped — C's `if (e->code)`.
        c.localGet(0);
        c.structGet(errT, this.deps.errCode());
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        put("code", () => {
          this.boxStr(c, (x) => {
            x.localGet(0);
            x.structGet(errT, this.deps.errCode());
          });
        });
        c.end();
        this.boxObj(c, (x) => x.localGet(O));
        c.localSet(D);
        // Publish before answering, so the next crossing finds it.
        c.localGet(0);
        c.localGet(D);
        c.globalGet(head);
        c.structNew(entryT);
        c.globalSet(head);
        c.localGet(D);
        this.mb.setBody(
          idx,
          [
            { kind: "ref", nullable: true, typeIndex: entryT },
            this.objRef(),
            this.dynRef(),
            this.deps.strRef(),
          ],
          c.bytes(),
        );
      },
    );
  }

  /** %w.dyn.toError(d) → the errRef `d` was boxed from, or NULL — the
   * REVERSE of `fromError()`, new for the dyn-adapter phase's completion-
   * callback done-mint (a `cb(err)` err argument arrives as a plain dyn
   * value; `afterWriteCore`/`finalDoneCore`/etc. all take a typed errRef,
   * so a truthy-and-`isError()` argument needs to unbox back to the
   * SAME real instance, not a reconstruction — Node's own `cb(existingErr)`
   * observably preserves identity, e.g. a later `err === original`
   * check). Only `caughtToDyn`/the error-rooted `dynFrom` ever mint the
   * `$errDyn` cache entries `fromError()` builds (its own header), and
   * BOTH of those run at the boxing call site whenever a real errRef
   * crosses INTO dyn — including the ordinary case this phase's own
   * adapters produce it: the user's `cb(new Error(...))` argument is a
   * concrete `%Error`-typed expression at the CALL site (inside their
   * own dyn-boundary closure), so the frontend's normal `dynFrom` lowering
   * already boxes it via `fromError()` before it ever reaches `arrPush` —
   * meaning the cache entry this scan needs already exists by construction,
   * not something this method has to create. The SAME linear scan
   * `fromError()` runs, comparing the OTHER field (dynRef here, errRef
   * there) — mirrored, not reimplemented independently, so a future
   * change to the entry shape only has one scan pattern to keep in sync. */
  toError(): number {
    return this.cached(
      "toError",
      [this.dynRef()],
      [{ kind: "ref", nullable: true, typeIndex: this.deps.errT() }],
      (idx) => {
        const entryT = this.errDynT();
        const head = this.errDynHead();
        const c = new Code();
        const N = 1;
        c.globalGet(head);
        c.localSet(N);
        c.block();
        c.loop();
        c.localGet(N);
        c.refIsNull();
        c.brIf(1);
        c.localGet(N);
        c.structGet(entryT, 1); // dynRef
        c.localGet(0);
        c.refEq();
        c.ifVoid();
        c.localGet(N);
        c.structGet(entryT, 0); // errRef
        c.return_();
        c.end();
        c.localGet(N);
        c.structGet(entryT, 2);
        c.localSet(N);
        c.br(0);
        c.end();
        c.end();
        c.refNull(this.deps.errT());
        this.mb.setBody(idx, [{ kind: "ref", nullable: true, typeIndex: entryT }], c.bytes());
      },
    );
  }

  /* ── prototype-method DISPATCH (scr_dyn_invoke) ───────────────────────
   *
   * `recv.m(args)` where `m` is a name more than one dyn-representable
   * prototype declares, so a stored-member read would silently mis-answer
   * real methods. C's honesty ladder, per (kind, name):
   *
   *   - implemented: JS-exact semantics;
   *   - the name IS on that kind's JS prototype but has no implementation
   *     here: a LOUD "not supported yet" Error, never a wrong answer
   *     (SEMANTICS.md S023 names every pair that takes this rung, and the
   *     non-number index argument that takes it from any receiver);
   *   - the name is not on that kind's prototype: Node's own
   *     "<spelling> is not a function", because that IS the JS answer;
   *   - OBJ: the own member calls (own properties shadow prototypes in JS
   *     too), otherwise the same is-not-a-function;
   *   - undefined/null: Node's "Cannot read properties of ...".
   *
   * ONE HELPER PER METHOD NAME, not one cascade. C compares `method`
   * against every name with `strcmp` because a shared runtime function
   * cannot know its caller; here the name is a COMPILE-TIME constant at
   * every dynInvoke site, so the cascade collapses into a per-name helper
   * that dispatches on the receiver's KIND alone — and the ladder's third
   * rung falls out statically, because a name no other prototype declares
   * simply has no arm but ARR's (or STR's, or OBJ's own-member one) and
   * lands on the shared is-not-a-function tail. That is also why the
   * HANDLE-only names (`on`, `write`, `end`, `listen`, ...) need no
   * refusal: their helpers are complete and JS-exact on every kind this
   * tier can build. The two texts the ladder needs per name — the nullish
   * read and the unsupported fence — become interned LITERALS rather than
   * runtime concatenations, for the same reason.
   *
   * `args` is the ordinary dyn vector `dynCall` builds; `what` is the
   * callee's compile-time source spelling (SEMANTICS.md S018's string).
   * A null answer means an exception is pending, exactly C's contract. */

  /** Array.prototype names with a real arm below. */
  private static readonly ARR_METHODS = new Set([
    "push", "pop", "shift", "unshift", "slice", "at", "indexOf", "lastIndexOf",
    "includes", "join", "concat", "reverse", "sort", "forEach", "map", "filter",
    "some", "every", "find", "findIndex", "flatMap",
  ]);

  /** String.prototype names with an arm — implemented or fenced. */
  private static readonly STR_METHODS = new Set([
    "slice", "at", "concat", "indexOf", "lastIndexOf", "includes",
    "replace", "replaceAll", "charAt",
  ]);

  /** Function.prototype names with an arm. */
  private static readonly FN_METHODS = new Set(["apply", "call"]);

  /** Number.prototype names with an arm (increment 21 stage B, gate 2) —
   * toString computes the base-10 text (absent radix, or an explicit 10)
   * via f64ToStr; an explicit NON-10 radix is not a measured corpus need
   * and FENCES loudly (SB2, review round 1) rather than silently
   * answering the base-10 digits under a claimed different base —
   * fractional-radix formatting is V8-internals (DoubleToRadixCString)
   * this tier does not port. */
  private static readonly NUM_METHODS = new Set(["toFixed", "toString"]);

  /** %w.dyn.notFn(what) — Node's catchable "<what> is not a function",
   * `dyn_throw_not_fn`. The CALLER pushes the null result and returns. */
  notFn(): number {
    return this.cached("notFn", [this.deps.strRef()], [], (idx) => {
      const c = new Code();
      const MSG = 1;
      c.localGet(0);
      this.deps.lit(c, " is not a function");
      c.call(this.deps.concat());
      c.localSet(MSG);
      this.deps.throwTypeError(c, (x) => x.localGet(MSG));
      this.mb.setBody(idx, [this.deps.strRef()], c.bytes());
    });
  }

  /** %w.dyn.cbGate(args) → i32 — the callable-callback test every
   * callback-taking array method opens with (`dyn_cb_check`): argument 0
   * must be a FUNC, and anything else throws JS's own
   * "<desc> is not a function" with V8's TYPED rendering of the operand
   * (see `v8Desc` — the C runtime renders its ToString image instead).
   * Answers 0 with the exception pending. */
  cbGate(): number {
    return this.cached("cbGate", [this.arrRef()], [I32], (idx) => {
      const c = new Code();
      const CB = 1;
      const MSG = 2;
      c.localGet(0);
      c.structGet(this.deps.arrVec().struct, VEC_LEN);
      c.i32Eqz();
      c.ifResult(this.dynRef());
      c.globalGet(this.undefinedGlobal());
      c.else_();
      this.arrAt(c, (x) => x.localGet(0), (x) => x.i32Const(0));
      c.end();
      c.localTee(CB);
      c.structGet(this.dynT(), DYN_KIND);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(CB);
      c.call(this.v8Desc());
      this.deps.lit(c, " is not a function");
      c.call(this.deps.concat());
      c.localSet(MSG);
      this.deps.throwTypeError(c, (x) => x.localGet(MSG));
      c.i32Const(0);
      this.mb.setBody(idx, [this.dynRef(), this.deps.strRef()], c.bytes());
    });
  }

  /** %w.dyn.callCb(cb, item, i, recv) — `dyn_call_cb`: the three
   * arguments JS hands an array callback, in a fresh vector. Null means
   * the callback threw. */
  callCb(): number {
    return this.cached(
      "callCb",
      [this.dynRef(), this.dynRef(), I32, this.dynRef()],
      [this.dynRef()],
      (idx) => {
        const c = new Code();
        const V = 4;
        this.pushNewArr(c);
        c.localSet(V);
        c.localGet(V);
        c.localGet(1);
        c.call(this.arrPush());
        c.localGet(V);
        this.boxNum(c, (x) => {
          x.localGet(2);
          x.f64ConvertI32U();
        });
        c.call(this.arrPush());
        c.localGet(V);
        c.localGet(3);
        c.call(this.arrPush());
        c.localGet(0);
        c.localGet(V);
        // C's `what` for a callback frame, verbatim: a throw from inside
        // the callback carries its own message, so this only surfaces
        // when the callback slot holds a non-function — which the gate
        // above already rejected.
        this.deps.lit(c, "callback");
        c.call(this.callFn());
        this.mb.setBody(idx, [this.arrRef()], c.bytes());
      },
    );
  }

  /** %w.dyn.idxArg(args, i, dflt, undefTo, nanTo, what) → f64 —
   * `dyn_index_arg`: ToIntegerOrInfinity over an OPTIONAL index
   * argument. A number truncates toward zero; ANY OTHER KIND throws the
   * loud fence rather than guessing, because Node would ToNumber-coerce
   * it and this tier has no coercion. The caller tests the pending flag.
   *
   * THE THREE f64s ARE THREE SPEC BRANCHES, and they are declared in the
   * order the tests below fire, so a call site reads top to bottom:
   * `dflt` for an ABSENT argument, `undefTo` for one PRESENT and
   * `undefined`, `nanTo` for a number that is NaN. Most methods answer
   * all three with the same value and pass it three times; the two that
   * do not are the reason this is not one parameter.
   *
   * `Array.prototype.lastIndexOf` separates dflt from undefTo. ECMA-262
   * branches on argument PRESENCE — "if fromIndex is present, let n be
   * ToIntegerOrInfinity(fromIndex), else let n be len - 1" — so an
   * explicit `undefined` is present and coerces to 0, searching index 0
   * alone: `[1,2,3,1,2,3].lastIndexOf(2, undefined)` is -1 where the
   * absent form answers 4. Every other index argument in this file
   * spells its default AS the undefined case ("if end is undefined, let
   * relativeEnd be len"), so the two coincide and cannot be told apart.
   *
   * `String.prototype.lastIndexOf` separates nanTo. It runs ToNumber
   * and then maps NaN to +∞ (`"abcabc".lastIndexOf("a", NaN)` is 3, the
   * whole string) where everything else takes ToIntegerOrInfinity's
   * NaN → 0. Both spellings are JS-exact for their own method; passing
   * the values in keeps each split visible at the call site instead of
   * hidden here. */
  idxArg(): number {
    return this.cached(
      "idxArg",
      [this.arrRef(), I32, F64, F64, F64, this.deps.strRef()],
      [F64],
      (idx) => {
        const c = new Code();
        const A = 6;
        const MSG = 7;
        c.localGet(1);
        c.localGet(0);
        c.structGet(this.deps.arrVec().struct, VEC_LEN);
        c.i32GeU();
        c.ifVoid();
        c.localGet(2);
        c.return_();
        c.end();
        this.arrAt(c, (x) => x.localGet(0), (x) => x.localGet(1));
        c.localSet(A);
        c.localGet(A);
        c.structGet(this.dynT(), DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.ifVoid();
        // PRESENT and undefined — not the same question as absent, for
        // the one method whose spec branches on presence.
        c.localGet(3);
        c.return_();
        c.end();
        c.localGet(A);
        c.structGet(this.dynT(), DYN_KIND);
        c.i32Const(DK.NUM);
        c.i32Eq();
        c.ifVoid();
        // NaN is the only double that fails `n == n`.
        c.localGet(A);
        c.structGet(this.dynT(), DYN_NUM);
        c.localGet(A);
        c.structGet(this.dynT(), DYN_NUM);
        c.f64Ne();
        c.ifResult(F64);
        c.localGet(4);
        c.else_();
        c.localGet(A);
        c.structGet(this.dynT(), DYN_NUM);
        c.f64Trunc();
        c.end();
        c.return_();
        c.end();
        c.localGet(5);
        this.deps.lit(c, ": non-number index arguments on a dynamic receiver are not supported yet");
        c.call(this.deps.concat());
        c.localSet(MSG);
        this.deps.throwTypeError(c, (x) => x.localGet(MSG));
        c.f64Const(0);
        this.mb.setBody(idx, [this.dynRef(), this.deps.strRef()], c.bytes());
      },
    );
  }

  /** %w.dyn.relIdx(rel, len) → i32 — JS's relative-index normalization,
   * `dyn_rel_index`: negatives count from the end and clamp at 0,
   * positives clamp at `len`. Both clamps happen BEFORE the truncation,
   * so the `i32.trunc_f64_s` below can never see an out-of-range double. */
  relIdx(): number {
    return this.cached("relIdx", [F64, I32], [I32], (idx) => {
      const c = new Code();
      const R = 2;
      c.localGet(0);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.localGet(1);
      c.f64ConvertI32U();
      c.localGet(0);
      c.f64Add();
      c.localTee(R);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(R);
      c.i32TruncF64S();
      c.end();
      c.return_();
      c.end();
      c.localGet(0);
      c.localGet(1);
      c.f64ConvertI32U();
      c.f64Gt();
      c.ifResult(I32);
      c.localGet(1);
      c.else_();
      c.localGet(0);
      c.i32TruncF64S();
      c.end();
      this.mb.setBody(idx, [F64], c.bytes());
    });
  }

  /** %w.dyn.strLastIdx(s, needle, from) → f64 —
   * String.prototype.lastIndexOf's backward scan. The tier's string
   * surface has no lastIndexOf of its own (strings.ts stops at
   * `indexOf`), so this is the one place it exists: `matchAt` from the
   * start position down, which answers that position for the empty
   * needle exactly as JS does.
   *
   * `from` takes the spec's clamp to [0, len] — NOT the relative-index
   * treatment `Array.prototype.lastIndexOf` gives its own argument. A
   * string position never counts from the end (`"abcabc"
   * .lastIndexOf("a", -1)` is 0, not 3), which is the whole reason the
   * clamp lives here rather than at the shared `relIdx`. It mirrors
   * `%w.str.indexOf`, which clamps its `from` the same way. */
  strLastIdx(): number {
    return this.cached(
      "strLastIdx",
      [this.deps.strRef(), this.deps.strRef(), F64],
      [F64],
      (idx) => {
        const c = new Code();
        const I = 3;
        const L = 4;
        c.localGet(0);
        c.arrayLen();
        c.localSet(L);
        c.localGet(2);
        c.f64Const(0);
        c.f64Le();
        c.ifResult(I32);
        c.i32Const(0);
        c.else_();
        c.localGet(2);
        c.localGet(L);
        c.f64ConvertI32U();
        c.f64Ge();
        c.ifResult(I32);
        c.localGet(L);
        c.else_();
        c.localGet(2);
        c.i32TruncF64S();
        c.end();
        c.end();
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(0);
        c.localGet(1);
        c.localGet(I);
        c.call(this.deps.strMatchAt());
        c.ifVoid();
        c.localGet(I);
        c.f64ConvertI32U();
        c.return_();
        c.end();
        c.localGet(I);
        c.i32Eqz();
        c.brIf(1);
        c.localGet(I);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.f64Const(-1);
        this.mb.setBody(idx, [I32, I32], c.bytes());
      },
    );
  }

  /** %w.dyn.sortCmp(x, y, cmp) → i32 in {-1, 0, 1} — one comparison of
   * `Array.prototype.sort`. `undefined` sinks BEFORE any comparator runs
   * (JS's rule, and null does not sink — it sorts by its text). A
   * comparator's answer converts loosely: numbers and booleans read the
   * shared `num` slot, everything else counts as 0, and NaN lands there
   * too since it is neither `< 0` nor `> 0`. A null `cmp` takes the
   * DEFAULT comparator: the ToString images ordered by UTF-16 CODE UNIT,
   * which is ECMAScript's own order and Node-exact. (C compares the same
   * images with `scr_str_cmp`, whose UTF-8 storage makes it code-POINT
   * order — S005's inherited divergence, which the flagged comparator
   * exists to avoid and this lane therefore does not reproduce.)
   * A throwing comparator leaves the exception pending and answers 0;
   * the caller tests the flag. */
  sortCmp(): number {
    return this.cached(
      "sortCmp",
      [this.dynRef(), this.dynRef(), this.dynRef()],
      [I32],
      (idx) => {
        const dynT = this.dynT();
        const c = new Code();
        const XU = 3;
        const YU = 4;
        const V = 5;
        const R = 6;
        const F = 7;
        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.localSet(XU);
        c.localGet(1);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.localSet(YU);
        c.localGet(XU);
        c.localGet(YU);
        c.i32Or();
        c.ifVoid();
        c.localGet(XU);
        c.localGet(YU);
        c.i32And();
        c.ifResult(I32);
        c.i32Const(0);
        c.else_();
        c.localGet(XU);
        c.ifResult(I32);
        c.i32Const(1);
        c.else_();
        c.i32Const(-1);
        c.end();
        c.end();
        c.return_();
        c.end();
        c.localGet(2);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        this.pushNewArr(c);
        c.localSet(V);
        c.localGet(V);
        c.localGet(0);
        c.call(this.arrPush());
        c.localGet(V);
        c.localGet(1);
        c.call(this.arrPush());
        c.localGet(2);
        c.localGet(V);
        this.deps.lit(c, "comparefn");
        c.call(this.callFn());
        c.localTee(R);
        c.refIsNull();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.f64Const(0);
        c.localSet(F);
        c.localGet(R);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NUM);
        c.i32Eq();
        c.localGet(R);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.BOOL);
        c.i32Eq();
        c.i32Or();
        c.ifVoid();
        c.localGet(R);
        c.structGet(dynT, DYN_NUM);
        c.localSet(F);
        c.end();
        c.localGet(F);
        c.f64Const(0);
        c.f64Lt();
        c.ifResult(I32);
        c.i32Const(-1);
        c.else_();
        c.localGet(F);
        c.f64Const(0);
        c.f64Gt();
        c.ifResult(I32);
        c.i32Const(1);
        c.else_();
        c.i32Const(0);
        c.end();
        c.end();
        c.return_();
        c.end();
        c.localGet(0);
        c.call(this.toStr());
        c.localGet(1);
        c.call(this.toStr());
        c.call(this.deps.strCmpU16());
        this.mb.setBody(idx, [I32, I32, this.arrRef(), this.dynRef(), F64], c.bytes());
      },
    );
  }

  /** %w.dyn.sortArr(vec, cmp) → i32 ok — the spec's SNAPSHOT sort:
   * elements copy into a work list, a stable merge orders it, and the
   * ordered list writes back index by index, so a comparator that mutates
   * the receiver mid-sort never reorders the elements being compared.
   * `dyn_arr_sort` with its recursion turned bottom-up (one loop pair
   * instead of a self-call, since every merge width is known). Stability
   * is the `<= 0` that takes the LEFT run's element on a tie. Answers 0
   * with the exception pending when a comparator threw.
   *
   * The ORDER this produces is Node's for every consistent comparator;
   * the comparison SEQUENCE is not V8's TimSort's and cannot be, which
   * a counting or mutating comparator can see — SEMANTICS.md S024. */
  sortArr(): number {
    return this.cached("sortArr", [this.arrRef(), this.dynRef()], [I32], (idx) => {
      const vec = this.deps.arrVec();
      const c = new Code();
      const N = 2;
      const WORK = 3;
      const TMP = 4;
      const W = 5;
      const LO = 6;
      const MID = 7;
      const HI = 8;
      const I = 9;
      const J = 10;
      const K = 11;
      c.localGet(0);
      c.structGet(vec.struct, VEC_LEN);
      c.localSet(N);
      c.localGet(N);
      c.f64ConvertI32U();
      c.call(this.deps.arrNewLen());
      c.localSet(WORK);
      c.localGet(N);
      c.f64ConvertI32U();
      c.call(this.deps.arrNewLen());
      c.localSet(TMP);
      // The snapshot.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      this.arrSet(
        c,
        (x) => x.localGet(WORK),
        (x) => x.localGet(I),
        (x) => this.arrAt(x, (y) => y.localGet(0), (y) => y.localGet(I)),
      );
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // Bottom-up merge: runs of width W pair off into TMP, then TMP
      // copies back over WORK and the width doubles.
      c.i32Const(1);
      c.localSet(W);
      c.block();
      c.loop();
      c.localGet(W);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.i32Const(0);
      c.localSet(LO);
      c.block();
      c.loop();
      c.localGet(LO);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      // mid = min(lo + w, n), hi = min(lo + 2w, n)
      const clampTo = (base: number, add: number, out: number): void => {
        c.localGet(base);
        c.localGet(add);
        c.i32Add();
        c.localTee(out);
        c.localGet(N);
        c.i32GtU();
        c.ifVoid();
        c.localGet(N);
        c.localSet(out);
        c.end();
      };
      clampTo(LO, W, MID);
      c.localGet(W);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(K); // 2w, borrowed before K becomes the write cursor
      clampTo(LO, K, HI);
      c.localGet(LO);
      c.localSet(I);
      c.localGet(MID);
      c.localSet(J);
      c.localGet(LO);
      c.localSet(K);
      // The merge proper.
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(MID);
      c.i32LtU();
      c.localGet(J);
      c.localGet(HI);
      c.i32LtU();
      c.i32And();
      c.i32Eqz();
      c.brIf(1);
      this.arrAt(c, (x) => x.localGet(WORK), (x) => x.localGet(I));
      this.arrAt(c, (x) => x.localGet(WORK), (x) => x.localGet(J));
      c.localGet(1);
      c.call(this.sortCmp());
      c.i32Const(0);
      c.i32LeS();
      c.ifVoid();
      this.arrSet(
        c,
        (x) => x.localGet(TMP),
        (x) => x.localGet(K),
        (x) => this.arrAt(x, (y) => y.localGet(WORK), (y) => y.localGet(I)),
      );
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.else_();
      this.arrSet(
        c,
        (x) => x.localGet(TMP),
        (x) => x.localGet(K),
        (x) => this.arrAt(x, (y) => y.localGet(WORK), (y) => y.localGet(J)),
      );
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.end();
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      // A comparator that threw stops everything — checked AFTER the
      // write so the loop shape stays one branch.
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.br(0);
      c.end();
      c.end();
      // The tails.
      const drain = (cursor: number, limit: number): void => {
        c.block();
        c.loop();
        c.localGet(cursor);
        c.localGet(limit);
        c.i32GeU();
        c.brIf(1);
        this.arrSet(
          c,
          (x) => x.localGet(TMP),
          (x) => x.localGet(K),
          (x) => this.arrAt(x, (y) => y.localGet(WORK), (y) => y.localGet(cursor)),
        );
        c.localGet(cursor);
        c.i32Const(1);
        c.i32Add();
        c.localSet(cursor);
        c.localGet(K);
        c.i32Const(1);
        c.i32Add();
        c.localSet(K);
        c.br(0);
        c.end();
        c.end();
      };
      drain(I, MID);
      drain(J, HI);
      c.localGet(LO);
      c.localGet(W);
      c.i32Const(1);
      c.i32Shl();
      c.i32Add();
      c.localSet(LO);
      c.br(0);
      c.end();
      c.end();
      // TMP → WORK for the next width.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      this.arrSet(
        c,
        (x) => x.localGet(WORK),
        (x) => x.localGet(I),
        (x) => this.arrAt(x, (y) => y.localGet(TMP), (y) => y.localGet(I)),
      );
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(W);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(W);
      c.br(0);
      c.end();
      c.end();
      // Write back into whatever the receiver holds NOW: a comparator
      // that SHRANK the array leaves the surplus behind, C's own stance.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(I);
      c.localGet(0);
      c.structGet(vec.struct, VEC_LEN);
      c.i32LtU();
      c.ifVoid();
      this.arrSet(
        c,
        (x) => x.localGet(0),
        (x) => x.localGet(I),
        (x) => this.arrAt(x, (y) => y.localGet(WORK), (y) => y.localGet(I)),
      );
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(1);
      this.mb.setBody(
        idx,
        [I32, this.arrRef(), this.arrRef(), I32, I32, I32, I32, I32, I32, I32],
        c.bytes(),
      );
    });
  }

  /** %w.dyn.nullishRecv:&lt;method&gt;(recv) — the TypeError a NULLISH
   * receiver earns, with the member name folded in at COMPILE time (the
   * helper is per-name, like `invoke` below). Throws and returns; the
   * caller tests the pending flag.
   *
   * It is a helper of its own because the throw has to happen at the
   * MEMBER GET, which in `u.m(f())` is before `f()` runs — so the emitter
   * calls this the moment the receiver is evaluated and `invoke`'s
   * arguments are never built. `invoke` opens with the same call, which
   * keeps one spelling of the message and leaves the ladder's first rung
   * real for any future caller that has its arguments already. */
  nullishRecv(method: string): number {
    return this.cached(`nullishRecv:${method}`, [this.dynRef()], [], (idx) => {
      const c = new Code();
      const K = 1;
      const MSG = 2;
      c.localGet(0);
      c.structGet(this.dynT(), DYN_KIND);
      c.localTee(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.localGet(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, `Cannot read properties of undefined (reading '${method}')`);
      c.else_();
      this.deps.lit(c, `Cannot read properties of null (reading '${method}')`);
      c.end();
      c.localSet(MSG);
      this.deps.throwTypeError(c, (x) => x.localGet(MSG));
      c.end();
      this.mb.setBody(idx, [I32, this.deps.strRef()], c.bytes());
    });
  }

  /** %w.dyn.invoke:&lt;method&gt;(recv, args, what) → the call's result, or
   * null with an exception pending. See the section header for the
   * ladder and for why there is one of these per method NAME. */
  invoke(method: string): number {
    return this.cached(
      `invoke:${method}`,
      [this.dynRef(), this.arrRef(), this.deps.strRef()],
      [this.dynRef()],
      (idx) => {
        const dynT = this.dynT();
        const vecT = this.deps.arrVec().struct;
        const concat = this.deps.concat();
        const c = new Code();
        // One local frame for every method, so the indices below read the
        // same whichever arms a given name grows. Unused slots cost a
        // zero in the locals declaration and nothing at runtime.
        const K = 3;
        const A = 4;
        const N = 5;
        const I = 6;
        const ARGC = 7;
        const OUT = 8;
        const E = 9;
        const R = 10;
        const CB = 11;
        const MSG = 12;
        const S = 13;
        const F0 = 14;
        const F1 = 15;
        const M = 16;
        const J = 17;
        const B = 18;
        const A2 = 19;

        /** Argument `i` as JS sees it: the value, or `undefined` past the
         * end — C's `argc > i ? args[i] : scr_dyn_undefined()`. */
        const argAt = (i: number): void => {
          c.i32Const(i);
          c.localGet(ARGC);
          c.i32LtU();
          c.ifResult(this.dynRef());
          this.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(i));
          c.else_();
          c.globalGet(this.undefinedGlobal());
          c.end();
        };
        /** Bail out of a sub-helper that may have thrown. */
        const bailIfPending = (): void => {
          c.globalGet(this.deps.excKind());
          c.ifVoid();
          c.refNull(dynT);
          c.return_();
          c.end();
        };
        /** Node's is-not-a-function, then the null result. */
        const throwNotFn = (): void => {
          c.localGet(2);
          c.call(this.notFn());
          c.refNull(dynT);
        };
        /** The LOUD fence for a name that IS on this prototype but has no
         * implementation here — `dyn_throw_unsupported`, a plain Error so
         * a `catch (e) { e instanceof TypeError }` handler does not
         * mistake a missing feature for a type error. */
        const throwUnsupported = (proto: string): void => {
          this.deps.throwError(c, "%Error", "Error", (x) =>
            this.deps.lit(x, `'${proto}.prototype.${method}' on a dynamic value is not supported yet`),
          );
          c.refNull(dynT);
        };
        /** `local = payload vector`, then `N = its length`. */
        const loadArr = (): void => {
          this.arrPayload(c, (x) => x.localGet(0));
          c.localSet(A);
          this.arrLen(c, (x) => x.localGet(A));
          c.localSet(N);
        };
        /** A counted forward loop `for (I = from; I < limitPush(); I++)`. */
        const forLoop = (pushLimit: () => void, body: () => void): void => {
          c.block();
          c.loop();
          c.localGet(I);
          pushLimit();
          c.i32GeU();
          c.brIf(1);
          body();
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
          c.br(0);
          c.end();
          c.end();
        };

        c.localGet(0);
        c.structGet(dynT, DYN_KIND);
        c.localSet(K);
        this.arrLen(c, (x) => x.localGet(1));
        c.localSet(ARGC);

        // Nullish receivers: Node's property-read message. The emitter
        // has already run this test at the member get, before it built a
        // single argument (JS's order — `nullishRecv`'s doc); this is the
        // rung kept whole so the ladder still reads top to bottom and so
        // the helper answers correctly however it is called.
        c.localGet(0);
        c.call(this.nullishRecv(method));
        bailIfPending();

        // OBJ: the OWN member calls — own properties shadow prototypes in
        // JS too, so this arm exists for every name. C binds the
        // receiver through the ambient-`this` window for the call
        // (scr_dyn_invoke.c:358-363 — `scr_dyn_this_push_dyn(recv)`
        // around `scr_dyn_call`, unconditionally popped after); ported
        // below via thisPush/thisPop, R staging callFn()'s result across
        // the pop the way C's local `r` does.
        this.arm(c, K, [DK.OBJ], () => {
          this.objPayload(c, (x) => x.localGet(0));
          this.deps.lit(c, method);
          c.call(this.objGet());
          c.localTee(M);
          c.refIsNull();
          c.i32Eqz();
          c.ifVoid();
          c.localGet(M);
          c.structGet(dynT, DYN_KIND);
          c.i32Const(DK.FUNC);
          c.i32Eq();
          c.ifVoid();
          c.localGet(0);
          c.call(this.thisPush());
          c.localGet(M);
          c.localGet(1);
          c.localGet(2);
          c.call(this.callFn());
          c.localSet(R);
          c.call(this.thisPop());
          c.localGet(R);
          c.return_();
          c.end();
          c.end();
          throwNotFn();
        });

        if (DynBuilder.FN_METHODS.has(method)) {
          this.arm(c, K, [DK.FUNC], () => {
            if (method === "apply") {
              // `f.apply(thisArg, argsArray)` — thisArg (`args[0]`, or
              // undefined absent) binds the ambient receiver for the
              // call window, C's scr_dyn_invoke.c:370-390 exactly: both
              // the nullish/absent-argsArray branch below and the real
              // array branch further down push it before their own
              // `callFn()` and pop after, R staging the result across
              // the pop the way C's local `r` does.
              argAt(1);
              c.localTee(M);
              c.structGet(dynT, DYN_KIND);
              c.localSet(B);
              c.localGet(B);
              c.i32Const(DK.UNDEF);
              c.i32Eq();
              c.localGet(B);
              c.i32Const(DK.NULL);
              c.i32Eq();
              c.i32Or();
              c.ifVoid();
              argAt(0);
              c.call(this.thisPush());
              c.localGet(0);
              this.pushNewArr(c);
              c.localGet(2);
              c.call(this.callFn());
              c.localSet(R);
              c.call(this.thisPop());
              c.localGet(R);
              c.return_();
              c.end();
              // A non-array argsArray splits the way Node splits it. An
              // OBJECT is array-LIKE: Node runs CreateListFromArrayLike
              // over its `length` and index members and SUCCEEDS. This
              // tier does not read them, so that side takes the ladder's
              // own loud fence — borrowing the message below would be a
              // lie about a case Node answers. A PRIMITIVE is the case
              // the message is actually FOR, and Node throws it there
              // too: `f.apply(null, "ab")`, verified against Node.
              // SEMANTICS.md S023.
              c.localGet(B);
              c.i32Const(DK.ARR);
              c.i32Ne();
              c.ifVoid();
              c.localGet(B);
              c.i32Const(DK.OBJ);
              c.i32Eq();
              c.localGet(B);
              c.i32Const(DK.FUNC);
              c.i32Eq();
              c.i32Or();
              c.localGet(B);
              c.i32Const(DK.PROMISE);
              c.i32Eq();
              c.i32Or();
              c.ifVoid();
              this.deps.throwError(c, "%Error", "Error", (x) =>
                this.deps.lit(
                  x,
                  "'Function.prototype.apply' with an array-like argsArray on a dynamic value is not supported yet",
                ),
              );
              c.refNull(dynT);
              c.return_();
              c.end();
              this.deps.throwTypeError(c, (x) =>
                this.deps.lit(x, "CreateListFromArrayLike called on non-object"),
              );
              c.refNull(dynT);
              c.return_();
              c.end();
              // The array's own payload IS the argument vector — no copy,
              // exactly C's `list->v.arr.items, list->v.arr.len`.
              argAt(0);
              c.call(this.thisPush());
              c.localGet(0);
              this.arrPayload(c, (x) => x.localGet(M));
              c.localGet(2);
              c.call(this.callFn());
              c.localSet(R);
              c.call(this.thisPop());
              c.localGet(R);
              return;
            }
            // `f.call(thisArg, ...rest)` — the tail, repacked. thisArg
            // (`args[0]`, or undefined absent) binds the ambient
            // receiver exactly like apply's, C's scr_dyn_invoke.c:392-396.
            this.pushNewArr(c);
            c.localSet(OUT);
            c.i32Const(1);
            c.localSet(I);
            forLoop(
              () => c.localGet(ARGC),
              () => {
                c.localGet(OUT);
                this.arrAt(c, (x) => x.localGet(1), (x) => x.localGet(I));
                c.call(this.arrPush());
              },
            );
            argAt(0);
            c.call(this.thisPush());
            c.localGet(0);
            c.localGet(OUT);
            c.localGet(2);
            c.call(this.callFn());
            c.localSet(R);
            c.call(this.thisPop());
            c.localGet(R);
          });
        }

        if (DynBuilder.ARR_METHODS.has(method)) {
          this.arm(c, K, [DK.ARR], () => {
            loadArr();
            /** `A[i]` for a loop cursor — the vector struct is re-read
             * every step, so a `push` from inside a callback that
             * REPLACED the buffer is picked up (JS iterates the live
             * array, and so does this). */
            const elemAt = (cursor: number): void => {
              this.arrAt(c, (x) => x.localGet(A), (x) => x.localGet(cursor));
            };
            /** The live length, C's `recv->v.arr.len` read fresh. */
            const liveLen = (): void => {
              this.arrLen(c, (x) => x.localGet(A));
            };
            switch (method) {
              case "push": {
                c.i32Const(0);
                c.localSet(I);
                forLoop(
                  () => c.localGet(ARGC),
                  () => {
                    c.localGet(A);
                    this.arrAt(c, (x) => x.localGet(1), (x) => x.localGet(I));
                    c.call(this.arrPush());
                  },
                );
                this.boxNum(c, (x) => {
                  this.arrLen(x, (y) => y.localGet(A));
                  x.f64ConvertI32U();
                });
                return;
              }
              case "pop":
              case "shift": {
                c.localGet(N);
                c.i32Eqz();
                c.ifVoid();
                c.globalGet(this.undefinedGlobal());
                c.return_();
                c.end();
                if (method === "pop") {
                  c.localGet(N);
                  c.i32Const(1);
                  c.i32Sub();
                  c.localSet(I);
                  elemAt(I);
                  c.localSet(E);
                } else {
                  c.i32Const(0);
                  c.localSet(I);
                  elemAt(I);
                  c.localSet(E);
                  // The close-up. `array.copy` would say the same thing
                  // in one instruction, but only over the raw buffers,
                  // and the loop keeps every access going through the
                  // one accessor pair the rest of this file uses.
                  forLoop(
                    () => {
                      c.localGet(N);
                      c.i32Const(1);
                      c.i32Sub();
                    },
                    () => {
                      this.arrSet(
                        c,
                        (x) => x.localGet(A),
                        (x) => x.localGet(I),
                        (x) => {
                          x.localGet(I);
                          x.i32Const(1);
                          x.i32Add();
                          x.localSet(J);
                          this.arrAt(x, (y) => y.localGet(A), (y) => y.localGet(J));
                        },
                      );
                    },
                  );
                }
                c.localGet(A);
                c.localGet(N);
                c.i32Const(1);
                c.i32Sub();
                c.structSet(vecT, VEC_LEN);
                c.localGet(E);
                return;
              }
              case "unshift": {
                // Grow first (the push path reallocates and takes the
                // capacity question with it), then rotate the old block
                // up and drop the new arguments into the front. The
                // rotation runs BACKWARD so it never reads a slot it has
                // already overwritten.
                c.i32Const(0);
                c.localSet(I);
                forLoop(
                  () => c.localGet(ARGC),
                  () => {
                    c.localGet(A);
                    this.arrAt(c, (x) => x.localGet(1), (x) => x.localGet(I));
                    c.call(this.arrPush());
                  },
                );
                c.localGet(N);
                c.localSet(I);
                c.block();
                c.loop();
                c.localGet(I);
                c.i32Eqz();
                c.brIf(1);
                c.localGet(I);
                c.i32Const(1);
                c.i32Sub();
                c.localSet(I);
                c.localGet(I);
                c.localGet(ARGC);
                c.i32Add();
                c.localSet(J);
                this.arrSet(
                  c,
                  (x) => x.localGet(A),
                  (x) => x.localGet(J),
                  (x) => this.arrAt(x, (y) => y.localGet(A), (y) => y.localGet(I)),
                );
                c.br(0);
                c.end();
                c.end();
                c.i32Const(0);
                c.localSet(I);
                forLoop(
                  () => c.localGet(ARGC),
                  () => {
                    this.arrSet(
                      c,
                      (x) => x.localGet(A),
                      (x) => x.localGet(I),
                      (x) => this.arrAt(x, (y) => y.localGet(1), (y) => y.localGet(I)),
                    );
                  },
                );
                this.boxNum(c, (x) => {
                  this.arrLen(x, (y) => y.localGet(A));
                  x.f64ConvertI32U();
                });
                return;
              }
              case "slice": {
                c.localGet(1);
                c.i32Const(0);
                c.f64Const(0);
                c.f64Const(0);
                c.f64Const(0);
                c.localGet(2);
                c.call(this.idxArg());
                c.localSet(F0);
                bailIfPending();
                // The END defaults to `len` and spells its undefined
                // case AS that default ("if end is undefined, let
                // relativeEnd be len"), so absent and undefined answer
                // the same thing here.
                c.localGet(1);
                c.i32Const(1);
                c.localGet(N);
                c.f64ConvertI32U();
                c.localGet(N);
                c.f64ConvertI32U();
                c.f64Const(0);
                c.localGet(2);
                c.call(this.idxArg());
                c.localSet(F1);
                bailIfPending();
                c.localGet(F0);
                c.localGet(N);
                c.call(this.relIdx());
                c.localSet(I);
                c.localGet(F1);
                c.localGet(N);
                c.call(this.relIdx());
                c.localSet(J);
                this.pushNewArr(c);
                c.localSet(OUT);
                forLoop(
                  () => c.localGet(J),
                  () => {
                    c.localGet(OUT);
                    elemAt(I);
                    c.call(this.arrPush());
                  },
                );
                this.boxArr(c, (x) => x.localGet(OUT));
                return;
              }
              case "at": {
                c.localGet(1);
                c.i32Const(0);
                c.f64Const(0);
                c.f64Const(0);
                c.f64Const(0);
                c.localGet(2);
                c.call(this.idxArg());
                c.localSet(F0);
                bailIfPending();
                c.localGet(F0);
                c.f64Const(0);
                c.f64Lt();
                c.ifVoid();
                c.localGet(N);
                c.f64ConvertI32U();
                c.localGet(F0);
                c.f64Add();
                c.localSet(F0);
                c.end();
                c.localGet(F0);
                c.f64Const(0);
                c.f64Lt();
                c.localGet(F0);
                c.localGet(N);
                c.f64ConvertI32U();
                c.f64Ge();
                c.i32Or();
                c.ifVoid();
                c.globalGet(this.undefinedGlobal());
                c.return_();
                c.end();
                c.localGet(F0);
                c.i32TruncF64S();
                c.localSet(I);
                elemAt(I);
                return;
              }
              case "indexOf":
              case "lastIndexOf":
              case "includes": {
                argAt(0);
                c.localSet(CB);
                // Argument 1 is the fromIndex, and ARRAY's rule for it is
                // the RELATIVE one: a negative counts from the end,
                // ToIntegerOrInfinity sends NaN to 0. (The String arms
                // below clamp instead — see `strLastIdx`.) The C runtime
                // ignores this argument on both receivers, which is a
                // gap rather than a stance and is tracked as one — the
                // lanes therefore differ here, S023's closing note.
                // `indexOf` and
                // `includes` scan up from it, so `relIdx` says the whole
                // thing: its clamp at `len` leaves the loop with nothing
                // to do, which is the spec's `n >= len` answer.
                //
                // `lastIndexOf` needs its own normalization rather than
                // `relIdx`, because it defaults to the LAST index and its
                // negative does not clamp at zero: a start that lands
                // below zero scans nothing at all, where `relIdx` would
                // helpfully move it to 0 and find a match JS does not
                // ([1,2,3].lastIndexOf(1, -5) is -1, not 0).
                if (method === "lastIndexOf") {
                  // The ONE index argument whose spec branches on
                  // PRESENCE rather than on the value: absent takes
                  // len - 1, but an explicit `undefined` is present and
                  // ToIntegerOrInfinity's it to 0, which searches index
                  // 0 alone. Hence the two different defaults — see
                  // `idxArg`.
                  c.localGet(1);
                  c.i32Const(1);
                  c.localGet(N);
                  c.f64ConvertI32U();
                  c.f64Const(1);
                  c.f64Sub();
                  c.f64Const(0);
                  c.f64Const(0);
                  c.localGet(2);
                  c.call(this.idxArg());
                  c.localSet(F0);
                  bailIfPending();
                  c.localGet(F0);
                  c.f64Const(0);
                  c.f64Lt();
                  c.ifVoid();
                  c.localGet(N);
                  c.f64ConvertI32U();
                  c.localGet(F0);
                  c.f64Add();
                  c.localSet(F0);
                  c.end();
                  // I is the countdown's EXCLUSIVE top, so the scan runs
                  // over min(start, len - 1) down to 0 — or over nothing,
                  // for a start still negative after the shift.
                  c.localGet(F0);
                  c.f64Const(0);
                  c.f64Lt();
                  c.ifResult(I32);
                  c.i32Const(0);
                  c.else_();
                  c.localGet(F0);
                  c.localGet(N);
                  c.f64ConvertI32U();
                  c.f64Const(1);
                  c.f64Sub();
                  c.f64Gt();
                  c.ifResult(I32);
                  c.localGet(N);
                  c.else_();
                  c.localGet(F0);
                  c.i32TruncF64S();
                  c.i32Const(1);
                  c.i32Add();
                  c.end();
                  c.end();
                  c.localSet(I);
                  c.block();
                  c.loop();
                  c.localGet(I);
                  c.i32Eqz();
                  c.brIf(1);
                  c.localGet(I);
                  c.i32Const(1);
                  c.i32Sub();
                  c.localSet(I);
                  elemAt(I);
                  c.localGet(CB);
                  c.call(this.strictEq());
                  c.ifVoid();
                  this.boxNum(c, (x) => {
                    x.localGet(I);
                    x.f64ConvertI32U();
                  });
                  c.return_();
                  c.end();
                  c.br(0);
                  c.end();
                  c.end();
                  this.boxNum(c, (x) => x.f64Const(-1));
                  return;
                }
                c.localGet(1);
                c.i32Const(1);
                c.f64Const(0);
                c.f64Const(0);
                c.f64Const(0);
                c.localGet(2);
                c.call(this.idxArg());
                c.localSet(F0);
                bailIfPending();
                c.localGet(F0);
                c.localGet(N);
                c.call(this.relIdx());
                c.localSet(I);
                forLoop(
                  () => c.localGet(N),
                  () => {
                    elemAt(I);
                    c.localGet(CB);
                    // `includes` matches NaN where the other two do not:
                    // SameValueZero against strict equality, JS's own
                    // split (`svZero`).
                    c.call(method === "includes" ? this.svZero() : this.strictEq());
                    c.ifVoid();
                    if (method === "includes") this.boxBool(c, (x) => x.i32Const(1));
                    else {
                      this.boxNum(c, (x) => {
                        x.localGet(I);
                        x.f64ConvertI32U();
                      });
                    }
                    c.return_();
                    c.end();
                  },
                );
                if (method === "includes") this.boxBool(c, (x) => x.i32Const(0));
                else this.boxNum(c, (x) => x.f64Const(-1));
                return;
              }
              case "join": {
                // The separator: an explicit non-undefined argument's
                // TEXT, "," otherwise. Nested rather than `i32.and` —
                // the kind read below indexes the vector.
                this.deps.lit(c, ",");
                c.localSet(S);
                c.localGet(ARGC);
                c.ifVoid();
                this.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(0));
                c.localTee(M);
                c.structGet(dynT, DYN_KIND);
                c.i32Const(DK.UNDEF);
                c.i32Ne();
                c.ifVoid();
                c.localGet(M);
                c.call(this.toStr());
                c.localSet(S);
                c.end();
                c.end();
                this.deps.lit(c, "");
                c.localSet(MSG);
                c.i32Const(0);
                c.localSet(I);
                forLoop(
                  () => c.localGet(N),
                  () => {
                    c.localGet(I);
                    c.ifVoid();
                    c.localGet(MSG);
                    c.localGet(S);
                    c.call(concat);
                    c.localSet(MSG);
                    c.end();
                    // A null or undefined ELEMENT contributes nothing —
                    // Array.prototype.join's own rule, and toStr's array
                    // arm says the same thing one level down.
                    elemAt(I);
                    c.localTee(E);
                    c.structGet(dynT, DYN_KIND);
                    c.localSet(B);
                    c.localGet(B);
                    c.i32Const(DK.UNDEF);
                    c.i32Eq();
                    c.localGet(B);
                    c.i32Const(DK.NULL);
                    c.i32Eq();
                    c.i32Or();
                    c.i32Eqz();
                    c.ifVoid();
                    c.localGet(MSG);
                    c.localGet(E);
                    c.call(this.toStr());
                    c.call(concat);
                    c.localSet(MSG);
                    c.end();
                  },
                );
                this.boxStr(c, (x) => x.localGet(MSG));
                return;
              }
              case "concat": {
                this.pushNewArr(c);
                c.localSet(OUT);
                c.i32Const(0);
                c.localSet(I);
                forLoop(
                  () => c.localGet(N),
                  () => {
                    c.localGet(OUT);
                    elemAt(I);
                    c.call(this.arrPush());
                  },
                );
                c.i32Const(0);
                c.localSet(I);
                forLoop(
                  () => c.localGet(ARGC),
                  () => {
                    this.arrAt(c, (x) => x.localGet(1), (x) => x.localGet(I));
                    c.localTee(E);
                    c.structGet(dynT, DYN_KIND);
                    c.i32Const(DK.ARR);
                    c.i32Eq();
                    c.ifVoid();
                    // An ARRAY argument spills its elements — one level,
                    // JS's own concat depth.
                    this.arrPayload(c, (x) => x.localGet(E));
                    c.localSet(A2);
                    c.i32Const(0);
                    c.localSet(J);
                    c.block();
                    c.loop();
                    c.localGet(J);
                    this.arrLen(c, (x) => x.localGet(A2));
                    c.i32GeU();
                    c.brIf(1);
                    c.localGet(OUT);
                    this.arrAt(c, (x) => x.localGet(A2), (x) => x.localGet(J));
                    c.call(this.arrPush());
                    c.localGet(J);
                    c.i32Const(1);
                    c.i32Add();
                    c.localSet(J);
                    c.br(0);
                    c.end();
                    c.end();
                    c.else_();
                    c.localGet(OUT);
                    c.localGet(E);
                    c.call(this.arrPush());
                    c.end();
                  },
                );
                this.boxArr(c, (x) => x.localGet(OUT));
                return;
              }
              case "reverse": {
                c.i32Const(0);
                c.localSet(I);
                forLoop(
                  () => {
                    c.localGet(N);
                    c.i32Const(1);
                    c.i32ShrU();
                  },
                  () => {
                    c.localGet(N);
                    c.i32Const(1);
                    c.i32Sub();
                    c.localGet(I);
                    c.i32Sub();
                    c.localSet(J);
                    elemAt(I);
                    c.localSet(E);
                    this.arrSet(
                      c,
                      (x) => x.localGet(A),
                      (x) => x.localGet(I),
                      (x) => this.arrAt(x, (y) => y.localGet(A), (y) => y.localGet(J)),
                    );
                    this.arrSet(
                      c,
                      (x) => x.localGet(A),
                      (x) => x.localGet(J),
                      (x) => x.localGet(E),
                    );
                  },
                );
                // Reverse answers the RECEIVER, by identity.
                c.localGet(0);
                return;
              }
              case "sort": {
                argAt(0);
                c.localTee(CB);
                c.structGet(dynT, DYN_KIND);
                c.localSet(B);
                c.localGet(B);
                c.i32Const(DK.UNDEF);
                c.i32Ne();
                c.localGet(B);
                c.i32Const(DK.FUNC);
                c.i32Ne();
                c.i32And();
                c.ifVoid();
                // V8 folds the whole received VALUE in here — unlike the
                // callback gate above, which names its type. The image is
                // NOT `String(v)`: building a message must not run user
                // code, so an object renders "#<Object>" and an array
                // "[object Array]" (`v8Str`, measured against Node).
                this.deps.lit(c, "The comparison function must be either a function or undefined: ");
                c.localGet(CB);
                c.call(this.v8Str());
                c.call(concat);
                c.localSet(MSG);
                this.deps.throwTypeError(c, (x) => x.localGet(MSG));
                c.refNull(dynT);
                c.return_();
                c.end();
                c.localGet(N);
                c.i32Const(1);
                c.i32GtU();
                c.ifVoid();
                c.localGet(A);
                c.localGet(B);
                c.i32Const(DK.FUNC);
                c.i32Eq();
                c.ifResult(this.dynRef());
                c.localGet(CB);
                c.else_();
                c.refNull(dynT);
                c.end();
                c.call(this.sortArr());
                c.i32Eqz();
                c.ifVoid();
                c.refNull(dynT);
                c.return_();
                c.end();
                c.end();
                c.localGet(0);
                return;
              }
              case "forEach":
              case "map":
              case "filter":
              case "some":
              case "every":
              case "find":
              case "findIndex":
              // `flatMap` is UNREACHABLE today: the frontend's dispatch
              // allowlist does not carry the name, so no `dynInvoke` node
              // ever asks for this helper. The arm stays filled anyway,
              // on the S019 ERR_-arm precedent and the sequencing rule
              // this file runs on — an arm transcribed before its
              // producer exists is one that lands RIGHT when the producer
              // does. Adding the name to DYN_DISPATCH_METHODS is the
              // whole of its activation.
              case "flatMap": {
                c.localGet(1);
                c.call(this.cbGate());
                c.i32Eqz();
                c.ifVoid();
                c.refNull(dynT);
                c.return_();
                c.end();
                this.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(0));
                c.localSet(CB);
                const collects = method === "map" || method === "filter" || method === "flatMap";
                if (collects) {
                  this.pushNewArr(c);
                  c.localSet(OUT);
                }
                if (method === "map") {
                  // map binds `len` for its RESULT too (the spec builds
                  // the output array at exactly that length before the
                  // first step), so the output is pre-filled here and the
                  // loop WRITES rather than appends. A step the shrink
                  // guard below skips therefore leaves its slot at THE
                  // undefined immortal, where Node leaves a HOLE: length,
                  // `join`'s empty rendering and an indexed read all
                  // agree, and only ENUMERATION parts company — the
                  // padded-slot difference SEMANTICS.md S016 registers.
                  c.i32Const(0);
                  c.localSet(I);
                  forLoop(
                    () => c.localGet(N),
                    () => {
                      c.localGet(OUT);
                      c.globalGet(this.undefinedGlobal());
                      c.call(this.arrPush());
                    },
                  );
                }
                c.i32Const(0);
                c.localSet(I);
                // THE LENGTH IS CAPTURED ONCE — every method here reads
                // it before the first step and never again, so elements
                // the callback APPENDS are not visited. That is the
                // spec's shape (`len` is bound before the Repeat) and
                // Node's behavior, verified; the C runtime re-reads the
                // length as its limit and does visit them, which is a
                // bug this lane does not inherit. The elements
                // themselves stay live: each step re-reads `A[i]`, so an
                // in-place write IS seen, and an index the array has
                // since SHRUNK past is SKIPPED rather than called for —
                // JS skips it too (HasProperty is false there), and a
                // dense vector has nothing to read. `map`'s OUTPUT keeps
                // the captured length across that skip; the other
                // collectors are dense in Node too, so theirs simply
                // ends up shorter.
                /** What one surviving step does with the callback's
                 * answer, once the shrink guard and the throw check are
                 * behind it. */
                const consume = (): void => {
                  if (method === "map") {
                    // Into the slot this step OWNS — the output was
                    // pre-sized above, so a skipped step leaves a gap
                    // rather than closing it up.
                    this.arrSet(
                      c,
                      (x) => x.localGet(OUT),
                      (x) => x.localGet(I),
                      (x) => x.localGet(R),
                    );
                    return;
                  }
                  if (method === "flatMap") {
                    c.localGet(R);
                    c.structGet(dynT, DYN_KIND);
                    c.i32Const(DK.ARR);
                    c.i32Eq();
                    c.ifVoid();
                    this.arrPayload(c, (x) => x.localGet(R));
                    c.localSet(A2);
                    c.i32Const(0);
                    c.localSet(J);
                    c.block();
                    c.loop();
                    c.localGet(J);
                    this.arrLen(c, (x) => x.localGet(A2));
                    c.i32GeU();
                    c.brIf(1);
                    c.localGet(OUT);
                    this.arrAt(c, (x) => x.localGet(A2), (x) => x.localGet(J));
                    c.call(this.arrPush());
                    c.localGet(J);
                    c.i32Const(1);
                    c.i32Add();
                    c.localSet(J);
                    c.br(0);
                    c.end();
                    c.end();
                    c.else_();
                    // A non-array result stays whole — JS keeps it.
                    c.localGet(OUT);
                    c.localGet(R);
                    c.call(this.arrPush());
                    c.end();
                    return;
                  }
                  c.localGet(R);
                  c.call(this.truthy());
                  c.localSet(B);
                  if (method === "filter") {
                    c.localGet(B);
                    c.ifVoid();
                    c.localGet(OUT);
                    c.localGet(E);
                    c.call(this.arrPush());
                    c.end();
                    return;
                  }
                  if (method === "forEach") return;
                  // The four that ANSWER from inside the loop.
                  c.localGet(B);
                  if (method === "every") c.i32Eqz();
                  c.ifVoid();
                  if (method === "some") this.boxBool(c, (x) => x.i32Const(1));
                  else if (method === "every") this.boxBool(c, (x) => x.i32Const(0));
                  else if (method === "find") c.localGet(E);
                  else {
                    this.boxNum(c, (x) => {
                      x.localGet(I);
                      x.f64ConvertI32U();
                    });
                  }
                  c.return_();
                  c.end();
                };
                forLoop(
                  () => c.localGet(N),
                  () => {
                    c.localGet(I);
                    liveLen();
                    c.i32LtU();
                    c.ifVoid();
                    elemAt(I);
                    c.localSet(E);
                    c.localGet(CB);
                    c.localGet(E);
                    c.localGet(I);
                    c.localGet(0);
                    c.call(this.callCb());
                    c.localTee(R);
                    c.refIsNull();
                    c.ifVoid();
                    c.refNull(dynT);
                    c.return_();
                    c.end();
                    consume();
                    c.end();
                  },
                );
                if (collects) this.boxArr(c, (x) => x.localGet(OUT));
                else if (method === "some") this.boxBool(c, (x) => x.i32Const(0));
                else if (method === "every") this.boxBool(c, (x) => x.i32Const(1));
                else if (method === "findIndex") this.boxNum(c, (x) => x.f64Const(-1));
                else c.globalGet(this.undefinedGlobal()); // forEach, find
                return;
              }
              default:
                // ARR_METHODS and this switch are one list; a name in the
                // set with no arm is an emitter bug, not a runtime one.
                throw new Error(`wasm emitter bug: no ARR arm for dyn invoke '${method}'`);
            }
          });
        }

        if (DynBuilder.STR_METHODS.has(method)) {
          this.arm(c, K, [DK.STR], () => {
            c.localGet(0);
            c.structGet(dynT, DYN_REF);
            c.refCast(this.deps.strType());
            c.localSet(S);
            if (method === "slice") {
              c.localGet(1);
              c.i32Const(0);
              c.f64Const(0);
              c.f64Const(0);
              c.f64Const(0);
              c.localGet(2);
              c.call(this.idxArg());
              c.localSet(F0);
              bailIfPending();
              // The end's undefined case IS its default here too.
              c.localGet(1);
              c.i32Const(1);
              c.localGet(S);
              c.arrayLen();
              c.f64ConvertI32U();
              c.localGet(S);
              c.arrayLen();
              c.f64ConvertI32U();
              c.f64Const(0);
              c.localGet(2);
              c.call(this.idxArg());
              c.localSet(F1);
              bailIfPending();
              this.boxStr(c, (x) => {
                x.localGet(S);
                x.localGet(F0);
                x.localGet(F1);
                x.call(this.deps.strSlice());
              });
              return;
            }
            if (method === "at") {
              // Mirrors the ARRAY "at" arm above exactly (idxArg's
              // relative-index resolve, negative-wraps-from-end,
              // out-of-range → undefined — surfaces.ts's own note: the
              // validated exit throws Node's catchable TypeError for
              // THAT case, not this op), reading a UTF-16 code UNIT
              // slice instead of an array element (1113's measured
              // need: `.at()` on a plain ASCII string — code-unit vs.
              // code-point indexing is not a distinguishable question
              // for it, and no target program exercises an astral
              // index here).
              c.localGet(1);
              c.i32Const(0);
              c.f64Const(0);
              c.f64Const(0);
              c.f64Const(0);
              c.localGet(2);
              c.call(this.idxArg());
              c.localSet(F0);
              bailIfPending();
              c.localGet(F0);
              c.f64Const(0);
              c.f64Lt();
              c.ifVoid();
              c.localGet(S);
              c.arrayLen();
              c.f64ConvertI32U();
              c.localGet(F0);
              c.f64Add();
              c.localSet(F0);
              c.end();
              c.localGet(F0);
              c.f64Const(0);
              c.f64Lt();
              c.localGet(F0);
              c.localGet(S);
              c.arrayLen();
              c.f64ConvertI32U();
              c.f64Ge();
              c.i32Or();
              c.ifVoid();
              c.globalGet(this.undefinedGlobal());
              c.return_();
              c.end();
              this.boxStr(c, (x) => {
                x.localGet(S);
                x.localGet(F0);
                x.localGet(F0);
                x.f64Const(1);
                x.f64Add();
                x.call(this.deps.strSlice());
              });
              return;
            }
            if (method === "concat") {
              throwUnsupported("String");
              return;
            }
            if (method === "charAt") {
              // Oracle-measured (unlike `.at`): NO negative wrap, and
              // out-of-range answers "" rather than undefined —
              // `"hello".charAt(-1)` and `.charAt(10)` are both "",
              // `.charAt()` (no arg, ToIntegerOrInfinity default 0) is
              // "h". `idxArg`'s own default-0 behavior on a missing/
              // undefined argument already matches this.
              c.localGet(1);
              c.i32Const(0);
              c.f64Const(0);
              c.f64Const(0);
              c.f64Const(0);
              c.localGet(2);
              c.call(this.idxArg());
              c.localSet(F0);
              bailIfPending();
              c.localGet(F0);
              c.f64Const(0);
              c.f64Lt();
              c.localGet(F0);
              c.localGet(S);
              c.arrayLen();
              c.f64ConvertI32U();
              c.f64Ge();
              c.i32Or();
              c.ifResult(this.dynRef());
              this.boxStr(c, (x) => this.deps.lit(x, ""));
              c.else_();
              this.boxStr(c, (x) => {
                x.localGet(S);
                x.localGet(F0);
                x.localGet(F0);
                x.f64Const(1);
                x.f64Add();
                x.call(this.deps.strSlice());
              });
              c.end();
              return;
            }
            if (method === "replace" || method === "replaceAll") {
              // surfaces.ts's ISLAND_SURFACE table declares both STRING-
              // only (`args: [STRING, STRING]`, no regex form) — the
              // island-surface call sites (1113/1114) always marshal
              // real strings; a non-STR argument is not a reachable
              // shape from that path, checked anyway (the same
              // discipline indexOf/lastIndexOf/includes use below) so a
              // future genuinely-dynamic caller fences loudly rather
              // than trapping a bad refCast.
              c.localGet(ARGC);
              c.i32Const(2);
              c.i32GeU();
              c.ifVoid();
              this.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(0));
              c.localTee(M);
              c.structGet(dynT, DYN_KIND);
              c.i32Const(DK.STR);
              c.i32Eq();
              this.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(1));
              c.structGet(dynT, DYN_KIND);
              c.i32Const(DK.STR);
              c.i32Eq();
              c.i32And();
              c.ifVoid();
              this.boxStr(c, (x) => {
                x.localGet(S);
                x.localGet(M);
                x.structGet(dynT, DYN_REF);
                x.refCast(this.deps.strType());
                this.arrAt(x, (y) => y.localGet(1), (y) => y.i32Const(1));
                x.structGet(dynT, DYN_REF);
                x.refCast(this.deps.strType());
                x.call(this.strReplaceHelper(method === "replaceAll"));
              });
              c.return_();
              c.end();
              c.end();
              throwUnsupported("String");
              return;
            }
            // indexOf / lastIndexOf / includes: real when the needle is
            // itself a string, the loud fence otherwise (Node ToStrings
            // it; this tier has no coercion — C's exact split).
            c.localGet(ARGC);
            c.i32Const(1);
            c.i32GeU();
            c.ifVoid();
            this.arrAt(c, (x) => x.localGet(1), (x) => x.i32Const(0));
            c.localTee(M);
            c.structGet(dynT, DYN_KIND);
            c.i32Const(DK.STR);
            c.i32Eq();
            c.ifVoid();
            c.localGet(M);
            c.structGet(dynT, DYN_REF);
            c.refCast(this.deps.strType());
            c.localSet(MSG);
            // Argument 1 is the position. A STRING's is CLAMPED to
            // [0, len] rather than taken relatively — `"abcabc"
            // .indexOf("a", -2)` is 0, where the array method's -2 would
            // count from the end. Both callees below own that clamp
            // (%w.str.indexOf documents its own; `strLastIdx` mirrors
            // it), so the raw double goes straight through.
            c.localGet(1);
            c.i32Const(1);
            if (method === "lastIndexOf") {
              // ...and lastIndexOf takes ToNumber, not
              // ToIntegerOrInfinity: a missing position, an explicit
              // `undefined` and an explicit NaN all mean +∞, which the
              // clamp turns into `len` — the whole string, JS-exact.
              // (Unlike the ARRAY method above, presence changes
              // nothing here: ToNumber(undefined) is NaN either way.)
              c.f64Const(Infinity);
              c.f64Const(Infinity);
              c.f64Const(Infinity);
            } else {
              c.f64Const(0);
              c.f64Const(0);
              c.f64Const(0);
            }
            c.localGet(2);
            c.call(this.idxArg());
            c.localSet(F0);
            bailIfPending();
            if (method === "lastIndexOf") {
              this.boxNum(c, (x) => {
                x.localGet(S);
                x.localGet(MSG);
                x.localGet(F0);
                x.call(this.strLastIdx());
              });
            } else if (method === "includes") {
              this.boxBool(c, (x) => {
                x.localGet(S);
                x.localGet(MSG);
                x.localGet(F0);
                x.call(this.deps.strIndexOf());
                x.f64Const(-1);
                x.f64Ne();
              });
            } else {
              this.boxNum(c, (x) => {
                x.localGet(S);
                x.localGet(MSG);
                x.localGet(F0);
                x.call(this.deps.strIndexOf());
              });
            }
            c.return_();
            c.end();
            c.end();
            throwUnsupported("String");
          });
        }

        // Number.prototype (increment 21 stage B, gate 2/review round 1):
        // toString (base-10 fast path via f64ToStr; an EXPLICIT non-10
        // radix FENCES loudly rather than silently answering the base-10
        // text — SB2: fractional-radix formatting is V8-internals
        // (DoubleToRadixCString) with zero measured corpus need, and a
        // wrong-base digit string is exactly the "silently wrong" shape
        // the project's absolute rule forbids) and toFixed (2084/761/
        // 765's measured need, ECMA-262 Number::toFixed ported to
        // %w.dyn.toFixed). Every OTHER NUM receiver call — the
        // remaining four placeholder names (toLocaleString/valueOf/
        // toExponential/toPrecision) reached this way rather than
        // through the callFn placeholder rescue, and any name NUM's
        // prototype does not declare — falls through to `throwNotFn()`
        // below, Node's own answer for a missing method.
        if (DynBuilder.NUM_METHODS.has(method)) {
          this.arm(c, K, [DK.NUM], () => {
            if (method === "toFixed") {
              // The RECEIVER is already NUM-kind (this arm's own guard);
              // the DIGITS argument gets the full ToNumber conversion
              // (SB4, review round 1: `(5).toFixed("2")` → "5.00",
              // oracle-measured — a bare DYN_NUM read on a non-NUM
              // argument would read the union's OTHER field, garbage).
              this.boxStr(c, (x) => {
                x.localGet(0);
                x.structGet(dynT, DYN_NUM);
                argAt(0);
                x.call(this.deps.jsToNumber());
                x.call(this.toFixed());
              });
              return;
            }
            // toString: an ABSENT radix, or an explicit one that is
            // (loosely) the number 10, is exactly the base-10 answer
            // f64ToStr already gives — anything else (a real base, or a
            // non-numeric radix ToNumber would coerce) fences.
            argAt(0);
            c.localTee(M);
            c.structGet(dynT, DYN_KIND);
            c.i32Const(DK.UNDEF);
            c.i32Eq();
            c.localGet(M);
            c.structGet(dynT, DYN_KIND);
            c.i32Const(DK.NUM);
            c.i32Eq();
            c.localGet(M);
            c.structGet(dynT, DYN_NUM);
            c.f64Const(10);
            c.f64Eq();
            c.i32And();
            c.i32Or();
            c.ifVoid();
            this.boxStr(c, (x) => {
              x.localGet(0);
              x.structGet(dynT, DYN_NUM);
              x.call(this.deps.f64ToStr());
            });
            c.return_();
            c.end();
            this.deps.throwError(c, "%Error", "Error", (x) =>
              this.deps.lit(x, "'Number.prototype.toString' with a radix other than 10 is not supported yet"),
            );
            c.refNull(dynT);
          });
        }

        // BYTES, HANDLE and JSVAL boxes are UNCONSTRUCTIBLE on this tier
        // (their producers are libCalls the backend refuses), so their
        // arms cannot be reached — and a trap says so, where the
        // is-not-a-function tail below would be a quiet wrong answer for
        // the names their prototypes really do declare.
        this.arm(c, K, [DK.BYTES, DK.HANDLE, DK.JSVAL], () => c.unreachable());

        // NUM, BOOL, PROMISE, and FUNC/ARR/STR for the names their own
        // prototypes do not declare: JS's own answer.
        throwNotFn();
        this.mb.setBody(
          idx,
          [
            I32, // K
            this.arrRef(), // A
            I32, // N
            I32, // I
            I32, // ARGC
            this.arrRef(), // OUT
            this.dynRef(), // E
            this.dynRef(), // R
            this.dynRef(), // CB
            this.deps.strRef(), // MSG
            this.deps.strRef(), // S
            F64, // F0
            F64, // F1
            this.dynRef(), // M
            I32, // J
            I32, // B
            this.arrRef(), // A2
          ],
          c.bytes(),
        );
      },
    );
  }

  /* ── increment 21 stage B, gate 2: String.prototype.replace/replaceAll
   * (STRING patterns only — surfaces.ts's ISLAND_SURFACE table declares
   * no regex form) and Number.prototype.toFixed, over the SAME `invoke`
   * ladder above. Oracle-measured corners (scratchpad/oracle2/
   * replace.mjs): `replace` takes the FIRST match only; `replaceAll`
   * with a NON-empty pattern replaces every non-overlapping match left
   * to right; `replaceAll` with the EMPTY pattern inserts at every one
   * of length+1 positions (between every unit and at both ends) —
   * `"aaa".replaceAll("","b")` is `"bababab"`; plain (single) `replace`
   * with an empty pattern inserts ONCE, at position 0 only. The
   * replacement text is NOT inserted raw: `getSubstitutionHelper` runs
   * ECMA-262 GetSubstitution over it first (review round 1, SB5) —
   * `$$`/`$&`/`` $` ``/`$'` expand, everything else (including `$1`-`$9`,
   * never special here since a string pattern has no capture groups) is
   * literal. */

  private strReplaceOnceFunc: number | null = null;
  private strReplaceAllFunc: number | null = null;

  /** %w.strReplace{Once,All}(s, pat, repl) → str. */
  private strReplaceHelper(all: boolean): number {
    const cached = all ? this.strReplaceAllFunc : this.strReplaceOnceFunc;
    if (cached !== null) return cached;
    const strRef = this.deps.strRef();
    const idx = this.mb.declareFunc(
      this.mb.funcType([strRef, strRef, strRef], [strRef]),
      all ? "%w.strReplaceAll" : "%w.strReplaceOnce",
    );
    if (all) this.strReplaceAllFunc = idx;
    else this.strReplaceOnceFunc = idx;
    const c = new Code();
    const S = 0, PAT = 1, REPL = 2;
    const L = 3, NL = 4, POS = 5, AT = 6, OUT = 7;
    const indexOf = this.deps.strIndexOf();
    const slice = this.deps.strSlice();
    const concat = this.deps.concat();
    c.localGet(S);
    c.arrayLen();
    c.localSet(L);
    c.localGet(PAT);
    c.arrayLen();
    c.localSet(NL);
    if (!all) {
      // Single replace: one match (or none) — the empty pattern matches
      // at position 0 only (strIndexOf's own "empty needle found at the
      // clamped position" rule, clamped from fromIndex=0).
      c.localGet(S);
      c.localGet(PAT);
      c.f64Const(0);
      c.call(indexOf);
      c.localSet(POS);
      c.localGet(POS);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(strRef);
      c.localGet(S);
      c.else_();
      {
        c.localGet(S);
        c.i32Const(0);
        c.f64ConvertI32S();
        c.localGet(POS);
        c.call(slice);
        // GetSubstitution (SB5, review round 1): $$/$&/$`/$' now expand
        // against the match at [POS, POS+NL) — a raw REPL concat used to
        // pass every `$`-form through as literal text.
        c.localGet(S);
        c.localGet(POS);
        c.localGet(NL);
        c.f64ConvertI32S();
        c.localGet(REPL);
        c.call(this.getSubstitutionHelper());
        c.call(concat);
        c.localGet(S);
        c.localGet(POS);
        c.localGet(NL);
        c.f64ConvertI32S();
        c.f64Add();
        c.localGet(L);
        c.f64ConvertI32S();
        c.call(slice);
        c.call(concat);
      }
      c.end();
      this.mb.setBody(idx, [I32, I32, F64], c.bytes());
      return idx;
    }
    // replaceAll, non-empty pattern: scan left to right, advancing past
    // each match's SOURCE span (never into `repl`'s own text — matches
    // are found in the ORIGINAL string, `strIndexOf` never sees `repl`).
    // Empty pattern: NL===0 forces `strIndexOf` to answer POS itself
    // every time, so the generic loop below would spin forever advancing
    // by 0 — the empty-pattern case is walked explicitly instead, one
    // unit at a time, `repl` between and at both ends.
    c.localGet(NL);
    c.i32Eqz();
    c.ifResult(strRef);
    {
      this.deps.lit(c, "");
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(AT);
      c.block();
      c.loop();
      // GetSubstitution (SB5): the empty-pattern insertion's own "match"
      // is zero-length AT this position — $&/$`/$' still expand against
      // it (measured: `"ab".replaceAll("", "[$`-$&-$\'']")` sees a real,
      // if empty, $& at every insertion point).
      c.localGet(OUT);
      c.localGet(S);
      c.localGet(AT);
      c.f64ConvertI32S();
      c.f64Const(0);
      c.localGet(REPL);
      c.call(this.getSubstitutionHelper());
      c.call(concat);
      c.localSet(OUT);
      c.localGet(AT);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);
      c.localGet(OUT);
      c.localGet(S);
      c.localGet(AT);
      c.f64ConvertI32S();
      c.localGet(AT);
      c.i32Const(1);
      c.i32Add();
      c.f64ConvertI32S();
      c.call(slice);
      c.call(concat);
      c.localSet(OUT);
      c.localGet(AT);
      c.i32Const(1);
      c.i32Add();
      c.localSet(AT);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUT);
    }
    c.else_();
    {
      this.deps.lit(c, "");
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(POS);
      c.block();
      c.loop();
      c.localGet(S);
      c.localGet(PAT);
      c.localGet(POS);
      c.f64ConvertI32S();
      c.call(indexOf);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.localGet(OUT);
      c.localGet(S);
      c.localGet(POS);
      c.f64ConvertI32S();
      c.localGet(L);
      c.f64ConvertI32S();
      c.call(slice);
      c.call(concat);
      c.localSet(OUT);
      c.br(2);
      c.end();
      c.localGet(S);
      c.localGet(PAT);
      c.localGet(POS);
      c.f64ConvertI32S();
      c.call(indexOf);
      c.i32TruncF64S();
      c.localSet(AT);
      c.localGet(OUT);
      c.localGet(S);
      c.localGet(POS);
      c.f64ConvertI32S();
      c.localGet(AT);
      c.f64ConvertI32S();
      c.call(slice);
      c.call(concat);
      // GetSubstitution (SB5): the match found at AT, length NL.
      c.localGet(S);
      c.localGet(AT);
      c.f64ConvertI32S();
      c.localGet(NL);
      c.f64ConvertI32S();
      c.localGet(REPL);
      c.call(this.getSubstitutionHelper());
      c.call(concat);
      c.localSet(OUT);
      c.localGet(AT);
      c.localGet(NL);
      c.i32Add();
      c.localSet(POS);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUT);
    }
    c.end();
    this.mb.setBody(idx, [I32, I32, I32, I32, strRef], c.bytes());
    return idx;
  }

  private getSubstitutionFunc: number | null = null;

  /** %w.getSubstitution(s, mStart, mLen, repl) → str — ECMA-262
   * GetSubstitution, the STRING-PATTERN subset (no capture groups exist
   * for a plain-string `replace`/`replaceAll` pattern, so `$1`-`$9`/`$<name>`
   * are never special — Node's own answer, oracle-measured:
   * `"abc".replace("b","$1")` → `"a$1c"`, the `$` and digit both literal).
   * `$$` → one `$`; `$&` → the matched substring `s.slice(mStart,
   * mStart+mLen)`; `` $` `` → the prefix `s.slice(0, mStart)`; `$'` → the
   * suffix `s.slice(mStart+mLen, s.length)`; a `$` with no recognized
   * following character (including a TRAILING `$`) passes through as a
   * literal `$`, consuming only itself — oracle-measured (review round
   * 1, SB5): `"abc".replace("b","$")` → `"a$c"`, `"abc".replace("b","$x")`
   * → `"a$xc"`. */
  private getSubstitutionHelper(): number {
    if (this.getSubstitutionFunc !== null) return this.getSubstitutionFunc;
    const strRef = this.deps.strRef();
    const strType = this.deps.strType();
    const idx = this.mb.declareFunc(this.mb.funcType([strRef, F64, F64, strRef], [strRef]), "%w.getSubstitution");
    this.getSubstitutionFunc = idx;
    const c = new Code();
    const S = 0, MSTART = 1, MLEN = 2, REPL = 3;
    const RL = 4, SL = 5, I = 6, OUT = 7, C1 = 8, APPEND = 9, SKIP = 10;
    const slice = this.deps.strSlice();
    const concat = this.deps.concat();
    c.localGet(REPL);
    c.arrayLen();
    c.localSet(RL);
    c.localGet(S);
    c.arrayLen();
    c.localSet(SL);
    this.deps.lit(c, "");
    c.localSet(OUT);
    c.i32Const(0);
    c.localSet(I);
    c.block();
    c.loop();
    c.localGet(I);
    c.localGet(RL);
    c.i32GeS();
    c.brIf(1);
    // Default: one literal character, advance by 1.
    c.localGet(REPL);
    c.localGet(I);
    c.f64ConvertI32S();
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.f64ConvertI32S();
    c.call(slice);
    c.localSet(APPEND);
    c.i32Const(1);
    c.localSet(SKIP);
    c.localGet(REPL);
    c.localGet(I);
    c.arrayGetU(strType);
    c.i32Const(0x24); // '$'
    c.i32Eq();
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localGet(RL);
    c.i32LtS();
    c.i32And();
    c.ifVoid();
    {
      c.localGet(REPL);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strType);
      c.localSet(C1);
      c.localGet(C1);
      c.i32Const(0x24); // '$'
      c.i32Eq();
      c.ifVoid();
      this.deps.lit(c, "$");
      c.localSet(APPEND);
      c.i32Const(2);
      c.localSet(SKIP);
      c.else_();
      {
        c.localGet(C1);
        c.i32Const(0x26); // '&'
        c.i32Eq();
        c.ifVoid();
        c.localGet(S);
        c.localGet(MSTART);
        c.localGet(MSTART);
        c.localGet(MLEN);
        c.f64Add();
        c.call(slice);
        c.localSet(APPEND);
        c.i32Const(2);
        c.localSet(SKIP);
        c.else_();
        {
          c.localGet(C1);
          c.i32Const(0x60); // '`'
          c.i32Eq();
          c.ifVoid();
          c.localGet(S);
          c.f64Const(0);
          c.localGet(MSTART);
          c.call(slice);
          c.localSet(APPEND);
          c.i32Const(2);
          c.localSet(SKIP);
          c.else_();
          {
            c.localGet(C1);
            c.i32Const(0x27); // "'"
            c.i32Eq();
            c.ifVoid();
            c.localGet(S);
            c.localGet(MSTART);
            c.localGet(MLEN);
            c.f64Add();
            c.localGet(SL);
            c.f64ConvertI32S();
            c.call(slice);
            c.localSet(APPEND);
            c.i32Const(2);
            c.localSet(SKIP);
            c.else_();
            // '$' with no recognized follower: literal '$', consume 1.
            this.deps.lit(c, "$");
            c.localSet(APPEND);
            c.i32Const(1);
            c.localSet(SKIP);
            c.end();
          }
          c.end();
        }
        c.end();
      }
      c.end();
    }
    c.end();
    c.localGet(OUT);
    c.localGet(APPEND);
    c.call(concat);
    c.localSet(OUT);
    c.localGet(I);
    c.localGet(SKIP);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end();
    c.end();
    c.localGet(OUT);
    this.mb.setBody(idx, [I32, I32, I32, strRef, I32, strRef, I32], c.bytes());
    return idx;
  }

  private toFixedFunc: number | null = null;

  /** %w.dyn.toFixed(x, f) → str — ECMA-262 Number::toFixed. `f<0` or
   * `f>100` (Infinity/-Infinity included, and NaN — ToIntegerOrInfinity's
   * own NaN→0 rule keeps that ONE case in range) throws Node's exact
   * RangeError BEFORE `x` is even inspected — oracle-measured, review
   * round 1 SB3/SB4 (`NaN.toFixed(101)` throws, it does not answer
   * "NaN"); non-finite `x` and `|x|>=1e21` both pass through `f64ToStr`
   * unconverted, Node's own Number::toString(x,10) fallback. Rounding
   * for everything else: `floor(scaled + 0.5)` — round-half-up on the
   * (already non-negative) scaled magnitude, which is the spec's
   * "closest n, ties to the larger" rule restated for x≥0. `f64ToStr`
   * on the rounded integer gives its exact digit string (no decimal
   * point/exponent for the magnitudes `ax<1e21` produces here — plain
   * JS integer formatting); the digit
   * string is left-zero-padded to f+1 chars before the split, covering
   * the "ax rounds to fewer significant digits than f wants" case
   * (measured: `(0).toFixed(2)` needs "000" before slicing "0"|"00"). */
  toFixed(): number {
    if (this.toFixedFunc !== null) return this.toFixedFunc;
    const strRef = this.deps.strRef();
    const idx = this.mb.declareFunc(this.mb.funcType([F64, F64], [strRef]), "%w.dyn.toFixed");
    this.toFixedFunc = idx;
    const c = new Code();
    const X = 0, F = 1;
    const FI = 2, SIGN = 3, AX = 4, SCALE = 5, N = 6, DIGITS = 7, DLEN = 8;
    const ID = 9, TMP = 10;
    // Step 1 (review round 1, SB3/SB4): the digits RangeError check runs
    // BEFORE x is even inspected (oracle-measured: `NaN.toFixed(101)`
    // throws, it does not answer "NaN") — `f` is ALREADY ToNumber'd by
    // the caller (SB4: a STR digits argument coerces, e.g. "2" → 2), so
    // this reads the raw f64 directly. IEEE comparisons make F!==F
    // (NaN) fall out of EVERY term below FALSE on their own — no
    // separate isNaN guard needed: ToIntegerOrInfinity(NaN) is 0 (in
    // range), matching `(5).toFixed(NaN)` → "5" measured directly.
    c.localGet(F);
    c.f64Const(Infinity);
    c.f64Eq();
    c.localGet(F);
    c.f64Const(-Infinity);
    c.f64Eq();
    c.i32Or();
    c.localGet(F);
    c.f64Trunc();
    c.f64Const(0);
    c.f64Lt();
    c.i32Or();
    c.localGet(F);
    c.f64Trunc();
    c.f64Const(100);
    c.f64Gt();
    c.i32Or();
    c.ifVoid();
    this.deps.throwError(c, "%RangeError", "RangeError", (x) =>
      this.deps.lit(x, "toFixed() digits argument must be between 0 and 100"),
    );
    c.refNull(this.deps.strType());
    c.return_();
    c.end();
    c.localGet(X);
    c.localGet(X);
    c.f64Ne();
    c.ifResult(strRef);
    this.deps.lit(c, "NaN");
    c.else_();
    {
      // Step 2: non-finite x and |x|>=1e21 both pass THROUGH f64ToStr
      // unconverted — the spec's own Number::toString(x,10) fallback,
      // oracle-measured ("Infinity"/"-Infinity" verbatim; `1e21` and
      // `1e21+1` both render as `f64ToStr`'s exponential text, not a
      // 1-followed-by-21-zeros integer the scale/round path below would
      // wrongly produce for a magnitude this large).
      c.localGet(X);
      c.i64ReinterpretF64();
      c.i64Const(0x7fffffffffffffffn);
      c.i64And();
      c.f64ReinterpretI64();
      c.localSet(AX);
      c.localGet(AX);
      c.f64Const(Infinity);
      c.f64Eq();
      c.localGet(AX);
      c.f64Const(1e21);
      c.f64Ge();
      c.i32Or();
      c.ifResult(strRef);
      c.localGet(X);
      c.call(this.deps.f64ToStr());
      c.else_();
      // `i32.trunc_f64_s` TRAPS on NaN — F itself can be NaN here (the
      // range check above admits it, matching ToIntegerOrInfinity(NaN)
      // = 0 — measured: `(5).toFixed(NaN)` → "5"), so the trunc target
      // is guarded to 0 first rather than fed to the instruction raw.
      c.localGet(F);
      c.localGet(F);
      c.f64Ne();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(F);
      c.f64Trunc();
      c.end();
      c.i32TruncF64S();
      c.localSet(FI);
      // N2 (review round 2): the scale/round path below (AX*10^FI,
      // +0.5, floor) is chained f64 arithmetic, NOT exact — beyond a
      // TOTAL of ~15 significant decimal digits (the integer digits AX
      // already has, PLUS the fractional digits FI asks for), it can
      // produce a WRONG digit, or — once the rounded magnitude leaves
      // the exact-integer window entirely — genuinely GARBLED text
      // (f64ToStr falling back to exponential notation mid-digit-string,
      // observed directly: `(0.1).toFixed(22)` renders as
      // "0.0000000000000000001e+22" on this tier pre-fix). 15 total
      // significant digits is the WELL-ESTABLISHED, PROVEN-SAFE bound
      // for IEEE-754 doubles (a strict subset of the "17 always round-
      // trips" guarantee) — empirically verified here against an EXACT
      // BigInt reference (mantissa × 2^exponent × 10^FI, rounded) across
      // 0.1/5/123.456/9.9999/1e20/1/0.5/999.999/0 and subnormals
      // (5e-300, Number.MIN_VALUE, the smallest normal
      // 2.2250738585072014e-308) for every (value, f) pair inside the
      // bound, f∈[0,100]: zero mismatches. A CONSERVATIVE bound (some
      // "round" values like `(5).toFixed(20)` are exactly correct well
      // past it and still fence) rather than the tightest possible one
      // — deriving the true, value-dependent boundary (trailing-zero-
      // bit-aware) was attempted and rejected as unsound under
      // measurement; a loud, named, catchable fence beyond a safe
      // static bound is the ruling's own explicitly accepted shape.
      //
      // ID's COUNTER STARTS AT 1, not 0 (below), so it lands one HIGHER
      // than AX's actual integer-digit count: for AX>=1 the loop divides
      // once per digit and increments alongside each division, so ID ==
      // intDigits(AX)+1 once it exits (AX=5 -> ID=2; AX=55 -> ID=3); for
      // 0<AX<1 the loop body never runs at all and ID stays at its
      // initial 1, which is ALSO intDigits(AX)+1 under the "zero integer
      // digits" convention (0+1). So `ID+FI>15` below is really
      // `intDigits(AX)+FI > 14`, not `> 15` — the EFFECTIVE safe window
      // is intDigits(AX)+f <= 14, one digit TIGHTER than "15 total
      // significant digits" reads, in the safe (more conservative)
      // direction (still never wrong — just fences a handful of cases,
      // like `(5).toFixed(14)`, that the 15-digit argument alone would
      // have allowed). Measured directly: `(5).toFixed(14)` fences
      // (intDigits=1, f=14, sum=15>14) while `(0.1).toFixed(14)`
      // computes (intDigits=0, f=14, sum=14<=14) — see
      // wasm-emitter.test.ts's "N2 gate-closing pin", which executes
      // both in the same run (the fence branch below shipped as
      // genuinely INVALID wasm once, caught only by a sweep that
      // actually ran it — a pin that only typechecks or asserts refusal
      // without instantiating would have missed it again).
      c.i32Const(1);
      c.localSet(ID);
      c.localGet(AX);
      c.localSet(TMP);
      c.block();
      c.loop();
      c.localGet(TMP);
      c.f64Const(1);
      c.f64Lt();
      c.brIf(1);
      c.localGet(TMP);
      c.f64Const(10);
      c.f64Div();
      c.localSet(TMP);
      c.localGet(ID);
      c.i32Const(1);
      c.i32Add();
      c.localSet(ID);
      c.br(0);
      c.end();
      c.end();
      c.localGet(ID);
      c.localGet(FI);
      c.i32Add();
      c.i32Const(15);
      c.i32GtS();
      c.ifResult(strRef);
      this.deps.throwError(c, "%Error", "Error", (x) =>
        this.deps.lit(x, "'Number.prototype.toFixed' at this precision is not supported yet"),
      );
      c.refNull(this.deps.strType());
      c.else_();
      c.localGet(X);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(strRef);
      this.deps.lit(c, "-");
      c.else_();
      this.deps.lit(c, "");
      c.end();
      c.localSet(SIGN);
      c.localGet(X);
      c.i64ReinterpretF64();
      c.i64Const(0x7fffffffffffffffn);
      c.i64And();
      c.f64ReinterpretI64();
      c.localSet(AX);
      // scale = 10^FI, integer accumulation (FI is small — 0..~20 here).
      c.f64Const(1);
      c.localSet(SCALE);
      c.block();
      c.loop();
      c.localGet(FI);
      c.i32Const(0);
      c.i32LeS();
      c.brIf(1);
      c.localGet(SCALE);
      c.f64Const(10);
      c.f64Mul();
      c.localSet(SCALE);
      c.localGet(FI);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(FI);
      c.br(0);
      c.end();
      c.end();
      // restore FI (the loop above decremented its copy) — SAME NaN
      // guard as the first read of F above (`i32.trunc_f64_s` traps on
      // NaN; `(5.5).toFixed(undefined)` reaches here with F literally
      // NaN, per ToNumber(undefined)).
      c.localGet(F);
      c.localGet(F);
      c.f64Ne();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(F);
      c.f64Trunc();
      c.end();
      c.i32TruncF64S();
      c.localSet(FI);
      c.localGet(AX);
      c.localGet(SCALE);
      c.f64Mul();
      c.f64Const(0.5);
      c.f64Add();
      c.f64Floor();
      c.localSet(N);
      c.localGet(N);
      c.call(this.deps.f64ToStr());
      c.localSet(DIGITS);
      // Left-pad with '0' until longer than FI (so a split at len-FI
      // always leaves at least one integer-part digit).
      c.block();
      c.loop();
      c.localGet(DIGITS);
      c.arrayLen();
      c.localGet(FI);
      c.i32GtS();
      c.brIf(1);
      this.deps.lit(c, "0");
      c.localGet(DIGITS);
      c.call(this.deps.concat());
      c.localSet(DIGITS);
      c.br(0);
      c.end();
      c.end();
      c.localGet(DIGITS);
      c.arrayLen();
      c.localSet(DLEN);
      c.localGet(FI);
      c.i32Eqz();
      c.ifResult(strRef);
      c.localGet(SIGN);
      c.localGet(DIGITS);
      c.call(this.deps.concat());
      c.else_();
      {
        c.localGet(SIGN);
        c.localGet(DIGITS);
        c.f64Const(0);
        c.localGet(DLEN);
        c.localGet(FI);
        c.i32Sub();
        c.f64ConvertI32S();
        c.call(this.deps.strSlice());
        c.call(this.deps.concat());
        this.deps.lit(c, ".");
        c.call(this.deps.concat());
        c.localGet(DIGITS);
        c.localGet(DLEN);
        c.localGet(FI);
        c.i32Sub();
        c.f64ConvertI32S();
        c.localGet(DLEN);
        c.f64ConvertI32S();
        c.call(this.deps.strSlice());
        c.call(this.deps.concat());
      }
      c.end();
      c.end(); // closes the N2 "too many significant digits" fence check
      c.end(); // closes the non-finite/|x|>=1e21 ifResult opened above
    }
    c.end();
    this.mb.setBody(idx, [I32, strRef, F64, F64, F64, strRef, I32, I32, F64], c.bytes());
    return idx;
  }
}
