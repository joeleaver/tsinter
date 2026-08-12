/* The resumable-function lowering (backend/wasm/statemachine.ts) as a pure
 * IR→IR transform: hand-built async modules in, state machines out. The
 * assertions are STRUCTURAL — the shape of the wrapper, the resume
 * skeleton, the frame's fields, and the closure of the state graph — not
 * byte-exact IR, so the pass keeps room to pick different state numbers.
 * The other half of the contract is the refusal set: every async shape the
 * pass declines must name itself and leave the function untouched, which
 * is what keeps the emitter's own `fn:async` firing behind it. */
import { beforeAll, describe, expect, test } from "vitest";
import type { IrExpr, IrFunction, IrModule, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../src/ir/nodes.js";
import { BOOL, CAUGHT, DYN, F64, STRING, UNDEFINED_T, VOID } from "../src/ir/nodes.js";
import {
  asIrModule,
  FunctionLowering,
  lowerResumableFunctions,
  type WFunction,
  type WModule,
} from "../src/backend/wasm/statemachine.js";
import { computeMayThrow } from "../src/backend/emission/may-throw.js";
import { emitWasmModule, surveyWasmModule } from "../src/backend/wasm/emitter.js";
import { genResultRecord, ShapeRegistry, UnionRegistry } from "../src/frontend/types.js";
import {
  assign,
  asyncModule,
  await_,
  bool,
  call,
  closureOver,
  exprStmt,
  hop,
  loc,
  local,
  log,
  moduleAwait,
  num,
  promiseGlobal,
  promiseOf,
  ret,
  runtimeErrorClasses,
  str,
  twoAwaits,
  v,
  varDecl,
} from "./fixtures/async-ir.js";

/* ── helpers ───────────────────────────────────────────────────────────── */

function lower(mod: IrModule): { mod: WModule; refusals: string[] } {
  const refusals: string[] = [];
  return { mod: lowerResumableFunctions(mod, (kind) => refusals.push(kind)), refusals };
}

function fnNamed(mod: WModule, name: string): WFunction {
  const fn = mod.functions.find((f) => f.name === name);
  if (fn === undefined) throw new Error(`no function "${name}"`);
  return fn;
}

/** Every node of a kind, anywhere in a JSON tree. */
function nodesOfKind(root: unknown, kind: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec["kind"] === kind) out.push(rec);
    for (const key of Object.keys(rec)) {
      if (key !== "loc" && key !== "type") walk(rec[key]);
    }
  };
  walk(root);
  return out;
}

/** The `while (true) tryCatch { switch (frame.%state) }` skeleton,
 * unpacked — past the one-statement cast prologue every resume opens with
 * (its parameter is the SHARED frame base; see frameCastPrologue below).
 * The tryCatch is INSIDE the loop so a caught exception can hand control
 * back to the dispatch rather than end it. */
function guard(resume: WFunction): Extract<IrStmt, { kind: "tryCatch" }> {
  expect(resume.body).toHaveLength(2);
  const loop = resume.body[1]!;
  expect(loop.kind).toBe("while");
  if (loop.kind !== "while") throw new Error("unreachable");
  expect(loop.labels).toEqual(["%dispatch"]);
  expect(loop.body).toHaveLength(1);
  const tc = loop.body[0]!;
  expect(tc.kind).toBe("tryCatch");
  if (tc.kind !== "tryCatch") throw new Error("unreachable");
  expect(tc.finallyBody).toBeNull();
  expect(tc.catchLocalId).toBe("%async.exc");
  return tc;
}

function dispatch(resume: WFunction): { test: number | null; body: IrStmt[] }[] {
  const sw = guard(resume).tryBody[0]!;
  expect(sw.kind).toBe("switch");
  if (sw.kind !== "switch") throw new Error("unreachable");
  return sw.cases.map((c) => ({
    test: c.test === null ? null : (c.test as { value: number }).value,
    body: c.body,
  }));
}

/** The catch arm's routing table: state number → the statements that run
 * when an exception reaches resume in that state. `null` is the default
 * (no region covers the state). Cases with EMPTY bodies fall through to
 * the next one, which is how states sharing a handler share a body. */
function routing(resume: WFunction): { test: number | null; body: IrStmt[] }[] {
  const arm = guard(resume).catchBody!;
  if (arm[0]?.kind !== "switch") return [{ test: null, body: arm }];
  expect(arm).toHaveLength(1);
  const cases = arm[0].cases;
  return cases.map((c, i) => {
    let body = c.body;
    // Fallthrough: an empty case runs the next non-empty one's body.
    for (let j = i; j < cases.length && body.length === 0; j++) body = cases[j]!.body;
    return { test: c.test === null ? null : (c.test as { value: number }).value, body };
  });
}

/** Where an exception raised in `state` lands: the handler state number
 * the routing table points %state at, or null when it rejects instead. */
function handlerOf(resume: WFunction, state: number): number | null {
  const arm = routing(resume).find((c) => c.test === state) ?? routing(resume).find((c) => c.test === null)!;
  const set = arm.body.find((s) => s.kind === "recordSet" && s.field === "%state");
  if (set === undefined) return null;
  return ((set as Extract<IrStmt, { kind: "recordSet" }>).value as { value: number }).value;
}

/** True for one statement of the restore prologue every state opens with. */
function isRestore(s: IrStmt | undefined): boolean {
  return s !== undefined && s.kind === "assign" && s.value.kind === "recordGet";
}

/** A state's body with its restore prologue dropped — every state opens
 * with one, state 0 included (the wrapper passes arguments through the
 * frame), so tests about the BODY start here. */
function afterRestores(body: IrStmt[]): IrStmt[] {
  let i = 0;
  while (isRestore(body[i])) i++;
  return body.slice(i);
}

/** State numbers written into `%state`, anywhere in the function. */
function stateWrites(fn: WFunction): number[] {
  return nodesOfKind(fn.body, "recordSet")
    .filter((r) => r["field"] === "%state")
    .map((r) => ((r["value"] as { value: number }).value));
}

function frameFields(mod: WModule, fnName: string): string[] {
  const shape = (mod.records ?? []).find((r) => r.id === `%frame.${fnName}`);
  if (shape === undefined) throw new Error(`no frame shape for ${fnName}`);
  return shape.fields.map((f) => f.name);
}

/** A one-async-function module whose lowering is expected to succeed. */
function lowerOne(fn: IrFunction, extra: IrFunction[] = []): WModule {
  const { mod, refusals } = lower(asyncModule(fn, extra));
  expect(refusals).toEqual([]);
  return mod;
}

/** A one-async-function module whose lowering is expected to refuse. */
function expectRefusal(fn: IrFunction, kind: string, patch: (m: IrModule) => IrModule = (m) => m): void {
  const input = patch(asyncModule(fn));
  const before = JSON.stringify(input);
  const { mod, refusals } = lower(input);
  expect(refusals).toEqual([kind]);
  // Declined ⇒ untouched: the function still says `async`, its body is the
  // one that came in, and no resume/frame was appended.
  const kept = fnNamed(mod, fn.name);
  expect(kept.async).toBe(true);
  expect(kept.body).toEqual(fn.body);
  expect(mod.functions.some((f) => f.name === `%${fn.name}.resume`)).toBe(false);
  expect((mod.records ?? []).some((r) => r.id === `%frame.${fn.name}`)).toBe(false);
  expect(JSON.stringify(input)).toBe(before); // the pass never mutates its input
}

/* ── 1. two sequential awaits ──────────────────────────────────────────── */

describe("two sequential awaits", () => {
  const mod = lowerOne(twoAwaits());
  const wrapper = fnNamed(mod, "f");
  const resume = fnNamed(mod, "%f.resume");

  test("the wrapper becomes a spawn stub returning promise<T>", () => {
    expect(wrapper.async).toBeUndefined();
    expect(wrapper.returnType).toEqual(promiseOf(F64));
    expect(wrapper.body.map((s) => s.kind)).toEqual(["varDecl", "exprStmt", "return"]);

    const decl = wrapper.body[0]!;
    if (decl.kind !== "varDecl") throw new Error("unreachable");
    expect(decl.localId).toBe("%async.frame");
    expect(decl.init!.kind).toBe("recordLit");
    // The frame literal mints the promise; %state rides struct defaults.
    expect(nodesOfKind(decl.init, "%async.mint")).toHaveLength(1);

    // JS runs an async body eagerly to its first await.
    const kick = wrapper.body[1]!;
    if (kick.kind !== "exprStmt") throw new Error("unreachable");
    expect(kick.expr.kind).toBe("call");
    expect((kick.expr as { callee: string }).callee).toBe("%f.resume");

    const answer = wrapper.body[2]!;
    if (answer.kind !== "return") throw new Error("unreachable");
    expect(answer.value).toMatchObject({ kind: "recordGet", field: "%promise" });
  });

  test("resume takes the SHARED base frame and casts it down once", () => {
    // Every resume has the one signature (base) → void — the only way a
    // waiter queue can hold frames from different async functions — and
    // recovers its own shape in a single prologue statement.
    expect(resume.params.map((p) => p.localId)).toEqual(["%async.frameAny"]);
    expect(resume.params[0]!.type).toEqual({ kind: "%frameBase" });
    const prologue = resume.body[0]!;
    expect(prologue.kind).toBe("varDecl");
    if (prologue.kind !== "varDecl") throw new Error("unreachable");
    expect(prologue.localId).toBe("%async.frame");
    expect(prologue.init).toMatchObject({
      kind: "%async.frameCast",
      type: { kind: "record", shapeId: "%frame.f" },
      value: { kind: "varRef", localId: "%async.frameAny" },
    });
    // Nothing else in the body mentions the base-typed parameter: the
    // state machine is concretely typed from the cast onward.
    expect(nodesOfKind(resume.body[1], "varRef").filter((r) => r["localId"] === "%async.frameAny")).toHaveLength(0);
  });

  test("resume is a void tryCatch/while/switch over three states", () => {
    expect(resume.async).toBeUndefined();
    expect(resume.returnType).toEqual(VOID);
    const cases = dispatch(resume);
    // states 0, 1, 2 plus the defensive default.
    expect(cases.map((c) => c.test)).toEqual([0, 1, 2, null]);
    expect(resume.locals.some((l) => l.id === "%async.exc" && l.type.kind === "caught")).toBe(true);
  });

  test("with no protected region the catch arm is the reject default alone", () => {
    // Nothing to route: the arm skips the routing switch entirely.
    expect(guard(resume).catchBody!.map((s) => s.kind)).toEqual(["%async.reject", "return"]);
    expect(handlerOf(resume, 0)).toBeNull();
  });

  test("the frame carries state, promise, every local and one slot per await", () => {
    expect(frameFields(mod, "f")).toEqual(["%state", "%promise", "%l_a.0", "%await1", "%await2"]);
    const shape = (mod.records ?? []).find((r) => r.id === "%frame.f")!;
    expect(shape.fields.find((f) => f.name === "%promise")!.type).toEqual(promiseOf(F64));
    // The await slot holds what was AWAITED (the promise), not the result:
    // the re-entry reads rejection and value out of it.
    expect(shape.fields.find((f) => f.name === "%await1")!.type).toEqual(promiseOf(F64));
    expect(shape.fields.find((f) => f.name === "%l_a.0")!.type).toEqual(F64);
  });

  test("every await is gone, replaced by subscribe/settled/settle", () => {
    expect(nodesOfKind(mod, "awaitExpr")).toHaveLength(0);
    expect(nodesOfKind(resume.body, "%async.subscribe")).toHaveLength(2);
    // The discarded `await mkp()` needs no settled read; the bound one does.
    expect(nodesOfKind(resume.body, "%async.settled")).toHaveLength(1);
    expect(nodesOfKind(resume.body, "%async.rejectCheck")).toHaveLength(2);
    expect(nodesOfKind(resume.body, "%async.settle")).toHaveLength(1);
  });

  test("each state saves before suspending and restores on re-entry", () => {
    const cases = dispatch(resume);
    const state = (n: number) => cases.find((c) => c.test === n)!.body;
    for (const n of [0, 1]) {
      const kinds = state(n).map((s) => s.kind);
      const save = kinds.indexOf("recordSet");
      const suspend = kinds.indexOf("%async.subscribe");
      expect(save).toBeGreaterThanOrEqual(0);
      expect(suspend).toBeGreaterThan(save);
      expect(kinds[kinds.length - 1]).toBe("return");
      // The local's save, the state write and the awaited promise all go
      // into the frame before the suspend.
      const fields = state(n)
        .slice(0, suspend)
        .filter((s) => s.kind === "recordSet")
        .map((s) => (s as Extract<IrStmt, { kind: "recordSet" }>).field);
      expect(fields).toContain("%l_a.0");
      expect(fields).toContain("%state");
    }
    for (const n of [1, 2]) {
      const first = state(n)[0]!;
      expect(first.kind).toBe("assign");
      expect((first as Extract<IrStmt, { kind: "assign" }>).localId).toBe("a.0");
    }
  });

  test("state 2 checks the discarded await's rejection, then settles", () => {
    const last = dispatch(resume).find((c) => c.test === 2)!.body;
    // The second await's VALUE is dropped, but a rejection still has to
    // re-throw — so the check survives where the settled read does not.
    expect(last.map((s) => s.kind)).toEqual(["assign", "%async.rejectCheck", "%async.settle", "return"]);
  });
});

/* ── 1b. state 0 is an entry like any other ────────────────────────────── */

test("state 0 restores the frame before running a line of the body", () => {
  /* async function p(a: number, b: string): Promise<void> {
   *   console.log(a, b);          // reads the params BEFORE any await
   *   await mkp();
   *   console.log(a, b);          // and again after
   * }
   *
   * The wrapper hands the arguments over in the frame's %l_ slots, not
   * through resume's signature — so without the entry restore these reads
   * see uninitialized wasm locals, and the first suspend's save writes
   * those defaults back over the wrapper's copies. */
  const fn: IrFunction = {
    name: "p",
    params: [
      { localId: "a.0", name: "a", type: F64 },
      { localId: "b.0", name: "b", type: STRING },
    ],
    returnType: VOID,
    async: true,
    locals: [local("a.0", F64), local("b.0", STRING), local("c.0", F64)],
    body: [
      log([v("a.0", F64), v("b.0", STRING)]),
      varDecl("c.0", num(1)),
      exprStmt(await_(call("mkp", [], promiseOf(F64)), F64)),
      log([v("a.0", F64), v("b.0", STRING), v("c.0", F64)]),
    ],
    loc,
  };
  const mod = lowerOne(fn);
  const resume = fnNamed(mod, "%p.resume");
  const cases = dispatch(resume);
  const saved = ["a.0", "b.0", "c.0"];

  // Every saved local, params first, restored from its frame slot before
  // anything of the body runs — the same prologue every re-entry gets.
  const head = cases[0]!.body.slice(0, saved.length);
  expect(head.map((s) => s.kind)).toEqual(saved.map(() => "assign"));
  expect(head.map((s) => (s as Extract<IrStmt, { kind: "assign" }>).localId)).toEqual(saved);
  for (const s of head) {
    expect((s as Extract<IrStmt, { kind: "assign" }>).value).toMatchObject({
      kind: "recordGet",
      shapeId: "%frame.p",
    });
  }
  // ...and the body starts only after it.
  expect(cases[0]!.body[saved.length]).toMatchObject({ kind: "exprStmt" });

  // The re-entry state gets the identical prologue.
  expect(cases[1]!.body.slice(0, saved.length)).toEqual(head);

  // The save that precedes the suspend therefore writes the RESTORED
  // values, not defaults.
  const suspend = cases[0]!.body.findIndex((s) => s.kind === "%async.subscribe");
  const savedFields = cases[0]!.body
    .slice(0, suspend)
    .filter((s) => s.kind === "recordSet")
    .map((s) => (s as Extract<IrStmt, { kind: "recordSet" }>).field);
  for (const id of saved) expect(savedFields).toContain(`%l_${id}`);
});

/* ── 2. exploded control flow ──────────────────────────────────────────── */

describe("awaits inside control flow", () => {
  /* async function g(n: number): Promise<void> {
   *   if (n > 0) { await mkp(); }
   *   while (n > 0) { await mkp(); n = n - 1; }
   * } */
  const g: IrFunction = {
    name: "g",
    params: [{ localId: "n.0", name: "n", type: F64 }],
    returnType: VOID,
    async: true,
    locals: [local("n.0", F64)],
    body: [
      {
        kind: "if",
        cond: { kind: "bin", op: ">", left: v("n.0", F64), right: num(0), type: BOOL, loc },
        then: [exprStmt(await_(call("mkp", [], promiseOf(F64)), F64))],
        else_: null,
        loc,
      },
      {
        kind: "while",
        cond: { kind: "bin", op: ">", left: v("n.0", F64), right: num(0), type: BOOL, loc },
        body: [
          exprStmt(await_(call("mkp", [], promiseOf(F64)), F64)),
          assign("n.0", { kind: "bin", op: "-", left: v("n.0", F64), right: num(1), type: F64, loc }),
        ],
        loc,
      },
    ],
    loc,
  };
  const mod = lowerOne(g);
  const resume = fnNamed(mod, "%g.resume");

  test("the state graph is closed: every jump target has a case", () => {
    const cases = dispatch(resume);
    const declared = new Set(cases.filter((c) => c.test !== null).map((c) => c.test!));
    for (const target of stateWrites(resume)) expect(declared).toContain(target);
    // The wrapper never writes %state — state 0 rides struct defaults.
    expect(stateWrites(fnNamed(mod, "g"))).toEqual([]);
  });

  test("transitions are stateSet + continue %dispatch", () => {
    const conts = nodesOfKind(resume.body, "continue");
    expect(conts.length).toBeGreaterThan(0);
    for (const c of conts) expect(c["label"]).toBe("%dispatch");
    // A `continue` is always immediately preceded by its state write, so
    // the dispatch loop can never re-enter the state it just left.
    for (const cases of [dispatch(resume)]) {
      for (const c of cases) {
        c.body.forEach((s, i) => {
          if (s.kind !== "continue") return;
          expect(c.body[i - 1]).toMatchObject({ kind: "recordSet", field: "%state" });
        });
      }
    }
  });

  test("both awaits got their own slot and state", () => {
    expect(frameFields(mod, "g")).toEqual(["%state", "%promise", "%l_n.0", "%await1", "%await2"]);
    expect(nodesOfKind(resume.body, "%async.subscribe")).toHaveLength(2);
    // Every state ends: nothing falls through into the next case.
    for (const c of dispatch(resume)) {
      const last = c.body[c.body.length - 1]!;
      expect(["return", "continue", "runtimeFence", "throw", "rethrow"]).toContain(last.kind);
    }
  });

  test("the loop body's assignment survives, and re-entry restores it", () => {
    const cases = dispatch(resume);
    const withAssign = cases.filter((c) =>
      c.body.some((s) => s.kind === "assign" && s.localId === "n.0" && s.value.kind === "bin"),
    );
    expect(withAssign).toHaveLength(1);
    // n.0 is restored from the frame at the entry state and at both
    // re-entries — the loop counter has to survive each suspension.
    expect(cases.filter((c) => isRestore(c.body[0]))).toHaveLength(3);
  });
});

/* ── 3. return of an awaited value, and the hop form ───────────────────── */

test("`return await p` settles after the reject check and the settled read", () => {
  const fn: IrFunction = {
    name: "h",
    params: [],
    returnType: F64,
    async: true,
    locals: [],
    body: [ret(await_(call("mkp", [], promiseOf(F64)), F64))],
    loc,
  };
  const resume = fnNamed(lowerOne(fn), "%h.resume");
  const cases = dispatch(resume);
  expect(cases.map((c) => c.test)).toEqual([0, 1, null]);
  expect(cases[1]!.body.map((s) => s.kind)).toEqual(["%async.rejectCheck", "%async.settle", "return"]);
  const settle = cases[1]!.body[1]! as unknown as { value: { kind: string } };
  expect(settle.value.kind).toBe("%async.settled");
});

test("`await <non-thenable>` becomes the bare microtask hop", () => {
  const fn: IrFunction = {
    name: "k",
    params: [],
    returnType: VOID,
    async: true,
    locals: [local("x.0", STRING), local("%awaited.0", STRING)],
    body: [varDecl("x.0", hop("%awaited.0", str("hi"))), log([v("x.0", STRING)])],
    loc,
  };
  const mod = lowerOne(fn);
  const resume = fnNamed(mod, "%k.resume");
  // No promise was awaited, so there is no %await slot and no reject check.
  expect(frameFields(mod, "k")).toEqual(["%state", "%promise", "%l_x.0", "%l_%awaited.0"]);
  expect(nodesOfKind(resume.body, "%async.hop")).toHaveLength(1);
  expect(nodesOfKind(resume.body, "%async.rejectCheck")).toHaveLength(0);
  expect(nodesOfKind(resume.body, "libCall")).toHaveLength(0);
  const cases = dispatch(resume);
  // The operand is evaluated BEFORE the suspend, its value rides the
  // hidden local through save/restore, and the consumer reads it after.
  expect(afterRestores(cases[0]!.body)[0]).toMatchObject({ kind: "varDecl", localId: "%awaited.0" });
  expect(cases[1]!.body.some((s) => s.kind === "varDecl" && s.localId === "x.0")).toBe(true);
  // A void body completes by settling with nothing.
  expect(nodesOfKind(resume.body, "%async.settle")).toHaveLength(1);
  expect((nodesOfKind(resume.body, "%async.settle")[0] as { value: unknown })["value"]).toBeNull();
});

test("a return nested in a statement the pass keeps verbatim still settles", () => {
  const fn: IrFunction = {
    name: "m",
    params: [{ localId: "n.0", name: "n", type: F64 }],
    returnType: F64,
    async: true,
    locals: [local("n.0", F64)],
    body: [
      { kind: "if", cond: bool(true), then: [ret(num(1))], else_: [ret(num(2))], loc },
      exprStmt(await_(call("mkp", [], promiseOf(F64)), F64)),
    ],
    loc,
  };
  const resume = fnNamed(lowerOne(fn), "%m.resume");
  // The `if` has no suspension, so it stays one statement — with both of
  // its returns rewritten into settle + return.
  const kept = afterRestores(dispatch(resume)[0]!.body)[0]!;
  expect(kept.kind).toBe("if");
  if (kept.kind !== "if") throw new Error("unreachable");
  expect(kept.then.map((s) => s.kind)).toEqual(["%async.settle", "return"]);
  expect(kept.else_!.map((s) => s.kind)).toEqual(["%async.settle", "return"]);
  expect(nodesOfKind(resume.body, "%async.settle")).toHaveLength(2);
});

/* ── 3b. awaits inside try/catch ───────────────────────────────────────── */

/** `try { <tryBody> } catch (<bind>) { <catchBody> }`. */
function tryCatch(tryBody: IrStmt[], bind: string | null, catchBody: IrStmt[]): IrStmt {
  return { kind: "tryCatch", tryBody, catchBody, catchLocalId: bind, finallyBody: null, loc };
}

const awaited = () => await_(call("mkp", [], promiseOf(F64)), F64);

/** The state whose body prints `text` — the marker each fixture below uses
 * to name a linearized body. Matched on the string LITERAL node, never as
 * a substring of the JSON: "inner" and "caught" are also IrType keys. */
function stateLogging(cases: { test: number | null; body: IrStmt[] }[], text: string): number {
  const hit = cases.filter(
    (c) => c.test !== null && nodesOfKind(c.body, "strLit").some((n) => n["value"] === text),
  );
  expect(hit, `one state prints ${text}`).toHaveLength(1);
  return hit[0]!.test!;
}

/** States that jump to `target` — the incoming edges of a join state.
 * TOP-LEVEL writes only, so a loop head's conditional goto (nested in an
 * `if`) is deliberately not one of them. */
function jumpsTo(cases: { test: number | null; body: IrStmt[] }[], target: number): number[] {
  return cases
    .filter(
      (c) =>
        c.test !== null &&
        c.test !== target &&
        c.body.some(
          (s) => s.kind === "recordSet" && s.field === "%state" && (s.value as { value: number }).value === target,
        ),
    )
    .map((c) => c.test!);
}

describe("awaits inside try/catch", () => {
  /* async function t(): Promise<void> {
   *   try {
   *     const a = await mkp();
   *     console.log(a);
   *     await mkp();
   *   } catch (e) {
   *     console.log('caught');
   *   }
   *   console.log('after');
   * }
   */
  const t: IrFunction = {
    name: "t",
    params: [],
    returnType: VOID,
    async: true,
    locals: [local("a.0", F64), local("e.0", CAUGHT)],
    body: [
      tryCatch(
        [varDecl("a.0", awaited()), log([v("a.0", F64)]), exprStmt(awaited())],
        "e.0",
        [log([str("caught")])],
      ),
      log([str("after")]),
    ],
    loc,
  };
  const mod = lowerOne(t);
  const resume = fnNamed(mod, "%t.resume");
  const cases = dispatch(resume);

  test("both bodies linearize — the try is gone as a statement", () => {
    expect(nodesOfKind(dispatch(resume).map((c) => c.body), "tryCatch")).toHaveLength(0);
    // Two suspensions, so two await slots and two re-entry states.
    expect(frameFields(mod, "t")).toEqual(["%state", "%promise", "%l_a.0", "%l_e.0", "%await1", "%await2"]);
    expect(nodesOfKind(resume.body, "%async.subscribe")).toHaveLength(2);
  });

  test("the state graph is closed and every state ends", () => {
    const declared = new Set(cases.filter((c) => c.test !== null).map((c) => c.test!));
    for (const target of stateWrites(resume)) expect(declared).toContain(target);
    for (const c of cases) {
      expect(["return", "continue", "break"]).toContain(c.body[c.body.length - 1]!.kind);
    }
  });

  test("every try-body state routes to the handler; nothing else does", () => {
    // The handler is the state the catch body linearized into: the one
    // holding its console.log.
    const handler = stateLogging(cases, "caught");
    const protectedStates = cases
      .filter((c) => c.test !== null)
      .map((c) => c.test!)
      .filter((s) => handlerOf(resume, s) !== null);
    expect(protectedStates.length).toBeGreaterThan(0);
    for (const s of protectedStates) expect(handlerOf(resume, s)).toBe(handler);
    // Both re-entry states (the ones that restore and reject-check) are in
    // the region: an awaited rejection inside the try IS what must land.
    const reentries = cases
      .filter((c) => c.test !== null && c.body.some((s) => s.kind === "%async.rejectCheck"))
      .map((c) => c.test!);
    expect(reentries).toHaveLength(2);
    for (const s of reentries) expect(handlerOf(resume, s)).toBe(handler);
    // The handler state itself is NOT protected by its own try (JS), and
    // neither is the entry state or the join the tail runs in.
    expect(handlerOf(resume, handler)).toBeNull();
    expect(handlerOf(resume, 0)).toBeNull();
    expect(handlerOf(resume, stateLogging(cases, "after"))).toBeNull();
  });

  test("the join state is reached from the try tail AND from the catch tail", () => {
    // One from the end of the try body, one from the end of the catch body.
    expect(jumpsTo(cases, stateLogging(cases, "after"))).toHaveLength(2);
  });

  test("the catch arm writes the binding, THEN saves, THEN points at the handler", () => {
    const handler = stateLogging(cases, "caught");
    const arm = routing(resume).find((c) => c.test !== null && handlerOf(resume, c.test) === handler)!.body;
    expect(arm[0]).toMatchObject({
      kind: "assign",
      localId: "e.0",
      value: { kind: "varRef", localId: "%async.exc" },
    });
    const saveAt = arm.findIndex((s) => s.kind === "recordSet" && s.field === "%l_e.0");
    const stateAt = arm.findIndex((s) => s.kind === "recordSet" && s.field === "%state");
    expect(saveAt).toBeGreaterThan(0);
    expect(stateAt).toBeGreaterThan(saveAt);
    // ...and falls out, so the dispatch loop's next turn is the handler.
    expect(arm[arm.length - 1]).toMatchObject({ kind: "break" });
    // The default is still the rejection of this frame's own promise.
    const def = routing(resume).find((c) => c.test === null)!.body;
    expect(def.map((s) => s.kind)).toEqual(["%async.reject", "return"]);
  });

  test("a bindingless `catch {}` writes no binding", () => {
    const fn: IrFunction = {
      ...t,
      name: "tb",
      locals: [local("a.0", F64)],
      body: [tryCatch([exprStmt(awaited())], null, [log([str("c")])])],
    };
    const r = fnNamed(lowerOne(fn), "%tb.resume");
    const arm = routing(r).find((c) => c.test !== null)!.body;
    expect(arm[0]).toMatchObject({ kind: "recordSet" });
    expect(nodesOfKind(arm, "assign")).toHaveLength(0);
  });
});

test("nested trys: the innermost region wins and the outer keeps its own", () => {
  /* try { await mkp(); try { await mkp(); } catch (i) { log('i') } await mkp(); }
   * catch (o) { log('o') } */
  const fn: IrFunction = {
    name: "n",
    params: [],
    returnType: VOID,
    async: true,
    locals: [local("i.0", CAUGHT), local("o.0", CAUGHT)],
    body: [
      tryCatch(
        [
          exprStmt(awaited()),
          tryCatch([exprStmt(awaited())], "i.0", [log([str("inner")])]),
          exprStmt(awaited()),
        ],
        "o.0",
        [log([str("outer")])],
      ),
    ],
    loc,
  };
  const resume = fnNamed(lowerOne(fn), "%n.resume");
  const cases = dispatch(resume);
  const inner = stateLogging(cases, "inner");
  const outer = stateLogging(cases, "outer");
  expect(inner).not.toBe(outer);
  // The three re-entry states, in await order: the first and third are
  // the OUTER try's, the middle one is the inner try's.
  const reentries = cases
    .filter((c) => c.test !== null && c.body.some((s) => s.kind === "%async.rejectCheck"))
    .map((c) => c.test!)
    .sort((a, b) => a - b);
  expect(reentries).toHaveLength(3);
  const handlers = reentries.map((s) => handlerOf(resume, s));
  expect(handlers.filter((h) => h === inner)).toHaveLength(1);
  expect(handlers.filter((h) => h === outer)).toHaveLength(2);
  // Each catch body is protected by what encloses ITS try: the inner
  // catch by the outer try, the outer catch by nothing.
  expect(handlerOf(resume, inner)).toBe(outer);
  expect(handlerOf(resume, outer)).toBeNull();
});

test("an await in a CATCH body is protected by the outer region only", () => {
  /* try { try { await mkp(); } catch (i) { await mkp(); } } catch (o) {} */
  const fn: IrFunction = {
    name: "cb",
    params: [],
    returnType: VOID,
    async: true,
    locals: [local("i.0", CAUGHT), local("o.0", CAUGHT)],
    body: [
      tryCatch(
        [tryCatch([exprStmt(awaited())], "i.0", [exprStmt(awaited()), log([str("recovered")])])],
        "o.0",
        [log([str("outer")])],
      ),
    ],
    loc,
  };
  const resume = fnNamed(lowerOne(fn), "%cb.resume");
  const cases = dispatch(resume);
  const outer = stateLogging(cases, "outer");
  const recovered = stateLogging(cases, "recovered");
  // The suspension inside the catch body resumes into a state the OUTER
  // try covers — the inner catch does not guard itself.
  expect(handlerOf(resume, recovered)).toBe(outer);
});

test("a try with no suspension stays verbatim inside a protected state", () => {
  /* try { await mkp(); try { throw ... } catch (v) { log } } catch (o) {} */
  const inner = tryCatch([{ kind: "throw", value: v("o.0", CAUGHT), loc }], "v.0", [log([str("v")])]);
  const fn: IrFunction = {
    name: "vb",
    params: [],
    returnType: VOID,
    async: true,
    locals: [local("v.0", CAUGHT), local("o.0", CAUGHT)],
    body: [tryCatch([exprStmt(awaited()), inner], "o.0", [log([str("outer")])])],
    loc,
  };
  const resume = fnNamed(lowerOne(fn), "%vb.resume");
  const cases = dispatch(resume);
  // The inner try survives as ONE statement — the emitter's own tryStack
  // nests it inside resume's per-iteration handler, innermost first.
  const kept = nodesOfKind(
    cases.map((c) => c.body),
    "tryCatch",
  );
  expect(kept).toHaveLength(1);
  const host = cases.find((c) => c.body.some((s) => s.kind === "tryCatch"))!.test!;
  const outer = stateLogging(cases, "outer");
  // ...and the state HOSTING it is still the outer region's, so anything
  // its own catch body rethrows routes outward.
  expect(handlerOf(resume, host)).toBe(outer);
});

test("a rethrow in a lowered catch body routes to the enclosing handler", () => {
  /* The `.finally` desugar's shape: try { await mkp() } catch (e) { cb();
   * throw e; } nested inside an outer try. */
  const fn: IrFunction = {
    name: "rt",
    params: [],
    returnType: VOID,
    async: true,
    locals: [local("e.0", CAUGHT), local("o.0", CAUGHT)],
    body: [
      tryCatch(
        [tryCatch([exprStmt(awaited())], "e.0", [log([str("fin")]), { kind: "rethrow", localId: "e.0", loc }])],
        "o.0",
        [log([str("outer")])],
      ),
    ],
    loc,
  };
  const resume = fnNamed(lowerOne(fn), "%rt.resume");
  const cases = dispatch(resume);
  const outer = stateLogging(cases, "outer");
  const rethrowState = cases.find((c) => c.body.some((s) => s.kind === "rethrow"))!.test!;
  // The rethrow re-raises into resume's own per-iteration catch, and the
  // routing table sends it OUTWARD — the inner region is already closed.
  expect(handlerOf(resume, rethrowState)).toBe(outer);
});

test("a break out of a protected region is an ordinary state jump", () => {
  /* while (true) { try { await mkp(); break; } catch (e) { } } */
  const fn: IrFunction = {
    name: "br",
    params: [],
    returnType: VOID,
    async: true,
    locals: [local("e.0", CAUGHT)],
    body: [
      {
        kind: "while",
        cond: bool(true),
        body: [tryCatch([exprStmt(awaited()), { kind: "break", loc }], "e.0", [log([str("c")])])],
        loc,
      },
      log([str("out")]),
    ],
    loc,
  };
  const resume = fnNamed(lowerOne(fn), "%br.resume");
  const cases = dispatch(resume);
  const exit = stateLogging(cases, "out");
  const jumper = cases.find((c) => c.test === jumpsTo(cases, exit)[0])!;
  // The jump is stateSet + continue like any other, made from a state the
  // region covers — and the loop's exit state, created before the region
  // opened, carries no handler at all.
  expect(jumper.body[jumper.body.length - 1]).toMatchObject({ kind: "continue", label: "%dispatch" });
  expect(handlerOf(resume, jumper.test!)).not.toBeNull();
  expect(handlerOf(resume, exit)).toBeNull();
});

/* ── 4. the refusal set ────────────────────────────────────────────────── */

describe("refusals leave the function untouched", () => {
  const awaitCall = () => await_(call("mkp", [], promiseOf(F64)), F64);
  const plain = (body: IrStmt[], locals: IrFunction["locals"] = [], extra: Partial<IrFunction> = {}): IrFunction => ({
    name: "f",
    params: [],
    returnType: VOID,
    async: true,
    locals,
    body,
    ...extra,
  } as IrFunction);

  test("await inside a try that has a FINALLY", () => {
    // A plain try/catch linearizes (the "awaits inside try/catch" describe
    // above); a finalizer takes part in completion, which is its own stage.
    const withFinally = (tryBody: IrStmt[], catchBody: IrStmt[] | null, finallyBody: IrStmt[]): IrStmt => ({
      kind: "tryCatch",
      tryBody,
      catchBody,
      catchLocalId: null,
      finallyBody,
      loc,
    });
    // The suspension in each of the three bodies in turn.
    expectRefusal(plain([withFinally([exprStmt(awaitCall())], [], [log([str("f")])])]), "fn:async:await-in-finally");
    expectRefusal(plain([withFinally([], [exprStmt(awaitCall())], [log([str("f")])])]), "fn:async:await-in-finally");
    expectRefusal(plain([withFinally([], [], [exprStmt(awaitCall())])]), "fn:async:await-in-finally");
    // Catchless try/finally is the same rock under the same name.
    expectRefusal(plain([withFinally([exprStmt(awaitCall())], null, [log([str("f")])])]), "fn:async:await-in-finally");
  });

  test("await under an operator that may not evaluate it", () => {
    // Hoisting is what retired the ordinary operand positions; a
    // CONDITIONAL one is the position where a temp ahead of the statement
    // would evaluate what JS skips, so it refuses under its own name.
    const cond = (e: IrExpr): IrExpr => ({ kind: "ternary", cond: bool(true), then: e, else_: num(0), type: F64, loc });
    expectRefusal(plain([log([cond(awaitCall())])]), "fn:async:await-conditional");
    expectRefusal(
      plain([varDecl("x.0", { kind: "logical", op: "&&", left: bool(true), right: awaitCall(), type: F64, loc })], [
        local("x.0", F64),
      ]),
      "fn:async:await-conditional",
    );
    expectRefusal(
      plain([
        {
          kind: "if",
          cond: { kind: "logical", op: "||", left: bool(false), right: awaitCall(), type: BOOL, loc },
          then: [],
          else_: null,
          loc,
        },
      ]),
      "fn:async:await-conditional",
    );
  });

  test("await in an expression kind the hoist register has no order for", () => {
    // A kind absent from HOIST_SLOTS refuses rather than guessing at its
    // operand order. A seeded `new Map([[k, await p]])` is the shape the
    // slot vocabulary cannot even spell: key and value interleave per
    // entry, and hoisting the keys as a block would reorder them.
    const mapT: IrType = { kind: "map", key: STRING, value: F64 };
    expectRefusal(
      plain(
        [varDecl("m.0", { kind: "mapNew", seed: [{ key: str("k"), value: awaitCall() }], type: mapT, loc })],
        [local("m.0", mapT)],
      ),
      "fn:async:await-position",
    );
  });

  test("await in a loop condition", () => {
    expectRefusal(
      plain([
        {
          kind: "while",
          cond: { kind: "bin", op: ">", left: awaitCall(), right: num(0), type: BOOL, loc },
          body: [],
          loc,
        },
      ]),
      "fn:async:await-position",
    );
  });

  test("await of a checked-dynamic value", () => {
    expectRefusal(
      plain([
        exprStmt({
          kind: "libCall",
          fn: "async.awaitDyn",
          args: [{ kind: "unitLit", unit: "undefined", type: { kind: "dyn" }, loc }],
          type: { kind: "dyn" },
          loc,
        }),
      ]),
      "fn:async:await-dyn",
    );
  });

  test("an initializer whose cache global is not a promise global", () => {
    // The wrapper's stores go through the "%g." namespace; a name that is
    // not a module global of promise type would silently become a write to
    // a local slot that does not exist.
    expectRefusal(
      plain([exprStmt(awaitCall())], [], { asyncCacheGlobal: "%g.mod.p" }),
      "fn:async:module-init-global",
    );
    expectRefusal(plain([exprStmt(awaitCall())], [], { asyncCacheGlobal: "%g.mod.p" }), "fn:async:module-init-global", (m) => ({
      ...m,
      globals: [{ id: "%g.mod.p", name: "p", type: BOOL, mutable: true }],
    }));
  });

  test("module.await outside an exprStmt", () => {
    // The loader's wait is void-valued and its re-entry produces nothing,
    // so only the statement slot that discards can host it.
    expectRefusal(
      plain([ret(moduleAwait(call("%init.0", [], promiseOf(VOID))))]),
      "fn:async:module-await-position",
    );
  });

  test("a body-boxed local whose declaration can run twice", () => {
    // JS binds `let` afresh per iteration, so closures made in iteration k
    // must not see iteration k+1's writes — which is exactly what the ONE
    // box the wrapper pre-creates would give them.
    expectRefusal(
      plain(
        [
          {
            kind: "while",
            cond: bool(true),
            body: [varDecl("c.0", num(1)), exprStmt(awaitCall())],
            loc,
          },
        ],
        [local("c.0", F64, { boxed: true })],
      ),
      "fn:async:boxed-in-loop",
    );
    // A for-of BINDING is the same story without a varDecl to point at.
    expectRefusal(
      plain(
        [
          {
            kind: "forOf",
            localId: "e.0",
            iterable: v("xs.0", { kind: "array", elem: F64 }),
            body: [],
            loc,
          },
          exprStmt(awaitCall()),
        ],
        [local("e.0", F64, { boxed: true }), local("xs.0", { kind: "array", elem: F64 })],
      ),
      "fn:async:boxed-in-loop",
    );
  });

  test("a non-tdz body box captured ahead of its declaration", () => {
    // Such a closure would read the box's DEFAULT payload where JS says
    // `undefined`. The frontend never emits the shape (a forward-captured
    // const becomes a tdz box; a forward-captured var gets its hoisted
    // `undefined` initializer pushed ahead of the closure), so this is the
    // structural proof of that rather than a measured rock.
    expectRefusal(
      plain(
        [
          exprStmt(closureOver("%lam", ["c.0"])),
          varDecl("c.0", num(1)),
          exprStmt(awaitCall()),
        ],
        [local("c.0", F64, { boxed: true })],
      ),
      "fn:async:boxed-forward-capture",
    );
  });

  test("a body box with no declaration to fill it", () => {
    expectRefusal(
      plain([exprStmt(awaitCall())], [local("c.0", F64, { boxed: true })]),
      "fn:async:boxed-local",
    );
  });

  test("selfRef in the body", () => {
    expectRefusal(
      plain([
        exprStmt({
          kind: "callValue",
          callee: { kind: "selfRef", type: { kind: "func", params: [], ret: VOID }, loc },
          args: [],
          type: VOID,
          loc,
        }),
        exprStmt(awaitCall()),
      ]),
      "fn:async:self-ref",
    );
  });

  test("await inside for-of", () => {
    expectRefusal(
      plain(
        [
          {
            kind: "forOf",
            localId: "e.0",
            iterable: v("xs.0", { kind: "array", elem: F64 }),
            body: [exprStmt(awaitCall())],
            loc,
          },
        ],
        [local("e.0", F64), local("xs.0", { kind: "array", elem: F64 })],
      ),
      "fn:async:await-in-forof",
    );
  });

  test("await inside switch", () => {
    expectRefusal(
      plain([
        {
          kind: "switch",
          disc: num(1),
          cases: [{ test: num(1), body: [exprStmt(awaitCall())] }],
          loc,
        },
      ]),
      "fn:async:await-in-switch",
    );
  });

  test("a return crossing a finally", () => {
    expectRefusal(
      plain([
        exprStmt(awaitCall()),
        {
          kind: "tryCatch",
          tryBody: [ret(null)],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [log([str("f")])],
          loc,
        },
      ]),
      "fn:async:return-in-finally",
    );
  });

  test("a break out of a kept construct into an exploded one", () => {
    expectRefusal(
      plain(
        [
          {
            kind: "while",
            cond: bool(true),
            body: [
              {
                kind: "switch",
                disc: num(1),
                // `continue` inside a switch binds to the enclosing LOOP,
                // which the await below explodes.
                cases: [{ test: num(1), body: [{ kind: "continue", loc }] }],
                loc,
              },
              exprStmt(awaitCall()),
            ],
            loc,
          },
        ],
      ),
      "fn:async:jump-out-of-switch",
    );
  });

  test("awaiting a promise OF a promise (JS would adopt it)", () => {
    // `await p` where p is Promise<Promise<T>>: JS flattens by adoption —
    // the awaiting frame ends up with T, two microtask turns later. This
    // tier stores payloads, so settling with a promise would hand the
    // INNER promise back: a miscompile, not a slower answer.
    expectRefusal(
      plain([exprStmt(await_(call("mkpp", [], promiseOf(promiseOf(F64))), promiseOf(F64)))]),
      "fn:async:nested-promise",
    );
  });

  test("an async function whose own result is a promise", () => {
    const fn: IrFunction = {
      name: "f",
      params: [],
      returnType: promiseOf(F64),
      async: true,
      locals: [],
      body: [ret(call("mkp", [], promiseOf(F64)))],
      loc,
    };
    expectRefusal(fn, "fn:async:nested-promise");
  });

  test("a source local colliding with the pass's own bindings", () => {
    expectRefusal(
      plain([exprStmt(awaitCall())], [local("%async.frame", F64)]),
      "fn:async:local-id-clash",
    );
  });

  test("a void-typed local has no frame slot", () => {
    expectRefusal(plain([exprStmt(awaitCall())], [local("z.0", VOID)]), "fn:async:void-local");
  });

  test("generators keep their own gate — the pass never touches them", () => {
    const gen: IrFunction = {
      name: "gf",
      params: [],
      returnType: VOID,
      async: true,
      generator: { yieldT: F64, nextT: VOID },
      locals: [],
      body: [exprStmt(awaitCall())],
      loc,
    };
    const { mod, refusals } = lower(asyncModule(gen));
    expect(refusals).toEqual([]);
    expect(fnNamed(mod, "gf")).toEqual(gen);
  });
});

/* ── 4a. order-preserving operand hoisting ─────────────────────────────── */

/* The rewrite that gives a suspension in an operand position a statement
 * root of its own. What these pin is ORDER: every subexpression that JS
 * evaluates before the suspension is taken into a `%hoist.<n>` temp on the
 * suspending side of the split, and everything after it is left where it
 * was, on the resumed side. */
describe("order-preserving operand hoisting", () => {
  const awaitP = () => await_(call("mkp", [], promiseOf(F64)), F64);
  const asyncF = (body: IrStmt[], locals: IrFunction["locals"] = [], returnType: IrType = VOID): IrFunction => ({
    name: "f",
    params: [],
    returnType,
    async: true,
    locals,
    body,
    loc,
  });
  /** The statements of a state, past the restore prologue AND the reject
   * check a re-entry opens with. */
  const resumedBody = (body: IrStmt[]): IrStmt[] => {
    const rest = afterRestores(body);
    return rest[0]?.kind === "%async.rejectCheck" ? rest.slice(1) : rest;
  };
  const argsOf = (s: IrStmt | undefined): IrExpr[] => {
    if (s === undefined || s.kind !== "exprStmt") throw new Error("not an exprStmt");
    return (s.expr as Extract<IrExpr, { kind: "call" }>).args;
  };

  test("`console.log('x', await p, 'y')` reads the awaited value out of a temp", () => {
    const mod = lowerOne(asyncF([log([str("x"), awaitP(), str("y")])]));
    const cases = dispatch(fnNamed(mod, "%f.resume"));
    expect(cases.map((c) => c.test)).toEqual([0, 1, null]);
    // The suspension became a varDecl root — the one shape the splitter
    // takes apart — and the log runs on the resumed side.
    const resumed = resumedBody(cases[1]!.body);
    expect(resumed.map((s) => s.kind)).toEqual(["varDecl", "exprStmt", "%async.settle", "return"]);
    expect(resumed[0]).toMatchObject({ kind: "varDecl", localId: "%hoist.1" });
    expect((resumed[0] as Extract<IrStmt, { kind: "varDecl" }>).init).toMatchObject({ kind: "%async.settled" });
    // Literals stay exactly where they were: re-evaluating one after the
    // resumption is unobservable, so they need no temp.
    const args = (resumed[1] as Extract<IrStmt, { kind: "exprStmt" }>).expr as { args: IrExpr[] };
    expect(args.args.map((a) => a.kind)).toEqual(["strLit", "varRef", "strLit"]);
    expect(args.args[1]).toMatchObject({ localId: "%hoist.1", type: F64 });
  });

  test("`g(a(), await p, b())` runs a() before the suspend and b() after", () => {
    const mod = lowerOne(
      asyncF([exprStmt(call("g", [call("a", [], F64), awaitP(), call("b", [], F64)], VOID))]),
    );
    const cases = dispatch(fnNamed(mod, "%f.resume"));
    // a() is taken into a temp on the SUSPENDING side, ahead of the save.
    const head = afterRestores(cases[0]!.body);
    expect(head[0]).toMatchObject({ kind: "varDecl", localId: "%hoist.1", init: { kind: "call", callee: "a" } });
    const subscribe = head.findIndex((s) => s.kind === "%async.subscribe");
    expect(subscribe).toBeGreaterThan(0);
    expect(head.slice(0, subscribe).some((s) => s.kind === "varDecl" && s.localId === "%hoist.1")).toBe(true);

    // b() is NOT hoisted: nothing after it suspends, so JS runs it after
    // the await — which is where leaving it in place puts it.
    const resumed = resumedBody(cases[1]!.body);
    expect(resumed[0]).toMatchObject({ kind: "varDecl", localId: "%hoist.2" });
    expect(argsOf(resumed[1]).map((a) => a.kind)).toEqual(["varRef", "varRef", "call"]);
    expect(argsOf(resumed[1])[0]).toMatchObject({ localId: "%hoist.1" });
    expect(argsOf(resumed[1])[1]).toMatchObject({ localId: "%hoist.2" });
    expect(argsOf(resumed[1])[2]).toMatchObject({ kind: "call", callee: "b" });
    expect(nodesOfKind(cases[0]!.body, "call").some((c) => c["callee"] === "b")).toBe(false);
  });

  test("two awaits in one argument list split twice, left to right", () => {
    const mod = lowerOne(
      asyncF([
        exprStmt(
          call("g", [await_(call("mkp", [], promiseOf(F64)), F64), await_(call("mkq", [], promiseOf(F64)), F64)], VOID),
        ),
      ]),
    );
    const resume = fnNamed(mod, "%f.resume");
    const cases = dispatch(resume);
    expect(cases.map((c) => c.test)).toEqual([0, 1, 2, null]);
    expect(nodesOfKind(resume.body, "%async.subscribe")).toHaveLength(2);
    // One await slot each, and the awaited promises in source order.
    expect(frameFields(mod, "f")).toEqual([
      "%state",
      "%promise",
      "%l_%hoist.1",
      "%l_%hoist.2",
      "%await1",
      "%await2",
    ]);
    const awaited = (n: number) =>
      nodesOfKind(cases[n]!.body, "recordSet").find((r) => String(r["field"]).startsWith("%await"))!;
    expect(awaited(0)["value"]).toMatchObject({ kind: "call", callee: "mkp" });
    expect(awaited(1)["value"]).toMatchObject({ kind: "call", callee: "mkq" });
    // The call itself runs last, on both temps.
    const resumed = resumedBody(cases[2]!.body);
    expect(argsOf(resumed[1])).toMatchObject([{ localId: "%hoist.1" }, { localId: "%hoist.2" }]);
  });

  test("`await f(await p)` hoists the inner await and leaves the call in place", () => {
    const mod = lowerOne(
      asyncF(
        [varDecl("x.0", await_(call("f2", [awaitP()], promiseOf(F64)), F64))],
        [local("x.0", F64)],
      ),
    );
    const cases = dispatch(fnNamed(mod, "%f.resume"));
    expect(cases.map((c) => c.test)).toEqual([0, 1, 2, null]);
    // Only the INNER await needed a temp: the call is the last operand of
    // the outer await, so it stays where it is — evaluated after the inner
    // resumption and before the outer suspend, exactly like JS.
    expect(nodesOfKind(mod, "varDecl").filter((d) => String(d["localId"]).startsWith("%hoist."))).toHaveLength(1);
    const second = resumedBody(cases[1]!.body);
    expect(second[0]).toMatchObject({ kind: "varDecl", localId: "%hoist.1" });
    const awaited = nodesOfKind(second, "recordSet").find((r) => r["field"] === "%await2")!;
    expect(awaited["value"]).toMatchObject({ kind: "call", callee: "f2", args: [{ localId: "%hoist.1" }] });
    expect(resumedBody(cases[2]!.body)[0]).toMatchObject({ kind: "varDecl", localId: "x.0" });
  });

  test("`arr[i()] = await p` hoists receiver, index and value in that order", () => {
    // JS evaluates the reference, then the index, then the RHS — so
    // hoisting only the awaited value would move the other two behind it.
    const arrT: IrType = { kind: "array", elem: F64 };
    const mod = lowerOne(
      asyncF(
        [{ kind: "arraySet", arr: v("xs.0", arrT), index: call("i", [], F64), value: awaitP(), loc }],
        [local("xs.0", arrT)],
      ),
    );
    const cases = dispatch(fnNamed(mod, "%f.resume"));
    const head = afterRestores(cases[0]!.body);
    expect(head.slice(0, 2)).toMatchObject([
      { kind: "varDecl", localId: "%hoist.1", init: { kind: "varRef", localId: "xs.0" } },
      { kind: "varDecl", localId: "%hoist.2", init: { kind: "call", callee: "i" } },
    ]);
    const resumed = resumedBody(cases[1]!.body);
    expect(resumed[0]).toMatchObject({ kind: "varDecl", localId: "%hoist.3" });
    expect(resumed[1]).toMatchObject({
      kind: "arraySet",
      arr: { localId: "%hoist.1" },
      index: { localId: "%hoist.2" },
      value: { localId: "%hoist.3" },
    });
  });

  test("the hop form hoists too: `console.log(await <non-thenable>)`", () => {
    // `await <non-thenable>` is a seqExpr, not an awaitExpr — the
    // classifier recognizes it in an operand position exactly as it does
    // at a statement root.
    const mod = lowerOne(asyncF([log([hop("%awaited.0", str("hi"))])], [local("%awaited.0", STRING)]));
    const resume = fnNamed(mod, "%f.resume");
    expect(nodesOfKind(resume.body, "%async.hop")).toHaveLength(1);
    expect(nodesOfKind(resume.body, "libCall")).toHaveLength(0);
    const cases = dispatch(resume);
    // The operand parks in the frontend's own temp before the hop; the
    // hoist temp takes the value on the way out.
    expect(afterRestores(cases[0]!.body)[0]).toMatchObject({ kind: "varDecl", localId: "%awaited.0" });
    const resumed = resumedBody(cases[1]!.body);
    expect(resumed[0]).toMatchObject({ kind: "varDecl", localId: "%hoist.1" });
    expect(argsOf(resumed[1])).toMatchObject([{ localId: "%hoist.1", type: STRING }]);
  });

  test("temps are ordinary locals: resume's list, the frame, and nowhere else", () => {
    const mod = lowerOne(asyncF([log([str("x"), awaitP()])]));
    const resume = fnNamed(mod, "%f.resume");
    const temp = resume.locals.find((l) => l.id === "%hoist.1");
    expect(temp).toMatchObject({ id: "%hoist.1", name: "%hoist.1", type: F64, mutable: false });
    // It rides the frame's total save/restore like every other local...
    expect(frameFields(mod, "f")).toContain("%l_%hoist.1");
    const cases = dispatch(resume);
    expect(cases[1]!.body[0]).toMatchObject({ kind: "assign", localId: "%hoist.1", value: { kind: "recordGet" } });
    // ...and the wrapper, which only stores arguments, never sees it.
    expect(fnNamed(mod, "f").locals.map((l) => l.id)).toEqual(["%async.frame"]);
  });

  test("a hoist temp the frame cannot hold refuses instead", () => {
    // A void operand has no frame slot and no reference to hand back to
    // the position it came from.
    expectRefusal(
      {
        name: "f",
        params: [],
        returnType: VOID,
        async: true,
        locals: [],
        body: [exprStmt(call("g", [call("side", [], VOID), awaitP()], VOID))],
        loc,
      },
      "fn:async:hoist-void",
    );
  });

  test("the rewrite copies: the input module is never mutated", () => {
    const fn = asyncF([exprStmt(call("g", [call("a", [], F64), awaitP(), call("b", [], F64)], VOID))]);
    const input = asyncModule(fn);
    const before = JSON.stringify(input);
    const { refusals } = lower(input);
    expect(refusals).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });
});

/* ── 4b. module initializers and top-level await ───────────────────────── */

describe("the module-initializer protocol", () => {
  const initFn = (extra: Partial<IrFunction> = {}): IrFunction =>
    ({
      name: "%init.0",
      params: [],
      returnType: VOID,
      async: true,
      locals: [],
      body: [exprStmt(await_(call("mkp", [], promiseOf(F64)), F64))],
      loc,
      ...extra,
    }) as IrFunction;

  const lowerWithGlobals = (
    fn: IrFunction,
    globals: NonNullable<IrModule["globals"]>,
    entry?: string,
  ): WModule => {
    const input: IrModule = { ...asyncModule(fn), globals, ...(entry !== undefined ? { entry } : {}) };
    const { mod, refusals } = lower(input);
    expect(refusals).toEqual([]);
    return mod;
  };

  test("the wrapper guards the cache FIRST and publishes both caches AFTER the spawn", () => {
    // emit-async.ts's order, and every step of it is load-bearing under an
    // import cycle: the guard is what makes a re-entrant call cheap, and
    // publishing last is what makes the OUTERMOST spawn the promise the
    // cycle ends up rooted at.
    const mod = lowerWithGlobals(
      initFn({ asyncCacheGlobal: "%g.m.%initPromise", asyncCycleCacheGlobal: "%g.m.%cyclePromise" }),
      [promiseGlobal("%g.m.%initPromise"), promiseGlobal("%g.m.%cyclePromise")],
    );
    const wrapper = fnNamed(mod, "%init.0");
    expect(wrapper.body.map((s) => s.kind)).toEqual([
      "%async.cacheCheck", // 1. already evaluating or evaluated? hand it back
      "varDecl", //           2. the frame, with its minted promise
      "exprStmt", //          … and the eager kick
      "%async.markHandled", // 3. the loader owns it: never "unhandled"
      "assign", //            4. the cache, LAST write wins
      "assign", //            5. the cycle cache, same rule
      "return",
    ]);
    expect(wrapper.body[0]).toMatchObject({ globalId: "%g.m.%initPromise" });
    // Both stores publish the frame's OWN promise, not the global's
    // previous value.
    for (const [i, id] of [[4, "%g.m.%initPromise"], [5, "%g.m.%cyclePromise"]] as const) {
      expect(wrapper.body[i]).toMatchObject({
        kind: "assign",
        localId: id,
        value: { kind: "recordGet", field: "%promise" },
      });
    }
    expect(wrapper.returnType).toEqual(promiseOf(VOID));
  });

  test("an initializer with no cycle publishes only its own cache", () => {
    const mod = lowerWithGlobals(initFn({ asyncCacheGlobal: "%g.m.%initPromise" }), [
      promiseGlobal("%g.m.%initPromise"),
    ]);
    expect(fnNamed(mod, "%init.0").body.map((s) => s.kind)).toEqual([
      "%async.cacheCheck",
      "varDecl",
      "exprStmt",
      "%async.markHandled",
      "assign",
      "return",
    ]);
  });

  test("the ENTRY may be async: top-level await lowers like any other body", () => {
    // The wrapper's promise IS the module evaluation promise `_start`
    // parks and `_status` reports on (abi.ts) — nothing about the pass
    // changes, the return type is what tells the emitter.
    const mod = lowerWithGlobals(initFn({ name: "f" }), [], "f");
    expect(fnNamed(mod, "f").returnType).toEqual(promiseOf(VOID));
    expect(mod.functions.some((fn) => fn.name === "%f.resume")).toBe(true);
  });

  test("module.await splits the state WITHOUT leaving resume when the dependency settled", () => {
    // The one suspension that can fall through: subscribeIfPending returns
    // only if it actually parked, so the settled path re-enters the
    // dispatch loop in the same turn and lands in the resume state, where
    // the reject check runs exactly as it would after a park.
    const dep = () => v("%depInit.0", promiseOf(VOID));
    const fn: IrFunction = {
      name: "%init.1",
      params: [],
      returnType: VOID,
      async: true,
      locals: [local("%depInit.0", promiseOf(VOID))],
      body: [
        varDecl("%depInit.0", call("%init.0", [], promiseOf(VOID))),
        exprStmt(moduleAwait(dep())),
        log([str("body")]),
      ],
      loc,
    };
    const mod = lowerWithGlobals(fn, []);
    const resume = fnNamed(mod, "%%init.1.resume");
    const cases = dispatch(resume);
    expect(cases.map((c) => c.test)).toEqual([0, 1, null]);
    // The suspending state parks the dependency, saves, sets the state,
    // and ends by CONTINUING — no `return`, which is the whole difference
    // from an ordinary await.
    const suspend = afterRestores(cases[0]!.body);
    expect(suspend.at(-2)!.kind).toBe("%async.subscribeIfPending");
    expect(suspend.at(-1)).toMatchObject({ kind: "continue", label: "%dispatch" });
    expect(nodesOfKind(cases[0]!.body, "%async.subscribe")).toHaveLength(0);
    expect(nodesOfKind(cases[0]!.body, "%async.hop")).toHaveLength(0);
    // Re-entry: the rejection check, then the body that follows the wait.
    expect(afterRestores(cases[1]!.body).map((s) => s.kind)).toEqual([
      "%async.rejectCheck",
      "exprStmt",
      "%async.settle",
      "return",
    ]);
    expect(frameFields(mod, "%init.1")).toEqual(["%state", "%promise", "%l_%depInit.0", "%await1"]);
  });
});

/* ── 4c. the boxes a body owns ─────────────────────────────────────────── */

/* A captured (or TDZ) local the body declares cannot ride the frame: two
 * closures and the resumed frame must see ONE box, and by-value
 * save/restore would fork it at every suspension. What these pin is the
 * three-part answer — the wrapper pre-creates the box, resume captures it,
 * and the declaration becomes the write that fills it in place. */
describe("body-boxed locals ride resume's environment", () => {
  const awaitP = () => await_(call("mkp", [], promiseOf(F64)), F64);
  /** `let n = 0; (closure over n); const a = await mkp(); log(a)`. */
  const boxedBody = (extra: Partial<IrFunction> = {}, decl: IrStmt = varDecl("n.0", num(0))): IrFunction =>
    ({
      name: "f",
      params: [],
      returnType: VOID,
      async: true,
      locals: [local("n.0", F64, { boxed: true }), local("a.0", F64)],
      body: [decl, exprStmt(closureOver("%bump", ["n.0"])), varDecl("a.0", awaitP()), log([v("a.0", F64)])],
      loc,
      ...extra,
    }) as IrFunction;

  /** The lifted lambda `%bump` points at — a real function, so the survey
   * at the end of this block has something to make a funcref of. Its own
   * `n.0` is the received-capture twin of the body's box. */
  const bump: IrFunction = {
    name: "%bump",
    params: [],
    returnType: VOID,
    captures: [{ localId: "n.0", name: "n.0", type: F64 }],
    locals: [local("n.0", F64, { boxed: true })],
    body: [assign("n.0", { kind: "bin", op: "+", left: v("n.0", F64), right: num(1), type: F64, loc })],
    loc,
  };

  const mod = lowerOne(boxedBody(), [bump]);
  const wrapper = fnNamed(mod, "f");
  const resume = fnNamed(mod, "%f.resume");

  test("the wrapper makes the box before it packs the resume closure", () => {
    expect(wrapper.body.map((s) => s.kind)).toEqual(["%async.boxInit", "varDecl", "exprStmt", "return"]);
    expect(wrapper.body[0]).toMatchObject({ kind: "%async.boxInit", localId: "n.0" });
    // The box slot lives in the wrapper, which is what the closure below
    // reads; the rest of the body's locals still belong to resume alone.
    expect(wrapper.locals.map((l) => l.id)).toEqual(["n.0", "%async.frame"]);
    expect(wrapper.locals[0]).toMatchObject({ id: "n.0", boxed: true });
  });

  test("the kick goes through the closure, whose captures name the box", () => {
    // A capturing resume can only be reached through its env: the direct
    // call would hand it the dead ref.null every direct call passes.
    const kick = wrapper.body[2]!;
    if (kick.kind !== "exprStmt") throw new Error("unreachable");
    expect(kick.expr.kind).toBe("callValue");
    expect((kick.expr as { callee: { captures: string[] } }).callee).toMatchObject({
      kind: "closure",
      fnName: "%f.resume",
      captures: ["n.0"],
    });
  });

  test("resume receives the box as a capture, with its boxed local twin", () => {
    expect(resume.captures).toEqual([{ localId: "n.0", name: "n.0", type: F64 }]);
    expect(resume.locals.find((l) => l.id === "n.0")).toMatchObject({ boxed: true });
    // Every suspend re-packs the SAME box, which is what makes the
    // aliasing survive a suspension.
    for (const c of nodesOfKind(resume.body, "closure")) {
      if (c["fnName"] === "%f.resume") expect(c["captures"]).toEqual(["n.0"]);
    }
  });

  test("the declaration becomes the write that fills the wrapper's box", () => {
    // `assign` stores THROUGH the box (storeVar); a `varDecl` would mint a
    // fresh one and fork the binding the closure already captured.
    expect(nodesOfKind(resume.body, "varDecl").some((d) => d["localId"] === "n.0")).toBe(false);
    const fill = nodesOfKind(resume.body, "assign").find((a) => a["localId"] === "n.0");
    expect(fill).toMatchObject({ kind: "assign", value: { kind: "numLit", value: 0 } });
  });

  test("the box is NOT in the frame: it is a ref in an env, not a value", () => {
    expect(frameFields(mod, "f")).toEqual(["%state", "%promise", "%l_a.0", "%await1"]);
    // ...and so it is neither saved nor restored.
    expect(nodesOfKind(resume.body, "recordSet").some((r) => r["field"] === "%l_n.0")).toBe(false);
    expect(nodesOfKind(resume.body, "assign").some((a) => a["localId"] === "n.0" && (a["value"] as { kind: string }).kind === "recordGet")).toBe(false);
  });

  test("an initializer-free TDZ box lowers: boxInit IS its empty state", () => {
    // The frontend pre-declares a forward-captured const as `varDecl
    // init:null, boxed, tdz` and turns the source declaration into an
    // `assign`. struct.new_default leaves the box's inner slot null, which
    // is the TDZ sentinel, so the declaration disappears outright and the
    // source assign is the fill — exactly the sync path's two statements.
    const tdz = boxedBody(
      { locals: [local("n.0", F64, { boxed: true, tdz: true }), local("a.0", F64)] },
      varDecl("n.0", null),
    );
    const m = lowerOne({ ...tdz, body: [...tdz.body, assign("n.0", num(7))] });
    expect(fnNamed(m, "f").body[0]).toMatchObject({ kind: "%async.boxInit", localId: "n.0" });
    const r = fnNamed(m, "%f.resume");
    expect(nodesOfKind(r.body, "varDecl").some((d) => d["localId"] === "n.0")).toBe(false);
    expect(nodesOfKind(r.body, "assign").filter((a) => a["localId"] === "n.0")).toMatchObject([
      { value: { kind: "numLit", value: 7 } },
    ]);
    expect(r.locals.find((l) => l.id === "n.0")).toMatchObject({ boxed: true, tdz: true });
    expect(frameFields(m, "f")).not.toContain("%l_n.0");
  });

  test("a boxed PARAM needs no boxInit — the wrapper's prologue boxes it", () => {
    // The emitter re-boxes every boxed argument into its own slot before
    // the body runs, so the wrapper already holds the box; it just has to
    // stay OUT of the frame, whose %l_ slots hold values, not box refs.
    const fn: IrFunction = {
      name: "g",
      params: [{ localId: "ms.0", name: "ms", type: F64 }],
      returnType: VOID,
      async: true,
      locals: [local("ms.0", F64, { boxed: true }), local("a.0", F64)],
      body: [exprStmt(closureOver("%later", ["ms.0"])), varDecl("a.0", awaitP()), log([v("a.0", F64)])],
      loc,
    };
    const m = lowerOne(fn);
    const w = fnNamed(m, "g");
    expect(nodesOfKind(w.body, "%async.boxInit")).toHaveLength(0);
    expect(fnNamed(m, "%g.resume").captures).toEqual([{ localId: "ms.0", name: "ms.0", type: F64 }]);
    expect(frameFields(m, "g")).toEqual(["%state", "%promise", "%l_a.0", "%await1"]);
    // The frame literal stores the arguments it has slots for, and only
    // those: a boxed param has none.
    const init = (w.body[0] as Extract<IrStmt, { kind: "varDecl" }>).init!;
    expect((init as { fields: { name: string }[] }).fields.map((f) => f.name)).toEqual(["%promise"]);
  });

  test("capture order: received first, then the body's own in locals order", () => {
    // The env layout is a function of the input alone — resume's prologue
    // unpacks by INDEX, so anything order-dependent here would be a
    // mismatched struct field read.
    const fn: IrFunction = {
      name: "h",
      params: [],
      returnType: VOID,
      async: true,
      captures: [
        { localId: "outerA.0", name: "outerA", type: F64 },
        { localId: "outerB.0", name: "outerB", type: STRING },
      ],
      locals: [
        local("zed.0", F64, { boxed: true }),
        local("outerA.0", F64, { boxed: true }),
        local("outerB.0", STRING, { boxed: true }),
        local("amy.0", F64, { boxed: true }),
        local("a.0", F64),
      ],
      body: [
        varDecl("zed.0", num(1)),
        varDecl("amy.0", num(2)),
        exprStmt(closureOver("%lam", ["outerA.0", "zed.0", "amy.0", "outerB.0"])),
        varDecl("a.0", awaitP()),
        log([v("a.0", F64)]),
      ],
      loc,
    };
    const m = lowerOne(fn);
    const ids = ["outerA.0", "outerB.0", "zed.0", "amy.0"];
    expect(fnNamed(m, "%h.resume").captures!.map((c) => c.localId)).toEqual(ids);
    // The wrapper's boxInits cover the body's own boxes only (the received
    // ones arrive through the wrapper's OWN env), in the same order.
    expect(nodesOfKind(fnNamed(m, "h").body, "%async.boxInit").map((b) => b["localId"])).toEqual([
      "zed.0",
      "amy.0",
    ]);
    for (const c of nodesOfKind(m, "closure")) {
      if (c["fnName"] === "%h.resume") expect(c["captures"]).toEqual(ids);
    }
  });

  test("the emitter accepts the shape: the survey is clean", () => {
    expect(surveyWasmModule(asIrModule(mod))).toEqual([]);
  });
});

/* ── 5. pass-through ───────────────────────────────────────────────────── */

test("a module with no async functions comes back by identity", () => {
  const sync: IrModule = {
    irVersion: 3,
    sourceFile: "sync.ts",
    entry: "%main",
    functions: [
      { name: "%main", params: [], returnType: VOID, locals: [], body: [log([num(1)])], loc },
    ],
  };
  const { mod, refusals } = lower(sync);
  expect(mod).toBe(sync);
  expect(refusals).toEqual([]);
});

test("a module whose only async function refuses comes back unchanged", () => {
  const fn: IrFunction = {
    name: "f",
    params: [],
    returnType: VOID,
    async: true,
    locals: [],
    // A loop condition: re-evaluated per iteration, so no temp ahead of
    // the loop can stand in for it.
    body: [
      {
        kind: "while",
        cond: {
          kind: "bin",
          op: ">",
          left: await_(call("mkp", [], promiseOf(F64)), F64),
          right: num(0),
          type: BOOL,
          loc,
        },
        body: [],
        loc,
      },
    ],
    loc,
  };
  const input = asyncModule(fn);
  const { mod, refusals } = lower(input);
  expect(refusals).toEqual(["fn:async:await-position"]);
  expect(mod).toEqual(input);
});

test("non-async functions beside a lowered one are untouched", () => {
  const input = asyncModule(twoAwaits());
  const before = input.functions.filter((f) => f.async !== true).map((f) => JSON.parse(JSON.stringify(f)));
  const { mod } = lower(input);
  for (const f of before) expect(fnNamed(mod, f.name)).toEqual(f);
});

/* ── 6. nothing resumable survives ─────────────────────────────────────── */

test("a lowered module holds no awaits and no async.hop anywhere", () => {
  const mod = lowerOne(twoAwaits());
  expect(nodesOfKind(mod, "awaitExpr")).toHaveLength(0);
  expect(nodesOfKind(mod, "awaitUnionExpr")).toHaveLength(0);
  expect(nodesOfKind(mod, "libCall").filter((r) => String(r["fn"]).startsWith("async."))).toHaveLength(0);
  expect(mod.functions.some((f) => f.async === true)).toBe(false);
});

/* ── 7. what may-throw makes of the output ─────────────────────────────── */

/* computeMayThrow runs on the LOWERED module (the Assembler's constructor)
 * and has NO tryCatch case: its walk recurses into tryBody/catchBody
 * uniformly, so a `throw` inside a try still marks the function. These two
 * tests pin what that means for the state machine — resume's absorbing
 * catch does NOT keep it out of the may set — so stage 2 finds out here
 * rather than in a census diff. */
describe("may-throw over a lowered module", () => {
  const mayThrow = (mod: WModule) => computeMayThrow(asIrModule(mod)).fns;
  const throwing = (): IrFunction => ({
    name: "f",
    params: [],
    returnType: VOID,
    async: true,
    locals: [],
    body: [
      { kind: "throw", value: str("boom"), loc },
      exprStmt(await_(call("mkp", [], promiseOf(F64)), F64)),
    ],
    loc,
  });

  test("an await-only body is not may-throw: awaitExpr's seed left with it", () => {
    // The rejection re-throw now lives in %async.rejectCheck, a kind the
    // analysis has no case for — so nothing seeds. Harmless today (the
    // unwind targets resume's own catch, which is a local branch), but it
    // is the reason stage 2 must not rely on the seed being there.
    const fns = mayThrow(lowerOne(twoAwaits()));
    expect(fns.has("%f.resume")).toBe(false);
    expect(fns.has("f")).toBe(false);
  });

  test("a body that throws makes resume — and its caller — may-throw", () => {
    // The catch arm absorbs the throw at RUNTIME; the analysis cannot see
    // that, so resume is in the may set and the wrapper inherits it
    // through the direct call. The cost is spurious pending checks after
    // calls to an async function, never a missed one.
    const fns = mayThrow(lowerOne(throwing()));
    expect(fns.has("%f.resume")).toBe(true);
    expect(fns.has("f")).toBe(true);
    // Before lowering, `f` was async and calls to it never propagated.
    expect(computeMayThrow(asyncModule(throwing())).fns.has("%main")).toBe(false);
    expect(fns.has("%main")).toBe(true);
  });
});

/* ── 8. the emitter accepts the shapes the pass produces ───────────────── */

describe("the wasm survey over a lowered module", () => {
  // Collection-time (module-body) execution would let a throw here fail
  // the whole FILE's collection instead of one test — beforeAll defers it
  // to run time, where a regression surfaces as a normal test failure.
  let survey: string[];
  beforeAll(() => {
    survey = surveyWasmModule(asyncModule(twoAwaits()));
  });

  test("the frame shape maps: no record refusal", () => {
    expect(survey).not.toContain("record:recursive");
    expect(survey).not.toContain("record:index-signature");
  });

  test("nothing is left to refuse: the whole seam emits", () => {
    // Stage 1 traded `fn:async` for the ten `%async.*` names; stage 2's
    // runtime is what retired those, so a plain two-await function now
    // surveys CLEAN — no whole-function gate, no runtime seam, and no
    // `type:promise` (one struct serves every promise).
    expect(survey).toEqual([]);
  });
});

/* ── 9. the union-armed seam ───────────────────────────────────────────── */

test("an awaited `Promise<T> | undefined` surveys clean", () => {
  const inner = { kind: "union" as const, unionId: "u0" };
  const fn: IrFunction = {
    name: "f",
    params: [],
    returnType: VOID,
    async: true,
    locals: [],
    body: [
      exprStmt({
        kind: "awaitUnionExpr",
        value: { kind: "varRef", localId: "%g.p", type: inner, loc },
        promiseTag: 0,
        type: VOID,
        loc,
      }),
    ],
    loc,
  };
  const mod = asyncModule(fn);
  const survey = surveyWasmModule({
    ...mod,
    globals: [{ id: "%g.p", type: inner, loc }],
    unions: [{ id: "u0", arms: [promiseOf(F64), { kind: "undefinedT" }] }],
  });
  // Stage 7 retired the last two seam refusals: the tag test picks
  // between parking on the promise arm and hopping on a unit arm, and the
  // re-entry check runs only on the promise arm. A VOID result emits no
  // settled read at all, so this shape needs the pair and nothing else.
  expect(survey).toEqual([]);
});

/* ── 10. S041: the IteratorResult record's declared order ────────────────
 *
 * SEMANTICS.md S041: declaredOrder is metadata, not identity, so a
 * structurally-identical record shares ONE render order module-wide,
 * first-seen-wins. These two tests cover exactly the scope S041 commits
 * to pinning: the INTENT genResultRecord asserts (declaredOrder itself),
 * and the BEHAVIORAL render in an UNCONTESTED module (nothing else in the
 * module shares this exact shape, so there is no race to observe). Real
 * generator lowering does not exist in the wasm backend yet (stage A is
 * still building it), so "a real g.next() result" is reached the same way
 * S037's flag-true tests reach an unreachable-today shape: directly, at
 * the builder level — genResultRecord is a pure frontend function, fully
 * callable today with fresh registries, and its output is fed through the
 * REAL wasm emitter (emitWasmModule, not a mock) for the behavioral half.
 * NEITHER test attempts to pin the race S041 itself documents — not
 * because it CAN'T be (a unit test can inspect the shape-registry state
 * directly and pin the collision deterministically with no Node oracle
 * needed at all — the corpus-unpinnable argument is about the
 * differential corpus specifically, and does not transfer to an
 * internals-inspecting unit test), but because a passing test asserting
 * the WRONG order would be a test that the tier is broken, not that it
 * works (SEMANTICS.md S041's own "Tested by" wording) — a policy choice
 * about what belongs in a green suite, not a claim about what a test
 * COULD show. */
describe("S041: IteratorResult declared order", () => {
  test("genResultRecord's declaredOrder is exactly [value, done] — intent", () => {
    // Two representative channel shapes: an ordinary yielded-number
    // generator (V becomes a real union, f64 | undefined) and a dyn
    // channel (V collapses to DYN directly, genResultRecord's own first
    // branch) — declaredOrder must be the literal ["value","done"] either
    // way, since it is independent of what V turns out to be.
    for (const yieldT of [F64, DYN]) {
      const shapes = new ShapeRegistry();
      const unions = new UnionRegistry();
      const rec = genResultRecord(yieldT, VOID, shapes, unions);
      if (rec === null) throw new Error("genResultRecord returned null");
      const shape = shapes.get(rec.shapeId);
      expect(shape?.declaredOrder).toEqual(["value", "done"]);
    }
  });

  test("a genResultRecord-shaped value renders value-first — behavioral, uncontested module", async () => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    // yieldT = f64 (not dyn): V becomes a real union (f64 | undefined),
    // exercising the SAME jsonWrite/declaredOrder path a real generator's
    // result record uses — plain dyn fields hit their own SEPARATE,
    // pre-existing "jsonWrite:dyn" gap (measured while writing this test,
    // unrelated to declaredOrder), which would make this pin about the
    // wrong thing. console.log of a raw record ALSO refuses on its own
    // account today (`intrinsic:console.log:record` — real compiled
    // console.log(obj) never reaches the emitter in this raw shape; the
    // frontend's lowerConsoleInspectArg/formatValueExpr desugars it to a
    // rendered STRING first, which this hand-built module has no frontend
    // pass to run). Piping through JSON.stringify (a STRING result) is
    // the same surface wasm-emitter.test.ts's own declaredOrder tests
    // already use, and exercises ONE of declaredOrder's three consumer
    // paths (JSON, inspect/console.log, Object.keys/for-in — S041's own
    // "every render path" list) — not all three, since the other two run
    // through the same frontend inspect-lowering this raw module skips.
    // The console.log/inspect gap is real but orthogonal to what this
    // test pins, so it is worked around here, not silently swallowed.
    const rec = genResultRecord(F64, VOID, shapes, unions);
    if (rec === null) throw new Error("genResultRecord returned null");
    const recType: IrType = { kind: "record", shapeId: rec.shapeId };
    const shape = shapes.get(rec.shapeId)!;
    const valueField = shape.fields.find((f) => f.name === "value")!;
    if (valueField.type.kind !== "union") throw new Error("expected value field to be a union");
    const unionId = valueField.type.unionId;
    const arms = unions.get(unionId)?.arms ?? [];
    const f64Tag = arms.findIndex((a) => a.kind === "f64");
    if (f64Tag < 0) throw new Error("expected an f64 arm in the value union");

    const valueExpr: IrExpr = {
      kind: "unionWrap",
      unionId,
      tag: f64Tag,
      value: { kind: "numLit", value: 42, type: F64, loc },
      type: valueField.type,
      loc,
    };
    const doneExpr: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
    const litExpr: IrExpr = {
      kind: "recordLit",
      fields: [
        { name: "value", value: valueExpr },
        { name: "done", value: doneExpr },
      ],
      type: recType,
      loc,
    };
    const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: recType, loc };

    const mod: IrModule = {
      irVersion: 3,
      sourceFile: "s041.ts",
      entry: "%main",
      classes: runtimeErrorClasses,
      records: shapes.shapes,
      unions: unions.unions,
      functions: [
        {
          name: "%main",
          params: [],
          returnType: VOID,
          locals: [{ id: "r.0", name: "r.0", type: recType, mutable: false }],
          body: [varDecl("r.0", litExpr), log([{ kind: "jsonStringify", value: rRef, type: STRING, loc }])],
          loc,
        },
      ],
    };

    // No refusals: the shape this test builds is exactly what stage A's
    // mapType/mapTypeSoft generator arms already make representable.
    expect(surveyWasmModule(mod)).toEqual([]);

    const bytes = emitWasmModule(mod);
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(bytes, {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (memory === null) throw new Error("write before instantiation completed");
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    (instance.exports["_start"] as () => void)();
    const stdout = Buffer.concat(chunks).toString("utf8");

    // value-first via JSON.stringify piped through console.log — the
    // exact surface declaredOrder controls, with nothing else in this
    // module sharing the shape to race against.
    expect(stdout).toBe(`{"value":42,"done":false}` + "\n");
  });
});

/* ── 11. increment 19 stage A2 (opening unit): genResume hoists inside an
 * ORDINARY async function ──────────────────────────────────────────────
 *
 * `genResume` is not itself generator-only — any function, async or not,
 * may hold and drive a generator — so this is LIVE today even though
 * yieldExpr recognition (isSuspensionNode) is not: a genResume node can
 * appear in an async body the pass already lowers, and its `arg` can
 * contain an ordinary await (2017's corpus shape puts one beside an
 * await in the same async function). Before this HOIST_SLOTS entry, such
 * a program refused at the HOISTING layer (`fn:async:await-position` —
 * no entry for `genResume`'s kind at all). After it, hoisting succeeds
 * and the refusal moves to the EMITTER's own `expr:genResume` arm
 * (genResume emission itself is stage A3's work) — strictly more precise
 * for the exact same not-yet-supported program, never a miscompile. */
describe("genResume hoists inside an async function (stage A2 opener)", () => {
  const genT: IrType = { kind: "generator", yieldT: F64, retT: VOID, nextT: F64 };

  /** genResultRecord's shape lives in a FRESH registry per call — the
   * module carrying `recT` must attach its `.shapes`/`.unions` arrays
   * itself (asyncModule's own records/unions are empty by default), or
   * the emitter's "unknown record shape" bug-check fires on a shapeId
   * nothing declared. */
  function genResultType(): { type: IrType; records: IrRecordShape[]; unions: IrUnionDef[] } {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const rec = genResultRecord(F64, VOID, shapes, unions);
    if (rec === null) throw new Error("genResultRecord returned null");
    return { type: { kind: "record", shapeId: rec.shapeId }, records: shapes.shapes, unions: unions.unions };
  }

  const awaitP = () => await_(call("mkp", [], promiseOf(F64)), F64);

  test("a genResume argument that awaits hoists cleanly — no fn:async:await-position", () => {
    const { type: recT, records, unions } = genResultType();
    const fn: IrFunction = {
      name: "f",
      params: [],
      returnType: VOID,
      async: true,
      locals: [local("g.0", genT), local("r.0", recT)],
      body: [
        varDecl(
          "r.0",
          { kind: "genResume", mode: "next", gen: v("g.0", genT), arg: awaitP(), type: recT, loc },
        ),
        log([v("r.0", recT)]),
      ],
      loc,
    };
    const { mod, refusals } = lower({ ...asyncModule(fn), records, unions });
    // Hoisting itself declines nothing — the whole point of this entry.
    expect(refusals).toEqual([]);
    const lowered = fnNamed(mod, "%f.resume");
    // The awaited operand split into its own state, ahead of the
    // genResume call that consumes the hoisted temp — the ordinary
    // "operand hoists before the statement's own suspension" shape any
    // other HOIST_SLOTS entry already produces (order-preserving
    // operand hoisting, section 6 above), not anything genResume-special.
    expect(nodesOfKind(lowered.body, "genResume")).toHaveLength(1);
    expect(nodesOfKind(lowered.body, "%async.subscribe")).toHaveLength(1);
  });

  test("the SAME module still refuses — at expr:genResume, in the emitter, not the hoister", () => {
    // genResume emission is unimplemented (stage A3): the refusal must
    // still happen, just at the right layer. Proves the HOIST_SLOTS entry
    // moved WHERE the refusal fires, not WHETHER it fires.
    const { type: recT, records, unions } = genResultType();
    const fn: IrFunction = {
      name: "f",
      params: [],
      returnType: VOID,
      async: true,
      locals: [local("g.0", genT), local("r.0", recT)],
      body: [
        varDecl(
          "r.0",
          { kind: "genResume", mode: "next", gen: v("g.0", genT), arg: awaitP(), type: recT, loc },
        ),
        log([v("r.0", recT)]),
      ],
      loc,
    };
    const survey = surveyWasmModule({ ...asyncModule(fn), records, unions });
    expect(survey).toContain("expr:genResume");
    expect(survey).not.toContain("fn:async:await-position");
    expect(survey).not.toContain("fn:async");
  });
});

/* ── 12. increment 19 stages A2b/A2c: yield lowering + completion ────────
 *
 * FunctionLowering is exported for this describe block ONLY (see its own
 * doc comment): lowerResumableFunctions' per-function skip still keeps
 * every real generator out (B2 — gate-widening is deliberately the LAST
 * step), so these tests construct one directly, the same way house rule
 * #9 already covers a helper's flag-true branches by builder-level
 * construction rather than waiting for a frontend path that doesn't
 * reach them yet.
 *
 * SCOPE NOTE (A2b gate's F2 finding — a GUARD, not documentation):
 * buildWrapper and catchArm (reached through buildResume) are BOTH STILL
 * unconditionally async-shaped as of this comment — buildWrapper's
 * frameInit literal names PROMISE_FIELD directly, and catchArm's
 * "reject" default arm (embedded in EVERY resume regardless of whether
 * the body has a covering try/catch — the routing table's fallback for
 * "no protected region") does too. `completion()`/`fellThrough()` are
 * NOT in that list anymore (stage A2c) — both now branch on genType and
 * emit `%gen.complete` for a generator's return/fall-through, covered by
 * the two tests below named for them; they are the reason those two
 * bodies can now use an explicit `return`/fall off the end at all, where
 * every A2b-era test had to avoid both. Calling `.run()` on a generator
 * would still construct invalid IR through buildWrapper/catchArm — not a
 * crash, since nothing cross-checks a recordLit's field names against
 * the shape, which is exactly why it has to be refused rather than
 * produced and trusted. `run()` still declines outright for any
 * generator (`this.genType !== null`), BEFORE doing any work — see its
 * own guard comment. These tests use `runFrameAndStatesForTest()`
 * instead: the frame fields and the raw per-state statement lists,
 * built the identical way `run()` builds them internally, WITHOUT ever
 * reaching buildResume/buildWrapper/catchArm — structurally incapable of
 * producing the invalid IR, not merely a test that happens to avoid
 * triggering it. */
describe("yield lowering (stage A2b — FunctionLowering used directly)", () => {
  const genLoc = loc;
  const yieldExpr = (value: IrExpr | null, type: IrType): IrExpr => ({ kind: "yieldExpr", value, type, loc: genLoc });

  function genModule(fn: IrFunction): IrModule {
    return { irVersion: 3, sourceFile: "gen.ts", entry: "%main", functions: [fn] };
  }

  test("run() declines a generator outright, before doing any work — the guard itself", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: F64 },
      locals: [],
      body: [exprStmt(yieldExpr(num(1), F64))],
      loc: genLoc,
    };
    const refusals: string[] = [];
    expect(() => new FunctionLowering(genModule(fn), fn, (kind) => refusals.push(kind)).run()).toThrow();
    expect(refusals).toEqual(["fn:async:generator-wrapper-not-built"]);
  });

  test("the frame carries %gen (typed to the function's own triple), never %promise", () => {
    const genT: IrType = { kind: "generator", yieldT: F64, retT: F64, nextT: F64 };
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: F64 },
      locals: [local("sent.0", F64)],
      body: [varDecl("sent.0", yieldExpr(num(1), F64)), log([v("sent.0", F64)])],
      loc: genLoc,
    };
    const { frame, states } = new FunctionLowering(genModule(fn), fn, () => {}).runFrameAndStatesForTest();
    expect(frame.fields.find((f) => f.name === "%gen")).toMatchObject({ type: genT });
    expect(frame.fields.some((f) => f.name === "%promise")).toBe(false);
    // The positive half of the F2 guard: not just "run() throws" (the
    // dedicated test above) but "the surface tests actually use never
    // constructs the async-only nodes that named PROMISE_FIELD" —
    // runFrameAndStatesForTest() never reaches catchArm/buildWrapper, so
    // none of these should exist at all, on ANY generator body.
    for (const kind of ["%async.reject", "%async.settle", "%async.mint", "%async.subscribe", "%async.hop"]) {
      expect(nodesOfKind(states, kind)).toEqual([]);
    }
  });

  test("a yield with a value and a real nextT: suspend carries the raw operand, injectCheck runs on re-entry, sent is read back", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: F64 },
      locals: [local("sent.0", F64)],
      body: [varDecl("sent.0", yieldExpr(num(1), F64)), log([v("sent.0", F64)])],
      loc: genLoc,
    };
    const { states } = new FunctionLowering(genModule(fn), fn, () => {}).runFrameAndStatesForTest();

    const suspend = nodesOfKind(states, "%gen.suspend");
    expect(suspend).toHaveLength(1);
    // The raw yieldT-typed operand, un-retagged — %gen.suspend's own
    // contract (retagging is stage A3's job, at emission time, not the
    // pass's — see the seam's doc comment for why).
    expect(suspend[0]).toMatchObject({ value: { kind: "numLit", value: 1 } });

    expect(nodesOfKind(states, "%gen.injectCheck")).toHaveLength(1);

    const sent = nodesOfKind(states, "%gen.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: F64 });
  });

  test("a bare `yield;` suspends with value: null", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: UNDEFINED_T },
      locals: [],
      body: [exprStmt(yieldExpr(null, UNDEFINED_T))],
      loc: genLoc,
    };
    const { states } = new FunctionLowering(genModule(fn), fn, () => {}).runFrameAndStatesForTest();
    const suspend = nodesOfKind(states, "%gen.suspend");
    expect(suspend).toHaveLength(1);
    expect(suspend[0]!["value"]).toBeNull();
  });

  test("nextT the undefined unit omits %gen.sent entirely — mirrors generators.ts's hasSent rule", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: UNDEFINED_T },
      locals: [],
      body: [exprStmt(yieldExpr(num(1), UNDEFINED_T))],
      loc: genLoc,
    };
    const { states } = new FunctionLowering(genModule(fn), fn, () => {}).runFrameAndStatesForTest();
    expect(nodesOfKind(states, "%gen.injectCheck")).toHaveLength(1);
    expect(nodesOfKind(states, "%gen.sent")).toHaveLength(0);
  });

  test("an explicit `return v;` retags into $gen.out via %gen.complete, never %async.settle", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: F64 },
      locals: [],
      body: [ret(num(42))],
      loc: genLoc,
    };
    const { states } = new FunctionLowering(genModule(fn), fn, () => {}).runFrameAndStatesForTest();
    const complete = nodesOfKind(states, "%gen.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ value: { kind: "numLit", value: 42 } });
    expect(nodesOfKind(states, "%async.settle")).toEqual([]);
  });

  test("a void-returning body falling off the end completes via %gen.complete(value: null), never %async.settle", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: VOID,
      generator: { yieldT: F64, nextT: F64 },
      locals: [],
      // A yield with nothing after it: the resume state has no return of
      // its own, so it falls off the end into fellThrough() — isolates
      // fellThrough's generator branch from completion()'s (the explicit
      // `return v;` case, covered by the test just above).
      body: [exprStmt(yieldExpr(num(1), F64))],
      loc: genLoc,
    };
    const { states } = new FunctionLowering(genModule(fn), fn, () => {}).runFrameAndStatesForTest();
    const complete = nodesOfKind(states, "%gen.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]!["value"]).toBeNull();
    expect(nodesOfKind(states, "%async.settle")).toEqual([]);
  });
});
