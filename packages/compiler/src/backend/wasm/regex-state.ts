/* Board #301: the regex methods over a STATEFUL regex value — lastIndex
 * modelled (SEMANTICS.md S003's regex amendment, retired by this unit).
 *
 * One helper per spec algorithm, each a module function built on first
 * use, so a call site is "evaluate the operands, call the helper":
 *
 *   bexec     RegExpBuiltinExec — reads lastIndex (ToLength) when the
 *             regex is global or sticky, writes the match end or 0
 *   exec      RegExp.prototype.exec: bexec + the honest string[] row
 *   match     Symbol.match: exec when not global; every whole match when
 *             global (lastIndex reset to 0 first, empty matches advance)
 *   replace   Symbol.replace with a string template (GetSubstitution)
 *   collect   Symbol.replace's collection phase for a FUNCTION replacer:
 *             every result as a row, positions alongside — the frontend
 *             calls the replacer afterwards, so user code never runs
 *             while the matcher is mid-match (its hoisted globals — the
 *             backtrack stack, the capture arrays — are never re-entered)
 *   matchAll  String.prototype.matchAll's drain over the spec's CLONE: it
 *             starts at ToLength(re.lastIndex) and never writes re
 *   split     Symbol.split (limit, capture splicing) — the spec's sticky
 *             splitter emulated by searching from q with the regex's own
 *             bytecode (sticky regexes probe per position)
 *
 * The native lanes run the same algorithms in scr_regex.c, held equal by
 * the regex differential fuzz (packages/compiler/test/regex-state-fuzz.test.ts).
 * Positions are UTF-16 indices; a capture that did not participate reads
 * "" in a row (S064) and -1 in a position list. */
import { A, Fn, type X } from "./asm.js";
import { F64, I32, type ModuleBuilder, type ValType } from "./module.js";
import { LRE_FLAG_GLOBAL, LRE_FLAG_STICKY, LRE_FLAG_UNICODE, LRE_FLAG_UNICODE_SETS, RE_HEADER_FLAGS, RE_HEADER_REGISTER_COUNT } from "./regex-opcodes.js";
import type { RegexInterpreterBuilder } from "./regex-interpreter.js";
import type { RegexBuilder } from "./regex-value.js";
import type { VecBuilder, VecInfo } from "./arrays.js";

// regex struct fields (regex-value.ts)
const F_BC = 2;
const F_CAPS = 3;
const F_NAMES = 4;
const F_LAST = 5;
// vec struct fields (arrays.ts)
const V_LEN = 0;

export interface RegexStateDeps {
  mb: ModuleBuilder;
  strT: number;
  re: RegexBuilder;
  interp: RegexInterpreterBuilder;
  vecs: VecBuilder;
  rowVec: VecInfo; // string[]
  rowsVec: VecInfo; // string[][]
  numVec: VecInfo; // number[]
  slice: () => number; // %w.str.slice (str, f64, f64) -> str
  join: () => number; // %w.vec.join over rowVec (vec, sep) -> str
  getSubstitution: () => number; // (S, start, end, cap, ncap, names, tpl) -> str
  indexOf: () => number; // %w.str.indexOf (str, needle, f64 from) -> f64
}

export class RegexStateBuilder {
  private readonly cache = new Map<string, number>();
  constructor(private readonly d: RegexStateDeps) {}

  private ref(t: number): ValType {
    return { kind: "ref", nullable: true, typeIndex: t };
  }
  get reT(): ValType {
    return this.ref(this.d.re.regexType);
  }
  get strRefT(): ValType {
    return this.ref(this.d.strT);
  }
  get capT(): ValType {
    return this.ref(this.d.interp.capType);
  }
  get rowT(): ValType {
    return this.d.vecs.vecRef(this.d.rowVec);
  }
  get rowsT(): ValType {
    return this.d.vecs.vecRef(this.d.rowsVec);
  }
  get numT(): ValType {
    return this.d.vecs.vecRef(this.d.numVec);
  }

  private fn(name: string, params: ValType[], results: ValType[], body: ($: A) => void): number {
    const hit = this.cache.get(name);
    if (hit !== undefined) return hit;
    const idx = this.d.mb.declareFunc(this.d.mb.funcType(params, results), `%w.re.${name}`);
    this.cache.set(name, idx);
    const f = new Fn(params.length);
    const $ = new A(f);
    body($);
    this.d.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  /* ── small pieces ─────────────────────────────────────────────────── */

  /** The bytecode header's flag bits. */
  flags(): number {
    return this.fn("flagBits", [this.reT], [I32], ($) => {
      $.do($.call(this.d.interp.readU16(), $.get(this.d.re.regexType, F_BC, $.l(0)), $.i(RE_HEADER_FLAGS)));
    });
  }

  /** A capture array sized for `re` (captures + the register slots). */
  capNew(): number {
    return this.fn("capNew", [this.reT], [this.capT], ($) => {
      const bc = $.get(this.d.re.regexType, F_BC, $.l(0));
      const regs = $.call(this.d.interp.readU8(), bc, $.i(RE_HEADER_REGISTER_COUNT));
      $.do($.call(this.d.interp.newCaptureArray(), $.add($.get(this.d.re.regexType, F_CAPS, $.l(0)), $.shrU($.add(regs, $.i(1)), $.i(1)))));
    });
  }

  /** ToLength over the stored number, as an index candidate: NaN and
   * non-positive values are 0, fractions truncate, and anything past the
   * subject is simply "past the end" (2^31 stands in for every such
   * value — no subject is that long). */
  toIndex(): number {
    return this.fn("toIndex", [F64], [F64], ($) => {
      $.if($.not($.dgt($.l(0), $.d(0))), () => $.ret($.d(0)));
      $.if($.dge($.l(0), $.d(2147483648)), () => $.ret($.d(2147483648)));
      $.do($.l(0));
      $.c.f64Floor();
    });
  }

  /** AdvanceStringIndex(S, i, unicode): past a whole surrogate pair under
   * /u (or /v), one code unit otherwise. */
  advance(): number {
    return this.fn("advance", [this.strRefT, I32, I32], [I32], ($) => {
      const S = $.l(0);
      const I = $.l(1);
      const U = $.l(2);
      const n1 = $.add(I, $.i(1));
      $.if($.either($.not(U), $.ge(n1, $.alen(S))), () => $.ret(n1));
      const hi = $.agetU(this.d.strT, S, I);
      const lo = $.agetU(this.d.strT, S, n1);
      $.if(
        $.both($.both($.geU(hi, $.i(0xd800)), $.ltU(hi, $.i(0xdc00))), $.both($.geU(lo, $.i(0xdc00)), $.ltU(lo, $.i(0xe000)))),
        () => $.ret($.add(I, $.i(2))),
      );
      $.do(n1);
    });
  }

  /** Every capture slot back to -1 (a reused capture array: the matcher
   * does not reset a slot its taken path never touches). */
  private reset($: A, cap: X, i: number): void {
    $.for(i, $.i(0), $.alen(cap), () => $.aset(this.d.interp.capType, cap, $.l(i), $.i(-1)));
  }

  /** RegExpBuiltinExec(re, S) into `cap`: 1 on a match, 0 otherwise. A
   * global or sticky regex starts at ToLength(lastIndex) and stores the
   * match end (or 0 on failure); any other starts at 0 and leaves
   * lastIndex alone, exactly the spec's steps. */
  bexec(): number {
    return this.fn("bexec", [this.reT, this.strRefT, this.capT], [I32], ($) => {
      const RE = $.l(0);
      const S = $.l(1);
      const CAP = $.l(2);
      const GY = $.local(I32);
      const LI = $.local(F64);
      const I = $.local(I32);
      const T = this.d.re.regexType;
      $.put(GY, $.and($.call(this.flags(), RE), $.i(LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)));
      $.put(LI, $.sel(F64, $.l(GY), $.call(this.toIndex(), $.get(T, F_LAST, RE)), $.d(0)));
      const fail = (): void => {
        $.if($.l(GY), () => $.set(T, F_LAST, RE, $.d(0)));
        $.ret($.i(0));
      };
      $.if($.dgt($.l(LI), $.i2d($.alen(S))), fail);
      this.reset($, CAP, I);
      $.if($.not($.call(this.d.interp.exec(), $.get(T, F_BC, RE), S, $.d2i($.l(LI)), CAP)), fail);
      $.if($.l(GY), () => $.set(T, F_LAST, RE, $.i2d($.aget(this.d.interp.capType, CAP, $.i(1)))));
      $.do($.i(1));
    });
  }

  private emptyStr($: A): X {
    return $.anew(this.d.strT, $.i(0));
  }

  private sub($: A, S: X, a: X, b: X): X {
    return $.call(this.d.slice(), S, $.i2d(a), $.i2d(b));
  }

  /** The honest match row: [whole, ...captures], "" for a capture that
   * did not participate (S064). */
  row(): number {
    return this.fn("row", [this.strRefT, this.capT, I32], [this.rowT], ($) => {
      const S = $.l(0);
      const CAP = $.l(1);
      const N = $.l(2);
      const OUT = $.local(this.rowT);
      const K = $.local(I32);
      const CS = $.local(I32);
      const capT = this.d.interp.capType;
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowVec), $.d(0)));
      $.for(K, $.i(0), N, () => {
        $.put(CS, $.aget(capT, CAP, $.shl($.l(K), $.i(1))));
        $.run(
          this.d.vecs.pushOne(this.d.rowVec),
          $.l(OUT),
          $.sel(this.strRefT, $.lt($.l(CS), $.i(0)), this.emptyStr($), this.sub($, S, $.l(CS), $.aget(capT, CAP, $.add($.shl($.l(K), $.i(1)), $.i(1))))),
        );
      });
      $.do($.l(OUT));
    });
  }

  /** Appends the match's 2*n capture positions (start, end; -1 unset). */
  pushPos(): number {
    return this.fn("pushPos", [this.numT, this.capT, I32], [], ($) => {
      const P = $.l(0);
      const CAP = $.l(1);
      const K = $.local(I32);
      $.for(K, $.i(0), $.shl($.l(2), $.i(1)), () => {
        $.run(this.d.vecs.pushOne(this.d.numVec), P, $.i2d($.aget(this.d.interp.capType, CAP, $.l(K))));
      });
    });
  }

  private clearVec($: A, v: X): void {
    $.set(this.d.numVec.struct, V_LEN, v, $.i(0));
  }

  /** RegExp.prototype.exec: the row, or null. `pos` (nullable) is cleared
   * and receives the match's capture positions. */
  exec(): number {
    return this.fn("execRow", [this.reT, this.strRefT, this.numT], [this.rowT], ($) => {
      const RE = $.l(0);
      const S = $.l(1);
      const P = $.l(2);
      const CAP = $.local(this.capT);
      $.if($.notNull(P), () => this.clearVec($, P));
      $.put(CAP, $.call(this.capNew(), RE));
      $.if($.not($.call(this.bexec(), RE, S, $.l(CAP))), () => $.ret($.nul(this.d.rowVec.struct)));
      const n = $.get(this.d.re.regexType, F_CAPS, RE);
      $.if($.notNull(P), () => $.run(this.pushPos(), P, $.l(CAP), n));
      $.do($.call(this.row(), S, $.l(CAP), n));
    });
  }

  private unicodeOf($: A, re: X): X {
    return $.ne($.and($.call(this.flags(), re), $.i(LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)), $.i(0));
  }

  /** After an empty match of a global loop: lastIndex = AdvanceStringIndex
   * (S, ToLength(lastIndex), unicode). lastIndex holds the match end the
   * last bexec stored, an index within S. */
  private bumpEmpty($: A, RE: X, S: X, U: X): void {
    const T = this.d.re.regexType;
    $.set(T, F_LAST, RE, $.i2d($.call(this.advance(), S, $.d2i($.get(T, F_LAST, RE)), U)));
  }

  /** Symbol.match: exec when the regex is not global; otherwise every
   * whole match (lastIndex set to 0 first), or null when there is none. */
  match(): number {
    return this.fn("match", [this.reT, this.strRefT, this.numT], [this.rowT], ($) => {
      const RE = $.l(0);
      const S = $.l(1);
      const P = $.l(2);
      const CAP = $.local(this.capT);
      const OUT = $.local(this.rowT);
      const U = $.local(I32);
      const GO = $.local(I32);
      const capT = this.d.interp.capType;
      $.if($.not($.and($.call(this.flags(), RE), $.i(LRE_FLAG_GLOBAL))), () => $.ret($.call(this.exec(), RE, S, P)));
      $.if($.notNull(P), () => this.clearVec($, P));
      $.put(U, this.unicodeOf($, RE));
      $.set(this.d.re.regexType, F_LAST, RE, $.d(0));
      $.put(CAP, $.call(this.capNew(), RE));
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowVec), $.d(0)));
      $.put(GO, $.i(1));
      $.while($.l(GO), () => {
        $.if(
          $.call(this.bexec(), RE, S, $.l(CAP)),
          () => {
            const s0 = $.aget(capT, $.l(CAP), $.i(0));
            const e0 = $.aget(capT, $.l(CAP), $.i(1));
            $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), this.sub($, S, s0, e0));
            $.if($.eq(s0, e0), () => this.bumpEmpty($, RE, S, $.l(U)));
          },
          () => $.put(GO, $.i(0)),
        );
      });
      $.if($.not($.get(this.d.rowVec.struct, V_LEN, $.l(OUT))), () => $.ret($.nul(this.d.rowVec.struct)));
      $.do($.l(OUT));
    });
  }

  /** The shared Symbol.replace loop. Each result calls `onMatch` with the
   * capture array in CAP (start/end in its slots 0/1); global regexes
   * start from lastIndex 0 and advance past empty matches. */
  private replaceLoop($: A, RE: X, S: X, CAP: number, onMatch: () => void): void {
    const G = $.local(I32);
    const U = $.local(I32);
    const GO = $.local(I32);
    const capT = this.d.interp.capType;
    $.put(G, $.and($.call(this.flags(), RE), $.i(LRE_FLAG_GLOBAL)));
    $.put(U, this.unicodeOf($, RE));
    $.if($.l(G), () => $.set(this.d.re.regexType, F_LAST, RE, $.d(0)));
    $.put(CAP, $.call(this.capNew(), RE));
    $.put(GO, $.i(1));
    $.while($.l(GO), () => {
      $.if(
        $.call(this.bexec(), RE, S, $.l(CAP)),
        () => {
          onMatch();
          $.if(
            $.l(G),
            () => $.if($.eq($.aget(capT, $.l(CAP), $.i(0)), $.aget(capT, $.l(CAP), $.i(1))), () => this.bumpEmpty($, RE, S, $.l(U))),
            () => $.put(GO, $.i(0)),
          );
        },
        () => $.put(GO, $.i(0)),
      );
    });
  }

  /** Symbol.replace with a string template. */
  replace(): number {
    return this.fn("replace", [this.strRefT, this.reT, this.strRefT], [this.strRefT], ($) => {
      const S = $.l(0);
      const RE = $.l(1);
      const TPL = $.l(2);
      const CAP = $.local(this.capT);
      const OUT = $.local(this.rowT);
      const NEXT = $.local(I32);
      const ST = $.local(I32);
      const EN = $.local(I32);
      const capT = this.d.interp.capType;
      const T = this.d.re.regexType;
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowVec), $.d(0)));
      $.put(NEXT, $.i(0));
      this.replaceLoop($, RE, S, CAP, () => {
        $.put(ST, $.aget(capT, $.l(CAP), $.i(0)));
        $.put(EN, $.aget(capT, $.l(CAP), $.i(1)));
        $.if($.ge($.l(ST), $.l(NEXT)), () => {
          $.if($.gt($.l(ST), $.l(NEXT)), () => $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), this.sub($, S, $.l(NEXT), $.l(ST))));
          $.run(
            this.d.vecs.pushOne(this.d.rowVec),
            $.l(OUT),
            $.call(this.d.getSubstitution(), S, $.l(ST), $.l(EN), $.l(CAP), $.get(T, F_CAPS, RE), $.get(T, F_NAMES, RE), TPL),
          );
          $.put(NEXT, $.l(EN));
        });
      });
      // No match at all: the subject itself (strings are immutable).
      $.if($.both($.not($.l(NEXT)), $.not($.get(this.d.rowVec.struct, V_LEN, $.l(OUT)))), () => $.ret(S));
      $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), this.sub($, S, $.l(NEXT), $.alen(S)));
      $.do($.call(this.d.join(), $.l(OUT), this.emptyStr($)));
    });
  }

  /** Symbol.replace's collection for a function replacer: every result's
   * row with the GAP before it appended ([whole, ...captures, gap]), then a
   * final [tail] row; each result's 2*n positions appended to `pos`
   * (cleared first). The gaps spare the caller any slicing of the subject. */
  collect(): number {
    return this.fn("collect", [this.strRefT, this.reT, this.numT], [this.rowsT], ($) => {
      const S = $.l(0);
      const RE = $.l(1);
      const P = $.l(2);
      const CAP = $.local(this.capT);
      const OUT = $.local(this.rowsT);
      const ROW = $.local(this.rowT);
      const NEXT = $.local(I32);
      const capT = this.d.interp.capType;
      const n = $.get(this.d.re.regexType, F_CAPS, RE);
      this.clearVec($, P);
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowsVec), $.d(0)));
      $.put(NEXT, $.i(0));
      this.replaceLoop($, RE, S, CAP, () => {
        $.put(ROW, $.call(this.row(), S, $.l(CAP), n));
        // the gap before this match (results are in subject order)
        $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(ROW), this.sub($, S, $.l(NEXT), $.aget(capT, $.l(CAP), $.i(0))));
        $.put(NEXT, $.aget(capT, $.l(CAP), $.i(1)));
        $.run(this.d.vecs.pushOne(this.d.rowsVec), $.l(OUT), $.l(ROW));
        $.run(this.pushPos(), P, $.l(CAP), n);
      });
      this.pushTail($, OUT, S, NEXT);
      $.do($.l(OUT));
    });
  }

  /** The final one-element row: the subject past the last match. */
  private pushTail($: A, OUT: number, S: X, NEXT: number): void {
    const TAIL = $.local(this.rowT);
    $.put(TAIL, $.call(this.d.vecs.newLen(this.d.rowVec), $.d(0)));
    $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(TAIL), this.sub($, S, $.l(NEXT), $.alen(S)));
    $.run(this.d.vecs.pushOne(this.d.rowsVec), $.l(OUT), $.l(TAIL));
  }

  /** A STRING pattern's collection for a function replacer: rows
   * [match, gap] per occurrence (replaceAll: every one, advancing by
   * max(1, |P|); replace: the first) and the final [tail] row, positions
   * [start, end] per occurrence appended to `pos` (cleared first). */
  strCollect(all: boolean): number {
    return this.fn(all ? "strCollectAll" : "strCollect", [this.strRefT, this.strRefT, this.numT], [this.rowsT], ($) => {
      const S = $.l(0);
      const PAT = $.l(1);
      const POS = $.l(2);
      const PL = $.local(I32);
      const P = $.local(I32);
      const NEXT = $.local(I32);
      const OUT = $.local(this.rowsT);
      const ROW = $.local(this.rowT);
      const find = (from: X): X => $.d2i($.call(this.d.indexOf(), S, PAT, $.i2d(from)));
      this.clearVec($, POS);
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowsVec), $.d(0)));
      $.put(PL, $.alen(PAT));
      $.put(NEXT, $.i(0));
      $.put(P, find($.i(0)));
      $.while($.ge($.l(P), $.i(0)), () => {
        $.put(ROW, $.call(this.d.vecs.newLen(this.d.rowVec), $.d(0)));
        $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(ROW), PAT);
        $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(ROW), this.sub($, S, $.l(NEXT), $.l(P)));
        $.run(this.d.vecs.pushOne(this.d.rowsVec), $.l(OUT), $.l(ROW));
        $.run(this.d.vecs.pushOne(this.d.numVec), POS, $.i2d($.l(P)));
        $.run(this.d.vecs.pushOne(this.d.numVec), POS, $.i2d($.add($.l(P), $.l(PL))));
        $.put(NEXT, $.add($.l(P), $.l(PL)));
        if (!all) {
          $.put(P, $.i(-1));
        } else {
          $.put(P, $.add($.l(P), $.sel(I32, $.gt($.l(PL), $.i(1)), $.l(PL), $.i(1))));
          $.put(P, $.sel(I32, $.gt($.l(P), $.alen(S)), $.i(-1), find($.l(P))));
        }
      });
      this.pushTail($, OUT, S, NEXT);
      $.do($.l(OUT));
    });
  }

  /** matchAll's drain over the spec's clone (a GLOBAL regex — the caller
   * threw for any other): from ToLength(re.lastIndex), never writing re.
   * `idx` (nullable) receives each match's start. */
  matchAll(): number {
    return this.fn("matchAll", [this.strRefT, this.reT, this.numT], [this.rowsT], ($) => {
      const S = $.l(0);
      const RE = $.l(1);
      const IDX = $.l(2);
      const CAP = $.local(this.capT);
      const OUT = $.local(this.rowsT);
      const U = $.local(I32);
      const LI = $.local(F64);
      const I = $.local(I32);
      const ST = $.local(I32);
      const EN = $.local(I32);
      const T = this.d.re.regexType;
      const capT = this.d.interp.capType;
      $.put(U, this.unicodeOf($, RE));
      $.put(LI, $.call(this.toIndex(), $.get(T, F_LAST, RE)));
      $.put(CAP, $.call(this.capNew(), RE));
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowsVec), $.d(0)));
      $.while($.dle($.l(LI), $.i2d($.alen(S))), () => {
        this.reset($, $.l(CAP), I);
        $.if($.not($.call(this.d.interp.exec(), $.get(T, F_BC, RE), S, $.d2i($.l(LI)), $.l(CAP))), () => $.ret($.l(OUT)));
        $.put(ST, $.aget(capT, $.l(CAP), $.i(0)));
        $.put(EN, $.aget(capT, $.l(CAP), $.i(1)));
        $.run(this.d.vecs.pushOne(this.d.rowsVec), $.l(OUT), $.call(this.row(), S, $.l(CAP), $.get(T, F_CAPS, RE)));
        $.if($.notNull(IDX), () => $.run(this.d.vecs.pushOne(this.d.numVec), IDX, $.i2d($.l(ST))));
        $.put(LI, $.i2d($.sel(I32, $.eq($.l(ST), $.l(EN)), $.call(this.advance(), S, $.l(EN), $.l(U)), $.l(EN))));
      });
      $.do($.l(OUT));
    });
  }

  /** String.prototype.replace / replaceAll with a STRING pattern and a
   * replacement template: every occurrence (replaceAll — advancing by
   * max(1, |P|), so an empty pattern inserts between every code unit and
   * at both ends) or the first; GetSubstitution over the template with the
   * occurrence as the one "capture" (no groups). */
  strReplace(all: boolean): number {
    return this.fn(all ? "strReplaceAll" : "strReplace", [this.strRefT, this.strRefT, this.strRefT], [this.strRefT], ($) => {
      const S = $.l(0);
      const PAT = $.l(1);
      const TPL = $.l(2);
      const PL = $.local(I32);
      const P = $.local(I32);
      const NEXT = $.local(I32);
      const OUT = $.local(this.rowT);
      const CAP = $.local(this.capT);
      const capT = this.d.interp.capType;
      const find = (from: X): X => $.d2i($.call(this.d.indexOf(), S, PAT, $.i2d(from)));
      $.put(PL, $.alen(PAT));
      $.put(P, find($.i(0)));
      $.if($.lt($.l(P), $.i(0)), () => $.ret(S));
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowVec), $.d(0)));
      $.put(CAP, $.anew(capT, $.i(2)));
      $.put(NEXT, $.i(0));
      $.while($.ge($.l(P), $.i(0)), () => {
        $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), this.sub($, S, $.l(NEXT), $.l(P)));
        $.aset(capT, $.l(CAP), $.i(0), $.l(P));
        $.aset(capT, $.l(CAP), $.i(1), $.add($.l(P), $.l(PL)));
        $.run(
          this.d.vecs.pushOne(this.d.rowVec),
          $.l(OUT),
          $.call(this.d.getSubstitution(), S, $.l(P), $.add($.l(P), $.l(PL)), $.l(CAP), $.i(1), $.nul(this.d.re.strArrType), TPL),
        );
        $.put(NEXT, $.add($.l(P), $.l(PL)));
        if (!all) {
          $.put(P, $.i(-1));
        } else {
          // next search from p + max(1, |P|); an empty pattern past the
          // end stops (indexOf would clamp it back to the end)
          $.put(P, $.add($.l(P), $.sel(I32, $.gt($.l(PL), $.i(1)), $.l(PL), $.i(1))));
          $.put(P, $.sel(I32, $.gt($.l(P), $.alen(S)), $.i(-1), find($.l(P))));
        }
      });
      $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), this.sub($, S, $.l(NEXT), $.alen(S)));
      $.do($.call(this.d.join(), $.l(OUT), this.emptyStr($)));
    });
  }

  /** 1 when `x` is what V8 holds as a non-negative Smi — an integer in
   * [0, 2^31-1], not -0 — the shape its fast split path requires of the
   * limit and of lastIndex (board #301 review). */
  private fastSmi($: A, x: X): X {
    const t = (): void => {
      x();
      $.c.f64Trunc();
    };
    return $.both(
      $.both($.deq(x, t), $.dge(x, $.d(0))),
      $.both($.dle(x, $.d(2147483647)), $.dgt(() => {
        $.c.f64Const(1);
        x();
        $.c.f64Copysign();
      }, $.d(0))),
    );
  }

  /** ToUint32 over a number. */
  private toUint32($: A, x: X): X {
    return $.sel(F64, $.deq(x, x), () => {
      // (NaN fails x == x; ±Infinity: t - floor(t/2^32)*2^32 is NaN → 0)
      const T = $.local(F64);
      x();
      $.c.f64Trunc();
      $.c.localSet(T);
      $.c.localGet(T);
      $.c.localGet(T);
      $.c.f64Const(4294967296);
      $.c.f64Div();
      $.c.f64Floor();
      $.c.f64Const(4294967296);
      $.c.f64Mul();
      $.c.f64Sub();
      $.c.localTee(T);
      $.c.localGet(T);
      $.c.f64Eq();
      $.c.ifResult(F64);
      $.c.localGet(T);
      $.c.else_();
      $.c.f64Const(0);
      $.c.end();
    }, $.d(0));
  }

  /** Symbol.split(S, limit): LIMARG is the limit argument (a number; HAS
   * 0 when it was absent — 2^32-1). Captures splice into the result. A
   * non-sticky regex finds the next split point by SEARCHING from q (the
   * spec's per-position sticky probe stops at the same first position) —
   * V8's fast path; a sticky one probes per position. V8 takes its SLOW
   * (spec) path when the regex is sticky, the limit is not a non-negative
   * Smi, or lastIndex is not one: there, under /u, the probes step whole
   * code points, so a match the search finds BETWEEN the halves of a
   * surrogate pair is no split point (S066). The regex's lastIndex is never
   * touched (the spec splits with a fresh clone). */
  split(): number {
    return this.fn("split", [this.strRefT, this.reT, F64, I32], [this.rowT], ($) => {
      const S = $.l(0);
      const RE = $.l(1);
      const LIMARG = $.l(2);
      const HAS = $.l(3);
      const LIM = $.local(F64);
      const SLOW = $.local(I32);
      const CAP = $.local(this.capT);
      const OUT = $.local(this.rowT);
      const U = $.local(I32);
      const Y = $.local(I32);
      const N = $.local(I32);
      const P = $.local(I32);
      const Q = $.local(I32);
      const I = $.local(I32);
      const ST = $.local(I32);
      const EN = $.local(I32);
      const K = $.local(I32);
      const CS = $.local(I32);
      const T = this.d.re.regexType;
      const capT = this.d.interp.capType;
      const bc = $.get(T, F_BC, RE);
      const outLen = (): X => $.i2d($.get(this.d.rowVec.struct, V_LEN, $.l(OUT)));
      const push = (v: X): void => {
        $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), v);
        $.if($.deq(outLen(), $.l(LIM)), () => $.ret($.l(OUT)));
      };
      $.put(LIM, $.sel(F64, HAS, this.toUint32($, LIMARG), $.d(4294967295)));
      $.put(OUT, $.call(this.d.vecs.newLen(this.d.rowVec), $.d(0)));
      $.if($.deq($.l(LIM), $.d(0)), () => $.ret($.l(OUT)));
      $.put(U, this.unicodeOf($, RE));
      $.put(Y, $.and($.call(this.flags(), RE), $.i(LRE_FLAG_STICKY)));
      $.put(
        SLOW,
        $.either(
          $.ne($.l(Y), $.i(0)),
          $.either($.both(HAS, $.not(this.fastSmi($, LIMARG))), $.not(this.fastSmi($, $.get(T, F_LAST, RE)))),
        ),
      );
      $.put(N, $.get(T, F_CAPS, RE));
      $.put(CAP, $.call(this.capNew(), RE));
      $.if($.not($.alen(S)), () => {
        this.reset($, $.l(CAP), I);
        $.if($.not($.call(this.d.interp.exec(), bc, S, $.i(0), $.l(CAP))), () => $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), S));
        $.ret($.l(OUT));
      });
      $.put(P, $.i(0));
      $.put(Q, $.i(0));
      $.while($.lt($.l(Q), $.alen(S)), () => {
        this.reset($, $.l(CAP), I);
        $.if(
          $.not($.call(this.d.interp.exec(), bc, S, $.l(Q), $.l(CAP))),
          () => {
            // no match anywhere right of q (a search), or none AT q (sticky)
            $.if($.not($.l(Y)), () => $.put(Q, $.alen(S)), () => $.put(Q, $.call(this.advance(), S, $.l(Q), $.l(U))));
          },
          () => {
            $.put(ST, $.aget(capT, $.l(CAP), $.i(0)));
            $.put(EN, $.aget(capT, $.l(CAP), $.i(1)));
            // The spec probes only q < size, so a match the search found AT
            // the end (`/$/`) is no split point; e == p is the empty match
            // adjacent to the last split (start == q == p there); on the
            // slow path under /u a search hit inside a surrogate pair is
            // no probe position — search on from the pair's end.
            $.if(
              $.ge($.l(ST), $.alen(S)),
              () => $.put(Q, $.alen(S)),
              () => $.if(
                $.andThen(
                  $.both($.l(SLOW), $.l(U)),
                  $.andThen($.gt($.l(ST), $.i(0)), $.call(this.midPair(), S, $.l(ST))),
                ),
                () => $.put(Q, $.add($.l(ST), $.i(1))),
                () => $.if(
                  $.eq($.l(EN), $.l(P)),
                  () => $.put(Q, $.call(this.advance(), S, $.l(ST), $.l(U))),
                  () => {
                    push(this.sub($, S, $.l(P), $.l(ST)));
                    $.put(P, $.l(EN));
                    $.for(K, $.i(1), $.l(N), () => {
                      $.put(CS, $.aget(capT, $.l(CAP), $.shl($.l(K), $.i(1))));
                      push($.sel(this.strRefT, $.lt($.l(CS), $.i(0)), this.emptyStr($), this.sub($, S, $.l(CS), $.aget(capT, $.l(CAP), $.add($.shl($.l(K), $.i(1)), $.i(1))))));
                    });
                    $.put(Q, $.l(P));
                  },
                ),
              ),
            );
          },
        );
      });
      $.run(this.d.vecs.pushOne(this.d.rowVec), $.l(OUT), this.sub($, S, $.l(P), $.alen(S)));
      $.do($.l(OUT));
    });
  }

  /** (S, i > 0) -> 1 when i falls between the halves of a surrogate pair. */
  midPair(): number {
    return this.fn("midPair", [this.strRefT, I32], [I32], ($) => {
      const S = $.l(0);
      const I = $.l(1);
      $.if($.ge(I, $.alen(S)), () => $.ret($.i(0)));
      const hi = $.agetU(this.d.strT, S, $.sub(I, $.i(1)));
      const lo = $.agetU(this.d.strT, S, I);
      $.do($.both($.both($.geU(hi, $.i(0xd800)), $.ltU(hi, $.i(0xdc00))), $.both($.geU(lo, $.i(0xdc00)), $.ltU(lo, $.i(0xe000)))));
    });
  }
}
