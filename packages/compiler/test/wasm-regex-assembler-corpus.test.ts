/* INC-24 P1, CP3 gate leg (i)'s SECOND half (brief-p1.md §3: "assembler-
 * vs-lre_compile byte-identical over a generated pattern corpus" —
 * distinct from the parser-vs-Node verdict agreement half, already done
 * at CP2d in wasm-regex-verdict.test.ts). wasm-regex-assembler.test.ts's
 * 21 hand-picked construct tests are DEVELOPMENT instruments — built
 * smallest-first, one AST kind at a time, to convert design errors into
 * immediate byte diffs during construction. THIS file is the GATE
 * instrument: the full deduplicated corpus (the same generators CP2d's
 * verdict harness uses — claim-patterns.tsv's 140 real patterns plus
 * generatedCorpus()'s systematic grammar-production × flag sweep, see
 * regex-corpus.ts), run end to end (parse -> assemble -> compare) against
 * the live lre_compile oracle, in ONE batched subprocess call. */
import { expect, test } from "vitest";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { assemble, type AssembleFlags } from "../src/backend/wasm/regex-assembler.js";
import type { RegexAst } from "../src/backend/wasm/regex-ast.js";
import { lreCompileBatch } from "./regex-lre-oracle.js";
import { generatedCorpus, loadClaimPatterns } from "./regex-corpus.js";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function flagsFromString(flagStr: string): AssembleFlags {
  return {
    global: flagStr.includes("g"),
    ignoreCase: flagStr.includes("i"),
    multiLine: flagStr.includes("m"),
    dotAll: flagStr.includes("s"),
    unicode: flagStr.includes("u"),
    sticky: flagStr.includes("y"),
  };
}

/** claim patterns + generatedCorpus's productions × flag sweep,
 * deduplicated by the SAME `${pattern} ${flags}` key lreCompileBatch
 * itself uses (so a dedup here and the batch's own lookup never
 * disagree about identity). */
function buildCorpus(): { pattern: string; flags: string }[] {
  const all = [...loadClaimPatterns(), ...generatedCorpus()];
  const seen = new Set<string>();
  const deduped: { pattern: string; flags: string }[] = [];
  for (const c of all) {
    const key = `${c.pattern} ${c.flags}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
}

test("assemble() vs lre_compile: byte-identical over the FULL generated pattern corpus (gate leg (i))", () => {
  const corpus = buildCorpus();

  // Filter to patterns THIS PARSER accepts. Parser-vs-Node verdict
  // agreement is CP2d's own, separately-passing gate leg (both corpora,
  // zero mismatches, already proven) — re-checking node acceptance here
  // would just duplicate that harness. This gate leg is about the
  // ASSEMBLER: does it produce byte-identical output for whatever the
  // parser accepts. A pattern the parser rejects contributes no AST and
  // is simply not part of this instrument's scope.
  const accepted: { pattern: string; flags: string; ast: RegexAst }[] = [];
  for (const { pattern, flags } of corpus) {
    const parsed = parsePattern(pattern, 0, flags.includes("u"), flags.includes("i"), flags.includes("m"), flags.includes("s"));
    if (parsed === null || parsed.next !== pattern.length) continue;
    accepted.push({ pattern, flags, ast: parsed.ast });
  }

  // ONE batched subprocess call for the whole corpus, not one per
  // pattern (lreCompileBatch's whole reason to exist).
  const oracleResults = lreCompileBatch(accepted);

  let mismatches = 0;
  let iFlagCount = 0;
  const firstFew: string[] = [];
  for (const { pattern, flags, ast } of accepted) {
    if (flags.includes("i")) iFlagCount++;
    const ref = oracleResults.get(`${pattern} ${flags}`);
    if (ref === undefined || ref === null) {
      mismatches++;
      if (firstFew.length < 10) firstFew.push(`/${pattern}/${flags}: oracle returned null/missing`);
      continue;
    }
    let mine: { bytes: Uint8Array };
    try {
      mine = assemble(ast, flagsFromString(flags));
    } catch (e) {
      mismatches++;
      if (firstFew.length < 10) firstFew.push(`/${pattern}/${flags}: assemble() threw: ${(e as Error).message}`);
      continue;
    }
    if (hex(mine.bytes) !== hex(ref.bytes)) {
      mismatches++;
      if (firstFew.length < 10) firstFew.push(`/${pattern}/${flags}: mine=${hex(mine.bytes)} ref=${hex(ref.bytes)}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[gate leg (i), assembler corpus] deduped corpus=${corpus.length} accepted-by-parser(byte-compared)=${accepted.length} /i-flag-patterns=${iFlagCount} mismatches=${mismatches}`,
  );

  expect(mismatches, `first mismatches: ${firstFew.join("; ")}`).toBe(0);
  // A basic sanity floor (not the precise 400-600 prediction check,
  // which is a REPORTING requirement carried in prose, not a hardcoded
  // assertion bound here — the exact post-dedup, post-parse-filter size
  // depends on how much of the raw corpus survives both steps).
  expect(accepted.length).toBeGreaterThan(300);
});
