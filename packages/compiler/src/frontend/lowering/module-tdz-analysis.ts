/* The module-scope temporal dead zone, program side: the analysis entry
 * (analyzeModuleTdz) over every file and import cycle, the sync-inert
 * initializer test, and the source occurrences each flagged binding's
 * guards must cover. module-tdz.ts' header describes the whole design. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { locOf, makeInertPredicates, nonInertTopLevel, orderedImportsOf } from "../program.js";
import { nsSymbolRuntimeKind } from "./lower-namespaces.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { ModuleTdz, isAmbient, isUnit, type Occurrence, type TdzBinding } from "./module-tdz.js";
import { analyzeFile, clusterRefs, type ClusterRefs } from "./module-tdz-file.js";

/** The builtins that only SCHEDULE their callback — never call it before
 * returning (the timer family and the microtask queue). */
const DEFERRING_GLOBALS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]);

/** `syncInert(e)`: evaluating `e` runs no user code SYNCHRONOUSLY — the
 * cycle-admission inert set (program.ts), plus object literals carrying
 * methods/accessors (creating one calls nothing), and calls of the
 * scheduling builtins whose arguments are themselves sync-inert (a
 * callback argument is created, not run). Function-likes created by such
 * an initializer cannot run until the declarator finished. */
function makeSyncInert(L: Lowerer): (e: ts.Expression) => boolean {
  const { inert } = makeInertPredicates(L.program);
  const fromDeclarationFiles = (ident: ts.Identifier): boolean => {
    let sym = L.checker.getSymbolAtLocation(ident);
    if (sym === undefined) return false;
    if (sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
    const decls = L.checker.declarationsOf(sym);
    return decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
  };
  const deferringCallee = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return DEFERRING_GLOBALS.has(callee.text) && fromDeclarationFiles(callee);
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "nextTick" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "process" &&
      fromDeclarationFiles(callee.expression)
    );
  };
  const syncInert = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    }
    if (inert(e)) return true;
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.every((p) => {
        if (ts.isShorthandPropertyAssignment(p)) return p.objectAssignmentInitializer === undefined;
        if (ts.isPropertyAssignment(p)) return !ts.isComputedPropertyName(p.name) && syncInert(p.initializer);
        if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
          return !ts.isComputedPropertyName(p.name);
        }
        return false;
      });
    }
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((el) => !ts.isSpreadElement(el) && syncInert(el));
    if (ts.isCallExpression(e) && e.questionDotToken === undefined && deferringCallee(e.expression)) {
      return e.arguments.every((a) => !ts.isSpreadElement(a) && syncInert(a));
    }
    return false;
  };
  return syncInert;
}

/** Strongly-connected components of the program's static import graph
 * (the module-order files only), as file → component. */
function importSccs(program: ts.Program, files: readonly ts.SourceFile[]): Map<ts.SourceFile, ts.SourceFile[]> {
  const inProgram = new Set(files);
  const sccOf = new Map<ts.SourceFile, ts.SourceFile[]>();
  const index = new Map<ts.SourceFile, number>();
  const low = new Map<ts.SourceFile, number>();
  const onStack = new Set<ts.SourceFile>();
  const stack: ts.SourceFile[] = [];
  let next = 0;
  const strong = (v: ts.SourceFile): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const { dep } of orderedImportsOf(program, v)) {
      if (dep === null || dep === v || !inProgram.has(dep)) continue;
      if (!index.has(dep)) {
        strong(dep);
        low.set(v, Math.min(low.get(v)!, low.get(dep)!));
      } else if (onStack.has(dep)) {
        low.set(v, Math.min(low.get(v)!, index.get(dep)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: ts.SourceFile[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      for (const w of comp) sccOf.set(w, comp);
    }
  };
  for (const sf of files) if (!index.has(sf)) strong(sf);
  return sccOf;
}

/** Runs the analysis over every program file and registers the init-flag
 * globals of the bindings that need one. Called once per lowering pass,
 * after collection (module globals exist) and before any body lowers. */
export function analyzeModuleTdz(L: Lowerer, parts: readonly FileParts[]): ModuleTdz {
  const tdz = new ModuleTdz();
  const files = parts.map((p) => p.sf);
  files.forEach((sf, i) => tdz.orderOf.set(sf.fileName, i));
  const sccs = importSccs(L.program, files);
  const clusterInfo = new Map<ts.SourceFile[], ClusterRefs | null>();
  const syncInert = makeSyncInert(L);
  const refuseNamespaces = (m: ts.SourceFile): void => {
    // A namespace's members flatten into module globals bound as its body
    // runs; before that Node reads the namespace object as undefined (a
    // TypeError at the member read, or an undefined member mid-body). Not
    // modeled: a module that hot cycle code can reach before it ran
    // refuses its runtime namespace at the declaration.
    for (const st of m.statements) {
      if (!ts.isModuleDeclaration(st) || !ts.isIdentifier(st.name) || isAmbient(st)) continue;
      const sym = L.checker.getSymbolAtLocation(st.name);
      if (sym === undefined || nsSymbolRuntimeKind(L, sym) !== "instantiated") continue;
      L.pushDiag(
        unsupportedDiag(
          "SC1016",
          locOf(st.name),
          `a namespace ('${st.name.text}') in a module of an import cycle whose top-level code runs during the cycle's evaluation, or in a module that cycle can reach before it ran (Node reads the namespace as undefined until its body ran, which is not modeled)`,
        ),
      );
    }
  };
  // 1. Every cluster's verdict. HOT: some member's top level can run user
  // code during the cluster's init window, or reads a binding of a member
  // that is still mid-evaluation then. A cold cluster keeps the per-file
  // analysis (nothing can observe a partial initialization).
  const hotWindows: { lo: number; hi: number; refs: ClusterRefs }[] = [];
  for (const sf of files) {
    const comp = sccs.get(sf);
    if (comp === undefined || comp.length < 2 || clusterInfo.has(comp)) continue;
    const refs = clusterRefs(L, comp, tdz.orderOf);
    const hot = refs.backTopRead || comp.some((m) => nonInertTopLevel(L.program, m) !== null);
    clusterInfo.set(comp, hot ? refs : null);
    if (!hot) continue;
    for (const m of comp) refuseNamespaces(m);
    const orders = comp.map((m) => tdz.orderOf.get(m.fileName) ?? -1);
    hotWindows.push({ lo: Math.min(...orders), hi: Math.max(...orders), refs });
  }
  // 2. The modules a hot cluster's code can reach before they ran: Node
  // evaluates them inside the cluster's window (between its first member
  // starting and its last finishing — a member's not-yet-evaluated
  // imports, transitively), so cycle code calling into one can meet its
  // bindings uninitialized. Each is analyzed in cycle mode too, its own
  // code units' references and the cluster's flagged.
  const windowScope = (sf: ts.SourceFile): ClusterRefs | null => {
    const at = tdz.orderOf.get(sf.fileName) ?? -1;
    const ws = hotWindows.filter((w) => w.lo < at && at < w.hi);
    if (ws.length === 0) return null;
    const own = clusterRefs(L, [sf], tdz.orderOf);
    const refs = new Set<ts.Symbol>(own.refs);
    for (const w of ws) for (const r of w.refs.refs) refs.add(r);
    return { files: new Set([sf.fileName]), refs, backTopRead: false };
  };
  const scopeOf = new Map<ts.SourceFile, ClusterRefs | null>();
  for (const sf of files) {
    if (sf.isDeclarationFile) continue;
    const comp = sccs.get(sf);
    let cluster: ClusterRefs | null = comp !== undefined && comp.length > 1 ? clusterInfo.get(comp)! : null;
    if (cluster === null) {
      cluster = windowScope(sf);
      if (cluster !== null) refuseNamespaces(sf);
    }
    scopeOf.set(sf, cluster);
    tdz.files.push(sf);
    analyzeFile(L, tdz, sf, cluster, syncInert);
  }
  // A JSON module imported into a hot cluster: before its first request
  // evaluated it, Node reads its default binding as undefined — a code
  // unit of the cluster reading it then fences (S124), testing the
  // module's own run-once loaded flag.
  for (const [sym, { flag, importer }] of L.jsonLoadedFlagOf) {
    const cluster = scopeOf.get(importer);
    if (cluster === undefined || cluster === null || tdz.bySymbol.has(sym)) continue;
    const decl = L.checker.declarationsOf(sym)[0];
    if (decl === undefined) continue;
    const b: TdzBinding = {
      name: "default",
      sf: decl.getSourceFile(),
      declIndex: 0,
      declNode: decl,
      flag,
      everywhere: true,
      isClass: false,
      cluster: cluster.files,
      fence: "a read of '%NAME%' (a JSON module's default, imported into an import cycle) before the JSON module evaluated — Node reads undefined there, which no typed slot holds (SEMANTICS.md S124)",
      sharedFlag: true,
    };
    tdz.bySymbol.set(sym, b);
    tdz.byFlagId.set(flag.id, b);
  }
  if (tdz.bySymbol.size > 0) collectOccurrences(L, tdz);
  return tdz;
}

/** Every source access of a flagged binding inside a unit where it is
 * guarded (ModuleTdz.occByFile) — plus, in cycle mode, the TOP-LEVEL
 * reads of another cluster member's bindings (needsCheck decides which).
 * Type positions are not accesses; an `extends` expression is. */
function collectOccurrences(L: Lowerer, tdz: ModuleTdz): void {
  const names = new Set<string>();
  let anyCycle = false;
  const cycleFiles = new Set<string>();
  for (const b of tdz.bySymbol.values()) {
    names.add(b.name);
    if (b.everywhere) anyCycle = true;
    if (b.cluster !== null) for (const f of b.cluster) cycleFiles.add(f);
  }
  for (const sf of tdz.files) {
    const out: Occurrence[] = [];
    const topLevel = cycleFiles.has(sf.fileName);
    const record = (n: ts.Node, sym: ts.Symbol | undefined, unit: ts.Node): void => {
      const b = tdz.bindingOfSymbol(L.checker, L.program, sym);
      if (b === undefined) return;
      const start = n.getStart(sf);
      if (!tdz.needsCheck(b, sf.fileName, start)) return;
      out.push({ start, end: n.end, b, unit, name: ts.isIdentifier(n) ? n.text : b.name });
    };
    // Iterative (each entry carries its innermost enclosing unit): a
    // thousands-deep expression must not overflow the JS stack. `out` is
    // sorted below, so visit order is immaterial.
    const work: [ts.Node, ts.Node | undefined][] = [[sf, undefined]];
    while (work.length > 0) {
      const [n, outer] = work.pop()!;
      if (ts.isTypeNode(n) && !(ts.isExpressionWithTypeArguments(n) && n.parent !== undefined && ts.isHeritageClause(n.parent) && n.parent.token === ts.SyntaxKind.ExtendsKeyword)) {
        continue;
      }
      // Module plumbing binds; it never reads.
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n)) continue;
      const unit = isUnit(n) ? n : outer;
      const scope = unit ?? (topLevel ? sf : undefined);
      if (scope !== undefined) {
        if (ts.isIdentifier(n)) {
          // Name pre-filter: a cycle-mode binding may be imported under
          // another name, so every identifier resolves then.
          if (anyCycle || names.has(n.text)) record(n, L.checker.getSymbolAtLocation(n), scope);
        } else if (ts.isShorthandPropertyAssignment(n)) {
          if (anyCycle || (ts.isIdentifier(n.name) && names.has(n.name.text))) record(n.name, L.checker.getShorthandAssignmentValueSymbol(n), scope);
          if (n.objectAssignmentInitializer !== undefined) work.push([n.objectAssignmentInitializer, unit]);
          continue;
        }
      }
      ts.forEachChild(n, (c) => {
        work.push([c, unit]);
        return undefined;
      });
    }
    if (out.length > 0) {
      out.sort((a, b) => a.start - b.start);
      tdz.occByFile.set(sf.fileName, out);
    }
  }
}
