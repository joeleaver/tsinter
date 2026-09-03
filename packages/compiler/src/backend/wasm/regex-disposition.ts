/* INC-24 P2: the four regexLit-side refusal-key DETECTORS (design §5.1's
 * disposition table — modifiers, annexb, unicode-casefold, unported-
 * unicode-property). NEW file, NOT an edit to any P1 engine file (the
 * "engine untouched" rule) — P1's parser correctly PARSES all four
 * constructs (or, for unported-unicode-property, correctly REJECTS at
 * parse time already); detecting them here is a P2-owned classification
 * layer over that already-verified engine, reusing its exported pieces
 * directly rather than re-deriving grammar.
 *
 * WHY EACH ONE NEEDS ITS OWN DETECTION STRATEGY (none of the four share
 * one mechanism — worth stating plainly, since a reader expecting a
 * single dispatch will be surprised otherwise):
 *
 * unicode-casefold (/iu together): trivial — a flag-string check, no
 * pattern text involved at all (design §6.3(a)).
 *
 * modifiers ((?i:)/(?-i:)/(?i-m:)): CONFIRMED LIVE (probed directly
 * before writing this) that P1's parser ALREADY structurally recognizes
 * modifier groups and correctly applies their SCOPED effect — parsing
 * `(?i:a)` produces a `char` node with cp=CANONICALIZE('a')=0x41 and
 * ignoreCase:true, exactly as regex-ast.ts's own "cp already
 * Canonicalize()'d if ignoreCase" convention requires. The AST is
 * TRANSPARENT (no distinct "this came from a modifier group" node), so
 * detection can't be "does it fail to parse" — it parses FINE. Design's
 * own REFUSE reasoning is a POLICY choice (§6.2's class case closure
 * assumes ignoreCase is CONSTANT per pattern; a modifier group makes it
 * vary WITHIN one pattern, an interaction this port's class-closure
 * machinery was never verified against), not a parser gap. Detection:
 * walk the AST comparing every scope-sensitive node's OWN flag
 * (char/charClass.ignoreCase, lineStart/lineEnd.multiline, dot.dotAll,
 * wordBoundary.ignoreCaseUnicode) against the PATTERN'S OWN top-level
 * flags — if ANY node's flag differs, a modifier group is the ONLY
 * mechanism that could have produced that difference (regex-ast.ts's
 * own doc: flag-dependent decisions are "baked into nodes AT PARSE
 * TIME" from whatever scope was active when each atom was reached).
 * EXACT (no scanning, no false positive/negative risk) — a structural
 * fact about the parser's own already-verified output, not a guess.
 *
 * annexb (the extended-grammar bundle, design §5.1's own list): reuses
 * the DESIGN'S OWN measurement methodology directly (annexb-need.mjs:
 * "all 140 distinct claim patterns parse under the u flag") — a
 * pattern relies on an Annex-B-only extension IFF it parses under the
 * ACTUAL (non-unicode) flags but FAILS to parse under isUnicode FORCED
 * true (same other flags). This re-runs the SAME already-verified
 * parser twice rather than re-deriving Annex-B's own grammar by hand —
 * zero new grammar logic, only a second parse call. Only meaningful
 * when the actual pattern is non-unicode to begin with (an already-/u
 * pattern is already strict, trivially not Annex-B-reliant).
 *
 * unported-unicode-property (\p{Script=...}/\P{...}/binary properties
 * under /u): P1's own errata item 2 confirms this is /u-ONLY (without
 * /u, \p is Annex B's own literal-'p' identity escape — a DIFFERENT,
 * already-IMPLEMENTED disposition, so this detector only runs when
 * unicode is true). Scans the pattern text for `\p{...}`/`\P{...}`
 * occurrences and calls regex-charclass.ts's OWN EXPORTED
 * parseUnicodeProperty on each, checking for its `cr: null` result —
 * the EXACT same null P1's own unicodeGeneralCategory returns for an
 * unsupported name (errata item 2's own "the null must never be
 * conflated with Node's own SyntaxError" pin). PRAGMATIC, not
 * exhaustively parser-exact: a plain regex scan, not a full re-parse —
 * accepts a THEORETICAL false-positive on a pattern containing the
 * literal text `\\p{` (an escaped backslash immediately followed by
 * literal `p{`), which textually resembles a property escape but
 * isn't one. NAMED explicitly because this project's own culture wants
 * trade-offs stated, not hidden: the real corpus has exactly ONE \p{}
 * occurrence total (\p{L}, already General_Category-supported, already
 * measured non-null) per P1's own scoping finding, so this risk is
 * theoretical, not practical, for the actual gate.
 */
import type { RegexAst } from "./regex-ast.js";
import { parseUnicodeProperty } from "./regex-charclass.js";
import { scanCaptures } from "./regex-parser.js";

/** THE NINE ANNEX-B (ECMA-262 B.1.2) PRODUCTION FAMILIES (INC-24 P5,
 * findings/annexb-enumeration.txt, sha256 d7f721c1... — des-24's
 * authoritative sweep, 45 candidate forms measured against live Node,
 * collapsing to nine, plus the 2026-09-03 addendum proving the nine
 * exhaustive by three independent derivations — the oracle's own
 * positions×forms sweep, the vendored libregexp.c reference, and partial
 * spec text). ONLY family 6 OUTSIDE a character class (lenient
 * IdentityEscape — `\-`, `\ `, `\_`, and generally any escaped character
 * strict IdentityEscape rejects) is IMPLEMENTED; family 6 INSIDE a class
 * was already IMPLEMENT before this pass (errata item 1's sibling fix).
 * The other eight REFUSE by their own name, so the census shows WHICH
 * legacy construct a program actually needs — team-lead's own
 * recommendation, matching the "sweep the alphabet, not the feature
 * list" discipline this same document's own headline finding is about
 * (family 7 was missing from design-regex-v6.txt's own §5.1 bundle
 * entirely, invisible to grammar-coverage.mjs by construction — a
 * bundled row can't be checked for completeness, only for existence).
 *
 * DO NOT DELETE F4/F5/F9 AS "DEAD CODE" — THE P3 NINTH-KEY BACKSTOP
 * PATTERN, applied here without being told (rev-24's own gate finding,
 * INC-24 P5 freeze p5-v1's advisory): three of these eight refused
 * families — legacy-octal (F4), nonoctal-decimal (F5), named-backref-
 * leniency (F9) — are STRUCTURALLY UNREACHABLE from real TypeScript
 * source. TSC's own frontend rejects the literal forms that would reach
 * them (`/\1/` and `/\01/` with no capturing group, `/\8/`, `/\k<x>/`
 * with no named group — TS1534/TS1487/TS1532 respectively, surfaced as
 * SC0001, this project's own TSC-error-passthrough gate) BEFORE the wasm
 * backend ever runs — verified directly, `tsc --noEmit --strict` on all
 * four forms, all four rejected. A regex.new call with a FOLDED constant
 * pattern could theoretically still reach these three (the folder builds
 * its own pattern text at compile time, past TSC's own literal-syntax
 * check) — this is the live reach path, not a purely theoretical one.
 * So these three keys are BACKSTOPS against a third-party validator (TSC
 * itself) changing across versions — the SAME shape as the regexLit
 * `expr:regexLit:invalid-pattern` backstop check elsewhere in this
 * backend (its own doc: "a future TSC version accepting something
 * design-regex-v6.txt §5.1 doesn't handle would otherwise flow a bad
 * literal into parse/assemble undefined") — not dead code, even though
 * the corpus census shows their own bucket empty today (confirmed:
 * item A, freeze p5-v1 — zero corpus programs reach any of the eight
 * refused families at all). They are pinned at the CONSTRUCTIBLE level
 * directly (wasm-regex-disposition.test.ts's own classifyAnnexBFamily
 * calls, bypassing TSC's own lexer the same way the invalid-pattern
 * backstop's own hand-built-IrModule pins do), which is what makes them
 * verifiably live rather than aspirational. The other five families
 * (quantified-assertion, extended-pattern-char, brace-literal, control-
 * escape, class-range-escape) ARE reachable through ordinary literal
 * source (`(?=a)*`, `a]b`, `a{,2}`, `\c1`, `[a-\d]` all parse cleanly
 * through TSC) — no backstop framing applies to those five. */
export type AnnexBFamily =
  | "quantified-assertion" // F1 — a lookahead (never lookbehind) directly followed by a quantifier
  | "extended-pattern-char" // F2 — a lone, unescaped ] { or } outside any class/quantifier
  | "brace-literal" // F3 — a { that doesn't form a valid quantifier body, taken as literal text
  | "legacy-octal" // F4 — \0<digit>, or \1-\7 with no corresponding capture group — BACKSTOP, see this section's own header (TSC's SC0001 preempts every literal form; reachable only via a folded regex.new pattern)
  | "nonoctal-decimal" // F5 — \8 or \9 with no corresponding capture group — BACKSTOP, same reason
  | "control-escape" // F7 — \c (bare) or \c<non-control-letter>, in or out of a class
  | "class-range-escape" // F8 — a class range whose endpoint is a CharacterClassEscape (\d\D\s\S\w\W)
  | "named-backref-leniency"; // F9 — \k (bare or \k<name>) when the WHOLE pattern has no named groups — BACKSTOP, same reason

export type RegexLitRefusal =
  | "modifiers"
  | "unicode-casefold"
  | "unported-unicode-property"
  | `annexb-${AnnexBFamily}`;

/** unicode-casefold: /iu together (design §6.3(a)). */
export function usesUnicodeCasefold(ignoreCase: boolean, unicode: boolean): boolean {
  return ignoreCase && unicode;
}

/** modifiers: AST-diff walk — see this file's own header for the full
 * argument. `topIgnoreCase`/`topMultiline`/`topDotAll` are the
 * PATTERN's own top-level flags (what every node would carry if no
 * modifier group ever overrode them). */
export function usesModifierGroup(ast: RegexAst, topIgnoreCase: boolean, topMultiline: boolean, topDotAll: boolean): boolean {
  switch (ast.kind) {
    case "lineStart":
    case "lineEnd":
      return ast.multiline !== topMultiline;
    case "dot":
      return ast.dotAll !== topDotAll;
    case "char":
    case "charClass":
      return ast.ignoreCase !== topIgnoreCase;
    case "wordBoundary":
      // ignoreCaseUnicode combines ignoreCase with the (already-fenced-
      // elsewhere) unicode-casefold axis; comparing against topIgnoreCase
      // is the same "did THIS node's own scope differ" test as the
      // char/charClass arms — unicode-casefold itself is checked
      // separately (usesUnicodeCasefold) and always fires first when it
      // applies, so this comparison is never reached under /iu.
      return ast.ignoreCaseUnicode !== topIgnoreCase;
    case "backreference":
      return false; // carries no scope-sensitive flag of its own
    case "group":
      return usesModifierGroup(ast.body, topIgnoreCase, topMultiline, topDotAll);
    case "lookahead":
      return usesModifierGroup(ast.body, topIgnoreCase, topMultiline, topDotAll);
    case "quantifier":
      return usesModifierGroup(ast.body, topIgnoreCase, topMultiline, topDotAll);
    case "alternative":
      return ast.terms.some((t) => usesModifierGroup(t, topIgnoreCase, topMultiline, topDotAll));
    case "disjunction":
      return ast.alternatives.some((a) => usesModifierGroup(a, topIgnoreCase, topMultiline, topDotAll));
  }
}

/** annexb: re-parse under isUnicode=true and compare — see this file's
 * own header. `parseFn` is injected (parsePattern itself) rather than
 * imported, keeping this file free of a regex-parser.ts import cycle
 * risk and making the re-parse call site visible to a reader here
 * rather than hidden behind another module's own name. */
export function usesAnnexBOnly(
  pattern: string,
  ignoreCase: boolean,
  multiline: boolean,
  dotAll: boolean,
  unicode: boolean,
  parseFn: (pattern: string, pos: number, isUnicode: boolean, ignoreCase: boolean, multiline: boolean, dotAll: boolean) => { next: number } | null,
): boolean {
  if (unicode) return false; // already strict; Annex-B extensions don't exist under /u
  // ignoreCase is deliberately NOT threaded through to either parse call
  // below: Annex-B's own bundle (design §5.1) is purely a GRAMMAR
  // question (lone ], a{,2} as literal text, etc.), never case-
  // sensitive — and forcing isUnicode=true for the strict re-parse
  // while carrying the ORIGINAL ignoreCase through would recreate the
  // forbidden /iu combination for an ignoreCase:true pattern, which
  // regex-parser.ts THROWS on by design (assertNoUnicodeCasefold) —
  // caught by this file's own pins on their first run, not assumed
  // safe.
  const actual = parseFn(pattern, 0, false, false, multiline, dotAll);
  if (actual === null || actual.next !== pattern.length) return false; // doesn't even parse under actual flags — not this detector's concern (S065's own territory)
  const strict = parseFn(pattern, 0, true, false, multiline, dotAll);
  return strict === null || strict.next !== pattern.length;
}

/** unported-unicode-property: pragmatic text scan — see this file's own
 * header for the accepted false-positive edge case. Only meaningful
 * under /u (errata item 2). */
export function usesUnportedUnicodeProperty(pattern: string, unicode: boolean): boolean {
  if (!unicode) return false;
  const re = /\\[pP]\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    const isInv = pattern[m.index + 1] === "P";
    // pos points AT the `{` itself (getClassAtom's own call convention,
    // regex-charclass.ts:487 — parseUnicodeProperty consumes the `{...}`
    // wrapper itself, so the caller stops right after the p/P letter).
    const result = parseUnicodeProperty(pattern, m.index + 2, isInv);
    if (result.cr === null) return true;
  }
  return false;
}

/* ── Annex-B family classification (INC-24 P5) ──────────────────────────
 * ELIMINATION, not a "safe character set": usesAnnexBOnly (unchanged,
 * still the entry gate) already answers "does this pattern rely on SOME
 * Annex-B leniency" via the SAME re-parse-under-both-flags differential
 * as before. When it's true, classifyAnnexBFamily runs eight POSITIVE
 * detectors (families 1,2,3,4,5,7,8,9); if none of them fire, the
 * pattern's own Annex-B reliance is family 6 (lenient IdentityEscape
 * outside a class) BY ELIMINATION — no detector for family 6 itself is
 * needed, and no "which characters are safe" enumeration is needed
 * either. This is SOUND, not just convenient: usesAnnexBOnly's own
 * precondition already requires the pattern to PARSE under actual flags
 * (checked directly against a dozen distinct forms this pass — the
 * ported parser, real QuickJS libregexp.c machinery, already implements
 * the FULL Annex-B grammar correctly), so by the time elimination runs,
 * a real, correct AST already exists; elimination only has to correctly
 * RULE OUT the other eight, never has to positively prove family 6's own
 * boundary. Every detector below is gated behind ast!==null (usesAnnexBOnly's
 * own precondition), so a genuine parse failure (a{2,1}'s reversed
 * bounds, a quantified lookbehind — MANDATED ERRORS in every mode, not
 * leniency) never reaches ANY of them: usesAnnexBOnly's own guard
 * ("actual===null -> return false") already excludes those upstream,
 * verified directly against this project's own parser for all five
 * mandated-error forms named in findings/annexb-enumeration.txt.
 *
 * KNOWN, ACCEPTED GAP (theoretical, not practical — same framing as
 * usesUnportedUnicodeProperty's own header note): the F4/F5 legacy-
 * numeric-escape detector below only classifies SINGLE-DIGIT decimal
 * escapes (\0-\9), matching every case this pass measured and every
 * case the corpus needs (des's own sweep: exactly one corpus program,
 * 2284, reaches Annex-B at all, and its own reliance is pure family 6 —
 * no numeric escape of any kind). A multi-digit legacy decimal escape
 * (\12 with no group 12) is unreached by anything in scope; if it were
 * ever reached, it would fall through to "family6" by elimination rather
 * than being named "legacy-octal"/"nonoctal-decimal" — still SAFE (the
 * underlying parser handles it correctly regardless, so no wrong output
 * results), just not verified/claimed under its own precise name. */

/** F1 — QuantifiableAssertion Quantifier: a lookahead (never lookbehind
 * — `backward:true` is excluded explicitly, though it can never reach
 * here anyway since a quantified lookbehind is a mandated parse error in
 * every mode) directly quantified. Recursive AST walk, mirrors
 * usesModifierGroup's own exhaustive-switch structure. */
function hasQuantifiedLookahead(ast: RegexAst): boolean {
  switch (ast.kind) {
    case "lineStart":
    case "lineEnd":
    case "dot":
    case "char":
    case "charClass":
    case "wordBoundary":
    case "backreference":
      return false;
    case "group":
      return hasQuantifiedLookahead(ast.body);
    case "lookahead":
      return hasQuantifiedLookahead(ast.body);
    case "quantifier":
      if (ast.body.kind === "lookahead" && !ast.body.backward) return true;
      return hasQuantifiedLookahead(ast.body);
    case "alternative":
      return ast.terms.some((t) => hasQuantifiedLookahead(t));
    case "disjunction":
      return ast.alternatives.some((a) => hasQuantifiedLookahead(a));
  }
}

/** F2/F3 — brace/bracket leniency: a lone, unescaped `]`/`{`/`}` outside
 * any class (F2 — ExtendedPatternCharacter), or a `{` that doesn't form
 * a valid quantifier body `{n}`/`{n,}`/`{n,m}` and is taken as literal
 * text instead (F3). A `{...}` that DOES match quantifier syntax is
 * consumed and skipped here even when its bounds are reversed (`{2,1}`)
 * — that's a MANDATED error (InvalidBracedQuantifier), never leniency,
 * and can't reach this function anyway (ast===null for it upstream). */
function classifyBraceLeniency(pattern: string): "extended-pattern-char" | "brace-literal" | null {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "]" || ch === "}") return "extended-pattern-char";
    if (ch === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      if (m !== null) {
        i += m[0].length - 1; // valid quantifier SYNTAX — consumed, not leniency
        continue;
      }
      return "brace-literal";
    }
  }
  return null;
}

/** F4/F5 — legacy numeric escape: \0 followed by another digit, or \1-\9
 * where the SINGLE digit does not correspond to an existing capture
 * group (scanCaptures's own totalCaptureCount — the SAME whole-pattern,
 * capture-aware disambiguation the reference parser itself needs for
 * numbered backreferences, reused rather than re-derived). \0 ALONE
 * (no following digit) is STRICT and is explicitly never flagged. See
 * this section's own header for the accepted single-digit-only scope. */
function classifyLegacyNumericEscape(pattern: string, totalCaptureCount: number): "legacy-octal" | "nonoctal-decimal" | null {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const d0 = pattern[i + 1];
      if (!inClass && d0 !== undefined && d0 >= "0" && d0 <= "9") {
        const d1 = pattern[i + 2];
        const hasSecondDigit = d1 !== undefined && d1 >= "0" && d1 <= "9";
        if (d0 === "0") {
          if (hasSecondDigit) return "legacy-octal";
          // \0 alone — strict NUL escape, never legacy.
        } else {
          const n = Number(d0);
          const isValidBackref = n < totalCaptureCount; // group n (1-9) exists?
          if (!isValidBackref) return d0 <= "7" ? "legacy-octal" : "nonoctal-decimal";
        }
      }
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
  }
  return null;
}

/** F7 — \c leniency: a bare `\c` (end of pattern or non-letter follows)
 * outside the strict ControlEscape production (`\c` + A-Za-z). ONE
 * predicate, deliberately — MEASURED directly against live Node (both
 * parse-success and the /u differential) for every follower character
 * this pass could find reason to doubt (0-9, `_`, space, non-ASCII,
 * `-`, `]`, `$`), in EVERY case both inside AND outside a class: the
 * boundary is IDENTICAL in both positions (A-Za-z strict, everything
 * else Annex-B-only) — unlike family 6 (`\-` itself: lenient outside a
 * class, STRICT inside one, errata item 1) and family 8 (meaningless
 * outside a class at all), family 7 has no in/out-of-class asymmetry to
 * get wrong. Checked because the project's own recurring axis here
 * (three prior defects: \-, \p, and this file's own first draft of this
 * comment) is exactly "assumed one predicate covers both positions
 * without measuring" — this one MEASURES clean, so one predicate is the
 * verified answer, not an assumption. (`\c\\`, a backslash immediately
 * after \c, throws in EVERY mode and position — a mandated error, never
 * reaches this detector at all.) */
function hasLenientControlEscape(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    if (pattern[i + 1] === "c") {
      const ctrl = pattern[i + 2];
      const isRealControlLetter = ctrl !== undefined && ((ctrl >= "A" && ctrl <= "Z") || (ctrl >= "a" && ctrl <= "z"));
      if (!isRealControlLetter) return true;
    }
    i++;
  }
  return false;
}

/** F8 — a character class range whose endpoint is a CharacterClassEscape
 * (\d\D\s\S\w\W) rather than a literal character — `[a-\d]`, `[\d-z]`,
 * `[\w-a]`, `[\d-\w]`. Scoped to INSIDE a class only (this family has no
 * meaning outside one — a bare `-\d` outside a class is two ordinary
 * atoms, not a range). */
function hasClassRangeEscapeEndpoint(pattern: string): boolean {
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    if (pattern[i] !== "[") {
      i++;
      continue;
    }
    let j = i + 1;
    let prevWasClassEscape = false;
    while (j < pattern.length && pattern[j] !== "]") {
      if (pattern[j] === "\\") {
        const esc = pattern[j + 1];
        const isClassEscape = esc !== undefined && "dDsSwW".includes(esc);
        if (isClassEscape && pattern[j - 1] === "-") return true; // class-escape as the RIGHT end of a range
        prevWasClassEscape = isClassEscape;
        j += 2;
        continue;
      }
      if (pattern[j] === "-" && prevWasClassEscape) return true; // class-escape as the LEFT end of a range
      prevWasClassEscape = false;
      j++;
    }
    i = j + 1;
  }
  return false;
}

/** F9 — \k leniency: a bare `\k` or `\k<name>` when the WHOLE pattern
 * has NO named capture groups anywhere (scanCaptures's own
 * hasNamedCaptures — the same non-local, whole-pattern rule §5.3
 * already needs for \k's own backreference resolution). When named
 * groups DO exist, an invalid \k<name> reference is a MANDATED error
 * ("Invalid named capture referenced"/"Invalid named reference"), never
 * this family — and per this section's own gating, a mandated error
 * never reaches here anyway (ast===null for it upstream). */
function hasLenientNamedBackref(pattern: string, hasNamedCaptures: boolean): boolean {
  if (hasNamedCaptures) return false;
  return /\\k/.test(pattern);
}

/** THE ELIMINATION CLASSIFIER (see this section's own header). Returns
 * null when the pattern doesn't rely on Annex-B at all, "family6" when
 * it does but ONLY on the now-implemented lenient-IdentityEscape-
 * outside-a-class production, or the specific family name to refuse by. */
export function classifyAnnexBFamily(
  pattern: string,
  ast: RegexAst | null,
  ignoreCase: boolean,
  multiline: boolean,
  dotAll: boolean,
  unicode: boolean,
  parseFn: (pattern: string, pos: number, isUnicode: boolean, ignoreCase: boolean, multiline: boolean, dotAll: boolean) => { next: number } | null,
): AnnexBFamily | "family6" | null {
  if (!usesAnnexBOnly(pattern, ignoreCase, multiline, dotAll, unicode, parseFn)) return null;
  if (ast !== null && hasQuantifiedLookahead(ast)) return "quantified-assertion";
  const brace = classifyBraceLeniency(pattern);
  if (brace !== null) return brace;
  const { totalCaptureCount, hasNamedCaptures } = scanCaptures(pattern);
  const legacyNum = classifyLegacyNumericEscape(pattern, totalCaptureCount);
  if (legacyNum !== null) return legacyNum;
  if (hasLenientControlEscape(pattern)) return "control-escape";
  if (hasClassRangeEscapeEndpoint(pattern)) return "class-range-escape";
  if (hasLenientNamedBackref(pattern, hasNamedCaptures)) return "named-backref-leniency";
  return "family6";
}

/** The combined classifier, precedence order stated explicitly: unicode-
 * casefold first (cheapest, flag-only, and modifier/annexb detection
 * would be meaningless or mis-scoped under /iu anyway), then modifiers
 * (exact, AST-based — only reachable when the pattern actually parsed),
 * then unported-unicode-property (also needs a successful parse... NO —
 * unicode property failures typically FAIL to parse; checked BEFORE
 * relying on `ast` being non-null), then Annex-B (classifyAnnexBFamily's
 * own gate already only fires on a pattern that DID parse under actual
 * flags). Returns null when none of these apply — the pattern is either
 * fully supported (including, since P5, family-6-outside-a-class), or
 * fails to parse for a reason none of these name — that residual case is
 * S065's own "invalid pattern" territory, not this classifier's. */
export function classifyRegexLitRefusal(
  pattern: string,
  ast: RegexAst | null,
  ignoreCase: boolean,
  multiline: boolean,
  dotAll: boolean,
  unicode: boolean,
  parseFn: (pattern: string, pos: number, isUnicode: boolean, ignoreCase: boolean, multiline: boolean, dotAll: boolean) => { next: number } | null,
): RegexLitRefusal | null {
  if (usesUnicodeCasefold(ignoreCase, unicode)) return "unicode-casefold";
  if (usesUnportedUnicodeProperty(pattern, unicode)) return "unported-unicode-property";
  if (ast !== null && usesModifierGroup(ast, ignoreCase, multiline, dotAll)) return "modifiers";
  const annexb = classifyAnnexBFamily(pattern, ast, ignoreCase, multiline, dotAll, unicode, parseFn);
  if (annexb !== null && annexb !== "family6") return `annexb-${annexb}`;
  return null;
}
