/* util.inspect's runtime half as emitted WasmGC code: the append buffer,
 * the UTF-16 measures, Node's quoting ladder (strEscape), and the two
 * leaf renderings that need no layout — formatPrimitive's string arm
 * (`insp.str`) and formatProperty's key arm (`insp.key`). The LAYOUT
 * engine (frames, break-length, grid grouping, the circular protocol)
 * and the dyn walker are the stages after this one; the frontend
 * (lower-inspect.ts) owns the per-type traversal either way.
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
 * DISPLAY WIDTH IS A KNOWN DIVERGENCE, and what this file implements is
 * NODE'S NON-ICU TABLES APPLIED PER CODE POINT, WITHOUT NFC NORMALIZATION
 * AND WITHOUT VT-SEQUENCE STRIPPING. All three halves of that sentence
 * matter, because Node does the other two unconditionally: its non-ICU
 * FALLBACK (inspect.js:2695-2711) runs `stripVTControlCharacters` then
 * `normalize('NFC')` before walking code points through exactly these
 * tables, and the ICU path this build actually takes (2671-2688) counts
 * ASCII itself and hands the rest to `icu.getStringWidth`, also over
 * NFC-normalized, VT-stripped text. So the port diverges from BOTH of
 * Node's implementations, not merely from the ICU one, on three axes:
 *
 *   - NFC NORMALIZATION, which can change the code point COUNT and not
 *     just widths: U+1D160 decomposes into three characters that do not
 *     recompose, so Node measures it 3 where a per-code-point walk says 1.
 *   - VT SEQUENCE STRIPPING: `\x1b[31m` measures 0 in Node and 4 here (ESC
 *     is zero-width by the table, `[31m` is four ordinary characters).
 *   - the TABLES themselves are stale against ICU's East_Asian_Width data,
 *     which only separates this file from the ICU path. Measured over all
 *     1,114,112 code points, the two answers differ on 11148 of them, in
 *     480 contiguous ranges (482 if a range is split where the direction
 *     of disagreement changes — which happens only at U+1D160 and
 *     U+1D1BD, the two NFC-expanding musical symbols). 1812 code points
 *     are combining marks outside U+0300..U+036F that ICU calls zero-width
 *     and these tables call 1; 9013 are emoji ICU widened to 2 (U+231A,
 *     U+2648..U+2653, ...); 299 go the other way (U+3040, U+4DC0..U+4DFF,
 *     U+1B002 — unassigned code points the two guess differently).
 *
 * Width feeds ONLY grid grouping (C calls insp_width from insp_group and
 * nowhere else — break-length counts code UNITS), so nothing diverges
 * until the grid lands in stage B, which is where the register entry
 * belongs. (scr_inspect.c:142-143 attributes the whole difference to NFC;
 * that comment is wrong the same way this one used to be, and fixing the C
 * is not this increment's business.) */
import { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

/** Node's `ctx.maxStringLength` default (inspectDefaultOptions). */
const MAX_STRING_LENGTH = 10000;

/** Node's `kMinLineLength` (inspect.js:258) — the floor below which
 * formatPrimitive never splits a string, whatever the indentation. */
const MIN_LINE_LENGTH = 16;

/** Node's `ctx.breakLength` default. */
const BREAK_LENGTH = 80;

export interface InspectDeps {
  strRef: () => ValType;
  strType: () => number;
  /** Push an interned string literal (the emitter's data-segment path). */
  lit: (c: Code, s: string) => void;
  /** `%w.f64ToStr` — the trailer's count. */
  f64ToStr: () => number;
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
   * verbatim. Every operand is a compare on the parameter, so the
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
}
