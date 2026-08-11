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
  /** The string array TYPE INDEX (not just its ValType) — the encoding
   * surface reads/writes UTF-16 code units directly (arrayGetU/arraySet),
   * which needs the raw type, not only the ref wrapping it. */
  strType: () => number;
  /** %w.toInt32's index — ECMA ToInt32/ToUint32's shared modular
   * truncation (see the header note on reusing it for byte coercion). */
  toInt32: () => number;
  /** %w.str.slice's index (strings.ts) — (str, f64 start, f64 end) → str.
   * numReceived's addNumericalSeparator rendering only ever passes
   * non-negative, in-range indices, so the general slice's relative/
   * negative-from-end handling is simply never triggered — reused
   * as-is rather than duplicated. */
  strSlice: () => number;
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
   * emitPendingCheck after the `call`. `codeLit` is the error's `.code`
   * property (e.g. "ERR_OUT_OF_RANGE") — null for the plain RangeErrors
   * stage A needed, non-null for stage B's Node-coded bounds errors. */
  throwError: (
    c: Code,
    className: string,
    name: string,
    pushMessage: (c: Code) => void,
    codeLit: string | null,
  ) => void;
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
      this.deps.throwError(
        c,
        "%RangeError",
        "RangeError",
        (x) => {
          this.deps.lit(x, "Invalid typed array length: ");
          x.localGet(N);
          x.call(this.deps.f64ToStr());
          x.call(this.deps.concat());
        },
        null,
      );
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
      this.deps.throwError(
        c,
        "%RangeError",
        "RangeError",
        (x) => this.deps.lit(x, "offset is out of bounds"),
        null,
      );
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
      this.deps.throwError(
        c,
        "%RangeError",
        "RangeError",
        (x) => this.deps.lit(x, "Invalid typed array index"),
        null,
      );
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

  /* ── numeric bounds/error rendering (scr_bytes.c:1282-1389) — shared by
   * stage B's readNum/writeNum bounds errors and (future work) compareBuf/
   * fill/fillNum's validateOffset ladder; built once, here, since both
   * need Node's ERR_OUT_OF_RANGE "Received" rendering. ─────────────────── */

  /** %w.bytes.numReceived — (f64) → str; Node's ERR_OUT_OF_RANGE "Received"
   * rendering (scr_num_received): the plain Number.toString() form, UNLESS
   * the value is a finite integer with |v| > 2^32, in which case Node's
   * addNumericalSeparator walks the STRING in groups of 3 from the RIGHT
   * (underscore-joined) — a blind string walk, not a semantic one, so it
   * lands inside an exponent's digits exactly where the group boundary
   * falls: measured directly against Node 24.18, `1e21` renders as
   * `Received 1e_+21` and `1e300` as `Received 1e+_300` (this function's
   * algorithm hand-traced against both and matches exactly — `head` walks
   * back from the string's end in threes with no awareness of what
   * character it lands on). */
  numReceivedHelper(): number {
    return this.cached("numReceived", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64], [this.strRefN()]), "%w.bytes.numReceived");
      const c = new Code();
      const V = 0, PLAIN = 1, N = 2, START = 3, HEAD = 4, ACC = 5, P = 6;
      c.localGet(V);
      c.call(this.deps.f64ToStr());
      c.localSet(PLAIN);
      c.localGet(PLAIN);
      c.arrayLen();
      c.localSet(N);
      // condition = isfinite(v) && trunc(v)==v && abs(v) > 2^32
      c.localGet(V);
      c.localGet(V);
      c.f64Eq(); // not NaN
      c.localGet(V);
      c.f64Const(Infinity);
      c.f64Eq();
      c.i32Eqz(); // not +Infinity
      c.i32And();
      c.localGet(V);
      c.f64Const(-Infinity);
      c.f64Eq();
      c.i32Eqz(); // not -Infinity
      c.i32And();
      c.localGet(V);
      c.f64Trunc();
      c.localGet(V);
      c.f64Eq(); // is an integer
      c.i32And();
      c.localGet(V);
      c.f64Const(0);
      c.f64Lt();
      c.ifResult(F64);
      c.localGet(V);
      c.f64Neg();
      c.else_();
      c.localGet(V);
      c.end();
      c.f64Const(4294967296);
      c.f64Gt(); // abs(v) > 2^32
      c.i32And();
      c.i32Eqz(); // NEGATED: true when the grouping does NOT apply
      c.ifVoid();
      c.localGet(PLAIN);
      c.return_();
      c.end();
      // START = (plain[0] == '-') ? 1 : 0
      c.localGet(PLAIN);
      c.i32Const(0);
      c.arrayGetU(this.deps.strType());
      c.i32Const(0x2d);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.i32Const(0);
      c.end();
      c.localSet(START);
      // while (head >= start + 4) head -= 3;
      c.localGet(N);
      c.localSet(HEAD);
      c.block();
      c.loop();
      c.localGet(HEAD);
      c.localGet(START);
      c.i32Const(4);
      c.i32Add();
      c.i32GeS();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(HEAD);
      c.i32Const(3);
      c.i32Sub();
      c.localSet(HEAD);
      c.br(0);
      c.end();
      c.end();
      // acc = plain[0..head)
      c.localGet(PLAIN);
      c.f64Const(0);
      c.localGet(HEAD);
      c.f64ConvertI32S();
      c.call(this.deps.strSlice());
      c.localSet(ACC);
      c.localGet(HEAD);
      c.localSet(P);
      c.block();
      c.loop();
      c.localGet(P);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(ACC);
      this.deps.lit(c, "_");
      c.call(this.deps.concat());
      c.localSet(ACC);
      c.localGet(ACC);
      c.localGet(PLAIN);
      c.localGet(P);
      c.f64ConvertI32S();
      c.localGet(P);
      c.i32Const(3);
      c.i32Add();
      c.f64ConvertI32S();
      c.call(this.deps.strSlice());
      c.call(this.deps.concat());
      c.localSet(ACC);
      c.localGet(P);
      c.i32Const(3);
      c.i32Add();
      c.localSet(P);
      c.br(0);
      c.end();
      c.end();
      c.localGet(ACC);
      this.mb.setBody(idx, [this.strRefN(), I32, I32, I32, this.strRefN(), I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.boundsErrorOffset — (f64 value, f64 cap) → (); the shared
   * tail of scr_bytes_rw_check's failure (scr_bytes_bounds_error with
   * `type` always "offset" — readNum/writeNum's own call shape; the
   * `type` = "byteLength" arm scr_bytes_read_var/write_var use is
   * follow-up work for the variable-width family). VOID — sets the
   * exception cell and returns; the CALLER pushes its own dummy result
   * and `return_()`s immediately after, the json.ts throwEnd() pattern. */
  private boundsErrorHelper(): number {
    return this.cached("boundsErrorOffset", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([F64, F64], []), "%w.bytes.boundsErrorOffset");
      const c = new Code();
      const VALUE = 0, CAP = 1;
      c.localGet(VALUE);
      c.f64Trunc();
      c.localGet(VALUE);
      c.f64Ne();
      c.ifVoid();
      {
        this.deps.throwError(
          c,
          "%RangeError",
          "RangeError",
          (x) => {
            this.deps.lit(x, 'The value of "offset" is out of range. It must be an integer. Received ');
            x.localGet(VALUE);
            x.call(this.numReceivedHelper());
            x.call(this.deps.concat());
          },
          "ERR_OUT_OF_RANGE",
        );
        c.return_();
      }
      c.end();
      c.localGet(CAP);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      {
        this.deps.throwError(
          c,
          "%RangeError",
          "RangeError",
          (x) => this.deps.lit(x, "Attempt to access memory outside buffer bounds"),
          "ERR_BUFFER_OUT_OF_BOUNDS",
        );
        c.return_();
      }
      c.end();
      this.deps.throwError(
        c,
        "%RangeError",
        "RangeError",
        (x) => {
          this.deps.lit(x, 'The value of "offset" is out of range. It must be >= 0 and <= ');
          x.localGet(CAP);
          x.call(this.deps.f64ToStr());
          x.call(this.deps.concat());
          this.deps.lit(x, ". Received ");
          x.call(this.deps.concat());
          x.localGet(VALUE);
          x.call(this.numReceivedHelper());
          x.call(this.deps.concat());
        },
        "ERR_OUT_OF_RANGE",
      );
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** LE/BE-aware byte assembly (widths 1/2/4 — the integer readNum/
   * writeNum family; f32/f64 are follow-up work, see readNumHelper's own
   * note). Mirrors scr_bytes_read_num's loop exactly: output bit-position
   * `i` reads from byte `le ? i : width-1-i`, shifted left by `8*i`. */
  private emitAssembleI32(c: Code, BUFL: number, ADDR: number, width: number, le: boolean, BITS: number): void {
    c.i32Const(0);
    c.localSet(BITS);
    for (let i = 0; i < width; i++) {
      const bytePos = le ? i : width - 1 - i;
      c.localGet(BITS);
      c.localGet(BUFL);
      c.localGet(ADDR);
      if (bytePos > 0) {
        c.i32Const(bytePos);
        c.i32Add();
      }
      c.arrayGetU(this.bufType());
      if (i > 0) {
        c.i32Const(8 * i);
        c.i32Shl();
      }
      c.i32Or();
      c.localSet(BITS);
    }
  }

  /** The scatter twin of emitAssembleI32 — mirrors scr_bytes_write_num's
   * loop: byte `le ? i : width-1-i` gets `(bits >> 8*i)` (array.set on
   * packed i8 storage auto-truncates to the low byte, so no explicit
   * `& 0xFF` is needed, exactly the element-write precedent from stage A). */
  private emitScatterI32(c: Code, BUFL: number, ADDR: number, width: number, le: boolean, BITS: number): void {
    for (let i = 0; i < width; i++) {
      const bytePos = le ? i : width - 1 - i;
      c.localGet(BUFL);
      c.localGet(ADDR);
      if (bytePos > 0) {
        c.i32Const(bytePos);
        c.i32Add();
      }
      c.localGet(BITS);
      if (i > 0) {
        c.i32Const(8 * i);
        c.i32ShrU();
      }
      c.arraySet(this.bufType());
    }
  }

  /** The fixed-width INTEGER readNum/writeNum kind tokens → (width,
   * signed, littleEndian). f32/f64 kinds throw here deliberately —
   * readNumHelper/writeNumHelper never reach this for them (the emitter
   * gates those kinds to a named refusal before calling in, since they
   * need i64/f32-reinterpret machinery this stage doesn't build yet). */
  private parseIntNumKind(kind: string): { width: number; signed: boolean; le: boolean } {
    if (kind === "u8") return { width: 1, signed: false, le: true };
    if (kind === "i8") return { width: 1, signed: true, le: true };
    const le = kind.endsWith("le");
    const rest = kind.slice(0, kind.length - 2);
    if (rest === "u16") return { width: 2, signed: false, le };
    if (rest === "i16") return { width: 2, signed: true, le };
    if (rest === "u32") return { width: 4, signed: false, le };
    if (rest === "i32") return { width: 4, signed: true, le };
    throw new Error(`typedarrays.ts bug: readNum/writeNum kind '${kind}' reached parseIntNumKind unguarded`);
  }

  /** %w.bytes.readNum:<kind> — (bytes<u8>, f64 offset) → f64; the fixed-
   * width integer read family (scr_bytes_read_num, scr_bytes_rw_check).
   * f32/f64 kinds are NOT built by this method — see parseIntNumKind. */
  readNumHelper(kind: string): number {
    const { width, signed, le } = this.parseIntNumKind(kind);
    return this.cached(`readNum:${kind}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef(), F64], [F64]), `%w.bytes.readNum:${kind}`);
      const c = new Code();
      const V = 0, OFFSET = 1, LENI = 2, CAP = 3, ADDR = 4, BUFL = 5, BITS = 6;
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      c.localGet(LENI);
      c.f64ConvertI32S();
      c.f64Const(width);
      c.f64Sub();
      c.localSet(CAP);
      c.localGet(OFFSET);
      c.f64Trunc();
      c.localGet(OFFSET);
      c.f64Ne();
      c.localGet(CAP);
      c.f64Const(0);
      c.f64Lt();
      c.i32Or();
      c.localGet(OFFSET);
      c.f64Const(0);
      c.f64Lt();
      c.i32Or();
      c.localGet(OFFSET);
      c.localGet(CAP);
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      {
        c.localGet(OFFSET);
        c.localGet(CAP);
        c.call(this.boundsErrorHelper());
        c.f64Const(0);
        c.return_();
      }
      c.end();
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(OFFSET);
      c.i32TruncF64S();
      c.i32Add();
      c.localSet(ADDR);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      this.emitAssembleI32(c, BUFL, ADDR, width, le, BITS);
      if (signed && width < 4) {
        // emitAssembleI32 zero-extends (arrayGetU) — correct for unsigned
        // reads, but a signed narrow read needs the sign bit propagated
        // across the full i32 before f64ConvertI32S: shift the value bit
        // up to bit 31, then arithmetic-shift back down (sign-extending).
        c.localGet(BITS);
        c.i32Const(32 - 8 * width);
        c.i32Shl();
        c.i32Const(32 - 8 * width);
        c.i32ShrS();
        c.localSet(BITS);
      }
      c.localGet(BITS);
      if (signed) c.f64ConvertI32S();
      else c.f64ConvertI32U();
      this.mb.setBody(idx, [I32, F64, I32, this.bufRefNN(), I32], c.bytes());
      return idx;
    });
  }

  /** %w.bytes.writeNum:<kind> — (bytes<u8>, f64 value, f64 offset) → f64
   * (offset + width); the fixed-width integer write family
   * (scr_bytes_write_num, scr_bytes_check_int + scr_bytes_rw_check).
   * Value-range validates FIRST, against the RAW (untruncated) value —
   * Node's actual check order, confirmed by direct measurement across all
   * 10 kinds (see wasm-emitter.test.ts's "writeNum — fractional/NaN/
   * Infinity" test): `writeUInt8(-0.5)` THROWS even though truncating
   * toward zero would land in range at 0, and `writeUInt8(255.5)` THROWS
   * for the same reason on the high side — this is a magnitude check on
   * the value as received, not an integer-ness check, and not a
   * check-after-truncate. A value that passes but is fractional or NaN
   * truncates/zeros silently (NaN passes the range gate since every NaN
   * comparison is false, then writes zero) — which `%w.toInt32` already
   * implements (ECMA ToInt32/ToUint32's shared NaN→0/trunc/mod-2^32), so
   * the value→bits step is exactly ONE call, reused from stage A. */
  writeNumHelper(kind: string): number {
    const { width, signed, le } = this.parseIntNumKind(kind);
    const max = signed ? 2 ** (8 * width - 1) - 1 : 2 ** (8 * width) - 1;
    const min = signed ? -(2 ** (8 * width - 1)) : 0;
    return this.cached(`writeNum:${kind}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.bytesRef(), F64, F64], [F64]),
        `%w.bytes.writeNum:${kind}`,
      );
      const c = new Code();
      const V = 0, VALUE = 1, OFFSET = 2, LENI = 3, CAP = 4, ADDR = 5, BUFL = 6, BITS = 7;
      c.localGet(VALUE);
      c.f64Const(max);
      c.f64Gt();
      c.localGet(VALUE);
      c.f64Const(min);
      c.f64Lt();
      c.i32Or();
      c.ifVoid();
      {
        this.deps.throwError(
          c,
          "%RangeError",
          "RangeError",
          (x) => {
            this.deps.lit(
              x,
              `The value of "value" is out of range. It must be >= ${String(min)} and <= ${String(max)}. Received `,
            );
            x.localGet(VALUE);
            x.call(this.numReceivedHelper());
            x.call(this.deps.concat());
          },
          "ERR_OUT_OF_RANGE",
        );
        c.f64Const(0);
        c.return_();
      }
      c.end();
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      c.localGet(LENI);
      c.f64ConvertI32S();
      c.f64Const(width);
      c.f64Sub();
      c.localSet(CAP);
      c.localGet(OFFSET);
      c.f64Trunc();
      c.localGet(OFFSET);
      c.f64Ne();
      c.localGet(CAP);
      c.f64Const(0);
      c.f64Lt();
      c.i32Or();
      c.localGet(OFFSET);
      c.f64Const(0);
      c.f64Lt();
      c.i32Or();
      c.localGet(OFFSET);
      c.localGet(CAP);
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      {
        c.localGet(OFFSET);
        c.localGet(CAP);
        c.call(this.boundsErrorHelper());
        c.f64Const(0);
        c.return_();
      }
      c.end();
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(OFFSET);
      c.i32TruncF64S();
      c.i32Add();
      c.localSet(ADDR);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      c.localGet(VALUE);
      c.call(this.deps.toInt32());
      c.localSet(BITS);
      this.emitScatterI32(c, BUFL, ADDR, width, le, BITS);
      c.localGet(OFFSET);
      c.f64Const(width);
      c.f64Add();
      this.mb.setBody(idx, [I32, F64, I32, this.bufRefNN(), I32], c.bytes());
      return idx;
    });
  }

  /* ── encodings (u8 only — the compiler routes only u8 receivers here);
   * stage B. Every encoding name arrives as a compile-time strLit (the
   * lowering never passes a runtime-computed encoding — nodes.ts's
   * bufEncoding fence), so the EMITTER picks the concrete helper by
   * reading the literal at build time; there is no runtime encoding
   * dispatch anywhere in this section, unlike the C runtime's
   * scr_enc_is string-compare ladder. ──────────────────────────────── */

  private strRefN(): ValType {
    return this.deps.strRef();
  }

  private strBufRefNN(): ValType {
    return { kind: "ref", nullable: false, typeIndex: this.deps.strType() };
  }

  /** Pushes the hex digit CHARACTER for the i32 0-15 value in local D
   * (lowercase, matching Node's toString("hex")). */
  private emitHexDigit(c: Code, D: number): void {
    c.localGet(D);
    c.i32Const(10);
    c.i32LtU();
    c.ifResult(I32);
    c.localGet(D);
    c.i32Const(0x30);
    c.i32Add();
    c.else_();
    c.localGet(D);
    c.i32Const(0x61 - 10);
    c.i32Add();
    c.end();
  }

  /** Pushes the 4-bit value of the hex digit UNIT in local U, or -1 for
   * anything else (Node-lenient decode's per-char gate). */
  private emitHexVal(c: Code, U: number): void {
    c.localGet(U);
    c.i32Const(0x30);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x39);
    c.i32LeU();
    c.i32And();
    c.ifResult(I32);
    c.localGet(U);
    c.i32Const(0x30);
    c.i32Sub();
    c.else_();
    c.localGet(U);
    c.i32Const(0x61);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x66);
    c.i32LeU();
    c.i32And();
    c.ifResult(I32);
    c.localGet(U);
    c.i32Const(0x61 - 10);
    c.i32Sub();
    c.else_();
    c.localGet(U);
    c.i32Const(0x41);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x46);
    c.i32LeU();
    c.i32And();
    c.ifResult(I32);
    c.localGet(U);
    c.i32Const(0x41 - 10);
    c.i32Sub();
    c.else_();
    c.i32Const(-1);
    c.end();
    c.end();
    c.end();
  }

  /** Pushes the 6-bit value of the base64(url) alphabet CHAR in local U
   * (standard '+/' AND url '-_' both accepted, matching Node-lenient
   * decode under either spelling), or -1. */
  private emitB64Val(c: Code, U: number): void {
    c.localGet(U);
    c.i32Const(0x41);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x5a);
    c.i32LeU();
    c.i32And();
    c.ifResult(I32);
    c.localGet(U);
    c.i32Const(0x41);
    c.i32Sub();
    c.else_();
    c.localGet(U);
    c.i32Const(0x61);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x7a);
    c.i32LeU();
    c.i32And();
    c.ifResult(I32);
    c.localGet(U);
    c.i32Const(0x61 - 26);
    c.i32Sub();
    c.else_();
    c.localGet(U);
    c.i32Const(0x30);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x39);
    c.i32LeU();
    c.i32And();
    c.ifResult(I32);
    c.localGet(U);
    c.i32Const(0x30 - 52);
    c.i32Sub();
    c.else_();
    c.localGet(U);
    c.i32Const(0x2b); // '+'
    c.i32Eq();
    c.localGet(U);
    c.i32Const(0x2d); // '-'
    c.i32Eq();
    c.i32Or();
    c.ifResult(I32);
    c.i32Const(62);
    c.else_();
    c.localGet(U);
    c.i32Const(0x2f); // '/'
    c.i32Eq();
    c.localGet(U);
    c.i32Const(0x5f); // '_'
    c.i32Eq();
    c.i32Or();
    c.ifResult(I32);
    c.i32Const(63);
    c.else_();
    c.i32Const(-1);
    c.end();
    c.end();
    c.end();
    c.end();
    c.end();
  }

  /** Pushes a fresh bytesRef of exactly LEN bytes, copied from
   * SCRATCH[0..LEN) — the "allocate worst-case, decode into it, copy the
   * actual-length prefix" pattern every variable-output decode below
   * uses (the C reference's own scr_bytes_decode_utf8/scr_bytes_from_str
   * shape, ported: malloc worst-case, scr_str_new/return only `o`). TMP
   * is a bufRefNN scratch local. */
  private emitBytesFromScratch(c: Code, SCRATCH: number, LEN: number, TMP: number): void {
    c.localGet(LEN);
    c.arrayNewDefault(this.bufType());
    c.localSet(TMP);
    c.localGet(TMP);
    c.i32Const(0);
    c.localGet(SCRATCH);
    c.i32Const(0);
    c.localGet(LEN);
    c.arrayCopy(this.bufType(), this.bufType());
    c.localGet(TMP);
    c.i32Const(0);
    c.localGet(LEN);
    c.structNew(this.bytesType());
  }

  /** The string twin of emitBytesFromScratch — a fresh strRef of exactly
   * LEN units, copied from SCRATCH[0..LEN). TMP is a strBufRefNN scratch
   * local (a non-null ref to the string array type). */
  private emitStrFromScratch(c: Code, SCRATCH: number, LEN: number, TMP: number): void {
    c.localGet(LEN);
    c.arrayNewDefault(this.deps.strType());
    c.localSet(TMP);
    c.localGet(TMP);
    c.i32Const(0);
    c.localGet(SCRATCH);
    c.i32Const(0);
    c.localGet(LEN);
    c.arrayCopy(this.deps.strType(), this.deps.strType());
    c.localGet(TMP);
  }

  /** %w.bytes.toStr:<enc> — (bytes<u8>) → str; the `toString(enc)`
   * decode surface (Buffer.prototype.toString / util.TextDecoder share
   * this — utf8's WHATWG maximal-subpart replacement rule, the OTHER six
   * encodings' simpler element-wise walks). Never throws. */
  toStrHelper(enc: string): number {
    return this.cached(`toStr:${enc}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.bytesRef()], [this.strRefN()]), `%w.bytes.toStr:${enc}`);
      const c = new Code();
      if (enc === "hex") {
        const V = 0, LENI = 1, BUFL = 2, OUT = 3, I = 4, BYTE = 5, HI = 6, LO = 7;
        c.localGet(V);
        c.structGet(this.bytesType(), BLEN);
        c.localSet(LENI);
        c.localGet(V);
        c.structGet(this.bytesType(), STORAGE);
        c.localSet(BUFL);
        c.localGet(LENI);
        c.i32Const(2);
        c.i32Mul();
        c.arrayNewDefault(this.deps.strType());
        c.localSet(OUT);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(LENI);
        c.i32GeS();
        c.brIf(1);
        c.localGet(BUFL);
        c.localGet(V);
        c.structGet(this.bytesType(), OFF);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(this.bufType());
        c.localSet(BYTE);
        c.localGet(BYTE);
        c.i32Const(4);
        c.i32ShrU();
        c.localSet(HI);
        c.localGet(BYTE);
        c.i32Const(0xf);
        c.i32And();
        c.localSet(LO);
        c.localGet(OUT);
        c.localGet(I);
        c.i32Const(2);
        c.i32Mul();
        this.emitHexDigit(c, HI);
        c.arraySet(this.deps.strType());
        c.localGet(OUT);
        c.localGet(I);
        c.i32Const(2);
        c.i32Mul();
        c.i32Const(1);
        c.i32Add();
        this.emitHexDigit(c, LO);
        c.arraySet(this.deps.strType());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
        this.mb.setBody(idx, [I32, this.bufRefNN(), this.strBufRefNN(), I32, I32, I32, I32], c.bytes());
        return idx;
      }
      if (enc === "base64" || enc === "base64url") {
        const url = enc === "base64url";
        const V = 0, LENI = 1, BUFL = 2, ALPHA = 3, OUTLEN = 4, OUT = 5, I = 6, O = 7, VAL = 8, B0 = 9, B1 = 10, B2 = 11, REM = 12;
        c.localGet(V);
        c.structGet(this.bytesType(), BLEN);
        c.localSet(LENI);
        c.localGet(V);
        c.structGet(this.bytesType(), STORAGE);
        c.localSet(BUFL);
        this.deps.lit(
          c,
          url
            ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
            : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
        );
        c.localSet(ALPHA);
        if (url) {
          // full*4 + (rem==0?0:rem+1)
          c.localGet(LENI);
          c.i32Const(3);
          c.i32DivS();
          c.i32Const(4);
          c.i32Mul();
          c.localGet(LENI);
          c.i32Const(3);
          c.i32RemS();
          c.ifResult(I32);
          c.localGet(LENI);
          c.i32Const(3);
          c.i32RemS();
          c.i32Const(1);
          c.i32Add();
          c.else_();
          c.i32Const(0);
          c.end();
          c.i32Add();
        } else {
          c.localGet(LENI);
          c.i32Const(2);
          c.i32Add();
          c.i32Const(3);
          c.i32DivS();
          c.i32Const(4);
          c.i32Mul();
        }
        c.localSet(OUTLEN);
        c.localGet(OUTLEN);
        c.arrayNewDefault(this.deps.strType());
        c.localSet(OUT);
        c.i32Const(0);
        c.localSet(I);
        c.i32Const(0);
        c.localSet(O);
        c.block();
        c.loop();
        c.localGet(I);
        c.i32Const(3);
        c.i32Add();
        c.localGet(LENI);
        c.i32GtS();
        c.brIf(1);
        c.localGet(BUFL);
        c.localGet(V);
        c.structGet(this.bytesType(), OFF);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(this.bufType());
        c.localSet(B0);
        c.localGet(BUFL);
        c.localGet(V);
        c.structGet(this.bytesType(), OFF);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.i32Add();
        c.arrayGetU(this.bufType());
        c.localSet(B1);
        c.localGet(BUFL);
        c.localGet(V);
        c.structGet(this.bytesType(), OFF);
        c.localGet(I);
        c.i32Const(2);
        c.i32Add();
        c.i32Add();
        c.arrayGetU(this.bufType());
        c.localSet(B2);
        c.localGet(B0);
        c.i32Const(16);
        c.i32Shl();
        c.localGet(B1);
        c.i32Const(8);
        c.i32Shl();
        c.i32Or();
        c.localGet(B2);
        c.i32Or();
        c.localSet(VAL);
        for (let k = 0; k < 4; k++) {
          c.localGet(OUT);
          c.localGet(O);
          if (k > 0) {
            c.i32Const(k);
            c.i32Add();
          }
          c.localGet(ALPHA);
          c.localGet(VAL);
          c.i32Const((3 - k) * 6);
          c.i32ShrU();
          c.i32Const(63);
          c.i32And();
          c.arrayGetU(this.deps.strType());
          c.arraySet(this.deps.strType());
        }
        c.localGet(I);
        c.i32Const(3);
        c.i32Add();
        c.localSet(I);
        c.localGet(O);
        c.i32Const(4);
        c.i32Add();
        c.localSet(O);
        c.br(0);
        c.end();
        c.end();
        c.localGet(LENI);
        c.localGet(I);
        c.i32Sub();
        c.localSet(REM);
        c.localGet(REM);
        c.i32Const(1);
        c.i32Eq();
        c.ifVoid();
        {
          c.localGet(BUFL);
          c.localGet(V);
          c.structGet(this.bytesType(), OFF);
          c.localGet(I);
          c.i32Add();
          c.arrayGetU(this.bufType());
          c.i32Const(16);
          c.i32Shl();
          c.localSet(VAL);
          c.localGet(OUT);
          c.localGet(O);
          c.localGet(ALPHA);
          c.localGet(VAL);
          c.i32Const(18);
          c.i32ShrU();
          c.i32Const(63);
          c.i32And();
          c.arrayGetU(this.deps.strType());
          c.arraySet(this.deps.strType());
          c.localGet(OUT);
          c.localGet(O);
          c.i32Const(1);
          c.i32Add();
          c.localGet(ALPHA);
          c.localGet(VAL);
          c.i32Const(12);
          c.i32ShrU();
          c.i32Const(63);
          c.i32And();
          c.arrayGetU(this.deps.strType());
          c.arraySet(this.deps.strType());
          if (!url) {
            c.localGet(OUT);
            c.localGet(O);
            c.i32Const(2);
            c.i32Add();
            c.i32Const(0x3d);
            c.arraySet(this.deps.strType());
            c.localGet(OUT);
            c.localGet(O);
            c.i32Const(3);
            c.i32Add();
            c.i32Const(0x3d);
            c.arraySet(this.deps.strType());
          }
        }
        c.else_();
        c.localGet(REM);
        c.i32Const(2);
        c.i32Eq();
        c.ifVoid();
        {
          c.localGet(BUFL);
          c.localGet(V);
          c.structGet(this.bytesType(), OFF);
          c.localGet(I);
          c.i32Add();
          c.arrayGetU(this.bufType());
          c.i32Const(16);
          c.i32Shl();
          c.localGet(BUFL);
          c.localGet(V);
          c.structGet(this.bytesType(), OFF);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.i32Add();
          c.arrayGetU(this.bufType());
          c.i32Const(8);
          c.i32Shl();
          c.i32Or();
          c.localSet(VAL);
          for (let k = 0; k < 3; k++) {
            c.localGet(OUT);
            c.localGet(O);
            if (k > 0) {
              c.i32Const(k);
              c.i32Add();
            }
            c.localGet(ALPHA);
            c.localGet(VAL);
            c.i32Const((3 - k) * 6);
            c.i32ShrU();
            c.i32Const(63);
            c.i32And();
            c.arrayGetU(this.deps.strType());
            c.arraySet(this.deps.strType());
          }
          if (!url) {
            c.localGet(OUT);
            c.localGet(O);
            c.i32Const(3);
            c.i32Add();
            c.i32Const(0x3d);
            c.arraySet(this.deps.strType());
          }
        }
        c.end();
        c.end();
        c.localGet(OUT);
        this.mb.setBody(
          idx,
          [I32, this.bufRefNN(), this.strRefN(), I32, this.strBufRefNN(), I32, I32, I32, I32, I32, I32, I32],
          c.bytes(),
        );
        return idx;
      }
      if (enc === "latin1" || enc === "ascii") {
        const V = 0, LENI = 1, BUFL = 2, OUT = 3, I = 4, BYTE = 5;
        c.localGet(V);
        c.structGet(this.bytesType(), BLEN);
        c.localSet(LENI);
        c.localGet(V);
        c.structGet(this.bytesType(), STORAGE);
        c.localSet(BUFL);
        c.localGet(LENI);
        c.arrayNewDefault(this.deps.strType());
        c.localSet(OUT);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(LENI);
        c.i32GeS();
        c.brIf(1);
        c.localGet(BUFL);
        c.localGet(V);
        c.structGet(this.bytesType(), OFF);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(this.bufType());
        c.localSet(BYTE);
        c.localGet(OUT);
        c.localGet(I);
        c.localGet(BYTE);
        if (enc === "ascii") {
          c.i32Const(0x7f);
          c.i32And();
        }
        c.arraySet(this.deps.strType());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
        this.mb.setBody(idx, [I32, this.bufRefNN(), this.strBufRefNN(), I32, I32], c.bytes());
        return idx;
      }
      if (enc === "utf16le") {
        const V = 0, LENI = 1, BUFL = 2, OUTLEN = 3, OUT = 4, U = 5;
        c.localGet(V);
        c.structGet(this.bytesType(), BLEN);
        c.localSet(LENI);
        c.localGet(V);
        c.structGet(this.bytesType(), STORAGE);
        c.localSet(BUFL);
        c.localGet(LENI);
        c.i32Const(2);
        c.i32DivS();
        c.localSet(OUTLEN);
        c.localGet(OUTLEN);
        c.arrayNewDefault(this.deps.strType());
        c.localSet(OUT);
        c.i32Const(0);
        c.localSet(U);
        c.block();
        c.loop();
        c.localGet(U);
        c.localGet(OUTLEN);
        c.i32GeS();
        c.brIf(1);
        c.localGet(OUT);
        c.localGet(U);
        c.localGet(BUFL);
        c.localGet(V);
        c.structGet(this.bytesType(), OFF);
        c.localGet(U);
        c.i32Const(2);
        c.i32Mul();
        c.i32Add();
        c.arrayGetU(this.bufType());
        c.localGet(BUFL);
        c.localGet(V);
        c.structGet(this.bytesType(), OFF);
        c.localGet(U);
        c.i32Const(2);
        c.i32Mul();
        c.i32Const(1);
        c.i32Add();
        c.i32Add();
        c.arrayGetU(this.bufType());
        c.i32Const(8);
        c.i32Shl();
        c.i32Or();
        c.arraySet(this.deps.strType());
        c.localGet(U);
        c.i32Const(1);
        c.i32Add();
        c.localSet(U);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
        this.mb.setBody(idx, [I32, this.bufRefNN(), I32, this.strBufRefNN(), I32], c.bytes());
        return idx;
      }
      // utf8: WHATWG maximal-subpart replacement decode, ported from
      // scr_bytes_decode_utf8 with the output step changed from
      // re-encoded UTF-8 (the C runtime's own storage) to UTF-16 code
      // units (this tier's storage, S002) — a surrogate pair for
      // cp > 0xFFFF rather than a 4-byte re-encoding. Allocates the
      // worst case (one output unit per input byte — the ratio when
      // every byte is independently invalid) and shrinks via
      // emitStrFromScratch, exactly the C reference's own "malloc
      // worst-case, return only what was used" shape.
      const V = 0,
        LENI = 1,
        BUFL = 2,
        SCRATCH = 3,
        I = 4,
        O = 5,
        CP = 6,
        NEEDED = 7,
        LOWER = 8,
        UPPER = 9,
        BYTE = 10,
        TMP = 11;
      const storeUnit = (push: () => void): void => {
        c.localGet(SCRATCH);
        c.localGet(O);
        push();
        c.arraySet(this.deps.strType());
        c.localGet(O);
        c.i32Const(1);
        c.i32Add();
        c.localSet(O);
      };
      c.localGet(V);
      c.structGet(this.bytesType(), BLEN);
      c.localSet(LENI);
      c.localGet(V);
      c.structGet(this.bytesType(), STORAGE);
      c.localSet(BUFL);
      c.localGet(LENI);
      c.arrayNewDefault(this.deps.strType());
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(I);
      c.i32Const(0);
      c.localSet(O);
      c.i32Const(0);
      c.localSet(NEEDED);
      c.i32Const(0x80);
      c.localSet(LOWER);
      c.i32Const(0xbf);
      c.localSet(UPPER);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LENI);
      c.i32GeU();
      c.brIf(1);
      c.localGet(BUFL);
      c.localGet(V);
      c.structGet(this.bytesType(), OFF);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(this.bufType());
      c.localSet(BYTE);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.localGet(NEEDED);
      c.i32Eqz();
      c.ifVoid();
      {
        c.localGet(BYTE);
        c.i32Const(0x7f);
        c.i32LeU();
        c.ifVoid();
        storeUnit(() => c.localGet(BYTE));
        c.else_();
        c.localGet(BYTE);
        c.i32Const(0xc2);
        c.i32GeU();
        c.localGet(BYTE);
        c.i32Const(0xdf);
        c.i32LeU();
        c.i32And();
        c.ifVoid();
        {
          c.i32Const(1);
          c.localSet(NEEDED);
          c.localGet(BYTE);
          c.i32Const(0x1f);
          c.i32And();
          c.localSet(CP);
        }
        c.else_();
        c.localGet(BYTE);
        c.i32Const(0xe0);
        c.i32GeU();
        c.localGet(BYTE);
        c.i32Const(0xef);
        c.i32LeU();
        c.i32And();
        c.ifVoid();
        {
          c.localGet(BYTE);
          c.i32Const(0xe0);
          c.i32Eq();
          c.ifVoid();
          c.i32Const(0xa0);
          c.localSet(LOWER);
          c.end();
          c.localGet(BYTE);
          c.i32Const(0xed);
          c.i32Eq();
          c.ifVoid();
          c.i32Const(0x9f);
          c.localSet(UPPER);
          c.end();
          c.i32Const(2);
          c.localSet(NEEDED);
          c.localGet(BYTE);
          c.i32Const(0xf);
          c.i32And();
          c.localSet(CP);
        }
        c.else_();
        c.localGet(BYTE);
        c.i32Const(0xf0);
        c.i32GeU();
        c.localGet(BYTE);
        c.i32Const(0xf4);
        c.i32LeU();
        c.i32And();
        c.ifVoid();
        {
          c.localGet(BYTE);
          c.i32Const(0xf0);
          c.i32Eq();
          c.ifVoid();
          c.i32Const(0x90);
          c.localSet(LOWER);
          c.end();
          c.localGet(BYTE);
          c.i32Const(0xf4);
          c.i32Eq();
          c.ifVoid();
          c.i32Const(0x8f);
          c.localSet(UPPER);
          c.end();
          c.i32Const(3);
          c.localSet(NEEDED);
          c.localGet(BYTE);
          c.i32Const(0x7);
          c.i32And();
          c.localSet(CP);
        }
        c.else_();
        storeUnit(() => c.i32Const(0xfffd));
        c.end();
        c.end();
        c.end();
        c.end();
      }
      c.else_();
      {
        c.localGet(BYTE);
        c.localGet(LOWER);
        c.i32LtU();
        c.localGet(BYTE);
        c.localGet(UPPER);
        c.i32GtU();
        c.i32Or();
        c.ifVoid();
        {
          storeUnit(() => c.i32Const(0xfffd));
          c.i32Const(0);
          c.localSet(NEEDED);
          c.i32Const(0x80);
          c.localSet(LOWER);
          c.i32Const(0xbf);
          c.localSet(UPPER);
          c.localGet(I);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(I);
        }
        c.else_();
        {
          c.i32Const(0x80);
          c.localSet(LOWER);
          c.i32Const(0xbf);
          c.localSet(UPPER);
          c.localGet(CP);
          c.i32Const(6);
          c.i32Shl();
          c.localGet(BYTE);
          c.i32Const(0x3f);
          c.i32And();
          c.i32Or();
          c.localSet(CP);
          c.localGet(NEEDED);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(NEEDED);
          c.localGet(NEEDED);
          c.i32Eqz();
          c.ifVoid();
          {
            c.localGet(CP);
            c.i32Const(0xffff);
            c.i32LeU();
            c.ifVoid();
            storeUnit(() => c.localGet(CP));
            c.else_();
            {
              c.localGet(CP);
              c.i32Const(0x10000);
              c.i32Sub();
              c.localSet(CP);
              storeUnit(() => {
                c.i32Const(0xd800);
                c.localGet(CP);
                c.i32Const(10);
                c.i32ShrU();
                c.i32Add();
              });
              storeUnit(() => {
                c.i32Const(0xdc00);
                c.localGet(CP);
                c.i32Const(0x3ff);
                c.i32And();
                c.i32Add();
              });
            }
            c.end();
          }
          c.end();
        }
        c.end();
      }
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(NEEDED);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      storeUnit(() => c.i32Const(0xfffd));
      c.end();
      this.emitStrFromScratch(c, SCRATCH, O, TMP);
      this.mb.setBody(
        idx,
        [I32, this.bufRefNN(), this.strBufRefNN(), I32, I32, I32, I32, I32, I32, I32, this.strBufRefNN()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** %w.bytes.fromStr:<enc> — (str) → bytes<u8>; the `Buffer.from(string,
   * enc)` / fillStr / writeStr shared ENCODE surface. Never throws (every
   * encoding here is Node-lenient or total). */
  fromStrHelper(enc: string): number {
    return this.cached(`fromStr:${enc}`, () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRefN()], [this.bytesRef()]), `%w.bytes.fromStr:${enc}`);
      const c = new Code();
      if (enc === "latin1" || enc === "ascii") {
        // Node writes charCodeAt(i) & 0xFF for BOTH spellings (measured
        // against Node directly — an astral char's two surrogate units
        // each contribute their own low byte; ascii-ENCODE does NOT mask
        // to 7 bits the way ascii-DECODE does). Fixed output length = N.
        const S = 0, N = 1, OUT = 2, I = 3;
        c.localGet(S);
        c.arrayLen();
        c.localSet(N);
        c.localGet(N);
        c.arrayNewDefault(this.bufType());
        c.localSet(OUT);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(OUT);
        c.localGet(I);
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.deps.strType());
        c.arraySet(this.bufType());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
        c.i32Const(0);
        c.localGet(N);
        c.structNew(this.bytesType());
        this.mb.setBody(idx, [I32, this.bufRefNN(), I32], c.bytes());
        return idx;
      }
      if (enc === "utf16le") {
        const S = 0, N = 1, OUT = 2, I = 3, U = 4;
        c.localGet(S);
        c.arrayLen();
        c.localSet(N);
        c.localGet(N);
        c.i32Const(2);
        c.i32Mul();
        c.arrayNewDefault(this.bufType());
        c.localSet(OUT);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.deps.strType());
        c.localSet(U);
        c.localGet(OUT);
        c.localGet(I);
        c.i32Const(2);
        c.i32Mul();
        c.localGet(U);
        c.i32Const(0xff);
        c.i32And();
        c.arraySet(this.bufType());
        c.localGet(OUT);
        c.localGet(I);
        c.i32Const(2);
        c.i32Mul();
        c.i32Const(1);
        c.i32Add();
        c.localGet(U);
        c.i32Const(8);
        c.i32ShrU();
        c.arraySet(this.bufType());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
        c.i32Const(0);
        c.localGet(N);
        c.i32Const(2);
        c.i32Mul();
        c.structNew(this.bytesType());
        this.mb.setBody(idx, [I32, this.bufRefNN(), I32, I32], c.bytes());
        return idx;
      }
      if (enc === "hex") {
        // Node-lenient: stop at the first invalid pair or the odd tail.
        const S = 0, N = 1, WORST = 2, SCRATCH = 3, I = 4, O = 5, U0 = 6, U1 = 7, HI = 8, LO = 9, TMP = 10;
        c.localGet(S);
        c.arrayLen();
        c.localSet(N);
        c.localGet(N);
        c.i32Const(2);
        c.i32DivS();
        c.localSet(WORST);
        c.localGet(WORST);
        c.arrayNewDefault(this.bufType());
        c.localSet(SCRATCH);
        c.i32Const(0);
        c.localSet(I);
        c.i32Const(0);
        c.localSet(O);
        c.block();
        c.loop();
        c.localGet(I);
        c.i32Const(2);
        c.i32Add();
        c.localGet(N);
        c.i32GtS();
        c.brIf(1);
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.deps.strType());
        c.localSet(U0);
        c.localGet(S);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.arrayGetU(this.deps.strType());
        c.localSet(U1);
        this.emitHexVal(c, U0);
        c.localSet(HI);
        this.emitHexVal(c, U1);
        c.localSet(LO);
        c.localGet(HI);
        c.i32Const(0);
        c.i32LtS();
        c.localGet(LO);
        c.i32Const(0);
        c.i32LtS();
        c.i32Or();
        c.brIf(1);
        c.localGet(SCRATCH);
        c.localGet(O);
        c.localGet(HI);
        c.i32Const(4);
        c.i32Shl();
        c.localGet(LO);
        c.i32Or();
        c.arraySet(this.bufType());
        c.localGet(O);
        c.i32Const(1);
        c.i32Add();
        c.localSet(O);
        c.localGet(I);
        c.i32Const(2);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        this.emitBytesFromScratch(c, SCRATCH, O, TMP);
        this.mb.setBody(idx, [I32, I32, this.bufRefNN(), I32, I32, I32, I32, I32, I32, this.bufRefNN()], c.bytes());
        return idx;
      }
      if (enc === "base64" || enc === "base64url") {
        // Node-lenient: skip bytes outside the (standard + url-safe)
        // alphabets; decode 4-char groups, a 2/3-char tail into 1/2 bytes.
        const S = 0, N = 1, WORST = 2, SCRATCH = 3, I = 4, O = 5, ACC = 6, HAVE = 7, U = 8, V = 9, TMP = 10;
        c.localGet(S);
        c.arrayLen();
        c.localSet(N);
        c.localGet(N);
        c.i32Const(4);
        c.i32DivS();
        c.i32Const(3);
        c.i32Mul();
        c.i32Const(2);
        c.i32Add();
        c.localSet(WORST);
        c.localGet(WORST);
        c.arrayNewDefault(this.bufType());
        c.localSet(SCRATCH);
        c.i32Const(0);
        c.localSet(O);
        c.i32Const(0);
        c.localSet(ACC);
        c.i32Const(0);
        c.localSet(HAVE);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.deps.strType());
        c.localSet(U);
        this.emitB64Val(c, U);
        c.localSet(V);
        c.localGet(V);
        c.i32Const(0);
        c.i32GeS();
        c.ifVoid();
        {
          c.localGet(ACC);
          c.i32Const(6);
          c.i32Shl();
          c.localGet(V);
          c.i32Or();
          c.localSet(ACC);
          c.localGet(HAVE);
          c.i32Const(1);
          c.i32Add();
          c.localSet(HAVE);
          c.localGet(HAVE);
          c.i32Const(4);
          c.i32Eq();
          c.ifVoid();
          {
            for (let k = 0; k < 3; k++) {
              c.localGet(SCRATCH);
              c.localGet(O);
              if (k > 0) {
                c.i32Const(k);
                c.i32Add();
              }
              c.localGet(ACC);
              c.i32Const((2 - k) * 8);
              c.i32ShrU();
              c.arraySet(this.bufType());
            }
            c.localGet(O);
            c.i32Const(3);
            c.i32Add();
            c.localSet(O);
            c.i32Const(0);
            c.localSet(ACC);
            c.i32Const(0);
            c.localSet(HAVE);
          }
          c.end();
        }
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(HAVE);
        c.i32Const(2);
        c.i32Eq();
        c.ifVoid();
        {
          c.localGet(SCRATCH);
          c.localGet(O);
          c.localGet(ACC);
          c.i32Const(4);
          c.i32ShrU();
          c.arraySet(this.bufType());
          c.localGet(O);
          c.i32Const(1);
          c.i32Add();
          c.localSet(O);
        }
        c.else_();
        c.localGet(HAVE);
        c.i32Const(3);
        c.i32Eq();
        c.ifVoid();
        {
          c.localGet(SCRATCH);
          c.localGet(O);
          c.localGet(ACC);
          c.i32Const(10);
          c.i32ShrU();
          c.arraySet(this.bufType());
          c.localGet(SCRATCH);
          c.localGet(O);
          c.i32Const(1);
          c.i32Add();
          c.localGet(ACC);
          c.i32Const(2);
          c.i32ShrU();
          c.arraySet(this.bufType());
          c.localGet(O);
          c.i32Const(2);
          c.i32Add();
          c.localSet(O);
        }
        c.end();
        c.end();
        this.emitBytesFromScratch(c, SCRATCH, O, TMP);
        this.mb.setBody(
          idx,
          [I32, I32, this.bufRefNN(), I32, I32, I32, I32, I32, I32, this.bufRefNN()],
          c.bytes(),
        );
        return idx;
      }
      // utf8: the write-boundary transcode ported from %w.stage
      // (emitter.ts) to target a GC bytes array instead of linear
      // memory — the SAME algorithm (surrogate pairs → one 4-byte
      // sequence, lone surrogates → U+FFFD), which %w.stage already
      // carries every console.log call through, so this is a
      // retargeting, not a new derivation. Worst case 3 bytes/unit
      // (%w.stage's own reserved capacity), shrunk to the actual count.
      const S = 0, N = 1, SCRATCH = 2, I = 3, O = 4, U = 5, NEXT = 6, PAIRED = 7, TMP = 8;
      const storeByte = (off: number, push: () => void): void => {
        c.localGet(SCRATCH);
        c.localGet(O);
        if (off > 0) {
          c.i32Const(off);
          c.i32Add();
        }
        push();
        c.arraySet(this.bufType());
      };
      const advance = (n: number): void => {
        c.localGet(O);
        c.i32Const(n);
        c.i32Add();
        c.localSet(O);
      };
      c.localGet(S);
      c.arrayLen();
      c.localSet(N);
      c.localGet(N);
      c.i32Const(3);
      c.i32Mul();
      c.arrayNewDefault(this.bufType());
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(I);
      c.i32Const(0);
      c.localSet(O);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.localSet(U);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.localGet(U);
      c.i32Const(0x80);
      c.i32LtU();
      c.ifVoid();
      {
        storeByte(0, () => c.localGet(U));
        advance(1);
      }
      c.else_();
      {
        c.localGet(U);
        c.i32Const(0x800);
        c.i32LtU();
        c.ifVoid();
        {
          storeByte(0, () => {
            c.i32Const(0xc0);
            c.localGet(U);
            c.i32Const(6);
            c.i32ShrU();
            c.i32Or();
          });
          storeByte(1, () => {
            c.i32Const(0x80);
            c.localGet(U);
            c.i32Const(0x3f);
            c.i32And();
            c.i32Or();
          });
          advance(2);
        }
        c.else_();
        {
          c.localGet(U);
          c.i32Const(0xf800);
          c.i32And();
          c.i32Const(0xd800);
          c.i32Eq();
          c.ifVoid();
          {
            c.i32Const(0);
            c.localSet(PAIRED);
            c.localGet(U);
            c.i32Const(0xdc00);
            c.i32LtU();
            c.ifVoid();
            c.localGet(I);
            c.localGet(N);
            c.i32LtU();
            c.ifVoid();
            c.localGet(S);
            c.localGet(I);
            c.arrayGetU(this.deps.strType());
            c.localSet(NEXT);
            c.localGet(NEXT);
            c.i32Const(0xfc00);
            c.i32And();
            c.i32Const(0xdc00);
            c.i32Eq();
            c.ifVoid();
            c.i32Const(1);
            c.localSet(PAIRED);
            c.end();
            c.end();
            c.end();
            c.localGet(PAIRED);
            c.ifVoid();
            {
              c.localGet(U);
              c.i32Const(0xd800);
              c.i32Sub();
              c.i32Const(10);
              c.i32Shl();
              c.localGet(NEXT);
              c.i32Const(0xdc00);
              c.i32Sub();
              c.i32Add();
              c.i32Const(0x10000);
              c.i32Add();
              c.localSet(U);
              storeByte(0, () => {
                c.i32Const(0xf0);
                c.localGet(U);
                c.i32Const(18);
                c.i32ShrU();
                c.i32Or();
              });
              storeByte(1, () => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(12);
                c.i32ShrU();
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
              storeByte(2, () => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(6);
                c.i32ShrU();
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
              storeByte(3, () => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
              advance(4);
              c.localGet(I);
              c.i32Const(1);
              c.i32Add();
              c.localSet(I);
            }
            c.else_();
            {
              storeByte(0, () => c.i32Const(0xef));
              storeByte(1, () => c.i32Const(0xbf));
              storeByte(2, () => c.i32Const(0xbd));
              advance(3);
            }
            c.end();
          }
          c.else_();
          {
            storeByte(0, () => {
              c.i32Const(0xe0);
              c.localGet(U);
              c.i32Const(12);
              c.i32ShrU();
              c.i32Or();
            });
            storeByte(1, () => {
              c.i32Const(0x80);
              c.localGet(U);
              c.i32Const(6);
              c.i32ShrU();
              c.i32Const(0x3f);
              c.i32And();
              c.i32Or();
            });
            storeByte(2, () => {
              c.i32Const(0x80);
              c.localGet(U);
              c.i32Const(0x3f);
              c.i32And();
              c.i32Or();
            });
            advance(3);
          }
          c.end();
        }
        c.end();
      }
      c.end();
      c.br(0);
      c.end();
      c.end();
      this.emitBytesFromScratch(c, SCRATCH, O, TMP);
      this.mb.setBody(idx, [I32, this.bufRefNN(), I32, I32, I32, I32, I32, this.bufRefNN()], c.bytes());
      return idx;
    });
  }
}
