// Target plans: which wrapper entries to analyze for one package. Parses source with the compiler's
// TypeScript (AST only); nothing is executed.
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { HERE, ROOT, TREES, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "./lib.mjs";

const ts = createRequire(join(HERE, "../../../packages/compiler/package.json"))("typescript5");

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
export function resolveLocal(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js"), join(base, "index.mjs"), join(base, "index.cjs")]) if (isFile(c)) return c;
  if (isFile(join(base, "package.json"))) {
    try { const m = JSON.parse(readFileSync(join(base, "package.json"), "utf8")).main; if (m) return resolveLocal(join(base, "x"), `./${m}`); } catch {}
  }
  return null;
}

/** Every string-literal module edge anywhere in a file, top level or nested, conditional or not. */
export function moduleEdges(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const edges = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) edges.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]) &&
        ((ts.isIdentifier(n.expression) && n.expression.text === "require") || n.expression.kind === ts.SyntaxKind.ImportKeyword)) edges.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return edges;
}

/** Node's condition walk for an ESM importer: first key in object order among node/import/default. */
function reduceTarget(t) {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) { for (const x of t) { const r = reduceTarget(x); if (r) return r; } return null; }
  if (t && typeof t === "object") {
    for (const [k, v] of Object.entries(t)) if (["node", "import", "module-sync", "default"].includes(k)) { const r = reduceTarget(v); if (r) return r; }
  }
  return null;
}
export function packageEntries(pkgDir, pj) {
  const out = new Set();
  const add = (p) => { if (typeof p === "string" && !p.includes("*")) { const f = resolveLocal(join(pkgDir, "x"), p.startsWith(".") ? p : `./${p}`); if (f) out.add(f); } };
  const ex = pj.exports;
  if (ex !== undefined && ex !== null) {
    const subpathMap = typeof ex === "object" && !Array.isArray(ex) && Object.keys(ex).some((k) => k.startsWith("."));
    if (subpathMap) { for (const [k, v] of Object.entries(ex)) if (!k.endsWith(".json") && !k.includes("package.json")) add(reduceTarget(v)); }
    else add(reduceTarget(ex));
  } else {
    add(pj.main ?? "./index.js");
  }
  return [...out];
}

export function closure(roots, pkgDir, cap = 4000, bare = new Set()) {
  const seen = new Set(roots);
  const list = [...roots];
  for (let i = 0; i < list.length && list.length < cap; i++) {
    let edges = [];
    if (!/\.(js|cjs|mjs)$/.test(list[i])) continue;
    try { edges = moduleEdges(list[i]); } catch { continue; }
    for (const e of edges) {
      if (!e.startsWith(".")) { bare.add(e); continue; }
      const f = resolveLocal(list[i], e);
      if (f && f.startsWith(pkgDir + "/") && !f.includes("/node_modules/", pkgDir.length) && /\.(js|cjs|mjs)$/.test(f) && !seen.has(f)) { seen.add(f); list.push(f); }
    }
  }
  return list;
}

const MAX_SWEEP = 300;
const BUILTINS = new Set(builtinModules);
/** What a real project has beside its node_modules: a tsconfig (skipLibCheck, so dependency .d.ts files
 * are not checked against tsinter's lib choice) and @types/node. Without them every dependency .d.ts that
 * names NodeJS.* is an SC0001 and the package falls back to the island. */
export function ensureProjectFiles(tree) {
  const cfg = join(tree, "tsconfig.json");
  if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, esModuleInterop: true } }));
  for (const p of ["@types/node", "undici-types"]) {
    const dest = join(tree, "node_modules", p);
    if (!existsSync(dest)) { mkdirSync(dirname(dest), { recursive: true }); execFileSync("cp", ["-al", join(ROOT, "node-types/node_modules", p), dest]); }
  }
}
export function planNpm(name, id) {
  const tree = join(TREES, id);
  const pkgDir = join(tree, "node_modules", name);
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const npmStatic = JSON.parse(readFileSync(join(tree, "closure.json"), "utf8"));
  const roots = packageEntries(pkgDir, pj);
  const bare = new Set();
  const files = closure(roots, pkgDir, 4000, bare);
  const builtins = [...bare].map((b) => b.replace(/^node:/, "")).filter((b) => BUILTINS.has(b.split("/")[0]));
  ensureProjectFiles(tree);
  // Entries are analyzed directly with the package opted in: a side-effect-only `import "x"` wrapper
  // lowers an ES module to nothing, and a bare-specifier wrapper cannot reach subpaths behind `exports`.
  // Each opts in only the package itself, so a dependency that refuses cannot hide the package's own
  // sites; a package whose own files come back clean then gets one more pass with its whole dependency
  // closure opted in (the "<tree>" entry in worker.mjs). The first entry also runs the wasm build.
  const swept = files.length > MAX_SWEEP ? files.slice(0, MAX_SWEEP) : files;
  const entries = swept.map((f, i) => ({ name: relative(pkgDir, f), kind: i === 0 ? "primary" : "file", wrapper: f, npmStatic: [name], compile: i === 0 }));
  const tree2 = npmStatic.length > 1 && swept.length > 0 ? { wrapper: swept[0], npmStatic } : null;
  return { id, name, entries, tree: tree2, builtins, rootFiles: roots.length, closureFiles: files.length, sweepTruncated: Math.max(0, files.length - swept.length) };
}
export { existsSync };
