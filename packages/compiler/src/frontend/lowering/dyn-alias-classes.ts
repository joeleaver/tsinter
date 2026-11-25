/* Which dynamic values may be the same object (SEMANTICS.md S125 (c)): the
 * unification judgeDynSites reads to tell whose writes can reach a copy. */
import type { IrExpr, IrFunction, IrType } from "../../ir/nodes.js";
import { DYN_FRESH_LIB, DYN_IDENTITY, DYN_MUTATING, DYN_READER, DYN_WRITER, isDynType, isPatternHelper, PASS_THROUGH, PURE_LIB, tkey } from "./width-copy-tables.js";
import type { DynAliasClasses, WidthCx } from "./width-cx.js";
import { bkey, rootOf } from "./width-uses.js";

/** Which dynamic values may be the same object: a unification
 * (Steensgaard-style, flow- and field-insensitive) over the program's
 * dynamic values. Bindings, parameters, results, the dynamic fields of
 * typed values, and every value built fresh are nodes; an assignment, an
 * argument, a return, a capture, a store into a dynamic container (a
 * keyed write, a push) or a read out of one (a member, an element) puts
 * both sides in one class. Everything the analysis does not follow — a
 * dynamic call, a runtime function that is not a known reader or writer,
 * a throw, the parameters and results of functions used as values, any
 * expression kind not modelled here — meets in one UNKNOWN class. A copy
 * is a fresh node of its own; a crossing never joins the two sides (that
 * is what a copy is), except through the dynamic fields of the typed
 * value, which are shared. */
export function dynAliasClasses(cx: WidthCx): DynAliasClasses {
  // Function values flow like dynamic ones, so a call through a function
  // value reaches the functions that can flow to its callee.
  const tracked = (t: IrType | undefined): boolean => t !== undefined && (isDynType(t) || t.kind === "func");
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const members = new Map<string, string[]>();
  let changed = false;
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent.set(ra, rb);
    const ma = members.get(ra) ?? [ra];
    const mb = members.get(rb) ?? [rb];
    members.set(rb, mb.concat(ma));
    members.delete(ra);
    changed = true;
  };
  const membersOf = (x: string): string[] => {
    const r = find(x);
    return members.get(r) ?? [r];
  };
  /** Calls through function values: the callee's node, the nodes of
   * its tracked arguments (null: untracked), and the call's own node. */
  const valueCalls: { callee: string; args: (string | null)[]; result: string }[] = [];
  const UNKNOWN = "\0unknown";
  let fresh = 0;
  const nodeOf = new Map<unknown, string>();
  const isDyn = (e: IrExpr | undefined): boolean => e !== undefined && tracked(e.type);
  /** The nodes of the dynamic fields a typed value of type `t` carries. */
  const dynFields = (t: IrType, out: string[] = [], seen = new Set<string>()): string[] => {
    const k = tkey(t);
    if (seen.has(k)) return out;
    seen.add(k);
    if (t.kind === "record") {
      const sh = cx.L.shapes.get(t.shapeId);
      for (const f of sh?.fields ?? []) {
        if (tracked(f.type)) out.push(`r:${t.shapeId}:${f.name}`);
        else dynFields(f.type, out, seen);
      }
      if (sh?.indexValue) {
        if (tracked(sh.indexValue)) out.push(`r:${t.shapeId}:*`);
        else dynFields(sh.indexValue, out, seen);
      }
    } else if (t.kind === "object") {
      for (let c = cx.L.classes.get(t.className); c; c = c.base ?? undefined) {
        for (const [n, ft] of c.fields) {
          if (tracked(ft)) out.push(`o:${rootOf(cx, t.className)}:${n}`);
          else dynFields(ft, out, seen);
        }
      }
    } else if (t.kind === "union") {
      for (const a of cx.L.unions.get(t.unionId)?.arms ?? []) dynFields(a, out, seen);
    } else if (t.kind === "array" || t.kind === "map" || t.kind === "set" || t.kind === "promise") {
      const inner = t.kind === "array" ? t.elem : t.kind === "map" ? t.value : t.kind === "set" ? t.elem : t.inner;
      if (tracked(inner)) out.push(`c:${k}`);
      else dynFields(inner, out, seen);
    }
    return out;
  };
  const dynFieldsMemo = new Map<string, string[]>();
  const dynFieldsOf = (t: IrType): string[] => {
    let m = dynFieldsMemo.get(tkey(t));
    if (!m) dynFieldsMemo.set(tkey(t), (m = dynFields(t)));
    return m;
  };
  /** Typed expressions whose dynamic fields this walk follows: built
   * here (literals, constructors, checked out of a dynamic value), read
   * out of a value it follows, or handed on. */
  const TYPED_PRODUCERS = new Set([
    "varRef", "recordLit", "arrayLit", "recordGet", "fieldGet", "arrayGet", "recordKeyGet", "unionWrap", "unionNarrow",
    "upcast", "downcast", "ternary", "logical", "nullish", "orDefault", "seqExpr", "dynCheck", "call", "new",
    "virtualCall", "callValue", "closure", "arrIntrinsic",
  ]);
  const fieldNode = (e: Record<string, unknown>): string | null => {
    const k = e["kind"];
    if (k === "recordGet" || k === "recordSet") return `r:${e["shapeId"] as string}:${e["field"] as string}`;
    if (k === "recordKeyGet" || k === "recordKeySet") return `r:${e["shapeId"] as string}:*`;
    if (k === "fieldGet" || k === "fieldSet") return `o:${rootOf(cx, e["className"] as string)}:${e["field"] as string}`;
    return null;
  };
  const paramKey = (callee: string, i: number): string | null => {
    const f = cx.byName.get(callee);
    const p = f?.params[i];
    return p ? bkey(cx, callee, p.localId) : null;
  };
  /** The node of a dynamic expression (evaluating it for its effects). */
  const node = (e: IrExpr, fn: string): string => {
    const memo = nodeOf.get(e);
    if (memo !== undefined) return memo;
    const r = e as unknown as Record<string, unknown>;
    let n: string;
    switch (e.kind) {
      case "varRef":
        n = bkey(cx, fn, e.localId);
        break;
      case "closure":
        walk(r, fn, null, true);
        n = `\0fn:${e.fnName}`;
        break;
      case "callValue": {
        n = `\0f${fresh++}`;
        valueCallSite(r, fn, n);
        break;
      }
      case "dynKeyGet":
        walk(e.key, fn, null);
        n = node(e.value, fn);
        break;
      case "dynDestrCheck":
      case "dynFromJsval":
        n = node(e.value, fn);
        break;
      case "jsOp":
        if ((e.op === "getProp" || e.op === "getIdx") && e.args[0] && isDyn(e.args[0])) {
          n = node(e.args[0], fn);
          for (const a of e.args.slice(1)) walk(a, fn, null);
        } else if (e.op === "callFn" && e.args[0] !== undefined && isPatternHelper(e.args[0]) && e.args[1] && isDyn(e.args[1])) {
          // The bound values are parts of the source.
          n = node(e.args[1], fn);
          for (const a of e.args.slice(2)) walk(a, fn, null);
        } else if ((e.op === "callMethod" || e.op === "optCallMethod") && e.args[0] && isDyn(e.args[0])) {
          // dynInvoke's rule: a method's result is (a part of) its
          // receiver or of the values it is handed.
          n = node(e.args[0], fn);
          for (const a of e.args.slice(1)) {
            if (isDyn(a)) union(n, node(a, fn));
            else walk(a, fn, null);
          }
        } else if (e.op === "arrLit" || e.op === "objLit" || e.op === "objSpread") {
          // A new value holding what it is built from.
          n = `\0f${fresh++}`;
          for (const x of e.args) {
            if (isDyn(x)) union(n, node(x, fn));
            else walk(x, fn, null);
          }
        } else {
          walk(r, fn, null, true);
          n = UNKNOWN;
        }
        break;
      case "ternary":
        walk(e.cond, fn, null);
        n = node(e.then, fn);
        union(n, node(e.else_, fn));
        break;
      case "logical":
      case "nullish":
      case "orDefault": {
        const l = r["left"] as IrExpr;
        const rt = r["right"] as IrExpr;
        n = isDyn(l) ? node(l, fn) : `\0f${fresh++}`;
        if (!isDyn(l)) walk(l, fn, null);
        if (isDyn(rt)) union(n, node(rt, fn));
        else walk(rt, fn, null);
        break;
      }
      case "seqExpr":
        walk(e.stmts, fn, null);
        n = node(e.result, fn);
        break;
      case "dynFrom": {
        // A copy: a node of its own, sharing only the typed value's
        // dynamic fields.
        n = `\0f${fresh++}`;
        walk(e.value, fn, null);
        for (const f of dynFields(e.value.type)) union(n, f);
        break;
      }
      case "dynArrLit":
        n = `\0f${fresh++}`;
        for (const x of e.elems) {
          if (isDyn(x)) union(n, node(x, fn));
          else walk(x, fn, null);
        }
        break;
      case "dynObjLit":
        n = `\0f${fresh++}`;
        for (const f of e.fields ?? []) {
          walk(f.key, fn, null);
          if (isDyn(f.value)) union(n, node(f.value, fn));
          else walk(f.value, fn, null);
        }
        break;
      case "call": {
        if (PASS_THROUGH.test(e.callee) && e.args[0] && isDyn(e.args[0])) {
          n = node(e.args[0], fn);
          for (const a of e.args.slice(1)) walk(a, fn, null);
          break;
        }
        walk(r, fn, null, true);
        n = cx.byName.has(e.callee) ? `\0ret:${e.callee}` : UNKNOWN;
        break;
      }
      case "libCall":
        if (DYN_FRESH_LIB.test(e.fn)) {
          // Builds a new value from what it reads.
          for (const a of e.args) {
            if (isDynType(a.type)) node(a, fn);
            else walk(a, fn, null);
          }
          n = `\0f${fresh++}`;
        } else if (DYN_READER.test(e.fn) || PURE_LIB.test(e.fn)) {
          // A reader answers its argument or a part of it.
          n = `\0f${fresh++}`;
          for (const a of e.args) {
            if (isDynType(a.type)) union(n, node(a, fn));
            else walk(a, fn, null);
          }
        } else {
          walk(r, fn, null, true);
          n = UNKNOWN;
        }
        break;
      case "dynInvoke":
        walk(r, fn, null, true);
        n = node(e.recv, fn);
        break;
      case "recordGet":
      case "recordKeyGet":
      case "fieldGet": {
        walk(r, fn, null, true);
        n = fieldNode(r) ?? UNKNOWN;
        break;
      }
      default:
        walk(r, fn, null, true);
        n = UNKNOWN;
    }
    nodeOf.set(e, n);
    return n;
  };
  function valueCallSite(r: Record<string, unknown>, fn: string, result: string): void {
    const callee = r["callee"] as IrExpr;
    const args = (r["args"] as IrExpr[]).map((a) => {
      if (tracked(a.type)) return node(a, fn);
      walk(a, fn, null);
      return null;
    });
    valueCalls.push({ callee: tracked(callee.type) ? node(callee, fn) : UNKNOWN, args, result });
  }
  /** Walks `x` for its flows; `into` names the node a dynamic value found
   * here flows to (null: it escapes, unless its parent is modelled).
   * `children`: walk only the children of the kinded node `x`. */
  function walk(x: unknown, fn: string, into: string | null, children = false): void {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const y of x) walk(y, fn, into);
      return;
    }
    const r = x as Record<string, unknown>;
    const k = r["kind"];
    if (typeof k !== "string") {
      for (const key of Object.keys(r)) if (key !== "type" && key !== "loc" && key !== "name") walk(r[key], fn, into);
      return;
    }
    const e = r as unknown as IrExpr;
    if (!children && r["type"] !== undefined && tracked(r["type"] as IrType)) {
      const n = node(e, fn);
      union(n, into ?? UNKNOWN);
      return;
    }
    // A typed value made where this walk cannot see its dynamic fields
    // filled (a runtime result, an awaited or iterated value, a generator
    // step): those fields meet UNKNOWN.
    if (!children && r["type"] !== undefined && r["loc"] !== undefined && !TYPED_PRODUCERS.has(k)) {
      for (const f of dynFieldsOf(r["type"] as IrType)) union(f, UNKNOWN);
    }
    // A binding something other than a declaration or an assignment
    // fills (a loop variable, a catch binding, a pattern): its values are
    // not followed.
    if (typeof r["localId"] === "string" && k !== "varRef" && k !== "varDecl" && k !== "assign" && k !== "assignExpr" && k !== "incDec") {
      union(bkey(cx, fn, r["localId"] as string), UNKNOWN);
    }
    const sub = (key: string, to: string | null): void => walk(r[key], fn, to);
    switch (k) {
      case "callValue":
        valueCallSite(r, fn, `\0f${fresh++}`);
        return;
      case "varDecl":
        sub("init", bkey(cx, fn, r["localId"] as string));
        return;
      case "assign":
      case "assignExpr":
        sub("value", bkey(cx, fn, r["localId"] as string));
        return;
      case "return":
        sub("value", `\0ret:${fn}`);
        return;
      case "exprStmt": {
        const ex = r["expr"] as IrExpr;
        if (tracked(ex.type)) node(ex, fn);
        else walk(ex, fn, null);
        return;
      }
      case "call": {
        const callee = r["callee"] as string;
        const args = r["args"] as IrExpr[];
        args.forEach((a, i) => walk(a, fn, cx.byName.has(callee) ? paramKey(callee, i) : null));
        return;
      }
      case "closure": {
        const g = cx.byName.get(r["fnName"] as string);
        ((r["captures"] as string[] | undefined) ?? []).forEach((c, i) => {
          const gc = g?.captures?.[i];
          if (gc) union(bkey(cx, fn, c), bkey(cx, g!.name, gc.localId));
          else union(bkey(cx, fn, c), UNKNOWN);
        });
        return;
      }
      case "recordLit": {
        const shapeId = (r["type"] as IrType & { shapeId?: string }).shapeId;
        for (const f of (r["fields"] as { name: string; value: IrExpr }[]) ?? []) {
          walk(f.value, fn, shapeId !== undefined ? `r:${shapeId}:${f.name}` : null);
        }
        return;
      }
      case "recordSet":
      case "recordKeySet":
      case "fieldSet": {
        const fnode = fieldNode(r);
        for (const key of Object.keys(r)) {
          if (key === "type" || key === "loc") continue;
          walk(r[key], fn, key === "value" ? fnode : null);
        }
        return;
      }
      case "dynCheck":
        // A copy out: the typed value shares only its dynamic fields.
        {
          const v = r["value"] as IrExpr;
          const n = node(v, fn);
          for (const f of dynFields(r["type"] as IrType)) union(n, f);
        }
        return;
      case "dynTest":
      case "dynHasKey":
      case "jsonStringify":
      case "dynScalarEq":
      case "dynIterN":
        // Readers.
        for (const key of Object.keys(r)) {
          if (key === "type" || key === "loc") continue;
          const v = r[key];
          if (v && typeof v === "object" && !Array.isArray(v) && tracked((v as IrExpr).type)) node(v as IrExpr, fn);
          else walk(v, fn, null);
        }
        return;
      case "intrinsic":
        if (/^console\./.test(r["name"] as string)) {
          for (const a of r["args"] as IrExpr[]) {
            if (isDynType(a.type)) node(a, fn);
            else walk(a, fn, null);
          }
          return;
        }
        break;
      case "libCall": {
        const lf = r["fn"] as string;
        const args = r["args"] as IrExpr[];
        if (DYN_WRITER.test(lf) && args[0] && tracked(args[0].type)) {
          // A store into the first argument.
          const t = node(args[0], fn);
          for (const a of args.slice(1)) {
            if (tracked(a.type)) union(t, node(a, fn));
            else walk(a, fn, null);
          }
          return;
        }
        if (DYN_READER.test(lf) || PURE_LIB.test(lf)) {
          for (const a of args) {
            if (isDynType(a.type)) node(a, fn);
            else walk(a, fn, null);
          }
          return;
        }
        break;
      }
      case "dynInvoke": {
        const m = r["method"] as string;
        const recv = node(r["recv"] as IrExpr, fn);
        const args = r["args"] as IrExpr[];
        if (m === "sort") {
          // A comparator is called with elements, never stored; a boxed
          // one already met UNKNOWN where it was boxed.
          for (const a of args) {
            if (tracked(a.type)) node(a, fn);
            else walk(a, fn, null);
          }
          return;
        }
        if (DYN_MUTATING.has(m) || DYN_IDENTITY.has(m) || m === "join" || m === "slice" || m === "at" || m === "concat") {
          // Elements stored into (or read out of) the receiver.
          for (const a of args) {
            if (tracked(a.type)) union(recv, node(a, fn));
            else walk(a, fn, null);
          }
          return;
        }
        if (/^(forEach|map|filter|some|every|find|findIndex)$/.test(m)) {
          // The callback's parameters receive the elements (and the
          // receiver itself); its result joins the receiver's class.
          for (const a of args) {
            const g = a.kind === "dynFrom" && a.value.kind === "closure" ? cx.byName.get(a.value.fnName) : undefined;
            if (g) {
              walk((a as IrExpr & { kind: "dynFrom" }).value, fn, null);
              for (const p of g.params) if (tracked(p.type)) union(recv, bkey(cx, g.name, p.localId));
              union(recv, `\0ret:${g.name}`);
            } else if (tracked(a.type)) {
              union(node(a, fn), UNKNOWN);
              union(recv, UNKNOWN);
            } else walk(a, fn, null);
          }
          return;
        }
        union(recv, UNKNOWN);
        for (const a of args) walk(a, fn, null);
        return;
      }
      default:
        break;
    }
    for (const key of Object.keys(r)) {
      if (key === "type" || key === "loc") continue;
      walk(r[key], fn, null);
    }
  }
  // The functions every call of which this walk sees as a direct `call`
  // (whose arguments it joins to the parameters, and whose returns to the
  // call's value). Every other function — used as a value, a constructor
  // (`new`), a method (virtual calls, `super`), an async function or a
  // generator (their results reach the caller through a promise or an
  // iterator) — is called by code the walk does not follow.
  const direct = new Set<string>();
  {
    const scan = (n: unknown): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(scan);
      const r = n as Record<string, unknown>;
      if (r["kind"] === "call") direct.add(r["callee"] as string);
      for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
    };
    for (const f of cx.functions) scan(f.body);
  }
  for (const f of cx.functions) walk(f.body, f.name, null);
  // To a fixpoint: a function some code this walk does not follow can
  // call (its value met UNKNOWN, or it is not reached only by direct
  // calls and calls through values) has its parameters and its result in
  // UNKNOWN; a call through a value whose callee class is known joins
  // the arguments to each function's parameters and its result.
  const notFollowed = (f: IrFunction): boolean =>
    (!direct.has(f.name) && !cx.valueFns.has(f.name)) || !!f.async || !!f.generator || f.name.endsWith(".constructor") ||
    cx.classPrefixes.some((pre) => f.name.startsWith(pre)) ||
    (cx.valueFns.has(f.name) && find(`\0fn:${f.name}`) === find(UNKNOWN));
  do {
    changed = false;
    for (const f of cx.functions) {
      if (!notFollowed(f)) continue;
      for (const p of f.params) if (tracked(p.type)) union(bkey(cx, f.name, p.localId), UNKNOWN);
      union(`\0ret:${f.name}`, UNKNOWN);
    }
    for (const c of valueCalls) {
      if (find(c.callee) === find(UNKNOWN)) {
        for (const a of c.args) if (a !== null) union(a, UNKNOWN);
        union(c.result, UNKNOWN);
        continue;
      }
      for (const m of membersOf(c.callee)) {
        if (!m.startsWith("\0fn:")) continue;
        const g = cx.byName.get(m.slice(4));
        if (!g) continue;
        c.args.forEach((a, i) => {
          const p = g.params[i];
          if (a !== null && p && tracked(p.type)) union(a, bkey(cx, g.name, p.localId));
        });
        union(c.result, `\0ret:${g.name}`);
      }
    }
  } while (changed);
  return {
    holders: (e, fn) => membersOf(node(e, fn)).filter((m) => !m.startsWith("\0f") && !m.startsWith("\0ret:")),
    callees: (e, fn) => {
      const n = node(e, fn);
      if (find(n) === find(UNKNOWN)) return null;
      return membersOf(n).filter((m) => m.startsWith("\0fn:")).map((m) => m.slice(4));
    },
    same: (a, fa, b, fb) => {
      const na = node(a, fa);
      const nb = node(b, fb);
      return find(na) === find(nb);
    },
  };
}
