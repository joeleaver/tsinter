/* The --npm-static opt-in: compile a named npm package's shipped JS
 * STATICALLY, as ordinary program modules, instead of island-running it
 * under --dynamic.
 *
 * The doctrine (slice 2 of the npm story): a package that ships readable,
 * unminified JS alongside its .d.ts can compile through the same
 * JS/CommonJS frontend the program's own JS files use — inference (JSDoc
 * included) types the bodies, and every statement the lowering cannot
 * honor becomes the standard JS runtime fence (the trap throws AT the
 * statement if the program ever drives it — trust-but-verify, never
 * silent trust). The .d.ts is deliberately DROPPED from the opted-in
 * package's resolution: a declaration is a CLAIM about the body, and the
 * compiled artifact must be built from what the body provably is, not
 * from what the declaration says it should be. Program-side use sites
 * therefore typecheck against the INFERRED export surface; where the
 * package's own JSDoc (usually written against that same .d.ts) types a
 * boundary, the declared types flow in through inference and the runtime
 * fences guard the sites the checker could not prove.
 *
 * MECHANISM. Resolution is the single lever:
 *   - tsgo's server-side resolution reads package.json and probes sibling
 *     .d.ts files through the host's virtual-FS hooks, so an opted-in
 *     package's package.json is SHADOWED (its "types"/"typings" fields and
 *     every "types" condition inside "exports" removed), its shipped
 *     declaration files are HIDDEN (fileExists answers false), and its
 *     @types twin is hidden whole — the bundler resolution then lands on
 *     the shipped JS, which allowJs + maxNodeModuleJsDepth admit into the
 *     program as checkable source.
 *   - scriptc's own resolver (resolve.ts) mirrors the same answer: for an
 *     opted-in package the types pass is skipped, the "types" export
 *     condition is dropped, and the @types mangling never runs.
 * Both worlds agreeing, the package's entry (and its internal relative
 * graph) joins userFiles/moduleOrder exactly like program JS, and the
 * whole existing CJS/ESM module machinery — require discipline, the CJS
 * lexer link check, export-identity analysis, %init ordering — applies
 * unchanged.
 *
 * FAILURE MODE: all-or-nothing per package, island fallback. A preflight
 * diagnostic anchored in an opted-in package's files (an unsupported
 * require form, an unshimmed builtin, a resolution miss) marks the
 * package as an OFFENDER; the frontend rebuilds without it and the
 * import takes today's island path (--dynamic) or the requires-dynamic
 * diagnostic (static builds). The fallback is reported in the coverage
 * report, never as a build failure. Checker errors inside opted-in
 * package files do NOT fail preflight and do NOT trigger fallback: the
 * package's author checked it under a different tsconfig, the program's
 * author cannot fix it, and the JS design already says where inference
 * gaps land — the per-statement runtime fences.
 *
 * STATE. One compile at a time: the active set is module state, written
 * by loadProgram (empty when the flag is off) and read by resolve.ts,
 * program.ts, and the lowering. The CLI and the test harness both drive
 * whole compiles sequentially per process, and every loadProgram resets
 * the state, so a flagless compile after a flagged one sees a clean
 * slate. */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { reduceConditionTargets, type WrapperSubstitution } from "./node-conditions.js";
import { rewriteBundlerCjsExports } from "./npm-static-rewrite.js";
import { npmPackageNameOf, registerWorkspacePackage, workspacePackageOfPath } from "./shared.js";

let activePackages: ReadonlySet<string> = new Set();

/** Offender records of the CURRENT load attempt: packages whose static
 * compilation the preflight had to refuse, with the first reason. The
 * frontend's fallback loop consumes these and rebuilds without them. */
const offenders = new Map<string, string>();

/** Per-load cache of the bundler-CJS export rewrite (npm-static-rewrite.ts):
 * the host probes the same file many times, and the rewrite parses. */
const rewriteCache = new Map<string, string | null>();

export function setNpmStaticPackages(packages: Iterable<string>): void {
  activePackages = new Set(packages);
  offenders.clear();
  rewriteCache.clear();
  untypedPkgCache.clear();
  realpathProbed.clear();
}

export function npmStaticActive(): boolean {
  return activePackages.size > 0;
}

export function npmStaticPackages(): ReadonlySet<string> {
  return activePackages;
}

export function isNpmStaticPackage(name: string | null): boolean {
  return name !== null && activePackages.has(name);
}

/** The opted-in package a path belongs to, or null. Attribution uses the
 * INNERMOST node_modules segment (a nested install is its own package);
 * paths with NO node_modules segment consult the workspace registry — an
 * opted-in WORKSPACE package's files live at realpaths outside every
 * node_modules (the symlinked-install shape), and they are that package's
 * files for every consumer of this answer: the fallback loop's offender
 * attribution, the checker-error suppression, and the program-source
 * classification (islandJsFile/userFiles) all agree the opt-in claims
 * them. */
export function npmStaticPackageOfPath(path: string): string | null {
  const pkg = npmPackageNameOf(path);
  if (pkg !== null) return activePackages.has(pkg) ? pkg : null;
  const ws = workspacePackageOfPath(path.split("\\").join("/"));
  return ws !== null && activePackages.has(ws) ? ws : null;
}

/** Records why a package cannot compile statically this attempt (first
 * reason wins — one line per package in the coverage note). */
export function reportNpmStaticOffender(pkg: string, reason: string): void {
  if (activePackages.has(pkg) && !offenders.has(pkg)) offenders.set(pkg, reason);
}

export function npmStaticOffenders(): ReadonlyMap<string, string> {
  return offenders;
}

/** The DefinitelyTyped name mangling ("@scope/pkg" → "scope__pkg") — the
 * @types twin that must hide alongside the package's own declarations. */
function mangledTypesName(name: string): string {
  return name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
}

/** See shadowTargetOf: realpaths an opted-in package's node_modules dir
 * once per load and registers workspace-symlinked installs. */
const realpathProbed = new Set<string>();

function registerWorkspaceRealpath(pkg: string, nmDir: string): void {
  if (realpathProbed.has(nmDir)) return;
  realpathProbed.add(nmDir);
  try {
    const real = realpathSync(nmDir).split("\\").join("/");
    if (real !== nmDir && !real.includes("/node_modules/")) registerWorkspacePackage(pkg, real);
  } catch {
    /* dangling symlink / missing dir — nothing to register */
  }
}

/** node_modules path classification for the fs shadow: which opted-in
 * package (if any) the path is inside, and whether it is inside that
 * package's @types twin instead. A path with no node_modules segment can
 * still be an opted-in WORKSPACE package's real home (the symlinked
 * install's realpath — loadProgram registers those before the host is
 * created, so probes along the package's internal relative edges hide the
 * declaration twins too). */
function shadowTargetOf(path: string): { pkg: string; viaTypes: boolean } | null {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) {
    const ws = workspacePackageOfPath(norm);
    return ws !== null && activePackages.has(ws) ? { pkg: ws, viaTypes: false } : null;
  }
  const rest = norm.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  if (activePackages.has(dirName)) {
    /* An opted-in package first seen through a node_modules path may be a
     * WORKSPACE SYMLINK whose realpath escapes node_modules — and the
     * host reads file CONTENT at realpaths, where nothing path-shaped
     * marks the package. The entry-anchored probe in loadProgram misses
     * nested realms (a monorepo driver outside every package realm), so
     * the shadow registers the realpath the moment resolution touches the
     * symlink — always before any content read along it. */
    registerWorkspaceRealpath(dirName, `${norm.slice(0, idx)}/node_modules/${dirName}`);
    return { pkg: dirName, viaTypes: false };
  }
  if (first === "@types") {
    const mangled = parts[1] ?? "";
    for (const pkg of activePackages) {
      if (mangledTypesName(pkg) === mangled) return { pkg, viaTypes: true };
    }
  }
  return null;
}

/** A CJS-first substitution the transform made (node-conditions.ts). */
export type NpmStaticWrapperSubstitution = WrapperSubstitution;

/** The opted-in package.json transform, applied identically in BOTH
 * resolution worlds (the tsgo host's fs shadow and resolve.ts):
 *   1. every types claim goes — the top-level "types"/"typings" fields
 *      and every "types"/"typings" condition key inside "exports" /
 *      "imports" — so resolution lands on runtime JS;
 *   2. every condition object inside "exports" AND "imports" is REPLACED
 *      by Node's own answer for each syntax: `{ import: <Node's import
 *      target>, require: <Node's require target> }`
 *      (node-conditions.ts reduceConditionTargets). Both worlds then pick
 *      per importing syntax — an import statement takes the "import" key,
 *      a require() the "require" key — and land on the file Node loads
 *      (board #258: a dual package's import used to take its CJS entry;
 *      an "imports" alias's "node" target used to lose to "default"). The
 *      "node" condition (yaml's browser-vs-node split) and "module-sync"
 *      fall out of the same reduction;
 *   3. CJS-first, ONLY for a wrapper dual: when the import target is a
 *      named-export wrapper over a require target Node loads as CommonJS
 *      (wrapperShapeOf + nodeLoadsAsCjs — commander's esm.mjs), the
 *      "import" key takes the require target. Both sides evaluate the
 *      same CJS module, so the named imports the wrapper exports read the
 *      same values; the wrapper's re-export shape (`export const {…} =
 *      cjsDefault`) has no static lowering while the CJS side engages the
 *      CJS lexer link check and export-identity analysis. What the
 *      wrapper does NOT serve (a default it doesn't export, a namespace,
 *      a name outside its list) is checked at the import site (program.ts
 *      npmStaticWrapperOffence7, and the CJS link check for a wrapper name
 *      the CJS lexer cannot see) and makes the package an offender — never
 *      a silent different entry. Returned so resolve.ts can mark answers
 *      that went through one.
 * `pkgDir` locates the wrapper candidates; without it (no directory
 * known) no substitution happens and step 2 stands alone. */
export function npmStaticTransformPkgJson(
  pkg: Record<string, unknown>,
  pkgDir?: string,
): NpmStaticWrapperSubstitution[] {
  delete pkg["types"];
  delete pkg["typings"];
  return reduceConditionTargets(pkg, { keepTypes: false, ...(pkgDir !== undefined ? { wrapperPkgDir: pkgDir } : {}) });
}

/** npmStaticTransformPkgJson over a package.json TEXT (the fs shadow's
 * form; `pkgDir` is the document's directory). Malformed documents pass
 * through untouched — resolution reports them exactly as it always did. */
export function npmStaticTransformPkgJsonText(text: string, pkgDir?: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return text;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return text;
  npmStaticTransformPkgJson(doc as Record<string, unknown>, pkgDir);
  return JSON.stringify(doc);
}

/** True for declaration-file names (the claims the opted-in resolution
 * must not see). */
function isDeclarationFileName(path: string): boolean {
  return /\.d\.(ts|mts|cts)$/.test(path) || path.endsWith(".d.json.ts");
}

function isNodeModulesPathNorm(path: string): boolean {
  return path.split("\\").join("/").includes("/node_modules/");
}

/** Whether the package owning `path` is UNTYPED for the checker: no
 * "types"/"typings" claim, no root .d.ts entry, and no installed @types
 * twin along the walk-up — the packages whose flagless import surface is
 * `any` (see the any-surface stub in the fs shadow). Cached per package
 * directory for the load's lifetime. */
const untypedPkgCache = new Map<string, boolean>();

function packageIsUntyped(path: string): boolean {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) return false;
  const rest = norm.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  if (first.startsWith("@types")) return false; // a twin IS the types
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  const pkgDir = `${norm.slice(0, idx)}/node_modules/${dirName}`;
  const hit = untypedPkgCache.get(pkgDir);
  if (hit !== undefined) return hit;
  let untyped = true;
  try {
    const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, "utf8")) as Record<string, unknown>;
    if (pkg["types"] !== undefined || pkg["typings"] !== undefined) untyped = false;
    if (untyped && typeof pkg["exports"] === "object" && pkg["exports"] !== null) {
      // a "types" condition anywhere inside exports is a claim too
      untyped = !JSON.stringify(pkg["exports"]).includes('"types"');
    }
  } catch {
    /* no package.json — keep probing */
  }
  if (untyped && existsSync(`${pkgDir}/index.d.ts`)) untyped = false;
  if (untyped) {
    // the @types twin, hoisted anywhere up the realm chain
    const mangled = mangledTypesName(dirName);
    for (let dir = dirname(pkgDir); ; ) {
      const parent = dirname(dir);
      if (existsSync(`${dir}/node_modules/@types/${mangled}/package.json`) || existsSync(`${dir}/@types/${mangled}/package.json`)) {
        untyped = false;
        break;
      }
      if (parent === dir) break;
      dir = parent;
    }
  }
  untypedPkgCache.set(pkgDir, untyped);
  return untyped;
}

export interface NpmStaticFsShadow {
  /** Shadowed CONTENT for a real path (the types-stripped package.json),
   * or undefined (no shadow — fall through). */
  readFile: (path: string) => string | undefined;
  /** True when the path must not exist for the type-checker's resolution
   * (an opted-in package's shipped .d.ts, or its @types twin whole). */
  hideFile: (path: string) => boolean;
}

/** The virtual-FS shadow loadProgram hands the tsgo host — null when the
 * flag is off, so flagless compiles keep the exact host behavior. */
export function npmStaticFsShadow(): NpmStaticFsShadow | null {
  if (!npmStaticActive()) return null;
  return {
    readFile: (path) => {
      const target = shadowTargetOf(path);
      /* NON-OPTED node_modules JS: maxNodeModuleJsDepth (set only on
       * --npm-static loads) admits third-party JS the flagless build never
       * types, and an UNTYPED package's inferred surface would then
       * replace the `any` its imports contribute flagless — changing the
       * PROGRAM's own types under a flag that promised to touch only the
       * opted-in packages (the jaro-winkler shape: an @ts-ignore'd import
       * whose result feeds program arithmetic). Serve those files as the
       * any-surface stub instead: the import types exactly what the
       * flagless build typed. Typed packages (own .d.ts or an installed
       * @types twin) resolve types-first and never reach here. */
      if (!target) {
        if (
          (path.endsWith(".js") || path.endsWith(".cjs")) &&
          isNodeModulesPathNorm(path) &&
          !existsSync(path.replace(/\.(js|cjs)$/, ".d.ts")) && // a sibling .d.ts types this very file
          packageIsUntyped(path)
        ) {
          return "module.exports = (() => { let u; return u; })();\n";
        }
        return undefined;
      }
      if (target.viaTypes) return undefined;
      if (path.endsWith("/package.json") || path.endsWith("\\package.json")) {
        try {
          return npmStaticTransformPkgJsonText(readFileSync(path, "utf8"), dirname(path));
        } catch {
          return undefined;
        }
      }
      // Bundler-emitted CJS files get their export surface respelled in
      // the plain CJS both worlds model (npm-static-rewrite.ts) — the ONE
      // program serves checker and lowering, so the rewrite is the text
      // everywhere downstream (statement walks, the CJS lexer link check,
      // diagnostics rendering; original line offsets survive by
      // construction). A `degrade` answer (a __toESM interop construct the
      // recognizers cannot finish) marks the PACKAGE an offender with the
      // reason — the fallback loop islands it, never a failed build — and
      // the file serves untouched for the doomed load.
      if (path.endsWith(".js") || path.endsWith(".cjs")) {
        const hit = rewriteCache.get(path);
        if (hit !== undefined) return hit ?? undefined;
        let rewritten: string | null = null;
        try {
          const answer = rewriteBundlerCjsExports(readFileSync(path, "utf8"), path);
          if (answer !== null && typeof answer === "object") {
            reportNpmStaticOffender(target.pkg, answer.degrade);
          } else {
            rewritten = answer;
          }
        } catch {
          rewritten = null; // unreadable/unparseable: fall through untouched
        }
        rewriteCache.set(path, rewritten);
        return rewritten ?? undefined;
      }
      return undefined;
    },
    hideFile: (path) => {
      const target = shadowTargetOf(path);
      if (!target) return false;
      if (target.viaTypes) return true; // the @types twin hides whole
      return isDeclarationFileName(path);
    },
  };
}

/* ── auto-detection (--npm-static=auto) ─────────────────────────────────
 * The criteria the design doc names: the package ships its OWN .d.ts (a
 * declaration surface its author maintains against the JS — @types twins
 * are third-party claims and do not qualify), the runtime JS is readable
 * (unminified: real lines, ordinary line lengths), and the source shows
 * no build-transform markers (a bundled/transpiled dist is not the code
 * the author checked). Best-effort: a package that slips through and
 * fails preflight falls back to the island like any offender. */

/* Only a bundler RUNTIME disqualifies now: webpack's module registry has
 * no static story (the graph lives in numbered closures). The tsc/babel
 * __esModule stamp and esbuild's helper preambles used to disqualify too,
 * but the bundler-emitted CJS export rewrite (npm-static-rewrite.ts)
 * types the getter-table shapes and the offender attribution degrades a
 * package whose surface still breaks its consumers — so those bundles are
 * worth ATTEMPTING: eligible when the .d.ts and unminified criteria hold,
 * gracefully per-package-degraded when the attempt fails. */
const TRANSFORM_MARKERS = ["__webpack_require__"];

/** Unminified-JS heuristic over an entry source: at least two lines and
 * an average line length under 200 characters (minified dists are one
 * enormous line; readable code averages well under 100). */
export function looksUnminified(source: string): boolean {
  const lines = source.split("\n");
  if (lines.length < 2) return false;
  return source.length / lines.length <= 200;
}

export function hasTransformMarkers(source: string): boolean {
  return TRANSFORM_MARKERS.some((m) => source.includes(m));
}

/** Auto-mode eligibility for one candidate package: `typesFile` is what
 * the ordinary (types-first) resolution answered for the import,
 * `jsEntry` what the js-only resolution answers. Returns null when
 * eligible, else the human-readable reason it is not. */
export function npmStaticIneligibleReason(
  pkgName: string,
  typesFile: string,
  jsEntry: string | null,
): string | null {
  if (npmPackageNameOf(typesFile) !== pkgName) {
    return "its declared types come from a third-party @types package, not the package itself";
  }
  if (!/\.d\.(ts|mts|cts)$/.test(typesFile)) {
    return "it ships no own .d.ts declaration surface";
  }
  if (jsEntry === null) return "no runtime JS entry resolves";
  let source: string;
  try {
    source = readFileSync(jsEntry, "utf8");
  } catch {
    return `its runtime entry ${jsEntry} cannot be read`;
  }
  if (!looksUnminified(source)) return "its shipped JS looks minified";
  if (hasTransformMarkers(source)) {
    return "its shipped JS carries build-transform markers (bundled/transpiled dist)";
  }
  return null;
}
