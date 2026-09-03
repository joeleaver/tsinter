/* INC-24 P2: the four regexLit-side refusal-key detectors, pinned
 * standalone before wiring into emission — each detector needs BOTH a
 * true-positive (the construct it names) and a true-negative (an
 * ordinary supported pattern it must NOT misfire on), per this
 * project's "a pin should be able to catch the bug it guards against"
 * standard. */
import { describe, expect, test } from "vitest";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import {
  classifyAnnexBFamily,
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
  test("annexb-brace-literal, standalone (INC-24 P5: the old blanket 'annexb' key split into nine families — this is family 3, des's own primary witness)", () => {
    expect(classifyRegexLitRefusal("a{,2}", null, false, false, false, false, parsePattern)).toBe("annexb-brace-literal");
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

/* INC-24 P5, design-regex-v6-errata-1.txt item 4: the nine-family Annex-B
 * split. classifyAnnexBFamily is the ELIMINATION classifier (see its own
 * doc in regex-disposition.ts) — family 6 outside a class is the residual
 * once all eight OTHER families are ruled out, never a positively-
 * enumerated character set. Every case below is MEASURED against live
 * Node first (this file's own established discipline — a detector pin
 * that isn't grounded in a real Node behavior isn't a pin, it's a guess
 * with a test wrapper). */
function annexBOnlyAst(pattern: string): ReturnType<typeof parsePattern> extends infer R ? (R extends { ast: infer A } ? A : never) : never {
  const parsed = parsePattern(pattern, 0, false, false, false, false);
  if (parsed === null || parsed.next !== pattern.length) throw new Error(`expected /${pattern}/ to parse under actual (non-unicode) flags`);
  return parsed.ast as never;
}

describe("classifyAnnexBFamily — the eight refused families, one true-positive witness each (MEASURED: each parses without /u, throws with /u)", () => {
  test("F1 quantified-assertion: (?=a)*", () => {
    expect(classifyAnnexBFamily("(?=a)*", annexBOnlyAst("(?=a)*"), false, false, false, false, parsePattern)).toBe("quantified-assertion");
  });
  test("F1 quantified-assertion: (?!a)+ (negated lookahead, still quantifiable)", () => {
    expect(classifyAnnexBFamily("(?!a)+", annexBOnlyAst("(?!a)+"), false, false, false, false, parsePattern)).toBe("quantified-assertion");
  });
  test("F1 does NOT fire on a quantified GROUP containing a lookahead (the lookahead itself isn't directly quantified)", () => {
    // (?=a) not itself quantified — the OUTER group is. Not Annex-B at all: strict.
    expect(classifyAnnexBFamily("(?:(?=a))+", annexBOnlyAst("(?:(?=a))+"), false, false, false, false, parsePattern)).toBeNull();
  });
  test("F2 extended-pattern-char: a lone unescaped ]", () => {
    expect(classifyAnnexBFamily("a]b", annexBOnlyAst("a]b"), false, false, false, false, parsePattern)).toBe("extended-pattern-char");
  });
  test("F2 extended-pattern-char: a lone unescaped } (des's own chosen boundary — } is F2, { is F3)", () => {
    expect(classifyAnnexBFamily("a}b", annexBOnlyAst("a}b"), false, false, false, false, parsePattern)).toBe("extended-pattern-char");
  });
  test("F3 brace-literal: a{,2} (des's own primary witness — no group-context dependency, no family-6 adjacency)", () => {
    expect(classifyAnnexBFamily("a{,2}", annexBOnlyAst("a{,2}"), false, false, false, false, parsePattern)).toBe("brace-literal");
  });
  test("F3 brace-literal: unterminated a{ and a{2", () => {
    expect(classifyAnnexBFamily("a{", annexBOnlyAst("a{"), false, false, false, false, parsePattern)).toBe("brace-literal");
    expect(classifyAnnexBFamily("a{2", annexBOnlyAst("a{2"), false, false, false, false, parsePattern)).toBe("brace-literal");
  });
  test("F4 legacy-octal: \\1 with NO group 1 anywhere", () => {
    expect(classifyAnnexBFamily("\\1", annexBOnlyAst("\\1"), false, false, false, false, parsePattern)).toBe("legacy-octal");
  });
  test("F4 legacy-octal: \\00 (\\0 followed by another digit)", () => {
    expect(classifyAnnexBFamily("\\00", annexBOnlyAst("\\00"), false, false, false, false, parsePattern)).toBe("legacy-octal");
  });
  test("F4 NON-LOCAL PIN: \\1 stays STRICT (not annexb at all) once group 1 actually exists — (a)\\1 matches Node's own \"aa\"", () => {
    expect(classifyAnnexBFamily("(a)\\1", annexBOnlyAst("(a)\\1"), false, false, false, false, parsePattern)).toBeNull();
  });
  test("F4 NON-LOCAL PIN: a NAMED group counts too — (?<n>a)\\1 stays strict (des's own measured false-refusal witness: a text '(' count would wrongly flag this)", () => {
    expect(classifyAnnexBFamily("(?<n>a)\\1", annexBOnlyAst("(?<n>a)\\1"), false, false, false, false, parsePattern)).toBeNull();
  });
  test("F4 NON-LOCAL PIN: only the SPECIFIC missing index is legacy — (?<a>x)(?<b>y)\\2 stays strict", () => {
    expect(classifyAnnexBFamily("(?<a>x)(?<b>y)\\2", annexBOnlyAst("(?<a>x)(?<b>y)\\2"), false, false, false, false, parsePattern)).toBeNull();
  });
  test("F5 nonoctal-decimal: \\8 with no groups at all", () => {
    expect(classifyAnnexBFamily("\\8", annexBOnlyAst("\\8"), false, false, false, false, parsePattern)).toBe("nonoctal-decimal");
  });
  test("F5 nonoctal-decimal: \\9 even with OTHER groups present, none at index 9 — (a)\\9", () => {
    expect(classifyAnnexBFamily("(a)\\9", annexBOnlyAst("(a)\\9"), false, false, false, false, parsePattern)).toBe("nonoctal-decimal");
  });
  test("F5 NON-LOCAL PIN: \\8 stays strict once 8 groups actually exist", () => {
    const pat = "(a)(b)(c)(d)(e)(f)(g)(h)\\8";
    expect(classifyAnnexBFamily(pat, annexBOnlyAst(pat), false, false, false, false, parsePattern)).toBeNull();
  });
  test("F7 control-escape: \\c1 (digit follows, not a real control letter)", () => {
    expect(classifyAnnexBFamily("\\c1", annexBOnlyAst("\\c1"), false, false, false, false, parsePattern)).toBe("control-escape");
  });
  test("F7 control-escape: bare \\c (end of pattern)", () => {
    expect(classifyAnnexBFamily("\\c", annexBOnlyAst("\\c"), false, false, false, false, parsePattern)).toBe("control-escape");
  });
  test("F7 control-escape, SAME predicate INSIDE a class — MEASURED position-independent (see regex-disposition.ts's own F7 doc): [\\c1] and [\\c_]", () => {
    expect(classifyAnnexBFamily("[\\c1]", annexBOnlyAst("[\\c1]"), false, false, false, false, parsePattern)).toBe("control-escape");
    expect(classifyAnnexBFamily("[\\c_]", annexBOnlyAst("[\\c_]"), false, false, false, false, parsePattern)).toBe("control-escape");
  });
  test("F7 does NOT fire on a real control letter, in or out of a class — \\cZ and [\\cZ] stay strict (not annexb at all)", () => {
    expect(classifyAnnexBFamily("\\cZ", annexBOnlyAst("\\cZ"), false, false, false, false, parsePattern)).toBeNull();
    expect(classifyAnnexBFamily("[\\cZ]", annexBOnlyAst("[\\cZ]"), false, false, false, false, parsePattern)).toBeNull();
  });
  test("F8 class-range-escape: [a-\\d] (class-escape as the RIGHT end of a range)", () => {
    expect(classifyAnnexBFamily("[a-\\d]", annexBOnlyAst("[a-\\d]"), false, false, false, false, parsePattern)).toBe("class-range-escape");
  });
  test("F8 class-range-escape: [\\d-z] (class-escape as the LEFT end)", () => {
    expect(classifyAnnexBFamily("[\\d-z]", annexBOnlyAst("[\\d-z]"), false, false, false, false, parsePattern)).toBe("class-range-escape");
  });
  test("F8 class-range-escape: [\\w-a] and [\\d-\\w] (both-ends form)", () => {
    expect(classifyAnnexBFamily("[\\w-a]", annexBOnlyAst("[\\w-a]"), false, false, false, false, parsePattern)).toBe("class-range-escape");
    expect(classifyAnnexBFamily("[\\d-\\w]", annexBOnlyAst("[\\d-\\w]"), false, false, false, false, parsePattern)).toBe("class-range-escape");
  });
  test("F8 does NOT fire on \\B in a class — \\B is not a CharacterClassEscape letter (d/D/s/S/w/W), so [\\B] never trips this detector", () => {
    expect(classifyAnnexBFamily("[\\B]", annexBOnlyAst("[\\B]"), false, false, false, false, parsePattern)).not.toBe("class-range-escape");
  });
  test("F9 named-backref-leniency: bare \\k with no named groups anywhere", () => {
    expect(classifyAnnexBFamily("\\k", annexBOnlyAst("\\k"), false, false, false, false, parsePattern)).toBe("named-backref-leniency");
  });
  test("F9 named-backref-leniency: \\k<a> with no named groups anywhere", () => {
    expect(classifyAnnexBFamily("\\k<a>", annexBOnlyAst("\\k<a>"), false, false, false, false, parsePattern)).toBe("named-backref-leniency");
  });
  test("F9 NON-LOCAL PIN: \\k<a> stays STRICT once its own named group exists — (?<a>x)\\k<a> matches Node's own backreference", () => {
    expect(classifyAnnexBFamily("(?<a>x)\\k<a>", annexBOnlyAst("(?<a>x)\\k<a>"), false, false, false, false, parsePattern)).toBeNull();
  });
});

describe("classifyAnnexBFamily — family 6 (lenient IdentityEscape outside a class): the RESIDUAL, verified across the FULL predicate, not a punctuation-only sample", () => {
  // des's own reconciliation (design-regex-v6-errata-1.txt item 4): family
  // 6 is nearly every SourceCharacter — punctuation, letters (except c x u
  // k p P and the strict class/control escapes), space, and ALL non-ASCII
  // including astral. A 16-character "safe set" would have LOUDLY FALSE-
  // REFUSED \q, \ (space), and \é — elimination avoids this by
  // construction (never positively enumerates a character set at all),
  // but the residual still needs to be SWEPT to prove it, not assumed.
  const punctuation = ["-", "_", "%", "<", "@", "'", "!", ",", ";", "~"];
  const letters = ["q", "Q", "z", "Z", "m"]; // NOT c/x/u/k/p/P — those own other families/escapes
  const other = [" ", "é", "中", "\u{1F600}"]; // space, non-ASCII BMP, non-ASCII BMP, astral (surrogate pair)

  for (const ch of [...punctuation, ...letters, ...other]) {
    test(`\\${ch} outside a class resolves to family6 (residual — not any of the 8 refused families)`, () => {
      const pat = "\\" + ch;
      expect(classifyAnnexBFamily(pat, annexBOnlyAst(pat), false, false, false, false, parsePattern)).toBe("family6");
    });
  }
  // \- is family-6 OUTSIDE a class but STRICT inside one (errata item 1 —
  // '-' is a syntax-significant character INSIDE a class, so \- there is
  // already a plain strict escape, not Annex-B at all): excluded from the
  // shared in-class loop below and pinned on its own.
  test("\\- inside a class is STRICT, not annexb at all (the position-flip errata item 1 already covers — MEASURED, not assumed)", () => {
    expect(classifyAnnexBFamily("[\\-]", annexBOnlyAst("[\\-]"), false, false, false, false, parsePattern)).toBeNull();
  });
  for (const ch of [...punctuation.filter((c) => c !== "-"), ...letters, ...other]) {
    test(`\\${ch} INSIDE a class also resolves to family6 (the position errata items 1/2/this-family's-own-F7-note keep finding — checked here too, not assumed symmetric)`, () => {
      const pat = "[\\" + ch + "]";
      expect(classifyAnnexBFamily(pat, annexBOnlyAst(pat), false, false, false, false, parsePattern)).toBe("family6");
    });
  }
  test("\\B inside a class is family6 (team-lead's own named edge case) — matches literal 'B', not a class-range-escape, not any other family", () => {
    expect(classifyAnnexBFamily("[\\B]", annexBOnlyAst("[\\B]"), false, false, false, false, parsePattern)).toBe("family6");
  });
});

describe("classifyRegexLitRefusal — DO-NOT-REFUSE controls: strict forms that merely LOOK legacy, never annexb at all", () => {
  const cases: Array<[pattern: string, unicode: boolean]> = [
    ["\\0", false], // alone, no following digit — strict NUL
    ["\\/", false], // '/' is a SyntaxCharacter — strict identity escape
    ["\\cZ", false], // real control letter
    ["[a-z]", false],
    ["(a)\\1", false], // valid numbered backref
    ["[]", false], // empty class — some engines error, Node/this parser: matches nothing, never annexb
    ["[^]", false], // negated empty class — matches everything, never annexb
  ];
  for (const [pattern, unicode] of cases) {
    test(`/${pattern}/ never classifies as annexb-anything`, () => {
      const parsed = parsePattern(pattern, 0, unicode, false, false, false);
      const ast = parsed !== null && parsed.next === pattern.length ? parsed.ast : null;
      const got = classifyRegexLitRefusal(pattern, ast, false, false, false, unicode, parsePattern);
      expect(got).toBeNull();
    });
  }
});
