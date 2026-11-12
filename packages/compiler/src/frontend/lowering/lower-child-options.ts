/* child_process option records as run-time VALUES (WasmGC lanes).
 *
 * An options argument that is not a plain literal — a typed const or
 * parameter (`ExecFileOptions`, `SpawnOptions`, ... — types.ts's
 * NODE_OPTION_RECORDS), a spread with overrides (`{ ...options, encoding:
 * "utf8" }`), a nullable record (`options?: ExecFileOptions | null`) —
 * lowers to the record value itself, and an interned helper reads each
 * member at run time: the supported ones drive the call, the documented
 * no-ops are skipped, and an unsupported member that is PRESENT (not
 * undefined) ends the program by name (SEMANTICS.md S122). Members a call
 * family ignores in Node (execFile passes only cwd, env, gid, shell,
 * signal, uid, windowsHide and windowsVerbatimArguments to its child) are
 * ignored here too.
 *
 * The promisified execFile also builds its rejection here, at the IR
 * level, with Node's properties (SEMANTICS.md S134): a command failure is
 * "Command failed: <cmd>\n<stderr>" with code (the exit status, or null),
 * killed, signal, cmd, stdout and stderr; a spawn failure is "spawn <file>
 * <CODE>" with errno, code, syscall, path, spawnargs, cmd, stdout and
 * stderr. The members ride the error's dynamic value (dyn.keySet), and
 * the exec-error member reads (lowerExecErrorMember) read them back. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError, dynUndefinedExpr } from "./lowerer.js";
import { locOf } from "../program.js";
import { noLoweringDiag } from "../../diagnostics/diagnostic.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  NULL_T,
  SPAWNRES_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  typeEquals,
  typeKey,
} from "../../ir/nodes.js";

const ERROR_T: IrType = { kind: "object", className: "%Error" };

/** Helpers are interned per call SITE, not per options type alone: their
 * run-time fences name the source line of the call they serve. */
const siteKey = (loc: SrcLoc): string => `${loc.file}:${loc.start}`;

/** A lifted function body under construction: locals by id, statements. */
class Fn {
  readonly locals: IrLocal[] = [];
  private n = 0;
  constructor(readonly loc: SrcLoc) {}
  local(name: string, type: IrType, mutable = true): string {
    const id = `${name}.${this.n++}`;
    this.locals.push({ id, name, type, mutable });
    return id;
  }
}

const str = (value: string, loc: SrcLoc): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const num = (value: number, loc: SrcLoc): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const bool = (value: boolean, loc: SrcLoc): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
const ref = (localId: string, type: IrType, loc: SrcLoc): IrExpr => ({ kind: "varRef", localId, type, loc });
const cat = (l: IrExpr, r: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "strConcat", left: l, right: r, type: STRING, loc });
const strEq = (l: IrExpr, r: IrExpr, loc: SrcLoc, negated = false): IrExpr => ({ kind: "strEq", negated, left: l, right: r, type: BOOL, loc });
const and = (l: IrExpr, r: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "logical", op: "&&", left: l, right: r, type: BOOL, loc });
const or = (l: IrExpr, r: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "logical", op: "||", left: l, right: r, type: BOOL, loc });
const assign = (localId: string, value: IrExpr, loc: SrcLoc): IrStmt => ({ kind: "assign", localId, value, loc });
const ifs = (cond: IrExpr, then: IrStmt[], else_: IrStmt[] | null, loc: SrcLoc): IrStmt => ({ kind: "if", cond, then, else_, loc });
const lib = (fn: string, args: IrExpr[], type: IrType, loc: SrcLoc): IrExpr => ({ kind: "libCall", fn: fn as never, args, type, loc });
const dynOf = (value: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "dynFrom", value, type: DYN, loc });
const unitDyn = (unit: "null" | "undefined", loc: SrcLoc): IrExpr =>
  dynOf({ kind: "unitLit", unit, type: unit === "null" ? NULL_T : UNDEFINED_T, loc }, loc);

/** The S122 run-time fence for an option this build does not implement,
 * worded like the compile-time SC2020 fence it stands in for. */
function optionFence(what: string, loc: SrcLoc): IrStmt {
  return { kind: "runtimeFence", code: "SC2020", message: noLoweringDiag(what, loc, undefined, true).message, loc };
}

/** The arms of `t`: a union's, else `t` itself. */
function armsOf(L: Lowerer, t: IrType): IrType[] {
  if (t.kind !== "union") return [t];
  return L.unions.get(t.unionId)?.arms ?? [];
}

type ArmHandler = (narrowed: IrExpr, arm: IrType) => IrStmt[];

/** Dispatch on the run-time arm of `read` (a pure expression of type
 * `t`): one branch per arm, its handler chosen by the arm's kind. An arm
 * with no handler gets `other` (a compile-time noLowering by default —
 * the caller lists every arm a declared option type can carry). */
function onArms(
  L: Lowerer,
  read: IrExpr,
  t: IrType,
  handlers: Partial<Record<IrType["kind"], ArmHandler>>,
  blame: ts.Node,
  what: string,
  loc: SrcLoc,
): IrStmt[] {
  const handlerFor = (arm: IrType): ArmHandler => {
    const h = handlers[arm.kind];
    if (h === undefined) L.noLowering(`${what} of type '${L.fmt(arm)}'`, blame);
    return h;
  };
  if (t.kind !== "union") return handlerFor(t)(read, t);
  const out: IrStmt[] = [];
  for (const arm of armsOf(L, t)) {
    const tag = L.armTag(t.unionId, arm);
    const h = handlerFor(arm);
    const narrowed: IrExpr = arm.kind === "undefinedT" || arm.kind === "nullT"
      ? read
      : { kind: "unionNarrow", unionId: t.unionId, tag, value: read, type: arm, loc };
    const body = h(narrowed, arm);
    if (body.length === 0) continue;
    out.push(ifs({ kind: "unionIsTag", unionId: t.unionId, tag, negated: false, value: read, type: BOOL, loc }, body, null, loc));
  }
  return out;
}

/** The record arm of an options value's type: the record itself, or the
 * one record arm of a union whose other arms are undefined/null. */
function optionsRecordOf(L: Lowerer, t: IrType): (IrType & { kind: "record" }) | null {
  if (t.kind === "record") return t;
  if (t.kind !== "union") return null;
  const arms = armsOf(L, t);
  const recs = arms.filter((a): a is IrType & { kind: "record" } => a.kind === "record");
  if (recs.length !== 1) return null;
  if (!arms.every((a) => a.kind === "record" || a.kind === "undefinedT" || a.kind === "nullT")) return null;
  return recs[0]!;
}

/** True for an options argument the run-time path takes: anything but a
 * plain object literal (no spreads), whose members the literal lowerings
 * check one by one at compile time. */
export function isRuntimeOptionsArg(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isObjectLiteralExpression(e)) return true;
  return e.properties.some((p) => ts.isSpreadAssignment(p));
}

/* ── the promisified execFile ─────────────────────────────────────────── */

/** The normalized execFile options record every %execFileAsync helper
 * takes: cwd ("" = inherit), env (hasEnv + the [k, v, ...] pairs),
 * timeout (0 = none), the kill signal (killNum NaN unless a number was
 * given, else killName — "" for the SIGTERM default), shell ("" = none,
 * else the shell's path) and enc (0 = utf8 strings, 1 = Buffers). */
function execNormShape(L: Lowerer): string {
  return L.shapes.intern([
    { name: "cwd", type: STRING },
    { name: "enc", type: F64 },
    { name: "hasEnv", type: BOOL },
    { name: "killName", type: STRING },
    { name: "killNum", type: F64 },
    { name: "pairs", type: arrayOf(STRING) },
    { name: "shell", type: STRING },
    { name: "timeout", type: F64 },
  ]);
}

/** The literal path's members as a normalized record (no shell, utf8). */
export function execNormLiteral(L: Lowerer, cwd: IrExpr, env: IrExpr, envShapeId: string, timeout: IrExpr, loc: SrcLoc): IrExpr {
  const envT: IrType = { kind: "record", shapeId: envShapeId };
  return {
    kind: "recordLit",
    fields: [
      { name: "cwd", value: cwd },
      { name: "enc", value: num(0, loc) },
      { name: "hasEnv", value: { kind: "recordGet", obj: env, shapeId: envShapeId, field: "has", type: BOOL, loc } },
      { name: "killName", value: str("", loc) },
      { name: "killNum", value: num(NaN, loc) },
      { name: "pairs", value: { kind: "recordGet", obj: env, shapeId: envShapeId, field: "pairs", type: arrayOf(STRING), loc } },
      { name: "shell", value: str("", loc) },
      { name: "timeout", value: timeout },
    ],
    type: { kind: "record", shapeId: execNormShape(L) },
    loc,
  };
  void envT;
}

/** The members the promisified execFile reads (Node's execFile passes the
 * rest of its options nowhere); each handled kind is a declared arm. */
function execFileMemberStmts(L: Lowerer, rec: IrExpr, shapeId: string, encPresent: boolean, blame: ts.Node, loc: SrcLoc, v: Record<string, string>): IrStmt[] {
  const shape = L.shapes.get(shapeId);
  if (!shape) throw new Error(`lowerer bug: options shape ${shapeId} unknown`);
  const out: IrStmt[] = [];
  const skip: ArmHandler = () => [];
  const what = (name: string): string => `the promisified execFile option '${name}'`;
  for (const field of shape.fields) {
    const read: IrExpr = { kind: "recordGet", obj: rec, shapeId, field: field.name, type: field.type, loc };
    const fence = (): IrStmt[] => [optionFence(what(field.name), loc)];
    switch (field.name) {
      case "cwd":
        out.push(...onArms(L, read, field.type, {
          string: (s) => [assign(v.cwd!, s, loc)],
          // A file: URL is its path (Node's getValidatedPath); any other
          // scheme throws Node's ERR_INVALID_URL_SCHEME there.
          url: (u) => [assign(v.cwd!, lib("url.fileURLToPathUrl", [u], STRING, loc), loc)],
          undefinedT: skip,
        }, blame, what("cwd"), loc));
        break;
      case "env":
        out.push(...onArms(L, read, field.type, {
          record: (r, arm) => {
            const helper = L.envToPairsHelper((arm as IrType & { kind: "record" }).shapeId, loc);
            if (helper === null) L.noLowering(`${what("env")} of type '${L.fmt(arm)}'`, blame, "env values must be strings (or string | undefined)");
            return [
              assign(v.hasEnv!, bool(true, loc), loc),
              assign(v.pairs!, { kind: "call", callee: helper, args: [r], type: arrayOf(STRING), loc }, loc),
            ];
          },
          undefinedT: skip,
        }, blame, what("env"), loc));
        break;
      case "timeout":
        out.push(...onArms(L, read, field.type, { f64: (n) => [assign(v.timeout!, n, loc)], undefinedT: skip }, blame, what("timeout"), loc));
        break;
      case "killSignal":
        out.push(...onArms(L, read, field.type, {
          string: (s) => [assign(v.killName!, s, loc), assign(v.killNum!, num(NaN, loc), loc)],
          f64: (n) => [assign(v.killNum!, n, loc)],
          undefinedT: skip,
        }, blame, what("killSignal"), loc));
        break;
      case "shell":
        out.push(...onArms(L, read, field.type, {
          // Node's shell: true is /bin/sh on POSIX; a string is the
          // shell's path ("" is no shell — Node tests truthiness).
          bool: (b) => [ifs(b, [assign(v.shell!, str("/bin/sh", loc), loc)], [assign(v.shell!, str("", loc), loc)], loc)],
          string: (s) => [assign(v.shell!, s, loc)],
          undefinedT: skip,
        }, blame, what("shell"), loc));
        break;
      case "encoding":
        out.push(...onArms(L, read, field.type, {
          // utf8 strings, or Buffers for "buffer"/null; Node decodes every
          // other valid encoding and answers Buffers for an invalid one —
          // not built: the run-time fence.
          string: (s) => [
            ifs(or(strEq(s, str("utf8", loc), loc), strEq(s, str("utf-8", loc), loc), loc),
              [assign(v.enc!, num(0, loc), loc)],
              [ifs(strEq(s, str("buffer", loc), loc), [assign(v.enc!, num(1, loc), loc)], [optionFence("the promisified execFile with an encoding other than \"utf8\", \"utf-8\", \"buffer\" or null", loc)], loc)],
              loc),
          ],
          nullT: () => [assign(v.enc!, num(1, loc), loc)],
          // A present key holding undefined is Node's Buffer request; an
          // absent one (an optional key — S091) the utf8 default.
          undefinedT: encPresent ? () => [optionFence("an explicit 'encoding' that may be undefined in the async exec options (Node answers Buffers for a present undefined key, strings for an absent one)", loc)] : skip,
        }, blame, what("encoding"), loc));
        break;
      case "signal":
        // An AbortSignal (types.ts slots it as a dynamic value): not
        // honored — present ends the program by name.
        if (field.type.kind === "dyn") {
          out.push(ifs({ kind: "dynTest", test: "undefined", negated: true, value: read, type: BOOL, loc }, fence(), null, loc));
        } else {
          out.push(...onArms(L, read, field.type, { undefinedT: skip }, blame, what("signal"), loc));
        }
        break;
      case "uid":
      case "gid":
        out.push(...onArms(L, read, field.type, { f64: fence, undefinedT: skip }, blame, what(field.name), loc));
        break;
      // Accepted without effect: maxBuffer is not enforced (SEMANTICS.md
      // S085 (d)); the Windows-only switches are POSIX no-ops in Node.
      case "maxBuffer":
      case "windowsHide":
      case "windowsVerbatimArguments":
        break;
      default:
        // Node's execFile reads nothing else.
        break;
    }
  }
  return out;
}

/** `%cpopts.execFile.<n>(o) -> norm` — the run-time reader of one options
 * type (a record, or a record | undefined | null union). */
function execFileNormHelper(L: Lowerer, optsT: IrType, encPresent: boolean, blame: ts.Node, loc: SrcLoc): string {
  const key = `cpopts.execFile:${encPresent}:${typeKey(optsT)}:${siteKey(loc)}`;
  const hit = L.widthHelpers.get(key);
  if (hit) return hit;
  const recT = optionsRecordOf(L, optsT);
  if (recT === null) {
    L.noLowering(
      `the promisified execFile with options of type '${L.fmt(optsT)}'`,
      blame,
      "pass an options object (a literal, a typed ExecFileOptions value, or a spread of one)",
    );
  }
  const name = `%cpopts.execFile.${L.widthHelpers.size}`;
  L.widthHelpers.set(key, name);
  const f = new Fn(loc);
  const o = f.local("o", optsT, false);
  const v: Record<string, string> = {
    cwd: f.local("cwd", STRING),
    enc: f.local("enc", F64),
    hasEnv: f.local("hasEnv", BOOL),
    killName: f.local("killName", STRING),
    killNum: f.local("killNum", F64),
    pairs: f.local("pairs", arrayOf(STRING)),
    shell: f.local("shell", STRING),
    timeout: f.local("timeout", F64),
  };
  const body: IrStmt[] = [
    { kind: "varDecl", localId: v.cwd!, init: str("", loc), loc },
    { kind: "varDecl", localId: v.enc!, init: num(0, loc), loc },
    { kind: "varDecl", localId: v.hasEnv!, init: bool(false, loc), loc },
    { kind: "varDecl", localId: v.killName!, init: str("", loc), loc },
    { kind: "varDecl", localId: v.killNum!, init: num(NaN, loc), loc },
    { kind: "varDecl", localId: v.pairs!, init: { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc }, loc },
    { kind: "varDecl", localId: v.shell!, init: str("", loc), loc },
    { kind: "varDecl", localId: v.timeout!, init: num(0, loc), loc },
  ];
  if (optsT.kind === "record") {
    body.push(...execFileMemberStmts(L, ref(o, optsT, loc), recT.shapeId, encPresent, blame, loc, v));
  } else if (optsT.kind === "union") {
    const tag = L.armTag(optsT.unionId, recT);
    const r = f.local("r", recT, false);
    body.push(ifs(
      { kind: "unionIsTag", unionId: optsT.unionId, tag, negated: false, value: ref(o, optsT, loc), type: BOOL, loc },
      [
        { kind: "varDecl", localId: r, init: { kind: "unionNarrow", unionId: optsT.unionId, tag, value: ref(o, optsT, loc), type: recT, loc }, loc },
        ...execFileMemberStmts(L, ref(r, recT, loc), recT.shapeId, encPresent, blame, loc, v),
      ],
      null,
      loc,
    ));
  }
  const normT: IrType = { kind: "record", shapeId: execNormShape(L) };
  body.push({
    kind: "return",
    value: {
      kind: "recordLit",
      fields: Object.keys(v).sort().map((k) => ({ name: k, value: ref(v[k]!, f.locals.find((l) => l.id === v[k])!.type, loc) })),
      type: normT,
      loc,
    },
    loc,
  });
  L.liftedFns.push({ name, params: [{ localId: o, name: "o", type: optsT }], returnType: normT, locals: f.locals, body, loc });
  return name;
}

/** The output representations a result field can ask for. */
type OutKind = "string" | "bytes" | "union";

function outKindOf(L: Lowerer, t: IrType, blame: ts.Node): OutKind {
  if (t.kind === "string") return "string";
  if (t.kind === "bytes" && t.elem === "u8") return "bytes";
  if (t.kind === "union") {
    const arms = armsOf(L, t);
    if (arms.length === 2 && arms.some((a) => a.kind === "string") && arms.some((a) => a.kind === "bytes" && a.elem === "u8")) return "union";
  }
  L.noLowering(`the promisified execFile with a '${L.fmt(t)}' result`, blame);
}

/** One captured stream as the result field's type, given the run-time
 * enc (0 utf8 / 1 Buffer) and the captured text (latin1 under enc 1). */
function outValue(L: Lowerer, kind: OutKind, t: IrType, text: IrExpr, raw: IrExpr, loc: SrcLoc): { pre: IrStmt[]; value: IrExpr } {
  const bytes: IrExpr = lib("buffer.fromStr", [text, str("latin1", loc)], BYTES_U8, loc);
  if (kind === "string") {
    return { pre: [ifs(raw, [optionFence("the promisified execFile with a Buffer encoding where the result is typed as a string", loc)], null, loc)], value: text };
  }
  if (kind === "bytes") {
    return { pre: [ifs(raw, [], [optionFence("the promisified execFile with a string encoding where the result is typed as a Buffer", loc)], loc)], value: bytes };
  }
  if (t.kind !== "union") throw new Error("lowerer bug: union out kind");
  return {
    pre: [],
    value: {
      kind: "ternary",
      cond: raw,
      then: { kind: "unionWrap", unionId: t.unionId, tag: L.armTag(t.unionId, BYTES_U8), value: bytes, type: t, loc },
      else_: { kind: "unionWrap", unionId: t.unionId, tag: L.armTag(t.unionId, STRING), value: text, type: t, loc },
      type: t,
      loc,
    },
  };
}

/** The interned ASYNC `%execFileAsync.v.<n>(cmd, argv, o) -> result`: the
 * options read (inside the promise, so their throws reject — Node's
 * promisify runs execFile inside the executor), the child, and Node's
 * settlement. One per (options type, result shape). */
function execFileAsyncValueHelper(L: Lowerer, optsT: IrType, resT: IrType & { kind: "record" }, encPresent: boolean, blame: ts.Node, loc: SrcLoc): string {
  const key = `execFileAsync.v:${encPresent}:${typeKey(optsT)}:${resT.shapeId}:${siteKey(loc)}`;
  const hit = L.widthHelpers.get(key);
  if (hit) return hit;
  const normT: IrType = { kind: "record", shapeId: execNormShape(L) };
  const normShape = normT.shapeId;
  const isNorm = optsT.kind === "record" && optsT.shapeId === normShape;
  const reader = isNorm ? null : execFileNormHelper(L, optsT, encPresent, blame, loc);
  const resShape = L.shapes.get(resT.shapeId);
  const outT = resShape?.fields.find((x) => x.name === "stdout")?.type;
  const errT = resShape?.fields.find((x) => x.name === "stderr")?.type;
  if (!resShape || resShape.fields.length !== 2 || outT === undefined || errT === undefined) {
    L.noLowering(`the promisified execFile with a '${L.fmt(resT)}' result`, blame);
  }
  const outKind = outKindOf(L, outT, blame);
  const errKind = outKindOf(L, errT, blame);
  const name = `%execFileAsync.v.${L.widthHelpers.size}`;
  L.widthHelpers.set(key, name);
  const f = new Fn(loc);
  const strArr = arrayOf(STRING);
  const cmd = f.local("cmd", STRING, false);
  const argv = f.local("argv", strArr, false);
  const o = f.local("o", optsT, false);
  const n = f.local("n", normT, false);
  const file = f.local("file", STRING);
  const args = f.local("args", strArr);
  const cmdText = f.local("cmdText", STRING, false);
  const r = f.local("r", SPAWNRES_T, false);
  const raw = f.local("raw", BOOL, false);
  const outS = f.local("outS", STRING, false);
  const errS = f.local("errS", STRING, false);
  const errText = f.local("errText", STRING, false);
  const en = f.local("en", STRING, false);
  const e = f.local("e", ERROR_T);
  const d = f.local("d", DYN);
  const nf = (field: string, type: IrType): IrExpr => ({ kind: "recordGet", obj: ref(n, normT, loc), shapeId: normShape, field, type, loc });
  const argvRef = ref(argv, strArr, loc);
  const joined = (arr: IrExpr): IrExpr => ({ kind: "arrIntrinsic", method: "join", receiver: arr, args: [str(" ", loc)], type: STRING, loc });
  const lenGt0 = (arr: IrExpr): IrExpr => ({
    kind: "bin",
    op: ">",
    left: { kind: "arrIntrinsic", method: "length", receiver: arr, args: [], type: F64, loc },
    right: num(0, loc),
    type: BOOL,
    loc,
  });
  const out = outValue(L, outKind, outT, ref(outS, STRING, loc), ref(raw, BOOL, loc), loc);
  const err = outValue(L, errKind, errT, ref(errS, STRING, loc), ref(raw, BOOL, loc), loc);
  const keySet = (k: string, value: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: lib("dyn.keySet", [ref(d, DYN, loc), str(k, loc), value], { kind: "void" }, loc),
    loc,
  });
  const outDyn = (kind: OutKind, text: string): IrExpr => {
    const s = ref(text, STRING, loc);
    const asBytes = dynOf(lib("buffer.fromStr", [s, str("latin1", loc)], BYTES_U8, loc), loc);
    if (kind === "string") return dynOf(s, loc);
    if (kind === "bytes") return asBytes;
    return { kind: "ternary", cond: ref(raw, BOOL, loc), then: asBytes, else_: dynOf(s, loc), type: DYN, loc };
  };
  const statusT = unionOf(L, [F64, NULL_T]);
  const signalT = unionOf(L, [STRING, NULL_T]);
  const status: IrExpr = lib("spawnRes.status", [ref(r, SPAWNRES_T, loc)], statusT, loc);
  const signal: IrExpr = lib("spawnRes.signal", [ref(r, SPAWNRES_T, loc)], signalT, loc);
  const unionToDyn = (u: IrExpr, uT: IrType, arm: IrType): IrExpr => {
    if (uT.kind !== "union") throw new Error("lowerer bug: status/signal union");
    return {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId: uT.unionId, tag: L.armTag(uT.unionId, NULL_T), negated: false, value: u, type: BOOL, loc },
      then: unitDyn("null", loc),
      else_: dynOf({ kind: "unionNarrow", unionId: uT.unionId, tag: L.armTag(uT.unionId, arm), value: u, type: arm, loc }, loc),
      type: DYN,
      loc,
    };
  };
  const failed: IrExpr = or(
    { kind: "unionIsTag", unionId: (statusT as IrType & { kind: "union" }).unionId, tag: L.armTag((statusT as IrType & { kind: "union" }).unionId, NULL_T), negated: false, value: status, type: BOOL, loc },
    {
      kind: "bin",
      op: "!==",
      left: { kind: "unionNarrow", unionId: (statusT as IrType & { kind: "union" }).unionId, tag: L.armTag((statusT as IrType & { kind: "union" }).unionId, F64), value: status, type: F64, loc },
      right: num(0, loc),
      type: BOOL,
      loc,
    },
    loc,
  );
  // The common tail of both rejections: cmd, stdout, stderr; then throw.
  const tail: IrStmt[] = [
    keySet("cmd", dynOf(ref(cmdText, STRING, loc), loc)),
    keySet("stdout", outDyn(outKind, outS)),
    keySet("stderr", outDyn(errKind, errS)),
    { kind: "throw", value: ref(e, ERROR_T, loc), loc },
  ];
  const body: IrStmt[] = [
    { kind: "varDecl", localId: e, init: null, loc },
    { kind: "varDecl", localId: d, init: null, loc },
    { kind: "varDecl", localId: n, init: reader === null ? ref(o, optsT, loc) : { kind: "call", callee: reader, args: [ref(o, optsT, loc)], type: normT, loc }, loc },
    // Node's error text and `cmd`: the file and args as given.
    {
      kind: "varDecl",
      localId: cmdText,
      init: {
        kind: "ternary",
        cond: lenGt0(argvRef),
        then: cat(cat(ref(cmd, STRING, loc), str(" ", loc), loc), joined(argvRef), loc),
        else_: ref(cmd, STRING, loc),
        type: STRING,
        loc,
      },
      loc,
    },
    { kind: "varDecl", localId: file, init: ref(cmd, STRING, loc), loc },
    { kind: "varDecl", localId: args, init: argvRef, loc },
    // shell: the shell runs `-c <file args...>` (Node joins with spaces).
    ifs(strEq(nf("shell", STRING), str("", loc), loc, true), [
      // Node prints its DEP0190 DeprecationWarning (with its pid) the
      // first time a shell gets arguments — not built.
      ifs(lenGt0(argvRef), [optionFence("the promisified execFile with the shell option and an arguments list (Node prints its DEP0190 deprecation warning)", loc)], null, loc),
      assign(file, nf("shell", STRING), loc),
      assign(args, { kind: "arrayLit", elems: [str("-c", loc), ref(cmdText, STRING, loc)], type: strArr, loc }, loc),
    ], null, loc),
    { kind: "varDecl", localId: raw, init: { kind: "bin", op: "===", left: nf("enc", F64), right: num(1, loc), type: BOOL, loc }, loc },
    {
      kind: "varDecl",
      localId: r,
      init: lib("cp.execFileRun", [
        ref(file, STRING, loc),
        ref(args, strArr, loc),
        nf("cwd", STRING),
        nf("hasEnv", BOOL),
        nf("pairs", strArr),
        nf("timeout", F64),
        nf("killName", STRING),
        nf("killNum", F64),
        ref(raw, BOOL, loc),
      ], SPAWNRES_T, loc),
      loc,
    },
    { kind: "varDecl", localId: outS, init: lib("spawnRes.stdout", [ref(r, SPAWNRES_T, loc)], STRING, loc), loc },
    { kind: "varDecl", localId: errS, init: lib("spawnRes.stderr", [ref(r, SPAWNRES_T, loc)], STRING, loc), loc },
    // The message's stderr is the decoded text (Node's template literal
    // over a Buffer decodes utf8).
    {
      kind: "varDecl",
      localId: errText,
      init: {
        kind: "ternary",
        cond: ref(raw, BOOL, loc),
        then: { kind: "bytesIntrinsic", method: "toString", receiver: lib("buffer.fromStr", [ref(errS, STRING, loc), str("latin1", loc)], BYTES_U8, loc), args: [str("utf8", loc)], type: STRING, loc },
        else_: ref(errS, STRING, loc),
        type: STRING,
        loc,
      },
      loc,
    },
    { kind: "varDecl", localId: en, init: lib("spawnRes.errName", [ref(r, SPAWNRES_T, loc)], STRING, loc), loc },
    // A spawn failure (any errno but a timeout's): Node's "spawn <file>
    // <CODE>" with errno, code, syscall, path, spawnargs.
    ifs(and(strEq(ref(en, STRING, loc), str("", loc), loc, true), strEq(ref(en, STRING, loc), str("ETIMEDOUT", loc), loc, true), loc), [
      {
        kind: "assign",
        localId: e,
        value: lib("error.newCoded", [cat(cat(cat(str("spawn ", loc), ref(file, STRING, loc), loc), str(" ", loc), loc), ref(en, STRING, loc), loc), ref(en, STRING, loc)], ERROR_T, loc),
        loc,
      },
      assign(d, dynOf(ref(e, ERROR_T, loc), loc), loc),
      keySet("errno", dynOf(lib("spawnRes.errno", [ref(r, SPAWNRES_T, loc)], F64, loc), loc)),
      keySet("code", dynOf(ref(en, STRING, loc), loc)),
      keySet("syscall", dynOf(cat(str("spawn ", loc), ref(file, STRING, loc), loc), loc)),
      keySet("path", dynOf(ref(file, STRING, loc), loc)),
      keySet("spawnargs", dynOf({ kind: "arrIntrinsic", method: "slice", receiver: ref(args, strArr, loc), args: [num(0, loc)], type: strArr, loc }, loc)),
      ...tail,
    ], null, loc),
    // A non-zero exit or a signal death (a timeout's kill included).
    ifs(failed, [
      {
        kind: "assign",
        localId: e,
        value: lib("error.newCoded", [cat(cat(cat(str("Command failed: ", loc), ref(cmdText, STRING, loc), loc), str("\n", loc), loc), ref(errText, STRING, loc), loc), str("", loc)], ERROR_T, loc),
        loc,
      },
      assign(d, dynOf(ref(e, ERROR_T, loc), loc), loc),
      keySet("code", unionToDyn(status, statusT, F64)),
      keySet("killed", dynOf(strEq(ref(en, STRING, loc), str("ETIMEDOUT", loc), loc), loc)),
      keySet("signal", unionToDyn(signal, signalT, STRING)),
      ...tail,
    ], null, loc),
    ...out.pre,
    ...err.pre,
    {
      kind: "return",
      value: {
        kind: "recordLit",
        fields: [
          { name: "stderr", value: err.value },
          { name: "stdout", value: out.value },
        ],
        type: resT,
        loc,
      },
      loc,
    },
  ];
  L.liftedFns.push({
    name,
    params: [
      { localId: cmd, name: "cmd", type: STRING },
      { localId: argv, name: "argv", type: strArr },
      { localId: o, name: "o", type: optsT },
    ],
    returnType: resT,
    async: true,
    locals: f.locals,
    body,
    loc,
  });
  return name;
}

/** The promisified execFile call over a lowered options VALUE (or the
 * literal path's normalized record): the interned async helper's call,
 * typed as the checker's result. */
export function execFileAsyncValueCall(L: Lowerer, expr: ts.CallExpression, cmd: IrExpr, argv: IrExpr, opts: IrExpr, blame: ts.Node, loc: SrcLoc): IrExpr {
  const resultT = L.mapTypeOf(L.typeOf(expr));
  // The checker's result: @types/node's `{ stdout; stderr }` literal (a
  // string or Buffer per field); the shipped fallback's promisify declares
  // the utf8 strings, interned here as the same record.
  let resT: IrType | null = resultT?.kind === "promise" && resultT.inner.kind === "record" ? resultT.inner : null;
  if (resT === null) {
    const awaited = L.checker.getAwaitedType(L.typeOf(expr));
    const outSym = awaited ? L.checker.getPropertyOfType(awaited, "stdout") : undefined;
    const errSym = awaited ? L.checker.getPropertyOfType(awaited, "stderr") : undefined;
    const isStr = (s: ts.Symbol | undefined): boolean => s !== undefined && (L.checker.getTypeOfSymbol(s).flags & ts.TypeFlags.String) !== 0;
    if (!isStr(outSym) || !isStr(errSym)) L.noLowering("the promisified execFile with this result type", expr);
    resT = { kind: "record", shapeId: L.shapes.intern([{ name: "stderr", type: STRING }, { name: "stdout", type: STRING }]) };
  }
  if (resT.kind !== "record") throw new Error("lowerer bug: execFile result");
  refuseEncodingWrites(L);
  const encPresent = blame !== expr && ts.isExpression(blame) && encodingKeyPresent(L, blame);
  const helper = execFileAsyncValueHelper(L, opts.type, resT, encPresent, blame, loc);
  return { kind: "call", callee: helper, args: [cmd, argv, opts], type: { kind: "promise", inner: resT }, loc };
}

/** The options argument as a run-time value: the lowered expression (a
 * record or nullable record), checked here so the reader can be built. */
export function lowerOptionsValue(L: Lowerer, node: ts.Expression, family: string): IrExpr {
  const v = L.lowerExpr(node);
  if (optionsRecordOf(L, v.type) === null) {
    L.noLowering(
      `${family} with options of type '${L.fmt(v.type)}'`,
      node,
      "pass an options object (a literal, a typed options value, or a spread of one)",
    );
  }
  return v;
}

/* ── spawn ────────────────────────────────────────────────────────────── */

/** The members spawn reads from an options value. stdio slots are
 * "ignore" / "inherit" (and a number fd for stdout/stderr); a piped slot
 * — Node's default for an absent stdio, a short array, null/undefined
 * entries, "pipe" and "overlapped" — and the members this build has no
 * spawn lowering for (timeout, killSignal, signal, uid, gid, argv0, a
 * shell with arguments) end the program by name when present. */
function spawnMemberStmts(L: Lowerer, f: Fn, rec: IrExpr, shapeId: string, blame: ts.Node, loc: SrcLoc, v: Record<string, string>, argv: IrExpr, cmdLine: IrExpr): IrStmt[] {
  const shape = L.shapes.get(shapeId);
  if (!shape) throw new Error(`lowerer bug: options shape ${shapeId} unknown`);
  const out: IrStmt[] = [];
  const skip: ArmHandler = () => [];
  const what = (name: string): string => `spawn option '${name}'`;
  const pipeFence = (): IrStmt[] => [optionFence("spawn with a piped stdio slot in an options value (\"pipe\", \"overlapped\", \"ipc\", null or undefined — an absent stdio is Node's \"pipe\")", loc)];
  // One slot's mode from a string: ignore 0, inherit 1, the rest piped.
  const modeOfString = (s: IrExpr, slots: string[]): IrStmt[] => [
    ifs(strEq(s, str("ignore", loc), loc), slots.map((m) => assign(m, num(0, loc), loc)),
      [ifs(strEq(s, str("inherit", loc), loc), slots.map((m) => assign(m, num(1, loc), loc)), pipeFence(), loc)], loc),
  ];
  let sawStdio = false;
  for (const field of shape.fields) {
    const read: IrExpr = { kind: "recordGet", obj: rec, shapeId, field: field.name, type: field.type, loc };
    const fence = (): IrStmt[] => [optionFence(what(field.name), loc)];
    switch (field.name) {
      case "cwd":
        out.push(...onArms(L, read, field.type, {
          string: (s) => [assign(v.cwd!, s, loc)],
          url: (u) => [assign(v.cwd!, lib("url.fileURLToPathUrl", [u], STRING, loc), loc)],
          undefinedT: skip,
        }, blame, what("cwd"), loc));
        break;
      case "env":
        out.push(...onArms(L, read, field.type, {
          record: (r, arm) => {
            const helper = L.envToPairsHelper((arm as IrType & { kind: "record" }).shapeId, loc);
            if (helper === null) L.noLowering(`${what("env")} of type '${L.fmt(arm)}'`, blame, "env values must be strings (or string | undefined)");
            return [
              assign(v.hasEnv!, bool(true, loc), loc),
              assign(v.pairs!, { kind: "call", callee: helper, args: [r], type: arrayOf(STRING), loc }, loc),
            ];
          },
          undefinedT: skip,
        }, blame, what("env"), loc));
        break;
      case "detached":
        out.push(...onArms(L, read, field.type, { bool: (b) => [assign(v.detached!, b, loc)], undefinedT: skip }, blame, what("detached"), loc));
        break;
      case "stdio": {
        sawStdio = true;
        const slots = [v.inMode!, v.outMode!, v.errMode!];
        out.push(...onArms(L, read, field.type, {
          string: (s) => modeOfString(s, slots),
          array: (a, arm) => {
            const elemT = (arm as IrType & { kind: "array" }).elem;
            const len: IrExpr = { kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc };
            const stmts: IrStmt[] = [
              ifs({ kind: "bin", op: "!==", left: len, right: num(3, loc), type: BOOL, loc }, [optionFence("spawn with a stdio array of other than three slots in an options value", loc)], null, loc),
            ];
            for (let i = 0; i < 3; i++) {
              const el: IrExpr = { kind: "arrayGet", arr: a, index: num(i, loc), type: elemT, loc };
              stmts.push(...onArms(L, el, elemT, {
                string: (s) => modeOfString(s, [slots[i]!]),
                f64: (fd) =>
                  i === 0
                    ? [optionFence("spawn with a number fd for stdin", loc)]
                    : [assign(slots[i]!, num(2, loc), loc), assign(i === 1 ? v.outFd! : v.errFd!, fd, loc)],
                nullT: pipeFence,
                undefinedT: pipeFence,
              }, blame, what("stdio"), loc));
            }
            return stmts;
          },
          undefinedT: pipeFence,
        }, blame, what("stdio"), loc));
        break;
      }
      case "shell":
        out.push(...onArms(L, read, field.type, {
          bool: (b) => [ifs(b, [assign(v.shell!, str("/bin/sh", loc), loc)], [assign(v.shell!, str("", loc), loc)], loc)],
          string: (s) => [assign(v.shell!, s, loc)],
          undefinedT: skip,
        }, blame, what("shell"), loc));
        break;
      case "signal":
        if (field.type.kind === "dyn") {
          out.push(ifs({ kind: "dynTest", test: "undefined", negated: true, value: read, type: BOOL, loc }, fence(), null, loc));
        } else {
          out.push(...onArms(L, read, field.type, { undefinedT: skip }, blame, what("signal"), loc));
        }
        break;
      case "timeout":
      case "uid":
      case "gid":
        out.push(...onArms(L, read, field.type, { f64: fence, undefinedT: skip }, blame, what(field.name), loc));
        break;
      case "killSignal":
        out.push(...onArms(L, read, field.type, { f64: fence, string: fence, undefinedT: skip }, blame, what(field.name), loc));
        break;
      case "argv0":
        out.push(...onArms(L, read, field.type, { string: fence, undefinedT: skip }, blame, what(field.name), loc));
        break;
      // POSIX no-ops in Node; serialization matters only with an "ipc"
      // slot, which is fenced above.
      case "windowsHide":
      case "windowsVerbatimArguments":
      case "serialization":
        break;
      default:
        break;
    }
  }
  if (!sawStdio) out.push(...pipeFence());
  // shell: `-c <command args...>`, Node's join; arguments print DEP0190.
  out.push(ifs(strEq(ref(v.shell!, STRING, loc), str("", loc), loc, true), [
    ifs({ kind: "bin", op: ">", left: { kind: "arrIntrinsic", method: "length", receiver: argv, args: [], type: F64, loc }, right: num(0, loc), type: BOOL, loc },
      [optionFence("spawn with the shell option and an arguments list (Node prints its DEP0190 deprecation warning)", loc)], null, loc),
    assign(v.args!, { kind: "arrayLit", elems: [str("-c", loc), cmdLine], type: arrayOf(STRING), loc }, loc),
    assign(v.file!, ref(v.shell!, STRING, loc), loc),
  ], null, loc));
  return out;
}

/** `%cpopts.spawn.<n>(cmd, argv, o) -> child` — spawn over an options
 * value: the members read, then the cp.spawnOptsRt child. */
function spawnValueHelper(L: Lowerer, optsT: IrType, blame: ts.Node, loc: SrcLoc): string {
  const key = `cpopts.spawn:${typeKey(optsT)}:${siteKey(loc)}`;
  const hit = L.widthHelpers.get(key);
  if (hit) return hit;
  const recT = optionsRecordOf(L, optsT);
  if (recT === null) {
    L.noLowering(`spawn with options of type '${L.fmt(optsT)}'`, blame, "pass an options object (a literal, a typed SpawnOptions value, or a spread of one)");
  }
  const name = `%cpopts.spawn.${L.widthHelpers.size}`;
  L.widthHelpers.set(key, name);
  const f = new Fn(loc);
  const strArr = arrayOf(STRING);
  const cmd = f.local("cmd", STRING, false);
  const argv = f.local("argv", strArr, false);
  const o = f.local("o", optsT, false);
  const v: Record<string, string> = {
    file: f.local("file", STRING),
    args: f.local("args", strArr),
    cwd: f.local("cwd", STRING),
    hasEnv: f.local("hasEnv", BOOL),
    pairs: f.local("pairs", strArr),
    detached: f.local("detached", BOOL),
    inMode: f.local("inMode", F64),
    outMode: f.local("outMode", F64),
    errMode: f.local("errMode", F64),
    outFd: f.local("outFd", F64),
    errFd: f.local("errFd", F64),
    shell: f.local("shell", STRING),
  };
  const decl = (id: string, init: IrExpr): IrStmt => ({ kind: "varDecl", localId: id, init, loc });
  const body: IrStmt[] = [
    decl(v.file!, ref(cmd, STRING, loc)),
    decl(v.args!, ref(argv, strArr, loc)),
    decl(v.cwd!, str("", loc)),
    decl(v.hasEnv!, bool(false, loc)),
    decl(v.pairs!, { kind: "arrayLit", elems: [], type: strArr, loc }),
    decl(v.detached!, bool(false, loc)),
    decl(v.inMode!, num(0, loc)),
    decl(v.outMode!, num(0, loc)),
    decl(v.errMode!, num(0, loc)),
    decl(v.outFd!, num(0, loc)),
    decl(v.errFd!, num(0, loc)),
    decl(v.shell!, str("", loc)),
  ];
  // The shell's command line: the file and its args joined by spaces.
  const cmdLine: IrExpr = {
    kind: "ternary",
    cond: { kind: "bin", op: ">", left: { kind: "arrIntrinsic", method: "length", receiver: ref(argv, strArr, loc), args: [], type: F64, loc }, right: num(0, loc), type: BOOL, loc },
    then: cat(cat(ref(cmd, STRING, loc), str(" ", loc), loc), { kind: "arrIntrinsic", method: "join", receiver: ref(argv, strArr, loc), args: [str(" ", loc)], type: STRING, loc }, loc),
    else_: ref(cmd, STRING, loc),
    type: STRING,
    loc,
  };
  const members = (r: IrExpr): IrStmt[] => spawnMemberStmts(L, f, r, recT.shapeId, blame, loc, v, ref(argv, strArr, loc), cmdLine);
  if (optsT.kind === "record") {
    body.push(...members(ref(o, optsT, loc)));
  } else if (optsT.kind === "union") {
    const tag = L.armTag(optsT.unionId, recT);
    const r = f.local("r", recT, false);
    body.push(ifs(
      { kind: "unionIsTag", unionId: optsT.unionId, tag, negated: false, value: ref(o, optsT, loc), type: BOOL, loc },
      [
        { kind: "varDecl", localId: r, init: { kind: "unionNarrow", unionId: optsT.unionId, tag, value: ref(o, optsT, loc), type: recT, loc }, loc },
        ...members(ref(r, recT, loc)),
      ],
      [optionFence("spawn with an absent options value (Node's default stdio is \"pipe\")", loc)],
      loc,
    ));
  }
  const g = (id: string, t: IrType): IrExpr => ref(id, t, loc);
  body.push({
    kind: "return",
    value: lib("cp.spawnOptsRt", [
      g(v.file!, STRING), g(v.args!, strArr), g(v.inMode!, F64), g(v.outMode!, F64), g(v.errMode!, F64),
      g(v.outFd!, F64), g(v.errFd!, F64), g(v.detached!, BOOL), g(v.hasEnv!, BOOL), g(v.pairs!, strArr), g(v.cwd!, STRING),
    ], { kind: "child" }, loc),
    loc,
  });
  L.liftedFns.push({
    name,
    params: [
      { localId: cmd, name: "cmd", type: STRING },
      { localId: argv, name: "argv", type: strArr },
      { localId: o, name: "o", type: optsT },
    ],
    returnType: { kind: "child" },
    locals: f.locals,
    body,
    loc,
  });
  return name;
}

/** spawn(cmd, args, <options value>) → the interned reader's call. */
export function spawnValueCall(L: Lowerer, cmd: IrExpr, argv: IrExpr, opts: IrExpr, blame: ts.Node, loc: SrcLoc): IrExpr {
  const helper = spawnValueHelper(L, opts.type, blame, loc);
  return { kind: "call", callee: helper, args: [cmd, argv, opts], type: { kind: "child" }, loc };
}

/* ── execSync / execFileSync ──────────────────────────────────────────── */

/** The members execSync/execFileSync read from an options value, as the
 * cp.execSync arguments: cwd, env, input (a string), timeout, stdio (the
 * literal path's modes: stdout 1 capture / 0 ignore / 2 inherit, + 4 for
 * an inherited stdin; stderr 0 capture-and-echo / 1 capture / 2 ignore /
 * 3 inherit), the utf8 encoding (anything else is a Buffer result, not
 * built), and the SIGTERM kill signal. The rest that Node honors fences
 * by name when present. */
function execSyncMemberStmts(L: Lowerer, rec: IrExpr, shapeId: string, shell: boolean, discarded: boolean, blame: ts.Node, loc: SrcLoc, v: Record<string, string>): IrStmt[] {
  const shape = L.shapes.get(shapeId);
  if (!shape) throw new Error(`lowerer bug: options shape ${shapeId} unknown`);
  const fam = shell ? "execSync" : "execFileSync";
  const what = (name: string): string => `${fam} option '${name}'`;
  const out: IrStmt[] = [];
  const skip: ArmHandler = () => [];
  let sawEncoding = false;
  // One fd's stdio string, the literal path's modeOf.
  const modeOf = (s: IrExpr, fd: 0 | 1 | 2): IrStmt[] => {
    const isS = (x: string): IrExpr => strEq(s, str(x, loc), loc);
    const pipe: IrStmt[] = fd === 2 ? [assign(v.errMode!, num(1, loc), loc)] : [];
    const ignore: IrStmt[] = fd === 1 ? [assign(v.outMode!, num(0, loc), loc)] : fd === 2 ? [assign(v.errMode!, num(2, loc), loc)] : [];
    const inherit: IrStmt[] =
      fd === 0 ? [assign(v.inInherit!, bool(true, loc), loc)] : fd === 1 ? [assign(v.outMode!, num(2, loc), loc)] : [assign(v.errMode!, num(3, loc), loc)];
    return [
      ifs(isS("pipe"), pipe, [
        ifs(isS("ignore"), ignore, [
          ifs(isS("inherit"), inherit, [optionFence(`${fam} with a stdio mode other than "pipe", "ignore" or "inherit"`, loc)], loc),
        ], loc),
      ], loc),
    ];
  };
  for (const field of shape.fields) {
    const read: IrExpr = { kind: "recordGet", obj: rec, shapeId, field: field.name, type: field.type, loc };
    const fence = (): IrStmt[] => [optionFence(what(field.name), loc)];
    switch (field.name) {
      case "cwd":
        out.push(...onArms(L, read, field.type, {
          string: (s) => [assign(v.cwd!, s, loc)],
          url: (u) => [assign(v.cwd!, lib("url.fileURLToPathUrl", [u], STRING, loc), loc)],
          undefinedT: skip,
        }, blame, what("cwd"), loc));
        break;
      case "env":
        out.push(...onArms(L, read, field.type, {
          record: (r, arm) => {
            const helper = L.envToPairsHelper((arm as IrType & { kind: "record" }).shapeId, loc);
            if (helper === null) L.noLowering(`${what("env")} of type '${L.fmt(arm)}'`, blame, "env values must be strings (or string | undefined)");
            return [
              assign(v.hasEnv!, bool(true, loc), loc),
              assign(v.pairs!, { kind: "call", callee: helper, args: [r], type: arrayOf(STRING), loc }, loc),
            ];
          },
          undefinedT: skip,
        }, blame, what("env"), loc));
        break;
      case "input":
        out.push(...onArms(L, read, field.type, {
          string: (s) => [assign(v.input!, s, loc), assign(v.hasInput!, bool(true, loc), loc)],
          bytes: () => [optionFence(`${fam} with a Buffer input`, loc)],
          undefinedT: skip,
        }, blame, what("input"), loc));
        break;
      case "timeout":
        out.push(...onArms(L, read, field.type, { f64: (n) => [assign(v.timeout!, n, loc)], undefinedT: skip }, blame, what("timeout"), loc));
        break;
      case "stdio":
        out.push(...onArms(L, read, field.type, {
          string: (s) => [...modeOf(s, 0), ...modeOf(s, 1), ...modeOf(s, 2)],
          array: (a, arm) => {
            const elemT = (arm as IrType & { kind: "array" }).elem;
            const len: IrExpr = { kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc };
            const stmts: IrStmt[] = [];
            for (let i = 0; i < 3; i++) {
              const el: IrExpr = { kind: "arrayGet", arr: a, index: num(i, loc), type: elemT, loc };
              // A slot past the end, null or undefined is Node's "pipe".
              const pipe = modeOf(str("pipe", loc), i as 0 | 1 | 2);
              stmts.push(ifs({ kind: "bin", op: ">", left: len, right: num(i, loc), type: BOOL, loc }, onArms(L, el, elemT, {
                string: (s) => modeOf(s, i as 0 | 1 | 2),
                f64: () => [optionFence(`${fam} with a number fd in stdio`, loc)],
                nullT: () => pipe,
                undefinedT: () => pipe,
              }, blame, what("stdio"), loc), pipe, loc));
            }
            stmts.push(ifs({ kind: "bin", op: ">", left: len, right: num(3, loc), type: BOOL, loc }, [optionFence(`${fam} with more than three stdio slots`, loc)], null, loc));
            return stmts;
          },
          undefinedT: skip,
        }, blame, what("stdio"), loc));
        break;
      case "encoding":
        sawEncoding = true;
        out.push(...onArms(L, read, field.type, {
          // A dropped result may be a Buffer: the raw echo is Node's then.
          string: (s) => [ifs(or(or(strEq(s, str("utf8", loc), loc), strEq(s, str("utf-8", loc), loc), loc), discarded ? strEq(s, str("buffer", loc), loc) : bool(false, loc), loc), [],
            [optionFence(`${fam} with an encoding other than "utf8" or "utf-8" (outputs are captured as utf8)`, loc)], loc)],
          nullT: () => (discarded ? [] : [optionFence(`${fam} without an encoding (Node returns a Buffer)`, loc)]),
          undefinedT: () => (discarded ? [] : [optionFence(`${fam} without an encoding (Node returns a Buffer)`, loc)]),
        }, blame, what("encoding"), loc));
        break;
      case "killSignal":
        out.push(...onArms(L, read, field.type, {
          string: (s) => [ifs(strEq(s, str("SIGTERM", loc), loc), [], fence(), loc)],
          f64: (n) => [ifs({ kind: "bin", op: "===", left: n, right: num(15, loc), type: BOOL, loc }, [], fence(), loc)],
          undefinedT: skip,
        }, blame, what("killSignal"), loc));
        break;
      case "shell":
        out.push(...onArms(L, read, field.type, {
          // execSync's own shell is /bin/sh; execFileSync runs no shell.
          string: (s) => (shell ? [ifs(strEq(s, str("/bin/sh", loc), loc), [], fence(), loc)] : [ifs(strEq(s, str("", loc), loc), [], fence(), loc)]),
          bool: (b) => (shell ? [] : [ifs(b, fence(), null, loc)]),
          undefinedT: skip,
        }, blame, what("shell"), loc));
        break;
      case "uid":
      case "gid":
        out.push(...onArms(L, read, field.type, { f64: fence, undefinedT: skip }, blame, what(field.name), loc));
        break;
      case "argv0":
        out.push(...onArms(L, read, field.type, { string: fence, undefinedT: skip }, blame, what(field.name), loc));
        break;
      case "detached":
        out.push(...onArms(L, read, field.type, { bool: (b) => [ifs(b, fence(), null, loc)], undefinedT: skip }, blame, what(field.name), loc));
        break;
      case "signal":
        if (field.type.kind === "dyn") {
          out.push(ifs({ kind: "dynTest", test: "undefined", negated: true, value: read, type: BOOL, loc }, fence(), null, loc));
        }
        break;
      // maxBuffer is not enforced (SEMANTICS.md S085 (d)); the rest are
      // POSIX no-ops in Node.
      default:
        break;
    }
  }
  if (!sawEncoding && !discarded) out.push(optionFence(`${fam} without an encoding (Node returns a Buffer)`, loc));
  return out;
}

/** `%cpopts.execSync.<n>(file, argv, o) -> string` — execSync (shell) or
 * execFileSync over an options value: the members read, then cp.execSync. */
function execSyncValueHelper(L: Lowerer, shell: boolean, discarded: boolean, optsT: IrType, blame: ts.Node, loc: SrcLoc): string {
  const key = `cpopts.execSync:${shell}:${discarded}:${typeKey(optsT)}:${siteKey(loc)}`;
  const hit = L.widthHelpers.get(key);
  if (hit) return hit;
  const fam = shell ? "execSync" : "execFileSync";
  const recT = optionsRecordOf(L, optsT);
  if (recT === null) {
    L.noLowering(`${fam} with options of type '${L.fmt(optsT)}'`, blame, "pass an options object (a literal, a typed options value, or a spread of one)");
  }
  const name = `%cpopts.execSync.${L.widthHelpers.size}`;
  L.widthHelpers.set(key, name);
  const f = new Fn(loc);
  const strArr = arrayOf(STRING);
  const file = f.local("file", STRING, false);
  const argv = f.local("argv", strArr, false);
  const o = f.local("o", optsT, false);
  const v: Record<string, string> = {
    input: f.local("input", STRING),
    hasInput: f.local("hasInput", BOOL),
    cwd: f.local("cwd", STRING),
    hasEnv: f.local("hasEnv", BOOL),
    pairs: f.local("pairs", strArr),
    timeout: f.local("timeout", F64),
    outMode: f.local("outMode", F64),
    errMode: f.local("errMode", F64),
    inInherit: f.local("inInherit", BOOL),
  };
  const decl = (id: string, init: IrExpr): IrStmt => ({ kind: "varDecl", localId: id, init, loc });
  const body: IrStmt[] = [
    decl(v.input!, str("", loc)),
    decl(v.hasInput!, bool(false, loc)),
    decl(v.cwd!, str("", loc)),
    decl(v.hasEnv!, bool(false, loc)),
    decl(v.pairs!, { kind: "arrayLit", elems: [], type: strArr, loc }),
    decl(v.timeout!, num(0, loc)),
    decl(v.outMode!, num(1, loc)),
    decl(v.errMode!, num(0, loc)),
    decl(v.inInherit!, bool(false, loc)),
  ];
  if (optsT.kind === "record") {
    body.push(...execSyncMemberStmts(L, ref(o, optsT, loc), recT.shapeId, shell, discarded, blame, loc, v));
  } else if (optsT.kind === "union") {
    const tag = L.armTag(optsT.unionId, recT);
    const r = f.local("r", recT, false);
    body.push(ifs(
      { kind: "unionIsTag", unionId: optsT.unionId, tag, negated: false, value: ref(o, optsT, loc), type: BOOL, loc },
      [
        { kind: "varDecl", localId: r, init: { kind: "unionNarrow", unionId: optsT.unionId, tag, value: ref(o, optsT, loc), type: recT, loc }, loc },
        ...execSyncMemberStmts(L, ref(r, recT, loc), recT.shapeId, shell, discarded, blame, loc, v),
      ],
      discarded ? null : [optionFence(`${fam} without an encoding (Node returns a Buffer)`, loc)],
      loc,
    ));
  }
  const g = (id: string, t: IrType): IrExpr => ref(id, t, loc);
  const outArg: IrExpr = {
    kind: "ternary",
    cond: g(v.inInherit!, BOOL),
    then: { kind: "bin", op: "+", left: g(v.outMode!, F64), right: num(4, loc), type: F64, loc },
    else_: g(v.outMode!, F64),
    type: F64,
    loc,
  };
  body.push({
    kind: "return",
    value: lib("cp.execSync", [
      ref(file, STRING, loc), ref(argv, strArr, loc), bool(shell, loc), g(v.input!, STRING), g(v.hasInput!, BOOL),
      g(v.cwd!, STRING), g(v.hasEnv!, BOOL), g(v.pairs!, strArr), g(v.timeout!, F64), outArg, g(v.errMode!, F64),
    ], STRING, loc),
    loc,
  });
  L.liftedFns.push({
    name,
    params: [
      { localId: file, name: "file", type: STRING },
      { localId: argv, name: "argv", type: strArr },
      { localId: o, name: "o", type: optsT },
    ],
    returnType: STRING,
    locals: f.locals,
    body,
    loc,
  });
  return name;
}

/** execSync/execFileSync(…, <options value>) → the interned reader's call.
 * The result must be typed as a string (the utf8 encoding), unless the
 * call is a statement whose result is dropped. */
export function execSyncValueCall(L: Lowerer, expr: ts.CallExpression, file: IrExpr, argv: IrExpr, shell: boolean, opts: IrExpr, blame: ts.Node, loc: SrcLoc): IrExpr {
  const resT = L.mapTypeOf(L.typeOf(expr));
  let at: ts.Node = expr;
  while (at.parent !== undefined && ts.isParenthesizedExpression(at.parent)) at = at.parent;
  const discarded = at.parent !== undefined && ts.isExpressionStatement(at.parent);
  if (resT?.kind !== "string" && !discarded) {
    L.noLowering(
      `${shell ? "execSync" : "execFileSync"} with an options value whose result is not typed as a string (without a utf8 encoding, Node returns a Buffer)`,
      expr,
      'type the options with encoding: "utf8" (ExecSyncOptionsWithStringEncoding), or discard the result',
    );
  }
  const helper = execSyncValueHelper(L, shell, discarded, opts.type, blame, loc);
  return { kind: "call", callee: helper, args: [file, argv, opts], type: STRING, loc };
}

/* ── an explicit `encoding: undefined` ────────────────────────────────── */

/** Node's promisified execFile spreads its options over `{ encoding:
 * "utf8" }`, so an `encoding` key that is PRESENT and holds undefined
 * answers Buffers, where an absent one answers strings. A typed record
 * holds the two alike (S091), so the build stops by name where a present
 * key can hold undefined (SEMANTICS.md S134 (b)): at an object literal
 * built for the async exec options (its contextual type is an
 * ExecOptions / ExecFileOptions record) that writes `encoding` with a
 * value that may be undefined — the value is checked when the literal is
 * built — and, for an options value whose type has a REQUIRED `encoding`
 * key admitting undefined (`{ ...o, encoding: x }` held in a const), in
 * the execFile reader (encodingKeyPresent). */
const ASYNC_EXEC_OPTION_RECORDS = new Set([
  "ExecOptions",
  "ExecOptionsWithStringEncoding",
  "ExecOptionsWithBufferEncoding",
  "ExecFileOptions",
  "ExecFileOptionsWithStringEncoding",
  "ExecFileOptionsWithBufferEncoding",
  "ExecFileOptionsWithOtherEncoding",
]);

const mayBeUndefined = (t: ts.Type): boolean =>
  (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
  (t.isUnionType() && t.getTypes().some((x) => (x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0));

function isAsyncExecEncodingDecl(L: Lowerer, sym: ts.Symbol): boolean {
  return L.checker.declarationsOf(sym).some((d) => {
    const owner = d.parent;
    return owner !== undefined && ts.isInterfaceDeclaration(owner) && ASYNC_EXEC_OPTION_RECORDS.has(owner.name.text) && L.isStdlibFile(d.getSourceFile());
  });
}

export function checkedExecEncodingLiteral(
  L: Lowerer,
  expr: ts.ObjectLiteralExpression,
  lower: (L: Lowerer, expr: ts.ObjectLiteralExpression) => IrExpr,
): IrExpr {
  const prop = expr.properties.find(
    (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "encoding",
  );
  if (prop === undefined || L.undefSlots !== true) return lower(L, expr);
  const valueNode = ts.isPropertyAssignment(prop) ? prop.initializer : (prop as ts.ShorthandPropertyAssignment).name;
  if (!mayBeUndefined(L.typeOf(valueNode))) return lower(L, expr);
  const ctx = L.checker.getContextualType(expr);
  const parts = ctx === undefined ? [] : ctx.isUnionType() ? ctx.getTypes() : [ctx];
  const forAsyncExec = parts.some((p) => {
    const sym = L.checker.getPropertyOfType(p, "encoding");
    return sym !== undefined && isAsyncExecEncodingDecl(L, sym);
  });
  if (!forAsyncExec) return lower(L, expr);
  const loc = locOf(prop);
  const what = "an explicit 'encoding' that may be undefined in the async exec options (Node answers Buffers for a present undefined key, strings for an absent one)";
  const out = lower(L, expr);
  let lit: IrExpr = out;
  while (lit.kind === "unionWrap") lit = lit.value;
  if (lit.kind !== "recordLit") L.noLowering(what, prop);
  const field = lit.fields.find((f) => f.name === "encoding");
  if (field === undefined) L.noLowering(what, prop);
  const t = field.value.type;
  if (t.kind !== "union" || L.armTag(t.unionId, UNDEFINED_T) < 0) {
    if (t.kind === "undefinedT" || (t.kind === "union" && armsOf(L, t).every((a) => a.kind === "undefinedT"))) L.noLowering(what, prop);
    return out;
  }
  field.value = { kind: "call", callee: encodingPresentHelper(L, t, what, loc), args: [field.value], type: t, loc };
  return out;
}

/** `%cpopts.encPresent.<n>(v) -> v`: the run-time stop for a present
 * `encoding` key holding undefined. */
function encodingPresentHelper(L: Lowerer, t: IrType & { kind: "union" }, what: string, loc: SrcLoc): string {
  const key = `cpopts.encPresent:${typeKey(t)}:${siteKey(loc)}`;
  const hit = L.widthHelpers.get(key);
  if (hit) return hit;
  const name = `%cpopts.encPresent.${L.widthHelpers.size}`;
  L.widthHelpers.set(key, name);
  const f = new Fn(loc);
  const v = f.local("v", t, false);
  const body: IrStmt[] = [
    ifs({ kind: "unionIsTag", unionId: t.unionId, tag: L.armTag(t.unionId, UNDEFINED_T), negated: false, value: ref(v, t, loc), type: BOOL, loc }, [optionFence(what, loc)], null, loc),
    { kind: "return", value: ref(v, t, loc), loc },
  ];
  L.liftedFns.push({ name, params: [{ localId: v, name: "v", type: t }], returnType: t, locals: f.locals, body, loc });
  return name;
}

const scannedEncodingWrites = new WeakSet<Lowerer>();

/** The remaining ways to make an async exec options record's `encoding`
 * key present while it may hold undefined — a member write (`o.encoding =
 * v`, `o["encoding"] = v`) and Object.assign onto such a record from a
 * source with an `encoding` key that may be undefined — refuse by name at
 * build time (once per program, from the first promisified execFile
 * call): the record cannot carry the key's presence to the call. */
function refuseEncodingWrites(L: Lowerer): void {
  if (scannedEncodingWrites.has(L)) return;
  scannedEncodingWrites.add(L);
  const what = "an explicit 'encoding' that may be undefined in the async exec options (Node answers Buffers for a present undefined key, strings for an absent one)";
  const asyncEncodingOf = (t: ts.Type): boolean => {
    const parts = t.isUnionType() ? t.getTypes() : [t];
    return parts.some((p) => {
      const sym = L.checker.getPropertyOfType(p, "encoding");
      return sym !== undefined && isAsyncExecEncodingDecl(L, sym);
    });
  };
  const encodingMayBeUndefined = (t: ts.Type): boolean => {
    const parts = t.isUnionType() ? t.getTypes() : [t];
    return parts.some((p) => {
      const sym = L.checker.getPropertyOfType(p, "encoding");
      return sym !== undefined && ((sym.flags & ts.SymbolFlags.Optional) !== 0 || mayBeUndefined(L.checker.getTypeOfSymbol(sym)));
    });
  };
  const blamed: ts.Node[] = [];
  for (const sf of L.program.getSourceFiles()) {
    if (sf.isDeclarationFile || L.isStdlibFile(sf)) continue;
    ts.walkPreorder(sf, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = n.left;
        const named =
          (ts.isPropertyAccessExpression(left) && left.name.text === "encoding") ||
          (ts.isElementAccessExpression(left) && ts.isStringLiteral(left.argumentExpression) && left.argumentExpression.text === "encoding");
        if (named && asyncEncodingOf(L.typeOf((left as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)) && mayBeUndefined(L.typeOf(n.right))) {
          blamed.push(n);
        }
      } else if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === "Object" &&
        n.expression.name.text === "assign" &&
        n.arguments.length >= 2 &&
        asyncEncodingOf(L.typeOf(n.arguments[0]!)) &&
        n.arguments.slice(1).some((a) => encodingMayBeUndefined(L.typeOf(a)))
      ) {
        blamed.push(n);
      }
      return undefined;
    });
  }
  for (const n of blamed) {
    try {
      L.noLowering(what, n);
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
    }
  }
}

/** True when the options argument's type has a REQUIRED `encoding` key
 * that admits undefined: a present key, so an undefined there is Node's
 * Buffer request (checkedExecEncodingLiteral). */
export function encodingKeyPresent(L: Lowerer, node: ts.Expression): boolean {
  const t = L.checker.getNonNullableType(L.typeOf(node));
  const parts = t.isUnionType() ? t.getTypes() : [t];
  return parts.some((p) => {
    const sym = L.checker.getPropertyOfType(p, "encoding");
    return sym !== undefined && (sym.flags & ts.SymbolFlags.Optional) === 0 && mayBeUndefined(L.checker.getTypeOfSymbol(sym));
  });
}

/* ── exec-error member reads ──────────────────────────────────────────── */

/** The exec error's own members (@types/node ExecException, and
 * ExecFileException's `code`), read off the error's dynamic value. */
const EXEC_ERROR_MEMBERS = new Set(["cmd", "killed", "code", "signal", "stdout", "stderr"]);

/** True when `sym` is a member @types/node declares on the exec error
 * types (ExecException, or the type literal ExecFileException adds). */
function isExecErrorMember(L: Lowerer, sym: ts.Symbol | undefined): boolean {
  if (sym === undefined || !EXEC_ERROR_MEMBERS.has(sym.name)) return false;
  const decls = L.checker.declarationsOf(sym);
  return decls.length > 0 && decls.every((d) => {
    if (!L.isStdlibFile(d.getSourceFile())) return false;
    const owner = d.parent;
    if (owner === undefined) return false;
    if (ts.isInterfaceDeclaration(owner)) return owner.name.text === "ExecException";
    if (owner.kind === ts.SyntaxKind.TypeLiteral) {
      const alias = owner.parent;
      return alias !== undefined && (ts.isTypeAliasDeclaration(alias) || ts.isIntersectionTypeNode(alias));
    }
    return false;
  });
}

/** `err.stdout` (and cmd, killed, code, signal, stderr) on an %Error-typed
 * receiver whose member comes from @types/node's exec error types: the
 * member of the error's dynamic value, converted to the declared type.
 * A value the declared type cannot hold (Node's `signal: null` on an exit
 * where @types/node declares a string) ends the program by name. Null for
 * anything else, so the property chain keeps trying. */
export function lowerExecErrorMember(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken) return null;
  const sym = L.checker.getSymbolAtLocation(expr.name);
  if (!isExecErrorMember(L, sym)) return null;
  const recvT = L.mapTypeOf(L.typeOf(expr.expression));
  if (recvT?.kind !== "object") return null;
  let info = L.classes.get(recvT.className) ?? null;
  while (info && info.base) info = info.base;
  if (!info || info.def.name !== "%Error") return null;
  const loc = locOf(expr);
  const want = L.mapTypeOf(L.typeOf(expr));
  if (want === null) return null;
  const recv = L.lowerExpr(expr.expression);
  const member: IrExpr = {
    kind: "dynKeyGet",
    key: str(expr.name.text, loc),
    value: dynOf(recv, loc),
    type: DYN,
    loc,
  };
  return { kind: "call", callee: execErrMemberHelper(L, want, expr.name.text, expr, loc), args: [member], type: want, loc };
}

/** `%execErr.<n>(d) -> want` — an exec-error member's dynamic value as
 * its declared type: undefined (an absent member) is the declared
 * undefined; a value of one of the declared arms converts (dynCheck); any
 * other value is a run-time fence naming the member. */
function execErrMemberHelper(L: Lowerer, want: IrType, member: string, blame: ts.Node, loc: SrcLoc): string {
  const key = `execErr:${member}:${typeKey(want)}:${siteKey(loc)}`;
  const hit = L.widthHelpers.get(key);
  if (hit) return hit;
  const name = `%execErr.${L.widthHelpers.size}`;
  L.widthHelpers.set(key, name);
  const f = new Fn(loc);
  const d = f.local("d", DYN, false);
  const dRef = ref(d, DYN, loc);
  const test = (t: "string" | "number" | "boolean" | "null" | "bytes"): IrExpr => ({ kind: "dynTest", test: t, value: dRef, type: BOOL, loc });
  const arms = armsOf(L, want);
  let fits: IrExpr | null = null;
  for (const arm of arms) {
    const t =
      arm.kind === "string" ? test("string") :
      arm.kind === "f64" ? test("number") :
      arm.kind === "bool" ? test("boolean") :
      arm.kind === "nullT" ? test("null") :
      arm.kind === "bytes" ? test("bytes") :
      arm.kind === "undefinedT" ? null :
      L.noLowering(`the exec error member '${member}' read as '${L.fmt(want)}'`, blame);
    if (t !== null) fits = fits === null ? t : or(fits, t, loc);
  }
  const body: IrStmt[] = [];
  const absent = L.wrappedUndefined(want, loc);
  if (absent !== null) {
    body.push(ifs({ kind: "dynTest", test: "undefined", value: dRef, type: BOOL, loc }, [{ kind: "return", value: absent, loc }], null, loc));
  }
  const fence = optionFence(`the exec error member '${member}' holding a value outside its declared type '${L.fmt(want)}'`, loc);
  if (fits === null) {
    body.push(fence);
  } else {
    body.push(ifs(fits, [], [fence], loc));
  }
  body.push({ kind: "return", value: { kind: "dynCheck", value: dRef, type: want, loc }, loc });
  L.liftedFns.push({ name, params: [{ localId: d, name: "d", type: DYN }], returnType: want, locals: f.locals, body, loc });
  return name;
}

/** The interned union of `arms` (canonical arm order). */
function unionOf(L: Lowerer, arms: IrType[]): IrType {
  const sorted = [...arms].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: L.unions.intern(sorted) };
}

void dynUndefinedExpr;
void typeEquals;
