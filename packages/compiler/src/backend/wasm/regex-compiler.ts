/* Unit P1: the RUN-TIME RegExp compiler — `%w.rec.compile(pattern, flags)`,
 * the wasm-emitted twin of the build-time pipeline (regex-parser.ts ->
 * regex-assembler.ts, driven by regex-fold.ts). A `new RegExp(p, f)` whose
 * arguments do not fold at build time calls it; it returns the SAME
 * %w.re.Regex struct (source, canonical flags, bytecode, capture count,
 * group names) the build-time path embeds, built from the SAME bytecode —
 * wasm-regex-runtime-compiler.test.ts holds the two compilers (and
 * libregexp's lre_compile) byte-identical over the claim patterns, the
 * corpus literals, the regex test fixtures and seeded mutations.
 *
 * SHAPE. One fused parse-and-emit pass in libregexp's own style
 * (re_parse_disjunction / re_parse_alternative / re_parse_term with
 * dbuf_insert splicing), not an AST: every decision is the build-time
 * pipeline's, transcribed in the order that pipeline makes it (the
 * parser's acceptance rules, the assembler's emission, the disposition
 * layer's fences). Where the build-time pipeline and lre_compile differ,
 * this follows the build-time pipeline — the gate test lists those rows.
 *
 * OUTCOMES. Success returns the struct. Failure returns null and leaves an
 * id in a global the call site reads (errKind / errMessage / errCode):
 *   - a V8 SyntaxError reason (regex-compiler-tables.ts RX_SYNTAX_TEXT),
 *     reported only where the gate shows V8 agrees on reason and
 *     precedence. V8's own precedence is followed where it differs from
 *     libregexp's: a duplicate group name is checked when the group
 *     CLOSES (V8's CreateNamedCaptureAtIndex timing) with ES2025's
 *     alternatives rule, and an undefined \k<name> is reported after the
 *     whole pattern parsed;
 *   - a named fence (SEMANTICS.md S102) for a pattern or flags string
 *     outside this tier — the build-time refusal keys, word for word.
 *
 * CONTROL FLOW. Every structured construct goes through RA (below), which
 * tracks block depth so a `br` names its target by label, never by a hand-
 * counted depth. Functions with results end in an explicit `ret`. */
import { A, Fn, I32, type X } from "./asm.js";
import type { ModuleBuilder, ValType } from "./module.js";
import { classRangeDSW, GC_LL_BIT, GC_LU_BIT, gcRowMask } from "./regex-charclass.js";
import { canonPairs, fenceId, RX_PATTERN_SIZE_LIMIT, gcAliasBlob, i32Bytes, identFirstRanges, identNextRanges, RX, RX_FENCE_KEY, RX_SYNTAX_TEXT, fenceMessage, fenceCode } from "./regex-compiler-tables.js";
import {
  CAPTURE_COUNT_MAX,
  LRE_FLAG_DOTALL,
  LRE_FLAG_GLOBAL,
  LRE_FLAG_IGNORECASE,
  LRE_FLAG_MULTILINE,
  LRE_FLAG_NAMED_GROUPS,
  LRE_FLAG_STICKY,
  LRE_FLAG_UNICODE,
  REGISTER_COUNT_MAX,
  REOP,
  REOP_SIZE,
} from "./regex-opcodes.js";
import { GC_NAME_ROWS, GC_TABLE } from "./regex-unicode-tables.js";
import type { RegexBuilder } from "./regex-value.js";

/** A branch target: the block depth at which it was opened. */
class Lbl {
  constructor(readonly depth: number) {}
}

/** A with depth-tracked control flow and labelled loops. */
class RA extends A {
  private dep = 0;
  override if(cond: X, then: () => void, els?: () => void): void {
    cond();
    this.c.ifVoid();
    this.dep++;
    then();
    if (els !== undefined) {
      this.c.else_();
      els();
    }
    this.c.end();
    this.dep--;
  }
  override sel(t: ValType, cond: X, a: X, b: X): X {
    return () => {
      cond();
      this.c.ifResult(t);
      this.dep++;
      a();
      this.c.else_();
      b();
      this.c.end();
      this.dep--;
    };
  }
  override andThen(a: X, b: X): X {
    return this.sel(I32, a, b, this.i(0));
  }
  override orElse(a: X, b: X): X {
    return this.sel(I32, a, this.i(1), b);
  }
  /** for (;;) body — `cont` re-enters, `brk` leaves; falling off the end
   * of `body` re-enters too. */
  loop(body: (brk: Lbl, cont: Lbl) => void): void {
    this.c.block();
    this.dep++;
    const brk = new Lbl(this.dep);
    this.c.loop();
    this.dep++;
    const cont = new Lbl(this.dep);
    body(brk, cont);
    this.br(cont);
    this.c.end();
    this.dep--;
    this.c.end();
    this.dep--;
  }
  override while(cond: X, body: () => void): void {
    this.loop((brk) => {
      this.if(this.not(cond), () => this.br(brk));
      body();
    });
  }
  /** while (cond) with break/continue labels. */
  whileL(cond: X, body: (brk: Lbl, cont: Lbl) => void): void {
    this.loop((brk, cont) => {
      this.if(this.not(cond), () => this.br(brk));
      body(brk, cont);
    });
  }
  br(l: Lbl): void {
    this.c.br(this.dep - l.depth);
  }
  bump(local: number, n = 1): void {
    this.put(local, this.add(this.l(local), this.i(n)));
  }
  /** v in [lo, hi] (signed; -1 is never inside a non-negative range). */
  inR(v: X, lo: number, hi: number): X {
    return this.both(this.ge(v, this.i(lo)), this.le(v, this.i(hi)));
  }
  anyEq(v: X, ks: readonly number[]): X {
    let acc = this.eq(v, this.i(ks[0]!));
    for (const k of ks.slice(1)) acc = this.or(acc, this.eq(v, this.i(k)));
    return acc;
  }
}

const C = (s: string): number => s.charCodeAt(0);

/** The per-opcode class re_need_check_adv_and_capture_init and
 * compute_register_count switch on, as one embedded table. */
const OPC_UNKNOWN = 0;
const OPC_RANGE16 = 1;
const OPC_RANGE32 = 2;
const OPC_CONSUME = 3;
const OPC_NEUTRAL = 4;
const OPC_BACKREF = 5;
function opcodeClasses(): Uint8Array {
  const t = new Uint8Array(REOP_SIZE.length);
  for (const k of [REOP.range, REOP.range_i]) t[k] = OPC_RANGE16;
  for (const k of [REOP.range32, REOP.range32_i]) t[k] = OPC_RANGE32;
  for (const k of [REOP.char, REOP.char_i, REOP.char32, REOP.char32_i, REOP.dot, REOP.any, REOP.space, REOP.not_space]) t[k] = OPC_CONSUME;
  for (const k of [
    REOP.line_start,
    REOP.line_start_m,
    REOP.line_end,
    REOP.line_end_m,
    REOP.set_i32,
    REOP.set_char_pos,
    REOP.word_boundary,
    REOP.word_boundary_i,
    REOP.not_word_boundary,
    REOP.not_word_boundary_i,
    REOP.prev,
    REOP.save_start,
    REOP.save_end,
    REOP.save_reset,
  ])
    t[k] = OPC_NEUTRAL;
  for (const k of [REOP.back_reference, REOP.back_reference_i, REOP.backward_back_reference, REOP.backward_back_reference_i]) t[k] = OPC_BACKREF;
  return t;
}

/** Atom kinds for the quantifier check (regex-parser.ts isQuantifiable). */
const K_ATOM = 0;
const K_ASSERT = 1; // ^ $ \b \B — "Nothing to repeat"
const K_LOOK_Q = 2; // forward lookahead, non-unicode: quantifiable (Annex B)
const K_LOOK_NQ = 3; // lookbehind, or lookahead under /u — "Invalid quantifier"

const MAX_NESTING = 256;
/** The flags-string mask bits (one per legal flag letter). */
const FM = { d: 1, g: 2, i: 4, m: 8, s: 16, u: 32, v: 64, y: 128 } as const;
const CR_SUB = 3;
const CR_UNION = 0;

export class RegexCompilerBuilder {
  private readonly fns = new Map<string, number>();
  private readonly strT: number;
  private readonly bufT: number;
  private readonly crT: number;
  private readonly nameArrT: number;
  private g: Record<string, number> | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    strType: number,
    private readonly re: RegexBuilder,
    /** %w.re.canonicalize's function index (the interpreter's, shared). */
    private readonly canonFn: () => number,
  ) {
    this.strT = strType;
    this.bufT = re.bcType;
    this.crT = mb.arrayType(I32, true);
    this.nameArrT = mb.arrayType(this.ref(strType), true);
  }

  private ref(t: number): ValType {
    return { kind: "ref", nullable: true, typeIndex: t };
  }

  /* ── globals ────────────────────────────────────────────────────── */

  private get G(): Record<string, number> {
    if (this.g !== null) return this.g;
    const i32 = (): number =>
      this.mb.addGlobal(I32, true, (w) => {
        w.u8(0x41);
        w.sleb(0);
      });
    const nul = (t: number): number =>
      this.mb.addGlobal(this.ref(t), true, (w) => {
        w.u8(0xd0);
        w.sleb(t);
      });
    const g: Record<string, number> = {};
    for (const n of [
      "len", "pos", "uni", "ic", "ml", "da", "topIc", "topMl", "topDa", "sticky", "flagMask",
      "capCount", "scope", "bcSize", "stFirst", "stSecond", "stCap", "totalCap", "hasNamed",
      "modUsed", "qLook", "deferredK", "depth", "err",
      "aKind", "aCp", "aNext", "aDsw", "escNext", "nameNext", "scanHasNamed", "matchCount", "digNext",
      "qPresent", "qMin", "qMax", "qInf", "qGreedy", "termKind", "tablesReady",
    ])
      g[n] = i32();
    g["pat"] = nul(this.strT);
    g["flags"] = nul(this.strT);
    g["nameStr"] = nul(this.strT);
    g["nbuf"] = nul(this.strT);
    g["bc"] = nul(this.bufT);
    g["aCr"] = nul(this.crT);
    g["names"] = nul(this.nameArrT);
    for (const n of ["nameScope", "closed", "match", "tIdFirst", "tIdNext", "tCanon", "tCanonNF", "tGcMask"]) g[n] = nul(this.crT);
    for (const n of ["tGc", "tAlias", "tOpSize", "tOpClass"]) g[n] = nul(this.bufT);
    this.g = g;
    return g;
  }

  private gg($: RA, n: string): X {
    return $.g(this.G[n]!);
  }
  private gs($: RA, n: string, v: X): void {
    $.gput(this.G[n]!, v);
  }

  /* ── function plumbing ──────────────────────────────────────────── */

  private fn(name: string, params: ValType[], results: ValType[], body: ($: RA) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.rec.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    const $ = new RA(f);
    body($);
    if (results.length > 0) $.c.unreachable();
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  /** Pushes a string literal (UTF-16 code units, array.new_data). */
  private lit($: RA, s: string): X {
    return () => {
      const units = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        units[i * 2] = s.charCodeAt(i) & 0xff;
        units[i * 2 + 1] = s.charCodeAt(i) >> 8;
      }
      $.c.i32Const(this.mb.internData(units));
      $.c.i32Const(s.length);
      $.c.arrayNewData(this.strT, 0);
    };
  }

  private dataI32($: RA, vals: readonly number[]): X {
    return () => {
      $.c.i32Const(this.mb.internData(i32Bytes(vals)));
      $.c.i32Const(vals.length);
      $.c.arrayNewData(this.crT, 0);
    };
  }

  private dataU8($: RA, bytes: Uint8Array): X {
    return () => {
      $.c.i32Const(this.mb.internData(bytes));
      $.c.i32Const(bytes.length);
      $.c.arrayNewData(this.bufT, 0);
    };
  }

  /** Early-return the status of a call when it is non-zero. */
  private chk($: RA, st: number, call: X): void {
    $.if($.ne($.tee(st, call), $.i(0)), () => $.ret($.l(st)));
  }

  /* ── tables ─────────────────────────────────────────────────────── */

  private get fInitTables(): number {
    return this.fn("initTables", [], [], ($) => {
      $.if(this.gg($, "tablesReady"), () => $.ret());
      const pairs = canonPairs();
      const xs: number[] = [];
      for (let i = 0; i < pairs.length; i += 2) xs.push(pairs[i]!, pairs[i]! + 1);
      // xs as a CharRange: merge touching singletons.
      const nf: number[] = [];
      for (let i = 0; i < xs.length; i += 2) {
        if (nf.length > 0 && nf[nf.length - 1] === xs[i]) nf[nf.length - 1] = xs[i + 1]!;
        else nf.push(xs[i]!, xs[i + 1]!);
      }
      const opSize = Uint8Array.from(REOP_SIZE);
      this.gs($, "tIdFirst", this.dataI32($, identFirstRanges()));
      this.gs($, "tIdNext", this.dataI32($, identNextRanges()));
      this.gs($, "tCanon", this.dataI32($, pairs));
      this.gs($, "tCanonNF", this.dataI32($, nf));
      this.gs($, "tGcMask", this.dataI32($, GC_NAME_ROWS.map((_, i) => gcRowMask(i))));
      this.gs($, "tGc", this.dataU8($, Uint8Array.from(GC_TABLE)));
      this.gs($, "tAlias", this.dataU8($, gcAliasBlob()));
      this.gs($, "tOpSize", this.dataU8($, opSize));
      this.gs($, "tOpClass", this.dataU8($, opcodeClasses()));
      this.gs($, "tablesReady", $.i(1));
    });
  }

  /* ── pattern access ─────────────────────────────────────────────── */

  /** The code unit at i, or -1 past either end (charCodeAt's NaN). */
  private get fCh(): number {
    return this.fn("ch", [I32], [I32], ($) => {
      const I = 0;
      $.if($.either($.lt($.l(I), $.i(0)), $.ge($.l(I), this.gg($, "len"))), () => $.ret($.i(-1)));
      $.ret($.agetU(this.strT, this.gg($, "pat"), $.l(I)));
    });
  }
  private ch($: RA, i: X): X {
    return $.call(this.fCh, i);
  }

  /** codePointAt(i), -1 past the end. */
  private get fCpAt(): number {
    return this.fn("cpAt", [I32], [I32], ($) => {
      const I = 0;
      const U = $.local(I32);
      const V = $.local(I32);
      $.put(U, this.ch($, $.l(I)));
      $.if($.inR($.l(U), 0xd800, 0xdbff), () => {
        $.put(V, this.ch($, $.add($.l(I), $.i(1))));
        $.if($.inR($.l(V), 0xdc00, 0xdfff), () =>
          $.ret($.add($.i(0x10000), $.add($.shl($.sub($.l(U), $.i(0xd800)), $.i(10)), $.sub($.l(V), $.i(0xdc00))))),
        );
      });
      $.ret($.l(U));
    });
  }

  private isDigit($: RA, c: X): X {
    return $.inR(c, 0x30, 0x39);
  }

  /* ── the bytecode buffer (DynBuf) ───────────────────────────────── */

  private get fReserve(): number {
    return this.fn("reserve", [I32], [], ($) => {
      const N = 0;
      const NEED = $.local(I32);
      const NL = $.local(I32);
      const NB = $.local(this.ref(this.bufT));
      $.put(NEED, $.add(this.gg($, "bcSize"), $.l(N)));
      $.if($.le($.l(NEED), $.alen(this.gg($, "bc"))), () => $.ret());
      $.put(NL, $.mul($.alen(this.gg($, "bc")), $.i(2)));
      $.if($.lt($.l(NL), $.l(NEED)), () => $.put(NL, $.l(NEED)));
      $.put(NB, $.anew(this.bufT, $.l(NL)));
      $.do($.l(NB), $.i(0), this.gg($, "bc"), $.i(0), this.gg($, "bcSize"));
      $.c.arrayCopy(this.bufT, this.bufT);
      this.gs($, "bc", $.l(NB));
    });
  }

  private get fEmit8(): number {
    return this.fn("emit8", [I32], [], ($) => {
      $.run(this.fReserve, $.i(1));
      $.aset(this.bufT, this.gg($, "bc"), this.gg($, "bcSize"), $.l(0));
      this.gs($, "bcSize", $.add(this.gg($, "bcSize"), $.i(1)));
    });
  }
  private e8($: RA, v: X): void {
    $.run(this.fEmit8, v);
  }
  private get fEmit16(): number {
    return this.fn("emit16", [I32], [], ($) => {
      this.e8($, $.and($.l(0), $.i(0xff)));
      this.e8($, $.and($.shrU($.l(0), $.i(8)), $.i(0xff)));
    });
  }
  private get fEmit32(): number {
    return this.fn("emit32", [I32], [], ($) => {
      for (let k = 0; k < 4; k++) this.e8($, $.and($.shrU($.l(0), $.i(k * 8)), $.i(0xff)));
    });
  }
  private get fPatch8(): number {
    return this.fn("patch8", [I32, I32], [], ($) => {
      $.aset(this.bufT, this.gg($, "bc"), $.l(0), $.l(1));
    });
  }
  private get fPatch32(): number {
    return this.fn("patch32", [I32, I32], [], ($) => {
      for (let k = 0; k < 4; k++) $.aset(this.bufT, this.gg($, "bc"), $.add($.l(0), $.i(k)), $.shrU($.l(1), $.i(k * 8)));
    });
  }
  private get fGet8(): number {
    return this.fn("get8", [I32], [I32], ($) => {
      $.ret($.agetU(this.bufT, this.gg($, "bc"), $.l(0)));
    });
  }
  private get8($: RA, p: X): X {
    return $.call(this.fGet8, p);
  }
  private get fGet16(): number {
    return this.fn("get16", [I32], [I32], ($) => {
      $.ret($.or(this.get8($, $.l(0)), $.shl(this.get8($, $.add($.l(0), $.i(1))), $.i(8))));
    });
  }
  /** dbuf_insert: n zero bytes at p. */
  private get fInsert(): number {
    return this.fn("insertZeros", [I32, I32], [], ($) => {
      const P = 0;
      const N = 1;
      const K = $.local(I32);
      $.run(this.fReserve, $.l(N));
      $.do(this.gg($, "bc"), $.add($.l(P), $.l(N)), this.gg($, "bc"), $.l(P), $.sub(this.gg($, "bcSize"), $.l(P)));
      $.c.arrayCopy(this.bufT, this.bufT);
      $.for(K, $.l(P), $.add($.l(P), $.l(N)), () => $.aset(this.bufT, this.gg($, "bc"), $.l(K), $.i(0)));
      this.gs($, "bcSize", $.add(this.gg($, "bcSize"), $.l(N)));
    });
  }
  /** re_parse_alternative's backward-direction term move. */
  private get fMoveToFront(): number {
    return this.fn("moveToFront", [I32, I32, I32], [], ($) => {
      const START = 0;
      const TS = 1;
      const END = 2;
      const SZ = $.local(I32);
      $.put(SZ, $.sub($.l(END), $.l(TS)));
      $.run(this.fReserve, $.l(SZ));
      $.do(this.gg($, "bc"), $.add($.l(START), $.l(SZ)), this.gg($, "bc"), $.l(START), $.sub($.l(END), $.l(START)));
      $.c.arrayCopy(this.bufT, this.bufT);
      $.do(this.gg($, "bc"), $.l(START), this.gg($, "bc"), $.l(END), $.l(SZ));
      $.c.arrayCopy(this.bufT, this.bufT);
    });
  }

  private opSize($: RA, op: X): X {
    return $.agetU(this.bufT, this.gg($, "tOpSize"), op);
  }
  private opClass($: RA, op: X): X {
    return $.agetU(this.bufT, this.gg($, "tOpClass"), op);
  }

  /** re_need_check_adv_and_capture_init: bit0 need_check_adv, bit1
   * need_capture_init. */
  private get fNeedCheckAdv(): number {
    return this.fn("needCheckAdv", [I32, I32], [I32], ($) => {
      const START = 0;
      const END = 1;
      const NCA = $.local(I32);
      const NCI = $.local(I32);
      const POS = $.local(I32);
      const OP = $.local(I32);
      const LEN = $.local(I32);
      const K = $.local(I32);
      $.put(NCA, $.i(1));
      $.put(NCI, $.i(0));
      $.put(POS, $.l(START));
      $.while($.lt($.l(POS), $.l(END)), () => {
        $.put(OP, this.get8($, $.l(POS)));
        $.put(LEN, this.opSize($, $.l(OP)));
        $.put(K, this.opClass($, $.l(OP)));
        $.if($.eq($.l(K), $.i(OPC_RANGE16)), () => {
          $.put(LEN, $.add($.l(LEN), $.mul($.call(this.fGet16, $.add($.l(POS), $.i(1))), $.i(4))));
          $.put(NCA, $.i(0));
        });
        $.if($.eq($.l(K), $.i(OPC_RANGE32)), () => {
          $.put(LEN, $.add($.l(LEN), $.mul($.call(this.fGet16, $.add($.l(POS), $.i(1))), $.i(8))));
          $.put(NCA, $.i(0));
        });
        $.if($.eq($.l(K), $.i(OPC_CONSUME)), () => $.put(NCA, $.i(0)));
        $.if($.eq($.l(K), $.i(OPC_BACKREF)), () => {
          $.put(LEN, $.add($.l(LEN), this.get8($, $.add($.l(POS), $.i(1)))));
          $.put(NCI, $.i(1));
        });
        $.if($.eq($.l(K), $.i(OPC_UNKNOWN)), () => $.ret($.or($.l(NCA), $.i(2))));
        $.put(POS, $.add($.l(POS), $.l(LEN)));
      });
      $.ret($.or($.l(NCA), $.shl($.l(NCI), $.i(1))));
    });
  }

  /** compute_register_count, backpatching each register operand; -1 past
   * REGISTER_COUNT_MAX. */
  private get fRegisterCount(): number {
    return this.fn("registerCount", [I32, I32], [I32], ($) => {
      const START = 0;
      const END = 1;
      const SS = $.local(I32);
      const MX = $.local(I32);
      const POS = $.local(I32);
      const OP = $.local(I32);
      const LEN = $.local(I32);
      const K = $.local(I32);
      $.put(POS, $.l(START));
      $.while($.lt($.l(POS), $.l(END)), () => {
        $.put(OP, this.get8($, $.l(POS)));
        $.put(LEN, this.opSize($, $.l(OP)));
        $.put(K, this.opClass($, $.l(OP)));
        $.if($.anyEq($.l(OP), [REOP.set_i32, REOP.set_char_pos]), () => {
          $.run(this.fPatch8, $.add($.l(POS), $.i(1)), $.l(SS));
          $.bump(SS);
          $.if($.gt($.l(SS), $.l(MX)), () => {
            $.if($.gt($.l(SS), $.i(REGISTER_COUNT_MAX)), () => $.ret($.i(-1)));
            $.put(MX, $.l(SS));
          });
        });
        $.if($.anyEq($.l(OP), [REOP.check_advance, REOP.loop, REOP.loop_split_goto_first, REOP.loop_split_next_first]), () => {
          $.bump(SS, -1);
          $.run(this.fPatch8, $.add($.l(POS), $.i(1)), $.l(SS));
        });
        $.if($.anyEq($.l(OP), [REOP.loop_check_adv_split_goto_first, REOP.loop_check_adv_split_next_first]), () => {
          $.bump(SS, -2);
          $.run(this.fPatch8, $.add($.l(POS), $.i(1)), $.l(SS));
        });
        $.if($.eq($.l(K), $.i(OPC_RANGE16)), () => $.put(LEN, $.add($.l(LEN), $.mul($.call(this.fGet16, $.add($.l(POS), $.i(1))), $.i(4)))));
        $.if($.eq($.l(K), $.i(OPC_RANGE32)), () => $.put(LEN, $.add($.l(LEN), $.mul($.call(this.fGet16, $.add($.l(POS), $.i(1))), $.i(8)))));
        $.if($.eq($.l(K), $.i(OPC_BACKREF)), () => $.put(LEN, $.add($.l(LEN), this.get8($, $.add($.l(POS), $.i(1))))));
        $.put(POS, $.add($.l(POS), $.l(LEN)));
      });
      $.ret($.l(MX));
    });
  }

  /* ── CharRange algebra (regex-charclass.ts; points are u32) ──────── */

  private crRef(): ValType {
    return this.ref(this.crT);
  }

  /** cr_compress over pts[0..n) into an exact-length array. */
  private get fCrCompress(): number {
    return this.fn("crCompress", [this.crRef(), I32], [this.crRef()], ($) => {
      const P = 0;
      const N = 1;
      const OUT = $.local(this.crRef());
      const K = $.local(I32);
      const I = $.local(I32);
      const J = $.local(I32);
      const RES = $.local(this.crRef());
      const at = (x: X): X => $.aget(this.crT, $.l(P), x);
      $.put(OUT, $.anew(this.crT, $.l(N)));
      $.whileL($.lt($.add($.l(I), $.i(1)), $.l(N)), (_brk, cont) => {
        $.if($.eq(at($.l(I)), at($.add($.l(I), $.i(1)))), () => {
          $.bump(I, 2);
          $.br(cont);
        });
        $.put(J, $.l(I));
        $.loop((brk) => {
          $.if($.not($.lt($.add($.l(J), $.i(3)), $.l(N))), () => $.br(brk));
          $.if($.ne(at($.add($.l(J), $.i(1))), at($.add($.l(J), $.i(2)))), () => $.br(brk));
          $.bump(J, 2);
        });
        $.aset(this.crT, $.l(OUT), $.l(K), at($.l(I)));
        $.bump(K);
        $.aset(this.crT, $.l(OUT), $.l(K), at($.add($.l(J), $.i(1))));
        $.bump(K);
        $.put(I, $.add($.l(J), $.i(2)));
      });
      $.put(RES, $.anew(this.crT, $.l(K)));
      $.do($.l(RES), $.i(0), $.l(OUT), $.i(0), $.l(K));
      $.c.arrayCopy(this.crT, this.crT);
      $.ret($.l(RES));
    });
  }

  /** cr_op: 0 union, 1 inter, 2 xor, 3 sub. */
  private get fCrOp(): number {
    return this.fn("crOp", [this.crRef(), this.crRef(), I32], [this.crRef()], ($) => {
      const A_ = 0;
      const B_ = 1;
      const OP = 2;
      const AL = $.local(I32);
      const BL = $.local(I32);
      const OUT = $.local(this.crRef());
      const N = $.local(I32);
      const AI = $.local(I32);
      const BI = $.local(I32);
      const V = $.local(I32);
      const X_ = $.local(I32);
      const Y = $.local(I32);
      const AIN = $.local(I32);
      const BIN = $.local(I32);
      const IN = $.local(I32);
      $.put(AL, $.alen($.l(A_)));
      $.put(BL, $.alen($.l(B_)));
      $.put(OUT, $.anew(this.crT, $.add($.l(AL), $.l(BL))));
      $.loop((brk) => {
        $.if(
          $.both($.lt($.l(AI), $.l(AL)), $.lt($.l(BI), $.l(BL))),
          () => {
            $.put(X_, $.aget(this.crT, $.l(A_), $.l(AI)));
            $.put(Y, $.aget(this.crT, $.l(B_), $.l(BI)));
            $.if(
              $.ltU($.l(X_), $.l(Y)),
              () => {
                $.put(V, $.l(X_));
                $.bump(AI);
              },
              () =>
                $.if(
                  $.eq($.l(X_), $.l(Y)),
                  () => {
                    $.put(V, $.l(X_));
                    $.bump(AI);
                    $.bump(BI);
                  },
                  () => {
                    $.put(V, $.l(Y));
                    $.bump(BI);
                  },
                ),
            );
          },
          () =>
            $.if(
              $.lt($.l(AI), $.l(AL)),
              () => {
                $.put(V, $.aget(this.crT, $.l(A_), $.l(AI)));
                $.bump(AI);
              },
              () =>
                $.if(
                  $.lt($.l(BI), $.l(BL)),
                  () => {
                    $.put(V, $.aget(this.crT, $.l(B_), $.l(BI)));
                    $.bump(BI);
                  },
                  () => $.br(brk),
                ),
            ),
        );
        $.put(AIN, $.and($.l(AI), $.i(1)));
        $.put(BIN, $.and($.l(BI), $.i(1)));
        $.put(IN, $.or($.l(AIN), $.l(BIN)));
        $.if($.eq($.l(OP), $.i(1)), () => $.put(IN, $.and($.l(AIN), $.l(BIN))));
        $.if($.eq($.l(OP), $.i(2)), () => $.put(IN, $.xor($.l(AIN), $.l(BIN))));
        $.if($.eq($.l(OP), $.i(3)), () => $.put(IN, $.and($.l(AIN), $.xor($.l(BIN), $.i(1)))));
        $.if($.ne($.l(IN), $.and($.l(N), $.i(1))), () => {
          $.aset(this.crT, $.l(OUT), $.l(N), $.l(V));
          $.bump(N);
        });
      });
      $.ret($.call(this.fCrCompress, $.l(OUT), $.l(N)));
    });
  }
  private crOp($: RA, a: X, b: X, op: number): X {
    return $.call(this.fCrOp, a, b, $.i(op));
  }

  private get fCrInvert(): number {
    return this.fn("crInvert", [this.crRef()], [this.crRef()], ($) => {
      const A_ = 0;
      const L = $.local(I32);
      const T = $.local(this.crRef());
      $.put(L, $.alen($.l(A_)));
      $.put(T, $.anew(this.crT, $.add($.l(L), $.i(2))));
      $.do($.l(T), $.i(1), $.l(A_), $.i(0), $.l(L));
      $.c.arrayCopy(this.crT, this.crT);
      $.aset(this.crT, $.l(T), $.add($.l(L), $.i(1)), $.i(-1));
      $.ret($.call(this.fCrCompress, $.l(T), $.add($.l(L), $.i(2))));
    });
  }

  /** [lo, hiExclusive) as a fresh CharRange. */
  private crPair($: RA, lo: X, hiExcl: X): X {
    return () => {
      lo();
      hiExcl();
      $.c.arrayNewFixed(this.crT, 2);
    };
  }

  /** Membership of x in a sorted point list (u32 compare). */
  private get fCrHas(): number {
    return this.fn("crHas", [this.crRef(), I32], [I32], ($) => {
      const A_ = 0;
      const X_ = 1;
      const LO = $.local(I32);
      const HI = $.local(I32);
      const MID = $.local(I32);
      $.put(HI, $.alen($.l(A_)));
      $.while($.lt($.l(LO), $.l(HI)), () => {
        $.put(MID, $.shrU($.add($.l(LO), $.l(HI)), $.i(1)));
        $.if(
          $.leU($.aget(this.crT, $.l(A_), $.l(MID)), $.l(X_)),
          () => $.put(LO, $.add($.l(MID), $.i(1))),
          () => $.put(HI, $.l(MID)),
        );
      });
      $.ret($.and($.l(LO), $.i(1)));
    });
  }

  /** caseCloseClass (regex-class-closure.ts) as a set identity:
   * (S minus the moved points) united with the moved points' images. */
  private get fCaseClose(): number {
    return this.fn("caseClose", [this.crRef()], [this.crRef()], ($) => {
      const S = 0;
      const BASE = $.local(this.crRef());
      const PAIRS = $.local(this.crRef());
      const NP = $.local(I32);
      const IMG = $.local(this.crRef());
      const M = $.local(I32);
      const I = $.local(I32);
      const J = $.local(I32);
      const V = $.local(I32);
      const PTS = $.local(this.crRef());
      const N = $.local(I32);
      const ST = $.local(I32);
      const EN = $.local(I32);
      $.put(BASE, this.crOp($, $.l(S), this.gg($, "tCanonNF"), CR_SUB));
      $.put(PAIRS, this.gg($, "tCanon"));
      $.put(NP, $.shrU($.alen($.l(PAIRS)), $.i(1)));
      $.put(IMG, $.anew(this.crT, $.l(NP)));
      $.for(I, $.i(0), $.l(NP), () => {
        $.if($.call(this.fCrHas, $.l(S), $.aget(this.crT, $.l(PAIRS), $.shl($.l(I), $.i(1)))), () => {
          $.aset(this.crT, $.l(IMG), $.l(M), $.aget(this.crT, $.l(PAIRS), $.add($.shl($.l(I), $.i(1)), $.i(1))));
          $.bump(M);
        });
      });
      // insertion sort IMG[0..M)
      $.for(I, $.i(1), $.l(M), () => {
        $.put(V, $.aget(this.crT, $.l(IMG), $.l(I)));
        $.put(J, $.sub($.l(I), $.i(1)));
        $.loop((brk) => {
          $.if($.lt($.l(J), $.i(0)), () => $.br(brk));
          $.if($.le($.aget(this.crT, $.l(IMG), $.l(J)), $.l(V)), () => $.br(brk));
          $.aset(this.crT, $.l(IMG), $.add($.l(J), $.i(1)), $.aget(this.crT, $.l(IMG), $.l(J)));
          $.bump(J, -1);
        });
        $.aset(this.crT, $.l(IMG), $.add($.l(J), $.i(1)), $.l(V));
      });
      $.put(PTS, $.anew(this.crT, $.add($.mul($.l(M), $.i(2)), $.i(2))));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.l(M)), () => {
        $.put(ST, $.aget(this.crT, $.l(IMG), $.l(I)));
        $.put(EN, $.add($.l(ST), $.i(1)));
        $.bump(I);
        $.loop((brk) => {
          $.if($.not($.lt($.l(I), $.l(M))), () => $.br(brk));
          $.if($.gt($.aget(this.crT, $.l(IMG), $.l(I)), $.l(EN)), () => $.br(brk));
          $.if($.eq($.aget(this.crT, $.l(IMG), $.l(I)), $.l(EN)), () => $.bump(EN));
          $.bump(I);
        });
        $.aset(this.crT, $.l(PTS), $.l(N), $.l(ST));
        $.bump(N);
        $.aset(this.crT, $.l(PTS), $.l(N), $.l(EN));
        $.bump(N);
      });
      $.ret(this.crOp($, $.l(BASE), $.call(this.fCrCompress, $.l(PTS), $.l(N)), CR_UNION));
    });
  }

  /** \d \D \s \S \w \W (classRangeDSW) by letter. */
  private get fDsw(): number {
    return this.fn("dsw", [I32], [this.crRef()], ($) => {
      for (const l of ["d", "D", "s", "S", "w", "W"] as const) {
        $.if($.eq($.l(0), $.i(C(l))), () => $.ret(this.dataI32($, classRangeDSW(l).map((v) => v | 0))));
      }
      $.trap();
    });
  }

  /** unicode_general_category1 over GC_TABLE. */
  private get fGc1(): number {
    return this.fn("gc1", [I32], [this.crRef()], ($) => {
      const MASK = 0;
      const OUT = $.local(this.crRef());
      const N = $.local(I32);
      const P = $.local(I32);
      const PEND = $.local(I32);
      const CC = $.local(I32);
      const B = $.local(I32);
      const RL = $.local(I32);
      const V = $.local(I32);
      const C0 = $.local(I32);
      const LULL = $.local(I32);
      const X_ = $.local(I32);
      const T = (x: X): X => $.agetU(this.bufT, this.gg($, "tGc"), x);
      const next = (): X => () => {
        T($.l(P))();
        $.bump(P);
      };
      const push = (a: X, b: X): void => {
        $.put(OUT, $.call(this.fI32Push2, $.l(OUT), $.l(N), a, b));
        $.bump(N, 2);
      };
      $.put(OUT, $.anew(this.crT, $.i(64)));
      $.put(PEND, $.alen(this.gg($, "tGc")));
      $.while($.lt($.l(P), $.l(PEND)), () => {
        $.put(B, next());
        $.put(RL, $.shrU($.l(B), $.i(5)));
        $.put(V, $.and($.l(B), $.i(0x1f)));
        $.if($.eq($.l(RL), $.i(7)), () => {
          $.put(RL, next());
          $.if(
            $.lt($.l(RL), $.i(128)),
            () => $.put(RL, $.add($.l(RL), $.i(7))),
            () =>
              $.if(
                $.lt($.l(RL), $.i(128 + 64)),
                () => {
                  $.put(RL, $.shl($.sub($.l(RL), $.i(128)), $.i(8)));
                  $.put(RL, $.or($.l(RL), next()));
                  $.put(RL, $.add($.l(RL), $.i(7 + 128)));
                },
                () => {
                  $.put(RL, $.shl($.sub($.l(RL), $.i(128 + 64)), $.i(16)));
                  $.put(RL, $.or($.l(RL), $.shl(next(), $.i(8))));
                  $.put(RL, $.or($.l(RL), next()));
                  $.put(RL, $.add($.l(RL), $.i(7 + 128 + (1 << 14))));
                },
              ),
          );
        });
        $.put(C0, $.l(CC));
        $.put(CC, $.add($.l(CC), $.add($.l(RL), $.i(1))));
        $.if(
          $.eq($.l(V), $.i(31)),
          () => {
            $.put(LULL, $.and($.l(MASK), $.i(GC_LU_BIT | GC_LL_BIT)));
            $.if($.ne($.l(LULL), $.i(0)), () => {
              $.if(
                $.eq($.l(LULL), $.i(GC_LU_BIT | GC_LL_BIT)),
                () => push($.l(C0), $.l(CC)),
                () => {
                  $.put(X_, $.add($.l(C0), $.ne($.and($.l(MASK), $.i(GC_LL_BIT)), $.i(0))));
                  $.while($.lt($.l(X_), $.l(CC)), () => {
                    push($.l(X_), $.add($.l(X_), $.i(1)));
                    $.bump(X_, 2);
                  });
                },
              );
            });
          },
          () => $.if($.and($.shrU($.l(MASK), $.l(V)), $.i(1)), () => push($.l(C0), $.l(CC))),
        );
      });
      // RAW, like unicode_general_category1's cr_add_interval appends:
      // adjacent runs stay separate intervals (a bare \p{..} emits them
      // that way; a class or \P{..} compresses through cr_op/cr_invert).
      $.ret($.call(this.fCrTrim, $.l(OUT), $.l(N)));
    });
  }

  /** pts[0..n) into an exact-length array, unchanged. */
  private get fCrTrim(): number {
    return this.fn("crTrim", [this.crRef(), I32], [this.crRef()], ($) => {
      const RES = $.local(this.crRef());
      $.put(RES, $.anew(this.crT, $.l(1)));
      $.do($.l(RES), $.i(0), $.l(0), $.i(0), $.l(1));
      $.c.arrayCopy(this.crT, this.crT);
      $.ret($.l(RES));
    });
  }

  /** arr[n] = a; arr[n+1] = b, growing arr; returns the (possibly new) arr. */
  private get fI32Push2(): number {
    return this.fn("i32Push2", [this.crRef(), I32, I32, I32], [this.crRef()], ($) => {
      const ARR = 0;
      const N = 1;
      const NA = $.local(this.crRef());
      $.if($.gt($.add($.l(N), $.i(2)), $.alen($.l(ARR))), () => {
        $.put(NA, $.anew(this.crT, $.add($.mul($.alen($.l(ARR)), $.i(2)), $.i(2))));
        $.do($.l(NA), $.i(0), $.l(ARR), $.i(0), $.l(N));
        $.c.arrayCopy(this.crT, this.crT);
        $.put(ARR, $.l(NA));
      });
      $.aset(this.crT, $.l(ARR), $.l(N), $.l(2));
      $.aset(this.crT, $.l(ARR), $.add($.l(N), $.i(1)), $.l(3));
      $.ret($.l(ARR));
    });
  }

  /** A General_Category alias spelled by pattern[s..e) -> its row, or -1. */
  private get fGcLookup(): number {
    return this.fn("gcLookup", [I32, I32], [I32], ($) => {
      const S = 0;
      const E = 1;
      const P = $.local(I32);
      const L = $.local(I32);
      const K = $.local(I32);
      const OK = $.local(I32);
      const T = (x: X): X => $.agetU(this.bufT, this.gg($, "tAlias"), x);
      $.while($.lt($.l(P), $.alen(this.gg($, "tAlias"))), () => {
        $.put(L, T($.l(P)));
        $.if($.eq($.l(L), $.sub($.l(E), $.l(S))), () => {
          $.put(OK, $.i(1));
          $.for(K, $.i(0), $.l(L), () => {
            $.if($.ne(T($.add($.add($.l(P), $.i(1)), $.l(K))), this.ch($, $.add($.l(S), $.l(K)))), () => $.put(OK, $.i(0)));
          });
          $.if($.l(OK), () => $.ret(T($.add($.add($.l(P), $.i(1)), $.l(L)))));
        });
        $.put(P, $.add($.l(P), $.add($.l(L), $.i(2))));
      });
      $.ret($.i(-1));
    });
  }

  /** pattern[s..e) spells `word` exactly. */
  private spells($: RA, s: number, e: number, word: string): X {
    let acc = $.eq($.sub($.l(e), $.l(s)), $.i(word.length));
    for (let k = 0; k < word.length; k++) acc = $.and(acc, $.eq(this.ch($, $.add($.l(s), $.i(k))), $.i(word.charCodeAt(k))));
    return acc;
  }

  /** parse_unicode_property (regex-charclass.ts parseUnicodeProperty),
   * `p` at the `{`. Sets aCr/aNext. A name outside General_Category is the
   * unported-unicode-property fence. */
  private get fUnicodeProperty(): number {
    return this.fn("unicodeProperty", [I32, I32], [I32], ($) => {
      const P = 0;
      const INV = 1;
      const NS = $.local(I32);
      const NE = $.local(I32);
      const VS = $.local(I32);
      const VE = $.local(I32);
      const HAS_EQ = $.local(I32);
      const ROW = $.local(I32);
      const CR = $.local(this.crRef());
      const propChar = (x: X): X => $.or($.or($.inR(x, 0x30, 0x39), $.inR(x, 0x41, 0x5a)), $.or($.inR(x, 0x61, 0x7a), $.eq(x, $.i(0x5f))));
      const FUNPORTED = fenceId("unported-unicode-property");
      $.if($.ne(this.ch($, $.l(P)), $.i(C("{"))), () => $.ret($.i(RX.INVALID_PROP_NAME)));
      $.bump(P);
      $.put(NS, $.l(P));
      $.while(propChar(this.ch($, $.l(P))), () => $.bump(P));
      $.put(NE, $.l(P));
      $.put(VS, $.l(P));
      $.put(VE, $.l(P));
      $.if($.eq(this.ch($, $.l(P)), $.i(C("="))), () => {
        $.put(HAS_EQ, $.i(1));
        $.bump(P);
        $.put(VS, $.l(P));
        $.while(propChar(this.ch($, $.l(P))), () => $.bump(P));
        $.put(VE, $.l(P));
      });
      $.if($.ne(this.ch($, $.l(P)), $.i(C("}"))), () => $.ret($.i(RX.INVALID_PROP_NAME)));
      $.bump(P);
      $.put(ROW, $.i(-1));
      $.if(
        $.or($.or(this.spells($, NS, NE, "Script"), this.spells($, NS, NE, "sc")), $.or(this.spells($, NS, NE, "Script_Extensions"), this.spells($, NS, NE, "scx"))),
        () => $.ret($.i(FUNPORTED)),
      );
      $.if(
        $.or(this.spells($, NS, NE, "General_Category"), this.spells($, NS, NE, "gc")),
        () => $.if($.l(HAS_EQ), () => $.put(ROW, $.call(this.fGcLookup, $.l(VS), $.l(VE)))),
        () => $.if($.not($.l(HAS_EQ)), () => $.put(ROW, $.call(this.fGcLookup, $.l(NS), $.l(NE)))),
      );
      $.if($.lt($.l(ROW), $.i(0)), () => $.ret($.i(FUNPORTED)));
      $.put(CR, $.call(this.fGc1, $.aget(this.crT, this.gg($, "tGcMask"), $.l(ROW))));
      $.if($.l(INV), () => $.put(CR, $.call(this.fCrInvert, $.l(CR))));
      this.gs($, "aCr", $.l(CR));
      this.gs($, "aNext", $.l(P));
      $.ret($.i(0));
    });
  }

  /* ── escapes, atoms, classes ────────────────────────────────────── */

  private hexVal($: RA, c: X): X {
    // -1 when not a hex digit
    return () => {
      const t = $.local(I32);
      const r = $.local(I32);
      $.put(t, c);
      $.put(r, $.i(-1));
      $.if($.inR($.l(t), 0x30, 0x39), () => $.put(r, $.sub($.l(t), $.i(0x30))));
      $.if($.inR($.l(t), 0x61, 0x66), () => $.put(r, $.sub($.l(t), $.i(0x61 - 10))));
      $.if($.inR($.l(t), 0x41, 0x46), () => $.put(r, $.sub($.l(t), $.i(0x41 - 10))));
      $.c.localGet(r);
    };
  }

  /** lre_parse_escape (regex-escape.ts parseEscape): `p` just after the
   * backslash. The value, or -1; sets escNext. */
  private get fParseEscape(): number {
    return this.fn("parseEscape", [I32, I32], [I32], ($) => {
      const P = 0;
      const ALLOW = 1;
      const C0 = $.local(I32);
      const CV = $.local(I32);
      const H = $.local(I32);
      const K = $.local(I32);
      const C1 = $.local(I32);
      const V = $.local(I32);
      const done = (): void => {
        this.gs($, "escNext", $.l(P));
        $.ret($.l(CV));
      };
      $.put(C0, this.ch($, $.l(P)));
      $.bump(P);
      for (const [ch, v] of [["b", 8], ["f", 0x0c], ["n", 0x0a], ["r", 0x0d], ["t", 9], ["v", 0x0b]] as const) {
        $.if($.eq($.l(C0), $.i(C(ch))), () => {
          $.put(CV, $.i(v));
          done();
        });
      }
      $.if($.eq($.l(C0), $.i(C("x"))), () => {
        $.put(H, this.hexVal($, this.ch($, $.l(P))));
        $.bump(P);
        $.if($.lt($.l(H), $.i(0)), () => $.ret($.i(-1)));
        $.put(CV, $.shl($.l(H), $.i(4)));
        $.put(H, this.hexVal($, this.ch($, $.l(P))));
        $.bump(P);
        $.if($.lt($.l(H), $.i(0)), () => $.ret($.i(-1)));
        $.put(CV, $.or($.l(CV), $.l(H)));
        done();
      });
      $.if($.eq($.l(C0), $.i(C("u"))), () => {
        $.if(
          $.both($.eq(this.ch($, $.l(P)), $.i(C("{"))), $.ne($.l(ALLOW), $.i(0))),
          () => {
            $.bump(P);
            $.put(CV, $.i(0));
            $.loop((brk) => {
              $.put(H, this.hexVal($, this.ch($, $.l(P))));
              $.bump(P);
              $.if($.lt($.l(H), $.i(0)), () => $.ret($.i(-1)));
              $.put(CV, $.or($.shl($.l(CV), $.i(4)), $.l(H)));
              $.if($.gt($.l(CV), $.i(0x10ffff)), () => $.ret($.i(-1)));
              $.if($.eq(this.ch($, $.l(P)), $.i(C("}"))), () => $.br(brk));
            });
            $.bump(P);
          },
          () => {
            $.put(CV, $.i(0));
            for (let k = 0; k < 4; k++) {
              $.put(H, this.hexVal($, this.ch($, $.l(P))));
              $.bump(P);
              $.if($.lt($.l(H), $.i(0)), () => $.ret($.i(-1)));
              $.put(CV, $.or($.shl($.l(CV), $.i(4)), $.l(H)));
            }
            $.if(
              $.andThen(
                $.both($.inR($.l(CV), 0xd800, 0xdbff), $.eq($.l(ALLOW), $.i(2))),
                $.both($.eq(this.ch($, $.l(P)), $.i(0x5c)), $.eq(this.ch($, $.add($.l(P), $.i(1))), $.i(C("u")))),
              ),
              () => {
                $.put(C1, $.i(0));
                $.put(K, $.i(0));
                $.loop((brk) => {
                  $.if($.ge($.l(K), $.i(4)), () => $.br(brk));
                  $.put(H, this.hexVal($, this.ch($, $.add($.add($.l(P), $.i(2)), $.l(K)))));
                  $.if($.lt($.l(H), $.i(0)), () => $.br(brk));
                  $.put(C1, $.or($.shl($.l(C1), $.i(4)), $.l(H)));
                  $.bump(K);
                });
                $.if($.both($.eq($.l(K), $.i(4)), $.inR($.l(C1), 0xdc00, 0xdfff)), () => {
                  $.bump(P, 6);
                  $.put(CV, $.add($.i(0x10000), $.add($.shl($.sub($.l(CV), $.i(0xd800)), $.i(10)), $.sub($.l(C1), $.i(0xdc00)))));
                });
              },
            );
          },
        );
        done();
      });
      $.if($.inR($.l(C0), 0x30, 0x37), () => {
        $.put(CV, $.sub($.l(C0), $.i(0x30)));
        $.if(
          $.eq($.l(ALLOW), $.i(2)),
          () => {
            $.if($.or($.ne($.l(CV), $.i(0)), this.isDigit($, this.ch($, $.l(P)))), () => $.ret($.i(-1)));
          },
          () => {
            $.loop((brk) => {
              $.put(V, this.ch($, $.l(P)));
              $.if($.not($.inR($.l(V), 0x30, 0x37)), () => $.br(brk));
              $.put(CV, $.or($.shl($.l(CV), $.i(3)), $.sub($.l(V), $.i(0x30))));
              $.bump(P);
              $.if($.ge($.l(CV), $.i(32)), () => $.br(brk));
              $.put(V, this.ch($, $.l(P)));
              $.if($.not($.inR($.l(V), 0x30, 0x37)), () => $.br(brk));
              $.put(CV, $.or($.shl($.l(CV), $.i(3)), $.sub($.l(V), $.i(0x30))));
              $.bump(P);
              $.br(brk);
            });
          },
        );
        done();
      });
      $.ret($.i(-1));
    });
  }

  /** normal_char: sets an atom char at p. */
  private normalChar($: RA, p: X): void {
    const P = $.local(I32);
    const CP = $.local(I32);
    $.put(P, p);
    this.gs($, "aKind", $.i(0));
    $.if(
      this.gg($, "uni"),
      () => {
        $.put(CP, $.call(this.fCpAt, $.l(P)));
        this.gs($, "aCp", $.l(CP));
        this.gs($, "aNext", $.add($.l(P), $.sel(I32, $.ge($.l(CP), $.i(0x10000)), $.i(2), $.i(1))));
      },
      () => {
        this.gs($, "aCp", this.ch($, $.l(P)));
        this.gs($, "aNext", $.add($.l(P), $.i(1)));
      },
    );
  }

  private setChar($: RA, cp: X, next: X): void {
    this.gs($, "aKind", $.i(0));
    this.gs($, "aCp", cp);
    this.gs($, "aNext", next);
  }

  /** get_class_atom (regex-charclass.ts getClassAtom). Status; on success
   * aKind 0 (aCp) or 1 (aCr, aDsw = the letter of a \d\D\s\S\w\W). */
  private get fClassAtom(): number {
    return this.fn("classAtom", [I32, I32], [I32], ($) => {
      const P = 0;
      const INCLASS = 1;
      const C0 = $.local(I32);
      const ESC = $.local(I32);
      const CC = $.local(I32);
      const BS = $.local(I32);
      const V = $.local(I32);
      const ST = $.local(I32);
      this.gs($, "aDsw", $.i(0));
      $.if($.ge($.l(P), this.gg($, "len")), () => $.ret($.i(RX.UNTERMINATED_CLASS)));
      $.put(C0, this.ch($, $.l(P)));
      $.if($.ne($.l(C0), $.i(0x5c)), () => {
        this.normalChar($, $.l(P));
        $.ret($.i(0));
      });
      $.put(BS, $.l(P));
      $.bump(P);
      $.if($.ge($.l(P), this.gg($, "len")), () => $.ret($.i(RX.BACKSLASH_END)));
      $.put(ESC, this.ch($, $.l(P)));
      $.bump(P);
      $.if($.anyEq($.l(ESC), [C("d"), C("D"), C("s"), C("S"), C("w"), C("W")]), () => {
        this.gs($, "aKind", $.i(1));
        this.gs($, "aCr", $.call(this.fDsw, $.l(ESC)));
        this.gs($, "aDsw", $.l(ESC));
        this.gs($, "aNext", $.l(P));
        $.ret($.i(0));
      });
      $.if($.eq($.l(ESC), $.i(C("c"))), () => {
        $.put(CC, this.ch($, $.l(P)));
        $.if(
          $.or(
            $.or($.inR($.l(CC), 0x61, 0x7a), $.inR($.l(CC), 0x41, 0x5a)),
            $.and($.and($.or(this.isDigit($, $.l(CC)), $.eq($.l(CC), $.i(0x5f))), $.l(INCLASS)), $.not(this.gg($, "uni"))),
          ),
          () => {
            this.setChar($, $.and($.l(CC), $.i(0x1f)), $.add($.l(P), $.i(1)));
            $.ret($.i(0));
          },
        );
        $.if(this.gg($, "uni"), () => $.ret($.i(RX.INVALID_UNICODE_ESCAPE)));
        this.setChar($, $.i(0x5c), $.sub($.l(P), $.i(1)));
        $.ret($.i(0));
      });
      $.if($.eq($.l(ESC), $.i(C("-"))), () => {
        $.if($.both($.not($.l(INCLASS)), this.gg($, "uni")), () => $.ret($.i(RX.INVALID_ESCAPE)));
        this.setChar($, $.i(C("-")), $.l(P));
        $.ret($.i(0));
      });
      $.if($.anyEq($.l(ESC), [..."^$\\.*+?()[]{}|/"].map(C)), () => {
        this.setChar($, $.l(ESC), $.l(P));
        $.ret($.i(0));
      });
      $.if($.both($.anyEq($.l(ESC), [C("p"), C("P")]), this.gg($, "uni")), () => {
        $.put(ST, $.call(this.fUnicodeProperty, $.l(P), $.eq($.l(ESC), $.i(C("P")))));
        $.if($.both($.eq($.l(ST), $.i(RX.INVALID_PROP_NAME)), $.l(INCLASS)), () => $.ret($.i(RX.INVALID_PROP_NAME_CLASS)));
        $.if($.l(ST), () => $.ret($.l(ST)));
        this.gs($, "aKind", $.i(1));
        $.ret($.i(0));
      });
      // With named groups (or /u) `\k` is no identity escape, in a class
      // too: V8's "Invalid escape" (regex-parser.ts takes it as `k`).
      $.if($.both($.both($.l(INCLASS), $.eq($.l(ESC), $.i(C("k")))), $.or(this.gg($, "uni"), this.hasNamed($))), () => $.ret($.i(RX.INVALID_ESCAPE)));
      // default_escape
      $.put(V, $.call(this.fParseEscape, $.add($.l(BS), $.i(1)), $.sel(I32, this.gg($, "uni"), $.i(2), $.i(0))));
      $.if($.ge($.l(V), $.i(0)), () => {
        this.setChar($, $.l(V), this.gg($, "escNext"));
        $.ret($.i(0));
      });
      $.if(this.gg($, "uni"), () => {
        $.if($.eq($.l(ESC), $.i(C("u"))), () => $.ret($.i(RX.INVALID_UNICODE_ESCAPE)));
        // a legacy octal escape in a class: "Invalid decimal escape"
        $.if($.inR($.l(ESC), 0x30, 0x37), () => $.ret($.i(RX.INVALID_DECIMAL_ESCAPE)));
        $.ret($.i(RX.INVALID_ESCAPE));
      });
      this.normalChar($, $.add($.l(BS), $.i(1)));
      $.ret($.i(0));
    });
  }

  /** parseCharClass, `pos` at `[`; emits the class (with the
   * backward-direction prev wrap left to the caller). Status. */
  private get fCharClass(): number {
    return this.fn("charClass", [I32], [I32], ($) => {
      const P = 0;
      const INV = $.local(I32);
      const CLOS = $.local(this.crRef());
      const RAW = $.local(this.crRef());
      const ANY_CLOS = $.local(I32);
      const ST = $.local(I32);
      const K1 = $.local(I32);
      const CP1 = $.local(I32);
      const CR1 = $.local(this.crRef());
      const D1 = $.local(I32);
      const CR = $.local(this.crRef());
      const addClos = (cr: X): void => {
        $.put(CLOS, this.crOp($, $.l(CLOS), cr, CR_UNION));
        $.put(ANY_CLOS, $.i(1));
      };
      const addA1 = (): void => {
        $.if(
          $.eq($.l(K1), $.i(1)),
          () =>
            $.if(
              $.l(D1),
              () => $.put(RAW, this.crOp($, $.l(RAW), $.l(CR1), CR_UNION)),
              () => addClos($.l(CR1)),
            ),
          () => addClos(this.crPair($, $.l(CP1), $.add($.l(CP1), $.i(1)))),
        );
      };
      $.bump(P);
      $.if($.eq(this.ch($, $.l(P)), $.i(C("^"))), () => {
        $.bump(P);
        $.put(INV, $.i(1));
      });
      $.put(CLOS, $.anew(this.crT, $.i(0)));
      $.put(RAW, $.anew(this.crT, $.i(0)));
      $.loop((brk, cont) => {
        $.if($.ge($.l(P), this.gg($, "len")), () => $.ret($.i(RX.UNTERMINATED_CLASS)));
        $.if($.eq(this.ch($, $.l(P)), $.i(C("]"))), () => $.br(brk));
        this.chk($, ST, $.call(this.fClassAtom, $.l(P), $.i(1)));
        $.put(K1, this.gg($, "aKind"));
        $.put(CP1, this.gg($, "aCp"));
        $.put(CR1, this.gg($, "aCr"));
        $.put(D1, this.gg($, "aDsw"));
        $.put(P, this.gg($, "aNext"));
        $.if($.both($.eq(this.ch($, $.l(P)), $.i(C("-"))), $.ne(this.ch($, $.add($.l(P), $.i(1))), $.i(C("]")))), () => {
          // Under /u V8 parses the range's end before rejecting a class
          // escape at either end ("Invalid character class").
          $.if($.both($.eq($.l(K1), $.i(1)), this.gg($, "uni")), () => {
            this.chk($, ST, $.call(this.fClassAtom, $.add($.l(P), $.i(1)), $.i(1)));
            $.ret($.i(RX.INVALID_CLASS));
          });
          // Without /u a class escape at either end of a range is Annex B
          // (family 8, class-range-escape): V8 then reads `-` and the far
          // end as literals where libregexp and regex-parser.ts start a new
          // range at the far end (`[\d-d-a]` parses in V8, not in either).
          // Fenced where met; the build-time pipeline refuses the same
          // patterns by name.
          $.if($.eq($.l(K1), $.i(1)), () => $.ret($.i(fenceId("annexb-class-range-escape"))));
          this.chk($, ST, $.call(this.fClassAtom, $.add($.l(P), $.i(1)), $.i(1)));
          $.if($.eq(this.gg($, "aKind"), $.i(1)), () => {
            $.if(this.gg($, "uni"), () => $.ret($.i(RX.INVALID_CLASS)));
            $.ret($.i(fenceId("annexb-class-range-escape")));
          });
          $.if($.lt(this.gg($, "aCp"), $.l(CP1)), () => $.ret($.i(RX.RANGE_ORDER)));
          addClos(this.crPair($, $.l(CP1), $.add(this.gg($, "aCp"), $.i(1))));
          $.put(P, this.gg($, "aNext"));
          $.br(cont);
        });
        addA1();
      });
      $.bump(P);
      $.put(CR, $.l(CLOS));
      $.if($.both(this.gg($, "ic"), $.l(ANY_CLOS)), () => {
        $.if(this.gg($, "uni"), () => $.ret($.i(fenceId("modifiers"))));
        $.put(CR, $.call(this.fCaseClose, $.l(CR)));
      });
      $.put(CR, this.crOp($, $.l(CR), $.l(RAW), CR_UNION));
      $.if($.l(INV), () => $.put(CR, $.call(this.fCrInvert, $.l(CR))));
      this.gs($, "pos", $.l(P));
      $.ret($.call(this.fEmitRange, $.l(CR), this.gg($, "ic")));
    });
  }

  /** re_emit_range (regex-assembler.ts emitRange). Status. */
  private get fEmitRange(): number {
    return this.fn("emitRange", [this.crRef(), I32], [I32], ($) => {
      const CR = 0;
      const IC = 1;
      const L = $.local(I32);
      const N = $.local(I32);
      const HIGH = $.local(I32);
      const I = $.local(I32);
      const HI = $.local(I32);
      const at = (x: X): X => $.aget(this.crT, $.l(CR), x);
      $.put(L, $.alen($.l(CR)));
      $.put(N, $.shrU($.l(L), $.i(1)));
      $.if($.ge($.l(N), $.i(65535)), () => $.ret($.i(fenceId("too-many-ranges"))));
      $.if($.not($.l(N)), () => {
        this.e8($, $.i(REOP.char32));
        $.run(this.fEmit32, $.i(-1));
        $.ret($.i(0));
      });
      $.put(HIGH, at($.sub($.l(L), $.i(1))));
      $.if($.eq($.l(HIGH), $.i(-1)), () => $.put(HIGH, at($.sub($.l(L), $.i(2)))));
      $.if(
        $.leU($.l(HIGH), $.i(0xffff)),
        () => {
          this.e8($, $.sel(I32, $.l(IC), $.i(REOP.range_i), $.i(REOP.range)));
          $.run(this.fEmit16, $.l(N));
          $.put(I, $.i(0));
          $.while($.lt($.l(I), $.l(L)), () => {
            $.run(this.fEmit16, at($.l(I)));
            $.put(HI, $.sub(at($.add($.l(I), $.i(1))), $.i(1)));
            $.if($.eq($.l(HI), $.i(-2)), () => $.put(HI, $.i(0xffff)));
            $.run(this.fEmit16, $.l(HI));
            $.bump(I, 2);
          });
        },
        () => {
          this.e8($, $.sel(I32, $.l(IC), $.i(REOP.range32_i), $.i(REOP.range32)));
          $.run(this.fEmit16, $.l(N));
          $.put(I, $.i(0));
          $.while($.lt($.l(I), $.l(L)), () => {
            $.run(this.fEmit32, at($.l(I)));
            $.run(this.fEmit32, $.sub(at($.add($.l(I), $.i(1))), $.i(1)));
            $.bump(I, 2);
          });
        },
      );
      $.ret($.i(0));
    });
  }

  /* ── group names ────────────────────────────────────────────────── */

  private get fIdentFirst(): number {
    return this.fn("identFirst", [I32], [I32], ($) => {
      $.if($.anyEq($.l(0), [0x24, 0x5f]), () => $.ret($.i(1)));
      $.ret($.call(this.fCrHas, this.gg($, "tIdFirst"), $.l(0)));
    });
  }
  private get fIdentNext(): number {
    return this.fn("identNext", [I32], [I32], ($) => {
      $.if($.anyEq($.l(0), [0x24, 0x5f, 0x200c, 0x200d]), () => $.ret($.i(1)));
      $.ret($.call(this.fCrHas, this.gg($, "tIdNext"), $.l(0)));
    });
  }

  /** nbuf[q] = u, growing nbuf. */
  private get fNbufPut(): number {
    return this.fn("nbufPut", [I32, I32], [], ($) => {
      const Q = 0;
      const U = 1;
      const NB = $.local(this.ref(this.strT));
      $.if($.ge($.l(Q), $.alen(this.gg($, "nbuf"))), () => {
        $.put(NB, $.anew(this.strT, $.mul($.add($.l(Q), $.i(1)), $.i(2))));
        $.do($.l(NB), $.i(0), this.gg($, "nbuf"), $.i(0), $.l(Q));
        $.c.arrayCopy(this.strT, this.strT);
        this.gs($, "nbuf", $.l(NB));
      });
      $.aset(this.strT, this.gg($, "nbuf"), $.l(Q), $.l(U));
    });
  }

  /** re_parse_group_name (regex-parser.ts parseGroupName), `p` after `<`.
   * 0 with nameStr/nameNext set, 2 for a malformed \u escape (V8's
   * "Invalid Unicode escape"), 1 for any other failure. */
  private get fGroupName(): number {
    return this.fn("groupName", [I32], [I32], ($) => {
      const P = 0;
      const Q = $.local(I32);
      const C0 = $.local(I32);
      const CP = $.local(I32);
      const S = $.local(this.ref(this.strT));
      $.loop((brk) => {
        $.put(C0, this.ch($, $.l(P)));
        $.if($.lt($.l(C0), $.i(0)), () => $.ret($.i(1)));
        $.if(
          $.eq($.l(C0), $.i(0x5c)),
          () => {
            $.if($.ne(this.ch($, $.add($.l(P), $.i(1))), $.i(C("u"))), () => $.ret($.i(1)));
            $.put(CP, $.call(this.fParseEscape, $.add($.l(P), $.i(1)), $.i(2)));
            $.if($.lt($.l(CP), $.i(0)), () => $.ret($.i(2)));
            $.put(P, this.gg($, "escNext"));
          },
          () => {
            $.if($.eq($.l(C0), $.i(C(">"))), () => $.br(brk));
            $.put(CP, $.call(this.fCpAt, $.l(P)));
            $.put(P, $.add($.l(P), $.sel(I32, $.ge($.l(CP), $.i(0x10000)), $.i(2), $.i(1))));
          },
        );
        $.if($.gt($.l(CP), $.i(0x10ffff)), () => $.ret($.i(1)));
        $.if(
          $.not($.l(Q)),
          () => $.if($.not($.call(this.fIdentFirst, $.l(CP))), () => $.ret($.i(1))),
          () => $.if($.not($.call(this.fIdentNext, $.l(CP))), () => $.ret($.i(1))),
        );
        $.if(
          $.ge($.l(CP), $.i(0x10000)),
          () => {
            $.run(this.fNbufPut, $.l(Q), $.add($.i(0xd800), $.shrU($.sub($.l(CP), $.i(0x10000)), $.i(10))));
            $.bump(Q);
            $.run(this.fNbufPut, $.l(Q), $.add($.i(0xdc00), $.and($.sub($.l(CP), $.i(0x10000)), $.i(0x3ff))));
            $.bump(Q);
          },
          () => {
            $.run(this.fNbufPut, $.l(Q), $.l(CP));
            $.bump(Q);
          },
        );
      });
      $.if($.not($.l(Q)), () => $.ret($.i(1)));
      $.put(S, $.anew(this.strT, $.l(Q)));
      $.do($.l(S), $.i(0), this.gg($, "nbuf"), $.i(0), $.l(Q));
      $.c.arrayCopy(this.strT, this.strT);
      this.gs($, "nameStr", $.l(S));
      this.gs($, "nameNext", $.add($.l(P), $.i(1)));
      $.ret($.i(0));
    });
  }

  private get fStrEq(): number {
    return this.fn("strEq", [this.ref(this.strT), this.ref(this.strT)], [I32], ($) => {
      const A_ = 0;
      const B_ = 1;
      const I = $.local(I32);
      $.if($.ne($.alen($.l(A_)), $.alen($.l(B_))), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.alen($.l(A_)), () => {
        $.if($.ne($.agetU(this.strT, $.l(A_), $.l(I)), $.agetU(this.strT, $.l(B_), $.l(I))), () => $.ret($.i(0)));
      });
      $.ret($.i(1));
    });
  }

  /** re_parse_captures / regex-parser.ts scanCaptures. The total capture
   * count; scanHasNamed; with a target, its matching indices into match. */
  private get fScanCaptures(): number {
    return this.fn("scanCaptures", [this.ref(this.strT)], [I32], ($) => {
      const TARGET = 0;
      const CI = $.local(I32);
      const P = $.local(I32);
      const CC = $.local(I32);
      const P3 = $.local(I32);
      $.put(CI, $.i(1));
      this.gs($, "scanHasNamed", $.i(0));
      this.gs($, "matchCount", $.i(0));
      $.loop((brk, cont) => {
        $.if($.ge($.l(P), this.gg($, "len")), () => $.br(brk));
        $.put(CC, this.ch($, $.l(P)));
        $.if($.eq($.l(CC), $.i(C("("))), () => {
          $.if(
            $.eq(this.ch($, $.add($.l(P), $.i(1))), $.i(C("?"))),
            () => {
              $.put(P3, this.ch($, $.add($.l(P), $.i(3))));
              $.if($.both($.eq(this.ch($, $.add($.l(P), $.i(2))), $.i(C("<"))), $.both($.ne($.l(P3), $.i(C("="))), $.ne($.l(P3), $.i(C("!"))))), () => {
                this.gs($, "scanHasNamed", $.i(1));
                $.if($.notNull($.l(TARGET)), () => {
                  $.if($.not($.call(this.fGroupName, $.add($.l(P), $.i(3)))), () => {
                    $.if($.call(this.fStrEq, this.gg($, "nameStr"), $.l(TARGET)), () => {
                      this.gs($, "match", $.call(this.fI32Push2, this.gg($, "match"), this.gg($, "matchCount"), $.l(CI), $.i(0)));
                      this.gs($, "matchCount", $.add(this.gg($, "matchCount"), $.i(1)));
                    });
                  });
                });
                $.bump(CI);
                $.if($.ge($.l(CI), $.i(CAPTURE_COUNT_MAX)), () => $.br(brk));
              });
            },
            () => {
              $.bump(CI);
              $.if($.ge($.l(CI), $.i(CAPTURE_COUNT_MAX)), () => $.br(brk));
            },
          );
          $.bump(P);
          $.br(cont);
        });
        $.if($.eq($.l(CC), $.i(0x5c)), () => {
          $.bump(P, 2);
          $.br(cont);
        });
        $.if($.eq($.l(CC), $.i(C("["))), () => {
          $.bump(P);
          $.while($.andThen($.lt($.l(P), this.gg($, "len")), $.ne(this.ch($, $.l(P)), $.i(C("]")))), () => {
            $.if($.eq(this.ch($, $.l(P)), $.i(0x5c)), () => $.bump(P));
            $.bump(P);
          });
          $.bump(P);
          $.br(cont);
        });
        $.bump(P);
      });
      $.ret($.l(CI));
    });
  }

  private totalCaptures($: RA): X {
    return $.call(this.fTotalCaptures);
  }
  private get fTotalCaptures(): number {
    return this.fn("totalCaptures", [], [I32], ($) => {
      $.if($.lt(this.gg($, "totalCap"), $.i(0)), () => {
        this.gs($, "totalCap", $.call(this.fScanCaptures, $.nul(this.strT)));
        this.gs($, "hasNamed", this.gg($, "scanHasNamed"));
      });
      $.ret(this.gg($, "totalCap"));
    });
  }
  private hasNamed($: RA): X {
    return () => {
      $.drop(this.totalCaptures($));
      this.gg($, "hasNamed")();
    };
  }

  /* ── digits ─────────────────────────────────────────────────────── */

  /** parse_digits(.., true): clamps at INT32_MAX; sets digNext. */
  private get fDigitsClamped(): number {
    return this.fn("digitsClamped", [I32], [I32], ($) => {
      const P = 0;
      const V = $.local(I32);
      const D = $.local(I32);
      $.loop((brk) => {
        $.put(D, this.ch($, $.l(P)));
        $.if($.not(this.isDigit($, $.l(D))), () => $.br(brk));
        $.put(D, $.sub($.l(D), $.i(0x30)));
        $.if(
          $.or($.gt($.l(V), $.i(214748364)), $.both($.eq($.l(V), $.i(214748364)), $.ge($.l(D), $.i(7)))),
          () => $.put(V, $.i(0x7fffffff)),
          () => $.put(V, $.add($.mul($.l(V), $.i(10)), $.l(D))),
        );
        $.bump(P);
      });
      this.gs($, "digNext", $.l(P));
      $.ret($.l(V));
    });
  }

  /** parse_digits(.., false): -1 on overflow; sets digNext. */
  private get fDigitsSigned(): number {
    return this.fn("digitsSigned", [I32], [I32], ($) => {
      const P = 0;
      const V = $.local(I32);
      const D = $.local(I32);
      $.loop((brk) => {
        $.put(D, this.ch($, $.l(P)));
        $.if($.not(this.isDigit($, $.l(D))), () => $.br(brk));
        $.put(D, $.sub($.l(D), $.i(0x30)));
        $.if($.or($.gt($.l(V), $.i(214748364)), $.both($.eq($.l(V), $.i(214748364)), $.ge($.l(D), $.i(7)))), () => {
          this.gs($, "digNext", $.l(P));
          $.ret($.i(-1));
        });
        $.put(V, $.add($.mul($.l(V), $.i(10)), $.l(D)));
        $.bump(P);
      });
      this.gs($, "digNext", $.l(P));
      $.ret($.l(V));
    });
  }

  /** looksLikeQuantifierBrace: {digits}, {digits,} or {digits,digits}. */
  private get fLooksLikeQuant(): number {
    return this.fn("looksLikeQuant", [I32], [I32], ($) => {
      const P = 0;
      $.bump(P);
      $.if($.not(this.isDigit($, this.ch($, $.l(P)))), () => $.ret($.i(0)));
      $.while(this.isDigit($, this.ch($, $.l(P))), () => $.bump(P));
      $.if($.eq(this.ch($, $.l(P)), $.i(C(","))), () => {
        $.bump(P);
        $.while(this.isDigit($, this.ch($, $.l(P))), () => $.bump(P));
      });
      $.ret($.eq(this.ch($, $.l(P)), $.i(C("}"))));
    });
  }

  /** The quantifier suffix (regex-parser.ts parseQuantifier): status;
   * qPresent 0 for none (pos untouched), else qMin/qMax/qInf/qGreedy. */
  private get fQuantifier(): number {
    return this.fn("quantifier", [], [I32], ($) => {
      const P = $.local(I32);
      const CC = $.local(I32);
      const MIN = $.local(I32);
      const MAX = $.local(I32);
      const INF = $.local(I32);
      const GREEDY = $.local(I32);
      this.gs($, "qPresent", $.i(0));
      $.put(P, this.gg($, "pos"));
      $.put(CC, this.ch($, $.l(P)));
      $.put(GREEDY, $.i(1));
      $.loop((brk) => {
        $.if($.eq($.l(CC), $.i(C("*"))), () => {
          $.bump(P);
          $.put(INF, $.i(1));
          $.br(brk);
        });
        $.if($.eq($.l(CC), $.i(C("+"))), () => {
          $.bump(P);
          $.put(MIN, $.i(1));
          $.put(INF, $.i(1));
          $.br(brk);
        });
        $.if($.eq($.l(CC), $.i(C("?"))), () => {
          $.bump(P);
          $.put(MAX, $.i(1));
          $.br(brk);
        });
        $.if($.ne($.l(CC), $.i(C("{"))), () => $.ret($.i(0)));
        $.if($.not(this.isDigit($, this.ch($, $.add($.l(P), $.i(1))))), () => {
          $.if(this.gg($, "uni"), () => $.ret($.i(RX.INCOMPLETE_QUANT)));
          $.ret($.i(0));
        });
        $.bump(P);
        $.put(MIN, $.call(this.fDigitsClamped, $.l(P)));
        $.put(P, this.gg($, "digNext"));
        $.put(MAX, $.l(MIN));
        $.if($.eq(this.ch($, $.l(P)), $.i(C(","))), () => {
          $.bump(P);
          $.if(
            this.isDigit($, this.ch($, $.l(P))),
            () => {
              $.put(MAX, $.call(this.fDigitsClamped, $.l(P)));
              $.put(P, this.gg($, "digNext"));
            },
            () => $.put(INF, $.i(1)),
          );
        });
        // V8 checks the closing brace before the bounds' order: `a{2,1`
        // is a literal without /u (libregexp and regex-parser.ts report
        // the order first) and "Incomplete quantifier" with it.
        $.if($.ne(this.ch($, $.l(P)), $.i(C("}"))), () => {
          $.if($.not(this.gg($, "uni")), () => $.ret($.i(0)));
          $.ret($.i(RX.INCOMPLETE_QUANT));
        });
        $.if($.both($.not($.l(INF)), $.lt($.l(MAX), $.l(MIN))), () => $.ret($.i(RX.NUM_ORDER)));
        $.bump(P);
        $.br(brk);
      });
      $.if($.eq(this.ch($, $.l(P)), $.i(C("?"))), () => {
        $.bump(P);
        $.put(GREEDY, $.i(0));
      });
      this.gs($, "pos", $.l(P));
      this.gs($, "qPresent", $.i(1));
      this.gs($, "qMin", $.l(MIN));
      this.gs($, "qMax", $.l(MAX));
      this.gs($, "qInf", $.l(INF));
      this.gs($, "qGreedy", $.l(GREEDY));
      $.ret($.i(0));
    });
  }

  /** emitQuantifier (regex-assembler.ts) over the atom at
   * [atomStart, bcSize), whose captures are [capBefore, capCount). */
  private get fEmitQuant(): number {
    return this.fn("emitQuant", [I32, I32], [], ($) => {
      const ATOM = 0;
      const CAPB = 1;
      const BITS = $.local(I32);
      const NCA = $.local(I32);
      const NCI = $.local(I32);
      const HAS_CAPS = $.local(I32);
      const WRAP = $.local(I32);
      const LEN = $.local(I32);
      const MIN = $.local(I32);
      const MAX = $.local(I32);
      const INF = $.local(I32);
      const GREEDY = $.local(I32);
      const POS = $.local(I32);
      const LAS = $.local(I32);
      const TP = $.local(I32);
      const MAXU = $.local(I32);
      const EFF = $.local(I32);
      const p8 = (p: X, v: X): void => $.run(this.fPatch8, p, v);
      const p32 = (p: X, v: X): void => $.run(this.fPatch32, p, v);
      const saveReset = (at: X): void => {
        $.run(this.fInsert, at, $.i(3));
        p8(at, $.i(REOP.save_reset));
        p8($.add(at, $.i(1)), $.l(CAPB));
        p8($.add(at, $.i(2)), $.sub(this.gg($, "capCount"), $.i(1)));
      };
      const jumpBack = (op: X, target: X): void => {
        this.e8($, op);
        $.put(TP, this.gg($, "bcSize"));
        $.run(this.fEmit32, $.i(0));
        p32($.l(TP), $.sub(target, $.add($.l(TP), $.i(4))));
      };
      $.put(MIN, this.gg($, "qMin"));
      $.put(MAX, this.gg($, "qMax"));
      $.put(INF, this.gg($, "qInf"));
      $.put(GREEDY, this.gg($, "qGreedy"));
      $.put(BITS, $.call(this.fNeedCheckAdv, $.l(ATOM), this.gg($, "bcSize")));
      $.put(NCA, $.and($.l(BITS), $.i(1)));
      $.put(NCI, $.shrU($.l(BITS), $.i(1)));
      $.put(HAS_CAPS, $.gt(this.gg($, "capCount"), $.l(CAPB)));
      $.put(WRAP, $.l(ATOM));
      $.if($.both($.l(NCI), $.l(HAS_CAPS)), () => saveReset($.l(ATOM)));
      $.if(
        $.not($.l(MIN)),
        () => {
          $.if($.both($.not($.l(NCI)), $.l(HAS_CAPS)), () => {
            saveReset($.l(WRAP));
            $.bump(WRAP, 3);
          });
          $.put(LEN, $.sub(this.gg($, "bcSize"), $.l(WRAP)));
          $.if(
            $.both($.not($.l(INF)), $.not($.l(MAX))),
            () => this.gs($, "bcSize", $.l(ATOM)),
            () =>
              $.if(
                $.or($.l(INF), $.eq($.l(MAX), $.i(1))),
                () => {
                  $.run(this.fInsert, $.l(WRAP), $.add($.i(5), $.mul($.l(NCA), $.i(2))));
                  p8($.l(WRAP), $.add($.i(REOP.split_goto_first), $.l(GREEDY)));
                  p32($.add($.l(WRAP), $.i(1)), $.add($.add($.l(LEN), $.mul($.l(INF), $.i(5))), $.mul($.l(NCA), $.i(4))));
                  $.if($.l(NCA), () => {
                    p8($.add($.l(WRAP), $.i(5)), $.i(REOP.set_char_pos));
                    p8($.add($.l(WRAP), $.i(6)), $.i(0));
                    this.e8($, $.i(REOP.check_advance));
                    this.e8($, $.i(0));
                  });
                  $.if($.l(INF), () => jumpBack($.i(REOP.goto), $.l(WRAP)));
                },
                () => {
                  $.run(this.fInsert, $.l(WRAP), $.add($.i(11), $.mul($.l(NCA), $.i(2))));
                  $.put(POS, $.l(WRAP));
                  p8($.l(POS), $.add($.i(REOP.split_goto_first), $.l(GREEDY)));
                  $.bump(POS);
                  p32($.l(POS), $.add($.add($.i(6 + 10), $.mul($.l(NCA), $.i(2))), $.l(LEN)));
                  $.bump(POS, 4);
                  p8($.l(POS), $.i(REOP.set_i32));
                  $.bump(POS);
                  p8($.l(POS), $.i(0));
                  $.bump(POS);
                  p32($.l(POS), $.l(MAX));
                  $.bump(POS, 4);
                  $.put(LAS, $.l(POS));
                  $.if($.l(NCA), () => {
                    p8($.l(POS), $.i(REOP.set_char_pos));
                    $.bump(POS);
                    p8($.l(POS), $.i(0));
                    $.bump(POS);
                  });
                  this.e8($, $.sub($.sel(I32, $.l(NCA), $.i(REOP.loop_check_adv_split_next_first), $.i(REOP.loop_split_next_first)), $.l(GREEDY)));
                  this.e8($, $.i(0));
                  $.run(this.fEmit32, $.l(MAX));
                  $.put(TP, this.gg($, "bcSize"));
                  $.run(this.fEmit32, $.i(0));
                  p32($.l(TP), $.sub($.l(LAS), $.add($.l(TP), $.i(4))));
                },
              ),
          );
        },
        () =>
          $.if(
            $.both($.both($.eq($.l(MIN), $.i(1)), $.l(INF)), $.not($.l(NCA))),
            () => jumpBack($.sub($.i(REOP.split_next_first), $.l(GREEDY)), $.l(WRAP)),
            () => {
              $.put(MAXU, $.sel(I32, $.l(INF), $.i(0x7fffffff), $.l(MAX)));
              $.put(EFF, $.l(NCA));
              $.if($.both($.not($.l(INF)), $.eq($.l(MIN), $.l(MAX))), () => $.put(EFF, $.i(0)));
              $.run(this.fInsert, $.l(WRAP), $.add($.i(6), $.mul($.l(EFF), $.i(2))));
              $.put(POS, $.l(WRAP));
              p8($.l(POS), $.i(REOP.set_i32));
              $.bump(POS);
              p8($.l(POS), $.i(0));
              $.bump(POS);
              p32($.l(POS), $.l(MAXU));
              $.bump(POS, 4);
              $.put(LAS, $.l(POS));
              $.if($.l(EFF), () => {
                p8($.l(POS), $.i(REOP.set_char_pos));
                $.bump(POS);
                p8($.l(POS), $.i(0));
                $.bump(POS);
              });
              $.if(
                $.both($.not($.l(INF)), $.eq($.l(MIN), $.l(MAX))),
                () => {
                  this.e8($, $.i(REOP.loop));
                  this.e8($, $.i(0));
                  $.put(TP, this.gg($, "bcSize"));
                  $.run(this.fEmit32, $.i(0));
                  p32($.l(TP), $.sub($.l(LAS), $.add($.l(TP), $.i(4))));
                },
                () => {
                  this.e8($, $.sub($.sel(I32, $.l(EFF), $.i(REOP.loop_check_adv_split_next_first), $.i(REOP.loop_split_next_first)), $.l(GREEDY)));
                  this.e8($, $.i(0));
                  $.run(this.fEmit32, $.sub($.l(MAXU), $.l(MIN)));
                  $.put(TP, this.gg($, "bcSize"));
                  $.run(this.fEmit32, $.i(0));
                  p32($.l(TP), $.sub($.l(LAS), $.add($.l(TP), $.i(4))));
                },
              );
            },
          ),
      );
    });
  }

  /* ── terms ──────────────────────────────────────────────────────── */

  private prevIf($: RA, back: number): void {
    $.if($.l(back), () => this.e8($, $.i(REOP.prev)));
  }

  /** A flag-scoped atom whose encoding differs from what the top-level
   * flags would give marks the pattern as using a modifier group
   * (regex-disposition.ts usesModifierGroup). */
  private modIf($: RA, differs: X): void {
    $.if(differs, () => this.gs($, "modUsed", $.i(1)));
  }

  /** A literal character atom (canonicalized under /i). Status. */
  private get fEmitLiteral(): number {
    return this.fn("emitLiteral", [I32, I32], [I32], ($) => {
      const CP = 0;
      const BACK = 1;
      this.prevIf($, BACK);
      $.if(this.gg($, "ic"), () => {
        $.if(this.gg($, "uni"), () => $.ret($.i(fenceId("modifiers"))));
        $.put(CP, $.call(this.canonFn(), $.l(CP)));
      });
      $.if(
        $.le($.l(CP), $.i(0xffff)),
        () => {
          this.e8($, $.sel(I32, this.gg($, "ic"), $.i(REOP.char_i), $.i(REOP.char)));
          $.run(this.fEmit16, $.l(CP));
        },
        () => {
          this.e8($, $.sel(I32, this.gg($, "ic"), $.i(REOP.char32_i), $.i(REOP.char32)));
          $.run(this.fEmit32, $.l(CP));
        },
      );
      this.prevIf($, BACK);
      this.modIf($, $.ne(this.gg($, "ic"), this.gg($, "topIc")));
      this.gs($, "termKind", $.i(K_ATOM));
      $.ret($.i(0));
    });
  }

  /** parseClassAtomTerm: a class atom outside brackets. Status. */
  private get fClassAtomTerm(): number {
    return this.fn("classAtomTerm", [I32, I32], [I32], ($) => {
      const P = 0;
      const BACK = 1;
      const ST = $.local(I32);
      const D = $.local(I32);
      const CR = $.local(this.crRef());
      this.chk($, ST, $.call(this.fClassAtom, $.l(P), $.i(0)));
      this.gs($, "pos", this.gg($, "aNext"));
      $.if($.not(this.gg($, "aKind")), () => $.ret($.call(this.fEmitLiteral, this.gg($, "aCp"), $.l(BACK))));
      this.prevIf($, BACK);
      $.put(D, this.gg($, "aDsw"));
      $.put(CR, this.gg($, "aCr"));
      $.if(
        $.eq($.l(D), $.i(C("s"))),
        () => this.e8($, $.i(REOP.space)),
        () =>
          $.if(
            $.eq($.l(D), $.i(C("S"))),
            () => this.e8($, $.i(REOP.not_space)),
            () => {
              $.if($.both($.not($.l(D)), this.gg($, "ic")), () => {
                $.if(this.gg($, "uni"), () => $.ret($.i(fenceId("modifiers"))));
                $.put(CR, $.call(this.fCaseClose, $.l(CR)));
              });
              this.chk($, ST, $.call(this.fEmitRange, $.l(CR), this.gg($, "ic")));
            },
          ),
      );
      this.prevIf($, BACK);
      this.modIf($, $.ne(this.gg($, "ic"), this.gg($, "topIc")));
      this.gs($, "termKind", $.i(K_ATOM));
      $.ret($.i(0));
    });
  }

  private emitBackrefOp($: RA, back: number): void {
    this.e8($, $.add($.add($.i(REOP.back_reference), $.mul($.l(back), $.i(2))), this.gg($, "ic")));
  }

  /** \k<name> (regex-parser.ts parseNamedBackref), `p` at the backslash. */
  private get fNamedBackref(): number {
    return this.fn("namedBackref", [I32, I32], [I32], ($) => {
      const P = 0;
      const BACK = 1;
      const NAME = $.local(this.ref(this.strT));
      const NEXT = $.local(I32);
      const I = $.local(I32);
      const GN = $.local(I32);
      const strict = (): X => $.or(this.gg($, "uni"), this.hasNamed($));
      $.if($.ne(this.ch($, $.add($.l(P), $.i(2))), $.i(C("<"))), () => {
        $.if(strict(), () => $.ret($.i(RX.INVALID_NAMED_REF)));
        $.ret($.call(this.fClassAtomTerm, $.l(P), $.l(BACK)));
      });
      $.put(GN, $.call(this.fGroupName, $.add($.l(P), $.i(3))));
      $.if($.l(GN), () => {
        $.if(strict(), () => $.ret($.sel(I32, $.eq($.l(GN), $.i(2)), $.i(RX.INVALID_UNICODE_ESCAPE), $.i(RX.INVALID_CAP_NAME))));
        $.ret($.call(this.fClassAtomTerm, $.l(P), $.l(BACK)));
      });
      $.put(NAME, this.gg($, "nameStr"));
      $.put(NEXT, this.gg($, "nameNext"));
      $.drop($.call(this.fScanCaptures, $.l(NAME)));
      this.gs($, "termKind", $.i(K_ATOM));
      $.if($.not(this.gg($, "matchCount")), () => {
        $.if($.or(this.gg($, "uni"), this.gg($, "scanHasNamed")), () => {
          // V8 reports an undefined name after the whole pattern parsed.
          this.gs($, "deferredK", $.i(1));
          this.gs($, "pos", $.l(NEXT));
          this.emitBackrefOp($, BACK);
          this.e8($, $.i(0));
          $.ret($.i(0));
        });
        $.ret($.call(this.fClassAtomTerm, $.l(P), $.l(BACK)));
      });
      this.gs($, "pos", $.l(NEXT));
      this.emitBackrefOp($, BACK);
      this.e8($, this.gg($, "matchCount"));
      $.for(I, $.i(0), this.gg($, "matchCount"), () => this.e8($, $.aget(this.crT, this.gg($, "match"), $.l(I))));
      $.ret($.i(0));
    });
  }

  /** \0 (regex-parser.ts parseZeroEscape). */
  private get fZeroEscape(): number {
    return this.fn("zeroEscape", [I32, I32], [I32], ($) => {
      const BS = 0;
      const BACK = 1;
      const P = $.local(I32);
      const CV = $.local(I32);
      const D = $.local(I32);
      $.put(P, $.add($.l(BS), $.i(2)));
      $.if(
        this.gg($, "uni"),
        () => $.if(this.isDigit($, this.ch($, $.l(P))), () => $.ret($.i(RX.INVALID_DECIMAL_ESCAPE))),
        () => {
          $.put(D, this.ch($, $.l(P)));
          $.if($.inR($.l(D), 0x30, 0x37), () => {
            $.put(CV, $.sub($.l(D), $.i(0x30)));
            $.bump(P);
            $.put(D, this.ch($, $.l(P)));
            $.if($.inR($.l(D), 0x30, 0x37), () => {
              $.put(CV, $.add($.shl($.l(CV), $.i(3)), $.sub($.l(D), $.i(0x30))));
              $.bump(P);
            });
          });
        },
      );
      this.gs($, "pos", $.l(P));
      $.ret($.call(this.fEmitLiteral, $.l(CV), $.l(BACK)));
    });
  }

  /** \1-\9 (regex-parser.ts parseNumberedBackrefOrOctal). */
  private get fNumberedBackref(): number {
    return this.fn("numberedBackref", [I32, I32], [I32], ($) => {
      const BS = 0;
      const BACK = 1;
      const DS = $.local(I32);
      const V = $.local(I32);
      const P = $.local(I32);
      const CV = $.local(I32);
      const D = $.local(I32);
      $.put(DS, $.add($.l(BS), $.i(1)));
      $.put(V, $.call(this.fDigitsSigned, $.l(DS)));
      $.put(P, this.gg($, "digNext"));
      $.if($.both($.ge($.l(V), $.i(0)), $.lt($.l(V), this.totalCaptures($))), () => {
        this.gs($, "pos", $.l(P));
        this.emitBackrefOp($, BACK);
        this.e8($, $.i(1));
        this.e8($, $.l(V));
        this.gs($, "termKind", $.i(K_ATOM));
        $.ret($.i(0));
      });
      $.if(this.gg($, "uni"), () => $.ret($.i(RX.INVALID_ESCAPE)));
      $.put(P, $.l(DS));
      $.put(D, this.ch($, $.l(P)));
      $.if(
        $.le($.l(D), $.i(C("7"))),
        () => {
          $.if($.le($.l(D), $.i(C("3"))), () => {
            $.put(CV, $.sub($.l(D), $.i(0x30)));
            $.bump(P);
          });
          $.put(D, this.ch($, $.l(P)));
          $.if($.inR($.l(D), 0x30, 0x37), () => {
            $.put(CV, $.add($.shl($.l(CV), $.i(3)), $.sub($.l(D), $.i(0x30))));
            $.bump(P);
            $.put(D, this.ch($, $.l(P)));
            $.if($.inR($.l(D), 0x30, 0x37), () => {
              $.put(CV, $.add($.shl($.l(CV), $.i(3)), $.sub($.l(D), $.i(0x30))));
              $.bump(P);
            });
          });
        },
        () => {
          $.put(CV, $.l(D));
          $.bump(P);
        },
      );
      this.gs($, "pos", $.l(P));
      $.ret($.call(this.fEmitLiteral, $.l(CV), $.l(BACK)));
    });
  }

  /** A capturing group (named when `named`, its name in nameStr). */
  private get fCapture(): number {
    return this.fn("capture", [I32, I32, I32], [I32], ($) => {
      const START = 0;
      const BACK = 1;
      const NAMED = 2;
      const IDX = $.local(I32);
      const ST = $.local(I32);
      const K = $.local(I32);
      const J = $.local(I32);
      const NAME = $.local(this.ref(this.strT));
      const SV = this.stateLocals($);
      $.if($.ge(this.gg($, "capCount"), $.i(CAPTURE_COUNT_MAX)), () => $.ret($.i(fenceId("too-many-captures"))));
      $.put(IDX, this.gg($, "capCount"));
      this.gs($, "capCount", $.add($.l(IDX), $.i(1)));
      this.stateOpen($, SV, $.l(IDX));
      $.if($.l(NAMED), () => {
        $.put(NAME, this.gg($, "nameStr"));
        $.aset(this.nameArrT, this.gg($, "names"), $.l(IDX), $.l(NAME));
        $.aset(this.crT, this.gg($, "nameScope"), $.l(IDX), this.gg($, "scope"));
      });
      this.gs($, "pos", $.l(START));
      this.e8($, $.sel(I32, $.l(BACK), $.i(REOP.save_end), $.i(REOP.save_start)));
      this.e8($, $.l(IDX));
      this.chk($, ST, $.call(this.fDisjunction, $.l(BACK)));
      $.if($.ne(this.ch($, this.gg($, "pos")), $.i(C(")"))), () => $.ret($.i(RX.UNTERMINATED_GROUP)));
      this.gs($, "pos", $.add(this.gg($, "pos"), $.i(1)));
      this.e8($, $.sel(I32, $.l(BACK), $.i(REOP.save_start), $.i(REOP.save_end)));
      this.e8($, $.l(IDX));
      $.if($.l(NAMED), () => {
        // V8 (CreateNamedCaptureAtIndex) checks a duplicate name when the
        // group CLOSES, against the groups already registered: one of the
        // same name is allowed only when its index lies in this group's
        // non-participating interval (see stateOpen / fDisjunction) — V8's
        // approximation of ES2025's "different alternatives" rule, followed
        // as V8 has it (it accepts `(?<a>y)(?:z|(?<a>w))`).
        $.for(J, $.i(1), this.gg($, "capCount"), () => {
          $.if(
            $.andThen(
              $.andThen($.aget(this.crT, this.gg($, "closed"), $.l(J)), $.notNull($.aget(this.nameArrT, this.gg($, "names"), $.l(J)))),
              $.andThen(
                $.call(this.fStrEq, $.aget(this.nameArrT, this.gg($, "names"), $.l(J)), $.l(NAME)),
                $.or($.lt($.l(J), this.gg($, "stFirst")), $.gt($.l(J), this.gg($, "stSecond"))),
              ),
            ),
            () => $.ret($.i(RX.DUP_NAME)),
          );
        });
      });
      $.aset(this.crT, this.gg($, "closed"), $.l(IDX), $.i(1));
      this.stateClose($, SV);
      this.gs($, "termKind", $.i(K_ATOM));
      $.ret($.i(0));
    });
  }

  /** A group opens a V8 parser state: its capture index (its own index
   * for a capturing group, else the captures started so far) and the
   * enclosing state's non-participating interval, inherited. The caller
   * keeps the enclosing state in `saved` and restores it with stateClose. */
  private stateOpen($: RA, saved: [number, number, number], capIdx: X): void {
    $.put(saved[0], this.gg($, "stFirst"));
    $.put(saved[1], this.gg($, "stSecond"));
    $.put(saved[2], this.gg($, "stCap"));
    this.gs($, "stCap", capIdx);
  }
  private stateClose($: RA, saved: [number, number, number]): void {
    this.gs($, "stFirst", $.l(saved[0]));
    this.gs($, "stSecond", $.l(saved[1]));
    this.gs($, "stCap", $.l(saved[2]));
  }
  private stateLocals($: RA): [number, number, number] {
    return [$.local(I32), $.local(I32), $.local(I32)];
  }

  /** Lookahead / lookbehind; `pos` already past the opener. */
  private get fLookaround(): number {
    return this.fn("lookaround", [I32, I32], [I32], ($) => {
      const NEG = 0;
      const BACKWARD = 1;
      const JP = $.local(I32);
      const ST = $.local(I32);
      const SV = this.stateLocals($);
      this.e8($, $.add($.i(REOP.lookahead), $.l(NEG)));
      $.put(JP, this.gg($, "bcSize"));
      $.run(this.fEmit32, $.i(0));
      this.stateOpen($, SV, $.sub(this.gg($, "capCount"), $.i(1)));
      this.chk($, ST, $.call(this.fDisjunction, $.l(BACKWARD)));
      this.stateClose($, SV);
      $.if($.ne(this.ch($, this.gg($, "pos")), $.i(C(")"))), () => $.ret($.i(RX.UNTERMINATED_GROUP)));
      this.gs($, "pos", $.add(this.gg($, "pos"), $.i(1)));
      this.e8($, $.add($.i(REOP.lookahead_match), $.l(NEG)));
      $.run(this.fPatch32, $.l(JP), $.sub(this.gg($, "bcSize"), $.add($.l(JP), $.i(4))));
      this.gs($, "termKind", $.sel(I32, $.or($.l(BACKWARD), this.gg($, "uni")), $.i(K_LOOK_NQ), $.i(K_LOOK_Q)));
      $.ret($.i(0));
    });
  }

  /** re_parse_modifiers: the mask (i=1, m=2, s=4) or -1 on a repeat; sets
   * digNext to the first unconsumed index. */
  private get fModifiers(): number {
    return this.fn("modifiers", [I32], [I32], ($) => {
      const P = 0;
      const MASK = $.local(I32);
      const V = $.local(I32);
      const CC = $.local(I32);
      $.loop((brk) => {
        $.put(CC, this.ch($, $.l(P)));
        $.put(V, $.i(0));
        $.if($.eq($.l(CC), $.i(C("i"))), () => $.put(V, $.i(1)));
        $.if($.eq($.l(CC), $.i(C("m"))), () => $.put(V, $.i(2)));
        $.if($.eq($.l(CC), $.i(C("s"))), () => $.put(V, $.i(4)));
        $.if($.not($.l(V)), () => $.br(brk));
        $.if($.and($.l(MASK), $.l(V)), () => $.ret($.i(-1)));
        $.put(MASK, $.or($.l(MASK), $.l(V)));
        $.bump(P);
      });
      this.gs($, "digNext", $.l(P));
      $.ret($.l(MASK));
    });
  }

  private get fModifierGroup(): number {
    return this.fn("modifierGroup", [I32, I32], [I32], ($) => {
      const OPEN = 0;
      const BACK = 1;
      const P = $.local(I32);
      const ADD = $.local(I32);
      const REM = $.local(I32);
      const SIC = $.local(I32);
      const SML = $.local(I32);
      const SDA = $.local(I32);
      const ST = $.local(I32);
      const SV = this.stateLocals($);
      const upd = (name: string, bit: number): void => {
        $.if($.and($.l(ADD), $.i(bit)), () => this.gs($, name, $.i(1)));
        $.if($.and($.l(REM), $.i(bit)), () => this.gs($, name, $.i(0)));
      };
      // V8's order: a repeated flag (within a side, or on both sides) and a
      // second dash as the flags are scanned; then a missing ':' ("Invalid
      // group"); then no flag at all ("Invalid flag group").
      $.put(ADD, $.call(this.fModifiers, $.add($.l(OPEN), $.i(2))));
      $.if($.lt($.l(ADD), $.i(0)), () => $.ret($.i(RX.REPEATED_FLAG)));
      $.put(P, this.gg($, "digNext"));
      $.if($.eq(this.ch($, $.l(P)), $.i(C("-"))), () => {
        $.put(REM, $.call(this.fModifiers, $.add($.l(P), $.i(1))));
        $.if($.lt($.l(REM), $.i(0)), () => $.ret($.i(RX.REPEATED_FLAG)));
        $.put(P, this.gg($, "digNext"));
        $.if($.and($.l(ADD), $.l(REM)), () => $.ret($.i(RX.REPEATED_FLAG)));
        $.if($.eq(this.ch($, $.l(P)), $.i(C("-"))), () => $.ret($.i(RX.MULTIPLE_DASHES)));
      });
      $.if($.ne(this.ch($, $.l(P)), $.i(C(":"))), () => $.ret($.i(RX.INVALID_GROUP)));
      $.if($.both($.not($.l(ADD)), $.not($.l(REM))), () => $.ret($.i(RX.INVALID_FLAG_GROUP)));
      $.put(SIC, this.gg($, "ic"));
      $.put(SML, this.gg($, "ml"));
      $.put(SDA, this.gg($, "da"));
      upd("ic", 1);
      upd("ml", 2);
      upd("da", 4);
      this.gs($, "pos", $.add($.l(P), $.i(1)));
      this.stateOpen($, SV, $.sub(this.gg($, "capCount"), $.i(1)));
      $.put(ST, $.call(this.fDisjunction, $.l(BACK)));
      this.stateClose($, SV);
      this.gs($, "ic", $.l(SIC));
      this.gs($, "ml", $.l(SML));
      this.gs($, "da", $.l(SDA));
      $.if($.l(ST), () => $.ret($.l(ST)));
      $.if($.ne(this.ch($, this.gg($, "pos")), $.i(C(")"))), () => $.ret($.i(RX.UNTERMINATED_GROUP)));
      this.gs($, "pos", $.add(this.gg($, "pos"), $.i(1)));
      this.gs($, "termKind", $.i(K_ATOM));
      $.ret($.i(0));
    });
  }

  /** The '(' dispatch (regex-parser.ts parseGroup). */
  private get fGroup(): number {
    return this.fn("group", [I32, I32], [I32], ($) => {
      const OPEN = 0;
      const BACK = 1;
      const P2 = $.local(I32);
      const P3 = $.local(I32);
      const ST = $.local(I32);
      const SV = this.stateLocals($);
      $.if($.ne(this.ch($, $.add($.l(OPEN), $.i(1))), $.i(C("?"))), () => $.ret($.call(this.fCapture, $.add($.l(OPEN), $.i(1)), $.l(BACK), $.i(0))));
      $.put(P2, this.ch($, $.add($.l(OPEN), $.i(2))));
      $.if($.eq($.l(P2), $.i(C(":"))), () => {
        this.gs($, "pos", $.add($.l(OPEN), $.i(3)));
        this.stateOpen($, SV, $.sub(this.gg($, "capCount"), $.i(1)));
        this.chk($, ST, $.call(this.fDisjunction, $.l(BACK)));
        this.stateClose($, SV);
        $.if($.ne(this.ch($, this.gg($, "pos")), $.i(C(")"))), () => $.ret($.i(RX.UNTERMINATED_GROUP)));
        this.gs($, "pos", $.add(this.gg($, "pos"), $.i(1)));
        this.gs($, "termKind", $.i(K_ATOM));
        $.ret($.i(0));
      });
      $.if($.anyEq($.l(P2), [C("i"), C("m"), C("s"), C("-")]), () => $.ret($.call(this.fModifierGroup, $.l(OPEN), $.l(BACK))));
      $.if($.anyEq($.l(P2), [C("="), C("!")]), () => {
        this.gs($, "pos", $.add($.l(OPEN), $.i(3)));
        $.ret($.call(this.fLookaround, $.eq($.l(P2), $.i(C("!"))), $.i(0)));
      });
      $.put(P3, this.ch($, $.add($.l(OPEN), $.i(3))));
      $.if($.both($.eq($.l(P2), $.i(C("<"))), $.anyEq($.l(P3), [C("="), C("!")])), () => {
        this.gs($, "pos", $.add($.l(OPEN), $.i(4)));
        $.ret($.call(this.fLookaround, $.eq($.l(P3), $.i(C("!"))), $.i(1)));
      });
      $.if($.eq($.l(P2), $.i(C("<"))), () => {
        $.put(ST, $.call(this.fGroupName, $.add($.l(OPEN), $.i(3))));
        $.if($.eq($.l(ST), $.i(2)), () => $.ret($.i(RX.INVALID_UNICODE_ESCAPE)));
        $.if($.l(ST), () => $.ret($.i(RX.INVALID_CAP_NAME)));
        $.ret($.call(this.fCapture, this.gg($, "nameNext"), $.l(BACK), $.i(1)));
      });
      $.ret($.i(RX.INVALID_GROUP));
    });
  }

  /** re_parse_term's atom dispatch (regex-parser.ts parseTerm). Status;
   * termKind says whether a quantifier may follow. */
  private get fAtom(): number {
    return this.fn("atom", [I32], [I32], ($) => {
      const BACK = 0;
      const P = $.local(I32);
      const C0 = $.local(I32);
      const ESC = $.local(I32);
      const ST = $.local(I32);
      const UNI = this.gg($, "uni");
      $.put(P, this.gg($, "pos"));
      $.put(C0, this.ch($, $.l(P)));
      this.gs($, "termKind", $.i(K_ATOM));
      $.if($.anyEq($.l(C0), [C("^"), C("$")]), () => {
        this.gs($, "pos", $.add($.l(P), $.i(1)));
        $.if(
          $.eq($.l(C0), $.i(C("^"))),
          () => this.e8($, $.sel(I32, this.gg($, "ml"), $.i(REOP.line_start_m), $.i(REOP.line_start))),
          () => this.e8($, $.sel(I32, this.gg($, "ml"), $.i(REOP.line_end_m), $.i(REOP.line_end))),
        );
        this.modIf($, $.ne(this.gg($, "ml"), this.gg($, "topMl")));
        this.gs($, "termKind", $.i(K_ASSERT));
        $.ret($.i(0));
      });
      $.if($.eq($.l(C0), $.i(C("."))), () => {
        this.gs($, "pos", $.add($.l(P), $.i(1)));
        this.prevIf($, BACK);
        this.e8($, $.sel(I32, this.gg($, "da"), $.i(REOP.any), $.i(REOP.dot)));
        this.prevIf($, BACK);
        this.modIf($, $.ne(this.gg($, "da"), this.gg($, "topDa")));
        $.ret($.i(0));
      });
      $.if($.anyEq($.l(C0), [C("*"), C("+"), C("?")]), () => $.ret($.i(RX.NOTHING_TO_REPEAT)));
      $.if($.eq($.l(C0), $.i(C("{"))), () => {
        $.if(UNI, () => $.ret($.sel(I32, $.call(this.fLooksLikeQuant, $.l(P)), $.i(RX.NOTHING_TO_REPEAT), $.i(RX.LONE_QUANT))));
        $.if($.not($.call(this.fLooksLikeQuant, $.l(P))), () => $.ret($.call(this.fClassAtomTerm, $.l(P), $.l(BACK))));
        $.ret($.i(RX.NOTHING_TO_REPEAT));
      });
      $.if($.eq($.l(C0), $.i(C("("))), () => $.ret($.call(this.fGroup, $.l(P), $.l(BACK))));
      $.if($.eq($.l(C0), $.i(0x5c)), () => {
        $.put(ESC, this.ch($, $.add($.l(P), $.i(1))));
        $.if($.anyEq($.l(ESC), [C("b"), C("B")]), () => {
          this.gs($, "pos", $.add($.l(P), $.i(2)));
          $.if(
            $.eq($.l(ESC), $.i(C("b"))),
            () => this.e8($, $.sel(I32, $.both(this.gg($, "ic"), UNI), $.i(REOP.word_boundary_i), $.i(REOP.word_boundary))),
            () => this.e8($, $.sel(I32, $.both(this.gg($, "ic"), UNI), $.i(REOP.not_word_boundary_i), $.i(REOP.not_word_boundary))),
          );
          this.modIf($, $.ne($.both(this.gg($, "ic"), UNI), $.both(this.gg($, "topIc"), UNI)));
          this.gs($, "termKind", $.i(K_ASSERT));
          $.ret($.i(0));
        });
        $.if($.eq($.l(ESC), $.i(C("k"))), () => $.ret($.call(this.fNamedBackref, $.l(P), $.l(BACK))));
        $.if($.eq($.l(ESC), $.i(C("0"))), () => $.ret($.call(this.fZeroEscape, $.l(P), $.l(BACK))));
        $.if($.inR($.l(ESC), 0x31, 0x39), () => $.ret($.call(this.fNumberedBackref, $.l(P), $.l(BACK))));
        $.ret($.call(this.fClassAtomTerm, $.l(P), $.l(BACK)));
      });
      $.if($.eq($.l(C0), $.i(C("["))), () => {
        this.prevIf($, BACK);
        this.chk($, ST, $.call(this.fCharClass, $.l(P)));
        this.prevIf($, BACK);
        this.modIf($, $.ne(this.gg($, "ic"), this.gg($, "topIc")));
        this.gs($, "termKind", $.i(K_ATOM));
        $.ret($.i(0));
      });
      $.if($.anyEq($.l(C0), [C("]"), C("}")]), () => {
        $.if(UNI, () => $.ret($.i(RX.LONE_QUANT)));
      });
      $.ret($.call(this.fClassAtomTerm, $.l(P), $.l(BACK)));
    });
  }

  /** One term: an atom and its optional quantifier. */
  private get fTerm(): number {
    return this.fn("term", [I32], [I32], ($) => {
      const BACK = 0;
      const ATOM = $.local(I32);
      const CAPB = $.local(I32);
      const ST = $.local(I32);
      const KIND = $.local(I32);
      $.put(ATOM, this.gg($, "bcSize"));
      $.put(CAPB, this.gg($, "capCount"));
      this.chk($, ST, $.call(this.fAtom, $.l(BACK)));
      $.put(KIND, this.gg($, "termKind"));
      // An assertion takes no quantifier: what follows parses as the next
      // atom, where a quantifier character is "Nothing to repeat" (V8's
      // order, and libregexp's last_atom_start < 0) — `^{2,1}` included.
      $.if($.eq($.l(KIND), $.i(K_ASSERT)), () => $.ret($.i(0)));
      this.chk($, ST, $.call(this.fQuantifier));
      $.if(this.gg($, "qPresent"), () => {
        $.if($.eq($.l(KIND), $.i(K_LOOK_NQ)), () => $.ret($.i(RX.INVALID_QUANTIFIER)));
        $.if($.eq($.l(KIND), $.i(K_LOOK_Q)), () => this.gs($, "qLook", $.i(1)));
        $.run(this.fEmitQuant, $.l(ATOM), $.l(CAPB));
      });
      $.ret($.i(0));
    });
  }

  private get fAlternative(): number {
    return this.fn("alternative", [I32], [I32], ($) => {
      const BACK = 0;
      const START = $.local(I32);
      const TS = $.local(I32);
      const CC = $.local(I32);
      const ST = $.local(I32);
      $.put(START, this.gg($, "bcSize"));
      $.loop((brk) => {
        $.put(CC, this.ch($, this.gg($, "pos")));
        $.if($.anyEq($.l(CC), [-1, C("|"), C(")")]), () => $.br(brk));
        $.put(TS, this.gg($, "bcSize"));
        this.chk($, ST, $.call(this.fTerm, $.l(BACK)));
        $.if($.l(BACK), () => $.run(this.fMoveToFront, $.l(START), $.l(TS), this.gg($, "bcSize")));
      });
      $.ret($.i(0));
    });
  }

  private get fDisjunction(): number {
    return this.fn("disjunction", [I32], [I32], ($) => {
      const BACK = 0;
      const START = $.local(I32);
      const LEN = $.local(I32);
      const GP = $.local(I32);
      const ST = $.local(I32);
      this.gs($, "depth", $.add(this.gg($, "depth"), $.i(1)));
      $.if($.gt(this.gg($, "depth"), $.i(MAX_NESTING)), () => $.ret($.i(fenceId("nesting-depth"))));
      $.put(START, this.gg($, "bcSize"));
      this.chk($, ST, $.call(this.fAlternative, $.l(BACK)));
      $.while($.eq(this.ch($, this.gg($, "pos")), $.i(C("|"))), () => {
        this.gs($, "pos", $.add(this.gg($, "pos"), $.i(1)));
        $.put(LEN, $.sub(this.gg($, "bcSize"), $.l(START)));
        $.run(this.fInsert, $.l(START), $.i(5));
        $.run(this.fPatch8, $.l(START), $.i(REOP.split_next_first));
        $.run(this.fPatch32, $.add($.l(START), $.i(1)), $.add($.l(LEN), $.i(5)));
        this.e8($, $.i(REOP.goto));
        $.put(GP, this.gg($, "bcSize"));
        $.run(this.fEmit32, $.i(0));
        this.gs($, "scope", $.add(this.gg($, "scope"), $.i(1)));
        // V8's RegExpParserState::NewAlternative: the captures started so
        // far join the state's non-participating interval (extending it,
        // or starting it at the state's own capture index).
        $.if(
          this.gg($, "stSecond"),
          () => this.gs($, "stSecond", $.sub(this.gg($, "capCount"), $.i(1))),
          () => {
            this.gs($, "stFirst", this.gg($, "stCap"));
            this.gs($, "stSecond", $.sub(this.gg($, "capCount"), $.i(1)));
          },
        );
        this.chk($, ST, $.call(this.fAlternative, $.l(BACK)));
        $.run(this.fPatch32, $.l(GP), $.sub(this.gg($, "bcSize"), $.add($.l(GP), $.i(4))));
      });
      this.gs($, "depth", $.sub(this.gg($, "depth"), $.i(1)));
      $.ret($.i(0));
    });
  }

  /* ── the whole pattern ──────────────────────────────────────────── */

  /** UTF-8 of a name (UTF-16 in), appended to the bytecode. */
  private get fEmitUtf8(): number {
    return this.fn("emitUtf8", [this.ref(this.strT)], [], ($) => {
      const S = 0;
      const I = $.local(I32);
      const U = $.local(I32);
      const V = $.local(I32);
      $.while($.lt($.l(I), $.alen($.l(S))), () => {
        $.put(U, $.agetU(this.strT, $.l(S), $.l(I)));
        $.bump(I);
        $.if($.both($.inR($.l(U), 0xd800, 0xdbff), $.lt($.l(I), $.alen($.l(S)))), () => {
          $.put(V, $.agetU(this.strT, $.l(S), $.l(I)));
          $.if($.inR($.l(V), 0xdc00, 0xdfff), () => {
            $.put(U, $.add($.i(0x10000), $.add($.shl($.sub($.l(U), $.i(0xd800)), $.i(10)), $.sub($.l(V), $.i(0xdc00)))));
            $.bump(I);
          });
        });
        $.if(
          $.lt($.l(U), $.i(0x80)),
          () => this.e8($, $.l(U)),
          () =>
            $.if(
              $.lt($.l(U), $.i(0x800)),
              () => {
                this.e8($, $.or($.i(0xc0), $.shrU($.l(U), $.i(6))));
                this.e8($, $.or($.i(0x80), $.and($.l(U), $.i(0x3f))));
              },
              () =>
                $.if(
                  $.lt($.l(U), $.i(0x10000)),
                  () => {
                    this.e8($, $.or($.i(0xe0), $.shrU($.l(U), $.i(12))));
                    this.e8($, $.or($.i(0x80), $.and($.shrU($.l(U), $.i(6)), $.i(0x3f))));
                    this.e8($, $.or($.i(0x80), $.and($.l(U), $.i(0x3f))));
                  },
                  () => {
                    this.e8($, $.or($.i(0xf0), $.shrU($.l(U), $.i(18))));
                    this.e8($, $.or($.i(0x80), $.and($.shrU($.l(U), $.i(12)), $.i(0x3f))));
                    this.e8($, $.or($.i(0x80), $.and($.shrU($.l(U), $.i(6)), $.i(0x3f))));
                    this.e8($, $.or($.i(0x80), $.and($.l(U), $.i(0x3f))));
                  },
                ),
            ),
        );
      });
    });
  }

  /** Parse and assemble with the current flag globals (lre_compile's
   * shape). `strict` stops after the parse (the Annex-B re-parse). */
  private get fCore(): number {
    return this.fn("core", [I32], [I32], ($) => {
      const STRICT = 0;
      const ST = $.local(I32);
      const REGS = $.local(I32);
      const I = $.local(I32);
      const ANY = $.local(I32);
      const NM = $.local(this.ref(this.strT));
      const z = (n: string): void => this.gs($, n, $.i(0));
      for (const n of ["pos", "scope", "bcSize", "stFirst", "stSecond", "stCap", "modUsed", "qLook", "deferredK", "depth"]) z(n);
      this.gs($, "capCount", $.i(1));
      this.gs($, "totalCap", $.i(-1));
      this.gs($, "names", $.anew(this.nameArrT, $.i(CAPTURE_COUNT_MAX + 1)));
      for (const n of ["nameScope", "closed"]) this.gs($, n, $.anew(this.crT, $.i(CAPTURE_COUNT_MAX + 1)));
      $.if($.isNull(this.gg($, "bc")), () => this.gs($, "bc", $.anew(this.bufT, $.i(256))));
      $.if($.isNull(this.gg($, "match")), () => this.gs($, "match", $.anew(this.crT, $.i(16))));
      $.if($.isNull(this.gg($, "nbuf")), () => this.gs($, "nbuf", $.anew(this.strT, $.i(16))));
      // header: flags, capture count, register count, bytecode length
      $.run(
        this.fEmit16,
        $.or(
          $.or($.sel(I32, $.and(this.gg($, "flagMask"), $.i(FM.g)), $.i(LRE_FLAG_GLOBAL), $.i(0)), $.sel(I32, this.gg($, "ic"), $.i(LRE_FLAG_IGNORECASE), $.i(0))),
          $.or(
            $.or($.sel(I32, this.gg($, "ml"), $.i(LRE_FLAG_MULTILINE), $.i(0)), $.sel(I32, this.gg($, "da"), $.i(LRE_FLAG_DOTALL), $.i(0))),
            $.or($.sel(I32, this.gg($, "uni"), $.i(LRE_FLAG_UNICODE), $.i(0)), $.sel(I32, this.gg($, "sticky"), $.i(LRE_FLAG_STICKY), $.i(0))),
          ),
        ),
      );
      this.e8($, $.i(0));
      this.e8($, $.i(0));
      $.run(this.fEmit32, $.i(0));
      $.if($.not(this.gg($, "sticky")), () => {
        this.e8($, $.i(REOP.split_goto_first));
        $.run(this.fEmit32, $.i(1 + 5));
        this.e8($, $.i(REOP.any));
        this.e8($, $.i(REOP.goto));
        $.run(this.fEmit32, $.i(-(5 + 1 + 5)));
      });
      this.e8($, $.i(REOP.save_start));
      this.e8($, $.i(0));
      this.chk($, ST, $.call(this.fDisjunction, $.i(0)));
      $.if($.ne(this.gg($, "pos"), this.gg($, "len")), () => $.ret($.i(RX.UNMATCHED_PAREN)));
      $.if(this.gg($, "deferredK"), () => $.ret($.i(RX.INVALID_NAMED_CAPTURE_REF)));
      $.if($.l(STRICT), () => $.ret($.i(0)));
      this.e8($, $.i(REOP.save_end));
      this.e8($, $.i(0));
      this.e8($, $.i(REOP.match));
      $.put(REGS, $.call(this.fRegisterCount, $.i(8), this.gg($, "bcSize")));
      $.if($.lt($.l(REGS), $.i(0)), () => $.ret($.i(fenceId("too-many-registers"))));
      $.run(this.fPatch32, $.i(4), $.sub(this.gg($, "bcSize"), $.i(8)));
      $.for(I, $.i(1), this.gg($, "capCount"), () => {
        $.if($.notNull($.aget(this.nameArrT, this.gg($, "names"), $.l(I))), () => $.put(ANY, $.i(1)));
      });
      $.if($.l(ANY), () => {
        $.for(I, $.i(1), this.gg($, "capCount"), () => {
          $.put(NM, $.aget(this.nameArrT, this.gg($, "names"), $.l(I)));
          $.if(
            $.notNull($.l(NM)),
            () => {
              $.run(this.fEmitUtf8, $.l(NM));
              this.e8($, $.i(0));
              this.e8($, $.and($.aget(this.crT, this.gg($, "nameScope"), $.l(I)), $.i(0xff)));
            },
            () => {
              this.e8($, $.i(0));
              this.e8($, $.i(0));
            },
          );
        });
        $.run(this.fPatch8, $.i(0), $.or(this.get8($, $.i(0)), $.i(LRE_FLAG_NAMED_GROUPS)));
      });
      $.run(this.fPatch8, $.i(2), this.gg($, "capCount"));
      $.run(this.fPatch8, $.i(3), $.l(REGS));
      $.ret($.i(0));
    });
  }

  /* ── Annex-B family classification (regex-disposition.ts) ───────── */

  private get fBraceLeniency(): number {
    return this.fn("braceLeniency", [], [I32], ($) => {
      const I = $.local(I32);
      const J = $.local(I32);
      const INC = $.local(I32);
      const CC = $.local(I32);
      $.whileL($.lt($.l(I), this.gg($, "len")), (_brk, cont) => {
        $.put(CC, this.ch($, $.l(I)));
        $.if($.eq($.l(CC), $.i(0x5c)), () => {
          $.bump(I, 2);
          $.br(cont);
        });
        $.if($.l(INC), () => {
          $.if($.eq($.l(CC), $.i(C("]"))), () => $.put(INC, $.i(0)));
          $.bump(I);
          $.br(cont);
        });
        $.if($.eq($.l(CC), $.i(C("["))), () => {
          $.put(INC, $.i(1));
          $.bump(I);
          $.br(cont);
        });
        $.if($.anyEq($.l(CC), [C("]"), C("}")]), () => $.ret($.i(1)));
        $.if($.eq($.l(CC), $.i(C("{"))), () => {
          $.put(J, $.add($.l(I), $.i(1)));
          $.if($.not(this.isDigit($, this.ch($, $.l(J)))), () => $.ret($.i(2)));
          $.while(this.isDigit($, this.ch($, $.l(J))), () => $.bump(J));
          $.if($.eq(this.ch($, $.l(J)), $.i(C(","))), () => {
            $.bump(J);
            $.while(this.isDigit($, this.ch($, $.l(J))), () => $.bump(J));
          });
          $.if($.ne(this.ch($, $.l(J)), $.i(C("}"))), () => $.ret($.i(2)));
          $.put(I, $.add($.l(J), $.i(1)));
          $.br(cont);
        });
        $.bump(I);
      });
      $.ret($.i(0));
    });
  }

  private get fLegacyNumeric(): number {
    return this.fn("legacyNumeric", [I32], [I32], ($) => {
      const TOTAL = 0;
      const I = $.local(I32);
      const INC = $.local(I32);
      const CC = $.local(I32);
      const D0 = $.local(I32);
      $.whileL($.lt($.l(I), this.gg($, "len")), (_brk, cont) => {
        $.put(CC, this.ch($, $.l(I)));
        $.if($.eq($.l(CC), $.i(0x5c)), () => {
          $.put(D0, this.ch($, $.add($.l(I), $.i(1))));
          $.if($.both($.not($.l(INC)), this.isDigit($, $.l(D0))), () => {
            $.if(
              $.eq($.l(D0), $.i(C("0"))),
              () => $.if(this.isDigit($, this.ch($, $.add($.l(I), $.i(2)))), () => $.ret($.i(1))),
              () => $.if($.not($.lt($.sub($.l(D0), $.i(0x30)), $.l(TOTAL))), () => $.ret($.sel(I32, $.le($.l(D0), $.i(C("7"))), $.i(1), $.i(2)))),
            );
          });
          $.bump(I, 2);
          $.br(cont);
        });
        $.if($.eq($.l(CC), $.i(C("["))), () => $.put(INC, $.i(1)));
        $.if($.eq($.l(CC), $.i(C("]"))), () => $.put(INC, $.i(0)));
        $.bump(I);
      });
      $.ret($.i(0));
    });
  }

  private get fLenientControl(): number {
    return this.fn("lenientControl", [], [I32], ($) => {
      const I = $.local(I32);
      const K = $.local(I32);
      $.whileL($.lt($.l(I), this.gg($, "len")), (_brk, cont) => {
        $.if($.ne(this.ch($, $.l(I)), $.i(0x5c)), () => {
          $.bump(I);
          $.br(cont);
        });
        $.if($.eq(this.ch($, $.add($.l(I), $.i(1))), $.i(C("c"))), () => {
          $.put(K, this.ch($, $.add($.l(I), $.i(2))));
          $.if($.not($.or($.inR($.l(K), 0x41, 0x5a), $.inR($.l(K), 0x61, 0x7a))), () => $.ret($.i(1)));
        });
        $.bump(I, 2);
      });
      $.ret($.i(0));
    });
  }

  private get fClassRangeEscape(): number {
    return this.fn("classRangeEscape", [], [I32], ($) => {
      const I = $.local(I32);
      const J = $.local(I32);
      const PREV = $.local(I32);
      const ISCE = $.local(I32);
      $.whileL($.lt($.l(I), this.gg($, "len")), (_brk, cont) => {
        $.if($.eq(this.ch($, $.l(I)), $.i(0x5c)), () => {
          $.bump(I, 2);
          $.br(cont);
        });
        $.if($.ne(this.ch($, $.l(I)), $.i(C("["))), () => {
          $.bump(I);
          $.br(cont);
        });
        $.put(J, $.add($.l(I), $.i(1)));
        $.put(PREV, $.i(0));
        $.whileL($.andThen($.lt($.l(J), this.gg($, "len")), $.ne(this.ch($, $.l(J)), $.i(C("]")))), (_b2, c2) => {
          $.if($.eq(this.ch($, $.l(J)), $.i(0x5c)), () => {
            $.put(ISCE, $.anyEq(this.ch($, $.add($.l(J), $.i(1))), [C("d"), C("D"), C("s"), C("S"), C("w"), C("W")]));
            $.if($.both($.l(ISCE), $.eq(this.ch($, $.sub($.l(J), $.i(1))), $.i(C("-")))), () => $.ret($.i(1)));
            $.put(PREV, $.l(ISCE));
            $.bump(J, 2);
            $.br(c2);
          });
          $.if($.both($.eq(this.ch($, $.l(J)), $.i(C("-"))), $.l(PREV)), () => $.ret($.i(1)));
          $.put(PREV, $.i(0));
          $.bump(J);
        });
        $.put(I, $.add($.l(J), $.i(1)));
      });
      $.ret($.i(0));
    });
  }

  /** classifyAnnexBFamily after the strict re-parse failed: the fence id,
   * or 0 for family 6 (lenient identity escape — implemented). */
  private get fAnnexBFamily(): number {
    return this.fn("annexbFamily", [I32], [I32], ($) => {
      const QLOOK = 0;
      const B = $.local(I32);
      const TOTAL = $.local(I32);
      const I = $.local(I32);
      $.if($.l(QLOOK), () => $.ret($.i(fenceId("annexb-quantified-assertion"))));
      $.put(B, $.call(this.fBraceLeniency));
      $.if($.eq($.l(B), $.i(1)), () => $.ret($.i(fenceId("annexb-extended-pattern-char"))));
      $.if($.eq($.l(B), $.i(2)), () => $.ret($.i(fenceId("annexb-brace-literal"))));
      $.put(TOTAL, $.call(this.fScanCaptures, $.nul(this.strT)));
      $.put(B, $.call(this.fLegacyNumeric, $.l(TOTAL)));
      $.if($.eq($.l(B), $.i(1)), () => $.ret($.i(fenceId("annexb-legacy-octal"))));
      $.if($.eq($.l(B), $.i(2)), () => $.ret($.i(fenceId("annexb-nonoctal-decimal"))));
      $.if($.call(this.fLenientControl), () => $.ret($.i(fenceId("annexb-control-escape"))));
      $.if($.call(this.fClassRangeEscape), () => $.ret($.i(fenceId("annexb-class-range-escape"))));
      $.if($.not(this.gg($, "scanHasNamed")), () => {
        $.for(I, $.i(0), this.gg($, "len"), () => {
          $.if($.both($.eq(this.ch($, $.l(I)), $.i(0x5c)), $.eq(this.ch($, $.add($.l(I), $.i(1))), $.i(C("k")))), () =>
            $.ret($.i(fenceId("annexb-named-backref-leniency"))),
          );
        });
      });
      $.ret($.i(0));
    });
  }

  /* ── the value ──────────────────────────────────────────────────── */

  /** EscapeRegExpPattern as V8 writes it (regexp.cc
   * WriteEscapedRegExpSource): `/` outside a class gets a backslash, a
   * line terminator becomes its escape, a backslash before a line
   * terminator is dropped; the empty pattern is `(?:)`. */
  private get fEscapeSource(): number {
    return this.fn("escapeSource", [], [this.ref(this.strT)], ($) => {
      const L = $.local(I32);
      const OUT = $.local(this.ref(this.strT));
      const N = $.local(I32);
      const S = $.local(I32);
      const INC = $.local(I32);
      const CC = $.local(I32);
      const RES = $.local(this.ref(this.strT));
      const isLT = (x: X): X => $.anyEq(x, [0x0a, 0x0d, 0x2028, 0x2029]);
      const put = (v: X): void => {
        $.aset(this.strT, $.l(OUT), $.l(N), v);
        $.bump(N);
      };
      const putStr = (s: string): void => {
        for (const ch of s) put($.i(ch.charCodeAt(0)));
      };
      $.put(L, this.gg($, "len"));
      $.if($.not($.l(L)), () => $.ret(this.lit($, "(?:)")));
      $.put(OUT, $.anew(this.strT, $.mul($.l(L), $.i(6))));
      $.whileL($.lt($.l(S), $.l(L)), (brk, cont) => {
        $.put(CC, this.ch($, $.l(S)));
        $.if($.eq($.l(CC), $.i(0x5c)), () => {
          $.if($.both($.lt($.add($.l(S), $.i(1)), $.l(L)), isLT(this.ch($, $.add($.l(S), $.i(1))))), () => {
            $.bump(S);
            $.br(cont);
          });
          put($.l(CC));
          $.bump(S);
          $.if($.eq($.l(S), $.l(L)), () => $.br(brk));
          put(this.ch($, $.l(S)));
          $.bump(S);
          $.br(cont);
        });
        $.if($.both($.eq($.l(CC), $.i(C("/"))), $.not($.l(INC))), () => put($.i(0x5c)));
        $.if($.eq($.l(CC), $.i(C("["))), () => $.put(INC, $.i(1)));
        $.if($.eq($.l(CC), $.i(C("]"))), () => $.put(INC, $.i(0)));
        for (const [code, text] of [[0x0a, "\\n"], [0x0d, "\\r"], [0x2028, "\\u2028"], [0x2029, "\\u2029"]] as const) {
          $.if($.eq($.l(CC), $.i(code)), () => {
            putStr(text);
            $.bump(S);
            $.br(cont);
          });
        }
        put($.l(CC));
        $.bump(S);
      });
      $.put(RES, $.anew(this.strT, $.l(N)));
      $.do($.l(RES), $.i(0), $.l(OUT), $.i(0), $.l(N));
      $.c.arrayCopy(this.strT, this.strT);
      $.ret($.l(RES));
    });
  }

  /** The canonical flags text (the flags getter's order) of the mask. */
  private get fCanonFlags(): number {
    return this.fn("canonFlags", [], [this.ref(this.strT)], ($) => {
      const OUT = $.local(this.ref(this.strT));
      const N = $.local(I32);
      const RES = $.local(this.ref(this.strT));
      $.put(OUT, $.anew(this.strT, $.i(8)));
      for (const ch of "dgimsuvy") {
        $.if($.and(this.gg($, "flagMask"), $.i(FM[ch as keyof typeof FM])), () => {
          $.aset(this.strT, $.l(OUT), $.l(N), $.i(ch.charCodeAt(0)));
          $.bump(N);
        });
      }
      $.put(RES, $.anew(this.strT, $.l(N)));
      $.do($.l(RES), $.i(0), $.l(OUT), $.i(0), $.l(N));
      $.c.arrayCopy(this.strT, this.strT);
      $.ret($.l(RES));
    });
  }

  private regexRef(): ValType {
    return this.ref(this.re.regexType);
  }

  /** `%w.rec.compile(pattern, flags)`: the %w.re.Regex, or null with the
   * outcome id left for errKind / errMessage / errCode. */
  compileFn(): number {
    return this.fn("compile", [this.ref(this.strT), this.ref(this.strT)], [this.regexRef()], ($) => {
      const PAT = 0;
      const FLAGS = 1;
      const I = $.local(I32);
      const BIT = $.local(I32);
      const MASK = $.local(I32);
      const CC = $.local(I32);
      const ST = $.local(I32);
      const QL = $.local(I32);
      const BYTES = $.local(this.ref(this.bufT));
      const NAMES = $.local(this.ref(this.re.strArrType));
      const NM = $.local(this.ref(this.strT));
      const R = $.local(this.regexRef());
      const fail = (id: X): void => {
        this.gs($, "err", id);
        $.ret($.nul(this.re.regexType));
      };
      $.run(this.fInitTables);
      this.gs($, "pat", $.l(PAT));
      this.gs($, "flags", $.l(FLAGS));
      this.gs($, "len", $.alen($.l(PAT)));
      this.gs($, "err", $.i(0));
      $.for(I, $.i(0), $.alen($.l(FLAGS)), () => {
        $.put(CC, $.agetU(this.strT, $.l(FLAGS), $.l(I)));
        $.put(BIT, $.i(0));
        for (const ch of "dgimsuvy") $.if($.eq($.l(CC), $.i(ch.charCodeAt(0))), () => $.put(BIT, $.i(FM[ch as keyof typeof FM])));
        $.if($.or($.not($.l(BIT)), $.and($.l(MASK), $.l(BIT))), () => fail($.i(RX.BAD_FLAGS)));
        $.put(MASK, $.or($.l(MASK), $.l(BIT)));
      });
      this.gs($, "flagMask", $.l(MASK));
      // u with v is an invalid flags string, before the /v fence (V8).
      $.if($.eq($.and($.l(MASK), $.i(FM.u | FM.v)), $.i(FM.u | FM.v)), () => fail($.i(RX.BAD_FLAGS)));
      $.if($.and($.l(MASK), $.i(FM.v)), () => fail($.i(fenceId("unicode-sets-flag"))));
      const has = (b: number): X => $.ne($.and($.l(MASK), $.i(b)), $.i(0));
      this.gs($, "uni", has(FM.u));
      this.gs($, "ic", has(FM.i));
      this.gs($, "ml", has(FM.m));
      this.gs($, "da", has(FM.s));
      this.gs($, "sticky", has(FM.y));
      $.if($.both(this.gg($, "ic"), this.gg($, "uni")), () => {
        // /iu is fenced, but a syntax error wins as in Node: the grammar
        // does not depend on /i, so the /u parse alone decides it.
        this.gs($, "ic", $.i(0));
        this.gs($, "topIc", $.i(0));
        this.gs($, "topMl", this.gg($, "ml"));
        this.gs($, "topDa", this.gg($, "da"));
        $.put(ST, $.call(this.fCore, $.i(1)));
        $.if($.both($.ne($.l(ST), $.i(0)), $.lt($.l(ST), $.i(RX.FENCE_BASE))), () => fail($.l(ST)));
        fail($.i(fenceId("unicode-casefold")));
      });
      this.gs($, "topIc", this.gg($, "ic"));
      this.gs($, "topMl", this.gg($, "ml"));
      this.gs($, "topDa", this.gg($, "da"));
      $.put(ST, $.call(this.fCore, $.i(0)));
      $.if($.l(ST), () => fail($.l(ST)));
      $.if(this.gg($, "modUsed"), () => fail($.i(fenceId("modifiers"))));
      $.put(BYTES, $.anew(this.bufT, this.gg($, "bcSize")));
      $.do($.l(BYTES), $.i(0), this.gg($, "bc"), $.i(0), this.gg($, "bcSize"));
      $.c.arrayCopy(this.bufT, this.bufT);
      $.put(NAMES, $.nul(this.re.strArrType));
      $.for(I, $.i(1), this.gg($, "capCount"), () => {
        $.if($.notNull($.aget(this.nameArrT, this.gg($, "names"), $.l(I))), () => {
          $.if($.isNull($.l(NAMES)), () => $.put(NAMES, $.anew(this.re.strArrType, $.sub(this.gg($, "capCount"), $.i(1)))));
        });
      });
      $.if($.notNull($.l(NAMES)), () => {
        $.for(I, $.i(1), this.gg($, "capCount"), () => {
          $.put(NM, $.aget(this.nameArrT, this.gg($, "names"), $.l(I)));
          $.if($.isNull($.l(NM)), () => $.put(NM, $.anew(this.strT, $.i(0))));
          $.aset(this.re.strArrType, $.l(NAMES), $.sub($.l(I), $.i(1)), $.l(NM));
        });
      });
      $.put(R, $.new_(this.re.regexType, $.call(this.fEscapeSource), $.call(this.fCanonFlags), $.l(BYTES), this.gg($, "capCount"), $.l(NAMES)));
      $.if($.not(this.gg($, "uni")), () => {
        // Annex B (regex-disposition.ts usesAnnexBOnly): a pattern that
        // fails to parse with /u forced on relies on a legacy production.
        $.put(QL, this.gg($, "qLook"));
        this.gs($, "uni", $.i(1));
        this.gs($, "ic", $.i(0));
        $.put(ST, $.call(this.fCore, $.i(1)));
        this.gs($, "uni", $.i(0));
        this.gs($, "ic", this.gg($, "topIc"));
        $.if($.l(ST), () => {
          $.put(ST, $.call(this.fAnnexBFamily, $.l(QL)));
          $.if($.l(ST), () => fail($.l(ST)));
        });
      });
      // a valid pattern past the size V8 is sure to compile (S102)
      $.if($.gt(this.gg($, "len"), $.i(RX_PATTERN_SIZE_LIMIT)), () => fail($.i(fenceId("pattern-too-large"))));
      $.ret($.l(R));
    });
  }

  /** 0 none, 1 SyntaxError, 2 named fence. */
  errKindFn(): number {
    return this.fn("errKind", [], [I32], ($) => {
      $.if($.not(this.gg($, "err")), () => $.ret($.i(0)));
      $.ret($.sel(I32, $.lt(this.gg($, "err"), $.i(RX.FENCE_BASE)), $.i(1), $.i(2)));
    });
  }

  private get fConcat(): number {
    return this.fn("concat", [this.ref(this.strT), this.ref(this.strT)], [this.ref(this.strT)], ($) => {
      const A_ = 0;
      const B_ = 1;
      const R = $.local(this.ref(this.strT));
      $.put(R, $.anew(this.strT, $.add($.alen($.l(A_)), $.alen($.l(B_)))));
      $.do($.l(R), $.i(0), $.l(A_), $.i(0), $.alen($.l(A_)));
      $.c.arrayCopy(this.strT, this.strT);
      $.do($.l(R), $.alen($.l(A_)), $.l(B_), $.i(0), $.alen($.l(B_)));
      $.c.arrayCopy(this.strT, this.strT);
      $.ret($.l(R));
    });
  }

  private cat($: RA, ...xs: X[]): X {
    let acc = xs[0]!;
    for (const x of xs.slice(1)) acc = $.call(this.fConcat, acc, x);
    return acc;
  }

  /** The thrown error's message. */
  errMessageFn(): number {
    return this.fn("errMessage", [], [this.ref(this.strT)], ($) => {
      const ERR = $.local(I32);
      $.put(ERR, this.gg($, "err"));
      $.if($.eq($.l(ERR), $.i(RX.BAD_FLAGS)), () =>
        $.ret(this.cat($, this.lit($, "Invalid flags supplied to RegExp constructor '"), this.gg($, "flags"), this.lit($, "'"))),
      );
      for (let id = 1; id < RX_SYNTAX_TEXT.length; id++) {
        $.if($.eq($.l(ERR), $.i(id)), () =>
          $.ret(this.cat($, this.lit($, "Invalid regular expression: /"), this.gg($, "pat"), this.lit($, "/"), $.call(this.fCanonFlags), this.lit($, `: ${RX_SYNTAX_TEXT[id]}`))),
        );
      }
      RX_FENCE_KEY.forEach((key, i) => {
        $.if($.eq($.l(ERR), $.i(RX.FENCE_BASE + i)), () => $.ret(this.lit($, fenceMessage(key))));
      });
      $.ret(this.lit($, ""));
    });
  }

  /** A fence's `code` (the refusal key). */
  errCodeFn(): number {
    return this.fn("errCode", [], [this.ref(this.strT)], ($) => {
      RX_FENCE_KEY.forEach((key, i) => {
        $.if($.eq(this.gg($, "err"), $.i(RX.FENCE_BASE + i)), () => $.ret(this.lit($, fenceCode(key))));
      });
      $.ret(this.lit($, ""));
    });
  }

  /** TEST SUPPORT: the outcome id itself. */
  errIdFn(): number {
    return this.fn("errId", [], [I32], ($) => {
      $.ret(this.gg($, "err"));
    });
  }
}
