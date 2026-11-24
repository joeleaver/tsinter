/* Arity through function VALUES: which functions with optional or
 * defaulted parameters may become values, which slots they may enter, and
 * how a call through a function value that omits trailing arguments
 * completes.
 *
 * A func-typed IrType spells one COMPLETED signature: an optional (`x?: T`)
 * or defaulted (`x: T = e`) parameter is a `T | undefined` slot, and the
 * default's value lives in the function's own prologue, which runs on the
 * undefined arm (mapType's completed-signature contract, types.ts). So JS's
 * two arity rules are mechanical here:
 *   - a call that omits trailing arguments passes the absent value
 *     (`undefined`) for each, which is exactly what JS binds to them;
 *   - a function with surplus trailing omittable parameters enters a slot
 *     that passes fewer arguments through the general function-value
 *     adapter, which passes `undefined` for the surplus (its identity stays
 *     the original's, board #89).
 * Both are Node-exact. The one observable difference, a callee reading
 * `arguments.length`, cannot reach either path: a JS function that reads
 * `arguments` and declares parameters refuses by name at its own lowering
 * ("'arguments' in functions with declared parameters"), and one without
 * declared parameters has the rest ABI, which no padding touches. Rest
 * parameters keep their fence (a rest signature has no completed arity). */
import { DYN, type IrExpr, type IrType, type SrcLoc, canBoxFuncIntoDyn, canMarshalTypedFuncIntoIsland, typeEquals } from "../../ir/nodes.js";
import { isJsSourceFile } from "../program.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import * as ts from "../ts7/adapter.js";
import { omittedArgFor, type ParamShape } from "./lower-calls.js";
import { dynFallbackType, jsMixedObjectUnion, type Lowerer } from "./lowerer.js";

type FuncT = IrType & { kind: "func" };

/** Can a parameter slot of this type take the absent value (a missing
 * argument)? The undefined-armed union of an optional or defaulted
 * parameter, or a checked-dynamic or island slot (omittedArgFor's set). */
export function slotTakesAbsent(L: Lowerer, t: IrType): boolean {
  if (t.kind === "dyn" || t.kind === "jsval") return true;
  return t.kind === "union" && (L.unions.get(t.unionId)?.arms.some((a) => a.kind === "undefinedT") ?? false);
}

/** True when every parameter `src` declares beyond `dst`'s count can take
 * the absent value, so a `src` function serves a `dst` slot by passing
 * `undefined` for each (vacuously true when `src` has no surplus). */
export function surplusParamsAbsent(L: Lowerer, src: FuncT, dst: FuncT): boolean {
  return src.params.slice(dst.params.length).every((t) => slotTakesAbsent(L, t));
}

/** The absent argument for a surplus parameter a caller checked with
 * surplusParamsAbsent. */
export function absentArg(L: Lowerer, t: IrType, loc: SrcLoc): IrExpr {
  const absent = omittedArgFor(L, t, loc);
  if (!absent) throw new Error("lowerer bug: a surplus parameter checked absent-capable has no absent value");
  return absent;
}

/** Completes a call through a function value that passes fewer arguments
 * than the value's completed signature: appends the absent value for each
 * missing trailing parameter, in place. False, with `args` untouched, when
 * the callee has the rest ABI or a missing parameter cannot take the absent
 * value (the caller's fence stands). */
export function padOmittedArgs(L: Lowerer, callee: FuncT, args: IrExpr[], loc: SrcLoc): boolean {
  if (callee.rest === true || args.length > callee.params.length) return false;
  const missing = callee.params.slice(args.length);
  if (!missing.every((t) => slotTakesAbsent(L, t))) return false;
  for (const t of missing) args.push(absentArg(L, t, loc));
  return true;
}

/** True when a `src` function value enters a `dst` slot through
 * funcCoerceAdapter with NO stranded (trap-only) piece: no rest packs,
 * surplus source params only where each takes the absent value (the
 * adapter passes `undefined` for them), every slot parameter converts into
 * the wrapped function's own type, and the result converts back (a void
 * slot drops it; a void result answers the exact JS undefined for
 * dyn/jsval slots). The width family's func gate — widthLiftPlan bridges
 * only signatures whose every call succeeds by construction. */
export function cleanFuncAdaptable(L: Lowerer, src: FuncT, dst: FuncT): boolean {
  if (src.rest === true || dst.rest === true) return false;
  if (!surplusParamsAbsent(L, src, dst)) return false;
  for (let i = 0; i < src.params.length && i < dst.params.length; i++) {
    if (!L.coercibleValue(dst.params[i]!, src.params[i]!)) return false;
  }
  if (dst.ret.kind === "void") return src.ret.kind !== "jsval";
  if (L.coercibleValue(src.ret, dst.ret)) return true;
  return src.ret.kind === "void" && (dst.ret.kind === "dyn" || dst.ret.kind === "jsval");
}

/** The value rule for a function whose declaration has optional, defaulted
 * or rest parameters. `contextual` is the value's expression (an arrow, a
 * function expression, a reference), or null for a nested function
 * declaration or an object-literal method, which are not expressions.
 *
 * The value's type is its completed signature, and every slot it enters
 * coerces it there, so it passes when the slot spells that signature, when
 * the general adapter bridges it cleanly (fewer slot parameters, the
 * surplus omittable — `waitReady(url, timeoutMs = 10)` into a
 * `(url: string) => …` slot), or when there is no slot to judge (a nested
 * declaration or a method: each later use of the value coerces from its
 * completed type). Rest parameters refuse by name; a slot whose signature
 * the value cannot reach refuses by name. */
export function admitFunctionValue(L: Lowerer, blame: ts.Node,
  contextual: ts.Expression | null,
  shapes: readonly ParamShape[],
  funcType: IrType,): void {
  // dynRest params ride the boxed thunk (JS arity — no completed-ABI
  // spelling exists or is needed); they don't gate the value form.
  // Dynamic-tier omittable params (`{} = a` with `a: any` — jsval/dyn
  // slots) don't either: their ABI slot IS the declared param type (no
  // synthesized union), so every func-type spelling of the signature
  // already matches and short calls through the value complete with the
  // tier's undefined (omittedArgFor).
  if (
    shapes.every(
      (s) =>
        s.mode === "required" ||
        s.mode === "dynRest" ||
        s.mode === "islandRest" ||
        (s.mode === "omittable" && (s.type.kind === "dyn" || s.type.kind === "jsval")),
    )
  ) {
    return;
  }
  if (shapes.some((s) => s.mode === "rest")) {
    L.unsupported("SC1090", blame, "functions with rest parameters as values (call them directly)");
  }
  // No expression, no slot: a nested function declaration or an
  // object-literal method. The value types by its completed signature, and
  // each use (a record field, an argument, a binding) coerces from it.
  if (contextual === null) return;
  // The type the value FLOWS under: the contextual (target) type when one
  // exists, otherwise the expression's OWN inferred type — the
  // unannotated-const case (`const f = (x = 5) => ...`), where every later
  // read types the value by that inference and optional/defaulted params
  // spell their `T | undefined` slots (mapType's completed-signature
  // contract), so omitted trailing args complete with the undefined arm
  // like any direct call.
  const target = L.checker.getContextualType(contextual);
  // A JS binding whose own type has no static mapping (picocolors'
  // `let createColors = (enabled = isColorSupported) => ({ red: … })`,
  // whose result holds implicit-any closures) types every later read by
  // the JS checked-dynamic fallback — the same per-piece answer judges
  // the value here.
  const ownType = (e: ts.Expression): IrType | null => {
    const t = L.typeOf(e);
    const m = L.mapTypeOf(t);
    if (m !== null && jsMixedObjectUnion(L, e, m)) return DYN;
    if (m !== null) return m;
    return isJsSourceFile(e.getSourceFile()) ? dynFallbackType(L, e, t) : null;
  };
  const mapped = target ? L.mapTypeOf(target) : ownType(contextual);
  if (mapped && typeEquals(mapped, funcType)) return;
  // A union-typed slot (`runner || defaultRunner` under a
  // `CommandRunner | undefined` context): the value can only inhabit
  // the union's one func arm — judge by it.
  let mappedFn: IrType | null =
    mapped?.kind === "union"
      ? (() => {
          const arms = L.unions.get(mapped.unionId)?.arms.filter((a) => a.kind === "func") ?? [];
          return arms.length === 1 ? arms[0]! : null;
        })()
      : mapped;
  // A contextual type that maps to something non-functional (`picked ||
  // defaultRunner` — tsc's contextual answer for the rhs is not the
  // slot): judge by the expression's OWN completed type; the slot's
  // coercion still enforces (or adapts) the flow it lands in.
  if (mappedFn?.kind !== "func") {
    mappedFn = L.mapTypeOf(L.typeOf(contextual));
  }
  if (mappedFn && typeEquals(mappedFn, funcType)) return;
  if (mappedFn?.kind === "func" && funcType.kind === "func") {
    // A slot the general adapter bridges cleanly: the slot's callers pass
    // its parameters, the adapter converts them and passes `undefined`
    // for the value's surplus omittable ones (JS's missing-argument rule).
    if (cleanFuncAdaptable(L, funcType, mappedFn)) return;
    // A target signature that agrees on the completed parameters and
    // differs only by RETURNING the structural spawnSync-result record
    // (the CommandRunner shape): the slot coercion bridges with the
    // interned runner-value adapter, so the value passes here.
    if (L.spawnResFnAdapterPlan(funcType, mappedFn) !== null) return;
  }
  // An 'any'-typed slot is the ISLAND boundary: the host-function
  // trampoline already implements JS call semantics over the completed
  // signature — a missing engine argument arrives as undefined and takes
  // the omittable param's undefined arm (which is what triggers the
  // default), surplus arguments drop. So a function with optional/
  // defaulted params may flow into a package API whenever the completed
  // signature can cross at all (jsvalIn re-checks and speaks otherwise) —
  // commander's `.option(flags, desc, collector, [])` pattern.
  if (mapped?.kind === "jsval" &&
    canMarshalTypedFuncIntoIsland(funcType, (id) => L.shapes.get(id), (id) => L.unions.get(id))
  ) {
    return;
  }
  // The same boundary through a package's SHIPPED DECLARATIONS
  // (SEMANTICS.md S133): an argument of a call that resolves to an
  // npm-static package's .d.ts lands in the package's JavaScript, which
  // takes the value with its OWN completed signature (the per-call-site
  // instance, or the checked-dynamic box) and calls it with JS argument
  // semantics — commander's `.option(flags, desc, collect)` with
  // `collect = (value, previous = []) => ...` under the declared
  // `(value: string, previous: T) => T`.
  if (intoNpmStaticDeclaration(L, contextual) &&
    canBoxFuncIntoDyn(funcType, (id) => L.shapes.get(id), (id) => L.unions.get(id))
  ) {
    return;
  }
  L.unsupported(
    "SC1090",
    blame,
    "functions with optional or defaulted parameters as values, except where the " +
      "target type spells the completed signature with required parameters " +
      "(a '(x?: T) => R' function flows into a '(x: T | undefined) => R' slot, " +
      "or into a slot that passes fewer arguments, and a package/'any' slot " +
      "takes any signature that can cross the island boundary; otherwise call " +
      "the function directly)",
  );
}

/** Is `arg` an argument of a call whose resolved signature is declared in
 * an npm-static package's shipped declarations (its JavaScript runs the
 * call)? */
function intoNpmStaticDeclaration(L: Lowerer, arg: ts.Expression): boolean {
  let e: ts.Node = arg;
  while (ts.isParenthesizedExpression(e.parent)) e = e.parent;
  const call = e.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(e as ts.Expression)) return false;
  try {
    const sig = L.checker.getResolvedSignature(call);
    const decl = sig ? L.checker.signatureDeclaration(sig) : undefined;
    if (decl === undefined) return false;
    const sf = decl.getSourceFile();
    return sf.isDeclarationFile && npmStaticPackageOfPath(sf.fileName) !== null;
  } catch {
    return false;
  }
}
