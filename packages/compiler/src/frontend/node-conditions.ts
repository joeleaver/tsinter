/* Node's package.json "exports" / "imports" condition semantics, reduced
 * to what both resolution worlds (the tsgo host's fs shadow and
 * resolve.ts) can read with a fixed bundler condition set.
 *
 * Node picks a conditional target by the IMPORTING SYNTAX: an import
 * statement / import() / export-from matches NODE_IMPORT_CONDITIONS, a
 * require() call NODE_REQUIRE_CONDITIONS — first key in object order,
 * nested objects and fallback arrays recursing. The bundler set both
 * resolvers otherwise use ({types, import, default}) answers differently
 * wherever a package spells "node", "module-sync" or "require" ahead of
 * the key the bundler set matches — board #258 (dual packages under
 * --npm-static) and its "imports"-field sibling (chalk 5's
 * `#supports-color: { node, default }`). reduceConditionTargets rewrites
 * every condition object into `{ [types,] import, require }` holding
 * Node's own answers, so a resolver that matches "import" for import
 * syntax and "require" for require syntax lands on Node's file. */

import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

/** Node v24's default condition sets (no --conditions flags): "node",
 * the syntax condition, "module-sync" (require(esm) is unflagged),
 * "node-addons" (no --no-addons), and "default", which always matches.
 * The match is first-key-in-object-order, so set order is irrelevant. */
export const NODE_IMPORT_CONDITIONS: ReadonlySet<string> = new Set(["node", "import", "module-sync", "node-addons", "default"]);
export const NODE_REQUIRE_CONDITIONS: ReadonlySet<string> = new Set(["node", "require", "module-sync", "node-addons", "default"]);

/** The bundler set the checker's declaration lookup uses — only consulted
 * to keep a declaration answer in project scopes (reduceConditionTargets'
 * keepTypes). */
const BUNDLER_TYPES_CONDITIONS: ReadonlySet<string> = new Set(["types", "import", "default"]);

/** Node's invalidSegmentRegEx minus the deprecated-only empty segment
 * (resolvePackageTargetString): a "." / ".." / "node_modules" path
 * segment (percent-encoded spellings included) after the leading "./"
 * makes the target INVALID (ERR_INVALID_PACKAGE_TARGET). */
const INVALID_SEGMENT =
  /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;

/** Node's validity rule for a string target. "exports" targets must be
 * "./"-relative with no invalid segment; an "imports" target may also be
 * a bare specifier (PACKAGE_RESOLVE re-entry) — but never "../", "/" or
 * a URL. */
export function isValidNodeTarget(target: string, field: "exports" | "imports"): boolean {
  if (!target.startsWith("./")) {
    if (field !== "imports") return false;
    if (target.startsWith("../") || target.startsWith("/")) return false;
    try {
      new URL(target);
      return false; // a URL target is not a bare specifier
    } catch {
      return true;
    }
  }
  return !INVALID_SEGMENT.test(target.slice(2));
}

/** A target's answer under one Node condition set — Node's
 * PACKAGE_TARGET_RESOLVE reduced to the LEAF: a valid string, null for an
 * explicit exclusion or an invalid target (Node throws there; both
 * resolvers then answer nothing), undefined for no match. Arrays are
 * Node's fallback lists: the first element answering a valid string wins;
 * invalid and excluded elements fall through. */
export function nodeConditionLeaf(
  target: unknown,
  conditions: ReadonlySet<string>,
  field: "exports" | "imports" = "exports",
): string | null | undefined {
  if (typeof target === "string") return isValidNodeTarget(target, field) ? target : null;
  if (target === null) return null;
  if (Array.isArray(target)) {
    if (target.length === 0) return null;
    let sawNull = false;
    for (const t of target) {
      const r = nodeConditionLeaf(t, conditions, field);
      if (typeof r === "string") return r;
      if (r === null) sawNull = true;
    }
    return sawNull ? null : undefined;
  }
  if (typeof target === "object") {
    for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
      if (!conditions.has(key)) continue;
      const r = nodeConditionLeaf(value, conditions, field);
      if (r === undefined) continue;
      return r;
    }
  }
  return undefined;
}

/** Whether Node loads `file` as CommonJS — conservatively (false when in
 * doubt): ".cjs" always; ".js" when the nearest package.json scope says
 * "type": "commonjs", or names no type and the source shows no ES module
 * syntax (Node 24's syntax detection would load it as ESM otherwise).
 * The scan is textual over comment-stripped source: an import/export
 * statement, import.meta, or a top-level-looking await reads as ESM. */
export function nodeLoadsAsCjs(file: string): boolean {
  if (file.endsWith(".cjs")) return true;
  if (!file.endsWith(".js")) return false;
  for (let dir = dirname(resolvePath(file)); ; ) {
    let text: string | null = null;
    try {
      text = readFileSync(join(dir, "package.json"), "utf8");
    } catch {
      text = null;
    }
    if (text !== null) {
      let type: unknown;
      try {
        type = (JSON.parse(text) as { type?: unknown }).type;
      } catch {
        return false;
      }
      if (type === "module") return false;
      if (type === "commonjs") return true;
      break; // the scope names no type: syntax detection decides
    }
    const parent = dirname(dir);
    if (parent === dir || dir.endsWith("/node_modules") || dir.endsWith("\\node_modules")) break;
    dir = parent;
  }
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const body = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return !/^\s*(import\s*[\w{*'"]|export\s|export\{|await\s)|\bimport\.meta\b/m.test(body);
}

/** Recognizes commander's esm.mjs shape — an ES module that is NOTHING
 * but name plumbing over one CJS file:
 *     import X from './index.js';
 *     export const { a, b, c } = X;
 *     export default X;            // optional
 * `source` is the wrapper's text, `wrapperAbs` its path, `cjsAbs` the
 * absolute path its default import must resolve to. Answers the exported
 * names, or null for any other body (one stray statement and the file is
 * a real ESM implementation). */
export function wrapperShapeOf(
  source: string,
  wrapperAbs: string,
  cjsAbs: string,
): { names: ReadonlySet<string>; hasDefault: boolean } | null {
  // Comments go first (the wrapper annotates its names: commander's
  // `InvalidOptionArgumentError, // deprecated old name`). No string in
  // the accepted shape can contain a comment opener.
  const body = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const stmts = body
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const id = "[A-Za-z_$][\\w$]*";
  let local: string | null = null;
  const names = new Set<string>();
  let hasDefault = false;
  for (const s of stmts) {
    const imp = new RegExp(`^import\\s+(${id})\\s+from\\s+(['"])([^'"]+)\\2$`).exec(s);
    if (imp !== null && local === null) {
      const spec = imp[3]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
      if (resolvePath(dirname(wrapperAbs), spec) !== resolvePath(cjsAbs)) return null;
      local = imp[1]!;
      continue;
    }
    if (local === null) return null;
    const exp = new RegExp(`^export\\s+const\\s*\\{([^}]*)\\}\\s*=\\s*(${id})$`).exec(s);
    if (exp !== null && exp[2] === local) {
      for (const raw of exp[1]!.split(",")) {
        const n = raw.trim();
        if (n === "") continue;
        if (!new RegExp(`^${id}$`).test(n)) return null; // renames/defaults/rest: not the plain shape
        names.add(n);
      }
      continue;
    }
    if (new RegExp(`^export\\s+default\\s+(${id})$`).exec(s)?.[1] === local) {
      hasDefault = true;
      continue;
    }
    return null;
  }
  return local !== null && names.size > 0 ? { names, hasDefault } : null;
}

/** A CJS-first substitution (reduceConditionTargets' `wrappers` mode): at
 * exports subpath `subpath`, the "import" target `wrapper` (a named-export
 * wrapper over the "require" target) was replaced by the "require" target
 * `cjs`. `names` are the wrapper's exported names, `hasDefault` whether it
 * also exports a default. */
export interface WrapperSubstitution {
  subpath: string;
  wrapper: string;
  cjs: string;
  names: ReadonlySet<string>;
  hasDefault: boolean;
}

export interface ReduceOptions {
  /** Keep a "types" key (first) where the bundler set's own answer is a
   * declaration file — project scopes, whose checker keeps reading
   * declarations exactly as before. Opted-in --npm-static packages drop
   * every types claim instead. */
  keepTypes: boolean;
  /** Detect wrapper duals (CJS-first) — needs the package directory. */
  wrapperPkgDir?: string;
}

/** Rewrites `pkg.exports` and `pkg.imports` IN PLACE: every condition
 * object becomes `{ [types,] import: <Node's import answer>, require:
 * <Node's require answer> }`. Returns the wrapper substitutions made. */
export function reduceConditionTargets(pkg: Record<string, unknown>, opts: ReduceOptions): WrapperSubstitution[] {
  const subs: WrapperSubstitution[] = [];
  const isConditionObject = (v: unknown, keyPrefix: string): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => !k.startsWith(keyPrefix));
  const normalize = (v: unknown, subpath: string, field: "exports" | "imports"): unknown => {
    if (Array.isArray(v)) return v.map((item) => normalize(item, subpath, field));
    if (!isConditionObject(v, field === "exports" ? "." : "#")) return v;
    const out: Record<string, unknown> = {};
    if (opts.keepTypes) {
      const t = nodeConditionLeaf(v, BUNDLER_TYPES_CONDITIONS, field);
      if (typeof t === "string" && /\.d\.(ts|mts|cts)$/.test(t)) out["types"] = t;
    }
    const imp = nodeConditionLeaf(v, NODE_IMPORT_CONDITIONS, field);
    const req = nodeConditionLeaf(v, NODE_REQUIRE_CONDITIONS, field);
    if (imp !== undefined) out["import"] = imp;
    if (req !== undefined) out["require"] = req;
    const dir = opts.wrapperPkgDir;
    if (
      field === "exports" &&
      dir !== undefined &&
      typeof imp === "string" &&
      typeof req === "string" &&
      imp !== req &&
      !imp.includes("*") &&
      !req.includes("*") &&
      // the require target must BE CommonJS by Node's own format rules:
      // an ES module's default is not the module object the wrapper
      // destructures
      nodeLoadsAsCjs(resolvePath(dir, req))
    ) {
      let source: string | null = null;
      try {
        source = readFileSync(resolvePath(dir, imp), "utf8");
      } catch {
        source = null;
      }
      const shape = source !== null ? wrapperShapeOf(source, resolvePath(dir, imp), resolvePath(dir, req)) : null;
      if (shape !== null) {
        out["import"] = req;
        subs.push({ subpath, wrapper: imp, cjs: req, ...shape });
      }
    }
    return out;
  };
  const exp = pkg["exports"];
  if (exp !== undefined) {
    if (isConditionObject(exp, ".")) {
      pkg["exports"] = normalize(exp, ".", "exports");
    } else if (exp !== null && typeof exp === "object" && !Array.isArray(exp)) {
      const map = exp as Record<string, unknown>;
      for (const key of Object.keys(map)) map[key] = normalize(map[key], key, "exports");
    } else {
      pkg["exports"] = normalize(exp, ".", "exports");
    }
  }
  const imps = pkg["imports"];
  if (imps !== null && typeof imps === "object" && !Array.isArray(imps)) {
    const map = imps as Record<string, unknown>;
    for (const key of Object.keys(map)) map[key] = normalize(map[key], key, "imports");
  }
  return subs;
}

/** True when a package.json document carries a condition object anywhere
 * in "exports" or "imports" (the documents the project-scope shadow must
 * rewrite; every other document is served byte-identical). */
export function hasConditionTargets(pkg: Record<string, unknown>): boolean {
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v === null || typeof v !== "object") return false;
    const keys = Object.keys(v);
    if (keys.some((k) => !k.startsWith(".") && !k.startsWith("#"))) return true;
    return Object.values(v as Record<string, unknown>).some(walk);
  };
  return walk(pkg["exports"]) || walk(pkg["imports"]);
}

/** The project-scope rewrite over a package.json TEXT (the tsgo host's
 * shadow for package.json files outside node_modules): Node's answers
 * per syntax, declaration answers kept. Undefined when the document needs
 * no rewrite (no condition objects, or malformed). */
export function projectPkgJsonShadowText(text: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const pkg = doc as Record<string, unknown>;
  if (!hasConditionTargets(pkg)) return undefined;
  reduceConditionTargets(pkg, { keepTypes: true });
  return JSON.stringify(pkg);
}
