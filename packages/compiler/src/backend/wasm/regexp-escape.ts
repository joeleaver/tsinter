/* RegExp.escape (ES2025) — EncodeForRegExpEscape, transcribed from the
 * vendored C reference (packages/runtime/src/scr_regex.c:1001-1104,
 * scr_regexp_escape and its three classifier helpers) rather than
 * re-derived from spec text, matching this project's own established
 * precedent (P1-P4 transcribed GetSubstitution/Symbol.replace the same
 * way). Per-CODE-POINT, not per-UTF-16-code-unit — verified against live
 * Node with an astral input (`RegExp.escape("ü\u{1D306}é café")` passes
 * U+1D306 through unchanged, never splitting its surrogate pair) — JS's
 * own `for...of` over a string already iterates by code point, so this
 * TS-level implementation gets that for free; the WASM-level runtime
 * port (emitter.ts's own regexp.escape libCall case) must use getChar()
 * or an equivalent code-point walk, never a naive UTF-16 loop, for the
 * same reason.
 *
 * NAMED "regexp-escape.ts", not "regex-escape.ts" — that name is ALREADY
 * TAKEN by P1's own lre_parse_escape port (a pattern-escape-sequence
 * parser, \n \t \xHH \uHHHH inside a regex literal — a completely
 * different algorithm serving get_class_atom/regex-charclass.ts). A
 * first attempt at this file used the taken name and silently overwrote
 * it; caught immediately by the next build's own two import errors
 * (regex-charclass.ts and regex-parser.ts both import parseEscape from
 * it), recovered via `git checkout` before anything else touched it.
 * Named distinctly here so the collision cannot repeat.
 *
 * TWO CALL SITES, ONE ALGORITHM (§7.6's own "not a second algorithm"
 * requirement): this pure function is called (a) at COMPILE TIME by the
 * constant-folder (emitter.ts's own foldRegexArg) when folding
 * `regexp.escape(<folded string>)` as a regex.new pattern/flags
 * argument, and (b) is the REFERENCE the WASM runtime case for the
 * general `regexp.escape` libCall (any string, not just a folded one —
 * 2367's own `dyn` proves this general case is required) must match
 * byte-for-byte; that runtime case reimplements this same
 * classification in wasm instructions rather than calling back into TS,
 * but the classification rules here are the single source of truth both
 * sides agree with. */

const SYNTAX_CHARS = new Set<number>(
  ["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"].map((c) => c.codePointAt(0)!),
);

/** TAB/LF/VT/FF/CR escape as \t \n \v \f \r — the spec's own ControlEscape
 * arm, checked before the generic hex-escape set. Returns the escape
 * letter, or null when `cp` isn't one of the five. */
function controlEscapeLetter(cp: number): string | null {
  switch (cp) {
    case 0x09:
      return "t";
    case 0x0a:
      return "n";
    case 0x0b:
      return "v";
    case 0x0c:
      return "f";
    case 0x0d:
      return "r";
    default:
      return null;
  }
}

const OTHER_PUNCTUATORS = new Set<number>(
  [",", "-", "=", "<", ">", "#", "&", "!", "%", ":", ";", "@", "~", "'", "`", '"'].map((c) => c.codePointAt(0)!),
);

/** WhiteSpace ∪ LineTerminator, less the ControlEscape five, PLUS the
 * "other punctuators" — the spec's own combined hex-escape set (every
 * member of this set hex-escapes: \xNN below U+0100, \uNNNN at or
 * above). */
function isHexEscaped(cp: number): boolean {
  if (OTHER_PUNCTUATORS.has(cp)) return true;
  switch (cp) {
    case 0x20:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
    case 0xfeff:
      return true;
    default:
      return cp >= 0x2000 && cp <= 0x200a;
  }
}

function isAsciiAlphanumeric(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

/** EncodeForRegExpEscape over one code point. `first` is true only for
 * the STRING's own first code point (a leading ASCII letter/digit
 * hex-escapes there SPECIFICALLY so a concatenation with a preceding
 * fragment can never extend a token — e.g. `x` + RegExp.escape("1")`
 * must not read as the identifier `x1`). */
function encodeOne(cp: number, first: boolean): string {
  if (first && isAsciiAlphanumeric(cp)) return "\\x" + hex(cp, 2);
  if (SYNTAX_CHARS.has(cp)) return "\\" + String.fromCodePoint(cp);
  const ctl = controlEscapeLetter(cp);
  if (ctl !== null) return "\\" + ctl;
  if (isHexEscaped(cp)) return cp < 0x100 ? "\\x" + hex(cp, 2) : "\\u" + hex(cp, 4);
  return String.fromCodePoint(cp);
}

/** RegExp.escape(s) — the full string, TS-level (compile-time folding and
 * the wasm runtime case's own reference). `for...of` walks by code point;
 * `first` is keyed to the STRING's own first code point, not the first
 * UTF-16 code unit (matters only for the vanishing case of an astral
 * first character that happens to also be ASCII-alphanumeric, which is
 * impossible — ASCII is never astral — so this distinction has no actual
 * witness, named here only so a future reader does not "fix" it). */
export function escapeRegExpText(s: string): string {
  let out = "";
  let first = true;
  for (const ch of s) {
    out += encodeOne(ch.codePointAt(0)!, first);
    first = false;
  }
  return out;
}
