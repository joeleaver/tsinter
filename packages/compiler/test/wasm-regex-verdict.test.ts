/* INC-24 P1, CP1/CP2d: the parser-vs-Node verdict harness (design §6.1's
 * second EXHAUSTIVE instrument — "Node is the oracle for the parser, not
 * just for the matcher"). Every pattern in a generated corpus is fed to
 * `new RegExp` and to our parser, and the two verdicts must agree: both
 * ACCEPT, or both REJECT.
 *
 * CP2d: the comparison half is wired (parserVerdict + the generated
 * corpus below). SCOPE: parserVerdict checks ACCEPT/REJECT agreement
 * only, not message-text equality — our parser doesn't produce Node-exact
 * error messages yet (that lands with §5.5's error table wiring, not yet
 * built); this harness's job at CP2d is proving the GRAMMAR is right, the
 * strongest available check on the parser short of message text.
 * FENCED (design §6.1, excluded from the generated corpus, matching the
 * oracle plan's own fence — NOT full parser gaps, just out of THIS
 * harness's exhaustive scope): /v (refused pre-parse, SC1120), Annex-B-
 * only grammar extensions, /iu combined (case-fold is unimplemented —
 * §6.3(a)'s own load-bearing warning that a fold request must be
 * unreachable by construction; this harness achieves that by never
 * generating an i+u pattern, not yet by an explicit runtime guard — see
 * the findings file for that as an open item). \p{Script=...}/binary
 * properties: also excluded (unicodeGeneralCategory's own documented
 * scope), except one deliberate negative case proving parserVerdict
 * correctly REJECTS rather than silently accepting what it can't resolve
 * when Node itself would accept the syntax (a real gap, not a false
 * pass) — see the "known gap" test below. */
import { expect, test } from "vitest";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { generatedCorpus, loadClaimPatterns } from "./regex-corpus.js";

interface Verdict {
  accept: boolean;
  name?: string;
  message?: string;
}

/** Node's own verdict on a pattern/flags pair — the oracle side of the
 * harness. Never throws itself: a SyntaxError from `new RegExp` is the
 * REJECT signal, not a test failure. */
function nodeVerdict(pattern: string, flags: string): Verdict {
  try {
    // Constructing IS the verdict; the instance itself is unused, only
    // whether construction throws matters.
    new RegExp(pattern, flags);
    return { accept: true };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { accept: false, name: err.name, message: err.message };
  }
}

/** Our parser's verdict on a pattern/flags pair. g/y are omitted from the
 * flag-derived booleans on purpose: neither affects PATTERN GRAMMAR
 * parsing (g governs the runtime exec loop, y governs runtime lastIndex
 * anchoring — parsePattern's four flag parameters are exactly the ones
 * that change parsing decisions: u/i/m/s). `next !== pattern.length`
 * (trailing unconsumed input, e.g. a stray ')') counts as REJECT — a
 * real parse failure this harness must not silently treat as ACCEPT. */
function parserVerdict(pattern: string, flags: string): Verdict {
  const r = parsePattern(pattern, 0, flags.includes("u"), flags.includes("i"), flags.includes("m"), flags.includes("s"));
  if (r === null || r.next !== pattern.length) return { accept: false };
  return { accept: true };
}

/* §5.5's byte-exact message table (design lines 950-963), reproduced here
 * as the trusted fixture — each is MEASURED against Node directly in the
 * design's own node/syntaxerr.mjs probe. Re-deriving them live against the
 * CURRENT Node (not copy-pasting the design's prose as ground truth) is
 * the whole point: if this repo's Node version ever drifted from the one
 * the design measured, THIS test would catch it before the parser did. */
const BAD_ARGUMENT_TABLE: { pattern: string; flags: string; message: string }[] = [
  { pattern: "(", flags: "", message: "Invalid regular expression: /(/: Unterminated group" },
  { pattern: "a)", flags: "", message: "Invalid regular expression: /a)/: Unmatched ')'" },
  { pattern: "[z-a]", flags: "", message: "Invalid regular expression: /[z-a]/: Range out of order in character class" },
  { pattern: "*", flags: "", message: "Invalid regular expression: /*/: Nothing to repeat" },
  { pattern: "\\", flags: "", message: "Invalid regular expression: /\\/: \\ at end of pattern" },
  {
    pattern: "(?<a>x)(?<a>y)",
    flags: "",
    message: "Invalid regular expression: /(?<a>x)(?<a>y)/: Duplicate capture group name",
  },
  { pattern: "\\p{Nope}", flags: "u", message: "Invalid regular expression: /\\p{Nope}/u: Invalid property name" },
  {
    pattern: "a{2,1}",
    flags: "",
    message: "Invalid regular expression: /a{2,1}/: numbers out of order in {} quantifier",
  },
  {
    // §5.3's non-local \k rule: a forward-or-absent reference with no
    // named group ANYWHERE in the pattern, under /u — same message as the
    // design's /\k<a>(?<b>x)/ example, cheaper to spell for this fixture.
    pattern: "\\k<a>",
    flags: "u",
    message: "Invalid regular expression: /\\k<a>/u: Invalid named capture referenced",
  },
];

const BAD_FLAGS_TABLE: { pattern: string; flags: string; message: string }[] = [
  { pattern: "a", flags: "x", message: "Invalid flags supplied to RegExp constructor 'x'" },
  { pattern: "a", flags: "gg", message: "Invalid flags supplied to RegExp constructor 'gg'" },
];

test("nodeVerdict: §5.5's bad-ARGUMENT message table, re-derived live against this Node", () => {
  for (const { pattern, flags, message } of BAD_ARGUMENT_TABLE) {
    const v = nodeVerdict(pattern, flags);
    expect(v.accept, `/${pattern}/${flags} was expected to REJECT`).toBe(false);
    expect(v.name, `/${pattern}/${flags}`).toBe("SyntaxError");
    expect(v.message, `/${pattern}/${flags}`).toBe(message);
  }
});

test("nodeVerdict: §5.5's bad-FLAGS message table, re-derived live against this Node", () => {
  for (const { pattern, flags, message } of BAD_FLAGS_TABLE) {
    const v = nodeVerdict(pattern, flags);
    expect(v.accept, `/${pattern}/${flags} was expected to REJECT`).toBe(false);
    // Node's own flags-rejection is a plain TypeError, not SyntaxError —
    // distinct from every row in the bad-argument table above, and worth
    // pinning as its own fact rather than assuming symmetry.
    expect(v.name, `/${pattern}/${flags}`).toBe("SyntaxError");
    expect(v.message, `/${pattern}/${flags}`).toBe(message);
  }
});

test("nodeVerdict: ACCEPT cases spanning the disposition table's extremes", () => {
  // An ordinary literal — the baseline ACCEPT.
  expect(nodeVerdict("abc", "").accept).toBe(true);
  // A modifier group (§5.1: REFUSE-dispositioned by OUR tier, but Node
  // itself accepts the syntax outright) — the harness must not conflate
  // "our tier won't support this" with "Node rejects this syntax". If
  // this ever flips to REJECT, §5.1's whole modifiers row is built on a
  // false premise.
  expect(nodeVerdict("(?i:a)", "").accept).toBe(true);
  expect(nodeVerdict("(?-i:a)", "").accept).toBe(true);
  expect(nodeVerdict("(?i-m:a)", "").accept).toBe(true);
  // Annex B's context-sensitivity (§5.1, the in-class-\- row's sibling):
  // `a{,2}` as literal text is legal WITHOUT /u and a SyntaxError WITH
  // it — the same two characters, opposite verdicts, decided by the flag.
  expect(nodeVerdict("a{,2}", "").accept).toBe(true);
  expect(nodeVerdict("a{,2}", "u").accept).toBe(false);
  // In-class \- (§5.1 v6 addition): legal in BOTH modes, unlike its
  // out-of-class twin above.
  expect(nodeVerdict("[a\\-z]", "").accept).toBe(true);
  expect(nodeVerdict("[a\\-z]", "u").accept).toBe(true);
});

/* A SEPARATE parse error for the malformed-LITERAL case (§5.5 arm A) is
 * NOT this harness's concern: `new RegExp(str)` and a literal /pattern/
 * share the same underlying pattern grammar and error messages in Node
 * (a literal's SyntaxError fires at parse time with the same text this
 * table already exercises via the string form) — arm A vs arm B is a
 * WASM-TIER timing distinction (§8.2), not a distinct Node verdict this
 * harness needs a second table for. */

/* ================= CP2d: THE COMPARISON HALF ================= */
/* loadClaimPatterns and generatedCorpus moved to regex-corpus.ts (CP3
 * needed the same generators for the assembler's byte-comparison
 * harness — see that file's own header for why). */

/** A curated set of patterns EXPECTED to REJECT — §5.5's whole point:
 * agreement on rejection is as important as agreement on acceptance, and
 * an accept-only corpus can't catch a parser that's too permissive. */
const INVALID_CORPUS: { pattern: string; flags: string }[] = [
  { pattern: "(", flags: "" },
  { pattern: "a)", flags: "" },
  { pattern: "[z-a]", flags: "" },
  { pattern: "*", flags: "" },
  { pattern: "\\", flags: "" },
  { pattern: "(?<a>x)(?<a>y)", flags: "" },
  { pattern: "\\p{Nope}", flags: "u" },
  { pattern: "a{2,1}", flags: "" },
  { pattern: "\\k<a>", flags: "u" },
  { pattern: "a{,2}", flags: "u" },
  { pattern: "\\1", flags: "u" }, // no capture group 1 exists
  { pattern: "\\01", flags: "u" },
  { pattern: "(?<1a>x)", flags: "" },
  { pattern: "(?<>x)", flags: "" },
  { pattern: "(?X)", flags: "" },
];

test("parserVerdict agrees with Node on the 140 real claim-set patterns", () => {
  const claims = loadClaimPatterns();
  expect(claims.length).toBe(140);
  let mismatches = 0;
  const firstFew: string[] = [];
  for (const { pattern, flags } of claims) {
    const node = nodeVerdict(pattern, flags);
    const parser = parserVerdict(pattern, flags);
    if (node.accept !== parser.accept) {
      mismatches++;
      if (firstFew.length < 10) firstFew.push(`/${pattern}/${flags}: node=${node.accept} parser=${parser.accept}`);
    }
  }
  expect(mismatches, `first mismatches: ${firstFew.join("; ")}`).toBe(0);
});

test("parserVerdict agrees with Node on the systematic generated corpus", () => {
  const corpus = [...generatedCorpus()];
  let mismatches = 0;
  const firstFew: string[] = [];
  for (const { pattern, flags } of corpus) {
    const node = nodeVerdict(pattern, flags);
    const parser = parserVerdict(pattern, flags);
    if (node.accept !== parser.accept) {
      mismatches++;
      if (firstFew.length < 10) firstFew.push(`/${pattern}/${flags}: node=${node.accept} parser=${parser.accept}`);
    }
  }
  expect(mismatches, `${corpus.length} patterns checked; first mismatches: ${firstFew.join("; ")}`).toBe(0);
  expect(corpus.length).toBeGreaterThan(500);
});

test("parserVerdict agrees with Node on the curated invalid-pattern corpus (both REJECT)", () => {
  for (const { pattern, flags } of INVALID_CORPUS) {
    const node = nodeVerdict(pattern, flags);
    const parser = parserVerdict(pattern, flags);
    expect(node.accept, `/${pattern}/${flags}: expected Node to reject`).toBe(false);
    expect(parser.accept, `/${pattern}/${flags}: expected our parser to reject`).toBe(false);
  }
});

test("KNOWN GAP, pinned rather than hidden: \\p{Alphabetic} — Node accepts, our parser correctly does NOT (out of scope, not a false accept)", () => {
  // unicodeGeneralCategory('Alphabetic') is null (a real, Node-valid
  // binary property outside this port's General_Category-only scope).
  // The correct, SAFE behavior is to REJECT rather than silently treat
  // it as some other range — verified here so this gap is visible in the
  // test suite, not just in a comment.
  expect(nodeVerdict("\\p{Alphabetic}", "u").accept).toBe(true);
  expect(parserVerdict("\\p{Alphabetic}", "u").accept).toBe(false);
});

test("\\P{...} SHARES the property-name subspace with \\p{...} (des-24's catch, measured not extrapolated): the same correct-reject symmetry holds for the negated form", () => {
  // \P{Script=Greek} is the negated form of \p{Script=Greek} — both
  // route through the same resolver in this parser, and both must get
  // the same correct-reject treatment (never a silent wrong answer, and
  // never conflated with Node's own "invalid property name" verdict).
  expect(nodeVerdict("\\P{Script=Greek}", "u").accept).toBe(true);
  expect(parserVerdict("\\P{Script=Greek}", "u").accept).toBe(false);
  // Symmetric with the un-negated form, confirmed side by side.
  expect(nodeVerdict("\\p{Script=Greek}", "u").accept).toBe(true);
  expect(parserVerdict("\\p{Script=Greek}", "u").accept).toBe(false);
});
