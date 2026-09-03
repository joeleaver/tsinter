/* Two small §5.5(B)/§5.6 helpers for regex.new's construction path
 * (emitter.ts's own "regex.new" libCall case). Neither touches the main
 * recursive-descent parser (regex-parser.ts) — both are independent,
 * narrowly-scoped, purpose-built passes over the raw pattern text, kept
 * separate from the shared parser deliberately so this new work carries
 * zero risk to the already-verified regexLit path.
 *
 * classifyRegexSyntaxErrorReason: when the shared parser's own
 * parsePattern() already returns null (a genuine syntax error — the SAME
 * failure regexLit's own case already detects and refuses by name), P5
 * additionally needs to know WHICH of V8's named reasons applies, since
 * §5.5(B) requires an ACTUAL SyntaxError with V8's exact message text at
 * the new RegExp(...) call, not just a refusal. Rather than thread a
 * reason value through the parser's own 46 `return null` sites (real
 * scope, no claim needs it, and the design's own §5.5 explicitly treats
 * the full 9-entry table as "the sweep" beyond 2284's own two), this
 * classifies only the reasons that are STRUCTURALLY DECIDABLE from a
 * single balanced-bracket scan: "Unterminated group", "Unmatched ')'",
 * "Unterminated character class". These three were chosen because they
 * are the ONLY reasons a plain paren/bracket scan can determine with
 * CERTAINTY (no semantic analysis needed) — anything else (a bad
 * quantifier range, a duplicate capture name, an unknown \p{} property,
 * a dangling \k<> reference) returns null here, and the caller refuses
 * BY NAME rather than guess at a message this function isn't sure of.
 *
 * Verified against live Node for every case below plus the interaction
 * cases (an unclosed '[' swallowing a later ')' or '(' rather than
 * either being reported; the FIRST unmatched ')' at scan depth 0
 * reported immediately, even with an unrelated unterminated '(' later
 * in the same pattern; an escaped '\)' inside a still-open group not
 * closing it):
 *   "("        -> "Unterminated group"
 *   "a)"       -> "Unmatched ')'"
 *   "(a(b)"    -> "Unterminated group"
 *   "(a))"     -> "Unmatched ')'"
 *   ")("       -> "Unmatched ')'"      (reported at the FIRST ')', left-to-right)
 *   "(a\\)b"   -> "Unterminated group" (the \) is a literal, group still open)
 *   "[("       -> "Unterminated character class" (unterminated class wins:
 *                  the '(' inside it is never seen as a group at all)
 *   "(a[b"     -> "Unterminated character class"
 *   "a)["      -> "Unmatched ')'"      (the ')' fires before the scan ever
 *                  reaches the unterminated '[')
 * "[)]" and "()" and "\\(" all parse clean (a ')' inside a class, or a
 * balanced group, or an escaped '(' outside any group, are never
 * misreported). */
export function classifyRegexSyntaxErrorReason(pattern: string): string | null {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i++; // skip the escaped character, in or out of a class alike
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      if (depth === 0) return "Unmatched ')'";
      depth--;
    }
  }
  if (inClass) return "Unterminated character class";
  if (depth > 0) return "Unterminated group";
  return null;
}

// U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR, by code point rather
// than as raw string literals in source — an earlier draft of this file
// embedded the actual invisible characters inline as `case " ":` labels,
// which is fragile (indistinguishable from a plain space at a glance, and
// a hazard for any tool or terminal that doesn't round-trip them exactly).
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** EscapeRegExpPattern (ECMA-262 22.2.3.2.4) — the `.source` text stored
 * for a new RegExp(str)-constructed value specifically (design §5.6).
 * Purely a STORAGE-time normalisation of what `.source` reads back:
 * matching itself always runs over the pattern's own ORIGINAL,
 * unmodified text (this function is never called before parsePattern —
 * only on the way into the %w.re.Regex struct's `source` field). A
 * regex LITERAL's own `.source` needs no normaliser at all (design
 * §5.6's own MEASURED finding: the literal grammar already forbids both
 * spellings this function exists to fix — a raw '/' or a raw
 * LineTerminator inside `/.../ ` is itself a syntax error at the
 * JS-source level, never reaches this function).
 *
 * Verified byte-exact against live Node:
 *   ""      -> "(?:)"     "/"    -> "\\/"      "a/b"  -> "a\\/b"
 *   "\n"    -> "\\n"      "\r"   -> "\\r"
 *   U+2028 -> "\\u2028"   U+2029 -> "\\u2029"
 *   "a\nb/c\rd" -> "a\\nb\\/c\\rd"   (each occurrence escaped independently)
 * Code-UNIT walk, not code-point: every character this function treats
 * specially (/, LF, CR, LS, PS) is a single UTF-16 code unit, so there is
 * no astral case to get wrong either way; a plain index walk is simplest
 * and matches pushStrLitInto's own code-unit-oriented storage model. */
export function escapeRegExpPattern(pattern: string): string {
  if (pattern === "") return "(?:)";
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    switch (ch) {
      case "/":
        out += "\\/";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case LINE_SEPARATOR:
        out += "\\u2028";
        break;
      case PARAGRAPH_SEPARATOR:
        out += "\\u2029";
        break;
      default:
        out += ch;
    }
  }
  return out;
}
