/* INC-24 P1, CP2a-close: parseCharClass (regex-charclass.ts), a
 * CharRange-only transcription of re_parse_nested_class (libregexp.c:1392).
 * Verified two ways: hand-derived structural cases (ranges, negation, the
 * Annex-B dash-adjacent-to-a-class-escape edge cases §5.1 names), and
 * direct membership sweeps against Node's own regex engine wherever a
 * class has a real ECMAScript equivalent to compare against. */
import { describe, expect, test } from "vitest";
import { parseCharClass, type CharRange } from "../src/backend/wasm/regex-charclass.js";

function crContains(cr: CharRange, cp: number): boolean {
  let lo = 0;
  let hi = cr.length;
  while (lo < hi) {
    const midPair = (((lo + hi) >> 1) >> 1) << 1;
    const s = cr[midPair]!;
    const e = cr[midPair + 1]!;
    if (cp < s) hi = midPair;
    else if (cp >= e) lo = midPair + 2;
    else return true;
  }
  return false;
}

describe("parseCharClass: basic membership against Node, exhaustive over the BMP", () => {
  test.each([
    ["[abc]", /[abc]/],
    ["[a-z]", /[a-z]/],
    ["[^a-z]", /[^a-z]/],
    ["[a-z0-9_]", /[a-z0-9_]/],
    ["[\\d\\s]", /[\d\s]/],
    ["[^\\d]", /[^\d]/],
    ["[\\]]", /[\]]/], // an escaped ] as the class's only member
    ["[-a]", /[-a]/], // a leading literal '-' (no range formed: nothing before it)
    ["[a-]", /[a-]/], // a trailing literal '-' (p[1]===']' skips the range attempt)
  ] as const)("%s matches Node's own regex for every BMP code point", (src, nodeRe) => {
    const r = parseCharClass(src, 0, false);
    expect(r, src).not.toBeNull();
    expect(r!.next, `${src}: cursor should land at string end`).toBe(src.length);
    for (let cp = 0; cp <= 0xffff; cp++) {
      const expected = nodeRe.test(String.fromCharCode(cp));
      const actual = crContains(r!.cr, cp);
      if (actual !== expected) {
        expect.fail(`${src} at U+${cp.toString(16).padStart(4, "0")}: expected ${expected}, got ${actual}`);
      }
    }
  });
});

describe("parseCharClass: \\p{L} inside a class, under /u", () => {
  test("[\\p{L}\\d] matches Node's /[\\p{L}\\d]/u over a sample", () => {
    const r = parseCharClass("[\\p{L}\\d]", 0, true);
    expect(r).not.toBeNull();
    const nodeRe = /[\p{L}\d]/u;
    // Full-BMP sweep (astral \p{L} membership is already pinned exhaustively
    // in wasm-regex-charclass.test.ts; this test's job is the CLASS PARSER's
    // union logic, not re-proving \p{L}'s own data).
    for (let cp = 0; cp <= 0xffff; cp++) {
      const expected = nodeRe.test(String.fromCodePoint(cp));
      const actual = crContains(r!.cr, cp);
      if (actual !== expected) {
        expect.fail(`U+${cp.toString(16)}: expected ${expected}, got ${actual}`);
      }
    }
  });
});

describe("parseCharClass: Annex-B dash-adjacent-to-class-escape (design §5.1's [a-\\d]/[\\w-a] rows)", () => {
  test("[a-\\d] without /u: THREE atoms (a, literal '-', \\d) — Annex B fallback", () => {
    const r = parseCharClass("[a-\\d]", 0, false);
    expect(r).not.toBeNull();
    expect(crContains(r!.cr, "a".codePointAt(0)!)).toBe(true);
    expect(crContains(r!.cr, "-".codePointAt(0)!)).toBe(true);
    expect(crContains(r!.cr, "5".codePointAt(0)!)).toBe(true); // \d member
    expect(crContains(r!.cr, "b".codePointAt(0)!)).toBe(false);
    // Cross-check against Node directly — non-unicode mode accepts this
    // Annex-B construct exactly as libregexp does.
    const nodeRe = /[a-\d]/;
    for (const ch of ["a", "-", "5", "b", "z"]) {
      expect(crContains(r!.cr, ch.codePointAt(0)!), ch).toBe(nodeRe.test(ch));
    }
  });
  test("[a-\\d] WITH /u is invalid (parseCharClass returns null)", () => {
    expect(parseCharClass("[a-\\d]", 0, true)).toBeNull();
  });
  test("[\\w-a] without /u: THREE atoms (\\w, literal '-', a)", () => {
    const r = parseCharClass("[\\w-a]", 0, false);
    expect(r).not.toBeNull();
    const nodeRe = /[\w-a]/;
    for (const ch of ["-", "a", "_", "5", "!"]) {
      expect(crContains(r!.cr, ch.codePointAt(0)!), ch).toBe(nodeRe.test(ch));
    }
  });
  test("[\\w-a] WITH /u is invalid", () => {
    expect(parseCharClass("[\\w-a]", 0, true)).toBeNull();
  });
});

describe("parseCharClass: reversed-order range is invalid", () => {
  test("[z-a] returns null", () => {
    expect(parseCharClass("[z-a]", 0, false)).toBeNull();
    expect(parseCharClass("[z-a]", 0, true)).toBeNull();
  });
});

describe("parseCharClass: cursor position and unterminated classes", () => {
  test("cursor lands one past the closing ']', not at it", () => {
    const r = parseCharClass("[abc]rest", 0, false);
    expect(r!.next).toBe(5); // "[abc]".length
  });
  test("an unterminated class returns null", () => {
    expect(parseCharClass("[abc", 0, false)).toBeNull();
  });
  test("an empty class [] is legal (matches nothing)", () => {
    const r = parseCharClass("[]", 0, false);
    expect(r).not.toBeNull();
    expect(r!.cr).toEqual([]);
    expect(r!.next).toBe(2);
  });
  test("an empty negated class [^] matches everything (Node cross-check on a sample)", () => {
    const r = parseCharClass("[^]", 0, false);
    expect(r).not.toBeNull();
    const nodeRe = /[^]/;
    for (const cp of [0, 1, 0x41, 0x61, 0xff, 0xffff]) {
      expect(crContains(r!.cr, cp)).toBe(nodeRe.test(String.fromCharCode(cp)));
    }
  });
});
