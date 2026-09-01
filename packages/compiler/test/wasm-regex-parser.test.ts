/* INC-24 P1, CP2b: parsePattern (regex-parser.ts). Node cross-checks
 * wherever a construct is fully in CP2b's scope; structural checks (AST
 * shape) for the assembler-relevant decisions (flag-baking, quantifier
 * bounds) Node's accept/reject verdict alone can't distinguish. */
import { describe, expect, test } from "vitest";
import type { RegexAst } from "../src/backend/wasm/regex-ast.js";
import { parseCharClass } from "../src/backend/wasm/regex-charclass.js";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";

function parse(pattern: string, flags: { u?: boolean; i?: boolean; m?: boolean; s?: boolean } = {}) {
  return parsePattern(pattern, 0, !!flags.u, !!flags.i, !!flags.m, !!flags.s);
}

function fullyParsed(pattern: string, flags: Parameters<typeof parse>[1] = {}): RegexAst {
  const r = parse(pattern, flags);
  expect(r, pattern).not.toBeNull();
  expect(r!.next, `${pattern}: trailing unconsumed input`).toBe(pattern.length);
  return r!.ast;
}

describe("GO rider 1b — the modifier-group REACHING PIN", () => {
  test("(?i:a) and (?:a) produce DIFFERENT nested char codes — the flag change actually reached atom compilation", () => {
    const withMod = fullyParsed("(?i:a)");
    const without = fullyParsed("(?:a)");
    // Both parse as { kind: "group", body: { kind: "alternative", terms: [{kind:"char", cp}] } }
    const cpWith = extractSoleCharCp(withMod);
    const cpWithout = extractSoleCharCp(without);
    expect(cpWith).not.toBe(cpWithout);
    expect(cpWithout).toBe(0x61); // 'a', unmodified
    expect(cpWith).toBe(0x41); // 'A' — canonicalize('a') under the /i modifier
  });
  test("(?-i:a) inside an outer /i pattern REMOVES the flag — nested char stays uncanonicalized", () => {
    // Simulate "outer /i" by parsing with ignoreCase=true at the top and
    // confirming (?-i:...) suppresses it for its body.
    const r = parse("(?-i:a)", { i: true });
    expect(r).not.toBeNull();
    expect(extractSoleCharCp(r!.ast)).toBe(0x61); // NOT canonicalized
  });
  test("(?i-m:a) both adds and removes in one group — both real code points differ from an unmodified parse", () => {
    const modified = fullyParsed("(?i-m:a)");
    const plain = fullyParsed("(?:a)");
    expect(extractSoleCharCp(modified)).not.toBe(extractSoleCharCp(plain));
  });
  test("a bare modifier group with no i/m/s at all is invalid (\"invalid modifiers\")", () => {
    // (?-: is add=0, remove=0 -> invalid per libregexp.c:1937-1940. Using
    // a syntactically well-formed but semantically empty modifier list.
    expect(parse("(?-:a)")).toBeNull();
  });
  test("a duplicate modifier letter is invalid", () => {
    expect(parse("(?ii:a)")).toBeNull();
  });
  test("adding and removing the SAME letter is invalid", () => {
    expect(parse("(?i-i:a)")).toBeNull();
  });
  test("Node itself ACCEPTS all these modifier-group forms as syntax (cross-check, design §5.1's own measured fact)", () => {
    for (const src of ["(?i:a)", "(?-i:a)", "(?i-m:a)"]) {
      expect(() => new RegExp(src), src).not.toThrow();
    }
  });
});

/** Finds the single "char" node anywhere in the tree — shape-agnostic on
 * purpose: a modifier group is TRANSPARENT (no AST wrapper, by design —
 * see regex-parser.ts's parseModifierGroup), while an ordinary
 * non-capturing group IS a real node, so `(?i:a)` and `(?:a)` do not
 * share a fixed depth to the char. That asymmetry is itself part of what
 * this file is testing, not something to paper over with a fixed path. */
function extractSoleCharCp(ast: RegexAst): number {
  const found: number[] = [];
  function walk(n: RegexAst): void {
    switch (n.kind) {
      case "char":
        found.push(n.cp);
        return;
      case "disjunction":
        n.alternatives.forEach(walk);
        return;
      case "alternative":
        n.terms.forEach(walk);
        return;
      case "group":
      case "lookahead":
      case "quantifier":
        walk(n.body);
        return;
      default:
        return;
    }
  }
  walk(ast);
  expect(found.length, "expected exactly one char node").toBe(1);
  return found[0]!;
}

describe("literals, dot, anchors", () => {
  test("a plain literal", () => {
    const ast = fullyParsed("a");
    expect(ast).toEqual({
      kind: "disjunction",
      alternatives: [{ kind: "alternative", terms: [{ kind: "char", cp: 0x61, ignoreCase: false }] }],
    });
  });
  test("^ and $ bake in the multiline flag", () => {
    const nonM = fullyParsed("^$");
    const alt = (nonM as Extract<RegexAst, { kind: "disjunction" }>).alternatives[0]!;
    expect((alt as Extract<RegexAst, { kind: "alternative" }>).terms).toEqual([
      { kind: "lineStart", multiline: false },
      { kind: "lineEnd", multiline: false },
    ]);
    const m = fullyParsed("^$", { m: true });
    const altM = (m as Extract<RegexAst, { kind: "disjunction" }>).alternatives[0]!;
    expect((altM as Extract<RegexAst, { kind: "alternative" }>).terms).toEqual([
      { kind: "lineStart", multiline: true },
      { kind: "lineEnd", multiline: true },
    ]);
  });
  test(". bakes in dotAll", () => {
    const nonS = fullyParsed(".");
    expect(soleTermsOf(nonS)).toEqual([{ kind: "dot", dotAll: false }]);
    const s = fullyParsed(".", { s: true });
    expect(soleTermsOf(s)).toEqual([{ kind: "dot", dotAll: true }]);
  });
  test("bare *, +, ? with nothing to repeat is invalid", () => {
    expect(parse("*")).toBeNull();
    expect(parse("+")).toBeNull();
    expect(parse("?")).toBeNull();
  });
});

function soleTermsOf(ast: RegexAst): readonly RegexAst[] {
  const alt = (ast as Extract<RegexAst, { kind: "disjunction" }>).alternatives[0]!;
  return (alt as Extract<RegexAst, { kind: "alternative" }>).terms;
}

describe("quantifiers", () => {
  test("* + ? and their lazy forms", () => {
    expect(soleTermsOf(fullyParsed("a*"))[0]).toMatchObject({ kind: "quantifier", min: 0, max: Infinity, greedy: true });
    expect(soleTermsOf(fullyParsed("a*?"))[0]).toMatchObject({ kind: "quantifier", min: 0, max: Infinity, greedy: false });
    expect(soleTermsOf(fullyParsed("a+"))[0]).toMatchObject({ kind: "quantifier", min: 1, max: Infinity, greedy: true });
    expect(soleTermsOf(fullyParsed("a?"))[0]).toMatchObject({ kind: "quantifier", min: 0, max: 1, greedy: true });
  });
  test("{n} {n,} {n,m}", () => {
    expect(soleTermsOf(fullyParsed("a{3}"))[0]).toMatchObject({ kind: "quantifier", min: 3, max: 3 });
    expect(soleTermsOf(fullyParsed("a{3,}"))[0]).toMatchObject({ kind: "quantifier", min: 3, max: Infinity });
    expect(soleTermsOf(fullyParsed("a{3,7}"))[0]).toMatchObject({ kind: "quantifier", min: 3, max: 7 });
  });
  test("{7,3} (reversed) is invalid", () => {
    expect(parse("a{7,3}")).toBeNull();
    expect(parse("a{7,3}", { u: true })).toBeNull();
  });
  test("Annex B: a { not shaped like a quantifier is a normal atom, non-unicode only", () => {
    const ast = fullyParsed("a{,2}"); // no leading digit right after '{' before ','
    // 'a' then '{' as separate literal chars, then ',','2','}' as more literals
    expect(soleTermsOf(ast).map((t) => t.kind)).toEqual(["char", "char", "char", "char", "char"]);
  });
  test("a{,2} under /u is a syntax error", () => {
    expect(parse("a{,2}", { u: true })).toBeNull();
  });
});

describe("character classes integrate with the term parser", () => {
  test("[a-z]+ ", () => {
    const terms = soleTermsOf(fullyParsed("[a-z]+"));
    expect(terms.length).toBe(1);
    expect(terms[0]!.kind).toBe("quantifier");
    const body = (terms[0] as Extract<RegexAst, { kind: "quantifier" }>).body;
    expect(body.kind).toBe("charClass");
  });
});

describe("groups: non-capturing, capturing (placeholder index), lookahead, lookbehind", () => {
  test("(?:a) is non-capturing", () => {
    expect(soleTermsOf(fullyParsed("(?:a)"))[0]).toMatchObject({ kind: "group", capture: null });
  });
  test("(a) is capturing, index 1 (capture 0 is the implicit whole match)", () => {
    expect(soleTermsOf(fullyParsed("(a)"))[0]).toMatchObject({ kind: "group", capture: 1 });
  });
  test("capture indices increment left-to-right by OPENING paren position, across nesting", () => {
    const terms = soleTermsOf(fullyParsed("(a(b))(c)"));
    expect(terms[0]).toMatchObject({ kind: "group", capture: 1 });
    const inner = soleTermsOf((terms[0] as Extract<RegexAst, { kind: "group" }>).body)[1]!;
    expect(inner).toMatchObject({ kind: "group", capture: 2 });
    expect(terms[1]).toMatchObject({ kind: "group", capture: 3 });
  });
  test("(?=a) lookahead, (?!a) negative lookahead", () => {
    expect(soleTermsOf(fullyParsed("(?=a)"))[0]).toMatchObject({ kind: "lookahead", negate: false, backward: false });
    expect(soleTermsOf(fullyParsed("(?!a)"))[0]).toMatchObject({ kind: "lookahead", negate: true, backward: false });
  });
  test("(?<=a) lookbehind, (?<!a) negative lookbehind (R3: ported, no claim)", () => {
    expect(soleTermsOf(fullyParsed("(?<=a)"))[0]).toMatchObject({ kind: "lookahead", negate: false, backward: true });
    expect(soleTermsOf(fullyParsed("(?<!a)"))[0]).toMatchObject({ kind: "lookahead", negate: true, backward: true });
  });
  test("an invalid group form ((?X ) is a syntax error", () => {
    expect(parse("(?X)")).toBeNull();
  });
});

describe("disjunction and alternatives", () => {
  test("a|b", () => {
    const ast = fullyParsed("a|b");
    expect(ast.kind).toBe("disjunction");
    expect((ast as Extract<RegexAst, { kind: "disjunction" }>).alternatives.length).toBe(2);
  });
  test("an empty alternative matches the empty string (a| and (?:))", () => {
    const ast = fullyParsed("a|");
    const alts = (ast as Extract<RegexAst, { kind: "disjunction" }>).alternatives;
    expect(alts[1]).toEqual({ kind: "alternative", terms: [] });
    // (?:) is a non-capturing group whose OWN body is empty.
    const group = soleTermsOf(fullyParsed("(?:)"))[0]!;
    expect(group.kind).toBe("group");
    const body = (group as Extract<RegexAst, { kind: "group" }>).body;
    expect(soleTermsOf(body)).toEqual([]);
  });
});

describe("CP2c: named capturing groups", () => {
  test("(?<n>a) captures with a real index and registers the name", () => {
    expect(soleTermsOf(fullyParsed("(?<n>a)"))[0]).toMatchObject({ kind: "group", capture: 1 });
  });
  test("an invalid group name is a syntax error", () => {
    expect(parse("(?<1a>x)")).toBeNull(); // digit as first char
    expect(parse("(?<>x)")).toBeNull(); // empty name
  });
  test("Node cross-check: (?<n>a) and the invalid forms agree with Node's own verdict", () => {
    expect(() => new RegExp("(?<n>a)")).not.toThrow();
    expect(() => new RegExp("(?<1a>x)")).toThrow();
  });
});

describe("CP2c: duplicate named-capture detection — design §5.3's own examples, transcribing libregexp's flat group_name_scope counter", () => {
  test("/(?<n>a)|(?<n>b)/ is LEGAL — different alternatives", () => {
    expect(parse("(?<n>a)|(?<n>b)")).not.toBeNull();
  });
  test("/(?<n>a)(?<n>b)/ is ILLEGAL — same alternative", () => {
    expect(parse("(?<n>a)(?<n>b)")).toBeNull();
  });
  test("/(?:(?<n>a))|(?<n>b)/ is LEGAL — nesting inside one top-level alternative doesn't change which alternative it's in", () => {
    expect(parse("(?:(?<n>a))|(?<n>b)")).not.toBeNull();
  });
  test("/(?<n>a)|(?<n>b)|(?<n>c)/ is LEGAL — three-way disjunction, all different alternatives", () => {
    expect(parse("(?<n>a)|(?<n>b)|(?<n>c)")).not.toBeNull();
  });
  test("every one of these agrees with Node's own accept/reject verdict", () => {
    const cases: [string, boolean][] = [
      ["(?<n>a)|(?<n>b)", true],
      ["(?<n>a)(?<n>b)", false],
      ["(?:(?<n>a))|(?<n>b)", true],
      ["(?<n>a)|(?<n>b)|(?<n>c)", true],
    ];
    for (const [src, accept] of cases) {
      let nodeAccepts = true;
      try {
        new RegExp(src);
      } catch {
        nodeAccepts = false;
      }
      expect(nodeAccepts, src).toBe(accept);
      expect(parse(src) !== null, src).toBe(accept);
    }
  });
});

describe("CP2c: numbered backreferences \\1-\\9", () => {
  test("a valid backward reference", () => {
    expect(soleTermsOf(fullyParsed("(a)\\1"))[1]).toEqual({ kind: "backreference", indices: [1], ignoreCase: false });
  });
  test("a valid FORWARD reference (the capture appears later in the pattern)", () => {
    expect(soleTermsOf(fullyParsed("\\1(a)"))[0]).toEqual({ kind: "backreference", indices: [1], ignoreCase: false });
  });
  test("Node cross-check: \\1(a) is valid syntax (forward references are legal)", () => {
    expect(() => new RegExp("\\1(a)")).not.toThrow();
  });
  test("an out-of-range backreference under /u is a syntax error", () => {
    expect(parse("\\1", { u: true })).toBeNull();
    expect(() => new RegExp("\\1", "u")).toThrow();
  });
  test("Annex B: an out-of-range backreference without /u falls back to legacy octal", () => {
    // \8 and \9 can never be octal digits, so they always fall to the
    // `c = *p++` bare-literal-digit branch when out of range.
    const ast = fullyParsed("\\8");
    expect(soleTermsOf(ast)[0]).toEqual({ kind: "char", cp: 0x38, ignoreCase: false }); // literal '8'
    // Cross-check against Node's own /\8/ behavior directly.
    expect(/^\8$/.test("8")).toBe(true);
  });
  test("Annex B octal: \\12 with no capture group 12 present parses as octal 012 = 10", () => {
    const ast = fullyParsed("\\12");
    expect(soleTermsOf(ast)[0]).toEqual({ kind: "char", cp: 10, ignoreCase: false });
    expect(new RegExp("\\12").test(String.fromCharCode(10))).toBe(true);
  });
});

describe("CP2c: \\0 is never a backreference", () => {
  test("\\0 alone is NUL", () => {
    expect(soleTermsOf(fullyParsed("\\0"))[0]).toEqual({ kind: "char", cp: 0, ignoreCase: false });
  });
  test("\\0 under /u followed by a digit is a syntax error", () => {
    expect(parse("\\01", { u: true })).toBeNull();
  });
  test("Annex B: \\01 without /u is octal-extended", () => {
    expect(soleTermsOf(fullyParsed("\\01"))[0]).toEqual({ kind: "char", cp: 1, ignoreCase: false });
  });
});

describe("CP2c: \\k<name>", () => {
  test("a backward named reference resolves to its capture's index", () => {
    const ast = fullyParsed("(?<n>a)\\k<n>");
    const terms = soleTermsOf(ast);
    expect(terms[1]).toEqual({ kind: "backreference", indices: [1], ignoreCase: false });
  });
  test("a FORWARD named reference also resolves (design §5.3: legal)", () => {
    const ast = fullyParsed("\\k<n>(?<n>a)");
    expect(soleTermsOf(ast)[0]).toEqual({ kind: "backreference", indices: [1], ignoreCase: false });
  });
  test("§5.3's own worked example: duplicate name across alternatives resolves to BOTH indices", () => {
    const ast = fullyParsed("(?<len>\\d+)px|(?<len>\\d+)em");
    // Just confirm it parses (the reference to \\k<len> elsewhere would
    // carry both indices — this pattern alone has no \\k use, this test
    // is about the DEFINITION side being legal per the duplicate-name
    // tests above; the multi-index resolution is exercised directly
    // below with an explicit \\k<n> use across two same-named groups).
    expect(ast).not.toBeNull();
  });
  test("\\k<n> after (?<n>a)|(?<n>b) carries BOTH capture indices", () => {
    const ast = fullyParsed("(?:(?<n>a)|(?<n>b))\\k<n>");
    const outerGroup = soleTermsOf(ast)[0]!;
    expect(outerGroup.kind).toBe("group");
    const backref = soleTermsOf(ast)[1]!;
    expect(backref).toEqual({ kind: "backreference", indices: [1, 2], ignoreCase: false });
  });
  test("\\k<undefined-name> under /u is a syntax error", () => {
    expect(parse("\\k<nope>", { u: true })).toBeNull();
    expect(() => new RegExp("\\k<nope>", "u")).toThrow();
  });
  test("Annex B: \\k<undefined-name> without /u and no named captures anywhere tolerates as literal", () => {
    // No named capture ANYWHERE in the pattern, so \\k<a> becomes a
    // literal string per Annex B (design §5.3's own /\k<a>/ example).
    const ast = fullyParsed("\\k<a>");
    // getClassAtom's own literal-\\k handling: '\\' isn't in its
    // always-escapable set, so it falls through parseEscape -> unknown
    // letter 'k' -> non-unicode ignore-backslash -> literal 'k', then
    // '<','a','>' as three more literal atoms.
    expect(soleTermsOf(ast).map((t) => (t as Extract<RegexAst, { kind: "char" }>).cp)).toEqual([
      0x6b, 0x3c, 0x61, 0x3e,
    ]);
    // Cross-check directly against Node's own measured behavior (design
    // §5.3: /\k<a>/.test("k<a>") is true).
    expect(/\k<a>/.test("k<a>")).toBe(true);
  });
});

describe("Node cross-check: every CP2b-scope pattern this suite parses, Node also accepts", () => {
  test("a sample of accepted patterns are ALSO accepted by Node (no false structural success)", () => {
    const patterns: [string, { u?: boolean; i?: boolean; m?: boolean; s?: boolean }][] = [
      ["a*b+c?", {}],
      ["^abc$", { m: true }],
      ["(?:ab)+", {}],
      ["(?i:a)b", {}],
      ["[a-z0-9]{2,5}", {}],
      ["(?=ab)a", {}],
      ["(?<=ab)c", {}],
      ["a|b|c", {}],
      ["\\p{L}+", { u: true }],
    ];
    for (const [src, flags] of patterns) {
      const flagStr = Object.entries(flags)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join("");
      expect(() => new RegExp(src, flagStr), `${src}/${flagStr}`).not.toThrow();
      expect(parse(src, flags), `${src}/${flagStr}`).not.toBeNull();
    }
  });
});

describe("quantifiability gating — the coupling-audit finding, all seven traced cases", () => {
  // The five Node-rejects: a quantifier suffix following an atom
  // libregexp never marks quantifiable (^, $, \b are NEVER quantifiable;
  // lookahead is quantifiable only forward+non-unicode; lookbehind is
  // NEVER quantifiable). Each cross-checked directly against Node, not
  // assumed from the C read.
  test("^* is REJECTED (Node: 'Nothing to repeat')", () => {
    expect(() => new RegExp("^*")).toThrow(/Nothing to repeat/);
    expect(parse("^*")).toBeNull();
  });
  test("$* is REJECTED (Node: 'Nothing to repeat')", () => {
    expect(() => new RegExp("$*")).toThrow(/Nothing to repeat/);
    expect(parse("$*")).toBeNull();
  });
  test("\\b* is REJECTED (Node: 'Nothing to repeat')", () => {
    expect(() => new RegExp("\\b*")).toThrow(/Nothing to repeat/);
    expect(parse("\\b*")).toBeNull();
  });
  test("(?=a)* under /u is REJECTED (Node: 'Invalid quantifier')", () => {
    expect(() => new RegExp("(?=a)*", "u")).toThrow(/Invalid quantifier/);
    expect(parse("(?=a)*", { u: true })).toBeNull();
  });
  test("(?<=a)* is REJECTED in BOTH modes (Node: 'Invalid quantifier')", () => {
    expect(() => new RegExp("(?<=a)*")).toThrow(/Invalid quantifier/);
    expect(() => new RegExp("(?<=a)*", "u")).toThrow(/Invalid quantifier/);
    expect(parse("(?<=a)*")).toBeNull();
    expect(parse("(?<=a)*", { u: true })).toBeNull();
  });

  // The two over-correction guards: confirm the fix didn't overshoot and
  // reject constructs Node actually accepts.
  test("OVER-CORRECTION GUARD: (?=a)* WITHOUT /u is ACCEPTED (Annex B leniency)", () => {
    expect(() => new RegExp("(?=a)*")).not.toThrow();
    expect(parse("(?=a)*")).not.toBeNull();
  });
  test("OVER-CORRECTION GUARD: an ordinary quantified atom still works", () => {
    expect(() => new RegExp("a*")).not.toThrow();
    expect(parse("a*")).not.toBeNull();
    expect(parse("[a-z]+")).not.toBeNull();
    expect(parse("(?:ab)*")).not.toBeNull();
    expect(parse("(?i:a)*")).not.toBeNull(); // transparent modifier group, quantified as a whole unit
  });
});

// §6.3(a)'s LOAD-BEARING CONSTRAINT: ignoreCase+isUnicode (simple case
// folding, /iu) must be unreachable by construction, with an EXPLICIT
// guard — this port implements only conv_type 0 (non-unicode /i's plain
// uppercase rule), never conv_type 2 (real unicode simple case folding),
// so a fold request reaching char/class compilation must throw rather
// than silently compute a wrong-but-plausible answer. CP3's case-closure
// restructuring (regex-charclass.ts's closeMemberIfNeeded) DUPLICATED
// this guard rather than sharing regex-parser.ts's assertNoUnicodeCasefold
// (a real circular-import constraint, documented at the duplication
// site) — a single reaching pin would leave the second copy decorative,
// so BOTH sites get their own direct pin, per the lead's explicit CP4
// rider. Neither pin goes through the generated corpus (which by design
// never produces an i+u pattern — §6.1's own fence) — each constructs
// the exact ignoreCase+isUnicode call directly.
describe("§6.3(a) reaching pins: BOTH copies of the /iu guard, each pinned directly", () => {
  test("regex-parser.ts's assertNoUnicodeCasefold (via parseClassAtomTerm, a bare literal char): THROWS under ignoreCase+isUnicode", () => {
    // /a/iu — an ordinary, otherwise-unremarkable pattern. Node accepts
    // it outright; this port's engine must refuse it LOUDLY (a throw,
    // not a null "syntax error" and not a silently-wrong AST) because
    // 'a' still routes through parseClassAtomTerm's normal_char path,
    // which cannot safely skip the fold-request guard just because this
    // particular character happens to fold the same way under both
    // rules — the guard is unconditional on ignoreCase+isUnicode, not
    // content-dependent.
    expect(() => parsePattern("a", 0, true, true, false, false)).toThrow(/ignoreCase\+isUnicode/);
  });

  test("regex-charclass.ts's closeMemberIfNeeded (via parseCharClass, a bracketed literal): THROWS under ignoreCase+isUnicode", () => {
    // Called DIRECTLY (not through parsePattern's `[` dispatch) so this
    // pin exercises regex-charclass.ts's OWN copy of the guard, not
    // regex-parser.ts's — proving the duplication didn't leave one side
    // silently unguarded.
    expect(() => parseCharClass("[a]", 0, true, true)).toThrow(/ignoreCase\+isUnicode/);
  });

  test("sanity: the SAME calls do NOT throw when isUnicode is false (non-unicode /i is fully supported)", () => {
    expect(() => parsePattern("a", 0, false, true, false, false)).not.toThrow();
    expect(() => parseCharClass("[a]", 0, false, true)).not.toThrow();
  });

  test("sanity: the SAME calls do NOT throw when ignoreCase is false (plain /u is fully supported)", () => {
    expect(() => parsePattern("a", 0, true, false, false, false)).not.toThrow();
    expect(() => parseCharClass("[a]", 0, true, false)).not.toThrow();
  });
});
