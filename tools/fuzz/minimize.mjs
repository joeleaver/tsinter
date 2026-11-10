/* The minimizer: shrink a program while a predicate (the same finding
 * still reproduces) holds. Reductions work on the TypeScript AST (the
 * repo's own `typescript` devDependency):
 *
 *   1. drop the generator's comments;
 *   2. ddmin over top-level statements (chunks, then single statements);
 *   3. delete nested statements and class members, one at a time;
 *   4. delete object-literal properties, array elements, call arguments
 *      (a console.log's label stays), type-literal members, union arms;
 *   5. simplify: an if to one branch, a try to its body, a literal to a
 *      plainer one.
 *
 * A candidate that no longer type-checks fails the predicate (the compile
 * reports SC0001), so reductions never need to know the type rules. */
import ts from "typescript";

function parse(src) {
  return ts.createSourceFile("main.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function apply(src, edits) {
  const sorted = [...edits].sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [s, e, t] of sorted) out = out.slice(0, s) + t + out.slice(e);
  return out;
}

/** A deletion of `node` with its leading trivia, plus one following
 * comma when it is a list element. */
function del(sf, node) {
  return [node.getFullStart(), node.getEnd(), ""];
}

function listDel(sf, list, i) {
  const n = list[i];
  if (i < list.length - 1) return [n.getStart(sf), list[i + 1].getStart(sf), ""];
  if (i > 0) return [list[i - 1].getEnd(), n.getEnd(), ""];
  return [n.getStart(sf), n.getEnd(), ""];
}

function isLabelCall(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === "console" && node.expression.name.text === "log";
}

/** Every candidate edit set for passes 3–5 on `src`, cheapest first. */
function candidates(src) {
  const sf = parse(src);
  const dels = [];
  const lists = [];
  const simp = [];
  const visit = (node) => {
    if ((ts.isBlock(node) || ts.isModuleBlock(node)) && node.statements.length > 0) {
      for (const st of node.statements) dels.push([del(sf, st)]);
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const m of node.members) dels.push([del(sf, m)]);
      if (node.heritageClauses) for (const h of node.heritageClauses) dels.push([[h.getFullStart(), h.getEnd(), ""]]);
    }
    if (ts.isObjectLiteralExpression(node)) node.properties.forEach((_, i) => lists.push([listDel(sf, node.properties, i)]));
    if (ts.isArrayLiteralExpression(node)) node.elements.forEach((_, i) => lists.push([listDel(sf, node.elements, i)]));
    if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) node.members.forEach((m) => lists.push([del(sf, m)]));
    if (ts.isUnionTypeNode(node)) node.types.forEach((_, i) => lists.push([listDel(sf, node.types, i)]));
    if (ts.isObjectBindingPattern(node)) node.elements.forEach((_, i) => lists.push([listDel(sf, node.elements, i)]));
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      const from = isLabelCall(node) ? 1 : 0;
      for (let i = from; i < args.length; i++) lists.push([listDel(sf, args, i)]);
    }
    if (ts.isIfStatement(node)) {
      simp.push([[node.getStart(sf), node.getEnd(), node.thenStatement.getText(sf)]]);
      if (node.elseStatement) simp.push([[node.getStart(sf), node.getEnd(), node.elseStatement.getText(sf)]]);
      if (node.elseStatement) simp.push([[node.thenStatement.getEnd(), node.getEnd(), ""]]);
    }
    if (ts.isTryStatement(node)) simp.push([[node.getStart(sf), node.getEnd(), node.tryBlock.getText(sf)]]);
    if (ts.isConditionalExpression(node)) {
      simp.push([[node.getStart(sf), node.getEnd(), node.whenTrue.getText(sf)]]);
      simp.push([[node.getStart(sf), node.getEnd(), node.whenFalse.getText(sf)]]);
    }
    if (ts.isNumericLiteral(node) && node.text !== "1" && node.text !== "0") simp.push([[node.getStart(sf), node.getEnd(), "1"]]);
    if (ts.isStringLiteral(node) && node.text.length > 1 && !(ts.isCallExpression(node.parent) && isLabelCall(node.parent) && node.parent.arguments[0] === node) && !ts.isPropertyAssignment(node.parent) && !ts.isPropertySignature(node.parent) && !ts.isElementAccessExpression(node.parent) && !ts.isImportDeclaration(node.parent)) {
      simp.push([[node.getStart(sf), node.getEnd(), '"a"']]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...dels.reverse(), ...lists.reverse(), ...simp];
}

function topLevel(src) {
  const sf = parse(src);
  return sf.statements.filter((s) => !ts.isImportDeclaration(s) && !(ts.isExportDeclaration(s) && !s.exportClause?.elements?.length)).map((s) => [s.getFullStart(), s.getEnd()]);
}

function stripComments(src) {
  return src.split("\n").filter((l, i) => i === 0 || !/^\s*\/\/ snippet \d+/.test(l)).join("\n");
}

/** Shrink `src` while `pred(candidate)` resolves true. `budget` caps the
 * number of predicate calls; `deadline` is an absolute ms time. */
export async function minimize(src, pred, { budget = 400, deadline = Infinity, log = () => {} } = {}) {
  let cur = src;
  let calls = 0;
  const history = [src];
  const tryIt = async (cand) => {
    if (cand === cur || calls >= budget || Date.now() > deadline) return false;
    calls++;
    const ok = await pred(cand);
    if (ok) {
      cur = cand;
      history.push(cand);
      log(`  min: ${cur.length} chars after ${calls} tries`);
    }
    return ok;
  };
  const out = () => ({ source: cur, calls, history });
  await tryIt(stripComments(cur));

  // 2. ddmin over top-level statements.
  let n = 2;
  for (;;) {
    const stmts = topLevel(cur);
    if (stmts.length === 0 || calls >= budget || Date.now() > deadline) break;
    n = Math.min(n, stmts.length);
    const size = Math.ceil(stmts.length / n);
    let progressed = false;
    for (let i = stmts.length - size; i >= 0 - size + 1; i -= size) {
      const lo = Math.max(0, i);
      const chunk = stmts.slice(lo, i + size);
      const cand = apply(cur, chunk.map(([s, e]) => [s, e, ""]));
      if (await tryIt(cand)) {
        progressed = true;
        break;
      }
    }
    if (progressed) {
      n = Math.max(n - 1, 2);
      continue;
    }
    if (size === 1) break;
    n = Math.min(n * 2, stmts.length);
  }

  // 3–5. Nested reductions, to a fixed point.
  for (let round = 0; round < 6; round++) {
    let progressed = false;
    const cs = candidates(cur);
    // Candidates are computed against `cur`; after a success, recompute.
    for (let i = 0; i < cs.length; i++) {
      if (calls >= budget || Date.now() > deadline) return out();
      const cand = apply(cur, cs[i]);
      if (await tryIt(cand)) {
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
    round = progressed ? -1 : round; // keep going while something shrinks
  }
  return out();
}

const FEATURE_CALLS = new Set([
  "keys", "entries", "values", "assign", "hasOwn", "stringify", "parse", "inspect", "format", "structuredClone",
  "toFixed", "toPrecision", "toString", "toExponential", "padStart", "padEnd", "split", "replace", "replaceAll", "repeat",
  "map", "filter", "reduce", "sort", "toSorted", "flatMap", "findLast", "at", "slice", "concat", "join", "push",
  "getPrototypeOf", "localeCompare", "normalize", "codePointAt", "charCodeAt", "trim", "max", "min", "round", "set", "delete",
  "freeze", "create", "isInteger", "parseInt", "parseFloat", "Number", "String", "BigInt", "decodeURIComponent", "encodeURIComponent",
]);

/** Syntactic feature tags of a (minimized) program, for bucketing. */
export function features(src) {
  const sf = parse(src);
  const f = new Set();
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.SpreadAssignment: f.add("obj-spread"); break;
      case ts.SyntaxKind.SpreadElement: f.add("arr-spread"); break;
      case ts.SyntaxKind.DeleteExpression: f.add("delete"); break;
      case ts.SyntaxKind.AnyKeyword: f.add("any"); break;
      case ts.SyntaxKind.UnknownKeyword: f.add("unknown"); break;
      case ts.SyntaxKind.ClassDeclaration: case ts.SyntaxKind.ClassExpression: f.add("class"); break;
      case ts.SyntaxKind.HeritageClause: f.add("extends"); break;
      case ts.SyntaxKind.ArrowFunction: f.add("arrow"); break;
      case ts.SyntaxKind.FunctionDeclaration: case ts.SyntaxKind.FunctionExpression: f.add("function"); break;
      case ts.SyntaxKind.TryStatement: f.add("try"); break;
      case ts.SyntaxKind.ThrowStatement: f.add("throw"); break;
      case ts.SyntaxKind.ForInStatement: f.add("for-in"); break;
      case ts.SyntaxKind.ForOfStatement: f.add("for-of"); break;
      case ts.SyntaxKind.UnionType: f.add("union"); break;
      case ts.SyntaxKind.TemplateExpression: f.add("template"); break;
      case ts.SyntaxKind.TypeOfExpression: f.add("typeof"); break;
      case ts.SyntaxKind.SwitchStatement: f.add("switch"); break;
      case ts.SyntaxKind.AsExpression: f.add("as"); break;
      case ts.SyntaxKind.ObjectBindingPattern: f.add("obj-destructure"); break;
      case ts.SyntaxKind.ArrayBindingPattern: f.add("arr-destructure"); break;
      case ts.SyntaxKind.PrivateIdentifier: f.add("#private"); break;
      case ts.SyntaxKind.GetAccessor: f.add("getter"); break;
      case ts.SyntaxKind.ThisKeyword: f.add("this"); break;
      case ts.SyntaxKind.SuperKeyword: f.add("super"); break;
      case ts.SyntaxKind.QuestionDotToken: f.add("?."); break;
      case ts.SyntaxKind.QuestionQuestionToken: f.add("??"); break;
      case ts.SyntaxKind.InKeyword: if (ts.isBinaryExpression(node.parent)) f.add("in"); break;
      default: break;
    }
    if (ts.isPropertySignature(node) && node.questionToken) f.add("optional-field");
    if ((ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) && ts.isStringLiteral(node.name)) f.add(/^-?\d/.test(node.name.text) ? "numeric-key" : "quoted-key");
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const n = node.expression.text;
      if (/Error$/.test(n)) f.add("new " + n);
      if (n === "Map" || n === "Set") f.add(n);
    }
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : null;
      if (name && FEATURE_CALLS.has(name)) f.add(name + "()");
    }
    if (ts.isIdentifier(node) && node.text === "undefined") f.add("undefined");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...f].sort();
}
