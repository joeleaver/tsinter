/* The --npm-static opt-in: compile a named npm package's shipped JS
 * STATICALLY, as ordinary program modules, instead of island-running it
 * under --dynamic.
 *
 * The doctrine (SEMANTICS.md S133, Joe's ruling 2026-11-11; it replaces
 * slice 2's "typecheck against the inferred surface"): a package that
 * ships readable, unminified JS alongside its .d.ts compiles through the
 * same JS/CommonJS frontend the program's own JS files use — inference
 * (JSDoc included) types the BODIES, and every statement the lowering
 * cannot honor becomes the standard JS runtime fence (the trap throws AT
 * the statement if the program ever drives it). The PROGRAM, though,
 * types against the package's SHIPPED declarations (its own .d.ts or the
 * @types twin), exactly as the project's own tsc does: the declared-
 * surface view below. A declaration is a CLAIM about the body, so the
 * compiled artifact is still built from the body — the checker facade
 * maps each declaration to the JS implementing it (dts-bridge.ts) — and
 * every claim is VERIFIED where a value crosses it (lowering/lower-dts.ts):
 * a value whose inferred type the declaration narrows is checked at the
 * crossing and a false claim ends the run by name; a dynamic value stays
 * dynamic and is checked where it enters typed storage (S128). A package
 * with no declarations keeps the inferred surface (and its old fallback).
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

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  dtsViews.clear();
}

/* ── the declared-surface view (SEMANTICS.md S133) ──────────────────────
 * An opted-in package's PROGRAM-side view is its shipped declarations (its
 * own .d.ts, or the @types twin), exactly what the project's own tsc
 * checks against; the package's JS is still what compiles. The two views
 * live in ONE tsgo program:
 *   - the package's real declaration files stay hidden (the package's own
 *     JS edges must keep landing on JS — a sibling `lib/x.d.ts` would
 *     otherwise capture `require('./x')`), and
 *   - a MIRROR of its declaration tree is served under
 *     `<types root>/__tsinter_dts__/…` (same bytes, read through the fs
 *     shadow), with tsconfig "paths" sending the package's bare specifier
 *     (and each subpath the program's source graph names, program.ts
 *     registerDtsSubpathViews) to the mirrored types entry. The mirror sits inside the real types
 *     root, so the nearest package.json, the node_modules walk-up of the
 *     declarations' own bare imports, and their relative edges all answer
 *     what they answer at the real location;
 *   - the JS entries join the program as ROOTS (the program's import no
 *     longer reaches them through resolution).
 * scriptc's own resolver (resolve.ts) is unchanged: the module graph links
 * the program's import to the package's JS, so the lowering compiles the
 * JS while the checker types the program against the declarations. The
 * lowering's checker facade maps each mirrored declaration to the JS
 * declaration it describes (dts-bridge.ts); where the two types differ the
 * crossing is a checked conversion. */

/** One declared-surface view: an opted-in package's bare specifier, or one
 * of its subpaths (its "exports" keys and patterns, rea step 10), each
 * typed against the declaration the ordinary resolution answers for it. */
export interface NpmStaticDtsView {
  pkg: string;
  /** The specifier the view answers: `pkg` itself, or `pkg/<subpath>`. */
  specifier: string;
  /** Real directory the declaration tree lives under (the package dir, or
   * its @types twin's). */
  typesRoot: string;
  /** The types entry the ordinary (types-first) resolution answers for the
   * specifier, real path. */
  typesEntry: string;
  /** The same entry under the mirror. */
  mirrorEntry: string;
  /** The specifier's runtime JS entries (import and require syntax) — the
   * program roots that bring the compiled JS into the tsgo program. */
  jsEntries: string[];
}

const DTS_MIRROR_SEGMENT = "/__tsinter_dts__";
/** Keyed by specifier (a package's bare name and its subpaths). */
const dtsViews = new Map<string, NpmStaticDtsView>();

export function registerNpmStaticDtsView(view: NpmStaticDtsView): void {
  if (activePackages.has(view.pkg)) dtsViews.set(view.specifier, view);
}

export function npmStaticDtsViews(): ReadonlyMap<string, NpmStaticDtsView> {
  return dtsViews;
}

/** Does the package have a declared-surface view (its bare specifier or
 * any subpath)? */
export function npmStaticHasDtsView(pkg: string): boolean {
  for (const v of dtsViews.values()) if (v.pkg === pkg) return true;
  return false;
}

/** The mirror path of a real path under a view's types root. */
export function dtsMirrorPathOf(typesRoot: string, real: string): string {
  return `${typesRoot}${DTS_MIRROR_SEGMENT}${real.slice(typesRoot.length)}`;
}

/** For a path at or inside some view's mirror: the view and the real path
 * it mirrors; else null. */
export function dtsMirrorTargetOf(path: string): { view: NpmStaticDtsView; real: string } | null {
  if (dtsViews.size === 0) return null;
  const norm = path.split("\\").join("/");
  let idx = norm.indexOf(`${DTS_MIRROR_SEGMENT}/`);
  if (idx < 0 && norm.endsWith(DTS_MIRROR_SEGMENT)) idx = norm.length - DTS_MIRROR_SEGMENT.length;
  if (idx < 0) return null;
  const root = norm.slice(0, idx);
  for (const view of dtsViews.values()) {
    if (view.typesRoot === root) return { view, real: root + norm.slice(idx + DTS_MIRROR_SEGMENT.length) };
  }
  return null;
}

/** True for a path served from a declared-surface mirror. */
export function isDtsMirrorPath(path: string): boolean {
  return dtsMirrorTargetOf(path) !== null;
}

/** tsconfig "paths" sending each viewed specifier (a bare package name or
 * one of its subpaths, exactly) to its mirrored types entry (null when no
 * view is registered). */
export function npmStaticDtsPaths(): Record<string, string[]> | null {
  if (dtsViews.size === 0) return null;
  const paths: Record<string, string[]> = {};
  for (const v of dtsViews.values()) paths[v.specifier] = [v.mirrorEntry];
  return paths;
}

/** The JS roots the viewed specifiers add to the program (the program
 * imports each one: a bare opted-in package, or a subpath its source graph
 * names). */
export function npmStaticDtsRoots(): string[] {
  const out: string[] = [];
  for (const v of dtsViews.values()) for (const j of v.jsEntries) if (!out.includes(j)) out.push(j);
  return out;
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

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
  /** Existence answers for paths the real FS does not hold (the
   * declared-surface mirror): true/false, or undefined to fall through. */
  fileExists?: (path: string) => boolean | undefined;
  directoryExists?: (path: string) => boolean | undefined;
  getAccessibleEntries?: (path: string) => { files: string[]; directories: string[] } | undefined;
  realpath?: (path: string) => string | undefined;
}

/** The virtual-FS shadow loadProgram hands the tsgo host — null when the
 * flag is off, so flagless compiles keep the exact host behavior. */
export function npmStaticFsShadow(): NpmStaticFsShadow | null {
  if (!npmStaticActive()) return null;
  return {
    readFile: (path) => {
      // The declared-surface mirror serves the real declaration's bytes.
      const mirror = dtsMirrorTargetOf(path);
      if (mirror !== null) {
        if (!isDeclarationFileName(mirror.real)) return undefined;
        try {
          return readFileSync(mirror.real, "utf8");
        } catch {
          return undefined;
        }
      }
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
      const mirror = dtsMirrorTargetOf(path);
      if (mirror !== null) return !isDeclarationFileName(mirror.real) || !isFileSync(mirror.real);
      const target = shadowTargetOf(path);
      if (!target) return false;
      if (target.viaTypes) return true; // the @types twin hides whole
      return isDeclarationFileName(path);
    },
    fileExists: (path) => {
      const mirror = dtsMirrorTargetOf(path);
      if (mirror === null) return undefined;
      return isDeclarationFileName(mirror.real) && isFileSync(mirror.real);
    },
    directoryExists: (path) => {
      const mirror = dtsMirrorTargetOf(path);
      return mirror === null ? undefined : isDirSync(mirror.real);
    },
    getAccessibleEntries: (path) => {
      const mirror = dtsMirrorTargetOf(path);
      if (mirror === null) return undefined;
      try {
        const files: string[] = [];
        const directories: string[] = [];
        for (const e of readdirSync(mirror.real, { withFileTypes: true })) {
          if (e.isDirectory()) {
            if (e.name !== "node_modules") directories.push(e.name);
          } else if (isDeclarationFileName(e.name)) files.push(e.name);
        }
        return { files, directories };
      } catch {
        return { files: [], directories: [] };
      }
    },
    realpath: (path) => (dtsMirrorTargetOf(path) !== null ? path : undefined),
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

/** Unminified-JS heuristic over an entry source. Minified output has two
 * signals together: LONG LINES (one enormous line, or an average far past
 * readable code's) and MANGLED NAMES (one- and two-character identifiers
 * dominating the identifier occurrences). Either alone is ordinary code: a
 * compact single-file package writes long lines with real names, and a
 * readable loop body has its `i`s and `k`s on short lines. An empty or
 * comment-only entry (a types-only package's stub) has nothing minified. */
export function looksUnminified(source: string): boolean {
  const lines = source.split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const longLines = longest > 500 || source.length / lines.length > 200;
  if (!longLines) return true;
  return mangledShare(source) < MANGLED_SHARE;
}

/** The share of identifier occurrences at or above which a long-lined
 * source reads as name-mangled. */
const MANGLED_SHARE = 0.4;

const JS_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "let",
  "new", "null", "of", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var",
  "void", "while", "with", "yield", "async", "await", "static", "get", "set", "undefined",
]);

/** One- and two-character identifiers as a share of all identifier
 * occurrences outside strings and comments (keywords excluded). */
function mangledShare(source: string): number {
  // Strings first (a URL's // is not a comment), then comments.
  const code = source
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  let total = 0;
  let short = 0;
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0];
    if (JS_WORDS.has(id)) continue;
    total++;
    if (id.length <= 2) short++;
  }
  return total === 0 ? 0 : short / total;
}

/** The DefinitelyTyped twin of a package name (`js-yaml` → `@types/js-yaml`,
 * `@scope/name` → `@types/scope__name`). */
export function typesTwinOf(pkgName: string): string {
  return pkgName.startsWith("@") ? `@types/${pkgName.slice(1).replace("/", "__")}` : `@types/${pkgName}`;
}

/** The runtime package a DefinitelyTyped package describes (the inverse of
 * typesTwinOf), or null for a name outside @types. */
export function runtimeOfTypesTwin(pkgName: string): string | null {
  if (!pkgName.startsWith("@types/")) return null;
  const rest = pkgName.slice("@types/".length);
  if (rest === "node") return null;
  return rest.includes("__") ? `@${rest.replace("__", "/")}` : rest;
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
  // The package's own declarations, or its @types twin (the declared-
  // surface view serves either — S133); any other package's types are a
  // third party's claim about this one.
  const typesPkg = npmPackageNameOf(typesFile);
  if (typesPkg !== pkgName && typesPkg !== typesTwinOf(pkgName)) {
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
