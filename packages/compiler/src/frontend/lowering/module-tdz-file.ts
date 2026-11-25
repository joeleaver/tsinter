/* The module-scope temporal dead zone, per file: a hot import cluster's
 * reference facts (clusterRefs) and the replay of one file's top level in
 * evaluation steps that decides which bindings need an init flag
 * (analyzeFile). module-tdz.ts' header describes the whole design. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL } from "../../ir/nodes.js";
import type { IrGlobal } from "../../ir/nodes.js";
import { boundIdentifiersOf } from "./lowerer.js";
import { ModuleTdz, isAmbient, isStaticMember, isUnit, type TdzBinding } from "./module-tdz.js";

/** A hot cluster's reference facts (cycle mode). */
export interface ClusterRefs {
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

export function clusterRefs(L: Lowerer, comp: ts.SourceFile[], orderOf: ReadonlyMap<string, number>): ClusterRefs {
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
export function analyzeFile(
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
    } else if (c.global === null && L.genericFnsBySymbol.has(sym)) {
      // A function binding with no storage: a generic or implicit-any
      // binding, its alias, or a called-only rest arrow
      // (bindingRestFnNodeOf). Calls resolve statically to the compiled
      // function, so no read exists for the IR pass to guard; Node still
      // throws its TDZ ReferenceError on an early call. A flag of its own,
      // set after the declarator (withModuleTdzFlags); owedChecks places
      // the check at each early call site (GH #241).
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
