/* The arm rounds of one build (units U2a/U2b, SEMANTICS.md S128): which
 * slots take U2's dynamic arm, which speculative bindings fall back to an
 * exact-fit copy, and which pass's module the build keeps. lowerToIr
 * supplies `pass`, one fresh emit Lowerer over the given site sets; this
 * module only decides which sets to try, in which order. */
import type { LowerResult, Lowerer } from "./lowerer.js";

/** How many further passes U2a's dynamic arm may take (each adds the
 * crossings the previous one's S125 (c) judgement refused). */
const DYN_ARM_ROUNDS = 6;

export interface ArmPass {
  emit: Lowerer;
  result: LowerResult;
  /** The module lowered and, when the pass took an arm, validated. */
  ok: boolean;
}

export type ArmPassFn = (dynArmSites: ReadonlySet<string>, noSpec: ReadonlySet<string>, exactSites: ReadonlySet<string>) => ArmPass;

export interface ArmOutcome {
  emit: Lowerer;
  result: LowerResult;
  dynArmSites: Set<string>;
  noSpec: Set<string>;
  exactSites: Set<string>;
}

/** Unit U2a (dyn-arm.ts): a dynamic value entering a contained typed slot
 * takes the dynamic arm in a further pass — every crossing S125 (c)
 * refused (until no new one appears), and the judged copies it accepted.
 * Unit U2b: a pass whose speculative bindings fail to lower retries with
 * them bound by an exact-fit copy (noSpec). A slot whose arm did not build
 * falls back to the last pass that built, with that slot's copy taking only
 * exactly-fitting values (exactSites): never a silent width copy where
 * the arm was meant (SEMANTICS.md S128 (a3)). */
export function runArmRounds(pass: ArmPassFn): ArmOutcome {
  let dynArmSites: Set<string> = new Set();
  let noSpec: Set<string> = new Set();
  let exactSites: Set<string> = new Set();
  let emit: Lowerer;
  let result: LowerResult;
  let built: { emit: Lowerer; result: LowerResult; sites: Set<string>; noSpec: Set<string> } | null = null;
  const seenSpec = new Set<string>();
  let round0Spec = false;
  for (let round = 0; ; round++) {
    const p = pass(dynArmSites, noSpec, exactSites);
    emit = p.emit;
    result = p.result;
    for (const k of emit.specKeys) seenSpec.add(k);
    if (round === 0) round0Spec = emit.specKeys.size > 0;
    if (p.ok) built = { emit, result, sites: dynArmSites, noSpec };
    if (round >= DYN_ARM_ROUNDS) break;
    if (p.ok) {
      // A pass that builds may still hold refused crossings: a compiled
      // package's JavaScript defers its S125 refusals to where they run
      // (zod's module-load `NEVER`); those slots try the arm as well.
      const soft = [...emit.dynArmSoft, ...emit.dynArmRetry].filter((k) => !dynArmSites.has(k));
      if (soft.length === 0) break;
      dynArmSites = new Set([...dynArmSites, ...soft]);
      continue;
    }
    // A failed pass also tries its accepted copies on the arm: the typed
    // copy may be what the failing construct needed (`t.length = 0`).
    const fresh = [...emit.dynArmRetry, ...emit.dynArmSoft].filter((k) => !dynArmSites.has(k));
    if (fresh.length > 0) {
      dynArmSites = new Set([...dynArmSites, ...fresh]);
      continue;
    }
    const spec = (emit.specRetry.size > 0 ? [...emit.specRetry] : [...emit.specKeys]).filter((k) => !noSpec.has(k));
    if (spec.length > 0) {
      noSpec = new Set([...noSpec, ...spec]);
      continue;
    }
    break;
  }
  // Nothing built: the arms may have been what failed (a site found under
  // speculation that the eager copy never needed) — no arm, every
  // speculative binding an exact-fit copy.
  if (built === null && round0Spec) {
    const allSpec = new Set([...noSpec, ...seenSpec]);
    const p = pass(new Set(), allSpec, new Set());
    if (p.ok) built = { emit: p.emit, result: p.result, sites: new Set(), noSpec: allSpec };
  }
  // A later pass's arms failed: the slots they tried and the pass that built
  // left as copies take only exactly-fitting values.
  if (built !== null && built.result !== result) {
    const failed = new Set([...dynArmSites].filter((k) => !built!.sites.has(k)));
    if (failed.size > 0) {
      const p = pass(built.sites, built.noSpec, failed);
      if (p.ok) {
        built = { emit: p.emit, result: p.result, sites: built.sites, noSpec: built.noSpec };
        exactSites = failed;
      }
    }
    ({ emit, result } = built);
    dynArmSites = built.sites;
    noSpec = built.noSpec;
  }
  return { emit, result, dynArmSites, noSpec, exactSites };
}
