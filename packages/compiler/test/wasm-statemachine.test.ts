/* The resumable-function lowering (backend/wasm/statemachine.ts) as a pure
 * IR→IR transform: hand-built async modules in, state machines out. The
 * assertions are STRUCTURAL — the shape of the wrapper, the resume
 * skeleton, the frame's fields, and the closure of the state graph — not
 * byte-exact IR, so the pass keeps room to pick different state numbers.
 * The other half of the contract is the refusal set: every async shape the
 * pass declines must name itself and leave the function untouched, which
 * is what keeps the emitter's own `fn:async` firing behind it. */
import { describe, expect, test } from "vitest";
import type { IrFunction, IrModule, IrStmt, IrType, SrcLoc } from "../src/ir/nodes.js";
import { BOOL, CAUGHT, F64, STRING, VOID } from "../src/ir/nodes.js";
import { asIrModule, lowerResumableFunctions, type WFunction, type WModule } from "../src/backend/wasm/statemachine.js";
import { computeMayThrow } from "../src/backend/emission/may-throw.js";
import { surveyWasmModule } from "../src/backend/wasm/emitter.js";
import {
  assign,
  asyncModule,
  await_,
  bool,
  call,
  exprStmt,
  hop,
  loc,
  local,
  log,
  num,
  promiseOf,
  ret,
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

/** The `while (true) switch (frame.%state)` skeleton, unpacked. */
function dispatch(resume: WFunction): { test: number | null; body: IrStmt[] }[] {
  expect(resume.body).toHaveLength(1);
  const tc = resume.body[0]!;
  expect(tc.kind).toBe("tryCatch");
  if (tc.kind !== "tryCatch") throw new Error("unreachable");
  expect(tc.finallyBody).toBeNull();
  expect(tc.catchLocalId).toBe("%async.exc");
  const loop = tc.tryBody[0]!;
  expect(loop.kind).toBe("while");
  if (loop.kind !== "while") throw new Error("unreachable");
  expect(loop.labels).toEqual(["%dispatch"]);
  const sw = loop.body[0]!;
  expect(sw.kind).toBe("switch");
  if (sw.kind !== "switch") throw new Error("unreachable");
  return sw.cases.map((c) => ({
    test: c.test === null ? null : (c.test as { value: number }).value,
    body: c.body,
  }));
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

  test("resume is a void tryCatch/while/switch over three states", () => {
    expect(resume.async).toBeUndefined();
    expect(resume.returnType).toEqual(VOID);
    expect(resume.params.map((p) => p.localId)).toEqual(["%async.frame"]);
    const cases = dispatch(resume);
    // states 0, 1, 2 plus the defensive default.
    expect(cases.map((c) => c.test)).toEqual([0, 1, 2, null]);
    expect(resume.locals.some((l) => l.id === "%async.exc" && l.type.kind === "caught")).toBe(true);
  });

  test("the catch arm rejects the frame's own promise", () => {
    const tc = resume.body[0]!;
    if (tc.kind !== "tryCatch") throw new Error("unreachable");
    expect(tc.catchBody!.map((s) => s.kind)).toEqual(["%async.reject", "return"]);
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

  test("await inside try/catch", () => {
    expectRefusal(
      plain(
        [{ kind: "tryCatch", tryBody: [exprStmt(awaitCall())], catchBody: [], catchLocalId: null, finallyBody: null, loc }],
      ),
      "fn:async:await-in-try",
    );
  });

  test("await in a non-root position (a call argument)", () => {
    expectRefusal(plain([log([awaitCall()])]), "fn:async:await-position");
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

  test("an async module initializer", () => {
    expectRefusal(
      plain([exprStmt(awaitCall())], [], { asyncCacheGlobal: "%g.mod.p" }),
      "fn:async:module-init",
    );
  });

  test("top-level await (the entry function is async)", () => {
    const fn = plain([exprStmt(awaitCall())]);
    expectRefusal(fn, "fn:async:entry", (m) => ({ ...m, entry: "f" }));
  });

  test("a body-declared boxed local", () => {
    expectRefusal(
      plain([varDecl("c.0", num(1)), exprStmt(awaitCall())], [local("c.0", F64, { boxed: true })]),
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
    body: [log([await_(call("mkp", [], promiseOf(F64)), F64)])],
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
  const survey = surveyWasmModule(asyncModule(twoAwaits()));

  test("the frame shape maps: no record refusal", () => {
    expect(survey).not.toContain("record:recursive");
    expect(survey).not.toContain("record:index-signature");
  });

  test("the whole-function gate is gone; the runtime seam is what is left", () => {
    expect(survey).not.toContain("fn:async");
    expect(survey).toContain("expr:%async.mint");
    expect(survey).toContain("expr:%async.settled");
    expect(survey).toContain("stmt:%async.subscribe");
    expect(survey).toContain("stmt:%async.settle");
    expect(survey).toContain("stmt:%async.rejectCheck");
    expect(survey).toContain("stmt:%async.reject");
    // The promise representation itself is stage 2's other half.
    expect(survey).toContain("type:promise");
  });
});
