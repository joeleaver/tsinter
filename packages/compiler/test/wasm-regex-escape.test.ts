/* INC-24 P1, CP2a: parseEscape (regex-escape.ts), a transcription of
 * lre_parse_escape (libregexp.c:749-864). Checked against hand-derived
 * expectations from the C source AND, where the escape has a JS-string
 * equivalent, against how a real JS string literal decodes the same
 * escape (JSON.parse for \n\t etc., and Node's own `\u{...}`/surrogate
 * handling via String.fromCodePoint) — Node is the oracle wherever the
 * escape's target concept exists on the JS side too. */
import { describe, expect, test } from "vitest";
import { parseEscape } from "../src/backend/wasm/regex-escape.js";

describe("parseEscape: single-letter escapes", () => {
  test.each([
    ["b", 0x08],
    ["f", 0x0c],
    ["n", 0x0a],
    ["r", 0x0d],
    ["t", 0x09],
    ["v", 0x0b],
  ])("\\%s -> 0x%s", (letter, expected) => {
    const r = parseEscape(letter, 0, 2);
    expect(r).not.toBeNull();
    expect(r!.value).toBe(expected);
    expect(r!.next).toBe(1);
    // Cross-check against JS's own string-escape decoding for the same
    // letter (Node is the oracle: these six letters mean the same thing
    // in a JS string literal as in the regex escape grammar).
    // Deliberately decoding a JS string literal escape here to cross-check
    // against an independent source.
    expect(expected).toBe(eval(`"\\${letter}"`).charCodeAt(0));
  });
});

describe("parseEscape: \\xHH", () => {
  test("valid hex pair", () => {
    const r = parseEscape("x41", 0, 2);
    expect(r).toEqual({ value: 0x41, next: 3 });
  });
  test("malformed (non-hex digit) returns null", () => {
    expect(parseEscape("xzz", 0, 2)).toBeNull();
  });
});

describe("parseEscape: \\uHHHH", () => {
  test("valid 4-hex-digit escape", () => {
    const r = parseEscape("u0041", 0, 2);
    expect(r).toEqual({ value: 0x41, next: 5 });
  });
  test("malformed returns null", () => {
    expect(parseEscape("u00zz", 0, 2)).toBeNull();
  });
  test("a lone high surrogate (allowUtf16=1, no combination) stays a surrogate value", () => {
    // \uD83D alone, allowUtf16=1: no pair-combination attempted.
    const r = parseEscape("uD83D", 0, 1);
    expect(r).toEqual({ value: 0xd83d, next: 5 });
  });
  test("high+low surrogate pair combines under allowUtf16=2 (unicode mode)", () => {
    // U+1F600 GRINNING FACE = surrogate pair D83D DE00.
    const r = parseEscape("uD83D\\uDE00", 0, 2);
    expect(r).toEqual({ value: 0x1f600, next: 11 });
    // Cross-check: this is exactly what JS's own \u{...} / surrogate
    // combination produces for the same code point.
    expect(String.fromCodePoint(r!.value)).toBe("😀");
  });
  test("high+low surrogate pair does NOT combine under allowUtf16=1", () => {
    const r = parseEscape("uD83D\\uDE00", 0, 1);
    expect(r).toEqual({ value: 0xd83d, next: 5 }); // stops after the first \uHHHH only
  });
  test("\\u{...} (allowUtf16 truthy) parses an arbitrary-width hex code point", () => {
    const r = parseEscape("u{1F600}", 0, 2);
    expect(r).toEqual({ value: 0x1f600, next: 8 });
  });
  test("\\u{...} exceeding 0x10FFFF returns null", () => {
    expect(parseEscape("u{110000}", 0, 2)).toBeNull();
  });
  test("\\u{...} is NOT recognized when allowUtf16=0 (falls through to the 4-hex-digit path and fails on '{')", () => {
    expect(parseEscape("u{41}", 0, 0)).toBeNull();
  });
});

describe("parseEscape: legacy octal (non-unicode mode, allowUtf16 !== 2)", () => {
  test("\\0 alone", () => {
    expect(parseEscape("0", 0, 1)).toEqual({ value: 0, next: 1 });
  });
  test("\\7 alone (single octal digit, no continuation since 7 doesn't extend under 32)", () => {
    // c=7 after first digit; c<32 so it tries a second digit — 'x' isn't
    // octal so `break`s with just the one digit consumed.
    expect(parseEscape("7x", 0, 1)).toEqual({ value: 7, next: 1 });
  });
  test("\\12 (two octal digits, 1*8+2=10)", () => {
    expect(parseEscape("12", 0, 1)).toEqual({ value: 10, next: 2 });
  });
  test("\\123 (three octal digits: (1*8+2)*8+3 = 83, matches legacy octal semantics)", () => {
    expect(parseEscape("123", 0, 1)).toEqual({ value: 83, next: 3 });
  });
  test("stops at 2 digits once the value would reach/exceed 32 (c>=32 break)", () => {
    // \47 = 4*8+7 = 39, already >=32, so a third digit is NOT consumed
    // even if present.
    expect(parseEscape("478", 0, 1)).toEqual({ value: 39, next: 2 });
  });
});

describe("parseEscape: \\0 in unicode mode (allowUtf16=2) rejects a following digit", () => {
  test("\\0 alone is fine", () => {
    expect(parseEscape("0", 0, 2)).toEqual({ value: 0, next: 1 });
  });
  test("\\01 is INVALID under unicode mode (Annex B legacy octal is non-unicode-only)", () => {
    expect(parseEscape("01", 0, 2)).toBeNull();
  });
  test("\\1 (nonzero single digit) is invalid under unicode mode", () => {
    expect(parseEscape("1", 0, 2)).toBeNull();
  });
});

test("parseEscape: an unrecognized letter returns null (collapses lre_parse_escape's -1/-2 distinction, matching both real call sites which only ever check the sign)", () => {
  expect(parseEscape("g", 0, 2)).toBeNull();
  expect(parseEscape("a", 0, 2)).toBeNull();
});

test("parseEscape: `pos` offsets into a longer string correctly (the real call shape — pos points just after the backslash)", () => {
  const pattern = "\\d\\n\\x41"; // runtime string: \ d \ n \ x 4 1  (indices 0-7)
  // 'n' sits at index 3 (just after the second backslash, at index 2).
  const r = parseEscape(pattern, 3, 2);
  expect(r).toEqual({ value: 0x0a, next: 4 });
});
