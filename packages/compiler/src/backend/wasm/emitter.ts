/* IR → WebAssembly (WasmGC). The wasm backend consumes the SAME in-memory
 * IrModule the C and LLVM backends do (never the JSON dump) and produces a
 * binary module — bytes, not text, and not a translation unit: nothing on
 * this lane reaches clang. A .wasm has no scr_* runtime linked beside it
 * and no C ABI to conform to; the runtime surface the other two backends
 * call into becomes, over time, either emitted GC code or a host import.
 * That is why this backend joins no fallback chain in either direction.
 *
 * DAY ONE THE TIER IS EMPTY. This file is the refusal skeleton and the
 * walk order — every real program refuses, by design. What matters now is
 * that each refusal names a construct precisely enough to be a work item:
 * a vague tag ("expr:unsupported", one bucket for the whole libCall
 * surface) would make the harness histogram worthless, so the tags stay
 * as fine as the construct is.
 *
 * TWO WALKS, one shape. `emitWasmModule` is the compiler contract: it
 * throws at the FIRST construct outside the tier, exactly like the LLVM
 * backend's refusal, and never emits partial or guessed code.
 * `surveyWasmModule` runs the same walk with a sink that RECORDS instead
 * of throwing, so it returns every distinct construct a program needs.
 * The survey exists because the first-refusal histogram is degenerate
 * while the tier is empty: the frontend opens every module's `%init.<i>`
 * with the same synthesized load-once guard (`if (%loaded) return;`), so
 * a first-refusal census over the corpus is one enormous `stmt:if` bucket
 * and says nothing about what to build. The survey is what makes the
 * histogram a queue. As real coverage lands the two converge.
 *
 * REFUSAL AT USE, NOT AT DECLARATION. The IR's declaration sections
 * (records, unions, classes, globals, FFI imports) are deliberately NOT
 * gated: every module carries the five synthesized runtime error classes
 * (%Error, %TypeError, %RangeError, %SyntaxError, %DOMException) and a
 * per-file `%loaded` global whether the program mentions them or not, so
 * gating on their PRESENCE refuses every program for something it never
 * uses. The constructs that consume those sections carry the honest tag
 * instead — expr:recordLit, expr:new, expr:unionWrap, expr:ffiCall — and
 * a declaration nothing reaches is not work. The two whole-module
 * emission modes have no use site to refuse at and so are still gated
 * up front.
 *
 * The switches over IrStmt/IrExpr list EVERY member with an exhaustive
 * `never` default (docs/ir.md's rule): a new IR kind breaks this build
 * loudly instead of silently falling into a generic refusal. As kinds are
 * implemented they move out of the grouped refusal arms into their own
 * case — the diff for one increment stays local, and the grouped arms
 * shrink to exactly the work that remains.
 */
import type { IrExpr, IrFunction, IrModule, IrStmt, SrcLoc } from "../../ir/nodes.js";
import { WasmUnsupportedError } from "./unsupported.js";

export { WasmUnsupportedError } from "./unsupported.js";

/** What the walk does with a construct outside the tier. The emit sink
 * throws (and never returns, which is why the nesting descent below is
 * unreachable on that path); the survey sink records and lets the walk
 * continue. */
type Refuse = (kind: string, loc?: SrcLoc) => void;

export function emitWasmModule(mod: IrModule): Uint8Array {
  walkModule(mod, (kind, loc) => {
    throw new WasmUnsupportedError(kind, loc);
  });
  // The walk found nothing outside the tier — which, while the tier is
  // empty, means the module is degenerate (every function body empty). No
  // byte emitter exists yet, so refuse: handing back an empty Uint8Array
  // would be a module no host could instantiate, dressed up as success.
  throw new WasmUnsupportedError("module:emit");
}

/** Every distinct construct this module needs from the wasm backend, in
 * first-encountered order — the work queue behind one program. Nothing
 * throws: this answers "what would it take to compile this?", not "does
 * it compile?". The walk descends through statement STRUCTURE (nested
 * bodies included) but reads expressions one level deep, at the four
 * transparent statement forms; an expression's operands stay unreachable
 * work until the expression's own kind lands. */
export function surveyWasmModule(mod: IrModule): string[] {
  const seen = new Set<string>();
  walkModule(mod, (kind) => {
    seen.add(kind);
  });
  return [...seen];
}

function walkModule(mod: IrModule, refuse: Refuse): void {
  // The two whole-module emission modes: library mode replaces main with
  // the profile's exported symbols, and the island's embedded npm graph
  // is an engine embedding. Neither has a use-site construct to refuse
  // at, so both are gated here.
  if (mod.lib !== undefined) refuse("module:lib");
  if (mod.embedded !== undefined) refuse("module:embedded");
  for (const fn of mod.functions) walkFunction(fn, refuse);
}

function walkFunction(fn: IrFunction, refuse: Refuse): void {
  // Whole-function shapes, tested BEFORE the body: each needs machinery
  // the module has no answer for yet (a fiber/state-machine lowering for
  // async and generators, a closure environment for captures), so the
  // constructs inside the body are not what blocks the function and must
  // not be reported as though they were.
  if (fn.async === true) refuse("fn:async", fn.loc);
  if (fn.generator !== undefined) refuse("fn:generator", fn.loc);
  if (fn.captures !== undefined && fn.captures.length > 0) refuse("fn:captures", fn.loc);
  // Parameter and return types are deliberately NOT gated: while no body
  // compiles, a signature check would report "type:f64" for every
  // function in the corpus and bury the spread the survey exists to show.
  // The signature gate joins when the first bodies land and the types
  // become load-bearing.
  walkBody(fn.body, refuse);
}

function walkBody(body: IrStmt[], refuse: Refuse): void {
  for (const s of body) walkStmt(s, refuse);
}

function walkStmt(s: IrStmt, refuse: Refuse): void {
  switch (s.kind) {
    /* The TRANSPARENT forms: the statement is one instruction over the
     * expression's result (drop, local.set, return), so the EXPRESSION is
     * the construct and naming the statement would blame the wrong node.
     * The valueless spellings have no expression to descend into, so
     * there the statement really is the work item. */
    case "exprStmt":
      walkExpr(s.expr, refuse);
      break;
    case "varDecl":
      if (s.init === null) refuse(`stmt:${s.kind}`, s.loc);
      else walkExpr(s.init, refuse);
      break;
    case "assign":
      walkExpr(s.value, refuse);
      break;
    case "return":
      if (s.value === null) refuse(`stmt:${s.kind}`, s.loc);
      else walkExpr(s.value, refuse);
      break;

    /* Structured control flow: wasm's own block/loop/br_if nesting covers
     * much of it, but each form still needs its own lowering (switch a
     * br_table, the labeled forms a depth-indexed break target). */
    case "if":
    case "while":
    case "doWhile":
    case "switch":
    case "for":
    case "forOf":
    case "break":
    case "continue":
    case "block":
    /* Stores into composites — each waits on the GC representation of the
     * thing being written. */
    case "arraySet":
    case "bytesSet":
    case "fieldSet":
    case "recordSet":
    case "recordKeySet":
    case "recordKeyDelete":
    /* The exception protocol (wasm exception handling, or a lowered
     * pending-flag unwind like the other two backends run). */
    case "throw":
    case "rethrow":
    case "tryCatch":
    case "runtimeFence":
      refuse(`stmt:${s.kind}`, s.loc);
      break;

    default: {
      const rest: never = s;
      refuse(`stmt:${(rest as IrStmt).kind}`, (rest as IrStmt).loc);
      return;
    }
  }
  walkNested(s, refuse);
}

/** Nested statement bodies. Only the SURVEY walk reaches this — the emit
 * walk's sink threw above. Exhaustive like the dispatch it follows, so a
 * new container kind cannot silently hide its body from the survey. */
function walkNested(s: IrStmt, refuse: Refuse): void {
  switch (s.kind) {
    case "if":
      walkBody(s.then, refuse);
      if (s.else_ !== null) walkBody(s.else_, refuse);
      break;
    case "while":
    case "doWhile":
    case "forOf":
    case "block":
      walkBody(s.body, refuse);
      break;
    case "for":
      if (s.init !== null) walkStmt(s.init, refuse);
      if (s.update !== null) walkStmt(s.update, refuse);
      walkBody(s.body, refuse);
      break;
    case "switch":
      for (const c of s.cases) walkBody(c.body, refuse);
      break;
    case "tryCatch":
      walkBody(s.tryBody, refuse);
      if (s.catchBody !== null) walkBody(s.catchBody, refuse);
      if (s.finallyBody !== null) walkBody(s.finallyBody, refuse);
      break;
    /* Leaf statements: nothing nested to descend into. */
    case "varDecl":
    case "assign":
    case "exprStmt":
    case "return":
    case "arraySet":
    case "bytesSet":
    case "fieldSet":
    case "recordSet":
    case "recordKeySet":
    case "recordKeyDelete":
    case "break":
    case "continue":
    case "throw":
    case "rethrow":
    case "runtimeFence":
      break;
    default: {
      const rest: never = s;
      void rest;
    }
  }
}

function walkExpr(e: IrExpr, refuse: Refuse): void {
  switch (e.kind) {
    /* The two BROAD namespaces name their member. "expr:libCall" would
     * collapse the entire runtime surface into one histogram bucket, and
     * that bucket would top the queue forever while saying nothing about
     * what to implement; the member name IS the work item. */
    case "libCall":
      refuse(`libCall:${e.fn}`, e.loc);
      return;
    case "intrinsic":
      refuse(`intrinsic:${e.name}`, e.loc);
      return;

    /* Scalars and locals — the first increment: f64/i32 constants, local
     * reads, and the operator set over them. */
    case "numLit":
    case "strLit":
    case "boolLit":
    case "unitLit":
    case "varRef":
    case "selfRef":
    /* Operators and the JS coercions/short-circuits around them. */
    case "bin":
    case "unary":
    case "incDec":
    case "fieldIncDec":
    case "assignExpr":
    case "toBool":
    case "logical":
    case "ternary":
    case "nullish":
    case "orDefault":
    case "seqExpr":
    /* Strings: a GC array of bytes plus the intrinsic surface over it. */
    case "strConcat":
    case "strEq":
    case "strCmp":
    case "toString":
    case "templateStrings":
    case "strIntrinsic":
    /* Optional chaining's two halves (the receiver stash and the guard). */
    case "optChain":
    case "chainRecv":
    /* Regex — a whole engine, host-imported or compiled. */
    case "regexLit":
    case "regexIntrinsic":
    /* Arrays, typed arrays, and the keyed collections. */
    case "arrayLit":
    case "arrayNewLen":
    case "arrayGet":
    case "arrIntrinsic":
    case "bytesNew":
    case "bytesIntrinsic":
    case "mapNew":
    case "mapIntrinsic":
    case "setNew":
    case "setIntrinsic":
    /* Calls and function values. */
    case "call":
    case "ffiCall":
    case "closure":
    case "callValue":
    /* Async, generators, promises. */
    case "yieldExpr":
    case "genResume":
    case "awaitExpr":
    case "awaitUnionExpr":
    case "newPromise":
    case "promiseWithResolvers":
    case "promiseVoidWiden":
    case "jsBridgePromise":
    /* Classes: GC structs, vtables for the virtual slice. */
    case "new":
    case "classRef":
    case "newValue":
    case "instanceOfValue":
    case "instanceOf":
    case "virtualCall":
    case "fieldGet":
    case "upcast":
    case "downcast":
    /* Record shapes. */
    case "recordLit":
    case "recordGet":
    case "recordKeyGet":
    case "recordOvfKeys":
    /* Tagged unions. */
    case "unionWrap":
    case "unionNarrow":
    case "unionDisc":
    case "unionKeyGet":
    case "unionIsTag":
    case "unionEq":
    /* Caught-exception snapshots. */
    case "caughtTest":
    case "caughtNarrow":
    case "caughtCheck":
    case "caughtToDyn":
    /* The dyn surface. */
    case "dynFrom":
    case "dynFromJsval":
    case "dynCall":
    case "dynInvoke":
    case "dynArrLit":
    case "dynObjLit":
    case "dynTest":
    case "dynKeyGet":
    case "dynHasKey":
    case "dynScalarEq":
    case "dynDestrCheck":
    case "dynIterN":
    case "dynCheck":
    case "jsonStringify":
    /* The island bridge — an engine embedding, so likely never on this
     * backend at all. */
    case "jsMarshal":
    case "jsOp":
    case "jsExit":
      refuse(`expr:${e.kind}`, e.loc);
      return;

    default: {
      const rest: never = e;
      refuse(`expr:${(rest as IrExpr).kind}`, (rest as IrExpr).loc);
    }
  }
}
