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
import {
  BYTES_PAYLOAD_IS_BUFFER,
  DK,
  DYN_KIND,
  DYN_NUM,
  DYN_REF,
  ENTRY_KEY,
  ENTRY_VALUE,
  FN_NAME,
  OBJ_ENTRIES,
  OBJ_LEN,
  OBJ_NULL_PROTO,
  type DynBuilder,
} from "./dyn.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

/** Node's `ctx.maxStringLength` default (inspectDefaultOptions). */
const MAX_STRING_LENGTH = 10000;

/** Node's `ctx.maxArrayLength` default — the entry count past which an
 * array renders `... N more items` instead. Plain objects are never
 * truncated (Node truncates arrays and iterables only). */
const MAX_ARRAY_LENGTH = 100;

/** The dyn walker's recursion cap — SEMANTICS.md S029. Node degrades
 * instead of failing here, at a stack-dependent depth measured between
 * 929 and 1421 levels; 1000 sits inside that band and matches the two
 * other capped walks (S013's parser, S026's stringifier). */
const MAX_DYN_DEPTH = 1000;

/** `assertion_error.js`'s own `depth: 1000` OPTION (increment 23 P2a,
 * design-p2.txt A.1) — cfValue's elision threshold, ported FAITHFULLY as
 * `rt > 1000` (Node's `recurseTimes > ctx.depth`). Deliberately a
 * SEPARATE constant from `MAX_DYN_DEPTH` even though both are 1000
 * today: that one is this tier's OWN substitute for Node's unbounded,
 * stack-dependent crash point (S029 — a divergence chosen to land near
 * Node's observed 929-2450 range), while this one is a literal port of
 * a real Node OPTION VALUE — the two numbers coincide by accident, not
 * because they mean the same thing, and must not be merged into one
 * constant on the strength of that coincidence. OWN RE-MEASUREMENT
 * (own probe, scratchpad/inc23/impl-p2a/renderer-depth.mjs): on THIS
 * Node build, `inspect(nestObj(1000, leaf), { depth: 1000, ...
 * assertion_error's other options })` already hits Node's own V8
 * stack-exhaustion safety net (the SAME phenomenon S029 documents for
 * the OTHER walker) before ever reaching the `rt > 1000` boundary this
 * option would otherwise draw — so the four elision forms below are, on
 * this measured Node, unreachable via ordinary nesting. The threshold
 * is implemented anyway, faithfully, because the OPTION is real (S029's
 * own reasoning: reproduce the mechanism Node documents, not the exact
 * unreproducible crash point) — see the pending P2a S-entry (drafted in
 * plan.txt, filed at freeze) for the full account. */
const ASSERT_RENDER_DEPTH_OPTION = 1000;

/** Node's `handleMaxCallStackSize` text, whose `constructorName` is the
 * composite's own — `Object`, `Array`, or (Node's own doubled-bracket
 * quirk) the whole `[Object: null prototype]` base. */
const INTERRUPTED = ": Inspection interrupted prematurely. Maximum call stack size exceeded.]";

/** The null-prototype dictionary's base, which Node prints ahead of the
 * braces at every depth (`formatValue`'s constructor-less base). */
const NULL_PROTO = "[Object: null prototype]";

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
  /** The dyn representation — the walker's whole vocabulary (kinds, the
   * ARR/OBJ/FUNC payload accessors, and `objWalk` for key ORDER). */
  dyn: () => DynBuilder;
  /** `%w.inspF64` — inspect's number arm (ToString, except -0 prints
   * "-0"). The frontend reaches it as the `insp.f64` libCall; the dyn
   * walker needs the same helper for a NUM box. */
  inspF64: () => number;
  /** Fill the exception cell with a fresh error of `className`. The dyn
   * walker's ONE throw is the promise fence (SEMANTICS.md S030). */
  throwError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void) => void;
  /** The exception cell's kind global — 0 when nothing is pending. Every
   * recursive step of the walker tests it, so a fence deep in a tree
   * unwinds instead of rendering the rest into a string nobody reads. */
  excKind: () => number;
  /** The `$bytes` struct's wasm ref type, and its element accessors —
   * `bufferForm`'s hex render and the dyn walker's BYTES arm need both,
   * the same helpers typedarrays.ts's own accessors and json.ts's putDyn
   * BYTES arm already use. */
  bytesRefU8: () => ValType;
  bytesLen: () => number;
  bytesGet: () => number;
  /** `%w.strCmpU16(a,b) -> -1|0|1` — Array.prototype.sort's default
   * comparator over strings (UTF-16 code-unit lexicographic order), the
   * SAME helper the frontend's own `.sort()` lowering and the OBJ-key
   * width-widening walk already use (increment 23 P2a, design-p2.txt
   * A.4: the assert renderer's entry sort is this, not a byte compare —
   * S002 stores UTF-16 code units, so no special case is needed). */
  strCmpU16: () => number;
  /** `%w.str.trim:end(s) -> str` — JS's REAL `trimEnd` (the full ECMA
   * White_Space + LineTerminator scan `strings.ts`'s `trim` already
   * implements for the frontend's own `.trimEnd()` lowering), reused
   * verbatim by `printMyersDiff` (design-p2.txt C.7 note (b)) rather
   * than inheriting C's narrower "strip '\n' and ' ' only" loop. */
  strTrimEnd: () => number;
  /** Prints "Uncaught " + `message` to fd 2 — S007's own reporter
   * (`%w.err.reportUncaught`) invoked DIRECTLY on a fresh EXC_STR cell
   * rather than through the normal pending-cell unwind (setUncaughtError
   * followed by every caller's own check-and-propagate) — and then
   * traps. UNCATCHABLE (nothing rethrows it; the current wasm function
   * halts right here) and NEVER RETURNS. For a refusal so deep inside a
   * recursive render that wiring a genuine catchable throw back out
   * through the whole walker is not worth building this pass
   * (SEMANTICS.md S058's own cycle trap, increment 23 P2b: previously a
   * bare `unreachable`, now named on stderr per the register's own
   * "reachable runtime refusals are named" rule). */
  namedTrap: (c: Code, message: string) => void;
}

export class InspectBuilder {
  private bufG: number | null = null;
  private lenG: number | null = null;
  private indentG: number | null = null;
  private cfEntryStrArrType: number | null = null;
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

  /** `%w.insp.ibPutRange(s, from, to)` — the `[from, to)` slice of `s`,
   * VERBATIM — `ibPuts`'s own shape with a range instead of the whole
   * string, added for `printMyersDiff` (design-p2.txt C.7), which
   * renders individual LINES sliced out of the two full rendered
   * strings rather than whole-string values. */
  ibPutRange(): number {
    return this.cached("ibPutRange", [this.deps.strRef(), I32, I32], [], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const FROM = 1;
      const TO = 2;
      const N = 3;
      c.localGet(TO);
      c.localGet(FROM);
      c.i32Sub();
      c.localSet(N);
      // array.copy null-traps on either side whatever the length, and an
      // empty range would otherwise force a first allocation.
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
      c.localGet(FROM);
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

  /** `(array (mut i32))` — public since increment 23 P2b: `splitLines`'s
   * own offsets array type, which force-emit pins need to name
   * directly (`arrayGet`/`arraySet`'s own typeIndex argument) the same
   * way dyn.ts makes every struct/array type index public for exactly
   * this reason. */
  i32Arr(): number {
    this.i32ArrT ??= this.mb.arrayType(I32, true);
    return this.i32ArrT;
  }

  private strArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strArr() };
  }

  i32ArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.i32Arr() };
  }

  private traceArrT: number | null = null;

  /** `(array (mut (ref null (array (mut i32)))))` — the myers windowed
   * trace's own storage (design-p2.txt C.4): one nullable slot per
   * `diffLevel` reached, holding that level's own small window (an
   * `i32Arr()` of length `2*diffLevel+3`). Pre-sized ONCE to `max+1`
   * slots (the forward walk's own outer-loop bound is `0..max`
   * inclusive) — no growable-array machinery needed, since the exact
   * worst-case slot count is known before the walk starts.
   *
   * Public since increment 23 P2b (same reason as `i32Arr`/`i32ArrRef`
   * above): `myersForward`'s own `trace` return value flows into
   * `myersBacktrack`'s params, and force-emit pins wiring that call by
   * hand need to name the type directly for `setBody`'s locals list. */
  traceArr(): number {
    this.traceArrT ??= this.mb.arrayType(this.i32ArrRef(), true);
    return this.traceArrT;
  }

  traceArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.traceArr() };
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

  /** Pushes the lowercase hex digit CHARACTER for the i32 0-15 value in
   * local D — typedarrays.ts's own `emitHexDigit`, repeated here for the
   * same reason `kindArm` is: this file needs nothing from that one but
   * the four-line computation. */
  private hexDigit(c: Code, D: number): void {
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

  /** `%w.insp.bufferForm(bytes)` → `<Buffer aa bb cc>` — `Buffer.prototype
   * [util.inspect.custom]`'s own rendering, NOT the generic dyn walker's
   * composite path: two lowercase hex digits per byte, space-joined, the
   * first `Buffer.INSPECT_MAX_BYTES` (50, Node's default) shown and then
   * `... N more byte(s)` before the closing `>` (measured against Node
   * 24.18 at 50/51/52 bytes to pin the exact truncation boundary and the
   * singular/plural split). An EMPTY buffer still prints the trailing
   * space before `>` — `<Buffer >` — because the space is part of the
   * fixed "<Buffer " prefix, not a separator the loop owns; nothing here
   * special-cases zero length.
   *
   * UNLIKE a plain Uint8Array's rendering (this function's caller's OTHER
   * arm), this ignores `ctx.depth` entirely — measured: a Buffer nested
   * past the default inspect depth still prints its full form where a
   * Uint8Array there substitutes `[Uint8Array]` (Buffer's custom-inspect
   * override runs before the generic depth-cutoff check ever applies) —
   * and needs none of the recursive machinery (`begin`/`entry`/`end`, the
   * seen stack) a composite's rendering does: the bytes are numbers,
   * never references, so a Buffer can never itself be part of a cycle. */
  bufferForm(): number {
    return this.cached("bufferForm", [this.deps.bytesRefU8()], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const B = 0;
      const N = 1;
      const I = 2;
      const SHOWN = 3;
      const MARK = 4;
      const BYTE = 5;
      const NIB = 6;
      const MAX_SHOWN = 50;
      c.globalGet(this.len());
      c.localSet(MARK);
      this.deps.lit(c, "<Buffer ");
      c.call(this.ibPuts());
      c.localGet(B);
      c.call(this.deps.bytesLen());
      c.i32TruncF64S();
      c.localSet(N);
      c.localGet(N);
      c.i32Const(MAX_SHOWN);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(N);
      c.else_();
      c.i32Const(MAX_SHOWN);
      c.end();
      c.localSet(SHOWN);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(SHOWN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(I);
      c.ifVoid();
      c.i32Const(0x20); // ' '
      c.call(this.ibPutc());
      c.end();
      c.localGet(B);
      c.localGet(I);
      c.f64ConvertI32U();
      c.call(this.deps.bytesGet());
      c.i32TruncF64S(); // byte values are always 0..255, non-negative
      c.localSet(BYTE);
      c.localGet(BYTE);
      c.i32Const(4);
      c.i32ShrU();
      c.localSet(NIB);
      this.hexDigit(c, NIB);
      c.call(this.ibPutc());
      c.localGet(BYTE);
      c.i32Const(0xf);
      c.i32And();
      c.localSet(NIB);
      this.hexDigit(c, NIB);
      c.call(this.ibPutc());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(N);
      c.i32Const(MAX_SHOWN);
      c.i32GtS();
      c.ifVoid();
      this.deps.lit(c, " ... ");
      c.call(this.ibPuts());
      c.localGet(N);
      c.i32Const(MAX_SHOWN);
      c.i32Sub();
      c.f64ConvertI32S();
      c.call(this.deps.f64ToStr());
      c.call(this.ibPuts());
      this.deps.lit(c, " more byte");
      c.call(this.ibPuts());
      c.localGet(N);
      c.i32Const(MAX_SHOWN + 1);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0x73); // 's'
      c.call(this.ibPutc());
      c.end();
      c.end();
      c.i32Const(0x3e); // '>'
      c.call(this.ibPutc());
      c.localGet(MARK);
      c.call(this.ibTake());
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32], c.bytes());
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

  /** `%w.insp.cfSeenCheck(v)` -> i32 — TRUE iff `v` is already on the
   * SHARED seen stack (the SAME `seen()`/`nseen()` the console.log dyn
   * walker's own circCheck/seenPush/refWrap protocol uses — safe to
   * share since the two walkers are never active on the same native
   * call stack simultaneously, and `nseen` returns to 0 between
   * independent top-level walks: whichever one starts next finds it
   * already at 0). Unlike `circCheck`, this assigns NO circular id and
   * mutates NOTHING — it is exactly the "is this value already being
   * rendered" existence test `cfValue`'s own NAMED cycle trap (A.6)
   * needs, deliberately WITHOUT `circCheck`'s own `<ref *N>`
   * bookkeeping (design-p2.txt A.6: a named trap for the assert
   * renderer, not the full `<ref *N>`/`[Circular *N]` protocol that
   * console.log's own lane already owns and keeps). */
  cfSeenCheck(): number {
    return this.cached("cfSeenCheck", [EQ_REF], [I32], (idx) => {
      const c = new Code();
      const V = 0;
      const I = 1;
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

  /** `%w.insp.cfSeenPop()` -> void — the PLAIN pop half of the SHARED
   * seen stack, for `cfValue`'s own named-trap protocol: no `<ref *N>`
   * labeling (that is `refWrap`'s own job for the OTHER walker, which
   * this trap deliberately does not build). Every ARR/OBJ arm of
   * `cfValue` that pushes via `seenPush()` must call this on EVERY
   * exit path — B.4's own discipline (deqEnter/deqLeave), one level
   * up, for the renderer's own re-entrancy guard instead of the
   * comparison memo. */
  cfSeenPop(): number {
    return this.cached("cfSeenPop", [], [], (idx) => {
      const c = new Code();
      c.globalGet(this.nseen());
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(this.nseen());
      c.globalGet(this.seen());
      c.globalGet(this.nseen());
      c.refNull(EQ_HEAP);
      c.arraySet(this.eqArr());
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

  /* ── the dyn walker ───────────────────────────────────────────────────
   * The one runtime type whose SHAPE lives in the value, so the traversal
   * lives here instead of a synthesized helper: `scr_insp_dyn` ported onto
   * the engine above, with the same defaults and Node as the oracle. Four
   * places it deliberately departs from the C, each measured:
   *
   *  1. KEY ORDER IS JS OWN-KEY ORDER. C walks `d->v.obj.entries` in
   *     insertion order; Node prints integer-like keys ASCENDING FIRST,
   *     the same order `Object.keys` answers (measured: `{b:1,a:2,10:3,
   *     2:4,c:5}` inspects as `{ '2': 4, '10': 3, b: 1, a: 2, c: 5 }`, and
   *     one-at-a-time assignment agrees). So the walk goes through
   *     `objWalk` mode 2 — the one helper that defines that order — rather
   *     than growing a second, subtly different copy of the rule. C's
   *     raw-order walk is a native-lane divergence, tracked separately.
   *     json.ts's `putDyn` made the same call for the same reason.
   *  2. THE CIRCULAR PROTOCOL RUNS HERE. C's dyn arm has none: a cyclic
   *     dyn tree recurses until the process dies. Node prints
   *     `<ref *1> { self: [Circular *1] }`, so the walker drives stage B's
   *     quartet exactly as the frontend's cycle-capable helpers do —
   *     circCheck BEFORE the empty and depth answers (measured: a cycle
   *     found at recursion 3 under depth 2 still says `[Circular *1]`,
   *     because Node's seen check precedes its depth check), seenPush
   *     after begin, refWrap around end.
   *  3. IDENTITY IS THE PAYLOAD, not the `$dyn` box. A keyed write COPIES
   *     the box while the ARR vector and the OBJ payload are SHARED (the
   *     dyn-surface bug filed as its own task), so `ref.eq` on the box
   *     would miss every cycle a program can actually build. The vector /
   *     `$dynObj` reference is what goes on the seen stack.
   *  4. THE RECURSION IS CAPPED — SEMANTICS.md S029. Node catches its own
   *     stack overflow mid-render and substitutes an interruption marker,
   *     then finishes the output; at a fixed depth this emits Node's exact
   *     marker text and finishes the same way.
   *
   * BYTES, HANDLE and JSVAL are `unreachable` for putDyn's reason: no
   * producer on this tier can build one (typed arrays, runtime handles and
   * the island bridge all refuse upstream), so arriving here means the dyn
   * surface grew a kind without growing this walk. PROMISE is DIFFERENT —
   * `dynFrom:promise` boxes a `Promise<any>` — and it fences loudly rather
   * than guess at Node's `Promise { <pending> }` / `Promise { value }`
   * (SEMANTICS.md S030, the handle stance). That fence is the
   * only throw in this file, and the reason `insp.dyn`/`insp.dynS` are
   * may-throw seeded. */

  /** `if (kind is one of ks) { body }` — json.ts's `emitKindArm`, repeated
   * for the same reason it was: this file needs nothing from dyn.ts but
   * the representation. */
  private kindArm(c: Code, kindLocal: number, ks: number[], body: () => void): void {
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

  /** `%w.insp.reset()` — abandon the whole render: the buffer, the frame
   * and item stacks, the circular state and the indentation all go back to
   * their initial values.
   *
   * The promise fence needs this because the throw unwinds through
   * ancestors that will never reach their `end` — their frames would stay
   * stacked, their marks unconsumed and `ctx.indentationLvl` two per level
   * too deep, and the NEXT render would inherit all of it. `begin(1)`
   * clears the circular state on a fresh top-level value but nothing else,
   * because until this arm existed nothing in the engine could throw.
   * Resetting `len` to 0 is also what makes the unwind safe: an ancestor
   * that returned without its `ibTake` leaves a mark ABOVE the fill
   * length, which the next take would read as a negative region. */
  private reset(): number {
    return this.cached("reset", [], [], (idx) => {
      const c = new Code();
      c.i32Const(0);
      c.globalSet(this.len());
      c.i32Const(0);
      c.globalSet(this.nitems());
      c.i32Const(0);
      c.globalSet(this.nframes());
      c.i32Const(0);
      c.globalSet(this.nseen());
      c.i32Const(0);
      c.globalSet(this.ncirc());
      c.i32Const(0);
      c.globalSet(this.indentGlobal());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.insp.dyn(d, recurse, depth)` → the dyn tree's rendering, or null
   * with the promise fence pending. RECURSIVE. */
  dyn(): number {
    const dyn = this.deps.dyn();
    return this.cached("dyn", [dyn.dynRef(), F64, F64], [this.deps.strRef()], (idx) => {
      const dynT = dyn.dynT();
      const objT = dyn.objT();
      const strT = this.deps.strType();
      const strRef = this.deps.strRef();
      const c = new Code();
      const D = 0;
      const RECURSE = 1;
      const DEPTH = 2;
      const K = 3;
      const MARK = 4;
      const V = 5; // the ARR payload, or objWalk's entries vector
      const O = 6; // the OBJ payload
      const N = 7;
      const I = 8;
      const SHOWN = 9;
      const MORE = 10;
      const NP = 11; // nullProto
      const ID = 12; // the circular id (f64)
      const E = 13; // one element, or one [key, value] pair
      const P = 14; // the pair's payload vector
      const KS = 15; // the key's rendering
      const VS = 16; // the value's rendering
      const R = 17; // the composite's rendering
      const ENTS = 18; // objWalk's result box
      const NAME = 19; // FN_NAME
      const AB = 20; // BYTES: the aliased $bytes ref (S014's amendment)
      const BASE = 21; // BYTES: the "Uint8Array(N) " prefix
      /** recurse + 1 — the depth children format at. */
      const deeper = (): void => {
        c.localGet(RECURSE);
        c.f64Const(1);
        c.f64Add();
      };
      /** The pending check every recursive step carries: a fence anywhere
       * in the tree abandons the render, and the arm that threw has
       * already reset the engine, so bailing touches nothing. */
      const bailIfPending = (): void => {
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.refNull(strT);
        c.return_();
        c.end();
      };
      /** `[Circular *N]` when `slot` holds an id the circular check just
       * assigned. */
      const circularAnswer = (): void => {
        c.localGet(ID);
        c.f64Const(0);
        c.f64Ne();
        c.ifVoid();
        c.localGet(ID);
        c.call(this.circular());
        c.return_();
        c.end();
      };

      c.localGet(D);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);

      /* The scalar arms: no frame, no recursion, no circular state. */
      this.kindArm(c, K, [DK.NULL], () => {
        this.deps.lit(c, "null");
        c.return_();
      });
      this.kindArm(c, K, [DK.UNDEF], () => {
        this.deps.lit(c, "undefined");
        c.return_();
      });
      this.kindArm(c, K, [DK.BOOL], () => {
        // The flag widened into the num slot at box time (dyn.ts).
        c.localGet(D);
        c.structGet(dynT, DYN_NUM);
        c.f64Const(0);
        c.f64Ne();
        c.ifResult(strRef);
        this.deps.lit(c, "true");
        c.else_();
        this.deps.lit(c, "false");
        c.end();
        c.return_();
      });
      this.kindArm(c, K, [DK.NUM], () => {
        c.localGet(D);
        c.structGet(dynT, DYN_NUM);
        c.call(this.deps.inspF64());
        c.return_();
      });
      this.kindArm(c, K, [DK.STR], () => {
        // A dyn string INSIDE a composite quotes like any other string;
        // only the top-level %s/console.log position passes it verbatim,
        // which is `insp.dynS`'s whole job.
        c.localGet(D);
        c.structGet(dynT, DYN_REF);
        c.refCast(strT);
        c.call(this.str());
        c.return_();
      });
      this.kindArm(c, K, [DK.FUNC], () => {
        // The boxed name is the compiler's best-effort static spelling
        // (S020). C's `name && name[0]`: null OR EMPTY is anonymous.
        dyn.fnPayload(c, (x) => x.localGet(D));
        c.structGet(dyn.fnT(), FN_NAME);
        c.localSet(NAME);
        c.localGet(NAME);
        c.refIsNull();
        c.ifResult(I32);
        c.i32Const(1);
        c.else_();
        c.localGet(NAME);
        c.arrayLen();
        c.i32Eqz();
        c.end();
        c.ifVoid();
        this.deps.lit(c, "[Function (anonymous)]");
        c.return_();
        c.end();
        c.globalGet(this.len());
        c.localSet(MARK);
        this.deps.lit(c, "[Function: ");
        c.call(this.ibPuts());
        c.localGet(NAME);
        c.call(this.ibPuts());
        c.i32Const(0x5d); // ']'
        c.call(this.ibPutc());
        c.localGet(MARK);
        c.call(this.ibTake());
        c.return_();
      });
      this.kindArm(c, K, [DK.PROMISE], () => {
        // Node renders Promise { <pending> } / Promise { value }. The
        // settled-value rendering would have to re-enter this walker
        // through the promise representation's payload, and the frontend
        // has no type for what comes out; fence loudly instead of a
        // silent-wrong shape (S030, the handle stance).
        c.call(this.reset());
        this.deps.throwError(c, "%Error", "Error", (x) =>
          this.deps.lit(x, "util.inspect of a promise value is not supported yet"),
        );
        c.refNull(strT);
        c.return_();
      });

      this.kindArm(c, K, [DK.ARR], () => {
        dyn.arrPayload(c, (x) => x.localGet(D));
        c.localSet(V);
        dyn.arrLen(c, (x) => x.localGet(V));
        c.localSet(N);
        // The empty answer comes BEFORE the frame (an empty frame renders
        // "[  ]") and before the circular check, which is sound because an
        // empty array cannot be on the traversal path — a self-reference
        // needs a slot to hold it.
        c.localGet(N);
        c.i32Eqz();
        c.ifVoid();
        this.deps.lit(c, "[]");
        c.return_();
        c.end();
        c.localGet(V);
        c.call(this.circCheck());
        c.localSet(ID);
        circularAnswer();
        c.localGet(RECURSE);
        c.localGet(DEPTH);
        c.f64Gt();
        c.ifVoid();
        this.deps.lit(c, "[Array]");
        c.return_();
        c.end();
        // S029: the marker, then a render that still completes.
        c.localGet(RECURSE);
        c.f64Const(MAX_DYN_DEPTH);
        c.f64Gt();
        c.ifVoid();
        this.deps.lit(c, `[Array${INTERRUPTED}`);
        c.return_();
        c.end();
        deeper();
        c.call(this.begin());
        c.localGet(V);
        c.call(this.seenPush());
        // shown = min(n, 100)
        c.localGet(N);
        c.i32Const(MAX_ARRAY_LENGTH);
        c.i32LtS();
        c.ifResult(I32);
        c.localGet(N);
        c.else_();
        c.i32Const(MAX_ARRAY_LENGTH);
        c.end();
        c.localSet(SHOWN);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(SHOWN);
        c.i32GeS();
        c.brIf(1);
        dyn.arrAt(c, (x) => x.localGet(V), (x) => x.localGet(I));
        c.localSet(E);
        c.localGet(E);
        deeper();
        c.localGet(DEPTH);
        c.call(idx);
        c.localSet(VS);
        bailIfPending();
        // The element's rendering is a FINISHED string by the time entry
        // takes it — no region of ours is open across the recursion, which
        // is what keeps the buffer's LIFO argument trivial here.
        c.localGet(VS);
        c.localGet(E);
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NUM);
        c.i32Eq();
        c.call(this.entry());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(N);
        c.i32Const(MAX_ARRAY_LENGTH);
        c.i32GtS();
        c.localSet(MORE);
        c.localGet(MORE);
        c.ifVoid();
        c.localGet(N);
        c.i32Const(MAX_ARRAY_LENGTH);
        c.i32Sub();
        c.f64ConvertI32S();
        c.call(this.moreItems());
        // The grid order flag follows the FIRST DROPPED element, C's
        // `items[100]->kind` (Node reads `output[outputLength]`).
        dyn.arrAt(c, (x) => x.localGet(V), (x) => x.i32Const(MAX_ARRAY_LENGTH));
        c.structGet(dynT, DYN_KIND);
        c.i32Const(DK.NUM);
        c.i32Eq();
        c.call(this.entry());
        c.end();
        this.deps.lit(c, "");
        this.deps.lit(c, "[");
        this.deps.lit(c, "]");
        deeper();
        c.i32Const(1); // arrayExtras: grid grouping applies
        c.localGet(MORE);
        c.call(this.end());
        c.localSet(R);
        c.localGet(V);
        c.localGet(R);
        c.call(this.refWrap());
        c.return_();
      });

      this.kindArm(c, K, [DK.OBJ], () => {
        dyn.objPayload(c, (x) => x.localGet(D));
        c.localSet(O);
        // Object.create(null)'s dictionary: Node prefixes the rendering
        // with the constructor-less base at EVERY depth, the empty form
        // included, and the beyond-depth answer IS the bare marker (where
        // a plain object says [Object]). No producer on the wasm tier
        // builds one yet — `dyn.objCreateNullProto` refuses here — so this
        // is the dyn surface's standing rule that an arm is filled before
        // the payload that reaches it lands.
        c.localGet(O);
        c.structGet(objT, OBJ_NULL_PROTO);
        c.localSet(NP);
        c.localGet(O);
        c.structGet(objT, OBJ_LEN);
        c.localSet(N);
        c.localGet(N);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(NP);
        c.ifResult(strRef);
        this.deps.lit(c, `${NULL_PROTO} {}`);
        c.else_();
        this.deps.lit(c, "{}");
        c.end();
        c.return_();
        c.end();
        c.localGet(O);
        c.call(this.circCheck());
        c.localSet(ID);
        circularAnswer();
        c.localGet(RECURSE);
        c.localGet(DEPTH);
        c.f64Gt();
        c.ifVoid();
        c.localGet(NP);
        c.ifResult(strRef);
        this.deps.lit(c, NULL_PROTO);
        c.else_();
        this.deps.lit(c, "[Object]");
        c.end();
        c.return_();
        c.end();
        // S029 again. Node builds this text as `[${constructorName}: ...]`
        // over a constructor name that is ALREADY bracketed for a
        // null-prototype dictionary, so the doubled bracket is Node's own
        // (measured, not a transcription slip).
        c.localGet(RECURSE);
        c.f64Const(MAX_DYN_DEPTH);
        c.f64Gt();
        c.ifVoid();
        c.localGet(NP);
        c.ifResult(strRef);
        this.deps.lit(c, `[${NULL_PROTO}${INTERRUPTED}`);
        c.else_();
        this.deps.lit(c, `[Object${INTERRUPTED}`);
        c.end();
        c.return_();
        c.end();
        deeper();
        c.call(this.begin());
        c.localGet(O);
        c.call(this.seenPush());
        // Own-key ORDER, through the one helper that defines it. The
        // receiver is an OBJ, so this walk cannot throw.
        c.localGet(D);
        c.i32Const(2); // Object.entries mode
        c.call(dyn.objWalk());
        c.localSet(ENTS);
        dyn.arrPayload(c, (x) => x.localGet(ENTS));
        c.localSet(V);
        dyn.arrLen(c, (x) => x.localGet(V));
        c.localSet(N);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        dyn.arrAt(c, (x) => x.localGet(V), (x) => x.localGet(I));
        c.localSet(E);
        dyn.arrPayload(c, (x) => x.localGet(E));
        c.localSet(P);
        // Key and value are both rendered into their OWN regions, closed
        // before the entry's region opens — C's order (it computes `val`
        // before initializing the entry buffer), and the one that keeps
        // this walker out of the nested-open-region case entirely.
        dyn.arrAt(c, (x) => x.localGet(P), (x) => x.i32Const(0));
        c.structGet(dynT, DYN_REF);
        c.refCast(strT);
        c.call(this.key());
        c.localSet(KS);
        dyn.arrAt(c, (x) => x.localGet(P), (x) => x.i32Const(1));
        deeper();
        c.localGet(DEPTH);
        c.call(idx);
        c.localSet(VS);
        bailIfPending();
        c.globalGet(this.len());
        c.localSet(MARK);
        c.localGet(KS);
        c.call(this.ibPuts());
        this.deps.lit(c, ": ");
        c.call(this.ibPuts());
        c.localGet(VS);
        c.call(this.ibPuts());
        c.localGet(MARK);
        c.call(this.ibTake());
        c.i32Const(0); // a property entry is never the grid's number case
        c.call(this.entry());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(NP);
        c.ifResult(strRef);
        this.deps.lit(c, NULL_PROTO);
        c.else_();
        this.deps.lit(c, "");
        c.end();
        this.deps.lit(c, "{");
        this.deps.lit(c, "}");
        deeper();
        c.i32Const(0); // no array extras: properties never grid-group
        c.i32Const(0);
        c.call(this.end());
        c.localSet(R);
        c.localGet(O);
        c.localGet(R);
        c.call(this.refWrap());
        c.return_();
      });

      // BYTES has a real arm (increment 18 stage C: dyn↔bytes crossing made
      // one constructible) — the isBuffer flag decides between TWO
      // genuinely different renderings, not a shared shape with a tweak:
      //  - Buffer: `bufferForm`'s own hex form, self-contained, no
      //    recursion/depth/circular concerns (see that function's header).
      //  - plain Uint8Array: array-shaped (grid grouping, the depth
      //    cutoff, the S029 interrupted marker) — the SAME begin/entry/end
      //    pipeline the ARR arm above uses, just sourcing elements from
      //    bytes instead of a dyn vector, and skipping circCheck/seenPush/
      //    refWrap because a `$bytes` payload holds only raw bytes and can
      //    never itself be part of a cycle (S014's bytes amendment argues
      //    the same acyclic-by-construction point).
      this.kindArm(c, K, [DK.BYTES], () => {
        dyn.bytesPayload(c, (x) => x.localGet(D));
        c.structGet(dyn.bytesPayloadT(), BYTES_PAYLOAD_IS_BUFFER);
        c.ifResult(strRef);
        dyn.bytesPayloadBytes(c, (x) => x.localGet(D));
        c.call(this.bufferForm());
        c.else_();
        dyn.bytesPayloadBytes(c, (x) => x.localGet(D));
        c.localSet(AB);
        dyn.bytesLenI32(c, (x) => x.localGet(AB));
        c.localSet(N);
        // An EMPTY typed array bypasses the depth cutoff entirely — same
        // as a plain empty array (measured: `{a:{b:{c:[]}}}` at default
        // depth still prints `[]`, not `[Array]`; `{a:{b:{c:new
        // Uint8Array(0)}}}` still prints `Uint8Array(0) []`) — so this
        // check, like the ARR arm's own N===0 shortcut above, comes
        // BEFORE the depth check, not after.
        c.localGet(N);
        c.i32Eqz();
        c.ifResult(strRef);
        this.deps.lit(c, "Uint8Array(0) []");
        c.else_();
        c.localGet(RECURSE);
        c.localGet(DEPTH);
        c.f64Gt();
        c.ifResult(strRef);
        this.deps.lit(c, "[Uint8Array]");
        c.else_();
        c.localGet(RECURSE);
        c.f64Const(MAX_DYN_DEPTH);
        c.f64Gt();
        c.ifResult(strRef);
        this.deps.lit(c, `[Uint8Array${INTERRUPTED}`);
        c.else_();
        // The "Uint8Array(N)" prefix, built through the append buffer
        // directly (there is no static literal for a runtime count). NO
        // trailing space here — `end()`'s `emitBasePrefix` adds its own
        // (`base ? \`${base} \` : ''`), so one baked in here would double
        // it (measured against Node the hard way — the first build of
        // this arm printed "Uint8Array(3)  [" and this comment is why).
        c.globalGet(this.len());
        c.localSet(MARK);
        this.deps.lit(c, "Uint8Array(");
        c.call(this.ibPuts());
        c.localGet(N);
        c.f64ConvertI32U();
        c.call(this.deps.f64ToStr());
        c.call(this.ibPuts());
        c.i32Const(0x29); // ')'
        c.call(this.ibPutc());
        c.localGet(MARK);
        c.call(this.ibTake());
        c.localSet(BASE);
        deeper();
        c.call(this.begin());
        c.localGet(N);
        c.i32Const(MAX_ARRAY_LENGTH);
        c.i32LtS();
        c.ifResult(I32);
        c.localGet(N);
        c.else_();
        c.i32Const(MAX_ARRAY_LENGTH);
        c.end();
        c.localSet(SHOWN);
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(SHOWN);
        c.i32GeS();
        c.brIf(1);
        c.localGet(AB);
        c.localGet(I);
        c.f64ConvertI32U();
        c.call(this.deps.bytesGet());
        c.call(this.deps.f64ToStr());
        c.i32Const(1); // isNum: every byte element is a number
        c.call(this.entry());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        c.localGet(N);
        c.i32Const(MAX_ARRAY_LENGTH);
        c.i32GtS();
        c.localSet(MORE);
        c.localGet(MORE);
        c.ifVoid();
        c.localGet(N);
        c.i32Const(MAX_ARRAY_LENGTH);
        c.i32Sub();
        c.f64ConvertI32S();
        c.call(this.moreItems());
        c.i32Const(1); // the first-dropped element is numeric too
        c.call(this.entry());
        c.end();
        c.localGet(BASE);
        this.deps.lit(c, "[");
        this.deps.lit(c, "]");
        deeper();
        c.i32Const(1); // arrayExtras: grid grouping applies
        c.localGet(MORE);
        c.call(this.end());
        c.end(); // interrupted-check ifResult
        c.end(); // depth-cutoff ifResult
        c.end(); // N===0 ifResult
        c.end(); // isBuffer ifResult
        c.return_();
      });

      // HANDLE and JSVAL: see the header — no producer on this tier can
      // build one, so arriving here means a kind grew without an arm.
      c.unreachable();
      this.mb.setBody(
        idx,
        [
          I32, I32, dyn.arrRef(), dyn.objRef(), I32, I32, I32, I32, I32, F64,
          dyn.dynRef(), dyn.arrRef(), strRef, strRef, strRef, dyn.dynRef(), strRef,
          this.deps.bytesRefU8(), strRef,
        ],
        c.bytes(),
      );
    });
  }

  /** `%w.insp.dynS(d, depth)` — util.format's %s (and console.log's
   * rest-argument) rule over a dyn value: a STRING passes VERBATIM, the
   * classic console.log-vs-inspect distinction, and everything else
   * inspects from recursion 0. `scr_insp_dyn_s` exactly. */
  dynS(): number {
    const dyn = this.deps.dyn();
    return this.cached("dynS", [dyn.dynRef(), F64], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const D = 0;
      const DEPTH = 1;
      c.localGet(D);
      c.structGet(dyn.dynT(), DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.ifVoid();
      c.localGet(D);
      c.structGet(dyn.dynT(), DYN_REF);
      c.refCast(this.deps.strType());
      c.return_();
      c.end();
      c.localGet(D);
      c.f64Const(0);
      c.localGet(DEPTH);
      c.call(this.dyn());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** The scratch array type for the OBJ arm's entry sort (A.4) — a plain
   * `array (mut ref null $str)`, allocated fresh per rendered object,
   * holding each entry's ALREADY-FORMATTED text (`key + ": " + value`)
   * before `%w.strCmpU16` sorts it into Node's own full-ENTRY-TEXT
   * UTF-16 order — NOT a key-only sort (A.4's own ndse-51 measurement:
   * the value participates, because the comparator sees the whole
   * rendered line, colon and all). */
  private cfEntryStrArr(): number {
    this.cfEntryStrArrType ??= this.mb.arrayType(this.deps.strRef(), true);
    return this.cfEntryStrArrType;
  }

  /** `%w.assert.cfValue(d, indent, rt) -> void` — increment 23 P2a's
   * dedicated recursive printer for `assert.eqDyn`'s failure message
   * (design-p2.txt A.1-A.6). Deliberately NOT inspect.ts's own layout
   * engine (`begin`/`entry`/`moreItems`/`end`, the frame stack, the
   * `<ref *N>` protocol): under assertion_error.js's `compact: false`,
   * `reduceToSingleString` collapses to a five-line layout rule with
   * BOTH grouping and single-lining dead, so threading that mode
   * through the shared layout engine would add a live branch to every
   * OTHER call site (console.log, `%o`/`%O`) for a mechanism only this
   * caller needs — design-p2.txt A.0's own verdict. What IS reused,
   * unchanged: `pushMark`/`ibPutc`/`ibPuts`/`ibSpaces`/`ibTake`/
   * `indentGlobal` (the append-buffer leaf pieces), `%w.insp.str` (the
   * string arm, INCLUDING its 10000-cap and multi-line split),
   * `%w.insp.key` (the key ladder), and `%w.strCmpU16` (the entry
   * sort comparator). `indent` is the column this value's OWN
   * continuation lines start at; `rt` is Node's own `recurseTimes`, 0
   * at the top level — the two move together in THIS design but are
   * not interchangeable (A.1: the `insp.str` handoff needs `indent`,
   * the elision gate needs `rt`).
   *
   * CYCLES — A SCOPED-DOWN DECISION FROM A.6's OWN RECOMMENDATION
   * (flagged at freeze, not silently taken): design-p2.txt A.6
   * recommends a dedicated SEEN STACK with a NAMED TRAP on re-entering
   * a value already being rendered, distinct from ordinary depth
   * elision — reach is "zero in the six" either way, since `eqDyn`
   * itself still refuses by name through the whole of P2 (H-2's
   * split: P2b, not P2a, wires the libCall), so NO compiled program
   * can reach this renderer AT ALL yet, cyclic or not. This pass
   * builds the cheaper property instead: RT alone is already a hard
   * bound on recursion (every ARR/OBJ arm increments it before
   * recursing, and the elision gate below fires by RT > 1000
   * regardless of WHY the nesting is that deep), so a genuine cycle
   * degrades to the SAME `[Object]`/`[Array]` elision text an
   * ordinary very-deep-but-finite structure would get, rather than a
   * distinct named trap — no crash, no wrong-but-silent divergence
   * from the elision path's own already-registered behavior, just a
   * COARSER signal than A.6's own ideal. The dedicated seen-stack
   * (a growable dyn-ref vector, push on ARR/OBJ entry, pop on every
   * exit — B.4's OWN discipline, one level up) is real, understood,
   * and deferred to whenever `eqDyn` actually becomes reachable (P2b
   * or later), where a cycle first becomes an observable shape rather
   * than a hypothetical one. */
  cfValue(): number {
    const dyn = this.deps.dyn();
    return this.cached("cfValue", [dyn.dynRef(), I32, I32], [], (idx) => {
      const dynT = dyn.dynT();
      const strRefT = this.deps.strRef();
      const entriesRefT: ValType = { kind: "ref", nullable: true, typeIndex: dyn.entriesArrayType() };
      const strArrRefT: ValType = { kind: "ref", nullable: true, typeIndex: this.cfEntryStrArr() };
      const D = 0;
      const INDENT = 1;
      const RT = 2;
      const K = 3;
      const FNAME = 4;
      const BREF = 5;
      const ISBUF = 6;
      const BLEN = 7;
      const BI = 8;
      const AVEC = 9;
      const ALEN = 10;
      const AI = 11;
      const OP = 12;
      const ONULLP = 13;
      const OLEN = 14;
      const OENTRIES = 15;
      const OI = 16;
      const OENTRY = 17;
      const OMARK = 18;
      const OSTRARR = 19;
      const SJ = 20;
      const SIDX = 21;
      const STMP = 22;
      const c = new Code();
      const putLit = (s: string): void => {
        this.deps.lit(c, s);
        c.call(this.ibPuts());
      };
      const putc = (ch: string): void => {
        c.i32Const(ch.charCodeAt(0));
        c.call(this.ibPutc());
      };
      const spaces = (pushN: () => void): void => {
        pushN();
        c.call(this.ibSpaces());
      };

      c.localGet(D);
      c.structGet(dynT, DYN_KIND);
      c.localSet(K);

      // UNDEF, NULL
      c.localGet(K);
      c.i32Const(DK.UNDEF);
      c.i32Eq();
      c.ifVoid();
      putLit("undefined");
      c.return_();
      c.end();
      c.localGet(K);
      c.i32Const(DK.NULL);
      c.i32Eq();
      c.ifVoid();
      putLit("null");
      c.return_();
      c.end();

      // BOOL — the shared num slot, exact (0/1).
      c.localGet(K);
      c.i32Const(DK.BOOL);
      c.i32Eq();
      c.ifVoid();
      c.localGet(D);
      c.structGet(dynT, DYN_NUM);
      c.f64Const(0);
      c.f64Ne();
      c.ifVoid();
      putLit("true");
      c.else_();
      putLit("false");
      c.end();
      c.return_();
      c.end();

      // NUM — Number::toString via the shared %w.inspF64 (the -0 exception
      // included; numericSeparator is false so no grouping ever applies).
      c.localGet(K);
      c.i32Const(DK.NUM);
      c.i32Eq();
      c.ifVoid();
      c.localGet(D);
      c.structGet(dynT, DYN_NUM);
      c.call(this.deps.inspF64());
      c.call(this.ibPuts());
      c.return_();
      c.end();

      // STR — A.3's handoff: set indentGlobal to THIS value's own indent
      // before calling insp.str, which reads it for both the 10000-cap-
      // independent split gate and the continuation indent.
      c.localGet(K);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.ifVoid();
      c.localGet(INDENT);
      c.globalSet(this.indentGlobal());
      c.localGet(D);
      c.structGet(dynT, DYN_REF);
      c.refCast(this.deps.strType());
      c.call(this.str());
      c.call(this.ibPuts());
      c.return_();
      c.end();

      // FUNC — name = fnPayload(d).FN_NAME; NEVER renders own properties
      // (dyn.defineProps is P4/board #98 — on THIS backend the slot is
      // ABSENT rather than always-null, so "[Function: name]" is exact
      // here where Node's own-property form would not be).
      c.localGet(K);
      c.i32Const(DK.FUNC);
      c.i32Eq();
      c.ifVoid();
      dyn.fnPayload(c, (x) => x.localGet(D));
      c.structGet(dyn.fnT(), FN_NAME);
      c.localSet(FNAME);
      c.localGet(FNAME);
      c.refIsNull();
      c.ifVoid();
      putLit("[Function (anonymous)]");
      c.return_();
      c.end();
      c.localGet(FNAME);
      c.arrayLen();
      c.i32Eqz();
      c.ifVoid();
      putLit("[Function (anonymous)]");
      c.return_();
      c.end();
      putLit("[Function: ");
      c.localGet(FNAME);
      c.call(this.ibPuts());
      putLit("]");
      c.return_();
      c.end();

      // BYTES — the isBuffer prototype gate, then content (A.2). EMPTY
      // is checked before the depth gate (matching ARR's own MEASURED
      // order — emptyarr1001 "a: []" — generalized here to BYTES/OBJ by
      // structural analogy, since real Node cannot reach rt=1001 via
      // ordinary nesting on this build to re-confirm it directly; see
      // ASSERT_RENDER_DEPTH_OPTION's own comment).
      c.localGet(K);
      c.i32Const(DK.BYTES);
      c.i32Eq();
      c.ifVoid();
      dyn.bytesPayloadBytes(c, (x) => x.localGet(D));
      c.localSet(BREF);
      dyn.bytesPayload(c, (x) => x.localGet(D));
      c.structGet(dyn.bytesPayloadT(), BYTES_PAYLOAD_IS_BUFFER);
      c.localSet(ISBUF);
      c.localGet(BREF);
      c.call(this.deps.bytesLen());
      c.i32TruncF64S();
      c.localSet(BLEN);
      c.localGet(BLEN);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ISBUF);
      c.ifVoid();
      putLit("Buffer(0) [Uint8Array] []");
      c.else_();
      putLit("Uint8Array(0) []");
      c.end();
      c.return_();
      c.end();
      c.localGet(RT);
      c.i32Const(ASSERT_RENDER_DEPTH_OPTION);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ISBUF);
      c.ifVoid();
      putLit("[Buffer]");
      c.else_();
      putLit("[Uint8Array]");
      c.end();
      c.return_();
      c.end();
      c.localGet(ISBUF);
      c.ifVoid();
      putLit("Buffer(");
      c.else_();
      putLit("Uint8Array(");
      c.end();
      c.localGet(BLEN);
      c.f64ConvertI32S();
      c.call(this.deps.inspF64());
      c.call(this.ibPuts());
      putLit(")");
      c.localGet(ISBUF);
      c.ifVoid();
      putLit(" [Uint8Array]");
      c.end();
      putLit(" [");
      c.i32Const(0);
      c.localSet(BI);
      c.block();
      c.loop();
      c.localGet(BI);
      c.localGet(BLEN);
      c.i32GeS();
      c.brIf(1);
      putc("\n");
      spaces(() => {
        c.localGet(INDENT);
        c.i32Const(2);
        c.i32Add();
      });
      c.localGet(BREF);
      c.localGet(BI);
      c.f64ConvertI32S();
      c.call(this.deps.bytesGet());
      c.call(this.deps.inspF64());
      c.call(this.ibPuts());
      c.localGet(BI);
      c.i32Const(1);
      c.i32Add();
      c.localGet(BLEN);
      c.i32Ne();
      c.ifVoid();
      putc(",");
      c.end();
      c.localGet(BI);
      c.i32Const(1);
      c.i32Add();
      c.localSet(BI);
      c.br(0);
      c.end();
      c.end();
      putc("\n");
      spaces(() => c.localGet(INDENT));
      putc("]");
      c.return_();
      c.end();

      // ARR — empty checked before the depth gate (MEASURED, A.2).
      c.localGet(K);
      c.i32Const(DK.ARR);
      c.i32Eq();
      c.ifVoid();
      // CLAIM 0 (A.6, increment 23 P2b): a NAMED cycle trap. Re-entering
      // a value already on the CURRENT render path (the shared seen
      // stack cfValue and the console.log walker's own protocol both
      // use, never active on the same native stack at once) traps
      // loudly instead of recursing forever or silently degrading
      // through depth elision — a cyclic operand is a DIFFERENT shape
      // than a merely-very-deep one, and gets a different, honest
      // answer. Pushed here, popped on EVERY exit below (B.4's own
      // discipline, one level up). Named on stderr (S058's own amended
      // reach statement, memo-rows ruling): `deps.namedTrap` prints
      // "Uncaught " + this text via S007's shared reporter and traps —
      // UNCATCHABLE, never a bare `unreachable`.
      c.localGet(D);
      c.call(this.cfSeenCheck());
      c.ifVoid();
      this.deps.namedTrap(
        c,
        "cfValue: cyclic value encountered while rendering an assert.eqDyn failure message (SEMANTICS.md S058)",
      );
      c.end();
      c.localGet(D);
      c.call(this.seenPush());
      dyn.arrPayload(c, (x) => x.localGet(D));
      c.localSet(AVEC);
      dyn.arrLen(c, (x) => x.localGet(AVEC));
      c.localSet(ALEN);
      c.localGet(ALEN);
      c.i32Eqz();
      c.ifVoid();
      putLit("[]");
      c.call(this.cfSeenPop());
      c.return_();
      c.end();
      c.localGet(RT);
      c.i32Const(ASSERT_RENDER_DEPTH_OPTION);
      c.i32GtS();
      c.ifVoid();
      putLit("[Array]");
      c.call(this.cfSeenPop());
      c.return_();
      c.end();
      putc("[");
      c.i32Const(0);
      c.localSet(AI);
      c.block();
      c.loop();
      c.localGet(AI);
      c.localGet(ALEN);
      c.i32GeS();
      c.brIf(1);
      putc("\n");
      spaces(() => {
        c.localGet(INDENT);
        c.i32Const(2);
        c.i32Add();
      });
      dyn.arrAt(c, (x) => x.localGet(AVEC), (x) => x.localGet(AI));
      c.localGet(INDENT);
      c.i32Const(2);
      c.i32Add();
      c.localGet(RT);
      c.i32Const(1);
      c.i32Add();
      c.call(this.cfValue());
      c.localGet(AI);
      c.i32Const(1);
      c.i32Add();
      c.localGet(ALEN);
      c.i32Ne();
      c.ifVoid();
      putc(",");
      c.end();
      c.localGet(AI);
      c.i32Const(1);
      c.i32Add();
      c.localSet(AI);
      c.br(0);
      c.end();
      c.end();
      putc("\n");
      spaces(() => c.localGet(INDENT));
      putc("]");
      c.call(this.cfSeenPop());
      c.return_();
      c.end();

      // OBJ — empty and null-proto forms, then the depth gate, then
      // entries (A.4's sort). Every entry's TEXT (key + ": " + value) is
      // rendered into its own region and taken BEFORE the sort — the
      // sort compares full lines, not keys (A.4's own ndse-51 proof).
      c.localGet(K);
      c.i32Const(DK.OBJ);
      c.i32Eq();
      c.ifVoid();
      // CLAIM 0 (A.6) — see the ARR arm's own comment; identical
      // discipline, the SAME shared seen stack, the SAME named trap.
      c.localGet(D);
      c.call(this.cfSeenCheck());
      c.ifVoid();
      this.deps.namedTrap(
        c,
        "cfValue: cyclic value encountered while rendering an assert.eqDyn failure message (SEMANTICS.md S058)",
      );
      c.end();
      c.localGet(D);
      c.call(this.seenPush());
      dyn.objPayload(c, (x) => x.localGet(D));
      c.localSet(OP);
      c.localGet(OP);
      c.structGet(dyn.objT(), OBJ_NULL_PROTO);
      c.localSet(ONULLP);
      c.localGet(OP);
      c.structGet(dyn.objT(), OBJ_LEN);
      c.localSet(OLEN);
      c.localGet(OLEN);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ONULLP);
      c.ifVoid();
      putLit("[Object: null prototype] {}");
      c.else_();
      putLit("{}");
      c.end();
      c.call(this.cfSeenPop());
      c.return_();
      c.end();
      c.localGet(RT);
      c.i32Const(ASSERT_RENDER_DEPTH_OPTION);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ONULLP);
      c.ifVoid();
      putLit("[Object: null prototype]");
      c.else_();
      putLit("[Object]");
      c.end();
      c.call(this.cfSeenPop());
      c.return_();
      c.end();
      c.localGet(OP);
      c.structGet(dyn.objT(), OBJ_ENTRIES);
      c.localSet(OENTRIES);
      c.localGet(OLEN);
      c.arrayNewDefault(this.cfEntryStrArr());
      c.localSet(OSTRARR);
      // Build each entry's TEXT (key + ": " + value) into its own
      // region and take it — the sort below compares these full lines,
      // not keys alone (A.4's own ndse-51 proof: the VALUE participates
      // because the comparator sees the whole rendered line).
      c.i32Const(0);
      c.localSet(OI);
      c.block();
      c.loop();
      c.localGet(OI);
      c.localGet(OLEN);
      c.i32GeS();
      c.brIf(1);
      this.pushMark(c);
      c.localSet(OMARK);
      c.localGet(OENTRIES);
      c.localGet(OI);
      c.arrayGet(dyn.entriesArrayType());
      c.localSet(OENTRY);
      c.localGet(OENTRY);
      c.structGet(dyn.entryT(), ENTRY_KEY);
      c.call(this.key());
      c.call(this.ibPuts());
      putLit(": ");
      c.localGet(OENTRY);
      c.structGet(dyn.entryT(), ENTRY_VALUE);
      c.localGet(INDENT);
      c.i32Const(2);
      c.i32Add();
      c.localGet(RT);
      c.i32Const(1);
      c.i32Add();
      c.call(this.cfValue());
      c.localGet(OMARK);
      c.call(this.ibTake());
      c.localSet(STMP);
      c.localGet(OSTRARR);
      c.localGet(OI);
      c.localGet(STMP);
      c.arraySet(this.cfEntryStrArr());
      c.localGet(OI);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OI);
      c.br(0);
      c.end();
      c.end();
      // Insertion sort over OSTRARR[0..OLEN) by %w.strCmpU16 — stability
      // is unreachable (two entries can only tie if their full rendered
      // texts are equal, which needs two equal keys), so any
      // deterministic sort is correct and this is the smallest one
      // (A.4's own recommendation).
      c.i32Const(1);
      c.localSet(SJ);
      c.block();
      c.loop();
      c.localGet(SJ);
      c.localGet(OLEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(OSTRARR);
      c.localGet(SJ);
      c.arrayGet(this.cfEntryStrArr());
      c.localSet(STMP);
      c.localGet(SJ);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(SIDX);
      c.block();
      c.loop();
      c.localGet(SIDX);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(OSTRARR);
      c.localGet(SIDX);
      c.arrayGet(this.cfEntryStrArr());
      c.localGet(STMP);
      c.call(this.deps.strCmpU16());
      c.i32Const(0);
      c.i32LeS();
      c.brIf(1);
      c.localGet(OSTRARR);
      c.localGet(SIDX);
      c.i32Const(1);
      c.i32Add();
      c.localGet(OSTRARR);
      c.localGet(SIDX);
      c.arrayGet(this.cfEntryStrArr());
      c.arraySet(this.cfEntryStrArr());
      c.localGet(SIDX);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(SIDX);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OSTRARR);
      c.localGet(SIDX);
      c.i32Const(1);
      c.i32Add();
      c.localGet(STMP);
      c.arraySet(this.cfEntryStrArr());
      c.localGet(SJ);
      c.i32Const(1);
      c.i32Add();
      c.localSet(SJ);
      c.br(0);
      c.end();
      c.end();
      // Emit: the null-proto prefix, the braces, and every SORTED entry.
      c.localGet(ONULLP);
      c.ifVoid();
      putLit("[Object: null prototype] ");
      c.end();
      putc("{");
      c.i32Const(0);
      c.localSet(OI);
      c.block();
      c.loop();
      c.localGet(OI);
      c.localGet(OLEN);
      c.i32GeS();
      c.brIf(1);
      putc("\n");
      spaces(() => {
        c.localGet(INDENT);
        c.i32Const(2);
        c.i32Add();
      });
      c.localGet(OSTRARR);
      c.localGet(OI);
      c.arrayGet(this.cfEntryStrArr());
      c.call(this.ibPuts());
      c.localGet(OI);
      c.i32Const(1);
      c.i32Add();
      c.localGet(OLEN);
      c.i32Ne();
      c.ifVoid();
      putc(",");
      c.end();
      c.localGet(OI);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OI);
      c.br(0);
      c.end();
      c.end();
      putc("\n");
      spaces(() => c.localGet(INDENT));
      putc("}");
      c.call(this.cfSeenPop());
      c.return_();
      c.end();

      // Exhaustive over DK's 12 kinds; every arm above returns. The
      // remaining three (HANDLE, PROMISE, JSVAL) trap — A.5's own
      // recommendation, a BARE unreachable with no placeholder: none is
      // constructible on this tier reaching this call (JSVAL never,
      // 0.1; HANDLE has no producer; PROMISE's producer cannot reach
      // eqDyn — none of the six does), and a knowingly-wrong placeholder
      // string would need an S-entry to authorize a divergence that buys
      // no claim, which A.5 explicitly rejects porting C's forms for.
      c.unreachable();

      this.mb.setBody(
        idx,
        [I32, strRefT, this.deps.bytesRefU8(), I32, I32, I32, dyn.arrRef(), I32, I32, dyn.objRef(), I32, I32, entriesRefT, I32, dyn.entryRef(), I32, strArrRefT, I32, I32, strRefT],
        c.bytes(),
      );
    });
  }

  /** `%w.assert.cfInspect(d) -> strref` — A.1's entry point: mark, render
   * from the top (`indent`/`rt` both 0), take. The whole of `assert.
   * eqDyn`'s failure-message renderer funnels through this one call. */
  cfInspect(): number {
    const dyn = this.deps.dyn();
    return this.cached("cfInspect", [dyn.dynRef()], [this.deps.strRef()], (idx) => {
      const c = new Code();
      const D = 0;
      const MARK = 1;
      this.pushMark(c);
      c.localSet(MARK);
      c.localGet(D);
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.cfValue());
      c.localGet(MARK);
      c.call(this.ibTake());
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.assert.splitLines(s) -> (offsets, n)` (design-p2.txt C.1) —
   * Node does `StringPrototypeSplit(inspected, '\n')`; N newlines give
   * N+1 pieces. WASM LAYOUT: no substrings — `offsets` holds n+1 START
   * positions (`offsets[0] = 0`; `offsets[n] = len+1` is a SENTINEL),
   * so line i spans `[offsets[i], offsets[i+1]-1)`. Two passes: count
   * newlines, then fill. Every downstream consumer (`linesEq`, the
   * printer's own line emission, notIdentical's 50-line slice, neq's
   * 47-line collapse) wants a (str, from, to) triple computed from two
   * adjacent offsets — this function hands back the RAW offsets array
   * and count, not materialized substrings, per C.1's own layout. */
  splitLines(): number {
    const offsetsRefT = this.i32ArrRef();
    return this.cached("splitLines", [this.deps.strRef()], [offsetsRefT, I32], (idx) => {
      const strT = this.deps.strType();
      const c = new Code();
      const S = 0;
      const LEN = 1;
      const I = 2;
      const NL = 3;
      const OFFSETS = 4;
      const OI = 5;
      c.localGet(S);
      c.arrayLen();
      c.localSet(LEN);
      // Pass 1: count newlines.
      c.i32Const(0);
      c.localSet(NL);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(10); // '\n'
      c.i32Eq();
      c.ifVoid();
      c.localGet(NL);
      c.i32Const(1);
      c.i32Add();
      c.localSet(NL);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // Allocate offsets[0..NL+1] — NL+2 entries (n = NL+1 lines, plus
      // the sentinel).
      c.localGet(NL);
      c.i32Const(2);
      c.i32Add();
      c.arrayNewDefault(this.i32Arr());
      c.localSet(OFFSETS);
      c.localGet(OFFSETS);
      c.i32Const(0);
      c.i32Const(0);
      c.arraySet(this.i32Arr());
      // Pass 2: fill offsets[1..NL] with the position right after each
      // newline.
      c.i32Const(1);
      c.localSet(OI);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(LEN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(strT);
      c.i32Const(10);
      c.i32Eq();
      c.ifVoid();
      c.localGet(OFFSETS);
      c.localGet(OI);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arraySet(this.i32Arr());
      c.localGet(OI);
      c.i32Const(1);
      c.i32Add();
      c.localSet(OI);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // Sentinel: offsets[NL+1] = len+1.
      c.localGet(OFFSETS);
      c.localGet(NL);
      c.i32Const(1);
      c.i32Add();
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Add();
      c.arraySet(this.i32Arr());
      c.localGet(OFFSETS);
      c.localGet(NL);
      c.i32Const(1);
      c.i32Add();
      // Locals beyond the 1 param (S=0): LEN=1, I=2, NL=3 (all i32),
      // OFFSETS=4 (the array REF — own first-pass bug, caught by
      // running this function's own pin: declared as I32 here
      // originally, which a validator rejects the moment
      // `array.new_default`'s result tries to `local.set` into it),
      // OI=5 (i32).
      this.mb.setBody(idx, [I32, I32, I32, offsetsRefT, I32], c.bytes());
    });
  }

  /** `%w.assert.linesEq(sa, fa, ta, sb, fb, tb, comma) -> i32` — C.2's
   * port of `areLinesEqual` (myers_diff.js:24-31): `a === b || (comma
   * && ((a+',') === b || a === (b+',')))`, as a range compare over the
   * SAME shared rendered string(s) `sa`/`sb` (which may be the SAME
   * string ref for two lines of one side, or different refs across
   * actual/expected) at `[fX, tX)`. HAZARD (own re-derivation of C.2's
   * own warning, confirmed against dyn.ts:3514-3517's `iterPack`
   * precedent): the three-way conjunction MUST nest as `if` blocks —
   * `i32.and` does not short-circuit, so `len-1 == other && s[t-1] ==
   * ','` evaluated flat would `array.get` at index -1 on a
   * zero-length line and TRAP. */
  linesEq(): number {
    return this.cached(
      "linesEq",
      [this.deps.strRef(), I32, I32, this.deps.strRef(), I32, I32, I32],
      [I32],
      (idx) => {
        const strT = this.deps.strType();
        const c = new Code();
        const SA = 0;
        const FA = 1;
        const TA = 2;
        const SB = 3;
        const FB = 4;
        const TB = 5;
        const COMMA = 6;
        const LA = 7;
        const LB = 8;
        const I = 9;
        c.localGet(TA);
        c.localGet(FA);
        c.i32Sub();
        c.localSet(LA);
        c.localGet(TB);
        c.localGet(FB);
        c.i32Sub();
        c.localSet(LB);
        // a === b: same length, same units.
        c.localGet(LA);
        c.localGet(LB);
        c.i32Eq();
        c.ifVoid();
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(LA);
        c.i32GeS();
        c.brIf(1);
        c.localGet(SA);
        c.localGet(FA);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(strT);
        c.localGet(SB);
        c.localGet(FB);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(strT);
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
        c.return_();
        c.end();
        c.localGet(COMMA);
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
        // (a+',') === b: LA+1 == LB, b's last unit is ',', and the
        // shared prefix (length LA) is equal.
        c.localGet(LA);
        c.i32Const(1);
        c.i32Add();
        c.localGet(LB);
        c.i32Eq();
        c.ifVoid();
        c.localGet(SB);
        c.localGet(TB);
        c.i32Const(1);
        c.i32Sub();
        c.arrayGetU(strT);
        c.i32Const(44); // ','
        c.i32Eq();
        c.ifVoid();
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(LA);
        c.i32GeS();
        c.brIf(1);
        c.localGet(SA);
        c.localGet(FA);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(strT);
        c.localGet(SB);
        c.localGet(FB);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(strT);
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
        c.return_();
        c.end();
        c.end();
        // a === (b+','): LB+1 == LA, a's last unit is ',', shared
        // prefix (length LB) equal.
        c.localGet(LB);
        c.i32Const(1);
        c.i32Add();
        c.localGet(LA);
        c.i32Eq();
        c.ifVoid();
        c.localGet(SA);
        c.localGet(TA);
        c.i32Const(1);
        c.i32Sub();
        c.arrayGetU(strT);
        c.i32Const(44);
        c.i32Eq();
        c.ifVoid();
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(LB);
        c.i32GeS();
        c.brIf(1);
        c.localGet(SA);
        c.localGet(FA);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(strT);
        c.localGet(SB);
        c.localGet(FB);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(strT);
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
        c.return_();
        c.end();
        c.end();
        c.i32Const(0);
        this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      },
    );
  }

  /** `%w.assert.myersForward(strA, offA, nA, strB, offB, nB, comma) ->
   * (trace, traceLen, max)` — Node's `myersDiff`'s own forward walk
   * (myers_diff.js:34-78), producing the WINDOWED trace C.4 proves is
   * output-identical to Node's own full-array clone per level.
   *
   * PADDING (C.3's own two hazards, BOTH fixed the same way): `v`'s
   * PHYSICAL array has length `2*max+3`; a LOGICAL offset `o` (which
   * ranges -1..2max+1 in Node's own algorithm, since `previousOffset`/
   * `nextOffset` read one past either end at the extremes) lives at
   * PHYSICAL index `o+1` (0..2max+2) — so both the neighbour-read
   * hazard (an out-of-range read that Node's own JS gets `undefined`
   * from, provably never USED — C.3's own worked proof) and the
   * window's own boundary at `diffLevel === max` (whose logical range
   * [max-max-1, max+max+1] = [-1, 2max+1] is EXACTLY v's own logical
   * range) are resolved by the identical `+1` adjustment. The inner
   * diagonal loop's own guard (`k !== d && prev < next`) reads BOTH
   * operands unconditionally either way (matching Node's own EAGER
   * read, C.3(ii)) — a flat `i32.and` is safe here specifically
   * because neither operand is an array read gated by the other. */
  myersForward(): number {
    const traceRefT = this.traceArrRef();
    return this.cached(
      "myersForward",
      [this.deps.strRef(), this.i32ArrRef(), I32, this.deps.strRef(), this.i32ArrRef(), I32, I32],
      [traceRefT, I32, I32],
      (idx) => {
        const c = new Code();
        const STRA = 0;
        const OFFA = 1;
        const NA = 2;
        const STRB = 3;
        const OFFB = 4;
        const NB = 5;
        const COMMA = 6;
        const MAXV = 7;
        const V = 8;
        const TRACE = 9;
        const DIFFLEVEL = 10;
        const DIAGIDX = 11;
        const OFFSET = 12;
        const PREVOFF = 13;
        const NEXTOFF = 14;
        const XV = 15;
        const YV = 16;
        const WIN = 17;
        const WINBASE = 18;
        const WINLEN = 19;
        const TMPI = 20;
        const TRACELEN = 21;
        const i32ArrT = this.i32Arr();
        const traceArrT = this.traceArr();

        // physV(logicalOffset) -> pushes the PHYSICAL v-index.
        const pushPhysV = (pushLogical: (c: Code) => void): void => {
          pushLogical(c);
          c.i32Const(1);
          c.i32Add();
        };
        const pushVGet = (pushLogical: (c: Code) => void): void => {
          c.localGet(V);
          pushPhysV(pushLogical);
          c.arrayGet(i32ArrT);
        };
        const pushLineFrom = (off: number, pushIdx: (c: Code) => void): void => {
          c.localGet(off);
          pushIdx(c);
          c.arrayGet(i32ArrT);
        };
        const pushLineTo = (off: number, pushIdx: (c: Code) => void): void => {
          c.localGet(off);
          pushIdx(c);
          c.i32Const(1);
          c.i32Add();
          c.arrayGet(i32ArrT);
          c.i32Const(1);
          c.i32Sub();
        };
        const pushLinesEqual = (pushX: (c: Code) => void, pushY: (c: Code) => void): void => {
          c.localGet(STRA);
          pushLineFrom(OFFA, pushX);
          pushLineTo(OFFA, pushX);
          c.localGet(STRB);
          pushLineFrom(OFFB, pushY);
          pushLineTo(OFFB, pushY);
          c.localGet(COMMA);
          c.call(this.linesEq());
        };

        c.localGet(NA);
        c.localGet(NB);
        c.i32Add();
        c.localSet(MAXV);
        c.localGet(MAXV);
        c.i32Const(2);
        c.i32Mul();
        c.i32Const(3);
        c.i32Add();
        c.arrayNewDefault(i32ArrT);
        c.localSet(V);
        c.localGet(MAXV);
        c.i32Const(1);
        c.i32Add();
        c.arrayNewDefault(traceArrT);
        c.localSet(TRACE);
        c.i32Const(0);
        c.localSet(TRACELEN);

        c.i32Const(0);
        c.localSet(DIFFLEVEL);
        c.block(); // 3: outer break
        c.loop(); // 2: outer continue
        c.localGet(DIFFLEVEL);
        c.localGet(MAXV);
        c.i32GtS();
        c.brIf(1); // break outer block (from loop depth: loop=0 relative here, block=1)

        // Snapshot this level's window BEFORE the diagonal loop writes.
        c.localGet(DIFFLEVEL);
        c.i32Const(2);
        c.i32Mul();
        c.i32Const(3);
        c.i32Add();
        c.localSet(WINLEN);
        c.localGet(MAXV);
        c.localGet(DIFFLEVEL);
        c.i32Sub();
        c.localSet(WINBASE);
        c.localGet(WINLEN);
        c.arrayNewDefault(i32ArrT);
        c.localSet(WIN);
        c.i32Const(0);
        c.localSet(TMPI);
        c.block();
        c.loop();
        c.localGet(TMPI);
        c.localGet(WINLEN);
        c.i32GeS();
        c.brIf(1);
        c.localGet(WIN);
        c.localGet(TMPI);
        c.localGet(V);
        c.localGet(WINBASE);
        c.localGet(TMPI);
        c.i32Add();
        c.arrayGet(i32ArrT);
        c.arraySet(i32ArrT);
        c.localGet(TMPI);
        c.i32Const(1);
        c.i32Add();
        c.localSet(TMPI);
        c.br(0);
        c.end();
        c.end();
        c.localGet(TRACE);
        c.localGet(DIFFLEVEL);
        c.localGet(WIN);
        c.arraySet(traceArrT);

        // The diagonal loop.
        c.localGet(DIFFLEVEL);
        c.i32Const(-1);
        c.i32Mul();
        c.localSet(DIAGIDX);
        c.block(); // 1: inner break
        c.loop(); // 0: inner continue
        c.localGet(DIAGIDX);
        c.localGet(DIFFLEVEL);
        c.i32GtS();
        c.brIf(1);
        c.localGet(DIAGIDX);
        c.localGet(MAXV);
        c.i32Add();
        c.localSet(OFFSET);
        pushVGet((x) => {
          x.localGet(OFFSET);
          x.i32Const(1);
          x.i32Sub();
        });
        c.localSet(PREVOFF);
        pushVGet((x) => {
          x.localGet(OFFSET);
          x.i32Const(1);
          x.i32Add();
        });
        c.localSet(NEXTOFF);
        c.localGet(DIAGIDX);
        c.localGet(DIFFLEVEL);
        c.i32Const(-1);
        c.i32Mul();
        c.i32Eq();
        c.ifResult(I32);
        c.localGet(NEXTOFF);
        c.else_();
        c.localGet(DIAGIDX);
        c.localGet(DIFFLEVEL);
        c.i32Ne();
        c.localGet(PREVOFF);
        c.localGet(NEXTOFF);
        c.i32LtS();
        c.i32And();
        c.ifResult(I32);
        c.localGet(NEXTOFF);
        c.else_();
        c.localGet(PREVOFF);
        c.i32Const(1);
        c.i32Add();
        c.end();
        c.end();
        c.localSet(XV);
        c.localGet(XV);
        c.localGet(DIAGIDX);
        c.i32Sub();
        c.localSet(YV);
        c.block();
        c.loop();
        c.localGet(XV);
        c.localGet(NA);
        c.i32LtS();
        c.ifResult(I32);
        c.localGet(YV);
        c.localGet(NB);
        c.i32LtS();
        c.else_();
        c.i32Const(0);
        c.end();
        c.i32Eqz();
        c.brIf(1);
        pushLinesEqual(
          (x) => x.localGet(XV),
          (x) => x.localGet(YV),
        );
        c.i32Eqz();
        c.brIf(1);
        c.localGet(XV);
        c.i32Const(1);
        c.i32Add();
        c.localSet(XV);
        c.localGet(YV);
        c.i32Const(1);
        c.i32Add();
        c.localSet(YV);
        c.br(0);
        c.end();
        c.end();
        c.localGet(V);
        c.localGet(OFFSET);
        c.i32Const(1);
        c.i32Add();
        c.localGet(XV);
        c.arraySet(i32ArrT);
        c.localGet(XV);
        c.localGet(NA);
        c.i32GeS();
        c.ifResult(I32);
        c.localGet(YV);
        c.localGet(NB);
        c.i32GeS();
        c.else_();
        c.i32Const(0);
        c.end();
        c.ifVoid();
        c.localGet(DIFFLEVEL);
        c.i32Const(1);
        c.i32Add();
        c.localSet(TRACELEN);
        // Break the OUTER block. Nesting at this point, innermost
        // first: this ifVoid(0), inner loop(1), inner block(2), outer
        // loop(3), outer block(4) — own first-pass bug, caught by
        // running this function's own pin: an off-by-one here (br(3),
        // targeting the OUTER LOOP as a "continue" instead of the
        // OUTER BLOCK as a "break") re-ran the same diffLevel forever
        // since DIFFLEVEL is only incremented at the BOTTOM of the
        // outer loop body, past this branch — an infinite loop, not a
        // validation error, since br(3) was still a STRUCTURALLY
        // valid (if wrong) target.
        c.br(4);
        c.end();
        c.localGet(DIAGIDX);
        c.i32Const(2);
        c.i32Add();
        c.localSet(DIAGIDX);
        c.br(0);
        c.end();
        c.end();
        c.localGet(DIFFLEVEL);
        c.i32Const(1);
        c.i32Add();
        c.localSet(DIFFLEVEL);
        c.br(0);
        c.end();
        c.end();

        c.localGet(TRACE);
        c.localGet(TRACELEN);
        c.localGet(MAXV);
        this.mb.setBody(
          idx,
          [
            I32 /* MAXV=7 */,
            this.i32ArrRef() /* V=8 */,
            traceRefT /* TRACE=9 */,
            I32 /* DIFFLEVEL=10 */,
            I32 /* DIAGIDX=11 */,
            I32 /* OFFSET=12 */,
            I32 /* PREVOFF=13 */,
            I32 /* NEXTOFF=14 */,
            I32 /* XV=15 */,
            I32 /* YV=16 */,
            this.i32ArrRef() /* WIN=17 */,
            I32 /* WINBASE=18 */,
            I32 /* WINLEN=19 */,
            I32 /* TMPI=20 */,
            I32 /* TRACELEN=21 */,
          ],
          c.bytes(),
        );
      },
    );
  }

  /** `%w.assert.myersBacktrack(strA, offA, nA, strB, offB, nB, comma,
   * trace, traceLen, max) -> (ops, sides, idxs, resultLen)` — C.6's
   * port of `backtrack` (myers_diff.js:80-125), walking `diffLevel`
   * from `traceLen-1` down to 0 in REVERSE document order (the caller
   * — `printMyersDiff` — walks it back to front to recover forward
   * order, exactly as Node's own printer does).
   *
   * REPRESENTATION: rather than push JS-style `[op, value]` pairs (a
   * STRING per NOP/INSERT/DELETE), this stores three parallel
   * `array i32`s — `ops` ({-1,0,1} = DELETE/NOP/INSERT), `sides` (0 =
   * slice from the actual/`strA` side, 1 = expected/`strB`), `idxs`
   * (the LINE INDEX within that side) — deferring the actual byte
   * slice to `printMyersDiff`, which already needs strA/offA/strB/offB
   * to render. Pre-sized to `max` entries: NOP+INSERT sum to exactly
   * `nA` (x's total descent from nA to 0) and NOP+DELETE sum to
   * exactly `nB`, so total pushes = nA+nB-NOP <= nA+nB = max — same
   * "exact safe upper bound, no growable array" style as `myersForward`'s
   * own `trace`.
   *
   * THE NOP-VALUE RULE (C.6's own citation, MEASURED reachable BOTH
   * directions in the corpus): `value = comma && !actualItem.endsWith(',')
   * ? expected[y-1] : actual[x-1]` — a NOP can render EITHER side's
   * line. 1771 L4 (`{a:1,b:2}` vs `{a:1}`) takes the actual side (its
   * own comma-suffixed `a: 1,`); 1771 L16 (`{a:1}` vs `{a:1,b:undefined}`)
   * takes the expected side, because the ACTUAL line there has no
   * trailing comma. `endsWithComma` is read EAGERLY regardless of
   * `comma`'s own value (a pure, always-in-bounds read of the actual
   * line at index x-1, x>=1 guaranteed by the while-loop's own guard)
   * and ANDed flat with `comma` — safe for the same reason `myersForward`'s
   * own flat `i32And` is safe: neither operand is an array read gated
   * by the other.
   *
   * WINDOWED-TRACE READS: `trace[diffLevel]` is the SAME 2L+3-windowed
   * snapshot `myersForward` writes (C.4's own base = `max-diffLevel-1`,
   * i.e. physical = logical - (max-diffLevel-1) via the SAME "+1"
   * shift myersForward's own `pushPhysV` uses for the live `v`,
   * substituting `max-diffLevel` for myersForward's plain `max`).
   * C.4's own proof explicitly covers backtrack's three reads here
   * (`v[offset-1]`, `v[offset+1]`, `v[prevDiagonalIndex+max]`) as
   * "all three indices lie in [max-L-1, max+L+1]" — i.e. ALWAYS within
   * the window's own allocated bounds (no trap), even at the diagIdx
   * extremes where Node's own `||`/`&&` would have short-circuited
   * past reading them — so, exactly as in `myersForward`, eager reads
   * plus a selection that matches Node's short-circuit STRUCTURE
   * (not its evaluation order) reproduce the same result. */
  myersBacktrack(): number {
    const i32ArrRefT = this.i32ArrRef();
    return this.cached(
      "myersBacktrack",
      [
        this.deps.strRef(),
        i32ArrRefT,
        I32,
        this.deps.strRef(),
        i32ArrRefT,
        I32,
        I32,
        this.traceArrRef(),
        I32,
        I32,
      ],
      [i32ArrRefT, i32ArrRefT, i32ArrRefT, I32],
      (idx) => {
        const c = new Code();
        const STRA = 0;
        const OFFA = 1;
        const NA = 2;
        const STRB = 3;
        const OFFB = 4;
        const NB = 5;
        const COMMA = 6;
        const TRACE = 7;
        const TRACELEN = 8;
        const MAXV = 9;
        const X = 10;
        const Y = 11;
        const RESLEN = 12;
        const OPS = 13;
        const SIDES = 14;
        const IDXS = 15;
        const DIFFLEVEL = 16;
        const V = 17;
        const DIAGIDX = 18;
        const OFFSET = 19;
        const PREVDIAGIDX = 20;
        const PREVOFF = 21;
        const NEXTOFF = 22;
        const PREVX = 23;
        const PREVY = 24;
        const ENDSCOMMA = 25;
        const USEEXP = 26;
        const i32ArrT = this.i32Arr();
        const traceArrT = this.traceArr();
        const strT = this.deps.strType();
        void OFFB;
        void STRB;
        void NB;

        const pushLineFrom = (off: number, pushIdx: (c: Code) => void): void => {
          c.localGet(off);
          pushIdx(c);
          c.arrayGet(i32ArrT);
        };
        const pushLineTo = (off: number, pushIdx: (c: Code) => void): void => {
          c.localGet(off);
          pushIdx(c);
          c.i32Const(1);
          c.i32Add();
          c.arrayGet(i32ArrT);
          c.i32Const(1);
          c.i32Sub();
        };
        // 1 iff the ACTUAL line at pushIdx is non-empty and its last
        // unit is ','  (matches ''.endsWith(',') === false for empty).
        const pushEndsWithComma = (pushIdx: (c: Code) => void): void => {
          pushLineTo(OFFA, pushIdx);
          pushLineFrom(OFFA, pushIdx);
          c.i32GtS();
          c.ifResult(I32);
          c.localGet(STRA);
          pushLineTo(OFFA, pushIdx);
          c.i32Const(1);
          c.i32Sub();
          c.arrayGetU(strT);
          c.i32Const(44); // ','
          c.i32Eq();
          c.else_();
          c.i32Const(0);
          c.end();
        };
        // physical window index = logical - (max-diffLevel) + 1, the
        // SAME "+1" shift myersForward's own physV uses, with the
        // window's base (max-diffLevel) standing in for myersForward's
        // plain max (C.4).
        const pushWinGet = (pushLogical: (c: Code) => void): void => {
          c.localGet(V);
          pushLogical(c);
          c.localGet(MAXV);
          c.i32Sub();
          c.localGet(DIFFLEVEL);
          c.i32Add();
          c.i32Const(1);
          c.i32Add();
          c.arrayGet(i32ArrT);
        };

        c.localGet(NA);
        c.localSet(X);
        c.localGet(NB);
        c.localSet(Y);
        c.i32Const(0);
        c.localSet(RESLEN);
        c.localGet(MAXV);
        c.arrayNewDefault(i32ArrT);
        c.localSet(OPS);
        c.localGet(MAXV);
        c.arrayNewDefault(i32ArrT);
        c.localSet(SIDES);
        c.localGet(MAXV);
        c.arrayNewDefault(i32ArrT);
        c.localSet(IDXS);

        c.localGet(TRACELEN);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(DIFFLEVEL);
        c.block(); // outer break
        c.loop(); // outer continue
        c.localGet(DIFFLEVEL);
        c.i32Const(0);
        c.i32LtS();
        c.brIf(1); // break outer block (loop=0 here, block=1)

        c.localGet(TRACE);
        c.localGet(DIFFLEVEL);
        c.arrayGet(traceArrT);
        c.localSet(V);

        c.localGet(X);
        c.localGet(Y);
        c.i32Sub();
        c.localSet(DIAGIDX);
        c.localGet(DIAGIDX);
        c.localGet(MAXV);
        c.i32Add();
        c.localSet(OFFSET);

        pushWinGet((x) => {
          x.localGet(OFFSET);
          x.i32Const(1);
          x.i32Sub();
        });
        c.localSet(PREVOFF);
        pushWinGet((x) => {
          x.localGet(OFFSET);
          x.i32Const(1);
          x.i32Add();
        });
        c.localSet(NEXTOFF);
        c.localGet(DIAGIDX);
        c.localGet(DIFFLEVEL);
        c.i32Const(-1);
        c.i32Mul();
        c.i32Eq();
        c.ifResult(I32);
        c.localGet(DIAGIDX);
        c.i32Const(1);
        c.i32Add();
        c.else_();
        c.localGet(DIAGIDX);
        c.localGet(DIFFLEVEL);
        c.i32Ne();
        c.localGet(PREVOFF);
        c.localGet(NEXTOFF);
        c.i32LtS();
        c.i32And();
        c.ifResult(I32);
        c.localGet(DIAGIDX);
        c.i32Const(1);
        c.i32Add();
        c.else_();
        c.localGet(DIAGIDX);
        c.i32Const(1);
        c.i32Sub();
        c.end();
        c.end();
        c.localSet(PREVDIAGIDX);

        pushWinGet((x) => {
          x.localGet(PREVDIAGIDX);
          x.localGet(MAXV);
          x.i32Add();
        });
        c.localSet(PREVX);
        c.localGet(PREVX);
        c.localGet(PREVDIAGIDX);
        c.i32Sub();
        c.localSet(PREVY);

        // The NOP while-loop: while (x>prevX && y>prevY).
        c.block(); // NOP break
        c.loop(); // NOP continue
        c.localGet(X);
        c.localGet(PREVX);
        c.i32GtS();
        c.localGet(Y);
        c.localGet(PREVY);
        c.i32GtS();
        c.i32And();
        c.i32Eqz();
        c.brIf(1); // break NOP block (loop=0, block=1 here)

        pushEndsWithComma((x) => {
          x.localGet(X);
          x.i32Const(1);
          x.i32Sub();
        });
        c.localSet(ENDSCOMMA);
        c.localGet(COMMA);
        c.localGet(ENDSCOMMA);
        c.i32Eqz();
        c.i32And();
        c.localSet(USEEXP);

        c.localGet(OPS);
        c.localGet(RESLEN);
        c.i32Const(0); // NOP
        c.arraySet(i32ArrT);
        c.localGet(USEEXP);
        c.ifVoid();
        c.localGet(SIDES);
        c.localGet(RESLEN);
        c.i32Const(1); // expected side
        c.arraySet(i32ArrT);
        c.localGet(IDXS);
        c.localGet(RESLEN);
        c.localGet(Y);
        c.i32Const(1);
        c.i32Sub();
        c.arraySet(i32ArrT);
        c.else_();
        c.localGet(SIDES);
        c.localGet(RESLEN);
        c.i32Const(0); // actual side
        c.arraySet(i32ArrT);
        c.localGet(IDXS);
        c.localGet(RESLEN);
        c.localGet(X);
        c.i32Const(1);
        c.i32Sub();
        c.arraySet(i32ArrT);
        c.end();

        c.localGet(RESLEN);
        c.i32Const(1);
        c.i32Add();
        c.localSet(RESLEN);
        c.localGet(X);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(X);
        c.localGet(Y);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(Y);
        c.br(0); // continue NOP loop (loop=0 here, directly inside it)
        c.end();
        c.end();

        // diffLevel > 0: exactly one INSERT or DELETE.
        c.localGet(DIFFLEVEL);
        c.i32Const(0);
        c.i32GtS();
        c.ifVoid();
        c.localGet(X);
        c.localGet(PREVX);
        c.i32GtS();
        c.ifVoid();
        c.localGet(X);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(X);
        c.localGet(OPS);
        c.localGet(RESLEN);
        c.i32Const(1); // INSERT
        c.arraySet(i32ArrT);
        c.localGet(SIDES);
        c.localGet(RESLEN);
        c.i32Const(0); // actual side
        c.arraySet(i32ArrT);
        c.localGet(IDXS);
        c.localGet(RESLEN);
        c.localGet(X);
        c.arraySet(i32ArrT);
        c.localGet(RESLEN);
        c.i32Const(1);
        c.i32Add();
        c.localSet(RESLEN);
        c.else_();
        c.localGet(Y);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(Y);
        c.localGet(OPS);
        c.localGet(RESLEN);
        c.i32Const(-1); // DELETE
        c.arraySet(i32ArrT);
        c.localGet(SIDES);
        c.localGet(RESLEN);
        c.i32Const(1); // expected side
        c.arraySet(i32ArrT);
        c.localGet(IDXS);
        c.localGet(RESLEN);
        c.localGet(Y);
        c.arraySet(i32ArrT);
        c.localGet(RESLEN);
        c.i32Const(1);
        c.i32Add();
        c.localSet(RESLEN);
        c.end();
        c.end();

        c.localGet(DIFFLEVEL);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(DIFFLEVEL);
        c.br(0); // continue outer loop (loop=0 here, directly inside it)
        c.end();
        c.end();

        c.localGet(OPS);
        c.localGet(SIDES);
        c.localGet(IDXS);
        c.localGet(RESLEN);
        this.mb.setBody(
          idx,
          [
            I32 /* X=10 */,
            I32 /* Y=11 */,
            I32 /* RESLEN=12 */,
            i32ArrRefT /* OPS=13 */,
            i32ArrRefT /* SIDES=14 */,
            i32ArrRefT /* IDXS=15 */,
            I32 /* DIFFLEVEL=16 */,
            this.i32ArrRef() /* V=17 */,
            I32 /* DIAGIDX=18 */,
            I32 /* OFFSET=19 */,
            I32 /* PREVDIAGIDX=20 */,
            I32 /* PREVOFF=21 */,
            I32 /* NEXTOFF=22 */,
            I32 /* PREVX=23 */,
            I32 /* PREVY=24 */,
            I32 /* ENDSCOMMA=25 */,
            I32 /* USEEXP=26 */,
          ],
          c.bytes(),
        );
      },
    );
  }

  /** `%w.assert.printMyersDiff(strA, offA, strB, offB, ops, sides, idxs,
   * resultLen) -> (message, skipped)` — C.7's port of `printMyersDiff`
   * (myers_diff.js:146-189). `operator` is NOT a parameter: D.6 (design-
   * p2.txt) already rules `partialDeepStrictEqual`'s gray/space INSERT
   * variant and all of `colors` out of scope — this tier renders the
   * NO-COLOR configuration unconditionally (no stderr to interrogate),
   * so every `colors.X` in Node's own source is the empty string here,
   * and INSERT always takes the plain `"+ "` form.
   *
   * Walks `diffIdx` from `resultLen-1` down to 0 — DOCUMENT order,
   * since `myersBacktrack` pushed in REVERSE document order (C.6).
   *
   * TWO faithfully-ported quirks (both MEASURED in the corpus, C.7's
   * own notes): (a) a trailing common (NOP) run past 5 lines at the
   * very END of the diff is silently DROPPED — there is no flush after
   * the loop, only a transition out of a NOP run triggers the collapse
   * arms, and the loop simply ends while still inside one; (b) the
   * final trim is JS's REAL `trimEnd` (`deps.strTrimEnd`, the full
   * ECMA White_Space + LineTerminator scan `strings.ts` already
   * implements), not the narrower "strip '\n'/' ' only" a C-shaped
   * port would suggest. */
  printMyersDiff(): number {
    const i32ArrRefT = this.i32ArrRef();
    const strRefT = this.deps.strRef();
    return this.cached(
      "printMyersDiff",
      [strRefT, i32ArrRefT, strRefT, i32ArrRefT, i32ArrRefT, i32ArrRefT, i32ArrRefT, I32],
      [strRefT, I32],
      (idx) => {
        const c = new Code();
        const STRA = 0;
        const OFFA = 1;
        const STRB = 2;
        const OFFB = 3;
        const OPS = 4;
        const SIDES = 5;
        const IDXS = 6;
        const RESLEN = 7;
        const MARK = 8;
        const DIFFIDX = 9;
        const NOPCOUNT = 10;
        const SKIPPED = 11;
        const OPVAL = 12;
        const PREVOP = 13;
        const TRIMMED = 14;
        const i32ArrT = this.i32Arr();
        const NULL_SENTINEL = -2; // outside {-1,0,1} — Node's `null`.
        const NOP = 0;
        const INSERT = 1;
        const DELETE = -1;

        const pushLineFrom = (off: number, pushIdx: (c: Code) => void): void => {
          c.localGet(off);
          pushIdx(c);
          c.arrayGet(i32ArrT);
        };
        const pushLineTo = (off: number, pushIdx: (c: Code) => void): void => {
          c.localGet(off);
          pushIdx(c);
          c.i32Const(1);
          c.i32Add();
          c.arrayGet(i32ArrT);
          c.i32Const(1);
          c.i32Sub();
        };
        const pushOpAt = (pushK: (c: Code) => void): void => {
          c.localGet(OPS);
          pushK(c);
          c.arrayGet(i32ArrT);
        };
        const pushIdxAt = (pushK: (c: Code) => void): ((c: Code) => void) => {
          return (x) => {
            x.localGet(IDXS);
            pushK(x);
            x.arrayGet(i32ArrT);
          };
        };
        // strRef/from/to for the line at `pushK`, selecting actual
        // (side=0) vs expected (side=1) — three independent reads of
        // `sides[pushK]` (a pure array read, safe to repeat).
        const pushEmitLine = (pushK: (c: Code) => void): void => {
          const idxAt = pushIdxAt(pushK);
          const pushSide = (): void => {
            c.localGet(SIDES);
            pushK(c);
            c.arrayGet(i32ArrT);
          };
          pushSide();
          c.ifResult(strRefT);
          c.localGet(STRB);
          c.else_();
          c.localGet(STRA);
          c.end();
          pushSide();
          c.ifResult(I32);
          pushLineFrom(OFFB, idxAt);
          c.else_();
          pushLineFrom(OFFA, idxAt);
          c.end();
          pushSide();
          c.ifResult(I32);
          pushLineTo(OFFB, idxAt);
          c.else_();
          pushLineTo(OFFA, idxAt);
          c.end();
          c.call(this.ibPutRange());
        };
        const putLit = (s: string): void => {
          this.deps.lit(c, s);
          c.call(this.ibPuts());
        };

        c.i32Const(0);
        c.localSet(NOPCOUNT);
        c.i32Const(0);
        c.localSet(SKIPPED);
        this.pushMark(c);
        c.localSet(MARK);

        c.localGet(RESLEN);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(DIFFIDX);
        c.block(); // outer break
        c.loop(); // outer continue
        c.localGet(DIFFIDX);
        c.i32Const(0);
        c.i32LtS();
        c.brIf(1); // break outer block (loop=0 here, block=1)

        pushOpAt((x) => x.localGet(DIFFIDX));
        c.localSet(OPVAL);

        c.localGet(DIFFIDX);
        c.localGet(RESLEN);
        c.i32Const(1);
        c.i32Sub();
        c.i32LtS();
        c.ifResult(I32);
        pushOpAt((x) => {
          x.localGet(DIFFIDX);
          x.i32Const(1);
          x.i32Add();
        });
        c.else_();
        c.i32Const(NULL_SENTINEL);
        c.end();
        c.localSet(PREVOP);

        // previousOperation === NOP && operation !== previousOperation
        c.localGet(PREVOP);
        c.i32Const(NOP);
        c.i32Eq();
        c.localGet(OPVAL);
        c.localGet(PREVOP);
        c.i32Ne();
        c.i32And();
        c.ifVoid();
        c.localGet(NOPCOUNT);
        c.i32Const(6);
        c.i32Eq();
        c.ifVoid();
        putLit("  ");
        pushEmitLine((x) => {
          x.localGet(DIFFIDX);
          x.i32Const(1);
          x.i32Add();
        });
        putLit("\n");
        c.else_();
        c.localGet(NOPCOUNT);
        c.i32Const(7);
        c.i32Eq();
        c.ifVoid();
        putLit("  ");
        pushEmitLine((x) => {
          x.localGet(DIFFIDX);
          x.i32Const(2);
          x.i32Add();
        });
        putLit("\n");
        putLit("  ");
        pushEmitLine((x) => {
          x.localGet(DIFFIDX);
          x.i32Const(1);
          x.i32Add();
        });
        putLit("\n");
        c.else_();
        c.localGet(NOPCOUNT);
        c.i32Const(8);
        c.i32GeS();
        c.ifVoid();
        putLit("...\n");
        putLit("  ");
        pushEmitLine((x) => {
          x.localGet(DIFFIDX);
          x.i32Const(1);
          x.i32Add();
        });
        putLit("\n");
        c.i32Const(1);
        c.localSet(SKIPPED);
        c.end();
        c.end();
        c.end();
        c.i32Const(0);
        c.localSet(NOPCOUNT);
        c.end();

        c.localGet(OPVAL);
        c.i32Const(INSERT);
        c.i32Eq();
        c.ifVoid();
        putLit("+ ");
        pushEmitLine((x) => x.localGet(DIFFIDX));
        putLit("\n");
        c.else_();
        c.localGet(OPVAL);
        c.i32Const(DELETE);
        c.i32Eq();
        c.ifVoid();
        putLit("- ");
        pushEmitLine((x) => x.localGet(DIFFIDX));
        putLit("\n");
        c.else_();
        c.localGet(NOPCOUNT);
        c.i32Const(5);
        c.i32LtS();
        c.ifVoid();
        putLit("  ");
        pushEmitLine((x) => x.localGet(DIFFIDX));
        putLit("\n");
        c.end();
        c.localGet(NOPCOUNT);
        c.i32Const(1);
        c.i32Add();
        c.localSet(NOPCOUNT);
        c.end();
        c.end();

        c.localGet(DIFFIDX);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(DIFFIDX);
        c.br(0); // continue outer loop (loop=0 here, directly inside it)
        c.end();
        c.end();

        c.localGet(MARK);
        c.call(this.ibTake());
        c.call(this.deps.strTrimEnd());
        c.localSet(TRIMMED);
        putLit("\n");
        c.localGet(TRIMMED);
        c.call(this.ibPuts());
        c.localGet(MARK);
        c.call(this.ibTake());
        c.localGet(SKIPPED);
        this.mb.setBody(
          idx,
          [
            I32 /* MARK=8 */,
            I32 /* DIFFIDX=9 */,
            I32 /* NOPCOUNT=10 */,
            I32 /* SKIPPED=11 */,
            I32 /* OPVAL=12 */,
            I32 /* PREVOP=13 */,
            strRefT /* TRIMMED=14 */,
          ],
          c.bytes(),
        );
      },
    );
  }
}
