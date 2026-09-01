/* INC-24 P1, CP4 back half: design §6.1's SAMPLED instrument — "match
 * RESULTS over a generated (pattern, subject) corpus, compared against
 * Node. Random pairs, seeded, with the seed recorded so a failure
 * replays" — run through THIS PORT'S REAL pipeline end to end: the
 * real parser (regex-parser.ts), the real assembler (assemble()), and
 * the real interpreter (exec()). Unlike the canonicalize/case-closure
 * sweeps (hand-built bytecode, deliberately isolating exec()'s own
 * canonicalization logic from the assembler), THIS corpus exercises
 * the WHOLE compile pipeline together, because match RESULTS over
 * arbitrary generated patterns is exactly the risk the assembler-vs-
 * lre_compile byte gate and the parser-verdict gate do NOT cover on
 * their own: byte-identical bytecode and a right/wrong parse verdict
 * both stop short of "does the compiled program actually MATCH the
 * same things Node does," which is what a live regex is used for.
 *
 * 3,000 (pattern, subject, startIndex) triples, seed RECORDED (below)
 * so a failure replays exactly. Riders (mini-plan §b, lead-approved):
 *   - startIndex varies via Node's own /g+lastIndex: for each (pattern,
 *     subject) a NON-sticky, GLOBAL Node regex finds real match
 *     positions in the subject; those positions (plus 0, subject
 *     length, and a couple of uniform-random positions) are the
 *     CANDIDATE startIndex draws, weighted 50/50 toward an actual
 *     match position vs a boundary/random one — real hit diversity,
 *     not indices chosen blind to the pattern.
 *   - weighted toward backreferences/lookbehind/nested quantifiers: the
 *     pattern draw is 50/50 between a GENERAL pool (regex-corpus.ts's
 *     own generatedCorpus() + the 140 real claim patterns) and a RISK
 *     pool (every generated pattern containing \N/\k<name>/(?<=/(?<! —
 *     tagged from the SAME general pool, not a separate list, so it
 *     can never drift out of sync with it — PLUS a small set of hand-
 *     added nested-quantifier bodies the general pool doesn't have at
 *     all: (a+)+, (a*)*, (a+)*b, (a*)+b, (ab+)+, (a|b)*c, (a+b*)+).
 *
 * MECHANISM for running arbitrary compiled patterns without a per-
 * pattern module rebuild: bytecode/subject bytes for every DISTINCT
 * pattern/subject in the draw are interned ONCE each (module.ts's own
 * exact-match dedup, so a repeated pattern or subject costs once), and
 * TWO generic exported functions (bcLitAt(offset,length),
 * subjLitAt(offset,length)) build the actual arrayref via
 * array.new_data with those RUNTIME i32 parameters — the SAME
 * instruction the existing per-case bcLit(i)/subjLit(i) harness uses,
 * just with the offset/length as ordinary runtime operands instead of
 * i32Const literals baked in per case (wasm's array.new_data takes
 * offset/length off the operand stack; nothing requires them to be
 * compile-time constants). This keeps the module to a handful of
 * exported functions regardless of corpus size — no big if-chain, no
 * 65,960-style array.new_fixed pressure (patterns/subjects here are
 * genuinely variable-length, unlike the canonicalize sweep's fixed
 * 16-byte char_i shape, so array.new_data's runtime-offset form is the
 * right tool here, not array.new_fixed).
 */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { assemble, type AssembleFlags } from "../src/backend/wasm/regex-assembler.js";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";
import { RE_HEADER_REGISTER_COUNT } from "../src/backend/wasm/regex-opcodes.js";
import { generatedCorpus, loadClaimPatterns } from "./regex-corpus.js";

const SEED = 424242; // RECORDED — a failure here replays exactly with this seed.

function makeRng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const NESTED_QUANTIFIER_BODIES = ["(a+)+", "(a*)*", "(a+)*b", "(a*)+b", "(ab+)+", "(a|b)*c", "(a+b*)+"];

function isRisky(pattern: string): boolean {
  return /\\[1-9]|\\k</.test(pattern) || pattern.includes("(?<=") || pattern.includes("(?<!") || NESTED_QUANTIFIER_BODIES.includes(pattern);
}

interface PoolEntry {
  pattern: string;
  flags: string;
}

function buildPools(): { general: PoolEntry[]; risk: PoolEntry[] } {
  const general: PoolEntry[] = [];
  const risk: PoolEntry[] = [];
  for (const { pattern, flags } of generatedCorpus()) {
    general.push({ pattern, flags });
    if (isRisky(pattern)) risk.push({ pattern, flags });
  }
  for (const { pattern, flags } of loadClaimPatterns()) {
    general.push({ pattern, flags });
    if (isRisky(pattern)) risk.push({ pattern, flags });
  }
  for (const pattern of NESTED_QUANTIFIER_BODIES) {
    for (const flags of ["", "i"]) risk.push({ pattern, flags });
  }
  return { general, risk };
}

/** A crude but effective pattern-literal extractor: strips regex
 * metacharacters, keeping plain letters/digits so generated subjects
 * share vocabulary with the pattern (realistic hit probability)
 * instead of being uniformly unrelated random noise. */
function literalCharsOf(pattern: string): string {
  const chars = pattern.match(/[a-zA-Z0-9]/g);
  return chars ? chars.join("") : "abc";
}

const GENERIC_ALPHABET = "abcXYZ012 \t";

function randomSubject(rng: () => number, pattern: string): string {
  const alphabet = literalCharsOf(pattern) + GENERIC_ALPHABET;
  const len = Math.floor(rng() * 13); // 0..12
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}

/** The /g+lastIndex rider: real Node match positions in `subject` for
 * `pattern`, found via a NON-sticky global regex — these are the
 * "interesting" startIndex candidates, since a uniformly random index
 * over a restrictive pattern would almost always draw a trivial
 * no-match. */
function realMatchStarts(pattern: string, flags: string, subject: string): number[] {
  try {
    const re = new RegExp(pattern, flags.replace("y", "") + "g");
    const starts: number[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(subject)) !== null && guard++ < 50) {
      starts.push(m.index);
      if (m[0].length === 0) re.lastIndex++; // avoid an infinite loop on a zero-width match
    }
    return starts;
  } catch {
    return [];
  }
}

interface CorpusEntry {
  pattern: string;
  flags: string;
  subject: string;
  startIndex: number;
}

function buildCorpus(count: number): CorpusEntry[] {
  const rng = makeRng(SEED);
  const { general, risk } = buildPools();
  const entries: CorpusEntry[] = [];
  let guard = 0;
  while (entries.length < count && guard++ < count * 20) {
    const useRisk = rng() < 0.5 && risk.length > 0;
    const pool = useRisk ? risk : general;
    const { pattern, flags } = pool[Math.floor(rng() * pool.length)]!;
    // This corpus is about MATCH RESULTS, not the /iu fence (§6.3) or
    // the unported-\p{}-property split (errata item 2) — both already
    // covered by their own dedicated gates. Skip anything this port
    // refuses to parse at all so a REFUSAL doesn't masquerade as a
    // match-result mismatch here.
    const parsed = parsePattern(pattern, 0, flags.includes("u"), flags.includes("i"), flags.includes("m"), flags.includes("s"));
    if (parsed === null || parsed.next !== pattern.length) continue;
    const subject = randomSubject(rng, pattern);
    const starts = realMatchStarts(pattern, flags, subject);
    let startIndex: number;
    if (starts.length > 0 && rng() < 0.5) {
      startIndex = starts[Math.floor(rng() * starts.length)]!;
    } else {
      const boundaryOrRandom = rng();
      if (boundaryOrRandom < 0.3) startIndex = 0;
      else if (boundaryOrRandom < 0.6) startIndex = subject.length;
      else startIndex = Math.floor(rng() * (subject.length + 1));
    }
    entries.push({ pattern, flags, subject, startIndex });
  }
  return entries;
}

interface CorpusExports {
  exec: (bc: unknown, subject: unknown, startIndex: number, captureOut: unknown) => number;
  newCaptureArray: (count: number) => unknown;
  capAt: (arr: unknown, i: number) => number;
  bcLitAt: (offset: number, length: number) => unknown;
  subjLitAt: (offset: number, length: number) => unknown;
}

function strUnits(s: string): Uint8Array {
  const units = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    units[i * 2] = u & 0xff;
    units[i * 2 + 1] = u >> 8;
  }
  return units;
}

async function build(
  entries: CorpusEntry[],
  sticky: boolean,
): Promise<{
  ex: CorpusExports;
  bcOf: Map<string, { offset: number; length: number; captureCount: number; registerCount: number }>;
  subjOf: Map<string, { offset: number; length: number }>;
}> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const bcType = mb.arrayType("i8", false);
  const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
  const capType = mb.arrayType(I32, true);
  const capRef: ValType = { kind: "ref", nullable: true, typeIndex: capType };
  const interp = new RegexInterpreterBuilder(mb, strType);

  const bcOf = new Map<string, { offset: number; length: number; captureCount: number; registerCount: number }>();
  const subjOf = new Map<string, { offset: number; length: number }>();

  for (const e of entries) {
    const bcKey = `${e.pattern} ${e.flags}`;
    if (!bcOf.has(bcKey)) {
      const flags: AssembleFlags = {
        global: false,
        ignoreCase: e.flags.includes("i"),
        multiLine: e.flags.includes("m"),
        dotAll: e.flags.includes("s"),
        unicode: e.flags.includes("u"),
        sticky,
      };
      const parsed = parsePattern(e.pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll)!;
      const asm = assemble(parsed.ast, flags);
      const offset = mb.internData(asm.bytes);
      bcOf.set(bcKey, { offset, length: asm.bytes.length, captureCount: asm.captureCount, registerCount: asm.bytes[RE_HEADER_REGISTER_COUNT]! });
    }
    if (!subjOf.has(e.subject)) {
      const units = strUnits(e.subject);
      const offset = mb.internData(units);
      subjOf.set(e.subject, { offset, length: e.subject.length });
    }
  }

  const bcLitAtFn = mb.declareFunc(mb.funcType([I32, I32], [bcRef]), "bcLitAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayNewData(bcType, 0);
    mb.setBody(bcLitAtFn, [], c.bytes());
  }
  const subjLitAtFn = mb.declareFunc(mb.funcType([I32, I32], [strRef]), "subjLitAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayNewData(strType, 0);
    mb.setBody(subjLitAtFn, [], c.bytes());
  }
  const capAtFn = mb.declareFunc(mb.funcType([capRef, I32], [I32]), "capAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGet(capType);
    mb.setBody(capAtFn, [], c.bytes());
  }

  mb.exportFunc("bcLitAt", bcLitAtFn);
  mb.exportFunc("subjLitAt", subjLitAtFn);
  mb.exportFunc("capAt", capAtFn);
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  mb.exportFunc("exec", interp.exec());

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`corpus match-sweep module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return { ex: instance.exports as unknown as CorpusExports, bcOf, subjOf };
}

describe("regex corpus match-results sweep, seeded and real-pipeline (design §6.1's sampled instrument)", () => {
  test(
    `3,000-pair seeded (pattern, subject, startIndex) corpus, seed=${SEED}, through the real parser+assembler+exec() pipeline vs Node`,
    async () => {
      const entries = buildCorpus(3000);
      expect(entries.length, "corpus generation must reach the target count").toBe(3000);
      const { ex, bcOf, subjOf } = await build(entries, true);

      let bad = 0;
      const badExamples: string[] = [];
      for (const e of entries) {
        const bc = bcOf.get(`${e.pattern} ${e.flags}`)!;
        const subj = subjOf.get(e.subject)!;
        // e.flags may carry a REAL corpus pattern's own g/y (loadClaimPatterns()
        // pulls actual source flags) — strip both and add 'y' unconditionally,
        // matching this port's assembler, which ALWAYS compiles sticky
        // (AssembleFlags.sticky:true above, regardless of the pattern's own flags).
        const nodeRe = new RegExp(e.pattern, e.flags.replace(/[gy]/g, "") + "y");
        nodeRe.lastIndex = e.startIndex;
        const nodeMatch = nodeRe.exec(e.subject);

        const bcArr = ex.bcLitAt(bc.offset, bc.length);
        const subjArr = ex.subjLitAt(subj.offset, subj.length);
        const captureOut = ex.newCaptureArray(bc.captureCount + Math.ceil(bc.registerCount / 2));
        const result = ex.exec(bcArr, subjArr, e.startIndex, captureOut);

        let mismatch = false;
        let detail = "";
        if (nodeMatch === null) {
          if (result !== 0) {
            mismatch = true;
            detail = "expected no match, exec matched";
          }
        } else {
          if (result !== 1) {
            mismatch = true;
            detail = "expected a match, exec did not match";
          } else {
            const start = ex.capAt(captureOut, 0);
            const end = ex.capAt(captureOut, 1);
            if (start !== e.startIndex || end - start !== nodeMatch[0].length) {
              mismatch = true;
              detail = `capture 0 mismatch: exec [${start},${end}) vs node length ${nodeMatch[0].length}`;
            } else {
              for (let g = 1; g < bc.captureCount; g++) {
                const gStart = ex.capAt(captureOut, 2 * g);
                const gEnd = ex.capAt(captureOut, 2 * g + 1);
                if (nodeMatch[g] === undefined) {
                  if (gStart !== -1 || gEnd !== -1) {
                    mismatch = true;
                    detail = `capture ${g} should be unset`;
                  }
                } else if (gEnd - gStart !== nodeMatch[g]!.length) {
                  mismatch = true;
                  detail = `capture ${g} length mismatch`;
                }
              }
            }
          }
        }
        if (mismatch) {
          bad++;
          if (badExamples.length < 25) {
            badExamples.push(`/${e.pattern}/${e.flags} on ${JSON.stringify(e.subject)}@${e.startIndex}: ${detail}`);
          }
        }
      }
      expect(bad, `${bad} of ${entries.length} mismatched (seed=${SEED}):\n${badExamples.join("\n")}`).toBe(0);
    },
    120_000,
  );

  // NON-STICKY SLICE (lead's rider, alongside the hand-picked shapes in
  // wasm-regex-nonsticky-prelude.test.ts): the SAME 3,000-entry corpus,
  // re-assembled with sticky:false so every pattern gets the real
  // search-loop prelude (regex-assembler.ts:716-723), compared against
  // Node's own non-sticky search oracle (a GLOBAL regex with lastIndex
  // set — the correct oracle for "search from startIndex", design
  // §3.1's own operation surface: search/test/match/... are all
  // non-sticky). Reuses buildCorpus()'s own startIndex draws (already
  // drawn via /g+lastIndex, so already meaningful search-start points)
  // rather than a second independent draw — same 3,000 pairs, a
  // DIFFERENT assembly and a DIFFERENT oracle.
  test(
    `same 3,000-pair corpus (seed=${SEED}), NON-STICKY: the real search-loop prelude through exec() vs Node's own global-search oracle`,
    async () => {
      const entries = buildCorpus(3000);
      const { ex, bcOf, subjOf } = await build(entries, false);

      let bad = 0;
      const badExamples: string[] = [];
      for (const e of entries) {
        const bc = bcOf.get(`${e.pattern} ${e.flags}`)!;
        const subj = subjOf.get(e.subject)!;
        const nodeRe = new RegExp(e.pattern, e.flags.replace(/[gy]/g, "") + "g");
        nodeRe.lastIndex = e.startIndex;
        const nodeMatch = nodeRe.exec(e.subject);

        const bcArr = ex.bcLitAt(bc.offset, bc.length);
        const subjArr = ex.subjLitAt(subj.offset, subj.length);
        const captureOut = ex.newCaptureArray(bc.captureCount + Math.ceil(bc.registerCount / 2));
        const result = ex.exec(bcArr, subjArr, e.startIndex, captureOut);

        let mismatch = false;
        let detail = "";
        if (nodeMatch === null) {
          if (result !== 0) {
            mismatch = true;
            detail = "expected no match anywhere from startIndex, exec matched";
          }
        } else {
          if (result !== 1) {
            mismatch = true;
            detail = "expected the prelude to find a match, exec did not match";
          } else {
            const start = ex.capAt(captureOut, 0);
            const end = ex.capAt(captureOut, 1);
            // start is the PRELUDE'S OWN found position — must equal
            // Node's own match.index, NOT e.startIndex (that's the
            // sticky-comparison invariant; here it would be wrong).
            if (start !== nodeMatch.index || end - start !== nodeMatch[0].length) {
              mismatch = true;
              detail = `capture 0 mismatch: exec found [${start},${end}) vs node's real match at index ${nodeMatch.index}, length ${nodeMatch[0].length}`;
            } else {
              for (let g = 1; g < bc.captureCount; g++) {
                const gStart = ex.capAt(captureOut, 2 * g);
                const gEnd = ex.capAt(captureOut, 2 * g + 1);
                if (nodeMatch[g] === undefined) {
                  if (gStart !== -1 || gEnd !== -1) {
                    mismatch = true;
                    detail = `capture ${g} should be unset`;
                  }
                } else if (gEnd - gStart !== nodeMatch[g]!.length) {
                  mismatch = true;
                  detail = `capture ${g} length mismatch`;
                }
              }
            }
          }
        }
        if (mismatch) {
          bad++;
          if (badExamples.length < 25) {
            badExamples.push(`/${e.pattern}/${e.flags} (search) on ${JSON.stringify(e.subject)}@${e.startIndex}: ${detail}`);
          }
        }
      }
      expect(bad, `${bad} of ${entries.length} mismatched, non-sticky (seed=${SEED}):\n${badExamples.join("\n")}`).toBe(0);
    },
    120_000,
  );
});
