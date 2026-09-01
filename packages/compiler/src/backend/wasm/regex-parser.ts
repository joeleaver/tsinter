/* INC-24 P1, CP2b/CP2c: the term/alternative/disjunction parser, an AST-
 * producing restructuring of re_parse_term/re_parse_alternative/
 * re_parse_disjunction (libregexp.c:1855-2455) — see regex-ast.ts's
 * header for why this is a separate stage rather than the reference's
 * fused parse+emit.
 *
 * FULL SCOPE (CP2b + CP2c): literals, dot, ^/$, \b/\B, character classes,
 * quantifiers, lookahead AND lookbehind (R3: port it, no claim behind it
 * — backward:true is the only difference at this layer; the
 * INTERPRETER's backward-direction machinery is separate, later work),
 * non-capturing/modifier/plain-capturing/NAMED-capturing groups (with the
 * GO rider 1b modifier-form reaching pin — see wasm-regex-parser.test.ts),
 * numbered backreferences \1-\9 (with Annex-B legacy-octal fallback) and
 * \0 (never a backreference — always an octal-extended literal), and
 * \k<name> (resolved via a full-pattern scanCaptures — see its own doc
 * for why that's behaviorally identical to the reference's incremental
 * two-tier lookup). Capture-name duplicate detection transcribes
 * libregexp's own flat, global `group_name_scope` counter (ParserState's
 * doc) — including its self-acknowledged "poor's man method... does not
 * catch all the errors" quirk (libregexp.c:1998-2000) — rather than an
 * independently-derived "more correct" algorithm, since the mandate is
 * matching libregexp's actual behavior. */
import type { RegexAst } from "./regex-ast.js";
import { canonicalize } from "./regex-canon.js";
import { caseCloseClass } from "./regex-class-closure.js";
import { getClassAtom, parseCharClass, type CharRange } from "./regex-charclass.js";
import { parseEscape } from "./regex-escape.js";
import { isIdentFirst, isIdentNext } from "./regex-ident.js";

/** §6.3(a)'s own load-bearing constraint, made an explicit guard rather
 * than relied on implicitly: ignore_case + unicode (simple case FOLDING,
 * /iu, conv_type 2) is refused (never reaches real compilation — §6.1
 * FENCES it from even this parser's own verdict corpus) — canonicalize()
 * and caseCloseClass() are BOTH non-unicode-casefold ONLY and would
 * silently produce wrong results if fed this combination, per casing.ts's
 * own conv_type-2 hazard. A thrown assertion here (not a `return null`,
 * which would look like an ordinary REJECT verdict) marks this as a
 * should-never-happen internal invariant, not a parse outcome — if this
 * ever fires, something upstream failed to keep /iu out. */
function assertNoUnicodeCasefold(st: ParserState): void {
  if (st.ignoreCase && st.isUnicode) {
    throw new Error(
      "regex-parser: ignoreCase+isUnicode (simple case folding, /iu) reached character/class " +
        "compilation — this combination is refused (design §6.3) and must never reach here.",
    );
  }
}

/** Applies design §6.2's class case-closure when ignore_case is active
 * (non-unicode only — see assertNoUnicodeCasefold), else returns the
 * range unchanged. Every charClass AST-node construction site routes
 * through this, so there is exactly one place that decides whether to
 * close a class. */
function closeIfIgnoreCase(st: ParserState, cr: CharRange): CharRange {
  if (!st.ignoreCase) return cr;
  assertNoUnicodeCasefold(st);
  return caseCloseClass(cr);
}

interface ParserState {
  pattern: string;
  pos: number;
  readonly isUnicode: boolean;
  ignoreCase: boolean;
  multiLine: boolean;
  dotAll: boolean;
  /** libregexp.c:2440's `s->group_name_scope`: a single FLAT, GLOBAL
   * counter incremented on every '|' consumed anywhere in the pattern,
   * at ANY nesting depth (re_parse_disjunction, not scoped per-call) —
   * NOT a tree-structured "nearest common disjunction ancestor" scope. A
   * named group registers the scope value current at the moment it's
   * parsed; two same-named groups conflict only if they share the exact
   * scope NUMBER. The reference's own comment calls this a "poor's man
   * method... does not catch all the errors" (libregexp.c:1998-2000) —
   * transcribed AS-IS (quirks included) rather than replaced with a
   * "more correct" independent algorithm, because the mandate is
   * matching libregexp's ACTUAL behavior (gate leg (i) is byte-identical
   * assembly), not independently re-deriving what ECMA-262 "should" do. */
  groupNameScope: number;
  seenGroupNames: { name: string; scope: number }[];
  /** libregexp.c:2551's `s->capture_count`, starting at 1 (capture 0 is
   * the implicit whole-match slot) — incremented once per capturing
   * group (named or not) in PARSE ORDER, matching `capture_index =
   * s->capture_count++` at libregexp.c:2024. */
  captureCount: number;
}

const isDigitChar = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isOctalDigitCode = (c: number): boolean => c >= 0x30 && c <= 0x37;
const CAPTURE_COUNT_MAX = 255; // libregexp.c:71

/** re_parse_modifiers (libregexp.c:1820) — consumes a run of i/m/s
 * letters, rejecting a repeated one. Returns the OR'd flag bitmask (using
 * this file's own bit assignment, unrelated to LRE_FLAG_*'s numeric
 * values — nothing outside this function reads the bits' numeric
 * identity) or null on a duplicate modifier. */
const MOD_I = 1;
const MOD_M = 2;
const MOD_S = 4;
function parseModifiers(pattern: string, pos: number): { mask: number; next: number } | null {
  let p = pos;
  let mask = 0;
  for (;;) {
    let val: number;
    const c = pattern.charCodeAt(p);
    if (c === 0x69 /* 'i' */) val = MOD_I;
    else if (c === 0x6d /* 'm' */) val = MOD_M;
    else if (c === 0x73 /* 's' */) val = MOD_S;
    else break;
    if (mask & val) return null; // duplicate modifier
    mask |= val;
    p++;
  }
  return { mask, next: p };
}

function updateModifier(cur: boolean, addMask: number, removeMask: number, bit: number): boolean {
  let v = cur;
  if (addMask & bit) v = true;
  if (removeMask & bit) v = false;
  return v;
}

function expect(pattern: string, pos: number, c: number): number | null {
  return pattern.charCodeAt(pos) === c ? pos + 1 : null;
}

/** re_parse_group_name (libregexp.c:1641-1693). `pos` points just AFTER
 * the opening '<' (both `(?<name>` and `\k<name>` share this shape).
 * Operates on UTF-16 code units directly (codePointAt combines a
 * surrogate pair the same way the reference's utf8_decode_len +
 * manual-surrogate-recombine dance does for a CESU-8 byte buffer — see
 * regex-charclass.ts's normalChar for the same equivalence already
 * established and tested there). */
export interface GroupNameResult {
  name: string;
  next: number;
}
export function parseGroupName(pattern: string, pos: number): GroupNameResult | null {
  let p = pos;
  let name = "";
  for (;;) {
    const c0 = pattern.charCodeAt(p);
    if (Number.isNaN(c0)) return null; // ran off the end, unterminated name
    let cp: number;
    if (c0 === 0x5c /* '\\' */) {
      if (pattern.charCodeAt(p + 1) !== 0x75 /* 'u' */) return null;
      const esc = parseEscape(pattern, p + 1, 2);
      if (esc === null) return null;
      cp = esc.value;
      p = esc.next;
    } else if (c0 === 0x3e /* '>' */) {
      break;
    } else {
      cp = pattern.codePointAt(p)!;
      p += cp >= 0x10000 ? 2 : 1;
    }
    if (cp > 0x10ffff) return null;
    if (name.length === 0 ? !isIdentFirst(cp) : !isIdentNext(cp)) return null;
    name += String.fromCodePoint(cp);
  }
  if (name.length === 0) return null; // empty name is invalid
  p++; // skip '>'
  return { name, next: p };
}

/** re_parse_captures (libregexp.c:1697-1751), a stateless full-PATTERN
 * scan (not tied to a parse cursor) counting capturing groups — needed
 * because a numbered OR named backreference can point FORWARD to a group
 * not parsed yet (\1(a) and \k<n>(?<n>a) are both legal). Unlike the
 * reference's incremental group_names DynBuf + two-tier backward/forward
 * lookup (find_group_name then re_parse_captures as a fallback), this AST-
 * first port always does the full-pattern scan directly — behaviorally
 * identical (a re-scan finds the same matches regardless of parse order)
 * and simpler for a from-scratch TS port; the reference's two-tier split
 * is a PERFORMANCE detail (avoid re-scanning when the name was already
 * seen), not an observable-behavior one.
 * `targetName` undefined: returns the TOTAL capture count (capture_index,
 * starting the walk at 1 to match libregexp.c:2551's `s->capture_count = 1`).
 * `targetName` given: returns the indices of every capturing group whose
 * name matches it (design §5.3: legitimately more than one, across
 * different alternatives — REOP_back_reference's own "variable length"
 * note exists for exactly this). */
export interface CapturesScan {
  totalCaptureCount: number;
  matchedIndices: readonly number[];
  hasNamedCaptures: boolean;
}
export function scanCaptures(pattern: string, targetName?: string): CapturesScan {
  let captureIndex = 1;
  let hasNamedCaptures = false;
  const matchedIndices: number[] = [];
  let p = 0;
  while (p < pattern.length) {
    const c = pattern.charCodeAt(p);
    if (c === 0x28 /* '(' */) {
      if (pattern.charCodeAt(p + 1) === 0x3f /* '?' */) {
        const p2 = pattern.charCodeAt(p + 2);
        const p3 = pattern.charCodeAt(p + 3);
        if (p2 === 0x3c /* '<' */ && p3 !== 0x3d /* '=' */ && p3 !== 0x21 /* '!' */) {
          hasNamedCaptures = true;
          if (targetName !== undefined) {
            const nameRes = parseGroupName(pattern, p + 3);
            if (nameRes !== null && nameRes.name === targetName) matchedIndices.push(captureIndex);
          }
          captureIndex++;
          if (captureIndex >= CAPTURE_COUNT_MAX) break;
        }
        // (?:  (?=  (?!  (?<=  (?<!  and modifier groups: none increment.
      } else {
        captureIndex++;
        if (captureIndex >= CAPTURE_COUNT_MAX) break;
      }
      p++;
    } else if (c === 0x5c /* '\\' */) {
      p += 2; // skip the backslash AND whatever it escapes
    } else if (c === 0x5b /* '[' */) {
      p++;
      while (p < pattern.length && pattern.charCodeAt(p) !== 0x5d /* ']' */) {
        if (pattern.charCodeAt(p) === 0x5c) p++;
        p++;
      }
      p++; // skip past ']' (or past end, harmlessly)
    } else {
      p++;
    }
  }
  return { totalCaptureCount: captureIndex, matchedIndices, hasNamedCaptures };
}

/** re_parse_term (libregexp.c:1855), the atom-dispatch half only
 * (quantifier-wrapping is handled by the caller, parseAlternative, since
 * it applies uniformly to whatever this function returns). Returns null
 * for a syntax error OR an out-of-CP2b-scope construct (see this file's
 * header) — the two are not yet distinguished; that distinction is
 * needed only once this parser is wired into the verdict harness's
 * comparison half (CP2d). */
function parseTerm(st: ParserState): RegexAst | null {
  const p0 = st.pos;
  const c0 = st.pattern.charCodeAt(p0);

  if (c0 === 0x5e /* '^' */) {
    st.pos = p0 + 1;
    return { kind: "lineStart", multiline: st.multiLine };
  }
  if (c0 === 0x24 /* '$' */) {
    st.pos = p0 + 1;
    return { kind: "lineEnd", multiline: st.multiLine };
  }
  if (c0 === 0x2e /* '.' */) {
    st.pos = p0 + 1;
    return { kind: "dot", dotAll: st.dotAll };
  }
  if (c0 === 0x2a /* '*' */ || c0 === 0x2b /* '+' */ || c0 === 0x3f /* '?' */) {
    return null; // "nothing to repeat" (libregexp.c:1907-1910)
  }
  if (c0 === 0x7b /* '{' */) {
    // libregexp.c:1885-1906: under /u, '{' is always a syntax error here;
    // otherwise Annex B accepts a lone '{' (or one not shaped like a
    // repetition count) as a normal atom, falling through to the
    // class-atom path below.
    if (st.isUnicode) return null;
    if (!looksLikeQuantifierBrace(st.pattern, p0)) {
      return parseClassAtomTerm(st, p0);
    }
    return null; // shaped like {n} / {n,} / {n,m} in atom position: "nothing to repeat"
  }
  if (c0 === 0x28 /* '(' */) {
    return parseGroup(st, p0);
  }
  if (c0 === 0x5c /* '\\' */) {
    const esc = st.pattern.charCodeAt(p0 + 1);
    if (esc === 0x62 /* 'b' */ || esc === 0x42 /* 'B' */) {
      st.pos = p0 + 2;
      return { kind: "wordBoundary", negate: esc === 0x42, ignoreCaseUnicode: st.ignoreCase && st.isUnicode };
    }
    if (esc === 0x6b /* 'k' */) return parseNamedBackref(st, p0);
    if (esc === 0x30 /* '0' */) return parseZeroEscape(st, p0);
    if (isDigitChar(esc)) return parseNumberedBackrefOrOctal(st, p0);
    return parseClassAtomTerm(st, p0);
  }
  if (c0 === 0x5b /* '[' */) {
    // parseCharClass now does its OWN per-member case-closing internally
    // (regex-charclass.ts's closeMemberIfNeeded — skipping \d\D\s\S\w\W
    // members, closing everything else, negation applied ONCE at the
    // end on the already-closed union) — NOT a whole-class closeIfIgnoreCase
    // here, which would incorrectly re-close (or wrongly close) members
    // that must stay raw. bareShorthand is ALWAYS null: [...] never gets
    // the reference's bare-\s/\S REOP_space/REOP_not_space fast path,
    // even for `[\s]` — that lives in re_parse_term's normal_char label
    // (outside any bracket), never in re_parse_char_class's own combining.
    const r = parseCharClass(st.pattern, p0, st.isUnicode, st.ignoreCase);
    if (r === null) return null;
    st.pos = r.next;
    return { kind: "charClass", cr: r.cr, ignoreCase: st.ignoreCase, bareShorthand: null };
  }
  if (c0 === 0x5d /* ']' */ || c0 === 0x7d /* '}' */) {
    // libregexp.c:2168-2172: under /u a syntax error; else Annex B
    // accepts a lone ]/} as a normal atom.
    if (st.isUnicode) return null;
    return parseClassAtomTerm(st, p0);
  }
  return parseClassAtomTerm(st, p0);
}

function looksLikeQuantifierBrace(pattern: string, bracePos: number): boolean {
  // libregexp.c:1888-1905's own lookahead, reused verbatim in shape:
  // '{' not followed by a digit is never quantifier-shaped; otherwise it
  // must be exactly {digits} or {digits,} or {digits,digits} to count.
  if (!isDigitChar(pattern.charCodeAt(bracePos + 1))) return false;
  let p = bracePos + 1;
  while (isDigitChar(pattern.charCodeAt(p))) p++;
  if (pattern.charCodeAt(p) === 0x2c /* ',' */) {
    p++;
    while (isDigitChar(pattern.charCodeAt(p))) p++;
  }
  return pattern.charCodeAt(p) === 0x7d /* '}' */;
}

/** parse_class_atom (libregexp.c:2174-2200's non-quantifier half): a
 * literal character (ignore_case-canonicalized here, matching the
 * reference emitting `lre_canonicalize(c, s->is_unicode)` inline) or a
 * resolved class-range from get_class_atom. A \d\D\s\S\w\W range (a.dsw
 * set) is used RAW, UNCLOSED, exactly like its bracketed counterpart
 * (regex-charclass.ts's closeMemberIfNeeded, same empirically-confirmed
 * rule — verified bare via `\w/i` keeping both cases, matching `[\w]/i`);
 * a \p{...} property (a.dsw unset) closes the same way an explicit
 * `[...]` class member does, via closeIfIgnoreCase. bareShorthand
 * (REOP_space/REOP_not_space's own opcode-choice tag) is narrower than
 * dsw — only "s"/"S" trigger it, the other four dsw letters still go
 * through emitRange, just with raw (unclosed) data. */
function parseClassAtomTerm(st: ParserState, pos: number): RegexAst | null {
  const a = getClassAtom(st.pattern, pos, false, st.isUnicode);
  if (a === null) return null;
  st.pos = a.next;
  if (a.kind === "range") {
    const bareShorthand = a.dsw === "s" || a.dsw === "S" ? a.dsw : null;
    const cr = a.dsw !== undefined ? a.cr : closeIfIgnoreCase(st, a.cr);
    return { kind: "charClass", cr, ignoreCase: st.ignoreCase, bareShorthand };
  }
  if (st.ignoreCase) assertNoUnicodeCasefold(st);
  const cp = st.ignoreCase ? canonicalize(a.cp) : a.cp;
  return { kind: "char", cp, ignoreCase: st.ignoreCase };
}

/** \k<name> (libregexp.c:2051-2100). `backslashPos` points AT '\';
 * 'k' is at backslashPos+1. Resolves via a full-pattern scanCaptures
 * rather than the reference's backward-then-forward two-tier lookup —
 * see scanCaptures's own doc for why that's behaviorally identical here. */
function parseNamedBackref(st: ParserState, backslashPos: number): RegexAst | null {
  if (st.pattern.charCodeAt(backslashPos + 2) !== 0x3c /* '<' */) {
    // Annex B: tolerate \k with no <name> at all IF non-unicode AND the
    // pattern has no named captures anywhere (libregexp.c:2058-2065).
    if (st.isUnicode || scanCaptures(st.pattern).hasNamedCaptures) return null;
    return parseClassAtomTerm(st, backslashPos);
  }
  const nameRes = parseGroupName(st.pattern, backslashPos + 3);
  if (nameRes === null) {
    if (st.isUnicode || scanCaptures(st.pattern).hasNamedCaptures) return null;
    return parseClassAtomTerm(st, backslashPos);
  }
  const scan = scanCaptures(st.pattern, nameRes.name);
  if (scan.matchedIndices.length === 0) {
    if (st.isUnicode || scan.hasNamedCaptures) return null; // "group name not defined"
    return parseClassAtomTerm(st, backslashPos);
  }
  st.pos = nameRes.next;
  return { kind: "backreference", indices: scan.matchedIndices, ignoreCase: st.ignoreCase };
}

/** \0 (libregexp.c:2102-2118) — NEVER a backreference (there is no
 * capture 0); always an octal-extended literal character, or a hard
 * error under /u if a digit follows. */
function parseZeroEscape(st: ParserState, backslashPos: number): RegexAst | null {
  let p = backslashPos + 2; // skip '\' and '0'
  let c = 0;
  if (st.isUnicode) {
    if (isDigitChar(st.pattern.charCodeAt(p))) return null; // "invalid decimal escape"
  } else if (isOctalDigitCode(st.pattern.charCodeAt(p))) {
    c = st.pattern.charCodeAt(p) - 0x30;
    p++;
    if (isOctalDigitCode(st.pattern.charCodeAt(p))) {
      c = (c << 3) + (st.pattern.charCodeAt(p) - 0x30);
      p++;
    }
  }
  st.pos = p;
  if (st.ignoreCase) assertNoUnicodeCasefold(st);
  return { kind: "char", cp: st.ignoreCase ? canonicalize(c) : c, ignoreCase: st.ignoreCase };
}

/** parse_digits(&p, false) (libregexp.c:703-726): -1 on overflow, does
 * NOT clamp (unlike the quantifier count parser, which does). */
function parseDigitsSigned(pattern: string, pos: number): { value: number; next: number } {
  let v = 0;
  let p = pos;
  for (;;) {
    const c = pattern.charCodeAt(p);
    if (!isDigitChar(c)) break;
    v = v * 10 + (c - 0x30);
    if (v >= 0x7fffffff) return { value: -1, next: p }; // matches the reference's early return
    p++;
  }
  return { value: v, next: p };
}

/** \1-\9 (libregexp.c:2119-2153): a numbered backreference if the digits
 * name a capture that exists ANYWHERE in the pattern (forward references
 * are legal); otherwise, non-unicode falls back to Annex B legacy octal
 * (or a bare literal digit), unicode is a hard error. */
function parseNumberedBackrefOrOctal(st: ParserState, backslashPos: number): RegexAst | null {
  const digitStart = backslashPos + 1;
  const parsed = parseDigitsSigned(st.pattern, digitStart);
  const totalCaptures = scanCaptures(st.pattern).totalCaptureCount;
  if (parsed.value >= 0 && parsed.value < totalCaptures) {
    st.pos = parsed.next;
    return { kind: "backreference", indices: [parsed.value], ignoreCase: st.ignoreCase };
  }
  if (st.isUnicode) return null; // "back reference out of range"
  // Annex B legacy octal fallback, reset to the first digit — the digit
  // at `digitStart` is guaranteed '1'-'9' by this function's own caller
  // (parseTerm only reaches here after matching that case), so `<= '7'`
  // alone (no `>= '0'` companion) is safe, exactly mirroring the
  // reference's own unguarded `*p <= '7'` at this point.
  let p = digitStart;
  let c: number;
  if (st.pattern.charCodeAt(p) <= 0x37 /* '7' */) {
    c = 0;
    if (st.pattern.charCodeAt(p) <= 0x33 /* '3' */) {
      c = st.pattern.charCodeAt(p) - 0x30;
      p++;
    }
    if (isOctalDigitCode(st.pattern.charCodeAt(p))) {
      c = (c << 3) + (st.pattern.charCodeAt(p) - 0x30);
      p++;
      if (isOctalDigitCode(st.pattern.charCodeAt(p))) {
        c = (c << 3) + (st.pattern.charCodeAt(p) - 0x30);
        p++;
      }
    }
  } else {
    c = st.pattern.charCodeAt(p);
    p++;
  }
  st.pos = p;
  if (st.ignoreCase) assertNoUnicodeCasefold(st);
  return { kind: "char", cp: st.ignoreCase ? canonicalize(c) : c, ignoreCase: st.ignoreCase };
}

/** The '(' dispatch (libregexp.c:1911-2039): non-capturing, modifier,
 * lookahead/lookbehind, named-capturing (CP2c), or plain capturing. */
function parseGroup(st: ParserState, openParen: number): RegexAst | null {
  const p1 = st.pattern.charCodeAt(openParen + 1);
  if (p1 !== 0x3f /* '?' */) {
    // Plain (unnamed) capturing group.
    if (st.captureCount >= CAPTURE_COUNT_MAX) return null; // "too many captures"
    const captureIndex = st.captureCount++;
    st.pos = openParen + 1;
    const body = parseDisjunction(st);
    if (body === null) return null;
    const close = expect(st.pattern, st.pos, 0x29 /* ')' */);
    if (close === null) return null;
    st.pos = close;
    return { kind: "group", capture: captureIndex, name: null, nameScope: 0, body };
  }
  const p2 = st.pattern.charCodeAt(openParen + 2);
  if (p2 === 0x3a /* ':' */) {
    st.pos = openParen + 3;
    const body = parseDisjunction(st);
    if (body === null) return null;
    const close = expect(st.pattern, st.pos, 0x29);
    if (close === null) return null;
    st.pos = close;
    return { kind: "group", capture: null, name: null, nameScope: 0, body };
  }
  if (p2 === 0x69 /* 'i' */ || p2 === 0x6d /* 'm' */ || p2 === 0x73 /* 's' */ || p2 === 0x2d /* '-' */) {
    return parseModifierGroup(st, openParen);
  }
  if (p2 === 0x3d /* '=' */ || p2 === 0x21 /* '!' */) {
    st.pos = openParen + 3;
    return parseLookaround(st, p2 === 0x21, false);
  }
  const p3 = st.pattern.charCodeAt(openParen + 3);
  if (p2 === 0x3c /* '<' */ && (p3 === 0x3d /* '=' */ || p3 === 0x21 /* '!' */)) {
    st.pos = openParen + 4;
    return parseLookaround(st, p3 === 0x21, true);
  }
  if (p2 === 0x3c /* '<' */) {
    return parseNamedGroup(st, openParen);
  }
  return null; // "invalid group"
}

/** (?<name>...) (libregexp.c:1992-2012's dispatch into the shared
 * `parse_capture` label at :2019). Duplicate-name detection uses the
 * SAME flat groupNameScope counter ParserState documents — transcribed
 * as the reference's own "poor's man method", not a tree-based one. */
function parseNamedGroup(st: ParserState, openParen: number): RegexAst | null {
  const nameRes = parseGroupName(st.pattern, openParen + 3);
  if (nameRes === null) return null; // "invalid group name"
  if (st.seenGroupNames.some((g) => g.name === nameRes.name && g.scope === st.groupNameScope)) {
    return null; // "duplicate group name"
  }
  // Captured NOW, not read lazily later: a '|' inside this group's own
  // body (or later in an enclosing disjunction) increments
  // st.groupNameScope AFTER this point, but the trailer entry's scope
  // byte (libregexp.c:2007's `dbuf_putc(&s->group_names,
  // s->group_name_scope)`) records the value at THIS group's OWN parse
  // point, matching the reference's own dbuf_putc call site (which runs
  // before the group's body is even parsed).
  const nameScope = st.groupNameScope;
  st.seenGroupNames.push({ name: nameRes.name, scope: nameScope });
  if (st.captureCount >= CAPTURE_COUNT_MAX) return null; // "too many captures"
  const captureIndex = st.captureCount++;
  st.pos = nameRes.next;
  const body = parseDisjunction(st);
  if (body === null) return null;
  const close = expect(st.pattern, st.pos, 0x29 /* ')' */);
  if (close === null) return null;
  st.pos = close;
  return { kind: "group", capture: captureIndex, name: nameRes.name, nameScope, body };
}

function parseLookaround(st: ParserState, negate: boolean, backward: boolean): RegexAst | null {
  const body = parseDisjunction(st);
  if (body === null) return null;
  const close = expect(st.pattern, st.pos, 0x29);
  if (close === null) return null;
  st.pos = close;
  return { kind: "lookahead", negate, backward, body };
}

/** (?i-m:...) etc. (libregexp.c:1923-1961). TRANSPARENT at the AST level
 * (regex-ast.ts's header explains why: the reference emits no opcode for
 * entering/leaving the scope, only nested atoms' OWN encoding changes) —
 * so this returns the BODY's node directly, not a wrapper. The GO rider
 * 1b reaching pin lives in wasm-regex-parser.test.ts: it must prove the
 * flag-state change actually reached a nested atom's compilation (a
 * canonicalized char code differing from the un-modified parse), not
 * just that this function returns without error. */
function parseModifierGroup(st: ParserState, openParen: number): RegexAst | null {
  let p = openParen + 2;
  const add = parseModifiers(st.pattern, p);
  if (add === null) return null;
  p = add.next;
  let removeMask = 0;
  if (st.pattern.charCodeAt(p) === 0x2d /* '-' */) {
    p++;
    const rem = parseModifiers(st.pattern, p);
    if (rem === null) return null;
    p = rem.next;
    removeMask = rem.mask;
  }
  if ((add.mask === 0 && removeMask === 0) || (add.mask & removeMask) !== 0) {
    return null; // "invalid modifiers"
  }
  const colon = expect(st.pattern, p, 0x3a /* ':' */);
  if (colon === null) return null;

  const savedIgnoreCase = st.ignoreCase;
  const savedMultiLine = st.multiLine;
  const savedDotAll = st.dotAll;
  st.ignoreCase = updateModifier(st.ignoreCase, add.mask, removeMask, MOD_I);
  st.multiLine = updateModifier(st.multiLine, add.mask, removeMask, MOD_M);
  st.dotAll = updateModifier(st.dotAll, add.mask, removeMask, MOD_S);

  st.pos = colon;
  const body = parseDisjunction(st);
  const afterBody = st.pos;
  st.ignoreCase = savedIgnoreCase;
  st.multiLine = savedMultiLine;
  st.dotAll = savedDotAll;
  if (body === null) return null;
  const close = expect(st.pattern, afterBody, 0x29 /* ')' */);
  if (close === null) return null;
  st.pos = close;
  return body;
}

/** re_parse_alternative (libregexp.c:2382): a run of terms, each
 * optionally quantified. Quantifier-wrapping (libregexp.c:2206-2374) is
 * ATTACHED HERE rather than inside parseTerm, matching the reference's
 * own structure (last_atom_start applies uniformly to whatever the
 * dispatch produced). */
function parseAlternative(st: ParserState): RegexAst | null {
  const terms: RegexAst[] = [];
  for (;;) {
    const c = st.pattern.charCodeAt(st.pos);
    if (Number.isNaN(c) || c === 0x7c /* '|' */ || c === 0x29 /* ')' */) break;
    let atom = parseTerm(st);
    if (atom === null) return null;
    const q = parseQuantifier(st);
    if (q !== undefined) {
      if (q === null) return null; // invalid_quant_count
      if (!isQuantifiable(atom, st.isUnicode)) return null; // "nothing to repeat" / "invalid quantifier"
      atom = { kind: "quantifier", min: q.min, max: q.max, greedy: q.greedy, body: atom };
    }
    terms.push(atom);
  }
  return { kind: "alternative", terms };
}

/** WHICH ATOM KINDS libregexp allows a following quantifier to apply to
 * (libregexp.c:1862 `last_atom_start = -1`, reassigned only in specific
 * branches; the quantifier switch at :2207 is gated `if (last_atom_start
 * >= 0)`). This is a PARSE-reads-EMISSION-state coupling in the
 * reference (re_parse_term's own bookkeeping of where the just-emitted
 * atom's bytecode begins) that this AST-first design does not need in
 * the same FORM — no bytecode positions exist yet — but the underlying
 * SEMANTIC FACT (which atoms are quantifiable) is real and must still be
 * enforced here, in the parser, not deferred to the assembler.
 *
 * TRACED from the reference and VERIFIED against Node directly (not
 * assumed): ^ $ \b \B are NEVER quantifiable (libregexp.c never sets
 * last_atom_start for line_start/line_end/word_boundary — a quantified
 * ^, $, or \b is all "Nothing to repeat" in Node, both modes). Lookahead is
 * quantifiable ONLY in the forward, non-unicode case — Annex B's
 * leniency, libregexp.c:1976 `if (!s->is_unicode &&
 * !is_backward_lookahead)`: forward lookahead under /u, and lookbehind
 * (backward) in EITHER mode, are "Invalid quantifier" in Node. EVERY
 * OTHER atom kind (dot, char, charClass, backreference, group,
 * disjunction — the last arising here only via a TRANSPARENT modifier
 * group, quantified as the whole group per libregexp.c:1950's
 * last_atom_start placement BEFORE the body) is quantifiable — this
 * matches the reference exactly since parseTerm's single return value
 * is always "the atom" a following quantifier wraps whole, regardless
 * of what shape that value has. */
function isQuantifiable(node: RegexAst, isUnicode: boolean): boolean {
  switch (node.kind) {
    case "lineStart":
    case "lineEnd":
    case "wordBoundary":
      return false;
    case "lookahead":
      if (node.backward) return false;
      return !isUnicode;
    default:
      return true;
  }
}

/** The quantifier suffix (libregexp.c:2207-2374, parsing half only — the
 * bytecode-splicing strategy the reference chooses per case is an
 * ASSEMBLER concern, not represented here). Returns `undefined` (no
 * quantifier present, term stands alone), `null` (a quantifier-shaped
 * suffix that fails to parse), or the resolved {min,max,greedy}. */
function parseQuantifier(st: ParserState): { min: number; max: number; greedy: boolean } | null | undefined {
  const c = st.pattern.charCodeAt(st.pos);
  let min: number;
  let max: number;
  if (c === 0x2a /* '*' */) {
    st.pos++;
    min = 0;
    max = Infinity;
  } else if (c === 0x2b /* '+' */) {
    st.pos++;
    min = 1;
    max = Infinity;
  } else if (c === 0x3f /* '?' */) {
    st.pos++;
    min = 0;
    max = 1;
  } else if (c === 0x7b /* '{' */) {
    const p0 = st.pos;
    if (!isDigitChar(st.pattern.charCodeAt(p0 + 1))) {
      if (st.isUnicode) return null; // invalid_quant_count
      return undefined; // Annex B: normal atom, no quantifier
    }
    let p = p0 + 1;
    min = parseDigitsClamped(st.pattern, p);
    p = skipDigits(st.pattern, p);
    max = min;
    if (st.pattern.charCodeAt(p) === 0x2c /* ',' */) {
      p++;
      if (isDigitChar(st.pattern.charCodeAt(p))) {
        max = parseDigitsClamped(st.pattern, p);
        p = skipDigits(st.pattern, p);
        if (max < min) return null; // invalid_quant_count
      } else {
        max = Infinity;
      }
    }
    if (st.pattern.charCodeAt(p) !== 0x7d /* '}' */) {
      if (!st.isUnicode) return undefined; // Annex B: normal atom
      return null;
    }
    st.pos = p + 1;
  } else {
    return undefined;
  }
  let greedy = true;
  if (st.pattern.charCodeAt(st.pos) === 0x3f /* '?' */) {
    st.pos++;
    greedy = false;
  }
  return { min, max, greedy };
}

function skipDigits(pattern: string, pos: number): number {
  let p = pos;
  while (isDigitChar(pattern.charCodeAt(p))) p++;
  return p;
}

function parseDigitsClamped(pattern: string, pos: number): number {
  // parse_digits(&p, true) (libregexp.c:703): clamps to INT32_MAX rather
  // than erroring on overflow. This port uses `Infinity` as max's own
  // "unbounded" sentinel already, so INT32_MAX (a real, large but finite
  // number) is what a huge literal quantifier count clamps to here.
  let v = 0;
  let p = pos;
  while (isDigitChar(pattern.charCodeAt(p))) {
    v = v * 10 + (pattern.charCodeAt(p) - 0x30);
    if (v >= 0x7fffffff) v = 0x7fffffff;
    p++;
  }
  return v;
}

/** re_parse_disjunction (libregexp.c:2416): alternatives separated by
 * '|'. A single-alternative disjunction still wraps in a "disjunction"
 * node (matching the reference's own uniform REOP_split emission whether
 * or not there is more than one branch would be an ASSEMBLER decision;
 * this AST layer keeps the wrapper unconditionally for a simpler,
 * uniform shape). */
function parseDisjunction(st: ParserState): RegexAst | null {
  const alternatives: RegexAst[] = [];
  for (;;) {
    const alt = parseAlternative(st);
    if (alt === null) return null;
    alternatives.push(alt);
    if (st.pattern.charCodeAt(st.pos) === 0x7c /* '|' */) {
      st.pos++;
      st.groupNameScope++; // libregexp.c:2440 — see ParserState's own doc
      continue;
    }
    break;
  }
  return { kind: "disjunction", alternatives };
}

export interface ParseResult {
  ast: RegexAst;
  next: number;
}

/** Entry point: parses a full pattern (or a sub-pattern starting at
 * `pos`, for future reuse). `pos` should be 0 and the whole pattern
 * consumed for a top-level parse — callers checking for trailing,
 * unconsumed input (a real syntax error, e.g. an unmatched ')') should
 * verify `next === pattern.length`. */
export function parsePattern(
  pattern: string,
  pos: number,
  isUnicode: boolean,
  ignoreCase: boolean,
  multiLine: boolean,
  dotAll: boolean,
): ParseResult | null {
  const st: ParserState = {
    pattern,
    pos,
    isUnicode,
    ignoreCase,
    multiLine,
    dotAll,
    groupNameScope: 0,
    seenGroupNames: [],
    captureCount: 1,
  };
  const ast = parseDisjunction(st);
  if (ast === null) return null;
  return { ast, next: st.pos };
}
