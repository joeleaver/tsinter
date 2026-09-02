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

export type RegexLitRefusal = "modifiers" | "annexb" | "unicode-casefold" | "unported-unicode-property";

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

/** The combined classifier, precedence order stated explicitly: unicode-
 * casefold first (cheapest, flag-only, and modifier/annexb detection
 * would be meaningless or mis-scoped under /iu anyway), then modifiers
 * (exact, AST-based — only reachable when the pattern actually parsed),
 * then unported-unicode-property (also needs a successful parse... NO —
 * unicode property failures typically FAIL to parse; checked BEFORE
 * relying on `ast` being non-null), then annexb (its own detector
 * already only fires on a pattern that DID parse under actual flags).
 * Returns null when none of the four apply (the pattern is either fully
 * supported, or fails to parse for a reason NONE of these four name —
 * that residual case is S065's own "invalid pattern" territory, not
 * this classifier's). */
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
  if (usesAnnexBOnly(pattern, ignoreCase, multiline, dotAll, unicode, parseFn)) return "annexb";
  return null;
}
