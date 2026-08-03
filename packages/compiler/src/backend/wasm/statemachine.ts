/* The resumable-function lowering: async functions (and, once the shape
 * proves out, generators) rewritten from bodies that SUSPEND into ordinary
 * IR the rest of this backend already compiles.
 *
 * WHY A PASS AND NOT AN EMISSION MODE. Upstream runs every async body on a
 * stackful fiber — a heap ucontext on POSIX, a Win32 Fiber on Windows
 * (scr_async.c) — and baseline WasmGC has no stack switching, so there is
 * nothing to port and the suspension has to be MATERIALIZED. The IR is
 * structured statements, which is exactly the input regenerator-style
 * lowering wants: flatten the body to numbered states, keep the live
 * values in a frame, and drive it with `while (true) switch (state)`.
 * Doing that as IR→IR means the emitter needs no resumable control flow at
 * all — the output is loops, switches, records, and calls, every one of
 * which increments 5, 6 and 10 already emit.
 *
 * WHERE IT IS ALLOWED TO RUN. compile() validates the module ONCE and then
 * hands it to emitWasmModule (index.ts), so this pass is POST-validation:
 * it may produce shapes the frontend never would, and no validator sees
 * them. That is the whole reason the design works, and it is also the
 * reason the pass lives HERE — under the backend that consumes it — rather
 * than in ir/ where it would look like part of the frontend contract.
 *
 * THE SEAM (settled the hard way — do not re-derive it). The pass has to
 * emit operations no IR node spells: "subscribe this frame to that promise
 * and return", "settle my promise with this value". Three seams were
 * considered:
 *
 *   1. Widen IrLibFn with `%async.*` names. REJECTED — LIB_FN_SIGS is a
 *      `Record<IrLibFn, ...>`, so the union is exhaustive by construction:
 *      widening it FORCES signature entries, which makes the names legal
 *      frontend output and drags arg types (frame refs, funcrefs) that
 *      have no IrType spelling into the shared contract.
 *   2. A new IrExpr/IrStmt kind in nodes.ts. REJECTED — every backend
 *      switches exhaustively over those unions, so a backend-private node
 *      would force dead cases into the C and LLVM emitters.
 *   3. A SUPERSET type owned by this backend: the pass returns IR whose
 *      statement/expression unions are `IrStmt | AsyncOp` etc., and the
 *      wasm emitter's walk widens to accept it. CHOSEN — the extra kinds
 *      stay inside backend/wasm, the emitter's `never` exhaustiveness
 *      check keeps them honest, and no shared file changes at all.
 *
 * The superset is deliberately SHALLOW: `WStmt = IrStmt | AsyncStmt`, not
 * a deep structural mirror of IrStmt/IrExpr (IrExpr alone has ~100 arms —
 * mirroring it would be a second copy of nodes.ts to keep in sync). The
 * consequence is that a nested body still SAYS `IrStmt[]` while carrying
 * `AsyncStmt`s at runtime. That costs nothing on the consumer side — the
 * emitter re-widens at every `walkStmt`/`walkExpr` boundary, which is the
 * only place it inspects a node — and on the producer side it is confined
 * to the two `widen*` helpers below, the single spot where the two views
 * are reconciled.
 *
 * THE PROTOCOL. Each async `f(params) -> T` becomes three things: a frame
 * record shape ({ %state, one field per live local, one PER-AWAIT-SITE
 * field for the resumed value — typed by that site, so no dyn is needed
 * anywhere }), a `%f.resume(frame)` holding the state loop, and `f` itself
 * demoted to a spawn wrapper (allocate the frame, store the params, mint
 * the promise, call resume once — JS runs an async body EAGERLY to its
 * first await — and return the promise).
 *
 * ONE RESUME SIGNATURE. Resume takes `%frameBase` — an empty OPEN struct
 * every concrete frame subtypes — and casts it down to its own shape in a
 * one-statement prologue (`%async.frameCast`); everything after is
 * concretely typed and unchanged. Without that the waiter queue could not
 * be typed at all: each resume would name its own frame struct, so the
 * (closure, frame) pairs the runtime parks would have as many wasm
 * signatures as there are async functions. The runtime never READS a
 * frame — it only carries one back to the function that made it — so the
 * base struct is deliberately empty.
 *
 * THE RESUME CLOSURE IS NOT IN THE FRAME. The obvious layout gives the
 * frame a `%resume` field typed `(frame) => void`, and it does not work:
 * recordInfo maps a shape's fields with mapTypeSoft, a func-typed field
 * maps its SIGNATURE, and the signature names the frame — so the shape is
 * in-flight when its own field asks for it and the recursion guard poisons
 * it into `record:recursive`. Typing the field `() => void` instead would
 * be a lie closSigFor turns into a mismatched call_ref. So the resume
 * closure is MATERIALIZED at each suspend site (and once in the wrapper)
 * as a `closure` node over `%f.resume`, and rides the suspend ops as an
 * operand. Zero-capture closures intern per function, so the common case
 * allocates nothing; a capturing async function re-packs its (unchanged)
 * boxes per suspend, which the runtime only ever calls.
 *
 * EVERY AWAIT SUSPENDS — with ONE exception, `module.await`, below. JS
 * spends a microtask turn even awaiting an already-settled promise, so
 * there is deliberately no settled fast path; the protocol is uniform,
 * which is what keeps the state numbering and the resume dispatch simple:
 *
 *     frame.%await<k> = <the awaited promise>;
 *     <save every non-boxed local into the frame>;
 *     frame.%state = k;
 *     %async.subscribe(frame.%await<k>, frame, closure(%f.resume));
 *     return;                       // suspend
 *   case k:                         // resumed
 *     <restore every non-boxed local from the frame>;
 *     %async.rejectCheck(frame.%await<k>);   // a rejected await re-throws
 *     ... %async.settled(frame.%await<k>) ...
 *
 * SAVE/RESTORE IS TOTAL, NOT LIVE. Every non-boxed local (params
 * included) is written at every suspend and read back at every re-entry —
 * STATE 0 INCLUDED, because the wrapper passes the arguments through the
 * frame's %l_ slots rather than through resume's signature, so the entry
 * state is where params become locals. No liveness analysis: a value that
 * was never assigned restores as the slot's zero, and the frontend's
 * definite-assignment guarantee means no read observes it. Received
 * CAPTURES are excluded on purpose — they are boxes, they ride resume's
 * own closure environment, and the box identity is what aliasing across a
 * suspension depends on.
 *
 * COMPLETION AND FAILURE. `return v` becomes `%async.settle(frame.%promise,
 * v)` + `return`, wherever it appears (returns inside statements the pass
 * keeps VERBATIM are rewritten in place). A synchronous throw anywhere in
 * the body has to become a rejection instead of unwinding into the
 * caller, which is what resume's one top-level tryCatch is for: its catch
 * arm is `%async.reject(frame.%promise, e)` + `return`.
 *
 * THE ONE AWAIT THAT DOES NOT HOP. `module.await` is ECMAScript's INTERNAL
 * module-dependency wait (the frontend emits it for an import edge inside
 * an async import CYCLE; an ordinary async dependency gets a real
 * `awaitExpr`, which is why 2658's "dep micro" still beats "main"). A
 * dependency that has ALREADY settled continues SYNCHRONOUSLY into the
 * importer — no promise job, no turn — while a pending one parks like any
 * other await and a rejected one propagates like any other await
 * (scr_async.c's `scr_module_await`). Both paths still go through ONE
 * resume point, so saves/restores stay uniform:
 *
 *     frame.%await<k> = <the dependency's promise>;
 *     <save>; frame.%state = k;
 *     %async.subscribeIfPending(frame.%await<k>, frame, closure);  // parks
 *     continue %dispatch;             // settled: fall into case k NOW
 *   case k:
 *     <restore>; %async.rejectCheck(frame.%await<k>);
 *
 * MODULE INITIALIZERS. An async `%init.N` carries `asyncCacheGlobal` (its
 * module evaluation promise) and, inside an import cycle, an
 * `asyncCycleCacheGlobal` shared by the whole SCC. Its wrapper is the
 * plain wrapper wearing emit-async.ts's protocol, in this exact order:
 *
 *   1. CACHE GUARD FIRST (`%async.cacheCheck`): a non-null global means
 *      this module is already evaluating or evaluated — hand that promise
 *      back instead of running the body twice.
 *   2. Spawn (mint + kick), eagerly, like every other wrapper.
 *   3. `%async.markHandled` on the minted promise: the LOADER owns a
 *      module evaluation promise, so its rejection is never an unhandled
 *      rejection — it becomes the root-rejection exit instead.
 *   4. Store the cache AFTER the spawn returns, not before. An admitted
 *      cycle re-enters this initializer between the guard and the spawn's
 *      return (the body's `%loaded` flag is what makes that re-entry a
 *      no-op body), and that guarded inner spawn temporarily fills the
 *      cache; the outer store is the LAST write, which is what makes the
 *      outermost member the promise everyone ends up waiting on.
 *   5. The cycle cache, when present, is the same last-wins store, and
 *      records the SCC member that actually rooted evaluation — an
 *      importer outside the cycle awaits that global directly.
 *
 * NOT YET LOWERED, REFUSED BY NAME (the loud-refusal contract — these are
 * real work, not oversights). A refusal names the WHOLE function and
 * leaves it untransformed, so the emitter's own `fn:async` still fires
 * behind it:
 *   - `fn:async:module-init-global` — an initializer whose cache global is
 *     not a module global of promise type. Unreachable from today's
 *     frontend (it emits both globals with the function); the wrapper's
 *     stores would otherwise land on a local slot that does not exist.
 *   - `fn:async:module-await-position` — a `module.await` anywhere but at
 *     the root of an `exprStmt`. The frontend emits exactly that shape;
 *     anything else would need the same temp hoisting `await-position`
 *     does, and the two are told apart so the census keeps naming the
 *     construct that actually needs work.
 *   - `fn:async:await-in-try` — an await inside try/catch/finally. The
 *     handler stack has to become frame state that survives suspension
 *     (regenerator carries an explicit try-entry stack), and it has to
 *     agree with the forward-only block shape and finallyStack the
 *     exception protocol emits today.
 *   - `fn:async:await-position` — an await anywhere but a simple statement
 *     slot (varDecl init, exprStmt, return, assign RHS). Everything else
 *     needs order-preserving temp hoisting before the split, because JS
 *     evaluation order across `f(await a, await b)` is observable.
 *   - `fn:async:await-dyn` — `await` of a checked-dynamic value
 *     (`async.awaitDyn`): the runtime decides between adoption and the
 *     one-hop non-thenable path, which needs the dyn surface.
 *   - `fn:async:nested-promise` — a promise whose INNER type is itself a
 *     promise, awaited or returned. JS flattens thenables by ADOPTION (a
 *     promise resolved with a promise subscribes to it and costs two
 *     extra microtask turns), and this tier has no adoption: settling
 *     with a promise payload would hand the inner promise back as the
 *     awaited value, which is a miscompile, not a slower answer.
 *   - `fn:async:await-in-forof` / `fn:async:await-in-switch` — a
 *     suspension inside a for-of or a switch. Both linearize, neither is
 *     free: for-of hides an index and a per-iteration binding, switch
 *     hides lazy test evaluation and fallthrough.
 *   - `fn:async:jump-out-of-<kind>` — a break/continue that leaves a
 *     construct this pass keeps verbatim (a for-of, switch or try) for a
 *     construct it exploded. Keeping the jump would retarget it at the
 *     dispatch switch; exploding the container is the same work as the
 *     two entries above.
 *   - `fn:async:boxed-local` — a body-declared captured (or TDZ) local.
 *     Its box must be allocated once per DECLARATION and survive the
 *     suspension by identity, which the frame's by-value save/restore
 *     cannot express; hoisting the box into the frame is possible, and
 *     only worth doing with aliasing tests behind it.
 *   - `fn:async:self-ref` — `selfRef` in the body. It means "the running
 *     closure", and after the split the running closure is resume's, not
 *     the wrapper's; rewriting it to `closure(f)` is future work.
 *   - `fn:async:return-in-finally` — a `return` inside a try that has a
 *     finally. The emitter's PENDING-RETURN path runs the finally BEFORE
 *     the function returns, and the promise must settle after it, not
 *     before — so the naive settle-then-return rewrite is observably
 *     wrong and the finally has to take part in completion.
 *     (`fn:async:return-in-<kind>` is its open-ended sibling: a `return`
 *     inside a container the return rewrite has never met.)
 *   - `fn:async:void-local` / `fn:async:local-id-clash` — shapes the
 *     frame cannot represent (a void-typed local has no field slot; a
 *     source local already named `%async.frame`/`%async.exc` would
 *     collide with the pass's own bindings). Neither is reachable from
 *     today's frontend; both refuse rather than assume. */
import type {
  IrExpr,
  IrFunction,
  IrLocal,
  IrModule,
  IrParam,
  IrRecordShape,
  IrStmt,
  IrType,
  SrcLoc,
} from "../../ir/nodes.js";
import { BOOL, CAUGHT, F64, VOID } from "../../ir/nodes.js";

/** What the emitter's walk does with a construct outside the tier — the
 * pass shares the sink so a function it declines names itself in exactly
 * the same census. */
export type Refuse = (kind: string, loc?: SrcLoc) => void;

/* ── the superset ──────────────────────────────────────────────────────── */

/** The one type the promise runtime knows a frame by: an OPEN struct with
 * no fields that every `%frame.<fn>` shape subtypes. Resume's parameter is
 * typed with it, so every resume shares ONE wasm signature — which is what
 * lets a waiter queue hold (closure, frame) pairs at all. Backend-private
 * like the `%async.*` kinds, and confined to the same shallow superset:
 * the IR nodes that carry it say `IrType` and hold this at runtime. */
export const FRAME_BASE = { kind: "%frameBase" } as const;

/** A type of the lowered IR (shallow superset, exactly like WStmt). */
export type WType = IrType | typeof FRAME_BASE;

function widenType(t: WType): IrType {
  return t as IrType;
}

/** Expression-position runtime seams. `%async.mint` allocates the pending
 * promise a spawn wrapper hands back; `%async.frameCast` is resume's
 * prologue narrowing its base-typed parameter back to its own frame
 * shape; the two `settled*` reads answer the value a resumed frame was
 * woken with (typed by the await site, so the consumer needs no dynamic
 * check). */
export type AsyncExpr =
  | { kind: "%async.mint"; type: IrType; loc: SrcLoc }
  | { kind: "%async.frameCast"; value: WExpr; type: IrType; loc: SrcLoc }
  | { kind: "%async.settled"; promise: WExpr; type: IrType; loc: SrcLoc }
  | { kind: "%async.settledUnion"; value: WExpr; promiseTag: number; type: IrType; loc: SrcLoc };

/** Statement-position runtime seams: the two halves of a suspension
 * (register a waiter / enqueue the bare microtask hop), the two halves of
 * completion (fulfill / reject my own promise), and the re-entry check
 * that turns an awaited rejection back into an unwind. */
export type AsyncStmt =
  /** Register (frame, resume) as a waiter on `promise`; when it settles
   * the runtime enqueues a microtask calling resume(frame). */
  | { kind: "%async.subscribe"; promise: WExpr; frame: WExpr; resume: WExpr; loc: SrcLoc }
  /** Enqueue resume(frame) directly — `await <non-thenable>`'s one turn. */
  | { kind: "%async.hop"; frame: WExpr; resume: WExpr; loc: SrcLoc }
  /** `module.await`'s half-suspend: subscribe and RETURN when the
   * dependency is still pending, fall through when it has settled (the
   * module wait costs no promise job — see the header). */
  | { kind: "%async.subscribeIfPending"; promise: WExpr; frame: WExpr; resume: WExpr; loc: SrcLoc }
  /** awaitUnionExpr's suspend: the `promiseTag` arm subscribes, every
   * other (unit) arm hops. */
  | { kind: "%async.subscribeUnion"; value: WExpr; promiseTag: number; frame: WExpr; resume: WExpr; loc: SrcLoc }
  /** Fulfill my own promise (`value: null` = a void fulfillment). */
  | { kind: "%async.settle"; promise: WExpr; value: WExpr | null; loc: SrcLoc }
  /** Reject my own promise with a caught-typed payload. */
  | { kind: "%async.reject"; promise: WExpr; caught: WExpr; loc: SrcLoc }
  /** If the awaited promise REJECTED: copy its payload into the
   * increment-10 exception cell and unwind (which lands in resume's own
   * catch, and so becomes this frame's rejection). Otherwise a no-op. */
  | { kind: "%async.rejectCheck"; promise: WExpr; loc: SrcLoc }
  /** rejectCheck for an awaited `Promise<T> | units` union: only the
   * `promiseTag` arm can carry a rejection. */
  | { kind: "%async.rejectCheckUnion"; value: WExpr; promiseTag: number; loc: SrcLoc }
  /** A module initializer's cache guard, the first statement of its
   * wrapper: a non-null global is the module's own evaluation promise, so
   * hand it straight back instead of evaluating twice. */
  | { kind: "%async.cacheCheck"; globalId: string; loc: SrcLoc }
  /** Mark a promise OBSERVED without reading it: a module evaluation
   * promise belongs to the loader, so its rejection is the program's
   * root-rejection exit and never an unhandled rejection. */
  | { kind: "%async.markHandled"; promise: WExpr; loc: SrcLoc };

/** A statement of the lowered IR. SHALLOW by design — see the header:
 * nested bodies keep their `IrStmt[]` static type while carrying
 * `AsyncStmt`s at runtime, and consumers re-widen at every walk boundary. */
export type WStmt = IrStmt | AsyncStmt;

/** An expression of the lowered IR (shallow, exactly like WStmt). */
export type WExpr = IrExpr | AsyncExpr;

export interface WFunction extends Omit<IrFunction, "body"> {
  body: WStmt[];
}

export interface WModule extends Omit<IrModule, "functions"> {
  functions: WFunction[];
}

/** The lowered module seen as plain IR. Sound for every CONSUMER that
 * walks the JSON generically rather than switching on a closed union —
 * computeMayThrow is the one that matters, and its walk recurses through
 * unknown kinds by Object.keys. */
export function asIrModule(mod: WModule): IrModule {
  return mod as unknown as IrModule;
}

/** The shallow superset's two reconciliation points (see the header). A
 * body list built by this pass really does hold AsyncStmts; the IR node it
 * is stored on says IrStmt[]. */
function widenBody(body: WStmt[]): IrStmt[] {
  return body as IrStmt[];
}

function widenExpr(e: WExpr): IrExpr {
  return e as IrExpr;
}

/* ── generic IR predicates ─────────────────────────────────────────────── */

/** Every node kind that SUSPENDS. `async.hop` is the frontend's `await
 * <non-thenable>` (one microtask turn, no promise); `async.awaitDyn` is
 * the checked-dynamic sibling this pass declines; `module.await` is the
 * loader's dependency wait, which only suspends when the dependency is
 * still pending but is a state split either way. */
function isSuspensionNode(rec: Record<string, unknown>): boolean {
  const kind = rec["kind"];
  if (kind === "awaitExpr" || kind === "awaitUnionExpr") return true;
  if (isModuleAwaitNode(rec)) return true;
  return kind === "libCall" && (rec["fn"] === "async.hop" || rec["fn"] === "async.awaitDyn");
}

function isModuleAwaitNode(rec: Record<string, unknown>): boolean {
  return rec["kind"] === "intrinsic" && rec["name"] === "module.await";
}

/** A generic kind-keyed scan, the may-throw walk's shape: the IR is plain
 * JSON, so a predicate over `kind` stays correct as nodes grow fields. */
function anyNode(node: unknown, pred: (rec: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(node)) return node.some((item) => anyNode(item, pred));
  if (node === null || typeof node !== "object") return false;
  const rec = node as Record<string, unknown>;
  if (pred(rec)) return true;
  for (const key of Object.keys(rec)) {
    if (key === "loc" || key === "type") continue;
    if (anyNode(rec[key], pred)) return true;
  }
  return false;
}

function hasSuspension(node: unknown): boolean {
  return anyNode(node, isSuspensionNode);
}

function hasModuleAwait(node: unknown): boolean {
  return anyNode(node, isModuleAwaitNode);
}

function hasAwaitDyn(node: unknown): boolean {
  return anyNode(node, (rec) => rec["kind"] === "libCall" && rec["fn"] === "async.awaitDyn");
}

function hasSelfRef(node: unknown): boolean {
  return anyNode(node, (rec) => rec["kind"] === "selfRef");
}

function hasReturn(node: unknown): boolean {
  return anyNode(node, (rec) => rec["kind"] === "return");
}

/** Break/continue targets INSIDE a statement, innermost last — the
 * emitter's resolveJump contract, mirrored so the pass agrees with it
 * about which jumps a construct swallows. */
interface JumpScope {
  labels: string[];
  /** Loops are the only `continue` targets (switch and labeled blocks
   * are break-only). */
  loop: boolean;
  /** Unlabeled `break` binds to a loop OR a switch; labeled blocks are
   * skipped. */
  breakable: boolean;
}

function resolvesWithin(kind: "break" | "continue", label: string | undefined, scopes: JumpScope[]): boolean {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i]!;
    if (label !== undefined) {
      if (!s.labels.includes(label)) continue;
      if (kind === "break") return true;
      if (s.loop) return true;
      continue;
    }
    if (kind === "break" && s.breakable) return true;
    if (kind === "continue" && s.loop) return true;
  }
  return false;
}

function scopeFor(s: IrStmt): JumpScope | null {
  switch (s.kind) {
    case "while":
    case "doWhile":
    case "for":
    case "forOf":
      return { labels: s.labels ?? [], loop: true, breakable: true };
    case "switch":
      return { labels: s.labels ?? [], loop: false, breakable: true };
    case "block":
      return { labels: s.labels ?? [], loop: false, breakable: false };
    default:
      return null;
  }
}

/** True when some break/continue inside `s` binds to a construct OUTSIDE
 * it. Such a statement cannot be kept verbatim inside a dispatch state:
 * the jump would retarget at the state machine's own loop and switch. */
function escapes(s: IrStmt): boolean {
  const walkList = (body: IrStmt[], scopes: JumpScope[]): boolean =>
    body.some((st) => walk(st, scopes));
  const walk = (st: IrStmt, outer: JumpScope[]): boolean => {
    if (st.kind === "break" || st.kind === "continue") {
      return !resolvesWithin(st.kind, st.label, outer);
    }
    const own = scopeFor(st);
    const scopes = own === null ? outer : [...outer, own];
    switch (st.kind) {
      case "if":
        return walkList(st.then, scopes) || (st.else_ !== null && walkList(st.else_, scopes));
      case "while":
      case "doWhile":
      case "block":
      case "forOf":
        return walkList(st.body, scopes);
      case "for":
        return walkList(st.body, scopes);
      case "switch":
        return st.cases.some((c) => walkList(c.body, scopes));
      case "tryCatch":
        return (
          walkList(st.tryBody, scopes) ||
          (st.catchBody !== null && walkList(st.catchBody, scopes)) ||
          (st.finallyBody !== null && walkList(st.finallyBody, scopes))
        );
      default:
        return false;
    }
  };
  return walk(s, []);
}

/* ── the suspension shapes the pass accepts ────────────────────────────── */

type AwaitNode = Extract<IrExpr, { kind: "awaitExpr" }>;
type AwaitUnionNode = Extract<IrExpr, { kind: "awaitUnionExpr" }>;

/** One suspension in a slot the pass can split at. `hop` covers the
 * frontend's `await <non-thenable>` lowering, which is a seqExpr around a
 * zero-argument `async.hop` libCall — in two spellings: the void operand
 * puts the hop in RESULT position (there is no value to carry), everything
 * else parks the operand in a `%awaited.N` local first and the hop lands
 * in the statement list. */
type Suspension =
  | { form: "await"; node: AwaitNode }
  | { form: "awaitUnion"; node: AwaitUnionNode }
  | { form: "hop"; before: IrStmt[]; result: IrExpr | null; type: IrType }
  /** `module.await(dep)` — void-valued, and only half a suspension (see
   * the header): `dep` is the dependency's evaluation promise. */
  | { form: "moduleAwait"; dep: IrExpr; loc: SrcLoc };

function isHopCall(e: IrExpr): boolean {
  return e.kind === "libCall" && e.fn === "async.hop";
}

/** Recognize a root-position suspension, or null when the expression
 * merely CONTAINS one somewhere the pass cannot split. */
function classifySuspension(e: IrExpr): Suspension | null {
  if (e.kind === "intrinsic" && e.name === "module.await") {
    const dep = e.args[0];
    if (dep === undefined || hasSuspension(dep)) return null;
    return { form: "moduleAwait", dep, loc: e.loc };
  }
  if (e.kind === "awaitExpr") {
    return hasSuspension(e.value) ? null : { form: "await", node: e };
  }
  if (e.kind === "awaitUnionExpr") {
    return hasSuspension(e.value) ? null : { form: "awaitUnion", node: e };
  }
  if (e.kind !== "seqExpr") return null;
  const at = e.stmts.findIndex((st) => st.kind === "exprStmt" && isHopCall(st.expr));
  if (at >= 0) {
    const before = e.stmts.slice(0, at);
    const after = e.stmts.slice(at + 1);
    if (after.length > 0 || hasSuspension(before) || hasSuspension(e.result)) return null;
    return { form: "hop", before, result: e.result, type: e.type };
  }
  if (isHopCall(e.result)) {
    if (hasSuspension(e.stmts)) return null;
    return { form: "hop", before: e.stmts, result: null, type: e.type };
  }
  return null;
}

/* ── the pass ──────────────────────────────────────────────────────────── */

/** Thrown to abandon ONE function after its refusal is recorded. The emit
 * sink's refuse already throws (WasmUnsupportedError, which propagates
 * straight out of the pass); the survey sink records and returns, and this
 * is what stops the survey from lowering a function it just declined. */
class AsyncBail extends Error {}

/** Rewrite every resumable function in `mod` into ordinary IR.
 *
 * Async functions whose bodies the pass can linearize become a frame
 * shape, a `%<name>.resume` state loop, and a spawn wrapper in place of
 * the original; everything else — generators, and the async shapes listed
 * in the header — is returned untouched, having named itself through
 * `refuse` first, so the emitter's own whole-function gate still reports
 * it. A module with nothing resumable in it comes back by identity. */
export function lowerResumableFunctions(mod: IrModule, refuse: Refuse): WModule {
  if (!mod.functions.some((fn) => fn.async === true)) return mod;

  const functions: WFunction[] = [];
  const records: IrRecordShape[] = [...(mod.records ?? [])];
  let changed = false;

  for (const fn of mod.functions) {
    // Generators keep their own gate: nothing here understands yield.
    if (fn.async !== true || fn.generator !== undefined) {
      functions.push(fn);
      continue;
    }
    let lowered: { wrapper: WFunction; resume: WFunction; frame: IrRecordShape } | null = null;
    try {
      lowered = new FunctionLowering(mod, fn, refuse).run();
    } catch (err) {
      if (!(err instanceof AsyncBail)) throw err;
    }
    if (lowered === null) {
      functions.push(fn);
      continue;
    }
    changed = true;
    records.push(lowered.frame);
    functions.push(lowered.wrapper, lowered.resume);
  }

  if (!changed) return mod;
  return { ...mod, functions, records };
}

const FRAME_LOCAL = "%async.frame";
/** Resume's actual parameter — the base-typed frame the cast prologue
 * narrows into FRAME_LOCAL. */
const FRAME_ANY_LOCAL = "%async.frameAny";
const EXC_LOCAL = "%async.exc";
const DISPATCH_LABEL = "%dispatch";
const STATE_FIELD = "%state";
const PROMISE_FIELD = "%promise";

class FunctionLowering {
  private readonly loc: SrcLoc;
  private readonly frameShapeId: string;
  private readonly resumeName: string;
  private readonly frameType: IrType;
  private readonly resumeType: IrType;
  private readonly promiseType: IrType;
  /** Non-boxed locals (params included) — the total save/restore set. */
  private readonly saved: IrLocal[];
  private readonly frameFields: { name: string; type: IrType }[] = [];
  /** Dispatch states, each a stmt list that must end in a terminator. */
  private readonly states: WStmt[][] = [];
  /** Exploded break/continue targets, innermost last. */
  private readonly jumps: (JumpScope & { breakState: number; continueState: number | null })[] = [];
  private awaitSites = 0;

  constructor(
    private readonly mod: IrModule,
    private readonly fn: IrFunction,
    private readonly refuse: Refuse,
  ) {
    this.loc = fn.loc;
    this.frameShapeId = `%frame.${fn.name}`;
    this.resumeName = `%${fn.name}.resume`;
    this.frameType = { kind: "record", shapeId: this.frameShapeId };
    // Base-typed, not frame-typed: the ONE signature every resume shares.
    this.resumeType = { kind: "func", params: [widenType(FRAME_BASE)], ret: VOID };
    this.promiseType = { kind: "promise", inner: fn.returnType };
    const captured = new Set((fn.captures ?? []).map((c) => c.localId));
    this.saved = fn.locals.filter((l) => l.boxed !== true && l.tdz !== true && !captured.has(l.id));
  }

  private decline(kind: string): never {
    this.refuse(kind, this.fn.loc);
    throw new AsyncBail(kind);
  }

  run(): { wrapper: WFunction; resume: WFunction; frame: IrRecordShape } {
    this.checkEligible();
    this.buildFrameFields();

    // State 0 restores like any other entry. The wrapper never calls
    // resume with the arguments — it parks them in the frame's %l_ slots
    // and hands over the frame — so a param is an UNINITIALIZED local
    // until this runs. Skipping it would read the wasm default before the
    // first await, and (worse) the first suspend's save would write that
    // default back over the wrapper's copy for every later state. The
    // non-param locals restore from struct defaults here, which is what
    // their wasm locals already hold.
    const entry = this.newState();
    this.emit(entry, ...this.restores());
    this.lowerList(this.fn.body, entry);
    // Every state must END: a switch case that runs off its body falls
    // through into the next state's. The one state that legitimately runs
    // off the end is where control leaves the body, and completing there
    // is exactly what falling off an async body means; the rest are join
    // states nothing branched to.
    for (const state of this.states) {
      if (!isTerminator(state[state.length - 1])) state.push(...this.fellThrough());
    }

    const frame: IrRecordShape = { id: this.frameShapeId, fields: this.frameFields };
    return { wrapper: this.buildWrapper(), resume: this.buildResume(), frame };
  }

  /* ── eligibility ─────────────────────────────────────────────────────── */

  private checkEligible(): void {
    const fn = this.fn;
    // The initializer wrapper writes both caches by ASSIGNING the module
    // global (storeVar's "%g." namespace); a name that is not a global of
    // promise type would silently become a local write.
    for (const id of [fn.asyncCacheGlobal, fn.asyncCycleCacheGlobal]) {
      if (id === undefined) continue;
      const g = (this.mod.globals ?? []).find((c) => c.id === id);
      if (g === undefined || g.type.kind !== "promise") this.decline("fn:async:module-init-global");
    }
    if (fn.locals.some((l) => l.id === FRAME_LOCAL || l.id === FRAME_ANY_LOCAL || l.id === EXC_LOCAL)) {
      this.decline("fn:async:local-id-clash");
    }
    // Adoption: a promise settled WITH a promise. `await` of one would
    // read the inner promise back as the value (a miscompile), and an
    // async function returning one would settle with it.
    if (fn.returnType.kind === "promise") this.decline("fn:async:nested-promise");
    if (
      anyNode(fn.body, (rec) => {
        if (rec["kind"] !== "awaitExpr") return false;
        const t = (rec["value"] as { type?: IrType } | undefined)?.type;
        return t !== undefined && t.kind === "promise" && t.inner.kind === "promise";
      })
    ) {
      this.decline("fn:async:nested-promise");
    }
    if (hasAwaitDyn(fn.body)) this.decline("fn:async:await-dyn");
    if (hasSelfRef(fn.body)) this.decline("fn:async:self-ref");
    const captured = new Set((fn.captures ?? []).map((c) => c.localId));
    if (fn.locals.some((l) => (l.boxed === true || l.tdz === true) && !captured.has(l.id))) {
      this.decline("fn:async:boxed-local");
    }
    if (this.saved.some((l) => l.type.kind === "void")) this.decline("fn:async:void-local");
    // A `return` crossing a finally settles AFTER the finally runs, which
    // the settle-then-return rewrite gets backwards. Checked over the WHOLE
    // body (not alongside the position scan) because the try may sit inside
    // a construct the scan does not descend into.
    if (anyNode(fn.body, (rec) => rec["kind"] === "tryCatch" && rec["finallyBody"] !== null && hasReturn(rec))) {
      this.decline("fn:async:return-in-finally");
    }
    this.checkPositions(fn.body);
  }

  /** Every suspension must sit at the ROOT of a simple statement slot.
   * Anywhere else — a call argument, a condition, a for-header — needs
   * order-preserving temp hoisting the pass does not do. */
  private checkPositions(body: IrStmt[]): void {
    for (const s of body) {
      switch (s.kind) {
        case "varDecl":
          this.checkRoot(s.init, s.kind);
          break;
        case "assign":
          this.checkRoot(s.value, s.kind);
          break;
        case "exprStmt":
          this.checkRoot(s.expr, s.kind);
          break;
        case "return":
          this.checkRoot(s.value, s.kind);
          break;
        case "if":
          this.checkClean(s.cond);
          this.checkPositions(s.then);
          if (s.else_ !== null) this.checkPositions(s.else_);
          break;
        case "while":
        case "doWhile":
          this.checkClean(s.cond);
          this.checkPositions(s.body);
          break;
        case "for":
          // The header slots are expressions of the LOOP, not statement
          // roots: an await in any of them needs hoisting.
          this.checkClean(s.init);
          this.checkClean(s.cond);
          this.checkClean(s.update);
          this.checkPositions(s.body);
          break;
        case "block":
          this.checkPositions(s.body);
          break;
        case "forOf":
          if (hasSuspension(s)) this.decline("fn:async:await-in-forof");
          break;
        case "switch":
          if (hasSuspension(s)) this.decline("fn:async:await-in-switch");
          break;
        case "tryCatch":
          if (hasSuspension(s)) this.decline("fn:async:await-in-try");
          break;
        default:
          this.checkClean(s);
          break;
      }
    }
  }

  private checkRoot(e: IrExpr | null, host: IrStmt["kind"]): void {
    if (e === null || !hasSuspension(e)) return;
    const susp = classifySuspension(e);
    if (susp === null) this.decline(this.positionRefusal(e));
    // The loader's wait is void-valued and its re-entry produces nothing,
    // so the only slot that can host it is the one that discards.
    if (susp.form === "moduleAwait" && host !== "exprStmt") {
      this.decline("fn:async:module-await-position");
    }
  }

  private checkClean(node: unknown): void {
    if (hasSuspension(node)) this.decline(this.positionRefusal(node));
  }

  /** The loader's dependency wait and a user `await` need the same work
   * (order-preserving temp hoisting) in a position this pass cannot split,
   * but they are different constructs and the census says which. */
  private positionRefusal(node: unknown): string {
    return hasModuleAwait(node) ? "fn:async:module-await-position" : "fn:async:await-position";
  }

  /* ── the frame shape ─────────────────────────────────────────────────── */

  private buildFrameFields(): void {
    this.frameFields.push({ name: STATE_FIELD, type: F64 });
    this.frameFields.push({ name: PROMISE_FIELD, type: this.promiseType });
    for (const l of this.saved) this.frameFields.push({ name: slotOf(l.id), type: l.type });
    // %await<k> slots are appended as linearization discovers the sites;
    // the emitter reads a shape's field order verbatim, so append order IS
    // the layout and nothing later re-sorts it.
  }

  private awaitSlot(type: IrType): string {
    const name = `%await${++this.awaitSites}`;
    this.frameFields.push({ name, type });
    return name;
  }

  /* ── IR construction helpers ─────────────────────────────────────────── */

  private frameRef(): WExpr {
    return { kind: "varRef", localId: FRAME_LOCAL, type: this.frameType, loc: this.loc };
  }

  private get(field: string, type: IrType): WExpr {
    return { kind: "recordGet", obj: widenExpr(this.frameRef()), shapeId: this.frameShapeId, field, type, loc: this.loc };
  }

  private set(field: string, value: WExpr): WStmt {
    return {
      kind: "recordSet",
      obj: widenExpr(this.frameRef()),
      shapeId: this.frameShapeId,
      field,
      value: widenExpr(value),
      loc: this.loc,
    };
  }

  private num(value: number): IrExpr {
    return { kind: "numLit", value, type: F64, loc: this.loc };
  }

  private ret(): WStmt {
    return { kind: "return", value: null, loc: this.loc };
  }

  /** The resume closure, materialized per use (see the header: it cannot
   * live in the frame). Captures are the ASYNC function's, in its own
   * captures[] order, which is also resume's. */
  private resumeClosure(): WExpr {
    return {
      kind: "closure",
      fnName: this.resumeName,
      captures: (this.fn.captures ?? []).map((c) => c.localId),
      type: this.resumeType,
      loc: this.loc,
    };
  }

  private saves(): WStmt[] {
    return this.saved.map((l) =>
      this.set(slotOf(l.id), { kind: "varRef", localId: l.id, type: l.type, loc: this.loc }),
    );
  }

  private restores(): WStmt[] {
    return this.saved.map((l) => ({
      kind: "assign" as const,
      localId: l.id,
      value: widenExpr(this.get(slotOf(l.id), l.type)),
      loc: this.loc,
    }));
  }

  /** Fulfil the wrapper's promise with `value` and leave resume. */
  private completion(value: IrExpr | null): WStmt[] {
    const out: WStmt[] = [];
    if (this.fn.returnType.kind === "void") {
      // A void `return f()` still has to RUN f(); only its (absent) value
      // is dropped.
      if (value !== null) out.push({ kind: "exprStmt", expr: value, loc: value.loc });
      out.push({ kind: "%async.settle", promise: this.get(PROMISE_FIELD, this.promiseType), value: null, loc: this.loc });
    } else {
      out.push({
        kind: "%async.settle",
        promise: this.get(PROMISE_FIELD, this.promiseType),
        value,
        loc: value?.loc ?? this.loc,
      });
    }
    out.push(this.ret());
    return out;
  }

  /** Running off the end of a state. For a void body that is the implicit
   * `return;` — fulfil with undefined and leave.
   *
   * For a NON-void body it is dead code. Such a body cannot fall off its
   * end (the frontend appends an implicit return on every path —
   * appendImplicitUndefinedReturn), and the states this reaches are the
   * join/exit states nothing branched to; the bare `return` is there so
   * the switch case ENDS, not because anything runs it. The tempting
   * alternative — an SC9002 runtimeFence, which the wasm emitter turns
   * into `unreachable` exactly like the trap it appends to every non-void
   * sync body — is deliberately NOT used: computeMayThrow seeds on every
   * runtimeFence regardless of code, so one defensive trap per resume
   * would make every async function may-throw and put a pending check
   * after every call to one. The state graph's closure is pinned by unit
   * test instead, which is where a numbering bug actually shows up. */
  private fellThrough(): WStmt[] {
    if (this.fn.returnType.kind !== "void") return [this.ret()];
    return [
      {
        kind: "%async.settle",
        promise: this.get(PROMISE_FIELD, this.promiseType),
        value: null,
        loc: this.loc,
      },
      this.ret(),
    ];
  }

  /* ── state linearization ─────────────────────────────────────────────── */

  private newState(): number {
    this.states.push([]);
    return this.states.length - 1;
  }

  private emit(state: number, ...stmts: WStmt[]): void {
    this.states[state]!.push(...stmts);
  }

  /** Jump to state `n` and re-enter the dispatch loop. */
  private goto(n: number): WStmt[] {
    return [this.set(STATE_FIELD, this.num(n)), { kind: "continue", label: DISPATCH_LABEL, loc: this.loc }];
  }

  /** Lower a statement list into `cur`; answers the state control falls
   * through to, or null when every path out of the list terminated. */
  private lowerList(body: IrStmt[], cur: number): number | null {
    let at: number | null = cur;
    for (const s of body) {
      if (at === null) break; // unreachable tail
      at = this.lowerStmt(s, at);
    }
    return at;
  }

  private lowerStmt(s: IrStmt, cur: number): number | null {
    if (s.kind === "return") {
      const susp = s.value === null ? null : classifySuspension(s.value);
      if (susp !== null) return this.lowerSuspension(s, cur, susp);
      this.emit(cur, ...this.completion(s.value));
      return null;
    }
    if (s.kind === "break" || s.kind === "continue") {
      const target = this.resolveJump(s.kind, s.label);
      this.emit(cur, ...this.goto(target));
      return null;
    }
    if (!hasSuspension(s) && !escapes(s)) {
      // Kept verbatim — but a `return` nested inside it still has to
      // settle the promise instead of leaving the caller's value behind.
      this.emit(cur, hasReturn(s) ? this.rewriteReturns(s) : s);
      // Syntactic on purpose: an over-conservative "not terminated" only
      // costs a dead statement after the state, never correctness.
      return isTerminator(s) ? null : cur;
    }

    switch (s.kind) {
      case "varDecl":
      case "assign":
      case "exprStmt":
        return this.lowerSuspension(s, cur, classifySuspension(rootOf(s))!);
      case "if":
        return this.lowerIf(s, cur);
      case "while":
        return this.lowerWhile(s, cur);
      case "doWhile":
        return this.lowerDoWhile(s, cur);
      case "for":
        return this.lowerFor(s, cur);
      case "block":
        return this.lowerBlock(s, cur);
      default:
        // A construct with a jump out of it that the pass cannot explode
        // (for-of, switch, try); suspensions inside these already refused
        // during the eligibility scan.
        return this.decline(`fn:async:jump-out-of-${s.kind.toLowerCase()}`);
    }
  }

  private resolveJump(kind: "break" | "continue", label: string | undefined): number {
    for (let i = this.jumps.length - 1; i >= 0; i--) {
      const j = this.jumps[i]!;
      if (label !== undefined) {
        if (!j.labels.includes(label)) continue;
        if (kind === "break") return j.breakState;
        if (j.continueState !== null) return j.continueState;
        continue;
      }
      if (kind === "break" && j.breakable) return j.breakState;
      if (kind === "continue" && j.continueState !== null) return j.continueState;
    }
    // The validator guarantees source jumps resolve, and every construct
    // enclosing an exploded one is itself exploded — so an unresolved jump
    // here is a pass bug, not a program shape.
    throw new Error(`async lowering: unresolved ${kind} in "${this.fn.name}"`);
  }

  /** `return` inside a statement kept verbatim: splice the settle in
   * ahead of it, in place, everywhere it appears. */
  private rewriteReturns(s: IrStmt): WStmt {
    const list = (body: IrStmt[]): IrStmt[] => widenBody(body.flatMap((st) => rewriteOne(st)));
    const rewriteOne = (st: IrStmt): WStmt[] => {
      if (st.kind === "return") return this.completion(st.value);
      if (!hasReturn(st)) return [st];
      switch (st.kind) {
        case "if":
          return [{ ...st, then: list(st.then), else_: st.else_ === null ? null : list(st.else_) }];
        case "while":
        case "doWhile":
        case "block":
        case "forOf":
          return [{ ...st, body: list(st.body) }];
        case "for":
          return [{ ...st, body: list(st.body) }];
        case "switch":
          return [{ ...st, cases: st.cases.map((c) => ({ ...c, body: list(c.body) })) }];
        case "tryCatch":
          return [
            {
              ...st,
              tryBody: list(st.tryBody),
              catchBody: st.catchBody === null ? null : list(st.catchBody),
              finallyBody: st.finallyBody === null ? null : list(st.finallyBody),
            },
          ];
        default:
          // A `return` can only live in a statement LIST, so every kind
          // that reports one is a container handled above. Refuse rather
          // than assume if the IR ever grows one this pass has not met.
          return this.decline(`fn:async:return-in-${st.kind.toLowerCase()}`);
      }
    };
    const out = rewriteOne(s);
    if (out.length !== 1) throw new Error("async lowering: kept statement expanded");
    return out[0]!;
  }

  /* ── the suspension split ────────────────────────────────────────────── */

  /** `s` is the consuming statement (varDecl / assign / exprStmt /
   * return); `susp` is the suspension at the root of its value slot. */
  private lowerSuspension(s: IrStmt, cur: number, susp: Suspension): number {
    const resumeState = this.newState();
    let resumed: WExpr | null = null;
    const reentry: WStmt[] = [];
    // How the suspending state ENDS. Every form but the module wait leaves
    // resume outright; that one only leaves when it actually parked, so it
    // ends by falling into its own resume state through the dispatch loop
    // (%state is already k) — no microtask turn for a settled dependency.
    let tail: WStmt = this.ret();

    if (susp.form === "moduleAwait") {
      const slot = this.awaitSlot(susp.dep.type);
      this.emit(cur, this.set(slot, susp.dep));
      this.emit(cur, ...this.saves(), this.set(STATE_FIELD, this.num(resumeState)), {
        kind: "%async.subscribeIfPending",
        promise: this.get(slot, susp.dep.type),
        frame: this.frameRef(),
        resume: this.resumeClosure(),
        loc: susp.loc,
      });
      tail = { kind: "continue", label: DISPATCH_LABEL, loc: susp.loc };
      reentry.push({ kind: "%async.rejectCheck", promise: this.get(slot, susp.dep.type), loc: susp.loc });
    } else if (susp.form === "hop") {
      this.emit(cur, ...susp.before);
      this.emit(cur, ...this.saves(), this.set(STATE_FIELD, this.num(resumeState)), {
        kind: "%async.hop",
        frame: this.frameRef(),
        resume: this.resumeClosure(),
        loc: susp.before[0]?.loc ?? this.loc,
      });
      resumed = susp.result;
    } else if (susp.form === "await") {
      const node = susp.node;
      const slot = this.awaitSlot(node.value.type);
      this.emit(cur, this.set(slot, node.value));
      this.emit(cur, ...this.saves(), this.set(STATE_FIELD, this.num(resumeState)), {
        kind: "%async.subscribe",
        promise: this.get(slot, node.value.type),
        frame: this.frameRef(),
        resume: this.resumeClosure(),
        loc: node.loc,
      });
      reentry.push({ kind: "%async.rejectCheck", promise: this.get(slot, node.value.type), loc: node.loc });
      if (node.type.kind !== "void") {
        resumed = { kind: "%async.settled", promise: this.get(slot, node.value.type), type: node.type, loc: node.loc };
      }
    } else {
      const node = susp.node;
      const slot = this.awaitSlot(node.value.type);
      this.emit(cur, this.set(slot, node.value));
      this.emit(cur, ...this.saves(), this.set(STATE_FIELD, this.num(resumeState)), {
        kind: "%async.subscribeUnion",
        value: this.get(slot, node.value.type),
        promiseTag: node.promiseTag,
        frame: this.frameRef(),
        resume: this.resumeClosure(),
        loc: node.loc,
      });
      reentry.push({
        kind: "%async.rejectCheckUnion",
        value: this.get(slot, node.value.type),
        promiseTag: node.promiseTag,
        loc: node.loc,
      });
      if (node.type.kind !== "void") {
        resumed = {
          kind: "%async.settledUnion",
          value: this.get(slot, node.value.type),
          promiseTag: node.promiseTag,
          type: node.type,
          loc: node.loc,
        };
      }
    }
    this.emit(cur, tail);

    this.emit(resumeState, ...this.restores(), ...reentry);
    switch (s.kind) {
      case "varDecl":
        if (resumed !== null) {
          this.emit(resumeState, { kind: "varDecl", localId: s.localId, init: widenExpr(resumed), loc: s.loc });
        }
        break;
      case "assign":
        if (resumed !== null) {
          this.emit(resumeState, { kind: "assign", localId: s.localId, value: widenExpr(resumed), loc: s.loc });
        }
        break;
      case "exprStmt":
        // The awaited value is discarded; the reject check above is the
        // whole observable effect.
        break;
      case "return":
        this.emit(resumeState, ...this.completion(resumed === null ? null : widenExpr(resumed)));
        break;
      default:
        throw new Error(`async lowering: suspension under ${s.kind}`);
    }
    return resumeState;
  }

  /* ── exploded control flow ───────────────────────────────────────────── */

  private lowerIf(s: Extract<IrStmt, { kind: "if" }>, cur: number): number {
    const thenS = this.newState();
    const elseS = this.newState();
    const joinS = this.newState();
    this.emit(cur, {
      kind: "if",
      cond: s.cond,
      then: widenBody(this.goto(thenS)),
      else_: widenBody(this.goto(elseS)),
      loc: s.loc,
    });
    const a = this.lowerList(s.then, thenS);
    if (a !== null) this.emit(a, ...this.goto(joinS));
    const b = this.lowerList(s.else_ ?? [], elseS);
    if (b !== null) this.emit(b, ...this.goto(joinS));
    return joinS;
  }

  private lowerWhile(s: Extract<IrStmt, { kind: "while" }>, cur: number): number {
    const headS = this.newState();
    const bodyS = this.newState();
    const exitS = this.newState();
    this.emit(cur, ...this.goto(headS));
    this.emit(headS, {
      kind: "if",
      cond: s.cond,
      then: widenBody(this.goto(bodyS)),
      else_: widenBody(this.goto(exitS)),
      loc: s.loc,
    });
    this.jumps.push({
      labels: s.labels ?? [],
      loop: true,
      breakable: true,
      breakState: exitS,
      continueState: headS,
    });
    const end = this.lowerList(s.body, bodyS);
    this.jumps.pop();
    if (end !== null) this.emit(end, ...this.goto(headS));
    return exitS;
  }

  private lowerDoWhile(s: Extract<IrStmt, { kind: "doWhile" }>, cur: number): number {
    const bodyS = this.newState();
    const condS = this.newState();
    const exitS = this.newState();
    this.emit(cur, ...this.goto(bodyS));
    this.jumps.push({
      labels: s.labels ?? [],
      loop: true,
      breakable: true,
      breakState: exitS,
      // `continue` in a do-while lands at the CONDITION, not the top.
      continueState: condS,
    });
    const end = this.lowerList(s.body, bodyS);
    this.jumps.pop();
    if (end !== null) this.emit(end, ...this.goto(condS));
    this.emit(condS, {
      kind: "if",
      cond: s.cond,
      then: widenBody(this.goto(bodyS)),
      else_: widenBody(this.goto(exitS)),
      loc: s.loc,
    });
    return exitS;
  }

  private lowerFor(s: Extract<IrStmt, { kind: "for" }>, cur: number): number {
    if (s.init !== null) this.emit(cur, s.init);
    const headS = this.newState();
    const bodyS = this.newState();
    const updS = this.newState();
    const exitS = this.newState();
    this.emit(cur, ...this.goto(headS));
    this.emit(
      headS,
      ...(s.cond === null
        ? this.goto(bodyS)
        : [
            {
              kind: "if" as const,
              cond: s.cond,
              then: widenBody(this.goto(bodyS)),
              else_: widenBody(this.goto(exitS)),
              loc: s.loc,
            },
          ]),
    );
    this.jumps.push({
      labels: s.labels ?? [],
      loop: true,
      breakable: true,
      breakState: exitS,
      // `continue` in a for runs the UPDATE first.
      continueState: updS,
    });
    const end = this.lowerList(s.body, bodyS);
    this.jumps.pop();
    if (end !== null) this.emit(end, ...this.goto(updS));
    if (s.update !== null) this.emit(updS, s.update);
    this.emit(updS, ...this.goto(headS));
    return exitS;
  }

  private lowerBlock(s: Extract<IrStmt, { kind: "block" }>, cur: number): number {
    const bodyS = this.newState();
    const exitS = this.newState();
    this.emit(cur, ...this.goto(bodyS));
    this.jumps.push({
      labels: s.labels ?? [],
      loop: false,
      breakable: false,
      breakState: exitS,
      continueState: null,
    });
    const end = this.lowerList(s.body, bodyS);
    this.jumps.pop();
    if (end !== null) this.emit(end, ...this.goto(exitS));
    return exitS;
  }

  /* ── the two emitted functions ───────────────────────────────────────── */

  private buildResume(): WFunction {
    const frameAnyLocal: IrLocal = {
      id: FRAME_ANY_LOCAL,
      name: FRAME_ANY_LOCAL,
      type: widenType(FRAME_BASE),
      mutable: false,
    };
    const frameLocal: IrLocal = { id: FRAME_LOCAL, name: FRAME_LOCAL, type: this.frameType, mutable: false };
    const excLocal: IrLocal = { id: EXC_LOCAL, name: EXC_LOCAL, type: CAUGHT, mutable: false };
    const param: IrParam = { localId: FRAME_ANY_LOCAL, name: FRAME_ANY_LOCAL, type: widenType(FRAME_BASE) };
    const dispatch: WStmt = {
      kind: "while",
      cond: { kind: "boolLit", value: true, type: BOOL, loc: this.loc },
      body: widenBody([
        {
          kind: "switch",
          disc: widenExpr(this.get(STATE_FIELD, F64)),
          cases: [
            ...this.states.map((body, i) => ({ test: this.num(i), body: widenBody(body) })),
            // Unreachable: this pass is the only writer of %state, and
            // the default's job is to keep the switch total.
            { test: null, body: widenBody([this.ret()]) },
          ],
          loc: this.loc,
        },
      ]),
      labels: [DISPATCH_LABEL],
      loc: this.loc,
    };
    // The one tryCatch is load-bearing twice: a synchronous throw in the
    // body becomes this frame's REJECTION rather than unwinding into
    // whoever pumped the microtask, and the awaited-rejection re-throw
    // (%async.rejectCheck) lands here too.
    //
    // The cast prologue sits OUTSIDE it: narrowing the parameter cannot
    // fail (the runtime hands back the frame this function parked), and
    // inside the try it would be one more statement between every state
    // and its handler for no gain.
    const body: WStmt[] = [
      {
        kind: "varDecl",
        localId: FRAME_LOCAL,
        init: widenExpr({
          kind: "%async.frameCast",
          value: { kind: "varRef", localId: FRAME_ANY_LOCAL, type: widenType(FRAME_BASE), loc: this.loc },
          type: this.frameType,
          loc: this.loc,
        }),
        loc: this.loc,
      },
      {
        kind: "tryCatch",
        tryBody: widenBody([dispatch]),
        catchBody: widenBody([
          {
            kind: "%async.reject",
            promise: this.get(PROMISE_FIELD, this.promiseType),
            caught: { kind: "varRef", localId: EXC_LOCAL, type: CAUGHT, loc: this.loc },
            loc: this.loc,
          },
          this.ret(),
        ]),
        catchLocalId: EXC_LOCAL,
        finallyBody: null,
        loc: this.loc,
      },
    ];
    return {
      name: this.resumeName,
      params: [param],
      returnType: VOID,
      // The async function's own locals ride along: params become plain
      // locals restored from the frame, and received captures keep their
      // boxed entries so the emitter's box-access gates still apply.
      locals: [frameAnyLocal, frameLocal, ...this.fn.locals, excLocal],
      ...(this.fn.captures !== undefined ? { captures: this.fn.captures } : {}),
      body,
      loc: this.fn.loc,
    };
  }

  private buildWrapper(): WFunction {
    const frameLocal: IrLocal = { id: FRAME_LOCAL, name: FRAME_LOCAL, type: this.frameType, mutable: false };
    const captured = new Set((this.fn.captures ?? []).map((c) => c.localId));
    const keep = this.fn.locals.filter(
      (l) => captured.has(l.id) || this.fn.params.some((p) => p.localId === l.id),
    );
    const frameInit: IrExpr = {
      kind: "recordLit",
      // Fields the literal omits take struct.new_default: %state is 0 (the
      // entry state) and the %await/%l_ slots are filled at their first
      // suspend.
      fields: [
        { name: PROMISE_FIELD, value: widenExpr({ kind: "%async.mint", type: this.promiseType, loc: this.loc }) },
        ...this.fn.params.map((p) => ({
          name: slotOf(p.localId),
          value: { kind: "varRef" as const, localId: p.localId, type: p.type, loc: this.loc },
        })),
      ],
      type: this.frameType,
      loc: this.loc,
    };
    // JS runs an async body EAGERLY to its first await, so the wrapper
    // calls resume once before answering. A capturing resume must be
    // reached through its closure (its prologue casts arg0 down to the env
    // struct); with no captures the direct call is the cheaper shape and
    // arg0 is the dead ref.null every direct call passes.
    const kick: WStmt =
      (this.fn.captures ?? []).length === 0
        ? {
            kind: "exprStmt",
            expr: {
              kind: "call",
              callee: this.resumeName,
              args: [widenExpr(this.frameRef())],
              type: VOID,
              loc: this.loc,
            },
            loc: this.loc,
          }
        : {
            kind: "exprStmt",
            expr: {
              kind: "callValue",
              callee: widenExpr(this.resumeClosure()),
              args: [widenExpr(this.frameRef())],
              type: VOID,
              loc: this.loc,
            },
            loc: this.loc,
          };
    // A module initializer wears emit-async.ts's cache protocol on top of
    // the plain wrapper — guard first, stores after the spawn (see the
    // header for why the order is load-bearing under an import cycle).
    const cache = this.fn.asyncCacheGlobal;
    const cycleCache = this.fn.asyncCycleCacheGlobal;
    const publish = (globalId: string): WStmt => ({
      kind: "assign",
      localId: globalId,
      value: widenExpr(this.get(PROMISE_FIELD, this.promiseType)),
      loc: this.loc,
    });
    return {
      name: this.fn.name,
      params: this.fn.params,
      // Call sites already carry promise<T> (the validator's
      // callSiteReturnType); the wrapper is where that becomes literal.
      returnType: this.promiseType,
      locals: [...keep, frameLocal],
      ...(this.fn.captures !== undefined ? { captures: this.fn.captures } : {}),
      body: [
        ...(cache !== undefined
          ? [{ kind: "%async.cacheCheck" as const, globalId: cache, loc: this.loc }]
          : []),
        { kind: "varDecl", localId: FRAME_LOCAL, init: frameInit, loc: this.loc },
        kick,
        ...(cache !== undefined
          ? [
              {
                kind: "%async.markHandled" as const,
                promise: this.get(PROMISE_FIELD, this.promiseType),
                loc: this.loc,
              },
              publish(cache),
            ]
          : []),
        ...(cycleCache !== undefined ? [publish(cycleCache)] : []),
        { kind: "return", value: widenExpr(this.get(PROMISE_FIELD, this.promiseType)), loc: this.loc },
      ],
      loc: this.fn.loc,
    };
  }
}

function slotOf(localId: string): string {
  return `%l_${localId}`;
}

/** The value slot a suspension was found in (checkPositions proved there
 * is exactly one, at the root). */
function rootOf(s: IrStmt): IrExpr {
  switch (s.kind) {
    case "varDecl":
      return s.init!;
    case "assign":
      return s.value;
    case "exprStmt":
      return s.expr;
    case "return":
      return s.value!;
    default:
      throw new Error(`async lowering: no value slot on ${s.kind}`);
  }
}

/** Statement kinds that end a dispatch state: control leaves the switch
 * without falling into the next case. */
function isTerminator(s: WStmt | undefined): boolean {
  if (s === undefined) return false;
  switch (s.kind) {
    case "return":
    case "throw":
    case "rethrow":
    case "break":
    case "continue":
    case "runtimeFence":
      return true;
    default:
      return false;
  }
}
