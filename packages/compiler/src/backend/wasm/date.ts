/* INC-25 pass P6 — the `date.*` IR-key family (option D, design-number-v6.txt
 * §5.5/§6.6/§7.6/§8; CP1 cp1-plan-p6.txt e365032f + cp1-addendum-p6.txt
 * bd77f800, DELTA-1..5 folded in, CP1 ACK GO WITH DELTA). A structurally new
 * subsystem in `UriBuilder`'s own shape (its own `cached()` memo, its own
 * `%w.date.*` name prefix — the CACHED lesson, v6 §11.2: never a second
 * builder under an existing name).
 *
 * date.toISOString and date.utc are pure arithmetic (Howard Hinnant's
 * civil-from-days / days-from-civil, shared with `scr_lib.c`'s
 * scr_date_to_iso / scr_days_from_civil / scr_date_utc — 369c379d). Both
 * directions are kept in i32: the day count a millisecond time value can
 * ever produce is bounded by TimeClip to |days| <= 1e8 (scr_date_to_iso's
 * own comment), and date.utc's own pre-TimeClip safety bound (|ym| <= 1e6)
 * keeps every intermediate (era*146097 <= ~3.65e8, yoe*365 <= ~1.46e5,
 * doe <= ~1.46e5) comfortably inside i32 range too — measured, not
 * assumed (CP1 §(e) Class 2: Date.UTC(999999,0)/(500000,0)/(300000,0) are
 * all already NaN via TimeClip's own tighter ~275760-year reach, so the
 * 1e6 bound never actually distinguishes an output; it is kept purely so
 * `daysFromCivil`'s own arithmetic never sees a `ym` outside this margin).
 * f64 is used only for the FINAL millisecond assembly (day count * 86400000
 * plus the time-of-day parts), exactly where the C itself promotes to
 * `double` (scr_date_utc's `days*86400000.0 + h*3600000.0 + ...`).
 *
 * date.parseGetTime (CP1 §(h) D-3) is a STRUCTURAL DEPARTURE from
 * scr_date_parse_get_time's own control flow, not a port of it (CP1 §(e)
 * Class 3 Finding 1): the C commits to grammar 1 on a first-letter test and
 * `return NAN`s on ANY internal mismatch, never trying grammar 2 — which
 * would silently answer NaN for strings Node parses to a REAL time
 * ("Jan 1 2020", "bogus 2020"). Here, `tryGrammar1`/`tryGrammar2` each
 * answer (ok: i32, value: f64): ok=0 means "this grammar's shape did not
 * produce a disposition this tier can state" (a structural non-match, OR
 * one of the five measured reinterpretation classes below) — the caller
 * tries the next grammar, or fences if none is left. ok=1 means value IS
 * the answer, Node-exact, and value may itself legitimately be NaN
 * (a grammar-internal bound violation Node also answers NaN for).
 *
 * FIVE corrections beyond scr_date_parse_get_time's own text, each
 * measured this session or by rev-25's independent instrument (never
 * transcribed as the C has them — CP1 §(h), CP1-addendum, and the CP1 ACK's
 * five deltas):
 *   D-alpha (grammar 2): the ±HH:MM offset is BOUNDED (HH 00-23, MM 00-59),
 *     a check ABSENT from the C (board #133-alpha; 17,120/20,000 measured
 *     wrong without it).
 *   D-beta  (grammar 2): TimeClip applies ONCE, to the value AFTER the
 *     offset is subtracted — the C checks it on the PRE-offset value and
 *     never re-checks (board #133-beta; 23/78 measured wrong).
 *   D-gamma (grammar 2): a negative sign on an all-zero six-digit expanded
 *     year ("-000000...") is a STRUCTURAL NON-MATCH, checked before any
 *     bound check — Node's own answer for this shape varies by what
 *     follows it (NaN with a time part; a real, TZ-moving value for the
 *     date-only sub-case), so ok=0 (eventual fence) is the only choice
 *     safe for every measured variant (board #133-gamma).
 *   D-delta (grammar 2): month>12 / day==0 / day-out-of-range, on a BARE
 *     (non-expanded) 4-digit year in [0001,0012], is reinterpreted by V8's
 *     legacy parser as a LOCAL time (the year field read as the month) —
 *     ok=0 there, NODE-NaN (ok=1, NaN) at every other year (exhaustive,
 *     both this session's and rev's independent sweeps, board #134 is the
 *     NATIVE lanes' own miss of this, not this entry's class — S069, not
 *     yet registered here, is the class where NATIVE answers NaN and this
 *     tier fences instead).
 *   grammar-1's OWN analogous delta: day==0 / day>31, on the parsed 4-digit
 *     year in [0001,0031] (a DIFFERENT range from grammar 2's — the year
 *     FIELD itself gets reread as the DAY here, not the month), is the
 *     same reinterpretation class — ok=0 there. Stated as the conjunction
 *     WITH the day violation (CP1 addendum DELTA-2 — the P5 wording
 *     lesson: a measured rule and the sentence that states it are not the
 *     same thing, and the first draft's parenthesised guard omitted the
 *     day condition entirely).
 *   grammar-1's ADDITIONAL, SIXTH correction, found independently this
 *     session and reproduced by rev-25 (CP1 ACK DELTA-1, BLOCKING, board
 *     #134 — a WRONG VALUE, not a NaN-vs-value miss, so NOT S069's class
 *     and NOT #133's either, per the lead's own L-1 ruling): on a FULLY
 *     VALID grammar-1 string, Node applies its OWN two-digit-year rule to
 *     the parsed year — 0000-0049 -> 2000-2049, 0050-0099 -> 1950-1999 —
 *     which is NOT date.utc's ECMA MakeFullYear rule (always 1900+y; the
 *     two rules agree only on 0050-0099 and DISAGREE on the other half of
 *     the range). Modelled here as its OWN two-comparison-and-an-add,
 *     never by calling into date.utc's own year-normalisation, per the
 *     CP1 ACK's own naming of the trap.
 *   ss>59 in grammar 1 is UNCONDITIONALLY ok=0 (Node reinterprets the
 *     seconds field as a two-digit year at EVERY tested year, 10,000 of
 *     10,000 — never safely NaN-able, unlike hh/mi's own bound checks,
 *     which stay NODE-NaN at every year, also exhaustively confirmed).
 *
 * The fence (parseGetTime's own ok=0 exhaustion) is emitter-owned at the
 * call site, via `fencedFlag()` (see parseGetTimeHelper's own doc) —
 * this file NEVER touches the shared exception cell itself. This is a
 * DIFFERENT shape from P4's toFixed / P5's encodeUriComponent precedent
 * (where the HELPER sets the cell and the call site's generic
 * `emitPendingCheck()` reads it): here the call site checks its own
 * condition (a distinct flag, or — for toISOString's RangeError — the
 * bound check itself) and sets the cell/unwinds inline, using the SAME
 * underlying primitives (`openIf`/`close`/`emitSetCellErrorLit`/
 * `emitUnwind`) `emitPendingCheck()` is itself built from. */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

export interface DateDeps {
  strRef: () => ValType;
  strType: () => number;
}

/** The fence sentinel `%w.date.parseGetTime` returns when NEITHER grammar
 * produced a disposition: NaN's own bit pattern is a legitimate MODELLED
 * answer (a grammar-internal bound violation), so the call site cannot
 * test the RESULT to learn whether to fence — it needs a SEPARATE signal.
 * This builder exposes `lastParseFenced()` (a global the emitted body sets
 * immediately before returning the sentinel) for exactly that; the call
 * site reads it right after the call, before anything else can run. */
export class DateBuilder {
  private readonly fns = new Map<string, number>();
  private fencedGlobal: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: DateDeps,
  ) {}

  private strRef(): ValType {
    return this.deps.strRef();
  }
  private strType(): number {
    return this.deps.strType();
  }

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.date.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /** A mutable i32 global, 0/1: set to 1 by `%w.date.parseGetTime`'s own
   * body immediately before it returns the fence sentinel, and to 0 on
   * every OTHER return path (so a stale `1` from a previous call can never
   * leak). The call site (emitter.ts) reads this right after `call`,
   * before emitting anything that could itself call back into this
   * function (there is nothing that would, but the ordering is the
   * contract). */
  fencedFlag(): number {
    this.fencedGlobal ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
    return this.fencedGlobal;
  }

  /* ── the shared civil-calendar arithmetic (Howard Hinnant's algorithm,
   * both directions; scr_lib.c's scr_date_to_iso / scr_days_from_civil) ── */

  /** `%w.date.civilFromDays(days) -> (y, m, d)` — days since the epoch to
   * a proleptic-Gregorian (year, 1-based month, 1-based day). i32
   * throughout: TimeClip bounds |days| <= 1e8 (scr_date_to_iso's own
   * comment), so `era` (days/146097) stays under ~685, `era*146097`
   * under ~1e8, and `doe`/`yoe*365`/`doy` all stay under ~1.5e5 — every
   * intermediate is comfortably inside i32 range. */
  civilFromDaysHelper(): number {
    return this.cached("civilFromDays", [I32], [I32, I32, I32], (idx) => {
      const c = new Code();
      const DAYS = 0, Z = 1, ERA = 2, DOE = 3, YOE = 4, Y = 5, DOY = 6, MP = 7, D = 8, M = 9;
      const locals: ValType[] = [I32, I32, I32, I32, I32, I32, I32, I32, I32];
      // z = days + 719468
      c.localGet(DAYS);
      c.i32Const(719468);
      c.i32Add();
      c.localSet(Z);
      // era = (z >= 0 ? z : z - 146096) / 146097  (truncating i32 division
      // matches the C's `long long` division exactly; the C's own
      // `z - 146096` pre-adjustment for negative z is there BECAUSE C's
      // integer division also truncates toward zero, so it carries over
      // unchanged, not re-derived).
      c.localGet(Z);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(I32);
      c.localGet(Z);
      c.else_();
      c.localGet(Z);
      c.i32Const(146096);
      c.i32Sub();
      c.end();
      c.i32Const(146097);
      c.i32DivS();
      c.localSet(ERA);
      // doe = z - era*146097  (always in [0, 146096])
      c.localGet(Z);
      c.localGet(ERA);
      c.i32Const(146097);
      c.i32Mul();
      c.i32Sub();
      c.localSet(DOE);
      // yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365
      c.localGet(DOE);
      c.localGet(DOE);
      c.i32Const(1460);
      c.i32DivS();
      c.i32Sub();
      c.localGet(DOE);
      c.i32Const(36524);
      c.i32DivS();
      c.i32Add();
      c.localGet(DOE);
      c.i32Const(146096);
      c.i32DivS();
      c.i32Sub();
      c.i32Const(365);
      c.i32DivS();
      c.localSet(YOE);
      // y = yoe + era*400
      c.localGet(YOE);
      c.localGet(ERA);
      c.i32Const(400);
      c.i32Mul();
      c.i32Add();
      c.localSet(Y);
      // doy = doe - (365*yoe + yoe/4 - yoe/100)
      c.localGet(DOE);
      c.i32Const(365);
      c.localGet(YOE);
      c.i32Mul();
      c.localGet(YOE);
      c.i32Const(4);
      c.i32DivS();
      c.i32Add();
      c.localGet(YOE);
      c.i32Const(100);
      c.i32DivS();
      c.i32Sub();
      c.i32Sub();
      c.localSet(DOY);
      // mp = (5*doy + 2) / 153
      c.i32Const(5);
      c.localGet(DOY);
      c.i32Mul();
      c.i32Const(2);
      c.i32Add();
      c.i32Const(153);
      c.i32DivS();
      c.localSet(MP);
      // d = doy - (153*mp+2)/5 + 1
      c.localGet(DOY);
      c.i32Const(153);
      c.localGet(MP);
      c.i32Mul();
      c.i32Const(2);
      c.i32Add();
      c.i32Const(5);
      c.i32DivS();
      c.i32Sub();
      c.i32Const(1);
      c.i32Add();
      c.localSet(D);
      // m = mp < 10 ? mp+3 : mp-9
      c.localGet(MP);
      c.i32Const(10);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(MP);
      c.i32Const(3);
      c.i32Add();
      c.else_();
      c.localGet(MP);
      c.i32Const(9);
      c.i32Sub();
      c.end();
      c.localSet(M);
      // if (m <= 2) y += 1
      c.localGet(M);
      c.i32Const(2);
      c.i32LeS();
      c.ifVoid();
      c.localGet(Y);
      c.i32Const(1);
      c.i32Add();
      c.localSet(Y);
      c.end();
      // results: (y, m, d)
      c.localGet(Y);
      c.localGet(M);
      c.localGet(D);
      this.mb.setBody(idx, locals, c.bytes());
    });
  }

  /** `%w.date.daysFromCivil(y, m, d) -> days` — the inverse walk
   * (scr_days_from_civil). `m` is 1-based; NO bound checks here (the
   * caller applies whatever bound/rollover rule its own grammar needs —
   * this function extrapolates linearly for any i32 input, which is
   * exactly the C's own "V8 accepts days 1..31 in every month and rolls
   * over past the month's end" behaviour, e.g. Feb 30 -> Mar 2). */
  daysFromCivilHelper(): number {
    return this.cached("daysFromCivil", [I32, I32, I32], [I32], (idx) => {
      const c = new Code();
      const Y = 0, M = 1, D = 2, ERA = 3, YOE = 4, DOY = 5;
      const locals: ValType[] = [I32, I32, I32, I32];
      // y -= (m <= 2)
      c.localGet(M);
      c.i32Const(2);
      c.i32LeS();
      c.ifVoid();
      c.localGet(Y);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(Y);
      c.end();
      // era = (y >= 0 ? y : y - 399) / 400
      c.localGet(Y);
      c.i32Const(0);
      c.i32GeS();
      c.ifResult(I32);
      c.localGet(Y);
      c.else_();
      c.localGet(Y);
      c.i32Const(399);
      c.i32Sub();
      c.end();
      c.i32Const(400);
      c.i32DivS();
      c.localSet(ERA);
      // yoe = y - era*400
      c.localGet(Y);
      c.localGet(ERA);
      c.i32Const(400);
      c.i32Mul();
      c.i32Sub();
      c.localSet(YOE);
      // doy = (153*(m + (m>2 ? -3 : 9)) + 2)/5 + d - 1
      c.i32Const(153);
      c.localGet(M);
      c.localGet(M);
      c.i32Const(2);
      c.i32GtS();
      c.ifResult(I32);
      c.i32Const(-3);
      c.else_();
      c.i32Const(9);
      c.end();
      c.i32Add();
      c.i32Mul();
      c.i32Const(2);
      c.i32Add();
      c.i32Const(5);
      c.i32DivS();
      c.localGet(D);
      c.i32Add();
      c.i32Const(1);
      c.i32Sub();
      c.localSet(DOY);
      // return era*146097 + (yoe*365 + yoe/4 - yoe/100 + doy) - 719468
      c.localGet(ERA);
      c.i32Const(146097);
      c.i32Mul();
      c.localGet(YOE);
      c.i32Const(365);
      c.i32Mul();
      c.localGet(YOE);
      c.i32Const(4);
      c.i32DivS();
      c.i32Add();
      c.localGet(YOE);
      c.i32Const(100);
      c.i32DivS();
      c.i32Sub();
      c.localGet(DOY);
      c.i32Add();
      c.i32Add();
      c.i32Const(719468);
      c.i32Sub();
      this.mb.setBody(idx, locals, c.bytes());
    });
  }

  /* ── date.toISOString (scr_date_to_iso, ~3240) ───────────────────────── */

  /** `%w.date.toISO(ms) -> str`. The RangeError arm is the CALLER's: this
   * function only ever returns a valid string (never null, never sets the
   * exception cell) — validate.ts's key is `[F64]->STRING`, and the
   * RangeError check (`|ms| <= 8.64e15`) is cheap enough to duplicate at
   * the call site (emitter.ts), matching how the call site owns the
   * pending-check half of every other may-throw arm in this pass (P4's
   * toFixed precedent) rather than this file reaching into the exception
   * cell itself. */
  toISOHelper(): number {
    return this.cached("toISO", [F64], [this.strRef()], (idx) => {
      const strType = this.strType();
      const strRef = this.strRef();
      const c = new Code();
      const MS = 0; // f64 param
      const T = 1, DAYD = 2; // f64
      const DAYS = 3,
        MSDAY = 4,
        Y = 5,
        M = 6,
        D = 7,
        HH = 8,
        MI = 9,
        SS = 10,
        SSS = 11,
        PLAIN = 12,
        O = 13,
        IDX = 14,
        ABSY = 15;
      const locals: ValType[] = [
        F64,
        F64,
        I32,
        I32,
        I32,
        I32,
        I32,
        I32,
        I32,
        I32,
        I32,
        I32,
        strRef,
        I32,
        I32,
      ];
      // t = trunc(ms)
      c.localGet(MS);
      c.f64Trunc();
      c.localSet(T);
      // dayd = floor(t / 86400000)
      c.localGet(T);
      c.f64Const(86400000);
      c.f64Div();
      c.f64Floor();
      c.localSet(DAYD);
      // days = i32(dayd); msday = i32(t - dayd*86400000)  (both i32-safe,
      // |dayd| <= 1e8, |msday| < 86400000 — see this file's own header).
      c.localGet(DAYD);
      c.i32TruncF64S();
      c.localSet(DAYS);
      c.localGet(T);
      c.localGet(DAYD);
      c.f64Const(86400000);
      c.f64Mul();
      c.f64Sub();
      c.i32TruncF64S();
      c.localSet(MSDAY);
      // (y, m, d) = civilFromDays(days)
      c.localGet(DAYS);
      c.call(this.civilFromDaysHelper());
      c.localSet(D);
      c.localSet(M);
      c.localSet(Y);
      // hh/mi/ss/sss from msday (all non-negative, i32-safe division).
      c.localGet(MSDAY);
      c.i32Const(3600000);
      c.i32DivS();
      c.localSet(HH);
      c.localGet(MSDAY);
      c.i32Const(60000);
      c.i32DivS();
      c.i32Const(60);
      c.i32RemS();
      c.localSet(MI);
      c.localGet(MSDAY);
      c.i32Const(1000);
      c.i32DivS();
      c.i32Const(60);
      c.i32RemS();
      c.localSet(SS);
      c.localGet(MSDAY);
      c.i32Const(1000);
      c.i32RemS();
      c.localSet(SSS);

      // Assemble the exact-length ASCII shape (three variants — the C's
      // own three snprintf formats): y in [0,9999] is 24 bytes
      // ("YYYY-MM-DDTHH:mm:ss.sssZ"); y<0 or y>9999 is 27 bytes
      // ("+YYYYYY-MM-DDTHH:mm:ss.sssZ", sign + 6-digit year). No trim
      // needed — the length is exact by construction (unlike numfmt.ts's
      // variable-width assembly).
      c.localGet(Y);
      c.i32Const(0);
      c.i32GeS();
      c.localGet(Y);
      c.i32Const(9999);
      c.i32LeS();
      c.i32And();
      c.localSet(PLAIN);
      c.i32Const(0);
      c.localSet(IDX);
      c.localGet(PLAIN);
      c.ifVoid();
      {
        c.i32Const(24);
        c.arrayNewDefault(strType);
        c.localSet(O);
        this.writeFixedDigits(c, strType, O, IDX, Y, 4);
      }
      c.else_();
      {
        c.i32Const(27);
        c.arrayNewDefault(strType);
        c.localSet(O);
        c.localGet(Y);
        c.i32Const(0);
        c.i32LtS();
        c.ifVoid();
        this.writeChar(c, strType, O, IDX, 0x2d); // '-'
        c.i32Const(0);
        c.localGet(Y);
        c.i32Sub();
        c.localSet(ABSY);
        c.else_();
        this.writeChar(c, strType, O, IDX, 0x2b); // '+'
        c.localGet(Y);
        c.localSet(ABSY);
        c.end();
        this.writeFixedDigits(c, strType, O, IDX, ABSY, 6);
      }
      c.end();
      // the tail is identical in both branches, at whatever IDX is now.
      this.writeChar(c, strType, O, IDX, 0x2d); // '-'
      this.writeFixedDigits(c, strType, O, IDX, M, 2);
      this.writeChar(c, strType, O, IDX, 0x2d); // '-'
      this.writeFixedDigits(c, strType, O, IDX, D, 2);
      this.writeChar(c, strType, O, IDX, 0x54); // 'T'
      this.writeFixedDigits(c, strType, O, IDX, HH, 2);
      this.writeChar(c, strType, O, IDX, 0x3a); // ':'
      this.writeFixedDigits(c, strType, O, IDX, MI, 2);
      this.writeChar(c, strType, O, IDX, 0x3a); // ':'
      this.writeFixedDigits(c, strType, O, IDX, SS, 2);
      this.writeChar(c, strType, O, IDX, 0x2e); // '.'
      this.writeFixedDigits(c, strType, O, IDX, SSS, 3);
      this.writeChar(c, strType, O, IDX, 0x5a); // 'Z'
      c.localGet(O);
      this.mb.setBody(idx, locals, c.bytes());
    });
  }

  /** Writes `width` zero-padded ASCII decimal digits of the i32 local
   * `valueLocal` into `out[idxLocal..idxLocal+width)`, advancing
   * `idxLocal` by `width`. `valueLocal` must be non-negative and fit in
   * `width` decimal digits (every caller here already guarantees that —
   * a 4-digit year in [0,9999], a 6-digit |year|, or a 2/3-digit
   * time-of-day field). Unrolled (width is always a small compile-time
   * constant): each digit is `(value / 10^i) % 10`, independent of the
   * others, so no running remainder needs to be threaded through. */
  private writeFixedDigits(
    c: Code,
    strType: number,
    outLocal: number,
    idxLocal: number,
    valueLocal: number,
    width: number,
  ): void {
    for (let i = width - 1; i >= 0; i--) {
      const divisor = 10 ** i;
      c.localGet(outLocal);
      c.localGet(idxLocal);
      c.localGet(valueLocal);
      if (divisor !== 1) {
        c.i32Const(divisor);
        c.i32DivS();
      }
      c.i32Const(10);
      c.i32RemS();
      c.i32Const(0x30); // '0'
      c.i32Add();
      c.arraySet(strType);
      c.localGet(idxLocal);
      c.i32Const(1);
      c.i32Add();
      c.localSet(idxLocal);
    }
  }

  /** Writes one literal ASCII byte at `out[idxLocal]`, advancing
   * `idxLocal` by 1. */
  private writeChar(c: Code, strType: number, outLocal: number, idxLocal: number, ch: number): void {
    c.localGet(outLocal);
    c.localGet(idxLocal);
    c.i32Const(ch);
    c.arraySet(strType);
    c.localGet(idxLocal);
    c.i32Const(1);
    c.i32Add();
    c.localSet(idxLocal);
  }

  /** Pushes 1 (i32) if the f64 already on top of the stack is NaN or
   * ±Infinity, else 0 — leaves the operand consumed. One comparison
   * catches both: `fabs(x) < Infinity` is true for every finite x and
   * false for NaN (comparisons with NaN are always false) and for
   * ±Infinity (not STRICTLY less than itself); negate it. */
  private pushIsNonFinite(c: Code): void {
    c.f64Abs();
    c.f64Const(Infinity);
    c.f64Lt();
    c.i32Eqz();
  }

  /* ── date.utc (scr_date_utc, ~3424) ───────────────────────────────────
   * Pure, never throws. `d` (the day-of-month argument) is UNBOUNDED —
   * the C's own call always passes day=1 into scr_days_from_civil and
   * adds `(d - 1.0)` SEPARATELY, in DOUBLE domain, exactly so an
   * arbitrarily large `d` (a real, unbounded f64 the frontend never
   * narrows) cannot overflow the i32-domain civil-calendar arithmetic —
   * mirrored here verbatim, not "helpfully" passed straight into
   * `daysFromCivilHelper`'s own i32 `d` parameter (which is safe for
   * D-3's grammar-bounded day fields, 1-2 parsed digits, but would NOT
   * be safe for this key's unbounded one). */
  utcHelper(): number {
    return this.cached(
      "utc",
      [F64, F64, F64, F64, F64, F64, F64],
      [F64],
      (idx) => {
        const c = new Code();
        const Y = 0, MO = 1, D = 2, H = 3, MI = 4, S = 5, MS = 6; // f64 params
        const YM = 7, MNF = 8, DAYSF = 9, T = 10; // f64 locals
        const MN = 11, YM32 = 12, DAYSBASE = 13; // i32 locals
        const locals: ValType[] = [F64, F64, F64, F64, I32, I32, I32];

        // any non-finite -> NaN.
        const nf = (local: number): void => {
          c.localGet(local);
          this.pushIsNonFinite(c);
        };
        nf(Y);
        nf(MO);
        nf(D);
        nf(H);
        nf(MI);
        nf(S);
        nf(MS);
        c.i32Or();
        c.i32Or();
        c.i32Or();
        c.i32Or();
        c.i32Or();
        c.i32Or();
        c.ifVoid();
        c.f64Const(NaN);
        c.return_();
        c.end();

        // trunc each.
        const trunc = (local: number): void => {
          c.localGet(local);
          c.f64Trunc();
          c.localSet(local);
        };
        trunc(Y);
        trunc(MO);
        trunc(D);
        trunc(H);
        trunc(MI);
        trunc(S);
        trunc(MS);

        // y in [0,99] -> +1900.
        c.localGet(Y);
        c.f64Const(0);
        c.f64Ge();
        c.localGet(Y);
        c.f64Const(99);
        c.f64Le();
        c.i32And();
        c.ifVoid();
        c.localGet(Y);
        c.f64Const(1900);
        c.f64Add();
        c.localSet(Y);
        c.end();

        // ym = y + floor(mo/12); mn = mo - floor(mo/12)*12 (0..11).
        c.localGet(MO);
        c.f64Const(12);
        c.f64Div();
        c.f64Floor();
        c.localSet(MNF); // MNF temporarily holds floor(mo/12)
        c.localGet(Y);
        c.localGet(MNF);
        c.f64Add();
        c.localSet(YM);
        c.localGet(MO);
        c.localGet(MNF);
        c.f64Const(12);
        c.f64Mul();
        c.f64Sub();
        c.localSet(MNF); // MNF now holds mn as f64, 0..11
        c.localGet(MNF);
        c.i32TruncF64S();
        c.localSet(MN);

        // the ±1e6 MakeDay safety bound (arithmetic-domain safety for
        // daysFromCivilHelper's own i32 math at extreme ym — CONFIRMED
        // unobservable past TimeClip, CP1 §(e) Class 2 / §(h) D-2: kept
        // for safety only, never for a distinguishable Node-matching
        // value).
        c.localGet(YM);
        c.f64Abs();
        c.f64Const(1000000);
        c.f64Gt();
        c.ifVoid();
        c.f64Const(NaN);
        c.return_();
        c.end();
        c.localGet(YM);
        c.i32TruncF64S();
        c.localSet(YM32);

        // days_from_civil(ym, mn+1, DAY=1) — the C's own fixed-day-1
        // call — then add (d - 1.0) in F64 domain (see this helper's
        // own header comment: `d` is unbounded, `daysFromCivilHelper`'s
        // i32 domain is not).
        c.localGet(YM32);
        c.localGet(MN);
        c.i32Const(1);
        c.i32Add();
        c.i32Const(1);
        c.call(this.daysFromCivilHelper());
        c.localSet(DAYSBASE);
        c.localGet(DAYSBASE);
        c.f64ConvertI32S();
        c.localGet(D);
        c.f64Const(1);
        c.f64Sub();
        c.f64Add();
        c.localSet(DAYSF);

        // t = days*86400000 + h*3600000 + mi*60000 + s*1000 + ms.
        c.localGet(DAYSF);
        c.f64Const(86400000);
        c.f64Mul();
        c.localGet(H);
        c.f64Const(3600000);
        c.f64Mul();
        c.f64Add();
        c.localGet(MI);
        c.f64Const(60000);
        c.f64Mul();
        c.f64Add();
        c.localGet(S);
        c.f64Const(1000);
        c.f64Mul();
        c.f64Add();
        c.localGet(MS);
        c.f64Add();
        c.localSet(T);

        // TimeClip.
        c.localGet(T);
        c.f64Abs();
        c.f64Const(8640000000000000);
        c.f64Gt();
        c.ifVoid();
        c.f64Const(NaN);
        c.return_();
        c.end();

        // normalize -0 -> +0 (TimeClip's own rule).
        c.localGet(T);
        c.f64Const(0);
        c.f64Eq();
        c.ifResult(F64);
        c.f64Const(0);
        c.else_();
        c.localGet(T);
        c.end();
        this.mb.setBody(idx, locals, c.bytes());
      },
    );
  }

  /* ── date.parseGetTime (scr_date_parse_get_time + scr_date_ms_of,
   * ~3324) — see this file's own header comment for why the control
   * flow is NOT a port of the C's. ── */

  /** `%w.date.readDigits(s, pos, n) -> (newPos, value)` — reads EXACTLY
   * `n` ASCII decimal digits starting at `pos`; on success, `newPos =
   * pos+n` and `value` is the parsed non-negative integer. On failure
   * (fewer than `n` characters remain, or a non-digit appears within the
   * window), `newPos = pos` (UNCHANGED — the caller must not use it) and
   * `value = -1` (a safe sentinel: every real parsed value is >= 0).
   * scr_date_digits's own contract, translated from `bool` + out-params
   * to wasm's multi-value return. */
  private readDigitsHelper(): number {
    return this.cached("readDigits", [this.strRef(), I32, I32], [I32, I32], (idx) => {
      const strType = this.strType();
      const c = new Code();
      const S = 0, POS = 1, N = 2; // params
      const LEN = 3, V = 4, I = 5, CH = 6;
      const locals: ValType[] = [I32, I32, I32, I32];

      c.localGet(S);
      c.arrayLen();
      c.localSet(LEN);
      // not enough characters left -> fail.
      c.localGet(POS);
      c.localGet(N);
      c.i32Add();
      c.localGet(LEN);
      c.i32GtS();
      c.ifVoid();
      c.localGet(POS);
      c.i32Const(-1);
      c.return_();
      c.end();

      c.i32Const(0);
      c.localSet(V);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(S);
      c.localGet(POS);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(strType);
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x30);
      c.i32LtS();
      c.localGet(CH);
      c.i32Const(0x39);
      c.i32GtS();
      c.i32Or();
      c.ifVoid();
      c.localGet(POS);
      c.i32Const(-1);
      c.return_();
      c.end();
      c.localGet(V);
      c.i32Const(10);
      c.i32Mul();
      c.localGet(CH);
      c.i32Const(0x30);
      c.i32Sub();
      c.i32Add();
      c.localSet(V);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(POS);
      c.localGet(N);
      c.i32Add();
      c.localGet(V);
      this.mb.setBody(idx, locals, c.bytes());
    });
  }

  /** Pushes the character at `s[pos]` (both already-pushed-value locals).
   * The CALLER must have already checked `pos < len` — this is a raw
   * `array.get_u`, which traps on an out-of-bounds index. */
  private pushCharAt(c: Code, strType: number, sLocal: number, posLocal: number): void {
    c.localGet(sLocal);
    c.localGet(posLocal);
    c.arrayGetU(strType);
  }

  private static readonly MONTHS = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];

  /** `%w.date.tryGrammar1(s) -> (ok, value)` — the ASN1_TIME_print shape
   * (`MMM [D]D HH:MM:SS YYYY GMT`), a WHOLE-STRING structural match
   * before any bound check (this file's own header, Finding 1): every
   * `return_()` before "STRUCTURAL MATCH CONFIRMED" below is a
   * NON-match (ok=0), never a disposition. Six corrections beyond
   * `scr_date_parse_get_time`'s own text (this file's header):
   *   - ss>59 is UNCONDITIONALLY ok=0 (Node reinterprets it as a
   *     two-digit year at every tested year — never NODE-NaN).
   *   - day==0 or day>31, ONLY when the parsed year is in [1,31], is
   *     ok=0 (the year field reread as the day by V8's legacy
   *     fallback — CP1 ACK DELTA-2's own wording fix: stated as the
   *     CONJUNCTION with the day violation, not the year range alone).
   *   - on a fully-matched string, the parsed year gets V8's OWN
   *     two-digit-year remap (0-49 -> 2000-2049, 50-99 -> 1950-1999),
   *     which is NOT `date.utc`'s ECMA MakeFullYear rule (always
   *     1900+y) — CP1 ACK DELTA-1, BLOCKING, board #134. Modelled as
   *     its own two comparisons and an add, never by calling into
   *     `date.utc`'s own year-normalisation. */
  private tryGrammar1Helper(): number {
    return this.cached("tryGrammar1", [this.strRef()], [I32, F64], (idx) => {
      const strType = this.strType();
      const c = new Code();
      const S = 0; // param
      const LEN = 1,
        POS = 2,
        PACKED = 3,
        MO = 4,
        D = 5,
        HH = 6,
        MI = 7,
        SS = 8,
        YEAR = 9,
        NEWPOS = 10,
        VAL = 11,
        EFFYEAR = 12,
        DAYS = 13,
        CH = 14;
      const T = 15; // f64
      const locals: ValType[] = [
        I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, F64,
      ];

      const fail = (): void => {
        c.i32Const(0);
        c.f64Const(0);
        c.return_();
      };
      const lower = (): void => {
        // ( already-pushed char ) | 0x20 — the standard ASCII
        // lowercase-if-uppercase idiom; safe here because the only
        // values this result is ever compared against are the 12
        // all-lowercase month packings (this file's header comment on
        // `matchMonthName`'s design).
        c.i32Const(0x20);
        c.i32Or();
      };

      c.localGet(S);
      c.arrayLen();
      c.localSet(LEN);
      c.localGet(LEN);
      c.i32Const(3);
      c.i32LtS();
      c.ifVoid();
      fail();
      c.end();

      // packed = lower(s[0])<<16 | lower(s[1])<<8 | lower(s[2])
      c.i32Const(0);
      c.localSet(POS);
      this.pushCharAt(c, strType, S, POS);
      lower();
      c.i32Const(16);
      c.i32Shl();
      c.i32Const(1);
      c.localSet(POS);
      this.pushCharAt(c, strType, S, POS);
      lower();
      c.i32Const(8);
      c.i32Shl();
      c.i32Or();
      c.i32Const(2);
      c.localSet(POS);
      this.pushCharAt(c, strType, S, POS);
      lower();
      c.i32Or();
      c.localSet(PACKED);

      c.i32Const(0);
      c.localSet(MO);
      DateBuilder.MONTHS.forEach((name, i) => {
        const packedConst =
          (name.charCodeAt(0) << 16) | (name.charCodeAt(1) << 8) | name.charCodeAt(2);
        c.localGet(PACKED);
        c.i32Const(packedConst);
        c.i32Eq();
        c.ifVoid();
        c.i32Const(i + 1);
        c.localSet(MO);
        c.end();
      });
      c.localGet(MO);
      c.i32Eqz();
      c.ifVoid();
      fail();
      c.end();

      c.i32Const(3);
      c.localSet(POS);
      // one or two spaces (the "%2d" padding shape). pushCharAtGuarded
      // pushes ITS OWN "pos<len && s[pos]==ch" combined result — no
      // extra AND needed at the call site.
      this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x20);
      c.ifVoid();
      c.localGet(POS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(POS);
      c.end();
      this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x20);
      c.ifVoid();
      c.localGet(POS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(POS);
      c.end();

      // day: one digit, then an optional second digit.
      c.localGet(S);
      c.localGet(POS);
      c.i32Const(1);
      c.call(this.readDigitsHelper());
      c.localSet(VAL);
      c.localSet(NEWPOS);
      c.localGet(VAL);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      fail();
      c.end();
      c.localGet(NEWPOS);
      c.localSet(POS);
      c.localGet(VAL);
      c.localSet(D);
      c.localGet(POS);
      c.localGet(LEN);
      c.i32LtS();
      c.ifResult(I32);
      this.pushCharAt(c, strType, S, POS);
      c.i32Const(0x30);
      c.i32GeS();
      c.localGet(S);
      c.localGet(POS);
      c.arrayGetU(strType);
      c.i32Const(0x39);
      c.i32LeS();
      c.i32And();
      c.else_();
      c.i32Const(0);
      c.end();
      c.ifVoid();
      c.localGet(S);
      c.localGet(POS);
      c.i32Const(1);
      c.call(this.readDigitsHelper());
      c.localSet(VAL);
      c.localSet(NEWPOS);
      c.localGet(NEWPOS);
      c.localSet(POS);
      c.localGet(D);
      c.i32Const(10);
      c.i32Mul();
      c.localGet(VAL);
      c.i32Add();
      c.localSet(D);
      c.end();

      // single space, then HH:MM:SS.
      this.expectChar(c, strType, S, LEN, POS, 0x20, fail);
      this.readTwoDigits(c, strType, S, POS, HH, fail);
      this.expectChar(c, strType, S, LEN, POS, 0x3a, fail);
      this.readTwoDigits(c, strType, S, POS, MI, fail);
      this.expectChar(c, strType, S, LEN, POS, 0x3a, fail);
      this.readTwoDigits(c, strType, S, POS, SS, fail);
      this.expectChar(c, strType, S, LEN, POS, 0x20, fail);

      // 4-digit year, then exactly " GMT" to the end of the string.
      c.localGet(S);
      c.localGet(POS);
      c.i32Const(4);
      c.call(this.readDigitsHelper());
      c.localSet(VAL);
      c.localSet(NEWPOS);
      c.localGet(VAL);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      fail();
      c.end();
      c.localGet(NEWPOS);
      c.localSet(POS);
      c.localGet(VAL);
      c.localSet(YEAR);

      c.localGet(LEN);
      c.localGet(POS);
      c.i32Sub();
      c.i32Const(4);
      c.i32Ne();
      c.ifVoid();
      fail();
      c.end();
      const gmt = [0x20, 0x47, 0x4d, 0x54]; // ' GMT'
      gmt.forEach((ch, i) => {
        c.localGet(S);
        c.localGet(POS);
        c.i32Const(i);
        c.i32Add();
        c.arrayGetU(strType);
        c.i32Const(ch);
        c.i32Ne();
        c.ifVoid();
        fail();
        c.end();
      });

      // STRUCTURAL MATCH CONFIRMED.
      c.localGet(SS);
      c.i32Const(59);
      c.i32GtS();
      c.ifVoid();
      fail();
      c.end();

      c.localGet(D);
      c.i32Const(1);
      c.i32LtS();
      c.localGet(D);
      c.i32Const(31);
      c.i32GtS();
      c.i32Or();
      c.ifVoid();
      {
        c.localGet(YEAR);
        c.i32Const(1);
        c.i32GeS();
        c.localGet(YEAR);
        c.i32Const(31);
        c.i32LeS();
        c.i32And();
        c.ifVoid();
        fail();
        c.end();
        c.i32Const(1);
        c.f64Const(NaN);
        c.return_();
      }
      c.end();

      c.localGet(HH);
      c.i32Const(24);
      c.i32GtS();
      c.localGet(MI);
      c.i32Const(59);
      c.i32GtS();
      c.i32Or();
      c.localGet(HH);
      c.i32Const(24);
      c.i32Eq();
      c.localGet(MI);
      c.i32Const(0);
      c.i32Ne();
      c.localGet(SS);
      c.i32Const(0);
      c.i32Ne();
      c.i32Or();
      c.i32And();
      c.i32Or();
      c.ifVoid();
      c.i32Const(1);
      c.f64Const(NaN);
      c.return_();
      c.end();

      // DELTA-1: grammar 1's OWN two-digit-year remap.
      c.localGet(YEAR);
      c.i32Const(99);
      c.i32LeS();
      c.ifResult(I32);
      c.localGet(YEAR);
      c.i32Const(49);
      c.i32LeS();
      c.ifResult(I32);
      c.i32Const(2000);
      c.localGet(YEAR);
      c.i32Add();
      c.else_();
      c.i32Const(1900);
      c.localGet(YEAR);
      c.i32Add();
      c.end();
      c.else_();
      c.localGet(YEAR);
      c.end();
      c.localSet(EFFYEAR);

      c.localGet(EFFYEAR);
      c.localGet(MO);
      c.localGet(D);
      c.call(this.daysFromCivilHelper());
      c.localSet(DAYS);
      c.localGet(DAYS);
      c.f64ConvertI32S();
      c.f64Const(86400000);
      c.f64Mul();
      c.localGet(HH);
      c.f64ConvertI32S();
      c.f64Const(3600000);
      c.f64Mul();
      c.f64Add();
      c.localGet(MI);
      c.f64ConvertI32S();
      c.f64Const(60000);
      c.f64Mul();
      c.f64Add();
      c.localGet(SS);
      c.f64ConvertI32S();
      c.f64Const(1000);
      c.f64Mul();
      c.f64Add();
      c.localSet(T);
      // TimeClip never fires here (this file's own header: the max
      // representable year via a 4-digit field, even after the remap,
      // is far inside TimeClip's +-275760-year reach) — no check.
      c.i32Const(1);
      c.localGet(T);
      this.mb.setBody(idx, locals, c.bytes());
    });
  }

  /** Pushes 1 (i32) if `pos < len` AND `s[pos] == ch`, else 0 — leaves
   * exactly one i32 on the stack, consuming nothing but reading `s[pos]`
   * only when the bounds check passes (guarded, never traps). */
  /** Pushes ONE i32: 1 if `pos < len && s[pos] == ch`, else 0.
   * Self-contained — pushes its own bounds check, so the char read only
   * ever happens when it is safe. */
  private pushCharAtGuarded(
    c: Code,
    strType: number,
    sLocal: number,
    posLocal: number,
    lenLocal: number,
    ch: number,
  ): void {
    c.localGet(posLocal);
    c.localGet(lenLocal);
    c.i32LtS();
    c.ifResult(I32);
    this.pushCharAt(c, strType, sLocal, posLocal);
    c.i32Const(ch);
    c.i32Eq();
    c.else_();
    c.i32Const(0);
    c.end();
  }

  /** `if (pos>=len || s[pos]!=ch) { onFail(); } pos++;` — the shared
   * shape of every single-literal-separator check in grammar 1/2. */
  private expectChar(
    c: Code,
    strType: number,
    sLocal: number,
    lenLocal: number,
    posLocal: number,
    ch: number,
    onFail: () => void,
  ): void {
    c.localGet(posLocal);
    c.localGet(lenLocal);
    c.i32GeS();
    c.ifResult(I32);
    c.i32Const(1);
    c.else_();
    this.pushCharAt(c, strType, sLocal, posLocal);
    c.i32Const(ch);
    c.i32Ne();
    c.end();
    c.ifVoid();
    onFail();
    c.end();
    c.localGet(posLocal);
    c.i32Const(1);
    c.i32Add();
    c.localSet(posLocal);
  }

  /** `(pos, value) = readDigits(s, pos, 2); if (value==-1) onFail();` —
   * the shared two-digit-field shape (hh/mi/ss/oh/om). */
  private readTwoDigits(
    c: Code,
    strType: number,
    sLocal: number,
    posLocal: number,
    outLocal: number,
    onFail: () => void,
  ): void {
    void strType;
    c.localGet(sLocal);
    c.localGet(posLocal);
    c.i32Const(2);
    c.call(this.readDigitsHelper());
    // stack: (newPos, value) — value on top.
    const NEWPOS_SCRATCH = outLocal; // reuse outLocal as scratch briefly
    c.localSet(NEWPOS_SCRATCH);
    c.localGet(NEWPOS_SCRATCH);
    c.i32Const(-1);
    c.i32Eq();
    c.ifVoid();
    onFail();
    c.end();
    // outLocal currently holds VALUE (we just checked); now consume
    // newPos (still on the stack) into posLocal.
    c.localSet(posLocal);
  }

  /** `%w.date.g2Finish(yy, bare, mo, d, hh, mi, ss, ms, off) -> (ok,
   * value)` — grammar 2's shared bound-check-and-assemble tail, called
   * from BOTH the date-only early return (hh=mi=ss=ms=0, off=0.0) and
   * the full date-time path. `bare` is 1 for a plain 4-digit year, 0 for
   * a signed 6-digit expanded year — the D-delta guard below applies
   * ONLY to bare years (this file's header; measured, not assumed: the
   * reinterpretation is V8's legacy fallback, which the expanded-year
   * grammar never reaches). `off` is already signed and in
   * milliseconds; D-beta means TimeClip is checked exactly ONCE, here,
   * on `days*... - off` — never inside a shared day/time helper. */
  private g2FinishHelper(): number {
    return this.cached(
      "g2Finish",
      [I32, I32, I32, I32, I32, I32, I32, I32, F64],
      [I32, F64],
      (idx) => {
        const c = new Code();
        const YY = 0, BARE = 1, MO = 2, D = 3, HH = 4, MI = 5, SS = 6, MS = 7; // i32 params
        const OFF = 8; // f64 param
        const DAYS = 9; // i32
        const DAYSF = 10, T = 11; // f64
        const locals: ValType[] = [I32, F64, F64];

        const fail = (): void => {
          c.i32Const(0);
          c.f64Const(0);
          c.return_();
        };
        const nan = (): void => {
          c.i32Const(1);
          c.f64Const(NaN);
          c.return_();
        };
        // D-delta guard: bare year in [1,12] with an invalid mo/d ->
        // fence (V8's legacy parser rereads the year as the month);
        // every other year, or an expanded year, -> NODE-NaN.
        const deltaGuardOrNaN = (): void => {
          c.localGet(BARE);
          c.localGet(YY);
          c.i32Const(1);
          c.i32GeS();
          c.i32And();
          c.localGet(YY);
          c.i32Const(12);
          c.i32LeS();
          c.i32And();
          c.ifVoid();
          fail();
          c.end();
          nan();
        };

        c.localGet(MO);
        c.i32Const(1);
        c.i32LtS();
        c.localGet(MO);
        c.i32Const(12);
        c.i32GtS();
        c.i32Or();
        c.ifVoid();
        deltaGuardOrNaN();
        c.end();

        c.localGet(D);
        c.i32Const(1);
        c.i32LtS();
        c.localGet(D);
        c.i32Const(31);
        c.i32GtS();
        c.i32Or();
        c.ifVoid();
        deltaGuardOrNaN();
        c.end();

        // hh/mi/ss/T24-remainder bound (exhaustive over years 0000-9999
        // both zones — CP1 ACK's own E-2/CP1-addendum: this arm HOLDS
        // universally, unlike the mo/d arm just above).
        c.localGet(HH);
        c.i32Const(24);
        c.i32GtS();
        c.localGet(MI);
        c.i32Const(59);
        c.i32GtS();
        c.i32Or();
        c.localGet(SS);
        c.i32Const(59);
        c.i32GtS();
        c.i32Or();
        c.localGet(HH);
        c.i32Const(24);
        c.i32Eq();
        c.localGet(MI);
        c.i32Const(0);
        c.i32Ne();
        c.localGet(SS);
        c.i32Const(0);
        c.i32Ne();
        c.i32Or();
        c.localGet(MS);
        c.i32Const(0);
        c.i32Ne();
        c.i32Or();
        c.i32And();
        c.i32Or();
        c.ifVoid();
        nan();
        c.end();

        c.localGet(YY);
        c.localGet(MO);
        c.localGet(D);
        c.call(this.daysFromCivilHelper());
        c.localSet(DAYS);
        c.localGet(DAYS);
        c.f64ConvertI32S();
        c.f64Const(86400000);
        c.f64Mul();
        c.localGet(HH);
        c.f64ConvertI32S();
        c.f64Const(3600000);
        c.f64Mul();
        c.f64Add();
        c.localGet(MI);
        c.f64ConvertI32S();
        c.f64Const(60000);
        c.f64Mul();
        c.f64Add();
        c.localGet(SS);
        c.f64ConvertI32S();
        c.f64Const(1000);
        c.f64Mul();
        c.f64Add();
        c.localGet(MS);
        c.f64ConvertI32S();
        c.f64Add();
        c.localSet(DAYSF); // DAYSF now holds the PRE-offset total ms (name kept for local budget)

        // D-beta: subtract the offset, THEN TimeClip — once, here.
        c.localGet(DAYSF);
        c.localGet(OFF);
        c.f64Sub();
        c.localSet(T);
        c.localGet(T);
        c.f64Abs();
        c.f64Const(8640000000000000);
        c.f64Gt();
        c.ifVoid();
        nan();
        c.end();

        c.i32Const(1);
        c.localGet(T);
        this.mb.setBody(idx, locals, c.bytes());
      },
    );
  }

  /** `%w.date.tryGrammar2(s) -> (ok, value)` — the strict ECMA Date Time
   * String Format. D-alpha (offset bound), D-gamma (the "-000000"
   * structural non-match) are handled here; D-beta and D-delta live in
   * `g2FinishHelper` (shared with the date-only early return). */
  private tryGrammar2Helper(): number {
    return this.cached("tryGrammar2", [this.strRef()], [I32, F64], (idx) => {
      const strType = this.strType();
      const c = new Code();
      const S = 0;
      const LEN = 1,
        POS = 2,
        BARE = 3,
        SIGN = 4,
        YY = 5,
        MO = 6,
        D = 7,
        HH = 8,
        MI = 9,
        SS = 10,
        MS = 11,
        NEWPOS = 12,
        VAL = 13,
        OFFSIGN = 14,
        OH = 15,
        OM = 16;
      const OFF = 17; // f64
      const locals: ValType[] = [
        I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, F64,
      ];

      const fail = (): void => {
        c.i32Const(0);
        c.f64Const(0);
        c.return_();
      };

      c.localGet(S);
      c.arrayLen();
      c.localSet(LEN);
      c.i32Const(0);
      c.localSet(POS);
      c.i32Const(1);
      c.localSet(MO);
      c.i32Const(1);
      c.localSet(D);

      // sign + 6-digit expanded year, OR a bare 4-digit year.
      this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x2b); // '+'
      this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x2d); // '-'
      c.i32Or();
      c.ifVoid();
      {
        this.pushCharAt(c, strType, S, POS);
        c.i32Const(0x2b);
        c.i32Eq();
        c.ifResult(I32);
        c.i32Const(1);
        c.else_();
        c.i32Const(-1);
        c.end();
        c.localSet(SIGN);
        c.i32Const(0);
        c.localSet(BARE);
        c.localGet(POS);
        c.i32Const(1);
        c.i32Add();
        c.localSet(POS);
        c.localGet(S);
        c.localGet(POS);
        c.i32Const(6);
        c.call(this.readDigitsHelper());
        c.localSet(VAL);
        c.localSet(NEWPOS);
        c.localGet(VAL);
        c.i32Const(-1);
        c.i32Eq();
        c.ifVoid();
        fail();
        c.end();
        c.localGet(NEWPOS);
        c.localSet(POS);
        // D-gamma: "-000000" is a structural non-match.
        c.localGet(SIGN);
        c.i32Const(-1);
        c.i32Eq();
        c.localGet(VAL);
        c.i32Eqz();
        c.i32And();
        c.ifVoid();
        fail();
        c.end();
        c.localGet(SIGN);
        c.localGet(VAL);
        c.i32Mul();
        c.localSet(YY);
      }
      c.else_();
      {
        c.i32Const(1);
        c.localSet(BARE);
        c.localGet(S);
        c.localGet(POS);
        c.i32Const(4);
        c.call(this.readDigitsHelper());
        c.localSet(VAL);
        c.localSet(NEWPOS);
        c.localGet(VAL);
        c.i32Const(-1);
        c.i32Eq();
        c.ifVoid();
        fail();
        c.end();
        c.localGet(NEWPOS);
        c.localSet(POS);
        c.localGet(VAL);
        c.localSet(YY);
      }
      c.end();

      // optional -MM[-DD].
      this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x2d);
      c.ifVoid();
      {
        c.localGet(POS);
        c.i32Const(1);
        c.i32Add();
        c.localSet(POS);
        c.localGet(S);
        c.localGet(POS);
        c.i32Const(2);
        c.call(this.readDigitsHelper());
        c.localSet(VAL);
        c.localSet(NEWPOS);
        c.localGet(VAL);
        c.i32Const(-1);
        c.i32Eq();
        c.ifVoid();
        fail();
        c.end();
        c.localGet(NEWPOS);
        c.localSet(POS);
        c.localGet(VAL);
        c.localSet(MO);
        this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x2d);
        c.ifVoid();
        {
          c.localGet(POS);
          c.i32Const(1);
          c.i32Add();
          c.localSet(POS);
          c.localGet(S);
          c.localGet(POS);
          c.i32Const(2);
          c.call(this.readDigitsHelper());
          c.localSet(VAL);
          c.localSet(NEWPOS);
          c.localGet(VAL);
          c.i32Const(-1);
          c.i32Eq();
          c.ifVoid();
          fail();
          c.end();
          c.localGet(NEWPOS);
          c.localSet(POS);
          c.localGet(VAL);
          c.localSet(D);
        }
        c.end();
      }
      c.end();

      // date-only: UTC, defaults completed.
      c.localGet(POS);
      c.localGet(LEN);
      c.i32Eq();
      c.ifVoid();
      c.localGet(YY);
      c.localGet(BARE);
      c.localGet(MO);
      c.localGet(D);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.f64Const(0);
      c.call(this.g2FinishHelper());
      c.return_();
      c.end();

      this.expectChar(c, strType, S, LEN, POS, 0x54, fail); // 'T'
      this.readTwoDigits(c, strType, S, POS, HH, fail);
      this.expectChar(c, strType, S, LEN, POS, 0x3a, fail); // ':'
      this.readTwoDigits(c, strType, S, POS, MI, fail);
      c.i32Const(0);
      c.localSet(SS);
      c.i32Const(0);
      c.localSet(MS);
      this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x3a);
      c.ifVoid();
      {
        c.localGet(POS);
        c.i32Const(1);
        c.i32Add();
        c.localSet(POS);
        this.readTwoDigits(c, strType, S, POS, SS, fail);
        this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x2e);
        c.ifVoid();
        {
          c.localGet(POS);
          c.i32Const(1);
          c.i32Add();
          c.localSet(POS);
          c.localGet(S);
          c.localGet(POS);
          c.i32Const(3);
          c.call(this.readDigitsHelper());
          c.localSet(VAL);
          c.localSet(NEWPOS);
          c.localGet(VAL);
          c.i32Const(-1);
          c.i32Eq();
          c.ifVoid();
          fail();
          c.end();
          c.localGet(NEWPOS);
          c.localSet(POS);
          c.localGet(VAL);
          c.localSet(MS);
        }
        c.end();
      }
      c.end();

      // offset-less date-time: FENCE (D6-ii), not NaN — ok=0.
      c.localGet(POS);
      c.localGet(LEN);
      c.i32Eq();
      c.ifVoid();
      fail();
      c.end();

      c.f64Const(0);
      c.localSet(OFF);
      this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x5a); // 'Z'
      c.ifVoid();
      c.localGet(POS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(POS);
      c.else_();
      {
        this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x2b);
        this.pushCharAtGuarded(c, strType, S, POS, LEN, 0x2d);
        c.i32Or();
        c.ifVoid();
        {
          this.pushCharAt(c, strType, S, POS);
          c.i32Const(0x2b);
          c.i32Eq();
          c.ifResult(I32);
          c.i32Const(1);
          c.else_();
          c.i32Const(-1);
          c.end();
          c.localSet(OFFSIGN);
          c.localGet(POS);
          c.i32Const(1);
          c.i32Add();
          c.localSet(POS);
          c.localGet(S);
          c.localGet(POS);
          c.i32Const(2);
          c.call(this.readDigitsHelper());
          c.localSet(VAL);
          c.localSet(NEWPOS);
          c.localGet(VAL);
          c.i32Const(-1);
          c.i32Eq();
          c.ifVoid();
          fail();
          c.end();
          c.localGet(NEWPOS);
          c.localSet(POS);
          c.localGet(VAL);
          c.localSet(OH);
          this.expectChar(c, strType, S, LEN, POS, 0x3a, fail);
          c.localGet(S);
          c.localGet(POS);
          c.i32Const(2);
          c.call(this.readDigitsHelper());
          c.localSet(VAL);
          c.localSet(NEWPOS);
          c.localGet(VAL);
          c.i32Const(-1);
          c.i32Eq();
          c.ifVoid();
          fail();
          c.end();
          c.localGet(NEWPOS);
          c.localSet(POS);
          c.localGet(VAL);
          c.localSet(OM);
          // D-alpha: bounded offset, a check absent from the C.
          c.localGet(OH);
          c.i32Const(23);
          c.i32GtS();
          c.localGet(OM);
          c.i32Const(59);
          c.i32GtS();
          c.i32Or();
          c.ifVoid();
          c.i32Const(1);
          c.f64Const(NaN);
          c.return_();
          c.end();
          c.localGet(OFFSIGN);
          c.f64ConvertI32S();
          c.localGet(OH);
          c.i32Const(60);
          c.i32Mul();
          c.localGet(OM);
          c.i32Add();
          c.f64ConvertI32S();
          c.f64Const(60000);
          c.f64Mul();
          c.f64Mul();
          c.localSet(OFF);
        }
        c.else_();
        fail();
        c.end();
      }
      c.end();

      // trailing garbage.
      c.localGet(POS);
      c.localGet(LEN);
      c.i32Ne();
      c.ifVoid();
      fail();
      c.end();

      c.localGet(YY);
      c.localGet(BARE);
      c.localGet(MO);
      c.localGet(D);
      c.localGet(HH);
      c.localGet(MI);
      c.localGet(SS);
      c.localGet(MS);
      c.localGet(OFF);
      c.call(this.g2FinishHelper());
      this.mb.setBody(idx, locals, c.bytes());
    });
  }

  /** `%w.date.parseGetTime(s) -> f64` — the public entry point
   * (validate.ts's `[STRING]->F64`). Tries grammar 1, then grammar 2;
   * neither producing a disposition sets `fencedFlag()` to 1 and returns
   * a sentinel the caller must NOT use as a value — the call site reads
   * the flag immediately after `call` and, if set, emits the S069 fence
   * (`emitPendingCheck()`'s own shape does not apply here: this key is
   * not in nodes.ts's may-throw set, by design — see this file's header
   * and CP1 §(i)). On EVERY other path `fencedFlag()` is explicitly
   * cleared to 0, so a stale 1 from an earlier call can never leak. */
  parseGetTimeHelper(): number {
    return this.cached("parseGetTime", [this.strRef()], [F64], (idx) => {
      const c = new Code();
      const S = 0;
      const OK = 1, V = 2; // f64 V, i32 OK — declared below in that order
      const locals: ValType[] = [I32, F64];

      c.localGet(S);
      c.call(this.tryGrammar1Helper());
      c.localSet(V);
      c.localSet(OK);
      c.localGet(OK);
      c.ifVoid();
      c.i32Const(0);
      c.globalSet(this.fencedFlag());
      c.localGet(V);
      c.return_();
      c.end();

      c.localGet(S);
      c.call(this.tryGrammar2Helper());
      c.localSet(V);
      c.localSet(OK);
      c.localGet(OK);
      c.ifVoid();
      c.i32Const(0);
      c.globalSet(this.fencedFlag());
      c.localGet(V);
      c.return_();
      c.end();

      c.i32Const(1);
      c.globalSet(this.fencedFlag());
      c.f64Const(NaN);
      this.mb.setBody(idx, locals, c.bytes());
    });
  }
}
