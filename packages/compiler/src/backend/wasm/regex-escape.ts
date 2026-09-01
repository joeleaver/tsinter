/* INC-24 P1: lre_parse_escape (libregexp.c:749-864), transcribed 1:1. The
 * general escape-sequence parser — \n \t \xHH \uHHHH \u{...} and legacy
 * octal — shared by get_class_atom (regex-charclass.ts) and, later, the
 * main term parser for escapes outside a character class.
 *
 * allowUtf16 mirrors the reference's tri-state exactly:
 *   0 — no UTF-16 escapes allowed (unused by this port's callers so far,
 *       kept for fidelity: the reference itself never actually calls with
 *       0 either — see libregexp.c's two call sites, both `s->is_unicode`
 *       or `s->is_unicode * 2`)
 *   1 — \u{...} recognized, \uHHHH surrogate pairs NOT combined
 *   2 — \u{...} recognized, a \uHHHH high surrogate immediately followed
 *       by \uHHHH low surrogate combines into one astral code point
 *       (unicode-mode regex: `s->is_unicode * 2`)
 *
 * Operates on UTF-16 CODE UNITS (design §5.4's named constraint) via a
 * plain `pattern: string, pos: number` cursor — no UTF-8/CESU-8 byte
 * decoding: the reference's `const uint8_t *p` walks a CESU-8 byte buffer
 * (scr_pattern_cesu8, §5.4) because C strings are bytes; a JS string is
 * already a UTF-16 code unit sequence, so indexing by code unit is the
 * direct equivalent with no decode step needed. */

export interface EscapeResult {
  /** The escape's resolved value: a code point (up to 0x10FFFF for a
   * combined surrogate pair or \u{...}, otherwise a single UTF-16 code
   * unit's value). */
  value: number;
  /** Index of the first code unit AFTER the escape. */
  next: number;
}

function fromHex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30; // '0'-'9'
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10; // 'a'-'f'
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10; // 'A'-'F'
  return -1;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isOctalDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x37;
}

const isHiSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLoSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const fromSurrogate = (hi: number, lo: number): number => 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);

/** lre_parse_escape. `pos` points just AFTER the '\'. Returns null for a
 * malformed escape (reference's `return -1`) — the reference's SEPARATE
 * `return -2` ("not an escape at all, try something else") is expressed
 * here as the caller's own dispatch never reaching this function for
 * those characters (get_class_atom's switch already routes \d\s\w\p etc.
 * elsewhere before falling through to `default_escape`), so this port
 * only needs the two-way null/value result, not a three-way one. */
export function parseEscape(pattern: string, pos: number, allowUtf16: 0 | 1 | 2): EscapeResult | null {
  let p = pos;
  const c0 = pattern.charCodeAt(p++);
  let c: number;
  switch (c0) {
    case 0x62: // 'b'
      c = 0x08;
      break;
    case 0x66: // 'f'
      c = 0x0c;
      break;
    case 0x6e: // 'n'
      c = 0x0a;
      break;
    case 0x72: // 'r'
      c = 0x0d;
      break;
    case 0x74: // 't'
      c = 0x09;
      break;
    case 0x76: // 'v'
      c = 0x0b;
      break;
    case 0x78: {
      // 'x'
      const h0 = fromHex(pattern.charCodeAt(p++));
      if (h0 < 0) return null;
      const h1 = fromHex(pattern.charCodeAt(p++));
      if (h1 < 0) return null;
      c = (h0 << 4) | h1;
      break;
    }
    case 0x75: {
      // 'u'
      if (pattern.charCodeAt(p) === 0x7b /* '{' */ && allowUtf16) {
        p++;
        c = 0;
        for (;;) {
          const h = fromHex(pattern.charCodeAt(p++));
          if (h < 0) return null;
          c = (c << 4) | h;
          if (c > 0x10ffff) return null;
          if (pattern.charCodeAt(p) === 0x7d /* '}' */) break;
        }
        p++;
      } else {
        c = 0;
        for (let i = 0; i < 4; i++) {
          const h = fromHex(pattern.charCodeAt(p++));
          if (h < 0) return null;
          c = (c << 4) | h;
        }
        if (isHiSurrogate(c) && allowUtf16 === 2 && pattern.charCodeAt(p) === 0x5c && pattern.charCodeAt(p + 1) === 0x75) {
          // convert an escaped surrogate pair into a unicode char
          let c1 = 0;
          let i = 0;
          for (; i < 4; i++) {
            const h = fromHex(pattern.charCodeAt(p + 2 + i));
            if (h < 0) break;
            c1 = (c1 << 4) | h;
          }
          if (i === 4 && isLoSurrogate(c1)) {
            p += 6;
            c = fromSurrogate(c, c1);
          }
        }
      }
      break;
    }
    case 0x30: // '0'-'7'
    case 0x31:
    case 0x32:
    case 0x33:
    case 0x34:
    case 0x35:
    case 0x36:
    case 0x37: {
      c = c0 - 0x30;
      if (allowUtf16 === 2) {
        // only accept \0 not followed by a digit
        if (c !== 0 || isDigit(pattern.charCodeAt(p))) return null;
      } else {
        // legacy octal sequence, up to 3 digits total. The reference
        // relies on C's null-terminated-buffer + unsigned-wraparound
        // trick (`*p - '0'` at end-of-string wraps to a huge uint32_t,
        // which is > 7) to stop the loop at end-of-input; `charCodeAt`
        // past the string's end returns NaN instead, and `NaN > 7` is
        // FALSE in JS (found by this file's own tests: an unguarded port
        // ran off the end of a short pattern and desynced `c`/`p`) — so
        // this port checks octal-digit-ness EXPLICITLY (isOctalDigit)
        // rather than reproducing the wraparound, which achieves the
        // same stop condition without depending on an out-of-bounds read
        // behaving a particular way.
        if (!isOctalDigit(pattern.charCodeAt(p))) break;
        let v = pattern.charCodeAt(p) - 0x30;
        c = (c << 3) | v;
        p++;
        if (c >= 32) break;
        if (!isOctalDigit(pattern.charCodeAt(p))) break;
        v = pattern.charCodeAt(p) - 0x30;
        c = (c << 3) | v;
        p++;
      }
      break;
    }
    default:
      return null;
  }
  return { value: c, next: p };
}
