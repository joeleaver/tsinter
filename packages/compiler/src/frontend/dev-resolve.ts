/* Dev-runner resolution (SEMANTICS.md S130) — how a real TypeScript
 * project's sources resolve under the project's own dev runner (tsx,
 * vite-node, vitest), which is how the Node oracle runs them for
 * multi-package projects: tests/real-apps-top10/harness/node-src-loader.mjs.
 * This module is that loader's resolve hook, rule for rule, for the
 * compiler. Keep the two in step: a rule changed in one is changed in the
 * other in the same commit (dev-resolve.test.ts runs both over the same
 * fixtures and requires one answer).
 *
 * The rules apply only where PLAIN Node's resolution fails — Node's own
 * answer always wins when it names an existing file:
 *   1. a bare specifier from a project file (outside node_modules): the
 *      nearest tsconfig.json's "paths" (extends chains followed, entries
 *      tried in object order, the first target that names a file wins);
 *   2. a bare specifier Node resolved to a MISSING file whose realpath lies
 *      outside every node_modules (a workspace package whose package.json
 *      main/exports names unbuilt output): that path under dist|lib|out|
 *      build mapped to its source twin (src/<rest> or <rest>, leading
 *      build-flavor directories dropped, .js → .ts), else the path's own
 *      TypeScript twin.
 * Relative specifiers keep S126's bundler resolution (resolve.ts), which
 * already answers what the loader's relative rule answers. A deep import of
 * an installed package that Node accepts only with an extension added
 * (moduleResolution "bundler" probing, `lodash/merge`) is an npm import:
 * this module answers null for it and the npm machinery keeps it.
 *
 * Pure node:fs plus the typescript5 JSONC reader (the same reader the
 * loader uses); no AST, checker or enum objects cross this module. */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, builtinModules } from "node:module";
import { dirname, join, resolve as presolve } from "node:path";
import ts5 from "typescript5";
import { NODE_IMPORT_CONDITIONS, NODE_REQUIRE_CONDITIONS, nodeConditionLeaf } from "./node-conditions.js";

const isProject = (p: string): boolean => !p.split("\\").join("/").includes("/node_modules/");

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/* ── tsconfig (JSONC, extends) — the loader's loadCfg/nearestCfg ──────── */

export interface DevTsconfig {
  compilerOptions: Record<string, unknown>;
  /** Directory of the tsconfig file itself. */
  dir: string;
  /** Where "paths" targets resolve: baseUrl of the config that set paths
   * or baseUrl, else that config's directory. */
  pathsDir?: string;
  /** The tsconfig file. */
  file: string;
}

const cfgCache = new Map<string, DevTsconfig>();
const nearestCache = new Map<string, DevTsconfig | null>();
const pkgCache = new Map<string, Record<string, unknown> | null>();

/** Resets every cache (per program load — fixtures change under tests). */
export function clearDevResolveCaches(): void {
  cfgCache.clear();
  nearestCache.clear();
  pkgCache.clear();
  answerCache.clear();
}

function readJsonc(p: string): Record<string, unknown> {
  const text = readFileSync(p, "utf8");
  const r = ts5.parseConfigFileTextToJson(p, text);
  return (r.config as Record<string, unknown> | undefined) ?? {};
}

export function loadDevTsconfig(p: string, depth = 0): DevTsconfig {
  const cached = cfgCache.get(p);
  if (cached !== undefined) return cached;
  let raw: Record<string, unknown>;
  try {
    raw = readJsonc(p);
  } catch {
    raw = {};
  }
  let base: { compilerOptions: Record<string, unknown>; pathsDir?: string } = { compilerOptions: {} };
  const ext = raw["extends"];
  const exts = ext === undefined ? [] : Array.isArray(ext) ? ext : [ext];
  for (const e of exts) {
    if (depth > 8 || typeof e !== "string") break;
    let ep: string | null = null;
    if (e.startsWith(".") || e.startsWith("/")) ep = presolve(dirname(p), e.endsWith(".json") ? e : e + ".json");
    else {
      try {
        ep = createRequire(p).resolve(e);
      } catch {
        try {
          ep = createRequire(p).resolve(e + "/tsconfig.json");
        } catch {
          ep = null;
        }
      }
    }
    if (ep !== null && isFile(ep)) {
      const b = loadDevTsconfig(ep, depth + 1);
      base = { compilerOptions: { ...base.compilerOptions, ...b.compilerOptions }, ...(b.pathsDir !== undefined ? { pathsDir: b.pathsDir } : {}) };
    }
  }
  const co = (raw["compilerOptions"] as Record<string, unknown> | undefined) ?? {};
  const merged: DevTsconfig = {
    compilerOptions: { ...base.compilerOptions, ...co },
    dir: dirname(p),
    file: p,
    ...(base.pathsDir !== undefined ? { pathsDir: base.pathsDir } : {}),
  };
  // "paths" resolve against baseUrl, else against the tsconfig that declares them
  if (co["paths"] !== undefined || co["baseUrl"] !== undefined) {
    merged.pathsDir = presolve(dirname(p), typeof co["baseUrl"] === "string" ? co["baseUrl"] : ".");
  }
  cfgCache.set(p, merged);
  return merged;
}

/** The nearest tsconfig.json at or above `dir` (no node_modules stop — the
 * loader's walk), parsed, or null. */
export function nearestDevTsconfig(dir: string): DevTsconfig | null {
  const cached = nearestCache.get(dir);
  if (cached !== undefined) return cached;
  let d = dir;
  let found: DevTsconfig | null = null;
  for (;;) {
    const c = join(d, "tsconfig.json");
    if (isFile(c)) {
      found = loadDevTsconfig(c);
      break;
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  nearestCache.set(dir, found);
  return found;
}

/* ── the loader's fallbacks ─────────────────────────────────────────────── */

/** The loader's tsTwin: the file itself, its TypeScript twin for a JS
 * extension, an extension added, or a directory index. */
export function tsTwin(p: string): string | null {
  if (isFile(p)) return p;
  const m = /\.(m|c)?jsx?$/.exec(p);
  if (m) {
    const stem = p.slice(0, -m[0].length);
    const c = m[1] ?? "";
    for (const e of [`.${c}ts`, `.${c}tsx`, ".ts", ".tsx"]) if (isFile(stem + e)) return stem + e;
  }
  for (const e of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"]) if (isFile(p + e)) return p + e;
  for (const e of ["index.ts", "index.tsx", "index.mts", "index.js"]) if (isFile(join(p, e))) return join(p, e);
  return null;
}

/** tsconfig "paths" of the importer's nearest tsconfig, entries in object
 * order (the loader's viaPaths — not TypeScript's longest-prefix order). */
export function viaPaths(spec: string, parentPath: string): string | null {
  const cfg = nearestDevTsconfig(dirname(parentPath));
  const paths = cfg?.compilerOptions["paths"];
  if (cfg === null || paths === null || typeof paths !== "object" || Array.isArray(paths)) return null;
  for (const [pat, targets] of Object.entries(paths as Record<string, unknown>)) {
    let star: string | null = null;
    if (pat.includes("*")) {
      const [pre, post] = pat.split("*") as [string, string];
      if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
        star = spec.slice(pre.length, spec.length - post.length);
      } else continue;
    } else if (pat !== spec) continue;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (typeof t !== "string") continue;
      const p = presolve(cfg.pathsDir ?? cfg.dir, star === null ? t : t.replace("*", star));
      const hit = tsTwin(p);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** dist/x.js, dist/esm/x.js, dist/cjs/src/x.js ... → src/x.ts (leading
 * build-flavor directories dropped) — the loader's distToSrc. */
export function distToSrc(p: string): string | null {
  const m = /^(.*?)\/(dist|lib|out|build)\/(.*)$/.exec(p);
  if (!m) return null;
  const rest = m[3]!.replace(/\.d\.(m|c)?ts$/, ".$1ts").split("/");
  for (let drop = 0; drop < Math.min(rest.length, 3); drop++) {
    const tail = rest.slice(drop).join("/");
    for (const sub of ["src/", ""]) {
      const hit = tsTwin(`${m[1]}/${sub}${tail}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** realpath of a path that may not exist: the nearest existing ancestor's
 * realpath + the rest (the loader's realpathSafe). */
export function realpathSafe(p: string): string {
  let head = p;
  let tail = "";
  for (;;) {
    try {
      return realpathSync(head) + tail;
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      tail = head.slice(up.length) + tail;
      head = up;
    }
  }
}

/* ── plain Node resolution of a bare specifier (the outcome only) ───────── */

function pkgJsonAt(dir: string): Record<string, unknown> | null {
  const cached = pkgCache.get(dir);
  if (cached !== undefined) return cached;
  let doc: Record<string, unknown> | null = null;
  const p = join(dir, "package.json");
  if (existsSync(p)) {
    try {
      const v: unknown = JSON.parse(readFileSync(p, "utf8"));
      doc = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      doc = null;
    }
  }
  pkgCache.set(dir, doc);
  return doc;
}

/** Node's outcome for one specifier: "ok" (an existing file — Node wins),
 * "missing" (Node resolved a file that does not exist; `path` is the
 * absolute path Node's ERR_MODULE_NOT_FOUND names), or "refused" (nothing
 * installed, not exported, invalid — no path the loader could map). */
type NodeOutcome =
  | { kind: "ok"; file?: string; viaNodeModules?: boolean }
  | { kind: "missing"; path: string }
  | { kind: "refused" };

/** Node's PACKAGE_EXPORTS_RESOLVE / PACKAGE_IMPORTS_RESOLVE over one map:
 * an exact key, then '*' patterns (the longest prefix wins, then the
 * longest key), the target's leaf under Node's condition set. */
function nodeMapTarget(
  map: unknown,
  subpath: string,
  conditions: ReadonlySet<string>,
  field: "exports" | "imports",
): string | null {
  if (field === "exports") {
    const isSubpathMap =
      map !== null && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0 && Object.keys(map).every((k) => k.startsWith("."));
    if (!isSubpathMap) {
      if (subpath !== ".") return null;
      const leaf = nodeConditionLeaf(map, conditions, field);
      return typeof leaf === "string" ? leaf : null;
    }
  } else if (map === null || typeof map !== "object" || Array.isArray(map)) {
    return null;
  }
  const m = map as Record<string, unknown>;
  if (Object.hasOwn(m, subpath) && !subpath.includes("*")) {
    const leaf = nodeConditionLeaf(m[subpath], conditions, field);
    return typeof leaf === "string" ? leaf : null;
  }
  let best: { key: string; prefix: string; suffix: string } | null = null;
  for (const key of Object.keys(m)) {
    const star = key.indexOf("*");
    if (star < 0 || key.lastIndexOf("*") !== star) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    // Node's PACKAGE_IMPORTS_EXPORTS_RESOLVE match: the prefix, a non-empty
    // wildcard (the subpath at least as long as the key), the trailer.
    if (!subpath.startsWith(prefix) || subpath.length < key.length || !subpath.endsWith(suffix)) continue;
    if (
      best === null ||
      prefix.length > best.prefix.length ||
      (prefix.length === best.prefix.length && key.length > best.key.length)
    ) {
      best = { key, prefix, suffix };
    }
  }
  if (best === null) return null;
  const leaf = nodeConditionLeaf(m[best.key], conditions, field);
  if (typeof leaf !== "string") return null;
  const wildcard = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
  return leaf.split("*").join(wildcard);
}

/** Node's legacy (no "exports") resolution of a package's main entry: the
 * main file with CommonJS's extension list, main as a directory index, then
 * the package's own index. */
function legacyMain(pkgDir: string, pkg: Record<string, unknown>): string | null {
  const main = pkg["main"];
  if (typeof main === "string" && main !== "") {
    const base = join(pkgDir, main);
    for (const c of [base, base + ".js", base + ".json", base + ".node", join(base, "index.js"), join(base, "index.json"), join(base, "index.node")]) {
      if (isFile(c)) return c;
    }
  }
  for (const c of ["index.js", "index.json", "index.node"]) if (isFile(join(pkgDir, c))) return join(pkgDir, c);
  return null;
}

function nodeOutcome(fromFile: string, spec: string, kind: "import" | "require", depth = 0): NodeOutcome {
  const conditions = kind === "require" ? NODE_REQUIRE_CONDITIONS : NODE_IMPORT_CONDITIONS;
  // An exports/imports target is an exact file for both syntaxes; a
  // directory there is ERR_UNSUPPORTED_DIR_IMPORT (no path to map).
  const fileOutcome = (abs: string): NodeOutcome =>
    isFile(abs) ? { kind: "ok", file: abs } : isDirectory(abs) ? { kind: "refused" } : { kind: "missing", path: abs };
  if (spec.startsWith("#")) {
    // Only the bare "#" is invalid ("#/x" matches "#/*" keys on Node 24).
    if (spec === "#") return { kind: "refused" };
    for (let dir = dirname(presolve(fromFile)); ; ) {
      const pkg = pkgJsonAt(dir);
      if (pkg !== null) {
        const target = nodeMapTarget(pkg["imports"], spec, conditions, "imports");
        if (target === null) return { kind: "refused" };
        if (target.startsWith("./")) return fileOutcome(join(dir, target));
        return depth > 4 ? { kind: "refused" } : nodeOutcome(join(dir, "package.json"), target, kind, depth + 1);
      }
      const up = dirname(dir);
      if (up === dir || dir.endsWith("/node_modules")) return { kind: "refused" };
      dir = up;
    }
  }
  const parts = spec.split("/");
  const nameLen = spec.startsWith("@") ? 2 : 1;
  if (parts.length < nameLen || parts.slice(0, nameLen).some((s) => s === "")) return { kind: "refused" };
  const name = parts.slice(0, nameLen).join("/");
  const rest = parts.slice(nameLen).join("/");
  const subpath = rest === "" ? "." : "./" + rest;
  const inPackage = (pkgDir: string, pkg: Record<string, unknown> | null): NodeOutcome => {
    if (pkg !== null && pkg["exports"] !== undefined && pkg["exports"] !== null) {
      const target = nodeMapTarget(pkg["exports"], subpath, conditions, "exports");
      if (target === null) return { kind: "refused" };
      return fileOutcome(join(pkgDir, target));
    }
    if (subpath === ".") {
      const main = pkg !== null ? legacyMain(pkgDir, pkg) : null;
      if (main !== null) return { kind: "ok", file: main };
      if (pkg === null) {
        for (const c of ["index.js", "index.json", "index.node"]) if (isFile(join(pkgDir, c))) return { kind: "ok" };
      }
      // Both syntaxes name the main entry they could not load (Node 24,
      // probed: ESM "Cannot find package '<pkgDir>/<main>'", CommonJS
      // "Cannot find module '<pkgDir>/<main>'"); with no main, ESM names
      // '<pkgDir>/index.js' and CommonJS only the specifier.
      const mainField = pkg?.["main"];
      if (typeof mainField === "string" && mainField !== "") return { kind: "missing", path: join(pkgDir, mainField) };
      return kind === "require" ? { kind: "refused" } : { kind: "missing", path: join(pkgDir, "index.js") };
    }
    // A deep path with no "exports": ESM takes the exact file (a missing
    // one is "Cannot find module '<abs>'"); CommonJS tries its extension
    // list and names the SPECIFIER when nothing answers (no path to map).
    const abs = join(pkgDir, rest);
    if (kind === "require") return isFile(abs) || cjsCandidates(abs) ? { kind: "ok" } : { kind: "refused" };
    return fileOutcome(abs);
  };
  // PACKAGE_SELF_RESOLVE: the nearest package scope naming itself, with exports.
  for (let dir = dirname(presolve(fromFile)); ; ) {
    const pkg = pkgJsonAt(dir);
    if (pkg !== null) {
      if (pkg["name"] === name && pkg["exports"] !== undefined && pkg["exports"] !== null) return inPackage(dir, pkg);
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (let dir = dirname(presolve(fromFile)); ; ) {
    if (!dir.endsWith("/node_modules")) {
      const pkgDir = join(dir, "node_modules", name);
      if (isDirectory(pkgDir)) {
        const r = inPackage(pkgDir, pkgJsonAt(pkgDir));
        return r.kind === "ok" ? { ...r, viaNodeModules: true } : r;
      }
    }
    const up = dirname(dir);
    if (up === dir) return { kind: "refused" };
    dir = up;
  }
}

/** CommonJS's extension list for a non-exports deep require. */
function cjsCandidates(abs: string): boolean {
  for (const c of [abs + ".js", abs + ".json", abs + ".node", join(abs, "index.js"), join(abs, "index.json")]) if (isFile(c)) return true;
  return false;
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

export interface DevResolution {
  /** The file the dev runner loads (absolute; a realpath for rule 2). */
  file: string;
  rule: "paths" | "workspace-source";
}

const answerCache = new Map<string, DevResolution | null>();

/** The dev-runner answer for a BARE specifier (or "#" import) from
 * `fromFile`, or null when plain Node's own resolution answers (it wins),
 * when the specifier is relative, a builtin or a URL, or when no rule
 * finds a file (Node's own refusal then stands). */
export function devResolve(fromFile: string, spec: string, kind: "import" | "require" = "import"): DevResolution | null {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === ".." || spec.startsWith("/")) return null;
  if (spec.startsWith("node:") || spec.includes(":") || BUILTINS.has(spec)) return null;
  const parentPath = presolve(fromFile);
  const key = `${kind}\0${dirname(parentPath)}\0${spec}`;
  const cached = answerCache.get(key);
  if (cached !== undefined) return cached;
  const answer = devResolveUncached(parentPath, spec, kind);
  answerCache.set(key, answer);
  return answer;
}

function devResolveUncached(parentPath: string, spec: string, kind: "import" | "require"): DevResolution | null {
  const first = nodeOutcome(parentPath, spec, kind);
  if (first.kind === "ok") {
    // Node's own answer wins. When it is TypeScript source of a workspace
    // package (an installed package whose realpath lies outside every
    // node_modules, its exports or main naming src/*.ts), the loader
    // transpiles it as a project file: the package is program source.
    if (first.viaNodeModules !== true || first.file === undefined) return null;
    const real = realpathSafe(first.file);
    return isProject(real) && /\.(m|c)?tsx?$/.test(real) && !/\.d\.(m|c)?ts$/.test(real) ? { file: real, rule: "workspace-source" } : null;
  }
  if (isProject(parentPath)) {
    const hit = viaPaths(spec, parentPath);
    if (hit !== null) return { file: hit, rule: "paths" };
    // moduleResolution "bundler": an extensionless deep import of an
    // installed package — Node accepts it with a suffix; an npm import.
    if (!spec.startsWith("#") && spec.split("/").length > (spec.startsWith("@") ? 2 : 1)) {
      for (const suffix of [".js", "/index.js", ".mjs", ".cjs"]) {
        if (nodeOutcome(parentPath, spec + suffix, kind).kind === "ok") return null;
      }
    }
  }
  if (first.kind === "missing") {
    const real = realpathSafe(first.path);
    if (isProject(real)) {
      const hit = distToSrc(real) ?? tsTwin(real);
      if (hit !== null) return { file: hit, rule: "workspace-source" };
    }
  }
  return null;
}
