/* JSON, both directions, as emitted WasmGC code: a recursive-descent
 * parser over the tier's UTF-16 string producing dyn trees (dyn.ts), and
 * the output BUFFER + escape/number/re-indent primitives the emitted
 * stringify serializers write through (the serializers themselves are
 * type-directed and live at the emitter, beside the dyn walkers). The
 * increment's design doc for this stage — read it before changing the
 * grammar or a message.
 *
 * THE ORACLE IS NODE, NOT THE C RUNTIME. `scr_json.c`'s parser is the
 * structural reference and this is a faithful port of its GRAMMAR, but
 * its error TEXTS are self-described as "approximate fidelity" and match
 * V8 in only 4 of 18 measured cases — it omits the `(line L column C)`
 * suffix everywhere, windows its snippet differently, and picks a
 * different message in a few places. Those texts are observable here (a
 * catch binding reads `e.message`), so this parser reproduces V8's
 * exactly and the native lanes' approximation is simply not inherited.
 * That is the same stance S002 takes for the string path, one layer up.
 *
 * STRINGS ARE UTF-16 AND LONE SURROGATES SURVIVE (S002). C decodes UTF-8
 * and maps unpaired surrogates to U+FFFD as a house policy; this tier
 * stores code units, so a `\uXXXX` escape appends its unit VERBATIM, a
 * surrogate pair written as two escapes combines for free, and raw
 * characters need no decoding at all. Simpler than C's path and closer to
 * Node's, which keeps the lone surrogate. Positions are code-unit indices
 * for the same reason — which is what V8 reports.
 *
 * PARSER STATE IS THREE MODULE GLOBALS (source, position, depth) rather
 * than a threaded struct, which is exactly C's pointer-to-ScrJsonP with
 * the pointer elided. Safe because a parse is never re-entrant: the
 * reviver argument — the one thing that could run user code mid-parse —
 * is FRONTEND-fenced (lower-builtins.ts, "JSON.parse with a reviver") and
 * never reaches any backend.
 *
 * THE DEPTH CAP IS A CATCHABLE ERROR, NOT A TRAP. Nesting deeper than
 * SCR_JSON_MAX_DEPTH (1000) throws a catchable RangeError through the
 * exception cell, exactly as `scr_throw_error` does natively — it is
 * deliberately NOT a member of the uncatchable-trap family (S003/S006/
 * S008), which exists for checks the may-throw analysis counts as aborts.
 * Node has no cap at all (its parser is iterative), so this is a real
 * divergence on every lane and it is registered as SEMANTICS.md S013.
 * Without the cap a recursive parser would exhaust the wasm stack at some
 * unspecified depth, which is a worse failure than a documented one.
 *
 * NUMBERS ARE CORRECTLY ROUNDED, in two stages, and the exactness
 * argument is the whole reason the second one exists:
 *
 *   1. Clinger's fast path, ported verbatim from `scr_json_number`: with
 *      at most 15 significant digits the mantissa is exact in a double
 *      (10^15 < 2^53) and 10^|exp10| for |exp10| <= 22 is exactly
 *      representable, so ONE multiply or divide is the only rounding and
 *      IEEE gives it correctly rounded.
 *   2. Simple Decimal Conversion otherwise. C hands those to `strtod`;
 *      wasm has no libc, and this case is NOT rare — `String(x)` emits
 *      the shortest round-trip form, which for ordinary doubles runs to
 *      16 or 17 significant digits (Math.PI, Number.MAX_SAFE_INTEGER,
 *      1/3, 0.1+0.2 all miss the 15-digit cap), so a measured 94% of
 *      round-tripped doubles land here. The full argument for why that
 *      path is correctly rounded — including why dropping digits past the
 *      buffer is safe — sits with the implementation below.
 *
 * Both stages are pinned by a 100k-case round-trip fuzz against Node
 * (random double bit patterns through JSON.stringify and back, asserting
 * bit equality) plus the hard set: subnormals, both ends of the
 * representable range, exact ties, long digit strings, and the exponent
 * overflow/underflow forms. */
import { Code } from "./code.js";
import { DK, DYN_KIND, DYN_NUM, DYN_REF, type DynBuilder } from "./dyn.js";
import { F64, I32, I64, ModuleBuilder, type ValType } from "./module.js";

/** C's SCR_JSON_MAX_DEPTH. SEMANTICS.md S013. */
export const MAX_DEPTH = 1000;

/** The abstract `eq` heap type's s33 encoding. Every GC struct and array
 * is a subtype, and unlike `any` it admits `ref.eq` — which is exactly
 * what circular detection compares. */
const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/** `json:seen` field indices — one circular-detection frame. */
const SEEN_PTR = 0;
const SEEN_IS_ARRAY = 1;
const SEEN_PROP = 2;
const SEEN_INDEX = 3;

/** V8 prints the whole input when it is this short, and otherwise a
 * window of this radius around the offending position, with an ellipsis
 * on whichever side it truncated. Reverse-engineered against Node across
 * error-at-start / at-end / in-middle at lengths 14-95. */
const SNIPPET_WHOLE_MAX = 20;
const SNIPPET_RADIUS = 10;

export interface JsonDeps {
  strRef: () => ValType;
  strType: () => number;
  concat: () => number;
  f64ToStr: () => number;
  lit: (c: Code, s: string) => void;
  /** Fill the exception cell with a catchable error of the named builtin
   * class whose message `pushMessage` builds at runtime. The CALLER
   * unwinds; json.parse is may-throw-seeded so its callers' pending
   * checks come free. */
  throwError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void) => void;
  /** Is a pending exception set? (the cell's kind global). */
  excKind: () => number;
  /** Push a fresh empty dyn VECTOR (the ARR payload) — %w.vec.newLen:dyn
   * at length 0. The vector machinery is the emitter's to intern. */
  newDynVec: (c: Code) => void;
  dyn: () => DynBuilder;
}

export class JsonBuilder {
  private srcG: number | null = null;
  private posG: number | null = null;
  private depthG: number | null = null;
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: JsonDeps,
  ) {}

  /* ── parser state ───────────────────────────────────────────────────── */

  private src(): number {
    this.srcG ??= this.mb.addGlobal(this.deps.strRef(), true, (w) => {
      w.u8(0xd0);
      w.sleb(this.deps.strType());
    });
    return this.srcG;
  }

  private pos(): number {
    this.posG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.posG;
  }

  private depth(): number {
    this.depthG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.depthG;
  }

  /** The input's length, as an i32. */
  private pushLen(c: Code): void {
    c.globalGet(this.src());
    c.arrayLen();
  }

  /** The code unit at index `i` (pushed by the caller). Unchecked — every
   * caller has already compared against the length. */
  private pushAt(c: Code, pushIndex: (c: Code) => void): void {
    c.globalGet(this.src());
    pushIndex(c);
    c.arrayGetU(this.deps.strType());
  }

  /** The unit at the current position. */
  private pushCur(c: Code): void {
    this.pushAt(c, (x) => x.globalGet(this.pos()));
  }

  /** The unit at `pos`, or 0 when the input is exhausted. Wasm evaluates
   * both operands of `i32.and` eagerly, so the natural spelling of
   * `pos < len && src[pos] == c` reads out of bounds at the end of input —
   * this is the short-circuit, and 0 is a safe sentinel because NUL is
   * never a structural JSON character and inside a string it fails the
   * control-character check anyway. */
  private pushCurOr0(c: Code): void {
    this.pushHasMore(c);
    c.ifResult(I32);
    this.pushCur(c);
    c.else_();
    c.i32Const(0);
    c.end();
  }

  /** pos += n. */
  private bump(c: Code, n: number): void {
    c.globalGet(this.pos());
    c.i32Const(n);
    c.i32Add();
    c.globalSet(this.pos());
  }

  /** pos < len. */
  private pushHasMore(c: Code): void {
    c.globalGet(this.pos());
    this.pushLen(c);
    c.i32LtU();
  }

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.json.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── errors: V8's texts exactly ─────────────────────────────────────── */

  /** `%w.json.lineCol(pos)` → " (line L column C)". V8 appends this to
   * every POSITIONED message. Lines are 1-based and split on '\n'; the
   * column is the 1-based offset from the last newline. */
  private lineCol(): number {
    return this.cached("lineCol", [I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const I = 1;
      const LINE = 2;
      const LAST = 3;
      c.i32Const(1);
      c.localSet(LINE);
      c.i32Const(0);
      c.localSet(LAST);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(0);
      c.i32GeU();
      c.brIf(1);
      this.pushAt(c, (x) => x.localGet(I));
      c.i32Const(10); // '\n'
      c.i32Eq();
      c.ifVoid();
      c.localGet(LINE);
      c.i32Const(1);
      c.i32Add();
      c.localSet(LINE);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(LAST);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.deps.lit(c, " (line ");
      c.localGet(LINE);
      c.f64ConvertI32U();
      c.call(this.deps.f64ToStr());
      c.call(this.deps.concat());
      this.deps.lit(c, " column ");
      c.call(this.deps.concat());
      c.localGet(0);
      c.localGet(LAST);
      c.i32Sub();
      c.i32Const(1);
      c.i32Add();
      c.f64ConvertI32U();
      c.call(this.deps.f64ToStr());
      c.call(this.deps.concat());
      this.deps.lit(c, ")");
      c.call(this.deps.concat());
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }

  /** `%w.json.throwAt(msg, pos)` — "<msg> in JSON at position N (line L
   * column C)", V8's positioned form. */
  private throwAt(infix: boolean = true): number {
    return this.cached(infix ? "throwAt" : "throwAtBare", [this.deps.strRef(), I32], [], (idx) => {
      const c = new Code();
      const M = 2;
      c.localGet(0);
      this.deps.lit(c, infix ? " in JSON at position " : " at position ");
      c.call(this.deps.concat());
      c.localGet(1);
      c.f64ConvertI32U();
      c.call(this.deps.f64ToStr());
      c.call(this.deps.concat());
      c.localGet(1);
      c.call(this.lineCol());
      c.call(this.deps.concat());
      c.localSet(M);
      this.deps.throwError(c, "%SyntaxError", "SyntaxError", (x) => x.localGet(M));
      this.mb.setBody(idx, [this.deps.strRef()], c.bytes());
    });
  }

  /** `%w.json.throwEnd()` — the unpositioned "Unexpected end of JSON
   * input", which V8 uses whenever the input simply ran out. */
  private throwEnd(): number {
    return this.cached("throwEnd", [], [], (idx) => {
      const c = new Code();
      this.deps.throwError(c, "%SyntaxError", "SyntaxError", (x) =>
        this.deps.lit(x, "Unexpected end of JSON input"),
      );
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.json.snippet()` → the quoted excerpt V8 shows after a bad token:
   * the whole input when it is at most 20 units, otherwise a window of
   * radius 10 around `pos` with `...` on whichever side was truncated. */
  private snippet(): number {
    return this.cached("snippet", [I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const START = 1;
      const END = 2;
      const OUT = 3;
      const LEN = 4;
      const TMP = 5;
      this.pushLen(c);
      c.localSet(LEN);
      // Short inputs print whole, ellipsis-free.
      c.localGet(LEN);
      c.i32Const(SNIPPET_WHOLE_MAX);
      c.i32LeU();
      c.ifVoid();
      this.deps.lit(c, '"');
      c.globalGet(this.src());
      c.call(this.deps.concat());
      this.deps.lit(c, '"');
      c.call(this.deps.concat());
      c.return_();
      c.end();
      // start = max(0, pos - 10); end = min(len, pos + 10)
      c.localGet(0);
      c.i32Const(SNIPPET_RADIUS);
      c.i32GtU();
      c.ifResult(I32);
      c.localGet(0);
      c.i32Const(SNIPPET_RADIUS);
      c.i32Sub();
      c.else_();
      c.i32Const(0);
      c.end();
      c.localSet(START);
      c.localGet(0);
      c.i32Const(SNIPPET_RADIUS);
      c.i32Add();
      c.localTee(END);
      c.localGet(LEN);
      c.i32GtU();
      c.ifVoid();
      c.localGet(LEN);
      c.localSet(END);
      c.end();
      // The LEADING ellipsis is gated on the POSITION, not on the clamped
      // window start: at exactly pos == RADIUS the window still begins at
      // 0, and V8 prints "..." there regardless. (The trailing one below
      // really is a "did we lose text" test.)
      c.localGet(0);
      c.i32Const(SNIPPET_RADIUS);
      c.i32GeU();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, '..."');
      c.else_();
      this.deps.lit(c, '"');
      c.end();
      c.localSet(OUT);
      c.localGet(OUT);
      this.emitSlice(c, TMP, (x) => x.localGet(START), (x) => {
        x.localGet(END);
        x.localGet(START);
        x.i32Sub();
      });
      c.call(this.deps.concat());
      c.localSet(OUT);
      c.localGet(OUT);
      c.localGet(END);
      c.localGet(LEN);
      c.i32LtU();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, '"...');
      c.else_();
      this.deps.lit(c, '"');
      c.end();
      c.call(this.deps.concat());
      this.mb.setBody(idx, [I32, I32, this.deps.strRef(), I32, this.deps.strRef()], c.bytes());
    });
  }

  /** `%w.json.throwToken(pos)` — "Unexpected token 'C', <snippet> is not
   * valid JSON". V8 replaces the whole form with `"<input>" is not valid
   * JSON` when the ENTIRE input is one of the three JS literals that look
   * like values but are not JSON; anything else, including the same words
   * with surrounding whitespace or trailing text, takes the general form. */
  private throwToken(): number {
    return this.cached("throwToken", [I32], [], (idx) => {
      const c = new Code();
      const M = 1;
      const T = 2;
      for (const word of ["NaN", "undefined", "Infinity"]) {
        this.pushWholeInputIs(c, word);
        c.ifVoid();
        this.deps.lit(c, `"${word}" is not valid JSON`);
        c.localSet(M);
        this.deps.throwError(c, "%SyntaxError", "SyntaxError", (x) => x.localGet(M));
        c.return_();
        c.end();
      }
      this.deps.lit(c, "Unexpected token '");
      this.emitSlice(c, T, (x) => x.localGet(0), (x) => x.i32Const(1));
      c.call(this.deps.concat());
      this.deps.lit(c, "', ");
      c.call(this.deps.concat());
      c.localGet(0);
      c.call(this.snippet());
      c.call(this.deps.concat());
      this.deps.lit(c, " is not valid JSON");
      c.call(this.deps.concat());
      c.localSet(M);
      this.deps.throwError(c, "%SyntaxError", "SyntaxError", (x) => x.localGet(M));
      this.mb.setBody(idx, [this.deps.strRef(), this.deps.strRef()], c.bytes());
    });
  }

  /** Is the ENTIRE source exactly `word`? (length equal and units equal —
   * no whitespace tolerance, which is V8's rule.) The unit reads are
   * bounds-guarded for the same reason pushCurOr0 exists: `i32.and` does
   * not short-circuit, so a shorter input would otherwise be indexed past
   * its end while evaluating a comparison already known to be false. */
  private pushWholeInputIs(c: Code, word: string): void {
    this.pushLen(c);
    c.i32Const(word.length);
    c.i32Eq();
    for (let i = 0; i < word.length; i++) {
      this.pushAtOr0(c, i);
      c.i32Const(word.charCodeAt(i));
      c.i32Eq();
      c.i32And();
    }
  }

  /** src[i], or 0 when i is past the end. */
  private pushAtOr0(c: Code, i: number): void {
    c.i32Const(i);
    this.pushLen(c);
    c.i32LtU();
    c.ifResult(I32);
    this.pushAt(c, (x) => x.i32Const(i));
    c.else_();
    c.i32Const(0);
    c.end();
  }

  /** A fresh string holding src[start, start+len) — the span copy every
   * message and every parsed literal is built from. `r` is a caller-owned
   * `(ref null $str)` scratch local. Leaves the new string on the stack. */
  private emitSlice(c: Code, r: number, pushStart: (c: Code) => void, pushLen: (c: Code) => void): void {
    pushLen(c);
    c.arrayNewDefault(this.deps.strType());
    c.localSet(r);
    c.localGet(r);
    c.i32Const(0);
    c.globalGet(this.src());
    pushStart(c);
    pushLen(c);
    c.arrayCopy(this.deps.strType(), this.deps.strType());
    c.localGet(r);
  }

  /** Throw a positioned message with a compile-time text. `infix` is
   * false for the one V8 message that already names JSON itself
   * ("Unexpected non-whitespace character after JSON at position N"). */
  private emitThrowAtLit(c: Code, message: string, pushPos: (c: Code) => void, infix = true): void {
    this.deps.lit(c, message);
    pushPos(c);
    c.call(this.throwAt(infix));
  }

  /** Bail out of a parser function when the cell is set: these return a
   * dummy and the CALLER's own check fires (the walkers' discipline). */
  private emitPending(c: Code, result: ValType | null): void {
    c.globalGet(this.deps.excKind());
    c.ifVoid();
    this.emitDummy(c, result);
    c.return_();
    c.end();
  }

  private emitDummy(c: Code, result: ValType | null): void {
    if (result === null) return;
    if (result.kind === "ref") c.refNull(result.typeIndex);
    else if (result.kind === "f64") c.f64Const(0);
    else c.i32Const(0);
  }

  /* ── the grammar ────────────────────────────────────────────────────── */

  /** `%w.json.ws()` — JSON's whitespace set is exactly space, tab, LF, CR
   * (NOT ECMA's WhiteSpace: no NBSP, no BOM, no U+2028). */
  private ws(): number {
    return this.cached("ws", [], [], (idx) => {
      const c = new Code();
      const U = 0;
      c.block();
      c.loop();
      this.pushHasMore(c);
      c.i32Eqz();
      c.brIf(1);
      this.pushCur(c);
      c.localSet(U);
      c.localGet(U);
      c.i32Const(0x20);
      c.i32Eq();
      c.localGet(U);
      c.i32Const(0x09);
      c.i32Eq();
      c.i32Or();
      c.localGet(U);
      c.i32Const(0x0a);
      c.i32Eq();
      c.i32Or();
      c.localGet(U);
      c.i32Const(0x0d);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.brIf(1);
      this.bump(c, 1);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.json.hex4()` → the code unit four hex digits spell, consuming
   * them. V8 reports the FIRST non-hex position, and treats running out
   * of input as exactly that (the position is then the length). */
  private hex4(): number {
    return this.cached("hex4", [], [I32], (idx) => {
      const c = new Code();
      const V = 0;
      const I = 1;
      const D = 2;
      c.i32Const(0);
      c.localSet(V);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(4);
      c.i32GeU();
      c.brIf(1);
      // Out of input counts as a bad digit at the length.
      c.globalGet(this.pos());
      c.localGet(I);
      c.i32Add();
      this.pushLen(c);
      c.i32GeU();
      c.ifVoid();
      this.emitThrowAtLit(c, "Bad Unicode escape", (x) => this.pushLen(x));
      c.i32Const(0);
      c.return_();
      c.end();
      this.pushAt(c, (x) => {
        x.globalGet(this.pos());
        x.localGet(I);
        x.i32Add();
      });
      c.localSet(D);
      // '0'-'9' | 'a'-'f' | 'A'-'F', else the positioned failure.
      c.localGet(D);
      c.i32Const(0x30);
      c.i32Sub();
      c.localTee(D);
      c.i32Const(9);
      c.i32LeU();
      c.ifVoid();
      c.localGet(V);
      c.i32Const(16);
      c.i32Mul();
      c.localGet(D);
      c.i32Add();
      c.localSet(V);
      c.else_();
      c.localGet(D);
      c.i32Const(0x61 - 0x30);
      c.i32Sub();
      c.localTee(D);
      c.i32Const(5);
      c.i32LeU();
      c.ifVoid();
      c.localGet(V);
      c.i32Const(16);
      c.i32Mul();
      c.localGet(D);
      c.i32Const(10);
      c.i32Add();
      c.i32Add();
      c.localSet(V);
      c.else_();
      c.localGet(D);
      c.i32Const(0x41 - 0x61);
      c.i32Sub();
      c.localTee(D);
      c.i32Const(5);
      c.i32LeU();
      c.ifVoid();
      c.localGet(V);
      c.i32Const(16);
      c.i32Mul();
      c.localGet(D);
      c.i32Const(10);
      c.i32Add();
      c.i32Add();
      c.localSet(V);
      c.else_();
      this.emitThrowAtLit(c, "Bad Unicode escape", (x) => {
        x.globalGet(this.pos());
        x.localGet(I);
        x.i32Add();
      });
      c.i32Const(0);
      c.return_();
      c.end();
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      this.bump(c, 4);
      c.localGet(V);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }

  /** `%w.json.string()` → the string literal at `pos` (which is its
   * opening quote). Escapes append CODE UNITS verbatim — a `😀`
   * pair combines for free and a lone `\uD800` survives, which is Node's
   * answer and S002's stance (C substitutes U+FFFD here; not inherited).
   *
   * The buffer is sized at the remaining input, which is an upper bound
   * on the decoded length because every escape shrinks: no output unit
   * can come from fewer than one input unit. */
  private jstring(): number {
    return this.cached("string", [], [this.deps.strRef()], (idx) => {
      const strRef = this.deps.strRef();
      const c = new Code();
      const OUT = 0;
      const N = 1;
      const U = 2;
      const R = 3;
      this.bump(c, 1); // the opening quote
      this.pushLen(c);
      c.globalGet(this.pos());
      c.i32Sub();
      c.arrayNewDefault(this.deps.strType());
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(N);
      c.block();
      c.loop();
      this.pushHasMore(c);
      c.i32Eqz();
      c.ifVoid();
      // V8 reports the END of input, not the opening quote (C reports the
      // quote — one of the four systematic text differences).
      this.emitThrowAtLit(c, "Unterminated string", (x) => this.pushLen(x));
      c.refNull(this.deps.strType());
      c.return_();
      c.end();
      this.pushCur(c);
      c.localSet(U);
      c.localGet(U);
      c.i32Const(0x22); // '"'
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      c.localGet(N);
      c.arrayNewDefault(this.deps.strType());
      c.localSet(R);
      c.localGet(R);
      c.i32Const(0);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(this.deps.strType(), this.deps.strType());
      c.localGet(R);
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x20);
      c.i32LtU();
      c.ifVoid();
      this.emitThrowAtLit(c, "Bad control character in string literal", (x) =>
        x.globalGet(this.pos()),
      );
      c.refNull(this.deps.strType());
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x5c); // '\\'
      c.i32Ne();
      c.ifVoid();
      this.emitAppend(c, OUT, N, (x) => x.localGet(U));
      this.bump(c, 1);
      c.br(1); // continue: if(0), loop(1), block(2)
      c.end();
      this.bump(c, 1); // the backslash
      this.pushHasMore(c);
      c.i32Eqz();
      c.ifVoid();
      c.call(this.throwEnd());
      c.refNull(this.deps.strType());
      c.return_();
      c.end();
      this.pushCur(c);
      c.localSet(U);
      const simple: [number, number][] = [
        [0x22, 0x22],
        [0x5c, 0x5c],
        [0x2f, 0x2f],
        [0x62, 0x08],
        [0x66, 0x0c],
        [0x6e, 0x0a],
        [0x72, 0x0d],
        [0x74, 0x09],
      ];
      for (const [esc, out] of simple) {
        c.localGet(U);
        c.i32Const(esc);
        c.i32Eq();
        c.ifVoid();
        this.emitAppend(c, OUT, N, (x) => x.i32Const(out));
        this.bump(c, 1);
        c.br(1);
        c.end();
      }
      c.localGet(U);
      c.i32Const(0x75); // 'u'
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      c.call(this.hex4());
      c.localSet(U);
      this.emitPendingStr(c);
      this.emitAppend(c, OUT, N, (x) => x.localGet(U));
      c.br(1);
      c.end();
      this.emitThrowAtLit(c, "Bad escaped character", (x) => x.globalGet(this.pos()));
      c.refNull(this.deps.strType());
      c.return_();
      c.end();
      c.end();
      c.refNull(this.deps.strType());
      this.mb.setBody(idx, [strRef, I32, I32, strRef], c.bytes());
    });
  }

  /** out[n++] = unit. */
  private emitAppend(c: Code, out: number, n: number, pushUnit: (c: Code) => void): void {
    c.localGet(out);
    c.localGet(n);
    pushUnit(c);
    c.arraySet(this.deps.strType());
    c.localGet(n);
    c.i32Const(1);
    c.i32Add();
    c.localSet(n);
  }

  /** The string-returning pending bail. */
  private emitPendingStr(c: Code): void {
    c.globalGet(this.deps.excKind());
    c.ifVoid();
    c.refNull(this.deps.strType());
    c.return_();
    c.end();
  }

  /** `unit` is an ASCII digit. */
  private pushIsDigit(c: Code, pushUnit: (c: Code) => void): void {
    pushUnit(c);
    c.i32Const(0x30);
    c.i32Sub();
    c.i32Const(9);
    c.i32LeU();
  }

  /** A digit at pos (false at end of input — see pushCurOr0). */
  private pushCurIsDigit(c: Code): void {
    this.pushIsDigit(c, (x) => this.pushCurOr0(x));
  }

  /** 10^0 .. 10^22 as an immutable global array of EXACT doubles — every
   * one of them is representable, which is the whole basis of the fast
   * path's single-rounding argument. `array.new_fixed` is a constant
   * expression, so this costs no runtime construction. */
  private pow10G: number | null = null;
  private pow10ArrT: number | null = null;

  private pow10(): { global: number; type: number } {
    if (this.pow10G === null) {
      const t = this.mb.arrayType(F64, false);
      this.pow10ArrT = t;
      this.pow10G = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: t }, false, (w) => {
        for (let k = 0; k <= 22; k++) {
          w.u8(0x44);
          w.f64(Number(`1e${k}`));
        }
        w.u8(0xfb);
        w.uleb(0x08); // array.new_fixed
        w.uleb(t);
        w.uleb(23);
      });
    }
    return { global: this.pow10G, type: this.pow10ArrT! };
  }

  /** `%w.json.number()` → the number literal at `pos` as a dyn NUM.
   * Grammar validation and mantissa accumulation in ONE pass, exactly as
   * `scr_json_number` does it — see the header for the two-stage
   * exactness argument. */
  private jnumber(): number {
    return this.cached("number", [], [this.deps.dyn().dynRef()], (idx) => {
      const dyn = this.deps.dyn();
      const c = new Code();
      const MANT = 0; // i64
      const NDIG = 1;
      const EXP = 2;
      const NEG = 3;
      const PREC = 4;
      const D = 5;
      const EV = 6;
      const ENEG = 7;
      const V = 8; // f64
      const START = 9;
      c.globalGet(this.pos());
      c.localSet(START);
      c.i64Const(0n);
      c.localSet(MANT);
      c.i32Const(0);
      c.localSet(NDIG);
      c.i32Const(0);
      c.localSet(EXP);
      c.i32Const(0);
      c.localSet(NEG);
      c.i32Const(1);
      c.localSet(PREC);
      // '-'
      this.pushCur(c);
      c.i32Const(0x2d);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(NEG);
      this.bump(c, 1);
      this.pushCurIsDigit(c);
      c.i32Eqz();
      c.ifVoid();
      this.emitThrowAtLit(c, "No number after minus sign", (x) => x.globalGet(this.pos()));
      c.refNull(dyn.dynT());
      c.return_();
      c.end();
      c.end();
      // integer part: a leading '0' stands alone
      this.pushCur(c);
      c.i32Const(0x30);
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      c.else_();
      c.block();
      c.loop();
      this.pushCurIsDigit(c);
      c.i32Eqz();
      c.brIf(1);
      this.pushCur(c);
      c.i32Const(0x30);
      c.i32Sub();
      c.localSet(D);
      c.localGet(NDIG);
      c.i32Const(15);
      c.i32LtU();
      c.ifVoid();
      c.localGet(MANT);
      c.i64Const(10n);
      c.i64Mul();
      c.localGet(D);
      c.i64ExtendI32U();
      c.i64Add();
      c.localSet(MANT);
      c.localGet(NDIG);
      c.i32Const(1);
      c.i32Add();
      c.localSet(NDIG);
      c.else_();
      c.i32Const(0);
      c.localSet(PREC);
      c.end();
      this.bump(c, 1);
      c.br(0);
      c.end();
      c.end();
      c.end();
      // fraction
      this.pushCurOr0(c);
      c.i32Const(0x2e);
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      this.pushCurIsDigit(c);
      c.i32Eqz();
      c.ifVoid();
      this.emitThrowAtLit(c, "Unterminated fractional number", (x) => x.globalGet(this.pos()));
      c.refNull(dyn.dynT());
      c.return_();
      c.end();
      c.block();
      c.loop();
      this.pushCurIsDigit(c);
      c.i32Eqz();
      c.brIf(1);
      this.pushCur(c);
      c.i32Const(0x30);
      c.i32Sub();
      c.localSet(D);
      // Leading fractional zeros scale without consuming a digit slot.
      c.localGet(MANT);
      c.i64Eqz();
      c.localGet(D);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(EXP);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(EXP);
      c.else_();
      c.localGet(NDIG);
      c.i32Const(15);
      c.i32LtU();
      c.ifVoid();
      c.localGet(MANT);
      c.i64Const(10n);
      c.i64Mul();
      c.localGet(D);
      c.i64ExtendI32U();
      c.i64Add();
      c.localSet(MANT);
      c.localGet(NDIG);
      c.i32Const(1);
      c.i32Add();
      c.localSet(NDIG);
      c.localGet(EXP);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(EXP);
      c.else_();
      c.i32Const(0);
      c.localSet(PREC);
      c.end();
      c.end();
      this.bump(c, 1);
      c.br(0);
      c.end();
      c.end();
      c.end();
      // exponent
      this.pushCurOr0(c);
      c.i32Const(0x65);
      c.i32Eq();
      this.pushCurOr0(c);
      c.i32Const(0x45);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      this.bump(c, 1);
      c.i32Const(0);
      c.localSet(ENEG);
      this.pushCurOr0(c);
      c.i32Const(0x2b);
      c.i32Eq();
      this.pushCurOr0(c);
      c.i32Const(0x2d);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      this.pushCur(c);
      c.i32Const(0x2d);
      c.i32Eq();
      c.localSet(ENEG);
      this.bump(c, 1);
      c.end();
      this.pushCurIsDigit(c);
      c.i32Eqz();
      c.ifVoid();
      this.emitThrowAtLit(c, "Exponent part is missing a number", (x) => x.globalGet(this.pos()));
      c.refNull(dyn.dynT());
      c.return_();
      c.end();
      c.i32Const(0);
      c.localSet(EV);
      c.block();
      c.loop();
      this.pushCurIsDigit(c);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(EV);
      c.i32Const(100000);
      c.i32LtU();
      c.ifVoid();
      c.localGet(EV);
      c.i32Const(10);
      c.i32Mul();
      this.pushCur(c);
      c.i32Const(0x30);
      c.i32Sub();
      c.i32Add();
      c.localSet(EV);
      c.end();
      this.bump(c, 1);
      c.br(0);
      c.end();
      c.end();
      c.localGet(EXP);
      c.localGet(ENEG);
      c.ifResult(I32);
      c.i32Const(0);
      c.localGet(EV);
      c.i32Sub();
      c.else_();
      c.localGet(EV);
      c.end();
      c.i32Add();
      c.localSet(EXP);
      c.end();
      // V8 alone: a completed number immediately followed by a digit is
      // "Unexpected number" (the leading-zero form, `01`). C reports the
      // enclosing container's expectation instead.
      this.pushCurIsDigit(c);
      c.ifVoid();
      this.emitThrowAtLit(c, "Unexpected number", (x) => x.globalGet(this.pos()));
      c.refNull(dyn.dynT());
      c.return_();
      c.end();
      // Stage 1 of the value: Clinger's fast path.
      c.localGet(PREC);
      c.localGet(EXP);
      c.i32Const(-22);
      c.i32GeS();
      c.i32And();
      c.localGet(EXP);
      c.i32Const(22);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      c.localGet(MANT);
      c.f64ConvertI64U(); // exact: mant < 10^15 < 2^53
      c.localSet(V);
      c.localGet(EXP);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(V);
      c.globalGet(this.pow10().global);
      c.localGet(EXP);
      c.arrayGet(this.pow10().type);
      c.f64Mul();
      c.localSet(V);
      c.else_();
      c.localGet(EXP);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.localGet(V);
      c.globalGet(this.pow10().global);
      c.i32Const(0);
      c.localGet(EXP);
      c.i32Sub();
      c.arrayGet(this.pow10().type);
      c.f64Div();
      c.localSet(V);
      c.end();
      c.end();
      dyn.boxNum(c, (x) => {
        x.localGet(NEG);
        x.ifResult(F64);
        x.localGet(V);
        x.f64Neg();
        x.else_();
        x.localGet(V);
        x.end();
      });
      c.return_();
      c.end();
      // Stage 2: Simple Decimal Conversion over the validated span. The
      // sign is read there too, so the box takes its answer directly.
      dyn.boxNum(c, (x) => {
        x.localGet(START);
        x.globalGet(this.pos());
        x.call(this.sdc());
      });
      this.mb.setBody(
        idx,
        [I64, I32, I32, I32, I32, I32, I32, I32, F64, I32],
        c.bytes(),
      );
    });
  }

  /** Match the keyword at `pos`, or fail the way V8 does: running out of
   * input is "Unexpected end of JSON input", while a MISMATCH names the
   * offending unit at its own position (`truX` → 'X', `nan` → 'a'). */
  private emitKeyword(c: Code, word: string, dynT: number): void {
    for (let i = 0; i < word.length; i++) {
      c.globalGet(this.pos());
      c.i32Const(i);
      c.i32Add();
      this.pushLen(c);
      c.i32GeU();
      c.ifVoid();
      c.call(this.throwEnd());
      c.refNull(dynT);
      c.return_();
      c.end();
      this.pushAt(c, (x) => {
        x.globalGet(this.pos());
        x.i32Const(i);
        x.i32Add();
      });
      c.i32Const(word.charCodeAt(i));
      c.i32Ne();
      c.ifVoid();
      c.globalGet(this.pos());
      c.i32Const(i);
      c.i32Add();
      c.call(this.throwToken());
      c.refNull(dynT);
      c.return_();
      c.end();
    }
    this.bump(c, word.length);
  }

  /** `%w.json.value()` — one JSON value at `pos`. */
  private jvalue(): number {
    return this.cached("value", [], [this.deps.dyn().dynRef()], (idx) => {
      const dyn = this.deps.dyn();
      const dynT = dyn.dynT();
      const c = new Code();
      const U = 0;
      const S = 1;
      c.call(this.ws());
      this.pushHasMore(c);
      c.i32Eqz();
      c.ifVoid();
      c.call(this.throwEnd());
      c.refNull(dynT);
      c.return_();
      c.end();
      this.pushCur(c);
      c.localSet(U);
      // Containers: the depth cap guards the recursion (S013).
      c.localGet(U);
      c.i32Const(0x7b); // '{'
      c.i32Eq();
      c.localGet(U);
      c.i32Const(0x5b); // '['
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.globalGet(this.depth());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.depth());
      c.globalGet(this.depth());
      c.i32Const(MAX_DEPTH);
      c.i32GtS();
      c.ifVoid();
      this.deps.throwError(c, "%RangeError", "RangeError", (x) =>
        this.deps.lit(x, "Maximum call stack size exceeded"),
      );
      c.refNull(dynT);
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x7b);
      c.i32Eq();
      c.ifResult(dyn.dynRef());
      c.call(this.jobject());
      c.else_();
      c.call(this.jarray());
      c.end();
      c.globalGet(this.depth());
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(this.depth());
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x22); // '"'
      c.i32Eq();
      c.ifVoid();
      c.call(this.jstring());
      c.localSet(S);
      this.emitPending(c, dyn.dynRef());
      dyn.boxStr(c, (x) => x.localGet(S));
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x74); // 't'
      c.i32Eq();
      c.ifVoid();
      this.emitKeyword(c, "true", dynT);
      c.globalGet(dyn.boolGlobal(true));
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x66); // 'f'
      c.i32Eq();
      c.ifVoid();
      this.emitKeyword(c, "false", dynT);
      c.globalGet(dyn.boolGlobal(false));
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x6e); // 'n'
      c.i32Eq();
      c.ifVoid();
      this.emitKeyword(c, "null", dynT);
      c.globalGet(dyn.nullGlobal());
      c.return_();
      c.end();
      c.localGet(U);
      c.i32Const(0x2d); // '-'
      c.i32Eq();
      this.pushIsDigit(c, (x) => x.localGet(U));
      c.i32Or();
      c.ifVoid();
      c.call(this.jnumber());
      c.return_();
      c.end();
      c.globalGet(this.pos());
      c.call(this.throwToken());
      c.refNull(dynT);
      this.mb.setBody(idx, [I32, this.deps.strRef()], c.bytes());
    });
  }

  /** `%w.json.array()` — `pos` is at '['. */
  private jarray(): number {
    return this.cached("array", [], [this.deps.dyn().dynRef()], (idx) => {
      const dyn = this.deps.dyn();
      const dynT = dyn.dynT();
      const c = new Code();
      const A = 0;
      const V = 1;
      this.bump(c, 1);
      this.deps.newDynVec(c);
      c.localSet(A);
      c.call(this.ws());
      this.pushCurOr0(c);
      c.i32Const(0x5d); // ']'
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      dyn.boxArr(c, (x) => x.localGet(A));
      c.return_();
      c.end();
      c.block();
      c.loop();
      c.call(this.jvalue());
      c.localSet(V);
      this.emitPending(c, dyn.dynRef());
      c.localGet(A);
      c.localGet(V);
      c.call(dyn.arrPush());
      c.call(this.ws());
      // The structural expectation fires even at end of input — V8 says
      // "Expected ',' or ']'" for `[1`, not "Unexpected end of JSON input"
      // (which it reserves for a missing VALUE, as after `[1,`).
      this.pushCurOr0(c);
      c.i32Const(0x2c); // ','
      c.i32Eq();
      this.pushCurOr0(c);
      c.i32Const(0x5d);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      this.emitThrowAtLit(c, "Expected ',' or ']' after array element", (x) =>
        x.globalGet(this.pos()),
      );
      c.refNull(dynT);
      c.return_();
      c.end();
      this.pushCurOr0(c);
      c.i32Const(0x5d);
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      dyn.boxArr(c, (x) => x.localGet(A));
      c.return_();
      c.end();
      this.bump(c, 1); // ','
      c.br(0);
      c.end();
      c.end();
      c.refNull(dynT);
      this.mb.setBody(idx, [dyn.arrRef(), dyn.dynRef()], c.bytes());
    });
  }

  /** `%w.json.object()` — `pos` is at '{'. Later duplicate keys win, which
   * is objPut's own rule and JS's. */
  private jobject(): number {
    return this.cached("object", [], [this.deps.dyn().dynRef()], (idx) => {
      const dyn = this.deps.dyn();
      const dynT = dyn.dynT();
      const c = new Code();
      const O = 0;
      const K = 1;
      const V = 2;
      const FIRST = 3;
      c.i32Const(1);
      c.localSet(FIRST);
      this.bump(c, 1);
      dyn.pushNewObj(c, false);
      c.localSet(O);
      c.call(this.ws());
      this.pushCurOr0(c);
      c.i32Const(0x7d); // '}'
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      dyn.boxObj(c, (x) => x.localGet(O));
      c.return_();
      c.end();
      c.block();
      c.loop();
      c.call(this.ws());
      this.pushCurOr0(c);
      c.i32Const(0x22); // '"'
      c.i32Eq();
      c.i32Eqz();
      c.ifVoid();
      // V8 splits these: the FIRST key names the alternative that would
      // have closed the object, while every post-comma key names only what
      // it wanted. Same position, same suffix — different sentence.
      c.localGet(FIRST);
      c.ifVoid();
      this.emitThrowAtLit(c, "Expected property name or '}'", (x) => x.globalGet(this.pos()));
      c.else_();
      this.emitThrowAtLit(c, "Expected double-quoted property name", (x) => x.globalGet(this.pos()));
      c.end();
      c.refNull(dynT);
      c.return_();
      c.end();
      c.call(this.jstring());
      c.localSet(K);
      this.emitPending(c, dyn.dynRef());
      c.call(this.ws());
      this.pushCurOr0(c);
      c.i32Const(0x3a); // ':'
      c.i32Eq();
      c.i32Eqz();
      c.ifVoid();
      this.emitThrowAtLit(c, "Expected ':' after property name", (x) => x.globalGet(this.pos()));
      c.refNull(dynT);
      c.return_();
      c.end();
      this.bump(c, 1);
      c.call(this.jvalue());
      c.localSet(V);
      this.emitPending(c, dyn.dynRef());
      c.localGet(O);
      c.localGet(K);
      c.localGet(V);
      c.call(dyn.objPut());
      c.call(this.ws());
      this.pushCurOr0(c);
      c.i32Const(0x2c);
      c.i32Eq();
      this.pushCurOr0(c);
      c.i32Const(0x7d);
      c.i32Eq();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      this.emitThrowAtLit(c, "Expected ',' or '}' after property value", (x) =>
        x.globalGet(this.pos()),
      );
      c.refNull(dynT);
      c.return_();
      c.end();
      this.pushCurOr0(c);
      c.i32Const(0x7d);
      c.i32Eq();
      c.ifVoid();
      this.bump(c, 1);
      dyn.boxObj(c, (x) => x.localGet(O));
      c.return_();
      c.end();
      this.bump(c, 1); // ','
      c.i32Const(0);
      c.localSet(FIRST);
      c.br(0);
      c.end();
      c.end();
      c.refNull(dynT);
      this.mb.setBody(idx, [dyn.objRef(), this.deps.strRef(), dyn.dynRef(), I32], c.bytes());
    });
  }

  /* ── Simple Decimal Conversion: the correctly-rounded fallback ─────────
   * The exactness argument, which is the only reason to prefer this over
   * a faster approximation:
   *
   *   The decimal digits are held EXACTLY in a base-10 buffer with a
   *   decimal-point position. `leftShift(k)` multiplies that value by 2^k
   *   and `rightShift(k)` divides by it; both are schoolbook operations on
   *   exact integers, so at every step the buffer still names the exact
   *   real number the literal did — no error has been introduced yet.
   *   Scaling by powers of two therefore lets us move the value into
   *   [1<<52, 1<<53) without approximating, and the ONLY rounding in the
   *   whole path is the final round-half-even, which acts on a residual we
   *   know exactly (the digits past the mantissa, plus a sticky bit for
   *   any we had to drop). A correctly-rounded result is what `strtod`
   *   promises, so this agrees with the native lanes and with V8.
   *
   *   TRUNCATION IS SAFE because of that sticky bit. The buffer holds 800
   *   digits, far past the ~767 a double can ever need; digits beyond it
   *   are dropped, but a dropped NONZERO digit sets `trunc`, and the
   *   half-way test consults `trunc` before it calls a tie. So a value
   *   that looks exactly half-way in the retained digits but is not really
   *   half-way still rounds up, which is the correct answer.
   *
   * VALIDATE THEN VALUE. The grammar walk in `jnumber` throws before any
   * of this runs, so a malformed literal never reaches the conversion —
   * the same order `scr_json_number` uses (its errors return NULL before
   * the strtod call). Note this does NOT cover trailing garbage after a
   * COMPLETE number (`123...890@`): that token is grammatical and its
   * value is genuinely needed to build the dyn box, so the caller reports
   * the garbage afterwards. It only looked like an ordering question
   * while the fallback was a trap.
   *
   * Ported from the algorithm Go's strconv/decimal.go implements; the
   * digit-count and shift bounds are re-derived below rather than
   * inherited, and the leftShift avoids Go's `leftcheats` table by
   * carrying right-to-left into a buffer with computed headroom. */

  /** Digits a double can ever need to round correctly is ~767; 800 gives
   * headroom and matches the reference implementation's choice. */
  private static readonly SDC_DIGITS = 800;
  /** Per-step shift bound. rightShift's accumulator reaches ~10 * 2^k and
   * leftShift's ~10 * 2^k too, so k <= 56 keeps both inside u64. */
  private static readonly SDC_MAX_SHIFT = 56;

  private sdcBufG: number | null = null;
  private sdcBufT: number | null = null;
  private sdcNdG: number | null = null;
  private sdcDpG: number | null = null;
  private sdcTruncG: number | null = null;
  private sdcNegG: number | null = null;

  private sdcBuf(): { global: number; type: number } {
    if (this.sdcBufG === null) {
      const t = this.mb.arrayType("i8", true);
      this.sdcBufT = t;
      this.sdcBufG = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: t }, false, (w) => {
        w.u8(0x41);
        w.sleb(JsonBuilder.SDC_DIGITS);
        w.u8(0xfb);
        w.uleb(0x07); // array.new_default
        w.uleb(t);
      });
    }
    return { global: this.sdcBufG, type: this.sdcBufT! };
  }

  private i32Global(slot: "nd" | "dp" | "trunc" | "neg"): number {
    const key = `sdc${slot}` as const;
    const cur =
      key === "sdcnd" ? this.sdcNdG
      : key === "sdcdp" ? this.sdcDpG
      : key === "sdctrunc" ? this.sdcTruncG
      : this.sdcNegG;
    if (cur !== null) return cur;
    const g = this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    if (key === "sdcnd") this.sdcNdG = g;
    else if (key === "sdcdp") this.sdcDpG = g;
    else if (key === "sdctrunc") this.sdcTruncG = g;
    else this.sdcNegG = g;
    return g;
  }

  private pushDigit(c: Code, pushIndex: (c: Code) => void): void {
    c.globalGet(this.sdcBuf().global);
    pushIndex(c);
    c.arrayGetU(this.sdcBuf().type);
  }

  private setDigit(c: Code, pushIndex: (c: Code) => void, pushVal: (c: Code) => void): void {
    c.globalGet(this.sdcBuf().global);
    pushIndex(c);
    pushVal(c);
    c.arraySet(this.sdcBuf().type);
  }

  /** Drop trailing zero digits, and collapse an all-zero value to nd == 0
   * (which the driver reads as "this is zero"). */
  private sdcTrim(): number {
    return this.cached("sdcTrim", [], [], (idx) => {
      const c = new Code();
      const ND = this.i32Global("nd");
      c.block();
      c.loop();
      // Guarded, not `nd > 0 && d[nd-1] == 0`: i32.and evaluates both
      // sides, so the natural spelling reads d[-1] at nd == 0.
      c.globalGet(ND);
      c.i32Const(0);
      c.i32GtS();
      c.ifResult(I32);
      this.pushDigit(c, (x) => {
        x.globalGet(ND);
        x.i32Const(1);
        x.i32Sub();
      });
      c.i32Eqz();
      c.else_();
      c.i32Const(0);
      c.end();
      c.i32Eqz();
      c.brIf(1);
      c.globalGet(ND);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(ND);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(ND);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.globalSet(this.i32Global("dp"));
      c.end();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.json.sdcRShift(k)` — divide the exact value by 2^k. */
  private sdcRShift(): number {
    return this.cached("sdcRShift", [I32], [], (idx) => {
      const ND = this.i32Global("nd");
      const DP = this.i32Global("dp");
      const c = new Code();
      const R = 1;
      const W = 2;
      const N = 3; // i64
      const MASK = 4; // i64
      const DIG = 5; // i64
      c.i32Const(0);
      c.localSet(R);
      c.i32Const(0);
      c.localSet(W);
      c.i64Const(0n);
      c.localSet(N);
      // Pull digits in until the accumulator covers 2^k.
      c.block();
      c.loop();
      c.localGet(N);
      c.localGet(0);
      c.i64ExtendI32U();
      c.i64ShrU();
      c.i64Eqz();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(R);
      c.globalGet(ND);
      c.i32GeS();
      c.ifVoid();
      // Ran out of digits: a zero accumulator means the value is zero.
      c.localGet(N);
      c.i64Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.globalSet(ND);
      c.return_();
      c.end();
      c.block();
      c.loop();
      c.localGet(N);
      c.localGet(0);
      c.i64ExtendI32U();
      c.i64ShrU();
      c.i64Eqz();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(N);
      c.i64Const(10n);
      c.i64Mul();
      c.localSet(N);
      c.localGet(R);
      c.i32Const(1);
      c.i32Add();
      c.localSet(R);
      c.br(0);
      c.end();
      c.end();
      c.br(1);
      c.end();
      c.localGet(N);
      c.i64Const(10n);
      c.i64Mul();
      this.pushDigit(c, (x) => x.localGet(R));
      c.i64ExtendI32U();
      c.i64Add();
      c.localSet(N);
      c.localGet(R);
      c.i32Const(1);
      c.i32Add();
      c.localSet(R);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(DP);
      c.localGet(R);
      c.i32Const(1);
      c.i32Sub();
      c.i32Sub();
      c.globalSet(DP);
      c.i64Const(1n);
      c.localGet(0);
      c.i64ExtendI32U();
      c.i64Shl();
      c.i64Const(1n);
      c.i64Sub();
      c.localSet(MASK);
      // Emit quotient digits while consuming the rest of the input.
      c.block();
      c.loop();
      c.localGet(R);
      c.globalGet(ND);
      c.i32GeS();
      c.brIf(1);
      c.localGet(N);
      c.localGet(0);
      c.i64ExtendI32U();
      c.i64ShrU();
      c.localSet(DIG);
      c.localGet(N);
      c.localGet(MASK);
      c.i64And();
      c.localSet(N);
      this.setDigit(c, (x) => x.localGet(W), (x) => {
        x.localGet(DIG);
        x.i32WrapI64();
      });
      c.localGet(W);
      c.i32Const(1);
      c.i32Add();
      c.localSet(W);
      c.localGet(N);
      c.i64Const(10n);
      c.i64Mul();
      this.pushDigit(c, (x) => x.localGet(R));
      c.i64ExtendI32U();
      c.i64Add();
      c.localSet(N);
      c.localGet(R);
      c.i32Const(1);
      c.i32Add();
      c.localSet(R);
      c.br(0);
      c.end();
      c.end();
      // Drain the accumulator; digits past the buffer set the sticky bit.
      c.block();
      c.loop();
      c.localGet(N);
      c.i64Eqz();
      c.brIf(1);
      c.localGet(N);
      c.localGet(0);
      c.i64ExtendI32U();
      c.i64ShrU();
      c.localSet(DIG);
      c.localGet(N);
      c.localGet(MASK);
      c.i64And();
      c.localSet(N);
      c.localGet(W);
      c.i32Const(JsonBuilder.SDC_DIGITS);
      c.i32LtS();
      c.ifVoid();
      this.setDigit(c, (x) => x.localGet(W), (x) => {
        x.localGet(DIG);
        x.i32WrapI64();
      });
      c.localGet(W);
      c.i32Const(1);
      c.i32Add();
      c.localSet(W);
      c.else_();
      c.localGet(DIG);
      c.i64Eqz();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.globalSet(this.i32Global("trunc"));
      c.end();
      c.end();
      c.localGet(N);
      c.i64Const(10n);
      c.i64Mul();
      c.localSet(N);
      c.br(0);
      c.end();
      c.end();
      c.localGet(W);
      c.globalSet(ND);
      c.call(this.sdcTrim());
      this.mb.setBody(idx, [I32, I32, I64, I64, I64], c.bytes());
    });
  }

  /** `%w.json.sdcLShift(k)` — multiply the exact value by 2^k. Carries
   * right-to-left into headroom at the top of the buffer, then slides the
   * result back to index 0; that avoids the reference implementation's
   * precomputed table for "how many digits does 2^k add", at the cost of
   * one copy. The headroom bound is ceil(k * log10 2), 17 at k = 56. */
  private sdcLShift(): number {
    return this.cached("sdcLShift", [I32], [], (idx) => {
      const ND = this.i32Global("nd");
      const DP = this.i32Global("dp");
      const c = new Code();
      const R = 1;
      const W = 2;
      const N = 3; // i64
      const DELTA = 4;
      const END = 5;
      // delta = ceil(k * log10(2)); k <= 56 so 17 always suffices.
      c.i32Const(17);
      c.localSet(DELTA);
      c.globalGet(ND);
      c.localGet(DELTA);
      c.i32Add();
      c.localSet(END);
      // The buffer must hold nd + delta; if it cannot, the tail digits are
      // already beyond anything a double can see — drop them (sticky) so
      // the shift still fits.
      c.localGet(END);
      c.i32Const(JsonBuilder.SDC_DIGITS);
      c.i32GtS();
      c.ifVoid();
      c.block();
      c.loop();
      c.globalGet(ND);
      c.localGet(DELTA);
      c.i32Add();
      c.i32Const(JsonBuilder.SDC_DIGITS);
      c.i32LeS();
      c.brIf(1);
      this.pushDigit(c, (x) => {
        x.globalGet(ND);
        x.i32Const(1);
        x.i32Sub();
      });
      c.i32Eqz();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.globalSet(this.i32Global("trunc"));
      c.end();
      c.globalGet(ND);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(ND);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(ND);
      c.localGet(DELTA);
      c.i32Add();
      c.localSet(END);
      c.end();
      c.localGet(END);
      c.localSet(W);
      c.i64Const(0n);
      c.localSet(N);
      c.globalGet(ND);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(R);
      c.block();
      c.loop();
      c.localGet(R);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(N);
      this.pushDigit(c, (x) => x.localGet(R));
      c.i64ExtendI32U();
      c.localGet(0);
      c.i64ExtendI32U();
      c.i64Shl();
      c.i64Add();
      c.localSet(N);
      c.localGet(W);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(W);
      this.setDigit(c, (x) => x.localGet(W), (x) => {
        x.localGet(N);
        x.i64Const(10n);
        x.i64RemU();
        x.i32WrapI64();
      });
      c.localGet(N);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(N);
      c.localGet(R);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(R);
      c.br(0);
      c.end();
      c.end();
      c.block();
      c.loop();
      c.localGet(N);
      c.i64Eqz();
      c.brIf(1);
      c.localGet(W);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(W);
      this.setDigit(c, (x) => x.localGet(W), (x) => {
        x.localGet(N);
        x.i64Const(10n);
        x.i64RemU();
        x.i32WrapI64();
      });
      c.localGet(N);
      c.i64Const(10n);
      c.i64DivU();
      c.localSet(N);
      c.br(0);
      c.end();
      c.end();
      // Slide [W, END) down to 0 and account for the digits gained.
      c.globalGet(DP);
      c.localGet(END);
      c.localGet(W);
      c.i32Sub();
      c.globalGet(ND);
      c.i32Sub();
      c.i32Add();
      c.globalSet(DP);
      c.localGet(END);
      c.localGet(W);
      c.i32Sub();
      c.globalSet(ND);
      c.globalGet(this.sdcBuf().global);
      c.i32Const(0);
      c.globalGet(this.sdcBuf().global);
      c.localGet(W);
      c.globalGet(ND);
      c.arrayCopy(this.sdcBuf().type, this.sdcBuf().type);
      c.call(this.sdcTrim());
      this.mb.setBody(idx, [I32, I32, I64, I32, I32], c.bytes());
    });
  }

  /** `%w.json.sdcShift(k)` — signed, in bounded steps. */
  private sdcShift(): number {
    return this.cached("sdcShift", [I32], [], (idx) => {
      const c = new Code();
      const K = 0;
      c.globalGet(this.i32Global("nd"));
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      const step = (dir: 1 | -1): void => {
        c.block();
        c.loop();
        c.localGet(K);
        c.i32Const(dir * JsonBuilder.SDC_MAX_SHIFT);
        if (dir > 0) c.i32LeS();
        else c.i32GeS();
        c.brIf(1);
        c.i32Const(JsonBuilder.SDC_MAX_SHIFT);
        c.call(dir > 0 ? this.sdcLShift() : this.sdcRShift());
        c.localGet(K);
        c.i32Const(dir * JsonBuilder.SDC_MAX_SHIFT);
        c.i32Sub();
        c.localSet(K);
        c.br(0);
        c.end();
        c.end();
      };
      c.localGet(K);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      step(1);
      c.localGet(K);
      c.call(this.sdcLShift());
      c.else_();
      c.localGet(K);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      step(-1);
      c.i32Const(0);
      c.localGet(K);
      c.i32Sub();
      c.call(this.sdcRShift());
      c.end();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** Round-half-even at digit position `n`: the digit there decides,
   * except an exact tie, which goes to the even neighbour — UNLESS the
   * sticky bit says digits were dropped, in which case the value is
   * strictly above the tie and rounds up. That consultation is what makes
   * truncation safe (see the exactness argument above). */
  private sdcRoundUp(): number {
    return this.cached("sdcRoundUp", [I32], [I32], (idx) => {
      const ND = this.i32Global("nd");
      const c = new Code();
      c.localGet(0);
      c.i32Const(0);
      c.i32LtS();
      c.localGet(0);
      c.globalGet(ND);
      c.i32GeS();
      c.i32Or();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      this.pushDigit(c, (x) => x.localGet(0));
      c.i32Const(5);
      c.i32Eq();
      c.localGet(0);
      c.i32Const(1);
      c.i32Add();
      c.globalGet(ND);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.globalGet(this.i32Global("trunc"));
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      // `n > 0 && d[n-1] is odd`, GUARDED. The reference spells this with
      // a short-circuiting &&; i32.and evaluates both sides, so the
      // literal transcription reads d[-1] at n == 0. That is reachable on
      // real input — exactly 2^-1075, the midpoint between zero and the
      // smallest subnormal, arrives here with n == 0 — and the read is an
      // UNCATCHABLE abort at the one place a program hands us untrusted
      // bytes. Fourth instance of this class in this file; see pushCurOr0.
      c.localGet(0);
      c.i32Const(0);
      c.i32GtS();
      c.ifResult(I32);
      this.pushDigit(c, (x) => {
        x.localGet(0);
        x.i32Const(1);
        x.i32Sub();
      });
      c.i32Const(1);
      c.i32And();
      c.else_();
      c.i32Const(0); // no preceding digit: zero is even, so round down
      c.end();
      c.return_();
      c.end();
      this.pushDigit(c, (x) => x.localGet(0));
      c.i32Const(5);
      c.i32GeS();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** The integer part as a u64, rounded per sdcRoundUp. */
  private sdcRoundedInt(): number {
    return this.cached("sdcRoundedInt", [], [I64], (idx) => {
      const ND = this.i32Global("nd");
      const DP = this.i32Global("dp");
      const c = new Code();
      const I = 0;
      const N = 1; // i64
      c.globalGet(DP);
      c.i32Const(20);
      c.i32GtS();
      c.ifVoid();
      c.i64Const(-1n); // 0xFFFF_FFFF_FFFF_FFFF
      c.return_();
      c.end();
      c.i64Const(0n);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.globalGet(DP);
      c.i32GeS();
      c.localGet(I);
      c.globalGet(ND);
      c.i32GeS();
      c.i32Or();
      c.brIf(1);
      c.localGet(N);
      c.i64Const(10n);
      c.i64Mul();
      this.pushDigit(c, (x) => x.localGet(I));
      c.i64ExtendI32U();
      c.i64Add();
      c.localSet(N);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.block();
      c.loop();
      c.localGet(I);
      c.globalGet(DP);
      c.i32GeS();
      c.brIf(1);
      c.localGet(N);
      c.i64Const(10n);
      c.i64Mul();
      c.localSet(N);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(N);
      c.globalGet(DP);
      c.call(this.sdcRoundUp());
      c.i64ExtendI32U();
      c.i64Add();
      this.mb.setBody(idx, [I32, I64], c.bytes());
    });
  }

  /** `%w.json.sdcInit(start, end)` — read the (already validated) literal
   * span into the exact decimal buffer. Leading zeros shift the decimal
   * point rather than occupying a slot, and digits past the buffer set the
   * sticky bit. */
  private sdcInit(): number {
    return this.cached("sdcInit", [I32, I32], [], (idx) => {
      const ND = this.i32Global("nd");
      const DP = this.i32Global("dp");
      const c = new Code();
      const I = 2;
      const U = 3;
      const SAWDOT = 4;
      const ESIGN = 5;
      const EV = 6;
      c.i32Const(0);
      c.globalSet(ND);
      c.i32Const(0);
      c.globalSet(DP);
      c.i32Const(0);
      c.globalSet(this.i32Global("trunc"));
      c.i32Const(0);
      c.globalSet(this.i32Global("neg"));
      c.i32Const(0);
      c.localSet(SAWDOT);
      c.localGet(0);
      c.localSet(I);
      this.pushAt(c, (x) => x.localGet(I));
      c.i32Const(0x2d);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.globalSet(this.i32Global("neg"));
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.end();
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(1);
      c.i32GeS();
      c.brIf(1);
      this.pushAt(c, (x) => x.localGet(I));
      c.localSet(U);
      c.localGet(U);
      c.i32Const(0x2e); // '.'
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(SAWDOT);
      c.globalGet(ND);
      c.globalSet(DP);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(1); // CONTINUE: if(0), loop(1), block(2)
      c.end();
      this.pushIsDigit(c, (x) => x.localGet(U));
      c.i32Eqz();
      c.brIf(1); // 'e' / 'E' ends the mantissa
      c.localGet(U);
      c.i32Const(0x30);
      c.i32Eq();
      c.globalGet(ND);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      // A leading zero moves the point instead of taking a slot.
      c.globalGet(DP);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(DP);
      c.else_();
      c.globalGet(ND);
      c.i32Const(JsonBuilder.SDC_DIGITS);
      c.i32LtS();
      c.ifVoid();
      this.setDigit(c, (x) => x.globalGet(ND), (x) => {
        x.localGet(U);
        x.i32Const(0x30);
        x.i32Sub();
      });
      c.globalGet(ND);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(ND);
      c.else_();
      c.localGet(U);
      c.i32Const(0x30);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(1);
      c.globalSet(this.i32Global("trunc"));
      c.end();
      c.end();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(SAWDOT);
      c.i32Eqz();
      c.ifVoid();
      c.globalGet(ND);
      c.globalSet(DP);
      c.end();
      // The explicit exponent just moves the point.
      c.localGet(I);
      c.localGet(1);
      c.i32LtS();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.i32Const(1);
      c.localSet(ESIGN);
      this.pushAt(c, (x) => x.localGet(I));
      c.i32Const(0x2b);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.end();
      this.pushAt(c, (x) => x.localGet(I));
      c.i32Const(0x2d);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(-1);
      c.localSet(ESIGN);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.end();
      c.i32Const(0);
      c.localSet(EV);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(1);
      c.i32GeS();
      c.brIf(1);
      c.localGet(EV);
      c.i32Const(100000);
      c.i32LtS();
      c.ifVoid();
      c.localGet(EV);
      c.i32Const(10);
      c.i32Mul();
      this.pushAt(c, (x) => x.localGet(I));
      c.i32Const(0x30);
      c.i32Sub();
      c.i32Add();
      c.localSet(EV);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(DP);
      c.localGet(EV);
      c.localGet(ESIGN);
      c.i32Mul();
      c.i32Add();
      c.globalSet(DP);
      c.end();
      c.call(this.sdcTrim());
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /** log2(10^i) rounded down, for i in [0, 8] — how far we may shift in
   * one step while approaching the target range. */
  private powtabG: number | null = null;
  private powtabT: number | null = null;

  private powtab(): { global: number; type: number } {
    if (this.powtabG === null) {
      const t = this.mb.arrayType(I32, false);
      this.powtabT = t;
      this.powtabG = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: t }, false, (w) => {
        for (const v of [1, 3, 6, 9, 13, 16, 19, 23, 26]) {
          w.u8(0x41);
          w.sleb(v);
        }
        w.u8(0xfb);
        w.uleb(0x08);
        w.uleb(t);
        w.uleb(9);
      });
    }
    return { global: this.powtabG, type: this.powtabT! };
  }

  /** `%w.json.sdc(start, end)` → the correctly-rounded double for the
   * validated literal in that span. */
  sdc(): number {
    return this.cached("sdc", [I32, I32], [F64], (idx) => {
      const ND = this.i32Global("nd");
      const DP = this.i32Global("dp");
      const NEG = this.i32Global("neg");
      const c = new Code();
      const EXP = 2;
      const MANT = 3; // i64
      const N = 4;
      const BITS = 5; // i64
      const pushSigned = (mk: (c: Code) => void): void => {
        c.globalGet(NEG);
        c.ifResult(F64);
        mk(c);
        c.f64Neg();
        c.else_();
        mk(c);
        c.end();
      };
      c.localGet(0);
      c.localGet(1);
      c.call(this.sdcInit());
      // Zero, and the ranges no double can reach.
      c.globalGet(ND);
      c.i32Eqz();
      c.globalGet(DP);
      c.i32Const(-330);
      c.i32LtS();
      c.i32Or();
      c.ifVoid();
      pushSigned((x) => x.f64Const(0));
      c.return_();
      c.end();
      c.globalGet(DP);
      c.i32Const(310);
      c.i32GtS();
      c.ifVoid();
      pushSigned((x) => x.f64Const(Infinity));
      c.return_();
      c.end();
      c.i32Const(0);
      c.localSet(EXP);
      // Scale down into [0.5, 1).
      c.block();
      c.loop();
      c.globalGet(DP);
      c.i32Const(0);
      c.i32LeS();
      c.brIf(1);
      c.globalGet(DP);
      c.i32Const(9);
      c.i32GeS();
      c.ifResult(I32);
      c.i32Const(27);
      c.else_();
      c.globalGet(this.powtab().global);
      c.globalGet(DP);
      c.arrayGet(this.powtab().type);
      c.end();
      c.localSet(N);
      c.i32Const(0);
      c.localGet(N);
      c.i32Sub();
      c.call(this.sdcShift());
      c.localGet(EXP);
      c.localGet(N);
      c.i32Add();
      c.localSet(EXP);
      c.br(0);
      c.end();
      c.end();
      // ...and up, until the leading digit is at least 5.
      c.block();
      c.loop();
      c.globalGet(DP);
      c.i32Const(0);
      c.i32LtS();
      c.globalGet(DP);
      c.i32Eqz();
      this.pushDigit(c, (x) => x.i32Const(0));
      c.i32Const(5);
      c.i32LtS();
      c.i32And();
      c.i32Or();
      c.i32Eqz();
      c.brIf(1);
      c.i32Const(0);
      c.globalGet(DP);
      c.i32Sub();
      c.i32Const(9);
      c.i32GeS();
      c.ifResult(I32);
      c.i32Const(27);
      c.else_();
      c.globalGet(this.powtab().global);
      c.i32Const(0);
      c.globalGet(DP);
      c.i32Sub();
      c.arrayGet(this.powtab().type);
      c.end();
      c.localSet(N);
      c.localGet(N);
      c.call(this.sdcShift());
      c.localGet(EXP);
      c.localGet(N);
      c.i32Sub();
      c.localSet(EXP);
      c.br(0);
      c.end();
      c.end();
      // [0.5,1) -> [1,2).
      c.localGet(EXP);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(EXP);
      // Subnormals: move back up to the minimum exponent.
      c.localGet(EXP);
      c.i32Const(-1022);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(-1022);
      c.localGet(EXP);
      c.i32Sub();
      c.localSet(N);
      c.i32Const(0);
      c.localGet(N);
      c.i32Sub();
      c.call(this.sdcShift());
      c.localGet(EXP);
      c.localGet(N);
      c.i32Add();
      c.localSet(EXP);
      c.end();
      c.localGet(EXP);
      c.i32Const(1023);
      c.i32Add();
      c.i32Const(2047);
      c.i32GeS();
      c.ifVoid();
      pushSigned((x) => x.f64Const(Infinity));
      c.return_();
      c.end();
      // Extract 1 + 52 bits and round ONCE.
      c.i32Const(53);
      c.call(this.sdcShift());
      c.call(this.sdcRoundedInt());
      c.localSet(MANT);
      c.localGet(MANT);
      c.i64Const(1n << 53n);
      c.i64Eq();
      c.ifVoid();
      c.localGet(MANT);
      c.i64Const(1n);
      c.i64ShrU();
      c.localSet(MANT);
      c.localGet(EXP);
      c.i32Const(1);
      c.i32Add();
      c.localSet(EXP);
      c.localGet(EXP);
      c.i32Const(1023);
      c.i32Add();
      c.i32Const(2047);
      c.i32GeS();
      c.ifVoid();
      pushSigned((x) => x.f64Const(Infinity));
      c.return_();
      c.end();
      c.end();
      // A missing hidden bit means the result is subnormal.
      c.localGet(MANT);
      c.i64Const(1n << 52n);
      c.i64And();
      c.i64Eqz();
      c.ifVoid();
      c.i32Const(-1023);
      c.localSet(EXP);
      c.end();
      c.localGet(MANT);
      c.i64Const((1n << 52n) - 1n);
      c.i64And();
      c.localGet(EXP);
      c.i32Const(1023);
      c.i32Add();
      c.i32Const(2047);
      c.i32And();
      c.i64ExtendI32U();
      c.i64Const(52n);
      c.i64Shl();
      c.i64Or();
      c.localSet(BITS);
      c.globalGet(NEG);
      c.ifVoid();
      c.localGet(BITS);
      c.i64Const(-(1n << 63n)); // the sign bit, as sleb's signed spelling
      c.i64Or();
      c.localSet(BITS);
      c.end();
      c.localGet(BITS);
      c.f64ReinterpretI64();
      this.mb.setBody(idx, [I32, I64, I32, I64], c.bytes());
    });
  }

  /** Drop the source reference on the way out. The parser holds it in a
   * global, so without this the LAST string ever parsed stays reachable
   * for the module's lifetime — a JSON config read once at startup would
   * be pinned forever. Every exit path clears it, the throwing ones
   * included. */
  private emitReleaseSrc(c: Code): void {
    c.refNull(this.deps.strType());
    c.globalSet(this.src());
  }

  /** `%w.json.parse(text)` → the dyn tree, or a pending SyntaxError. THE
   * entry point the `json.parse` libCall lowers to. */
  parse(): number {
    return this.cached("parse", [this.deps.strRef()], [this.deps.dyn().dynRef()], (idx) => {
      const dyn = this.deps.dyn();
      const dynT = dyn.dynT();
      const c = new Code();
      const D = 1;
      c.localGet(0);
      c.globalSet(this.src());
      c.i32Const(0);
      c.globalSet(this.pos());
      c.i32Const(0);
      c.globalSet(this.depth());
      c.call(this.ws());
      this.pushHasMore(c);
      c.i32Eqz();
      c.ifVoid();
      c.call(this.throwEnd());
      this.emitReleaseSrc(c);
      c.refNull(dynT);
      c.return_();
      c.end();
      c.call(this.jvalue());
      c.localSet(D);
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      this.emitReleaseSrc(c);
      c.refNull(dynT);
      c.return_();
      c.end();
      c.call(this.ws());
      this.pushHasMore(c);
      c.ifVoid();
      this.emitThrowAtLit(c, "Unexpected non-whitespace character after JSON", (x) =>
        x.globalGet(this.pos()), false,
      );
      this.emitReleaseSrc(c);
      c.refNull(dynT);
      c.return_();
      c.end();
      this.emitReleaseSrc(c);
      c.localGet(D);
      this.mb.setBody(idx, [dyn.dynRef()], c.bytes());
    });
  }

  /* ── JSON.stringify: the output buffer ──────────────────────────────────
   * C's ScrJsonBuf, with the struct pointer elided the same way the
   * parser elides its ScrJsonP: TWO MODULE GLOBALS, a growing UTF-16
   * array and a fill length. The emitted type-directed serializers (the
   * emitter's `%w.json.write:<typeKey>` family, C's sc_jw_*) write
   * through these; `jbFinish` copies the filled prefix into an
   * exact-length string and hands it back.
   *
   * NON-REENTRANCY is the same argument the parser makes, and it has to
   * hold for the globals to be sound: no user code can run mid-walk. A
   * `toJSON` method and a replacer function are the two things that
   * could, and both are FRONTEND-fenced (lower-builtins.ts) — they never
   * reach any backend. A closure sitting in a serialized composite is
   * dropped UNCALLED. The one nesting that does occur —
   * `JSON.stringify({ a: JSON.stringify(b) })` — is not reentrancy: the
   * inner call finishes (and so resets the buffer) while evaluating the
   * ARGUMENT, strictly before the outer call's prologue zeroes the
   * length.
   *
   * The buffer SURVIVES finish (a stringify loop then allocates once
   * rather than doubling its way up every round), which is C's size-hint
   * discipline with the hint being the allocation itself — and bounded
   * the same way: one giant document must not pin a big array for the
   * module's lifetime, so a buffer grown past 2^16 units is dropped
   * instead of kept. */

  private jbBufG: number | null = null;
  private jbLenG: number | null = null;

  private jbBuf(): number {
    this.jbBufG ??= this.mb.addGlobal(this.deps.strRef(), true, (w) => {
      w.u8(0xd0);
      w.sleb(this.deps.strType());
    });
    return this.jbBufG;
  }

  private jbLen(): number {
    this.jbLenG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.jbLenG;
  }

  /** `%w.json.jbBegin()` — the serializer prologue: an empty buffer. The
   * grown array stays for reuse. Every stringify SITE calls this rather
   * than trusting the previous finish, because a walk that unwinds
   * mid-way (the circular-structure throw, once cycle-capable roots
   * land) never reaches its finish. */
  jbBegin(): number {
    return this.cached("jbBegin", [], [], (idx) => {
      const c = new Code();
      c.i32Const(0);
      c.globalSet(this.jbLen());
      c.i32Const(0);
      c.globalSet(this.seenLen());
      c.i32Const(0);
      c.globalSet(this.jbDepth());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.json.jbEnsure(need)` — room for `need` more units, growing by
   * doubling from a 64-unit floor. */
  private jbEnsure(): number {
    return this.cached("jbEnsure", [I32], [], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const NEED = 0;
      const WANT = 1;
      const CAP = 2;
      const NB = 3;
      // First fill: max(64, need) — the floor is C's initial hint.
      c.globalGet(this.jbBuf());
      c.refIsNull();
      c.ifVoid();
      c.i32Const(64);
      c.localGet(NEED);
      c.i32LtU();
      c.ifResult(I32);
      c.localGet(NEED);
      c.else_();
      c.i32Const(64);
      c.end();
      c.arrayNewDefault(strT);
      c.globalSet(this.jbBuf());
      c.return_();
      c.end();
      c.globalGet(this.jbLen());
      c.localGet(NEED);
      c.i32Add();
      c.localSet(WANT);
      c.localGet(WANT);
      c.globalGet(this.jbBuf());
      c.arrayLen();
      c.i32LeU();
      c.ifVoid();
      c.return_();
      c.end();
      c.globalGet(this.jbBuf());
      c.arrayLen();
      c.localSet(CAP);
      c.block();
      c.loop();
      c.localGet(CAP);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(CAP);
      c.localGet(CAP);
      c.localGet(WANT);
      c.i32GeU();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      c.localGet(CAP);
      c.arrayNewDefault(strT);
      c.localSet(NB);
      c.localGet(NB);
      c.i32Const(0);
      c.globalGet(this.jbBuf());
      c.i32Const(0);
      c.globalGet(this.jbLen());
      c.arrayCopy(strT, strT);
      c.localGet(NB);
      c.globalSet(this.jbBuf());
      this.mb.setBody(idx, [I32, I32, this.deps.strRef()], c.bytes());
    });
  }

  /** `%w.json.jbPutc(unit)` — one code unit. */
  jbPutc(): number {
    return this.cached("jbPutc", [I32], [], (idx) => {
      const c = new Code();
      c.i32Const(1);
      c.call(this.jbEnsure());
      c.globalGet(this.jbBuf());
      c.globalGet(this.jbLen());
      c.localGet(0);
      c.arraySet(this.deps.strType());
      c.globalGet(this.jbLen());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.jbLen());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.json.jbPuts(s)` — a whole string, VERBATIM (no escaping): the
   * literal syntax the serializers emit around their values, and the
   * digits `jbPutF64` produces. */
  jbPuts(): number {
    return this.cached("jbPuts", [this.deps.strRef()], [], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const N = 1;
      c.localGet(0);
      c.arrayLen();
      c.localSet(N);
      // array.copy null-traps on either side whatever the length, and an
      // empty literal would otherwise force a first allocation.
      c.localGet(N);
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(N);
      c.call(this.jbEnsure());
      c.globalGet(this.jbBuf());
      c.globalGet(this.jbLen());
      c.localGet(0);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(strT, strT);
      c.globalGet(this.jbLen());
      c.localGet(N);
      c.i32Add();
      c.globalSet(this.jbLen());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.json.jbPutF64(v)` — JSON's number rule: non-finite serializes as
   * `null` (JSON has no NaN or Infinity), zero as `0` (which is where -0
   * loses its sign, exactly like Node), everything else as the shortest
   * round-trip digits `String(v)` would give. */
  jbPutF64(): number {
    return this.cached("jbPutF64", [F64], [], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.localGet(0);
      c.f64Ne(); // NaN
      c.localGet(0);
      c.f64Const(Infinity);
      c.f64Eq();
      c.i32Or();
      c.localGet(0);
      c.f64Const(-Infinity);
      c.f64Eq();
      c.i32Or();
      c.ifVoid();
      this.deps.lit(c, "null");
      c.call(this.jbPuts());
      c.return_();
      c.end();
      c.localGet(0);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(0x30);
      c.call(this.jbPutc());
      c.return_();
      c.end();
      c.localGet(0);
      c.call(this.deps.f64ToStr());
      c.call(this.jbPuts());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.json.jbHex4(unit)` — `\uXXXX`, four LOWERCASE hex digits, which
   * is the case V8 emits (verified against Node 24.18, not assumed). */
  private jbHex4(): number {
    return this.cached("jbHex4", [I32], [], (idx) => {
      const c = new Code();
      const D = 1;
      c.i32Const(0x5c);
      c.call(this.jbPutc());
      c.i32Const(0x75);
      c.call(this.jbPutc());
      for (const shift of [12, 8, 4, 0]) {
        c.localGet(0);
        if (shift !== 0) {
          c.i32Const(shift);
          c.i32ShrU();
        }
        c.i32Const(0xf);
        c.i32And();
        c.localSet(D);
        c.localGet(D);
        c.i32Const(10);
        c.i32LtU();
        c.ifResult(I32);
        c.localGet(D);
        c.i32Const(0x30); // '0'
        c.i32Add();
        c.else_();
        c.localGet(D);
        c.i32Const(0x57); // 10 + 0x57 == 'a'
        c.i32Add();
        c.end();
        c.call(this.jbPutc());
      }
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.json.jbPutStr(s)` — a quoted, escaped JSON string.
   *
   * THIS IS NODE'S WELL-FORMED JSON.stringify (ES2019), NOT THE C
   * RUNTIME'S RULE, and the difference is the same one S002 draws for the
   * parse side. C walks UTF-8 BYTES whose storage already substituted
   * U+FFFD for anything unpaired, so it never has a surrogate to decide
   * about; this tier stores real UTF-16 units, so a lone surrogate
   * reaches here intact and must escape — `JSON.stringify("\ud800")` is
   * `"\ud800"` in Node, and the result is well-formed UTF-8 wherever it
   * is written. A surrogate PAIR passes through as its two units, since
   * together they encode a real character.
   *
   * Per unit: `"` and `\` take their two-character escape; \b \f \n \r \t
   * take theirs; anything else below 0x20 takes `\u00xx`; an UNPAIRED
   * surrogate half takes `\uXXXX`; everything else — DEL and every
   * non-ASCII character included — passes verbatim. */
  jbPutStr(): number {
    return this.cached("jbPutStr", [this.deps.strRef()], [], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const N = 1;
      const I = 2;
      const U = 3;
      const V = 4;
      const P = 5;
      c.i32Const(0x22);
      c.call(this.jbPutc());
      c.localGet(0);
      c.arrayLen();
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.block(); // OUTER
      c.loop(); // LOOP
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(U);
      c.block(); // UNIT — every arm leaves through this block's end
      // '"' and '\': a backslash, then the unit itself.
      c.localGet(U);
      c.i32Const(0x22);
      c.i32Eq();
      c.localGet(U);
      c.i32Const(0x5c);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.i32Const(0x5c);
      c.call(this.jbPutc());
      c.localGet(U);
      c.call(this.jbPutc());
      c.br(1);
      c.end();
      // Control characters: five have a named escape, the rest go hex.
      c.localGet(U);
      c.i32Const(0x20);
      c.i32LtU();
      c.ifVoid();
      for (const [ctrl, letter] of [
        [0x08, 0x62], // \b
        [0x0c, 0x66], // \f
        [0x0a, 0x6e], // \n
        [0x0d, 0x72], // \r
        [0x09, 0x74], // \t
      ]) {
        c.localGet(U);
        c.i32Const(ctrl!);
        c.i32Eq();
        c.ifVoid();
        c.i32Const(0x5c);
        c.call(this.jbPutc());
        c.i32Const(letter!);
        c.call(this.jbPutc());
        c.br(2);
        c.end();
      }
      c.localGet(U);
      c.call(this.jbHex4());
      c.br(1);
      c.end();
      // A surrogate half (0xD800-0xDFFF): verbatim only if it is half of
      // a PAIR. A high half pairs with the unit after it, a low half with
      // the unit before it — and because a high half consumes exactly the
      // low that follows it, "the previous unit is a high half" is an
      // exact test for the low side, not an approximation.
      c.localGet(U);
      c.i32Const(0xf800);
      c.i32And();
      c.i32Const(0xd800);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(P);
      c.localGet(U);
      c.i32Const(0x0400);
      c.i32And();
      c.i32Eqz(); // high half
      c.ifVoid();
      // The bounds test and the peek CANNOT be one i32.and: wasm
      // evaluates both operands, and the peek reads the array — at the
      // last unit that is an out-of-bounds trap. Hence the if-chain.
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(N);
      c.i32LtU();
      c.ifVoid();
      c.localGet(0);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strT);
      c.localSet(V);
      c.localGet(V);
      c.i32Const(0xfc00);
      c.i32And();
      c.i32Const(0xdc00);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(P);
      c.end();
      c.end();
      c.else_();
      // Low half: the same if-chain backwards (index 0 has no previous).
      c.localGet(I);
      c.i32Const(0);
      c.i32GtU();
      c.ifVoid();
      c.localGet(0);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(strT);
      c.localSet(V);
      c.localGet(V);
      c.i32Const(0xfc00);
      c.i32And();
      c.i32Const(0xd800);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(P);
      c.end();
      c.end();
      c.end();
      c.localGet(P);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(U);
      c.call(this.jbHex4());
      c.br(2);
      c.end();
      c.end();
      c.localGet(U);
      c.call(this.jbPutc());
      c.end(); // UNIT
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end(); // LOOP
      c.end(); // OUTER
      c.i32Const(0x22);
      c.call(this.jbPutc());
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /** `%w.json.jbFinish()` → the buffered text as a fresh string, with the
   * buffer emptied for the next document. */
  jbFinish(): number {
    return this.cached("jbFinish", [], [this.deps.strRef()], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const L = 0;
      const R = 1;
      c.globalGet(this.jbLen());
      c.localSet(L);
      c.localGet(L);
      c.arrayNewDefault(strT);
      c.localSet(R);
      // array.copy traps on a null side regardless of length, and an
      // untouched buffer IS null — so the empty document skips the copy.
      c.localGet(L);
      c.ifVoid();
      c.localGet(R);
      c.i32Const(0);
      c.globalGet(this.jbBuf());
      c.i32Const(0);
      c.localGet(L);
      c.arrayCopy(strT, strT);
      c.end();
      c.i32Const(0);
      c.globalSet(this.jbLen());
      // The hint bound: keep an ordinary buffer for the next document,
      // drop one that a giant document grew (the null test and the length
      // read are an if-chain for the usual reason — array.len null-traps).
      c.globalGet(this.jbBuf());
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.globalGet(this.jbBuf());
      c.arrayLen();
      c.i32Const(1 << 16);
      c.i32GtU();
      c.ifVoid();
      c.refNull(strT);
      c.globalSet(this.jbBuf());
      c.end();
      c.end();
      c.localGet(R);
      this.mb.setBody(idx, [I32, this.deps.strRef()], c.bytes());
    });
  }

  /* ── JSON.stringify: the pretty-print re-indenter ───────────────────────
   * `JSON.stringify(v, null, space)` as a REWRITE of the compact text —
   * C's sc_ji (emit-walkers.ts jsonIndentHelper) ported unit for unit,
   * which is Node's gap algorithm. Structural '{' / '[' open a newline
   * and one more level of indent unless immediately closed (`{}` and `[]`
   * stay inline, like Node), '}' / ']' close onto their own line at the
   * outer depth, ',' breaks the line, and the key ':' gains one space.
   * String state (with escape skipping) keeps braces, commas and colons
   * that live INSIDE a JSON string untouched.
   *
   * The input is this module's own compact output, so it is well-formed
   * by construction and the state machine needs no error paths. An empty
   * indent never reaches here — the frontend drops the property. */

  /** `%w.json.jbNewline(indent, depth)` — a line break and `depth`
   * copies of the indent unit string. */
  private jbNewline(): number {
    return this.cached("jbNewline", [this.deps.strRef(), I32], [], (idx) => {
      const c = new Code();
      const T = 2;
      c.i32Const(0x0a);
      c.call(this.jbPutc());
      c.i32Const(0);
      c.localSet(T);
      c.block();
      c.loop();
      c.localGet(T);
      c.localGet(1);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.call(this.jbPuts());
      c.localGet(T);
      c.i32Const(1);
      c.i32Add();
      c.localSet(T);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.json.indent(compact, indent)` → the pretty-printed text. */
  indent(): number {
    const strRef = this.deps.strRef();
    return this.cached("indent", [strRef, strRef], [strRef], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const N = 2;
      const I = 3;
      const U = 4;
      const V = 5;
      const D = 6;
      const INSTR = 7;
      c.call(this.jbBegin());
      c.localGet(0);
      c.arrayLen();
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);
      c.i32Const(0);
      c.localSet(D);
      c.i32Const(0);
      c.localSet(INSTR);
      c.block(); // OUTER
      c.loop(); // LOOP
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(0);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(U);
      c.block(); // UNIT
      // Inside a string: copy verbatim, and copy the unit after a
      // backslash with it so an escaped quote cannot end the string.
      c.localGet(INSTR);
      c.ifVoid();
      c.localGet(U);
      c.call(this.jbPutc());
      c.localGet(U);
      c.i32Const(0x5c);
      c.i32Eq();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(N);
      c.i32LtU();
      c.i32And(); // both operands are pure compares — no array read
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.localGet(0);
      c.localGet(I);
      c.arrayGetU(strT);
      c.call(this.jbPutc());
      c.br(2);
      c.end();
      c.localGet(U);
      c.i32Const(0x22);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(INSTR);
      c.end();
      c.br(1);
      c.end();
      // An opening quote.
      c.localGet(U);
      c.i32Const(0x22);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(INSTR);
      c.localGet(U);
      c.call(this.jbPutc());
      c.br(1);
      c.end();
      // '{' or '[' — an empty container stays on one line.
      c.localGet(U);
      c.i32Const(0x7b);
      c.i32Eq();
      c.localGet(U);
      c.i32Const(0x5b);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.localGet(U);
      c.call(this.jbPutc());
      // The peek reads the array, so bounds and content are an if-chain.
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(N);
      c.i32LtU();
      c.ifVoid();
      c.localGet(0);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strT);
      c.localSet(V);
      // '}' is '{' + 2 and ']' is '[' + 2, so one compare closes both.
      c.localGet(V);
      c.localGet(U);
      c.i32Const(2);
      c.i32Add();
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.localGet(V);
      c.call(this.jbPutc());
      c.br(3);
      c.end();
      c.end();
      c.localGet(D);
      c.i32Const(1);
      c.i32Add();
      c.localSet(D);
      c.localGet(1);
      c.localGet(D);
      c.call(this.jbNewline());
      c.br(1);
      c.end();
      // '}' or ']' — close at the OUTER depth.
      c.localGet(U);
      c.i32Const(0x7d);
      c.i32Eq();
      c.localGet(U);
      c.i32Const(0x5d);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.localGet(D);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(D);
      c.localGet(1);
      c.localGet(D);
      c.call(this.jbNewline());
      c.localGet(U);
      c.call(this.jbPutc());
      c.br(1);
      c.end();
      // ',' breaks the line at the current depth.
      c.localGet(U);
      c.i32Const(0x2c);
      c.i32Eq();
      c.ifVoid();
      c.localGet(U);
      c.call(this.jbPutc());
      c.localGet(1);
      c.localGet(D);
      c.call(this.jbNewline());
      c.br(1);
      c.end();
      // The key ':' gains one space.
      c.localGet(U);
      c.i32Const(0x3a);
      c.i32Eq();
      c.ifVoid();
      c.localGet(U);
      c.call(this.jbPutc());
      c.i32Const(0x20);
      c.call(this.jbPutc());
      c.br(1);
      c.end();
      c.localGet(U);
      c.call(this.jbPutc());
      c.end(); // UNIT
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end(); // LOOP
      c.end(); // OUTER
      c.call(this.jbFinish());
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /* ── circular-structure detection ───────────────────────────────────────
   * A RECURSIVE type admits runtime reference cycles, and stringifying a
   * cyclic value throws V8's exact TypeError. The emitted walkers over
   * cycle-CAPABLE containers bracket their bodies with enter/leave and
   * stamp the current edge before each cycle-capable member; acyclic
   * types pay nothing at all. C's scr_jb_enter/leave/edge_* ported.
   *
   * Detection is STACK membership, not "seen anywhere": a DAG serializes
   * its shared subtree twice, exactly like Node, and only a path back to
   * an ANCESTOR is circular.
   *
   * The message mirrors V8's ConstructCircularStructureErrorMessage byte
   * for byte — the starting object where the repeat lands, one line per
   * hop up to the top of the stack, the middle elided as "..." when there
   * are more than three hops (first two and the last one survive), then
   * the closing edge. Constructor names are only ever 'Object' or
   * 'Array', which is all a JSON-safe type can be. Verified against Node
   * 24.18 on every shape the corpus program exercises plus the ellipsis
   * boundary, by diffing whole program outputs — not inferred from the C
   * source, which is merely where the algorithm came from. */

  private seenEntT: number | null = null;
  private seenArrT: number | null = null;
  private seenG: number | null = null;
  private seenLenG: number | null = null;

  /** One frame: the container's identity, whether it prints as an Array,
   * and the edge LEAVING it (a property name, or an index when the name
   * is null). The edge fields are stamped as the walk moves. */
  private seenEnt(): number {
    this.seenEntT ??= this.mb.openStructType("json:seen", [
      { storage: EQ_REF, mutable: true },
      { storage: I32, mutable: true },
      { storage: this.deps.strRef(), mutable: true },
      { storage: I32, mutable: true },
    ]);
    return this.seenEntT;
  }

  private seenArr(): number {
    if (this.seenArrT === null) {
      this.seenArrT = this.mb.arrayType({ kind: "ref", nullable: true, typeIndex: this.seenEnt() }, true);
    }
    return this.seenArrT;
  }

  private seen(): number {
    this.seenG ??= this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: this.seenArr() }, true, (w) => {
      w.u8(0xd0);
      w.sleb(this.seenArr());
    });
    return this.seenG;
  }

  private seenLen(): number {
    this.seenLenG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.seenLenG;
  }

  /** The top frame, which every edge stamp writes into. */
  private pushTop(c: Code): void {
    c.globalGet(this.seen());
    c.globalGet(this.seenLen());
    c.i32Const(1);
    c.i32Sub();
    c.arrayGet(this.seenArr());
    c.refAsNonNull();
  }

  /** `%w.json.jbEdgeProp(name)` — the top frame leaves by a PROPERTY. */
  jbEdgeProp(): number {
    return this.cached("jbEdgeProp", [this.deps.strRef()], [], (idx) => {
      const c = new Code();
      this.pushTop(c);
      c.localGet(0);
      c.structSet(this.seenEnt(), SEEN_PROP);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.json.jbEdgeIdx(i)` — the top frame leaves by an INDEX. A null
   * property is what marks the edge as an index one. */
  jbEdgeIdx(): number {
    return this.cached("jbEdgeIdx", [I32], [], (idx) => {
      const c = new Code();
      this.pushTop(c);
      c.refNull(this.deps.strType());
      c.structSet(this.seenEnt(), SEEN_PROP);
      this.pushTop(c);
      c.localGet(0);
      c.structSet(this.seenEnt(), SEEN_INDEX);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.json.jbLeave()` — pop the frame and the depth it claimed. */
  jbLeave(): number {
    return this.cached("jbLeave", [], [], (idx) => {
      const c = new Code();
      c.globalGet(this.seenLen());
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(this.seenLen());
      this.emitDepthLeave(c);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** One frame's edge, rendered: `property 'x'` or `index 3`. */
  private circEdge(): number {
    return this.cached("circEdge", [I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const E = 1;
      c.globalGet(this.seen());
      c.localGet(0);
      c.arrayGet(this.seenArr());
      c.refAsNonNull();
      c.localSet(E);
      c.localGet(E);
      c.structGet(this.seenEnt(), SEEN_PROP);
      c.refIsNull();
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "index ");
      c.localGet(E);
      c.structGet(this.seenEnt(), SEEN_INDEX);
      c.f64ConvertI32S();
      c.call(this.deps.f64ToStr());
      c.call(this.deps.concat());
      c.else_();
      this.deps.lit(c, "property '");
      c.localGet(E);
      c.structGet(this.seenEnt(), SEEN_PROP);
      c.call(this.deps.concat());
      this.deps.lit(c, "'");
      c.call(this.deps.concat());
      c.end();
      this.mb.setBody(idx, [{ kind: "ref", nullable: true, typeIndex: this.seenEnt() }], c.bytes());
    });
  }

  /** One frame's constructor clause. JSON-safe types reach exactly two. */
  private circCtor(): number {
    return this.cached("circCtor", [I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      c.globalGet(this.seen());
      c.localGet(0);
      c.arrayGet(this.seenArr());
      c.refAsNonNull();
      c.structGet(this.seenEnt(), SEEN_IS_ARRAY);
      c.ifResult(this.deps.strRef());
      this.deps.lit(c, "object with constructor 'Array'");
      c.else_();
      this.deps.lit(c, "object with constructor 'Object'");
      c.end();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** V8's message for a repeat found at stack position `i`. */
  private circMsg(): number {
    return this.cached("circMsg", [I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const M = 1; // the accumulator
      const N = 2;
      const J = 3;
      const HOPS = 4;
      const cat = (): void => {
        c.call(this.deps.concat());
        c.localSet(M);
      };
      this.deps.lit(c, "Converting circular structure to JSON\n    --> starting at ");
      c.localSet(M);
      c.localGet(M);
      c.localGet(0);
      c.call(this.circCtor());
      cat();
      c.globalGet(this.seenLen());
      c.localSet(N);
      // Intermediate lines are j = i+1 .. n-1; more than three of them
      // and the middle elides, keeping the first two and the last.
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(0);
      c.i32Sub();
      c.localSet(HOPS);
      c.localGet(0);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      // The elision test reads only locals, so one i32.and is safe here.
      c.localGet(HOPS);
      c.i32Const(3);
      c.i32GtU();
      c.localGet(J);
      c.localGet(0);
      c.i32Const(1);
      c.i32Add();
      c.i32Sub();
      c.i32Const(2);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.localGet(M);
      this.deps.lit(c, "\n    |     ...");
      cat();
      // Resume at the LAST hop (the loop's own increment lands on it).
      c.localGet(N);
      c.i32Const(2);
      c.i32Sub();
      c.localSet(J);
      c.else_();
      c.localGet(M);
      this.deps.lit(c, "\n    |     ");
      cat();
      c.localGet(M);
      c.localGet(J);
      c.i32Const(1);
      c.i32Sub();
      c.call(this.circEdge());
      cat();
      c.localGet(M);
      this.deps.lit(c, " -> ");
      cat();
      c.localGet(M);
      c.localGet(J);
      c.call(this.circCtor());
      cat();
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(M);
      this.deps.lit(c, "\n    --- ");
      cat();
      c.localGet(M);
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.call(this.circEdge());
      cat();
      c.localGet(M);
      this.deps.lit(c, " closes the circle");
      cat();
      c.localGet(M);
      this.mb.setBody(idx, [this.deps.strRef(), I32, I32, I32], c.bytes());
    });
  }

  /** `%w.json.jbEnter(v, isArray)` → 1 to proceed, 0 with a pending
   * error — the circular-structure TypeError, or the depth cap's
   * RangeError.
   *
   * THE DEPTH CAP RIDES HERE for the same reason the seen stack does: a
   * walker for a recursive TYPE is recursive at RUNTIME, so a deep but
   * perfectly ACYCLIC value recurses without bound. Left unguarded that
   * exhausts the wasm stack as an UNCATCHABLE trap — measured at between
   * 5000 and 10000 links, with the program's own `try` never running —
   * where Node throws a catchable RangeError. Sharing S026's counter
   * turns that into the same catchable failure the dyn walker already
   * gives, at the same documented depth. A type that is NOT cycle-capable
   * never reaches here and pays nothing, which is exactly right: its
   * nesting is bounded by its own type structure. */
  jbEnter(): number {
    return this.cached("jbEnter", [EQ_REF, I32], [I32], (idx) => {
      const entT = this.seenEnt();
      const arrT = this.seenArr();
      const c = new Code();
      const I = 2;
      const N = 3;
      const NA = 4;
      const E = 5;
      // THE FIRST THROW WINS. The cell is filled unconditionally, so a
      // walk that keeps going after one failure overwrites the message
      // with whatever fails next: `x.a = x; x.b = x` would report the
      // edge Node does not (`property 'b'` for Node's `property 'a'`),
      // and a sibling's depth RangeError would overwrite a circular
      // TypeError outright, which an `instanceof TypeError` catch then
      // misses. Both were measured before this guard existed. Bailing
      // here short-circuits the rest of the walk through the 0-return
      // paths every caller already handles. Nothing pre-existing can be
      // pending: the site evaluates its value before the prologue, so
      // the cell is clear when the walk starts.
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      this.emitDepthEnter(c);
      c.globalGet(this.seenLen());
      c.localSet(N);
      // Already on the stack? Then this edge closes a circle.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.globalGet(this.seen());
      c.localGet(I);
      c.arrayGet(arrT);
      c.refAsNonNull();
      c.structGet(entT, SEEN_PTR);
      c.localGet(0);
      c.refEq();
      c.ifVoid();
      this.deps.throwError(c, "%TypeError", "TypeError", (x) => {
        x.localGet(I);
        x.call(this.circMsg());
      });
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
      // Room for one more frame (grow by doubling from 8), then fill it.
      // Frames are REUSED across pushes: the struct in a slot outlives
      // the pop, so a deep acyclic walk allocates the stack once instead
      // of once per container.
      c.globalGet(this.seen());
      c.refIsNull();
      c.ifVoid();
      c.i32Const(8);
      c.arrayNewDefault(arrT);
      c.globalSet(this.seen());
      c.end();
      c.globalGet(this.seen());
      c.arrayLen();
      c.localGet(N);
      c.i32LeU();
      c.ifVoid();
      c.globalGet(this.seen());
      c.arrayLen();
      c.i32Const(1);
      c.i32Shl();
      c.arrayNewDefault(arrT);
      c.localSet(NA);
      c.localGet(NA);
      c.i32Const(0);
      c.globalGet(this.seen());
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(arrT, arrT);
      c.localGet(NA);
      c.globalSet(this.seen());
      c.end();
      c.globalGet(this.seen());
      c.localGet(N);
      c.arrayGet(arrT);
      c.localSet(E);
      c.localGet(E);
      c.refIsNull();
      c.ifVoid();
      c.localGet(0);
      c.localGet(1);
      c.refNull(this.deps.strType());
      c.i32Const(0);
      c.structNew(entT);
      c.localSet(E);
      c.globalGet(this.seen());
      c.localGet(N);
      c.localGet(E);
      c.arraySet(arrT);
      c.else_();
      c.localGet(E);
      c.localGet(0);
      c.structSet(entT, SEEN_PTR);
      c.localGet(E);
      c.localGet(1);
      c.structSet(entT, SEEN_IS_ARRAY);
      c.localGet(E);
      c.refNull(this.deps.strType());
      c.structSet(entT, SEEN_PROP);
      c.localGet(E);
      c.i32Const(0);
      c.structSet(entT, SEEN_INDEX);
      c.end();
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.seenLen());
      c.i32Const(1);
      this.mb.setBody(
        idx,
        [I32, I32, { kind: "ref", nullable: true, typeIndex: arrT }, { kind: "ref", nullable: true, typeIndex: entT }],
        c.bytes(),
      );
    });
  }

  /* ── JSON.stringify over a DYN root ─────────────────────────────────────
   * The runtime walk the type-directed serializers exist to avoid. A dyn
   * value has no static type, so the tree's own kinds drive the walk —
   * C's `scr_dyn_json_write`, ported with three deliberate differences,
   * each argued where it happens:
   *
   *  - KEY ORDER IS JS OWN-KEY ORDER, not the entry table's. C walks
   *    `d->v.obj.entries` in insertion order, which reorders nothing;
   *    Node's stringify uses EnumerableOwnPropertyNames, so integer-like
   *    keys come out ascending FIRST whatever order they went in
   *    (`JSON.stringify(JSON.parse('{"2":1,"1":2}'))` is `{"1":2,"2":1}`
   *    in Node — measured, not assumed). This tier already answers that
   *    order for `Object.keys`, so the walk goes through the same
   *    `objWalk` rather than growing a second, subtly different copy of
   *    the rule. C's raw-order walk is a native-lane divergence, tracked
   *    separately.
   *  - NO PROBE BUFFER. C serializes each member into a scratch buffer
   *    first to discover whether it was absent, because a JSVAL member's
   *    presence is only known once the engine has been asked. No dyn tree
   *    here can hold a JSVAL, so absence is exactly `kind is UNDEF or
   *    FUNC` and a kind test decides it before a byte is written.
   *  - BYTES / HANDLE / JSVAL ARMS ARE `unreachable`. None is
   *    constructible on this tier; an honest trap beats a silently wrong
   *    answer if that ever stops being true.
   *
   * THE DEPTH CAP IS SEMANTICS.md S026. Both Node and this walker cap
   * stringify recursion and both report `RangeError: Maximum call stack
   * size exceeded` — the kind and the text agree exactly. What differs is
   * the LIMIT: 1000 here regardless of anything, implementation-defined
   * and stack-dependent there. The entry has the measurements. */

  private jbDepthG: number | null = null;

  /** The stringify walker's recursion depth. Deliberately NOT the
   * parser's global: the two never run at once, but one counter serving
   * two unrelated state machines is a coupling with nothing to buy it. */
  private jbDepth(): number {
    this.jbDepthG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.jbDepthG;
  }

  /** depth += 1, and the cap check. Leaves nothing; the caller tests the
   * exception cell. A throwing exit does NOT decrement — the root entry
   * zeroes the counter, which is the parser's discipline too. */
  private emitDepthEnter(c: Code): void {
    c.globalGet(this.jbDepth());
    c.i32Const(1);
    c.i32Add();
    c.globalSet(this.jbDepth());
    c.globalGet(this.jbDepth());
    c.i32Const(MAX_DEPTH);
    c.i32GtS();
    c.ifVoid();
    // SEMANTICS.md S026. Node throws this same RangeError with this same
    // message for deep nesting; only the depth it happens at differs.
    this.deps.throwError(c, "%RangeError", "RangeError", (x) =>
      this.deps.lit(x, "Maximum call stack size exceeded"),
    );
    c.i32Const(0);
    c.return_();
    c.end();
  }

  private emitDepthLeave(c: Code): void {
    c.globalGet(this.jbDepth());
    c.i32Const(1);
    c.i32Sub();
    c.globalSet(this.jbDepth());
  }

  /** `%w.json.putDyn(d)` → 1 when the value serialized, 0 when it is
   * ABSENT under stringify (undefined and functions, C's `false` return).
   * The caller decides what absence means in its position: a dropped
   * ROOT becomes the text "undefined", an array SLOT becomes `null`, and
   * an object MEMBER vanishes with its key — all three exactly Node.
   *
   * A 0 return is meaningless while the exception cell is set, so every
   * recursive call tests the cell BEFORE reading the answer. */
  putDyn(): number {
    const dyn = this.deps.dyn();
    return this.cached("putDyn", [dyn.dynRef()], [I32], (idx) => {
      const dynT = dyn.dynT();
      const strT = this.deps.strType();
      const c = new Code();
      const K = 1; // the receiver's kind
      const V = 2; // the ARR payload, or the entries vector
      const N = 3;
      const I = 4;
      const ENTS = 5; // objWalk's result box
      const E = 6; // one element, or one [key, value] pair
      const P = 7; // the pair's payload vector
      const MK = 8; // one member's kind
      const FIRST = 9;
      const PRESENT = 10;
      c.localGet(0);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);

      // Absent under stringify. C returns false here and so do we; the
      // three callers differ only in what they do about it.
      this.emitKindArm(c, K, [DK.UNDEF, DK.FUNC], () => {
        c.i32Const(0);
        c.return_();
      });
      this.emitKindArm(c, K, [DK.NULL], () => {
        this.deps.lit(c, "null");
        c.call(this.jbPuts());
        c.i32Const(1);
        c.return_();
      });
      this.emitKindArm(c, K, [DK.BOOL], () => {
        // The flag widened into the num slot at box time (dyn.ts).
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.f64Const(0);
        c.f64Ne();
        c.ifResult(this.deps.strRef());
        this.deps.lit(c, "true");
        c.else_();
        this.deps.lit(c, "false");
        c.end();
        c.call(this.jbPuts());
        c.i32Const(1);
        c.return_();
      });
      this.emitKindArm(c, K, [DK.NUM], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_NUM);
        c.call(this.jbPutF64());
        c.i32Const(1);
        c.return_();
      });
      this.emitKindArm(c, K, [DK.STR], () => {
        c.localGet(0);
        c.structGet(dynT, DYN_REF);
        c.refCast(strT);
        c.call(this.jbPutStr());
        c.i32Const(1);
        c.return_();
      });
      // A promise has no own enumerable properties, so Node stringifies
      // one as an empty object.
      this.emitKindArm(c, K, [DK.PROMISE], () => {
        this.deps.lit(c, "{}");
        c.call(this.jbPuts());
        c.i32Const(1);
        c.return_();
      });

      this.emitKindArm(c, K, [DK.ARR], () => {
        this.emitDepthEnter(c);
        c.i32Const(0x5b); // '['
        c.call(this.jbPutc());
        dyn.arrPayload(c, (x) => x.localGet(0));
        c.localSet(V);
        dyn.arrLen(c, (x) => x.localGet(V));
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
        c.ifVoid();
        c.i32Const(0x2c); // ','
        c.call(this.jbPutc());
        c.end();
        dyn.arrAt(c, (x) => x.localGet(V), (x) => x.localGet(I));
        c.call(idx);
        c.localSet(PRESENT);
        // The cell first: a 0 from a walk that THREW is an unwind, not an
        // absent value, and writing `null` for it would swallow the throw.
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.localGet(PRESENT);
        c.i32Eqz();
        c.ifVoid();
        // A hole in the JSON sense: undefined and functions print as null
        // in ARRAY position, where an object member would have dropped.
        this.deps.lit(c, "null");
        c.call(this.jbPuts());
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.i32Const(0x5d); // ']'
        c.call(this.jbPutc());
        this.emitDepthLeave(c);
        c.i32Const(1);
        c.return_();
      });

      this.emitKindArm(c, K, [DK.OBJ], () => {
        this.emitDepthEnter(c);
        c.i32Const(0x7b); // '{'
        c.call(this.jbPutc());
        // Own-key ORDER, through the one helper that defines it.
        c.localGet(0);
        c.i32Const(2); // Object.entries mode
        c.call(dyn.objWalk());
        c.localSet(ENTS);
        dyn.arrPayload(c, (x) => x.localGet(ENTS));
        c.localSet(V);
        dyn.arrLen(c, (x) => x.localGet(V));
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.i32Const(1);
        c.localSet(FIRST);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeU();
        c.brIf(1);
        dyn.arrAt(c, (x) => x.localGet(V), (x) => x.localGet(I));
        c.localSet(E);
        dyn.arrPayload(c, (x) => x.localGet(E));
        c.localSet(P);
        // An absent MEMBER drops with its key, so the kind decides before
        // anything is written — no probe buffer needed (see the header).
        dyn.arrAt(c, (x) => x.localGet(P), (x) => x.i32Const(1));
        c.structGet(dynT, DYN_KIND);
        c.localSet(MK);
        c.localGet(MK);
        c.i32Const(DK.UNDEF);
        c.i32Eq();
        c.localGet(MK);
        c.i32Const(DK.FUNC);
        c.i32Eq();
        c.i32Or();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(FIRST);
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0x2c); // ','
        c.call(this.jbPutc());
        c.end();
        c.i32Const(0);
        c.localSet(FIRST);
        dyn.arrAt(c, (x) => x.localGet(P), (x) => x.i32Const(0));
        c.structGet(dynT, DYN_REF);
        c.refCast(strT);
        c.call(this.jbPutStr());
        c.i32Const(0x3a); // ':'
        c.call(this.jbPutc());
        dyn.arrAt(c, (x) => x.localGet(P), (x) => x.i32Const(1));
        c.call(idx);
        c.drop(); // present: the kind test above already established it
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.i32Const(0x7d); // '}'
        c.call(this.jbPutc());
        this.emitDepthLeave(c);
        c.i32Const(1);
        c.return_();
      });

      // BYTES, HANDLE and JSVAL: no producer on this tier can build one
      // (typed arrays, runtime handles and the island bridge all refuse
      // upstream of here), so reaching this point means the dyn surface
      // grew a kind without growing this walk.
      c.unreachable();
      this.mb.setBody(
        idx,
        [I32, dyn.arrRef(), I32, I32, dyn.dynRef(), dyn.dynRef(), dyn.arrRef(), I32, I32, I32],
        c.bytes(),
      );
    });
  }

  /** `if (kind is one of ks) { body }` — the kind-dispatch shape dyn.ts
   * spells `arm`, repeated here so this file needs nothing from it but
   * the representation. */
  private emitKindArm(c: Code, kindLocal: number, ks: number[], body: () => void): void {
    ks.forEach((k, i) => {
      c.localGet(kindLocal);
      c.i32Const(k);
      c.i32Eq();
      if (i > 0) c.i32Or();
    });
    c.ifVoid();
    body();
    c.end();
  }

  /** `%w.json.stringifyDyn(d)` → the stringify text, or a pending
   * RangeError. THE entry point a dyn-rooted `JSON.stringify` lowers to.
   *
   * A root the walk DROPS answers the text "undefined" where Node answers
   * the undefined VALUE. That is the lowering's documented rule rather
   * than this walker's invention: tsc's own lib types the return `string`,
   * so no statically-typed consumer can tell the two apart. */
  stringifyDyn(): number {
    const dyn = this.deps.dyn();
    return this.cached("stringifyDyn", [dyn.dynRef()], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const PRESENT = 1;
      c.call(this.jbBegin()); // buffer, seen stack and depth all reset here
      c.localGet(0);
      c.call(this.putDyn());
      c.localSet(PRESENT);
      // The cell first, again: the caller's pending check unwinds, and
      // the buffer is left for the next site's prologue to reset.
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.refNull(this.deps.strType());
      c.return_();
      c.end();
      c.localGet(PRESENT);
      c.i32Eqz();
      c.ifVoid();
      this.deps.lit(c, "undefined");
      c.return_();
      c.end();
      c.call(this.jbFinish());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }
}

/** One record KEY (or any compile-time-known string) as a quoted JSON
 * string literal, escaped by exactly the rule `jbPutStr` applies at
 * runtime — so the emitter can bake `"name":` into the label literal
 * instead of writing keys through the escape walk.
 *
 * Node escapes keys with the FULL rule, keys and values alike: the object
 * `{ 'a"b': 1 }` stringifies as `{"a\"b":1}` (verified against Node
 * 24.18). The C generator writes keys RAW through cStringLiteral, which
 * is a latent native-lane divergence for any key needing an escape; that
 * is C's bug to fix, not a rule to inherit. */
export function jsonQuote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u === 0x22 || u === 0x5c) {
      out += `\\${s[i]}`;
      continue;
    }
    if (u < 0x20) {
      switch (u) {
        case 0x08: out += "\\b"; break;
        case 0x0c: out += "\\f"; break;
        case 0x0a: out += "\\n"; break;
        case 0x0d: out += "\\r"; break;
        case 0x09: out += "\\t"; break;
        default: out += `\\u${u.toString(16).padStart(4, "0")}`;
      }
      continue;
    }
    if ((u & 0xf800) === 0xd800) {
      const paired =
        (u & 0x0400) === 0
          ? i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00
          : i > 0 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800;
      if (!paired) {
        out += `\\u${u.toString(16).padStart(4, "0")}`;
        continue;
      }
    }
    out += s[i];
  }
  return `${out}"`;
}
