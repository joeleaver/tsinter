/* Units U3 + U4 (docs/design/dynamic-values.md §4.6 "U3 + U4 plan as
 * built"): the lowering side of the ES5 object model on dynamic values.
 * Every construct here lowers to an `om.*` libCall (backend/wasm/
 * objmodel.ts) when its decisive operand is a dynamic value on the WasmGC
 * lanes' one dynamic world; anything else returns null and keeps the
 * existing path. Also SEMANTICS.md S132: the `Function` constructor and
 * `eval` throw Node's --disallow-code-generation-from-strings EvalError. */
import * as ts from "../ts7/adapter.js";
import { PoisonError, fnProtoOfValueNode, nodeThrowExpr, type Lowerer } from "./lowerer.js";
import { BOOL, DYN, F64, JSVAL, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import { isJsSourceFileName } from "../shared.js";

/** The object model serves the one-world WasmGC lowering (not the
 * embedded engine's --dynamic island, which has its own). */
export function omActive(L: Lowerer): boolean {
  return L.sharedDynamic && !L.engine;
}

function strip(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

/** Is the expression a dynamic value (its mapped type the one dynamic
 * world's)? */
export function isDynNode(L: Lowerer, node: ts.Expression): boolean {
  const t = L.typeOf(node);
  if ((t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
  let m;
  try {
    m = L.mapTypeOf(t);
  } catch {
    return false;
  }
  return m?.kind === "jsval" || m?.kind === "dyn";
}

function js(L: Lowerer, node: ts.Expression): IrExpr {
  return L.lowerExprExpecting(node, JSVAL);
}

function undefJs(loc: SrcLoc): IrExpr {
  return { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc };
}

function lib(fn: string, args: IrExpr[], loc: SrcLoc, type = JSVAL): IrExpr {
  return { kind: "libCall", fn, args, type, loc } as IrExpr;
}

/** `Object.prototype` as a value. */
export function lowerObjectPrototypeRead(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (!omActive(L)) return null;
  if (expr.name.text !== "prototype" || !L.isStdlibGlobal(expr.expression, "Object")) return null;
  // `Object.prototype.hasOwnProperty.call(...)` and kin keep their own
  // pattern lowering.
  const p = expr.parent;
  if (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === expr) return null;
  return lib("om.objectProto", [], locOf(expr));
}

const OM_PRIM_OK = new Set(["defineProperty", "defineProperties", "create", "setPrototypeOf", "getOwnPropertyDescriptor"]);

/** `Object.prototype.hasOwnProperty.call(o, k)` (and `{}.hasOwnProperty`)
 * over a dynamic receiver: the own-key test. */
export function lowerHasOwnPropertyCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (!omActive(L)) return null;
  const callee = strip(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call" || call.arguments.length !== 2) return null;
  const hop = strip(callee.expression);
  if (!ts.isPropertyAccessExpression(hop) || hop.name.text !== "hasOwnProperty") return null;
  const base = strip(hop.expression);
  const isObjProto = ts.isPropertyAccessExpression(base) && base.name.text === "prototype" && L.isStdlibGlobal(base.expression, "Object");
  const isEmptyLit = ts.isObjectLiteralExpression(base) && base.properties.length === 0;
  if (!isObjProto && !isEmptyLit) return null;
  if (!isDynNode(L, call.arguments[0]!)) return null;
  const loc = locOf(call);
  const recv = { kind: "dynFromJsval", value: js(L, call.arguments[0]!), type: DYN, loc } as IrExpr;
  const keyNode = call.arguments[1]!;
  const key0 = L.lowerExpr(keyNode);
  const key: IrExpr = key0.type.kind === "string" ? key0 : ({ kind: "toString", operand: key0, type: STRING, loc: locOf(keyNode) } as IrExpr);
  return { kind: "libCall", fn: "dyn.hasOwn", args: [recv, key], type: BOOL, loc } as IrExpr;
}

/** Object.<member>(...) over a dynamic operand, or null. */
export function lowerObjModelStatic(L: Lowerer, call: ts.CallExpression, member: string): IrExpr | null {
  if (!omActive(L)) return null;
  const args = call.arguments;
  if (args.some((a) => ts.isSpreadElement(a))) return null;
  const loc = locOf(call);
  // A dynamic first operand, or a primitive one (Node's TypeErrors and
  // primitive answers come from the same helpers).
  const prim = (e: ts.Expression): boolean => {
    const k = L.mapTypeOf(L.typeOf(e))?.kind;
    return k === "f64" || k === "string" || k === "bool" || k === "undefinedT" || k === "nullT";
  };
  const dyn0 = args.length > 0 && (isDynNode(L, args[0]!) || (OM_PRIM_OK.has(member) && prim(args[0]!)));
  const isProtoExpr = (e: ts.Expression | undefined): boolean => {
    if (e === undefined) return false;
    const x = strip(e);
    return ts.isPropertyAccessExpression(x) && x.name.text === "prototype" && L.isStdlibGlobal(x.expression, "Object");
  };
  switch (member) {
    case "defineProperty": {
      if (!dyn0 || args.length < 3) return null;
      // A well-known symbol key (`Symbol.hasInstance`): its reserved
      // string key (objmodel.ts SYM_KEY_PREFIX).
      const k = strip(args[1]!);
      if (ts.isPropertyAccessExpression(k) && L.isStdlibGlobal(k.expression, "Symbol")) {
        if (k.name.text !== "hasInstance") return null;
        const key: IrExpr = { kind: "jsMarshal", value: { kind: "strLit", value: "\uD800@@" + k.name.text, type: STRING, loc }, type: JSVAL, loc } as IrExpr;
        return lib("om.defineProperty", [js(L, args[0]!), key, js(L, args[2]!)], loc);
      }
      return lib("om.defineProperty", [js(L, args[0]!), js(L, args[1]!), js(L, args[2]!)], loc);
    }
    case "defineProperties":
      if (!dyn0 || args.length < 2) return null;
      return lib("om.defineProperties", [js(L, args[0]!), js(L, args[1]!)], loc);
    case "getOwnPropertyDescriptor":
      if (!dyn0 || args.length < 1) return null;
      return lib("om.getOwnPropertyDescriptor", [js(L, args[0]!), args.length > 1 ? js(L, args[1]!) : undefJs(loc)], loc);
    case "getOwnPropertyDescriptors":
      if (!dyn0) return null;
      return lib("om.getOwnPropertyDescriptors", [js(L, args[0]!)], loc);
    case "getOwnPropertyNames":
      if (!dyn0) return null;
      return lib("om.getOwnPropertyNames", [js(L, args[0]!)], loc);
    case "getPrototypeOf":
      if (!dyn0) return null;
      return lib("om.getPrototypeOf", [js(L, args[0]!)], loc);
    case "setPrototypeOf":
      if (!dyn0 || args.length < 2) return null;
      return lib("om.setPrototypeOf", [js(L, args[0]!), js(L, args[1]!)], loc);
    case "create": {
      if (args.length < 1) return null;
      const p0 = strip(args[0]!);
      const nullProto = p0.kind === ts.SyntaxKind.NullKeyword;
      if (!(dyn0 || isProtoExpr(args[0]) || (nullProto && args.length > 1))) return null;
      const proto = nullProto ? ({ kind: "jsOp", op: "nullLit", args: [], type: JSVAL, loc } as IrExpr) : js(L, args[0]!);
      return lib("om.create", [proto, args.length > 1 ? js(L, args[1]!) : undefJs(loc)], loc);
    }
    case "freeze":
    case "seal":
    case "preventExtensions": {
      if (!dyn0) return null;
      const level = member === "freeze" ? 2 : member === "seal" ? 1 : 0;
      return lib("om.integrity", [js(L, args[0]!), { kind: "numLit", value: level, type: F64, loc }], loc);
    }
    case "isFrozen":
    case "isSealed":
    case "isExtensible": {
      if (!dyn0) return null;
      const level = member === "isFrozen" ? 2 : member === "isSealed" ? 1 : 0;
      return lib("om.isIntegrity", [js(L, args[0]!), { kind: "numLit", value: level, type: F64, loc }], loc, BOOL);
    }
    default:
      return null;
  }
}

/** `delete o.k` / `delete o[k]` on a dynamic receiver, or null. */
export function lowerObjModelDelete(L: Lowerer, expr: ts.DeleteExpression): IrExpr | null {
  if (!omActive(L)) return null;
  const target = strip(expr.expression);
  const loc = locOf(expr);
  if (ts.isPropertyAccessExpression(target)) {
    if (!isDynNode(L, target.expression)) return null;
    return lib("om.delete", [js(L, target.expression), { kind: "strLit", value: target.name.text, type: STRING, loc }], loc, BOOL);
  }
  if (ts.isElementAccessExpression(target)) {
    if (!isDynNode(L, target.expression)) return null;
    const recv = js(L, target.expression);
    const keyNode = target.argumentExpression;
    const key = L.lowerExpr(keyNode);
    const keyStr: IrExpr = key.type.kind === "string" ? key : { kind: "toString", operand: key, type: STRING, loc: locOf(keyNode) } as IrExpr;
    return lib("om.delete", [recv, keyStr], loc, BOOL);
  }
  return null;
}

let es5RefGuard: ts.Node | null = null;

/** A reference to an ES5 constructor (or a re-routed function): the
 * function as a dynamic FUNC value, so its `prototype`, its own
 * properties, `call`/`apply`/`bind` and `===` all see one value. */
export function lowerEs5Ref(L: Lowerer, expr: ts.Identifier): IrExpr | null {
  const info = L.es5;
  if (info === null || info.ctors.size === 0 || es5RefGuard === expr) return null;
  const p = expr.parent;
  if (p !== undefined && ts.isFunctionDeclaration(p) && p.name === expr) return null;
  const s = L.checker.getSymbolAtLocation(expr);
  if (s === undefined || !info.ctors.has(s)) return null;
  const saved = es5RefGuard;
  es5RefGuard = expr;
  try {
    const raw = L.lowerExpr(expr);
    if (raw.type.kind === "jsval" || raw.type.kind === "dyn") return raw;
    return L.jsvalIn(raw, expr);
  } finally {
    es5RefGuard = saved;
  }
}

/** `v instanceof F` with a dynamic right side (an ES5 constructor, an
 * `any`): the prototype-chain walk. */
export function lowerObjModelInstanceof(L: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  if (!omActive(L) || expr.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return null;
  if (!isDynNode(L, expr.right)) {
    // JavaScript: a right side that cannot be called throws Node's
    // TypeError (the helper's own check).
    if (!isJsSourceFileName(expr.getSourceFile().fileName)) return null;
    const t = L.typeOf(expr.right);
    // A JavaScript function (no class) walks the chain; a non-callable
    // throws.
    if (L.checker.getConstructSignatures(t).length > 0) return null;
    const k = L.mapTypeOf(t)?.kind;
    if (k !== "record" && k !== "f64" && k !== "string" && k !== "bool" && k !== "func") return null;
  }
  // A class or builtin on the right keeps its own lowering.
  const rt = L.checker.getTypeAtLocation(expr.right);
  if (L.checker.getConstructSignatures(rt).length > 0 && (L.typeOf(expr.right).flags & ts.TypeFlags.Any) === 0) return null;
  const loc = locOf(expr);
  return { kind: "jsOp", op: "instanceOf", args: [js(L, expr.left), js(L, expr.right)], type: BOOL, loc } as IrExpr;
}

/** `new C(...)` over a dynamic callee (an ES5 constructor, an `any`). */
export function lowerObjModelNew(L: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!omActive(L)) return null;
  if (!isDynNode(L, expr.expression)) {
    // A JavaScript function value (no class): an ES5 constructor too.
    if (!isJsSourceFileName(expr.getSourceFile().fileName)) return null;
    const t = L.typeOf(expr.expression);
    if (L.checker.getCallSignatures(t).length === 0 || L.checker.getConstructSignatures(t).length > 0) return null;
  } else {
    // A dynamic callee that is no ES5 function: the existing lowering
    // first (a class value it can resolve), the object model only where
    // that refuses.
    const cs = ts.isIdentifier(strip(expr.expression)) ? L.checker.getSymbolAtLocation(strip(expr.expression)) : undefined;
    if (cs === undefined || L.es5 === null || !L.es5.ctors.has(cs)) {
      const saved = L.diagSink;
      const captured: typeof L.diags = [];
      L.diagSink = captured;
      let prior: IrExpr | null = null;
      try {
        prior = L.lowerNew(expr);
      } catch (e) {
        if (!(e instanceof PoisonError)) {
          L.diagSink = saved;
          throw e;
        }
      }
      L.diagSink = saved;
      if (prior !== null) {
        for (const d of captured) L.pushDiag(d);
        return prior;
      }
    }
  }
  const args = expr.arguments ?? [];
  if (args.some((a) => ts.isSpreadElement(a))) return null;
  const loc = locOf(expr);
  const spelling = ts.isIdentifier(expr.expression) ? expr.expression.text : ts.isPropertyAccessExpression(expr.expression) ? expr.expression.getText() : undefined;
  if (fnProtoOfValueNode(L, expr.expression) === 2) {
    // An arrow, method or async function: Node evaluates the callee and
    // the arguments, then throws its TypeError.
    const stmts: IrStmt[] = [expr.expression, ...args].map((a) => ({ kind: "exprStmt", expr: L.lowerExpr(a), loc: locOf(a) }) as IrStmt);
    return { kind: "seqExpr", stmts, result: nodeThrowExpr(1, "", `${spelling ?? "value"} is not a constructor`, JSVAL, loc), type: JSVAL, loc } as IrExpr;
  }
  return { kind: "jsOp", op: "construct", args: [js(L, expr.expression), ...args.map((a) => js(L, a))], type: JSVAL, loc, ...(spelling !== undefined ? { spelling } : {}) } as IrExpr;
}

/** The keys a for-in over a dynamic value visits (a fresh dynamic array),
 * or null when the operand is not dynamic. */
export function lowerObjModelForInKeys(L: Lowerer, operand: ts.Expression): IrExpr | null {
  if (!omActive(L) || !isDynNode(L, operand)) return null;
  return lib("om.forInKeys", [js(L, operand)], locOf(operand));
}

/* ── SEMANTICS.md S132 ─────────────────────────────────────────────── */

function isFunctionCtorType(L: Lowerer, node: ts.Expression): boolean {
  const t = L.typeOf(node);
  const sym = t.getSymbol();
  return sym !== undefined && sym.name === "FunctionConstructor" && L.isStdlibSymbol(sym);
}

/** The `Function` constructor as a value, a `Function(...)` / `new
 * Function(...)` through any alias, and `eval(...)`: each throws Node's
 * --disallow-code-generation-from-strings EvalError (the Function forms
 * after converting their arguments to strings). Null for anything else. */
export function lowerCodegenSite(L: Lowerer, expr: ts.Expression): IrExpr | null {
  if (!omActive(L)) return null;
  const loc = locOf(expr);
  if ((ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) && !expr.questionDotToken) {
    // `Function.<member>`: none is modeled (the value is S132's thrower,
    // whose `length`, `name`, `prototype`, `call`, `apply`, `bind` would
    // not be Node's), so each refuses by name
    const recv = strip(expr.expression);
    if (ts.isIdentifier(recv) && recv.text === "Function" && L.isStdlibGlobal(recv, "Function")) {
      const m = ts.isPropertyAccessExpression(expr) ? expr.name.text : expr.argumentExpression.getText();
      L.unsupported("SC1090", expr, `'Function.${m}' (a member of the Function constructor, SEMANTICS.md S132)`);
    }
    return null;
  }
  if (ts.isIdentifier(expr) && expr.text === "Function" && L.isStdlibGlobal(expr, "Function")) {
    return lib("om.codegenFn", [], loc);
  }
  if ((ts.isNewExpression(expr) || ts.isCallExpression(expr)) && !ts.isPropertyAccessExpression(expr.expression)) {
    const callee = expr.expression;
    const args = expr.arguments ?? [];
    if (args.some((a) => ts.isSpreadElement(a))) return null;
    // `eval(x)`, and the indirect `(0, eval)(x)` (its left operand runs)
    let ev: ts.Expression = strip(callee);
    const pre: ts.Expression[] = [];
    if (ts.isBinaryExpression(ev) && ev.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      pre.push(ev.left);
      ev = strip(ev.right);
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(ev) && ev.text === "eval" && L.isStdlibGlobal(ev, "eval")) {
      const stmts: IrStmt[] = [...pre, ...args].map((a) => ({ kind: "exprStmt", expr: L.lowerExpr(a), loc: locOf(a) }) as IrStmt);
      const thrower: IrExpr = { kind: "jsOp", op: "construct", args: [lib("om.codegenFn", [], loc)], type: JSVAL, loc };
      return stmts.length === 0 ? thrower : { kind: "seqExpr", stmts, result: thrower, type: JSVAL, loc };
    }
    if (isFunctionCtorType(L, callee)) {
      const fn = ts.isIdentifier(callee) && L.isStdlibGlobal(callee, "Function") ? lib("om.codegenFn", [], loc) : js(L, callee);
      return { kind: "jsOp", op: "construct", args: [fn, ...args.map((a) => js(L, a))], type: JSVAL, loc };
    }
  }
  return null;
}

/* ── U4: the ES5 analysis of JavaScript sources ─────────────────────── */

/** What one program's JavaScript sources make dynamic (decided once per
 * lowering, before anything lowers):
 *  - `ctors`: function symbols that are ES5 constructors (`new F`, or a
 *    `F.prototype` reference). F's references are dynamic FUNC values,
 *    and its instance type (`this` in its body, `new F()`) is `any`.
 *  - `syms`: bindings initialized by an object literal that reaches the
 *    object model (an Object.* model call, `delete`, for-in, computed
 *    `in`, a prototype role, a method reading `this`). Their values are
 *    dynamic objects (`any`), built as dynamic literals.
 *  - `lits`: object literals built as dynamic objects in place. */
export interface Es5Info {
  ctors: Set<ts.Symbol>;
  syms: Set<ts.Symbol>;
  lits: Set<ts.Node>;
}

const OM_TARGET_MEMBERS = new Set([
  "defineProperty", "defineProperties", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors",
  "getOwnPropertyNames", "getPrototypeOf", "setPrototypeOf", "create", "freeze", "seal",
  "preventExtensions", "isFrozen", "isSealed", "isExtensible",
]);

const DESC_KEYS = new Set(["value", "writable", "get", "set", "enumerable", "configurable"]);
const DATA_DESC_KEYS = new Set(["value", "writable", "enumerable", "configurable"]);

/** A CommonJS export table (`module.exports = {…}`, `exports.k = {…}`):
 * the module machinery owns its representation (namespace reads, live
 * getters), so the object model leaves it alone. */
function isCjsExportTable(n: ts.Node): boolean {
  let p = n.parent;
  while (p !== undefined && ts.isParenthesizedExpression(p)) p = p.parent;
  if (p === undefined || !ts.isBinaryExpression(p) || p.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const t = p.left.getText();
  return t === "module.exports" || t.startsWith("exports.") || t.startsWith("module.exports.");
}

/** A preorder walk with an explicit stack (a deeply nested expression
 * must not overflow the compiler's own stack); `visit` answers whether to
 * descend into the node's children. */
function walk(root: ts.Node, visit: (n: ts.Node) => boolean): void {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (!visit(n)) continue;
    const kids: ts.Node[] = [];
    ts.forEachChild(n, (k) => {
      kids.push(k);
    });
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}

function usesThis(fn: ts.Node): boolean {
  let found = false;
  walk(fn, (n) => {
    if (found) return false;
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return false;
    }
    // A nested non-arrow function has its own `this`.
    if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isMethodDeclaration(n))) return false;
    return true;
  });
  return found;
}

export function collectEs5(L: Lowerer, files: readonly ts.SourceFile[]): Es5Info | null {
  if (!omActive(L)) return null;
  const jsFiles = files.filter((sf) => !sf.isDeclarationFile && isJsSourceFileName(sf.fileName));
  if (jsFiles.length === 0) return null;
  const info: Es5Info = { ctors: new Set(), syms: new Set(), lits: new Set() };
  const checker = L.checker;
  const symOf = (e: ts.Expression): ts.Symbol | undefined => {
    const x = strip(e);
    if (!ts.isIdentifier(x)) return undefined;
    return checker.getSymbolAtLocation(x);
  };
  const fnSymbol = (s: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (s === undefined) return undefined;
    for (const d of checker.declarationsOf(s)) {
      if (!isJsSourceFileName(d.getSourceFile().fileName)) continue;
      if (ts.isFunctionDeclaration(d)) return s;
      if (ts.isVariableDeclaration(d) && d.initializer !== undefined && ts.isFunctionExpression(strip(d.initializer))) return s;
    }
    return undefined;
  };
  /** Marks an expression whose value must be a dynamic object: an object
   * literal in place, or the binding an object literal initializes. */
  const markDyn = (e: ts.Expression | undefined): void => {
    if (e === undefined) return;
    const x = strip(e);
    if (ts.isObjectLiteralExpression(x)) {
      if (!isCjsExportTable(x)) info.lits.add(x);
      return;
    }
    const s = symOf(x);
    if (s === undefined) return;
    // A function given properties or a prototype role: a dynamic FUNC.
    const f = fnSymbol(s);
    if (f !== undefined) {
      info.ctors.add(f);
      return;
    }
    for (const d of checker.declarationsOf(s)) {
      if (ts.isVariableDeclaration(d) && d.initializer !== undefined && ts.isObjectLiteralExpression(strip(d.initializer)) && isJsSourceFileName(d.getSourceFile().fileName)) {
        info.syms.add(s);
        info.lits.add(strip(d.initializer));
      }
    }
  };
  // Descriptor-shaped literals, made dynamic only where the program hands
  // descriptors to the object model at all (an option table's
  // `{ value: … }` row elsewhere keeps its typed record).
  const descLits: ts.ObjectLiteralExpression[] = [];
  let descConsumer = false;
  for (const sf of jsFiles) {
    walk(sf, (n) => {
      if (ts.isNewExpression(n)) {
        const f = fnSymbol(symOf(n.expression));
        if (f !== undefined) info.ctors.add(f);
      } else if (ts.isPropertyAccessExpression(n) && (n.name.text === "call" || n.name.text === "apply" || n.name.text === "bind")) {
        // A function whose receiver is re-routed: a dynamic FUNC value.
        const f = fnSymbol(symOf(n.expression));
        if (f !== undefined) info.ctors.add(f);
      } else if (ts.isPropertyAccessExpression(n) && n.name.text === "prototype") {
        const f = fnSymbol(symOf(n.expression));
        if (f !== undefined) info.ctors.add(f);
        // `F.prototype = { ... }`: the prototype object is dynamic.
        const p = n.parent;
        if (p !== undefined && ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) markDyn(p.right);
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) &&
                 n.expression.expression.text === "Object" && OM_TARGET_MEMBERS.has(n.expression.name.text)) {
        const m = n.expression.name.text;
        if (m === "defineProperty" || m === "defineProperties" || (m === "create" && n.arguments.length > 1)) descConsumer = true;
        markDyn(n.arguments[0]);
        if (m === "setPrototypeOf") markDyn(n.arguments[1]);
        if (m === "defineProperties" || m === "create") markDyn(n.arguments[1]);
        if (m === "defineProperty") markDyn(n.arguments[2]);
      } else if (ts.isDeleteExpression(n)) {
        const t = strip(n.expression);
        if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) markDyn(t.expression);
      } else if (ts.isForInStatement(n)) {
        markDyn(n.expression);
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && !ts.isStringLiteral(strip(n.left))) {
        markDyn(n.right);
      } else if (ts.isObjectLiteralExpression(n) && n.properties.length > 0 && n.properties.every((p) =>
        !ts.isSpreadAssignment(p) && p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && DESC_KEYS.has(p.name.text)) &&
        // at least one key only a descriptor has (a Proxy handler's
        // `{ get, set }` is not one)
        n.properties.some((p) => !ts.isSpreadAssignment(p) && p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && DATA_DESC_KEYS.has(p.name.text))) {
        // A property-descriptor-shaped literal: a dynamic object, so its
        // accessor halves are what the object model reads.
        if (!isCjsExportTable(n)) descLits.push(n);
      } else if (ts.isObjectLiteralExpression(n)) {
        // A method (or function-valued property) reading `this`.
        for (const p of n.properties) {
          const fn = ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
            ? p
            : ts.isPropertyAssignment(p) && ts.isFunctionExpression(strip(p.initializer)) ? strip(p.initializer) : undefined;
          if (fn !== undefined && usesThis(fn)) {
            if (!isCjsExportTable(n)) info.lits.add(n);
            break;
          }
        }
      }
      return true;
    });
  }
  if (descConsumer) for (const n of descLits) info.lits.add(n);
  // A binding initialized by a value rooted at a dynamic function or
  // object (`const b = f.bind(o)`, `const p = F.prototype`): dynamic too.
  {
    const rootSym = (e: ts.Expression): ts.Symbol | undefined => {
      let x = strip(e);
      for (;;) {
        if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = strip(x.expression);
        else if (ts.isCallExpression(x)) x = strip(x.expression);
        else break;
      }
      return ts.isIdentifier(x) ? checker.getSymbolAtLocation(x) : undefined;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const sf of jsFiles) {
        walk(sf, (n) => {
          if (ts.isVariableDeclaration(n) && n.initializer !== undefined && ts.isIdentifier(n.name)) {
            const init = strip(n.initializer);
            if (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init) || ts.isCallExpression(init)) {
              const r = rootSym(init);
              if (r !== undefined && (info.ctors.has(r) || info.syms.has(r))) {
                const s = checker.getSymbolAtLocation(n.name);
                if (s !== undefined && !info.syms.has(s) && !info.ctors.has(s)) {
                  info.syms.add(s);
                  changed = true;
                }
              }
            }
          }
          return true;
        });
      }
    }
  }
  // A dynamic literal's nested object literals are dynamic too (a
  // descriptor map's descriptors, a prototype's nested tables).
  {
    const work = [...info.lits];
    while (work.length > 0) {
      const lit = work.pop()!;
      if (!ts.isObjectLiteralExpression(lit)) continue;
      for (const p of lit.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const v = strip(p.initializer);
        if (ts.isObjectLiteralExpression(v) && !info.lits.has(v)) {
          info.lits.add(v);
          work.push(v);
        }
      }
    }
  }
  // An array literal holding a dynamic literal is dynamic too (its
  // elements are dynamic objects, not one typed union).
  for (const lit of [...info.lits]) {
    let p = lit.parent;
    while (p !== undefined && ts.isParenthesizedExpression(p)) p = p.parent;
    while (p !== undefined && ts.isArrayLiteralExpression(p) && !info.lits.has(p)) {
      info.lits.add(p);
      // its object-literal elements are dynamic objects too
      for (const el of p.elements) {
        const x = strip(el as ts.Expression);
        if (ts.isObjectLiteralExpression(x)) info.lits.add(x);
      }
      p = p.parent;
    }
  }
  // A literal marked in place whose declaration binds it: the binding too.
  for (const sf of jsFiles) {
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer !== undefined && info.lits.has(strip(n.initializer)) && ts.isIdentifier(n.name)) {
        const s = checker.getSymbolAtLocation(n.name);
        if (s !== undefined) info.syms.add(s);
      }
      return true;
    });
  }
  if (info.ctors.size === 0 && info.syms.size === 0 && info.lits.size === 0) return null;
  return info;
}

/** Lowerer.typeOf's ES5 answer: `any` for a dynamic binding's references
 * (its declaration name included), a dynamic literal, a reference to an
 * ES5 constructor, and any value of an ES5 constructor's instance type. */
export function es5TypeOf(L: Lowerer, info: Es5Info, node: ts.Node): ts.Type | null {
  if (ts.isIdentifier(node)) {
    const p = node.parent;
    if (p !== undefined && ts.isPropertyAccessExpression(p) && p.name === node) return null;
    if (p !== undefined && (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === node) return null;
    const s = p !== undefined && ts.isShorthandPropertyAssignment(p) ? L.checker.getShorthandAssignmentValueSymbol(p) : L.checker.getSymbolAtLocation(node);
    if (s !== undefined && (info.syms.has(s) || info.ctors.has(s))) {
      // The function declaration's own name keeps its function type.
      if (p !== undefined && ts.isFunctionDeclaration(p) && p.name === node) return null;
      return L.checker.getAnyType();
    }
  }
  if (info.lits.has(node)) return L.checker.getAnyType();
  // In a program the object model reaches, a JavaScript value of the
  // empty object-literal type (`{}` built and filled dynamically, or the
  // result of Object.defineProperties({}, ...)) is a dynamic object.
  if (ts.isExpression(node) && isJsSourceFileName(node.getSourceFile().fileName)) {
    const t = L.checker.getTypeAtLocation(node);
    const ts0 = t.getSymbol();
    if ((t.flags & ts.TypeFlags.Object) !== 0 && ts0 !== undefined && (ts0.flags & ts.SymbolFlags.ObjectLiteral) !== 0 &&
        L.checker.getPropertiesOfType(t).length === 0 && L.checker.getCallSignatures(t).length === 0 && L.checker.getConstructSignatures(t).length === 0) {
      return L.checker.getAnyType();
    }
  }
  if (info.ctors.size > 0 && (ts.isExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword)) {
    const t = L.checker.getTypeAtLocation(node);
    const sym = t.getSymbol();
    // An ES5 constructor's instance type, and the function's own type
    // wherever a value of it flows (a factory returning it).
    if (sym !== undefined && info.ctors.has(sym)) return L.checker.getAnyType();
  }
  return null;
}
