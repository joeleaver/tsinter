/* INC-24 P1, CP4: %w.re.exec end to end — REAL bytecode from this
 * port's own already-byte-verified assemble() (CP3), run through the
 * wasm interpreter, compared against Node's own regex matching. Every
 * test pattern here is STICKY (assemble()'s own `sticky: true`) as a
 * deliberate SCOPE choice for this file specifically — not because
 * exec() can't handle the alternative. STALE CLAIM CORRECTED (CP4 back
 * half): an earlier draft of this comment said the non-sticky search-
 * loop prelude "needs a genuine loop construct exec() doesn't
 * implement yet" — true when written, false by the time split_goto_
 * first/any/goto (the prelude's own three opcodes, regex-assembler.ts:
 * 716-723) were built, and never corrected. Sticky-vs-search is
 * entirely a BYTECODE-SHAPE decision the ASSEMBLER makes; exec() never
 * reads the header's own STICKY bit and is shape-agnostic. Proven
 * (not just reasoned) through real exec() end to end in
 * wasm-regex-nonsticky-prelude.test.ts (12 hand-picked cases) and
 * wasm-regex-corpus-match-sweep.test.ts's own SECOND, non-sticky pass
 * over the full 3,000-pair corpus — both green.
 *
 * This file itself STAYS sticky-only by scope (its own job is pinning
 * every opcode this slice's exec() handles individually, not re-
 * proving the prelude) — restricted to opcodes THIS SLICE's
 * exec() handles: char/char32/char_i/char32_i/dot/any/save_start/
 * save_end/save_reset/split_goto_first/split_next_first/goto/prev/
 * range/range_i/range32/range32_i/space/not_space/line_start(_m)/
 * line_end(_m)/word_boundary(_i)/not_word_boundary(_i)/set_i32/loop/
 * loop_split_{goto,next}_first/loop_check_adv_split_{goto,next}_first/
 * set_char_pos/check_advance/lookahead/negative_lookahead/lookahead_
 * match/negative_lookahead_match/back_reference/back_reference_i/
 * backward_back_reference/backward_back_reference_i/match — THE FULL
 * OPCODE SET this port's interpreter implements (regex-interpreter.ts's
 * own doc comment). Quantifiers a-star/a-plus/a-question/BOUNDED-COUNT
 * (`a{3}`, `a{2,5}`, `a{2,}` — the register family), alternation,
 * capturing groups (both plain and QUANTIFIED, unbounded `(a)*` and
 * bounded `(a){2,3}`, both exercising save_reset), character classes
 * (plain, negated, case-insensitive, and astral via range32), dot/any's
 * line-terminator distinction, line/word anchors (plain and /m, plain
 * and /iu — the KELVIN SIGN/LONG S special case), positive and negative
 * lookahead (both success/failure directions, a preserved capture
 * through a successful lookahead, and a quantifier INSIDE a lookahead
 * body — lookaheadMatch's own compaction through real bytecode),
 * forward and backward backreferences (plain, ignoreCase, a forward
 * reference to a not-yet-closed group, ES2025 duplicate named capture
 * groups exercising the search loop's own scan-past-an-unset-candidate
 * path, and lookbehind — reachable through REAL patterns, reusing the
 * already-built lookahead machinery), and GENUINE backtracking (a*a for
 * plain split,
 * a{2,5}a for the register family's own conditional split — both
 * needing noMatch to pop back and retry with one fewer repetition
 * consumed) are all in scope now that split/goto/the general no_match
 * are wired in. */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { assemble, type AssembleFlags } from "../src/backend/wasm/regex-assembler.js";
import { RE_HEADER_REGISTER_COUNT } from "../src/backend/wasm/regex-opcodes.js";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";

interface Case {
  pattern: string;
  subject: string;
  startIndex: number;
  unicode: boolean;
  dotAll?: boolean;
  ignoreCase?: boolean;
  multiLine?: boolean;
}

const CASES: Case[] = [
  { pattern: "a", subject: "a", startIndex: 0, unicode: false },
  { pattern: "a", subject: "b", startIndex: 0, unicode: false },
  { pattern: "ab", subject: "ab", startIndex: 0, unicode: false },
  { pattern: "ab", subject: "ac", startIndex: 0, unicode: false },
  { pattern: "ab", subject: "xab", startIndex: 1, unicode: false }, // sticky: must match starting EXACTLY at startIndex
  { pattern: "ab", subject: "xab", startIndex: 0, unicode: false }, // sticky at the WRONG index: no match
  { pattern: "abc", subject: "abc", startIndex: 0, unicode: false },
  { pattern: "abc", subject: "ab", startIndex: 0, unicode: false }, // subject too short
  { pattern: "\u{1F600}", subject: "\u{1F600}", startIndex: 0, unicode: true }, // astral literal, /u — exercises char32
  { pattern: "\u{1F600}", subject: "\u{1F601}", startIndex: 0, unicode: true }, // a DIFFERENT astral char: no match

  // Quantifiers (a*/a+/a? all compile via split+goto per CP3's own
  // emitQuantifier — no loop/set_i32 needed for these three shapes).
  { pattern: "a*", subject: "", startIndex: 0, unicode: false }, // a* can match ZERO times: succeeds empty
  { pattern: "a*", subject: "aaa", startIndex: 0, unicode: false },
  { pattern: "a*", subject: "b", startIndex: 0, unicode: false }, // still succeeds, matching "" — a* never fails
  { pattern: "a+", subject: "aaa", startIndex: 0, unicode: false },
  { pattern: "a+", subject: "b", startIndex: 0, unicode: false }, // a+ requires AT LEAST one: fails
  { pattern: "a?", subject: "a", startIndex: 0, unicode: false },
  { pattern: "a?", subject: "b", startIndex: 0, unicode: false }, // matches "" (zero is allowed)

  // Alternation (REOP_split_next_first + goto chains).
  { pattern: "a|b", subject: "a", startIndex: 0, unicode: false },
  { pattern: "a|b", subject: "b", startIndex: 0, unicode: false }, // FIRST alternative fails, backtracks to the second
  { pattern: "a|b", subject: "c", startIndex: 0, unicode: false }, // both fail: no match
  { pattern: "a|b|c", subject: "c", startIndex: 0, unicode: false }, // must backtrack THROUGH two failed alternatives

  // Capturing group (exercises save_start(1)/save_end(1) — NOT just
  // capture 0 — participating correctly in the SAME dispatch/backtrack
  // machinery already proven for capture 0 alone).
  { pattern: "(a)", subject: "a", startIndex: 0, unicode: false },

  // GENUINE backtracking: a* greedily consumes ALL available a's first
  // (per libregexp's own greedy-first ordering), which leaves nothing
  // for the trailing mandatory `a` — the match only succeeds because
  // no_match correctly pops back to the split's OTHER branch (one fewer
  // a consumed) and retries, repeatedly if needed.
  { pattern: "a*a", subject: "aaa", startIndex: 0, unicode: false }, // a* must give back exactly one 'a'
  { pattern: "a*a", subject: "a", startIndex: 0, unicode: false }, // a* must give back its ONLY 'a' (down to zero)
  { pattern: "a*a", subject: "", startIndex: 0, unicode: false }, // a* has nothing to give back at all: no match

  // REOP_dot / REOP_any: `.` matches anything EXCEPT a line terminator
  // (dot); under /s it becomes `any`, matching EVERYTHING including
  // line terminators.
  { pattern: ".", subject: "a", startIndex: 0, unicode: false },
  { pattern: ".", subject: "\n", startIndex: 0, unicode: false }, // dot: line terminator fails
  { pattern: ".", subject: "", startIndex: 0, unicode: false }, // dot: nothing to read fails
  { pattern: ".", subject: "\n", startIndex: 0, unicode: false, dotAll: true }, // any (/s): line terminator SUCCEEDS
  { pattern: ".", subject: "\u{1F600}", startIndex: 0, unicode: true }, // dot combines a surrogate pair via getChar under /u — one astral char, not two lone surrogates

  // REOP_save_reset: QUANTIFIED capturing groups. `(a)*` compiles a
  // save_reset ahead of the loop body so a run that executes the group
  // ZERO times leaves capture 1 genuinely UNSET (-1), not stale from
  // some earlier attempt; a run that executes it MULTIPLE times must
  // report the LAST iteration's span, not the first.
  { pattern: "(a)*", subject: "aaa", startIndex: 0, unicode: false }, // 3 iterations: capture 1 = the LAST 'a' (index 2-3)
  { pattern: "(a)*", subject: "", startIndex: 0, unicode: false }, // ZERO iterations: capture 1 must be unset, not stale
  { pattern: "(a)*b", subject: "aaab", startIndex: 0, unicode: false }, // reset survives a trailing mandatory literal after the loop
  { pattern: "(a)?", subject: "b", startIndex: 0, unicode: false }, // save_reset also guards the zero-or-one case (matches "", capture 1 unset)

  // REOP_char_i: ignore-case matching, exercising regexCanonicalize()'s
  // runtime half. `val` (the bytecode operand) is ALREADY canonicalized
  // at PARSE time — these cases exist to prove the SUBJECT character
  // gets canonicalized correctly too, not just that a pre-canonicalized
  // literal happens to round-trip.
  { pattern: "a", subject: "A", startIndex: 0, unicode: false, ignoreCase: true }, // plain ASCII cross-case
  { pattern: "A", subject: "a", startIndex: 0, unicode: false, ignoreCase: true }, // the reverse direction
  { pattern: "a", subject: "b", startIndex: 0, unicode: false, ignoreCase: true }, // still fails — /i doesn't match EVERYTHING
  { pattern: "σ", subject: "Σ", startIndex: 0, unicode: false, ignoreCase: true }, // non-ASCII cross-case, genuinely exercising the table (not just ASCII A-Z)
  // The famous >=128-but-canonicalizes-into-ASCII guard (regex-canon.
  // ts's own `cp>=128 && cu<128 -> cp`, ported here as regexCanonicalize's
  // override-skip): LATIN SMALL LETTER LONG S (U+017F) uppercases to
  // plain ASCII 'S', but the guard means canonicalize(0x17F) stays
  // 0x17F, NOT 0x53 — so /s/i must NOT match it, matching real Node
  // behavior (`/s/i.test('ſ')` === false), not a naive "uppercase
  // and compare" that would wrongly match.
  { pattern: "s", subject: "ſ", startIndex: 0, unicode: false, ignoreCase: true }, // guard fires: no match despite same uppercase target
  { pattern: "ſ", subject: "s", startIndex: 0, unicode: false, ignoreCase: true }, // same guard, reversed direction

  // REOP_range/range32(_i) and REOP_space/not_space: rangeSearch()'s
  // own wiring through real assembled patterns (all reachable through
  // this port's own assemble() — confirmed directly by probing, not
  // assumed).
  { pattern: "\\d", subject: "5", startIndex: 0, unicode: false }, // REOP_range (16-bit)
  { pattern: "\\d", subject: "a", startIndex: 0, unicode: false },
  { pattern: "[a-z]", subject: "m", startIndex: 0, unicode: false },
  { pattern: "[a-z]", subject: "M", startIndex: 0, unicode: false }, // case-sensitive: no match
  { pattern: "[a-z]", subject: "M", startIndex: 0, unicode: false, ignoreCase: true }, // REOP_range_i: reuses regexCanonicalize on the subject char
  { pattern: "[^a]", subject: "b", startIndex: 0, unicode: false }, // a NEGATED class — still just REOP_range over an inverted CharRange
  { pattern: "[^a]", subject: "a", startIndex: 0, unicode: false },
  { pattern: "\\s", subject: " ", startIndex: 0, unicode: false }, // REOP_space, the FIXED \s table
  { pattern: "\\s", subject: "\t", startIndex: 0, unicode: false }, // a DIFFERENT \s member (the 0x9-0xe run), not just the common ASCII space
  { pattern: "\\s", subject: "a", startIndex: 0, unicode: false },
  { pattern: "\\S", subject: "a", startIndex: 0, unicode: false }, // REOP_not_space, the FIXED \S table (crInvert of the same CharRange)
  { pattern: "\\S", subject: " ", startIndex: 0, unicode: false },
  // REOP_range32: an astral class, only reachable under /u (the ONLY
  // way a single class member's high boundary exceeds 0xFFFF).
  { pattern: "[\\u{10000}-\\u{10FFFF}]", subject: "\u{1F600}", startIndex: 0, unicode: true },
  { pattern: "[\\u{10000}-\\u{10FFFF}]", subject: "a", startIndex: 0, unicode: true }, // BMP char: below the astral range entirely

  // REOP_line_start(_m)/line_end(_m): anchors, both plain and /m.
  { pattern: "^a", subject: "a", startIndex: 0, unicode: false }, // line_start: at subject start
  { pattern: "^a", subject: "xa", startIndex: 1, unicode: false }, // line_start: NOT at subject start — fails even though sticky tries exactly here
  { pattern: "^a", subject: "x\na", startIndex: 2, unicode: false, multiLine: true }, // line_start_m: right after a line terminator
  { pattern: "^a", subject: "xa", startIndex: 1, unicode: false, multiLine: true }, // line_start_m: preceding char is NOT a line terminator
  { pattern: "a$", subject: "a", startIndex: 0, unicode: false }, // line_end: at subject end
  { pattern: "a$", subject: "ab", startIndex: 0, unicode: false }, // line_end: NOT at subject end
  { pattern: "a$", subject: "a\nb", startIndex: 0, unicode: false, multiLine: true }, // line_end_m: next char is a line terminator
  { pattern: "a$", subject: "ab", startIndex: 0, unicode: false, multiLine: true }, // line_end_m: next char is NOT a line terminator, not at end either

  // REOP_word_boundary(_i)/not_word_boundary(_i).
  { pattern: "\\ba", subject: "a", startIndex: 0, unicode: false }, // subject start, 'a' is a word char: a boundary
  { pattern: "\\ba", subject: "ba", startIndex: 1, unicode: false }, // both sides word chars: NO boundary
  { pattern: "\\Ba", subject: "ba", startIndex: 1, unicode: false }, // \B: succeeds exactly where \b would fail
  { pattern: "\\Ba", subject: "a", startIndex: 0, unicode: false }, // \B: fails exactly where \b would succeed
  // The KELVIN SIGN (U+212A) / LATIN SMALL LETTER LONG S (U+017F)
  // ignoreCase-gated special case — word_boundary_i is ONLY chosen by
  // this port's assembler under /iu together (confirmed by probing
  // directly, not assumed symmetric with char_i's own gating), and \b
  // itself is NOT subject to the /iu character-compilation fence (it
  // never calls canonicalize() — the ignoreCase gate here is a plain
  // RUNTIME comparison against two hardcoded codepoints). These two
  // cases are a DISCRIMINATING pair: same subject/position, only
  // ignoreCase differs, expecting OPPOSITE results.
  { pattern: "\\b", subject: "K", startIndex: 0, unicode: true, ignoreCase: true }, // ignoreCase: Kelvin sign counts as word-like -> boundary
  { pattern: "\\b", subject: "K", startIndex: 0, unicode: true }, // no ignoreCase: Kelvin sign is NOT word-like -> no boundary
  // An astral emoji at a \b position — proves peekChar's own surrogate
  // combining is exercised correctly from WITHIN word_boundary's own
  // call sites, not just in isolation: the combined codepoint is
  // >=256 and matches neither special case, so it's correctly treated
  // as non-word (no boundary), the same as any other non-word char.
  { pattern: "\\b", subject: "\u{1F600}", startIndex: 0, unicode: true },

  // REOP_set_i32/loop/loop_split_*/set_char_pos/check_advance — the
  // REGISTER family, bounded-count quantifiers (`a{3}`, `a{2,5}`).
  // save_start/set_i32/char/loop/save_end/match for an exact count;
  // loop_split_goto_first for an open or ranged count.
  { pattern: "a{3}", subject: "aaa", startIndex: 0, unicode: false }, // exact count, exactly satisfied
  { pattern: "a{3}", subject: "aa", startIndex: 0, unicode: false }, // exact count, one short — the loop's own iterations fail via char's cptr>=len check, not the loop opcode itself
  { pattern: "a{2,5}", subject: "aaaa", startIndex: 0, unicode: false }, // ranged, greedy: consumes as many as available up to the max
  { pattern: "a{2,}", subject: "aaa", startIndex: 0, unicode: false }, // open-ended minimum
  { pattern: "a{2,}", subject: "a", startIndex: 0, unicode: false }, // open-ended minimum NOT reached: fails
  // GENUINE backtracking through loop_split: a{2,5} greedily consumes
  // ALL 4 available a's first (nothing left over), which leaves
  // nothing for the trailing mandatory `a` — only succeeds because
  // noMatch correctly pops back to loop_split's OWN pushed backtrack
  // point (one fewer a consumed) and retries. The SAME mechanism
  // a*a's own test already proved for PLAIN split, exercised here for
  // the register family's conditional split instead.
  { pattern: "a{2,5}a", subject: "aaaa", startIndex: 0, unicode: false },
  // A quantified CAPTURING group under a bounded count — proves
  // save_reset (already built) and the register family compose
  // correctly together, the same coverage (a)*'s own tests established
  // for the unbounded case.
  { pattern: "(a){2,3}", subject: "aaa", startIndex: 0, unicode: false },
  { pattern: "(a){2,3}", subject: "aa", startIndex: 0, unicode: false }, // exactly the minimum, no more available

  // REOP_lookahead/negative_lookahead + their _match forms.
  { pattern: "a(?=b)", subject: "ab", startIndex: 0, unicode: false }, // positive lookahead succeeds — ZERO-WIDTH: match length is 1, not 2
  { pattern: "a(?=b)", subject: "ac", startIndex: 0, unicode: false }, // positive lookahead body fails: ordinary backtrack, no new opcode exercised
  { pattern: "(?=(a))a", subject: "a", startIndex: 0, unicode: false }, // lookaheadMatch's own "preserve, never undo" contract, through a REAL capturing group
  { pattern: "(?=a+)a", subject: "aaa", startIndex: 0, unicode: false }, // the lookahead BODY itself contains a quantifier (an internal split marker lookaheadMatch must compact away) — through REAL bytecode, not just the synthetic fixture
  { pattern: "a(?!b)", subject: "ac", startIndex: 0, unicode: false }, // negative lookahead succeeds (body fails) — via noMatch's OWN existing "continue past LOOKAHEAD" path, no new opcode's OWN match-arm exercised here
  { pattern: "a(?!b)", subject: "ab", startIndex: 0, unicode: false }, // negative lookahead FAILS (body succeeds) — exercises negative_lookahead_match's own new code
  { pattern: "(?!a)b", subject: "b", startIndex: 0, unicode: false }, // negative lookahead succeeds, standalone (no preceding literal)
  { pattern: "(?!a)b", subject: "ab", startIndex: 0, unicode: false }, // negative lookahead fails, standalone: no match at all (nothing to backtrack to)

  // REOP_back_reference(_i)/backward_back_reference(_i) — the LAST
  // opcode family, closing the interpreter's own opcode set entirely.
  { pattern: "(a)\\1", subject: "aa", startIndex: 0, unicode: false }, // forward backreference matches
  { pattern: "(a)\\1", subject: "ab", startIndex: 0, unicode: false }, // forward backreference mismatches
  { pattern: "(a)\\1", subject: "aA", startIndex: 0, unicode: false, ignoreCase: true }, // ignoreCase: matches despite the case difference
  { pattern: "(a)\\1", subject: "ab", startIndex: 0, unicode: false, ignoreCase: true }, // ignoreCase doesn't make EVERYTHING match — still fails here
  { pattern: "\\1(a)", subject: "a", startIndex: 0, unicode: false }, // \1 references a group NOT YET closed (forward in pattern order) — trivially matches empty, per ECMA-262's own rule
  // Duplicate named capture groups across alternation (ES2025) — n=2
  // for THIS opcode's own search loop, genuinely exercising the "scan
  // PAST a candidate whose capture is unset" path (this port's own
  // hand-traced br(1)-vs-br(2) fix in emitBackReference's own search
  // loop — a wrong depth here would have either infinite-looped
  // (caught by external timeout) or incorrectly stopped at the FIRST
  // unset candidate instead of continuing to the SET one).
  { pattern: "(?<x>a)|(?<x>b)\\k<x>", subject: "bb", startIndex: 0, unicode: false }, // alt1 fails, alt2's own group (index 2, NOT index 1) is what's actually set
  { pattern: "(?<x>a)|(?<x>b)\\k<x>", subject: "ba", startIndex: 0, unicode: false }, // same construct, genuine mismatch once the SET candidate (group 2, "b") is found
  // backward_back_reference — the arm with NO test precedent anywhere
  // in this port's own corpus or gate history, per the lead's own
  // explicit standing requirement. Reachable through REAL lookbehind
  // patterns, not hand-built bytecode (lookbehind reuses the already-
  // built lookahead machinery, wrapping REOP_prev-wrapped atoms).
  { pattern: "(a)(?<=\\1)", subject: "a", startIndex: 0, unicode: false }, // positive: the lookbehind trivially confirms the JUST-captured text
  { pattern: "(ab)c(?<=\\1)", subject: "abcab", startIndex: 0, unicode: false }, // genuine mismatch: the 2 characters before the check point are "bc", not capture1's own "ab"
];

function flagsFor(tc: Case): AssembleFlags {
  return { global: false, ignoreCase: !!tc.ignoreCase, multiLine: !!tc.multiLine, dotAll: !!tc.dotAll, unicode: tc.unicode, sticky: true };
}

interface ExecExports {
  exec: (bc: unknown, subject: unknown, startIndex: number, captureOut: unknown) => number;
  newCaptureArray: (count: number) => unknown;
  capAt: (arr: unknown, i: number) => number;
  bcLit: (i: number) => unknown;
  subjLit: (i: number) => unknown;
}

async function build(): Promise<ExecExports> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const bcType = mb.arrayType("i8", false);
  const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
  const capType = mb.arrayType(I32, true);
  const capRef: ValType = { kind: "ref", nullable: true, typeIndex: capType };
  const interp = new RegexInterpreterBuilder(mb, strType);

  const strUnits = (s: string): Uint8Array => {
    const units = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    return units;
  };

  const bcLitFn = mb.declareFunc(mb.funcType([I32], [bcRef]), "bcLit");
  {
    const c = new Code();
    CASES.forEach((tc, i) => {
      const flags = flagsFor(tc);
      const parsed = parsePattern(tc.pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
      if (parsed === null || parsed.next !== tc.pattern.length) throw new Error(`parse failed for /${tc.pattern}/`);
      const asm = assemble(parsed.ast, flags);
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      const off = mb.internData(asm.bytes);
      c.i32Const(off);
      c.i32Const(asm.bytes.length);
      c.arrayNewData(bcType, 0);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(bcLitFn, [], c.bytes());
  }

  const subjLitFn = mb.declareFunc(mb.funcType([I32], [strRef]), "subjLit");
  {
    const c = new Code();
    CASES.forEach((tc, i) => {
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      const units = strUnits(tc.subject);
      const off = mb.internData(units);
      c.i32Const(off);
      c.i32Const(tc.subject.length);
      c.arrayNewData(strType, 0);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(subjLitFn, [], c.bytes());
  }

  const capAtFn = mb.declareFunc(mb.funcType([capRef, I32], [I32]), "capAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGet(capType);
    mb.setBody(capAtFn, [], c.bytes());
  }

  mb.exportFunc("bcLit", bcLitFn);
  mb.exportFunc("subjLit", subjLitFn);
  mb.exportFunc("capAt", capAtFn);
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  mb.exportFunc("exec", interp.exec());

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`regex-interpreter exec module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as ExecExports;
}

function captureCountFor(tc: Case): number {
  const flags = flagsFor(tc);
  const parsed = parsePattern(tc.pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
  if (parsed === null || parsed.next !== tc.pattern.length) throw new Error(`parse failed for /${tc.pattern}/`);
  return assemble(parsed.ast, flags).captureCount;
}

// newCaptureArray(count) allocates 2*count i32 slots — captureCountFor's
// own unit. Bounded-count quantifiers (a{3}, a{2,5}) also need REGISTER
// slots PAST the real capture slots, in the SAME array (RE_HEADER_
// REGISTER_COUNT — not exposed on AssembleResult as its own field, read
// straight off the emitted header byte instead). newCaptureArray has no
// "N extra raw slots" mode, so this just asks for a few more CAPTURE
// units than strictly needed — the padding slots are harmless (stay -1,
// nothing ever reads them) and every OTHER assertion in the main loop
// below is bounded by the REAL captureCount, never by the array's own
// (possibly padded) length.
function captureArrayCountFor(tc: Case): number {
  const flags = flagsFor(tc);
  const parsed = parsePattern(tc.pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
  if (parsed === null || parsed.next !== tc.pattern.length) throw new Error(`parse failed for /${tc.pattern}/`);
  const asm = assemble(parsed.ast, flags);
  const registerCount = asm.bytes[RE_HEADER_REGISTER_COUNT]!;
  return asm.captureCount + Math.ceil(registerCount / 2);
}

describe("%w.re.exec: literal patterns, quantifiers, alternation, groups, and genuine backtracking — byte-verified bytecode from THIS port's own assemble(), verified against Node's own regex matching", () => {
  CASES.forEach((tc, i) => {
    test(`/${tc.pattern}/y against ${JSON.stringify(tc.subject)} at index ${tc.startIndex}`, async () => {
      const ex = await build();
      const flags = flagsFor(tc);
      const flagStr = "y" + (flags.unicode ? "u" : "") + (flags.dotAll ? "s" : "") + (flags.ignoreCase ? "i" : "") + (flags.multiLine ? "m" : "");
      const nodeRe = new RegExp(tc.pattern, flagStr);
      nodeRe.lastIndex = tc.startIndex;
      const nodeMatch = nodeRe.exec(tc.subject);

      const bc = ex.bcLit(i);
      const subj = ex.subjLit(i);
      const captureCount = captureCountFor(tc);
      const captureOut = ex.newCaptureArray(captureArrayCountFor(tc));
      const result = ex.exec(bc, subj, tc.startIndex, captureOut);

      if (nodeMatch === null) {
        expect(result, `expected no match for /${tc.pattern}/y on ${JSON.stringify(tc.subject)}@${tc.startIndex}`).toBe(0);
      } else {
        expect(result, `expected a match for /${tc.pattern}/y on ${JSON.stringify(tc.subject)}@${tc.startIndex}`).toBe(1);
        const start = ex.capAt(captureOut, 0);
        const end = ex.capAt(captureOut, 1);
        expect(start, "capture 0 start").toBe(tc.startIndex);
        expect(end - start, "capture 0 length").toBe(nodeMatch[0].length);
        // Check every user capturing group too, not just capture 0 —
        // proves save_start(N)/save_end(N) for N>0 participate
        // correctly in the SAME dispatch/backtrack machinery, not just
        // capture 0 (already exercised extensively above).
        for (let g = 1; g < captureCount; g++) {
          const gStart = ex.capAt(captureOut, 2 * g);
          const gEnd = ex.capAt(captureOut, 2 * g + 1);
          if (nodeMatch[g] === undefined) {
            expect(gStart, `capture ${g} should be unset (-1)`).toBe(-1);
            expect(gEnd, `capture ${g} should be unset (-1)`).toBe(-1);
          } else {
            expect(gEnd - gStart, `capture ${g} length`).toBe(nodeMatch[g].length);
          }
        }
      }
    });
  });
});

// REOP_prev cannot yet be reached through ANY pattern this port's OWN
// assemble() can produce end to end: it's only ever emitted for
// backward-direction (lookbehind) atom wrapping, and lookbehind needs
// REOP_lookahead/REOP_negative_lookahead, which exec() doesn't
// implement yet (this file's own doc comment). So it is pinned here via
// HAND-BUILT bytecode, bypassing assemble() entirely — matching the
// SAME "prove the mechanism directly, not just by inspection" standard
// as noMatch's synthetic-stack pins. Opcode values from regex-opcodes.ts:
// char=1, save_start=19, save_end=20, match=16, prev=44. Header: u16
// flags (STICKY=0x20, no other bits), u8 captureCount=1, u8
// registerCount=0, u32 bodyLength.
describe("%w.re.exec: REOP_prev, hand-built bytecode (not yet reachable through any assembled pattern — see this file's own note above)", () => {
  function header(bodyLen: number): number[] {
    return [0x20, 0x00, 1, 0, bodyLen & 0xff, (bodyLen >> 8) & 0xff, (bodyLen >> 16) & 0xff, (bodyLen >> 24) & 0xff];
  }
  const A = "a".charCodeAt(0);

  test("save_start(0), char('a'), prev, char('a'), save_end(0), match — reading 'a' TWICE at the SAME position (prev undoes the advance)", async () => {
    const body = [
      19,
      0, // save_start(0)
      1,
      A & 0xff,
      (A >> 8) & 0xff, // char('a')
      44, // prev
      1,
      A & 0xff,
      (A >> 8) & 0xff, // char('a') again — only reachable if prev correctly rewound cptr
      20,
      0, // save_end(0)
      16, // match
    ];
    const bc = new Uint8Array([...header(body.length), ...body]);

    const mb = new ModuleBuilder();
    const strType = mb.arrayType("i16", true);
    const bcType = mb.arrayType("i8", false);
    const capType = mb.arrayType(I32, true);
    const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
    const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
    const capRef: ValType = { kind: "ref", nullable: true, typeIndex: capType };
    const interp = new RegexInterpreterBuilder(mb, strType);

    const bcOff = mb.internData(bc);
    const bcLitFn = mb.declareFunc(mb.funcType([], [bcRef]), "bcLit");
    {
      const c = new Code();
      c.i32Const(bcOff);
      c.i32Const(bc.length);
      c.arrayNewData(bcType, 0);
      mb.setBody(bcLitFn, [], c.bytes());
    }
    const subjBytes = new Uint8Array([A & 0xff, (A >> 8) & 0xff]); // "a", one UTF-16 code unit
    const subjOff = mb.internData(subjBytes);
    const subjLitFn = mb.declareFunc(mb.funcType([], [strRef]), "subjLit");
    {
      const c = new Code();
      c.i32Const(subjOff);
      c.i32Const(1);
      c.arrayNewData(strType, 0);
      mb.setBody(subjLitFn, [], c.bytes());
    }
    const capAtFn = mb.declareFunc(mb.funcType([capRef, I32], [I32]), "capAt");
    {
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.arrayGet(capType);
      mb.setBody(capAtFn, [], c.bytes());
    }
    mb.exportFunc("bcLit", bcLitFn);
    mb.exportFunc("subjLit", subjLitFn);
    mb.exportFunc("capAt", capAtFn);
    mb.exportFunc("newCaptureArray", interp.newCaptureArray());
    mb.exportFunc("exec", interp.exec());
    const bytes = mb.emit();
    new WebAssembly.Module(bytes); // validate
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports as unknown as {
      bcLit: () => unknown;
      subjLit: () => unknown;
      capAt: (arr: unknown, i: number) => number;
      newCaptureArray: (n: number) => unknown;
      exec: (bc: unknown, subject: unknown, startIndex: number, captureOut: unknown) => number;
    };
    const captureOut = ex.newCaptureArray(1);
    const result = ex.exec(ex.bcLit(), ex.subjLit(), 0, captureOut);
    expect(result, "prev correctly rewound cptr, letting the second char('a') match the SAME position").toBe(1);
    expect(ex.capAt(captureOut, 0)).toBe(0);
    expect(ex.capAt(captureOut, 1)).toBe(1); // net ONE character consumed, not two — prev cancelled the first char's advance
  });

  test("prev at the very start of the subject (cptr==0): fails immediately, matching libregexp.c:3322-3323's own `cptr == s->cbuf` guard", async () => {
    const body = [
      19,
      0, // save_start(0)
      44, // prev — immediately, at cptr==0
      20,
      0, // save_end(0)
      16, // match
    ];
    const bc = new Uint8Array([...header(body.length), ...body]);

    const mb = new ModuleBuilder();
    const strType = mb.arrayType("i16", true);
    const bcType = mb.arrayType("i8", false);
    const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
    const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
    const interp = new RegexInterpreterBuilder(mb, strType);

    const bcOff = mb.internData(bc);
    const bcLitFn = mb.declareFunc(mb.funcType([], [bcRef]), "bcLit");
    {
      const c = new Code();
      c.i32Const(bcOff);
      c.i32Const(bc.length);
      c.arrayNewData(bcType, 0);
      mb.setBody(bcLitFn, [], c.bytes());
    }
    const subjBytes = new Uint8Array([A & 0xff, (A >> 8) & 0xff]);
    const subjOff = mb.internData(subjBytes);
    const subjLitFn = mb.declareFunc(mb.funcType([], [strRef]), "subjLit");
    {
      const c = new Code();
      c.i32Const(subjOff);
      c.i32Const(1);
      c.arrayNewData(strType, 0);
      mb.setBody(subjLitFn, [], c.bytes());
    }
    mb.exportFunc("bcLit", bcLitFn);
    mb.exportFunc("subjLit", subjLitFn);
    mb.exportFunc("newCaptureArray", interp.newCaptureArray());
    mb.exportFunc("exec", interp.exec());
    const bytes = mb.emit();
    new WebAssembly.Module(bytes);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports as unknown as {
      bcLit: () => unknown;
      subjLit: () => unknown;
      newCaptureArray: (n: number) => unknown;
      exec: (bc: unknown, subject: unknown, startIndex: number, captureOut: unknown) => number;
    };
    const captureOut = ex.newCaptureArray(1);
    const result = ex.exec(ex.bcLit(), ex.subjLit(), 0, captureOut);
    expect(result, "prev at cptr==0 must fail, not underflow").toBe(0);
  });
});

// REOP_char32_i, same reachability gap as REOP_prev above: this port's
// OWN assembler NEVER emits it through any complete pattern, because
// the only way a single char node's codepoint exceeds 0xFFFF is under
// /u (unicode mode), and ignoreCase+unicode together is FENCED (design
// §6.3(a) — /iu needs simple case FOLDING, a different algorithm this
// port refuses) — confirmed directly: parsing "\u{10428}" with both
// ignoreCase and unicode set THROWS regex-parser's own refusal, it
// never reaches emitChar at all. So char32_i is pinned here via
// hand-built bytecode, same technique as REOP_prev's own two blobs —
// this does NOT reproduce the compiler's fence (that stays enforced at
// the parser, see wasm-regex-parser.test.ts), it proves exec()'s OWN
// interpretation of char32_i is correct independent of whether this
// port's compiler currently has any way to reach it.
describe("%w.re.exec: REOP_char32_i, hand-built bytecode (fenced by design §6.3(a) at the PARSER, not reachable through any assembled pattern — see this file's own note above)", () => {
  const header = (bodyLen: number): number[] => [
    0x30,
    0x00, // STICKY(0x20) | UNICODE(0x10) — UNICODE is needed for getChar to combine the subject's surrogate pair; exec() doesn't know about the compiler's own /iu fence, it just interprets the flags word
    1,
    0,
    bodyLen & 0xff,
    (bodyLen >> 8) & 0xff,
    (bodyLen >> 16) & 0xff,
    (bodyLen >> 24) & 0xff,
  ];
  // DESERET SMALL LETTER LONG A (U+10428) uppercases to DESERET CAPITAL
  // LETTER LONG A (U+10400) — a REAL astral case pair (verified via
  // Node's own String.prototype.toUpperCase directly, not assumed),
  // chosen specifically so this pin exercises the ACTUAL case table for
  // a codepoint above the BMP, not merely "the wiring doesn't crash".
  // val is regex-canon.ts's canonicalize(0x10428) computed by hand here
  // (0x10400 — single-codepoint result, cp>=128 but r0=0x10400 is NOT
  // <128, so the ASCII-boundary guard does not fire) — this is exactly
  // what the real parser would embed if the /iu fence didn't block it.
  const CHAR32_I_VAL = 0x10400;
  function u32le(v: number): number[] {
    return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  }
  function surrogatePair(cp: number): number[] {
    const s = String.fromCodePoint(cp);
    const hi = s.charCodeAt(0);
    const lo = s.charCodeAt(1)!;
    return [hi & 0xff, hi >> 8, lo & 0xff, lo >> 8];
  }

  async function buildAndRun(subjectCp: number): Promise<number> {
    const body = [19, 0, 4, ...u32le(CHAR32_I_VAL), 20, 0, 16]; // save_start(0), char32_i(0x10400), save_end(0), match
    const bc = new Uint8Array([...header(body.length), ...body]);

    const mb = new ModuleBuilder();
    const strType = mb.arrayType("i16", true);
    const bcType = mb.arrayType("i8", false);
    const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
    const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
    const interp = new RegexInterpreterBuilder(mb, strType);

    const bcOff = mb.internData(bc);
    const bcLitFn = mb.declareFunc(mb.funcType([], [bcRef]), "bcLit");
    {
      const c = new Code();
      c.i32Const(bcOff);
      c.i32Const(bc.length);
      c.arrayNewData(bcType, 0);
      mb.setBody(bcLitFn, [], c.bytes());
    }
    const subjBytes = new Uint8Array(surrogatePair(subjectCp));
    const subjOff = mb.internData(subjBytes);
    const subjLitFn = mb.declareFunc(mb.funcType([], [strRef]), "subjLit");
    {
      const c = new Code();
      c.i32Const(subjOff);
      c.i32Const(2); // two UTF-16 code units
      c.arrayNewData(strType, 0);
      mb.setBody(subjLitFn, [], c.bytes());
    }
    mb.exportFunc("bcLit", bcLitFn);
    mb.exportFunc("subjLit", subjLitFn);
    mb.exportFunc("newCaptureArray", interp.newCaptureArray());
    mb.exportFunc("exec", interp.exec());
    const bytes = mb.emit();
    new WebAssembly.Module(bytes);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports as unknown as {
      bcLit: () => unknown;
      subjLit: () => unknown;
      newCaptureArray: (n: number) => unknown;
      exec: (bc: unknown, subject: unknown, startIndex: number, captureOut: unknown) => number;
    };
    const captureOut = ex.newCaptureArray(1);
    return ex.exec(ex.bcLit(), ex.subjLit(), 0, captureOut);
  }

  test("char32_i(canonicalize(U+10428)) against the LOWERCASE original U+10428 itself — subject-side canonicalization must run", async () => {
    const result = await buildAndRun(0x10428);
    expect(result, "canonicalize(0x10428) === canonicalize(0x10428) === 0x10400").toBe(1);
  });

  test("char32_i(canonicalize(U+10428)) against the UPPERCASE target U+10400 — already-canonical subject still matches", async () => {
    const result = await buildAndRun(0x10400);
    expect(result, "canonicalize(0x10400) === 0x10400 (identity, already uppercase)").toBe(1);
  });

  test("char32_i(canonicalize(U+10428)) against an UNRELATED astral char (U+1F600) — must still fail, not match everything astral", async () => {
    const result = await buildAndRun(0x1f600);
    expect(result, "an emoji has no case mapping — canonicalize(0x1F600) === 0x1F600 !== 0x10400").toBe(0);
  });
});
