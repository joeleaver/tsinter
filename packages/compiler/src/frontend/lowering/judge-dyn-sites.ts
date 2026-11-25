/* S125 (c)'s judgement (SEMANTICS.md S125): every dynamic crossing the
 * program could observe, and every typed function boxed into a dynamic
 * value whose crossings it could observe, refuses by name (SC1090). */
import type { IrExpr, IrType } from "../../ir/nodes.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { fencedValue } from "./class-views.js";
import * as ts from "../ts7/adapter.js";
import { dynArmKey } from "./dyn-arm.js";
import { isJsSourceFileName } from "../shared.js";
import { armFailureNote } from "./arm-failures.js";
import { dynAliasClasses } from "./dyn-alias-classes.js";
import { dynDeepFresh, onlyValue, ownedTyped, resultOnArm, rootKey, uniqueDyn, unwrap } from "./dyn-copy-fresh.js";
import { anyIdentity, anyWritten, copyWindow, dynDestReadOnly, dynWritten, holderBinding, lastUse, origWrittenWhileHeld, ownedLocal, typedSideWritten } from "./dyn-copy-written.js";
import { destBinding, fresh } from "./width-copy-fresh.js";
import { closedRecordArms, isDynType, tkey } from "./width-copy-tables.js";
import type { DynJudgeCx, DynSite, Site, WidthCx } from "./width-cx.js";
import { callReach } from "./width-reach.js";
import { bkey, hasRef, refsOf } from "./width-uses.js";

const DYN_WRITE_TO = "the program writes to dynamic values, and a write through the copy would not reach the original";
const DYN_WRITE_FROM = "the program writes to dynamic values, and the copy would not see the write";
const DYN_SAME = "the program compares dynamic values by identity, and the copy is a different object";
const ORIG_WRITTEN = "the program writes to values of the original's type, and the copy would not see the write";
const COPY_WRITTEN = "the program writes to values of the copy's type, and a write through the copy would not reach the dynamic value";
const COPY_IDENTITY = "the program compares values of the copy's type by identity, and the copy is a different object";
const DYN_WIDTH = "the program prints, serializes or lists the keys of the copy, which keeps only the type's declared fields where JavaScript's object keeps every key it has";

/** GH #222: the closed record types a check into `t` copies by width:
 * the type's own record arms, or its array's elements' (`top`), and
 * those reached inside them (`nested`: a deep copy narrows every
 * level). */
function widthArms(cx: DynJudgeCx, t: IrType): { top: IrType[]; nested: IrType[] } {
  const top = closedRecordArms(cx.L, t).map((a) => a.t);
  if (t.kind === "array") top.push(...closedRecordArms(cx.L, t.elem).map((a) => a.t));
  const nested: IrType[] = [];
  const seen = new Set(top.map(tkey));
  const walk = (x: IrType, depth: number): void => {
    if (depth > 6) return;
    const sh = x.kind === "record" ? cx.L.shapes.get(x.shapeId) : undefined;
    for (const f of sh?.fields ?? []) {
      const inner = [...closedRecordArms(cx.L, f.type).map((a) => a.t), ...(f.type.kind === "array" ? closedRecordArms(cx.L, f.type.elem).map((a) => a.t) : [])];
      for (const i of inner) {
        if (seen.has(tkey(i))) continue;
        seen.add(tkey(i));
        nested.push(i);
        walk(i, depth + 1);
      }
    }
  };
  for (const a of top) walk(a, 0);
  return { top, nested };
}

/** Does a print, serialization or key listing meet the out-crossing's
 * width copy: where it is made, through its own binding, or (with no
 * binding accounting for every use) anywhere a value of its type is
 * observed? */
function widthObserved(cx: DynJudgeCx, s: DynSite): boolean {
  // (A copy behind U2's exact-fit test is no width copy: a value with a
  // key the type lacks stops by name — S128 (a2)/(a3).)
  if (s.arg?.kind === "call" && /^%u2\.exact\./.test(s.arg.callee)) return false;
  const { top, nested } = widthArms(cx, s.t);
  if (top.length === 0) return false;
  const all = [...top, ...nested];
  if (all.some((t) => cx.foldedKeys.has(tkey(t)))) return true;
  if (nested.some((t) => cx.reachNoSpec.has(tkey(t)))) return true;
  if (s.observedAt === true) return true;
  // (A consumed copy — pushed, read once — still meets every printer
  // of its type: review of #222's `arr.push(src as N)`.)
  const db = s.consumed ? null : destBinding(cx, s);
  if (db !== null && s.dest !== null && !s.dest.param) {
    if (db.uses.some((u) => u === "print" || u === "keys")) return true;
    if (db.uses.every((u) => u === "read")) return false;
  }
  return top.some((t) => cx.reachNoSpec.has(tkey(t)));
}

/** A function value boxed into (or out of) the dynamic world: its
 * thunk copies each composite argument and its composite result. By
 * type: a copy any write or identity test could meet. */
function fnTypeObservable(cx: DynJudgeCx, f: IrType & { kind: "func" }): string | null {
  for (const pt of [...f.params, f.ret]) {
    const refs = refsOf(cx, pt).refs;
    if (refs.length === 0) continue;
    if (anyWritten(cx, refs, null)) return COPY_WRITTEN;
    if (anyIdentity(cx, refs)) return COPY_IDENTITY;
    if (dynWritten(cx, null, null)) return DYN_WRITE_FROM;
    if (cx.dynIdentity) return DYN_SAME;
  }
  return null;
}

/** The program functions a boxed value carries, when they can be
 * named; `open` when some function inside cannot. */
function boxedFns(cx: DynJudgeCx, e: IrExpr | undefined, fn: string, depth = 0): { fns: string[]; open: boolean } {
  e = unwrap(cx, e);
  if (!e || depth > 6) return { fns: [], open: true };
  if (!isDynType(e.type) && refsOf(cx, e.type).fns.length === 0 && e.type.kind !== "func") return { fns: [], open: false };
  const merge = (xs: IrExpr[]): { fns: string[]; open: boolean } => {
    const out = { fns: [] as string[], open: false };
    for (const x of xs) {
      const r = boxedFns(cx, x, fn, depth + 1);
      out.fns.push(...r.fns);
      out.open ||= r.open;
    }
    return out;
  };
  switch (e.kind) {
    case "closure":
      return cx.byName.has(e.fnName) ? { fns: [e.fnName], open: false } : { fns: [], open: true };
    case "dynFrom":
      // Boxed right here (an out-crossing of a function just boxed).
      return boxedFns(cx, e.value, fn, depth + 1);
    case "recordLit":
      return merge(e.fields.map((f) => f.value));
    case "arrayLit":
      return merge(e.elems.filter((x): x is IrExpr => x !== null && typeof x === "object" && "kind" in x));
    case "ternary":
      return merge([e.then, e.else_]);
    case "varRef": {
      // A function adapter's captured function: whatever its callers hand it.
      const adapter = /^(%fn\.adapt\.\d+)\.impl$/.exec(fn);
      if (adapter && e.localId === "f.0") {
        const given = cx.adapterArgs.get(adapter[1]!) ?? [];
        const out = { fns: [] as string[], open: given.length === 0 };
        for (const g of given) {
          const r = boxedFns(cx, g.e, g.fn, depth + 1);
          out.fns.push(...r.fns);
          out.open ||= r.open;
        }
        return out;
      }
      const init = onlyValue(cx, fn, e.localId);
      return init ? boxedFns(cx, init, fn, depth + 1) : { fns: [], open: true };
    }
    default:
      return { fns: [], open: true };
  }
}

/** A program function boxed into a dynamic value: each composite
 * parameter receives a copy of the dynamic argument, and a composite
 * result goes back as a copy. */
function judgeBoxedFn(cx: DynJudgeCx, name: string): { why: string; what: string; param?: string } | null {
  const f = cx.byName.get(name)!;
  // The function literal's source parameters (U2a: a refused one takes
  // the dynamic arm in the next pass).
  const srcParams = cx.L.dynArmFnParams.get(name);
  // (S125 A4: a DECLARED function boxed into dynamic code — its refused
  // parameter is a `dparam:` site, taken only by the function's boxed
  // instance, so its direct calls keep the typed parameter.)
  const declHit = srcParams === undefined ? cx.L.declByFnName(name) : undefined;
  for (const p of f.params) {
    const refs = refsOf(cx, p.type).refs;
    if (refs.length === 0) continue;
    const ps: Site = { callee: "%dyn.param", arg: undefined, loc: f.loc, where: name, top: 0, dest: { key: `${name}\0${p.localId}`, param: true } };
    const db = destBinding(cx, ps);
    const reachFns = callReach(cx, name);
    const transient = !reachFns.suspends && db !== null && !db.uses.includes("other");
    const what = `its parameter '${p.name}' typed '${cx.L.fmt(p.type)}'`;
    const sp = srcParams?.find((q) => ts.isIdentifier(q.name) && q.name.text === p.name && !q.dotDotDotToken);
    const dp = declHit?.decl.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === p.name && !q.dotDotDotToken);
    const param = sp !== undefined ? `param:${dynArmKey(sp)}` : dp !== undefined ? `dparam:${dynArmKey(dp)}` : undefined;
    const out = (why: string): { why: string; what: string; param?: string } => (param !== undefined ? { why, what, param } : { why, what });
    if (typedSideWritten(cx, ps, p.type, null)) return out(COPY_WRITTEN);
    if (anyIdentity(cx, refs)) return out(COPY_IDENTITY);
    if (dynWritten(cx, null, transient ? reachFns.fns : null, null, null, null, refs)) return out(DYN_WRITE_FROM);
  }
  const rrefs = refsOf(cx, f.returnType).refs;
  if (rrefs.length > 0) {
    const rets: IrExpr[] = [];
    const scan = (n: unknown): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(scan);
      const r = n as Record<string, unknown>;
      if (r["kind"] === "return" && r["value"]) rets.push(r["value"] as IrExpr);
      for (const key of Object.keys(r)) if (key !== "type" && key !== "loc") scan(r[key]);
    };
    scan(f.body);
    const what = `its result typed '${cx.L.fmt(f.returnType)}'`;
    // Unit U2 (dyn-arm.ts): a refused result of a function literal
    // takes the dynamic arm in the next pass, as its parameters do.
    const fnNode = cx.L.dynArmFnNodes.get(name);
    // (S125 A4: a declared function's result — a `dret:` site, taken by
    // its boxed instance only)
    const param = fnNode !== undefined ? `ret:${dynArmKey(fnNode)}` : declHit !== undefined ? `dret:${dynArmKey(declHit.decl)}` : undefined;
    const out = (why: string): { why: string; what: string; param?: string } => (param !== undefined ? { why, what, param } : { why, what });
    for (const v0 of rets) {
      const v = unwrap(cx, v0);
      // A result nothing else holds once the function returns (built
      // from its own locals): the copy the box hands out is the only
      // one.
      if (!v || dynDeepFresh(cx, v, name) || ownedTyped(cx, v, name)) continue;
      if (anyWritten(cx, refsOf(cx, v.type).refs, null)) return out(ORIG_WRITTEN);
      if (dynWritten(cx, null, null)) return out(DYN_WRITE_TO);
      if (cx.dynIdentity || anyIdentity(cx, refsOf(cx, v.type).refs)) return out(DYN_SAME);
    }
  }
  return null;
}

/** S125 (c): every dynamic crossing the program could observe refuses
 * by name. */
export function judgeDynSites(base: WidthCx): void {
  if (base.dynSites.length === 0) return;
  const judging: Omit<DynJudgeCx, keyof WidthCx> = { returnsOwnedMemo: new Map<string, boolean>(), alias: dynAliasClasses(base), accessorsMemo: null };
  const cx: DynJudgeCx = Object.assign(base, judging);
  const reportedDyn = new Set<string>();
  let armParam: string | null = null;
  const judgedFns = new Map<string, { why: string; what: string; param?: string } | null>();
  if (cx.dynIdentity) for (const k of cx.islandEntered) cx.identity.add(k);
  // The program functions boxed into dynamic values (dynamic code calls
  // them, and what they return is handed to it), and the functions whose
  // result is on the dynamic arm; an unnamed boxed function (`open`)
  // leaves the copies inside it to the ordinary judgement.
  const boxedIntoDyn = new Set<string>();
  for (const s of cx.dynSites) {
    if (refsOf(cx, s.t).fns.length === 0 && s.t.kind !== "func") continue;
    for (const name of boxedFns(cx, s.arg, s.where).fns) boxedIntoDyn.add(name);
  }
  for (const name of cx.byName.keys()) if (resultOnArm(cx, name)) boxedIntoDyn.add(name);
  cx.judgingDyn = true;
  for (const s of cx.dynSites) {
    let why: string | null = null;
    let feature = "";
    // GH #222: a width copy only its printing could tell apart — at an
    // armable slot it tries the arm (falling back to U2's exact-fit copy,
    // which stops by name on an extra key); elsewhere it refuses.
    let widthOnly = false;
    let hint = "";
    const refs = refsOf(cx, s.t).refs;
    if (s.dir === "in") {
      feature = `a '${cx.L.fmt(s.t)}' value converted to a dynamic ('unknown', 'any' or 'object') value`;
      hint = "keep the value typed where it is shared, or hand the dynamic slot a value nothing else holds (a literal, a spread, structuredClone)";
      const x = unwrap(cx, s.arg);
      const src = x?.kind === "varRef" ? cx.bindings.get(bkey(cx, s.where, x.localId)) : undefined;
      const sole = x !== undefined && (fresh(cx, x) || (src !== undefined && !src.captured && src.assigns.length === 1 && fresh(cx, src.assigns[0]) && src.uses.every((u) => u === "read" || u === "copy" || u === "keys" || u === "print")));
      // Nothing else holds the value: fresh all the way down, or (at a
      // return) built from locals of the function that die with it.
      const unique = dynDeepFresh(cx, x, s.where) || (s.atReturn === true && ownedTyped(cx, x, s.where));
      if (refs.length > 0 && !unique && !s.consumed) {
        // The original is still held: a write on the dynamic side is
        // lost to it, and a write to it (or to anything inside it) is
        // lost to the copy.
        const destRO = dynDestReadOnly(cx, s);
        const dead = lastUse(cx, s);
        if (!destRO && dynWritten(cx, s, null, null, { e: s.node, fn: s.where }, dead)) why = DYN_WRITE_TO;
        // (A copy no binding, field or unknown code ever holds is read where it
        // is made, before the original can change.)
        else if (origWrittenWhileHeld(cx, s, sole ? refs.filter((r) => tkey(r) !== tkey(s.t)) : refs, dead)) why = ORIG_WRITTEN;
        // (GH #250: an identity test is no read-only use — `last === x`
        // over two crossings of one record compares two copies.)
        else if (cx.dynIdentityOps.some((o) => o === null || cx.alias.same(o.e, o.fn, s.node, s.where))) why = DYN_SAME;
      }
    } else {
      feature = `a dynamic ('unknown', 'any' or 'object') value checked into '${cx.L.fmt(s.t)}'`;
      hint = "keep the value dynamic and read its members through it, or cast a value nothing else holds (JSON.parse(text) as T)";
      // A new array a dynamic map/filter/slice/concat just built, checked
      // into an array of scalars: its spine is all the copy holds.
      const src = unwrap(cx, s.arg);
      const freshSpine = s.t.kind === "array" && !hasRef(cx, s.t.elem) && src?.kind === "dynInvoke" && /^(map|filter|slice|concat)$/.test(src.method);
      // Object.assign onto a fresh target, checked into a type of scalar
      // fields: the copy takes only scalars from the sources.
      const assignSrc = src?.kind === "seqExpr" ? unwrap(cx, src.result) : src;
      const freshAssign = assignSrc?.kind === "libCall" && /^dyn\.assign(All)?$/.test(assignSrc.fn) && uniqueDyn(cx, assignSrc.args[0], s.where) &&
        refsOf(cx, s.t).refs.every((x) => tkey(x) === tkey(s.t));
      if (refs.length > 0 && !s.consumed && !freshSpine && !freshAssign && !uniqueDyn(cx, s.arg, s.where) && !(s.atReturn && ownedLocal(cx, s.arg, s.where))) {
        // While the copy is alive: only the function its local binding
        // lives in (and what that can call) runs, unless it suspends.
        const window = copyWindow(cx, s);
        const viaHolder = s.dest === null && holderBinding(cx, s) !== null;
        // In a function dynamic code calls, a copy that lands in no
        // binding of its own may be part of what the function hands back
        // (`() => [cache]`, `() => ({ c: cache })`): it lives on after the
        // function returns, so any dynamic write or identity test anywhere
        // could tell it from the original.
        if (s.dest === null && boxedIntoDyn.has(s.where) && (dynWritten(cx, null, null) || cx.dynIdentity || anyIdentity(cx, refs))) why = dynWritten(cx, null, null) ? DYN_WRITE_FROM : DYN_SAME;
        else if (!viaHolder && typedSideWritten(cx, s, s.t, null)) why = COPY_WRITTEN;
        else if (dynWritten(cx, s, window, rootKey(cx, s.arg, s.where), { e: s.arg!, fn: s.where }, null, refs)) {
          why = DYN_WRITE_FROM;
        }
        else if (anyIdentity(cx, refs)) why = COPY_IDENTITY;
      }
      // GH #222: the copy keeps only its closed record type's declared
      // fields where the dynamic object may carry more, so printing it,
      // serializing it or listing its keys tells the two apart (S009's
      // width tolerance applies only to a value nothing else holds).
      // (A plain function's result tries the arm even for a fresh value —
      // `return JSON.parse(s)` keeps every key, as its const form does.)
      const wk = cx.L.dynArmExitNodes.get(s.node as object);
      const retArm = wk !== undefined && wk.startsWith("ret:");
      // (and a slot already tried on the arm that still copies, fresh or
      // not: `arr.push(src as N)` — delta review)
      const armedStill = wk !== undefined && (cx.L.dynArmSites.has(wk) || cx.L.exactSites.has(wk));
      if (!why && !freshSpine && !freshAssign && (retArm || armedStill || !uniqueDyn(cx, s.arg, s.where)) && widthObserved(cx, s)) {
        // (Delta review: a slot already on the arm that still copies — the
        // value must enter typed storage, `arr.push(src as N)` — refuses,
        // so the fallback pass's exact-fit copy stops by name; one the
        // fallback still copies without that test refuses outright.)
        if (wk !== undefined && !cx.L.dynArmSites.has(wk) && !cx.L.exactSites.has(wk) && !isJsSourceFileName(wk.replace(/^ret:/, "").replace(/:\d+:\d+$/, ""))) widthOnly = true;
        else why = DYN_WIDTH;
      }
    }
    // Functions boxed with the value (or unboxed from it).
    if (!why) {
      const fnTypes = refsOf(cx, s.t).fns;
      if (fnTypes.length > 0) {
        const boxed = boxedFns(cx, s.arg, s.where);
        for (const name of boxed.fns) {
          if (!judgedFns.has(name)) judgedFns.set(name, judgeBoxedFn(cx, name));
          const j = judgedFns.get(name);
          if (!j) {
            // Accepted: its composite parameters still try the arm (U2a).
            const f = cx.byName.get(name);
            const srcParams = cx.L.dynArmFnParams.get(name);
            for (const p of f?.params ?? []) {
              if (refsOf(cx, p.type).refs.length === 0) continue;
              const sp = srcParams?.find((q) => ts.isIdentifier(q.name) && q.name.text === p.name && !q.dotDotDotToken);
              if (sp !== undefined && !isJsSourceFileName(sp.getSourceFile().fileName)) cx.L.dynArmSoft.add(`param:${dynArmKey(sp)}`);
            }
          }
          if (j) {
            why = j.why;
            armParam = j.param ?? null;
            feature = `a function crossing into a dynamic value, ${j.what}`;
            hint = "leave the parameter dynamic ('unknown' or 'any') or return a fresh value, so dynamic code and the function share one object";
            break;
          }
        }
        if (!why && boxed.open) {
          for (const f of fnTypes) {
            const j = fnTypeObservable(cx, f);
            if (j) {
              why = j;
              feature = `a '${cx.L.fmt(f)}' function crossing ${s.dir === "in" ? "into" : "out of"} a dynamic value (its composite arguments and result cross as copies)`;
              hint = "type the function's composite parameters and result as 'unknown' or 'any', so both sides share one object";
              break;
            }
          }
        }
      }
    }
    if (!why) {
      // An accepted copy at a contained slot: the next pass tries the
      // dynamic arm (Node's sharing, Node's keys), falling back to it.
      // (TypeScript sources only: a JavaScript source keeps U1b's
      // checked-dynamic storage wherever its program builds.)
      const k = s.dir === "out" ? cx.L.dynArmExitNodes.get(s.node as object) : undefined;
      if (k !== undefined && (widthOnly || !k.startsWith("ret:")) && !isJsSourceFileName(k.replace(/:\d+:\d+$/, ""))) cx.L.dynArmSoft.add(k);
      continue;
    }
    // Unit U2a (dyn-arm.ts): a refused crossing at a contained slot
    // takes the dynamic arm in the next pass.
    if (s.dir === "out") {
      const k = cx.L.dynArmExitNodes.get(s.node as object);
      if (k !== undefined) cx.L.dynArmRetry.add(k);
    }
    if (armParam !== null) cx.L.dynArmRetry.add(armParam);
    armParam = null;
    const at = `${s.loc.file}:${s.loc.start}`;
    const diag = unsupportedDiag("SC1090", s.loc, `${feature}: it would be a COPY where JavaScript shares the object, and ${why} (SEMANTICS.md S125)${armFailureNote(cx.L, s.loc)}`, hint);
    // A compiled npm package's own JavaScript (SEMANTICS.md S133) takes the
    // JS deferral stance: the observable copy refuses where it RUNS — the
    // crossing ends the program by name — never the program's build.
    // So does the crossing of a dynamic Object.fromEntries result
    // (paperclip's removeUndefined<T> in an unreached client command):
    // a reach-only named stop (SEMANTICS.md S149 (c)).
    const fromEntriesArg = unwrap(cx, s.arg);
    const fromEntriesDyn = fromEntriesArg?.kind === "call" && /^%obj\.fromEntries\.dyn\.\d+$/.test(fromEntriesArg.callee);
    if ((npmStaticPackageOfPath(s.loc.file) !== null || fromEntriesDyn) && s.node !== null && typeof s.node === "object" && typeof (s.node as { kind?: unknown }).kind === "string") {
      const node = s.node as unknown as Record<string, unknown>;
      const orig = { ...node };
      for (const k of Object.keys(node)) delete node[k];
      // file:line, as every other deferred fence names its site
      const sf = cx.L.program.getSourceFile(s.loc.file);
      const line = sf !== undefined ? `:${ts.getLineAndCharacterOfPosition(sf, s.loc.start).line + 1}` : "";
      Object.assign(node, fencedValue(cx.L, orig as unknown as IrExpr, diag.code, `${diag.message} [${diag.code} at ${s.loc.file}${line}]`, s.loc));
      if (!reportedDyn.has(at)) cx.L.runtimeFences.push(diag);
      reportedDyn.add(at);
      continue;
    }
    if (reportedDyn.has(at)) continue;
    reportedDyn.add(at);
    cx.L.pushDiag(diag);
  }
  cx.judgingDyn = false;
}
