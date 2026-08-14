/* The resumable-function lowering (backend/wasm/statemachine.ts) as a pure
 * IR→IR transform: hand-built async modules in, state machines out. The
 * assertions are STRUCTURAL — the shape of the wrapper, the resume
 * skeleton, the frame's fields, and the closure of the state graph — not
 * byte-exact IR, so the pass keeps room to pick different state numbers.
 * The other half of the contract is the refusal set: every async shape the
 * pass declines must name itself and leave the function untouched, which
 * is what keeps the emitter's own `fn:async` firing behind it. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { IrExpr, IrFunction, IrLocal, IrModule, IrParam, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../src/ir/nodes.js";
import { BOOL, CAUGHT, DYN, F64, STRING, UNDEFINED_T, VOID } from "../src/ir/nodes.js";
import {
  asIrModule,
  FRAME_BASE,
  FunctionLowering,
  lowerResumableFunctions,
  type WFunction,
  type WModule,
} from "../src/backend/wasm/statemachine.js";
import { computeMayThrow } from "../src/backend/emission/may-throw.js";
import { emitWasmModule, surveyWasmModule } from "../src/backend/wasm/emitter.js";
import { compile } from "../src/index.js";
import { computeGenResultArms, genResultRecord, ShapeRegistry, UnionRegistry } from "../src/frontend/types.js";
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
    // ...and jumps to the dispatch loop's own label, so its next turn is
    // the handler — a LABELED continue (dispatchToHandler, stage B round
    // 3's F1 fix), not a bare break: reraisePending's own THROW arm
    // reuses this exact same dispatch from a deeper nesting level (its
    // own switch, inside a state's body, inside the states switch) where
    // a bare break would only exit ITS OWN switch, never reach the
    // dispatch loop — one proven-correct "jump to a state" mechanism
    // (goto's own labeled continue), not two that only coincide here.
    expect(arm[arm.length - 1]).toMatchObject({ kind: "continue", label: "%dispatch" });
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

  test("await inside a try that has a FINALLY now lowers (stage B: the async lift)", () => {
    // Stage B builds finalizer linearization generically over BOTH lanes
    // (generators' own target — 2011/2012/2014 — and, per the design
    // report's acceptance test, whichever fn:async shapes ride free): a
    // suspension in ANY of the three bodies of a finally-bearing try no
    // longer refuses here. The differential census (2011/2012/2014/1022,
    // all byte-diffed against Node) is the real behavioral bar; this
    // pins the STRUCTURAL side stage A's own analogous "run() now
    // succeeds" test (above, A2c slice 5) already established the
    // pattern for: the shapes that used to decline now lower clean.
    const withFinally = (tryBody: IrStmt[], catchBody: IrStmt[] | null, finallyBody: IrStmt[]): IrStmt => ({
      kind: "tryCatch",
      tryBody,
      catchBody,
      catchLocalId: null,
      finallyBody,
      loc,
    });
    // The suspension in each of the three bodies in turn.
    const mod1 = lowerOne(plain([withFinally([exprStmt(awaitCall())], [], [log([str("f")])])]));
    const mod2 = lowerOne(plain([withFinally([], [exprStmt(awaitCall())], [log([str("f")])])]));
    const mod3 = lowerOne(plain([withFinally([], [], [exprStmt(awaitCall())])]));
    // Catchless try/finally is the same shape under the same machinery.
    const mod4 = lowerOne(plain([withFinally([exprStmt(awaitCall())], null, [log([str("f")])])]));
    for (const mod of [mod1, mod2, mod3, mod4]) {
      expect(mod.functions.some((f) => f.name === "%f.resume")).toBe(true);
      // %pending.kind/%pending.value joined the frame — lazy allocation
      // (pendingFields' own doc comment), so their PRESENCE here is
      // itself evidence the finally path was actually taken, not just
      // that lowering happened to succeed for an unrelated reason.
      const fields = frameFields(mod, "f");
      expect(fields).toContain("%pending.kind");
      expect(fields).toContain("%pending.value");
    }
  });

  test("a NON-suspending finally with a return still refuses — the settle-then-return bug is real for the verbatim-kept case", () => {
    // The narrowed decline (checkEligible, stage B): a return inside a
    // finally-bearing try that has NO suspension anywhere in it stays
    // declined — rewriteReturns' naive splice would settle BEFORE the
    // emitter's own native finally desugar runs it, observably too
    // early. Only the ACTUALLY-suspending shape (above) gets the fix.
    const withFinally = (tryBody: IrStmt[], finallyBody: IrStmt[]): IrStmt => ({
      kind: "tryCatch",
      tryBody,
      catchBody: null,
      catchLocalId: null,
      finallyBody,
      loc,
    });
    expectRefusal(
      plain([withFinally([{ kind: "return", value: num(1), loc }], [log([str("f")])])], [], { returnType: F64 }),
      "fn:async:return-in-finally",
    );
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

  // "await inside for-of" over an ARRAY iterable lived here through stage
  // B: forOf had no lowering at all, so ANY suspension inside one — over
  // any iterable type — declined under this name. Stage C's forOf desugar
  // (hoistStmt's own "forOf" case: an array-typed, suspension-containing
  // forOf becomes an ordinary index-based "for", which the EXISTING for-
  // machinery then linearizes with no changes of its own) means an array
  // iterable no longer declines here — full positive coverage lives in
  // the "stage C: forOf array desugar" describe block below. What STILL
  // declines under this name is every OTHER iterable kind (the frontend
  // already desugars a GENERATOR iterable away entirely — see
  // lower-generators.ts's lowerForOfGenerator — so a "forOf" IR node
  // reaching this pass is never over one); pinned below with a dyn
  // iterable standing in for "not an array."
  test("await inside for-of over a NON-array iterable stays declined", () => {
    expectRefusal(
      plain(
        [
          {
            kind: "forOf",
            localId: "e.0",
            iterable: v("xs.0", DYN),
            body: [exprStmt(awaitCall())],
            loc,
          },
        ],
        [local("e.0", DYN), local("xs.0", DYN)],
      ),
      "fn:async:await-in-forof",
    );
  });

  // "await inside switch" (case BODY) lived here through stage B: switch
  // used to have no lowering at all, so ANY suspension anywhere inside one
  // declined under this name. Stage C built lowerSwitch — a case body's
  // own suspension now lowers for real (full-source coverage in the
  // "stage C: switch dispatch reuse" describe block below); the premise
  // this pin tested is gone, not merely its assertion. What STILL declines
  // under a switch-specific name is a suspension in a case TEST (the
  // conditional, lazily-evaluated part of a switch) — a materially
  // different position, pinned in its place.
  test("await inside a switch CASE TEST", () => {
    expectRefusal(
      plain([
        {
          kind: "switch",
          disc: num(1),
          cases: [{ test: awaitCall(), body: [log([str("hit")])] }],
          loc,
        },
      ]),
      "fn:async:await-in-switch-test",
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

  // "a break out of a kept construct into an exploded one" lived here
  // through stage B: a switch with ZERO suspension of its own, but a
  // continue escaping it into an enclosing loop that DOES suspend
  // elsewhere, used to fall to lowerStmt's generic default arm (no
  // "switch" case existed) and decline. Stage C's lowerSwitch handles
  // this shape directly — the switch's own JumpScope lets `continue`
  // pass through to the loop unchanged — so the premise is gone; full
  // positive coverage (the reviewer's own "yields outside a switch that
  // continues" shape) lives in the "stage C: switch dispatch reuse"
  // describe block below.

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

  // "generators keep their own gate — the pass never touches them" lived
  // here through A2c slice 4b, pinning the OLD per-function skip
  // (lowerResumableFunctions treated `fn.generator !== undefined` as an
  // unconditional pass-through, regardless of `fn.async`). A2c slice 5
  // widened that gate on purpose — a real generator now DOES reach this
  // pass — so the test's own premise is gone, not merely its assertion;
  // retired rather than inverted. The "yield lowering" describe block
  // below (A2c slices 2/2b/3/4/5) is where generator-shaped `run()`
  // coverage lives now, including what a real (non-async-flagged)
  // generator does when it reaches this class for real.
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

  test("the SAME module now survives THROUGH the emitter too (A3's next-mode slice) — genResume beside an await, inside an ORDINARY async function's own resume", () => {
    // Retired premise: through A2c slice 5, genResume emission was
    // entirely unimplemented (stage A3), so this same module refused at
    // expr:genResume — proving the HOIST_SLOTS entry moved WHERE the
    // refusal fired, not WHETHER it fired. A3's first sub-slice (mode:
    // "next") changes the answer: this exact shape — genResume beside an
    // await, embedded in an ORDINARY ASYNC function's own resume body,
    // never a generator's — now compiles clean end to end. `genResume`
    // is not generator-only (the design doc's own framing): any
    // function, async or not, may hold and drive a generator, and this
    // is the proof that composition works at the EMITTER layer, not
    // just the hoister. Logging `r.0.done` rather than `r.0` itself
    // sidesteps a wholly unrelated, pre-existing limitation (console.log
    // of a raw record needs the frontend's own inspect-lowering, which
    // this hand-built module has no frontend pass to run — see the S041
    // test's identical workaround).
    const { type: recT, records, unions } = genResultType();
    const doneRead: IrExpr = { kind: "recordGet", obj: v("r.0", recT), shapeId: recT.shapeId, field: "done", type: BOOL, loc };
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
        log([doneRead]),
      ],
      loc,
    };
    const survey = surveyWasmModule({ ...asyncModule(fn), records, unions });
    expect(survey).toEqual([]);
  });
});

/* ── 12. increment 19 stages A2b through A2c-5: yield lowering,
 * completion, and (as of A2c slice 5) `run()` itself ────────────────────
 *
 * FunctionLowering is exported beyond this describe block now (A2c
 * slice 5's gate widening — see the class's own doc comment): a real
 * generator reaches `lowerResumableFunctions`/`run()` through the
 * ordinary compiled path today, the same as an async function always
 * has. This describe block predates that and still constructs
 * FunctionLowering directly for most of its tests, which stays valid —
 * direct construction isolates ONE piece of the lowering the same way
 * house rule #9 (increment 18) already established for builder-level
 * flag-true branches; it is a CHOICE now, not the only way in.
 *
 * DEFERRAL, restated exactly (statemachine.ts's own header/guard-site
 * comments carry the canonical wording — this note must never drift
 * from it): A2c slice 5 means GENERATOR BODIES COMPILE AND THE WRAPPER
 * IS LAZY. It does not mean generators WORK — genResume's CONSUMER-side
 * state ladder (stage A3) is unbuilt, and `expr:genResume` still refuses
 * by name at the emitter for any program that actually drives one. AND
 * yields in unhoistable/finalizer/switch/forof positions decline under
 * named `fn:generator:*` refusals until their own machinery lands —
 * never under the `fn:async:*` names the shared position-checking
 * machinery would otherwise report on a body with no `await` in it.
 *
 * SCOPE NOTE (A2b gate's F2 finding — a GUARD, not documentation, now
 * HISTORY): `completion()`/`fellThrough()`, `buildWrapper()`, and
 * `catchArm()` all branch on genType — nothing in the PASS
 * unconditionally names PROMISE_FIELD or emits an async-only op for a
 * generator. `run()`'s own guard (`fn:async:generator-wrapper-not-built`)
 * is GONE as of this slice — the "run() declines a generator outright"
 * test that used to pin it is retired below, replaced by a test pinning
 * the opposite: `run()` now SUCCEEDS for an eligible generator, the same
 * as it always has for async. Most of these tests still use
 * `runFrameAndStatesForTest()`/`buildWrapperForTest()`/
 * `buildResumeForTest()` where isolating ONE piece is the point of the
 * test — that reasoning is unchanged by the guard's removal, since those
 * methods were never ABOUT dodging the guard, only about narrowing scope
 * (see each method's own doc comment). */
describe("yield lowering (stage A2b — FunctionLowering used directly)", () => {
  const genLoc = loc;
  const yieldExpr = (value: IrExpr | null, type: IrType): IrExpr => ({ kind: "yieldExpr", value, type, loc: genLoc });

  function genModule(fn: IrFunction): IrModule {
    return { irVersion: 3, sourceFile: "gen.ts", entry: "%main", functions: [fn] };
  }

  test("run() now succeeds for an eligible generator — the guard is gone (A2c slice 5)", () => {
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
    const result = new FunctionLowering(genModule(fn), fn, (kind) => refusals.push(kind)).run();
    expect(refusals).toEqual([]);
    // The wrapper's own return type is the generator type itself, never
    // a promise — buildWrapper's generator branch (A2c slice 2), now
    // reached for real rather than only through buildWrapperForTest().
    expect(result.wrapper.returnType).toEqual({ kind: "generator", yieldT: F64, retT: F64, nextT: F64 });
    expect(result.frame.fields.some((f) => f.name === "%gen")).toBe(true);
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

  test("a yield with a value and a real nextT: suspend carries the operand through its own frame slot (evaluated before saves(), mirroring await), injectCheck runs on re-entry, sent is read back", () => {
    // Stage C's fix (found live via 2454's Feed/#emit()/takeTwo() — Node
    // "0+1@2", this pass then "0+0@0"): a suspending yield's operand must
    // evaluate into its OWN frame slot BEFORE saves() runs, exactly like
    // await's own `this.set(awaitSlot, node.value)` already did — a
    // side-effecting operand (`yield i++`) embedded straight into
    // %gen.suspend's own value field (the pre-fix shape this test used to
    // assert) evaluates AFTER saves() already captured the frame, so the
    // side effect never survives a suspend/resume round trip. This test's
    // OWN operand (`num(1)`) has no side effect to lose, but the slot
    // indirection is unconditional (matching await, which never
    // special-cases a stable operand either) — so the assertion here
    // checks the NEW shape, not merely a no-op-for-this-operand detail.
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

    // The slot write happens before saves() — a recordSet into a fresh
    // "%awaitN" frame field, holding the literal 1.
    const slotWrite = nodesOfKind(states, "recordSet").find(
      (r) => String(r["field"]).startsWith("%await") && (r["value"] as { kind?: string })?.kind === "numLit",
    );
    expect(slotWrite).toMatchObject({ value: { kind: "numLit", value: 1 } });
    const slotName = slotWrite!["field"] as string;

    const suspend = nodesOfKind(states, "%gen.suspend");
    expect(suspend).toHaveLength(1);
    // %gen.suspend's own value is now a READ of that same slot, not the
    // raw operand re-embedded (which would evaluate it a second time).
    expect(suspend[0]).toMatchObject({ value: { kind: "recordGet", field: slotName } });

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

  test("the lazy wrapper: %gen.new after the frame, frame.%gen written back, $gen returned, NO resume call", () => {
    const genT: IrType = { kind: "generator", yieldT: F64, retT: F64, nextT: F64 };
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: F64 },
      locals: [],
      body: [exprStmt(yieldExpr(num(1), F64))],
      loc: genLoc,
    };
    const wrapper = new FunctionLowering(genModule(fn), fn, () => {}).buildWrapperForTest();

    // Call sites see the generator type itself, never a promise.
    expect(wrapper.returnType).toEqual(genT);

    // %gen.new appears exactly once, and its "frame" operand names the
    // SAME local the frame varDecl just bound — the ordering constraint
    // (frame built first, since $gen.new needs the reference) is a
    // property of construction, checked here as a value-level fact.
    const genNew = nodesOfKind(wrapper.body, "%gen.new");
    expect(genNew).toHaveLength(1);
    expect(genNew[0]).toMatchObject({ frame: { kind: "varRef", localId: "%async.frame" } });

    // The write-back: frame.%gen = the new $gen (a recordSet naming the
    // %gen field on the frame shape).
    const genFieldWrites = nodesOfKind(wrapper.body, "recordSet").filter((n) => n["field"] === "%gen");
    expect(genFieldWrites).toHaveLength(1);

    // NO eager kick: a generator body runs nothing until the first
    // `.next()` — resumeClosure() only builds a closure VALUE ($gen's
    // `resume` field), never invokes it, so neither call shape the async
    // kick would have used ("call" the direct form, "callValue" the
    // captures-through-a-closure form) should appear anywhere.
    expect(nodesOfKind(wrapper.body, "call")).toEqual([]);
    expect(nodesOfKind(wrapper.body, "callValue")).toEqual([]);

    // NO async-only construction leaks in either: %async.mint (there is
    // no promise to mint) and the module-initializer cache ops (a
    // generator function is never a module initializer).
    for (const kind of ["%async.mint", "%async.cacheCheck", "%async.markHandled"]) {
      expect(nodesOfKind(wrapper.body, kind)).toEqual([]);
    }

    // The final statement returns $gen, not a promise.
    const ret = wrapper.body[wrapper.body.length - 1];
    expect(ret).toMatchObject({ kind: "return", value: { kind: "varRef", localId: "%gen.wrapper" } });
  });

  test("catchArm, no protected region: the routing-table default forks on GENRET vs a real exception", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: F64 },
      locals: [],
      body: [exprStmt(yieldExpr(num(1), F64))],
      loc: genLoc,
    };
    const resume = new FunctionLowering(genModule(fn), fn, () => {}).buildResumeForTest();
    const table = routing(resume);
    expect(table).toHaveLength(1);
    expect(table[0]!.test).toBeNull();

    const arm = table[0]!.body;
    expect(arm).toHaveLength(1);
    const fork = arm[0]!;
    expect(fork.kind).toBe("if");
    if (fork.kind !== "if") throw new Error("unreachable");
    expect(fork.cond).toMatchObject({ kind: "%gen.excIsGenret", caught: { localId: "%async.exc" } });

    // GENRET: promote retPark into out and complete, through %gen.complete
    // — never a bespoke write of its own (see %gen.retPark's doc comment).
    const complete = nodesOfKind(fork.then, "%gen.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ value: { kind: "%gen.retPark" } });
    expect(fork.then[fork.then.length - 1]).toMatchObject({ kind: "return" });

    // Real exception: state=DONE alone (out untouched) and rethrow — the
    // cell stays set for genResume's own post-call pending check, never
    // %async.reject (there is no promise to reject).
    expect(fork.else_).not.toBeNull();
    const elseBody = fork.else_!;
    expect(nodesOfKind(elseBody, "%gen.markDone")).toHaveLength(1);
    expect(elseBody[elseBody.length - 1]).toMatchObject({ kind: "rethrow", localId: "%async.exc" });
    expect(nodesOfKind(resume.body, "%async.reject")).toEqual([]);
  });

  test("catchArm, a protected region: the sentinel prologue reuses the SAME genretExit as the default, never binds a GENRET", () => {
    const fn: IrFunction = {
      name: "g",
      params: [],
      returnType: F64,
      generator: { yieldT: F64, nextT: F64 },
      locals: [local("e.0", CAUGHT)],
      body: [tryCatch([exprStmt(yieldExpr(num(1), F64))], "e.0", [log([str("caught")])])],
      loc: genLoc,
    };
    const resume = new FunctionLowering(genModule(fn), fn, () => {}).buildResumeForTest();
    const table = routing(resume);

    // A real protected region exists now: more than just the default.
    const defaultArm = table.find((c) => c.test === null)!;
    const regionArm = table.find((c) => c.test !== null)!;
    expect(defaultArm).toBeDefined();
    expect(regionArm).toBeDefined();

    // The sentinel prologue is the region arm's FIRST statement — before
    // the binding, before the saves, before the state write. A GENRET
    // reaching this arm returns from inside the prologue and never
    // executes any of what follows.
    const prologue = regionArm.body[0]!;
    expect(prologue.kind).toBe("if");
    if (prologue.kind !== "if") throw new Error("unreachable");
    expect(prologue.cond).toMatchObject({ kind: "%gen.excIsGenret", caught: { localId: "%async.exc" } });
    expect(prologue.else_).toBeNull();

    // The binding still follows, for the NON-genret path that falls
    // through the prologue's guard.
    const bindingIndex = regionArm.body.findIndex((s) => s.kind === "assign" && s.localId === "e.0");
    expect(bindingIndex).toBeGreaterThan(0);

    // "Single DEFINITION site, consumed by every exit": the default
    // arm's own GENRET branch and the region's sentinel prologue produce
    // STRUCTURALLY IDENTICAL statements — genretExit() is a method now
    // (stage B), not a single shared local, because lowerTry's own
    // finally re-raise (reraisePending) needs it too, from a DIFFERENT
    // pass (lowering) than catchArm's (post-lowering, resume-building) —
    // the two can never share one array reference across that boundary.
    // Content equality is what the wasm output actually cares about;
    // object identity was always an implementation detail, not the
    // invariant this test means to pin.
    const defaultFork = defaultArm.body[0]!;
    expect(defaultFork.kind).toBe("if");
    if (defaultFork.kind !== "if") throw new Error("unreachable");
    expect(prologue.then).toStrictEqual(defaultFork.then);
  });

  // 2010-generators-basics.ts's two(): Generator<string, void, unknown> is
  // the exact corpus shape both regression tests below isolate. void is
  // not a real V arm (only undefinedT spells "no value" —
  // computeGenResultArms's own add() drops void channels entirely), so
  // genretExit's promotion must normalize to undefined the SAME way
  // completion()'s own void branch already does, rather than reading
  // %gen.retPark typed void — which crashed emitGenOutValue the moment
  // gate-widening let a real void-retT generator reach it.
  //
  // TWO shapes, not one: genretExit is built ONCE and consumed by BOTH
  // catchArm exits (the "single construction site" property its own
  // tests above already pin) — the routing-table DEFAULT arm always
  // contains it, with or without any try/catch in the body at all, since
  // `byHandler.size === 0` still returns `defaultArm`. The bug's true
  // trigger is void retT, full stop — a protected region was never
  // required to reach it, only sufficient. The reviewer's own read of
  // the fix (normalizing at genretExit's construction site, not per
  // consumer) predicts both shapes are already covered by the ONE fix;
  // these two tests are what PROVES that instead of assuming it.
  test("catchArm's GENRET exit on a VOID retT, NO protected region — the common corpus shape, hits the routing default directly (regression)", () => {
    const fn: IrFunction = {
      name: "two",
      params: [],
      returnType: VOID,
      generator: { yieldT: STRING, nextT: F64 },
      locals: [],
      body: [exprStmt(yieldExpr({ kind: "strLit", value: "x", type: STRING, loc: genLoc }, STRING))],
      loc: genLoc,
    };
    const resume = new FunctionLowering(genModule(fn), fn, () => {}).buildResumeForTest();
    const table = routing(resume);
    // No protected region at all: routing() answers ONE entry, the
    // default (see the "no protected region" test in section 11 above
    // for the same shape without the void-retT angle).
    expect(table).toHaveLength(1);
    const defaultFork = table[0]!.body[0]!;
    expect(defaultFork.kind).toBe("if");
    if (defaultFork.kind !== "if") throw new Error("unreachable");

    const complete = nodesOfKind(defaultFork.then, "%gen.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]!["value"]).toBeNull();
    expect(nodesOfKind(defaultFork.then, "%gen.retPark")).toEqual([]);
  });

  test("catchArm's GENRET exit on a VOID retT, WITH a protected region — the sentinel prologue's own copy of genretExit (regression)", () => {
    const fn: IrFunction = {
      name: "two",
      params: [],
      returnType: VOID,
      generator: { yieldT: STRING, nextT: F64 },
      locals: [local("e.0", CAUGHT)],
      body: [tryCatch([exprStmt(yieldExpr({ kind: "strLit", value: "x", type: STRING, loc: genLoc }, STRING))], "e.0", [
        log([str("caught")]),
      ])],
      loc: genLoc,
    };
    const resume = new FunctionLowering(genModule(fn), fn, () => {}).buildResumeForTest();
    const table = routing(resume);
    const defaultArm = table.find((c) => c.test === null)!;
    const defaultFork = defaultArm.body[0]!;
    expect(defaultFork.kind).toBe("if");
    if (defaultFork.kind !== "if") throw new Error("unreachable");

    const complete = nodesOfKind(defaultFork.then, "%gen.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]!["value"]).toBeNull();
    expect(nodesOfKind(defaultFork.then, "%gen.retPark")).toEqual([]);

    // The region arm's own sentinel prologue is STRUCTURALLY IDENTICAL
    // to the default arm's own genretExit (content equality — see the
    // "single construction site" test above for why this is no longer
    // reference identity as of stage B: genretExit() is a re-callable
    // method now, needed from lowerTry's finally re-raise too, a
    // DIFFERENT pass than catchArm's own) — so it is ALREADY covered by
    // the assertions on defaultFork.then above; this just makes that
    // coverage explicit for the void-retT shape specifically, rather
    // than relying on the reader to trace it back to the default arm.
    const regionArm = table.find((c) => c.test !== null)!;
    const prologue = regionArm.body[0]!;
    expect(prologue.kind).toBe("if");
    if (prologue.kind !== "if") throw new Error("unreachable");
    expect(prologue.then).toStrictEqual(defaultFork.then);
  });
});

/* ── 12. A2c slice 4a: the six non-retag %gen.* seam-op emissions ────────
 *
 * `%gen.new`/`%gen.sent`/`%gen.retPark`/`%gen.markDone`/`%gen.injectCheck`/
 * `%gen.excIsGenret` have real emitter implementations now — plain struct
 * field reads/writes over generators.ts's $gen<triple>, none of them
 * needing the value-into-V retag machinery `%gen.suspend`/`%gen.complete`
 * still refuse pending (a separate, deferred design question — see the
 * commit history around this test). The pass itself cannot reach any of
 * these yet (fn:generator still gates every generator body before it is
 * ever walked), so — exactly like S041 and the increment-18 bytes
 * validate-sweep before it — this hand-builds a module that USES them
 * directly, bypassing both the frontend and the pass, and runs it through
 * the REAL wasm emitter (surveyWasmModule + emitWasmModule, never a mock).
 *
 * REACHABILITY NOTE (read before extending this test): nothing in the
 * CURRENTLY BUILT op set can write `$gen.inject` — that is genResume's
 * job, stage A3, not yet built — so `%gen.injectCheck`'s GENRET arm (the
 * tag-write) and `%gen.excIsGenret`'s TRUE outcome are proven only
 * STRUCTURALLY here (their bytecode is emitted and WebAssembly.validate
 * checks it STATICALLY, regardless of which branch a given run actually
 * takes) — not BEHAVIORALLY, since nothing can drive `$gen.inject` to
 * GENRET yet. Stage A3's own tests are what will exercise that path for
 * real. This is a fact about the dependency graph between these ops, not
 * a gap in this test. */
describe("A2c slice 4a: %gen.new / %gen.sent / %gen.retPark / %gen.markDone / %gen.injectCheck / %gen.excIsGenret", () => {
  const g4Loc = loc;
  const genT: IrType = { kind: "generator", yieldT: F64, retT: BOOL, nextT: F64 };
  const frameShapeId = "%frame.g4a";
  const frameT: IrType = { kind: "record", shapeId: frameShapeId };

  function buildModule(): IrModule {
    // %g.resume(frameBase) -> void: trivial and never invoked — there is
    // no read-accessor for $gen.resume at the pass level (genResume,
    // stage A3, is the only future consumer), so this test proves
    // %gen.new emits VALID, correctly-typed bytecode STORING the
    // closure, not that it is later called. %gen.new's own operand
    // (frame/resume) type-correctness is exactly what WebAssembly.validate
    // below checks: a wrongly-typed store into either field fails
    // validation, not merely silently reading back wrong.
    const resumeFn: IrFunction = {
      name: "%g.resume",
      params: [{ localId: "%f", name: "%f", type: FRAME_BASE }],
      returnType: VOID,
      locals: [],
      body: [ret(null)],
      loc: g4Loc,
    };

    const frameInit: IrExpr = {
      kind: "recordLit",
      fields: [{ name: "%l_x", value: num(99) }],
      type: frameT,
      loc: g4Loc,
    };
    const resumeClosure: IrExpr = {
      kind: "closure",
      fnName: "%g.resume",
      captures: [],
      type: { kind: "func", params: [FRAME_BASE], ret: VOID },
      loc: g4Loc,
    };

    const body: IrStmt[] = [
      varDecl("frame.0", frameInit),
      varDecl("g.0", {
        kind: "%gen.new",
        frame: v("frame.0", frameT),
        resume: resumeClosure,
        type: genT,
        loc: g4Loc,
      } as unknown as IrExpr),
      // Defaults: nothing has written sent/retPark yet.
      log([{ kind: "%gen.sent", gen: v("g.0", genT), type: F64, loc: g4Loc } as unknown as IrExpr]),
      log([{ kind: "%gen.retPark", gen: v("g.0", genT), type: BOOL, loc: g4Loc } as unknown as IrExpr]),
      { kind: "%gen.markDone", gen: v("g.0", genT), loc: g4Loc } as unknown as IrStmt,
      // NEXT (the struct's own default, 0) — the only dynamically
      // reachable path today; see the describe block's REACHABILITY NOTE.
      { kind: "%gen.injectCheck", gen: v("g.0", genT), loc: g4Loc } as unknown as IrStmt,
      log([str("next-fell-through")]),
      // excIsGenret's FALSE case: an ordinary real exception's kind
      // (EXC_STR here) is never the GENRET tag.
      tryCatch(
        [{ kind: "throw", value: str("boom"), loc: g4Loc }],
        "e.0",
        [log([{ kind: "%gen.excIsGenret", caught: v("e.0", CAUGHT), type: BOOL, loc: g4Loc } as unknown as IrExpr])],
      ),
    ];

    return {
      irVersion: 3,
      sourceFile: "g4a.ts",
      entry: "%main",
      records: [{ id: frameShapeId, fields: [{ name: "%l_x", type: F64 }] }],
      functions: [
        resumeFn,
        {
          name: "%main",
          params: [],
          returnType: VOID,
          locals: [
            local("frame.0", frameT),
            local("g.0", genT),
            local("e.0", CAUGHT),
          ],
          body,
          loc: g4Loc,
        },
      ],
    };
  }

  test("survey clean: none of the six ops refuse", () => {
    expect(surveyWasmModule(buildModule())).toEqual([]);
  });

  test("emits a VALID module (WebAssembly.validate) and runs it: sent/retPark defaults, injectCheck's NEXT fallthrough, excIsGenret false", async () => {
    const mod = buildModule();
    const bytes = emitWasmModule(mod);
    expect(WebAssembly.validate(bytes)).toBe(true);

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

    expect(stdout).toBe(["0", "false", "next-fell-through", "false", ""].join("\n"));
  });
});

/* ── 13. A2c slice 4b groundwork: computeGenResultArms, shared by
 * construction with genResultRecord ──────────────────────────────────────
 *
 * The wasm backend's `%gen.suspend`/`%gen.complete` will need V's exact
 * arm list to find a concrete operand's TAG — a wrong tag is a SILENT
 * miscompile (a struct.new_default wraps the wrong arm; nothing traps),
 * never a validation failure, so generators.ts imports this function
 * rather than re-deriving genResultRecord's arm-computation locally (the
 * increment-6/7/10 "keyed by the full triple, never twice" lesson,
 * increment 13's vtable-numbering precedent — shared by construction).
 * These tests pin that the FACTORED function still agrees with
 * genResultRecord's own (unchanged) behavior for representative shapes,
 * including the case that makes this non-optional: 2014-generators-
 * values.ts's `mixed(): Generator<number | string, void, unknown>` — a
 * REAL union yield channel in the 12-program target set, not a
 * hypothetical corner. */
describe("computeGenResultArms: shared by construction with genResultRecord", () => {
  test("a concrete (f64, void) channel pair: arms are exactly [f64, undefined], matching genResultRecord's own union", () => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const result = computeGenResultArms(F64, VOID, (id) => unions.get(id)?.arms ?? []);
    expect(result?.kind).toBe("arms");
    if (result?.kind !== "arms") throw new Error("unreachable");
    expect(result.arms).toHaveLength(2);
    expect(result.arms.some((a) => a.kind === "f64")).toBe(true);
    expect(result.arms.some((a) => a.kind === "undefinedT")).toBe(true);

    // Cross-check: genResultRecord's OWN interned union (built through the
    // UNCHANGED path — unions.intern) has the identical arm set.
    const rec = genResultRecord(F64, VOID, shapes, unions);
    if (rec === null) throw new Error("genResultRecord returned null");
    const shape = shapes.get(rec.shapeId)!;
    const valueField = shape.fields.find((f) => f.name === "value")!;
    if (valueField.type.kind !== "union") throw new Error("expected a union value field");
    const realArms = unions.get(valueField.type.unionId)!.arms;
    expect(realArms.map((a) => a.kind).sort()).toEqual(result.arms.map((a) => a.kind).sort());
  });

  test("either channel dyn: reports \"dyn\", matching genResultRecord's DYN short-circuit", () => {
    const result = computeGenResultArms(DYN, F64, () => []);
    expect(result).toEqual({ kind: "dyn" });

    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const rec = genResultRecord(DYN, F64, shapes, unions);
    if (rec === null) throw new Error("genResultRecord returned null");
    const shape = shapes.get(rec.shapeId)!;
    expect(shape.fields.find((f) => f.name === "value")!.type).toEqual(DYN);
  });

  test("a UNION yield channel (2014-generators-values.ts's mixed(): Generator<number | string, void, unknown>): V flattens yieldT's own arms in, never nests the union", () => {
    const unions = new UnionRegistry();
    const yieldUnionArms = [F64, STRING].sort((a, b) => (a.kind < b.kind ? -1 : 1));
    const yieldUnionId = unions.intern(yieldUnionArms);
    const yieldT: IrType = { kind: "union", unionId: yieldUnionId };

    const result = computeGenResultArms(yieldT, VOID, (id) => unions.get(id)?.arms ?? []);
    expect(result?.kind).toBe("arms");
    if (result?.kind !== "arms") throw new Error("unreachable");
    // Three arms: f64, string (flattened out of yieldT's own union — never
    // "yieldT" as one opaque arm), and the unconditional undefined arm
    // (exhausted .next() answers undefined) — never fewer, never nested.
    expect(result.arms).toHaveLength(3);
    expect(result.arms.map((a) => a.kind).sort()).toEqual(["f64", "string", "undefinedT"]);

    // Cross-check against genResultRecord's own real union, built through
    // the SAME UnionRegistry (so a real .next() consumer's extractYieldValue
    // would resolve tags against this exact union).
    const shapes = new ShapeRegistry();
    const rec = genResultRecord(yieldT, VOID, shapes, unions);
    if (rec === null) throw new Error("genResultRecord returned null");
    const shape = shapes.get(rec.shapeId)!;
    const valueField = shape.fields.find((f) => f.name === "value")!;
    if (valueField.type.kind !== "union") throw new Error("expected a union value field");
    const realArms = unions.get(valueField.type.unionId)!.arms;
    expect(realArms.map((a) => a.kind).sort()).toEqual(result.arms.map((a) => a.kind).sort());
  });

  test("a degenerate no-value generator (void yield, void return): reports \"degenerate\", matching genResultRecord's unitOnlyUnion", () => {
    const result = computeGenResultArms(VOID, VOID, () => []);
    expect(result).toEqual({ kind: "degenerate" });

    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const rec = genResultRecord(VOID, VOID, shapes, unions);
    if (rec === null) throw new Error("genResultRecord returned null");
    const shape = shapes.get(rec.shapeId)!;
    const valueField = shape.fields.find((f) => f.name === "value")!;
    if (valueField.type.kind !== "union") throw new Error("expected a union value field");
    const realArms = unions.get(valueField.type.unionId)!.arms;
    expect(realArms.map((a) => a.kind).sort()).toEqual(["nullT", "undefinedT"]);
  });
});

/* ── 14. A2c slice 4b: %gen.suspend / %gen.complete real emission ────────
 *
 * The two ops that retag a raw yieldT/retT-typed operand into $gen.out's
 * V representation — built on `emitGenOutValue` and the new
 * `UnionBuilder.retag` dispatch helper (unions.ts). There is no read-
 * accessor for $gen.out at the pass level (only genResume, stage A3,
 * unbuilt, will ever read it), so these tests stay STRUCTURAL —
 * survey-clean + WebAssembly.validate across the three representation
 * shapes (concrete arm, union-channel retag, dyn-channel) — the SAME
 * bar slice 4a's %gen.new held for the frame/resume fields it also could
 * not read back. The retag MECHANISM's own correctness (tag numbers AND
 * payloads, end to end through a real WebAssembly.instantiate) is
 * covered independently in wasm-unions-validate.test.ts, which calls
 * `UnionBuilder.retag` directly — the union-channel test below confirms
 * this pass/emitter combination actually REACHES that mechanism for a
 * real generator shape, not that the mechanism itself is correct. */
describe("A2c slice 4b: %gen.suspend / %gen.complete real emission (retag)", () => {
  const g4bLoc = loc;

  /** Direct construction, the SAME pattern slice 4a's %gen.new/%gen.sent/
   * etc. tests use — never through FunctionLowering/the pass. `gen:
   * v("g.0", genT)` reads straight off the local %gen.new just filled;
   * %gen.suspend/%gen.complete only care about that expression's STATIC
   * TYPE, never how it was obtained, so there is no need for a frame
   * shape, a frame local, or a write-back here at all (unlike the real
   * wrapper, which threads $gen through `frame.%gen` because resume
   * only ever holds the frame — irrelevant to what this file tests). */
  function genModule4b(genT: IrType, resumeName: string, resumeParams: IrParam[], body: IrStmt[]): IrModule {
    const resumeFn: IrFunction = {
      name: resumeName,
      params: resumeParams,
      returnType: VOID,
      locals: [],
      body: [ret(null)],
      loc: g4bLoc,
    };
    const genLocal: IrLocal = { id: "g.0", name: "g.0", type: genT, mutable: false };
    // A FRAME_BASE-typed local, never assigned — wasm's own default-zero
    // rule gives it `ref.null`, which is all %gen.new's `frame` operand
    // needs to exist as HERE (it is stored, never dereferenced — no
    // resume call happens in this file, so a real frame is never read).
    const frameSlot: IrLocal = { id: "frameSlot", name: "frameSlot", type: FRAME_BASE, mutable: false };
    return {
      irVersion: 3,
      sourceFile: "g4b.ts",
      entry: "%main",
      functions: [
        resumeFn,
        {
          name: "%main",
          params: [],
          returnType: VOID,
          locals: [genLocal, frameSlot],
          body: [
            varDecl("g.0", {
              kind: "%gen.new",
              frame: v("frameSlot", FRAME_BASE),
              resume: { kind: "closure", fnName: resumeName, captures: [], type: { kind: "func", params: [FRAME_BASE], ret: VOID }, loc: g4bLoc },
              type: genT,
              loc: g4bLoc,
            } as unknown as IrExpr),
            ...body,
          ],
          loc: g4bLoc,
        },
      ],
    };
  }

  test("concrete arm + a void return (null value): both survey clean and emit a VALID module", () => {
    const genT: IrType = { kind: "generator", yieldT: F64, retT: VOID, nextT: F64 };
    const mod = genModule4b(genT, "%stub.resume1", [{ localId: "%f", name: "%f", type: FRAME_BASE }], [
      { kind: "%gen.suspend", gen: v("g.0", genT), value: num(1), loc: g4bLoc } as unknown as IrStmt,
      { kind: "%gen.complete", gen: v("g.0", genT), value: null, loc: g4bLoc } as unknown as IrStmt,
    ]);
    expect(surveyWasmModule(mod)).toEqual([]);
    expect(WebAssembly.validate(emitWasmModule(mod))).toBe(true);
  });

  test("a UNION yield channel (2014-generators-values.ts's mixed() shape): %gen.suspend reaches unions.ts's retag helper for a real generator", () => {
    const unions = new UnionRegistry();
    const yieldUnionArms = [F64, STRING].sort((a, b) => (a.kind < b.kind ? -1 : 1));
    const yieldUnionId = unions.intern(yieldUnionArms);
    const yieldT: IrType = { kind: "union", unionId: yieldUnionId };
    const f64Tag = unions.get(yieldUnionId)!.arms.findIndex((a) => a.kind === "f64");
    const strTag = unions.get(yieldUnionId)!.arms.findIndex((a) => a.kind === "string");
    const genT: IrType = { kind: "generator", yieldT, retT: VOID, nextT: UNDEFINED_T };

    const mod = genModule4b(genT, "%stub.resume2", [{ localId: "%f", name: "%f", type: FRAME_BASE }], [
      {
        kind: "%gen.suspend",
        gen: v("g.0", genT),
        value: { kind: "unionWrap", unionId: yieldUnionId, tag: f64Tag, value: num(1), type: yieldT, loc: g4bLoc },
        loc: g4bLoc,
      } as unknown as IrStmt,
      {
        kind: "%gen.suspend",
        gen: v("g.0", genT),
        value: { kind: "unionWrap", unionId: yieldUnionId, tag: strTag, value: str("two"), type: yieldT, loc: g4bLoc },
        loc: g4bLoc,
      } as unknown as IrStmt,
    ]);
    mod.unions = unions.unions;
    expect(surveyWasmModule(mod)).toEqual([]);
    const bytes = emitWasmModule(mod);
    expect(WebAssembly.validate(bytes)).toBe(true);
  });

  test("a dyn channel (retT dyn): a concrete yield operand gets boxed via dynFrom, an already-dyn one passes through unchanged", () => {
    // retT dyn (unlike yieldT, kept concrete here) makes $gen.out
    // dyn-typed per genResultRecord's "dyn if EITHER channel is dyn"
    // rule — exactly the case that needs dynFrom boxing
    // (emitGenOutValue's first branch) for the concrete F64 operand.
    const genT: IrType = { kind: "generator", yieldT: F64, retT: DYN, nextT: F64 };
    const mod = genModule4b(genT, "%stub.resume3", [{ localId: "%f", name: "%f", type: FRAME_BASE }], [
      { kind: "%gen.suspend", gen: v("g.0", genT), value: num(1), loc: g4bLoc } as unknown as IrStmt,
      // An operand that is ALREADY dyn-typed (e.g. a return value on a
      // dyn retT channel) should ride through unchanged — no double box.
      {
        kind: "%gen.complete",
        gen: v("g.0", genT),
        value: { kind: "dynFrom", value: num(2), type: DYN, loc: g4bLoc },
        loc: g4bLoc,
      } as unknown as IrStmt,
    ]);
    expect(surveyWasmModule(mod)).toEqual([]);
    expect(WebAssembly.validate(emitWasmModule(mod))).toBe(true);
  });
});

/* ── Stage B: the finalizer-park write-discipline regressions ───────────
 *
 * Full source, compiled through `compile()` — NOT hand-built IR like the
 * rest of this file. The shape under test (a THROW injection parking at
 * one finally, whose own suspend crosses into a SECOND, enclosing
 * finally that ALSO suspends) depends on checkEligible/hoistStmt/lowerTry
 * all agreeing with each other and with the frontend's own try/finally
 * desugar in a way that hand-building the equivalent IR would only prove
 * for whatever shape I happened to construct by hand, not for what real
 * source actually produces — the exact gap that let TWO real bugs (one
 * crash, one silent miscompile) ship past this file's own earlier,
 * hand-built stage B coverage above. `compile()` is the only way to get
 * the real pipeline running end to end.
 *
 * Every pin here follows the explicit unfreeze's three requirements:
 * (1) assert the OUTCOME (the actual propagated value/error), never
 * internal state like %pending.kind directly; (2) assert the absence of
 * a trap EXPLICITLY, not merely by omission (board #49: the corpus
 * harness's stdout+exit-code diff is blind to a trap that happens after
 * partial, otherwise-correct-looking output — exactly the shape the
 * silent-miscompile round of this bug could have hidden behind if the
 * pin only checked stdout); (3) each was manually verified, before this
 * file was finalized, to FAIL when the fix is disabled on a scratch copy
 * (parkThrow reverted to reading the exception cell directly instead of
 * `excRef`) — this is a verification step performed once by hand while
 * writing these pins, not an automated check this suite re-runs. */
describe("stage B: parkThrow write discipline (full-source regressions)", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-stageb-"));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function buildWasm(name: string, source: string) {
    const entry = join(scratch, name);
    await writeFile(entry, source);
    return compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  }

  /** Runs to completion and returns stdout — but unlike wasm-emitter.test.ts's
   * bare `runWasm`, this NEVER lets a trap pass silently: `_start` is
   * called inside its own try/catch and a WebAssembly.RuntimeError is
   * asserted NOT to have happened, explicitly, satisfying requirement
   * (2) for every pin that expects a clean run (the run may still
   * observe a THROWN JS Error, caught by the compiled program's OWN
   * source-level try/catch — that is a normal return, not a trap). */
  async function runWasmExpectNoTrap(modulePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (memory === null) throw new Error("write before instantiation completed");
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    const trap = await Promise.resolve()
      .then(() => (instance.exports["_start"] as () => void)())
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(trap).toBeNull();
    return Buffer.concat(chunks).toString("utf8");
  }

  /** The inverse of the above: for the ONE shape that should propagate
   * all the way to an uncaught, module-wide trap (mirroring Node's own
   * uncaught-exception exit), assert the trap explicitly rather than
   * treating "the await rejected" as incidental.
   *
   * F5 (round 3, reviewer's substance gate): `toBeInstanceOf(RuntimeError)`
   * ALONE does not discriminate — the round-1 null-pointer crash (a
   * `structGet` dereferencing a null ref, `rethrow`'s stale per-invocation
   * EXC_LOCAL) is ALSO a WebAssembly.RuntimeError, with a DIFFERENT
   * message ("null pointer" family, not "unreachable"); the reviewer ran
   * this exact pin against the historical broken compiler and it PASSED
   * for the wrong reason. `_start`'s own uncaught-exception bridge
   * (S007) is a deliberate `c.unreachable()` opcode — V8/Node's own
   * WebAssembly.RuntimeError for that specific trap reports the message
   * "unreachable" — so asserting the message is what actually proves
   * "this trapped because the exception legitimately reached `_start`'s
   * own check", not "this trapped for some unrelated reason that merely
   * also throws a RuntimeError". */
  async function runWasmExpectTrap(modulePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (memory === null) throw new Error("write before instantiation completed");
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    const trap = await Promise.resolve()
      .then(() => (instance.exports["_start"] as () => void)())
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(trap).toBeInstanceOf(WebAssembly.RuntimeError);
    expect((trap as WebAssembly.RuntimeError).message).toBe("unreachable");
    return Buffer.concat(chunks).toString("utf8");
  }

  /** For a timer-bearing async body specifically (round 3's F7/varI/varJ):
   * `runWasmExpectNoTrap`'s bare `write`-only import never pumps `_tick`,
   * so a program with a real `setTimeout` inside an awaited chain simply
   * stalls — the reviewer's own ad-hoc host hit exactly this and nearly
   * produced a false finding. Mirrors the differential harness's own host
   * contract (and inc19-probes/wasm-host.mjs, this session's standalone
   * copy of it): a virtual `tsinter.now` clock, `_start` then `_tick`
   * pumped to quiescence (a due time < 0 means nothing left pending), a
   * trap is exit-code 1, `_status` (when present) is the real exit code
   * otherwise. Programs with no `_tick` export (nothing timer-shaped
   * survived lowering) skip the pump entirely, so this is safe to use
   * even where the pump never actually engages. */
  async function runWasmWithTimers(modulePath: string): Promise<{ stdout: string; exitCode: number }> {
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    let clock = 0;
    const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (memory === null) throw new Error("write before instantiation completed");
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
        },
        now: () => clock,
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    let exitCode = 0;
    try {
      (instance.exports["_start"] as () => void)();
      const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
      if (tick !== undefined) {
        for (let turns = 0; ; turns++) {
          if (turns > 1_000_000) throw new Error("pump did not settle");
          const due = tick(clock);
          if (due < 0) break;
          clock = Math.max(clock, due);
        }
      }
      const status = instance.exports["_status"] as (() => number) | undefined;
      if (status !== undefined) exitCode = status();
    } catch (err) {
      if (!(err instanceof WebAssembly.RuntimeError)) throw err;
      exitCode = 1;
    }
    return { stdout: Buffer.concat(chunks).toString("utf8"), exitCode };
  }

  test("a single finally never reaches parkThrow at all — the injected throw hits the routing table's TRUE default directly", async () => {
    // NOT a write-discipline pin (relabeled per the explicit unfreeze's
    // requirement (3)): with only ONE finally, the injected throw at its
    // suspend point has nothing left to detour into, so it takes
    // catchArm()'s trueDefault path (%gen.markDone + rethrow) — parkThrow
    // is never called, %pending.kind/%pending.exc never get written. This
    // pins THAT path stays correct on its own account, as a control for
    // the nested pin below (which DOES reach parkThrow) rather than as
    // evidence for the fix itself.
    const res = await buildWasm(
      "sb-single-finally.ts",
      [
        "function show(label: string, f: () => unknown): void {",
        "  try {",
        "    console.log(label, JSON.stringify(f()));",
        "  } catch (e) {",
        '    if (e instanceof Error) console.log(label, "THREW", e.name + ": " + e.message);',
        '    else console.log(label, "THREW wrong-kind");',
        "  }",
        "}",
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        '    return "returned-value";',
        "  } finally {",
        '    yield "fin";',
        "  }",
        "}",
        "const it = g();",
        // parks RETURN("returned-value"); the finally yields "fin". This
        // park DOES go through completeOrPark, but the throw injected
        // below arrives at the FINALLY's OWN suspend point — a state
        // with no enclosing finally of its own — so it is the ROUTING,
        // not the park, that must take the default path here.
        'show("next", () => it.next());',
        // hits catchArm's trueDefault directly: nothing encloses this
        // finally, so there is nowhere for parkThrow to detour into.
        'show("throw", () => it.throw(new Error("injected")));',
        'show("after", () => it.next());',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe-stageB-writediscipline.ts, this session).
    expect(stdout).toBe(
      ['next {"value":"fin","done":false}', "throw THREW Error: injected", 'after {"done":true}', ""].join("\n"),
    );
  });

  test("a THROW injected over a parked RETURN, crossing a SECOND suspending finally, propagates the injected error — the parked return value never surfaces (parkThrow's own write discipline)", async () => {
    // THE mandated pin: a source-level `return` parks RETURN in an INNER
    // finally that itself suspends; a CONSUMER `.throw()` injection then
    // crosses into an OUTER finally also covering that point, which
    // ALSO suspends. Nested on purpose — a single, non-nested finally
    // (above) never reaches parkThrow at all, so nesting is what proves
    // this pin exercises parkThrow's real mechanism rather than
    // coincidence. Outcome asserted directly: "resume" must show the
    // INJECTED error, never "returned-value" (the parked-and-overwritten
    // RETURN) surfacing anywhere, and the whole run must not trap (the
    // throw is caught by the compiled program's OWN try/catch, `show`).
    //
    // This is the exact shape that caught BOTH bugs this session: round
    // 1 (a null-pointer trap — parkThrow's snapshot rode a per-invocation
    // local dead by the time a suspending finally's re-raise ran in a
    // later call) and round 2 (a silent miscompile once round 1 was
    // fixed — parkThrow's OWN snapshot read the exception cell AFTER the
    // enclosing tryCatch's generic catch prologue had already drained
    // it, so the parked payload was empty; "resume" reported a stale,
    // wrong value instead of throwing, with no trap at all). Round 2 is
    // exactly the failure shape board #49 is about, which is why this
    // pin insists on the explicit no-trap check even for the ordinary,
    // non-trapping tests in this file — a stdout match alone would have
    // let round 2 ship.
    const res = await buildWasm(
      "sb-nested-throw.ts",
      [
        "function show(label: string, f: () => unknown): void {",
        "  try {",
        "    console.log(label, JSON.stringify(f()));",
        "  } catch (e) {",
        '    if (e instanceof Error) console.log(label, "THREW", e.name + ": " + e.message);',
        '    else console.log(label, "THREW wrong-kind");',
        "  }",
        "}",
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        "    try {",
        '      return "returned-value";',
        "    } finally {",
        '      yield "inner-fin";',
        "    }",
        "  } finally {",
        '    yield "outer-fin";',
        "  }",
        "}",
        "const it = g();",
        // parks RETURN("returned-value") at inner; inner finally yields.
        'show("next", () => it.next());',
        // must overwrite the park to THROW and cross into outer-fin's
        // own coverage; outer finally yields.
        'show("throw", () => it.throw(new Error("injected")));',
        // outer finally's own natural end re-raises — must be the
        // injected THROW, never the stale, overwritten RETURN.
        'show("resume", () => it.next());',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe-stageB-writediscipline-nested.ts, this session).
    expect(stdout).toBe(
      [
        'next {"value":"inner-fin","done":false}',
        'throw {"value":"outer-fin","done":false}',
        "resume THREW Error: injected",
        "",
      ].join("\n"),
    );
  });

  test("the SAME nested shape, uncaught at the true top level, traps the module exactly where Node throws uncaught — proves the propagated value, not merely 'something' unwound", async () => {
    // The strongest form of the pin above: with no source-level catch at
    // all, the injected error must reach the true top level and trap
    // `_start` (S007's own uncaught-exception bridge — a real wasm trap
    // is this backend's exit-1 signal), at the SAME point in the output
    // Node itself throws uncaught. Round 2's bug (the silent miscompile)
    // produced a CLEAN run with a stale value here — this specific
    // shape is what caught it during this session's own debugging, kept
    // here as the regression rather than only the caught-and-shown form
    // above, since a clean exit is the failure mode most likely to look
    // like success at a glance.
    const res = await buildWasm(
      "sb-nested-throw-uncaught.ts",
      [
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        "    try {",
        '      return "returned-value";',
        "    } finally {",
        '      console.log("inner-fin-start");',
        '      yield "inner-fin";',
        '      console.log("inner-fin-tail");',
        "    }",
        "  } finally {",
        '    console.log("outer-fin-start");',
        '    yield "outer-fin";',
        '    console.log("outer-fin-tail");',
        "  }",
        '  return "normal-end";',
        "}",
        "const it = g();",
        'console.log("A", JSON.stringify(it.next()));',
        'console.log("B", JSON.stringify(it.throw(new Error("injected"))));',
        'console.log("C", JSON.stringify(it.next()));',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectTrap(res.binaryPath);
    // Node-measured (probe-stageB-nested-diag2.ts, this session): output
    // up to and including "outer-fin-tail" prints, then Node crashes
    // uncaught before "C" ever runs — the wasm trap must land at the
    // identical point, not one line later or earlier.
    expect(stdout).toBe(
      [
        "inner-fin-start",
        'A {"value":"inner-fin","done":false}',
        "outer-fin-start",
        'B {"value":"outer-fin","done":false}',
        "outer-fin-tail",
        "",
      ].join("\n"),
    );
  });

  test("GENRET's finally CHAINING (not its handler-group routing — see the dedicated pin below for that, a genuinely different bug): a .return() crossing the SAME doubly-nested shape completes with the returned value, no cell write-discipline fix needed", async () => {
    // PENDING_KIND_FIELD's own doc comment documents the CELL question
    // (a stale kindG surviving a suspend) as measured, not proven: two
    // independent Node-diffed probes found no misroute for GENRET across
    // this exact shape, both before AND after the THROW fix
    // (genretRouting never reads the exception cell at all — $gen.retPark
    // carries the value, untouched either way). This pin exists to catch
    // a REGRESSION on THAT specific question (some future change coupling
    // GENRET's routing to the cell the way THROW's used to be coupled),
    // not to assert GENRET had no bug anywhere — it did (round 3's F4,
    // pinned separately below): a DIFFERENT part of GENRET's own routing
    // (which handler-group a GENRET dispatches through) was broken by an
    // unrelated mechanism (a group's shared sentinel using the wrong
    // representative state's finallyOf), fixed as part of the SAME
    // change that fixed F2. Two different questions, two different pins.
    const res = await buildWasm(
      "sb-nested-genret.ts",
      [
        "function show(label: string, f: () => unknown): void {",
        "  try {",
        "    console.log(label, JSON.stringify(f()));",
        "  } catch (e) {",
        '    if (e instanceof Error) console.log(label, "THREW", e.name + ": " + e.message);',
        '    else console.log(label, "THREW wrong-kind");',
        "  }",
        "}",
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        "    try {",
        '      yield "inner-body";',
        "    } finally {",
        '      yield "inner-fin";',
        "    }",
        "  } finally {",
        '    yield "outer-fin";',
        "  }",
        '  return "normal-end";',
        "}",
        "const it = g();",
        'show("next1", () => it.next());',
        'show("return", () => it.return("R" as never));',
        'show("next2", () => it.next());',
        'show("next3", () => it.next());',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe-stageB-genret-drain.ts, this session).
    expect(stdout).toBe(
      [
        'next1 {"value":"inner-body","done":false}',
        'return {"value":"inner-fin","done":false}',
        'next2 {"value":"outer-fin","done":false}',
        'next3 {"value":"R","done":true}',
        "",
      ].join("\n"),
    );
  });

  test("round 3, F1: a plain source-level throw parked at an inner finally chains through a STILL-open outer finally at the inner finally's own natural end — not merely at a consumer injection point", async () => {
    // Distinct from the two pins above: those exercise a CONSUMER
    // `.throw()` injection landing directly at a suspend point (routed
    // by catchArm, which already worked). This shape has NO injection at
    // all — an ordinary `throw` inside the innermost try parks at the
    // inner finally via the normal path (already correct before round
    // 3), the inner finally suspends normally, and on plain resume its
    // own tail reaches reraisePending — THAT is where F1 lived:
    // reraisePending's THROW arm never checked `finallyOf`, unlike its
    // RETURN/GENRET siblings, so it unwound straight out instead of
    // detouring into the still-open outer finally. Node-measured
    // (probe-sb3-chained-reraise.ts, reviewer-supplied).
    const res = await buildWasm(
      "sb3-chained-reraise.ts",
      [
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        "    try {",
        '      yield "a";',
        '      throw new Error("boom");',
        "    } finally {",
        '      yield "inner-fin";',
        "    }",
        "  } finally {",
        '    yield "outer-fin";',
        "  }",
        "}",
        "const it = g();",
        'console.log("1", JSON.stringify(it.next()));',
        'console.log("2", JSON.stringify(it.next()));',
        'console.log("3", JSON.stringify(it.next()));',
        "try {",
        '  console.log("4", JSON.stringify(it.next()));',
        "} catch (e) {",
        '  console.log("4 THREW", (e as Error).message);',
        "}",
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    expect(stdout).toBe(
      [
        '1 {"value":"a","done":false}',
        '2 {"value":"inner-fin","done":false}',
        '3 {"value":"outer-fin","done":false}',
        "4 THREW boom",
        "",
      ].join("\n"),
    );
  });

  test("round 3, F2: a throw under an inner finally, wrapped by a SEPARATE outer try/catch (not a full try/catch/finally), runs the finally BEFORE reaching the outer catch", async () => {
    // Nesting order matters, not just "a handler exists": here the inner
    // try/finally is wrapped by an OUTER try/catch, two separate
    // constructs — the finally is pushed AFTER (more deeply nested than)
    // the outer handler, so it must run FIRST. Before round 3,
    // catchArm's grouping sent any state with a non-negative handlerOf
    // straight to the handler regardless of nesting, skipping the inner
    // finally entirely — "yield inner-fin" would never print. Node-
    // measured (sb3-varF.ts, reviewer-supplied).
    const res = await buildWasm(
      "sb3-varF.ts",
      [
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        "    try {",
        '      yield "a";',
        '      throw new Error("boom");',
        "    } finally {",
        '      yield "inner-fin";',
        "    }",
        '  } catch (e) { yield "caught:" + (e as Error).message; }',
        '  return "end";',
        "}",
        "const it = g();",
        'console.log("1", JSON.stringify(it.next()));',
        'console.log("2", JSON.stringify(it.next()));',
        'console.log("3", JSON.stringify(it.next()));',
        'console.log("4", JSON.stringify(it.next()));',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    expect(stdout).toBe(
      [
        '1 {"value":"a","done":false}',
        '2 {"value":"inner-fin","done":false}',
        '3 {"value":"caught:boom","done":false}',
        '4 {"value":"end","done":true}',
        "",
      ].join("\n"),
    );
  });

  test("round 3, F4: a GENRET into a handler group whose REPRESENTATIVE state has no enclosing finally, while the state actually suspended does", async () => {
    // Two yield sites share ONE outer catch — "before" (no finally of
    // its own) and "inside" (wrapped by an inner finally, still under
    // the SAME outer catch). Before round 3, catchArm grouped both
    // states purely by handlerOf, and the group's shared GENRET sentinel
    // read finallyOf off states[0] — if that happened to be "before"
    // (finallyOf -1), a .return() actually delivered at "inside" wrongly
    // skipped the inner finally instead of detouring into it. This is a
    // DIFFERENT bug from the two above (GENRET's own routing, not a real
    // exception's), closed by the SAME (handlerOf, finallyOf) pair
    // grouping fix. Node-measured (sb3-varG.ts, reviewer-supplied).
    const res = await buildWasm(
      "sb3-varG.ts",
      [
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        '    yield "before";',
        "    try {",
        '      yield "inside";',
        "    } finally {",
        '      yield "fin";',
        "    }",
        '  } catch (e) { yield "caught"; }',
        '  return "end";',
        "}",
        "const it = g();",
        'console.log("1", JSON.stringify(it.next()));',
        'console.log("2", JSON.stringify(it.next()));',
        'console.log("3", JSON.stringify(it.return("early")));',
        'console.log("4", JSON.stringify(it.next()));',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    expect(stdout).toBe(
      [
        '1 {"value":"before","done":false}',
        '2 {"value":"inside","done":false}',
        '3 {"value":"fin","done":false}',
        '4 {"value":"early","done":true}',
        "",
      ].join("\n"),
    );
  });

  test("round 3, F6: a generator that throws all the way out through a suspending finally is marked DONE, not left resumable — the fourth .next() must answer {done:true}, not trap", async () => {
    // Before F6's fix, reraisePending's true final exit restored the
    // exception cell and returned WITHOUT %gen.markDone — $gen.state
    // stayed SUSPENDED, so a later .next() call resumed `resume` at a
    // state with nothing valid left to run: a trap, not Node's own
    // {value:undefined,done:true} steady state. Node-measured
    // (sb3-varH.ts, reviewer-supplied).
    const res = await buildWasm(
      "sb3-varH.ts",
      [
        "function* g(): Generator<string, string, unknown> {",
        "  try { yield \"a\"; throw new Error(\"boom\"); }",
        '  finally { yield "fin"; }',
        "}",
        "const it = g();",
        'console.log("1", JSON.stringify(it.next()));',
        'console.log("2", JSON.stringify(it.next()));',
        "try {",
        '  console.log("3", JSON.stringify(it.next()));',
        "} catch (e) {",
        '  console.log("3 THREW", (e as Error).message);',
        "}",
        'console.log("4", JSON.stringify(it.next()));',
        'console.log("5", JSON.stringify(it.next()));',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    expect(stdout).toBe(
      [
        '1 {"value":"a","done":false}',
        '2 {"value":"fin","done":false}',
        "3 THREW boom",
        '4 {"done":true}',
        '5 {"done":true}',
        "",
      ].join("\n"),
    );
  });

  test("round 3, F7: an async function that throws all the way out through a suspending finally rejects its own promise — it must not hang forever unsettled", async () => {
    // Before F7's fix, the SAME true final exit skipped %async.reject
    // entirely for the async lane — the promise never settled, the
    // awaiting caller never resumed, and the program exited 0 with
    // silently truncated output instead of Node's own rejection. No
    // trap, no wrong value at an identifiable point — the worst
    // divergence class this increment can produce, invisible to a
    // stdout-only or exit-code-only check. Requires the timer-pumping
    // host (`runWasmWithTimers`) — a plain write-only import stalls a
    // real `setTimeout` inside an awaited chain. Node-measured
    // (sb3-varI.ts, reviewer-supplied).
    const res = await buildWasm(
      "sb3-varI.ts",
      [
        "function tick(): Promise<void> {",
        "  return new Promise<void>((resolve) => { setTimeout(() => { resolve(); }, 1); });",
        "}",
        "async function f(): Promise<string> {",
        "  try {",
        "    await tick();",
        '    throw new Error("boom");',
        "  } finally {",
        "    await tick();",
        '    console.log("finally ran");',
        "  }",
        "}",
        "async function main(): Promise<void> {",
        "  try {",
        "    const v = await f();",
        '    console.log("resolved", v);',
        "  } catch (e) {",
        '    console.log("rejected", (e as Error).message);',
        "  }",
        '  console.log("main done");',
        "}",
        "main();",
        'console.log("spawned");',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const { stdout, exitCode } = await runWasmWithTimers(res.binaryPath);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(["spawned", "finally ran", "rejected boom", "main done", ""].join("\n"));
  });

  test("round 3, F7's own control: the SAME async shape with NO throw — await-in-finally on the normal path settles the promise and resolves, proving F6/F7's fix didn't break the case that already worked", async () => {
    // sb3-varJ.ts, reviewer-supplied — the near-miss this pin exists to
    // guard against: it's easy for a "make the uncaught-exception exit
    // more correct" fix to accidentally regress the ordinary resolving
    // path if the true-final-exit change is scoped wrong. This shape is
    // already green on all three lanes; it stays green here as a
    // permanent regression guard, not evidence a bug was ever found.
    const res = await buildWasm(
      "sb3-varJ.ts",
      [
        "function tick(): Promise<void> {",
        "  return new Promise<void>((resolve) => { setTimeout(() => { resolve(); }, 1); });",
        "}",
        "async function f(): Promise<string> {",
        "  try {",
        "    await tick();",
        '    return "ok";',
        "  } finally {",
        "    await tick();",
        '    console.log("finally ran");',
        "  }",
        "}",
        "async function main(): Promise<void> {",
        "  const v = await f();",
        '  console.log("resolved", v);',
        "}",
        "main();",
        'console.log("spawned");',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const { stdout, exitCode } = await runWasmWithTimers(res.binaryPath);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(["spawned", "finally ran", "resolved ok", ""].join("\n"));
  });

  test("round 3, F8: a catch nested BETWEEN a suspending inner finally and an outer finally — reraisePending's THROW arm must reach the NEARER catch, not skip it for a fixed 'finally always first' priority", async () => {
    // The F1 fix gave THROW a finallyOf check, but hard-coded it FIRST
    // with handlerOf only as a fallback — the exact category-first
    // mistake F2 already named and fixed inside catchArm's own grouping,
    // reintroduced here at the one site that never got routed through
    // nearestOf. At the inner finally's own end state here, handlerOf
    // names the MIDDLE catch and finallyOf names the OUTER finally, and
    // the middle catch is nearer (pushed after the outer finally, more
    // deeply nested) — Node delivers there. The unconditional
    // "finallyOf first" order skipped it entirely: the exception (or,
    // for the async analog, the promise's own outcome) reached the outer
    // finally and completed as if nothing had ever caught it. Node-
    // measured (sb3-varK.ts, reviewer-supplied).
    const res = await buildWasm(
      "sb3-varK.ts",
      [
        "function* g(): Generator<string, string, unknown> {",
        "  try {",
        "    try {",
        "      try { yield \"a\"; throw new Error(\"boom\"); }",
        '      finally { yield "inner-fin"; }',
        '    } catch (e) { yield "caught:" + (e as Error).message; }',
        "  } finally {",
        '    yield "outer-fin";',
        "  }",
        '  return "end";',
        "}",
        "const it = g();",
        'console.log("1", JSON.stringify(it.next()));',
        'console.log("2", JSON.stringify(it.next()));',
        'console.log("3", JSON.stringify(it.next()));',
        'console.log("4", JSON.stringify(it.next()));',
        'console.log("5", JSON.stringify(it.next()));',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    expect(stdout).toBe(
      [
        '1 {"value":"a","done":false}',
        '2 {"value":"inner-fin","done":false}',
        '3 {"value":"caught:boom","done":false}',
        '4 {"value":"outer-fin","done":false}',
        '5 {"value":"end","done":true}',
        "",
      ].join("\n"),
    );
  });
});

describe("stage C: switch dispatch reuse (full-source regressions)", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-stagec-switch-"));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function buildWasm(name: string, source: string) {
    const entry = join(scratch, name);
    await writeFile(entry, source);
    return compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  }

  /** Mirrors stage B's own helper (see that describe block's doc comment):
   * `_start` runs inside its own try/catch and a trap is asserted NOT to
   * have happened, so every pin below fails loudly rather than passing on
   * a silently-truncated run. */
  async function runWasmExpectNoTrap(modulePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (memory === null) throw new Error("write before instantiation completed");
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    const trap = await Promise.resolve()
      .then(() => (instance.exports["_start"] as () => void)())
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(trap).toBeNull();
    return Buffer.concat(chunks).toString("utf8");
  }

  test("a middle default: Node enters at the default's SOURCE position and falls through into later cases — the silent-if-wrong state-chain property", async () => {
    const res = await buildWasm(
      "sc-switch-middle-default.ts",
      [
        "function* f64Mid(mode: number): Generator<string, void, unknown> {",
        "  switch (mode) {",
        "    case 0:",
        '      yield "zero";',
        "      break;",
        "    default:",
        '      yield "DEF";',
        "    case 1:",
        '      yield "one";',
        "      break;",
        "    case 2:",
        '      yield "two";',
        "      break;",
        "  }",
        '  yield "tail";',
        "}",
        "function drive(mode: number): string {",
        "  const out: string[] = [];",
        "  for (const s of f64Mid(mode)) out.push(s);",
        '  return out.join(",");',
        "}",
        "console.log(drive(9));",
        "console.log(drive(0));",
        "console.log(drive(1));",
        "console.log(drive(2));",
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe1-middle-default.ts, this session): mode 9
    // matches nothing, enters the default AT ITS OWN SOURCE POSITION
    // (between case 0 and case 1), and falls through into case 1.
    expect(stdout).toBe(["DEF,one,tail", "zero,tail", "one,tail", "two,tail", ""].join("\n"));
  });

  test("last-case fallthrough lands at the switch's own exit, and a no-match falls straight through every case", async () => {
    const res = await buildWasm(
      "sc-switch-last-fallthrough.ts",
      [
        "function* f64Last(mode: number): Generator<string, void, unknown> {",
        "  switch (mode) {",
        "    case 0:",
        '      yield "zero";',
        "      break;",
        "    case 1:",
        '      yield "one";',
        "    case 2:",
        '      yield "two";',
        "  }",
        '  yield "tail";',
        "}",
        "function drive(mode: number): string {",
        "  const out: string[] = [];",
        "  for (const s of f64Last(mode)) out.push(s);",
        '  return out.join(",");',
        "}",
        "console.log(drive(0));",
        "console.log(drive(1));",
        "console.log(drive(2));",
        "console.log(drive(3));",
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe2-last-fallthrough.ts, this session).
    expect(stdout).toBe(["zero,tail", "one,two,tail", "two,tail", "tail", ""].join("\n"));
  });

  test("no default clause, no match: reaches past the switch instead of silently stalling in the split world", async () => {
    // The synthetic {test:null, body:goto(exitS)} arm this pin targets was
    // mutation-checked directly against this exact shape (this session):
    // disabling the arm turned drive(99) from "tail" into "" — the
    // generator exhausted with zero yields rather than reaching the tail
    // statement — while unrelated controls stayed green.
    const res = await buildWasm(
      "sc-switch-no-default.ts",
      [
        "function* noDefault(mode: number): Generator<string, void, unknown> {",
        "  switch (mode) {",
        "    case 0:",
        '      yield "zero";',
        "      break;",
        "    case 1:",
        '      yield "one";',
        "      break;",
        "  }",
        '  yield "tail";',
        "}",
        "function drive(mode: number): string {",
        "  const out: string[] = [];",
        "  for (const s of noDefault(mode)) out.push(s);",
        '  return out.join(",");',
        "}",
        "console.log(drive(0));",
        "console.log(drive(1));",
        "console.log(drive(99));",
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe4-no-default.ts, this session).
    expect(stdout).toBe(["zero,tail", "one,tail", "tail", ""].join("\n"));
  });

  test("a labeled break naming the switch's OWN label binds there, not to whatever outer construct shares a jump target", async () => {
    const res = await buildWasm(
      "sc-switch-labeled-break.ts",
      [
        "function* labeled(mode: number): Generator<string, void, unknown> {",
        "  outer: switch (mode) {",
        "    case 0:",
        '      yield "zero";',
        "      if (mode === 0) break outer;",
        '      yield "unreachable";',
        "    case 1:",
        '      yield "one";',
        "      break;",
        "  }",
        '  yield "tail";',
        "}",
        "function drive1(mode: number): string {",
        "  const out: string[] = [];",
        "  for (const s of labeled(mode)) out.push(s);",
        '  return out.join(",");',
        "}",
        "console.log(drive1(0));",
        "console.log(drive1(1));",
        "",
        // The SAME label name reused on an outer loop — catches a switch's
        // own JumpScope entry accidentally binding to the WRONG (outer)
        // scope (the one type-correct wrong value is `labels: []`).
        "function* nestedSameLabel(mode: number): Generator<string, void, unknown> {",
        "  loop: for (let i = 0; i < 2; i++) {",
        "    switch (mode) {",
        "      case 0:",
        "        yield `i${i}`;",
        "        break;", // binds to the switch, NOT the loop
        "      case 1:",
        "        if (i === 0) continue loop;", // binds to the loop (pass-through)
        "        yield `i${i}`;",
        "        break;",
        "    }",
        "    yield `after${i}`;",
        "  }",
        "}",
        "function drive2(mode: number): string {",
        "  const out: string[] = [];",
        "  for (const s of nestedSameLabel(mode)) out.push(s);",
        '  return out.join(",");',
        "}",
        "console.log(drive2(0));",
        "console.log(drive2(1));",
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe3-labeled-break.ts, this session).
    expect(stdout).toBe(["zero,tail", "one,tail", "i0,after0,i1,after1", "i1,after1", ""].join("\n"));
  });

  test("a zero-suspension switch that a continue escapes, inside a loop whose body yields OUTSIDE the switch — the reviewer's own pre-read shape (the second decline site: escapes(s) with no suspension)", async () => {
    // Before stage C, this fell to lowerStmt's generic default arm (no
    // "switch" case existed) and declined fn:async:jump-out-of-switch even
    // though NOTHING inside the switch itself suspends — see the retired
    // "a break out of a kept construct into an exploded one" IR-level pin
    // above. lowerSwitch's own JumpScope now handles it directly.
    const res = await buildWasm(
      "sc-switch-escape.ts",
      [
        "function* sc_switch_escape(): Generator<number, number, undefined> {",
        "  let step = 0;",
        "  while (true) {",
        "    step++;",
        "    switch (step) {",
        "      case 1:",
        "      case 3:",
        "      case 5:",
        "      case 7:",
        "        continue;", // odd steps: escape the switch AND the while body, no yield
        "      case 9:",
        "        return 232;",
        "      default:",
        "        break;", // even steps: fall through to the yield below
        "    }",
        "    yield step;",
        "  }",
        "}",
        "const it = sc_switch_escape();",
        "for (let i = 0; i < 5; i++) {",
        "  const r = it.next();",
        "  console.log(r.value, r.done);",
        "}",
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe6-sc-switch-escape.ts, this session): four
    // yields (the even steps), then the case-9 return.
    expect(stdout).toBe(["2 false", "4 false", "6 false", "8 false", "232 true", ""].join("\n"));
  });

  test("the discriminant itself suspends: hoists like an if's condition (evaluates exactly once, unconditionally, before any test) — generator and async lanes", async () => {
    const res = await buildWasm(
      "sc-switch-disc-suspends.ts",
      [
        "function* g(): Generator<string, void, string> {",
        "  switch (yield \"which\") {",
        "    case \"a\":",
        '      yield "matched-a";',
        "      break;",
        "    case \"b\":",
        '      yield "matched-b";',
        "      break;",
        "    default:",
        '      yield "matched-default";',
        "  }",
        '  yield "tail";',
        "}",
        "function drive(input: string): string {",
        "  const it = g();",
        '  it.next("");', // priming call: the argument is always discarded
        "  const out: string[] = [];",
        "  let r = it.next(input);",
        "  while (!r.done) {",
        "    out.push(r.value);",
        '    r = it.next("");',
        "  }",
        '  return out.join(",");',
        "}",
        'console.log(drive("a"));',
        'console.log(drive("b"));',
        'console.log(drive("z"));',
        "",
        "async function step(v: string): Promise<string> {",
        "  return v;",
        "}",
        "async function h(input: string): Promise<string> {",
        "  const out: string[] = [];",
        "  switch (await step(input)) {",
        "    case \"a\":",
        '      out.push("matched-a");',
        "      break;",
        "    default:",
        '      out.push("matched-default");',
        "  }",
        '  out.push("tail");',
        '  return out.join(",");',
        "}",
        'h("a").then((v) => console.log(v));',
        'h("z").then((v) => console.log(v));',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe7-discriminant-suspends.ts, this session): the
    // three sync generator drives print first, then the two async .then
    // callbacks in scheduling order.
    expect(stdout).toBe(
      ["matched-a,tail", "matched-b,tail", "matched-default,tail", "matched-a,tail", "matched-default,tail", ""].join(
        "\n",
      ),
    );
  });
});

describe("stage C: forOf array desugar + the yield-operand slot fix (full-source regressions)", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-stagec-forof-"));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function buildWasm(name: string, source: string) {
    const entry = join(scratch, name);
    await writeFile(entry, source);
    return compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  }

  /** Mirrors stage B's and stage C's own switch-block helper. */
  async function runWasmExpectNoTrap(modulePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (memory === null) throw new Error("write before instantiation completed");
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    const trap = await Promise.resolve()
      .then(() => (instance.exports["_start"] as () => void)())
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(trap).toBeNull();
    return Buffer.concat(chunks).toString("utf8");
  }

  test("array for-of inside a generator body, its async mirror, and a break with no IteratorClose needed", async () => {
    const res = await buildWasm(
      "sc-forof-basic.ts",
      [
        "function* doubleAll(xs: number[]): Generator<number, void, unknown> {",
        "  for (const x of xs) {",
        "    yield x * 2;",
        "  }",
        "  yield -1;",
        "}",
        "function drive(xs: number[]): string {",
        "  const out: number[] = [];",
        "  for (const v of doubleAll(xs)) out.push(v);",
        '  return out.join(",");',
        "}",
        "console.log(drive([1, 2, 3]));",
        "console.log(drive([]));",
        "",
        "async function step(v: number): Promise<number> {",
        "  return v + 100;",
        "}",
        "async function sumSteps(xs: number[]): Promise<number> {",
        "  let total = 0;",
        "  for (const x of xs) {",
        "    total += await step(x);",
        "  }",
        "  return total;",
        "}",
        'sumSteps([1, 2, 3]).then((v) => console.log("sum:", v));',
        'sumSteps([]).then((v) => console.log("sum:", v));',
        "",
        "function* takeUntil(xs: number[], stop: number): Generator<number, void, unknown> {",
        "  for (const x of xs) {",
        "    if (x === stop) break;",
        "    yield x;",
        "  }",
        "  yield -1;",
        "}",
        "function driveTake(xs: number[], stop: number): string {",
        "  const out: number[] = [];",
        "  for (const v of takeUntil(xs, stop)) out.push(v);",
        '  return out.join(",");',
        "}",
        "console.log(driveTake([1, 2, 3, 4], 3));",
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe12-forof-basic.ts, this session).
    expect(stdout).toBe(["2,4,6,-1", "-1", "1,2,-1", "sum: 0", "sum: 306", ""].join("\n"));
  });

  test("a suspending loop's yield operand with its OWN side effect (`yield i++`) survives a suspend/resume round trip — the bug 2454 exposed live (Node measured 0+1@2 for the shape below; this pass, pre-fix, silently produced 0+0@0)", async () => {
    // lowerSuspension's "yield" case embedded the operand straight into
    // %gen.suspend's own value field, evaluated AFTER saves() already ran
    // (saves() ran first in emission order) — so a side effect from
    // evaluating the operand (i++ incrementing i) landed in the local
    // too late to be captured in the frame, and a resumed generator
    // restored the STALE pre-effect value every time. Fixed by hoisting
    // the operand into its own frame slot BEFORE saves(), mirroring how
    // "await"'s own case already did this. Unrelated to forOf/switch —
    // exposed by 2454's Feed/#emit()/takeTwo() (private generator method,
    // for-of-driven IteratorClose on early break) simply being the first
    // program to reach a suspending LOOP whose yield operand has a side
    // effect of its own; this pin reproduces the exact shape.
    const res = await buildWasm(
      "sc-yield-operand-side-effect.ts",
      [
        "class Feed {",
        "  closedAt = -1;",
        "  *#emit(): Generator<number, void, undefined> {",
        "    let i = 0;",
        "    try {",
        "      while (true) yield i++;",
        "    } finally {",
        "      this.closedAt = i;",
        "    }",
        "  }",
        "  takeTwo(): string {",
        "    const got: number[] = [];",
        "    for (const v of this.#emit()) {",
        "      got.push(v);",
        "      if (got.length === 2) break;",
        "    }",
        '    return `${got.join("+")}@${this.closedAt}`;',
        "  }",
        "}",
        "const f = new Feed();",
        "console.log(f.takeTwo());",
        "",
        // A free-standing function control, isolating the fix from private-
        // method machinery entirely.
        "function* freeEmit(): Generator<number, void, undefined> {",
        "  let i = 0;",
        "  while (true) yield i++;",
        "}",
        "function driveFree(): string {",
        "  const g = freeEmit();",
        '  return `${g.next().value},${g.next().value},${g.next().value}`;',
        "}",
        'console.log("free:", driveFree());',
        "",
        // Controls proving the fix is scoped to the side-effecting case:
        // a SEPARATE increment statement (no operand side effect to lose)
        // and a for-loop's own update slot (already correct) both stay
        // right either way.
        "function* freeSeparate(): Generator<number, void, undefined> {",
        "  let i = 0;",
        "  while (true) {",
        "    yield i;",
        "    i++;",
        "  }",
        "}",
        "function driveSeparate(): string {",
        "  const g = freeSeparate();",
        '  return `${g.next().value},${g.next().value},${g.next().value}`;',
        "}",
        'console.log("separate:", driveSeparate());',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // Node-measured (probe8-iteratorclose-repro.ts / probe11-narrow2.ts,
    // this session).
    expect(stdout).toBe(["0+1@2", "free: 0,1,2", "separate: 0,1,2", ""].join("\n"));
  });
});

describe("register close-out: S039/S040 forward-instruction pins", () => {
  // Both entries' own "Tested by" sections instruct: "once [generator
  // lowering / for-of-over-generator] lowers, a unit test should pin the
  // CURRENT (divergent) behavior directly" — the S037/S038 pattern. This
  // increment's independence citation read (the lead's own S039-S041
  // read, closing the reviewer's self-flagged loop) found both
  // instructions still unfulfilled at the final unit: zero S039/S040
  // references existed anywhere in this file before these two tests.
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-register-close-"));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function buildWasm(name: string, source: string) {
    const entry = join(scratch, name);
    await writeFile(entry, source);
    return compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  }

  async function runWasmExpectNoTrap(modulePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    let memory: WebAssembly.Memory | null = null;
    const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
      tsinter: {
        write(fd: number, ptr: number, len: number): void {
          if (memory === null) throw new Error("write before instantiation completed");
          if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
        },
      },
    });
    memory = instance.exports["memory"] as WebAssembly.Memory;
    const trap = await Promise.resolve()
      .then(() => (instance.exports["_start"] as () => void)())
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(trap).toBeNull();
    return Buffer.concat(chunks).toString("utf8");
  }

  test("SEMANTICS.md S039: a consumer .return() injected mid-yield*-delegation unwinds the OUTER generator directly, WITHOUT forwarding into the delegate — the delegate's own finally never runs, though the reported {value,done} pair still matches Node's (Node itself: the delegate's finally DOES run first, in this exact shape — NOT reproduced here, deliberately)", async () => {
    const res = await buildWasm(
      "s039-yieldstar-return.ts",
      [
        "function* inner(): Generator<string, string, unknown> {",
        '  try { yield "a"; yield "b"; return "inner-ret"; } finally { console.log("inner finally ran"); }',
        "}",
        "function* outer(): Generator<string, string, unknown> {",
        '  try { yield* inner(); return "outer-ret"; } finally { console.log("outer finally ran"); }',
        "}",
        "const g = outer();",
        "console.log(JSON.stringify(g.next()));",
        'console.log(JSON.stringify(g.return("RV")));',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // OUR tier's own answer (S039), Node-diffed and NOT expected to match
    // on the "inner finally ran" line: Node prints "inner finally ran"
    // THEN "outer finally ran" (measured in the entry's own repro) —
    // this pass reaches genResume's THROW/GENRET routing straight from
    // the outer's own suspension point (yield* desugars %dele.next()'s
    // own embedded yield as an ordinary suspension), never touching
    // %dele at all, so ONLY "outer finally ran" prints. The {value,done}
    // PAIR still agrees with Node's own {"value":"RV","done":true} — the
    // divergence is confined to the delegate's silently-skipped side
    // effect, exactly as the entry's own lane paragraph documents.
    expect(stdout).toBe(['{"value":"a","done":false}', "outer finally ran", '{"value":"RV","done":true}', ""].join("\n"));
  });

  test("SEMANTICS.md S040: for-of over a generator closes on break (matches Node) but NOT on a return/throw abandonment (diverges from Node, which closes on all three)", async () => {
    const res = await buildWasm(
      "s040-forof-close.ts",
      [
        "function* gen(): Generator<number, void, unknown> {",
        "  try {",
        "    yield 1;",
        "    yield 2;",
        "    yield 3;",
        "  } finally {",
        '    console.log("finally ran");',
        "  }",
        "}",
        "function viaBreak(): void {",
        "  for (const x of gen()) {",
        "    if (x === 1) break;",
        "  }",
        "}",
        "function viaReturn(): void {",
        "  for (const x of gen()) {",
        "    if (x === 1) return;",
        "  }",
        "}",
        "function viaThrow(): void {",
        "  try {",
        "    for (const x of gen()) {",
        '      if (x === 1) throw new Error("boom");',
        "    }",
        "  } catch {",
        "    // swallowed",
        "  }",
        "}",
        'console.log("break:");',
        "viaBreak();",
        'console.log("return:");',
        "viaReturn();",
        'console.log("throw:");',
        "viaThrow();",
        'console.log("done");',
        "",
      ].join("\n"),
    );
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
    const stdout = await runWasmExpectNoTrap(res.binaryPath);
    // OUR tier's own answer (S040), Node-diffed and NOT expected to
    // match on the "return"/"throw" sections: Node prints "finally ran"
    // after EVERY one of the three abandonment shapes (measured in the
    // entry's own repro — IteratorClose fires on break, return, AND an
    // uncaught throw alike). lowerForOfGenerator's own desugar places the
    // close statement AFTER the while loop, reached only when control
    // falls out normally (exhaustion or a break inside the body) — a
    // return/throw unwinds the enclosing function/catch directly and
    // never reaches it, so only the break line logs here.
    expect(stdout).toBe(["break:", "finally ran", "return:", "throw:", "done", ""].join("\n"));
  });
});
