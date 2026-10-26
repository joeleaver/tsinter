/* The regex tier's dispositions — which named fence (SEMANTICS.md S102,
 * the census key `expr:regexLit:<key>` / `libCall:regex.new:<key>`) a
 * pattern refuses under, or that it builds — pinned on the one regex
 * compiler (regex-compiler.ts, run in-process by regex-buildtime.ts).
 * These are the witnesses the retired TypeScript disposition layer
 * (INC-24 P2/P5) was pinned with, one true positive per key and the
 * true negatives that must NOT misfire, now asserted on the compiler's
 * own outcome. Every row is also checked against Node: a fenced or built
 * pattern is one Node accepts, so a fence never hides a SyntaxError. */
import { describe, expect, test } from "vitest";
import { compileRegex } from "../src/backend/wasm/regex-buildtime.js";

/** "ok", or the fence key. */
function disposition(pattern: string, flags: string): string {
  const r = compileRegex(pattern, flags);
  if (r.kind === "ok") return "ok";
  if (r.kind === "fence") return r.key;
  return `SyntaxError: ${r.message}`;
}

function nodeAccepts(pattern: string, flags: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

const ROWS: ReadonlyArray<readonly [pattern: string, flags: string, expected: string, why: string]> = [
  // unicode-casefold: /iu together, whatever else the pattern holds
  ["(?i:a)", "iu", "unicode-casefold", "/iu wins even over a modifier group"],
  ["a", "iu", "unicode-casefold", "i+u together"],
  ["a", "i", "ok", "i alone"],
  ["a", "u", "ok", "u alone"],
  // modifiers
  ["(?i:a)", "", "modifiers", "(?i:) under non-ignoreCase top level"],
  ["(?-i:a)", "i", "modifiers", "(?-i:) under top-level /i turns it OFF"],
  ["(x(?i-m:a))", "m", "modifiers", "nested inside a group"],
  ["(?i:\\b)", "u", "modifiers", "(?i:\\b) under /u turns word_boundary_i on"],
  ["abc", "i", "ok", "plain pattern, top-level /i"],
  ["(a|b)+[c-e]*\\d{2,3}", "", "ok", "alternation, groups, quantifiers, classes"],
  ["\\bfoo\\B", "i", "ok", "\\b under top-level /i (word_boundary has no /i form without /u)"],
  ["(?:a)", "", "ok", "a non-capturing group is not a modifier group"],
  // unported-unicode-property (/u only)
  ["\\p{Script=Greek}", "u", "unported-unicode-property", "Script under /u"],
  ["\\P{Alphabetic}", "u", "unported-unicode-property", "negated binary property"],
  ["\\p{Alphabetic}", "u", "unported-unicode-property", "binary property (Node accepts)"],
  ["\\p{L}", "u", "ok", "General_Category is supported"],
  ["[\\p{L}\\d]", "u", "ok", "General_Category inside a class"],
  // #267: an escaped backslash followed by `p{…}` is no property escape
  ["[\\\\p{Script=Greek}]", "u", "ok", "#267: `\\\\` then literal p{Script=Greek} in a class"],
  ["\\\\p\\{Script=Greek\\}", "u", "ok", "#267: `\\\\` then an escaped p\\{Script=Greek\\}"],
  // Annex B — the eight refused families, one witness each (each parses
  // without /u and throws with /u in Node)
  ["(?=a)*", "", "annexb-quantified-assertion", "F1"],
  ["(?!a)+", "", "annexb-quantified-assertion", "F1 negated lookahead"],
  ["(?:(?=a))+", "", "ok", "F1 does NOT fire on a quantified group containing a lookahead"],
  ["a]b", "", "annexb-extended-pattern-char", "F2 lone ]"],
  ["a}b", "", "annexb-extended-pattern-char", "F2 lone }"],
  ["a{,2}", "", "annexb-brace-literal", "F3"],
  ["a{", "", "annexb-brace-literal", "F3 unterminated a{"],
  ["a{2", "", "annexb-brace-literal", "F3 unterminated a{2"],
  ["\\1", "", "annexb-legacy-octal", "F4 \\1 with no group 1"],
  ["\\00", "", "annexb-legacy-octal", "F4 \\0 followed by a digit"],
  ["(a)\\1", "", "ok", "F4 non-local: group 1 exists"],
  ["(?<n>a)\\1", "", "ok", "F4 non-local: a named group counts"],
  ["(?<a>x)(?<b>y)\\2", "", "ok", "F4 non-local: only the missing index is legacy"],
  ["\\8", "", "annexb-nonoctal-decimal", "F5"],
  ["(a)\\9", "", "annexb-nonoctal-decimal", "F5 with other groups present"],
  ["(a)(b)(c)(d)(e)(f)(g)(h)\\8", "", "ok", "F5 non-local: 8 groups exist"],
  ["\\c1", "", "annexb-control-escape", "F7 digit after \\c"],
  ["\\c", "", "annexb-control-escape", "F7 bare \\c"],
  ["[\\c1]", "", "annexb-control-escape", "F7 inside a class"],
  ["[\\c_]", "", "annexb-control-escape", "F7 inside a class"],
  ["\\cZ", "", "ok", "F7 does not fire on a real control letter"],
  ["[\\cZ]", "", "ok", "F7 does not fire on a real control letter in a class"],
  ["[a-\\d]", "", "annexb-class-range-escape", "F8 class escape at the right end"],
  ["[\\d-z]", "", "annexb-class-range-escape", "F8 class escape at the left end"],
  ["[\\w-a]", "", "annexb-class-range-escape", "F8"],
  ["[\\d-\\w]", "", "annexb-class-range-escape", "F8 both ends"],
  ["[\\d-d-a]", "", "annexb-class-range-escape", "F8 where V8's class parse differs from libregexp's"],
  ["[\\B]", "", "ok", "\\B in a class is family 6 (literal B), not F8"],
  ["\\k", "", "annexb-named-backref-leniency", "F9 bare \\k"],
  ["\\k<a>", "", "annexb-named-backref-leniency", "F9 \\k<a> with no named groups"],
  ["(?<a>x)\\k<a>", "", "ok", "F9 non-local: its named group exists"],
  // family 6 (lenient identity escape) is implemented
  ["\\-", "", "ok", "family 6"],
  ["\\q", "", "ok", "family 6"],
  ["\\ ", "", "ok", "family 6"],
  ["\\é", "", "ok", "family 6"],
  ["\\\u{1F600}", "", "ok", "family 6 astral"],
  ["[\\q]", "", "ok", "family 6 in a class"],
  ["[\\-]", "", "ok", "\\- in a class is strict"],
  // controls: strict forms that merely look legacy
  ["\\0", "", "ok", "strict NUL"],
  ["\\/", "", "ok", "strict identity escape"],
  ["[a-z]", "", "ok", ""],
  ["[]", "", "ok", "empty class"],
  ["[^]", "", "ok", "negated empty class"],
  // the claim patterns' representative shapes
  ["ab+c", "", "ok", ""],
  ["hello", "i", "ok", ""],
  ["^b", "m", "ok", ""],
  ["a.b", "s", "ok", ""],
  ["^.$", "u", "ok", ""],
  ["t(a)g", "gim", "ok", ""],
  ["\\d{3}-\\d{4}", "", "ok", ""],
  // flags
  ["a", "v", "unicode-sets-flag", "/v"],
  ["a".repeat(8193), "", "pattern-too-large", "past RX_PATTERN_SIZE_LIMIT"],
];

/** A fenced construct does not hide a later syntax error: V8 reports it
 * (unit E made the class-range-escape fence wait for the whole parse;
 * #264's two classes reject as V8 does). Expected outcome: Node's own
 * message, read here, never typed. */
const NODE_REJECTS: ReadonlyArray<readonly [pattern: string, flags: string, why: string]> = [
  ["[\\w-a][a", "", "class-range escape, then an unterminated class"],
  ["[\\d-a]^(?<y", "", "class-range escape, then a bad group name"],
  ["a{2,5}[\\d-a]}[\\d-aa.c", "s", "two class-range escapes, then an unterminated class"],
  ["((?<a>x)|y)(?<a>z)", "", "#264: a duplicate group name V8 rejects"],
  ["(?<a>x)[\\k]", "", "#264: \\k inside a class with named groups"],
  ["\\p{", "u", "an unterminated property escape is V8's syntax error, not a fence"],
  ["(?<a>x]|y)(?<a>z)", "i", "a duplicate name after a lone ]"],
  // property names V8 rejects without its property tables (review)
  ["\\p{L=}", "u", "an empty value"],
  ["\\p{}", "u", "an empty name"],
  ["\\p{sc=}", "u", "an empty Script value"],
  ["\\p{gc=Foo}", "u", "a General_Category value that is not one"],
  ["\\p{Script}", "u", "a Name=Value name standing alone"],
  ["\\p{Lu=Lu}", "u", "a Name=Value whose name is not gc/sc/scx"],
  ["[\\p{gc=Foo}]", "u", "the same inside a class"],
  ["\\p{L=}", "iu", "/iu: the /u grammar runs before the casefold fence"],
  // a pending fence (modifiers) does not hide a later syntax error
  ["(?i:a)(", "", "modifiers, then an unterminated group"],
  ["(?i:a)(", "u", "a modifier turning /i on under /u, then an unterminated group"],
  ["(?i:a){2,1}", "iu", "/iu with a modifier, then numbers out of order"],
];

/** Fences where Node throws a SyntaxError — registered in S102 (a name
 * only Node's property tables can judge is fenced where met). */
const FENCE_WHERE_NODE_REJECTS: ReadonlyArray<readonly [pattern: string, flags: string, key: string]> = [
  ["\\p{Foo}", "u", "unported-unicode-property"],
  ["\\p{sc=Foo}", "u", "unported-unicode-property"],
  ["\\p{Alphabetic}(", "u", "unported-unicode-property"],
  ["\\p{Alphabetic}(", "iu", "unicode-casefold"],
];

function nodeMessage(pattern: string, flags: string): string {
  try {
    new RegExp(pattern, flags);
    return "accepted";
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
}

describe("regex dispositions on the one compiler", () => {
  for (const [pattern, flags, expected, why] of ROWS) {
    test(`/${pattern.length > 40 ? pattern.slice(0, 20) + "…" : pattern}/${flags} → ${expected}${why ? ` (${why})` : ""}`, () => {
      expect(disposition(pattern, flags)).toBe(expected);
      expect(nodeAccepts(pattern, flags), "Node accepts every built or fenced row").toBe(true);
    });
  }
  for (const [pattern, flags, why] of NODE_REJECTS) {
    test(`/${pattern}/${flags} → Node's SyntaxError (${why})`, () => {
      const want = nodeMessage(pattern, flags);
      expect(want.startsWith("SyntaxError: ")).toBe(true);
      expect(disposition(pattern, flags)).toBe(want);
    });
  }
  for (const [pattern, flags, key] of FENCE_WHERE_NODE_REJECTS) {
    test(`/${pattern}/${flags} → ${key} where Node throws a SyntaxError (S102)`, () => {
      expect(nodeMessage(pattern, flags).startsWith("SyntaxError: ")).toBe(true);
      expect(disposition(pattern, flags)).toBe(key);
    });
  }
});
