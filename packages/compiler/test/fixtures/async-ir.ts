/* Hand-built async IR for the wasm state-machine pass (fib-ir.ts's
 * pattern: there is no compileToIr, so the pass's input is written out by
 * hand). Everything here is shaped exactly like the frontend's output —
 * async functions carry the INNER type as `returnType`, call sites of them
 * already carry promise<T>, and `await <non-thenable>` is the seqExpr
 * around a zero-argument `async.hop`. */
import type { IrClassDef, IrExpr, IrFunction, IrModule, IrStmt, IrType, SrcLoc } from "../../src/ir/nodes.js";
import { BOOL, F64, RUNTIME_ERROR_CLASSES, STRING, VOID } from "../../src/ir/nodes.js";

export const loc: SrcLoc = { file: "async.ts", start: 0, end: 0 };

export const promiseOf = (inner: IrType): IrType => ({ kind: "promise", inner });

export const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
export const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
export const bool = (value: boolean): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
export const v = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
export const call = (callee: string, args: IrExpr[], type: IrType): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
export const await_ = (value: IrExpr, type: IrType): IrExpr => ({ kind: "awaitExpr", value, type, loc });

/** `await <non-thenable>`: the operand parks in a hidden local, the hop
 * takes the one microtask turn, the local is the value. */
export const hop = (tmpId: string, value: IrExpr): IrExpr => ({
  kind: "seqExpr",
  stmts: [
    { kind: "varDecl", localId: tmpId, init: value, loc },
    { kind: "exprStmt", expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc }, loc },
  ],
  result: v(tmpId, value.type),
  type: value.type,
  loc,
});

/** A `closure` value over a lifted lambda, capturing the named boxed
 * locals of the creating function (nodes.ts's IrExpr "closure"). */
export const closureOver = (fnName: string, captures: string[]): IrExpr => ({
  kind: "closure",
  fnName,
  captures,
  type: { kind: "func", params: [], ret: VOID },
  loc,
});

export const varDecl = (localId: string, init: IrExpr | null): IrStmt => ({ kind: "varDecl", localId, init, loc });
export const assign = (localId: string, value: IrExpr): IrStmt => ({ kind: "assign", localId, value, loc });
export const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
export const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });
export const log = (args: IrExpr[]): IrStmt =>
  exprStmt({ kind: "intrinsic", name: "console.log", args, type: VOID, loc });

export const local = (
  id: string,
  type: IrType,
  extra: { boxed?: true; tdz?: true; mutable?: boolean } = {},
): IrFunction["locals"][number] => ({ id, name: id, type, mutable: extra.mutable ?? true, ...extra });

/** The five runtime-provided error classes (registerBuiltinErrorClasses's
 * IrClassDef shape, lower-classes.ts:326-368), hand-mirrored since this
 * fixture has no compileToIr to synthesize them: every real module
 * carries these whether or not user code mentions Error (emitter.ts:25-
 * 31's five-error-classes invariant), and the wasm emitter's
 * emitErrIntervalTest reads %Error's preorder interval unconditionally —
 * a module missing them throws "no %Error in the class graph" the moment
 * ANY runtime helper touching errors (e.g. a promise's rejection report)
 * is built, not only when user code constructs one. */
export const runtimeErrorClasses: IrClassDef[] = [...RUNTIME_ERROR_CLASSES].map(([irName, rec]) => ({
  name: irName,
  runtime: true as const,
  ...(rec.base ? { base: rec.base } : {}),
  fields: [
    { name: "name", type: STRING },
    { name: "message", type: STRING },
    { name: "%code", type: STRING },
  ],
  loc,
}));

/** A module around one async function: a promise SOURCE it can await
 * (`mkp`, an ordinary function returning Promise<number>) and an entry
 * that calls the async function so reachability finds everything. */
export function asyncModule(fn: IrFunction, extra: IrFunction[] = []): IrModule {
  return {
    irVersion: 3,
    sourceFile: "async.ts",
    entry: "%main",
    classes: runtimeErrorClasses,
    functions: [
      // A promise SOURCE the async body can await. Its own body is
      // uninteresting (and out of tier — the point is the call site's
      // promise<number> type).
      {
        name: "mkp",
        params: [],
        returnType: promiseOf(F64),
        locals: [local("p.0", promiseOf(F64))],
        body: [varDecl("p.0", null), ret(v("p.0", promiseOf(F64)))],
        loc,
      },
      fn,
      ...extra,
      {
        name: "%main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [exprStmt(call(fn.name, [], promiseOf(fn.returnType)))],
        loc,
      },
    ],
  };
}

/** The loader's INTERNAL dependency wait: `module.await(p)`, which the
 * frontend only ever emits at the root of an exprStmt. */
export const moduleAwait = (dep: IrExpr): IrExpr => ({
  kind: "intrinsic",
  name: "module.await",
  args: [dep],
  type: VOID,
  loc,
});

/** A module evaluation promise global — what `asyncCacheGlobal` and
 * `asyncCycleCacheGlobal` name (mutable, promise-typed, "%g." namespace). */
export const promiseGlobal = (id: string): NonNullable<IrModule["globals"]>[number] => ({
  id,
  name: id,
  type: promiseOf(VOID),
  mutable: true,
});

/** The canonical two-await body:
 *
 *   async function f(): Promise<number> {
 *     const a = await mkp();
 *     await mkp();
 *     return a;
 *   }
 */
export function twoAwaits(): IrFunction {
  return {
    name: "f",
    params: [],
    returnType: F64,
    async: true,
    locals: [local("a.0", F64)],
    body: [
      varDecl("a.0", await_(call("mkp", [], promiseOf(F64)), F64)),
      exprStmt(await_(call("mkp", [], promiseOf(F64)), F64)),
      ret(v("a.0", F64)),
    ],
    loc,
  };
}
