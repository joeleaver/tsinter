/* util.inspect's runtime half as emitted WasmGC code, in four parts: the
 * append buffer and the UTF-16 measures; Node's quoting ladder
 * (strEscape) behind the two leaf renderings that need no layout —
 * formatPrimitive's string arm (`insp.str`) and formatProperty's key arm
 * (`insp.key`); the LAYOUT ENGINE, which is a frame stack driving
 * reduceToSingleString and groupArrayElements plus the `<ref *N>` /
 * `[Circular *N]` protocol; and the error leaf. The frontend
 * (lower-inspect.ts) owns the per-type TRAVERSAL and calls all of it
 * through `insp.*` libCalls — what lives here is everything a static type
 * cannot know.
 *
 * The dyn walker, the one runtime type whose shape lives in the value, is
 * the stage after this one.
 *
 * `scr_inspect.c` is the structural reference and NODE IS THE ORACLE. The
 * whole file was measured against Node v24.18 before it was written, and
 * three of the C's shapes dissolve or change here:
 *
 *  1. JS `.length` IS `array.len`. C carries `insp_utf16_len`, a WTF-8
 *     walk that adds 2 per astral code point; this tier stores code units
 *     (S002), so every length in Node's algorithm — the 10000 cap, the
 *     16-unit and breakLength gates — is the array length directly and
 *     the walk is deleted.
 *  2. THE 10000-UNIT CAP IS A PLAIN SLICE. C's `insp_utf16_offset` needs a
 *     `lone_high` dance to re-encode the high surrogate of an astral pair
 *     the cut splits. Node does `value.slice(0, 10000)`, which keeps that
 *     lone high half and lets strEscape render it `\ud83d` — measured:
 *     `inspect("a".repeat(9999) + "\u{1F600}" + "bcd")` ends
 *     `...aaa\ud83d'... 4 more characters`. Taking units [0, 10000) and
 *     running the ordinary ladder reproduces it with no special case.
 *  3. LONE SURROGATES ARE READ DIRECTLY. C decodes WTF-8 to find them;
 *     here an unpaired 0xd800-0xdfff unit IS the escape's input, and a
 *     PAIRED one is copied verbatim as two units.
 *
 * THE SPLIT GATE'S ARITHMETIC IS SIGNED, and that is a deliberate
 * departure from the C. Node tests `value.length > ctx.breakLength -
 * ctx.indentationLvl - 4` in JS numbers, so indentation past 76 makes the
 * bound negative and the answer "split"; C's `80 - g_indent - 4` is
 * size_t and wraps to a huge unsigned, answering "don't split". Default
 * options cap indentation near 8, so nothing observable reaches the
 * difference — but the oracle is Node, so the i32 compare here is signed.
 *
 * THE BUFFER IS ONE MODULE-GLOBAL ARRAY PLUS A FILL LENGTH, used as a
 * STACK OF REGIONS: a helper records `mark = len` on entry, appends, and
 * `ibTake(mark)` slices [mark, len) into a fresh string and truncates
 * back. That is json.ts's jb buffer plus one integer, and the integer is
 * the whole point — a fixed-base buffer can only ever hold ONE thing,
 * which is not enough for two reasons:
 *
 *   - THE ESCAPE LADDER APPENDS INTO ITS CALLER'S REGION. C's
 *     `insp_quote_into(b, ...)` takes the buffer to write into, and
 *     `scr_insp_error` uses exactly that to put `code: 'X'` inside an
 *     entry it is already building. So `quoteInto` here cannot be a
 *     "returns a string" helper, and the buffer has to be reachable
 *     without being threaded through every signature.
 *   - A NESTED RENDER MUST TAKE ONLY ITS OWN SLICE. Once stage B builds an
 *     entry (`key + ": " + value`) as a region, an `insp.str` called while
 *     that region is open has to hand back its own text, not the entry's
 *     prefix as well. `mark` is what makes that answerable.
 *
 * The C reference does NOT itself nest InspBufs, and the earlier claim
 * here that it did was wrong: `insp_group`'s per-row `line` buffers are
 * all taken before `scr_insp_end` opens its `out` (scr_inspect.c:481 runs
 * before 482), and `scr_insp_error`'s `base` is taken before `entry` is
 * opened. Its one two-live-buffer site is `scr_insp_str`'s `out` + `val`,
 * and this port deletes it — the chunk loop quotes RANGES of the original
 * string instead of materializing a truncated copy. So the mark is
 * justified by what the emitted code needs, not by the reference's shape.
 *
 * NON-REENTRANCY, the argument the globals need: the synthesized
 * traversals never call user code. util.inspect's escape hatches — a
 * getter, a custom `inspect` method, a `toString` — are all FRONTEND-
 * fenced (lower-inspect.ts refuses accessor-carrying shapes, subclassed
 * classes, and function values by name), so no program can re-enter a
 * render mid-region. Nesting that DOES occur is LIFO and the mark handles
 * it: an entry's value string is taken (popping its region) before the
 * entry's own region closes.
 *
 * NOTHING HERE THROWS, so no call site needs a pending check.
 *
 * DISPLAY WIDTH IS A KNOWN DIVERGENCE (SEMANTICS.md S028), and what this
 * file implements is NODE'S NON-ICU TABLES APPLIED PER CODE POINT WITHOUT
 * NFC NORMALIZATION. Two axes, one of which is NOT a divergence and is
 * worth stating because it looks like one:
 *
 *   - NFC NORMALIZATION is omitted here and Node always applies it, in
 *     BOTH implementations — the non-ICU fallback (inspect.js:2695-2711)
 *     normalizes before walking these very tables, and the ICU path this
 *     build takes (2671-2688) normalizes before handing off to
 *     `icu.getStringWidth`. It can change the code point COUNT and not
 *     just widths: U+1D160 decomposes into three characters that do not
 *     recompose, so Node measures it 3 where a per-code-point walk says 1.
 *   - VT SEQUENCE STRIPPING IS NOT A DIVERGENCE, though the two
 *     implementations do it. `getStringWidth(str, removeControlChars)`
 *     takes the flag, and the only caller that matters here passes
 *     `ctx.colors` — false under the default options the frontend allows.
 *     Measured: `getStringWidth("\x1b[31mred\x1b[0m")` is 3 with stripping
 *     and 10 without, and 10 is what these tables answer. Skipping the
 *     strip is what MATCHES Node, not what breaks it.
 *   - the TABLES themselves are stale against ICU's East_Asian_Width data,
 *     which separates this file from the ICU path only. Measured over all
 *     1,114,112 code points, the two answers differ on 11148 of them, in
 *     480 contiguous ranges (482 if a range is split where the direction
 *     of disagreement changes — which happens only at U+1D160 and
 *     U+1D1BD, the two NFC-expanding musical symbols). 1812 code points
 *     are combining marks outside U+0300..U+036F that ICU calls zero-width
 *     and these tables call 1; 9013 are emoji ICU widened to 2 (U+231A,
 *     U+2648..U+2653, ...); 299 go the other way (U+3040, U+4DC0..U+4DFF,
 *     U+1B002 — unassigned code points the two guess differently).
 *
 * Width feeds ONLY grid grouping (Node calls getStringWidth from
 * groupArrayElements and nowhere else under these options — break-length
 * counts code UNITS), so an array of seven-plus short exotic entries is
 * the whole exposure. (scr_inspect.c:142-143 attributes the difference to
 * NFC alone; fixing the C is not this increment's business.) */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

/** Node's `ctx.maxStringLength` default (inspectDefaultOptions). */
const MAX_STRING_LENGTH = 10000;

/** Node's `kMinLineLength` (inspect.js:258) — the floor below which
 * formatPrimitive never splits a string, whatever the indentation. */
const MIN_LINE_LENGTH = 16;

/** Node's `ctx.breakLength` default. */
const BREAK_LENGTH = 80;

/** Node's `ctx.compact` default — the depth window inside which a
 * composite may still collapse onto one line, and (times four) the column
 * ceiling for grid grouping. */
const COMPACT = 3;

/** The abstract `eq` heap type's s33 encoding (json.ts's EQ_HEAP). Every GC
 * struct and array is a subtype, and unlike `any` it admits `ref.eq` —
 * which is what the circular machinery compares. */
const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

export interface InspectDeps {
  strRef: () => ValType;
  strType: () => number;
  /** Push an interned string literal (the emitter's data-segment path). */
  lit: (c: Code, s: string) => void;
  /** `%w.f64ToStr` — the trailer's count. */
  f64ToStr: () => number;
  /** The exception struct and its slot indices: insp.error reads
   * name/message/code straight off an errT (the representation every
   * builtin error class and its subclasses share). */
  errT: () => number;
  errName: () => number;
  errMessage: () => number;
  errCode: () => number;
}

export class InspectBuilder {
  private bufG: number | null = null;
  private lenG: number | null = null;
  private indentG: number | null = null;
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: InspectDeps,
  ) {}

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.insp.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── the append buffer ──────────────────────────────────────────────── */

  private buf(): number {
    this.bufG ??= this.mb.addGlobal(this.deps.strRef(), true, (w) => {
      w.u8(0xd0); // ref.null $str
      w.sleb(this.deps.strType());
    });
    return this.bufG;
  }

  private len(): number {
    this.lenG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.lenG;
  }

  /** `ctx.indentationLvl`. The layout engine moves it by 2 per composite
   * level; every reader here reads the GLOBAL rather than baking 0, so
   * `insp.str` inside a frame splits at the right column once stage B
   * starts mutating it. */
  indentGlobal(): number {
    this.indentG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.indentG;
  }

  /** Open a region: push the current fill length, which the matching
   * `ibTake` consumes. */
  pushMark(c: Code): void {
    c.globalGet(this.len());
  }

  /** `%w.insp.ibEnsure(need)` — room for `need` more units, doubling from
   * a 64-unit floor (jbEnsure's shape). */
  private ibEnsure(): number {
    return this.cached("ibEnsure", [I32], [], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const NEED = 0;
      const WANT = 1;
      const CAP = 2;
      const NB = 3;
      c.globalGet(this.buf());
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
      c.globalSet(this.buf());
      c.return_();
      c.end();
      c.globalGet(this.len());
      c.localGet(NEED);
      c.i32Add();
      c.localSet(WANT);
      c.localGet(WANT);
      c.globalGet(this.buf());
      c.arrayLen();
      c.i32LeU();
      c.ifVoid();
      c.return_();
      c.end();
      c.globalGet(this.buf());
      c.arrayLen();
      c.localSet(CAP);
      c.block();
      c.loop();
      c.localGet(CAP);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(CAP);
      // A capacity that doubled THROUGH the i32 top is 0, and 0 is never
      // >= a positive want — the loop would spin forever. It takes a
      // 2^31-unit buffer to get here, so `array.new_default` traps on the
      // allocation long before, but a hang is a worse failure than a trap
      // and the guard is one compare.
      c.localGet(CAP);
      c.i32Eqz();
      c.ifVoid();
      c.unreachable();
      c.end();
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
      c.globalGet(this.buf());
      c.i32Const(0);
      c.globalGet(this.len());
      c.arrayCopy(strT, strT);
      c.localGet(NB);
      c.globalSet(this.buf());
      this.mb.setBody(idx, [I32, I32, this.deps.strRef()], c.bytes());
    });
  }

  /** `%w.insp.ibPutc(unit)` — one code unit. */
  ibPutc(): number {
    return this.cached("ibPutc", [I32], [], (idx) => {
      const c = new Code();
      c.i32Const(1);
      c.call(this.ibEnsure());
      c.globalGet(this.buf());
      c.globalGet(this.len());
      c.localGet(0);
      c.arraySet(this.deps.strType());
      c.globalGet(this.len());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.len());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.ibPuts(s)` — a whole string, VERBATIM. */
  ibPuts(): number {
    return this.cached("ibPuts", [this.deps.strRef()], [], (idx) => {
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
      c.call(this.ibEnsure());
      c.globalGet(this.buf());
      c.globalGet(this.len());
      c.localGet(0);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(strT, strT);
      c.globalGet(this.len());
      c.localGet(N);
      c.i32Add();
      c.globalSet(this.len());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.insp.ibSpaces(n)` — `ib_spaces`. */
  ibSpaces(): number {
    return this.cached("ibSpaces", [I32], [], (idx) => {
      const c = new Code();
      const N = 0;
      const I = 1;
      c.localGet(N);
      c.i32Const(0);
      c.i32LeS();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(N);
      c.call(this.ibEnsure());
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.buf());
      c.globalGet(this.len());
      c.localGet(I);
      c.i32Add();
      c.i32Const(0x20);
      c.arraySet(this.deps.strType());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(this.len());
      c.localGet(N);
      c.i32Add();
      c.globalSet(this.len());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.insp.ibTake(mark)` → the region [mark, len) as a fresh string,
   * with the fill length truncated back to `mark` (C's `ib_take`, which
   * frees the buffer — here the backing array is kept for reuse, and
   * dropped only when it grew past 2^16 units AND the stack is empty, so
   * one giant render cannot pin a big array for the module's lifetime). */
  ibTake(): number {
    return this.cached("ibTake", [I32], [this.deps.strRef()], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const MARK = 0;
      const L = 1;
      const R = 2;
      c.globalGet(this.len());
      c.localGet(MARK);
      c.i32Sub();
      c.localSet(L);
      c.localGet(L);
      c.arrayNewDefault(strT);
      c.localSet(R);
      // array.copy traps on a null side regardless of length, and an
      // untouched buffer IS null — so an empty region skips the copy.
      c.localGet(L);
      c.ifVoid();
      c.localGet(R);
      c.i32Const(0);
      c.globalGet(this.buf());
      c.localGet(MARK);
      c.localGet(L);
      c.arrayCopy(strT, strT);
      c.end();
      c.localGet(MARK);
      c.globalSet(this.len());
      // The if-chain is the usual reason: array.len null-traps, and the
      // outer region test keeps a nested take from dropping a buffer its
      // caller is still writing into.
      c.globalGet(this.buf());
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(MARK);
      c.i32Eqz();
      c.ifVoid();
      c.globalGet(this.buf());
      c.arrayLen();
      c.i32Const(1 << 16);
      c.i32GtU();
      c.ifVoid();
      c.refNull(strT);
      c.globalSet(this.buf());
      c.end();
      c.end();
      c.end();
      c.localGet(R);
      this.mb.setBody(idx, [I32, this.deps.strRef()], c.bytes());
    });
  }

  /* ── measures ───────────────────────────────────────────────────────── */

  /* JS `.length` needs no helper at all: it IS `array.len` over the i16
   * storage (S002). C's `insp_utf16_len` exists only because its storage
   * is WTF-8; every use of it in the reference is an `array.len` here. */

  /** `%w.insp.fullWidth(cp)` → i32 — Node's non-ICU isFullWidthCodePoint,
   * verbatim (SEMANTICS.md S028 for what that costs against an ICU Node).
   * Every operand is a compare on the parameter, so the
   * non-short-circuiting i32.and/i32.or are safe: nothing indexes memory. */
  fullWidth(): number {
    return this.cached("fullWidth", [I32], [I32], (idx) => {
      const c = new Code();
      const CP = 0;
      const range = (lo: number, hi: number): void => {
        c.localGet(CP);
        c.i32Const(lo);
        c.i32GeS();
        c.localGet(CP);
        c.i32Const(hi);
        c.i32LeS();
        c.i32And();
      };
      const eq = (v: number): void => {
        c.localGet(CP);
        c.i32Const(v);
        c.i32Eq();
      };
      c.localGet(CP);
      c.i32Const(0x1100);
      c.i32GeS();
      // ( code <= 0x115f || 0x2329 || 0x232a || ... )
      c.localGet(CP);
      c.i32Const(0x115f);
      c.i32LeS();
      eq(0x2329);
      c.i32Or();
      eq(0x232a);
      c.i32Or();
      // (code >= 0x2e80 && code <= 0x3247 && code != 0x303f)
      range(0x2e80, 0x3247);
      c.localGet(CP);
      c.i32Const(0x303f);
      c.i32Ne();
      c.i32And();
      c.i32Or();
      for (const [lo, hi] of [
        [0x3250, 0x4dbf],
        [0x4e00, 0xa4c6],
        [0xa960, 0xa97c],
        [0xac00, 0xd7a3],
        [0xf900, 0xfaff],
        [0xfe10, 0xfe19],
        [0xfe30, 0xfe6b],
        [0xff01, 0xff60],
        [0xffe0, 0xffe6],
        [0x1b000, 0x1b001],
        [0x1f200, 0x1f251],
        [0x1f300, 0x1f64f],
        [0x20000, 0x3fffd],
      ] as const) {
        range(lo, hi);
        c.i32Or();
      }
      c.i32And();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.zeroWidth(cp)` → i32 — Node's non-ICU isZeroWidthCodePoint,
   * verbatim. Pure compares again. */
  zeroWidth(): number {
    return this.cached("zeroWidth", [I32], [I32], (idx) => {
      const c = new Code();
      const CP = 0;
      c.localGet(CP);
      c.i32Const(0x1f);
      c.i32LeS();
      for (const [lo, hi] of [
        [0x7f, 0x9f],
        [0x300, 0x36f],
        [0x200b, 0x200f],
        [0x20d0, 0x20ff],
        [0xfe00, 0xfe0f],
        [0xfe20, 0xfe2f],
        [0xe0100, 0xe01ef],
      ] as const) {
        c.localGet(CP);
        c.i32Const(lo);
        c.i32GeS();
        c.localGet(CP);
        c.i32Const(hi);
        c.i32LeS();
        c.i32And();
        c.i32Or();
      }
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.width(s)` → i32 — display width, the grid-grouping measure
   * (C's `insp_width`; Node's non-ICU getStringWidth). Code points, so
   * surrogate pairs combine; an UNPAIRED half measures as itself, which is
   * width 1 under both tables. */
  width(): number {
    return this.cached("width", [this.deps.strRef()], [I32], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const S = 0;
      const N = 1;
      const I = 2;
      const W = 3;
      const U = 4;
      const CP = 5;
      c.localGet(S);
      c.arrayLen();
      c.localSet(N);
      c.i32Const(0);
      c.localSet(W);
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
      c.arrayGetU(strT);
      c.localSet(U);
      c.localGet(U);
      c.localSet(CP);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      // A high surrogate followed by a low one is ONE code point. The
      // bounds test is part of the condition and the READ is inside the
      // if — i32.and never evaluates an indexing operand here.
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0xdbff);
      c.i32LeS();
      c.i32And();
      c.localGet(I);
      c.localGet(N);
      c.i32LtS();
      c.i32And();
      c.ifVoid();
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(CP);
      c.localGet(CP);
      c.i32Const(0xdc00);
      c.i32GeS();
      c.localGet(CP);
      c.i32Const(0xdfff);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      // 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
      c.i32Const(0x10000);
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32Sub();
      c.i32Const(10);
      c.i32Shl();
      c.i32Add();
      c.localGet(CP);
      c.i32Const(0xdc00);
      c.i32Sub();
      c.i32Add();
      c.localSet(CP);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.else_();
      // Not a pair after all: the high half stands alone.
      c.localGet(U);
      c.localSet(CP);
      c.end();
      c.end();
      c.localGet(CP);
      c.call(this.fullWidth());
      c.ifVoid();
      c.localGet(W);
      c.i32Const(2);
      c.i32Add();
      c.localSet(W);
      c.else_();
      c.localGet(CP);
      c.call(this.zeroWidth());
      c.i32Eqz();
      c.ifVoid();
      c.localGet(W);
      c.i32Const(1);
      c.i32Add();
      c.localSet(W);
      c.end();
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(W);
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /* ── the quoting ladder (strEscape) ─────────────────────────────────── */

  /** `%w.insp.contains(s, from, to, unit)` → i32. */
  private contains(): number {
    return this.cached("contains", [this.deps.strRef(), I32, I32, I32], [I32], (idx) => {
      const c = new Code();
      const S = 0;
      const FROM = 1;
      const TO = 2;
      const U = 3;
      const I = 4;
      c.localGet(FROM);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(TO);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.localGet(U);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.insp.hasDollarBrace(s, from, to)` → i32 — a literal `${`, the one
   * thing that disqualifies backtick quoting. */
  private hasDollarBrace(): number {
    return this.cached("hasDollarBrace", [this.deps.strRef(), I32, I32], [I32], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const S = 0;
      const FROM = 1;
      const TO = 2;
      const I = 3;
      const A = 4;
      const B = 5;
      c.localGet(FROM);
      c.localSet(I);
      c.block();
      c.loop();
      // `i + 1 < to` is the guard, so BOTH reads below are in bounds; the
      // units go into locals before the compare rather than relying on an
      // i32.and to skip one (increment-14's rule).
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(TO);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(A);
      c.localGet(S);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(strT);
      c.localSet(B);
      c.localGet(A);
      c.i32Const(0x24); // '$'
      c.i32Eq();
      c.localGet(B);
      c.i32Const(0x7b); // '{'
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }

  /** `%w.insp.pickQuote(s, from, to)` → the quote UNIT. Node's ladder:
   * single quotes; double when the text has a `'` but no `"`; backtick
   * when it has both but no backtick and no `${`; single otherwise (with
   * the `'`s escaped). C returns 39/-1/-2 sentinels and maps them — the
   * unit itself carries the same information. */
  private pickQuote(): number {
    return this.cached("pickQuote", [this.deps.strRef(), I32, I32], [I32], (idx) => {
      const c = new Code();
      const S = 0;
      const FROM = 1;
      const TO = 2;
      const has = (unit: number): void => {
        c.localGet(S);
        c.localGet(FROM);
        c.localGet(TO);
        c.i32Const(unit);
        c.call(this.contains());
      };
      has(0x27);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0x27);
      c.return_();
      c.end();
      has(0x22);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0x22);
      c.return_();
      c.end();
      // Nested ifs, not an i32.and: the second scan is pure work the
      // short-circuit would skip.
      has(0x60);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(S);
      c.localGet(FROM);
      c.localGet(TO);
      c.call(this.hasDollarBrace());
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0x60);
      c.return_();
      c.end();
      c.end();
      c.i32Const(0x27);
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.putHex(v, digits, upper)` — `digits` hex digits of `v`, most
   * significant first. Node's two cases: `\xNN` goes through
   * `toUpperCase()` and `\udNNN` through a bare `toString(16)`, so the
   * case flag is the whole difference. */
  private putHex(): number {
    return this.cached("putHex", [I32, I32, I32], [], (idx) => {
      const c = new Code();
      const V = 0;
      const DIGITS = 1;
      const UPPER = 2;
      const SH = 3;
      const D = 4;
      c.localGet(DIGITS);
      c.i32Const(1);
      c.i32Sub();
      c.i32Const(2);
      c.i32Shl();
      c.localSet(SH);
      c.block();
      c.loop();
      c.localGet(SH);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(V);
      c.localGet(SH);
      c.i32ShrU();
      c.i32Const(0xf);
      c.i32And();
      c.localSet(D);
      c.localGet(D);
      c.i32Const(10);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0x30);
      c.localGet(D);
      c.i32Add();
      c.call(this.ibPutc());
      c.else_();
      // 0x37 + 10 = 'A', 0x57 + 10 = 'a'.
      c.localGet(UPPER);
      c.ifResult(I32);
      c.i32Const(0x37);
      c.else_();
      c.i32Const(0x57);
      c.end();
      c.localGet(D);
      c.i32Add();
      c.call(this.ibPutc());
      c.end();
      c.localGet(SH);
      c.i32Const(4);
      c.i32Sub();
      c.localSet(SH);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  /** `%w.insp.putC0(unit)` — inspect.js's `meta` table for 0x00-0x1f: the
   * five named escapes, `\xNN` (uppercase) for the rest. */
  private putC0(): number {
    return this.cached("putC0", [I32], [], (idx) => {
      const c = new Code();
      const U = 0;
      const named: [number, string][] = [
        [0x08, "\\b"],
        [0x09, "\\t"],
        [0x0a, "\\n"],
        [0x0c, "\\f"],
        [0x0d, "\\r"],
      ];
      for (const [unit, text] of named) {
        c.localGet(U);
        c.i32Const(unit);
        c.i32Eq();
        c.ifVoid();
        this.deps.lit(c, text);
        c.call(this.ibPuts());
        c.return_();
        c.end();
      }
      this.deps.lit(c, "\\x");
      c.call(this.ibPuts());
      c.localGet(U);
      c.i32Const(2);
      c.i32Const(1);
      c.call(this.putHex());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.escapeInto(s, from, to, quote)` — strEscape's body between
   * the quotes, appended to the open region: backslash doubled, C0 through
   * the meta table, DEL and C1 as `\xNN` (uppercase), UNPAIRED surrogates
   * as `\udNNN` (lowercase), and the single quote escaped only when
   * quoting with one. A paired surrogate is copied as its two units. */
  private escapeInto(): number {
    return this.cached("escapeInto", [this.deps.strRef(), I32, I32, I32], [], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const S = 0;
      const FROM = 1;
      const TO = 2;
      const Q = 3;
      const I = 4;
      const U = 5;
      const U2 = 6;
      c.localGet(FROM);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(TO);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(U);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.localGet(U);
      c.i32Const(0x20);
      c.i32LtS();
      c.ifVoid();
      c.localGet(U);
      c.call(this.putC0());
      c.else_();
      c.localGet(U);
      c.i32Const(0x27);
      c.i32Eq();
      c.localGet(Q);
      c.i32Const(0x27);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      this.deps.lit(c, "\\'");
      c.call(this.ibPuts());
      c.else_();
      c.localGet(U);
      c.i32Const(0x5c);
      c.i32Eq();
      c.ifVoid();
      this.deps.lit(c, "\\\\");
      c.call(this.ibPuts());
      c.else_();
      c.localGet(U);
      c.i32Const(0x7f);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0x9f);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      this.deps.lit(c, "\\x");
      c.call(this.ibPuts());
      c.localGet(U);
      c.i32Const(2);
      c.i32Const(1);
      c.call(this.putHex());
      c.else_();
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0xdfff);
      c.i32LeS();
      c.i32And();
      c.ifVoid();
      // A surrogate. Paired with a following low half INSIDE the range?
      // Then it is an ordinary astral character and both units pass
      // through. The bounds test guards the read, which sits in the body.
      c.i32Const(0);
      c.localSet(U2);
      c.localGet(U);
      c.i32Const(0xdbff);
      c.i32LeS();
      c.localGet(I);
      c.localGet(TO);
      c.i32LtS();
      c.i32And();
      c.ifVoid();
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(U2);
      c.localGet(U2);
      c.i32Const(0xdc00);
      c.i32GeS();
      c.localGet(U2);
      c.i32Const(0xdfff);
      c.i32LeS();
      c.i32And();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(U2);
      c.end();
      c.end();
      c.localGet(U2);
      c.ifVoid();
      c.localGet(U);
      c.call(this.ibPutc());
      c.localGet(U2);
      c.call(this.ibPutc());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.else_();
      this.deps.lit(c, "\\u");
      c.call(this.ibPuts());
      c.localGet(U);
      c.i32Const(4);
      c.i32Const(0);
      c.call(this.putHex());
      c.end();
      c.else_();
      c.localGet(U);
      c.call(this.ibPutc());
      c.end();
      c.end();
      c.end();
      c.end();
      c.end();
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }

  /** `%w.insp.quoteInto(s, from, to)` — the picked quote, the escaped
   * body, the quote again, appended to the open region (C's
   * `insp_quote_into`, which the layout engine also calls directly). */
  quoteInto(): number {
    return this.cached("quoteInto", [this.deps.strRef(), I32, I32], [], (idx) => {
      const c = new Code();
      const S = 0;
      const FROM = 1;
      const TO = 2;
      const Q = 3;
      c.localGet(S);
      c.localGet(FROM);
      c.localGet(TO);
      c.call(this.pickQuote());
      c.localSet(Q);
      c.localGet(Q);
      c.call(this.ibPutc());
      c.localGet(S);
      c.localGet(FROM);
      c.localGet(TO);
      c.localGet(Q);
      c.call(this.escapeInto());
      c.localGet(Q);
      c.call(this.ibPutc());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /* ── the leaf renderings ────────────────────────────────────────────── */

  /** `%w.insp.str(s)` → str — formatPrimitive's string arm under the
   * default options: the 10000-unit cap with its `... N more character(s)`
   * trailer, then the per-line ` +` continuation when the (truncated) text
   * is longer than 16 units AND longer than breakLength - indentation - 4,
   * split AFTER each newline with every chunk quoted on its own. */
  str(): number {
    return this.cached("str", [this.deps.strRef()], [this.deps.strRef()], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const S = 0;
      const MARK = 1;
      const N = 2;
      const REM = 3;
      const I = 4;
      const CS = 5; // chunk start
      const FIRST = 6;
      const END = 7;
      const SPLIT = 8;
      c.globalGet(this.len());
      c.localSet(MARK);
      c.localGet(S);
      c.arrayLen();
      c.localSet(N);
      c.i32Const(0);
      c.localSet(REM);
      // maxStringLength: a PLAIN unit slice. A pair split at the cap keeps
      // its high half, which the ladder below escapes as \udNNN — exactly
      // what `value.slice(0, 10000)` gives Node (measured).
      c.localGet(N);
      c.i32Const(MAX_STRING_LENGTH);
      c.i32GtS();
      c.ifVoid();
      c.localGet(N);
      c.i32Const(MAX_STRING_LENGTH);
      c.i32Sub();
      c.localSet(REM);
      c.i32Const(MAX_STRING_LENGTH);
      c.localSet(N);
      c.end();
      // The split gate, as nested ifs so neither scan runs needlessly.
      // The bound is SIGNED (see the header): Node computes it in JS
      // numbers, where indentation past 76 makes it negative.
      c.i32Const(0);
      c.localSet(SPLIT);
      c.localGet(N);
      c.i32Const(MIN_LINE_LENGTH);
      c.i32GtS();
      c.ifVoid();
      c.localGet(N);
      c.i32Const(BREAK_LENGTH - 4);
      c.globalGet(this.indentGlobal());
      c.i32Sub();
      c.i32GtS();
      c.ifVoid();
      c.localGet(S);
      c.i32Const(0);
      c.localGet(N);
      c.i32Const(0x0a);
      c.call(this.contains());
      c.localSet(SPLIT);
      c.end();
      c.end();
      c.localGet(SPLIT);
      c.ifVoid();
      c.i32Const(0);
      c.localSet(CS);
      c.i32Const(1);
      c.localSet(FIRST);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GtS();
      c.brIf(1);
      // A chunk ends after each newline, and the tail (if non-empty) at
      // the end. `i == n` must gate the read: n is the TRUNCATED length,
      // so s[n] can be in bounds and still not ours.
      c.i32Const(0);
      c.localSet(END);
      c.localGet(I);
      c.localGet(N);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.localGet(CS);
      c.i32GtS();
      c.ifVoid();
      c.localGet(I);
      c.localSet(END);
      c.end();
      c.else_();
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(0x0a);
      c.i32Eq();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(END);
      c.end();
      c.end();
      c.localGet(END);
      c.ifVoid();
      c.localGet(FIRST);
      c.i32Eqz();
      c.ifVoid();
      this.deps.lit(c, " +\n");
      c.call(this.ibPuts());
      c.globalGet(this.indentGlobal());
      c.i32Const(2);
      c.i32Add();
      c.call(this.ibSpaces());
      c.end();
      c.localGet(S);
      c.localGet(CS);
      c.localGet(END);
      c.call(this.quoteInto());
      c.localGet(END);
      c.localSet(CS);
      c.i32Const(0);
      c.localSet(FIRST);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.else_();
      c.localGet(S);
      c.i32Const(0);
      c.localGet(N);
      c.call(this.quoteInto());
      c.end();
      // remainingText: `... N more character` + the plural 's'.
      c.localGet(REM);
      c.ifVoid();
      this.deps.lit(c, "... ");
      c.call(this.ibPuts());
      c.localGet(REM);
      c.f64ConvertI32S();
      c.call(this.deps.f64ToStr());
      c.call(this.ibPuts());
      this.deps.lit(c, " more character");
      c.call(this.ibPuts());
      c.localGet(REM);
      c.i32Const(1);
      c.i32GtS();
      c.ifVoid();
      c.i32Const(0x73); // 's'
      c.call(this.ibPutc());
      c.end();
      c.end();
      c.localGet(MARK);
      c.call(this.ibTake());
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /** `%w.insp.key(k)` → str — formatProperty's key arm over a RUNTIME
   * string (the synthesized index-signature record helpers): bare when it
   * matches Node's keyStrRegExp `/^[a-zA-Z_][a-zA-Z_0-9]*$/` — an
   * ASCII-only test, and the empty string is NOT bare — `['__proto__']`
   * for the one exception, the quote ladder otherwise. */
  key(): number {
    return this.cached("key", [this.deps.strRef()], [this.deps.strRef()], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const K = 0;
      const MARK = 1;
      const N = 2;
      const I = 3;
      const BARE = 4;
      const U = 5;
      const HEAD = 6;
      c.globalGet(this.len());
      c.localSet(MARK);
      c.localGet(K);
      c.arrayLen();
      c.localSet(N);
      // '__proto__' renders as a computed key. The nine unit compares are
      // ANDed without short-circuiting, which is safe BECAUSE the length
      // test is the enclosing if — every index is known in bounds.
      c.localGet(N);
      c.i32Const(9);
      c.i32Eq();
      c.ifVoid();
      const proto = "__proto__";
      for (let i = 0; i < proto.length; i++) {
        c.localGet(K);
        c.i32Const(i);
        c.arrayGetU(strT);
        c.i32Const(proto.charCodeAt(i));
        c.i32Eq();
        if (i > 0) c.i32And();
      }
      c.ifVoid();
      this.deps.lit(c, "['__proto__']");
      c.call(this.ibPuts());
      c.localGet(MARK);
      c.call(this.ibTake());
      c.return_();
      c.end();
      c.end();
      c.localGet(N);
      c.i32Const(0);
      c.i32GtS();
      c.localSet(BARE);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(BARE);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(K);
      c.localGet(I);
      c.arrayGetU(strT);
      c.localSet(U);
      // head: [a-zA-Z_]; tail adds [0-9].
      c.localGet(U);
      c.i32Const(0x61);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0x7a);
      c.i32LeS();
      c.i32And();
      c.localGet(U);
      c.i32Const(0x41);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0x5a);
      c.i32LeS();
      c.i32And();
      c.i32Or();
      c.localGet(U);
      c.i32Const(0x5f);
      c.i32Eq();
      c.i32Or();
      c.localSet(HEAD);
      c.localGet(I);
      c.i32Eqz();
      c.ifResult(I32);
      c.localGet(HEAD);
      c.else_();
      c.localGet(HEAD);
      c.localGet(U);
      c.i32Const(0x30);
      c.i32GeS();
      c.localGet(U);
      c.i32Const(0x39);
      c.i32LeS();
      c.i32And();
      c.i32Or();
      c.end();
      c.localSet(BARE);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(BARE);
      c.ifVoid();
      c.localGet(K);
      c.call(this.ibPuts());
      c.else_();
      c.localGet(K);
      c.i32Const(0);
      c.localGet(N);
      c.call(this.quoteInto());
      c.end();
      c.localGet(MARK);
      c.call(this.ibTake());
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32], c.bytes());
    });
  }

  /* ── the frame stack ──────────────────────────────────────────────────
   * C's `InspFrame` array becomes ONE FLAT ITEM STACK plus a small frame
   * table, which is sound because frames are strictly LIFO — begin/end
   * bracket a composite and the frontend's synthesized helpers nest them
   * the way the type nests. A frame is then just the index its items start
   * at, so `insp.entry` is a push onto the flat stack and `insp.end` reads
   * a contiguous span. C mallocs a per-frame item array instead; the flat
   * stack costs one allocation for the whole render.
   *
   * ENTRIES ARE FINISHED STRINGS, never open buffer regions. The frontend
   * guarantees it — lower-inspect.ts concatenates key, ": " and the child's
   * rendering into one value before calling insp.entry — and the engine
   * must keep it that way: an entry held open as a region would sit under
   * the marks that `insp.end` and grid rows take, and the LIFO argument
   * that makes the shared buffer sound would no longer hold. */

  private itemsG: number | null = null;
  private nitemsG: number | null = null;
  private fbaseG: number | null = null;
  private fnumG: number | null = null;
  private nframesG: number | null = null;
  private curDepthG: number | null = null;
  private strArrT: number | null = null;
  private i32ArrT: number | null = null;

  /** `(array (mut (ref null $str)))` — the item stack's storage, and the
   * scratch rows grid grouping builds. */
  private strArr(): number {
    this.strArrT ??= this.mb.arrayType(this.deps.strRef(), true);
    return this.strArrT;
  }

  private i32Arr(): number {
    this.i32ArrT ??= this.mb.arrayType(I32, true);
    return this.i32ArrT;
  }

  private strArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strArr() };
  }

  private i32ArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.i32Arr() };
  }

  private nullArrGlobal(field: "itemsG" | "fbaseG" | "fnumG", arrType: () => number): number {
    if (this[field] === null) {
      const t = arrType();
      this[field] = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: t }, true, (w) => {
        w.u8(0xd0);
        w.sleb(t);
      });
    }
    return this[field]!;
  }

  private counterGlobal(field: "nitemsG" | "nframesG"): number {
    this[field] ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this[field]!;
  }

  private items(): number {
    return this.nullArrGlobal("itemsG", () => this.strArr());
  }

  private nitems(): number {
    return this.counterGlobal("nitemsG");
  }

  private fbase(): number {
    return this.nullArrGlobal("fbaseG", () => this.i32Arr());
  }

  private fnum(): number {
    return this.nullArrGlobal("fnumG", () => this.i32Arr());
  }

  private nframes(): number {
    return this.counterGlobal("nframesG");
  }

  /** `ctx.currentDepth` — the recursion depth of the last composite
   * ENTERED, which is what reduceToSingleString's compact window measures
   * against. */
  private curDepth(): number {
    this.curDepthG ??= this.mb.addGlobal(F64, true, (w) => {
      w.u8(0x44);
      w.f64(0);
    });
    return this.curDepthG;
  }

  /** Grow a global i32 array to hold at least `need` elements, preserving
   * `keep` of them. Doubling from an 8-element floor. */
  private growI32(name: string, global: () => number): number {
    return this.cached(name, [I32, I32], [], (idx) => {
      const arrT = this.i32Arr();
      const c = new Code();
      const NEED = 0;
      const KEEP = 1;
      const CAP = 2;
      const NA = 3;
      c.globalGet(global());
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(NEED);
      c.globalGet(global());
      c.arrayLen();
      c.i32LeU();
      c.ifVoid();
      c.return_();
      c.end();
      c.globalGet(global());
      c.arrayLen();
      c.localSet(CAP);
      c.end();
      c.localGet(CAP);
      c.i32Const(8);
      c.i32LtU();
      c.ifVoid();
      c.i32Const(8);
      c.localSet(CAP);
      c.end();
      c.block();
      c.loop();
      c.localGet(CAP);
      c.localGet(NEED);
      c.i32GeU();
      c.brIf(1);
      c.localGet(CAP);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(CAP);
      // The ibEnsure guard, for the same reason: a capacity that doubles
      // through the i32 top is 0 and would loop forever.
      c.localGet(CAP);
      c.i32Eqz();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(CAP);
      c.arrayNewDefault(arrT);
      c.localSet(NA);
      c.localGet(KEEP);
      c.ifVoid();
      c.localGet(NA);
      c.i32Const(0);
      c.globalGet(global());
      c.i32Const(0);
      c.localGet(KEEP);
      c.arrayCopy(arrT, arrT);
      c.end();
      c.localGet(NA);
      c.globalSet(global());
      this.mb.setBody(idx, [I32, this.i32ArrRef()], c.bytes());
    });
  }

  /** `%w.insp.growItems(need)` — the same doubling over the item stack. */
  private growItems(): number {
    return this.cached("growItems", [I32], [], (idx) => {
      const arrT = this.strArr();
      const c = new Code();
      const NEED = 0;
      const CAP = 1;
      const NA = 2;
      c.globalGet(this.items());
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(NEED);
      c.globalGet(this.items());
      c.arrayLen();
      c.i32LeU();
      c.ifVoid();
      c.return_();
      c.end();
      c.globalGet(this.items());
      c.arrayLen();
      c.localSet(CAP);
      c.end();
      c.localGet(CAP);
      c.i32Const(16);
      c.i32LtU();
      c.ifVoid();
      c.i32Const(16);
      c.localSet(CAP);
      c.end();
      c.block();
      c.loop();
      c.localGet(CAP);
      c.localGet(NEED);
      c.i32GeU();
      c.brIf(1);
      c.localGet(CAP);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(CAP);
      c.localGet(CAP);
      c.i32Eqz();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(CAP);
      c.arrayNewDefault(arrT);
      c.localSet(NA);
      c.globalGet(this.nitems());
      c.ifVoid();
      c.localGet(NA);
      c.i32Const(0);
      c.globalGet(this.items());
      c.i32Const(0);
      c.globalGet(this.nitems());
      c.arrayCopy(arrT, arrT);
      c.end();
      c.localGet(NA);
      c.globalSet(this.items());
      this.mb.setBody(idx, [I32, this.strArrRef()], c.bytes());
    });
  }

  /** `%w.insp.begin(recurse)` — formatRaw's frame entry: `recurseTimes +=
   * 1; ctx.currentDepth = recurseTimes` plus the uniform +2 the children
   * format under (formatProperty's `diff`, which is 2 whenever compact is a
   * number — always, here). A recursion depth of 1 is a fresh TOP-LEVEL
   * value, and resets the per-inspect circular state the way Node's
   * per-call ctx does. */
  begin(): number {
    return this.cached("begin", [F64], [], (idx) => {
      const c = new Code();
      const R = 0;
      c.localGet(R);
      c.f64Const(1);
      c.f64Eq();
      c.ifVoid();
      c.i32Const(0);
      c.globalSet(this.nseen());
      c.i32Const(0);
      c.globalSet(this.ncirc());
      c.end();
      // Room for one more frame, keeping the frames already stacked.
      c.globalGet(this.nframes());
      c.i32Const(1);
      c.i32Add();
      c.globalGet(this.nframes());
      c.call(this.growI32("growFbase", () => this.fbase()));
      c.globalGet(this.nframes());
      c.i32Const(1);
      c.i32Add();
      c.globalGet(this.nframes());
      c.call(this.growI32("growFnum", () => this.fnum()));
      c.globalGet(this.fbase());
      c.globalGet(this.nframes());
      c.globalGet(this.nitems());
      c.arraySet(this.i32Arr());
      c.globalGet(this.fnum());
      c.globalGet(this.nframes());
      c.i32Const(1); // all_num starts true
      c.arraySet(this.i32Arr());
      c.globalGet(this.nframes());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.nframes());
      c.localGet(R);
      c.globalSet(this.curDepth());
      c.globalGet(this.indentGlobal());
      c.i32Const(2);
      c.i32Add();
      c.globalSet(this.indentGlobal());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.entry(s, isNum)` — one already-rendered entry. `isNum`
   * mirrors `typeof value[i] === 'number'`, which decides grid grouping's
   * padStart-vs-padEnd order. */
  entry(): number {
    return this.cached("entry", [this.deps.strRef(), I32], [], (idx) => {
      const c = new Code();
      const S = 0;
      const NUM = 1;
      c.globalGet(this.nitems());
      c.i32Const(1);
      c.i32Add();
      c.call(this.growItems());
      c.globalGet(this.items());
      c.globalGet(this.nitems());
      c.localGet(S);
      c.arraySet(this.strArr());
      c.globalGet(this.nitems());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.nitems());
      c.localGet(NUM);
      c.i32Eqz();
      c.ifVoid();
      c.globalGet(this.fnum());
      c.globalGet(this.nframes());
      c.i32Const(1);
      c.i32Sub();
      c.i32Const(0);
      c.arraySet(this.i32Arr());
      c.end();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.moreItems(remaining)` — remainingText's tail entry. */
  moreItems(): number {
    return this.cached("moreItems", [F64], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const REM = 0;
      const MARK = 1;
      c.globalGet(this.len());
      c.localSet(MARK);
      this.deps.lit(c, "... ");
      c.call(this.ibPuts());
      c.localGet(REM);
      c.call(this.deps.f64ToStr());
      c.call(this.ibPuts());
      this.deps.lit(c, " more item");
      c.call(this.ibPuts());
      c.localGet(REM);
      c.f64Const(1);
      c.f64Gt();
      c.ifVoid();
      c.i32Const(0x73); // 's'
      c.call(this.ibPutc());
      c.end();
      c.localGet(MARK);
      c.call(this.ibTake());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.insp.popFrame(baseIdx)` — drop the top frame, releasing the item
   * slots so a finished render stops pinning its strings (C releases each;
   * the flat stack has to null them or the module-global array keeps every
   * string of the largest render alive for the process's life). */
  private popFrame(): number {
    return this.cached("popFrame", [I32], [], (idx) => {
      const c = new Code();
      const BI = 0;
      const I = 1;
      c.localGet(BI);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.globalGet(this.nitems());
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.items());
      c.localGet(I);
      c.refNull(this.deps.strType());
      c.arraySet(this.strArr());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(BI);
      c.globalSet(this.nitems());
      c.globalGet(this.nframes());
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(this.nframes());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** The top frame's item base — `fbase[nframes - 1]`. */
  private pushTopBase(c: Code): void {
    c.globalGet(this.fbase());
    c.globalGet(this.nframes());
    c.i32Const(1);
    c.i32Sub();
    c.arrayGet(this.i32Arr());
  }

  /** The item at a flat index (pushed by the caller). */
  private pushItem(c: Code, pushIndex: (c: Code) => void): void {
    c.globalGet(this.items());
    pushIndex(c);
    c.arrayGet(this.strArr());
  }

  /** `%w.insp.belowBreak(base, start)` → i32 — isBelowBreakLength over the
   * top frame, counting UTF-16 LENGTHS (not widths — that is the grid's
   * measure, and the two are deliberately different in Node).
   *
   * The entry count is added TWICE, once into `total` and again in the
   * early test, which is Node's own comment-acknowledged rough estimate.
   * It is kept for fidelity, and for n >= 1 it is also PROVABLY REDUNDANT:
   * the early test fails only when `2n + start > 80`, and since every entry
   * renders at least one character the accumulating loop reaches `n + start
   * + sum >= 2n + start` by its last iteration, so it would have failed
   * too. (An entry can never be empty: the frontend builds each as `key +
   * ": " + value`, or as a child rendering, and no rendering in the tier
   * produces the empty string.)
   *
   * The n = 0 case is the one place the two forms differ — the early test
   * can still fail on `start > 80` where the loop has no iterations to fail
   * in — and it is unreachable: every caller answers an empty composite
   * with its literal BEFORE opening a frame, so no frame ever reaches `end`
   * with zero entries. So the line stays verbatim and stays unpinned; there
   * is no reachable input that distinguishes the two, and a test asserting
   * otherwise would be pinning something Node does not do. */
  private belowBreak(): number {
    return this.cached("belowBreak", [this.deps.strRef(), I32], [I32], (idx) => {
      const c = new Code();
      const BASE = 0;
      const START = 1;
      const BI = 2;
      const N = 3;
      const TOTAL = 4;
      const I = 5;
      this.pushTopBase(c);
      c.localSet(BI);
      c.globalGet(this.nitems());
      c.localGet(BI);
      c.i32Sub();
      c.localSet(N);
      c.localGet(N);
      c.localGet(START);
      c.i32Add();
      c.localSet(TOTAL);
      c.localGet(TOTAL);
      c.localGet(N);
      c.i32Add();
      c.i32Const(BREAK_LENGTH);
      c.i32GtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(TOTAL);
      this.pushItem(c, (x) => {
        x.localGet(BI);
        x.localGet(I);
        x.i32Add();
      });
      c.arrayLen();
      c.i32Add();
      c.localSet(TOTAL);
      c.localGet(TOTAL);
      c.i32Const(BREAK_LENGTH);
      c.i32GtS();
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
      // `base === '' || !base.includes('\n')`
      c.localGet(BASE);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(BASE);
      c.i32Const(0);
      c.localGet(BASE);
      c.arrayLen();
      c.i32Const(0x0a);
      c.call(this.contains());
      c.i32Eqz();
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
    });
  }

  /** `%w.insp.group(trailingMore)` — groupArrayElements, which rewrites the
   * top frame's items into grid ROWS when the entries are short and
   * numerous. The measure here is DISPLAY WIDTH (insp_width), unlike
   * break-length's code units.
   *
   * Node's padding expression is `maxLineLength[col] + output[j].length -
   * dataLen[j]` as a padStart/padEnd TARGET, mixing a width-derived column
   * size with a length-derived correction; since the pad target is a
   * length and the string's own length appears on both sides, the whole
   * thing reduces to `maxLineLength[col] - width - 2` SPACES, which is what
   * this emits (and what the C emits). The correction terms exist for
   * colored output, which the frontend fences off. */
  private group(): number {
    return this.cached("group", [I32], [], (idx) => {
      const c = new Code();
      const MORE = 0;
      const BI = 1;
      const FULL = 2;
      const OUT = 3;
      const I = 4;
      const J = 5;
      const W = 6;
      const NCOLS = 7;
      const MAX = 8;
      const TARGET = 9;
      const PADSTART = 10;
      const MARK = 11;
      const LM = 12;
      const NROWS = 13;
      const TOTAL = 14; // f64
      const MAXLEN = 15; // f64
      const ACTMAX = 16; // f64
      const BMAX = 17; // f64
      const COLS = 18; // f64
      const DL = 19; // i32 array
      const MLL = 20; // i32 array
      const ROWS = 21; // str array
      this.pushTopBase(c);
      c.localSet(BI);
      c.globalGet(this.nitems());
      c.localGet(BI);
      c.i32Sub();
      c.localSet(FULL);
      // The "... n more items" tail is excluded from the grid.
      c.localGet(FULL);
      c.localGet(MORE);
      c.ifResult(I32);
      c.i32Const(1);
      c.else_();
      c.i32Const(0);
      c.end();
      c.i32Sub();
      c.localSet(OUT);
      c.localGet(OUT);
      c.arrayNewDefault(this.i32Arr());
      c.localSet(DL);
      c.f64Const(0);
      c.localSet(TOTAL);
      c.f64Const(0);
      c.localSet(MAXLEN);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(OUT);
      c.i32GeS();
      c.brIf(1);
      this.pushItem(c, (x) => {
        x.localGet(BI);
        x.localGet(I);
        x.i32Add();
      });
      c.call(this.width());
      c.localSet(W);
      c.localGet(DL);
      c.localGet(I);
      c.localGet(W);
      c.arraySet(this.i32Arr());
      c.localGet(TOTAL);
      c.localGet(W);
      c.f64ConvertI32S();
      c.f64Add();
      c.f64Const(2);
      c.f64Add();
      c.localSet(TOTAL);
      c.localGet(MAXLEN);
      c.localGet(W);
      c.f64ConvertI32S();
      c.f64Lt();
      c.ifVoid();
      c.localGet(W);
      c.f64ConvertI32S();
      c.localSet(MAXLEN);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(MAXLEN);
      c.f64Const(2);
      c.f64Add();
      c.localSet(ACTMAX);
      // Gate 1: at least three entries fit side by side.
      c.localGet(ACTMAX);
      c.f64Const(3);
      c.f64Mul();
      c.globalGet(this.indentGlobal());
      c.f64ConvertI32S();
      c.f64Add();
      c.f64Const(BREAK_LENGTH);
      c.f64Lt();
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      // Gate 2: no single entry dwarfs the rest.
      c.localGet(TOTAL);
      c.localGet(ACTMAX);
      c.f64Div();
      c.f64Const(5);
      c.f64Gt();
      c.localGet(MAXLEN);
      c.f64Const(6);
      c.f64Le();
      c.i32Or();
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      // averageBias divides by the FULL entry count (the more-items tail
      // included) while the column estimate uses the grid's count — that
      // asymmetry is Node's, verbatim.
      c.localGet(ACTMAX);
      c.f64Const(3);
      c.f64Sub();
      c.localGet(ACTMAX);
      c.localGet(TOTAL);
      c.localGet(FULL);
      c.f64ConvertI32S();
      c.f64Div();
      c.f64Sub();
      c.f64Sqrt();
      c.f64Sub();
      c.f64Const(1);
      c.f64Max();
      c.localSet(BMAX);
      // columns = min(round(sqrt(2.5 * biasedMax * out) / biasedMax),
      //               floor((80 - indent) / actualMax), compact * 4, 15)
      c.f64Const(2.5);
      c.localGet(BMAX);
      c.f64Mul();
      c.localGet(OUT);
      c.f64ConvertI32S();
      c.f64Mul();
      c.f64Sqrt();
      c.localGet(BMAX);
      c.f64Div();
      // MathRound is floor(x + 0.5) — NOT f64.nearest, which breaks ties to
      // even. The argument is never negative here, so the two forms of
      // "round half up" agree.
      c.f64Const(0.5);
      c.f64Add();
      c.f64Floor();
      c.f64Const(BREAK_LENGTH);
      c.globalGet(this.indentGlobal());
      c.f64ConvertI32S();
      c.f64Sub();
      c.localGet(ACTMAX);
      c.f64Div();
      c.f64Floor();
      c.f64Min();
      c.f64Const(COMPACT * 4);
      c.f64Min();
      c.f64Const(15);
      c.f64Min();
      c.localSet(COLS);
      c.localGet(COLS);
      c.f64Const(1);
      c.f64Le();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(COLS);
      c.i32TruncF64S();
      c.localSet(NCOLS);
      // maxLineLength per column: the widest entry in that column, + 2.
      c.localGet(NCOLS);
      c.arrayNewDefault(this.i32Arr());
      c.localSet(MLL);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(NCOLS);
      c.i32GeS();
      c.brIf(1);
      c.i32Const(0);
      c.localSet(LM);
      c.localGet(I);
      c.localSet(J);
      c.block();
      c.loop();
      c.localGet(J);
      c.localGet(OUT);
      c.i32GeS();
      c.brIf(1);
      c.localGet(DL);
      c.localGet(J);
      c.arrayGet(this.i32Arr());
      c.localSet(W);
      c.localGet(W);
      c.localGet(LM);
      c.i32GtS();
      c.ifVoid();
      c.localGet(W);
      c.localSet(LM);
      c.end();
      c.localGet(J);
      c.localGet(NCOLS);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      c.localGet(MLL);
      c.localGet(I);
      c.localGet(LM);
      c.i32Const(2);
      c.i32Add();
      c.arraySet(this.i32Arr());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.globalGet(this.fnum());
      c.globalGet(this.nframes());
      c.i32Const(1);
      c.i32Sub();
      c.arrayGet(this.i32Arr());
      c.localSet(PADSTART);
      // One row per NCOLS entries, plus a slot for the more-items tail.
      c.localGet(OUT);
      c.localGet(NCOLS);
      c.i32Add();
      c.i32Const(1);
      c.i32Sub();
      c.localGet(NCOLS);
      c.i32DivS();
      c.i32Const(1);
      c.i32Add();
      c.arrayNewDefault(this.strArr());
      c.localSet(ROWS);
      c.i32Const(0);
      c.localSet(NROWS);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(OUT);
      c.i32GeS();
      c.brIf(1);
      c.localGet(I);
      c.localGet(NCOLS);
      c.i32Add();
      c.localGet(OUT);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(I);
      c.localGet(NCOLS);
      c.i32Add();
      c.else_();
      c.localGet(OUT);
      c.end();
      c.localSet(MAX);
      c.globalGet(this.len());
      c.localSet(MARK);
      c.localGet(I);
      c.localSet(J);
      // Every entry but the last in the row carries its ", " separator and
      // is padded to the column width.
      c.block();
      c.loop();
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localGet(MAX);
      c.i32GeS();
      c.brIf(1);
      c.localGet(DL);
      c.localGet(J);
      c.arrayGet(this.i32Arr());
      c.localSet(W);
      c.localGet(MLL);
      c.localGet(J);
      c.localGet(I);
      c.i32Sub();
      c.arrayGet(this.i32Arr());
      c.localSet(TARGET);
      c.localGet(PADSTART);
      c.ifVoid();
      c.localGet(TARGET);
      c.localGet(W);
      c.i32Sub();
      c.i32Const(2);
      c.i32Sub();
      c.call(this.ibSpaces());
      this.pushItem(c, (x) => {
        x.localGet(BI);
        x.localGet(J);
        x.i32Add();
      });
      c.call(this.ibPuts());
      this.deps.lit(c, ", ");
      c.call(this.ibPuts());
      c.else_();
      this.pushItem(c, (x) => {
        x.localGet(BI);
        x.localGet(J);
        x.i32Add();
      });
      c.call(this.ibPuts());
      this.deps.lit(c, ", ");
      c.call(this.ibPuts());
      c.localGet(TARGET);
      c.localGet(W);
      c.i32Sub();
      c.i32Const(2);
      c.i32Sub();
      c.call(this.ibSpaces());
      c.end();
      c.localGet(J);
      c.i32Const(1);
      c.i32Add();
      c.localSet(J);
      c.br(0);
      c.end();
      c.end();
      // The row's last entry: right-aligned under padStart, bare otherwise.
      c.localGet(PADSTART);
      c.ifVoid();
      c.localGet(MLL);
      c.localGet(J);
      c.localGet(I);
      c.i32Sub();
      c.arrayGet(this.i32Arr());
      c.i32Const(2);
      c.i32Sub();
      c.localGet(DL);
      c.localGet(J);
      c.arrayGet(this.i32Arr());
      c.i32Sub();
      c.call(this.ibSpaces());
      c.end();
      this.pushItem(c, (x) => {
        x.localGet(BI);
        x.localGet(J);
        x.i32Add();
      });
      c.call(this.ibPuts());
      c.localGet(ROWS);
      c.localGet(NROWS);
      c.localGet(MARK);
      c.call(this.ibTake());
      c.arraySet(this.strArr());
      c.localGet(NROWS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(NROWS);
      c.localGet(I);
      c.localGet(NCOLS);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(MORE);
      c.ifVoid();
      c.localGet(ROWS);
      c.localGet(NROWS);
      this.pushItem(c, (x) => {
        x.localGet(BI);
        x.localGet(OUT);
        x.i32Add();
      });
      c.arraySet(this.strArr());
      c.localGet(NROWS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(NROWS);
      c.end();
      // Rows replace the entries in place; the frame shrinks.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(NROWS);
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.items());
      c.localGet(BI);
      c.localGet(I);
      c.i32Add();
      c.localGet(ROWS);
      c.localGet(I);
      c.arrayGet(this.strArr());
      c.arraySet(this.strArr());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(BI);
      c.localGet(NROWS);
      c.i32Add();
      c.globalSet(this.nitems());
      this.mb.setBody(
        idx,
        [I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, F64, F64, F64, F64, F64,
          this.i32ArrRef(), this.i32ArrRef(), this.strArrRef()],
        c.bytes(),
      );
    });
  }

  /** `%w.insp.end(base, b0, b1, recurse, arrayExtras, trailingMore)` →
   * reduceToSingleString for the default options, popping the frame. The
   * single-line form needs three things at once: the composite to be within
   * `compact` levels of the deepest one entered, grouping not to have
   * fired, and the joined entries to fit in breakLength without a newline
   * anywhere. Otherwise one entry per line at indent + 2. */
  end(): number {
    return this.cached(
      "end",
      [this.deps.strRef(), this.deps.strRef(), this.deps.strRef(), F64, I32, I32],
      [this.deps.strRef()],
      (idx) => {
        const c = new Code();
        const BASE = 0;
        const B0 = 1;
        const B1 = 2;
        const RECURSE = 3;
        const EXTRAS = 4;
        const MORE = 5;
        const BI = 6;
        const ENTRIES = 7;
        const N = 8;
        const MARK = 9;
        const I = 10;
        const MULTI = 11;
        const R = 12;
        this.pushTopBase(c);
        c.localSet(BI);
        c.globalGet(this.indentGlobal());
        c.i32Const(2);
        c.i32Sub();
        c.globalSet(this.indentGlobal());
        c.globalGet(this.nitems());
        c.localGet(BI);
        c.i32Sub();
        c.localSet(ENTRIES);
        // Grid grouping runs BEFORE the output region opens (C's order),
        // so its per-row marks nest above nothing of ours.
        c.localGet(EXTRAS);
        c.ifVoid();
        c.localGet(ENTRIES);
        c.i32Const(6);
        c.i32GtS();
        c.ifVoid();
        c.localGet(MORE);
        c.call(this.group());
        c.end();
        c.end();
        c.globalGet(this.nitems());
        c.localGet(BI);
        c.i32Sub();
        c.localSet(N);
        // The single-line attempt.
        c.globalGet(this.curDepth());
        c.localGet(RECURSE);
        c.f64Sub();
        c.f64Const(COMPACT);
        c.f64Lt();
        c.ifVoid();
        c.localGet(ENTRIES);
        c.localGet(N);
        c.i32Eq();
        c.ifVoid();
        c.localGet(BASE);
        c.localGet(N);
        c.globalGet(this.indentGlobal());
        c.i32Add();
        c.localGet(B0);
        c.arrayLen();
        c.i32Add();
        c.localGet(BASE);
        c.arrayLen();
        c.i32Add();
        c.i32Const(10);
        c.i32Add();
        c.call(this.belowBreak());
        c.ifVoid();
        c.i32Const(0);
        c.localSet(MULTI);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        this.pushItem(c, (x) => {
          x.localGet(BI);
          x.localGet(I);
          x.i32Add();
        });
        c.localSet(R);
        c.localGet(R);
        c.i32Const(0);
        c.localGet(R);
        c.arrayLen();
        c.i32Const(0x0a);
        c.call(this.contains());
        c.ifVoid();
        c.i32Const(1);
        c.localSet(MULTI);
        c.br(2);
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(MULTI);
        c.i32Eqz();
        c.ifVoid();
        c.globalGet(this.len());
        c.localSet(MARK);
        this.emitBasePrefix(c, BASE);
        c.localGet(B0);
        c.call(this.ibPuts());
        c.i32Const(0x20);
        c.call(this.ibPutc());
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(I);
        c.ifVoid();
        this.deps.lit(c, ", ");
        c.call(this.ibPuts());
        c.end();
        this.pushItem(c, (x) => {
          x.localGet(BI);
          x.localGet(I);
          x.i32Add();
        });
        c.call(this.ibPuts());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.i32Const(0x20);
        c.call(this.ibPutc());
        c.localGet(B1);
        c.call(this.ibPuts());
        c.localGet(MARK);
        c.call(this.ibTake());
        c.localSet(R);
        c.localGet(BI);
        c.call(this.popFrame());
        c.localGet(R);
        c.return_();
        c.end();
        c.end();
        c.end();
        c.end();
        // The multi-line form: one entry per line at indent + 2.
        c.globalGet(this.len());
        c.localSet(MARK);
        this.emitBasePrefix(c, BASE);
        c.localGet(B0);
        c.call(this.ibPuts());
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(I);
        c.ifVoid();
        this.deps.lit(c, ",\n");
        c.call(this.ibPuts());
        c.else_();
        c.i32Const(0x0a);
        c.call(this.ibPutc());
        c.end();
        c.globalGet(this.indentGlobal());
        c.i32Const(2);
        c.i32Add();
        c.call(this.ibSpaces());
        this.pushItem(c, (x) => {
          x.localGet(BI);
          x.localGet(I);
          x.i32Add();
        });
        c.call(this.ibPuts());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.i32Const(0x0a);
        c.call(this.ibPutc());
        c.globalGet(this.indentGlobal());
        c.call(this.ibSpaces());
        c.localGet(B1);
        c.call(this.ibPuts());
        c.localGet(MARK);
        c.call(this.ibTake());
        c.localSet(R);
        c.localGet(BI);
        c.call(this.popFrame());
        c.localGet(R);
        this.mb.setBody(
          idx,
          [I32, I32, I32, I32, I32, I32, this.deps.strRef()],
          c.bytes(),
        );
      },
    );
  }

  /** `base ? `${base} ` : ''` — the constructor prefix both forms share. */
  private emitBasePrefix(c: Code, BASE: number): void {
    c.localGet(BASE);
    c.arrayLen();
    c.ifVoid();
    c.localGet(BASE);
    c.call(this.ibPuts());
    c.i32Const(0x20);
    c.call(this.ibPutc());
    c.end();
  }

  /* ── circular references ──────────────────────────────────────────────
   * Node's formatValue keeps a SEEN stack (the values on the current
   * traversal path) and a CIRCULAR map (the ones found to repeat, numbered
   * in discovery order). A repeat renders `[Circular *N]`; every rendering
   * of a numbered value gets a `<ref *N> ` prefix. The frontend drives the
   * protocol for cycle-capable types only — circCheck before the empty and
   * depth answers, seenPush after begin, refWrap around end.
   *
   * Identity is `ref.eq` over eqref, the same comparison json.ts's
   * circular detection uses. The numbered table GROWS here; C caps it at 64
   * entries and then answers 0, which the frontend reads as "not circular"
   * and walks into the cycle again — unbounded recursion rather than a
   * wrong string. */

  private seenG: number | null = null;
  private nseenG: number | null = null;
  private circG: number | null = null;
  private ncircG: number | null = null;
  private eqArrT: number | null = null;

  private eqArr(): number {
    this.eqArrT ??= this.mb.arrayType(EQ_REF, true);
    return this.eqArrT;
  }

  private eqArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.eqArr() };
  }

  private eqArrGlobal(field: "seenG" | "circG"): number {
    if (this[field] === null) {
      const t = this.eqArr();
      this[field] = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: t }, true, (w) => {
        w.u8(0xd0);
        w.sleb(t);
      });
    }
    return this[field]!;
  }

  private seen(): number {
    return this.eqArrGlobal("seenG");
  }

  private circ(): number {
    return this.eqArrGlobal("circG");
  }

  private nseen(): number {
    this.nseenG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.nseenG;
  }

  private ncirc(): number {
    this.ncircG ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.ncircG;
  }

  /** Grow one of the eqref stacks, preserving `keep` entries. */
  private growEq(name: string, global: () => number): number {
    return this.cached(name, [I32, I32], [], (idx) => {
      const arrT = this.eqArr();
      const c = new Code();
      const NEED = 0;
      const KEEP = 1;
      const CAP = 2;
      const NA = 3;
      c.globalGet(global());
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(NEED);
      c.globalGet(global());
      c.arrayLen();
      c.i32LeU();
      c.ifVoid();
      c.return_();
      c.end();
      c.globalGet(global());
      c.arrayLen();
      c.localSet(CAP);
      c.end();
      c.localGet(CAP);
      c.i32Const(8);
      c.i32LtU();
      c.ifVoid();
      c.i32Const(8);
      c.localSet(CAP);
      c.end();
      c.block();
      c.loop();
      c.localGet(CAP);
      c.localGet(NEED);
      c.i32GeU();
      c.brIf(1);
      c.localGet(CAP);
      c.i32Const(1);
      c.i32Shl();
      c.localSet(CAP);
      c.localGet(CAP);
      c.i32Eqz();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(CAP);
      c.arrayNewDefault(arrT);
      c.localSet(NA);
      c.localGet(KEEP);
      c.ifVoid();
      c.localGet(NA);
      c.i32Const(0);
      c.globalGet(global());
      c.i32Const(0);
      c.localGet(KEEP);
      c.arrayCopy(arrT, arrT);
      c.end();
      c.localGet(NA);
      c.globalSet(global());
      this.mb.setBody(idx, [I32, this.eqArrRef()], c.bytes());
    });
  }

  /** `%w.insp.circId(v)` → the 1-based circular id, or 0. */
  private circId(): number {
    return this.cached("circId", [EQ_REF], [I32], (idx) => {
      const c = new Code();
      const V = 0;
      const I = 1;
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.globalGet(this.ncirc());
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.circ());
      c.localGet(I);
      c.arrayGet(this.eqArr());
      c.localGet(V);
      c.refEq();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.return_();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.insp.circCheck(v)` → the circular id as an f64, or 0 when `v` is
   * not on the current traversal path. Assigns the id on first detection,
   * which is what makes the numbering discovery-ordered. */
  circCheck(): number {
    return this.cached("circCheck", [EQ_REF], [F64], (idx) => {
      const c = new Code();
      const V = 0;
      const I = 1;
      const ID = 2;
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.globalGet(this.nseen());
      c.i32GeS();
      c.brIf(1);
      c.globalGet(this.seen());
      c.localGet(I);
      c.arrayGet(this.eqArr());
      c.localGet(V);
      c.refEq();
      c.ifVoid();
      c.localGet(V);
      c.call(this.circId());
      c.localSet(ID);
      c.localGet(ID);
      c.i32Eqz();
      c.ifVoid();
      c.globalGet(this.ncirc());
      c.i32Const(1);
      c.i32Add();
      c.globalGet(this.ncirc());
      c.call(this.growEq("growCirc", () => this.circ()));
      c.globalGet(this.circ());
      c.globalGet(this.ncirc());
      c.localGet(V);
      c.arraySet(this.eqArr());
      c.globalGet(this.ncirc());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.ncirc());
      c.globalGet(this.ncirc());
      c.localSet(ID);
      c.end();
      c.localGet(ID);
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
      c.f64Const(0);
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  /** `%w.insp.seenPush(v)` — the value is now on the traversal path. */
  seenPush(): number {
    return this.cached("seenPush", [EQ_REF], [], (idx) => {
      const c = new Code();
      const V = 0;
      c.globalGet(this.nseen());
      c.i32Const(1);
      c.i32Add();
      c.globalGet(this.nseen());
      c.call(this.growEq("growSeen", () => this.seen()));
      c.globalGet(this.seen());
      c.globalGet(this.nseen());
      c.localGet(V);
      c.arraySet(this.eqArr());
      c.globalGet(this.nseen());
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.nseen());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.refWrap(v, s)` — pops the seen stack and prefixes `<ref *N> `
   * when the walk found `v` circular. */
  refWrap(): number {
    return this.cached("refWrap", [EQ_REF, this.deps.strRef()], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const V = 0;
      const S = 1;
      const ID = 2;
      const MARK = 3;
      c.globalGet(this.nseen());
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.globalGet(this.nseen());
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(this.nseen());
      // Drop the slot so a finished render stops pinning the value.
      c.globalGet(this.seen());
      c.globalGet(this.nseen());
      c.refNull(EQ_HEAP);
      c.arraySet(this.eqArr());
      c.end();
      c.localGet(V);
      c.call(this.circId());
      c.localSet(ID);
      c.localGet(ID);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(S);
      c.return_();
      c.end();
      c.globalGet(this.len());
      c.localSet(MARK);
      this.deps.lit(c, "<ref *");
      c.call(this.ibPuts());
      c.localGet(ID);
      c.f64ConvertI32S();
      c.call(this.deps.f64ToStr());
      c.call(this.ibPuts());
      this.deps.lit(c, "> ");
      c.call(this.ibPuts());
      c.localGet(S);
      c.call(this.ibPuts());
      c.localGet(MARK);
      c.call(this.ibTake());
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  /** `%w.insp.circular(id)` → `[Circular *N]`. */
  circular(): number {
    return this.cached("circular", [F64], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const ID = 0;
      const MARK = 1;
      c.globalGet(this.len());
      c.localSet(MARK);
      this.deps.lit(c, "[Circular *");
      c.call(this.ibPuts());
      c.localGet(ID);
      c.call(this.deps.f64ToStr());
      c.call(this.ibPuts());
      c.i32Const(0x5d); // ']'
      c.call(this.ibPutc());
      c.localGet(MARK);
      c.call(this.ibTake());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /* ── errors ───────────────────────────────────────────────────────────
   * The STACKLESS rendering: a compiled module carries no JS stack, so the
   * base is formatError's bracket form — `[Name: message]`, or `[Name]`
   * when the message is empty — which is exactly what Node prints for an
   * error whose `stack` is empty (measured). A stamped `code` slot is the
   * one extra own property, rendered through the frame engine so it breaks
   * and indents like any other object: `[Error: m] { code: 'X' }`.
   * SEMANTICS.md S027 covers the difference from a stack-carrying Node.
   *
   * The NAME comes straight out of the slot, which is sound because only
   * the BUILTIN classes get here — inspect of an error subclass is fenced
   * in the frontend. Node reconstructs a subclass's header from its
   * constructor (`[AppError: m]`, `[MyType [TypeError]: m]`), and this
   * reads the stamped builtin base instead, so unfencing subclasses means
   * porting that rule first. */

  /** `%w.insp.error(e, recurse, depth)` → the error's rendering. */
  error(): number {
    return this.cached("error", [this.errRef(), F64, F64], [this.deps.strRef()], (idx) => {
      const errT = this.deps.errT();
      const c = new Code();
      const E = 0;
      const RECURSE = 1;
      const DEPTH = 2;
      const MARK = 3;
      const I = 4;
      const U = 5;
      const M = 6;
      const BASE = 7;
      const CODE = 8;
      c.localGet(E);
      c.structGet(errT, this.deps.errCode());
      c.localSet(CODE);
      // Beyond the depth budget an error with extra properties collapses to
      // `[Name]`; one WITHOUT them still prints its full base, because the
      // bracket form IS its stack rather than a property dump (measured
      // against Node with an emptied stack, both ways).
      c.localGet(CODE);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(RECURSE);
      c.localGet(DEPTH);
      c.f64Gt();
      c.ifVoid();
      c.globalGet(this.len());
      c.localSet(MARK);
      c.i32Const(0x5b); // '['
      c.call(this.ibPutc());
      c.localGet(E);
      c.structGet(errT, this.deps.errName());
      c.call(this.ibPuts());
      c.i32Const(0x5d); // ']'
      c.call(this.ibPutc());
      c.localGet(MARK);
      c.call(this.ibTake());
      c.return_();
      c.end();
      c.end();
      // The base. Embedded newlines in the message indent to the CURRENT
      // level, which is formatError's closing replaceAll.
      c.globalGet(this.len());
      c.localSet(MARK);
      c.i32Const(0x5b);
      c.call(this.ibPutc());
      c.localGet(E);
      c.structGet(errT, this.deps.errName());
      c.call(this.ibPuts());
      c.localGet(E);
      c.structGet(errT, this.deps.errMessage());
      c.localSet(M);
      c.localGet(M);
      c.arrayLen();
      c.ifVoid();
      this.deps.lit(c, ": ");
      c.call(this.ibPuts());
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(M);
      c.arrayLen();
      c.i32GeS();
      c.brIf(1);
      c.localGet(M);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.localSet(U);
      c.localGet(U);
      c.call(this.ibPutc());
      c.localGet(U);
      c.i32Const(0x0a);
      c.i32Eq();
      c.ifVoid();
      c.globalGet(this.indentGlobal());
      c.call(this.ibSpaces());
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.end();
      c.i32Const(0x5d);
      c.call(this.ibPutc());
      c.localGet(MARK);
      c.call(this.ibTake());
      c.localSet(BASE);
      c.localGet(CODE);
      c.refIsNull();
      c.ifVoid();
      c.localGet(BASE);
      c.return_();
      c.end();
      // `{ code: 'X' }` through the engine, so it breaks like any object.
      c.localGet(RECURSE);
      c.f64Const(1);
      c.f64Add();
      c.call(this.begin());
      c.globalGet(this.len());
      c.localSet(MARK);
      this.deps.lit(c, "code: ");
      c.call(this.ibPuts());
      c.localGet(CODE);
      c.i32Const(0);
      c.localGet(CODE);
      c.arrayLen();
      c.call(this.quoteInto());
      c.localGet(MARK);
      c.call(this.ibTake());
      c.i32Const(0);
      c.call(this.entry());
      c.localGet(BASE);
      this.deps.lit(c, "{");
      this.deps.lit(c, "}");
      c.localGet(RECURSE);
      c.f64Const(1);
      c.f64Add();
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.end());
      this.mb.setBody(
        idx,
        [I32, I32, I32, this.deps.strRef(), this.deps.strRef(), this.deps.strRef()],
        c.bytes(),
      );
    });
  }

  private errRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.deps.errT() };
  }
}
