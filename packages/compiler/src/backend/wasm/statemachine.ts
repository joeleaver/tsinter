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
 * THE PROTOCOL. Each async `f(params) -> T` becomes three things: a frame
 * record shape ({ %state, one field per live local, one PER-AWAIT-SITE
 * field for the resumed value — typed by that site, so no dyn is needed
 * anywhere }), a `%f.resume(frame)` holding the state loop, and `f` itself
 * demoted to a spawn wrapper (allocate the frame, store the params, mint
 * the promise, call resume once — JS runs an async body EAGERLY to its
 * first await — and return the promise).
 *
 * EVERY AWAIT SUSPENDS. JS spends a microtask turn even awaiting an
 * already-settled promise, so there is deliberately no settled fast path;
 * the protocol is uniform, which is what keeps the state numbering and the
 * resume dispatch simple:
 *
 *     frame.%state = k;
 *     <subscribe frame + resume to the awaited promise>;
 *     return;                       // suspend
 *   case k:                         // resumed
 *     if (frame.%threw) { <fill the increment-10 cell>; <unwind>; }
 *     ... frame.%sent<k> ...
 *
 * NOT YET LOWERED, REFUSED BY NAME (the loud-refusal contract — these are
 * real work, not oversights):
 *   - `fn:async:await-in-try` — an await inside try/catch/finally. The
 *     handler stack has to become frame state that survives suspension
 *     (regenerator carries an explicit try-entry stack), and it has to
 *     agree with the forward-only block shape and finallyStack the
 *     exception protocol emits today.
 *   - `fn:async:await-position` — an await anywhere but a simple statement
 *     slot (varDecl init, exprStmt, return, assign RHS). Everything else
 *     needs order-preserving temp hoisting before the split, because JS
 *     evaluation order across `f(await a, await b)` is observable. */
import type { IrModule } from "../../ir/nodes.js";

/** Rewrite every resumable function in `mod` into ordinary IR.
 *
 * Currently the identity: async and generator functions still reach the
 * emitter intact and refuse there by whole-function shape (`fn:async` /
 * `fn:generator`), exactly as they did before this seam existed. The pass
 * is wired in so the transform has one place to land. */
export function lowerResumableFunctions(mod: IrModule): IrModule {
  return mod;
}
