/* Build acceptance across TypeScript versions: the reach of a
 * `// @ts-expect-error` / `// @ts-ignore` directive, and the writes a
 * suppressed error must never let through silently (docs/design/
 * ts-directives.md).
 *
 * TypeScript suppresses errors on the line after a directive. Where an
 * error lands inside a multi-line statement moved between versions:
 * TypeScript 4.9 reports a mismatched conditional `return a ? b : c` at
 * the statement, TypeScript 7 at the offending branch two lines down. A
 * project pinned to an older TypeScript (Vue 2.7 on 4.9.5) therefore
 * builds clean under its own tsc and fails under ours with the error the
 * directive was written for. So here a directive over an EXPRESSION-LIKE
 * statement (`return`, a variable statement, an expression statement, a
 * property declaration) suppresses errors anywhere in it. Over anything
 * else (`if`, loops, blocks, functions, classes, modules) it keeps
 * TypeScript's own one-line reach. Nothing about the program's types
 * changes; the lowering meets the suppressed site with its ordinary
 * per-site coercions, exactly as at a line TypeScript itself suppresses. */
import * as ts from "./ts7/adapter.js";

const DIRECTIVE = /^\/\/\/?\s*@ts-(?:expect-error|ignore)\b|^\/\*+\s*@ts-(?:expect-error|ignore)\b/;

/** The node kinds a directive's reach widens to (the whole statement). */
function widens(n: ts.Node): boolean {
  return ts.isReturnStatement(n) || ts.isVariableStatement(n) || ts.isExpressionStatement(n) || ts.isPropertyDeclaration(n);
}

/** Literal text a `//` or `/*` inside of is not a comment. */
const LITERAL_KINDS = new Set<number>([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.JsxText,
]);
function isLiteralText(n: ts.Node): boolean {
  return LITERAL_KINDS.has(n.kind);
}

/** Is `pos` inside a string, template or regex literal (so not a comment)? */
function insideLiteral(sf: ts.SourceFile, pos: number): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit || pos < n.pos || pos >= n.end) return;
    if (isLiteralText(n) && pos >= n.getStart()) {
      hit = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return hit;
}

const cache = new WeakMap<ts.SourceFile, readonly (readonly [number, number])[]>();

/** The statement ranges the file's directives widen to, [start, end). */
function directiveRanges(sf: ts.SourceFile): readonly (readonly [number, number])[] {
  const hit = cache.get(sf);
  if (hit !== undefined) return hit;
  const text = sf.text;
  const out: (readonly [number, number])[] = [];
  // Cheap filter first: most files carry no directive at all.
  if (text.includes("@ts-expect-error") || text.includes("@ts-ignore")) {
    let i = 0;
    while (i < text.length) {
      const c = text.indexOf("@ts-", i);
      if (c < 0) break;
      i = c + 4;
      // The comment that holds it: a `//` or a `/*` opening on its line,
      // with nothing but whitespace before it (TypeScript's rule).
      const lineStart = text.lastIndexOf("\n", c) + 1;
      const lead = text.slice(lineStart, c);
      const open = lineStart + (lead.length - lead.trimStart().length);
      if (!DIRECTIVE.test(text.slice(open, c + 20))) continue;
      // A `// @ts-ignore` inside a template literal is text, not a comment.
      if (insideLiteral(sf, open)) continue;
      const lineEnd = text.indexOf("\n", c);
      if (lineEnd < 0) break;
      const target = firstTokenAfter(text, lineEnd + 1);
      if (target < 0) continue;
      const node = outermostAt(sf, target);
      if (node !== undefined && widens(node)) out.push([node.getStart(), node.end]);
    }
  }
  cache.set(sf, out);
  return out;
}

/** The first non-whitespace, non-comment position at or after `from`. */
function firstTokenAfter(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) return -1;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    return i;
  }
}

/** The outermost node whose first token starts at `pos`. */
function outermostAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found !== undefined || pos < n.pos || pos >= n.end) return;
    if (n.getStart() === pos) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** Is the error at `pos` in `sf` inside a statement a directive widens to? */
export function directiveCovers(sf: ts.SourceFile, pos: number): boolean {
  const ranges = directiveRanges(sf);
  for (const [a, b] of ranges) if (pos >= a && pos < b) return true;
  return false;
}

/** Does the file carry a directive that can suppress a TypeScript error? */
export function hasSuppression(sf: ts.SourceFile): boolean {
  const t = sf.text;
  return t.includes("@ts-ignore") || t.includes("@ts-expect-error") || t.includes("@ts-nocheck");
}

const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

/** The writes a suppressed TypeScript error would let through where Node
 * throws, found statically in a file that suppresses errors (any other
 * file's are TypeScript errors already):
 * - an assignment to a `const` (or `using`) binding or an import binding
 *   (TS2588/TS2632; Node: `TypeError: Assignment to constant variable.`);
 * - a write to a read-only value, a `Readonly<…>` (what `Object.freeze`
 *   answers) or a readonly array or tuple, in a TypeScript file: a member
 *   or element write, `delete`, `++`/`--`, a mutating array method
 *   (Node: TypeError in strict code; this build keeps no frozen bit).
 * Each is a named refusal at the site. */
export function suppressedWriteSites(sf: ts.SourceFile, checker: ts.TypeChecker): { node: ts.Node; feature: string }[] {
  const out: { node: ts.Node; feature: string }[] = [];
  const isTs = !/\.(c|m)?jsx?$/.test(sf.fileName);
  const writeTop = (n: ts.Node): ts.Node | null => {
    // The write position an expression is in: an assignment's left side
    // (through destructuring literals), ++/--, a for-in/of head, delete.
    let top: ts.Node = n;
    for (;;) {
      const q = top.parent;
      if (q !== undefined && (ts.isParenthesizedExpression(q) || ts.isArrayLiteralExpression(q) || ts.isObjectLiteralExpression(q) ||
        ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q) || ts.isSpreadElement(q) || ts.isSpreadAssignment(q) ||
        ts.isNonNullExpression(q))) {
        top = q;
        continue;
      }
      break;
    }
    const q = top.parent;
    if (q === undefined) return null;
    if (ts.isBinaryExpression(q) && q.left === top && q.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && q.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return q;
    if ((ts.isPrefixUnaryExpression(q) || ts.isPostfixUnaryExpression(q)) &&
      (q.operator === ts.SyntaxKind.PlusPlusToken || q.operator === ts.SyntaxKind.MinusMinusToken)) return q;
    if ((ts.isForOfStatement(q) || ts.isForInStatement(q)) && q.initializer === top) return q;
    if (ts.isDeleteExpression(q)) return q;
    return null;
  };
  const constBinding = (id: ts.Identifier): string | null => {
    const s = checker.getSymbolAtLocation(id);
    if (s === undefined) return null;
    for (const d of checker.declarationsOf(s)) {
      if (ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) &&
        (d.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0) return "constant";
      if (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isImportEqualsDeclaration(d)) return "import";
    }
    return null;
  };
  const readonlyReceiver = (e: ts.Expression): boolean => {
    let t: ts.Type;
    try {
      t = checker.getTypeAtLocation(e);
    } catch {
      return false;
    }
    const parts = t.isUnionType() ? t.getTypes() : [t];
    return parts.some((p) => {
      const s = checker.typeToString(p);
      return s.startsWith("Readonly<") || s.startsWith("readonly ") || s.startsWith("ReadonlyArray<");
    });
  };
  const readonlyArray = (t: ts.Type): boolean => {
    const parts = t.isUnionType() ? t.getTypes() : [t];
    return parts.some((p) => {
      if ((p.flags & ts.TypeFlags.Object) === 0) return false;
      const str = checker.typeToString(p);
      return str.startsWith("readonly ") || str.startsWith("ReadonlyArray<");
    });
  };
  const mutableArray = (t: ts.Type): boolean => {
    const parts = t.isUnionType() ? t.getTypes() : [t];
    return parts.some((p) => {
      const str = checker.typeToString(p);
      return !str.startsWith("readonly ") && (str.endsWith("[]") || str.startsWith("Array<") || /^\[.*\]$/.test(str));
    });
  };
  const roFeature = "a read-only array entering a mutable array slot (TypeScript's error there is suppressed; a later write through the slot would throw in Node on a frozen array, and this build keeps no frozen bit)";
  const flows = (vt: ts.Type | undefined, ct: ts.Type | undefined): boolean =>
    vt !== undefined && ct !== undefined && readonlyArray(vt) && !readonlyArray(ct) && mutableArray(ct);
  /** The value and slot types of a shorthand property `{ items }`: the
   * value symbol's type against the property's contextual type. */
  const shorthandTypes = (sh: ts.ShorthandPropertyAssignment): [ts.Type | undefined, ts.Type | undefined] => {
    const sym = checker.getShorthandAssignmentValueSymbol(sh);
    const objCt = checker.getContextualType(sh.parent as ts.Expression);
    if (sym === undefined || objCt === undefined) return [undefined, undefined];
    const prop = checker.getPropertyOfType(objCt, (sh.name as ts.Identifier).text);
    return [checker.getTypeOfSymbolAtLocation(sym, sh.name), prop === undefined ? undefined : checker.getTypeOfSymbol(prop)];
  };
  const visit = (n: ts.Node): void => {
    // Every value with a contextual type is a slot it enters (an argument,
    // an initializer, an element, a returned or default value, a property
    // value, ...): a read-only array entering a mutable one refuses.
    // (A shorthand's own name is reported once, as the shorthand.)
    if (isTs && ((ts.isExpression(n) && !(n.parent !== undefined && ts.isShorthandPropertyAssignment(n.parent))) || ts.isShorthandPropertyAssignment(n))) {
      let vt: ts.Type | undefined;
      let ct: ts.Type | undefined;
      try {
        if (ts.isShorthandPropertyAssignment(n)) {
          [vt, ct] = shorthandTypes(n);
        } else {
          // The value's own type first (prefetched per file); the
          // contextual query only for a read-only array.
          vt = checker.getTypeAtLocation(n);
          ct = readonlyArray(vt) ? checker.getContextualType(n) : undefined;
        }
      } catch {
        vt = undefined;
      }
      if (flows(vt, ct)) out.push({ node: n, feature: roFeature });
    }
    if (ts.isIdentifier(n)) {
      const w = writeTop(n);
      if (w !== null && !ts.isDeleteExpression(w)) {
        const kind = constBinding(n);
        if (kind !== null) {
          out.push({
            node: w,
            feature: `an assignment to the ${kind} binding '${n.text}' (TypeScript's error there is suppressed; Node throws TypeError: Assignment to constant variable.)`,
          });
        }
      }
    } else if (isTs && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
      const w = writeTop(n);
      if (w !== null && readonlyReceiver(n.expression)) {
        out.push({
          node: w,
          feature: "a write to a read-only value (a Readonly<…> or readonly array, as Object.freeze answers; TypeScript's error there is suppressed, Node throws a TypeError in strict code, and this build keeps no frozen bit)",
        });
      }
    } else if (isTs && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text) &&
      readonlyReceiver(n.expression.expression)) {
      out.push({
        node: n,
        feature: `'${n.expression.name.text}' on a read-only array (TypeScript's error there is suppressed; Node throws a TypeError on a frozen array, and this build keeps no frozen bit)`,
      });
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}
