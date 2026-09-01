/* INC-24 P1: the shared (pattern, flags) corpus generators — factored
 * out of wasm-regex-verdict.test.ts (CP2d) so CP3's assembler byte-
 * comparison harness (gate leg (i)'s OTHER half — "assembler-vs-
 * lre_compile byte-identical over a generated pattern corpus", brief-
 * p1.md §3) reuses the SAME generator instead of maintaining a second,
 * possibly-drifting copy. Both loadClaimPatterns and generatedCorpus are
 * pure data generation — no parser/oracle calls here, so this module has
 * no test-runner dependency and can be imported by any test file. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The 140 real claim-set (pattern, flags) pairs — the SAME fixture
 * bcsize.c's own trusted-fixture validation used at CP1 (copied in-repo
 * at test/fixtures/regex/claim-patterns.tsv so every harness that needs
 * it shares one source instead of each reaching out-of-repo to the
 * design's probes dir). Real, already-known-valid patterns from actual
 * corpus programs — the strongest possible baseline before adding
 * synthetic grammar-coverage patterns. */
export function loadClaimPatterns(): { pattern: string; flags: string }[] {
  const text = readFileSync(join(import.meta.dirname, "fixtures/regex/claim-patterns.tsv"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pattern, flags] = line.split("\t");
      return { pattern: pattern!, flags: flags ?? "" };
    });
}

/** A systematic (pattern, flags) generator over the grammar productions
 * this parser implements — deliberately EXCLUDES the fenced categories
 * design §6.1 names (Annex-B-only forms, /v, /iu combined, Script=/
 * binary \p{} properties): the point of the fence is that this
 * generator's EXHAUSTIVE-agreement claim doesn't extend to them, not
 * that they're silently assumed to work. Flag combos vary over i/m/s/u,
 * skipping any combo containing both i and u (and the (?i modifier-
 * group equivalent of i+u, per the same §6.3(a) fence). */
export function* generatedCorpus(): Generator<{ pattern: string; flags: string }> {
  const flagCombos = ["", "i", "m", "s", "u", "im", "ms", "su", "ims"];
  const bodies = [
    // literals, dot, anchors
    "a",
    "abc",
    ".",
    "^",
    "$",
    "^abc$",
    "a.c",
    // character classes
    "[abc]",
    "[a-z]",
    "[^a-z]",
    "[a-z0-9_]",
    "[\\d\\s\\w]",
    "[\\D\\S\\W]",
    "[\\]]",
    "[-a]",
    "[a-]",
    // quantifiers
    "a*",
    "a+",
    "a?",
    "a*?",
    "a+?",
    "a??",
    "a{2}",
    "a{2,}",
    "a{2,5}",
    "[a-z]+",
    "(?:ab)*",
    // groups
    "(a)",
    "(?:a)",
    "(?<n>a)",
    "(?=a)",
    "(?!a)",
    "(?<=a)",
    "(?<!a)",
    "(?i:a)",
    "(?-i:a)",
    "(?i-m:a)",
    "(a(b))(c)",
    // backreferences
    "(a)\\1",
    "\\1(a)",
    "(?<n>a)\\k<n>",
    "\\k<n>(?<n>a)",
    "(?<n>a)|(?<n>b)",
    // alternation
    "a|b",
    "a|b|c",
    "(a|b)c",
    "a|",
    "(?:)",
    // escapes
    "\\n",
    "\\t",
    "\\r",
    "\\f",
    "\\v",
    "\\xAB",
    "\\uABCD",
    "\\cA",
    "\\.",
    "\\(",
    "\\[",
    // word boundary / digit escapes
    "\\bfoo\\b",
    "\\Bfoo\\B",
    "\\0",
    "\\8",
    "\\9",
    // combined shapes
    "^(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})$",
    "(?:https?:\\/\\/)?[\\w.-]+",
    // quantified assertions (the coupling-audit finding, lead-ordered
    // corpus enlargement): ^ $ \b \B are NEVER quantifiable in Node;
    // lookahead is quantifiable ONLY forward+non-unicode (Annex B);
    // lookbehind is NEVER quantifiable in either mode. Cross-producted
    // against the SAME flagCombos below (including u vs non-u) so the
    // verdict harness holds this fix permanently, not just in the
    // hand-picked parser pins.
    "^*",
    "$*",
    "\\b*",
    "\\B*",
    "(?=a)*",
    "(?!a)*",
    "(?<=a)*",
    "(?<!a)*",
  ];
  for (const pattern of bodies) {
    for (const flags of flagCombos) {
      // A modifier group's LOCAL (?i:...) combined with an outer /u flag
      // is the SAME simple-case-folding hazard as a top-level /iu — Node
      // measurably accepts /(?i:a)/u (verified live), but it needs real
      // unicode case folding, which this port doesn't implement (§6.3).
      // §6.1 fences /iu from this generator's exhaustive-agreement claim;
      // this exclusion extends that fence to its modifier-group-shaped
      // equivalent, which the flag-string exclusion alone doesn't catch.
      if (flags.includes("u") && /\(\?i/.test(pattern)) continue;
      yield { pattern, flags };
    }
  }
  // /u-only bodies (astral escapes, \p{L}) — folded in separately so
  // they aren't cross-producted against non-u flag combos pointlessly.
  for (const pattern of ["\\u{1F600}", "\\p{L}", "\\p{L}+", "[\\p{L}\\d]", "\\P{L}"]) {
    for (const flags of ["u", "um", "us"]) {
      yield { pattern, flags };
    }
  }
}
