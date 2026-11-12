/* The checker's half of dev-runner resolution (SEMANTICS.md S130).
 *
 * Preflight resolves every import edge with scriptc's own resolver
 * (resolve.ts), which consults dev-resolve.ts per importing file. The tsgo
 * checker has ONE module resolution per program, so it cannot follow a
 * per-file tsconfig "paths" lookup or the workspace dist → src mapping by
 * itself. Before the program is created, this module walks the program's
 * source graph from its roots — relative edges, package.json-mediated
 * project edges and dev-runner edges, never into node_modules — and turns
 * every dev-runner answer into an EXACT-specifier tsconfig "paths" entry
 * (absolute target) for the checker. Both worlds then answer the same file
 * for every such specifier.
 *
 * A specifier exact paths cannot express is a CONFLICT: two importers
 * resolving it to different files (two packages' tsconfigs mapping "@/*"
 * to their own directories, both used with the same text), or one importer
 * resolving it through a dev-runner rule while another resolves it through
 * Node or not at all. Conflicts get no entry and refuse by name (SC1010) at
 * every import site involved: the checker would type one of them against
 * the wrong module, which is never a silent outcome here.
 *
 * The scan parses with typescript5 (createSourceFile, no checker), memoized
 * per path and mtime across loads. */

import { readFileSync, statSync } from "node:fs";
import ts5 from "typescript5";
import { devResolve } from "./dev-resolve.js";
import { isNodeModulesPath, resolveProjectImport, resolveRelativeModule } from "./resolve.js";

interface SpecUse {
  spec: string;
  kind: "import" | "require";
  start: number;
  end: number;
}

const usesCache = new Map<string, { key: string; uses: SpecUse[] }>();

function scriptKindOf(file: string): ts5.ScriptKind {
  if (/\.(tsx)$/.test(file)) return ts5.ScriptKind.TSX;
  if (/\.(jsx)$/.test(file)) return ts5.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts5.ScriptKind.JS;
  return ts5.ScriptKind.TS;
}

/** Every module specifier a file names: import/export declarations (type-
 * only ones too — the checker resolves them), `import x = require()`,
 * import() and require() calls with a literal, and `import("x")` types. */
function specifierUsesOf(file: string): SpecUse[] {
  let key: string;
  try {
    const st = statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }
  const hit = usesCache.get(file);
  if (hit !== undefined && hit.key === key) return hit.uses;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const sf = ts5.createSourceFile(file, text, ts5.ScriptTarget.Latest, true, scriptKindOf(file));
  const uses: SpecUse[] = [];
  const push = (lit: ts5.Node & { text: string }, kind: "import" | "require"): void => {
    uses.push({ spec: lit.text, kind, start: lit.getStart(sf), end: lit.getEnd() });
  };
  const visit = (n: ts5.Node): void => {
    if ((ts5.isImportDeclaration(n) || ts5.isExportDeclaration(n)) && n.moduleSpecifier !== undefined && ts5.isStringLiteral(n.moduleSpecifier)) {
      push(n.moduleSpecifier, "import");
    } else if (ts5.isImportEqualsDeclaration(n) && ts5.isExternalModuleReference(n.moduleReference) && ts5.isStringLiteral(n.moduleReference.expression)) {
      push(n.moduleReference.expression, "require");
    } else if (ts5.isCallExpression(n)) {
      const arg = n.arguments[0];
      if (arg !== undefined && ts5.isStringLiteralLike(arg)) {
        if (n.expression.kind === ts5.SyntaxKind.ImportKeyword) push(arg, "import");
        else if (ts5.isIdentifier(n.expression) && n.expression.text === "require" && n.arguments.length === 1) push(arg, "require");
      }
    } else if (ts5.isImportTypeNode(n) && ts5.isLiteralTypeNode(n.argument) && ts5.isStringLiteral(n.argument.literal)) {
      push(n.argument.literal, "import");
    }
  };
  // An explicit stack, never recursion: a long binary chain (a corpus
  // program's generated expression) nests deeper than the JS stack. Children
  // go on in reverse, so the walk stays in source order.
  const stack: ts5.Node[] = [sf];
  while (stack.length > 0) {
    const n = stack.pop()!;
    visit(n);
    const kids: ts5.Node[] = [];
    ts5.forEachChild(n, (c) => {
      kids.push(c);
    });
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!);
  }
  usesCache.set(file, { key, uses });
  return uses;
}

export interface DevGraphConflict {
  spec: string;
  /** Every import site of the specifier in the scanned graph, with its
   * answer: a file, "node" (plain Node resolves it) or null (nothing). */
  sites: { file: string; start: number; end: number; answer: string | null | "node" }[];
}

export interface DevGraph {
  /** Exact-specifier tsconfig "paths" for the checker (absolute targets). */
  paths: Record<string, string[]>;
  conflicts: DevGraphConflict[];
  /** Every source file the walk reached (absolute; node_modules excluded). */
  files: string[];
}

/** Walks the source graph from `roots` (see the header) and answers the
 * checker's paths and the conflicts. Empty when no edge needs a dev-runner
 * rule — the common case, and every single-package program. */
export function scanDevGraph(roots: readonly string[]): DevGraph {
  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (f: string | null): void => {
    if (f === null || seen.has(f) || isNodeModulesPath(f) || f.endsWith(".json")) return;
    seen.add(f);
    queue.push(f);
  };
  for (const r of roots) enqueue(r);
  const bySpec = new Map<string, DevGraphConflict["sites"]>();
  const devSpecs = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const u of specifierUsesOf(file)) {
      const { spec } = u;
      if (spec === "" || spec.startsWith("node:")) continue;
      if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
        enqueue(resolveRelativeModule(file, spec));
        continue;
      }
      const dev = devResolve(file, spec, u.kind);
      let sites = bySpec.get(spec);
      if (sites === undefined) bySpec.set(spec, (sites = []));
      if (dev !== null) {
        devSpecs.add(spec);
        sites.push({ file, start: u.start, end: u.end, answer: dev.file });
        enqueue(dev.file);
        continue;
      }
      const proj = resolveProjectImport(file, spec, u.kind);
      if (proj !== null) enqueue(proj);
      sites.push({ file, start: u.start, end: u.end, answer: proj ?? "node" });
    }
  }
  const paths: Record<string, string[]> = {};
  const conflicts: DevGraphConflict[] = [];
  for (const spec of devSpecs) {
    const sites = bySpec.get(spec)!;
    const answers = new Set(sites.map((s) => s.answer));
    const only = sites[0]!.answer;
    if (answers.size === 1 && typeof only === "string" && only !== "node") paths[spec] = [only];
    else conflicts.push({ spec, sites });
  }
  return { paths, conflicts, files: [...seen] };
}
