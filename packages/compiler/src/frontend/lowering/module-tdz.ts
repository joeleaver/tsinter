/* The module-scope temporal dead zone (board #265).
 *
 * A file-scope `const` / `let` / `class` binding exists from module entry
 * but is UNINITIALIZED until its declaration statement runs; any read or
 * write before that — from a function the module's earlier top-level code
 * calls — throws Node's catchable ReferenceError "Cannot access 'x' before
 * initialization" (typeof included: a TDZ binding is not "undeclared").
 * Module bindings lower to static globals, which hold a typed zero/NULL
 * before their initializing assign, so without a guard such a read was a
 * silent wrong answer (c: 0) or an unnamed trap (wasm: null deref).
 *
 * THE GUARD. A binding that needs one gets a BOOL init-flag global
 * (`<global id>%tdz`, or `%g.<tag>%tdzc.<Class>` for a class), set true
 * the moment it is bound: after its declarator (a destructuring pattern:
 * after its own element's assign), after a class's static initializers.
 * Each guarded access runs `global.tdzCheck(flag, name)` first — a
 * write's RHS evaluates BEFORE the check, exactly Node's PutValue order;
 * reads, compound updates and typeof check first. Two layers place them:
 *  - the IR pass (insertModuleTdzChecks) guards every global read/write
 *    that survived lowering;
 *  - SOURCE COVERAGE: every guarded source access (occByFile) that
 *    lowering folded or aliased away — `late === undefined`, `void late`,
 *    `typeof late`, `Alias.scale` through a class alias, `new C` — is owed
 *    a check by the smallest lowered expression or statement around it
 *    (owedChecks, called from lowerExpr and the statement loop), placed
 *    before that node evaluates. SCRIPTC_TDZ_ASSERT=1 turns the invariant
 *    "every guarded source access in a lowered unit has a check in its
 *    statement" into a hard error (assertTdzCoverage); the module-TDZ
 *    tests and the corpus sweep run with it.
 *
 * THE ANALYSIS (what makes most programs pay nothing). Direct top-level
 * reads never need a guard: tsc rejects a use lexically before the
 * declaration in the same container (TS2448/TS2450), static initializers
 * and JS files included. Only code in a function-like UNIT — a function/
 * arrow/method/accessor/constructor body, or an instance field
 * initializer — can run while a binding is still uninitialized, and only
 * if something the module executed up to that point could have started
 * it. Per file, the top level is replayed in evaluation STEPS (one per
 * declarator, one per other statement); executing step i:
 *  - a reference to a function declaration, or to a top-level `const f =
 *    () => ...` / `const K = class {...}` binding, makes that unit (those
 *    members) RUNNABLE at i;
 *  - any other function-like CREATED by executed code (a callback
 *    argument, an object-literal method, a nested class's members) is
 *    runnable at i — it escapes, and anything may call it later — or at
 *    i + 1/2 when the step's initializer is SYNC-INERT (makeSyncInert:
 *    nothing it evaluates can call user code, so what it creates cannot
 *    run before the declarator bound: `const t = setInterval(() =>
 *    clearInterval(t))`, `const o = { get v() { return o.w; } }`);
 *  - a reference to a top-level class makes all its members (and its
 *    bases') runnable; a class definition executes its decorators,
 *    heritage, computed keys and static initializers/blocks in place
 *    (`this` there escapes the members);
 *  - a runnable unit's own body executes the same way, transitively.
 * A binding declared at step k needs the flag iff some unit runnable by k
 * (k included: the initializer itself may call out) references it; an
 * access is guarded iff its enclosing unit is runnable by k — and never
 * inside the class's own body for a class binding (that is the class's
 * inner binding, initialized before its static elements run). A flag no
 * guard ended up testing is dropped with its sets (dropUnusedFlags).
 * Other files cannot reach a binding before its module finished, EXCEPT
 * in an import cycle: when every cluster member's top level is inert
 * (preflight's declaration-only admission rule — no user code runs while
 * the cluster initializes) the per-file analysis stands; otherwise every
 * binding some cluster unit references is guarded at every unit access,
 * in any file.
 */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { BOOL, STRING, VOID } from "../../ir/nodes.js";
import type { IrExpr, IrFunction, IrGlobal, IrStmt, SrcLoc } from "../../ir/nodes.js";
import { locOf, makeInertPredicates, nonInertTopLevel, orderedImportsOf, resolveImport } from "../program.js";
import { boundIdentifiersOf } from "./lowerer.js";
import { nsSymbolRuntimeKind } from "./lower-namespaces.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";

export interface Occurrence {
  start: number;
  end: number;
  b: TdzBinding;
  /** The innermost enclosing unit, or the SourceFile for a top-level
   * access (cycle mode only — see needsCheck). */
  unit: ts.Node;
  /** The name the access spells: V8's TDZ message names the binding as
   * the ACCESS SITE sees it (an importer's local alias, a namespace
   * member's export name), not the exporter's declaration name. */
  name: string;
}

export interface TdzBinding {
  name: string;
  sf: ts.SourceFile;
  /** The declaration's evaluation step (analyzeFile: one per top-level
   * declarator, one per other statement). */
  declIndex: number;
  /** The class declaration (own-body exemption) or the declarator. */
  declNode: ts.Node;
  flag: IrGlobal;
  /** Cycle mode: every access inside any function-like unit is guarded. */
  everywhere: boolean;
  isClass: boolean;
  /** Cycle mode: the files of the binding's import-cycle cluster. A
   * TOP-LEVEL read in another member that evaluates first (the declaring
   * module is still mid-evaluation then) is guarded too. */
  cluster: ReadonlySet<string> | null;
  /** Non-null for a VAR-LIKE binding of a hot cycle cluster (`var`, an
   * enum): Node reads `undefined` before its declaration ran, which no
   * typed slot represents — the guard is a run-time fence carrying this
   * message instead of the TDZ ReferenceError (SEMANTICS.md S124). */
  fence: string | null;
  /** The flag is another mechanism's own state (a JSON module's run-once
   * loaded flag): never dropped as unused. */
  sharedFlag?: true;
}

const isStaticMember = (n: ts.Node): boolean =>
  (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Static) !== 0;

/** A function-like evaluation unit (see the header). */
function isUnit(n: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  ) {
    return n.body !== undefined;
  }
  if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return true;
  if (ts.isPropertyDeclaration(n)) return n.initializer !== undefined && !isStaticMember(n);
  return false;
}

function isAmbient(n: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0;
}

export class ModuleTdz {
  readonly bySymbol = new Map<ts.Symbol, TdzBinding>();
  readonly byGlobalId = new Map<string, TdzBinding>();
  /** Unit → the first top-level evaluation step (analyzeFile) by which it
   * may run. */
  readonly addedAt = new Map<ts.Node, number>();
  /** Every unit of the analyzed files, by file, for loc → unit lookup. */
  readonly unitsByFile = new Map<string, ts.Node[]>();
  readonly byFlagId = new Map<string, TdzBinding>();
  /** Every SOURCE access of a flagged binding that must be guarded (an
   * identifier read/write/typeof inside a unit the analysis could not
   * prove late enough), by file, sorted by start. Lowering may fold or
   * alias such a read away (`late === undefined`, `Alias.scale` through a
   * class alias, `void late`): guardLowered keeps a check for it anyway. */
  readonly occByFile = new Map<string, Occurrence[]>();
  /** The analyzed source files (occurrence collection, the coverage check). */
  readonly files: ts.SourceFile[] = [];
  /** Evaluation position of each file (Node's depth-first postorder — the
   * module order): a top-level read of another cluster member's binding
   * can see it uninitialized only when that member evaluates LATER (it is
   * an ancestor still mid-evaluation). */
  readonly orderOf = new Map<string, number>();
  /** Cycle-mode flag-only bindings on a module's DEFAULT ALIAS symbol
   * (`export default someIdentifier`): Node's `default` is its own binding,
   * initialized when the export statement runs, while importers' reads
   * resolve through the alias to the target's storage. */
  readonly defaultAliases = new Set<ts.Symbol>();

  /** The binding an identifier's symbol is guarded as: a flagged default
   * alias on its import hops wins over the alias-resolved declaration. */
  bindingOfSymbol(checker: ts.TypeChecker, program: ts.Program, sym: ts.Symbol | undefined): TdzBinding | undefined {
    if (sym === undefined) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) {
      if (this.defaultAliases.size > 0) {
        const hop = defaultAliasHop(checker, program, sym, this.defaultAliases);
        if (hop !== null) return this.bySymbol.get(hop);
      }
      sym = checker.getAliasedSymbol(sym);
    }
    return this.bySymbol.get(sym);
  }

  /** The access-site name for a guarded IR access at `loc` (the recorded
   * source occurrence it lowered from), else the declaration name. */
  nameAt(b: TdzBinding, loc: SrcLoc): string {
    const occs = this.occByFile.get(loc.file);
    if (occs !== undefined) {
      for (const o of occs) {
        if (o.start > loc.end) break;
        if (o.b === b && o.start >= loc.start && o.start <= loc.end) return o.name;
      }
    }
    return b.name;
  }

  /** The innermost unit strictly enclosing `node` (not `node` itself). */
  ownerUnit(node: ts.Node): ts.Node | null {
    const sf = node.getSourceFile();
    const units = this.unitsByFile.get(sf.fileName);
    if (units === undefined) return null;
    const start = node.getStart(sf);
    let best: ts.Node | null = null;
    let bestStart = -1;
    for (const u of units) {
      if (u === node) continue;
      const s = u.getStart();
      if (s <= start && node.end <= u.end && s >= bestStart) {
        best = u;
        bestStart = s;
      }
    }
    return best;
  }

  /** The guard checks a lowered source node still owes: one per flagged
   * binding with more guarded source accesses inside `node` (in the same
   * unit) than the lowered IR `ir` carries accesses for — an access is a
   * tdzCheck already placed, or a global read/write the IR pass will
   * guard. Deepest nodes lower first, so a check lands at the smallest
   * lowered node containing the folded read; it precedes everything that
   * node evaluates. Null when nothing is owed. */
  owedChecks(node: ts.Node, ir: unknown): IrStmt[] | null {
    if (this.occByFile.size === 0) return null;
    const sf = node.getSourceFile();
    const occs = this.occByFile.get(sf.fileName);
    if (occs === undefined) return null;
    const start = node.getStart(sf);
    const end = node.end;
    // First occurrence at or after start (sorted by start).
    let lo = 0;
    let hi = occs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (occs[mid]!.start < start) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= occs.length || occs[lo]!.start >= end) return null;
    // A top-level node's scope is its SourceFile (cycle mode records
    // top-level occurrences under it — needsCheck).
    const owner = this.ownerUnit(node) ?? sf;
    const want = new Map<TdzBinding, { count: number; first: Occurrence }>();
    for (let i = lo; i < occs.length && occs[i]!.start < end; i++) {
      const o = occs[i]!;
      if (o.unit !== owner) continue;
      const w = want.get(o.b);
      if (w === undefined) want.set(o.b, { count: 1, first: o });
      else w.count++;
    }
    if (want.size === 0) return null;
    const have = new Map<TdzBinding, number>();
    const seen = new WeakSet<object>();
    const scan = (v: unknown): void => {
      if (v === null || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        for (const x of v) scan(x);
        return;
      }
      const r = v as Record<string, unknown>;
      const kind = r["kind"];
      let b: TdzBinding | undefined;
      const checked = checkedFlagOf(r);
      if (checked !== null) {
        b = this.byFlagId.get(checked);
      } else if (kind === "varRef" || kind === "assign" || kind === "assignExpr" || kind === "incDec" || kind === "forOf") {
        b = this.byGlobalId.get(r["localId"] as string);
      }
      if (b !== undefined && want.has(b)) {
        const loc = r["loc"] as SrcLoc | undefined;
        if (loc !== undefined && loc.file === sf.fileName && loc.start >= start && loc.start < end && (this.unitAt(loc.file, loc.start) ?? sf) === owner) {
          have.set(b, (have.get(b) ?? 0) + 1);
        }
      }
      for (const k of Object.keys(r)) if (k !== "type" && k !== "loc") scan(r[k]);
    };
    scan(ir);
    const out: IrStmt[] = [];
    for (const [b, w] of want) {
      if ((have.get(b) ?? 0) >= w.count) continue;
      out.push(this.checkStmt(b, { file: sf.fileName, start: w.first.start, end: w.first.end }, w.first.name));
    }
    return out.length > 0 ? out : null;
  }

  /** The innermost unit containing the position, or null (top level). */
  unitAt(file: string, start: number): ts.Node | null {
    const units = this.unitsByFile.get(file);
    if (units === undefined) return null;
    let best: ts.Node | null = null;
    let bestStart = -1;
    for (const u of units) {
      const s = u.getStart();
      if (s <= start && start < u.end && s >= bestStart) {
        best = u;
        bestStart = s;
      }
    }
    return best;
  }

  /** Whether an access at (file, start) must test the binding's flag. */
  needsCheck(b: TdzBinding, file: string, start: number): boolean {
    if (b.isClass && file === b.sf.fileName && b.declNode.getStart() <= start && start < b.declNode.end) {
      return false; // the class's inner binding
    }
    const u = this.unitAt(file, start);
    if (u === null) {
      // Cycle mode: a TOP-LEVEL read in another member of the cluster that
      // evaluates before the declaring module (an ancestor, still
      // mid-evaluation) — Node's TDZ for a cross-module read.
      if (b.cluster === null || file === b.sf.fileName || !b.cluster.has(file)) return false;
      return (this.orderOf.get(b.sf.fileName) ?? -1) > (this.orderOf.get(file) ?? -1);
    }
    if (b.everywhere) return true;
    if (file !== b.sf.fileName) return false;
    const at = this.addedAt.get(u);
    return at !== undefined && at <= b.declIndex;
  }

  checkExpr(b: TdzBinding, loc: SrcLoc, name: string = b.name): IrExpr {
    return {
      kind: "libCall",
      fn: "global.tdzCheck",
      args: [
        { kind: "varRef", localId: b.flag.id, type: BOOL, loc },
        { kind: "strLit", value: name, type: STRING, loc },
      ],
      type: VOID,
      loc,
    };
  }

  checkStmt(b: TdzBinding, loc: SrcLoc, name: string = b.name): IrStmt {
    if (b.fence !== null) {
      // A var-like binding (SEMANTICS.md S124): Node reads `undefined`
      // here, which the typed slot cannot hold — the read ends the
      // program by name instead (S122's run-time fence). Checks sit in
      // straight-line positions (seqExpr), so the test lives in a helper
      // (fenceHelpers, emitted by insertModuleTdzChecks).
      // One helper per access SITE (the fence names its line).
      const callee = `${FENCE_HELPER}${b.flag.id}.${name}.${this.orderOf.get(loc.file) ?? "x"}_${loc.start}`;
      if (!this.fenceHelpers.has(callee)) {
        this.fenceHelpers.set(callee, {
          name: callee,
          params: [],
          returnType: VOID,
          locals: [],
          body: [{
            kind: "if",
            cond: { kind: "unary", op: "!", operand: { kind: "varRef", localId: b.flag.id, type: BOOL, loc }, type: BOOL, loc },
            then: [{ kind: "runtimeFence", code: "SC1016", message: b.fence.replace("%NAME%", name), loc }],
            else_: null,
            loc,
          }],
          loc,
        });
      }
      return { kind: "exprStmt", expr: { kind: "call", callee, args: [], type: VOID, loc }, loc };
    }
    return { kind: "exprStmt", expr: this.checkExpr(b, loc, name), loc };
  }

  /** The var-like bindings' fence helpers checkStmt minted, by name. */
  readonly fenceHelpers = new Map<string, IrFunction>();

  flagSet(b: TdzBinding, loc: SrcLoc): IrStmt {
    return { kind: "assign", localId: b.flag.id, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc };
  }

  /** The binding (any kind) an identifier reads, when this access is
   * guarded — `typeof x` folds statically typed operands away during
   * lowering, so its guard is placed at the expression, not the read. */
  guardedRef(L: Lowerer, ident: ts.Identifier): TdzBinding | null {
    const b = this.bindingOfSymbol(L.checker, L.program, L.checker.getSymbolAtLocation(ident));
    if (b === undefined) return null;
    const sf = ident.getSourceFile();
    return this.needsCheck(b, sf.fileName, ident.getStart(sf)) ? b : null;
  }
}

/** The init flag a guard node tests: a `global.tdzCheck` libCall, or a
 * var-like binding's fence (`if (!flag) runtimeFence`). Null otherwise. */
export function checkedFlagOf(r: Record<string, unknown>): string | null {
  if (r["kind"] === "libCall" && r["fn"] === "global.tdzCheck") {
    const flag = (r["args"] as { localId?: string }[])[0];
    return flag?.localId ?? null;
  }
  if (r["kind"] === "call" && typeof r["callee"] === "string" && r["callee"].startsWith(FENCE_HELPER)) {
    const rest = r["callee"].slice(FENCE_HELPER.length);
    // `<flag id>.<access name>.<site>`: flag ids end in `%tdz`, `%tdzc.<C>`,
    // `%tdzf.<N>` — the name and the site are the last two dot-free
    // segments.
    const noSite = rest.slice(0, rest.lastIndexOf("."));
    return noSite.slice(0, noSite.lastIndexOf("."));
  }
  return null;
}

/** Name prefix of the var-like bindings' fence helpers (ModuleTdz.checkStmt). */
const FENCE_HELPER = "%tdzfence.";

/** The first DEFAULT-export hop of an import alias chain (default import
 * clauses, `{ default as x }` specifiers, `export { default } from`
 * re-exports) that lands on a symbol in `targets`, or null — the walk
 * Lowerer.defaultSnapshotSymbolOf makes for snapshot storage. */
function defaultAliasHop(
  checker: ts.TypeChecker,
  program: ts.Program,
  alias: ts.Symbol,
  targets: ReadonlySet<ts.Symbol>,
): ts.Symbol | null {
  let sym: ts.Symbol | undefined = alias;
  for (let hop = 0; sym !== undefined && hop < 32; hop++) {
    if (hop > 0 && targets.has(sym)) return sym;
    const d = checker
      .declarationsOf(sym)
      .find((x) => ts.isImportClause(x) || ts.isImportSpecifier(x) || ts.isExportSpecifier(x));
    let spec: ts.Expression | undefined;
    let name: string | undefined;
    if (d && ts.isImportClause(d) && ts.isImportDeclaration(d.parent)) {
      spec = d.parent.moduleSpecifier;
      name = "default";
    } else if (d && ts.isImportSpecifier(d)) {
      const idecl: ts.Node = d.parent.parent.parent;
      if (ts.isImportDeclaration(idecl)) spec = idecl.moduleSpecifier;
      name = (d.propertyName ?? d.name).text;
    } else if (d && ts.isExportSpecifier(d)) {
      const edecl: ts.Node = d.parent.parent;
      if (ts.isExportDeclaration(edecl)) spec = edecl.moduleSpecifier;
      name = (d.propertyName ?? d.name).text;
    }
    if (d === undefined || spec === undefined || !ts.isStringLiteral(spec) || name !== "default") return null;
    const dep = resolveImport(program, d.getSourceFile(), spec.text);
    if (!dep) return null;
    sym = checker.getSymbolAtLocation(dep)?.getExports().get(ts.InternalSymbolName.Default as ts.__String);
  }
  return null;
}

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

/** The coverage invariant (SCRIPTC_TDZ_ASSERT=1 — the module-TDZ tests
 * and the corpus sweep run with it): every guarded source access whose
 * unit was lowered at all has a tdzCheck of its binding inside its
 * enclosing statement. An uncovered access would be a folded/aliased
 * read nothing guards — a silent value where Node throws. */
export function assertTdzCoverage(tdz: ModuleTdz, functions: IrFunction[]): void {
  const checks = new Map<string, { b: TdzBinding; start: number }[]>();
  const locs = new Map<string, number[]>();
  // Statements lowered to a deferred runtimeFence: they throw before any
  // access inside them could run, so those accesses owe no guard.
  const fences = new Map<string, SrcLoc[]>();
  const seen = new WeakSet<object>();
  const scan = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) scan(x);
      return;
    }
    const r = v as Record<string, unknown>;
    const loc = r["loc"] as SrcLoc | undefined;
    if (loc !== undefined && typeof loc === "object" && typeof loc.file === "string") {
      let arr = locs.get(loc.file);
      if (arr === undefined) locs.set(loc.file, (arr = []));
      arr.push(loc.start);
      // (A var-like binding's own guard fence — SC1016 — is a CHECK, not
      // a fenced statement.)
      if (r["kind"] === "runtimeFence" && r["code"] !== "SC1016") {
        let f = fences.get(loc.file);
        if (f === undefined) fences.set(loc.file, (f = []));
        f.push(loc);
      }
      const checked = checkedFlagOf(r);
      if (checked !== null) {
        const b = tdz.byFlagId.get(checked);
        if (b !== undefined) {
          let c = checks.get(loc.file);
          if (c === undefined) checks.set(loc.file, (c = []));
          c.push({ b, start: loc.start });
        }
      }
    }
    for (const k of Object.keys(r)) if (k !== "type") scan(r[k]);
  };
  scan(functions);
  for (const sf of tdz.files) {
    const occs = tdz.occByFile.get(sf.fileName);
    if (occs === undefined) continue;
    const fileLocs = locs.get(sf.fileName) ?? [];
    const fileChecks = checks.get(sf.fileName) ?? [];
    const fileFences = fences.get(sf.fileName) ?? [];
    for (const o of occs) {
      if (fileFences.some((f) => f.start <= o.start && o.end <= f.end)) continue;
      const uStart = o.unit.getStart(sf);
      // A unit nothing lowered (unreachable) has no IR to guard.
      if (!fileLocs.some((p) => p > uStart && p < o.unit.end)) continue;
      let stmt: ts.Node = o.unit;
      // The innermost statement (or the unit's concise body) around it.
      // (Preorder, iterative: the last containing statement is the innermost.)
      ts.walkPreorder(o.unit, (n) => {
        if (!(n.getStart(sf) <= o.start && o.end <= n.end)) return "skip";
        if ((ts.isStatement(n) || n === o.unit) && n !== sf) stmt = n;
        return undefined;
      });
      const s0 = stmt.getStart(sf);
      if (!fileChecks.some((c) => c.b === o.b && c.start >= s0 && c.start < stmt.end)) {
        const lc = ts.getLineAndCharacterOfPosition(sf, o.start);
        throw new Error(
          `module-TDZ coverage: the access to '${o.b.name}' at ${sf.fileName}:${lc.line + 1}:${lc.character + 1} lowered with no guard`,
        );
      }
    }
  }
}

/** A hot cluster's reference facts (cycle mode). */
interface ClusterRefs {
  files: ReadonlySet<string>;
  /** Every symbol an identifier inside some function-like unit of the
   * cluster's files resolves to, plus every top-level reference one member
   * makes to another member's binding — cycle mode flags exactly the
   * bindings some code in the cluster could read early. */
  refs: Set<ts.Symbol>;
  /** Some member's top level reads a binding (not a hoisted function) of a
   * member that evaluates after it — still mid-evaluation at the read. */
  backTopRead: boolean;
}

function clusterRefs(L: Lowerer, comp: ts.SourceFile[], orderOf: ReadonlyMap<string, number>): ClusterRefs {
  const files = new Set(comp.map((m) => m.fileName));
  const refs = new Set<ts.Symbol>();
  let backTopRead = false;
  const resolve = (sym: ts.Symbol | undefined): ts.Symbol | undefined =>
    sym !== undefined && sym.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(sym) : sym;
  for (const m of comp) {
    const mOrder = orderOf.get(m.fileName) ?? -1;
    const topRef = (sym: ts.Symbol | undefined, viaAlias: ts.Symbol | undefined): void => {
      if (sym === undefined) return;
      const decls = L.checker.declarationsOf(sym);
      const home = decls[0]?.getSourceFile();
      if (home === undefined || home === m || !files.has(home.fileName)) return;
      refs.add(sym);
      if (viaAlias !== undefined) refs.add(viaAlias);
      if (decls.every((d) => ts.isFunctionDeclaration(d))) return; // hoisted: initialized at link
      if ((orderOf.get(home.fileName) ?? -1) > mOrder) backTopRead = true;
    };
    // Iterative: a thousands-deep expression must not overflow the JS stack.
    const work: [ts.Node, boolean][] = [[m, false]];
    while (work.length > 0) {
      const [n, inUnit] = work.pop()!;
      if (!inUnit && (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n))) continue;
      if (ts.isTypeNode(n) && !(ts.isExpressionWithTypeArguments(n) && n.parent !== undefined && ts.isHeritageClause(n.parent))) continue;
      if (ts.isIdentifier(n)) {
        const raw = L.checker.getSymbolAtLocation(n);
        const sym = resolve(raw);
        if (inUnit) {
          if (sym !== undefined) refs.add(sym);
          if (raw !== undefined && raw !== sym) refs.add(raw);
        } else {
          topRef(sym, raw !== sym ? raw : undefined);
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(n)) {
        const sym = L.checker.getShorthandAssignmentValueSymbol(n);
        if (inUnit) {
          if (sym !== undefined) refs.add(resolve(sym)!);
        } else {
          topRef(resolve(sym), undefined);
        }
      }
      const inner = inUnit || isUnit(n);
      ts.forEachChild(n, (c) => {
        work.push([c, inner]);
        return undefined;
      });
    }
  }
  return { files, refs, backTopRead };
}

/** `cluster` non-null: cycle mode — flag every binding some code of the
 * hot cluster references (ClusterRefs.refs), guarded at every unit access
 * and at the top-level reads needsCheck names. Cycle mode also flags the
 * bindings no per-file analysis needs: the module's `default` (its own
 * binding, initialized when the export statement runs) and the var-like
 * bindings (`var`, enums), whose early reads fence (S124). */
function analyzeFile(
  L: Lowerer,
  tdz: ModuleTdz,
  sf: ts.SourceFile,
  cluster: ClusterRefs | null,
  syncInert: (e: ts.Expression) => boolean,
): void {
  const cycleRefs = cluster?.refs ?? null;
  const everywhere = cycleRefs !== null;
  const checker = L.checker;
  const resolve = (ident: ts.Node): ts.Symbol | undefined => {
    let sym = checker.getSymbolAtLocation(ident);
    if (sym !== undefined && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym;
  };

  // 1. The file's lexical bindings, its units, and the reference maps.
  const candidates = new Map<ts.Symbol, {
    name: string;
    index: number;
    declNode: ts.Node;
    global: IrGlobal | null;
    isClass: boolean;
    /** Cycle mode: flagged whatever the reference set says. */
    always?: boolean;
    fence?: string;
    /** A flag with no storage of its own (the default ALIAS, an enum). */
    flagOnly?: boolean;
  }>();
  const fenceText = (what: string): string =>
    `a read of '%NAME%' (${what}, read by code of an import cycle) before its module ran — Node reads undefined there, which no typed slot holds (SEMANTICS.md S124)`;
  const valueUnits = new Map<ts.Symbol, ts.Node>(); // top-level `const f = () => ...`
  const deferredUnits = new Set<ts.Node>();
  const topClasses = new Map<ts.Symbol, ts.ClassLikeDeclaration>();
  const deferredClasses = new Set<ts.ClassLikeDeclaration>(); // `const K = class {...}`
  // Evaluation STEPS: one per declarator of a lexical/var statement (a
  // later declarator's initializer runs after an earlier one bound), one
  // per other statement. Binding positions and unit runnability are steps.
  const stepOf: number[] = [];
  let steps = 0;
  for (const stmt of sf.statements) {
    stepOf.push(steps);
    steps += ts.isVariableStatement(stmt) ? Math.max(1, stmt.declarationList.declarations.length) : 1;
  }
  sf.statements.forEach((stmt, stmtIndex) => {
    if (isAmbient(stmt)) return;
    if (ts.isVariableStatement(stmt)) {
      const list = stmt.declarationList;
      if ((list.flags & ts.NodeFlags.Using) !== 0) return;
      if ((list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) {
        // var: no TDZ — but in cycle mode an early read is Node's
        // `undefined`, fenced by name (S124).
        if (!everywhere) return;
        list.declarations.forEach((decl, d) => {
          for (const nameNode of boundIdentifiersOf(decl.name)) {
            const sym = checker.getSymbolAtLocation(nameNode);
            if (sym === undefined) continue;
            const global = L.globalsBySymbol.get(sym) ?? null;
            // An undefined-armed (or dynamic) slot holds `undefined` from
            // instantiation on (buildMain's var hoisting): Node's early
            // read is representable, so nothing to fence.
            if (global !== null && (L.varGlobalEntryInits.get(sf) ?? []).includes(global)) continue;
            candidates.set(sym, { name: nameNode.text, index: stepOf[stmtIndex]! + d, declNode: decl, global, isClass: false, fence: fenceText("a var binding") });
          }
        });
        return;
      }
      list.declarations.forEach((decl, d) => {
        const index = stepOf[stmtIndex]! + d;
        for (const nameNode of boundIdentifiersOf(decl.name)) {
          const sym = checker.getSymbolAtLocation(nameNode);
          if (sym === undefined) continue;
          candidates.set(sym, { name: nameNode.text, index, declNode: decl, global: L.globalsBySymbol.get(sym) ?? null, isClass: false });
        }
        let init = decl.initializer;
        while (init !== undefined && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) {
          init = init.expression;
        }
        if (init !== undefined && ts.isIdentifier(decl.name) && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const sym = checker.getSymbolAtLocation(decl.name);
          if (sym !== undefined) {
            valueUnits.set(sym, init);
            deferredUnits.add(init);
          }
        }
        if (init !== undefined && ts.isIdentifier(decl.name) && ts.isClassExpression(init)) {
          // Its members run only once something reaches the class through
          // the binding (or its own static elements' `this`).
          const sym = checker.getSymbolAtLocation(decl.name);
          if (sym !== undefined) {
            topClasses.set(sym, init);
            deferredClasses.add(init);
          }
        }
      });
    } else if (everywhere && ts.isEnumDeclaration(stmt)) {
      const sym = checker.getSymbolAtLocation(stmt.name);
      if (sym === undefined) return;
      candidates.set(sym, { name: stmt.name.text, index: stepOf[stmtIndex]!, declNode: stmt, global: null, isClass: false, flagOnly: true, fence: fenceText("an enum") });
    } else if (everywhere && ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // The module's `default` binding: storage of its own (an expression
      // or a mutable target's snapshot), or — `export default ident` of an
      // immutable target — alias plumbing to the target's storage, which
      // gets a flag of its own keyed by the default ALIAS symbol.
      const sym = checker.getSymbolAtLocation(sf)?.getExports().get(ts.InternalSymbolName.Default as ts.__String);
      if (sym === undefined) return;
      const global = L.globalsBySymbol.get(sym) ?? null;
      if (global === null && !(sym.flags & ts.SymbolFlags.Alias)) return;
      candidates.set(sym, { name: "default", index: stepOf[stmtIndex]!, declNode: stmt, global, isClass: false, always: true, flagOnly: global === null });
      if (global === null) tdz.defaultAliases.add(sym);
    } else if (everywhere && ts.isClassDeclaration(stmt) && stmt.name === undefined) {
      // `export default class { ... }`: the binding is the module's default.
      const sym = checker.getSymbolAtLocation(sf)?.getExports().get(ts.InternalSymbolName.Default as ts.__String);
      if (sym === undefined) return;
      topClasses.set(sym, stmt);
      candidates.set(sym, { name: "default", index: stepOf[stmtIndex]!, declNode: stmt, global: null, isClass: true, always: true });
    } else if (ts.isClassDeclaration(stmt) && stmt.name !== undefined) {
      const sym = checker.getSymbolAtLocation(stmt.name);
      if (sym === undefined) return;
      topClasses.set(sym, stmt);
      candidates.set(sym, { name: stmt.name.text, index: stepOf[stmtIndex]!, declNode: stmt, global: null, isClass: true });
    }
  });
  const units: ts.Node[] = [];
  ts.walkPreorder(sf, (n) => {
    if (isUnit(n)) units.push(n);
    return undefined;
  });
  tdz.unitsByFile.set(sf.fileName, units);
  if (candidates.size === 0) return;

  // 2. Replay the top level.
  const refIndex = new Map<ts.Symbol, number>();
  const worklist: ts.Node[] = [];
  const addedClasses = new Set<ts.Symbol>();
  let at = 0;
  const addUnit = (u: ts.Node): void => {
    if (tdz.addedAt.has(u)) return;
    tdz.addedAt.set(u, at);
    worklist.push(u);
  };
  const classMemberUnits = (c: ts.ClassLikeDeclaration): ts.Node[] => c.members.filter(isUnit);
  const staticPartsUseThis = (c: ts.ClassLikeDeclaration): boolean =>
    c.members.some((m) => {
      const part = ts.isClassStaticBlockDeclaration(m)
        ? m.body
        : ts.isPropertyDeclaration(m) && isStaticMember(m)
          ? m.initializer
          : undefined;
      if (part === undefined) return false;
      let found = false;
      ts.walkPreorder(part, (n) => {
        if (n.kind === ts.SyntaxKind.ThisKeyword) {
          found = true;
          return "stop";
        }
        return undefined;
      });
      return found;
    });
  const addClass = (sym: ts.Symbol): void => {
    if (addedClasses.has(sym)) return;
    addedClasses.add(sym);
    const c = topClasses.get(sym)!;
    for (const m of classMemberUnits(c)) addUnit(m);
    for (const h of c.heritageClauses ?? []) {
      if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const t of h.types) visitExec(t.expression, false);
    }
  };
  const referenceSym = (sym: ts.Symbol | undefined, inUnit: boolean, at_node: ts.Node): void => {
    if (sym === undefined) return;
    // A function declaration of this file — by its DECLARATION, so an
    // anonymous `export default function () {}` reached through an import
    // of the module itself counts too.
    for (const d of checker.declarationsOf(sym)) {
      if (ts.isFunctionDeclaration(d) && d.body !== undefined && d.getSourceFile() === sf) addUnit(d);
    }
    const vu = valueUnits.get(sym);
    if (vu !== undefined) addUnit(vu);
    if (topClasses.has(sym)) addClass(sym);
    const cand = candidates.get(sym);
    // A class's own body reads its INNER binding — never a TDZ read.
    if (inUnit && cand !== undefined && !(cand.isClass && cand.declNode.getStart() <= at_node.getStart() && at_node.end <= cand.declNode.end)) {
      const prev = refIndex.get(sym);
      if (prev === undefined || at < prev) refIndex.set(sym, at);
    }
  };
  /** A class DEFINITION executing here: decorators, heritage, computed
   * keys, static initializers and blocks run in place; members of a
   * non-top-level class escape immediately (top-level classes wait for a
   * reference — addClass). */
  const execClass = (c: ts.ClassLikeDeclaration, inUnit: boolean): void => {
    for (const m of ts.getModifiers(c) ?? []) visitExec(m, inUnit);
    for (const h of c.heritageClauses ?? []) {
      if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const t of h.types) visitExec(t.expression, inUnit);
    }
    for (const m of c.members) {
      for (const mod of ts.getModifiers(m) ?? []) visitExec(mod, inUnit);
      const name = (m as { name?: ts.PropertyName }).name;
      if (name !== undefined && ts.isComputedPropertyName(name)) visitExec(name.expression, inUnit);
      if (ts.isClassStaticBlockDeclaration(m)) visitExec(m.body, inUnit);
      else if (ts.isPropertyDeclaration(m) && isStaticMember(m) && m.initializer !== undefined) visitExec(m.initializer, inUnit);
    }
    // `this` in a static element IS the class (`static inst = new this()`,
    // `registry.push(this)`): the members escape without the name.
    const deferredClass = (ts.isClassDeclaration(c) && c.parent === sf) || deferredClasses.has(c);
    if (!deferredClass || staticPartsUseThis(c)) {
      for (const m of classMemberUnits(c)) addUnit(m);
    }
  };
  // Iterative (an explicit stack, like walkPreorder): an expression nested
  // thousands deep must not overflow the JS stack before lowering's named
  // SC1090 fence fires. Visit order is immaterial — every effect (addUnit,
  // referenceSym) records the same `at` for the whole call.
  const visitExec = (root: ts.Node, inUnit: boolean): void => {
    const stack: ts.Node[] = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      visitExecStep(n, inUnit, stack);
    }
  };
  const visitExecStep = (n: ts.Node, inUnit: boolean, stack: ts.Node[]): void => {
    if (isUnit(n)) {
      if (!deferredUnits.has(n)) addUnit(n);
      return;
    }
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      if (!isAmbient(n)) execClass(n, inUnit);
      return;
    }
    if (ts.isHeritageClause(n) || ts.isTypeNode(n)) return;
    if (
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isImportDeclaration(n) ||
      ts.isExportDeclaration(n)
    ) {
      return;
    }
    if (ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isParameter(n)) {
      // The bound NAME is a declaration, not a reference (a top-level
      // `const f = () => ...` must not count as calling f); defaults,
      // computed keys and initializers execute.
      if (ts.isBindingElement(n) && n.propertyName !== undefined && ts.isComputedPropertyName(n.propertyName)) {
        stack.push(n.propertyName.expression);
      }
      if (n.name !== undefined && !ts.isIdentifier(n.name)) stack.push(n.name);
      if (n.initializer !== undefined) stack.push(n.initializer);
      return;
    }
    if (ts.isIdentifier(n)) {
      referenceSym(resolve(n), inUnit, n);
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      referenceSym(checker.getShorthandAssignmentValueSymbol(n), inUnit, n);
      if (n.objectAssignmentInitializer !== undefined) stack.push(n.objectAssignmentInitializer);
      return;
    }
    ts.forEachChild(n, (c) => {
      stack.push(c);
      return undefined;
    });
  };
  const drain = (): void => {
    while (worklist.length > 0) {
      const u = worklist.pop()!;
      ts.forEachChild(u, (c) => {
        visitExec(c, true);
        return undefined;
      });
    }
  };
  sf.statements.forEach((stmt, stmtIndex) => {
    at = stepOf[stmtIndex]!;
    if (isAmbient(stmt) || ts.isFunctionDeclaration(stmt)) return;
    if (ts.isVariableStatement(stmt)) {
      stmt.declarationList.declarations.forEach((decl, d) => {
        // A sync-inert initializer runs nothing while it evaluates: what
        // it creates can first run AFTER this declarator bound — half a
        // step later (so its own bindings, and every earlier one, never
        // need a guard on its account).
        // (A pattern is never inert: its defaults run, and it reads
        // through getters and iterators.)
        const inertInit = ts.isIdentifier(decl.name) && (decl.initializer === undefined || syncInert(decl.initializer));
        at = stepOf[stmtIndex]! + d + (inertInit ? 0.5 : 0);
        visitExec(decl, false);
        drain();
      });
      return;
    }
    if (ts.isClassDeclaration(stmt)) execClass(stmt, false);
    else visitExec(stmt, false);
    drain();
  });

  // 3. Flag the bindings some runnable unit can reach early.
  const tag = (L.fileTag.get(sf) ?? "").replace(/^%/, "") || "e.";
  for (const [sym, c] of candidates) {
    const ref = refIndex.get(sym);
    if (cycleRefs !== null ? !cycleRefs.has(sym) && c.always !== true : ref === undefined || ref > c.index) continue;
    let flagId: string;
    if (c.isClass) {
      flagId = `%g.${tag}%tdzc.${c.name}`;
    } else if (c.flagOnly === true) {
      flagId = `%g.${tag}%tdzf.${c.name}`;
    } else {
      if (c.global === null) continue; // alias plumbing / no storage
      flagId = `${c.global.id}%tdz`;
    }
    const flag: IrGlobal = { id: flagId, name: `%tdz.${c.name}`, type: BOOL, mutable: true };
    L.globalsList.push(flag);
    const b: TdzBinding = {
      name: c.name,
      sf,
      declIndex: c.index,
      declNode: c.declNode,
      flag,
      everywhere,
      isClass: c.isClass,
      cluster: cluster?.files ?? null,
      fence: c.fence ?? null,
    };
    tdz.bySymbol.set(sym, b);
    if (c.global !== null) tdz.byGlobalId.set(c.global.id, b);
    tdz.byFlagId.set(flag.id, b);
  }
}

/** The IR side: guards every access to a flagged module global whose
 * enclosing unit the analysis could not prove late enough. Rewrites the
 * lowered functions in place (shared subtrees are visited once; the
 * wrappers this pass creates are never re-entered). */
export function insertModuleTdzChecks(tdz: ModuleTdz, functions: IrFunction[], globals: IrGlobal[]): void {
  if (tdz.bySymbol.size === 0) return;
  for (const fn of functions) {
    const created = new WeakSet<object>();
    const processed = new WeakSet<object>();
    const memo = new Map<object, Record<string, unknown>>();
    let temps = 0;
    const guarded = (id: string, loc: SrcLoc | undefined): TdzBinding | null => {
      const b = tdz.byGlobalId.get(id);
      if (b === undefined || loc === undefined) return null;
      return tdz.needsCheck(b, loc.file, loc.start) ? b : null;
    };
    const mark = <T extends object>(n: T): T => {
      created.add(n);
      return n;
    };
    /** The replacement for one IR node in its parent slot (or itself). */
    const rewrite = (node: Record<string, unknown>): Record<string, unknown> => {
      const done = memo.get(node);
      if (done !== undefined) return done;
      const out = rewriteOnce(node);
      memo.set(node, out);
      return out;
    };
    const rewriteOnce = (node: Record<string, unknown>): Record<string, unknown> => {
      const kind = node["kind"];
      const loc = node["loc"] as SrcLoc | undefined;
      if (kind === "varRef") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null) return node;
        return mark({ kind: "seqExpr", stmts: [tdz.checkStmt(b, loc!, tdz.nameAt(b, loc!))], result: node, type: node["type"], loc });
      }
      walkChildren(node);
      if (kind === "incDec") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null) return node;
        return mark({ kind: "seqExpr", stmts: [tdz.checkStmt(b, loc!, tdz.nameAt(b, loc!))], result: node, type: node["type"], loc });
      }
      if (kind === "assign" || kind === "assignExpr") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null) return node;
        if (b.fence !== null) {
          // A var-like binding's early WRITE is Node's too: it lands, and
          // a later read sees it (a declaration with an initializer
          // overwrites it later, as in Node; one without stores nothing).
          // So the write marks the binding as holding a value.
          const value = node["value"] as IrExpr;
          const tmpId = `%tdzv.${temps++}`;
          fn.locals.push({ id: tmpId, name: "%tdzv", type: value.type, mutable: false });
          node["value"] = mark({
            kind: "seqExpr",
            stmts: [{ kind: "varDecl", localId: tmpId, init: value, loc }, tdz.flagSet(b, loc!)],
            result: { kind: "varRef", localId: tmpId, type: value.type, loc },
            type: value.type,
            loc,
          });
          return node;
        }
        // Node's PutValue order: the RHS evaluates, THEN the binding's
        // state is tested.
        const value = node["value"] as IrExpr;
        const tmpId = `%tdzv.${temps++}`;
        fn.locals.push({ id: tmpId, name: "%tdzv", type: value.type, mutable: false });
        node["value"] = mark({
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: tmpId, init: value, loc }, tdz.checkStmt(b, loc!, tdz.nameAt(b, loc!))],
          result: { kind: "varRef", localId: tmpId, type: value.type, loc },
          type: value.type,
          loc,
        });
        return node;
      }
      if (kind === "forOf") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null || b.fence !== null) return node;
        // Each iteration's binding write: next() ran, then PutValue tests.
        node["body"] = [tdz.checkStmt(b, loc!), ...(node["body"] as IrStmt[])];
        return node;
      }
      return node;
    };
    const walkChildren = (node: Record<string, unknown>): void => {
      if (processed.has(node)) return;
      processed.add(node);
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "loc") continue;
        const v = node[key];
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            const item = v[i];
            if (item !== null && typeof item === "object" && !created.has(item)) {
              if (typeof (item as { kind?: unknown }).kind === "string") v[i] = rewrite(item as Record<string, unknown>);
              else walkChildren(item as Record<string, unknown>);
            }
          }
        } else if (v !== null && typeof v === "object" && !created.has(v)) {
          if (typeof (v as { kind?: unknown }).kind === "string") node[key] = rewrite(v as Record<string, unknown>);
          else walkChildren(v as Record<string, unknown>);
        }
      }
    };
    fn.body = fn.body.map((s) => rewrite(s as unknown as Record<string, unknown>) as unknown as IrStmt);
  }
  for (const h of tdz.fenceHelpers.values()) functions.push(h);
  if (process.env["SCRIPTC_TDZ_ASSERT"] === "1") assertTdzCoverage(tdz, functions);
  dropUnusedFlags(tdz, functions, globals);
}

/** A flag no guard ended up testing (its reads lowered to something other
 * than a global access — a const alias of a class, a folded literal):
 * its global and its set statements go, so the module is byte-identical
 * to an unguarded build wherever nothing is guarded. */
function dropUnusedFlags(tdz: ModuleTdz, functions: IrFunction[], globals: IrGlobal[]): void {
  const allFlags = new Set<string>();
  for (const b of tdz.bySymbol.values()) if (b.sharedFlag !== true) allFlags.add(b.flag.id);
  const used = new Set<string>();
  const seen = new WeakSet<object>();
  const scanUse = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) scanUse(x);
      return;
    }
    const r = v as Record<string, unknown>;
    const checked = checkedFlagOf(r);
    if (checked !== null) used.add(checked);
    for (const k of Object.keys(r)) if (k !== "type" && k !== "loc") scanUse(r[k]);
  };
  for (const fn of functions) scanUse(fn.body);
  const unused = new Set([...allFlags].filter((id) => !used.has(id)));
  if (unused.size === 0) return;
  const seen2 = new WeakSet<object>();
  const strip = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen2.has(v)) return;
    seen2.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const x = v[i] as Record<string, unknown> | null;
        if (x !== null && typeof x === "object" && x["kind"] === "assign" && unused.has(x["localId"] as string)) {
          v.splice(i, 1);
          i--;
        } else {
          strip(x);
        }
      }
      return;
    }
    const r = v as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== "type" && k !== "loc") strip(r[k]);
  };
  for (const fn of functions) strip(fn.body);
  for (let i = globals.length - 1; i >= 0; i--) if (unused.has(globals[i]!.id)) globals.splice(i, 1);
  for (const [sym, b] of tdz.bySymbol) {
    if (!unused.has(b.flag.id)) continue;
    tdz.bySymbol.delete(sym);
    for (const [id, gb] of tdz.byGlobalId) if (gb === b) tdz.byGlobalId.delete(id);
  }
}
