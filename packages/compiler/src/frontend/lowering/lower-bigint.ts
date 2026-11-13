/* BigInt lowering: literals, the operators, and the conversions, as big.*
 * libCalls over the bigint IR kind (the WasmGC lanes' bigint.ts answers
 * them). Every form the checker accepts on bigint operands lowers here with
 * Node's semantics; mixing BigInt and Number in arithmetic is a checker
 * error in TypeScript, so only `any` operands can reach it, and those take
 * the dynamic world's arms instead. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BIGINT_T, BOOL, F64, STRING, type IrExpr, type IrLibFn, type IrStmt, type SrcLoc } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import { nodeThrowExpr } from "./lowerer.js";
import type { CompoundOp } from "./surfaces.js";

export function bigCall(fn: IrLibFn, args: IrExpr[], loc: SrcLoc): IrExpr {
  const type = fn === "big.eq" || fn === "big.cmp" || fn === "big.cmpNum" || fn === "big.numCmp" || fn === "big.eqNum" || fn === "big.truthy"
    ? BOOL
    : fn === "big.toNum"
      ? F64
      : fn === "big.toStr" || fn === "big.toStrRadix" || fn === "big.toLocale" || fn === "big.inspect"
        ? STRING
        : BIGINT_T;
  return { kind: "libCall", fn, args, type, loc };
}

export function bigLitOf(value: bigint, loc: SrcLoc): IrExpr {
  return bigCall("big.lit", [{ kind: "strLit", value: value.toString(), type: STRING, loc }], loc);
}

/** `123n`, `0x1Fn`, `1_000n`: the literal's exact value. */
export function lowerBigIntLiteral(expr: ts.BigIntLiteral): IrExpr {
  const text = expr.text.replace(/_/g, "");
  return bigLitOf(BigInt(text.endsWith("n") ? text.slice(0, -1) : text), locOf(expr));
}

/** The literal's value when `e` is one (constant folding of `-1n`). */
export function bigLitValue(e: IrExpr): bigint | null {
  if (e.kind === "libCall" && e.fn === "big.lit" && e.args[0]?.kind === "strLit") return BigInt(e.args[0].value);
  return null;
}

const ARITH: Partial<Record<string, IrLibFn>> = {
  "+": "big.add",
  "-": "big.sub",
  "*": "big.mul",
  "/": "big.div",
  "%": "big.rem",
  "**": "big.pow",
  "&": "big.and",
  "|": "big.or",
  "^": "big.xor",
  "<<": "big.shl",
  ">>": "big.sar",
  ">>>": "big.ushr",
};

const OP_TEXT: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
  [ts.SyntaxKind.PercentToken]: "%",
  [ts.SyntaxKind.AsteriskAsteriskToken]: "**",
  [ts.SyntaxKind.AmpersandToken]: "&",
  [ts.SyntaxKind.BarToken]: "|",
  [ts.SyntaxKind.CaretToken]: "^",
  [ts.SyntaxKind.LessThanLessThanToken]: "<<",
  [ts.SyntaxKind.GreaterThanGreaterThanToken]: ">>",
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: ">>>",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
};

function not(e: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "unary", op: "!", operand: e, type: BOOL, loc };
}

/** An arithmetic/bitwise operator over two bigint operands (compound
 * assignment shares it), or null for an operator with no bigint form. */
export function bigArith(op: CompoundOp | string, left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr | null {
  const fn = ARITH[op];
  return fn === undefined ? null : bigCall(fn, [left, right], loc);
}

/** A binary operator with a bigint operand, already lowered (left first).
 * Null when the pair has no lowering here (the caller's fence names it). */
export function lowerBigBinary(L: Lowerer, expr: ts.BinaryExpression, left: IrExpr, right: IrExpr): IrExpr | null {
  const loc = locOf(expr);
  const op = OP_TEXT[expr.operatorToken.kind];
  if (op === undefined) return null;
  const lb = left.type.kind === "bigint";
  const rb = right.type.kind === "bigint";
  if (lb && rb) {
    const a = bigArith(op, left, right, loc);
    if (a !== null) return a;
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      return bigCall("big.cmp", [left, right, { kind: "strLit", value: op, type: STRING, loc }], loc);
    }
    if (op === "===" || op === "==") return bigCall("big.eq", [left, right], loc);
    if (op === "!==" || op === "!=") return not(bigCall("big.eq", [left, right], loc), loc);
    return null;
  }
  // string + bigint: the bigint's decimal text (pure, so converting after
  // both operands evaluate is exact)
  if (op === "+" && (left.type.kind === "string" || right.type.kind === "string")) {
    const s = (e: IrExpr): IrExpr => (e.type.kind === "bigint" ? bigCall("big.toStr", [e], e.loc) : e);
    return { kind: "strConcat", left: s(left), right: s(right), type: STRING, loc };
  }
  const nl = left.type.kind === "f64";
  const nr = right.type.kind === "f64";
  if ((lb && nr) || (nl && rb)) {
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      return bigCall(lb ? "big.cmpNum" : "big.numCmp", [left, right, { kind: "strLit", value: op, type: STRING, loc }], loc);
    }
    if (op === "==" || op === "!=") {
      // symmetric: a (number, bigint) pair evaluates the number first
      let eq: IrExpr;
      if (lb) eq = bigCall("big.eqNum", [left, right], loc);
      else {
        const tmp = L.declareHiddenLocal("%bigEqN", F64);
        eq = {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: tmp.id, init: left, loc }],
          result: bigCall("big.eqNum", [right, { kind: "varRef", localId: tmp.id, type: F64, loc }], loc),
          type: BOOL,
          loc,
        };
      }
      return op === "==" ? eq : not(eq, loc);
    }
  }
  // (Reachable from JavaScript only: the checker rejects these in
  // TypeScript.) A bigint beside a number or boolean: `===` is false,
  // arithmetic is V8's TypeError — both operands evaluate first.
  const sl = left.type.kind === "f64" || left.type.kind === "bool";
  const sr = right.type.kind === "f64" || right.type.kind === "bool";
  if ((lb && sr) || (sl && rb)) {
    const stmts: IrStmt[] = [
      { kind: "exprStmt", expr: left, loc },
      { kind: "exprStmt", expr: right, loc },
    ];
    if (op === "===" || op === "!==") {
      return { kind: "seqExpr", stmts, result: { kind: "boolLit", value: op === "!==", type: BOOL, loc }, type: BOOL, loc };
    }
    if (ARITH[op] !== undefined) {
      return {
        kind: "seqExpr",
        stmts,
        result: nodeThrowExpr(1, "", "Cannot mix BigInt and other types, use explicit conversions", BIGINT_T, loc),
        type: BIGINT_T,
        loc,
      };
    }
  }
  return null;
}

/** `+b`: ToNumber of a bigint is V8's TypeError (JavaScript only — a
 * checker error in TypeScript). */
export function lowerBigUnaryPlus(operand: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: operand, loc }],
    result: nodeThrowExpr(1, "", "Cannot convert a BigInt value to a number", F64, loc),
    type: F64,
    loc,
  };
}

/** `-b` and `~b` (a literal folds). */
export function lowerBigUnary(op: "-" | "~", operand: IrExpr, loc: SrcLoc): IrExpr {
  const v = bigLitValue(operand);
  if (v !== null) return bigLitOf(op === "-" ? -v : ~v, loc);
  return bigCall(op === "-" ? "big.neg" : "big.not", [operand], loc);
}

/** `x++` / `--x` over a bigint variable in value position: the new value
 * (prefix) or the old one (postfix). */
export function lowerBigIncDec(L: Lowerer, target: { id: string }, op: "+" | "-", prefix: boolean, loc: SrcLoc): IrExpr {
  const read = (): IrExpr => ({ kind: "varRef", localId: target.id, type: BIGINT_T, loc });
  const one = bigLitOf(1n, loc);
  if (prefix) {
    return { kind: "assignExpr", localId: target.id, value: bigCall(op === "+" ? "big.add" : "big.sub", [read(), one], loc), type: BIGINT_T, loc };
  }
  const tmp = L.declareHiddenLocal("%bigOld", BIGINT_T);
  const old = (): IrExpr => ({ kind: "varRef", localId: tmp.id, type: BIGINT_T, loc });
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: tmp.id, init: read(), loc },
      { kind: "assign", localId: target.id, value: bigCall(op === "+" ? "big.add" : "big.sub", [old(), one], loc), loc },
    ],
    result: old(),
    type: BIGINT_T,
    loc,
  };
}

/** `BigInt(x)`: from a bigint (itself), a number (RangeError unless an
 * integer), a string (SyntaxError unless StringToBigInt accepts it), or a
 * boolean. Null for other argument types. */
export function lowerBigIntCall(arg: IrExpr, loc: SrcLoc): IrExpr | null {
  switch (arg.type.kind) {
    case "bigint":
      return arg;
    case "f64":
      if (arg.kind === "numLit" && Number.isInteger(arg.value)) return bigLitOf(BigInt(arg.value), loc);
      return bigCall("big.fromNum", [arg], loc);
    case "string":
      return bigCall("big.fromStr", [arg], loc);
    case "bool":
      return { kind: "ternary", cond: arg, then: bigLitOf(1n, loc), else_: bigLitOf(0n, loc), type: BIGINT_T, loc };
    default:
      return null;
  }
}

function arg0(L: Lowerer, call: ts.CallExpression, what: string): ts.Expression {
  const a = call.arguments[0];
  if (a === undefined || ts.isSpreadElement(a)) L.noLowering(`${what} without a plain argument`, call);
  return a;
}

/** `BigInt(x)`. */
export function lowerBigIntGlobalCall(L: Lowerer, call: ts.CallExpression): IrExpr {
  const loc = locOf(call);
  if (call.arguments.length !== 1) L.noLowering(`BigInt with ${call.arguments.length} arguments`, call);
  const argNode = arg0(L, call, "BigInt");
  // a string literal that converts folds to the value (zod's
  // BigInt("-9223372036854775808") table); an invalid one keeps the
  // run-time SyntaxError
  if (ts.isStringLiteralLike(argNode)) {
    let v: bigint | null = null;
    try {
      v = BigInt(argNode.text);
    } catch {
      v = null;
    }
    if (v !== null) return bigLitOf(v, loc);
  }
  const arg = L.lowerExpr(argNode);
  const out = lowerBigIntCall(arg, loc);
  if (out !== null) return out;
  // A union of convertible arms (`BigInt(x ?? "1")`, number | string):
  // per arm at run time; an undefined/null arm is V8's TypeError.
  if (arg.type.kind === "union") {
    const unionId = arg.type.unionId;
    const def = L.unions.get(unionId);
    const ut = arg.type;
    if (def && def.arms.every((a) => a.kind === "f64" || a.kind === "string" || a.kind === "bool" || a.kind === "bigint" || a.kind === "undefinedT" || a.kind === "nullT")) {
      const tmp = L.declareHiddenLocal("%bigArg", ut);
      const read = (): IrExpr => ({ kind: "varRef", localId: tmp.id, type: ut, loc });
      let result: IrExpr | null = null;
      for (let i = def.arms.length - 1; i >= 0; i--) {
        const a = def.arms[i]!;
        const branch: IrExpr =
          a.kind === "undefinedT" || a.kind === "nullT"
            ? nodeThrowExpr(1, "", `Cannot convert ${a.kind === "nullT" ? "null" : "undefined"} to a BigInt`, BIGINT_T, loc)
            : lowerBigIntCall({ kind: "unionNarrow", unionId, tag: i, value: read(), type: a, loc }, loc)!;
        result = result === null
          ? branch
          : {
              kind: "ternary",
              cond: { kind: "unionIsTag", unionId, tag: i, negated: false, value: read(), type: BOOL, loc },
              then: branch,
              else_: result,
              type: BIGINT_T,
              loc,
            };
      }
      return { kind: "seqExpr", stmts: [{ kind: "varDecl", localId: tmp.id, init: arg, loc }], result: result!, type: BIGINT_T, loc };
    }
  }
  return L.noLowering(
    `BigInt of ${L.fmt(arg.type)} values`,
    argNode,
    "bigint, number, string and boolean arguments lower — narrow the value first",
  );
}

/** `BigInt.asIntN(bits, x)` / `BigInt.asUintN(bits, x)`. */
export function lowerBigIntStaticCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!L.isStdlibGlobal(access.expression, "BigInt")) return null;
  const member = access.name.text;
  const loc = locOf(call);
  if (member !== "asIntN" && member !== "asUintN") return null;
  if (call.arguments.length !== 2 || call.arguments.some((a) => ts.isSpreadElement(a))) {
    L.noLowering(`BigInt.${member} with ${call.arguments.length} arguments`, call);
  }
  const bits = L.lowerExprExpecting(call.arguments[0]!, F64);
  const x = L.lowerExprExpecting(call.arguments[1]!, BIGINT_T);
  if (bits.type.kind !== "f64" || x.type.kind !== "bigint") {
    L.noLowering(`BigInt.${member} over ${L.fmt(bits.type)}, ${L.fmt(x.type)}`, call, "a number bit count and a bigint lower");
  }
  return bigCall(member === "asIntN" ? "big.asIntN" : "big.asUintN", [bits, x], loc);
}

/** Methods on a bigint receiver: toString(radix?), toLocaleString("en-US")
 * and valueOf(). */
export function lowerBigIntMethodCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "bigint") return null;
  if (!L.isStdlibMember(access)) return null;
  if (call.questionDotToken || access.questionDotToken) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (call.arguments.some((a) => ts.isSpreadElement(a))) return null;
  if (name === "toString" && call.arguments.length <= 1) {
    const receiver = L.lowerExprExpecting(access.expression, BIGINT_T);
    if (receiver.type.kind !== "bigint") return null;
    const radixNode = call.arguments[0];
    if (radixNode === undefined || (ts.isIdentifier(radixNode) && radixNode.text === "undefined")) {
      return bigCall("big.toStr", [receiver], loc);
    }
    const radix = L.lowerExprExpecting(radixNode, F64);
    if (radix.type.kind !== "f64") return L.noLowering(`bigint.toString with a ${L.fmt(radix.type)} radix`, radixNode);
    if (radix.kind === "numLit" && radix.value === 10) return bigCall("big.toStr", [receiver], loc);
    return bigCall("big.toStrRadix", [receiver, radix], loc);
  }
  if (name === "valueOf" && call.arguments.length === 0) {
    const receiver = L.lowerExprExpecting(access.expression, BIGINT_T);
    return receiver.type.kind === "bigint" ? receiver : null;
  }
  if (name === "toLocaleString") {
    // Number.prototype.toLocaleString's stance: en-US (Node's default-build
    // locale, default options) is the one lowered locale
    const locNode = call.arguments[0];
    if (call.arguments.length !== 1 || locNode === undefined || !ts.isStringLiteralLike(locNode) || locNode.text !== "en-US") {
      return L.noLowering(
        "BigInt.prototype.toLocaleString other than x.toLocaleString(\"en-US\")",
        call,
        "the default locale is the host environment's, which a compiled binary cannot carry, and en-US with default options is the one locale whose data the runtime embeds",
      );
    }
    const receiver = L.lowerExprExpecting(access.expression, BIGINT_T);
    if (receiver.type.kind !== "bigint") return null;
    return bigCall("big.toLocale", [receiver], loc);
  }
  return null;
}

/* ── fs BigIntStats (the full stat record, fsCall op 24) ─────────────── */

const STAT_BIG_FIELDS = new Set(["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks", "atimeNs", "mtimeNs", "ctimeNs"]);

/** Is `node`'s checker type @types/node's BigIntStats? */
export function isBigIntStatsType(L: Lowerer, node: ts.Expression): boolean {
  const arms = statsArms(L, node);
  return arms.big && !arms.plain;
}

/** Which record kinds the receiver's type admits (null and undefined
 * aside): a BigIntStats, a plain Stats, or both (a `Stats | BigIntStats`
 * union, whose member reads cannot know statically which one it holds). */
function statsArms(L: Lowerer, node: ts.Expression): { big: boolean; plain: boolean } {
  return statsArmsOf(L, L.typeOf(node));
}

function statsArmsOf(L: Lowerer, type: ts.Type): { big: boolean; plain: boolean } {
  const t = L.checker.getNonNullableType(type);
  const parts = t.isUnionType() ? t.getTypes() : [t];
  let big = false;
  let plain = false;
  for (const p of parts) {
    const n = p.getSymbol()?.name;
    if (n === "BigIntStats") big = true;
    else if (n === "Stats") plain = true;
  }
  return { big, plain };
}

/** A receiver that may hold a BigIntStats but is not one for certain: the
 * plain Stats reader must never serve it (it would answer numbers where
 * Node answers bigints), so the read refuses by name. */
export function refuseMixedStats(L: Lowerer, receiver: ts.Expression, member: string, at: ts.Node): void {
  const arms = statsArms(L, receiver);
  if (arms.big && arms.plain) {
    L.noLowering(
      `${member} on a Stats | BigIntStats receiver`,
      at,
      "the member reads lower on a receiver typed Stats or BigIntStats alone (narrow it, or keep the two in separate bindings)",
    );
  }
}

/** A member read on a BigIntStats receiver: the numeric fields as bigints
 * (the *Ms times are the *Ns ones / 1000000n, BigInt division, as Node
 * computes them); the birthtime fields and the Date-valued atime/mtime/
 * ctime/birthtime refuse by name. Null for any other receiver. */
export function lowerBigIntStatsProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  // An optional read (`b?.size`) reads the same record: the chain guards
  // the nullish receiver, this lowers the member.
  refuseMixedStats(L, expr.expression, `.${expr.name.text}`, expr);
  if (!isBigIntStatsType(L, expr.expression)) return null;
  const name = expr.name.text;
  const loc = locOf(expr);
  const field = name.endsWith("Ms") ? name.slice(0, -2) + "Ns" : name;
  if (!STAT_BIG_FIELDS.has(field)) {
    return L.noLowering(
      `BigIntStats.${name}`,
      expr,
      "the numeric fields (dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atimeMs/Ns, mtimeMs/Ns, ctimeMs/Ns) and the is*() predicates are the lowered BigIntStats members",
    );
  }
  const receiver = L.lowerExpr(expr.expression);
  const raw = bigCallStats(receiver, field, loc);
  if (field === name) return raw;
  return bigCall("big.div", [raw, bigLitOf(1000000n, loc)], loc);
}

function bigCallStats(receiver: IrExpr, field: string, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "stats.big", args: [receiver, { kind: "strLit", value: field, type: STRING, loc }], type: BIGINT_T, loc };
}

/** statSync/lstatSync(path, { bigint }), fstatSync(fd[, { bigint }]),
 * and fs/promises stat/lstat(path[, { bigint }]): the full record (op 24)
 * wherever an options bag or one of the forms the 7/8 ops never served
 * appears. Only a literal `bigint` boolean is lowered; any other option
 * (throwIfNoEntry, a computed bag) refuses by name. Null for every other
 * call (the existing one-argument statSync/lstatSync/stat keep ops 7/8). */
export function lowerStatCall(L: Lowerer, call: ts.CallExpression, module: string, member: string): IrExpr | null {
  const sync = module === "fs" && (member === "statSync" || member === "lstatSync" || member === "fstatSync");
  const prom = module === "fs/promises" && (member === "stat" || member === "lstat");
  if (!sync && !prom) return null;
  const args = call.arguments;
  if (args.some((a) => ts.isSpreadElement(a)) || args.length < 1 || args.length > 2) {
    return L.noLowering(`${member} with ${args.length} arguments`, call);
  }
  // the one-argument forms ops 7/8 already serve stay as they are
  if (args.length === 1 && member !== "fstatSync" && member !== "lstat") return null;
  const loc = locOf(call);
  if (args.length === 2) {
    const optNode = args[1]!;
    const okBag =
      ts.isObjectLiteralExpression(optNode) &&
      optNode.properties.every(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "bigint" &&
          (p.initializer.kind === ts.SyntaxKind.TrueKeyword || p.initializer.kind === ts.SyntaxKind.FalseKeyword),
      );
    if (!okBag) {
      return L.noLowering(
        `${member} with this options argument`,
        optNode,
        "a literal { bigint: true } or { bigint: false } is the lowered options bag (throwIfNoEntry and computed bags have no lowering)",
      );
    }
  }
  const kindLit: IrExpr = { kind: "strLit", value: member.startsWith("l") ? "lstat" : "stat", type: STRING, loc };
  if (member === "fstatSync") {
    const fd = L.lowerExprExpecting(args[0]!, F64);
    if (fd.type.kind !== "f64") return L.noLowering(`fstatSync of a '${L.fmt(fd.type)}' descriptor`, args[0]!);
    return { kind: "libCall", fn: "fs.fstatBig", args: [fd], type: { kind: "stats" }, loc };
  }
  const path = L.lowerExprExpecting(args[0]!, STRING);
  if (path.type.kind !== "string") {
    return L.noLowering(`${member} of a '${L.fmt(path.type)}' path`, args[0]!, "a string path is the lowered form");
  }
  if (prom) {
    return { kind: "libCall", fn: "fsp.statBig", args: [path, kindLit], type: { kind: "promise", inner: { kind: "stats" } }, loc };
  }
  return { kind: "libCall", fn: "fs.statBig", args: [path, kindLit], type: { kind: "stats" }, loc };
}

/** `b as unknown as Stats` over a BigIntStats (or the reverse): one record
 * representation serves both, so the recast value would be read by the
 * other kind's member reader (numbers where Node answers bigints). The
 * lying cast refuses by name. */
export function refuseStatsRecast(L: Lowerer, expr: ts.AsExpression | ts.TypeAssertion): void {
  const target = statsArmsOf(L, L.checker.getTypeFromTypeNode(expr.type));
  if (!target.big && !target.plain) return;
  let inner: ts.Expression = expr.expression;
  while (ts.isAsExpression(inner) || ts.isTypeAssertion(inner) || ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  const source = statsArms(L, inner);
  if ((source.big && target.plain && !target.big) || (source.plain && !source.big && target.big)) {
    L.noLowering(
      source.big ? "a BigIntStats cast to Stats" : "a Stats cast to BigIntStats",
      expr,
      "the value keeps its own kind: read it through its own type",
    );
  }
}
