/* INC-24 P2: the four regexLit-side refusal-key detectors, pinned
 * standalone before wiring into emission — each detector needs BOTH a
 * true-positive (the construct it names) and a true-negative (an
 * ordinary supported pattern it must NOT misfire on), per this
 * project's "a pin should be able to catch the bug it guards against"
 * standard. */
import { describe, expect, test } from "vitest";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import {
  classifyRegexLitRefusal,
  usesAnnexBOnly,
  usesModifierGroup,
  usesUnicodeCasefold,
  usesUnportedUnicodeProperty,
} from "../src/backend/wasm/regex-disposition.js";

function parseOrThrow(pattern: string, ignoreCase = false, multiline = false, dotAll = false, unicode = false) {
  const r = parsePattern(pattern, 0, unicode, ignoreCase, multiline, dotAll);
  if (r === null || r.next !== pattern.length) throw new Error(`parse failed for /${pattern}/`);
  return r.ast;
}

describe("usesUnicodeCasefold", () => {
  test("true: i+u together", () => expect(usesUnicodeCasefold(true, true)).toBe(true));
  test("false: i alone", () => expect(usesUnicodeCasefold(true, false)).toBe(false));
  test("false: u alone", () => expect(usesUnicodeCasefold(false, true)).toBe(false));
});

describe("usesModifierGroup", () => {
  test("true: (?i:a) under non-ignoreCase top level", () => {
    const ast = parseOrThrow("(?i:a)", false, false, false, false);
    expect(usesModifierGroup(ast, false, false, false)).toBe(true);
  });
  test("true: (?-i:a) under ignoreCase top level (scope turns it OFF)", () => {
    const ast = parseOrThrow("(?-i:a)", true, false, false, false);
    expect(usesModifierGroup(ast, true, false, false)).toBe(true);
  });
  test("true: (?i-m:a) nested inside a group", () => {
    const ast = parseOrThrow("(x(?i-m:a))", false, true, false, false);
    expect(usesModifierGroup(ast, false, true, false)).toBe(true);
  });
  test("false: a plain pattern with matching top-level ignoreCase", () => {
    const ast = parseOrThrow("abc", true, false, false, false);
    expect(usesModifierGroup(ast, true, false, false)).toBe(false);
  });
  test("false: a plain pattern with alternation, groups, quantifiers, classes — no modifier group anywhere", () => {
    const ast = parseOrThrow("(a|b)+[c-e]*\\d{2,3}", false, false, false, false);
    expect(usesModifierGroup(ast, false, false, false)).toBe(false);
  });
  test("false: (?:a) non-capturing group is NOT a modifier group", () => {
    const ast = parseOrThrow("(?:a)", false, false, false, false);
    expect(usesModifierGroup(ast, false, false, false)).toBe(false);
  });
});

describe("usesAnnexBOnly", () => {
  test("true: a{,2} as literal text (Annex-B-only quantifier-shaped literal)", () => {
    expect(usesAnnexBOnly("a{,2}", false, false, false, false, parsePattern)).toBe(true);
  });
  test("true: lone unescaped ]", () => {
    expect(usesAnnexBOnly("a]b", false, false, false, false, parsePattern)).toBe(true);
  });
  test("false: an ordinary supported pattern", () => {
    expect(usesAnnexBOnly("^[a-f]+$", false, false, false, false, parsePattern)).toBe(false);
  });
  test("false: already-/u pattern (Annex-B doesn't apply, short-circuited)", () => {
    expect(usesAnnexBOnly("a{,2}", false, false, false, true, parsePattern)).toBe(false);
  });
  test("false: a pattern that fails to parse under BOTH modes (genuine syntax error, not this detector's)", () => {
    expect(usesAnnexBOnly("(", false, false, false, false, parsePattern)).toBe(false);
  });
});

describe("usesUnportedUnicodeProperty", () => {
  test("true: \\p{Script=Greek} under /u", () => {
    expect(usesUnportedUnicodeProperty("\\p{Script=Greek}", true)).toBe(true);
  });
  test("true: \\P{Alphabetic} under /u (negated form, same subspace)", () => {
    expect(usesUnportedUnicodeProperty("\\P{Alphabetic}", true)).toBe(true);
  });
  test("false: \\p{L} under /u (General_Category, supported)", () => {
    expect(usesUnportedUnicodeProperty("\\p{L}", true)).toBe(false);
  });
  test("false: \\p{Script=Greek} WITHOUT /u (Annex-B literal-p, different disposition entirely)", () => {
    expect(usesUnportedUnicodeProperty("\\p{Script=Greek}", false)).toBe(false);
  });
  test("false: an ordinary pattern with no property escape at all", () => {
    expect(usesUnportedUnicodeProperty("^[a-f]+$", true)).toBe(false);
  });
});

describe("classifyRegexLitRefusal, the combined dispatcher", () => {
  test("unicode-casefold wins even when the pattern text also LOOKS like it could be something else", () => {
    expect(classifyRegexLitRefusal("(?i:a)", null, true, false, false, true, parsePattern)).toBe("unicode-casefold");
  });
  test("modifiers, standalone", () => {
    const ast = parseOrThrow("(?i:a)", false, false, false, false);
    expect(classifyRegexLitRefusal("(?i:a)", ast, false, false, false, false, parsePattern)).toBe("modifiers");
  });
  test("annexb, standalone", () => {
    expect(classifyRegexLitRefusal("a{,2}", null, false, false, false, false, parsePattern)).toBe("annexb");
  });
  test("unported-unicode-property, standalone", () => {
    expect(classifyRegexLitRefusal("\\p{Script=Greek}", null, false, false, false, true, parsePattern)).toBe("unported-unicode-property");
  });
  test("null: every one of the 4 CLAIM patterns' own representative shapes classify clean", () => {
    for (const [pattern, flags] of [
      ["ab+c", ""],
      ["hello", "i"],
      ["^b", "m"],
      ["a.b", "s"],
      ["\\p{L}", "u"],
      ["^.$", "u"],
      ["^[a-f]+$", ""],
      ["cat|dog", ""],
      ["\\d{3}-\\d{4}", ""],
      ["t(a)g", "gim"],
      ["\\d+", "u"],
      ["z$", ""],
      ["[aeiou]", ""],
      ["^[A-Z][a-z]+$", ""],
      ["^\\d+$", ""],
      ["\\s", ""],
      ["\\n", ""],
      ["\\r\\n", ""],
      ["^dif", ""],
      ["xyz", ""],
    ] as const) {
      const ignoreCase = flags.includes("i");
      const multiline = flags.includes("m");
      const dotAll = flags.includes("s");
      const unicode = flags.includes("u");
      const parsed = parsePattern(pattern, 0, unicode, ignoreCase, multiline, dotAll);
      const ast = parsed !== null && parsed.next === pattern.length ? parsed.ast : null;
      const got = classifyRegexLitRefusal(pattern, ast, ignoreCase, multiline, dotAll, unicode, parsePattern);
      expect(got, `/${pattern}/${flags}`).toBeNull();
    }
  });
});
