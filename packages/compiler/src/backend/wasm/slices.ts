/* Strings unit S3 — slice views (V8's SlicedString) on the wasm tier.
 *
 * A string VALUE (S1's `(ref null eq)`) is now a flat `$chars` array, a
 * `$rope` node (S2, ropes.ts) or a `$slice` view {len, base, off} over a
 * FLAT base (the `$slice` type and its materialisation live beside the
 * rope in ropes.ts, so the flatten crossing knows all three shapes).
 * Without views, `s = s.slice(1)` copied the rest of the string at every
 * step — a loop that eats its input from the front (a tokenizer's
 * `src = src.slice(m[0].length)`) was quadratic, where V8 answers a
 * substring of 13 code units or more (SlicedString::kMinLength) with an
 * O(1) view.
 *
 *   - PRODUCERS. slice / substring / trimStart / trimEnd / trim in VALUE
 *     position (a store, a return, an argument — the emitter's walkValue),
 *     `split` pieces and regex match/capture rows build a view when the
 *     result is 13 units or longer and not the whole base; a shorter one is
 *     a flat copy (one unit from the shared table, %w.str.unit, #299). The
 *     receiver is read as a WINDOW (window below): a flat array is itself
 *     at offset 0, a view is its (base, off, len) — so a view of a view is
 *     re-pointed at the root, never chained, exactly V8's rule — and a rope
 *     is flattened first (cached in the node, as V8 flattens a ConsString
 *     before slicing it). In FLAT position (the result read on the spot)
 *     the same helpers copy just the span out of the window, never the
 *     receiver's whole string.
 *   - HOT READERS read through the window without materialising anything:
 *     charCodeAt / charAt / `s[i]` / the string iterator's step,
 *     startsWith, endsWith, indexOf / includes here, and the regex
 *     matcher's subject (regex-interpreter.ts takes an offset window over
 *     the base; regex-state.ts the W entry points). Every other reader
 *     goes through the flatten crossing (strings.ts emitFlat), which
 *     MATERIALISES a view: one exact copy, cached by re-pointing the view
 *     at it (ropes.ts materialise), so a second read is O(1) and the
 *     parent is released.
 *   - Each reader and producer comes in two forms: V takes the str VALUE
 *     and extracts its window itself; W takes a window (base, off, len)
 *     the caller already holds — the emitter's WINDOW SHADOW of a binding
 *     read only by these readers (a lexer's `src` parameter, a tokenizer's
 *     `rest`), filled in O(1) at each write, so its hot reads pay no shape
 *     test at all.
 *   - RETENTION: a live view keeps its whole base alive until the view is
 *     materialised or collected — V8 accepts the same (a short SlicedString
 *     retains its parent), and so does this tier: no special handling.
 *   - Equality, hashing and Map/Set keys go through the crossing, so they
 *     compare CONTENTS, never shapes.
 *
 * Nothing here is observable: strings stay immutable values with the same
 * contents, and identity is not observable for JS primitives. A module
 * with no producer (emitter.ts hasStrView) builds none of this and is
 * byte-identical to S2's. */
import { A, Fn, type X } from "./asm.js";
import type { Code } from "./code.js";
import { F64, I32, type ModuleBuilder, type ValType } from "./module.js";
import { type Ropes, SL_BASE, SL_LEN, SL_OFF } from "./ropes.js";
import type { StrBuilder } from "./strings.js";

/** V8's SlicedString::kMinLength: a substring shorter than this is a
 * flat copy. */
export const SLICED_MIN_LENGTH = 13;

const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: -0x13 };

export type SliceOpKind = "slice" | "substring" | "trim:both" | "trim:start" | "trim:end";
/** A reader's form: V over a str value, W over a held window. */
export type WinForm = "V" | "W";

interface Win {
  B: number;
  OFF: number;
  LEN: number;
}

export class Slices {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly strType: number,
    private readonly ropes: Ropes,
    private readonly strs: StrBuilder,
  ) {}

  private get chars(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strType };
  }

  private fn(name: string, params: ValType[], results: ValType[], body: ($: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.str.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    const $ = new A(f);
    body($);
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  /** The string value in local X as a WINDOW into a flat array: B (a
   * `(ref null $chars)` local), OFF and LEN (i32 locals). A flat array is
   * itself; a view its base span; a rope is flattened (cached in the
   * node). Null: with `nullOk` (a binding's window shadow, filled at a
   * write that may store null) B is null and LEN 0 — every W reader
   * traps on the null B, as the flat helpers' array.len did; otherwise
   * it traps here. */
  emitWindow(c: Code, X: number, B: number, OFF: number, LEN: number, nullOk: boolean): void {
    const T = this.ropes.sliceType;
    c.localGet(X);
    c.refTest(this.strType);
    c.ifVoid();
    c.localGet(X);
    c.castChars(this.strType, false);
    c.localTee(B);
    c.arrayLen();
    c.localSet(LEN);
    c.i32Const(0);
    c.localSet(OFF);
    c.else_();
    c.localGet(X);
    c.refTest(T);
    c.ifVoid();
    c.localGet(X);
    c.refCast(T);
    c.structGet(T, SL_BASE);
    c.localSet(B);
    c.localGet(X);
    c.refCast(T);
    c.structGet(T, SL_OFF);
    c.localSet(OFF);
    c.localGet(X);
    c.refCast(T);
    c.structGet(T, SL_LEN);
    c.localSet(LEN);
    c.else_();
    c.localGet(X);
    c.call(nullOk ? this.ropes.flat() : this.ropes.flatCast());
    c.localTee(B);
    if (nullOk) {
      c.refIsNull();
      c.ifResult(I32);
      c.i32Const(0);
      c.else_();
      c.localGet(B);
      c.arrayLen();
      c.end();
    } else {
      c.arrayLen();
    }
    c.localSet(LEN);
    c.i32Const(0);
    c.localSet(OFF);
    c.end();
    c.end();
  }

  /** A window shadow's fill at a WRITE: a flat array or a view sets the
   * window (O(1)); anything else — a rope, or null — leaves it UNFILLED
   * (B = null) rather than flattening here, so an accumulation loop
   * (`s += x` in a module with views) stays linear: the first window
   * read refills it (emitWindow, the rope flattened once and cached). */
  emitWindowFill(c: Code, X: number, B: number, OFF: number, LEN: number): void {
    const T = this.ropes.sliceType;
    c.localGet(X);
    c.refTest(this.strType);
    c.ifVoid();
    c.localGet(X);
    c.castChars(this.strType, false);
    c.localTee(B);
    c.arrayLen();
    c.localSet(LEN);
    c.i32Const(0);
    c.localSet(OFF);
    c.else_();
    c.localGet(X);
    c.refTest(T);
    c.ifVoid();
    c.localGet(X);
    c.refCast(T);
    c.structGet(T, SL_BASE);
    c.localSet(B);
    c.localGet(X);
    c.refCast(T);
    c.structGet(T, SL_OFF);
    c.localSet(OFF);
    c.localGet(X);
    c.refCast(T);
    c.structGet(T, SL_LEN);
    c.localSet(LEN);
    c.else_();
    c.refNull(this.strType);
    c.localSet(B);
    c.end();
    c.end();
  }

  /** The A-layer spelling of emitWindow (non-null). */
  window($: A, X: number, B: number, OFF: number, LEN: number): void {
    this.emitWindow($.c, X, B, OFF, LEN, false);
  }

  /** Window locals for a helper whose string value is param `x`. */
  private win($: A, x: number): Win {
    const B = $.local(this.chars);
    const OFF = $.local(I32);
    const LEN = $.local(I32);
    this.window($, x, B, OFF, LEN);
    return { B, OFF, LEN };
  }

  /** One reader/producer in either form: V's params are (str value,
   * ...extra), W's (base, off, len, ...extra) — `body` sees the window
   * and the extra params' indices. A W base is null-checked first (a
   * window shadow of a null binding traps, as the flat read did). */
  private twin(name: string, form: WinForm, extra: ValType[], result: ValType, body: ($: A, w: Win, a: number[]) => void): number {
    const params = form === "V" ? [EQ_REF, ...extra] : [this.chars, I32, I32, ...extra];
    return this.fn(`${name}${form}`, params, [result], ($) => {
      let w: Win;
      if (form === "V") {
        w = this.win($, 0);
      } else {
        w = { B: 0, OFF: 1, LEN: 2 };
        $.c.localGet(0);
        $.c.refAsNonNull();
        $.c.drop();
      }
      const first = form === "V" ? 1 : 3;
      body($, w, extra.map((_, i) => first + i));
    });
  }

  /** %w.str.span — ($chars base, i32 off, i32 cnt) → str value: base[off,
   * off + cnt) as the cheapest value — the shared one-unit string, the
   * base itself when the span is all of it, a view at 13 units or more,
   * else a flat copy. */
  span(): number {
    return this.fn("span", [this.chars, I32, I32], [EQ_REF], ($) => this.emitSpan($, 0, 1, 2, true));
  }

  /** %w.str.flatSpan — span's flat twin (no view): → `$chars`. */
  flatSpan(): number {
    return this.fn("flatSpan", [this.chars, I32, I32], [this.chars], ($) => this.emitSpan($, 0, 1, 2, false));
  }

  private emitSpan($: A, b: number, off: number, cnt: number, view: boolean): void {
    const B = $.l(b);
    const OFF = $.l(off);
    const CNT = $.l(cnt);
    const R = $.local(this.chars);
    $.if($.eq(CNT, $.i(1)), () => $.ret($.call(this.strs.unit(), $.agetU(this.strType, B, OFF))));
    $.if($.both($.eq(OFF, $.i(0)), $.eq(CNT, $.alen(B))), () => $.ret(B));
    if (view) {
      const T = this.ropes.sliceType;
      $.if($.ge(CNT, $.i(SLICED_MIN_LENGTH)), () =>
        $.ret(
          $.new_(
            T,
            CNT,
            $.raw((c) => {
              B();
              c.refAsNonNull();
            }),
            OFF,
          ),
        ),
      );
    }
    $.put(R, $.anew(this.strType, CNT));
    $.do(
      $.raw((c) => {
        c.localGet(R);
        c.i32Const(0);
        B();
        OFF();
        CNT();
        c.arrayCopy(this.strType, this.strType);
      }),
    );
    $.do($.l(R));
  }

  /** %w.str.copyInto — ($chars dest, i32 pos, str value) → i32: the
   * value's code units copied into dest at pos straight from its window
   * (a join's pieces: a view is never materialised), answering the count. */
  copyInto(): number {
    return this.fn("copyInto", [this.chars, I32, EQ_REF], [I32], ($) => {
      const w = this.win($, 2);
      $.do(
        $.raw((c) => {
          c.localGet(0);
          c.localGet(1);
          c.localGet(w.B);
          c.localGet(w.OFF);
          c.localGet(w.LEN);
          c.arrayCopy(this.strType, this.strType);
        }),
      );
      $.do($.l(w.LEN));
    });
  }

  /* ── hot readers: through the window, nothing materialised ───────── */

  /** Out of [0, len) after ToIntegerOrInfinity (the f64 in local x). */
  private outOfRange($: A, x: number, w: Win): X {
    return $.either($.dlt($.l(x), $.d(0)), $.dge($.l(x), $.i2d($.l(w.LEN))));
  }

  /** charCodeAt: (s, f64) → f64. */
  charCodeAt(form: WinForm = "V"): number {
    return this.twin("charCodeAt", form, [F64], F64, ($, w, [x]) => {
      this.strs.emitToIntInf($.c, x!);
      $.if(this.outOfRange($, x!, w), () => $.ret($.d(Number.NaN)));
      $.do($.agetU(this.strType, $.l(w.B), $.add($.l(w.OFF), $.d2i($.l(x!)))));
      $.c.f64ConvertI32U();
    });
  }

  /** charAt: (s, f64) → $chars ("" out of range). */
  charAt(form: WinForm = "V"): number {
    return this.twin("charAt", form, [F64], this.chars, ($, w, [x]) => {
      this.strs.emitToIntInf($.c, x!);
      $.if(this.outOfRange($, x!, w), () => $.ret($.anew(this.strType, $.i(0))));
      $.do($.call(this.strs.unit(), $.agetU(this.strType, $.l(w.B), $.add($.l(w.OFF), $.d2i($.l(x!))))));
    });
  }

  /** The string iterator's step (strings.ts cpAt's rules). */
  cpAt(form: WinForm = "V"): number {
    return this.twin("cpAt", form, [F64], this.chars, ($, w, [x]) => {
      const I = $.local(I32);
      const U = $.local(I32);
      const U2 = $.local(I32);
      this.strs.emitToIntInf($.c, x!);
      $.if(this.outOfRange($, x!, w), () => $.ret($.anew(this.strType, $.i(0))));
      $.put(I, $.d2i($.l(x!)));
      $.put(U, $.agetU(this.strType, $.l(w.B), $.add($.l(w.OFF), $.l(I))));
      $.if($.both($.both($.ge($.l(U), $.i(0xd800)), $.le($.l(U), $.i(0xdbff))), $.lt($.add($.l(I), $.i(1)), $.l(w.LEN))), () => {
        $.put(U2, $.agetU(this.strType, $.l(w.B), $.add($.add($.l(w.OFF), $.l(I)), $.i(1))));
        $.if($.both($.ge($.l(U2), $.i(0xdc00)), $.le($.l(U2), $.i(0xdfff))), () =>
          $.ret(
            $.raw((c) => {
              c.localGet(U);
              c.localGet(U2);
              c.arrayNewFixed(this.strType, 2);
            }),
          ),
        );
      });
      $.do($.call(this.strs.unit(), $.l(U)));
    });
  }

  /** matchAt: (s, needle, i32 at) → i32 — startsWith is this at 0. */
  matchAt(form: WinForm = "V"): number {
    return this.twin("matchAt", form, [this.chars, I32], I32, ($, w, [n, at]) => {
      const NL = $.local(I32);
      $.put(NL, $.alen($.l(n!)));
      $.if($.gt($.l(at!), $.l(w.LEN)), () => $.ret($.i(0)));
      $.if($.gt($.l(NL), $.sub($.l(w.LEN), $.l(at!))), () => $.ret($.i(0)));
      $.do($.call(this.strs.matchAt(), $.l(w.B), $.l(n!), $.add($.l(w.OFF), $.l(at!))));
    });
  }

  /** endsWith: (s, needle) → i32. */
  endsWith(form: WinForm = "V"): number {
    return this.twin("endsWith", form, [this.chars], I32, ($, w, [n]) => {
      const NL = $.local(I32);
      $.put(NL, $.alen($.l(n!)));
      $.if($.gt($.l(NL), $.l(w.LEN)), () => $.ret($.i(0)));
      $.do($.call(this.strs.matchAt(), $.l(w.B), $.l(n!), $.sub($.add($.l(w.OFF), $.l(w.LEN)), $.l(NL))));
    });
  }

  /** indexOf: (s, needle, f64 from) → f64 (strings.ts indexOf's clamp;
   * includes is this ≠ -1). */
  indexOf(form: WinForm = "V"): number {
    return this.twin("indexOf", form, [this.chars, F64], F64, ($, w, [n, x]) => {
      const NL = $.local(I32);
      const I = $.local(I32);
      $.put(NL, $.alen($.l(n!)));
      this.strs.emitToIntInf($.c, x!);
      $.put(I, $.sel(I32, $.dle($.l(x!), $.d(0)), $.i(0), $.sel(I32, $.dge($.l(x!), $.i2d($.l(w.LEN))), $.l(w.LEN), $.d2i($.l(x!)))));
      $.if($.eq($.l(NL), $.i(0)), () => $.ret($.i2d($.l(I))));
      $.while($.le($.l(I), $.sub($.l(w.LEN), $.l(NL))), () => {
        $.if($.call(this.strs.matchAt(), $.l(w.B), $.l(n!), $.add($.l(w.OFF), $.l(I))), () => $.ret($.i2d($.l(I))));
        $.put(I, $.add($.l(I), $.i(1)));
      });
      $.do($.d(-1));
    });
  }

  /* ── producers ───────────────────────────────────────────────────── */

  /** slice / substring / trim*: (s[, f64, f64]) → a str value (`asView`:
   * a view at 13 units or more) or flat `$chars` (the span copied out of
   * the window). The boundary rules are strings.ts's, on the window's
   * length. */
  op(kind: SliceOpKind, asView: boolean, form: WinForm = "V"): number {
    const twoArgs = kind === "slice" || kind === "substring";
    return this.twin(`${kind}${asView ? "V" : "F"}`, form, twoArgs ? [F64, F64] : [], asView ? EQ_REF : this.chars, ($, w, a) => {
      const F = $.local(I32);
      const T = $.local(I32);
      const c = $.c;
      if (kind === "slice" || kind === "substring") {
        const [x0, x1] = a as [number, number];
        this.strs.emitToIntInf(c, x0);
        this.strs.emitToIntInf(c, x1);
        if (kind === "slice") {
          this.strs.emitSliceBoundary(c, x0, w.LEN);
          c.localSet(F);
          this.strs.emitSliceBoundary(c, x1, w.LEN);
          c.localSet(T);
          $.if($.ge($.l(F), $.l(T)), () => $.put(T, $.l(F)));
        } else {
          const TMP = $.local(I32);
          this.strs.emitAbsBoundary(c, x0, w.LEN);
          c.localSet(F);
          this.strs.emitAbsBoundary(c, x1, w.LEN);
          c.localSet(T);
          $.if($.gt($.l(F), $.l(T)), () => {
            $.put(TMP, $.l(F));
            $.put(F, $.l(T));
            $.put(T, $.l(TMP));
          });
        }
      } else {
        const ws = (i: X): X => $.call(this.strs.isWs(), $.agetU(this.strType, $.l(w.B), $.add($.l(w.OFF), i)));
        $.put(F, $.i(0));
        $.put(T, $.l(w.LEN));
        if (kind !== "trim:end") {
          $.while($.andThen($.lt($.l(F), $.l(T)), ws($.l(F))), () => $.put(F, $.add($.l(F), $.i(1))));
        }
        if (kind !== "trim:start") {
          $.while($.andThen($.gt($.l(T), $.l(F)), ws($.sub($.l(T), $.i(1)))), () => $.put(T, $.sub($.l(T), $.i(1))));
        }
      }
      // span's body inlined (a token-sized slice pays no second call).
      $.put(T, $.sub($.l(T), $.l(F)));
      $.put(F, $.add($.l(w.OFF), $.l(F)));
      this.emitSpan($, w.B, F, T, asView);
    });
  }
}
