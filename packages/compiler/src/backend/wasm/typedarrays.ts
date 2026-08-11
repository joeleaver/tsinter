/* Typed arrays / Buffer over WasmGC: ONE wasm struct for every bytes
 * value, every element kind (increment 18 design doc, stage A):
 *   $bytes = struct { storage: (ref (array (mut i8))), off: i32, len: i32 }
 * (field names indicative; all THREE fields are immutable — only the
 * storage array's CONTENTS mutate, via array.set). `off` is a byte offset
 * from the storage array's start; `len` is an ELEMENT count. Element kind
 * (u8/u32/i32/f32) is static from the IR type and never stored — most ops
 * below are interned per elem kind (like arrays.ts's per-element-type
 * vectors), even where u32/i32 could share bytes, for the same reason
 * arrays.ts doesn't collapse structurally-identical element kinds: one
 * function per representation, simplicity over cleverness. The exceptions
 * are `length`/`byteOffset`/`equals`, which read only the elem-kind-
 * independent struct fields (or, for `equals`, only raw storage bytes)
 * and are DELIBERATELY interned ONCE, shared across every elem kind —
 * there is no representation for them to vary over.
 *
 * Storage is BYTE-GRANULAR for every elem kind (never per-elem-type
 * arrays) because DataView/Buffer-view aliasing over non-u8 typed arrays
 * needs a shared byte address space — the design doc's forced choice.
 * Multi-byte elements compose LITTLE-ENDIAN (Node's real-platform byte
 * order, observable only through aliasing, which this then matches).
 *
 * Views (subarray) are a FRESH struct sharing the SAME storage array
 * reference with a composed `off` — real GC keeps the shared array alive
 * for as long as any view references it, which is exactly C's rc
 * `backing` chain collapsed to depth 1 for free: `off` is always
 * root-relative already, so there is no separate "owner" field to
 * maintain at all.
 *
 * Element read widens to f64 (u8 zero-extend; u32 f64.convert_i32_u; i32
 * signed f64.convert_i32_s; f32 f64.promote_f32 after f32.reinterpret_i32
 * assembles the 4 LE bytes' bit pattern). Element write coerces JS-exactly:
 * integer kinds reuse %w.toInt32 (ECMA ToInt32/ToUint32's shared modular
 * truncation — verified bit-identical to scr_bytes_to_u32's NaN/Inf→0,
 * trunc, mod 2^32 wrap against scr_bytes.c:108-116: both compute
 * trunc(v) mod 2^32 taking the [0,2^32) representative; ToUint8 is that
 * pattern's low byte, which array.set onto i8-packed storage takes
 * automatically — no explicit `& 0xFF` needed); f32 via f32.demote_f64
 * (round-to-nearest-even, exactly Float32Array's coercion).
 *
 * OOB element get/set TRAPS (uncatchable) — SEMANTICS.md S003's array
 * discipline, amended to cover typed arrays (see the amendment).
 *
 * Scope note (stage A, reported to the PM): the u8-only Buffer
 * comparison/search surface (equals is here; compareBuf, indexOf/
 * lastIndexOf/includes, fill, fillNum are NOT) is deferred. compareBuf/
 * fill/fillNum need Node's ERR_OUT_OF_RANGE validateOffset ladder
 * (scr_bytes.c's scr_bytes_validate_off + scr_num_received's
 * addNumericalSeparator rendering) — substantial shared machinery that
 * stage B's readNum/writeNum bounds errors need anyway, so it lands once,
 * there. No stage-A-claimed corpus program exercises the deferred
 * methods (measured: 1663-buffer-compare-search-fill needs
 * toString/hex — stage B — regardless of these). indexOf/lastIndexOf/
 * includes never throw and were cut for time, not for a representational
 * reason; they are ordinary future work over the SAME storage this file
 * defines. */
import { BUF, LEN, type VecInfo } from "./arrays.js";
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

export type BytesElem = "u8" | "u32" | "i32" | "f32";

export interface BytesDeps {
  /** %w.concat's index (string building: messages, join). */
  concat: () => number;
  /** %w.f64ToStr's index (join, and the length RangeError message). */
  f64ToStr: () => number;
  /** Push an interned string literal onto `c`'s stack. */
  lit: (c: Code, s: string) => void;
  /** The string valtype (bytesRef-adjacent signatures: join, messages). */
  strRef: () => ValType;
  /** %w.toInt32's index — ECMA ToInt32/ToUint32's shared modular
   * truncation (see the header note on reusing it for byte coercion). */
  toInt32: () => number;
  /** The interned `vec(f64)` info — number[]'s own representation
   * (arrays.ts), needed by bytesNew's array-literal source and toArray. */
  f64Vec: () => VecInfo;
  /** %w.vec.newLen for vec(f64) — a fresh N-slot (zero-filled) vec. */
  f64VecNewLen: () => number;
  /** %w.vec.push1 for vec(f64) — the unchecked append toArray uses. */
  f64VecPush1: () => number;
  /** Builds a class-error instance from (className, name, message) and
   * fills the exception cell — emitter.ts's emitSetCellError, which does
   * NOT depend on any per-function walk state (only the `Code` passed
   * in), so it is safe to call while building a STANDALONE interned
   * helper here (the json.ts precedent: throwError sets the cell: the
   * caller in THIS file pushes the function's own dummy result and
   * `return_()`s immediately — mirroring emitUnwind's no-try-stack case
   * by hand, since a standalone helper has no `this.fn.tryStack` to
   * consult). The OUTER caller (emitter.ts's walkExpr, a real function
   * walk) then does the pending-check-and-propagate half via
   * emitPendingCheck after the `call`. */
  throwError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void) => void;
}

// $bytes struct field indices (private to this file — callers never need
// the raw layout; every access goes through a named helper below).
const STORAGE = 0;
const OFF = 1;
const BLEN = 2;

export class BytesBuilder {
  private structField: number | null = null;
  private bufField: number | null = null;
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: BytesDeps,
  ) {}

  /** The ONE byte-storage array type, shared by every bytes value of
   * every elem kind (the design doc's forced byte-granular storage). */
  bufType(): number {
    this.bufField ??= this.mb.arrayType("i8", true);
    return this.bufField;
  }

  private bufRefNN(): ValType {
    return { kind: "ref", nullable: false, typeIndex: this.bufType() };
  }

  /** The ONE $bytes struct type, shared by every elem kind — elem kind is
   * static from the IR type and never stored (the design doc's stance). */
  bytesType(): number {
    this.structField ??= this.mb.structType([
      { storage: this.bufRefNN(), mutable: false },
      { storage: I32, mutable: false }, // off, in BYTES from storage start
      { storage: I32, mutable: false }, // len, in ELEMENTS
    ]);
    return this.structField;
  }

  bytesRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bytesType() };
  }

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  private esize(elem: BytesElem): number {
    return elem === "u8" ? 1 : 4;
  }

  /** Traps (uncatchable) if `elementCount * esize` would be ≥ 2^31 — the
   * wasm-tier bytes allocation cap, SEMANTICS.md S034 (that entry's
   * registered cap IS this function's `2147483648` literal — one source
   * of truth). This is the ONE guard every bytes-length-producing
   * construction path funnels through (newLen on its ToIndex'd f64;
   * fromArrLit on its i32 source
   * length converted to f64 — that length is already capped below 2^31
   * by arrays.ts's own vec-length guard, but a u32/i32/f32 elem's esize=4
   * multiplier can still carry the BYTE size past this cap, so it needs
   * the identical check, not a smaller one). Every OTHER bytes value
   * derives its length from an already-valid receiver (slice/subarray/
   * with/toReversed/fillElem never exceed their source's len), so
   * guarding these two suffices for `len * esize` to never overflow i32
   * anywhere byteLength (or any byte-address arithmetic) reads it. Must
   * run AFTER any catchable-RangeError length validation (Node accepts
   * this length; it is OUR representation that cannot hold it — an
   * uncatchable engineering limit, not an observable JS error). */
  private emitByteSizeGuard(c: Code, esz: number, pushCountF64: () => void): void {
    pushCountF64();
    if (esz > 1) {
      c.f64Const(esz);
      c.f64Mul();
    }
    c.f64Const(2147483648);
    c.f64Ge();
    c.ifVoid();
    c.unreachable();
    c.end();
  }

  /** Validates the f64 index in local X is an integer in [0, limit] (the
   * caller pushes the limit — get/set both use len-1, the [0,len) read/
   * write range; bytes never grow, so there is no arrays.ts-style i==len
   * append case). TRAPS otherwise (S003, amended for bytes). Leaves the
   * i32 index in local I. Mirrors arrays.ts's VecBuilder.emitIndexCheck
   * exactly — each builder file is self-contained by house style. */
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

  /** Pushes trunc+relative+clamped i32 from the f64 in local X: negative
   * means len + x, then clamp to [0, len]. ±Infinity clamps too, NaN
   * reads as 0 — ToIntegerOrInfinity, exactly VecBuilder.emitRelIndex
   * (slice/subarray/with/fillElem's shared boundary rule). `LENI` is an
   * i32 local already holding the element length. */
  private emitRelIndex(c: Code, X: number, LENI: number): void {
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
    c.localGet(LENI);
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
    c.localGet(LENI);
    c.f64ConvertI32S();
    c.f64Ge();
    c.ifResult(I32);
    c.localGet(LENI);
    c.else_();
    c.localGet(X);
    c.i32TruncF64S();
    c.end();
    c.end();
  }

  /** Widens the elem-kind's raw bits (already assembled/read into local
   * BITS for non-u8, or read raw for u8) to f64, pushing the result. For
   * u8, reads directly off (BUFL, ADDR) since no assembly is needed. */
  private emitWidenElem(c: Code, elem: BytesElem, BUFL: number, ADDR: number, BITS: number): void {
    if (elem === "u8") {
      c.localGet(BUFL);
      c.localGet(ADDR);
      c.arrayGetU(this.bufType());
      c.f64ConvertI32U();
      return;
    }
    c.i32Const(0);
    c.localSet(BITS);
    for (let k = 0; k < 4; k++) {
      c.localGet(BITS);
      c.localGet(BUFL);
      c.localGet(ADDR);
      if (k > 0) {
        c.i32Const(k);
        c.i32Add();
      }
      c.arrayGetU(this.bufType());
      if (k > 0) {
        c.i32Const(8 * k);
        c.i32Shl();
      }
      c.i32Or();
      c.localSet(BITS);
    }
    c.localGet(BITS);
    if (elem === "u32") c.f64ConvertI32U();
    else if (elem === "i32") c.f64ConvertI32S();
    else {
      c.f32ReinterpretI32();
      c.f64PromoteF32();
    }
  }

  /** Scatters the f64 value in local VAL, JS-coerced, into (BUFL, ADDR)
   * for u8 (one array.set — packed i8 storage auto-truncates the low
   * byte, so ToUint32's pattern IS ToUint8's) or 4 little-endian bytes for
   * the wider kinds (BITS is a scratch i32 local; u32/i32 share
   * %w.toInt32's bit pattern, f32 goes through demote+reinterpret). */
  private emitScatterElem(c: Code, elem: BytesElem, VAL: number, BUFL: number, ADDR: number, BITS: number): void {
    if (elem === "u8") {
      c.localGet(BUFL);
      c.localGet(ADDR);
      c.localGet(VAL);
      c.call(this.deps.toInt32());
      c.arraySet(this.bufType());
      return;
    }
    if (elem === "f32") {
      c.localGet(VAL);
      c.f32DemoteF64();
      c.i32ReinterpretF32();
    } else {
      c.localGet(VAL);
      c.call(this.deps.toInt32());
    }
    c.localSet(BITS);
    for (let k = 0; k < 4; k++) {
      c.localGet(BUFL);
      c.localGet(ADDR);
      if (k > 0) {
        c.i32Const(k);
        c.i32Add();
      }
      c.localGet(BITS);
      if (k > 0) {
        c.i32Const(8 * k);
        c.i32ShrU();
      }
      c.arraySet(this.bufType());
    }
  }

  /* ── properties ───────────────────────────────────────────────────── */

  /** %w.bytes.length — elem-kind-independent (the struct layout is
   * shared), so ONE function serves every elem kind. */
  length(): number {
    return this.cached("length", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef()], [F64]), "%w.bytes.length");
      const c = new Code();
      c.localGet(0);
      c.structGet(this.bytesType(), BLEN);
      c.f64ConvertI32S();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.byteOffset — also elem-kind-independent: `off` is already
   * in bytes regardless of what the elements are. */
  byteOffset(): number {
    return this.cached("byteOffset", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef()], [F64]), "%w.bytes.byteOffset");
      const c = new Code();
      c.localGet(0);
      c.structGet(this.bytesType(), OFF);
      c.f64ConvertI32S();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.byteLength:<elem> — len * esize. */
  byteLength(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`byteLength:${elem}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef()], [F64]), `%w.bytes.byteLength:${elem}`);
      const c = new Code();
      c.localGet(0);
      c.structGet(this.bytesType(), BLEN);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.f64ConvertI32S();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /* ── element access ──────────────────────────────────────────────── */

  /** %w.bytes.get:<elem> — (bytes, f64 index) → f64; OOB TRAPS. */
  get(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`get:${elem}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef(), F64], [F64]), `%w.bytes.get:${elem}`);
      const c = new Code();
      const V = 0, X = 1, I = 2, ADDR = 3, BUFL = 4, BITS = 5;
      this.emitIndexCheck(c, X, I, () => {
        c.localGet(V);
        c.structGet(this.bytesType(), BLEN);
        c.i32Const(1);
        c.i32Sub();
        c.f64ConvertI32S();
      });
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localSet(ADDR);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      this.emitWidenElem(c, elem, BUFL, ADDR, BITS);
      this.mb.setBody(idx, [I32, I32, this.bufRefNN(), I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.set:<elem> — (bytes, f64 index, f64 value) → (); OOB TRAPS,
   * write coerces JS-exactly. Backs the `bytesSet` statement. */
  setElem(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`set:${elem}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef(), F64, F64], []), `%w.bytes.set:${elem}`);
      const c = new Code();
      const V = 0, X = 1, VAL = 2, I = 3, ADDR = 4, BUFL = 5, BITS = 6;
      this.emitIndexCheck(c, X, I, () => {
        c.localGet(V);
        c.structGet(this.bytesType(), BLEN);
        c.i32Const(1);
        c.i32Sub();
        c.f64ConvertI32S();
      });
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localSet(ADDR);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      this.emitScatterElem(c, elem, VAL, BUFL, ADDR, BITS);
      this.mb.setBody(idx, [I32, I32, this.bufRefNN(), I32], c.bytes());
      return idx;
    });
  }

  /* ── construction ────────────────────────────────────────────────── */

  /** %w.bytes.new:<elem> — (f64 n) → bytes; ToIndex (NaN→0, truncate) a
   * zero-filled buffer, or Node's catchable "Invalid typed array length:
   * N" RangeError (N is the ORIGINAL argument's ToString — measured
   * against Node directly: `new Uint8Array(-1.5)` reads "...length: -1.5",
   * NOT the truncated "-1" scr_bytes.c's message would render; see the
   * stage-A report for the C-runtime-vs-Node correction). */
  newLen(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`newLen:${elem}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [this.bytesRef()]), `%w.bytes.new:${elem}`);
      const c = new Code();
      const N = 0, T = 1, CNT = 2, BUFV = 3;
      c.localGet(N);
      c.localGet(N);
      c.f64Ne();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(N);
      c.f64Trunc();
      c.end();
      c.localSet(T);
      c.localGet(T);
      c.f64Const(0);
      c.f64Lt();
      c.localGet(T);
      c.f64Const(9007199254740991);
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      this.deps.throwError(c, "%RangeError", "RangeError", (x) => {
        this.deps.lit(x, "Invalid typed array length: ");
        x.localGet(N);
        x.call(this.deps.f64ToStr());
        x.call(this.deps.concat());
      });
      c.refNull(this.bytesType());
      c.return_();
      c.end();
      this.emitByteSizeGuard(c, esz, () => c.localGet(T));
      c.localGet(T);
      c.i32TruncF64S();
      c.localSet(CNT);
      c.localGet(CNT);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayNewDefault(this.bufType());
      c.localSet(BUFV);
      c.localGet(BUFV);
      c.i32Const(0);
      c.localGet(CNT);
      c.structNew(this.bytesType());
      this.mb.setBody(idx, [F64, I32, this.bufRefNN()], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.fromArrLit:<elem> — (vec(f64)) → bytes; a per-element
   * coerced copy (`new Uint8Array([1, 2.7, -1, 256])`). */
  fromArrLit(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`fromArrLit:${elem}`, () => {
      const vinfo = this.deps.f64Vec();
      const vref: ValType = { kind: "ref", nullable: true, typeIndex: vinfo.struct };
      const idx = this.mb.declareFunc(this.mb.funcType([vref], [this.bytesRef()]), `%w.bytes.fromArrLit:${elem}`);
      const c = new Code();
      const SRC = 0, N = 1, OUTBUF = 2, I = 3, ADDR = 4, BITS = 5, EL = 6;
      c.localGet(SRC);
      c.structGet(vinfo.struct, LEN);
      c.localSet(N);
      this.emitByteSizeGuard(c, esz, () => {
        c.localGet(N);
        c.f64ConvertI32S();
      });
      c.localGet(N);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayNewDefault(this.bufType());
      c.localSet(OUTBUF);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(SRC);
      c.structGet(vinfo.struct, BUF);
      c.localGet(I);
      c.arrayGet(vinfo.bufType);
      c.localSet(EL);
      c.localGet(I);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.localSet(ADDR);
      this.emitScatterElem(c, elem, EL, OUTBUF, ADDR, BITS);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUTBUF);
      c.i32Const(0);
      c.localGet(N);
      c.structNew(this.bytesType());
      this.mb.setBody(idx, [I32, this.bufRefNN(), I32, I32, I32, F64], c.bytes());
      return idx;
    });
  }

  /* ── views / copies ──────────────────────────────────────────────── */

  /** %w.bytes.slice:<elem> — (bytes, f64 start, f64 end) → bytes; a fresh
   * COPY over relative/clamped indices (TypedArray.prototype.slice; also
   * bytesNew's same-elem-copy source form, called with (0, length)). */
  sliceHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`slice:${elem}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.bytesRef(), F64, F64], [this.bytesRef()]),
        `%w.bytes.slice:${elem}`,
      );
      const c = new Code();
      const V = 0, A = 1, B = 2, LENI = 3, S = 4, E = 5, CNT = 6, OUTBUF = 7;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      this.emitRelIndex(c, A, LENI);
      c.localSet(S);
      this.emitRelIndex(c, B, LENI);
      c.localSet(E);
      c.localGet(E);
      c.localGet(S);
      c.i32GtS();
      c.ifResult(I32);
      c.localGet(E);
      c.localGet(S);
      c.i32Sub();
      c.else_();
      c.i32Const(0);
      c.end();
      c.localSet(CNT);
      c.localGet(CNT);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayNewDefault(this.bufType());
      c.localSet(OUTBUF);
      c.localGet(OUTBUF);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(S);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localGet(CNT);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayCopy(this.bufType(), this.bufType());
      c.localGet(OUTBUF);
      c.i32Const(0);
      c.localGet(CNT);
      c.structNew(this.bytesType());
      this.mb.setBody(idx, [I32, I32, I32, I32, this.bufRefNN()], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.subarray:<elem> — (bytes, f64 start, f64 end) → bytes; a
   * fresh struct sharing the SAME storage array (a VIEW — aliasing writes
   * visible both ways, matching Node; the C runtime's owner-flattening
   * backing chain is unnecessary here since `off` is always
   * root-relative and the GC keeps the shared array alive on its own). */
  subarrayHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`subarray:${elem}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.bytesRef(), F64, F64], [this.bytesRef()]),
        `%w.bytes.subarray:${elem}`,
      );
      const c = new Code();
      const V = 0, A = 1, B = 2, LENI = 3, S = 4, E = 5, CNT = 6;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      this.emitRelIndex(c, A, LENI);
      c.localSet(S);
      this.emitRelIndex(c, B, LENI);
      c.localSet(E);
      c.localGet(E);
      c.localGet(S);
      c.i32GtS();
      c.ifResult(I32);
      c.localGet(E);
      c.localGet(S);
      c.i32Sub();
      c.else_();
      c.i32Const(0);
      c.end();
      c.localSet(CNT);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(S);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localGet(CNT);
      c.structNew(this.bytesType());
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.setFrom:<elem> — (dst, src, f64 offset) → (); `dst.set(src,
   * offset?)`. THROWS Node's constant "offset is out of bounds"
   * RangeError on overflow (measured: no dynamic parts in the message).
   * The copy is overlap-safe (array.copy has memmove semantics). */
  setFromHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`setFrom:${elem}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.bytesRef(), this.bytesRef(), F64], []),
        `%w.bytes.setFrom:${elem}`,
      );
      const c = new Code();
      const DST = 0, SRC = 1, OFFARG = 2, T = 3, SRCLEN = 4, DSTLEN = 5;
      c.localGet(OFFARG);
      c.localGet(OFFARG);
      c.f64Ne();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(OFFARG);
      c.f64Trunc();
      c.end();
      c.localSet(T);
      c.localGet(SRC);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(SRCLEN);
      c.localGet(DST);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(DSTLEN);
      c.localGet(T);
      c.f64Const(0);
      c.f64Lt();
      c.localGet(SRCLEN);
      c.f64ConvertI32S();
      c.localGet(T);
      c.f64Add();
      c.localGet(DSTLEN);
      c.f64ConvertI32S();
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      this.deps.throwError(c, "%RangeError", "RangeError", (x) => this.deps.lit(x, "offset is out of bounds"));
      c.return_();
      c.end();
      c.localGet(DST);
      c.structGet(this.bytesType(), STORAGE);
      c.localGet(DST);
      c.structGet(this.bytesType(), OFF);
      c.localGet(T);
      c.i32TruncF64S();
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localGet(SRC);
      c.structGet(this.bytesType(), STORAGE);
      c.localGet(SRC);
      c.structGet(this.bytesType(), OFF);
      c.localGet(SRCLEN);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayCopy(this.bufType(), this.bufType());
      this.mb.setBody(idx, [F64, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.toArray:<elem> — (bytes) → vec(f64); drains elements into a
   * fresh number[] (array spread / typed-array destructuring rest). */
  toArrayHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`toArray:${elem}`, () => {
      const vinfo = this.deps.f64Vec();
      const vref: ValType = { kind: "ref", nullable: true, typeIndex: vinfo.struct };
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef()], [vref]), `%w.bytes.toArray:${elem}`);
      const c = new Code();
      const V = 0, LENI = 1, OUT = 2, I = 3, ADDR = 4, BUFL = 5, BITS = 6;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      c.f64Const(0);
      c.call(this.deps.f64VecNewLen());
      c.localSet(OUT);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LENI);
      c.i32GeS();
      c.brIf(1);
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localSet(ADDR);
      c.localGet(OUT);
      this.emitWidenElem(c, elem, BUFL, ADDR, BITS);
      c.call(this.deps.f64VecPush1());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUT);
      this.mb.setBody(idx, [I32, vref, I32, I32, this.bufRefNN(), I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.join:<elem> — (bytes, str sep) → str; Array.prototype.join
   * over the elements' Number ToString (Uint8Array.prototype.join, u8-
   * only at the lowering — this file stays generic like everything
   * else). Mirrors VecBuilder.join's f64-element arm exactly, reading
   * bytes storage directly instead of a vec buffer. */
  joinHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`join:${elem}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.bytesRef(), this.deps.strRef()], [this.deps.strRef()]),
        `%w.bytes.join:${elem}`,
      );
      const c = new Code();
      const V = 0, SEP = 1, LENI = 2, I = 3, ACC = 4, BUFL = 5, ADDR = 6, BITS = 7;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      this.deps.lit(c, "");
      c.localSet(ACC);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LENI);
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
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localSet(ADDR);
      this.emitWidenElem(c, elem, BUFL, ADDR, BITS);
      c.call(this.deps.f64ToStr());
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
      this.mb.setBody(idx, [I32, I32, this.deps.strRef(), this.bufRefNN(), I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.with:<elem> — (bytes, f64 index, f64 value) → bytes; a
   * fresh copy with one element replaced. THROWS Node's constant "Invalid
   * typed array index" RangeError (measured: no dynamic parts) on an
   * out-of-range relative index. u8-only at the lowering. */
  withHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`with:${elem}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.bytesRef(), F64, F64], [this.bytesRef()]),
        `%w.bytes.with:${elem}`,
      );
      const c = new Code();
      const V = 0, IDX = 1, VAL = 2, LENI = 3, REL = 4, ACTUAL = 5, OUTBUF = 6, ADDR = 7, BITS = 8;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
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
      c.localGet(LENI);
      c.f64ConvertI32S();
      c.localGet(REL);
      c.f64Add();
      c.localSet(REL);
      c.end();
      c.localGet(REL);
      c.f64Const(0);
      c.f64Lt();
      c.localGet(REL);
      c.localGet(LENI);
      c.f64ConvertI32S();
      c.f64Ge();
      c.i32Or();
      c.ifVoid();
      this.deps.throwError(c, "%RangeError", "RangeError", (x) => this.deps.lit(x, "Invalid typed array index"));
      c.refNull(this.bytesType());
      c.return_();
      c.end();
      c.localGet(REL);
      c.i32TruncF64S();
      c.localSet(ACTUAL);
      c.localGet(LENI);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayNewDefault(this.bufType());
      c.localSet(OUTBUF);
      c.localGet(OUTBUF);
      c.i32Const(0);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(LENI);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayCopy(this.bufType(), this.bufType());
      c.localGet(ACTUAL);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.localSet(ADDR);
      this.emitScatterElem(c, elem, VAL, OUTBUF, ADDR, BITS);
      c.localGet(OUTBUF);
      c.i32Const(0);
      c.localGet(LENI);
      c.structNew(this.bytesType());
      this.mb.setBody(idx, [I32, F64, I32, this.bufRefNN(), I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.toReversed:<elem> — (bytes) → bytes; a fresh reversed copy. */
  toReversedHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`toReversed:${elem}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef()], [this.bytesRef()]), `%w.bytes.toReversed:${elem}`);
      const c = new Code();
      const V = 0, LENI = 1, OUTBUF = 2, I = 3, SRCADDR = 4, DSTADDR = 5, BUFL = 6;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      c.localGet(LENI);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.arrayNewDefault(this.bufType());
      c.localSet(OUTBUF);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LENI);
      c.i32GeS();
      c.brIf(1);
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(LENI);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(I);
      c.i32Sub();
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localSet(SRCADDR);
      c.localGet(I);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.localSet(DSTADDR);
      for (let k = 0; k < esz; k++) {
        c.localGet(OUTBUF);
        c.localGet(DSTADDR);
        if (k > 0) {
          c.i32Const(k);
          c.i32Add();
        }
        c.localGet(BUFL);
        c.localGet(SRCADDR);
        if (k > 0) {
          c.i32Const(k);
          c.i32Add();
        }
        c.arrayGetU(this.bufType());
        c.arraySet(this.bufType());
      }
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUTBUF);
      c.i32Const(0);
      c.localGet(LENI);
      c.structNew(this.bytesType());
      this.mb.setBody(idx, [I32, this.bufRefNN(), I32, I32, I32, this.bufRefNN()], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.fillElem:<elem> — (bytes, f64 value, f64 start, f64 end) →
   * bytes (the RECEIVER — chaining, identity-preserving); TypedArray.
   * prototype.fill on NON-u8 receivers: per-element coercion, slice-
   * clamped relative indices, NEVER throws (u8 keeps the separate,
   * throwing Buffer fill family — deferred, see the header note). */
  fillElemHelper(elem: BytesElem): number {
    const esz = this.esize(elem);
    return this.cached(`fillElem:${elem}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.bytesRef(), F64, F64, F64], [this.bytesRef()]),
        `%w.bytes.fillElem:${elem}`,
      );
      const c = new Code();
      const V = 0, VAL = 1, A = 2, B = 3, LENI = 4, S = 5, E = 6, BUFL = 7, I = 8, ADDR = 9, BITS = 10;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      this.emitRelIndex(c, A, LENI);
      c.localSet(S);
      this.emitRelIndex(c, B, LENI);
      c.localSet(E);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      c.localGet(S);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(E);
      c.i32GeS();
      c.brIf(1);
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      if (esz > 1) {
        c.i32Const(esz);
        c.i32Mul();
      }
      c.i32Add();
      c.localSet(ADDR);
      this.emitScatterElem(c, elem, VAL, BUFL, ADDR, BITS);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(V);
      this.mb.setBody(idx, [I32, I32, I32, this.bufRefNN(), I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /* ── comparison (u8 only; the design-doc-scoped subset) ─────────────── */

  /** %w.bytes.equals — (a, b) → i32 bool; length + byte content, never
   * throws. u8-only at the lowering (the Buffer surface). */
  equalsHelper(): number {
    return this.cached("equals", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef(), this.bytesRef()], [I32]), "%w.bytes.equals");
      const c = new Code();
      const A = 0, B = 1, LENI = 2, BUFA = 3, BUFB = 4, I = 5;
      c.localGet(A);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      c.localGet(B);
      c.structGet(this.bytesType(), BLEN);
      c.localGet(LENI);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(A);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFA);
      c.localGet(B);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFB);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LENI);
      c.i32GeS();
      c.brIf(1);
      c.localGet(BUFA);
      c.localGet(A);
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(this.bufType());
      c.localGet(BUFB);
      c.localGet(B);
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(this.bufType());
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [I32, this.bufRefNN(), this.bufRefNN(), I32], c.bytes());
      return idx;
    });
  }
}
