/* The UTF-16-exact string method surface (strIntrinsic) over the wasm
 * tier's faithful (array (mut i16)) storage — scr_string.c's semantics
 * with the UTF-8 index translation deleted: code-unit indexing IS the
 * storage here, so the ports keep the ECMA clamps and edge cases and drop
 * the byte walking entirely.
 *
 * Where upstream's well-formed UTF-8 storage forced its divergence 2
 * (U+FFFD standing in for the lone surrogate halves charAt/split("")/pad
 * truncation can produce), this backend is JS-EXACT: S002 removed that
 * divergence class, lone surrogates live in storage with identity, and
 * only the write boundary substitutes. The same faithfulness makes
 * isWellFormed/toWellFormed REAL scans here where the C runtime answers
 * the constant its storage invariant guarantees.
 *
 * Helpers BORROW everything (the GC owns storage); string results are
 * fresh arrays except the documented identity returns (pad at or below
 * the target, toWellFormed of well-formed input — string identity is
 * unobservable for JS primitives). RangeError sites (repeat's negative or
 * infinite count, repeat/pad results at or past 2^31 units) TRAP — the
 * S003 bridge, exit 1 like Node's uncaught RangeError; Node's own
 * threshold is lower (~2^29 units) but everything between traps on
 * allocation anyway. toLowerCase/toUpperCase are NOT here: ECMA Default
 * Case Conversion wants libunicode's tables (the lre-backed pair), and
 * the emitter refuses them by member. */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";
import type { VecInfo } from "./arrays.js";

export interface StrDeps {
  /** The string[] vector machinery for split: the interned vec(str) info
   * plus %w.vec.push1's index (growth included). */
  vecStr: () => { info: VecInfo; push1: number };
}

export class StrBuilder {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly strType: number,
    private readonly deps: StrDeps,
  ) {}

  private strRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strType };
  }

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** ECMA ToIntegerOrInfinity on the f64 in local X, in place: NaN → +0,
   * otherwise truncate toward zero, ±Infinity preserved. */
  private emitToIntInf(c: Code, X: number): void {
    c.localGet(X);
    c.localGet(X);
    c.f64Ne(); // NaN is the only x != x
    c.ifVoid();
    c.f64Const(0);
    c.localSet(X);
    c.end();
    c.localGet(X);
    c.f64Trunc();
    c.localSet(X);
  }

  /** A fresh copy of s[F, F+CNT) — (ref $str) onto the stack. S/F/CNT are
   * locals (CNT computed by the caller); R is a (ref null $str) scratch. */
  private emitCopySpan(c: Code, S: number, F: number, CNT: number, R: number): void {
    c.localGet(CNT);
    c.arrayNewDefault(this.strType);
    c.localSet(R);
    c.localGet(R);
    c.i32Const(0);
    c.localGet(S);
    c.localGet(F);
    c.localGet(CNT);
    c.arrayCopy(this.strType, this.strType);
    c.localGet(R);
  }

  /** %w.str.isWs — (i32 unit) → i32: exact ECMA-262 WhiteSpace ∪
   * LineTerminator membership. The whole set is BMP, so unit-wise
   * membership IS code-point membership (surrogate halves are not in it). */
  private isWs(): number {
    return this.cached("isWs", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32], [I32]), "%w.str.isWs");
      const c = new Code();
      const U = 0;
      const singles = [0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
      c.localGet(U);
      c.i32Const(singles[0]!);
      c.i32Eq();
      for (const k of singles.slice(1)) {
        c.localGet(U);
        c.i32Const(k);
        c.i32Eq();
        c.i32Or();
      }
      c.localGet(U);
      c.i32Const(0x2000);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0x200a);
      c.i32LeS();
      c.i32And();
      c.i32Or();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.matchAt — (s, needle, i32 at) → i32: does needle occur at
   * unit index `at`? Bounds-checked (overflow-safe: compares against
   * len - at, never at + nlen). startsWith IS this helper with at 0. */
  matchAt(): number {
    return this.cached("matchAt", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), this.strRef(), I32], [I32]),
        "%w.str.matchAt",
      );
      const c = new Code();
      const S = 0, N = 1, AT = 2, L = 3, NL = 4, J = 5;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.localGet(N);
      c.arrayLen();
      c.localSet(NL);
      c.localGet(AT);
      c.localGet(L);
      c.i32GtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(NL);
      c.localGet(L);
      c.localGet(AT);
      c.i32Sub();
      c.i32GtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.i32Const(0);
      c.localSet(J);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(NL);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(AT);
      c.localGet(J);
      c.i32Add();
      c.arrayGetU(this.strType);
      c.localGet(N);
      c.localGet(J);
      c.arrayGetU(this.strType);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.charCodeAt — (s, f64) → f64: the unit as a number, NaN out of
   * [0, len). Faithful storage: a surrogate half answers its own code. */
  charCodeAt(): number {
    return this.cached("charCodeAt", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), F64], [F64]),
        "%w.str.charCodeAt",
      );
      const c = new Code();
      const S = 0, X = 1, L = 2;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      this.emitToIntInf(c, X);
      c.localGet(X);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.f64Const(Number.NaN);
      c.return_();
      c.end();
      c.localGet(X);
      c.localGet(L);
      c.f64ConvertI32S();
      c.f64Ge();
      c.ifVoid();
      c.f64Const(Number.NaN);
      c.return_();
      c.end();
      c.localGet(S);
      c.localGet(X);
      c.i32TruncF64S();
      c.arrayGetU(this.strType);
      c.f64ConvertI32U();
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.charAt — (s, f64) → str: the single unit as a 1-length
   * string, "" out of range. JS-exact on astral middles: the lone
   * surrogate half comes back AS ITSELF (upstream's U+FFFD divergence
   * does not exist on this storage). */
  charAt(): number {
    return this.cached("charAt", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), F64], [this.strRef()]),
        "%w.str.charAt",
      );
      const c = new Code();
      const S = 0, X = 1, L = 2;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      this.emitToIntInf(c, X);
      c.localGet(X);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(this.strType);
      c.return_();
      c.end();
      c.localGet(X);
      c.localGet(L);
      c.f64ConvertI32S();
      c.f64Ge();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(this.strType);
      c.return_();
      c.end();
      c.localGet(S);
      c.localGet(X);
      c.i32TruncF64S();
      c.arrayGetU(this.strType);
      c.arrayNewFixed(this.strType, 1);
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.cpAt — (s, f64) → str: the string iterator's step, the full
   * code POINT at a unit index (a paired high surrogate brings its low
   * half along; an unpaired half comes back alone, JS's iterator contract
   * on ill-formed strings). "" out of range. */
  cpAt(): number {
    return this.cached("cpAt", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), F64], [this.strRef()]),
        "%w.str.cpAt",
      );
      const c = new Code();
      const S = 0, X = 1, L = 2, I = 3, U = 4, U2 = 5;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      this.emitToIntInf(c, X);
      c.localGet(X);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(this.strType);
      c.return_();
      c.end();
      c.localGet(X);
      c.localGet(L);
      c.f64ConvertI32S();
      c.f64Ge();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(this.strType);
      c.return_();
      c.end();
      c.localGet(X);
      c.i32TruncF64S();
      c.localSet(I);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType);
      c.localSet(U);
      // A high surrogate with a following low half → the two-unit char.
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0xdbff);
      c.i32LeS();
      c.i32And();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(L);
      c.i32LtS();
      c.i32And();
      c.ifVoid();
      c.localGet(S);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.strType);
      c.localSet(U2);
      c.localGet(U2);
      c.i32Const(0xdc00);
      c.i32GeS();
      c.localGet(U2);
      c.i32Const(0xdfff);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      c.localGet(U);
      c.localGet(U2);
      c.arrayNewFixed(this.strType, 2);
      c.return_();
      c.end();
      c.end();
      c.localGet(U);
      c.arrayNewFixed(this.strType, 1);
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.indexOf — (s, needle, f64 from) → f64: StringIndexOf with the
   * spec's fromIndex clamp to [0, len]; the empty needle is found at the
   * clamped position itself. includes (both arg forms) is this ≠ -1 at
   * the call site, the spec's own routing. */
  indexOf(): number {
    return this.cached("indexOf", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), this.strRef(), F64], [F64]),
        "%w.str.indexOf",
      );
      const c = new Code();
      const S = 0, N = 1, X = 2, L = 3, NL = 4, I = 5;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.localGet(N);
      c.arrayLen();
      c.localSet(NL);
      this.emitToIntInf(c, X);
      // I = clamp(X, 0, L)
      c.localGet(X);
      c.f64Const(0);
      c.f64Le();
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
      c.localSet(I);
      c.localGet(NL);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(I);
      c.f64ConvertI32S();
      c.return_();
      c.end();
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.localGet(NL);
      c.i32Sub();
      c.i32GtS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(N);
      c.localGet(I);
      c.call(this.matchAt());
      c.ifVoid();
      c.localGet(I);
      c.f64ConvertI32S();
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.f64Const(-1);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.endsWith — (s, needle) → i32: the suffix match (matchAt at
   * len - nlen; a longer needle never matches). */
  endsWith(): number {
    return this.cached("endsWith", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), this.strRef()], [I32]),
        "%w.str.endsWith",
      );
      const c = new Code();
      const S = 0, N = 1, L = 2, NL = 3;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.localGet(N);
      c.arrayLen();
      c.localSet(NL);
      c.localGet(NL);
      c.localGet(L);
      c.i32GtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(S);
      c.localGet(N);
      c.localGet(L);
      c.localGet(NL);
      c.i32Sub();
      c.call(this.matchAt());
      this.mb.setBody(idx, [I32, I32], c.bytes());
      return idx;
    });
  }

  /** One slice() boundary out of the f64 in local X (already through
   * ToIntegerOrInfinity): negatives are relative to the end, then clamp
   * to [0, len]. Leaves the i32 on the stack; clobbers X. */
  private emitSliceBoundary(c: Code, X: number, L: number): void {
    c.localGet(X);
    c.f64Const(0);
    c.f64Lt();
    c.ifResult(I32);
    c.localGet(X);
    c.localGet(L);
    c.f64ConvertI32S();
    c.f64Add();
    c.localSet(X); // t = x + len (-Infinity stays itself)
    c.localGet(X);
    c.f64Const(0);
    c.f64Le();
    c.ifResult(I32);
    c.i32Const(0);
    c.else_();
    c.localGet(X);
    c.i32TruncF64S();
    c.end();
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

  /** %w.str.slice — (s, f64 start, f64 end) → str: relative boundaries
   * (negatives from the end), empty when they cross. Defaults (start 0,
   * end +Infinity) are the CALLER's fill, the IR convention. */
  slice(): number {
    return this.cached("slice", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), F64, F64], [this.strRef()]),
        "%w.str.slice",
      );
      const c = new Code();
      const S = 0, A = 1, B = 2, L = 3, F = 4, T = 5, R = 6;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      this.emitToIntInf(c, A);
      this.emitToIntInf(c, B);
      this.emitSliceBoundary(c, A, L);
      c.localSet(F);
      this.emitSliceBoundary(c, B, L);
      c.localSet(T);
      c.localGet(F);
      c.localGet(T);
      c.i32GeS();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(this.strType);
      c.return_();
      c.end();
      c.localGet(T);
      c.localGet(F);
      c.i32Sub();
      c.localSet(T); // count
      this.emitCopySpan(c, S, F, T, R);
      this.mb.setBody(idx, [I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }

  /** One substring() boundary: ToIntegerOrInfinity'd X clamped ABSOLUTE
   * to [0, len] (no relative negatives — substring's contract). */
  private emitAbsBoundary(c: Code, X: number, L: number): void {
    c.localGet(X);
    c.f64Const(0);
    c.f64Le();
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

  /** %w.str.substring — (s, f64, f64) → str: slice's clamp-and-swap
   * sibling — both boundaries clamp to [0, len], then swap when crossed
   * (scr_str_substring's delegation, with the copy inlined). */
  substring(): number {
    return this.cached("substring", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), F64, F64], [this.strRef()]),
        "%w.str.substring",
      );
      const c = new Code();
      const S = 0, A = 1, B = 2, L = 3, F = 4, T = 5, TMP = 6, R = 7;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      this.emitToIntInf(c, A);
      this.emitToIntInf(c, B);
      this.emitAbsBoundary(c, A, L);
      c.localSet(F);
      this.emitAbsBoundary(c, B, L);
      c.localSet(T);
      c.localGet(F);
      c.localGet(T);
      c.i32GtS();
      c.ifVoid();
      c.localGet(F);
      c.localSet(TMP);
      c.localGet(T);
      c.localSet(F);
      c.localGet(TMP);
      c.localSet(T);
      c.end();
      c.localGet(T);
      c.localGet(F);
      c.i32Sub();
      c.localSet(T); // count (≥ 0 after the swap)
      this.emitCopySpan(c, S, F, T, R);
      this.mb.setBody(idx, [I32, I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }

  /** %w.str.repeat — (s, f64 count) → str. Negative or +Infinity counts
   * are the spec's RangeError → trap (S003 bridge); results at or past
   * 2^31 units trap too (Node's own RangeError fires around 2^29). */
  repeat(): number {
    return this.cached("repeat", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), F64], [this.strRef()]),
        "%w.str.repeat",
      );
      const c = new Code();
      const S = 0, X = 1, L = 2, N = 3, TOT = 4, K = 5, R = 6;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      this.emitToIntInf(c, X);
      c.localGet(X);
      c.f64Const(0);
      c.f64Lt();
      c.ifVoid();
      c.unreachable(); // RangeError: Invalid count value
      c.end();
      c.localGet(X);
      c.f64Const(Number.POSITIVE_INFINITY);
      c.f64Eq();
      c.ifVoid();
      c.unreachable(); // RangeError: Invalid count value
      c.end();
      // count 0 or the empty receiver → "" (BEFORE the size cap: a huge
      // finite count over "" is legal JS and returns "").
      c.localGet(X);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(this.strType);
      c.return_();
      c.end();
      c.localGet(L);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.arrayNewDefault(this.strType);
      c.return_();
      c.end();
      c.localGet(X);
      c.localGet(L);
      c.f64ConvertI32S();
      c.f64Mul();
      c.f64Const(2147483648);
      c.f64Ge();
      c.ifVoid();
      c.unreachable(); // result size unrepresentable — RangeError's trap
      c.end();
      c.localGet(X);
      c.i32TruncF64S();
      c.localSet(N);
      c.localGet(N);
      c.localGet(L);
      c.i32Mul();
      c.localSet(TOT);
      c.localGet(TOT);
      c.arrayNewDefault(this.strType);
      c.localSet(R);
      c.i32Const(0);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(R);
      c.localGet(K);
      c.localGet(L);
      c.i32Mul();
      c.localGet(S);
      c.i32Const(0);
      c.localGet(L);
      c.arrayCopy(this.strType, this.strType);
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();
      c.localGet(R);
      this.mb.setBody(idx, [I32, I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }

  /** %w.str.trim:<mode> — (s) → str: the ECMA whitespace scans, one-sided
   * for the trimStart/trimEnd halves. Always a fresh copy. */
  trim(mode: "both" | "start" | "end"): number {
    return this.cached(`trim:${mode}`, () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef()], [this.strRef()]),
        `%w.str.trim:${mode}`,
      );
      const c = new Code();
      const S = 0, L = 1, B = 2, E = 3, R = 4;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.i32Const(0);
      c.localSet(B);
      c.localGet(L);
      c.localSet(E);
      if (mode !== "end") {
        c.block();
        c.loop();
        c.localGet(B);
        c.localGet(E);
        c.i32GeS();
        c.brIf(1);
        c.localGet(S);
        c.localGet(B);
        c.arrayGetU(this.strType);
        c.call(this.isWs());
        c.i32Eqz();
        c.brIf(1);
        c.localGet(B);
        c.i32Const(1);
        c.i32Add();
        c.localSet(B);
        c.br(0);
        c.end();
        c.end();
      }
      if (mode !== "start") {
        c.block();
        c.loop();
        c.localGet(E);
        c.localGet(B);
        c.i32LeS();
        c.brIf(1);
        c.localGet(S);
        c.localGet(E);
        c.i32Const(1);
        c.i32Sub();
        c.arrayGetU(this.strType);
        c.call(this.isWs());
        c.i32Eqz();
        c.brIf(1);
        c.localGet(E);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(E);
        c.br(0);
        c.end();
        c.end();
      }
      c.localGet(E);
      c.localGet(B);
      c.i32Sub();
      c.localSet(E); // count
      this.emitCopySpan(c, S, B, E, R);
      this.mb.setBody(idx, [I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }

  /** %w.str.split — (s, sep) → vec(str), ECMA-262's string-separator
   * form, no limit: the empty separator splits per UTF-16 CODE UNIT
   * ("".split("") is []) — JS-exact, an astral char DOES yield its two
   * lone halves here (upstream's U+FFFD substitution is gone with the
   * storage that forced it); a non-empty separator keeps empty pieces at
   * the ends and between adjacent matches, and an empty subject answers
   * [""]. */
  split(): number {
    return this.cached("split", () => {
      const { info, push1 } = this.deps.vecStr();
      const vecRef: ValType = { kind: "ref", nullable: true, typeIndex: info.struct };
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), this.strRef()], [vecRef]),
        "%w.str.split",
      );
      const c = new Code();
      const S = 0, SEP = 1, L = 2, SL = 3, OUT = 4, I = 5, START = 6, CNT = 7, R = 8;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.localGet(SEP);
      c.arrayLen();
      c.localSet(SL);
      c.i32Const(0);
      c.i32Const(0);
      c.arrayNewDefault(info.bufType);
      c.structNew(info.struct);
      c.localSet(OUT);
      c.localGet(SL);
      c.i32Eqz();
      c.ifVoid();
      {
        // Per-unit pieces; the loop body IS "".split("")'s [] for free.
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(L);
        c.i32GeS();
        c.brIf(1);
        c.localGet(OUT);
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.strType);
        c.arrayNewFixed(this.strType, 1);
        c.call(push1);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(OUT);
        c.return_();
      }
      c.end();
      c.i32Const(0);
      c.localSet(START);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.localGet(SL);
      c.i32Sub();
      c.i32GtS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(SEP);
      c.localGet(I);
      c.call(this.matchAt());
      c.ifVoid();
      c.localGet(OUT);
      c.localGet(I);
      c.localGet(START);
      c.i32Sub();
      c.localSet(CNT);
      this.emitCopySpan(c, S, START, CNT, R);
      c.call(push1);
      c.localGet(I);
      c.localGet(SL);
      c.i32Add();
      c.localSet(START);
      c.localGet(START);
      c.localSet(I);
      c.br(1); // continue the scan loop (0 is this if)
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUT);
      c.localGet(L);
      c.localGet(START);
      c.i32Sub();
      c.localSet(CNT);
      this.emitCopySpan(c, S, START, CNT, R);
      c.call(push1);
      c.localGet(OUT);
      this.mb.setBody(idx, [I32, I32, vecRef, I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }

  /** %w.str.pad — (s, f64 target, fill, i32 atStart) → str: StringPad,
   * target in UTF-16 units. At-or-below-target and empty-fill answer the
   * RECEIVER (identity — unobservable for primitives); the truncated
   * final fill keeps its first rem units EXACTLY (a split astral pair
   * keeps the lone high half, JS's answer — no U+FFFD here). Targets at
   * or past 2^31 trap (the repeat() policy). */
  pad(): number {
    return this.cached("pad", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), F64, this.strRef(), I32], [this.strRef()]),
        "%w.str.pad",
      );
      const c = new Code();
      const S = 0, X = 1, FILL = 2, AT = 3, L = 4, FL = 5, T = 6, PAD = 7, REPS = 8, REM = 9, K = 10, R = 11, OFF = 12;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.localGet(FILL);
      c.arrayLen();
      c.localSet(FL);
      this.emitToIntInf(c, X);
      // !(target > len) → identity (NaN → 0 rode ToIntegerOrInfinity).
      c.localGet(X);
      c.localGet(L);
      c.f64ConvertI32S();
      c.f64Gt();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(S);
      c.return_();
      c.end();
      c.localGet(FL);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(S);
      c.return_();
      c.end();
      c.localGet(X);
      c.f64Const(2147483648);
      c.f64Ge();
      c.ifVoid();
      c.unreachable(); // target size unrepresentable — RangeError's trap
      c.end();
      c.localGet(X);
      c.i32TruncF64S();
      c.localSet(T);
      c.localGet(T);
      c.localGet(L);
      c.i32Sub();
      c.localSet(PAD);
      c.localGet(PAD);
      c.localGet(FL);
      c.i32DivS();
      c.localSet(REPS);
      c.localGet(PAD);
      c.localGet(FL);
      c.i32RemS();
      c.localSet(REM);
      c.localGet(T);
      c.arrayNewDefault(this.strType);
      c.localSet(R);
      // The filler's start: 0 padding the front, len padding the back.
      c.localGet(AT);
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(L);
      c.end();
      c.localSet(OFF);
      c.i32Const(0);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(REPS);
      c.i32GeS();
      c.brIf(1);
      c.localGet(R);
      c.localGet(OFF);
      c.localGet(K);
      c.localGet(FL);
      c.i32Mul();
      c.i32Add();
      c.localGet(FILL);
      c.i32Const(0);
      c.localGet(FL);
      c.arrayCopy(this.strType, this.strType);
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();
      c.localGet(R);
      c.localGet(OFF);
      c.localGet(REPS);
      c.localGet(FL);
      c.i32Mul();
      c.i32Add();
      c.localGet(FILL);
      c.i32Const(0);
      c.localGet(REM);
      c.arrayCopy(this.strType, this.strType);
      // The receiver lands after front padding, or at 0 padding the back.
      c.localGet(R);
      c.localGet(AT);
      c.ifResult(I32);
      c.localGet(PAD);
      c.else_();
      c.i32Const(0);
      c.end();
      c.localGet(S);
      c.i32Const(0);
      c.localGet(L);
      c.arrayCopy(this.strType, this.strType);
      c.localGet(R);
      this.mb.setBody(
        idx,
        [I32, I32, I32, I32, I32, I32, I32, this.strRef(), I32],
        c.bytes(),
      );
      return idx;
    });
  }

  /** %w.str.isWellFormed — (s) → i32: a REAL scan here (every surrogate
   * paired), where the C runtime's storage invariant let it answer a
   * constant. */
  isWellFormed(): number {
    return this.cached("isWellFormed", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRef()], [I32]), "%w.str.isWellFormed");
      const c = new Code();
      const S = 0, L = 1, I = 2, U = 3;
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType);
      c.localSet(U);
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0xdbff);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      {
        // A high surrogate needs a low one right behind it.
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localGet(L);
        c.i32GeS();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(S);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.arrayGetU(this.strType);
        c.localSet(U);
        c.localGet(U);
        c.i32Const(0xdc00);
        c.i32LtS();
        c.localGet(U);
        c.i32Const(0xdfff);
        c.i32GtS();
        c.i32Or();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(I);
        c.i32Const(2);
        c.i32Add();
        c.localSet(I);
      }
      c.else_();
      {
        // A bare low surrogate is ill-formed on its own.
        c.localGet(U);
        c.i32Const(0xdc00);
        c.i32GeS();
        c.localGet(U);
        c.i32Const(0xdfff);
        c.i32LeS();
        c.i32And();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      }
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.i32Const(1);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.toWellFormed — (s) → str: identity on well-formed input, else
   * a fresh copy with every UNPAIRED surrogate replaced by U+FFFD (paired
   * ones copy through) — the spec's algorithm over faithful storage. */
  toWellFormed(): number {
    return this.cached("toWellFormed", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef()], [this.strRef()]),
        "%w.str.toWellFormed",
      );
      const c = new Code();
      const S = 0, L = 1, I = 2, U = 3, R = 4;
      c.localGet(S);
      c.call(this.isWellFormed());
      c.ifVoid();
      c.localGet(S);
      c.return_();
      c.end();
      c.localGet(S);
      c.arrayLen();
      c.localSet(L);
      c.localGet(L);
      c.arrayNewDefault(this.strType);
      c.localSet(R);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType);
      c.localSet(U);
      // A high surrogate with its low half: both units copy through.
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0xdbff);
      c.i32LeS();
      c.i32And();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(L);
      c.i32LtS();
      c.i32And();
      c.ifVoid();
      c.localGet(S);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.strType);
      c.i32Const(0xfc00);
      c.i32And();
      c.i32Const(0xdc00);
      c.i32Eq();
      c.ifVoid();
      c.localGet(R);
      c.localGet(I);
      c.localGet(U);
      c.arraySet(this.strType);
      c.localGet(R);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(S);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.strType);
      c.arraySet(this.strType);
      c.localGet(I);
      c.i32Const(2);
      c.i32Add();
      c.localSet(I);
      c.br(2); // continue the copy loop (0 this if, 1 the outer if)
      c.end();
      c.end();
      // Anything else: the unit itself, or U+FFFD when it is a surrogate.
      c.localGet(R);
      c.localGet(I);
      c.localGet(U);
      c.i32Const(0xf800);
      c.i32And();
      c.i32Const(0xd800);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(0xfffd);
      c.else_();
      c.localGet(U);
      c.end();
      c.arraySet(this.strType);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(R);
      this.mb.setBody(idx, [I32, I32, I32, this.strRef()], c.bytes());
      return idx;
    });
  }
}
