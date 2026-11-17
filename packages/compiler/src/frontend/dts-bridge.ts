/* The declared-surface bridge (SEMANTICS.md S133): a program types against
 * an opted-in npm package's SHIPPED declarations while the package's JS is
 * what compiles (npm-static.ts, "the declared-surface view"). The checker
 * resolves every program-side use of the package to a declaration in the
 * mirrored .d.ts; the lowering needs the JS that implements it. This
 * module answers that mapping for the checker facade's symbol-declaration
 * surface (CheckerFacade.setSymbolRedirect):
 *
 *   - an EXPORT of the declarations (a class, function, const, default)
 *     maps to the JS module's export of the same name — resolved through
 *     the JS module's own aliases (`const { Command } = require(...)`,
 *     `exports.Command = Command`) to the binding it names, and, for a
 *     declared CLASS, to the JS class itself (the instance type's
 *     declaration is what types.ts maps to a struct);
 *   - a MEMBER of a declared class maps to the JS class's member of the
 *     same name and staticness (methods, fields assigned in the
 *     constructor, accessors) — the overload signatures of one declared
 *     method all map to its one implementation.
 *
 * Interfaces, type aliases and everything else with no runtime value keep
 * their declared meaning: they are types, and types stay the declared ones
 * (getTypeAtLocation answers the declared type of every program
 * expression). Where the declared type of a use differs from what the
 * implementation produces, the lowering converts with a check — the
 * resolved overload's return (reconcileOverloadReturn), argument and
 * field coercions — and a mismatch stops by name. A declaration with no
 * JS counterpart stays unmapped: its use meets the ordinary npm fences. */

import * as ts from "./ts7/adapter.js";
import { isDtsMirrorPath, npmStaticDtsViews } from "./npm-static.js";

type Sym = ts.Symbol;

interface ViewExports {
  /** Declared export symbol (alias-resolved) → export name. */
  declared: Map<Sym, string>;
  /** JS export name → JS export symbol (as exported). */
  js: Map<string, Sym>;
}

const pathInMirror = (p: string): boolean => isDtsMirrorPath(p);
/** The mirror directory segment (npm-static.ts DTS_MIRROR_SEGMENT). */
const MIRROR_SEGMENT = "/__tsinter_dts__";

export function installDtsBridge(program: ts.Program): void {
  const views = npmStaticDtsViews();
  const checker = program.getTypeChecker();
  if (views.size === 0) {
    checker.setSymbolRedirect(null);
    declaredMemberLookup = null;
    return;
  }
  let exportsOfViews: ViewExports[] | null = null;
  // A view's declaration MODULE → the JS module it describes: a namespace
  // import (`import * as p from "@clack/prompts"`) binds the former, and its
  // member reads then resolve as any program module's do, each member
  // through the export mapping (SEMANTICS.md S133 (n)). Nested namespace
  // exports map through `declared`/`js` already.
  const moduleMap = new Map<Sym, Sym>();
  const moduleSymbolOf = (sf: ts.SourceFile | undefined): Sym | undefined =>
    sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
  const exportsOf = (mod: Sym | undefined): readonly Sym[] => {
    if (mod === undefined) return [];
    try {
      return checker.raw.getExportsOfModule(mod);
    } catch {
      return [];
    }
  };
  const resolveAlias = (s: Sym): Sym => (s.flags & ts.SymbolFlags.Alias ? checker.rawGetAliasedSymbol(s) : s);
  const viewExports = (): ViewExports[] => {
    if (exportsOfViews !== null) return exportsOfViews;
    exportsOfViews = [];
    for (const view of views.values()) {
      const declared = new Map<Sym, string>();
      const mirrorMod = moduleSymbolOf(program.getSourceFile(view.mirrorEntry));
      // `export = picocolors` (a declared const the whole module IS): the
      // const maps to the JS module's own `module.exports = …` value, and
      // its MEMBERS (which the module's exports list repeats) stay the
      // declared type's members — a member read reads the implementation
      // value's own member and crosses it (SEMANTICS.md S133).
      const declaredEq = mirrorMod?.getExports().get("export=" as ts.__String);
      const eqIsConst =
        declaredEq !== undefined &&
        checker.rawDeclarationsOf(resolveAlias(declaredEq)).some((d) => ts.isVariableDeclaration(d));
      if (!eqIsConst) {
        // Only the OWNING view maps a declaration (one under its own mirror):
        // a re-export of another viewed package's name (`export { isCancel }
        // from "pcore"`) maps through its own export alias only, so its JS
        // export of that name (a wrapper, or the re-export itself) answers
        // that package's uses, and pcore's view answers pcore's (GH #237).
        const mirrorRoot = view.mirrorEntry.slice(0, view.mirrorEntry.indexOf(MIRROR_SEGMENT) + MIRROR_SEGMENT.length);
        for (const e of exportsOf(mirrorMod)) {
          const resolved = resolveAlias(e);
          if (resolved === e || checker.symbolDeclaredIn(resolved, (p) => p.startsWith(mirrorRoot))) declared.set(resolved, e.name);
          declared.set(e, e.name);
        }
      }
      if (declaredEq !== undefined) {
        declared.set(resolveAlias(declaredEq), "export=");
        declared.set(declaredEq, "export=");
      }
      const js = new Map<string, Sym>();
      for (const entry of view.jsEntries) {
        // A CommonJS module's exports answer through its module TYPE (the
        // type of module.exports); ES modules answer either way.
        const mod = moduleSymbolOf(program.getSourceFile(entry));
        if (mod === undefined) continue;
        if (mirrorMod !== undefined && declaredEq === undefined && !moduleMap.has(mirrorMod)) moduleMap.set(mirrorMod, mod);
        // An ESM implementation of `export =` declarations (postgres: CommonJS
        // .d.ts over an ESM `export default`): the default-import binding the
        // declarations type as `module.exports` is the ESM default export.
        const jsEq = mod.getExports().get("export=" as ts.__String) ?? mod.getExports().get("default" as ts.__String);
        if (jsEq !== undefined && !js.has("export=")) js.set("export=", jsEq);
        const named = exportsOf(mod);
        const props = named.length > 0 ? named : checker.getPropertiesOfType(checker.getTypeOfSymbol(mod));
        for (const e of props) {
          if (!js.has(e.name)) js.set(e.name, e);
        }
      }
      exportsOfViews.push({ declared, js });
      nestedNamespaces(declared, js, new Set());
    }
    return exportsOfViews;
  };
  const isFileModule = (s: Sym): boolean => checker.rawDeclarationsOf(s).some((d) => ts.isSourceFile(d));
  /** A namespace export (`export * as iso from "./iso.js"`, zod's
   * `z.iso.date()`) that the declarations AND the JS both make a module
   * namespace: that module's exports map name for name, as the entry's do,
   * and so on down. */
  const nestedNamespaces = (declared: Map<Sym, string>, js: Map<string, Sym>, seen: Set<Sym>): void => {
    for (const [dsym, name] of declared) {
      if (!(dsym.flags & ts.SymbolFlags.ValueModule) || seen.has(dsym) || !isFileModule(dsym)) continue;
      const j = js.get(name);
      if (j === undefined) continue;
      const jmod = resolveAlias(j);
      if (!(jmod.flags & ts.SymbolFlags.ValueModule) || !isFileModule(jmod)) continue;
      seen.add(dsym);
      const d2 = new Map<Sym, string>();
      for (const e of exportsOf(dsym)) {
        d2.set(resolveAlias(e), e.name);
        d2.set(e, e.name);
      }
      const j2 = new Map<string, Sym>();
      for (const e of exportsOf(jmod)) j2.set(e.name, e);
      exportsOfViews!.push({ declared: d2, js: j2 });
      nestedNamespaces(d2, j2, seen);
    }
  };

  /** The JS class a value symbol names (the symbol itself when it is one;
   * else the class its type's symbol declares — `exports.C = C` through a
   * property assignment). */
  const classOf = (s: Sym): Sym | null => {
    if (s.flags & ts.SymbolFlags.Class) return s;
    const t = checker.getTypeOfSymbol(s);
    const ts_ = t.getSymbol();
    return ts_ !== undefined && ts_.flags & ts.SymbolFlags.Class ? ts_ : null;
  };

  const memo = new Map<Sym, Sym | null>();
  const redirect = (sym: Sym): Sym | null => {
    if (!checker.symbolDeclaredIn(sym, pathInMirror)) return null;
    if (memo.has(sym)) return memo.get(sym)!;
    memo.set(sym, null); // cycle guard
    const answer = computeRedirect(sym);
    memo.set(sym, answer);
    return answer;
  };

  const computeRedirect = (sym: Sym): Sym | null => {
    const views = viewExports();
    if (sym.flags & ts.SymbolFlags.ValueModule) {
      const jsMod = moduleMap.get(sym);
      if (jsMod !== undefined) return jsMod;
    }
    for (const v of views) {
      const name = v.declared.get(sym);
      if (name === undefined) continue;
      const j = v.js.get(name);
      if (j === undefined) return null;
      // Hop by hop (the facade's redirect-aware alias resolution): a JS re-export
      // of another viewed package's name stops at THAT package's own export
      // (its wrapper), not at the declaration the raw chain ends on (GH #237).
      let jr = j.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(j) : j;
      // GH #237: the JS re-exports a binding of ANOTHER viewed package
      // (@clack/prompts' `export { isCancel }` of @clack/core's import). That
      // package's bare specifier types against its declarations program-wide,
      // so the JS alias lands on a declaration: keep redirecting to the
      // implementation, whatever order the views were registered in.
      if (checker.symbolDeclaredIn(jr, pathInMirror)) {
        // The alias leads back to this very declaration: another view (the
        // declaring package's own) maps it.
        if (jr === sym) continue;
        const deeper = redirect(jr);
        if (deeper === null) continue;
        jr = deeper;
      }
      if (sym.flags & ts.SymbolFlags.Class) return classOf(jr) ?? jr;
      return jr;
    }
    // A member of a declared class: the JS class's member of the same name.
    const decl = checker.rawDeclarationsOf(sym)[0];
    const owner = decl?.parent;
    if (decl === undefined || owner === undefined || !ts.isClassDeclaration(owner) || owner.name === undefined) return null;
    const ownerSym = checker.getSymbolAtLocation(owner.name);
    if (ownerSym === undefined) return null;
    const jsClass = redirect(ownerSym);
    if (jsClass === null || !(jsClass.flags & ts.SymbolFlags.Class)) return null;
    const isStatic = ts.canHaveModifiers(decl) && (ts.getModifiers(decl) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    const holder = isStatic ? checker.getTypeOfSymbol(jsClass) : checker.getDeclaredTypeOfSymbol(jsClass);
    const member = checker.getPropertyOfType(holder, sym.name);
    if (member === undefined || checker.symbolDeclaredIn(member, pathInMirror)) return null;
    return member;
  };

  checker.setSymbolRedirect((sym) => redirect(sym));

  // A declared export of a view's entry (or of a namespace export nested in
  // it) whose JS module exports no value of that name. Only those: a
  // declaration the bridge never maps (a declared class member, a module
  // the JS does not make a namespace) is not a missing export, whatever
  // its redirect answers.
  unmappedExportLookups.set(program, (sym) => {
    for (const v of viewExports()) {
      const name = v.declared.get(sym);
      if (name !== undefined) return !v.js.has(name);
    }
    return false;
  });

  // The reverse question (the implementation's side): the DECLARED type of
  // a JS class's member, where the declarations describe that class.
  let declaredClassOfJs: Map<Sym, Sym> | null = null;
  declaredMemberLookup = (jsClass, name, isStatic) => {
    if (declaredClassOfJs === null) {
      declaredClassOfJs = new Map();
      for (const v of viewExports()) {
        for (const dsym of v.declared.keys()) {
          if (!(dsym.flags & ts.SymbolFlags.Class)) continue;
          const j = redirect(dsym);
          if (j !== null && !declaredClassOfJs.has(j)) declaredClassOfJs.set(j, dsym);
        }
      }
    }
    const dsym = declaredClassOfJs.get(jsClass);
    if (dsym === undefined) return undefined;
    const holder = isStatic ? checker.getTypeOfSymbol(dsym) : checker.getDeclaredTypeOfSymbol(dsym);
    const prop = checker.getPropertyOfType(holder, name);
    return prop === undefined ? undefined : checker.getTypeOfSymbol(prop);
  };
}

let declaredMemberLookup: ((jsClass: Sym, name: string, isStatic: boolean) => ts.Type | undefined) | null = null;
/** Per program: preflight judges several loads (scout, base, probe), and a
 * symbol is only meaningful against the program whose bridge mapped it. */
const unmappedExportLookups = new WeakMap<ts.Program, (sym: Sym) => boolean>();

/** True when `sym` is an export a viewed package's entry declarations
 * declare and its JS entry does not export (SEMANTICS.md S133 (j)'s
 * build-time refusal). False for anything the bridge does not judge. */
export function isUnmappedDeclaredExport(program: ts.Program, sym: Sym): boolean {
  return unmappedExportLookups.get(program)?.(sym) ?? false;
}

/** The type the shipped declarations give member `name` of the JS class
 * `jsClass` (a compiled npm package's class the declarations describe), or
 * undefined. The implementation's own fields inference leaves `any` (the
 * `this.parent = null` idiom) take it: the declaration is the claim, and
 * every value stored there is checked against it (SEMANTICS.md S133). */
export function declaredMemberTypeOf(jsClass: Sym, name: string, isStatic = false): ts.Type | undefined {
  return declaredMemberLookup?.(jsClass, name, isStatic);
}
