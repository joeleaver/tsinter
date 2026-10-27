/* Board #301: the stateful regex surface the frontend owns.
 *
 *  - `re.lastIndex` reads and writes, and the flag accessors (`re.global`
 *    …) over `.flags`;
 *  - exec/match result COMPANIONS: a binding every write of which is a
 *    direct `re.exec(s)` / `s.match(re)` call (or null) in its declaring
 *    function keeps the match's capture positions and subject in hidden
 *    locals, so `m.index`, `m.input` and `m.groups` read Node's values
 *    (the result itself stays the honest string[] row, S064);
 *  - FUNCTION replacers — `s.replace(re, fn)`, `s.replaceAll(re, fn)` and
 *    the string-pattern forms: the regex forms collect every match first
 *    (Symbol.replace's own order — the `collect` intrinsic) and call the
 *    replacer over the rows afterwards, so the replacer never runs while
 *    the matcher is mid-match; the string forms collect occurrences the
 *    same way (`strCollect`);
 *  - string-pattern `replace` / `replaceAll` with a replacement template
 *    (the `strReplace` / `strReplaceAll` intrinsics — GetSubstitution).
 *
 * The backends implement the regex intrinsics with the spec's lastIndex
 * rules (backend/wasm/regex-state.ts, runtime scr_regex.c). */
import * as ts from "../ts7/adapter.js";
import type { FnCtx, Lowerer } from "./lowerer.js";
import { BOOL, F64, IrExpr, IrFunction, IrLocal, IrStmt, IrType, REGEX, STRING, SrcLoc, UNDEFINED_T, VOID, arrayOf, typeEquals } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import { isMatchSliceType, lowerGroupsProjection, namedCaptureGroupsOfPattern } from "./lower-exprs.js";
import { foldRegexLiteral } from "../../backend/wasm/regex-fold.js";
import { typeKey } from "../types.js";
import { bodyReadsArguments } from "./lower-calls.js";

export interface ExecCompanionEntry {
  posId: string;
  inputId: string;
  ctx: FnCtx;
  /** the named groups of the one static pattern every write uses, or null
   * when the writes' regexes are not one statically known pattern */
  groups: { name: string; index: number }[] | null;
  /** every write is s.match(re) over a statically global regex */
  globalMatch: boolean;
}

export interface ExecCompanionUse {
  subject(e: IrExpr): IrExpr;
  pos(): IrExpr;
}

const NUMS = arrayOf(F64);

function unparen(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function strLit(value: string, loc: SrcLoc): IrExpr {
  return { kind: "strLit", value, type: STRING, loc };
}

function num(value: number, loc: SrcLoc): IrExpr {
  return { kind: "numLit", value, type: F64, loc };
}

function ref(localId: string, type: IrType, loc: SrcLoc): IrExpr {
  return { kind: "varRef", localId, type, loc };
}

function bin(op: "+" | "-" | "*" | "<" | ">=" | ">" | "===" | "!==", left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr {
  const cmp = op === "<" || op === ">=" || op === ">" || op === "===" || op === "!==";
  return { kind: "bin", op, left, right, type: cmp ? BOOL : F64, loc };
}

/* ── static regex facts ───────────────────────────────────────────────── */

/** The (pattern, flags) of a regex expression known at compile time: a
 * literal, `new RegExp("…", "…")` over string literals, or a const bound
 * to one of those. */
export function staticRegexOf(L: Lowerer, e: ts.Expression): { pattern: string; flags: string } | null {
  let expr = e;
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
  if (ts.isRegularExpressionLiteral(expr)) {
    const text = expr.text;
    const at = text.lastIndexOf("/");
    return { pattern: text.slice(1, at), flags: text.slice(at + 1) };
  }
  const isStr = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  if (
    ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "RegExp" &&
    L.isStdlibGlobal(expr.expression, "RegExp") && expr.arguments !== undefined &&
    expr.arguments.length >= 1 && expr.arguments.length <= 2 && isStr(expr.arguments[0]) &&
    (expr.arguments.length === 1 || isStr(expr.arguments[1]))
  ) {
    const flags = expr.arguments.length === 2 ? (expr.arguments[1] as ts.StringLiteral).text : "";
    return { pattern: (expr.arguments[0] as ts.StringLiteral).text, flags };
  }
  if (ts.isIdentifier(expr)) {
    const sym = L.resolveValueSymbol(expr);
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return null;
    if (!ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0) return null;
    return staticRegexOf(L, decl.initializer);
  }
  return null;
}

/** Capture count (whole match included) and named groups of a static
 * regex, by the one regex compiler; null when it does not compile. */
interface RegexShape {
  count: number;
  groups: { name: string; index: number }[];
  /** per capture index: always participates (captureAlwaysParticipates) */
  always: boolean[];
}

function staticRegexShape(L: Lowerer, e: ts.Expression): RegexShape | null {
  const s = staticRegexOf(L, e);
  if (s === null) return null;
  const out = foldRegexLiteral(s.pattern, s.flags);
  if (out.kind !== "ok") return null;
  const groups = namedCaptureGroupsOfPattern(s.pattern);
  if (groups === null) return null;
  let always = captureAlwaysParticipates(s.pattern);
  if (always.length !== out.captureCount) always = new Array<boolean>(out.captureCount).fill(false);
  return { count: out.captureCount, groups, always };
}

/** Per capture (index 1..n; [0] the whole match): true when the capture
 * ALWAYS participates in a successful match — no enclosing (or own)
 * quantifier admits zero repetitions, no alternation sits around it, and
 * no lookaround encloses it. Conservative: anything unclear answers false
 * (the parameter then takes `string | undefined`, Node's exact values). */
export function captureAlwaysParticipates(pattern: string): boolean[] {
  interface Frame { kind: "top" | "group" | "look"; capture: number; caps: number[]; alt: boolean }
  const top: Frame = { kind: "top", capture: 0, caps: [], alt: false };
  const stack: Frame[] = [top];
  const risky = new Set<number>();
  let count = 0;
  let i = 0;
  const zeroQuant = (at: number): boolean => {
    const c = pattern[at];
    if (c === "?" || c === "*") return true;
    if (c === "{") {
      const m = /^\{(\d+)(,\d*)?\}/.exec(pattern.slice(at));
      return m !== null && Number(m[1]) === 0;
    }
    return false;
  };
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    const cur = stack[stack.length - 1]!;
    if (c === "|") {
      cur.alt = true;
      i++;
      continue;
    }
    if (c === "(") {
      let kind: Frame["kind"] = "group";
      let capture = 0;
      if (pattern[i + 1] !== "?") {
        capture = ++count;
      } else if (pattern[i + 2] === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!") {
        capture = ++count; // (?<name>
      } else if (pattern[i + 2] === "=" || pattern[i + 2] === "!" || (pattern[i + 2] === "<" && (pattern[i + 3] === "=" || pattern[i + 3] === "!"))) {
        kind = "look";
      }
      stack.push({ kind, capture, caps: capture ? [capture] : [], alt: false });
      i++;
      continue;
    }
    if (c === ")") {
      const f = stack.length > 1 ? stack.pop()! : top;
      i++;
      // an alternation inside: captures in its branches may not take part
      if (f.alt) for (const k of f.caps) if (k !== f.capture) risky.add(k);
      if (f.kind === "look" || zeroQuant(i)) for (const k of f.caps) risky.add(k);
      stack[stack.length - 1]!.caps.push(...f.caps);
      continue;
    }
    i++;
  }
  // unclosed groups: give up on everything (the compiler judged the
  // pattern already; this is only a backstop)
  if (stack.length > 1) return new Array(count + 1).fill(false);
  if (top.alt) for (const k of top.caps) risky.add(k);
  const out = new Array<boolean>(count + 1).fill(true);
  for (const k of risky) out[k] = false;
  return out;
}

/** `string | undefined` as a checker type — String.prototype.at's return,
 * the one lib signature that spells it — or null if the lib lacks it. */
function stringOrUndefinedType(L: Lowerer): ts.Type | null {
  const at = L.checker.getPropertyOfType(L.checker.getStringType(), "at");
  if (!at) return null;
  const sigs = L.checker.getCallSignatures(L.checker.getTypeOfSymbol(at));
  for (const sig of sigs) {
    const t = L.checker.getReturnTypeOfSignature(sig);
    const ir = L.mapTypeOf(t);
    if (ir?.kind !== "union") continue;
    const arms = L.unions.get(ir.unionId)?.arms ?? [];
    if (arms.length === 2 && arms.some((a) => a.kind === "string") && arms.some((a) => a.kind === "undefinedT")) return t;
  }
  return null;
}

/* ── exec / match result companions ───────────────────────────────────── */

/** Is `e` a direct stdlib `re.exec(s)` / `s.match(re)`? Answers the regex
 * argument expression. */
function execOrMatchRegexOf(L: Lowerer, e: ts.Expression): ts.Expression | null {
  const c = unparen(e);
  if (!ts.isCallExpression(c) || !ts.isPropertyAccessExpression(c.expression)) return null;
  const acc = c.expression;
  if (acc.questionDotToken || c.questionDotToken || c.arguments.length !== 1) return null;
  if (!L.isStdlibMember(acc)) return null;
  if (acc.name.text === "exec" && L.mapTypeOf(L.typeOf(acc.expression))?.kind === "regex") return acc.expression;
  if (
    acc.name.text === "match" && L.mapTypeOf(L.typeOf(acc.expression))?.kind === "string" &&
    L.mapTypeOf(L.typeOf(c.arguments[0]!))?.kind === "regex"
  ) {
    return c.arguments[0]!;
  }
  return null;
}

function isNullish(e: ts.Expression): boolean {
  const c = unparen(e);
  return c.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(c) && c.text === "undefined");
}

function enclosingFunction(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p) || p.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) return p;
  }
  return undefined;
}

/** The scan behind a companion: every write of `sym` inside `scope` must be
 * `sym = <exec/match call>` or `sym = null|undefined`, in the declaring
 * function; answers the regex expressions of those calls, plus whether any
 * companion member is read at all — or null when a write disqualifies. */
function companionWrites(L: Lowerer, scope: ts.Node, sym: ts.Symbol, declFn: ts.Node | undefined, declName: ts.Node):
  { regexes: ts.Expression[]; read: boolean } | null {
  let ok = true;
  let read = false;
  const regexes: ts.Expression[] = [];
  ts.walkPreorder(scope, (n) => {
    if (!ok) return "stop";
    if (!ts.isIdentifier(n) || n === declName) return undefined;
    if (L.checker.getSymbolAtLocation(n) !== sym) return undefined;
    let top: ts.Node = n;
    while (top.parent !== undefined && ts.isParenthesizedExpression(top.parent)) top = top.parent;
    const p = top.parent;
    if (p === undefined) return undefined;
    if (ts.isPropertyAccessExpression(p) && p.expression === top) {
      const name = p.name.text;
      if (name === "index" || name === "input" || name === "groups") read = true;
      return undefined;
    }
    if (ts.isNonNullExpression(p) && p.parent !== undefined && ts.isPropertyAccessExpression(p.parent)) {
      const name = p.parent.name.text;
      if (name === "index" || name === "input" || name === "groups") read = true;
      return undefined;
    }
    if (ts.isBinaryExpression(p) && p.left === top) {
      const op = p.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        if (op !== ts.SyntaxKind.EqualsToken) { ok = false; return "stop"; }
        if (isNullish(p.right)) return undefined;
        const re = execOrMatchRegexOf(L, p.right);
        if (re === null || enclosingFunction(p) !== declFn) { ok = false; return "stop"; }
        regexes.push(re);
      }
      return undefined;
    }
    if (
      ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
        (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ts.isArrayLiteralExpression(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadElement(p) ||
      ts.isPropertyAssignment(p) || ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === top)
    ) {
      // possibly a destructuring / loop write — no companion for this one
      ok = false;
      return "stop";
    }
    return undefined;
  });
  return ok ? { regexes, read } : null;
}

/** The declaration interception (lowerVarStatement): declares the hidden
 * companions of an eligible exec/match result binding that reads
 * `.index` / `.input` / `.groups`, and registers it. The ordinary
 * declaration lowering follows (its initializer finds the registration
 * through execCompanionFor). */
export function lowerExecCompanionDecl(L: Lowerer, decl: ts.VariableDeclaration): IrStmt[] | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const sym = L.checker.getSymbolAtLocation(decl.name);
  if (!sym || L.tdzPredeclared.has(sym)) return null;
  const declared = L.mapTypeOf(L.typeOf(decl.name));
  if (!declared || !isMatchSliceType(L, declared)) return null;
  const regexes: ts.Expression[] = [];
  if (decl.initializer !== undefined && !isNullish(decl.initializer)) {
    const re = execOrMatchRegexOf(L, decl.initializer);
    if (re === null) return null;
    regexes.push(re);
  }
  const declFn = enclosingFunction(decl);
  const scope = declFn ?? decl.getSourceFile();
  const scan = companionWrites(L, scope, sym, declFn, decl.name);
  if (scan === null || !scan.read) return null;
  regexes.push(...scan.regexes);
  // .groups: known when every write's regex is the same static pattern
  let groups: { name: string; index: number }[] | null = null;
  const pats = regexes.map((r) => staticRegexOf(L, r));
  if (pats.length > 0 && pats.every((p) => p !== null && p.pattern === pats[0]!.pattern)) {
    groups = namedCaptureGroupsOfPattern(pats[0]!.pattern);
  }
  const loc = locOf(decl);
  const pos = L.declareHiddenMutableLocal("%mpos", NUMS);
  const input = L.declareHiddenMutableLocal("%minput", STRING);
  // every write a match() over a statically GLOBAL regex: the every-match
  // array, whose .index/.input Node answers undefined — refused at compile
  // time (a mix of shapes keeps the run-time check)
  const globalMatch = regexes.length > 0 && regexes.every((re, k) => {
    const p = re.parent;
    const isMatch = p !== undefined && ts.isCallExpression(p) && p.arguments.includes(re);
    return isMatch && (pats[k]?.flags.includes("g") ?? false);
  });
  L.execCompanions.set(sym, { posId: pos.id, inputId: input.id, ctx: L.ctx, groups, globalMatch });
  return [
    { kind: "varDecl", localId: pos.id, init: { kind: "arrayLit", elems: [], type: NUMS, loc }, loc },
    { kind: "varDecl", localId: input.id, init: strLit("", loc), loc },
  ];
}

/** Why a `.index` / `.input` / `.groups` read on a match result found no
 * companion — the refusal hint's second half (surfaces.ts). */
export function companionRejectionReason(L: Lowerer, recv: ts.Expression, member: string): string {
  let r: ts.Expression = recv;
  while (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r)) r = r.expression;
  if (!ts.isIdentifier(r)) {
    return "this result is not held in a variable — bind it first (`const m = re.exec(s)`)";
  }
  const sym = L.resolveValueSymbol(r);
  const entry = sym ? L.execCompanions.get(sym) : undefined;
  if (entry !== undefined && entry.ctx !== L.ctx) {
    return `'${r.text}' is read inside a closure, away from the function that assigned it`;
  }
  const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
  if (decl === undefined) return `'${r.text}' has no declaration this lowering can follow`;
  if (ts.isParameter(decl)) return `'${r.text}' is a parameter — the exec/match call happened in another function`;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) {
    return `'${r.text}' is not a plain local variable (a destructured binding, a loop variable or a property)`;
  }
  if (ts.isVariableDeclarationList(decl.parent) && (ts.isForOfStatement(decl.parent.parent) || ts.isForInStatement(decl.parent.parent))) {
    return `'${r.text}' is a for-of/for-in binding over something other than a direct s.matchAll(re)`;
  }
  const initRe = decl.initializer !== undefined && !isNullish(decl.initializer) ? execOrMatchRegexOf(L, decl.initializer) : undefined;
  if (initRe === null) {
    return `'${r.text}' is initialized from something other than a direct exec/match call (an alias, a function's result, an array element)`;
  }
  if (member === "groups" && initRe !== undefined && staticRegexOf(L, initRe) === null) {
    return "the regex is not statically known (a parameter or a computed value), so its group names are not";
  }
  return `'${r.text}' is also assigned from something other than a direct exec/match call, destructured into, or assigned inside a closure`;
}

/** The companion of the binding an exec/match call is assigned to (its
 * initializer, or `m = call` — through parentheses), in this function. */
export function execCompanionFor(L: Lowerer, call: ts.CallExpression): ExecCompanionUse | null {
  if (L.execCompanions.size === 0) return null;
  let top: ts.Node = call;
  while (top.parent !== undefined && ts.isParenthesizedExpression(top.parent)) top = top.parent;
  const p = top.parent;
  let name: ts.Node | null = null;
  if (p !== undefined && ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) name = p.name;
  if (
    p !== undefined && ts.isBinaryExpression(p) && p.right === top &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unparen(p.left))
  ) {
    name = unparen(p.left);
  }
  if (name === null) return null;
  const sym = L.checker.getSymbolAtLocation(name);
  const entry = sym ? L.execCompanions.get(sym) : undefined;
  if (entry === undefined || entry.ctx !== L.ctx) return null;
  const loc = locOf(call);
  return {
    subject: (e) => ({ kind: "assignExpr", localId: entry.inputId, value: e, type: STRING, loc }),
    pos: () => ref(entry.posId, NUMS, loc),
  };
}

const companionHelpers = new WeakMap<Lowerer, Map<string, string>>();

function helperName(L: Lowerer, key: string, build: (name: string) => IrFunction): string {
  let m = companionHelpers.get(L);
  if (!m) {
    m = new Map();
    companionHelpers.set(L, m);
  }
  let name = m.get(key);
  if (name === undefined) {
    name = `%regex.${key.split(":")[0]}.${m.size}`;
    m.set(key, name);
    L.liftedFns.push(build(name));
  }
  return name;
}

/** `m.index` / `m.input` / `m.groups` on a companion binding narrowed to
 * its row (string[]). The every-match form of a GLOBAL match has neither
 * (Node: undefined) — its positions are empty, and the read throws a
 * named Error rather than invent a number. */
export function lowerExecCompanionRead(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  const name = expr.name.text;
  if (name !== "index" && name !== "input" && name !== "groups") return null;
  let r: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r)) r = r.expression;
  if (!ts.isIdentifier(r)) return null;
  const sym = L.resolveValueSymbol(r);
  const entry = sym ? L.execCompanions.get(sym) : undefined;
  if (entry === undefined || entry.ctx !== L.ctx) return null;
  const recvT = L.mapTypeOf(L.typeOf(expr.expression));
  if (!recvT || !typeEquals(recvT, arrayOf(STRING))) return null;
  const loc = locOf(expr);
  if (name === "groups") {
    if (entry.groups === null) return null;
    if (entry.groups.length === 0) return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
    return lowerGroupsProjection(L, L.lowerExpr(expr.expression), entry.groups, loc);
  }
  if (entry.globalMatch) {
    L.unsupported(
      "SC1120",
      expr,
      `'.${name}' of a global match() result (Node answers undefined: the every-match array has no ${name})`,
    );
  }
  const resultT = name === "index" ? F64 : STRING;
  const fn = helperName(L, `companion:${name}`, (fname) => {
    const P = "p.0";
    const I = "i.0";
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: bin("===", { kind: "arrIntrinsic", method: "length", receiver: ref(P, NUMS, loc), args: [], type: F64, loc }, num(0, loc), loc),
        then: [{
          kind: "throw",
          value: {
            kind: "libCall",
            fn: "error.new",
            args: [strLit(`'.${name}' of a global match() result (Node: undefined) is not supported: the every-match array has no ${name}`, loc)],
            type: { kind: "object", className: "%Error" },
            loc,
          },
          loc,
        }],
        else_: null,
        loc,
      },
      {
        kind: "return",
        value: name === "index"
          ? { kind: "arrayGet", arr: ref(P, NUMS, loc), index: num(0, loc), type: F64, loc }
          : ref(I, STRING, loc),
        loc,
      },
    ];
    return {
      name: fname,
      params: [{ localId: P, name: "p", type: NUMS }, { localId: I, name: "i", type: STRING }],
      returnType: resultT,
      locals: [
        { id: P, name: "p", type: NUMS, mutable: false },
        { id: I, name: "i", type: STRING, mutable: false },
      ],
      body,
      loc,
    };
  });
  return { kind: "call", callee: fn, args: [ref(entry.posId, NUMS, loc), ref(entry.inputId, STRING, loc)], type: resultT, loc };
}

/* ── lastIndex and the flag accessors ─────────────────────────────────── */

const FLAG_GETTERS: Record<string, string> = {
  global: "g",
  ignoreCase: "i",
  multiline: "m",
  dotAll: "s",
  unicode: "u",
  sticky: "y",
  hasIndices: "d",
  unicodeSets: "v",
};

/** `re.lastIndex` and the flag accessors on a regex receiver; null for
 * any other member. */
export function lowerRegexMemberRead(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  const name = expr.name.text;
  const loc = locOf(expr);
  if (name === "lastIndex") {
    const receiver = L.lowerExpr(expr.expression);
    return { kind: "regexIntrinsic", method: "lastIndex", receiver, args: [], type: F64, loc };
  }
  const flag = FLAG_GETTERS[name];
  if (flag !== undefined && Object.prototype.hasOwnProperty.call(FLAG_GETTERS, name)) {
    const receiver = L.lowerExpr(expr.expression);
    const flags: IrExpr = { kind: "regexIntrinsic", method: "flags", receiver, args: [], type: STRING, loc };
    return { kind: "strIntrinsic", method: "includes", receiver: flags, args: [strLit(flag, loc)], type: BOOL, loc };
  }
  return null;
}

/** `re.lastIndex = v` / `re.lastIndex op= v` in statement position. */
export function lowerRegexLastIndexWrite(L: Lowerer, expr: ts.BinaryExpression): IrStmt | null {
  const op = expr.operatorToken.kind;
  const kind: "=" | "+" | "-" | null =
    op === ts.SyntaxKind.EqualsToken ? "=" :
    op === ts.SyntaxKind.PlusEqualsToken ? "+" :
    op === ts.SyntaxKind.MinusEqualsToken ? "-" : null;
  if (kind === null) return null;
  return lowerRegexLastIndexUpdate(L, expr.left, kind, expr.right, locOf(expr));
}

/** `re.lastIndex++` / `--` in statement position. */
export function lowerRegexLastIndexIncDec(L: Lowerer, operand: ts.Expression, op: "+" | "-", loc: SrcLoc): IrStmt | null {
  return lowerRegexLastIndexUpdate(L, operand, op, null, loc);
}

function lowerRegexLastIndexUpdate(L: Lowerer, target: ts.Expression, op: "=" | "+" | "-", rhsNode: ts.Expression | null, loc: SrcLoc): IrStmt | null {
  const left = unparen(target);
  if (!ts.isPropertyAccessExpression(left) || left.name.text !== "lastIndex" || left.questionDotToken) return null;
  if (L.mapTypeOf(L.typeOf(left.expression))?.kind !== "regex") return null;
  const set = (receiver: IrExpr, value: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: { kind: "regexIntrinsic", method: "setLastIndex", receiver, args: [value], type: VOID, loc },
    loc,
  });
  if (op === "=") {
    const receiver = L.lowerExpr(left.expression);
    return set(receiver, L.lowerExprExpecting(rhsNode!, F64));
  }
  // The receiver evaluates once: a hidden local holds it.
  const reLocal = L.declareHiddenLocal("%re", REGEX);
  const reRef = ref(reLocal.id, REGEX, loc);
  const init = L.lowerExpr(left.expression);
  const rhs = rhsNode === null ? num(1, loc) : L.lowerExprExpecting(rhsNode, F64);
  const read: IrExpr = { kind: "regexIntrinsic", method: "lastIndex", receiver: reRef, args: [], type: F64, loc };
  return {
    kind: "block",
    body: [
      { kind: "varDecl", localId: reLocal.id, init, loc },
      set(reRef, { kind: "bin", op, left: read, right: rhs, type: F64, loc }),
    ],
    loc,
  };
}

/* ── replace / replaceAll ─────────────────────────────────────────────── */

/** `s.replace(pat, rep)` / `s.replaceAll(pat, rep)` with a STRING pattern,
 * or with a FUNCTION replacement (either pattern kind). Null when the
 * shape is the plain regex-with-template form (lowerRegexMethodCall's own
 * path) or not a replace at all. */
export function lowerReplaceCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression,
  lowerReceiver: () => IrExpr): IrExpr | null {
  const isAll = access.name.text === "replaceAll";
  if (call.arguments.length !== 2) return null;
  const [patNode, repNode] = [call.arguments[0]!, call.arguments[1]!];
  const patT = L.mapTypeOf(L.typeOf(patNode));
  const isRegex = patT?.kind === "regex";
  if (!isRegex && patT?.kind !== "string") return null;
  const repT = L.typeOf(repNode);
  const isFn = L.checker.getCallSignatures(L.checker.getNonNullableType(repT)).length > 0;
  if (!isFn) {
    if (isRegex) return null; // the template form — lowerRegexMethodCall
    if (L.mapTypeOf(repT)?.kind !== "string") return null;
    const loc = locOf(call);
    const receiver = lowerReceiver();
    const pat = L.lowerExpr(patNode);
    const rep = L.lowerExpr(repNode);
    return { kind: "regexIntrinsic", method: isAll ? "strReplaceAll" : "strReplace", receiver, args: [pat, rep], type: STRING, loc };
  }
  return lowerFunctionReplace(L, call, isRegex, isAll, lowerReceiver);
}

type Role = "match" | "capture" | "offset" | "input" | "groups" | "extra";

function lowerFunctionReplace(L: Lowerer, call: ts.CallExpression, isRegex: boolean, isAll: boolean,
  lowerReceiver: () => IrExpr): IrExpr {
  const loc = locOf(call);
  const patNode = call.arguments[0]!;
  const fnNode = call.arguments[1]!;
  const fnExpr = unparen(fnNode);
  // The argument list Node passes: (match, ...captures, offset, string,
  // groups?) — a regex's captures known at compile time, or none for a
  // string pattern.
  let shape: RegexShape | null = { count: 1, groups: [], always: [true] };
  if (isRegex) shape = staticRegexShape(L, patNode);
  const roleOf = (j: number): Role | null => {
    if (j === 0) return "match";
    if (shape === null) return null;
    if (j < shape.count) return "capture";
    if (j === shape.count) return "offset";
    if (j === shape.count + 1) return "input";
    if (j === shape.count + 2 && shape.groups.length > 0) return "groups";
    return "extra";
  };
  // A replacer reading `arguments` sees every argument Node passes; the
  // call through the replacer's own signature cannot carry them.
  {
    let decl: ts.Node | undefined = fnExpr;
    if (ts.isIdentifier(fnExpr)) {
      const sym = L.resolveValueSymbol(fnExpr);
      decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) decl = unparen(decl.initializer);
    }
    if (decl && (ts.isFunctionExpression(decl) || ts.isFunctionDeclaration(decl)) && bodyReadsArguments(decl)) {
      L.unsupported(
        "SC1120",
        fnNode,
        "a function replacer that reads `arguments` (Node passes match, captures, offset, string and groups — declare them as parameters)",
      );
    }
  }
  // Evaluation order: receiver, pattern, replacer.
  const receiver = lowerReceiver();
  const pat = L.lowerExpr(patNode);
  let fn: IrExpr;
  if (ts.isArrowFunction(fnExpr) || ts.isFunctionExpression(fnExpr)) {
    // Implicit-any parameters (`(_, c) => c.toUpperCase()`) bind to the
    // types of the arguments Node passes; the ABI returns string.
    // A capture that can fail to participate binds to `string |
    // undefined` (Node passes undefined), one that always does to
    // `string`; a parameter past Node's arguments is undefined.
    const bindings = new Map<ts.Symbol, ts.Type>(L.implicitParamTypes ?? []);
    const strOrUndef = stringOrUndefinedType(L);
    fnExpr.parameters.forEach((p, j) => {
      if (p.type !== undefined || !ts.isIdentifier(p.name) || p.dotDotDotToken) return;
      const sym = L.checker.getSymbolAtLocation(p.name);
      if (!sym || !(L.checker.getTypeAtLocation(p.name).flags & ts.TypeFlags.Any)) return;
      const role = roleOf(j);
      if (role === "match" || role === "input") bindings.set(sym, L.checker.getStringType());
      else if (role === "capture") {
        if (shape!.always[j] === true) bindings.set(sym, L.checker.getStringType());
        else if (strOrUndef !== null) bindings.set(sym, strOrUndef);
        else L.unsupported("SC1120", p, "an unannotated capture parameter that can be undefined (annotate it `string | undefined`)");
      } else if (role === "extra" && strOrUndef !== null) bindings.set(sym, strOrUndef);
      else if (role === "offset") bindings.set(sym, L.checker.getNumberType());
      else if (role === "groups") {
        L.unsupported(
          "SC1120",
          p,
          "an unannotated groups parameter of a function replacer (annotate it: `groups: { [name: string]: string | undefined }`)",
        );
      }
    });
    const prev = L.implicitParamTypes;
    L.implicitParamTypes = bindings.size > 0 ? bindings : prev;
    L.lambdaRetOverrides.set(fnExpr, STRING);
    try {
      fn = L.lowerExpr(fnNode);
    } finally {
      L.implicitParamTypes = prev;
      L.lambdaRetOverrides.delete(fnExpr);
    }
  } else {
    fn = L.lowerExpr(fnNode);
  }
  const fnT = fn.type;
  if (fnT.kind !== "func" || fnT.rest) {
    L.unsupported("SC1120", fnNode, "a function replacement value of this type (pass a function with plain parameters)");
  }
  if (fnT.params.length > 1 && shape === null) {
    L.unsupported(
      "SC1120",
      fnNode,
      "a function replacer with capture or offset parameters over a regex whose captures are not known at compile time (use a regex literal, or a const bound to one)",
    );
  }
  const key = `fnReplace:${isRegex ? "re" : "str"}:${isAll}:${typeKey(fnT)}:${shape?.count ?? "?"}:${shape?.groups.map((g) => `${g.name}=${g.index}`).join(",") ?? ""}`;
  const name = helperName(L, key, (fname) => buildReplaceHelper(L, fname, fnNode, fnT, isRegex, isAll, shape, roleOf, loc));
  return { kind: "call", callee: name, args: [receiver, pat, fn], type: STRING, loc };
}

/** The lifted `%regex.fnReplace.N(S, pattern, F)`: collect the matches,
 * then call F over each and splice. */
function buildReplaceHelper(
  L: Lowerer,
  fname: string,
  blame: ts.Node,
  fnT: IrType & { kind: "func" },
  isRegex: boolean,
  isAll: boolean,
  shape: RegexShape | null,
  roleOf: (j: number) => Role | null,
  loc: SrcLoc,
): IrFunction {
  const rowsT = arrayOf(arrayOf(STRING));
  const locals: IrLocal[] = [];
  const local = (id: string, type: IrType, mutable = true): IrExpr => {
    locals.push({ id, name: id.split(".")[0]!, type, mutable });
    return ref(id, type, loc);
  };
  const S = local("s.0", STRING, false);
  const P = local("p.0", isRegex ? REGEX : STRING, false);
  const F = local("f.0", fnT, false);
  const pos = local("pos.0", NUMS);
  const rows = local("rows.0", rowsT);
  const parts = local("parts.0", arrayOf(STRING));
  const i = local("i.0", F64);
  const n = local("n.0", F64);
  const row = local("row.0", arrayOf(STRING));
  const width = local("w.0", F64);
  const start = local("start.0", F64);
  const r = local("r.0", STRING);
  const decl = (e: IrExpr, init: IrExpr): IrStmt => ({ kind: "varDecl", localId: (e as { localId: string }).localId, init, loc });
  const assign = (e: IrExpr, value: IrExpr): IrStmt => ({ kind: "assign", localId: (e as { localId: string }).localId, value, loc });
  const push = (arr: IrExpr, v: IrExpr): IrStmt => ({ kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "push", receiver: arr, args: [v], type: F64, loc }, loc });
  const len = (arr: IrExpr): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: arr, args: [], type: F64, loc });
  const at = (arr: IrExpr, index: IrExpr, type: IrType): IrExpr => ({ kind: "arrayGet", arr, index, type, loc });
  // The collection (runtime): rows [match, ...captures, gap] per result —
  // [match, gap] for a string pattern — then a final [tail] row, and each
  // result's capture positions in `pos`. No slicing of S happens here, and
  // the replacer runs only after every match is collected.
  const method = isRegex ? (isAll ? "collectAll" : "collect") : isAll ? "strCollectAll" : "strCollect";
  const body: IrStmt[] = [
    decl(pos, { kind: "arrayLit", elems: [], type: NUMS, loc }),
    decl(rows, { kind: "regexIntrinsic", method, receiver: S, args: [P, pos], type: rowsT, loc }),
    decl(parts, { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc }),
    decl(n, bin("-", len(rows), num(1, loc), loc)),
    decl(i, num(0, loc)),
  ];
  const base = (): IrExpr => bin("*", bin("*", i, num(2, loc), loc), width, loc);
  const loop: IrStmt[] = [
    decl(row, at(rows, i, arrayOf(STRING))),
    decl(width, bin("-", len(row), num(1, loc), loc)),
    decl(start, at(pos, base(), F64)),
  ];
  // The replacer's arguments, by its own parameter types.
  const args: IrExpr[] = fnT.params.map((pt, j) => {
    const role = roleOf(j);
    const undef = (): IrExpr => {
      const arms = pt.kind === "union" ? L.unions.get(pt.unionId)?.arms ?? [] : [];
      if (!arms.some((a) => a.kind === "undefinedT")) {
        L.unsupported(
          "SC1120",
          blame,
          `a function replacer parameter (#${j + 1}) that Node passes undefined to, typed '${L.fmt(pt)}' (declare it optional or '| undefined')`,
        );
      }
      return L.coerceInto(blame, { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, pt);
    };
    switch (role) {
      case "match":
        return L.coerceInto(blame, at(row, num(0, loc), STRING), pt);
      case "capture": {
        const cap = at(row, num(j, loc), STRING);
        if (pt.kind === "string") return cap; // S064: a nonparticipating capture is ""
        const arms = pt.kind === "union" ? L.unions.get(pt.unionId)?.arms ?? [] : [];
        if (!arms.some((a) => a.kind === "undefinedT")) return L.coerceInto(blame, cap, pt);
        // `p?: string` / `string | undefined`: Node's undefined exactly
        const startJ = at(pos, bin("+", base(), num(2 * j, loc), loc), F64);
        return { kind: "ternary", cond: bin("<", startJ, num(0, loc), loc), then: undef(), else_: L.coerceInto(blame, cap, pt), type: pt, loc };
      }
      case "offset":
        return L.coerceInto(blame, start, pt);
      case "input":
        return L.coerceInto(blame, S, pt);
      case "groups": {
        // `{ [name: string]: string | undefined }`: Node's undefined for a
        // group that did not participate, exactly; a `string`-valued
        // annotation keeps the "" projection (S064).
        const def = pt.kind === "record" ? L.shapes.get(pt.shapeId) : undefined;
        const iv = def?.indexValue;
        const ivArms = iv?.kind === "union" ? L.unions.get(iv.unionId)?.arms ?? [] : [];
        if (def && def.fields.length === 0 && iv && ivArms.some((a) => a.kind === "undefinedT")) {
          const order: string[] = [];
          const idxs = new Map<string, number[]>();
          for (const g of shape!.groups) {
            const got = idxs.get(g.name);
            if (got) got.push(g.index);
            else {
              idxs.set(g.name, [g.index]);
              order.push(g.name);
            }
          }
          const fields = order.map((name) => {
            // the first participating occurrence (ES2025 duplicates)
            let v: IrExpr = L.coerceInto(blame, { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, iv);
            for (const idx of [...idxs.get(name)!].reverse()) {
              const startK = at(pos, bin("+", base(), num(2 * idx, loc), loc), F64);
              v = { kind: "ternary", cond: bin(">=", startK, num(0, loc), loc), then: L.coerceInto(blame, at(row, num(idx, loc), STRING), iv), else_: v, type: iv, loc };
            }
            return { name, value: v, overflow: true as const };
          });
          return { kind: "recordLit", fields, type: pt, loc };
        }
        return L.coerceInto(blame, lowerGroupsProjection(L, row, shape!.groups, loc), pt);
      }
      case "extra":
        return undef();
      default:
        throw new Error("unreachable: replacer role");
    }
  });
  loop.push(decl(r, L.coerceInto(blame, { kind: "callValue", callee: F, args, type: fnT.ret, loc }, STRING)));
  loop.push(push(parts, at(row, width, STRING))); // the gap before the match
  loop.push(push(parts, r));
  loop.push(assign(i, bin("+", i, num(1, loc), loc)));
  body.push({ kind: "while", cond: bin("<", i, n, loc), body: loop, loc });
  body.push(push(parts, at(at(rows, n, arrayOf(STRING)), num(0, loc), STRING))); // the tail
  body.push({ kind: "return", value: { kind: "arrIntrinsic", method: "join", receiver: parts, args: [strLit("", loc)], type: STRING, loc }, loc });
  return {
    name: fname,
    params: [
      { localId: "s.0", name: "s", type: STRING },
      { localId: "p.0", name: "p", type: isRegex ? REGEX : STRING },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: STRING,
    locals,
    body,
    loc,
  };
}
/* ── a regex value crossing into dynamically-typed code ───────────────── */

/** The island boundary rebuilds a static regex as a FRESH engine RegExp
 * from its source and flags (lower-island.ts islandRegexpOf), where Node
 * passes the same object: lastIndex neither crosses nor comes back. That
 * was unobservable while this tier had no lastIndex (board #301 gave it
 * one), so a VALUE crossing (a literal crossing directly is a fresh object
 * either way) throws a named Error when it is global or sticky — the
 * flags whose methods read and write lastIndex on either side — or
 * already holds a lastIndex other than 0. Answers `re` itself otherwise. */
export function regexCrossingChecked(L: Lowerer, re: IrExpr): IrExpr {
  const loc = re.loc;
  const fn = helperName(L, "crossing", (fname) => {
    const R = ref("r.0", REGEX, loc);
    const flags: IrExpr = { kind: "regexIntrinsic", method: "flags", receiver: R, args: [], type: STRING, loc };
    const has = (f: string): IrExpr => ({ kind: "strIntrinsic", method: "includes", receiver: flags, args: [strLit(f, loc)], type: BOOL, loc });
    const li: IrExpr = { kind: "regexIntrinsic", method: "lastIndex", receiver: R, args: [], type: F64, loc };
    const bad = (cond: IrExpr): IrStmt => ({
      kind: "if",
      cond,
      then: [{
        kind: "throw",
        value: {
          kind: "libCall",
          fn: "error.new",
          args: [strLit(
            "passing a global or sticky RegExp value, or one whose lastIndex is not 0, into dynamically-typed code is not supported (the engine gets a fresh RegExp, so lastIndex would not be shared); pass a regex literal, or drop the g/y flag",
            loc,
          )],
          type: { kind: "object", className: "%Error" },
          loc,
        },
        loc,
      }],
      else_: null,
      loc,
    });
    return {
      name: fname,
      params: [{ localId: "r.0", name: "r", type: REGEX }],
      returnType: REGEX,
      locals: [{ id: "r.0", name: "r", type: REGEX, mutable: false }],
      body: [bad(has("g")), bad(has("y")), bad(bin("!==", li, num(0, loc), loc)), { kind: "return", value: R, loc }],
      loc,
    };
  });
  return { kind: "call", callee: fn, args: [re], type: REGEX, loc };
}
