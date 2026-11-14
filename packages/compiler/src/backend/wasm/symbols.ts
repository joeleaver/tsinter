/* INC-27 unit U1 — the symbol value's wasm representation. ONE immutable
 * GC struct, a dedicated per-kind builder in maps.ts/vecs.ts/regex-
 * value.ts/typedarrays.ts's own shape — its own struct type, its own
 * `%w.sym.*` function-name prefix, instantiated lazily by emitter.ts's
 * own `get syms()` accessor so a module with no symbol construct pays
 * nothing (the casing.ts/regex-value.ts "lazy accessor" convention).
 *
 * FIELDS, every one IMMUTABLE after construction (matching regex-
 * value.ts's own struct's stance):
 *   id    i32           a monotone counter minted at construction. Read
 *                       by maps.ts's third Map/Set key kind (the "sym"
 *                       arm), through the `readSymId` closure this file
 *                       injects into MapDeps — the hash reads exactly
 *                       this field.
 *   desc  ref null $str  the description, null for `Symbol()`. Read by
 *                       toStringHelper() below and by emitter.ts's own
 *                       inline `sym.desc` dispatch (the map `get`
 *                       precedent: that union is built AT THE CALL SITE,
 *                       not returned by a helper here — see descField()).
 *   key   ref null $str  the `Symbol.for` registry key, non-null EXACTLY
 *                       for a registered symbol. Populated by this
 *                       file's own registry (forHelper, below): every
 *                       symbol minted by sym.new/sym.newAnon still
 *                       carries `key: null`, but a registered symbol
 *                       (Symbol.for's own miss-path mint) carries the
 *                       lookup string in both `desc` and `key`.
 *
 * THIS FILE BUILDS: sym.new / sym.newAnon (construction — the id counter),
 * sym.toString (`"Symbol(" + (desc ?? "") + ")"`, via the shared
 * %w.concat helper — the SAME two-call concat-chain shape emitter.ts's
 * own inspect rendering uses elsewhere), and the `Symbol.for` registry
 * (forHelper, below). The description ACCESSOR (`sym.desc`, a
 * `string | undefined` union) is
 * dispatched from emitter.ts directly, not from this file: the map
 * `get` intrinsic's own precedent (emitter.ts's `emitMapIntrinsic`
 * "get" case) builds its union INLINE at the call site rather than
 * through a helper, and `sym.desc` follows the identical shape —
 * structGet against DESC, then a two-armed union wrap keyed off
 * ref.is_null. This file exposes exactly what that call site needs
 * (structType(), descField()) and nothing more.
 *
 * THE REGISTRY ITSELF (forHelper, below) is a growable parallel pair of
 * arrays (keys, symbols), scanned linearly
 * by string equality, keyed on WHETHER A MATCHING ENTRY WAS FOUND, never
 * on the key STRING's truthiness (an empty-string key is a legal,
 * distinct registry entry — `Symbol.for("")` must intern exactly like
 * any other key). A HIT returns the interned symbol unchanged (its own
 * `key` field, set at first registration, already answers
 * `Symbol.keyFor`); a MISS mints a fresh symbol whose `desc` AND `key`
 * both equal the lookup string (Node: a registered symbol's description
 * IS its registry key) and appends it. `Symbol.keyFor` itself needs no
 * registry lookup at all — every symbol already carries its own `key`
 * (null unless it came from this registry), so it is exactly `sym.desc`'s
 * shape with a different field, dispatched inline in emitter.ts the same
 * way. */
import { Code } from "./code.js";
import { I32, ModuleBuilder, type FieldType, type ValType } from "./module.js";

export interface SymDeps {
  /** The string valtype (module-shared). */
  strRef: () => ValType;
  /** The string array type's own index — `ref.null` needs the heap type,
   * not a ValType. */
  strType: () => number;
  /** %w.concat's index (two strings in, one out — strings.ts's own
   * ConcatDeps shape, same helper). */
  concat: () => number;
  /** Push an interned string literal onto `c`'s stack (pushStrLitInto). */
  lit: (c: Code, s: string) => void;
  /** %w.strEq's index (content equality — the registry's own key scan). */
  strEq: () => number;
}

const ID = 0;
const DESC = 1;
const KEY = 2;

export class SymBuilder {
  private readonly symType: number;
  private counterGlobal: number | null = null;
  private newNamedFn: number | null = null;
  private newAnonFn: number | null = null;
  private toStringFn: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: SymDeps,
  ) {
    // Field order is the order mintBody() pushes operands for struct.new
    // (id, desc, key) — regex-value.ts's own struct comment names this
    // exact hazard: changing one without the other is a live miscompile,
    // not a validator error (struct.new only checks TYPES, never which
    // logical field a same-typed operand landed in).
    const fields: FieldType[] = [
      { storage: I32, mutable: false }, // id
      { storage: this.strRef(), mutable: false }, // desc
      { storage: this.strRef(), mutable: false }, // key
    ];
    this.symType = mb.structType(fields);
  }

  private strRef(): ValType {
    return this.deps.strRef();
  }

  /** The struct's own type index — mapType's and mapTypeSoft's own
   * "symbol" arms and emitter.ts's inline `sym.desc` dispatch (structGet)
   * both need it. */
  structType(): number {
    return this.symType;
  }

  symRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.symType };
  }

  /** The DESC field's index, for emitter.ts's inline `sym.desc` union
   * dispatch (structGet against it directly — see this file's own header
   * for why no helper function here does that read). */
  descField(): number {
    return DESC;
  }

  /** The KEY field's index, for emitter.ts's inline `sym.keyFor` union
   * dispatch — the identical shape as `sym.desc`'s, a different field. */
  keyField(): number {
    return KEY;
  }

  /** The ID field's index — maps.ts's third (symbol) Map/Set key kind
   * hashes on exactly this field, via the one `readSymId` closure
   * emitter.ts injects into MapDeps (this file's own struct/field
   * layout stays private to it otherwise). */
  idField(): number {
    return ID;
  }

  /** The monotone i32 counter, one per module: 0 at start, bumped at
   * every construction site built here — including `Symbol.for`'s own
   * miss-path mint (forHelper, below, via mintBody). */
  private counter(): number {
    this.counterGlobal ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    return this.counterGlobal;
  }

  /** Shared construction body: reads the counter into a fresh id, bumps
   * it, and struct.news `{ id, desc, key }` — `pushDesc`/`pushKey` supply
   * those two operands (a param read or a bare `ref.null`, depending on
   * the caller), the ONLY difference between sym.new/sym.newAnon/the
   * registry's own miss-path mint. `idLocal` is the first free local
   * index (past however many string params the caller declared). */
  private mintBody(c: Code, idLocal: number, pushDesc: (c: Code) => void, pushKey: (c: Code) => void): void {
    c.globalGet(this.counter());
    c.localSet(idLocal);
    c.globalGet(this.counter());
    c.i32Const(1);
    c.i32Add();
    c.globalSet(this.counter());
    c.localGet(idLocal);
    pushDesc(c);
    pushKey(c);
    c.structNew(this.symType);
  }

  /** %w.sym.new(desc: string) -> $sym — `Symbol(desc)`. */
  newNamed(): number {
    if (this.newNamedFn !== null) return this.newNamedFn;
    const idx = this.mb.declareFunc(this.mb.funcType([this.strRef()], [this.symRef()]), "%w.sym.new");
    this.newNamedFn = idx;
    const c = new Code();
    this.mintBody(
      c,
      1,
      (cc) => cc.localGet(0),
      (cc) => cc.refNull(this.deps.strType()),
    );
    this.mb.setBody(idx, [I32], c.bytes());
    return idx;
  }

  /** %w.sym.newAnon() -> $sym — `Symbol()`, desc null. */
  newAnon(): number {
    if (this.newAnonFn !== null) return this.newAnonFn;
    const idx = this.mb.declareFunc(this.mb.funcType([], [this.symRef()]), "%w.sym.newAnon");
    this.newAnonFn = idx;
    const c = new Code();
    this.mintBody(
      c,
      0,
      (cc) => cc.refNull(this.deps.strType()),
      (cc) => cc.refNull(this.deps.strType()),
    );
    this.mb.setBody(idx, [I32], c.bytes());
    return idx;
  }

  /** %w.sym.toString($sym) -> string — `"Symbol(" + (desc ?? "") + ")"`,
   * Node-exact for both a described and an anonymous symbol: rendering
   * never reads `key` — a registered symbol's `toString()` is identical
   * to an unregistered one's, description only. The two-call concat
   * chain mirrors emitter.ts's own inspect-rendering shape elsewhere in
   * that file (lit; concat; lit; concat). */
  toStringHelper(): number {
    if (this.toStringFn !== null) return this.toStringFn;
    const idx = this.mb.declareFunc(this.mb.funcType([this.symRef()], [this.strRef()]), "%w.sym.toString");
    this.toStringFn = idx;
    const c = new Code();
    const D = 1;
    c.localGet(0);
    c.structGet(this.symType, DESC);
    c.localSet(D);
    c.localGet(D);
    c.refIsNull();
    c.ifResult(this.strRef());
    this.deps.lit(c, "Symbol()");
    c.else_();
    this.deps.lit(c, "Symbol(");
    c.localGet(D);
    c.call(this.deps.concat());
    this.deps.lit(c, ")");
    c.call(this.deps.concat());
    c.end();
    this.mb.setBody(idx, [this.strRef()], c.bytes());
    return idx;
  }

  /* ── symbol property keys (the dynamic objects' reserved keys) ─────── */

  private keyTableG: number | null = null;
  private keyTableType: number | null = null;
  private keyStrFn: number | null = null;
  private fromKeyFn: number | null = null;
  private keyStrsG: number | null = null;
  private keyStrsType: number | null = null;
  private genuineFn: number | null = null;

  /** A symbol property key's reserved string (dynamic objects keep every
   * property under a string key): U+D800 '@' '@' '#' then the symbol's id
   * as two code units (high half, low half). The lone surrogate prefix is
   * SYM_KEY_PREFIX (objmodel.ts); program string keys spelled with it stop
   * by name (dyn.ts keyGuard), so no string key aliases a symbol's. */
  private tableT(): number {
    this.keyTableType ??= this.mb.arrayType({ kind: "ref", nullable: true, typeIndex: this.symType }, true);
    return this.keyTableType;
  }

  /** The key strings keyStr built, by id (the same length as table()):
   * a symbol's key is always the SAME string object, so the object store
   * tells a genuine symbol key from a program string spelled the same way
   * by identity (isGenuineKey). */
  private keyStrsT(): number {
    this.keyStrsType ??= this.mb.arrayType({ kind: "ref", nullable: true, typeIndex: this.deps.strType() }, true);
    return this.keyStrsType;
  }

  private keyStrs(): number {
    if (this.keyStrsG !== null) return this.keyStrsG;
    const t = this.keyStrsT();
    this.keyStrsG = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: t }, true, (w) => {
      w.u8(0xd0);
      w.sleb(t);
    });
    return this.keyStrsG;
  }

  /** %w.sym.isGenuineKey(flat 6-unit reserved key) -> i32 — is it the very
   * string keyStr built for the symbol its id names? */
  isGenuineKey(): number {
    if (this.genuineFn !== null) return this.genuineFn;
    const s = this.deps.strType();
    const idx = this.mb.declareFunc(this.mb.funcType([{ kind: "ref", nullable: true, typeIndex: s }], [I32]), "%w.sym.isGenuineKey");
    this.genuineFn = idx;
    const ks = this.keyStrs();
    const kt = this.keyStrsT();
    const c = new Code();
    const ID_ = 1;
    c.localGet(0);
    c.i32Const(4);
    c.arrayGetU(s);
    c.i32Const(16);
    c.i32Shl();
    c.localGet(0);
    c.i32Const(5);
    c.arrayGetU(s);
    c.i32Or();
    c.localSet(ID_);
    c.globalGet(ks);
    c.refIsNull();
    c.ifResult(I32);
    c.i32Const(1);
    c.else_();
    c.localGet(ID_);
    c.globalGet(ks);
    c.arrayLen();
    c.i32GeU();
    c.end();
    c.ifVoid();
    c.i32Const(0);
    c.return_();
    c.end();
    c.globalGet(ks);
    c.localGet(ID_);
    c.arrayGet(kt);
    c.localGet(0);
    c.refEq();
    this.mb.setBody(idx, [I32], c.bytes());
    return idx;
  }

  private table(): number {
    if (this.keyTableG !== null) return this.keyTableG;
    const t = this.tableT();
    this.keyTableG = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: t }, true, (w) => {
      w.u8(0xd0);
      w.sleb(t);
    });
    return this.keyTableG;
  }

  /** %w.sym.keyStr($sym) -> string — the symbol's reserved property key;
   * the symbol is entered in the id table (fromKey's reverse lookup). */
  keyStr(): number {
    if (this.keyStrFn !== null) return this.keyStrFn;
    const idx = this.mb.declareFunc(this.mb.funcType([this.symRef()], [this.strRef()]), "%w.sym.keyStr");
    this.keyStrFn = idx;
    const t = this.tableT();
    const tab = this.table();
    const c = new Code();
    const ID_ = 1;
    const NT = 2;
    const N = 3;
    const NK = 4;
    const K = 5;
    const ks = this.keyStrs();
    const kt = this.keyStrsT();
    c.localGet(0);
    c.structGet(this.symType, ID);
    c.localSet(ID_);
    // grow the table to hold index id (doubling)
    c.globalGet(tab);
    c.refIsNull();
    c.ifResult(I32);
    c.i32Const(1);
    c.else_();
    c.localGet(ID_);
    c.globalGet(tab);
    c.arrayLen();
    c.i32GeU();
    c.end();
    c.ifVoid();
    c.i32Const(16);
    c.localGet(ID_);
    c.i32Const(1);
    c.i32Add();
    c.i32Const(2);
    c.i32Mul();
    c.localGet(ID_);
    c.i32Const(16);
    c.i32LtU();
    c.select();
    c.localTee(N);
    c.arrayNewDefault(t);
    c.localSet(NT);
    c.globalGet(tab);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(NT);
    c.i32Const(0);
    c.globalGet(tab);
    c.i32Const(0);
    c.globalGet(tab);
    c.arrayLen();
    c.arrayCopy(t, t);
    c.end();
    c.localGet(NT);
    c.globalSet(tab);
    // the key strings grow with it (same length)
    c.localGet(N);
    c.arrayNewDefault(kt);
    c.localSet(NK);
    c.globalGet(ks);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(NK);
    c.i32Const(0);
    c.globalGet(ks);
    c.i32Const(0);
    c.globalGet(ks);
    c.arrayLen();
    c.arrayCopy(kt, kt);
    c.end();
    c.localGet(NK);
    c.globalSet(ks);
    c.end();
    c.globalGet(tab);
    c.localGet(ID_);
    c.localGet(0);
    c.arraySet(t);
    // built once per symbol: the same string object every time
    c.globalGet(ks);
    c.localGet(ID_);
    c.arrayGet(kt);
    c.localTee(K);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(K);
    c.refAsNonNull();
    c.return_();
    c.end();
    c.globalGet(ks);
    c.localGet(ID_);
    c.i32Const(0xd800);
    c.i32Const(0x40);
    c.i32Const(0x40);
    c.i32Const(0x23);
    c.localGet(ID_);
    c.i32Const(16);
    c.i32ShrU();
    c.localGet(ID_);
    c.i32Const(0xffff);
    c.i32And();
    c.arrayNewFixed(this.deps.strType(), 6);
    c.localTee(K);
    c.arraySet(kt);
    c.localGet(K);
    c.refAsNonNull();
    this.mb.setBody(idx, [I32, { kind: "ref", nullable: true, typeIndex: t }, I32, { kind: "ref", nullable: true, typeIndex: kt }, { kind: "ref", nullable: true, typeIndex: this.deps.strType() }], c.bytes());
    return idx;
  }

  /** %w.sym.fromKey(string) -> $sym | null — the symbol a reserved key
   * names (keyStr's reverse), null for any other string (a well-known
   * symbol's reserved key included). */
  fromKey(): number {
    if (this.fromKeyFn !== null) return this.fromKeyFn;
    const idx = this.mb.declareFunc(this.mb.funcType([this.strRef()], [this.symRef()]), "%w.sym.fromKey");
    this.fromKeyFn = idx;
    const s = this.deps.strType();
    const tab = this.table();
    const c = new Code();
    const ID_ = 1;
    c.localGet(0);
    c.arrayLen();
    c.i32Const(6);
    c.i32Ne();
    c.ifVoid();
    c.refNull(this.symType);
    c.return_();
    c.end();
    for (const [i, cu] of [[0, 0xd800], [1, 0x40], [2, 0x40], [3, 0x23]] as const) {
      c.localGet(0);
      c.i32Const(i);
      c.arrayGetU(s);
      c.i32Const(cu);
      c.i32Ne();
      c.ifVoid();
      c.refNull(this.symType);
      c.return_();
      c.end();
    }
    c.localGet(0);
    c.i32Const(4);
    c.arrayGetU(s);
    c.i32Const(16);
    c.i32Shl();
    c.localGet(0);
    c.i32Const(5);
    c.arrayGetU(s);
    c.i32Or();
    c.localSet(ID_);
    c.globalGet(tab);
    c.refIsNull();
    c.ifResult(I32);
    c.i32Const(1);
    c.else_();
    c.localGet(ID_);
    c.globalGet(tab);
    c.arrayLen();
    c.i32GeU();
    c.end();
    c.ifVoid();
    c.refNull(this.symType);
    c.return_();
    c.end();
    c.globalGet(tab);
    c.localGet(ID_);
    c.arrayGet(this.tableT());
    this.mb.setBody(idx, [I32], c.bytes());
    return idx;
  }

  /* ── the `Symbol.for` registry ─────────────────────────────────────── */

  /* STANDING CONDITION: this registry interns purely by KEY STRING —
   * there is no separate notion of a "well-known" symbol here. Today
   * that is safe because no well-known symbol (Symbol.iterator,
   * Symbol.asyncIterator, and the rest of that family) can ever reach
   * this file as a VALUE: the front end refuses every construct that
   * would let one flow here, so none is ever looked up or inserted. If
   * a LATER change lets a well-known symbol become a value that reaches
   * this registry, `Symbol.for` must NOT intern it under its own
   * well-known name — in Node, `Symbol.for("Symbol.iterator") ===
   * Symbol.iterator` is `false` (the two are never the same symbol),
   * and at that moment a row asserting exactly that comparison becomes
   * required, not optional, board #159. */
  private regKeysType: number | null = null; // array(ref null $str, mutable)
  private regValsType: number | null = null; // array(ref null $sym, mutable)
  private regKeysG: number | null = null; // mutable global, ref null regKeysType; null = not yet allocated
  private regValsG: number | null = null; // mutable global, ref null regValsType
  private regCountG: number | null = null; // mutable i32, the live entry count (also the next write index)
  private forFn: number | null = null;

  private keysArrType(): number {
    this.regKeysType ??= this.mb.arrayType(this.strRef(), true);
    return this.regKeysType;
  }

  private valsArrType(): number {
    this.regValsType ??= this.mb.arrayType(this.symRef(), true);
    return this.regValsType;
  }

  private keysArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.keysArrType() };
  }

  private valsArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.valsArrType() };
  }

  private regKeys(): number {
    this.regKeysG ??= this.mb.addGlobal(this.keysArrRef(), true, (w) => {
      w.u8(0xd0); // ref.null
      w.sleb(this.keysArrType());
    });
    return this.regKeysG;
  }

  private regVals(): number {
    this.regValsG ??= this.mb.addGlobal(this.valsArrRef(), true, (w) => {
      w.u8(0xd0); // ref.null
      w.sleb(this.valsArrType());
    });
    return this.regValsG;
  }

  private regCount(): number {
    this.regCountG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    return this.regCountG;
  }

  /** %w.sym.for(key: string) -> $sym — a linear scan by CONTENT equality
   * over the registered keys (present-or-absent, never the key string's
   * own truthiness: an empty-string key is a legal, distinct entry), a
   * HIT returning the interned symbol unchanged, a MISS growing the
   * parallel arrays (amortized doubling — maps.ts's own rebuildBuckets/
   * addAll growth shape, one array.new_default + array.copy per array)
   * and minting a fresh symbol whose `desc` AND `key` both equal `key`
   * (Node: a registered symbol's description IS its registry key). */
  forHelper(): number {
    if (this.forFn !== null) return this.forFn;
    const idx = this.mb.declareFunc(this.mb.funcType([this.strRef()], [this.symRef()]), "%w.sym.for");
    this.forFn = idx;
    const c = new Code();
    const KEY_P = 0;
    const I = 1;
    const FOUND = 2; // -1 until a match is found
    const NEWKEYS = 3;
    const NEWVALS = 4;
    const NEWCAP = 5;
    const NEWSYM = 6;
    const ID_TMP = 7; // mintBody's own scratch for the id counter read
    const locals: ValType[] = [
      I32, // I
      I32, // FOUND
      this.keysArrRef(), // NEWKEYS
      this.valsArrRef(), // NEWVALS
      I32, // NEWCAP
      this.symRef(), // NEWSYM
      I32, // ID_TMP
    ];

    // found = -1
    c.i32Const(-1);
    c.localSet(FOUND);
    // if regKeys() != null: scan
    c.globalGet(this.regKeys());
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.i32Const(0);
    c.localSet(I);
    c.block();
    c.loop();
    c.localGet(I);
    c.globalGet(this.regCount());
    c.i32GeS();
    c.brIf(1);
    c.globalGet(this.regKeys());
    c.refAsNonNull();
    c.localGet(I);
    c.arrayGet(this.keysArrType());
    c.refAsNonNull();
    c.localGet(KEY_P);
    c.call(this.deps.strEq());
    c.ifVoid();
    c.localGet(I);
    c.localSet(FOUND);
    c.br(2);
    c.end();
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end();
    c.end();
    c.end();

    // if found >= 0: return regVals()[found]
    c.localGet(FOUND);
    c.i32Const(0);
    c.i32GeS();
    c.ifResult(this.symRef());
    c.globalGet(this.regVals());
    c.refAsNonNull();
    c.localGet(FOUND);
    c.arrayGet(this.valsArrType());
    c.refAsNonNull();
    c.else_();

    // miss: ensure capacity (first allocation, or amortized doubling —
    // maps.ts's own rebuildBuckets/addAll growth shape: one
    // array.new_default + array.copy per parallel array), then append
    // and mint.
    c.globalGet(this.regKeys());
    c.refIsNull();
    c.ifVoid();
    // first allocation: capacity 4.
    c.i32Const(4);
    c.arrayNewDefault(this.keysArrType());
    c.globalSet(this.regKeys());
    c.i32Const(4);
    c.arrayNewDefault(this.valsArrType());
    c.globalSet(this.regVals());
    c.else_();
    c.globalGet(this.regCount());
    c.globalGet(this.regKeys());
    c.refAsNonNull();
    c.arrayLen();
    c.i32GeS();
    c.ifVoid();
    // grow: double both arrays, copying the live prefix.
    c.globalGet(this.regKeys());
    c.refAsNonNull();
    c.arrayLen();
    c.i32Const(2);
    c.i32Mul();
    c.localSet(NEWCAP);
    c.localGet(NEWCAP);
    c.arrayNewDefault(this.keysArrType());
    c.localSet(NEWKEYS);
    c.localGet(NEWKEYS);
    c.refAsNonNull();
    c.i32Const(0);
    c.globalGet(this.regKeys());
    c.refAsNonNull();
    c.i32Const(0);
    c.globalGet(this.regCount());
    c.arrayCopy(this.keysArrType(), this.keysArrType());
    c.localGet(NEWKEYS);
    c.globalSet(this.regKeys());
    c.localGet(NEWCAP);
    c.arrayNewDefault(this.valsArrType());
    c.localSet(NEWVALS);
    c.localGet(NEWVALS);
    c.refAsNonNull();
    c.i32Const(0);
    c.globalGet(this.regVals());
    c.refAsNonNull();
    c.i32Const(0);
    c.globalGet(this.regCount());
    c.arrayCopy(this.valsArrType(), this.valsArrType());
    c.localGet(NEWVALS);
    c.globalSet(this.regVals());
    c.end();
    c.end();

    // mint { id, desc: key, key: key } and capture it.
    this.mintBody(
      c,
      ID_TMP,
      (cc) => cc.localGet(KEY_P),
      (cc) => cc.localGet(KEY_P),
    );
    c.localSet(NEWSYM);

    // append: regKeys[regCount] = key; regVals[regCount] = newSym; regCount += 1.
    c.globalGet(this.regKeys());
    c.refAsNonNull();
    c.globalGet(this.regCount());
    c.localGet(KEY_P);
    c.arraySet(this.keysArrType());
    c.globalGet(this.regVals());
    c.refAsNonNull();
    c.globalGet(this.regCount());
    c.localGet(NEWSYM);
    c.arraySet(this.valsArrType());
    c.globalGet(this.regCount());
    c.i32Const(1);
    c.i32Add();
    c.globalSet(this.regCount());

    c.localGet(NEWSYM);
    c.end(); // closes the found/miss ifResult opened above
    this.mb.setBody(idx, locals, c.bytes());
    return idx;
  }
}
