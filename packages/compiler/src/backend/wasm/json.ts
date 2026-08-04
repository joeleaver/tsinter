/* JSON.parse as emitted WasmGC code: a recursive-descent parser over the
 * tier's UTF-16 string producing dyn trees (dyn.ts). The increment's
 * design doc for this stage — read it before changing the grammar or a
 * message.
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
 *      round-tripped doubles land here. The decimal digits are held
 *      exactly, binary shifts are exact operations on that
 *      representation, and the single final round-half-even acts on an
 *      exactly-known residual — so the result is the correctly-rounded
 *      double, which is what strtod promises and therefore what the
 *      native lanes and V8 both produce. */
import { Code } from "./code.js";
import type { DynBuilder } from "./dyn.js";
import { F64, I32, I64, ModuleBuilder, type ValType } from "./module.js";

/** C's SCR_JSON_MAX_DEPTH. SEMANTICS.md S013. */
export const MAX_DEPTH = 1000;

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
      // Stage 2 — SEE THE HEADER'S 2b-ii OBLIGATION. Simple Decimal
      // Conversion has not landed yet, and a >15-digit literal is RUNTIME
      // data that no compile-time refusal can fence: the only two runtime
      // choices are a trap or a wrong answer, and this is the loud one.
      c.unreachable();
      this.mb.setBody(
        idx,
        [I64, I32, I32, I32, I32, I32, I32, I32, F64],
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
}
