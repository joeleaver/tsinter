/* JS arrays over WasmGC: a per-element-type VECTOR — (struct (mut len)
 * (mut buf)) over a growable (array (mut elem)) — because JS arrays
 * grow (arraySet at i == length appends, push exists) and GC arrays are
 * fixed-length. Capacity doubles on append; length is the observable
 * truth and buf.len the capacity.
 *
 * Index semantics are the register's: reads and writes validate that the
 * f64 index is an integer in bounds ([0, len) for reads, [0, len] for
 * writes — i == len appends) and TRAP otherwise (S003's stance — an
 * UNCATCHABLE abort on every tier, scr_trap's native parity; the
 * may-throw analysis counts runtime traps as aborts, so the exception
 * protocol deliberately does NOT catch these). Ref-element reads trap
 * on an absent (null) slot, SEMANTICS.md 46's arrayNewLen rule.
 *
 * Everything is keyed by the element's VALUE representation: one struct,
 * one buffer type, one helper family per distinct element type, interned.
 * The emitter injects what element formatting needs (strEq for string
 * equality, f64ToStr and literal pushing for join). */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type StorageType, type ValType } from "./module.js";

export interface VecDeps {
  /** %w.strEq's index (content equality for string elements). */
  strEq: () => number;
  /** %w.f64ToStr's index (join over number elements). */
  f64ToStr: () => number;
  /** %w.concat's index (join accumulates by concatenation). */
  concat: () => number;
  /** Push an interned string literal onto `c`'s stack. */
  lit: (c: Code, s: string) => void;
  /** Builds a class-error instance and fills the exception cell — the
   * SAME emitSetCellError route typedarrays.ts's BytesBuilder.withHelper
   * uses for the array `with`'s catchable RangeError (INC-27 U2): the
   * caller pushes a dummy result and returns immediately;
   * the outer emitter call site does the pending-check-and-propagate
   * half via emitPendingCheck after the `call`, exactly as the bytes
   * `with` call site already does. */
  throwError: (
    c: Code,
    className: string,
    name: string,
    pushMessage: (c: Code) => void,
    codeLit: string | null,
  ) => void;
}

/** How elements compare (===/SameValueZero) and format (join). */
export type ElemKind = "f64" | "bool" | "string" | "ref";

export interface VecInfo {
  key: string;
  struct: number;
  bufType: number;
  storage: StorageType;
  elemVal: ValType;
  elemKind: ElemKind;
  /** Ref-typed elements trap on absent-slot reads. */
  refElem: boolean;
}

// Vec struct field indices — exported so callers holding a bare
// (struct, bufType) pair from VecInfo (maps.ts's addAll/toArray, which
// read/write a caller-supplied seed/target vec directly rather than
// going through this builder's own methods) don't have to hardcode the
// layout as an undocumented assumption (review MINOR-2).
export const LEN = 0;
export const BUF = 1;

export class VecBuilder {
  private readonly infos = new Map<string, VecInfo>();
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: VecDeps,
  ) {}

  /** The vector types for one element representation, interned. */
  info(key: string, elemVal: ValType, storage: StorageType, elemKind: ElemKind): VecInfo {
    const existing = this.infos.get(key);
    if (existing !== undefined) return existing;
    const bufType = this.mb.arrayType(storage, true);
    const struct = this.mb.structType([
      { storage: I32, mutable: true },
      { storage: { kind: "ref", nullable: false, typeIndex: bufType }, mutable: true },
    ]);
    const made: VecInfo = {
      key,
      struct,
      bufType,
      storage,
      elemVal,
      elemKind,
      refElem: elemVal.kind === "ref",
    };
    this.infos.set(key, made);
    return made;
  }

  vecRef(v: VecInfo): ValType {
    return { kind: "ref", nullable: true, typeIndex: v.struct };
  }

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** buf[i] with the storage-appropriate get, plus the absent-slot trap
   * for ref elements. Expects (buf, i) on the stack. */
  emitElemRead(c: Code, v: VecInfo): void {
    if (v.storage === "i8" || v.storage === "i16") c.arrayGetU(v.bufType);
    else c.arrayGet(v.bufType);
    if (v.refElem) c.refAsNonNull();
  }

  /** Validates the f64 index in local X: an integer, ≥ 0, and ≤ the limit
   * `pushLimitF64` pushes. Traps otherwise (S003); leaves the i32 index
   * in local I. */
  private emitIndexCheck(c: Code, X: number, I: number, pushLimitF64: () => void): void {
    c.localGet(X);
    c.f64Trunc();
    c.localGet(X);
    c.f64Ne();
    c.ifVoid();
    c.unreachable();
    c.end();
    c.localGet(X);
    c.f64Const(0);
    c.f64Lt();
    c.ifVoid();
    c.unreachable();
    c.end();
    c.localGet(X);
    pushLimitF64();
    c.f64Gt();
    c.ifVoid();
    c.unreachable();
    c.end();
    c.localGet(X);
    c.i32TruncF64S();
    c.localSet(I);
  }

  /** if (slot L is beyond capacity) → fresh buffer at max(4, 2*cap), old
   * LEN elements copied over, installed. NB is a (ref null buf) local. */
  private emitEnsureCapacity(c: Code, v: VecInfo, V: number, L: number, NB: number): void {
    c.localGet(L);
    c.localGet(V);
    c.structGet(v.struct, BUF);
    c.arrayLen();
    c.i32GeS();
    c.ifVoid();
    {
      // ncap = (cap * 2) | 4 — doubles, and lifts the cap-0 empty case
      // to 4; L == len ≤ cap keeps the slot inside the new buffer.
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.i32Const(4);
      c.i32Or();
      c.arrayNewDefault(v.bufType);
      c.localSet(NB);
      c.localGet(NB);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.arrayCopy(v.bufType, v.bufType);
      c.localGet(V);
      c.localGet(NB);
      c.refAsNonNull();
      c.structSet(v.struct, BUF);
    }
    c.end();
  }

  private nullableBuf(v: VecInfo): ValType {
    return { kind: "ref", nullable: true, typeIndex: v.bufType };
  }

  /** %w.vec.newLen — (f64) → vec of n ABSENT slots (arrayNewLen: ref
   * elements start null, reads trap until assigned — SEMANTICS.md 46).
   * The bound truncates; negative/NaN give an empty array; a bound at or
   * past 2^31 traps (allocation that size is unrepresentable anyway). */
  newLen(v: VecInfo): number {
    return this.cached(`${v.key}:newLen`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [this.vecRef(v)]), `%w.vec.newLen:${v.key}`);
      const c = new Code();
      const X = 0;
      const N = 1; // i32
      c.localGet(X);
      c.f64Const(1);
      c.f64Ge();
      c.ifResult(I32);
      {
        c.localGet(X);
        c.f64Const(2147483648);
        c.f64Ge();
        c.ifVoid();
        c.unreachable();
        c.end();
        c.localGet(X);
        c.f64Trunc();
        c.i32TruncF64S();
      }
      c.else_();
      c.i32Const(0);
      c.end();
      c.localSet(N);
      c.localGet(N);
      c.localGet(N);
      c.arrayNewDefault(v.bufType);
      c.structNew(v.struct);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.vec.get — (vec, f64) → elem; traps outside [0, len). */
  get(v: VecInfo): number {
    return this.cached(`${v.key}:get`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), F64], [v.elemVal]),
        `%w.vec.get:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const X = 1;
      const I = 2;
      this.emitIndexCheck(c, X, I, () => {
        c.localGet(V);
        c.structGet(v.struct, LEN);
        c.i32Const(1);
        c.i32Sub();
        c.f64ConvertI32S();
      });
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(I);
      this.emitElemRead(c, v);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.vec.set — (vec, f64, elem) → (); [0, len] with i == len append. */
  set(v: VecInfo): number {
    return this.cached(`${v.key}:set`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), F64, v.elemVal], []),
        `%w.vec.set:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const X = 1;
      const E = 2;
      const I = 3;
      const NB = 4;
      this.emitIndexCheck(c, X, I, () => {
        c.localGet(V);
        c.structGet(v.struct, LEN);
        c.f64ConvertI32S();
      });
      // Append: grow capacity if needed, then bump len.
      c.localGet(I);
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.i32Eq();
      c.ifVoid();
      this.emitEnsureCapacity(c, v, V, I, NB);
      c.localGet(V);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.structSet(v.struct, LEN);
      c.end();
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(I);
      c.localGet(E);
      c.arraySet(v.bufType);
      this.mb.setBody(idx, [I32, this.nullableBuf(v)], c.bytes());
      return idx;
    });
  }

  /** %w.vec.push1 — (vec, elem) → (); the unchecked append. */
  pushOne(v: VecInfo): number {
    return this.cached(`${v.key}:push1`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), v.elemVal], []),
        `%w.vec.push1:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const E = 1;
      const L = 2;
      const NB = 3;
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      this.emitEnsureCapacity(c, v, V, L, NB);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(L);
      c.localGet(E);
      c.arraySet(v.bufType);
      c.localGet(V);
      c.localGet(L);
      c.i32Const(1);
      c.i32Add();
      c.structSet(v.struct, LEN);
      this.mb.setBody(idx, [I32, this.nullableBuf(v)], c.bytes());
      return idx;
    });
  }

  /** %w.vec.pushN — (vec, srcVec) → (); append a whole array (spread). */
  pushSpread(v: VecInfo): number {
    return this.cached(`${v.key}:pushN`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), this.vecRef(v)], []),
        `%w.vec.pushN:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const S = 1;
      const L = 2;
      const N = 3;
      const NB = 4;
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      c.localGet(S);
      c.structGet(v.struct, LEN);
      c.localSet(N);
      // Ensure the last new slot (L + N - 1) fits; a doubling may not
      // suffice for a large source, so grow to exactly the need then.
      c.localGet(L);
      c.localGet(N);
      c.i32Add();
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.arrayLen();
      c.i32GtS();
      c.ifVoid();
      {
        // ncap = max(2*cap | 4, L + N)
        c.localGet(V);
        c.structGet(v.struct, BUF);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.i32Const(4);
        c.i32Or();
        c.localSet(N); // borrow N briefly — restored below
        c.localGet(L);
        c.localGet(S);
        c.structGet(v.struct, LEN);
        c.i32Add();
        c.localGet(N);
        c.i32GtS();
        c.ifResult(I32);
        c.localGet(L);
        c.localGet(S);
        c.structGet(v.struct, LEN);
        c.i32Add();
        c.else_();
        c.localGet(N);
        c.end();
        c.arrayNewDefault(v.bufType);
        c.localSet(NB);
        c.localGet(NB);
        c.i32Const(0);
        c.localGet(V);
        c.structGet(v.struct, BUF);
        c.i32Const(0);
        c.localGet(L);
        c.arrayCopy(v.bufType, v.bufType);
        c.localGet(V);
        c.localGet(NB);
        c.refAsNonNull();
        c.structSet(v.struct, BUF);
        c.localGet(S);
        c.structGet(v.struct, LEN);
        c.localSet(N); // restore
      }
      c.end();
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(L);
      c.localGet(S);
      c.structGet(v.struct, BUF);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(v.bufType, v.bufType);
      c.localGet(V);
      c.localGet(L);
      c.localGet(N);
      c.i32Add();
      c.structSet(v.struct, LEN);
      this.mb.setBody(idx, [I32, I32, this.nullableBuf(v)], c.bytes());
      return idx;
    });
  }

  /** Pushes elem-equality of (a: elemVal, b: elemVal) from locals — ===
   * for indexOf, SameValueZero for includes (NaN equals NaN). */
  private emitElemEq(c: Code, v: VecInfo, A: number, B: number, sameValueZero: boolean): void {
    switch (v.elemKind) {
      case "f64":
        c.localGet(A);
        c.localGet(B);
        c.f64Eq();
        if (sameValueZero) {
          c.localGet(A);
          c.localGet(A);
          c.f64Ne();
          c.localGet(B);
          c.localGet(B);
          c.f64Ne();
          c.i32And();
          c.i32Or();
        }
        return;
      case "bool":
        c.localGet(A);
        c.localGet(B);
        c.i32Eq();
        return;
      case "string":
        // An absent (null) slot is unequal to every needle — and must not
        // reach strEq, whose arrayLen would trap on it.
        c.localGet(A);
        c.refIsNull();
        c.ifResult(I32);
        c.i32Const(0);
        c.else_();
        c.localGet(A);
        c.localGet(B);
        c.call(this.deps.strEq());
        c.end();
        return;
      case "ref":
        c.localGet(A);
        c.localGet(B);
        c.refEq();
        return;
    }
  }

  /** %w.vec.indexOf / includes — (vec, needle, from f64) → f64/i32.
   * `from` is JS's relative fromIndex (negative = len + from, clamped). */
  search(v: VecInfo, includes: boolean): number {
    const name = includes ? "includes" : "indexOf";
    return this.cached(`${v.key}:${name}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), v.elemVal, F64], [includes ? I32 : F64]),
        `%w.vec.${name}:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const NEEDLE = 1;
      const FROM = 2;
      const L = 3; // i32 len
      const I = 4; // i32 cursor
      const E = 5; // elem scratch
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      // start = the relative/clamped fromIndex (NaN reads as 0).
      this.emitRelIndex(c, FROM, L);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(I);
      // Raw element read: an absent slot must not trap a SEARCH — it is
      // simply unequal to any needle (the needle itself is never null).
      if (v.storage === "i8" || v.storage === "i16") c.arrayGetU(v.bufType);
      else c.arrayGet(v.bufType);
      c.localSet(E);
      this.emitElemEq(c, v, E, NEEDLE, includes);
      c.ifVoid();
      if (includes) c.i32Const(1);
      else {
        c.localGet(I);
        c.f64ConvertI32S();
      }
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      if (includes) c.i32Const(0);
      else c.f64Const(-1);
      this.mb.setBody(idx, [I32, I32, v.elemVal], c.bytes());
      return idx;
    });
  }

  /** %w.vec.join — (vec, sep) → str. Scalar/string elements format
   * inline; a "ref" elemKind element (INC-27 U2: a union of
   * {number,string,boolean}∪{null,undefined} arms, the front end's own
   * join element fence (lower-containers.ts) —
   * a record/class/nested-array/function element is refused at the
   * front end before it ever reaches here) formats via `refJoinToStr`,
   * the caller's per-arm ToString helper index (unions.ts's
   * toStrForJoin) — arrays.ts stays element-representation-agnostic and
   * never itself inspects a union's arm list. A "ref" elemKind array
   * reaching here with `refJoinToStr` still null is an emitter bug (the
   * refusal belongs at the call site, before this helper is even
   * requested). CACHE KEY: `vecKeyFor`'s `v.key` is deliberately ONE
   * shared "vec(union)" key for EVERY union-element array (every union
   * value is a ref to the same base struct — vecKeyFor's own documented
   * reason), so `${v.key}:join` alone would collide TWO DIFFERENT
   * unions' join calls onto the SAME cached function (measured:
   * `(string|undefined)[]` and `(number|string|null)[]` join
   * calls in one module shared one cached `%w.vec.join:vec(union)` and
   * the SECOND union's runtime tag hit the FIRST union's arm casts —
   * "illegal cast"). `refJoinToStr` is called EAGERLY (outside the
   * lazy `cached` builder) so its own already-interned helper INDEX can
   * fold into the join helper's cache key — never re-deriving a
   * "structural union identity" arrays.ts has no business knowing. */
  join(v: VecInfo, strRefT: ValType, refJoinToStr: (() => number) | null = null): number {
    const refIdx = refJoinToStr === null ? null : refJoinToStr();
    return this.cached(`${v.key}:join:${refIdx ?? "-"}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), strRefT], [strRefT]),
        `%w.vec.join:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const SEP = 1;
      const L = 2; // i32
      const I = 3; // i32
      const ACC = 4; // str
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      this.deps.lit(c, "");
      c.localSet(ACC);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);
      c.localGet(I);
      c.ifVoid();
      c.localGet(ACC);
      c.localGet(SEP);
      c.call(this.deps.concat());
      c.localSet(ACC);
      c.end();
      c.localGet(ACC);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(I);
      this.emitElemRead(c, v);
      switch (v.elemKind) {
        case "f64":
          c.call(this.deps.f64ToStr());
          break;
        case "bool":
          c.ifResult(strRefT);
          this.deps.lit(c, "true");
          c.else_();
          this.deps.lit(c, "false");
          c.end();
          break;
        case "string":
          break; // already a string
        case "ref":
          if (refIdx === null) throw new Error("join over ref elements needs refJoinToStr (emitter bug)");
          c.call(refIdx);
          break;
      }
      c.call(this.deps.concat());
      c.localSet(ACC);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(ACC);
      this.mb.setBody(idx, [I32, I32, strRefT], c.bytes());
      return idx;
    });
  }

  /** Pushes trunc+relative+clamped i32 from the f64 in local X: negative
   * means len + x, then clamp to [0, len]. ±Infinity clamps too (the
   * frontend fills omitted ends with +Infinity), and NaN reads as 0 —
   * ToIntegerOrInfinity, which a bare i32.trunc would trap on. */
  private emitRelIndex(c: Code, X: number, L: number): void {
    c.localGet(X);
    c.localGet(X);
    c.f64Ne();
    c.ifVoid();
    c.f64Const(0);
    c.localSet(X);
    c.end();
    c.localGet(X);
    c.f64Trunc();
    c.localSet(X);
    c.localGet(X);
    c.f64Const(0);
    c.f64Lt();
    c.ifVoid();
    c.localGet(L);
    c.f64ConvertI32S();
    c.localGet(X);
    c.f64Add();
    c.localSet(X);
    c.end();
    c.localGet(X);
    c.f64Const(0);
    c.f64Lt();
    c.ifResult(I32);
    c.i32Const(0);
    c.else_();
    c.localGet(X);
    c.localGet(L);
    c.f64ConvertI32S();
    c.f64Ge();
    c.ifResult(I32);
    c.localGet(L);
    c.else_();
    c.localGet(X);
    c.i32TruncF64S();
    c.end();
    c.end();
  }

  /** %w.vec.slice — (vec, start f64, end f64) → fresh vec. */
  slice(v: VecInfo): number {
    return this.cached(`${v.key}:slice`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), F64, F64], [this.vecRef(v)]),
        `%w.vec.slice:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const S = 1;
      const E = 2;
      const L = 3; // i32 len
      const A = 4; // i32 start
      const N = 5; // i32 count
      const NB = 6; // new buf
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      this.emitRelIndex(c, S, L);
      c.localSet(A);
      this.emitRelIndex(c, E, L);
      c.localGet(A);
      c.i32Sub();
      c.localSet(N);
      c.localGet(N);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(N);
      c.end();
      c.localGet(N);
      c.arrayNewDefault(v.bufType);
      c.localSet(NB);
      c.localGet(NB);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(A);
      c.localGet(N);
      c.arrayCopy(v.bufType, v.bufType);
      c.localGet(N);
      c.localGet(NB);
      c.refAsNonNull();
      c.structNew(v.struct);
      this.mb.setBody(idx, [I32, I32, I32, this.nullableBuf(v)], c.bytes());
      return idx;
    });
  }

  /** %w.vec.splice — (vec, start f64, count f64) → the removed vec; the
   * receiver compacts in place. Removal forms only (the IR fences
   * insertion). */
  splice(v: VecInfo): number {
    return this.cached(`${v.key}:splice`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), F64, F64], [this.vecRef(v)]),
        `%w.vec.splice:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const S = 1;
      const CNT = 2;
      const L = 3; // i32 len
      const A = 4; // i32 start
      const N = 5; // i32 removal count
      const NB = 6; // removed buf
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      this.emitRelIndex(c, S, L);
      c.localSet(A);
      // n = clamp(trunc(count), 0, len - start); +Infinity → to the end,
      // NaN → 0 (ToIntegerOrInfinity; a bare trunc would trap).
      c.localGet(CNT);
      c.localGet(CNT);
      c.f64Ne();
      c.ifVoid();
      c.f64Const(0);
      c.localSet(CNT);
      c.end();
      c.localGet(CNT);
      c.f64Trunc();
      c.localSet(CNT);
      c.localGet(CNT);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(CNT);
      c.localGet(L);
      c.localGet(A);
      c.i32Sub();
      c.f64ConvertI32S();
      c.f64Ge();
      c.ifResult(I32);
      c.localGet(L);
      c.localGet(A);
      c.i32Sub();
      c.else_();
      c.localGet(CNT);
      c.i32TruncF64S();
      c.end();
      c.end();
      c.localSet(N);
      // removed = fresh vec over buf[A, A+N)
      c.localGet(N);
      c.arrayNewDefault(v.bufType);
      c.localSet(NB);
      c.localGet(NB);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(A);
      c.localGet(N);
      c.arrayCopy(v.bufType, v.bufType);
      // compact the tail left (array.copy is memmove-safe on overlap)
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(A);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(A);
      c.localGet(N);
      c.i32Add();
      c.localGet(L);
      c.localGet(A);
      c.i32Sub();
      c.localGet(N);
      c.i32Sub();
      c.arrayCopy(v.bufType, v.bufType);
      c.localGet(V);
      c.localGet(L);
      c.localGet(N);
      c.i32Sub();
      c.structSet(v.struct, LEN);
      c.localGet(N);
      c.localGet(NB);
      c.refAsNonNull();
      c.structNew(v.struct);
      this.mb.setBody(idx, [I32, I32, I32, this.nullableBuf(v)], c.bytes());
      return idx;
    });
  }

  /** %w.vec.toReversed — (vec) → fresh vec, elements in reverse order;
   * the receiver is UNCHANGED (ES2023 copier — INC-27 U2). Every
   * ElemKind: a raw element copy (arrayGet/arraySet), no per-kind
   * formatting needed (unlike join). */
  toReversedHelper(v: VecInfo): number {
    return this.cached(`${v.key}:toReversed`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v)], [this.vecRef(v)]),
        `%w.vec.toReversed:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const L = 1; // i32 len
      const NB = 2; // new buf
      const I = 3; // loop cursor
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      c.localGet(L);
      c.arrayNewDefault(v.bufType);
      c.localSet(NB);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);
      // NB[i] = V.buf[L - 1 - i] — a raw slot copy (no absent-slot trap:
      // a receiver's own [0, len) slots are always populated).
      c.localGet(NB);
      c.localGet(I);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(L);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(I);
      c.i32Sub();
      if (v.storage === "i8" || v.storage === "i16") c.arrayGetU(v.bufType);
      else c.arrayGet(v.bufType);
      c.arraySet(v.bufType);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(L);
      c.localGet(NB);
      c.refAsNonNull();
      c.structNew(v.struct);
      this.mb.setBody(idx, [I32, this.nullableBuf(v), I32], c.bytes());
      return idx;
    });
  }

  /** %w.vec.toSpliced — (vec, start f64, deleteCount f64, items vec) →
   * fresh vec; the receiver is UNCHANGED (ES2023 copier — INC-27 U2).
   * `start`/`deleteCount` clamp exactly as splice's own (start via
   * emitRelIndex, deleteCount via the same NaN/negative/+Infinity
   * clamp splice uses) — the frontend has already canonicalised the
   * omitted-argument forms (lower-containers.ts's toSpliced lowering:
   * no args → (0, 0, []); start only → (start, +Infinity, [])). `items`
   * arrives as an already-built vec of the SAME VecInfo (an arrayLit
   * IR node walked like any array literal), never a spread. */
  toSplicedHelper(v: VecInfo): number {
    return this.cached(`${v.key}:toSpliced`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), F64, F64, this.vecRef(v)], [this.vecRef(v)]),
        `%w.vec.toSpliced:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const S = 1;
      const CNT = 2;
      const ITEMS = 3;
      const L = 4; // i32 len
      const A = 5; // i32 start
      const N = 6; // i32 delete count
      const IL = 7; // i32 items len
      const NL = 8; // i32 new len
      const NB = 9; // new buf
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      this.emitRelIndex(c, S, L);
      c.localSet(A);
      // n = clamp(trunc(count), 0, len - start); +Infinity → to the end,
      // NaN → 0 — the SAME clamp splice() uses (a bare trunc would trap
      // on +/-Infinity).
      c.localGet(CNT);
      c.localGet(CNT);
      c.f64Ne();
      c.ifVoid();
      c.f64Const(0);
      c.localSet(CNT);
      c.end();
      c.localGet(CNT);
      c.f64Trunc();
      c.localSet(CNT);
      c.localGet(CNT);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(CNT);
      c.localGet(L);
      c.localGet(A);
      c.i32Sub();
      c.f64ConvertI32S();
      c.f64Ge();
      c.ifResult(I32);
      c.localGet(L);
      c.localGet(A);
      c.i32Sub();
      c.else_();
      c.localGet(CNT);
      c.i32TruncF64S();
      c.end();
      c.end();
      c.localSet(N);
      c.localGet(ITEMS);
      c.structGet(v.struct, LEN);
      c.localSet(IL);
      // newLen = len - n + itemsLen
      c.localGet(L);
      c.localGet(N);
      c.i32Sub();
      c.localGet(IL);
      c.i32Add();
      c.localSet(NL);
      c.localGet(NL);
      c.arrayNewDefault(v.bufType);
      c.localSet(NB);
      // NB[0, A) = V.buf[0, A)
      c.localGet(NB);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.i32Const(0);
      c.localGet(A);
      c.arrayCopy(v.bufType, v.bufType);
      // NB[A, A+IL) = ITEMS.buf[0, IL)
      c.localGet(NB);
      c.localGet(A);
      c.localGet(ITEMS);
      c.structGet(v.struct, BUF);
      c.i32Const(0);
      c.localGet(IL);
      c.arrayCopy(v.bufType, v.bufType);
      // NB[A+IL, NL) = V.buf[A+N, L)
      c.localGet(NB);
      c.localGet(A);
      c.localGet(IL);
      c.i32Add();
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.localGet(A);
      c.localGet(N);
      c.i32Add();
      c.localGet(L);
      c.localGet(A);
      c.localGet(N);
      c.i32Add();
      c.i32Sub();
      c.arrayCopy(v.bufType, v.bufType);
      c.localGet(NL);
      c.localGet(NB);
      c.refAsNonNull();
      c.structNew(v.struct);
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, this.nullableBuf(v)], c.bytes());
      return idx;
    });
  }

  /** %w.vec.with — (vec, index f64, value elem) → fresh vec, one element
   * replaced (ES2023 copier — INC-27 U2). THROWS Node's catchable
   * RangeError "Invalid index : " + the ORIGINAL argument's
   * Number::toString on an out-of-range relative index — the SAME
   * throwError route and message shape
   * typedarrays.ts's BytesBuilder.withHelper already uses for
   * Uint8Array, ported to a GC vec instead of linear-memory bytes. The
   * index arrives as f64 (ToNumber is the boundary's, not the site's):
   * trunc, NaN → 0, negative → + len, then a range check that
   * THROWS (not clamps, unlike slice/splice's emitRelIndex). */
  withHelper(v: VecInfo): number {
    return this.cached(`${v.key}:with`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.vecRef(v), F64, v.elemVal], [this.vecRef(v)]),
        `%w.vec.with:${v.key}`,
      );
      const c = new Code();
      const V = 0;
      const IDX = 1;
      const VAL = 2;
      const L = 3; // i32 len
      const REL = 4; // f64 relative index
      const ACTUAL = 5; // i32 actual index
      const NB = 6; // new buf
      c.localGet(V);
      c.structGet(v.struct, LEN);
      c.localSet(L);
      c.localGet(IDX);
      c.localGet(IDX);
      c.f64Ne();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(IDX);
      c.f64Trunc();
      c.end();
      c.localSet(REL);
      c.localGet(REL);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.localGet(L);
      c.f64ConvertI32S();
      c.localGet(REL);
      c.f64Add();
      c.localSet(REL);
      c.end();
      c.localGet(REL);
      c.f64Const(0);
      c.f64Lt();
      c.localGet(REL);
      c.localGet(L);
      c.f64ConvertI32S();
      c.f64Ge();
      c.i32Or();
      c.ifVoid();
      this.deps.throwError(
        c,
        "%RangeError",
        "RangeError",
        (mc) => {
          this.deps.lit(mc, "Invalid index : ");
          mc.localGet(IDX);
          mc.call(this.deps.f64ToStr());
          mc.call(this.deps.concat());
        },
        null,
      );
      c.refNull(v.struct);
      c.return_();
      c.end();
      c.localGet(REL);
      c.i32TruncF64S();
      c.localSet(ACTUAL);
      c.localGet(L);
      c.arrayNewDefault(v.bufType);
      c.localSet(NB);
      c.localGet(NB);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(v.struct, BUF);
      c.i32Const(0);
      c.localGet(L);
      c.arrayCopy(v.bufType, v.bufType);
      c.localGet(NB);
      c.localGet(ACTUAL);
      c.localGet(VAL);
      c.arraySet(v.bufType);
      c.localGet(L);
      c.localGet(NB);
      c.refAsNonNull();
      c.structNew(v.struct);
      this.mb.setBody(idx, [I32, F64, I32, this.nullableBuf(v)], c.bytes());
      return idx;
    });
  }
}
