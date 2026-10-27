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
import { makeInertPredicates, nonInertTopLevel, orderedImportsOf } from "../program.js";
import { boundIdentifiersOf } from "./lowerer.js";

export interface Occurrence {
  start: number;
  end: number;
  b: TdzBinding;
  unit: ts.Node;
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
    const owner = this.ownerUnit(node);
    if (owner === null) return null;
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
      if (kind === "libCall" && r["fn"] === "global.tdzCheck") {
        const flag = (r["args"] as { localId?: string }[])[0];
        b = flag?.localId !== undefined ? this.byFlagId.get(flag.localId) : undefined;
      } else if (kind === "varRef" || kind === "assign" || kind === "assignExpr" || kind === "incDec" || kind === "forOf") {
        b = this.byGlobalId.get(r["localId"] as string);
      }
      if (b !== undefined && want.has(b)) {
        const loc = r["loc"] as SrcLoc | undefined;
        if (loc !== undefined && loc.file === sf.fileName && loc.start >= start && loc.start < end && this.unitAt(loc.file, loc.start) === owner) {
          have.set(b, (have.get(b) ?? 0) + 1);
        }
      }
      for (const k of Object.keys(r)) if (k !== "type" && k !== "loc") scan(r[k]);
    };
    scan(ir);
    const out: IrStmt[] = [];
    for (const [b, w] of want) {
      if ((have.get(b) ?? 0) >= w.count) continue;
      out.push(this.checkStmt(b, { file: sf.fileName, start: w.first.start, end: w.first.end }));
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
    if (u === null) return false;
    if (b.everywhere) return true;
    if (file !== b.sf.fileName) return false;
    const at = this.addedAt.get(u);
    return at !== undefined && at <= b.declIndex;
  }

  checkExpr(b: TdzBinding, loc: SrcLoc): IrExpr {
    return {
      kind: "libCall",
      fn: "global.tdzCheck",
      args: [
        { kind: "varRef", localId: b.flag.id, type: BOOL, loc },
        { kind: "strLit", value: b.name, type: STRING, loc },
      ],
      type: VOID,
      loc,
    };
  }

  checkStmt(b: TdzBinding, loc: SrcLoc): IrStmt {
    return { kind: "exprStmt", expr: this.checkExpr(b, loc), loc };
  }

  flagSet(b: TdzBinding, loc: SrcLoc): IrStmt {
    return { kind: "assign", localId: b.flag.id, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc };
  }

  /** The binding (any kind) an identifier reads, when this access is
   * guarded — `typeof x` folds statically typed operands away during
   * lowering, so its guard is placed at the expression, not the read. */
  guardedRef(L: Lowerer, ident: ts.Identifier): TdzBinding | null {
    let sym = L.checker.getSymbolAtLocation(ident);
    if (sym === undefined) return null;
    if (sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
    const b = this.bySymbol.get(sym);
    if (b === undefined) return null;
    const sf = ident.getSourceFile();
    return this.needsCheck(b, sf.fileName, ident.getStart(sf)) ? b : null;
  }
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
  const sccs = importSccs(L.program, files);
  const clusterHot = new Map<ts.SourceFile[], boolean>();
  const unitRefMemo = new Map<ts.SourceFile[], Set<ts.Symbol>>();
  const syncInert = makeSyncInert(L);
  for (const sf of files) {
    if (sf.isDeclarationFile) continue;
    const comp = sccs.get(sf);
    let everywhere = false;
    if (comp !== undefined && comp.length > 1) {
      if (!clusterHot.has(comp)) clusterHot.set(comp, comp.some((m) => nonInertTopLevel(L.program, m) !== null));
      everywhere = clusterHot.get(comp)!;
    }
    tdz.files.push(sf);
    analyzeFile(L, tdz, sf, everywhere ? clusterUnitRefs(L, comp!, unitRefMemo) : null, syncInert);
  }
  if (tdz.bySymbol.size > 0) collectOccurrences(L, tdz);
  return tdz;
}

/** Every source access of a flagged binding inside a unit where it is
 * guarded (ModuleTdz.occByFile). Type positions are not accesses; an
 * `extends` expression is. */
function collectOccurrences(L: Lowerer, tdz: ModuleTdz): void {
  const names = new Set<string>();
  let anyCycle = false;
  for (const b of tdz.bySymbol.values()) {
    names.add(b.name);
    if (b.everywhere) anyCycle = true;
  }
  for (const sf of tdz.files) {
    const out: Occurrence[] = [];
    const stack: ts.Node[] = [];
    const record = (n: ts.Node, sym: ts.Symbol | undefined): void => {
      if (sym === undefined) return;
      if (sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
      const b = tdz.bySymbol.get(sym);
      if (b === undefined) return;
      const start = n.getStart(sf);
      if (!tdz.needsCheck(b, sf.fileName, start)) return;
      out.push({ start, end: n.end, b, unit: stack[stack.length - 1]! });
    };
    const visit = (n: ts.Node): void => {
      if (ts.isTypeNode(n) && !(ts.isExpressionWithTypeArguments(n) && n.parent !== undefined && ts.isHeritageClause(n.parent) && n.parent.token === ts.SyntaxKind.ExtendsKeyword)) {
        return;
      }
      const unit = isUnit(n);
      if (unit) stack.push(n);
      if (stack.length > 0) {
        if (ts.isIdentifier(n)) {
          // Name pre-filter: a cycle-mode binding may be imported under
          // another name, so every identifier resolves then.
          if (anyCycle || names.has(n.text)) record(n, L.checker.getSymbolAtLocation(n));
        } else if (ts.isShorthandPropertyAssignment(n)) {
          if (anyCycle || (ts.isIdentifier(n.name) && names.has(n.name.text))) record(n.name, L.checker.getShorthandAssignmentValueSymbol(n));
          if (n.objectAssignmentInitializer !== undefined) visit(n.objectAssignmentInitializer);
          if (unit) stack.pop();
          return;
        }
      }
      ts.forEachChild(n, (c) => {
        visit(c);
        return undefined;
      });
      if (unit) stack.pop();
    };
    visit(sf);
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
      if (r["kind"] === "libCall" && r["fn"] === "global.tdzCheck") {
        const flag = (r["args"] as { localId?: string }[])[0];
        const b = flag?.localId !== undefined ? tdz.byFlagId.get(flag.localId) : undefined;
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
    for (const o of occs) {
      const uStart = o.unit.getStart(sf);
      // A unit nothing lowered (unreachable) has no IR to guard.
      if (!fileLocs.some((p) => p > uStart && p < o.unit.end)) continue;
      let stmt: ts.Node = o.unit;
      // The innermost statement (or the unit's concise body) around it.
      const find = (n: ts.Node): void => {
        if (n.getStart(sf) <= o.start && o.end <= n.end) {
          if ((ts.isStatement(n) || n === o.unit) && n !== sf) stmt = n;
          ts.forEachChild(n, (c) => {
            find(c);
            return undefined;
          });
        }
      };
      find(o.unit);
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

/** Every symbol an identifier inside some function-like unit of the
 * cluster's files resolves to — cycle mode flags exactly the bindings
 * some unit (in any member) could read. */
function clusterUnitRefs(
  L: Lowerer,
  comp: ts.SourceFile[],
  memo: Map<ts.SourceFile[], Set<ts.Symbol>>,
): Set<ts.Symbol> {
  const hit = memo.get(comp);
  if (hit !== undefined) return hit;
  const refs = new Set<ts.Symbol>();
  for (const m of comp) {
    const visit = (n: ts.Node, inUnit: boolean): void => {
      if (inUnit && ts.isIdentifier(n)) {
        let sym = L.checker.getSymbolAtLocation(n);
        if (sym !== undefined && sym.flags & ts.SymbolFlags.Alias) sym = L.checker.getAliasedSymbol(sym);
        if (sym !== undefined) refs.add(sym);
        return;
      }
      if (inUnit && ts.isShorthandPropertyAssignment(n)) {
        const sym = L.checker.getShorthandAssignmentValueSymbol(n);
        if (sym !== undefined) refs.add(sym);
      }
      const inner = inUnit || isUnit(n);
      ts.forEachChild(n, (c) => {
        visit(c, inner);
        return undefined;
      });
    };
    visit(m, false);
  }
  memo.set(comp, refs);
  return refs;
}

/** `cycleRefs` non-null: cycle mode — flag every binding some unit of the
 * cluster references (the symbols given), guarded at every unit access. */
function analyzeFile(
  L: Lowerer,
  tdz: ModuleTdz,
  sf: ts.SourceFile,
  cycleRefs: Set<ts.Symbol> | null,
  syncInert: (e: ts.Expression) => boolean,
): void {
  const everywhere = cycleRefs !== null;
  const checker = L.checker;
  const resolve = (ident: ts.Node): ts.Symbol | undefined => {
    let sym = checker.getSymbolAtLocation(ident);
    if (sym !== undefined && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym;
  };

  // 1. The file's lexical bindings, its units, and the reference maps.
  const candidates = new Map<ts.Symbol, { name: string; index: number; declNode: ts.Node; global: IrGlobal | null; isClass: boolean }>();
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
      if ((list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) return; // var: no TDZ
      if ((list.flags & ts.NodeFlags.Using) !== 0) return;
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
  const visitExec = (n: ts.Node, inUnit: boolean): void => {
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
        visitExec(n.propertyName.expression, inUnit);
      }
      if (n.name !== undefined && !ts.isIdentifier(n.name)) visitExec(n.name, inUnit);
      if (n.initializer !== undefined) visitExec(n.initializer, inUnit);
      return;
    }
    if (ts.isIdentifier(n)) {
      referenceSym(resolve(n), inUnit, n);
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      referenceSym(checker.getShorthandAssignmentValueSymbol(n), inUnit, n);
      if (n.objectAssignmentInitializer !== undefined) visitExec(n.objectAssignmentInitializer, inUnit);
      return;
    }
    ts.forEachChild(n, (c) => {
      visitExec(c, inUnit);
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
    if (cycleRefs !== null ? !cycleRefs.has(sym) : ref === undefined || ref > c.index) continue;
    let flagId: string;
    if (c.isClass) {
      flagId = `%g.${tag}%tdzc.${c.name}`;
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
        return mark({ kind: "seqExpr", stmts: [tdz.checkStmt(b, loc!)], result: node, type: node["type"], loc });
      }
      walkChildren(node);
      if (kind === "incDec") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null) return node;
        return mark({ kind: "seqExpr", stmts: [tdz.checkStmt(b, loc!)], result: node, type: node["type"], loc });
      }
      if (kind === "assign" || kind === "assignExpr") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null) return node;
        // Node's PutValue order: the RHS evaluates, THEN the binding's
        // state is tested.
        const value = node["value"] as IrExpr;
        const tmpId = `%tdzv.${temps++}`;
        fn.locals.push({ id: tmpId, name: "%tdzv", type: value.type, mutable: false });
        node["value"] = mark({
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: tmpId, init: value, loc }, tdz.checkStmt(b, loc!)],
          result: { kind: "varRef", localId: tmpId, type: value.type, loc },
          type: value.type,
          loc,
        });
        return node;
      }
      if (kind === "forOf") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null) return node;
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
  if (process.env["SCRIPTC_TDZ_ASSERT"] === "1") assertTdzCoverage(tdz, functions);
  dropUnusedFlags(tdz, functions, globals);
}

/** A flag no guard ended up testing (its reads lowered to something other
 * than a global access — a const alias of a class, a folded literal):
 * its global and its set statements go, so the module is byte-identical
 * to an unguarded build wherever nothing is guarded. */
function dropUnusedFlags(tdz: ModuleTdz, functions: IrFunction[], globals: IrGlobal[]): void {
  const allFlags = new Set<string>();
  for (const b of tdz.bySymbol.values()) allFlags.add(b.flag.id);
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
    if (r["kind"] === "libCall" && r["fn"] === "global.tdzCheck") {
      const flag = (r["args"] as IrExpr[])[0];
      if (flag !== undefined && flag.kind === "varRef") used.add(flag.localId);
    }
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
