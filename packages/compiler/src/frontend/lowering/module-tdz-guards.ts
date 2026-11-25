/* The module-scope temporal dead zone, IR side: the pass that guards
 * every lowered access to a flagged module global (insertModuleTdzChecks),
 * the source-coverage invariant (assertTdzCoverage) and the dropping of
 * flags no guard tests. module-tdz.ts' header describes the whole design. */
import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrFunction, IrGlobal, IrStmt, SrcLoc } from "../../ir/nodes.js";
import { ModuleTdz, checkedFlagOf, type TdzBinding } from "./module-tdz.js";

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

/** The IR side: guards every access to a flagged module global whose
 * enclosing unit the analysis could not prove late enough. Rewrites the
 * lowered functions in place (shared subtrees are visited once; the
 * wrappers this pass creates are never re-entered). */
/** GH #256: stores the program makes at INSTANTIATION, before any module
 * evaluates — the entry's module-`var` hoisting, which also gives a
 * checked-dynamic `let` slot its dyn undefined (buildMain). They are not
 * source accesses, so the TDZ pass never guards them: a guard there threw
 * the binding's ReferenceError at program start, outside every try (its
 * synthesized loc, the file's first position, can fall inside a function
 * unit that starts there). */
export const INSTANTIATION_WRITES = new WeakSet<object>();

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
    /** Whether `n` (already rewritten) holds a node this pass created. */
    const holdsCheck = (n: object): boolean =>
      created.has(n) ||
      Object.entries(n).some(([k, v]) =>
        k !== "type" && k !== "loc" && v !== null && typeof v === "object" &&
        (Array.isArray(v) ? v.some((x) => x !== null && typeof x === "object" && holdsCheck(x as object)) : holdsCheck(v as object)));
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
      // A folded tuple `t.length` (tuple-length.ts) keeps its receiver as
      // `tupleOf`, which nothing evaluates. A receiver that now holds a
      // TDZ check may throw, as JavaScript's read of it does, so it is
      // evaluated for effect before the constant.
      if (kind === "numLit" && node["tupleOf"] !== undefined && holdsCheck(node["tupleOf"] as object)) {
        const recv = node["tupleOf"] as IrExpr;
        delete node["tupleOf"];
        return mark({ kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: recv, loc: recv.loc }], result: node, type: node["type"], loc });
      }
      if (kind === "incDec") {
        const b = guarded(node["localId"] as string, loc);
        if (b === null) return node;
        return mark({ kind: "seqExpr", stmts: [tdz.checkStmt(b, loc!, tdz.nameAt(b, loc!))], result: node, type: node["type"], loc });
      }
      if (kind === "assign" || kind === "assignExpr") {
        if (INSTANTIATION_WRITES.has(node)) return node;
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
