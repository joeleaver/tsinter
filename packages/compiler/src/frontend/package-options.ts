/* Per-package compiler options (SEMANTICS.md S136).
 *
 * In a multi-package project each package's files are checked the way that
 * package's own tsc checks them: under the file's NEAREST tsconfig.json
 * (extends followed), exactly the file the dev-runner loader
 * (tests/real-apps-top10/harness/node-src-loader.mjs) reads per file. Only
 * the ADOPTED knobs (shared.ts) are taken from it; the forced ones and the
 * type surface stay the entry's.
 *
 * One program still LOWERS the whole project. When the project's files
 * carry more than one adopted option set, that program runs with the
 * CHECK-ONLY knobs relaxed (they decide which programs are errors, never
 * which type a node has), and every option set gets its own check-only
 * program whose diagnostics gate that set's files. The TYPE-SHAPING knobs
 * (TYPE_SHAPING below) stay the entry's in the lowering program: where a
 * package's own value differs and the lowering program reports an error in
 * a file Node evaluates, the lowering's static types do not hold there and
 * the site refuses by name (SC0006).
 *
 * State is per load (reset by setPackageOptions), like the npm-static and
 * workspace registries. */

import { dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

/** The adopted knobs, raw (`strict` and its family unresolved), plus the
 * package's type surface under SURFACE_LIB / SURFACE_TYPES (sorted arrays;
 * never compiler options themselves). */
export type AdoptedOptions = Record<string, unknown>;

/** The set's adopted non-ECMAScript lib files ("lib.dom.d.ts", ...). */
export const SURFACE_LIB = "%lib";
/** The set's explicit "types" packages (`node` excluded). */
export const SURFACE_TYPES = "%types";

/** The strict family: an unset member takes `strict`'s value. */
const STRICT_FAMILY = new Set([
  "noImplicitAny",
  "noImplicitThis",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "useUnknownInCatchVariables",
  "alwaysStrict",
]);

/** Knobs that change the TYPE the checker gives a node (and so the
 * lowering's representation choices). strictNullChecks is also the floor. */
export const TYPE_SHAPING = [
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "useUnknownInCatchVariables",
] as const;

/** Knobs that only decide which programs are errors: relaxed to their
 * permissive value in a mixed project's lowering program. noImplicitAny and
 * noImplicitThis leave the implicit type `any` either way; exactOptional-
 * PropertyTypes changes assignability only; noUncheckedIndexedAccess off is
 * the setting every tsconfig-less program (the corpus) lowers under;
 * the decorator mode only changes how decorator CALLS are checked (a
 * legacy decorator that runs refuses in the lowering regardless). */
export const CHECK_ONLY_RELAXED: Readonly<Record<string, unknown>> = {
  noImplicitAny: false,
  noImplicitThis: false,
  strictPropertyInitialization: false,
  exactOptionalPropertyTypes: false,
  noUncheckedIndexedAccess: false,
  noImplicitOverride: false,
  noPropertyAccessFromIndexSignature: false,
  noImplicitReturns: false,
  noFallthroughCasesInSwitch: false,
  noUnusedLocals: false,
  noUnusedParameters: false,
  allowUnusedLabels: true,
  allowUnreachableCode: true,
  experimentalDecorators: undefined,
  emitDecoratorMetadata: undefined,
};

/** The effective value of a knob under a raw adopted set. */
export function effectiveOption(set: AdoptedOptions, key: string): unknown {
  const v = set[key];
  if (v !== undefined) return v;
  if (STRICT_FAMILY.has(key)) return set["strict"] === true;
  return undefined;
}

/** Knobs whose unset value differs from `false` (unset reports a
 * suggestion, `false` an error). */
const TRI_STATE = new Set(["allowUnreachableCode", "allowUnusedLabels"]);

/** A stable identity for an adopted set (effective values, sorted keys). */
export function optionSetKey(set: AdoptedOptions): string {
  const keys = new Set<string>([...Object.keys(set), ...STRICT_FAMILY]);
  keys.delete("strict");
  const out: Record<string, unknown> = {};
  for (const k of [...keys].sort()) {
    const v = effectiveOption(set, k);
    if (v === undefined || (v === false && !TRI_STATE.has(k))) continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}

/** True when two sets give some type-shaping knob different values. */
export function typeShapingDiffers(a: AdoptedOptions, b: AdoptedOptions): boolean {
  return TYPE_SHAPING.some((k) => (effectiveOption(a, k) === true) !== (effectiveOption(b, k) === true));
}

/* ── per-load state ───────────────────────────────────────────────────── */

let adoptedOf: (configFile: string) => AdoptedOptions = () => ({});
const nearestCache = new Map<string, string | null>();

/** Installs this load's tsconfig reader (the host's parser plus the
 * ADOPTED subset); clears every cache. */
export function setPackageOptions(reader: ((configFile: string) => AdoptedOptions) | null): void {
  const cache = new Map<string, AdoptedOptions>();
  adoptedOf = reader === null
    ? () => ({})
    : (configFile) => {
        let hit = cache.get(configFile);
        if (hit === undefined) cache.set(configFile, (hit = reader(configFile)));
        return hit;
      };
  nearestCache.clear();
}

/** The nearest tsconfig.json above `file` (the loader's nearestCfg). */
export function nearestTsconfig(file: string): string | null {
  const dir = dirname(resolve(file));
  return nearestFrom(dir);
}

function nearestFrom(dir: string): string | null {
  const cached = nearestCache.get(dir);
  if (cached !== undefined) return cached;
  const candidate = resolve(dir, "tsconfig.json");
  let answer: string | null;
  if (existsSync(candidate) && statSync(candidate).isFile()) answer = candidate;
  else {
    const up = dirname(dir);
    answer = up === dir ? null : nearestFrom(up);
  }
  nearestCache.set(dir, answer);
  return answer;
}

/** The adopted set that governs `file` ({} when no tsconfig is above it). */
export function adoptedOptionsFor(file: string): AdoptedOptions {
  const cfg = nearestTsconfig(file);
  return cfg === null ? {} : adoptedOf(cfg);
}

/** True when `file`'s own tsconfig enables TypeScript's legacy decorators:
 * Node under the loader then runs tsc's legacy decorator emit for it,
 * which the lowering does not implement (S136: such decorators refuse). */
export function legacyDecoratorsFor(file: string): boolean {
  return adoptedOptionsFor(file)["experimentalDecorators"] === true;
}
