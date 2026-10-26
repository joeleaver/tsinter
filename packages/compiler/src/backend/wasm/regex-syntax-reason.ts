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

/** EscapeRegExpPattern (ECMA-262 22.2.3.2.4) — the `.source` text stored
 * for a new RegExp(str)-constructed value (design §5.6), as V8 writes it
 * (regexp.cc's WriteEscapedRegExpSource): an unescaped `/` OUTSIDE a
 * character class gets a backslash; a line terminator (LF, CR, U+2028,
 * U+2029) becomes its escape sequence; a backslash that already escapes a
 * line terminator is dropped (the terminator's own escape replaces the
 * pair); any other backslash copies itself and the character after it
 * unchanged (so an already-escaped `\/` stays one escape, and an escaped
 * `\]` does not end a class). The empty pattern is `(?:)`. Storage only:
 * matching runs over the original text.
 *
 * Verified byte-exact against Node v24.18.1 (the run-time compiler unit
 * replaced the earlier character-by-character version, which escaped a
 * `/` inside a class and doubled an existing escape — `new
 * RegExp("[/]").source` is "[/]" and `new RegExp("\\/").source` is
 * "\\/" in Node):
 *   ""  -> "(?:)"   "/" -> "\\/"   "a/b" -> "a\\/b"   "[/]" -> "[/]"
 *   "\\/" -> "\\/"   "\n" -> "\\n"   "a\\\nb" -> "a\\nb"
 *   U+2028 -> "\\u2028"   "[\\]/]" -> "[\\]/]"
 * Code-unit walk: every character treated specially is one code unit. */
export function escapeRegExpPattern(pattern: string): string {
  if (pattern === "") return "(?:)";
  const isLT = (c: number): boolean => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
  let out = "";
  let inClass = false;
  let s = 0;
  while (s < pattern.length) {
    const c = pattern.charCodeAt(s);
    if (c === 0x5c) {
      if (s + 1 < pattern.length && isLT(pattern.charCodeAt(s + 1))) {
        s++;
        continue;
      }
      out += pattern[s++];
      if (s === pattern.length) break;
      out += pattern[s++];
      continue;
    }
    if (c === 0x2f && !inClass) out += "\\";
    else if (c === 0x5b) inClass = true;
    else if (c === 0x5d) inClass = false;
    else if (c === 0x0a) {
      out += "\\n";
      s++;
      continue;
    } else if (c === 0x0d) {
      out += "\\r";
      s++;
      continue;
    } else if (c === 0x2028) {
      out += "\\u2028";
      s++;
      continue;
    } else if (c === 0x2029) {
      out += "\\u2029";
      s++;
      continue;
    }
    out += pattern[s++];
  }
  return out;
}
