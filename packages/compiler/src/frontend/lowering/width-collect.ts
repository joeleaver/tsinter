/* The width-copy pass's collection walk (SEMANTICS.md S125): one visit over
 * every function body records the copy sites, dynamic crossings, writes,
 * identity tests, escapes and binding uses into the pass state. */
import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
import { ARG_MUTATOR, BUILDER, closedRecordArms, DYN_IDENTITY, DYN_MUTATING, DYN_WRITER, HOF_HELPER, isComposite, isCopyHelper, isDynType, isPatternHelper, JS_READING_METHODS, JS_WRITING_OPS, KEYS_HELPER, KEYS_KINDS, MUTATING_ARR, ORDER_HELPER, PASS_THROUGH, PRINT_HELPER, PRINT_KINDS, READING_ARR, spreadMayCarryExtra, spreadsIn, staticReadsArgs, tkey, TRANSPARENT } from "./width-copy-tables.js";
import type { Mode, Site, WidthCx } from "./width-cx.js";
import { atReturn, binding, bkey, consumedAt, dynUseAt, escape, exposedParts, forwardFrom, hasRef, holderAt, noteDynWrite, noteWrite, ownUseAt, refsOf, rootOf, transparentCallee, typedOwnUseAt, useOf } from "./width-uses.js";

/** Visits `n`; `mode` says where a VALUE found directly here sits in
 * its nearest kinded parent: a transparent position ("t"), a read-only
 * observer's operand ("r"), or anything else ("w" — an observer that
 * may also write). `parent`/`pkey` name that parent and the key. */
function visit(cx: WidthCx, n: unknown, mode: Mode, parent: Record<string, unknown> | null, pkey: string): void {
  if (n === null || typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const x of n) visit(cx, x, mode, parent, pkey);
    return;
  }
  const r = n as Record<string, unknown>;
  const k = r["kind"];
  if (typeof k !== "string") {
    // A plain carrier object (a recordLit field entry): its members keep
    // the parent's position.
    for (const key of Object.keys(r)) {
      if (key === "type" || key === "loc" || key === "name") continue;
      visit(cx, r[key], mode, parent, pkey);
    }
    return;
  }
  const t = r["type"] as IrType | undefined;
  // A composite VALUE in a non-transparent position escapes.
  if (mode !== "t" && t !== undefined && r["loc"] !== undefined && isComposite(t) && k !== "slotUndef") {
    // (`%jsin.union.N` is the per-arm tag switch whose composite arms
    // enter as views or marshals, each visited in its own body: its
    // argument escapes the way a view factory's does.)
    const viewArg = (parent !== null && parent["kind"] === "call" && pkey === "args" && /^%(view|jsin\.union)\.\d+$/.test(parent["callee"] as string)) ||
      /^%view\./.test(cx.curFn);
    if (viewArg || (parent !== null && parent["kind"] === "jsMarshal")) {
      cx.islandEntered.add(tkey(t));
      if (t.kind === "union") for (const a of cx.L.unions.get(t.unionId)?.arms ?? []) cx.islandEntered.add(tkey(a));
    }
    // Unit U2b: a module-scope speculative binding's own re-pointing (its
    // dynamic global taking the view of its exactly-fitting typed copy,
    // dyn-arm.ts lowerSpecDecl) is the dynamic value itself, in exactly
    // its type's shape: no printer reaching it can see a key it lacks.
    // Every other crossing of the copy is an escape like any other. (A
    // view factory's own body answers to its call sites: each records
    // its argument's escape.)
    const lid = k === "varRef" && typeof r["localId"] === "string" ? (r["localId"] as string) : null;
    const outer = cx.stack.length >= 2 ? cx.stack[cx.stack.length - 2]![0] : null;
    const repoint = viewArg && lid !== null && lid.endsWith("%spec.t") && outer !== null && outer["kind"] === "assign" &&
      outer["localId"] === lid.slice(0, -"%spec.t".length);
    const specView = repoint || /^%view\./.test(cx.curFn);
    escape(cx, t, mode === "w", viewArg, specView);
  }
  if (k === "varRef" && parent) {
    // A pass-through check answers its argument: the use is its own
    // parent's.
    let i = cx.stack.length - 1;
    i = forwardFrom(cx, i);
    const [up, upKey] = cx.stack[i]!;
    const b = binding(cx, bkey(cx, cx.curFn, r["localId"] as string));
    b.uses.push(useOf(cx, up, upKey));
    b.useAt.push({ fn: cx.curFn, up, key: upKey, child: i + 1 < cx.stack.length ? cx.stack[i + 1]![0] : r });
    if (up["kind"] === "recordSet" && upKey === "obj") b.fieldWrites = (b.fieldWrites ?? 0) + 1;
    // A chain of reads off the binding: the part it ends at, and that
    // part's own use.
    let j = i;
    let part: IrType | null = null;
    for (;;) {
      const [anc, key] = cx.stack[j]!;
      const ak = anc["kind"];
      const read = (ak === "recordGet" && key === "obj" && !anc["spreadCopy"]) || (ak === "recordKeyGet" && key === "obj") || (ak === "fieldGet" && key === "obj") || (ak === "arrayGet" && key === "arr");
      if (!read) break;
      part = anc["type"] as IrType;
      j--;
      if (j >= 0) j = forwardFrom(cx, j);
      if (j < 0) break;
    }
    if (part !== null && isComposite(part)) b.parts.push({ t: part, use: j >= 0 ? useOf(cx, cx.stack[j]![0], cx.stack[j]![1]) : "other" });
    // A loop over an array, a callback loop, or a method building a new
    // array from it hands its ELEMENTS on: they are parts used anyhow.
    if (j >= 0) {
      for (const x of exposedParts(cx, part ?? (r["type"] as IrType), cx.stack[j]![0], cx.stack[j]![1])) {
        b.parts.push(x.via !== undefined ? { t: x.t, use: "other", via: x.via } : { t: x.t, use: "other" });
      }
    }
  }
  if (k === "varRef" && parent && isDynType(t)) {
    const key = bkey(cx, cx.curFn, r["localId"] as string);
    let u = cx.dynUses.get(key);
    if (!u) cx.dynUses.set(key, (u = []));
    u.push(dynUseAt(cx, cx.stack.length - 1, false, r));
    let o = cx.ownUses.get(key);
    if (!o) cx.ownUses.set(key, (o = []));
    o.push(ownUseAt(cx, cx.stack.length - 1, r));
    let ut = cx.useTops.get(key);
    if (!ut) cx.useTops.set(key, (ut = []));
    ut.push({ fn: cx.curFn, top: cx.curTop });
  }
  if (k === "varRef" && parent && t !== undefined && !isDynType(t) && hasRef(cx, t)) {
    const key = bkey(cx, cx.curFn, r["localId"] as string);
    let o = cx.typedOwnUses.get(key);
    if (!o) cx.typedOwnUses.set(key, (o = []));
    o.push(typedOwnUseAt(cx, cx.stack.length - 1, t));
  }
  if (k === "closure") {
    cx.closureCaptures.push({
      fnName: r["fnName"] as string, fn: cx.curFn, captures: (r["captures"] as string[] | undefined) ?? [],
      // (A typed array loop, or a dynamic one: `xs.forEach(cb)` on a
      // dynamic array boxes `cb` and the runtime runs it the same way.)
      transient: parent !== null && ((parent["kind"] === "call" && pkey === "args" && HOF_HELPER.test(parent["callee"] as string)) ||
        (parent["kind"] === "dynFrom" && cx.stack.length >= 2 && cx.stack[cx.stack.length - 2]![0]["kind"] === "dynInvoke" && cx.stack[cx.stack.length - 2]![1] === "args" &&
          /^(forEach|map|filter|some|every|find|findIndex)$/.test(cx.stack[cx.stack.length - 2]![0]["method"] as string))),
    });
  }
  noteDynNode(cx, r, parent, pkey);
  let kids: readonly string[] = Object.hasOwn(TRANSPARENT, k) ? TRANSPARENT[k]! : [];
  let rest: Mode = PRINT_KINDS.has(k) || KEYS_KINDS.has(k) ? "r" : "w";
  switch (k) {
    case "varDecl":
      if (r["init"]) binding(cx, bkey(cx, cx.curFn, r["localId"] as string)).assigns.push(r["init"] as IrExpr);
      break;
    case "assign":
    case "assignExpr":
      binding(cx, bkey(cx, cx.curFn, r["localId"] as string)).assigns.push(r["value"] as IrExpr);
      break;
    case "incDec":
      binding(cx, bkey(cx, cx.curFn, r["localId"] as string)).assigns.push(r as unknown as IrExpr);
      break;
    case "closure":
      for (const c of (r["captures"] as string[] | undefined) ?? []) binding(cx, bkey(cx, cx.curFn, c)).captured = true;
      break;
    case "call": {
      const callee = r["callee"] as string;
      const args = r["args"] as IrExpr[];
      if (isCopyHelper(callee)) cx.sites.push({ callee, arg: args[0], loc: r["loc"] as SrcLoc, where: cx.curFn, top: cx.curTop, dest: destOf(cx, parent, pkey, r) });
      if (ARG_MUTATOR.test(callee) && args[0]) {
        noteWrite(cx, tkey(args[0].type));
        kids = ["args"];
      } else if (transparentCallee(cx, callee)) kids = ["args"];
      else if (ORDER_HELPER.test(callee)) kids = ["args"]; // bookkeeping: lets nothing go, observes nothing
      else if (PRINT_HELPER.test(callee) || KEYS_HELPER.test(callee)) rest = "r";
      break;
    }
    case "recordGet":
      // A spread's field read lists the source's keys: a key observer.
      if (!r["spreadCopy"]) kids = ["obj"];
      else rest = "r";
      break;
    case "mapNew":
    case "setNew": {
      // A seed array of scalars is only read (its elements are copied in).
      const seed = k === "setNew" ? (r["seed"] as IrExpr | undefined) : undefined;
      if (seed !== undefined && seed.type.kind === "array" && !isComposite(seed.type.elem)) rest = "r";
      const ct = r["type"] as IrType;
      const kt = ct.kind === "map" ? ct.key : ct.kind === "set" ? ct.elem : undefined;
      if (kt !== undefined && isComposite(kt)) {
        cx.identity.add(tkey(kt));
        if (kt.kind === "union") for (const a of cx.L.unions.get(kt.unionId)?.arms ?? []) cx.identity.add(tkey(a));
      }
      break;
    }
    case "mapIntrinsic":
    case "setIntrinsic": {
      // A Map's values and a Set's elements are stored and handed back
      // as they are; set/add/delete/clear write the container itself.
      const m = r["method"] as string;
      if ((m === "set" || m === "add" || m === "delete" || m === "clear") && !cx.building) noteWrite(cx, tkey((r["receiver"] as IrExpr).type));
      // Object keys (docs/design/object-keys.md): a composite key is
      // compared by identity — a copy would be a different key.
      const ct = (r["receiver"] as IrExpr).type;
      const kt = ct.kind === "map" ? ct.key : ct.kind === "set" ? ct.elem : undefined;
      if (kt !== undefined && isComposite(kt)) {
        cx.identity.add(tkey(kt));
        if (kt.kind === "union") for (const a of cx.L.unions.get(kt.unionId)?.arms ?? []) cx.identity.add(tkey(a));
      }
      kids = ["receiver", "args"];
      break;
    }
    case "bytesNew":
      // Typed-array construction reads the source array's numbers.
      rest = "r";
      break;
    case "libCall":
      // The data-in, data-out library families read their arguments
      // (`path.join(...)` over a string array, say); they never write one.
      if (/^(math|num|number|string|str|insp|json|path|sym|os|text|strdec)\./.test(r["fn"] as string)) rest = "r";
      break;
    case "recordSet":
      if (!cx.building) noteWrite(cx, `record:${r["shapeId"] as string}:${r["field"] as string}`);
      break;
    case "recordKeySet":
    case "recordKeyDelete":
      if (!cx.building) noteWrite(cx, `record:${r["shapeId"] as string}:*`);
      break;
    case "recordOrderSet":
      // GH #132: an order note never writes alone — every one rides a
      // field write (noted above) or builds a fresh literal's record.
      kids = ["obj", "value"];
      break;
    case "recordOrder":
      // GH #132: reading the order slot reads nothing of the record's
      // fields and lets nothing go.
      kids = ["obj"];
      break;
    case "fieldSet":
    case "fieldIncDec":
    {
      // Construction is a constructor writing its OWN instance; a
      // constructor writing another object is an ordinary write.
      const key = `object:${rootOf(cx, r["className"] as string)}:${r["field"] as string}`;
      const obj = r["obj"] as IrExpr;
      if (cx.curThis !== null && obj.kind === "varRef" && obj.localId === cx.curThis) cx.ctorWritten.add(key);
      else noteWrite(cx, key);
    }
      break;
    case "arraySet":
      noteWrite(cx, tkey((r["arr"] as IrExpr).type));
      break;
    // A folded tuple `t.length` reads its tuple's arity (tuple-length.ts):
    // a read in place, like an array's `xs.length`.
    case "numLit":
      kids = ["tupleOf"];
      break;
    case "arrIntrinsic": {
      const m = r["method"] as string;
      const recv = r["receiver"] as IrExpr;
      if (MUTATING_ARR.has(m) && !cx.building) noteWrite(cx, tkey(recv.type));
      if ((m === "indexOf" || m === "includes") && recv.type.kind === "array") cx.identity.add(tkey(recv.type.elem));
      if (READING_ARR.has(m)) kids = m === "push" || m === "with" ? ["receiver", "args"] : ["receiver"];
      else if (m === "indexOf" || m === "includes") kids = ["receiver", "args"];
      break;
    }
    case "bin": {
      const op = r["op"] as string;
      if (op === "===" || op === "!==" || op === "==" || op === "!=") {
        const l = r["left"] as IrExpr;
        const rt = r["right"] as IrExpr;
        const unit = (e: IrExpr): boolean =>
          e.type.kind === "undefinedT" || e.type.kind === "nullT" || e.kind === "unitLit";
        if (!unit(l) && !unit(rt)) {
          for (const side of [l, rt]) {
            if (!isComposite(side.type)) continue;
            cx.identity.add(tkey(side.type));
            if (side.type.kind === "union") for (const a of cx.L.unions.get(side.type.unionId)?.arms ?? []) cx.identity.add(tkey(a));
          }
        }
        kids = ["left", "right"];
      }
      break;
    }
    default:
      break;
  }
  for (const key of Object.keys(r)) {
    if (key === "type" || key === "loc") continue;
    cx.stack.push([r, key]);
    visit(cx, r[key], kids.includes(key) ? "t" : rest, r, key);
    cx.stack.pop();
  }
}

/** Dynamic crossings and dynamic writes at node `r` (S125 (c)). */
/** GH #148 (review): a typed exit (jsExit, dynCheck) of an island spread
 * literal — directly or through a `?:`/`&&`/`||` arm — into a closed
 * record type, or a union with one, that may lack some of its keys. */
function noteSpreadExit(cx: WidthCx, r: Record<string, unknown>, parent: Record<string, unknown> | null, pkey: string, loc: SrcLoc): void {
  const spreads = spreadsIn(r["value"]);
  if (spreads.length === 0) return;
  const t = r["type"] as IrType;
  const arms = closedRecordArms(cx.L, t);
  if (arms.length === 0) return;
  const extra = arms.some((a) => {
    const fields = new Set(a.shape.fields.map((f) => f.name));
    return spreads.some((s) => spreadMayCarryExtra(cx.L, s, fields));
  });
  if (extra) cx.spreadExits.push({ t, arms: arms.map((a) => a.t), loc, dest: destOf(cx, parent, pkey, r) });
}

function noteDynNode(cx: WidthCx, r: Record<string, unknown>, parent: Record<string, unknown> | null, pkey: string): void {
  const loc = r["loc"] as SrcLoc;
  // A variadic callback's adapter (restFuncAdapter) calls the boxed
  // function with its arguments crossed, and checks its result back:
  // copies GH #22 already vets (the callback may only read the count and
  // the scalar positions; any other use refuses by name).
  if (/^%fn\.adapt\.\d+\.impl$/.test(cx.curFn) && (isAdapterCall(cx, r) || (parent !== null && pkey === "args" && isAdapterCall(cx, parent)))) return;
  switch (r["kind"]) {
    case "jsExit":
      noteSpreadExit(cx, r, parent, pkey, loc);
      return;
    case "call": {
      const callee = r["callee"] as string;
      const a0 = (r["args"] as IrExpr[])[0];
      if (/^%fn\.adapt\.\d+$/.test(callee) && a0) {
        let at = cx.adapterArgs.get(callee);
        if (!at) cx.adapterArgs.set(callee, (at = []));
        at.push({ e: a0, fn: cx.curFn });
      }
      return;
    }
    case "dynFrom": {
      const v = r["value"] as IrExpr;
      const { refs, fns } = refsOf(cx, v.type);
      if (refs.length === 0 && fns.length === 0) return;
      cx.dynSites.push({
        dir: "in", callee: "%dyn.from", arg: v, t: v.type, loc, where: cx.curFn, top: cx.curTop, node: r as unknown as IrExpr,
        dest: destOf(cx, parent, pkey, r),
        // A source of Object.assign hands on only its own property values.
        consumed: (cx.stack.length > 0 && dynUseAt(cx, cx.stack.length - 1, true, r) === "ro") ||
          (parent !== null && parent["kind"] === "libCall" && pkey === "args" && /^dyn\.assign(All)?$/.test(parent["fn"] as string) &&
            (parent["args"] as unknown[]).indexOf(r) > 0 && refsOf(cx, v.type).refs.every((x) => tkey(x) === tkey(v.type))),
        atReturn: cx.stack.length > 0 && atReturn(cx, cx.stack.length - 1),
      });
      return;
    }
    case "dynCheck": {
      noteSpreadExit(cx, r, parent, pkey, loc);
      const t = r["type"] as IrType;
      const { refs, fns } = refsOf(cx, t);
      if (refs.length === 0 && fns.length === 0) return;
      cx.dynSites.push({
        dir: "out", callee: "%dyn.check", arg: r["value"] as IrExpr, t, loc, where: cx.curFn, top: cx.curTop, node: r as unknown as IrExpr,
        dest: destOf(cx, parent, pkey, r), consumed: consumedAt(cx, cx.stack.length - 1, t), atReturn: atReturn(cx, cx.stack.length - 1),
        observedAt: cx.stack.length > 0 && ((): boolean => {
          const [anc, key] = cx.stack[forwardFrom(cx, cx.stack.length - 1)]!;
          const u = useOf(cx, anc, key);
          return u === "print" || u === "keys";
        })(),
        scope: parent?.["kind"] === "varDecl" && pkey === "init" && cx.stack.length >= 2 && cx.stack[cx.stack.length - 2]![0]["kind"] === "seqExpr" &&
          cx.stack[cx.stack.length - 2]![1] === "stmts" ? cx.stack[cx.stack.length - 2]![0] : undefined,
        holder: holderAt(cx, cx.stack.length - 1),
      });
      return;
    }
    case "libCall": {
      const fn = r["fn"] as string;
      const args = r["args"] as IrExpr[];
      if (DYN_WRITER.test(fn)) {
        // A keyed store with a literal key names the one member it writes.
        const k = fn === "dyn.keySet" && args[1]?.kind === "strLit" ? args[1].value : undefined;
        noteDynWrite(cx, args[0] ?? null, undefined, k);
      }
      return;
    }
    case "dynInvoke": {
      const m = r["method"] as string;
      if (DYN_MUTATING.has(m)) noteDynWrite(cx, r["recv"] as IrExpr, m);
      if (DYN_IDENTITY.has(m)) {
        cx.dynIdentity = true;
        cx.dynIdentityOps.push({ e: r["recv"] as IrExpr, fn: cx.curFn });
        for (const a of r["args"] as IrExpr[]) if (isDynType(a.type)) cx.dynIdentityOps.push({ e: a, fn: cx.curFn });
      }
      if (cx.opaqueCalls && (r["args"] as IrExpr[]).some((a) => passesDyn(cx, a))) noteDynWrite(cx, null);
      return;
    }
    case "dynCall":
      // An element call (GH #133, `recvThis`) hands its receiver on too.
      if (cx.opaqueCalls && ((r["args"] as IrExpr[]).some((a) => passesDyn(cx, a)) || r["recvThis"] === true)) noteDynWrite(cx, null);
      return;
    case "dynScalarEq":
      if (isDynType((r["left"] as IrExpr).type) && isDynType((r["right"] as IrExpr).type)) {
        cx.dynIdentity = true;
        cx.dynIdentityOps.push({ e: r["left"] as IrExpr, fn: cx.curFn }, { e: r["right"] as IrExpr, fn: cx.curFn });
      }
      return;
    case "mapIntrinsic":
    case "setIntrinsic": {
      const rt = (r["receiver"] as IrExpr).type;
      if ((rt.kind === "map" && isDynType(rt.key)) || (rt.kind === "set" && isDynType(rt.elem))) {
        cx.dynIdentity = true;
        cx.dynIdentityOps.push(null);
      }
      return;
    }
    case "jsOp": {
      const op = r["op"] as string;
      const args = r["args"] as IrExpr[];
      // A property write or a method call writes (or may write) its
      // receiver; a call writes what it is handed (the callee itself
      // and marshaled scalars hand nothing).
      // On the one-world lanes (sharedDynamic) no engine code runs: a
      // method reached through dynamic dispatch is the runtime's (which
      // writes only its receiver and, for the assign-like statics, the
      // values it is handed) or a boxed program function (whose writes
      // are noted where they are), so the write is pinned to the
      // receiver and to each dynamic value handed on.
      if (cx.L.sharedDynamic && !cx.opaqueCalls && (op === "setProp" || op === "setIdx" || op === "callMethod" || op === "optCallMethod" || op === "defineGetter")) {
        const g0 = args[0]?.kind === "jsOp" && args[0].op === "globalGet" ? args[0].name : undefined;
        const readOnly = (op === "callMethod" || op === "optCallMethod") &&
          (JS_READING_METHODS.has(r["name"] as string) || (g0 !== undefined && staticReadsArgs(g0, r["name"] as string)) || (g0 === "Object" && r["name"] === "assign"));
        if (!readOnly) {
          noteDynWrite(cx, 
            args[0] ?? null,
            op === "callMethod" || op === "optCallMethod" ? (r["name"] as string) : undefined,
            op === "setProp" && typeof r["name"] === "string" ? (r["name"] as string) : undefined,
          );
        }
        // A method may write what it is handed (Object.assign's sources
        // are read, its target written — the receiver there is the
        // Object global); a store only stores.
        if (op === "callMethod" || op === "optCallMethod") {
          const g = args[0]?.kind === "jsOp" && args[0].op === "globalGet" ? args[0].name : undefined;
          const m = r["name"] as string;
          if (g === "Object" && m === "assign") noteDynWrite(cx, args[1] ?? null);
          // A reading method reads what it is handed too: a callback it
          // runs is a program function whose own writes are noted where
          // they are (a receiver whose own member of that name is a
          // program function is the same case).
          else if (!readOnly && !(g !== undefined && staticReadsArgs(g, m))) {
            for (const a of args.slice(1)) if (isDynType(a.type) && passesJs(cx, a)) noteDynWrite(cx, a);
          }
        }
      } else if (cx.L.sharedDynamic && !cx.opaqueCalls && JS_WRITING_OPS.has(op)) {
        // The lowering's own destructuring helpers only read their source.
        if (!(op === "callFn" && args[0] !== undefined && isPatternHelper(args[0]))) {
          for (const a of args.slice(1)) if (isDynType(a.type) && passesJs(cx, a)) noteDynWrite(cx, a);
        }
      } else if (op === "setProp" || op === "setIdx" || op === "callMethod" || op === "optCallMethod" || op === "defineGetter") noteDynWrite(cx, null);
      else if (JS_WRITING_OPS.has(op) && (args.slice(1).some((a) => passesJs(cx, a)) || r["recvThis"] === true)) noteDynWrite(cx, null);
      if (op === "eq" || op === "neq") {
        cx.dynIdentity = true;
        cx.dynIdentityOps.push(null);
        // An operand that is a typed composite's view (or marshal) is an
        // identity test on that type: a copy of it compares unequal where
        // JavaScript's one object compares equal (U1a).
        for (const a of args) {
          const viewed = a.kind === "call" && /^%view\.\d+$/.test(a.callee) ? a.args[0] : a.kind === "jsMarshal" ? a.value : undefined;
          if (viewed !== undefined && isComposite(viewed.type)) {
            cx.identity.add(tkey(viewed.type));
            if (viewed.type.kind === "union") for (const arm of cx.L.unions.get(viewed.type.unionId)?.arms ?? []) cx.identity.add(tkey(arm));
          }
        }
      }
      return;
    }
    case "jsMarshal":
      // A checked-dynamic value marshaled into the island is the same
      // value there (S014's jsMarshal amendment): island code may write it.
      // On the one-world lanes there is no engine: the marshal is the
      // same value under the island type, written where island ops write.
      if (isDynType((r["value"] as IrExpr).type) && !(cx.L.sharedDynamic && !cx.opaqueCalls)) noteDynWrite(cx, null);
      return;
    default:
      return;
  }
}

/** restFuncAdapter's call: `dynCall(dynFrom(f), args...)` over its
 * captured function `f.0` — or the out-crossing of that call's result. */
function isAdapterCall(cx: WidthCx, n: Record<string, unknown>): boolean {
  const c = (n["kind"] === "dynCheck" ? n["value"] : n) as Record<string, unknown>;
  if (c["kind"] !== "dynCall") return false;
  const callee = c["callee"] as IrExpr;
  return callee.kind === "dynFrom" && callee.value.kind === "varRef" && callee.value.localId === "f.0";
}

/** An island argument that hands a VALUE to the callee — not a
 * marshaled scalar. */
function passesJs(cx: WidthCx, a: IrExpr): boolean {
  if (!isDynType(a.type)) return hasRef(cx, a.type);
  if (a.kind === "jsMarshal") return isDynType(a.value.type) || hasRef(cx, a.value.type) || a.value.type.kind === "func";
  return a.kind !== "strLit" && a.kind !== "numLit";
}

/** A dynamic argument that hands a dynamic VALUE to the callee — not a
 * boxed scalar or a boxed function. */
export function passesDyn(cx: WidthCx, a: IrExpr): boolean {
  if (!isDynType(a.type)) return false;
  if (a.kind === "dynFrom") return hasRef(cx, a.value.type);
  return true;
}

/** The binding a copy lands in: a local or global it initializes or is
 * assigned to, or the parameter of a directly called program function
 * it is passed as. */
function destOf(cx: WidthCx, parent: Record<string, unknown> | null, pkey: string, call: Record<string, unknown>): Site["dest"] {
  if (!parent) return null;
  const pk = parent["kind"];
  if ((pk === "varDecl" && pkey === "init") || (pk === "assign" && pkey === "value")) {
    return { key: bkey(cx, cx.curFn, parent["localId"] as string), param: false };
  }
  if (pk === "call" && pkey === "args") {
    const callee = parent["callee"] as string;
    if (isCopyHelper(callee) || PASS_THROUGH.test(callee) || !transparentCallee(cx, callee)) return null;
    const f = cx.byName.get(callee);
    const i = (parent["args"] as unknown[]).indexOf(call);
    const p = f?.params[i];
    return p ? { key: `${callee}\0${p.localId}`, param: true } : null;
  }
  return null;
}

/** Walks every function body (the copy helpers and pass-through checks
 * aside), recording the copy sites, the writes, the identity tests, the
 * escapes and each binding's uses that the judgements read. */
export function collectUses(cx: WidthCx): void {
  for (const f of cx.functions) {
    if (isCopyHelper(f.name) || PASS_THROUGH.test(f.name)) continue;
    cx.curFn = f.name;
    cx.curThis = f.name.endsWith(".constructor") ? (f.params[0]?.localId ?? null) : null;
    cx.building = BUILDER.test(f.name) || ARG_MUTATOR.test(f.name);
    f.body.forEach((st, i) => {
      cx.curTop = i;
      visit(cx, st, "t", null, "");
    });
  }
}
