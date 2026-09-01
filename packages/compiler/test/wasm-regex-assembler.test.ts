/* INC-24 P1, CP3: assemble() vs the LIVE lre_compile oracle — the byte
 * comparison design §9.2 calls "the strongest available gate". Built
 * smallest-pattern-first: this file starts with the single-literal-char
 * case (the smallest possible pattern) and grows as walkTerm gains more
 * AST kinds, each verified against the oracle before the next is added. */
import { describe, expect, test } from "vitest";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { assemble, type AssembleFlags } from "../src/backend/wasm/regex-assembler.js";
import { archiveCanaryRun, lreCompile } from "./regex-lre-oracle.js";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function noFlags(overrides: Partial<AssembleFlags> = {}): AssembleFlags {
  return { global: false, ignoreCase: false, multiLine: false, dotAll: false, unicode: false, sticky: false, ...overrides };
}

function assembleFromSource(pattern: string, flags: AssembleFlags) {
  const parsed = parsePattern(pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
  expect(parsed, `parse failed for /${pattern}/`).not.toBeNull();
  expect(parsed!.next, `trailing unconsumed input in /${pattern}/`).toBe(pattern.length);
  return assemble(parsed!.ast, flags);
}

test("canary: the live oracle itself is reachable and archived for the record", () => {
  expect(() => archiveCanaryRun()).not.toThrow();
});

test("/a/ (no flags): byte-identical to lre_compile", () => {
  const ref = lreCompile("a", "");
  expect(ref).not.toBeNull();
  const mine = assembleFromSource("a", noFlags());
  expect(hex(mine.bytes), `mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  expect(mine.bytes.length).toBe(ref!.bytes.length);
  expect(mine.captureCount).toBe(ref!.captures);
});

test("a single literal char, several code points: byte-identical to lre_compile", () => {
  for (const ch of ["a", "Z", "5", "_", "é"]) {
    const ref = lreCompile(ch, "");
    expect(ref, ch).not.toBeNull();
    const mine = assembleFromSource(ch, noFlags());
    expect(hex(mine.bytes), `char=${ch}`).toBe(hex(ref!.bytes));
  }
});

test("a two-char literal sequence (alternative with multiple terms): byte-identical", () => {
  const ref = lreCompile("ab", "");
  expect(ref).not.toBeNull();
  const mine = assembleFromSource("ab", noFlags());
  expect(hex(mine.bytes)).toBe(hex(ref!.bytes));
});

test("ignore_case on a literal char picks REOP_char_i and canonicalizes: byte-identical", () => {
  const ref = lreCompile("a", "i");
  expect(ref).not.toBeNull();
  const mine = assembleFromSource("a", noFlags({ ignoreCase: true }));
  expect(hex(mine.bytes), `mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
});

test("sticky flag omits the search-from-any-position prelude: byte-identical", () => {
  const ref = lreCompile("a", "y");
  expect(ref).not.toBeNull();
  const mine = assembleFromSource("a", noFlags({ sticky: true }));
  expect(hex(mine.bytes)).toBe(hex(ref!.bytes));
  // Structural sanity: the sticky version must be shorter than the
  // non-sticky one by exactly the prelude's size (11 bytes: split_goto_first
  // 5 + any 1 + goto 5).
  const nonSticky = assembleFromSource("a", noFlags());
  expect(nonSticky.bytes.length - mine.bytes.length).toBe(11);
});

test("an astral literal char (REOP_char32, not REOP_char): byte-identical", () => {
  const ref = lreCompile("\u{1F600}", "u"); // 😀, requires /u to parse as one atom, not two surrogates
  expect(ref).not.toBeNull();
  const mine = assembleFromSource("\u{1F600}", noFlags({ unicode: true }));
  expect(hex(mine.bytes)).toBe(hex(ref!.bytes));
});

test("character classes ([abc], [a-z], \\d\\s\\w, negated, \\p{L}): byte-identical", () => {
  const cases: [string, Partial<AssembleFlags>][] = [
    ["[abc]", {}],
    ["[a-z]", {}],
    ["[^a-z]", {}],
    ["[a-z0-9_]", {}],
    ["[\\d\\s\\w]", {}],
    ["[\\D\\S\\W]", {}],
    ["\\d", {}],
    ["\\D", {}],
    ["[\\p{L}]", { unicode: true }],
  ];
  for (const [pattern, over] of cases) {
    const flags = noFlags(over);
    const flagStr = (flags.unicode ? "u" : "") + (flags.ignoreCase ? "i" : "");
    const ref = lreCompile(pattern, flagStr);
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, flags);
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

test("a case-closed class under /i: byte-identical (canonicalize's byte-level check, per the lead's rider)", () => {
  const cases = ["[a-z]", "[a-fA-F0-9]", "\\d"];
  for (const pattern of cases) {
    const ref = lreCompile(pattern, "i");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags({ ignoreCase: true }));
    expect(hex(mine.bytes), `${pattern}/i: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

test("multi-alternative disjunction (REOP_split_next_first + goto chains): byte-identical", () => {
  for (const pattern of ["a|b", "a|b|c", "ab|cd", "a|b|c|d"]) {
    const ref = lreCompile(pattern, "");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags());
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

test("quantifiers on a simple literal char, no captures: byte-identical", () => {
  for (const pattern of ["a*", "a+", "a?", "a*?", "a+?", "a??", "a{3}", "a{3,}", "a{3,7}", "a{0,5}"]) {
    const ref = lreCompile(pattern, "");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags());
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

// Strategy-SELECTION boundaries (libregexp.c:2306-2367's own min/max
// branch conditions) — each pattern below is chosen to sit directly
// adjacent to a branch edge, pairing with an already-tested neighbor
// above, so a transcription error in the BOUNDARY CHECK ITSELF (off-by-
// one in a min===/max=== comparison) would show up as a byte mismatch
// even though both sides individually "look plausible":
//   a{0}    max 0->1 edge (discard vs split-wrap), pairs with a? (={0,1})
//   a{0,2}  max 1->2 edge (split-wrap vs {0,N}-loop), pairs with a?
//   a{1,1}  min===max at its SMALLEST value (single REOP.loop), pairs with a{3}
//   a{1,5}  min===1 with FINITE max (must NOT take the `+`-fast-path,
//           which requires max===Infinity too — proves the fast-path
//           condition checks BOTH min and max, not min alone)
//   a{2,}   min 1->2 edge at max===Infinity (general case's neighbor of
//           the `+`-fast-path), pairs with a+ (={1,Infinity})
test("quantifiers: strategy-selection boundary pairs, byte-identical", () => {
  for (const pattern of ["a{0}", "a{0,2}", "a{1,1}", "a{1,5}", "a{2,}"]) {
    const ref = lreCompile(pattern, "");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags());
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

test("trivial single-opcode atoms (dot, ^, $, \\b, \\B) and their multiline/dotAll/quantified variants: byte-identical", () => {
  const cases: [string, string][] = [
    [".", ""],
    [".", "s"], // dotAll -> REOP_any instead of REOP_dot
    ["^", ""],
    ["^", "m"],
    ["$", ""],
    ["$", "m"],
    ["\\b", ""],
    ["\\B", ""],
    ["a.b", ""],
    [".*", ""], // quantified dot: dot always advances, no addZeroAdvanceCheck interaction
  ];
  for (const [pattern, flagStr] of cases) {
    const flags = noFlags({ multiLine: flagStr.includes("m"), dotAll: flagStr.includes("s") });
    const parsed = parsePattern(pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
    expect(parsed, `${pattern}/${flagStr}`).not.toBeNull();
    expect(parsed!.next, `trailing unconsumed input in /${pattern}/${flagStr}`).toBe(pattern.length);
    const ref = lreCompile(pattern, flagStr);
    expect(ref, `${pattern}/${flagStr}`).not.toBeNull();
    const mine = assemble(parsed!.ast, flags);
    expect(hex(mine.bytes), `${pattern}/${flagStr}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

test("groups: non-capturing (transparent) and capturing (save_start/save_end wrap): byte-identical", () => {
  const cases = ["(?:a)", "(?:ab)", "(a)", "(ab)", "(a)(b)", "((a))", "(a)(?:b)(c)", "(a)*", "(a)+", "(a){2,3}"];
  for (const pattern of cases) {
    const ref = lreCompile(pattern, "");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags());
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

test("forward lookahead/negative-lookahead (REOP_lookahead+match wrap): byte-identical", () => {
  const cases = ["(?=a)", "(?!a)", "a(?=b)", "a(?!b)", "(?=ab)c", "(?=a)*", "(?!a)*"]; // last two: Annex B non-unicode quantifiable lookahead
  for (const pattern of cases) {
    const ref = lreCompile(pattern, "");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags());
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

test("backreferences: numbered, named, forward-reference ordering: byte-identical", () => {
  const cases = [
    "(a)\\1", // basic numbered backref
    "(?<x>a)\\k<x>", // named backref
    "(?<x>a)\\1", // numbered backref to a named group
    "\\k<a>(?<a>x)", // FORWARD reference: \k<a> appears before (?<a>...) is parsed
    "(a)\\1\\1", // multiple backrefs to the same capture
  ];
  for (const pattern of cases) {
    const ref = lreCompile(pattern, "");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags());
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

// R3 PINS: lookbehind (backward direction) — built WHILE the emission
// logic is fresh, per the lead's explicit ask, not deferred to CP4. This
// is the ported-without-a-claim machinery: REOP_prev wrapping around
// content-consuming atoms, term-order reversal within each alternative
// (RegexByteWriter.moveToFront, unit-pinned separately in
// wasm-regex-bytewriter.test.ts), and save_start/save_end SWAP order for
// capturing groups — all threaded through a single isBackwardDir
// parameter (walkTerm/walkAlternative/walkGroup/walkDisjunction/
// emitQuantifier/emitBackreference).
describe("R3: lookbehind (backward direction)", () => {
  test("per-arm: (?<=...) and (?<!...), single and multi-char bodies, byte-identical", () => {
    const cases = [
      "(?<=a)", // lookbehind arm 1: positive, single char
      "(?<!a)", // lookbehind arm 2: negative, single char
      "(?<=ab)", // multi-char body: exercises term-order reversal (moveToFront)
      "(?<!ab)",
      "b(?<=a)", // lookbehind not at pattern start (a preceding forward atom)
      "(?<=a)b", // lookbehind followed by a forward atom (confirms direction resets after the lookaround closes)
      "(?<=[a-c])", // a char-class body inside a lookbehind (REOP_prev wraps range too, same as char)
    ];
    for (const pattern of cases) {
      const ref = lreCompile(pattern, "");
      expect(ref, pattern).not.toBeNull();
      const mine = assembleFromSource(pattern, noFlags());
      expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
    }
  });

  test("nested lookaround RESETS direction from its own syntax, not the enclosing context: byte-identical", () => {
    const cases = [
      "(?<=(?=a)b)", // forward lookahead NESTED inside a lookbehind: its OWN body must still walk forward
      "(?=(?<=a)b)", // lookbehind NESTED inside a forward lookahead: its OWN body must still walk backward
      "(?<=(?<=a)b)", // lookbehind nested inside ANOTHER lookbehind: both walk backward, independently re-established
      "(?<!(?!a)b)", // negative lookahead nested inside a negative lookbehind
    ];
    for (const pattern of cases) {
      const ref = lreCompile(pattern, "");
      expect(ref, pattern).not.toBeNull();
      const mine = assembleFromSource(pattern, noFlags());
      expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
    }
  });

  test("capturing groups inside a lookbehind: save_start/save_end SWAP order, byte-identical", () => {
    const cases = [
      "(?<=(a))", // single-char capture inside a lookbehind
      "(?<=(ab))", // multi-char capture body: term-reversal AND the save swap together
      "(?<=(a)(b))", // two captures inside one lookbehind: both swapped, term order reversed
    ];
    for (const pattern of cases) {
      const ref = lreCompile(pattern, "");
      expect(ref, pattern).not.toBeNull();
      const mine = assembleFromSource(pattern, noFlags());
      expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
    }
  });

  test("backward-backreference interaction: byte-identical", () => {
    const cases = [
      "(a)(?<=\\1)", // backreference INSIDE a lookbehind, to a group captured OUTSIDE (forward) it —
      // proves the backreference's own opcode picks backward_back_reference
      // from the CURRENT walk direction (true, inside the lookbehind),
      // independent of the direction the referenced group was captured in.
      "(?<=(a)\\1)", // backreference AND its referenced group both INSIDE the same lookbehind
      "(?<=(a)b\\1)", // same, with an intervening atom (exercises term-reversal ordering the backref correctly)
    ];
    for (const pattern of cases) {
      const ref = lreCompile(pattern, "");
      expect(ref, pattern).not.toBeNull();
      const mine = assembleFromSource(pattern, noFlags());
      expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
    }
  });
});

// addZeroAdvanceCheck=true oracle pin (previously flagged UNREACHABLE by
// construction, now reachable now that groups/disjunction/backreferences
// are wired into walkTerm — owed since that finding, promoted to "first
// test after group emission works" per the lead's explicit ask). Two
// distinct routes into needCheckAdvAndCaptureInit's `default` case are
// pinned: a quantified group wrapping a disjunction (`(a|b)*` — the
// group's own save_start and the disjunction's split_next_first opcode
// are both unrecognized by the scanner, so it hits `default` and returns
// with needCheckAdv still at its initial `true`), and a quantified
// backreference (`\1+` — REOP_back_reference isn't in the scanner's
// recognized list either, but unlike split/goto it does NOT early-
// return, so this exercises a genuinely different control path through
// the SAME scanner reaching the SAME outcome: the loop runs to
// completion with needCheckAdv never set false). `(a|b)+` additionally
// pins the min===1&&max===Infinity fast-path-vs-general split UNDER the
// flag: the fast path requires `!addZeroAdvanceCheck` too, so this must
// take the GENERAL case's extra set_char_pos/check_advance bytes, not
// the simpler trailing-split fast path `a+` uses.
test("addZeroAdvanceCheck=true: quantified group-with-disjunction and quantified backreference, byte-identical", () => {
  const cases = [
    "(a|b)*", // {0,Infinity} strategy, addZeroAdvanceCheck=true via the group+disjunction route
    "(a|b)+", // min=1,max=Infinity: MUST take the general case, not the `+`-fast-path
    "(a|b){2,4}", // general {N,M} strategy, addZeroAdvanceCheck=true
    "(a)\\1+", // addZeroAdvanceCheck=true via the OTHER route: a quantified backreference (no early return in the scanner)
  ];
  for (const pattern of cases) {
    const ref = lreCompile(pattern, "");
    expect(ref, pattern).not.toBeNull();
    const mine = assembleFromSource(pattern, noFlags());
    expect(hex(mine.bytes), `${pattern}: mine=${hex(mine.bytes)} ref=${hex(ref!.bytes)}`).toBe(hex(ref!.bytes));
  }
});

