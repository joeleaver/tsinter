/* INC-24 P1, CP2a: getClassAtom (regex-charclass.ts), a transcription of
 * get_class_atom (libregexp.c:1056). Position-tracking is as much the
 * subject under test as the resolved value — a cursor bug here would be
 * invisible to a test that only checks "does this one escape resolve
 * right" and only surface once real multi-atom patterns are parsed, so
 * several tests below chain atoms through a longer string and check every
 * intermediate cursor position, not just the final one. */
import { describe, expect, test } from "vitest";
import { getClassAtom, unicodeGeneralCategory, type ClassAtomResult } from "../src/backend/wasm/regex-charclass.js";

function char(r: ClassAtomResult | null): { cp: number; next: number } {
  expect(r).not.toBeNull();
  expect(r!.kind).toBe("char");
  return { cp: (r as { kind: "char"; cp: number; next: number }).cp, next: r!.next };
}

describe("getClassAtom: plain literals", () => {
  test("an ordinary ASCII character", () => {
    expect(char(getClassAtom("a", 0, false, false))).toEqual({ cp: 0x61, next: 1 });
  });
  test("a BMP non-ASCII character (single UTF-16 code unit)", () => {
    expect(char(getClassAtom("é", 0, false, true))).toEqual({ cp: 0xe9, next: 1 });
  });
});

describe("getClassAtom: astral code points — §5.4's named constraint (the bug this port caught and fixed)", () => {
  const astral = "\u{1F600}"; // 😀, U+1F600, a surrogate pair in the underlying UTF-16 string
  test("under /u: the surrogate pair COMBINES into one astral code point", () => {
    expect(char(getClassAtom(astral, 0, false, true))).toEqual({ cp: 0x1f600, next: 2 });
  });
  test("WITHOUT /u: the surrogate pair does NOT combine — one code UNIT at a time", () => {
    const r = char(getClassAtom(astral, 0, false, false));
    expect(r).toEqual({ cp: 0xd83d, next: 1 }); // the lone high surrogate's own code unit
  });
  test("1204's own witness shape: parsing the SAME astral text under both modes side by side", () => {
    // design §5.4: 1204-regex-empty-unicode tests /<astral>/u and
    // /<astral>/ side by side and asserts they agree for a paired match
    // (i.e. matching astral-under-u against astral-under-non-u requires
    // the non-u parse to walk TWO atoms, each a lone surrogate, while the
    // u parse walks ONE atom, the combined code point).
    const uResult = getClassAtom(astral, 0, false, true)!;
    expect(uResult.next).toBe(2); // one astral atom, whole string consumed
    const nonU1 = getClassAtom(astral, 0, false, false)!;
    expect(nonU1.next).toBe(1); // first surrogate only
    const nonU2 = getClassAtom(astral, nonU1.next, false, false)!;
    expect(nonU2.next).toBe(2); // second surrogate, string now fully consumed
    expect(char(nonU1).cp).toBe(0xd83d);
    expect(char(nonU2).cp).toBe(0xde00);
  });
});

describe("getClassAtom: \\d\\D\\s\\S\\w\\W dispatch to classRangeDSW", () => {
  test.each(["d", "D", "s", "S", "w", "W"])("\\%s resolves to a range, cursor past the letter", (letter) => {
    const r = getClassAtom(`\\${letter}`, 0, true, false);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("range");
    expect(r!.next).toBe(2);
  });
});

describe("getClassAtom: \\p{...} / \\P{...}", () => {
  test("\\p{L} under /u resolves to the SAME range as unicodeGeneralCategory('L')", () => {
    const r = getClassAtom("\\p{L}", 0, true, true);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("range");
    expect(r!.next).toBe(5);
    expect((r as { kind: "range"; cr: unknown }).cr).toEqual(unicodeGeneralCategory("L"));
  });
  test("\\P{L} inverts", () => {
    const r = getClassAtom("\\P{L}", 0, true, true);
    expect(r).not.toBeNull();
    const inverted = (r as { kind: "range"; cr: readonly number[] }).cr;
    const plain = unicodeGeneralCategory("L")!;
    // crInvert(plain) should equal `inverted` — spot check via membership
    // at a known Letter code point ('A') and a known non-Letter ('1').
    expect(inverted.length).toBeGreaterThan(0);
    expect(inverted).not.toEqual(plain);
  });
  test("\\p WITHOUT /u is the Annex-B identity escape: literal 'p' (design §5.1, node/pnou.mjs's measured fact)", () => {
    // /\p{L}/.test("p{L}") is true, /\p{L}/.test("p") is false, .source
    // unchanged — i.e. \p becomes literal 'p', and '{L}' parses as three
    // MORE separate atoms afterward, not as part of a property escape.
    const r = getClassAtom("\\p{L}", 0, true, false);
    expect(char(r)).toEqual({ cp: 0x70, next: 2 }); // 'p', cursor right after it
  });
  test("an unresolvable property name returns null, not a wrong range", () => {
    expect(getClassAtom("\\p{Nope}", 0, true, true)).toBeNull();
  });
  test("Script= (out of scope) returns null", () => {
    expect(getClassAtom("\\p{Script=Greek}", 0, true, true)).toBeNull();
  });
});

describe("getClassAtom: \\cX control-letter escape", () => {
  test("a valid control letter (\\cA = U+0001)", () => {
    expect(char(getClassAtom("\\cA", 0, true, true))).toEqual({ cp: 1, next: 3 });
  });
  test("lowercase control letter (\\cz = U+001A)", () => {
    expect(char(getClassAtom("\\cz", 0, true, true))).toEqual({ cp: 0x1a, next: 3 });
  });
  test("Annex B: \\c9 inside a class, non-unicode — digit target legal", () => {
    // '9' & 0x1f = 0x39 & 0x1f = 0x19
    expect(char(getClassAtom("\\c9", 0, true, false))).toEqual({ cp: 0x39 & 0x1f, next: 3 });
  });
  test("\\c9 OUTSIDE a class, non-unicode: falls to the literal-backslash branch (Annex B gates digits to inclass only)", () => {
    const r = char(getClassAtom("\\c9", 0, false, false));
    expect(r).toEqual({ cp: 0x5c, next: 1 }); // literal '\', cursor at 'c'
  });
  test("\\c9 under /u is invalid (Annex B digit form is non-unicode only)", () => {
    expect(getClassAtom("\\c9", 0, true, true)).toBeNull();
  });
  test("\\c followed by a non-letter, non-unicode: literal backslash, cursor lands AT 'c' for re-parsing", () => {
    const r = char(getClassAtom("\\c!", 0, false, false));
    expect(r).toEqual({ cp: 0x5c, next: 1 });
    // Reparsing from `next` should yield the literal 'c'.
    expect(char(getClassAtom("\\c!", r.next, false, false))).toEqual({ cp: 0x63, next: 2 });
  });
});

describe("getClassAtom: \\- (design §5.1's in-class/out-of-class split)", () => {
  test("inside a class: always a literal '-', unicode or not", () => {
    expect(char(getClassAtom("\\-", 0, true, true))).toEqual({ cp: 0x2d, next: 2 });
    expect(char(getClassAtom("\\-", 0, true, false))).toEqual({ cp: 0x2d, next: 2 });
  });
  test("outside a class, non-unicode: literal '-' (Annex B)", () => {
    expect(char(getClassAtom("\\-", 0, false, false))).toEqual({ cp: 0x2d, next: 2 });
  });
  test("outside a class, unicode: invalid", () => {
    expect(getClassAtom("\\-", 0, false, true)).toBeNull();
  });
});

describe("getClassAtom: always-valid punctuation escapes", () => {
  test.each([..."^$\\.*+?(){}[]|/"])("\\%s -> literal", (ch) => {
    const r = char(getClassAtom(`\\${ch}`, 0, true, true));
    expect(r.cp).toBe(ch.codePointAt(0));
    expect(r.next).toBe(2);
  });
});

describe("getClassAtom: general escapes via parseEscape (default_escape)", () => {
  test("\\n resolves through parseEscape", () => {
    expect(char(getClassAtom("\\n", 0, true, true))).toEqual({ cp: 0x0a, next: 2 });
  });
  test("\\x41 resolves through parseEscape", () => {
    expect(char(getClassAtom("\\x41", 0, true, true))).toEqual({ cp: 0x41, next: 4 });
  });
  test("an unrecognized letter escape (\\g), non-unicode: 'ignore the backslash', literal 'g'", () => {
    expect(char(getClassAtom("\\g", 0, true, false))).toEqual({ cp: 0x67, next: 2 });
  });
  test("an unrecognized letter escape under /u is invalid", () => {
    expect(getClassAtom("\\g", 0, true, true)).toBeNull();
  });
});

describe("getClassAtom: end-of-input safety", () => {
  test("a lone backslash at end of pattern returns null, not a crash", () => {
    expect(getClassAtom("\\", 0, true, true)).toBeNull();
  });
  test("an incomplete \\x escape at end of pattern returns null", () => {
    expect(getClassAtom("\\x4", 0, true, true)).toBeNull();
  });
  test("empty pattern at pos 0 returns null", () => {
    expect(getClassAtom("", 0, true, true)).toBeNull();
  });
});

describe("getClassAtom: cursor continuity across a multi-atom sequence", () => {
  test("a run of mixed atoms chains position-to-position correctly", () => {
    // a \d \n \x41 é  — five atoms back to back.
    const pattern = "a\\d\\n\\x41é";
    let pos = 0;
    const results: { kind: string; next: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const r = getClassAtom(pattern, pos, true, true);
      expect(r, `atom ${i} at pos ${pos}`).not.toBeNull();
      results.push({ kind: r!.kind, next: r!.next });
      pos = r!.next;
    }
    expect(pos).toBe(pattern.length);
    expect(results.map((r) => r.kind)).toEqual(["char", "range", "char", "char", "char"]);
  });
});
