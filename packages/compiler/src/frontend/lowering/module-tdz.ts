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
 *
 * The parts: this module holds the binding model (ModuleTdz) and its
 * per-access decision; module-tdz-analysis.ts the program-wide analysis
 * and the source occurrences; module-tdz-file.ts the per-file step replay
 * and a cycle cluster's references; module-tdz-guards.ts the IR pass, the
 * coverage invariant and the unused-flag sweep.
 */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, STRING, VOID } from "../../ir/nodes.js";
import type { IrExpr, IrFunction, IrGlobal, IrStmt, SrcLoc } from "../../ir/nodes.js";
import { resolveImport } from "../program.js";

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

export const isStaticMember = (n: ts.Node): boolean =>
  (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Static) !== 0;

/** A function-like evaluation unit (see the header). */
export function isUnit(n: ts.Node): boolean {
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

export function isAmbient(n: ts.Node): boolean {
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
export const FENCE_HELPER = "%tdzfence.";

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
