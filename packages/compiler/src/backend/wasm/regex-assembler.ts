/* INC-24 P1, CP3: the bytecode assembler — walks a RegexAst (regex-ast.ts)
 * and emits libregexp-compatible bytecode via RegexByteWriter, matching
 * lre_compile byte-for-byte (verified against the live lre_compile
 * oracle, not argued). Built incrementally, smallest pattern first, per
 * the lead's own CP3 sequencing: "the lre_compile byte harness IS the
 * emission design check... convert design errors into immediate byte
 * diffs instead of accumulated risk." Cases are added to walkTerm as
 * each is verified against the oracle — an unimplemented AST kind throws
 * (an internal error, not a parse-time null) rather than emitting wrong
 * bytes silently.
 *
 * TOP-LEVEL STRUCTURE (lre_compile, libregexp.c:2555-2620), transcribed
 * exactly: 8-byte header (placeholder, backpatched at the end) -> IF NOT
 * STICKY, the "search from any position" prelude (split_goto_first +6,
 * REOP_any, goto -11 — libregexp.c:2564-2568) -> save_start(0) -> the
 * pattern body -> save_end(0) -> match -> backpatch capture_count/
 * register_count/bytecode_length into the header. */
import type { RegexAst } from "./regex-ast.js";
import type { CharRange } from "./regex-charclass.js";
import { RegexByteWriter } from "./regex-bytewriter.js";
import { LRE_FLAG_DOTALL, LRE_FLAG_GLOBAL, LRE_FLAG_IGNORECASE, LRE_FLAG_MULTILINE, LRE_FLAG_NAMED_GROUPS, LRE_FLAG_STICKY, LRE_FLAG_UNICODE, REGISTER_COUNT_MAX, RE_HEADER_BYTECODE_LEN, RE_HEADER_CAPTURE_COUNT, RE_HEADER_FLAGS, RE_HEADER_LEN, RE_HEADER_REGISTER_COUNT, REOP, REOP_SIZE } from "./regex-opcodes.js";

/** re_need_check_adv_and_capture_init (libregexp.c:1567-1638): a linear
 * scan over an ALREADY-EMITTED atom's bytecode span, deciding TWO facts
 * a following quantifier needs: does this atom UNCONDITIONALLY consume
 * at least one character on every successful match (if so, the zero-
 * advance-check wrapper that guards against infinite empty-match loops
 * is unnecessary), and does it contain anything (a backreference, or —
 * safe-by-default — any opcode this scan doesn't specifically recognize,
 * which covers groups with internal branching: alternation, nested
 * quantifiers, lookaround) that needs a FRESH capture-reset before each
 * repetition. The reference scans its OWN just-written byte_code buffer;
 * this port scans the SAME already-emitted bytes via RegexByteWriter's
 * read accessors — the same buffer the reference would have, not a
 * parallel AST-level reimplementation of this analysis, so a subtle
 * divergence between "what the AST says" and "what bytes actually got
 * emitted" can't hide here. */
function needCheckAdvAndCaptureInit(w: RegexByteWriter, atomStart: number, atomEnd: number): { needCheckAdv: boolean; needCaptureInit: boolean } {
  let needCheckAdv = true;
  let needCaptureInit = false;
  let pos = atomStart;
  while (pos < atomEnd) {
    const opcode = w.byteAt(pos);
    let len = REOP_SIZE[opcode]!;
    switch (opcode) {
      case REOP.range:
      case REOP.range_i: {
        const n = w.readU16(pos + 1);
        len += n * 4;
        needCheckAdv = false;
        break;
      }
      case REOP.range32:
      case REOP.range32_i: {
        const n = w.readU16(pos + 1);
        len += n * 8;
        needCheckAdv = false;
        break;
      }
      case REOP.char:
      case REOP.char_i:
      case REOP.char32:
      case REOP.char32_i:
      case REOP.dot:
      case REOP.any:
      case REOP.space:
      case REOP.not_space:
        needCheckAdv = false;
        break;
      case REOP.line_start:
      case REOP.line_start_m:
      case REOP.line_end:
      case REOP.line_end_m:
      case REOP.set_i32:
      case REOP.set_char_pos:
      case REOP.word_boundary:
      case REOP.word_boundary_i:
      case REOP.not_word_boundary:
      case REOP.not_word_boundary_i:
      case REOP.prev:
        // no effect
        break;
      case REOP.save_start:
      case REOP.save_end:
      case REOP.save_reset:
        break;
      case REOP.back_reference:
      case REOP.back_reference_i:
      case REOP.backward_back_reference:
      case REOP.backward_back_reference_i: {
        const n = w.byteAt(pos + 1);
        len += n;
        needCaptureInit = true;
        break;
      }
      default:
        // safe behavior: we cannot predict the outcome
        needCaptureInit = true;
        return { needCheckAdv, needCaptureInit };
    }
    pos += len;
  }
  return { needCheckAdv, needCaptureInit };
}

/** compute_register_count (libregexp.c:2454-2515): a SECOND linear scan,
 * over the FULL emitted bytecode (post-header — the prelude and every
 * atom, not a single atom's span like the scan above), run once at the
 * very end of assembly. It plays two roles at once, exactly as the
 * reference does: it simulates a stack-depth counter to find the peak
 * register usage (the header's register_count field), AND it
 * BACKPATCHES that stack discipline's actual per-opcode register index
 * into the placeholder register byte every register-using opcode wrote
 * as literal 0 at emission time (emitQuantifier's `w.u8(0)` /
 * `w.patchU8(pos, 0)` operand-byte calls) — quantifiers can nest, and
 * this stack simulation is how nested quantifiers reuse register slots
 * rather than each claiming a distinct one. set_i32/set_char_pos PUSH
 * (claim the current stack depth as their register, then grow it);
 * check_advance/loop/loop_split_* POP one (shrink first, then claim the
 * new depth); loop_check_adv_split_* POP two at once (the fused opcode
 * that both loops and checks advancement in one instruction, see
 * emitQuantifier's zero-advance-guarded loop case). Mutates `w` via
 * patchU8 in place; returns the register_count. Throws (matching the
 * reference's re_parse_error("too many imbricated quantifiers") ->
 * lre_compile returning null) if the nesting exceeds REGISTER_COUNT_MAX
 * — assemble() assumes a valid AST, so this is an internal-limits error,
 * not a parse-time null. */
function computeRegisterCount(w: RegexByteWriter, bodyStart: number, bodyEnd: number): number {
  let stackSize = 0;
  let stackSizeMax = 0;
  let pos = bodyStart;
  while (pos < bodyEnd) {
    const opcode = w.byteAt(pos);
    let len = REOP_SIZE[opcode]!;
    switch (opcode) {
      case REOP.set_i32:
      case REOP.set_char_pos:
        w.patchU8(pos + 1, stackSize);
        stackSize++;
        if (stackSize > stackSizeMax) {
          if (stackSize > REGISTER_COUNT_MAX) throw new Error("regex-assembler: too many imbricated quantifiers");
          stackSizeMax = stackSize;
        }
        break;
      case REOP.check_advance:
      case REOP.loop:
      case REOP.loop_split_goto_first:
      case REOP.loop_split_next_first:
        stackSize--;
        w.patchU8(pos + 1, stackSize);
        break;
      case REOP.loop_check_adv_split_goto_first:
      case REOP.loop_check_adv_split_next_first:
        stackSize -= 2;
        w.patchU8(pos + 1, stackSize);
        break;
      case REOP.range:
      case REOP.range_i: {
        const n = w.readU16(pos + 1);
        len += n * 4;
        break;
      }
      case REOP.range32:
      case REOP.range32_i: {
        const n = w.readU16(pos + 1);
        len += n * 8;
        break;
      }
      case REOP.back_reference:
      case REOP.back_reference_i:
      case REOP.backward_back_reference:
      case REOP.backward_back_reference_i: {
        const n = w.byteAt(pos + 1);
        len += n;
        break;
      }
    }
    pos += len;
  }
  return stackSizeMax;
}

export interface AssembleFlags {
  global: boolean;
  ignoreCase: boolean;
  multiLine: boolean;
  dotAll: boolean;
  unicode: boolean;
  sticky: boolean;
}

function flagsToBits(f: AssembleFlags): number {
  let bits = 0;
  if (f.global) bits |= LRE_FLAG_GLOBAL;
  if (f.ignoreCase) bits |= LRE_FLAG_IGNORECASE;
  if (f.multiLine) bits |= LRE_FLAG_MULTILINE;
  if (f.dotAll) bits |= LRE_FLAG_DOTALL;
  if (f.unicode) bits |= LRE_FLAG_UNICODE;
  if (f.sticky) bits |= LRE_FLAG_STICKY;
  return bits;
}

/** re_emit_char (libregexp.c:1278-1284): opcode choice by code-point
 * width and the node's OWN ignoreCase (not a global flag — see regex-
 * ast.ts's header on why this is per-atom). */
function emitChar(w: RegexByteWriter, cp: number, ignoreCase: boolean): void {
  if (cp <= 0xffff) {
    w.u8(ignoreCase ? REOP.char_i : REOP.char);
    w.u16(cp);
  } else {
    w.u8(ignoreCase ? REOP.char32_i : REOP.char32);
    w.u32(cp);
  }
}

/** re_emit_range (libregexp.c:1235-1269): a class's CharRange, opcode
 * chosen by width (16 vs 32-bit encoding, "0xffff = infinity" convention
 * for the 16-bit form) and ignoreCase (matching emitChar's own
 * per-atom, not global, choice). EXPORTED (only this file used it
 * before CP4): regex-interpreter.ts's exec() reuses it AS-IS to build
 * REOP_space/REOP_not_space's fixed \s/\S range table — those opcodes
 * carry no per-instance bytecode operand (libregexp.c never emits one;
 * this port's own assembler mirrors that, see walkTerm's own comment),
 * so the runtime needs a FIXED, embedded table instead, and reusing
 * this ALREADY oracle-verified encoder (rather than a second hand-
 * derived one) is a straight DRY win, not a new algorithm to prove. */
export function emitRange(w: RegexByteWriter, cr: CharRange, ignoreCase: boolean): void {
  const len = cr.length / 2;
  if (len >= 65535) throw new Error("regex-assembler: too many ranges (>= 65535)");
  if (len === 0) {
    w.u8(REOP.char32);
    w.u32(-1);
    return;
  }
  let high = cr[cr.length - 1]!;
  if (high === 0xffffffff) high = cr[cr.length - 2]!;
  if (high <= 0xffff) {
    w.u8(ignoreCase ? REOP.range_i : REOP.range);
    w.u16(len);
    for (let i = 0; i < cr.length; i += 2) {
      w.u16(cr[i]!);
      let hi = cr[i + 1]! - 1;
      if (hi === 0xfffffffe) hi = 0xffff;
      w.u16(hi);
    }
  } else {
    w.u8(ignoreCase ? REOP.range32_i : REOP.range32);
    w.u16(len);
    for (let i = 0; i < cr.length; i += 2) {
      w.u32(cr[i]!);
      w.u32(cr[i + 1]! - 1);
    }
  }
}

/** Walks ONE term/atom node, emitting its bytecode. Only the kinds
 * verified against the live oracle so far are implemented — anything
 * else throws (an internal "not yet built" error), matching this file's
 * own build discipline: never emit a guess. */
function walkTerm(w: RegexByteWriter, node: RegexAst, isBackwardDir: boolean): void {
  switch (node.kind) {
    case "char":
      if (isBackwardDir) w.u8(REOP.prev);
      emitChar(w, node.cp, node.ignoreCase);
      if (isBackwardDir) w.u8(REOP.prev);
      return;
    case "charClass":
      // libregexp.c:2183-2196: a BARE (non-bracketed) \s/\S gets the
      // fixed-opcode fast path — REOP_space/REOP_not_space — checked
      // BEFORE the reference ever looks at ignore_case for this atom
      // kind, so this bypasses emitRange's ignoreCase-driven REOP_range
      // vs REOP_range_i choice entirely (matches: \s/i still emits
      // plain REOP_space, never a "_i" variant — there isn't one).
      // Everything else (including \d/\D/\w/\W and any [...] class,
      // per bareShorthand being null there — regex-parser.ts's own
      // construction sites) falls through to the general range
      // encoding, unchanged.
      if (isBackwardDir) w.u8(REOP.prev);
      if (node.bareShorthand === "s") w.u8(REOP.space);
      else if (node.bareShorthand === "S") w.u8(REOP.not_space);
      else emitRange(w, node.cr, node.ignoreCase);
      if (isBackwardDir) w.u8(REOP.prev);
      return;
    case "dot":
      // libregexp.c:1875-1884: REOP_prev-wrapped the same way as char/
      // charClass (a content-consuming atom) — NOT wrapped for
      // lineStart/lineEnd/wordBoundary below (those are zero-width and
      // the reference never wraps them, backward or not).
      if (isBackwardDir) w.u8(REOP.prev);
      w.u8(node.dotAll ? REOP.any : REOP.dot);
      if (isBackwardDir) w.u8(REOP.prev);
      return;
    case "lineStart":
      w.u8(node.multiline ? REOP.line_start_m : REOP.line_start);
      return;
    case "lineEnd":
      w.u8(node.multiline ? REOP.line_end_m : REOP.line_end);
      return;
    case "wordBoundary":
      w.u8(
        node.negate
          ? node.ignoreCaseUnicode
            ? REOP.not_word_boundary_i
            : REOP.not_word_boundary
          : node.ignoreCaseUnicode
            ? REOP.word_boundary_i
            : REOP.word_boundary,
      );
      return;
    case "backreference":
      emitBackreference(w, node.indices, node.ignoreCase, isBackwardDir);
      return;
    case "group":
      walkGroup(w, node, isBackwardDir);
      return;
    case "lookahead":
      walkLookaround(w, node);
      return;
    case "alternative":
      walkAlternative(w, node.terms, isBackwardDir);
      return;
    case "disjunction":
      walkDisjunction(w, node.alternatives, isBackwardDir);
      return;
    case "quantifier":
      emitQuantifier(w, node, isBackwardDir);
      return;
    default:
      throw new Error("regex-assembler: internal error - unhandled AST kind");
  }
}

/** re_parse_alternative (libregexp.c:2382-2414): walks each term of a
 * sequence in order. Under a backward direction, incrementally prepends
 * each newly-emitted term before all previously-emitted (already-
 * reversed) terms of THIS alternative via RegexByteWriter.moveToFront —
 * producing full term-order reversal by the time the last term is
 * processed (hand-traced and unit-pinned in wasm-regex-bytewriter.test.ts
 * before being wired in here). Forward direction is untouched: append in
 * source order, matching the reference's own `if (is_backward_dir)`
 * guard around its memmove+memcpy pair. */
function walkAlternative(w: RegexByteWriter, terms: readonly RegexAst[], isBackwardDir: boolean): void {
  const start = w.size;
  for (const term of terms) {
    const termStart = w.size;
    walkTerm(w, term, isBackwardDir);
    if (isBackwardDir) w.moveToFront(start, termStart, w.size);
  }
}

/** The '(' capturing/non-capturing dispatch's emission half (libregexp.c
 * :1911-2039, the shared `parse_capture` path at :2019-2036). Non-
 * capturing is TRANSPARENT (regex-ast.ts's own header: the reference
 * emits no opcode for `(?:...)` itself, only its body's own encoding
 * matters) — walked in the SAME direction as the group itself, since a
 * plain group does not establish new direction context (only a
 * lookaround does, see walkLookaround). Capturing wraps with REOP_
 * save_start/REOP_save_end — but WHICH opcode comes first depends on
 * isBackwardDir (libregexp.c:2029's `REOP_save_start + is_backward_dir`
 * / `REOP_save_start + 1 - is_backward_dir`): forward emits save_start-
 * then-save_end; backward emits save_end-then-save_start, because
 * scanning backward through a lookbehind reaches the capture's TEXT-
 * ORDER END first. */
function walkGroup(w: RegexByteWriter, node: Extract<RegexAst, { kind: "group" }>, isBackwardDir: boolean): void {
  if (node.capture === null) {
    walkTerm(w, node.body, isBackwardDir);
    return;
  }
  const openOp = isBackwardDir ? REOP.save_end : REOP.save_start;
  const closeOp = isBackwardDir ? REOP.save_start : REOP.save_end;
  w.u8(openOp);
  w.u8(node.capture);
  walkTerm(w, node.body, isBackwardDir);
  w.u8(closeOp);
  w.u8(node.capture);
}

/** Lookahead/lookbehind (libregexp.c:1959-1990's shared `lookahead:`
 * label): the SAME wrapper opcodes (REOP_lookahead/REOP_lookahead_match,
 * +1 for negate) regardless of forward vs backward — only the BODY's
 * own direction differs, and it does NOT inherit the caller's direction:
 * a lookaround ALWAYS establishes a FRESH direction from its own syntax
 * (node.backward), discarding whatever direction was in effect at the
 * call site. This is the reference's own `re_parse_disjunction(s,
 * is_backward_lookahead)` — it passes `is_backward_lookahead` (a value
 * derived from THIS lookaround's own `<`/no-`<` syntax), never the
 * enclosing `is_backward_dir` parameter — which is why a forward
 * lookahead nested inside a lookbehind still walks its own body forward.
 * No wrapper param for the CALLER's direction is needed here at all. */
function walkLookaround(w: RegexByteWriter, node: Extract<RegexAst, { kind: "lookahead" }>): void {
  const opBase = node.negate ? 1 : 0;
  w.u8(REOP.lookahead + opBase);
  const jumpOperandPos = w.size;
  w.u32(0); // placeholder, patched below
  walkTerm(w, node.body, node.backward);
  w.u8(REOP.lookahead_match + opBase);
  w.patchU32(jumpOperandPos, w.size - (jumpOperandPos + 4));
}

/** \N / \k<name> backreference emission (libregexp.c:2093 and :2150-2151,
 * fused with find_group_name/re_parse_captures's own index-writing loops
 * when called with emit_group_index=true). This port's PARSER already
 * resolves the full `indices` list via one full-pattern scan
 * (scanCaptures, regex-parser.ts) regardless of whether the referenced
 * name/number is defined before or after this backreference — this is
 * why the FORWARD-REFERENCE case (`\k<a>` appearing before `(?<a>...)`
 * is parsed later in the same pattern) needs no special handling HERE:
 * `indices` already holds the right capture index/indices, in ascending
 * order, by the time the assembler sees the node — matching what the
 * reference's own two-tier (backward-table-then-forward-rescan) lookup
 * would have produced, just resolved earlier in the pipeline. Encoding:
 * [opcode][count = indices.length][index_1]...[index_n] — count and
 * each index fit in one byte (CAPTURE_COUNT_MAX = 255). Opcode choice:
 * REOP_back_reference + 2*isBackwardDir + ignoreCase (REOP enum order:
 * back_reference=32, back_reference_i=33, backward_back_reference=34,
 * backward_back_reference_i=35 — verified against regex-opcodes.ts). */
function emitBackreference(w: RegexByteWriter, indices: readonly number[], ignoreCase: boolean, isBackwardDir: boolean): void {
  const opcode = REOP.back_reference + (isBackwardDir ? 2 : 0) + (ignoreCase ? 1 : 0);
  w.u8(opcode);
  w.u8(indices.length);
  for (const idx of indices) w.u8(idx);
}

/** The INCLUSIVE [min,max] capture-index range a subtree spans, or null
 * if it contains no capturing group. Capture indices are assigned
 * sequentially in PARSE ORDER (ParserState.captureCount, regex-parser.ts)
 * and a quantified atom's body is parsed as one contiguous span before
 * the quantifier ever attaches, so every capture index inside it is
 * necessarily contiguous — nothing from outside the span can be
 * interleaved. Backs REOP_save_reset(min,max)'s two operand bytes. */
function captureIndexRange(node: RegexAst): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  function walk(n: RegexAst): void {
    switch (n.kind) {
      case "group":
        if (n.capture !== null) {
          if (n.capture < min) min = n.capture;
          if (n.capture > max) max = n.capture;
        }
        walk(n.body);
        return;
      case "lookahead":
      case "quantifier":
        walk(n.body);
        return;
      case "alternative":
        n.terms.forEach(walk);
        return;
      case "disjunction":
        n.alternatives.forEach(walk);
        return;
      default:
        return;
    }
  }
  walk(node);
  return min === Infinity ? null : [min, max];
}

/** The named-groups trailer's per-entry payload (libregexp.c:1992-2018,
 * the `dbuf_put(name+NUL); dbuf_putc(scope)` / `dbuf_putc(0); dbuf_putc(0)`
 * pair pushed to s->group_names as EVERY capturing group — named or not —
 * is parsed). Walks the WHOLE ast (same shape as captureIndexRange, one
 * level up: the top-level pattern, not a quantified subtree) collecting
 * each capturing group's {name, nameScope} keyed by its capture index,
 * so assemble() can rebuild the trailer in capture-index order without
 * needing the original pattern string. */
export function collectGroupNames(node: RegexAst): Map<number, { name: string | null; nameScope: number }> {
  const result = new Map<number, { name: string | null; nameScope: number }>();
  function walk(n: RegexAst): void {
    switch (n.kind) {
      case "group":
        if (n.capture !== null) result.set(n.capture, { name: n.name, nameScope: n.nameScope });
        walk(n.body);
        return;
      case "lookahead":
      case "quantifier":
        walk(n.body);
        return;
      case "alternative":
        n.terms.forEach(walk);
        return;
      case "disjunction":
        n.alternatives.forEach(walk);
        return;
      default:
        return;
    }
  }
  walk(node);
  return result;
}

/** The quantifier suffix's bytecode-splicing (libregexp.c:2206-2374) —
 * design's own "several distinct strategies by min/max/greedy" the lead
 * named as needing the most literal transcription. `atomStart` is where
 * the body's bytecode begins; the body is already emitted by the time
 * this runs (matching the reference's own last_atom_start bookkeeping,
 * ported here via a real position rather than a global field). */
function emitQuantifier(w: RegexByteWriter, node: Extract<RegexAst, { kind: "quantifier" }>, isBackwardDir: boolean): void {
  const atomStart = w.size;
  walkTerm(w, node.body, isBackwardDir);
  const captureRange = captureIndexRange(node.body);
  const { needCheckAdv, needCaptureInit } = needCheckAdvAndCaptureInit(w, atomStart, w.size);
  const addZeroAdvanceCheck = needCheckAdv;
  // REACHABILITY NOTE (RESOLVED — oracle-pinned in
  // wasm-regex-assembler.test.ts's "addZeroAdvanceCheck=true" test, plus
  // incidentally by the forward-lookahead test's Annex-B `(?=a)*`/
  // `(?!a)*` cases): addZeroAdvanceCheck is true whenever the body's
  // bytecode hits needCheckAdvAndCaptureInit's `default` case (a
  // quantified GROUP wrapping a disjunction, e.g. `(a|b)*` — the
  // disjunction's split_next_first/goto opcodes are unrecognized by the
  // scanner) or reaches the scan's natural end with needCheckAdv never
  // set false (a quantified BACKREFERENCE, e.g. `(a)\1+` — REOP_back_
  // reference is recognized only for needCaptureInit, so the loop
  // completes normally instead of early-returning — a genuinely
  // different control path through the same scanner reaching the same
  // outcome). Mutation-checked: forcing this to always `false` broke
  // both the dedicated pin AND the pre-existing `(?=a)*`/`(?!a)*` cases,
  // confirming the flag is load-bearing and was already being exercised
  // more widely than first realized. The min===1&&max===Infinity fast-
  // path-vs-general split UNDER this flag is separately pinned via
  // `(a|b)+` (must take the general case, not the `+` fast path, since
  // the fast path also requires `!addZeroAdvanceCheck`).

  // Insertion 1 (libregexp.c:2286-2293): INSIDE the eventual wrap — reset
  // captures before EACH repetition attempt. `wrapStart` stays AT
  // atomStart (the reference's own `pos` local, distinct from
  // last_atom_start here — this save_reset becomes part of what later
  // wrapping logic wraps).
  let wrapStart = atomStart;
  if (needCaptureInit && captureRange !== null) {
    w.insertZeros(atomStart, 3);
    w.patchU8(atomStart, REOP.save_reset);
    w.patchU8(atomStart + 1, captureRange[0]);
    w.patchU8(atomStart + 2, captureRange[1]);
  }

  const { min, max, greedy } = node;

  if (min === 0) {
    // Insertion 2 (libregexp.c:2298-2305): OUTSIDE the eventual wrap —
    // guarantee captures are reset to undefined even if the atom runs
    // ZERO times. Mutually exclusive with insertion 1 (the reference's
    // own `!need_capture_init` guard) — this is the "flat, non-branching
    // atom that still has captures" case (e.g. `(a)?` with no internal
    // alternation). `wrapStart` ADVANCES past this one (libregexp.c:2302's
    // `buf[last_atom_start++]` post-increments), so later wrapping logic
    // does NOT re-execute it on every loop iteration.
    if (!needCaptureInit && captureRange !== null) {
      w.insertZeros(wrapStart, 3);
      w.patchU8(wrapStart, REOP.save_reset);
      w.patchU8(wrapStart + 1, captureRange[0]);
      w.patchU8(wrapStart + 2, captureRange[1]);
      wrapStart += 3;
    }
    const len = w.size - wrapStart;
    if (max === 0) {
      // Discard the atom entirely (libregexp.c:2306-2307) — quant_max===0
      // means it can never run.
      w.truncate(atomStart);
    } else if (max === 1 || max === Infinity) {
      const hasGoto = max === Infinity;
      w.insertZeros(wrapStart, 5 + (addZeroAdvanceCheck ? 2 : 0));
      w.patchU8(wrapStart, REOP.split_goto_first + (greedy ? 1 : 0));
      w.patchU32(wrapStart + 1, len + (hasGoto ? 5 : 0) + (addZeroAdvanceCheck ? 4 : 0));
      if (addZeroAdvanceCheck) {
        w.patchU8(wrapStart + 1 + 4, REOP.set_char_pos);
        w.patchU8(wrapStart + 1 + 4 + 1, 0);
        w.u8(REOP.check_advance);
        w.u8(0);
      }
      if (hasGoto) {
        w.u8(REOP.goto);
        const gotoOperandPos = w.size;
        w.u32(0);
        w.patchU32(gotoOperandPos, wrapStart - (gotoOperandPos + 4));
      }
    } else {
      // quant_max is finite and > 1: {0,N}
      w.insertZeros(wrapStart, 11 + (addZeroAdvanceCheck ? 2 : 0));
      let pos = wrapStart;
      w.patchU8(pos, REOP.split_goto_first + (greedy ? 1 : 0));
      pos++;
      w.patchU32(pos, 6 + (addZeroAdvanceCheck ? 2 : 0) + len + 10);
      pos += 4;
      w.patchU8(pos, REOP.set_i32);
      pos++;
      w.patchU8(pos, 0);
      pos++;
      w.patchU32(pos, max);
      pos += 4;
      const loopAtomStart = pos;
      if (addZeroAdvanceCheck) {
        w.patchU8(pos, REOP.set_char_pos);
        pos++;
        w.patchU8(pos, 0);
        pos++;
      }
      const loopOp = (addZeroAdvanceCheck ? REOP.loop_check_adv_split_next_first : REOP.loop_split_next_first) - (greedy ? 1 : 0);
      w.u8(loopOp);
      w.u8(0);
      const limitOperandPos = w.size;
      w.u32(max);
      const targetOperandPos = w.size;
      w.u32(0);
      w.patchU32(targetOperandPos, loopAtomStart - (targetOperandPos + 4));
      void limitOperandPos;
    }
  } else if (min === 1 && max === Infinity && !addZeroAdvanceCheck) {
    // The simplest `+` fast path (libregexp.c:2342-2345): no register
    // needed at all, just a trailing split that loops back to the atom.
    w.u8(REOP.split_next_first - (greedy ? 1 : 0));
    const operandPos = w.size;
    w.u32(0);
    w.patchU32(operandPos, wrapStart - (operandPos + 4));
  } else {
    // General case: min > 0, not the simple `+` fast path. `max` can be
    // Infinity here ({N,}) — the reference's PARSER already resolves
    // "unbounded" to INT32_MAX before the assembler ever runs
    // (libregexp.c:2247's own `quant_max = INT32_MAX; /* infinity */`).
    // This port's AST keeps Infinity as the "unbounded" sentinel (design's
    // own AST doc), so this is the SAME semantic decision as the
    // reference's, just resolved at a different point in the pipeline —
    // here, at the assembler boundary, instead of in the parser — because
    // that's where THIS port's two-stage split puts the AST/bytecode
    // seam. Every place a register VALUE gets written (not a structural
    // max===1||max===Infinity branch decision, which already treats
    // Infinity correctly via `===`) must apply the same clamp.
    const maxAsU32 = max === Infinity ? 0x7fffffff : max;
    let effectiveAddZeroAdvanceCheck = addZeroAdvanceCheck;
    if (min === max) effectiveAddZeroAdvanceCheck = false; // exact {N}: no infinite-loop risk
    w.insertZeros(wrapStart, 6 + (effectiveAddZeroAdvanceCheck ? 2 : 0));
    let pos = wrapStart;
    w.patchU8(pos, REOP.set_i32);
    pos++;
    w.patchU8(pos, 0);
    pos++;
    w.patchU32(pos, maxAsU32);
    pos += 4;
    const loopAtomStart = pos;
    if (effectiveAddZeroAdvanceCheck) {
      w.patchU8(pos, REOP.set_char_pos);
      pos++;
      w.patchU8(pos, 0);
      pos++;
    }
    if (min === max) {
      w.u8(REOP.loop);
      w.u8(0);
      const targetPos = w.size;
      w.u32(0);
      w.patchU32(targetPos, loopAtomStart - (targetPos + 4));
    } else {
      const loopOp = (effectiveAddZeroAdvanceCheck ? REOP.loop_check_adv_split_next_first : REOP.loop_split_next_first) - (greedy ? 1 : 0);
      w.u8(loopOp);
      w.u8(0);
      w.u32(maxAsU32 - min);
      const targetPos = w.size;
      w.u32(0);
      w.patchU32(targetPos, loopAtomStart - (targetPos + 4));
    }
  }
}

/** re_parse_disjunction's bytecode shape (libregexp.c:2416-2450). A
 * single alternative emits no split at all (matching the reference's own
 * `while (*buf_ptr == '|')` never triggering). For N>1 alternatives, ONE
 * split is inserted per '|', ALWAYS at the disjunction's own fixed start
 * position (not nested progressively at each new alternative's start) —
 * so later insertions land BEFORE earlier ones, and EARLIER splits'/
 * gotos' relative offsets stay valid unchanged, since a pure relative
 * offset is invariant under insertions that occur uniformly before both
 * its source and target. Verified against the live oracle for 2- and
 * 3-alternative cases before trusting the derivation (a hand-traced
 * byte-position walk alone was not treated as sufficient). */
function walkDisjunction(w: RegexByteWriter, alternatives: readonly RegexAst[], isBackwardDir: boolean): void {
  const start = w.size;
  walkTerm(w, alternatives[0]!, isBackwardDir);
  for (let i = 1; i < alternatives.length; i++) {
    const len = w.size - start;
    w.insertZeros(start, 5);
    w.patchU8(start, REOP.split_next_first);
    w.patchU32(start + 1, len + 5);
    w.u8(REOP.goto);
    const gotoOperandPos = w.size;
    w.u32(0); // placeholder, patched below
    walkTerm(w, alternatives[i]!, isBackwardDir);
    w.patchU32(gotoOperandPos, w.size - (gotoOperandPos + 4));
  }
}

export interface AssembleResult {
  bytes: Uint8Array;
  captureCount: number;
}

/** lre_compile's top-level structure (libregexp.c:2555-2620), minus
 * error handling (the parser already validated — this function assumes
 * a valid AST). register_count comes from computeRegisterCount's post-
 * emission scan (libregexp.c:2598), which ALSO backpatches every
 * register-using opcode's placeholder byte — matching the reference's
 * own ordering: compute_register_count runs against the buffer's
 * CURRENT size (before any named-groups trailer is appended), then its
 * result is written into the header alongside capture_count and
 * bytecode_length, and ONLY THEN is the named-groups trailer (if any)
 * appended and LRE_FLAG_NAMED_GROUPS set. */
export function assemble(ast: RegexAst, flags: AssembleFlags): AssembleResult {
  const w = new RegexByteWriter();
  w.u16(flagsToBits(flags)); // RE_HEADER_FLAGS placeholder (final value, no patch needed — flags are known up front)
  w.u8(0); // RE_HEADER_CAPTURE_COUNT placeholder
  w.u8(0); // RE_HEADER_REGISTER_COUNT placeholder
  w.u32(0); // RE_HEADER_BYTECODE_LEN placeholder

  if (!flags.sticky) {
    // libregexp.c:2564-2568's exact prelude.
    w.u8(REOP.split_goto_first);
    w.u32(1 + 5);
    w.u8(REOP.any);
    w.u8(REOP.goto);
    w.u32(-(5 + 1 + 5)); // JS's bitwise ops wrap a negative operand the same way C's uint32_t assignment does
  }
  w.u8(REOP.save_start);
  w.u8(0);

  walkTerm(w, ast, false); // top-level pattern is always forward direction

  w.u8(REOP.save_end);
  w.u8(0);
  w.u8(REOP.match);

  // Capture 0 is reserved for the whole match (matching lre_compile's
  // own `s->capture_count = 1` init); if the AST contains user capturing
  // groups up to index K (found by the same subtree walk emitQuantifier
  // already uses for save_reset's operand range), capture_count is K+1.
  const topCaptureRange = captureIndexRange(ast);
  const captureCount = topCaptureRange === null ? 1 : topCaptureRange[1] + 1;
  const registerCount = computeRegisterCount(w, RE_HEADER_LEN, w.size);
  // bytecode_length is the size BEFORE the trailer is appended
  // (libregexp.c:2606-2607 runs before :2610-2614's trailer dbuf_put) —
  // the trailer is not part of "the bytecode" the length field measures.
  w.patchU32(RE_HEADER_BYTECODE_LEN, w.size - RE_HEADER_LEN);

  // Named-groups trailer (libregexp.c:2609-2614): one entry per
  // capturing group (capture indices 1..captureCount-1), in capture-
  // index order — [name as UTF-8 bytes][NUL][scope byte] for a named
  // group (matching re_parse_group_name's own UTF-8 encoding of the
  // name into its char buffer), or [0][0] for an unnamed one (every
  // capturing group gets exactly one entry, named or not). Appended
  // (and LRE_FLAG_NAMED_GROUPS set in the header) only if the total
  // exceeds what an ALL-UNNAMED pattern would produce (2 bytes/group) —
  // equivalent to "at least one group in this pattern is named", since
  // only a named entry's UTF-8 name bytes can push the sum above that
  // baseline.
  const groupNames = collectGroupNames(ast);
  const trailerBytes: number[] = [];
  for (let i = 1; i < captureCount; i++) {
    const info = groupNames.get(i);
    if (info !== undefined && info.name !== null) {
      for (const byte of new TextEncoder().encode(info.name)) trailerBytes.push(byte);
      trailerBytes.push(0); // NUL terminator
      trailerBytes.push(info.nameScope);
    } else {
      trailerBytes.push(0, 0);
    }
  }
  if (trailerBytes.length > (captureCount - 1) * 2) {
    for (const b of trailerBytes) w.u8(b);
    w.patchU8(RE_HEADER_FLAGS, w.byteAt(RE_HEADER_FLAGS) | LRE_FLAG_NAMED_GROUPS);
  }

  const bytes = w.toBytes();
  bytes[RE_HEADER_CAPTURE_COUNT] = captureCount;
  bytes[RE_HEADER_REGISTER_COUNT] = registerCount;
  return { bytes, captureCount };
}
