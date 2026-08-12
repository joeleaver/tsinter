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
 * GENERATORS RIDE THIS SAME SEAM, NOT A PARALLEL ONE (increment 19's
 * yield-lowering unit). The `%gen.*` kinds (suspend/sent/injectCheck)
 * grow the SAME AsyncStmt/AsyncExpr unions rather than a sibling
 * GenStmt/GenExpr pair — deliberately, not merely for naming symmetry
 * with async's own `%async.*` prefix. The emitter's six exhaustiveness
 * sites (`const rest: never = e` / `= s`, paired with a loud named
 * refusal — never a bare compile-time-only assertNever) are typed over
 * WStmt/WExpr, so a kind added to AsyncStmt/AsyncExpr becomes a compile
 * error at every one of those sites automatically, the moment it is
 * added here — no separate union to widen, no site that could silently
 * forget it. A parallel GenStmt/GenExpr pair would only inherit that
 * protection if the emitter's own WStmt/WExpr unions AND all six sites
 * were ALSO widened by hand alongside it — a second, easy-to-skip step
 * this choice makes unnecessary. The upshot: the `%async.` PREFIX on the
 * shared type names is a residue of async landing first in this file,
 * not a claim that the seam mechanism itself is async-specific —
 * `%gen.*` kinds living inside `AsyncStmt`/`AsyncExpr` is the seam
 * working exactly as designed, not an awkward fit.
 *
 * THE PROTOCOL. Each async `f(params) -> T` becomes three things: a frame
 * record shape ({ %state, one field per live local, one PER-AWAIT-SITE
 * field for the resumed value — typed by that site, so no dyn is needed
 * anywhere }), a `%f.resume(frame)` holding the state loop, and `f` itself
 * demoted to a spawn wrapper (allocate the frame, store the params, mint
 * the promise, call resume once — JS runs an async body EAGERLY to its
 * first await — and return the promise).
 *
 * A GENERATOR'S SIBLING PROTOCOL (increment 19). `function* f(): Generator
 * <Y,R,N>` becomes the SAME three things with two deltas the design doc
 * fixes precisely: the frame carries a `%gen` field (GEN_FIELD, mirroring
 * `%promise`/PROMISE_FIELD, mutually exclusive with it — buildFrameFields'
 * own branch) holding the function's `$gen<Y,R,N>` struct
 * (generators.ts's GeneratorBuilder — a wasm-backend-owned struct, never
 * an IR record, exactly like promT is for async); and the wrapper is
 * LAZY, the opposite of async's eager kick — it allocates frame + $gen,
 * stores params, runs boxInit, sets `$gen.state = UNSTARTED`, and returns
 * the $gen WITHOUT calling resume at all (a generator body runs NOTHING
 * until the first `.next()`). A `yield e` suspends through the exact
 * SAME state-splitting machinery an `await` does — state field write,
 * save, return; case k: restore, re-entry check, resumed value — with
 * `%gen.suspend`/`%gen.injectCheck`/`%gen.sent` (AsyncStmt/AsyncExpr
 * above, each documented at its own definition) standing in for
 * `%async.subscribe`/`%async.rejectCheck`/`%async.settled`. BUILD STATUS,
 * checked against the code below rather than assumed (the stale-header
 * lesson): the frame's `%gen` field and the yield-site suspend/resume
 * split (`lowerSuspension`'s "yield" case) are BUILT (stage A2b). The
 * lazy wrapper itself, `return v`'s retag-into-$gen.out-then-DONE
 * rewrite (completion()/fellThrough()'s generator branch), and
 * catch-region GENRET sentinel routing are NOT YET BUILT as of this
 * paragraph — buildWrapper/completion/fellThrough still unconditionally
 * assume async's promise-settling shape (see their own TODO markers) —
 * which is why lowerResumableFunctions' per-function skip (below) still
 * gates every real generator out: gate-widening is deliberately the LAST
 * step, once calling `.run()` on a generator function stops producing a
 * correct resume beside a wrong wrapper.
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
 * ORDER-PRESERVING HOISTING. A suspension only splits a state when it
 * sits at the ROOT of a statement's value slot, and the corpus is full of
 * `console.log(await p)`. So each statement is REWRITTEN before it is
 * lowered: its value expression is walked in EVALUATION order, everything
 * that must run before a later suspension is bound to a `%hoist.<n>`
 * temp, and each suspension lands as its own varDecl root that the
 * splitter below already knows how to take apart:
 *
 *     g(a(), await p, b())
 *   ⇒ %hoist.1 = a(); %hoist.2 = await p; g(%hoist.1, %hoist.2, b())
 *
 * What was already evaluated stays evaluated (in a temp), and what
 * follows the LAST suspension stays in place — it runs after the
 * resumption, which is exactly where JS puts it — so the interleaving is
 * source order. Literals are the one thing never hoisted: re-evaluating
 * one after the suspension is unobservable. Hoisting more than order
 * requires costs a frame field and nothing else; hoisting LESS is a
 * miscompile, which is why the rewrite is total over the positions it
 * accepts and refuses outright everywhere else.
 *
 * The positions it accepts are the ones whose evaluation order is STATIC.
 * HOIST_SLOTS and STMT_HOIST_SLOTS are the register — one entry per node
 * kind, operands in JS order (nodes.ts documents that order for the
 * writes and the literals; where it is silent the C emitter is the
 * reference for what the backends implement). Both tables are partial ON
 * PURPOSE: a kind with no entry refuses, so growing the IR can never
 * silently grow the hoister.
 *
 * CONDITIONAL positions are refused rather than hoisted
 * (`fn:async:await-conditional`): the right operand of `&&`/`||`/`??`, a
 * ternary arm, an optChain continuation and an orDefault default may all
 * never evaluate, and a temp ahead of the statement would evaluate them
 * unconditionally. Loop and for headers keep refusing under the old name
 * for the mirror-image reason — a hoist ahead of the loop would evaluate
 * once what the loop evaluates per iteration.
 *
 * Three positions are worth naming because they are not expressions in an
 * argument list: an `if` CONDITION hoists (it evaluates exactly once,
 * before either arm — the arms are statement lists the pass explodes); a
 * WRITE statement hoists every operand it has, because JS evaluates
 * `arr[i] = await p` as reference, then index, then value, and moving only
 * the value would put the other two behind the suspension; and a
 * `seqExpr` is SPLICED, its straight-line statements landing in the host
 * list at the point the expression itself would have run.
 *
 * The rewrite runs BEFORE checkPositions, which is left as the checker of
 * what hoisting could not fix.
 *
 * SAVE/RESTORE IS TOTAL, NOT LIVE. Every non-boxed local (params and
 * `%hoist.<n>` temps included) is written at every suspend and read back
 * at every re-entry — STATE 0 INCLUDED, because the wrapper passes the
 * arguments through the frame's %l_ slots rather than through resume's
 * signature, so the entry state is where params become locals. No
 * liveness analysis: a value that was never assigned restores as the
 * slot's zero, and the frontend's definite-assignment guarantee means no
 * read observes it. Received CAPTURES are excluded on purpose — they are
 * boxes, they ride resume's own closure environment, and the box identity
 * is what aliasing across a suspension depends on.
 *
 * BOXES THE BODY OWNS RIDE THE ENV TOO. A local the body declares and a
 * nested closure captures lives in a one-field mutable box (increment 5),
 * and every access — the declaring function's included — goes through it.
 * By-value save/restore cannot carry one: two closures and the frame must
 * see ONE box, so copying its contents into a frame slot and back would
 * fork the binding at every suspension. The fix is to make a body box
 * look exactly like a RECEIVED one, which the protocol already carries:
 *
 *   1. The WRAPPER pre-creates it (`%async.boxInit`), with the payload
 *      struct.new_default gives — which is precisely what the sync
 *      `varDecl` emits for an uninitialized boxed local, TDZ sentinel
 *      included (a tdz box's empty state IS its null inner slot).
 *   2. resume's `captures` grow by one entry per box, so every re-entry
 *      unpacks the SAME wrapper-made box out of the env. Order is
 *      RECEIVED captures first (fn.captures order), then the body's own
 *      in `locals` order — the frontend's declaration order, so the
 *      layout is a function of the input alone.
 *   3. The body's `varDecl` becomes an `assign`, which stores THROUGH the
 *      box instead of minting a new one (storeVar), so the identity the
 *      closures captured is the identity the declaration fills — and for
 *      a tdz local that assign is the same statement the sync path uses
 *      to leave the dead zone.
 *
 * A boxed PARAM needs no boxInit: the wrapper still declares the
 * parameter, and the emitter's prologue re-boxes every boxed argument
 * into its own slot. Both kinds drop out of the frame (they are box refs
 * in an env, not values in a struct), which is why the wrapper's frame
 * literal skips a boxed param's `%l_` field — there is none.
 *
 * WHAT PRE-CREATION CANNOT SERVE is refused by name rather than aliased
 * together; see `fn:async:boxed-in-loop` and `fn:async:boxed-forward-
 * capture` in the refusal list.
 *
 * COMPLETION AND FAILURE. `return v` becomes `%async.settle(frame.%promise,
 * v)` + `return`, wherever it appears (returns inside statements the pass
 * keeps VERBATIM are rewritten in place). A synchronous throw anywhere in
 * the body has to become a rejection instead of unwinding into the
 * caller, which is what resume's one tryCatch is for.
 *
 * TRY/CATCH ACROSS A SUSPENSION — AND WHY THE FRAME NEEDS NOTHING FOR IT.
 * regenerator carries an explicit try-entry STACK in the generator object,
 * pushed and popped at runtime, because it re-derives the handler from the
 * program counter at throw time. This pass does not need one: the states
 * are numbered AT COMPILE TIME, so "which handler covers this state" is a
 * static map, and the map compiles into the catch arm as an ordinary
 * dispatch. Nothing about a region survives into the frame — no push, no
 * pop, no depth counter, nothing to save or restore.
 *
 * That map is what decides resume's skeleton. The tryCatch moves INSIDE
 * the dispatch loop, so the loop can keep running after it fires:
 *
 *     while (%dispatch) {
 *       tryCatch {
 *         switch (frame.%state) { ...the states... }
 *       } catch (%async.exc) {
 *         switch (frame.%state) {           // the STATIC routing table
 *           case <a state in a protected region>:
 *             <that region's catch binding> = %async.exc;
 *             <save every local>;           // binding first — see below
 *             frame.%state = <that region's handler state>;
 *             break;                        // fall out; the loop re-dispatches
 *           default:                        // no region covers this state
 *             %async.reject(frame.%promise, %async.exc);
 *             return;
 *         }
 *       }
 *     }
 *
 * The restructure is UNIFORM — a function with no try at all gets the same
 * skeleton, its catch arm being the reject default alone — because a
 * second shape would be a second thing to reason about for no gain.
 *
 * A try/catch some suspension crosses LINEARIZES: the try body becomes
 * states, the catch body becomes states, and both meet at a join state.
 * The region stack is open only while the TRY body is lowered, so every
 * state created there — including states from nested constructs the pass
 * explodes — maps to that try's handler, and the catch body's states map
 * to whatever encloses the statement instead (a catch body is not
 * protected by its own try). Nested trys nest, innermost wins, for free.
 *
 * TWO ORDERING FACTS, both load-bearing:
 *
 *   - The try body opens a state of its OWN. `cur` may already hold the
 *     statements that ran BEFORE the try, and those are not protected;
 *     a state's handler is fixed when the state is created, so the region
 *     can only start at a state boundary.
 *   - The catch arm writes the BINDING before it saves. The arm is reached
 *     by a BRANCH, never a re-entry, so every wasm local is still live and
 *     current — a mid-state throw never left resume, and on the
 *     rejectCheck path the re-entry's restores have already run — which is
 *     why the handler state needs no restore prologue and reads the locals
 *     directly. The saves are what keep the frame current at the state
 *     boundary anyway; writing the binding first is what makes the slot
 *     and the local agree rather than disagree.
 *
 * `rethrow` inside a lowered catch body needs no special case: it refills
 * the cell from the caught snapshot and unwinds into the SAME per-iteration
 * catch, whose table routes it to the enclosing handler — or to the reject
 * default, which is the rejection the `.finally` desugar wants.
 *
 * A break or continue LEAVING a protected region is a plain state jump.
 * With no finalizer there is nothing to run on the way out, and the target
 * state was created before the region opened, so it already carries the
 * outer handler.
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
 *     the root of an `exprStmt`. The wait is VOID-valued and its re-entry
 *     produces nothing, so no temp can stand in for it: hoisting rewrites
 *     its dependency operand, never the wait itself. The frontend emits
 *     exactly the statement shape, and the two names are kept apart so
 *     the census keeps naming the construct that actually needs work.
 *   - `fn:async:await-in-finally` — a suspension anywhere inside a
 *     try/catch/FINALLY. A finalizer takes part in COMPLETION: a return, a
 *     break and plain fallthrough each have to run it before they leave,
 *     which the emitter does with three copies of the body and a
 *     pending-return path (finallyStack) — and across a suspension those
 *     copies are states that have to re-dispatch to different places
 *     depending on why the region was left. Real machinery, and its own
 *     stage; a plain try/catch needs none of it, which is why the two are
 *     told apart by name.
 *   - `fn:async:await-position` — an await in a slot the hoisting rewrite
 *     cannot move it out of: a loop or for header (hoisting would
 *     evaluate once what the loop evaluates per iteration), a statement
 *     kind whose operand order this pass has no contract for, or an
 *     expression kind absent from HOIST_SLOTS. Ordinary operand
 *     positions no longer refuse — they hoist (see ORDER-PRESERVING
 *     HOISTING above).
 *   - `fn:async:await-conditional` — an await under an operator that may
 *     not evaluate it: the right side of `&&`/`||`/`??`, a ternary arm,
 *     an optChain continuation, an orDefault default. A temp ahead of the
 *     statement would evaluate it unconditionally, so this is the one
 *     position where hoisting is a MISCOMPILE rather than a cost; making
 *     it a name of its own is what lets the census measure the
 *     conditional-await shapes on their own.
 *   - `fn:async:hoist-void` — a hoist whose temp would be void-typed: the
 *     frame has no slot for one, and the operand position it came from
 *     still needs SOME expression back. The reachable shape is a recordLit
 *     `drop` field holding a void await (`{ status, value: await f() }`
 *     where the checker dropped `value`) inside a statement that cannot
 *     host a split — one corpus program, and the fix is a way to run a
 *     suspension for its effect alone rather than a wider hoist.
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
 *     construct this pass keeps verbatim (a for-of, a switch, or a try
 *     with a finalizer) for a construct it exploded. Keeping the jump
 *     would retarget it at the dispatch switch; exploding the container
 *     is the same work as the two entries above. A plain try/catch is no
 *     longer in that set — it linearizes, and a jump out of one leaves
 *     nothing to run.
 *   - `fn:async:boxed-in-loop` — a body-boxed local whose declaration can
 *     run more than once: inside a loop, in a `for` header, or as a
 *     for-of binding. JS gives each execution a FRESH binding (the
 *     emitter re-boxes per iteration for exactly this reason), so the
 *     ONE box the wrapper pre-creates would alias every iteration's
 *     closures together — a miscompile, not a slower answer.
 *   - `fn:async:boxed-forward-capture` — a NON-tdz body box some closure
 *     captures ahead of its declaration. Such a closure would read the
 *     box's default payload where JS says `undefined`. The frontend does
 *     not emit the shape (a forward-captured `const` becomes a tdz box,
 *     whose sentinel answers with Node's ReferenceError; a forward-
 *     captured `var` gets its hoisted `undefined` initializer pushed
 *     AHEAD of the capturing closure; a forward-captured `let` is fenced
 *     in the frontend), so this is the structural proof of that, not a
 *     measured rock.
 *   - `fn:async:boxed-local` — a body-boxed local this pass cannot place:
 *     no declaration at all, more than one, or one nested somewhere the
 *     placement walk does not reach. Unreachable from today's frontend
 *     (one boxed binding has exactly one `varDecl`); it refuses rather
 *     than pre-create a box whose declaration it could not find.
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
  /** The union-armed read. `type` is the awaitUnionExpr result union —
   * a DIFFERENT interned union from `value`'s, with its own typeKey-sorted
   * numbering, so the consumer must map every arm by TYPE. Never emitted
   * when the result is void (there is nothing to read). */
  | { kind: "%async.settledUnion"; value: WExpr; promiseTag: number; type: IrType; loc: SrcLoc }
  /** Read $gen.sent — the value a `.next(arg)` resume delivered, typed
   * `nextT` (`type` here). Mirrors `%async.settled` exactly: the pass
   * never touches $gen's own field layout (generators.ts's GeneratorBuilder
   * owns that, backend-side, same as promT for PromiseBuilder) — it hands
   * over the $gen expression and the static type it expects back, and the
   * emitter's own implementation (stage A3) does the field read. Never
   * emitted when nextT is the undefined unit — nothing to read, same rule
   * `%async.settled` follows for a void await. */
  | { kind: "%gen.sent"; gen: WExpr; type: IrType; loc: SrcLoc };

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
  | { kind: "%async.markHandled"; promise: WExpr; loc: SrcLoc }
  /** Allocate a body-boxed local's box, empty, into the wrapper's slot —
   * the one statement that lets a body box ride resume's env (see the
   * header). Its payload is struct.new_default's, which is bit for bit
   * what the sync `varDecl` of an uninitialized boxed local emits. */
  | { kind: "%async.boxInit"; localId: string; loc: SrcLoc }
  /** A generator's suspend: write `value` into $gen.out and set
   * $gen.state = SUSPENDED, ATOMICALLY (one seam, not two writes) — the
   * design doc's "yield at site k: ...write out; ...gen.state=SUSPENDED"
   * pair, combined the same way `%async.settle` combines "write the
   * fulfillment value" and "the promise is now fulfilled" into one op.
   * `value` is the RAW yieldT-typed operand (`null` for a bare `yield;`,
   * mirroring yieldExpr's own `value: IrExpr | null`) — NOT pre-retagged
   * into $gen.out's V representation. Retagging (dyn wrap, or a union
   * tag the pass has no way to know without reaching into $gen's backend
   * layout) is the emitter's job when it implements this op (stage A3),
   * exactly how `%async.settled`'s reader never needed the pass to know
   * promT's tag encoding either — same seam, same reason. */
  | { kind: "%gen.suspend"; gen: WExpr; value: WExpr | null; loc: SrcLoc }
  /** A generator re-entry's injection check — mirrors `%async.rejectCheck`'s
   * role exactly, generalized to three cases instead of one: reads
   * $gen.inject and branches. NEXT is a no-op (falls through — the
   * caller's `%gen.sent` read, emitted separately right after this in
   * lowerSuspension's resume state, is the whole observable effect).
   * THROW copies the CALLER-PREFILLED exception cell payload and unwinds
   * (the design doc: "the caller pre-filled the exception cell — mirror
   * of %async.rejectCheck" — genResume's throw mode fills the SAME
   * increment-10 pending-exception cell before calling resume, so this
   * op's THROW arm is rejectCheck's unwind with the fill already done
   * upstream, not repeated here). GENRET sets the GENRET cell KIND
   * (increment 10's cell grows this tag — carries no payload, retPark
   * already holds the value) and unwinds the SAME way. Both unwind arms
   * land in resume's own catch and its static routing table exactly like
   * any other exception — no new control-flow mechanism, just a new way
   * to ARRIVE at the existing one. This is the op stage B's finalizer
   * work builds on: a finalizer crossed by a GENRET unwind sees the SAME
   * cell kind at its own catch entry, which is why the design doc calls
   * catch's GENRET handling a "sentinel re-unwind prologue" rather than a
   * generator-specific special case. */
  | { kind: "%gen.injectCheck"; gen: WExpr; loc: SrcLoc };

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
 * still pending but is a state split either way.
 *
 * `yieldExpr` joins the set ahead of any generator lowering (increment
 * 19's yield-lowering unit, staged before `classifySuspension`/
 * `lowerSuspension` grow their own generator arms — see that unit's
 * notes): currently INERT, not yet load-bearing. `yieldExpr` is
 * frontend-fenced to generator bodies only (nodes.ts's own doc comment),
 * and no generator body reaches this pass today (the per-function skip
 * in `lowerResumableFunctions` below), so nothing walks a subtree
 * containing one yet. Recognizing it here now (rather than alongside
 * `classifySuspension`) is what lets `HOIST_SLOTS`'s new `genResume`
 * entry actually find a NESTED yield inside a genResume argument once
 * generators do reach this pass (yield*'s forwarding loop nests one
 * exactly there) — `hasSuspension` has to see it before hoisting can act
 * on it. */
function isSuspensionNode(rec: Record<string, unknown>): boolean {
  const kind = rec["kind"];
  if (kind === "awaitExpr" || kind === "awaitUnionExpr" || kind === "yieldExpr") return true;
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

/* ── where a body box is declared ──────────────────────────────────────── */

/** Everything the box plan needs to know about one body-boxed local (see
 * the header's BOXES THE BODY OWNS section). */
interface BoxSite {
  /** Declarations the STRUCTURED walk below found — a for-of binding
   * counts as one, since that is where its box is minted. */
  decls: number;
  /** Some declaration sits where it can run more than once. */
  inLoop: boolean;
  /** A `closure` listing this local was built before its declaration. */
  earlyCapture: boolean;
}

/** Walk `body` in SOURCE order, recording each id's declaration sites and
 * whether a closure over it was built ahead of them.
 *
 * Tree order is time order for the "ahead of" question: reaching a
 * closure before a declaration that lexically precedes it needs a
 * backward jump, and a loop holding the closure but not the declaration
 * necessarily opens before the declaration in tree order too. Loop bodies
 * are still walked — a closure inside one is "after" a declaration above
 * it — and only the DECLARATION positions inside them are what `inLoop`
 * reports. */
function boxSites(body: IrStmt[], ids: Set<string>): Map<string, BoxSite> {
  const sites = new Map<string, BoxSite>();
  for (const id of ids) sites.set(id, { decls: 0, inLoop: false, earlyCapture: false });
  const declared = new Set<string>();

  const scanExpr = (node: unknown): void => {
    anyNode(node, (rec) => {
      if (rec["kind"] !== "closure") return false;
      for (const id of (rec["captures"] as string[] | undefined) ?? []) {
        if (ids.has(id) && !declared.has(id)) sites.get(id)!.earlyCapture = true;
      }
      return false;
    });
  };
  const declare = (id: string, inLoop: boolean): void => {
    const site = sites.get(id);
    if (site === undefined) return;
    site.decls++;
    if (inLoop) site.inLoop = true;
    declared.add(id);
  };
  const list = (stmts: IrStmt[], inLoop: boolean): void => {
    for (const s of stmts) walk(s, inLoop);
  };
  const walk = (s: IrStmt, inLoop: boolean): void => {
    switch (s.kind) {
      case "varDecl":
        // The initializer evaluates BEFORE the binding is initialized, so
        // a closure in it is an early capture like any other.
        scanExpr(s.init);
        declare(s.localId, inLoop);
        return;
      case "if":
        scanExpr(s.cond);
        list(s.then, inLoop);
        if (s.else_ !== null) list(s.else_, inLoop);
        return;
      case "block":
        list(s.body, inLoop);
        return;
      case "while":
      case "doWhile":
        scanExpr(s.cond);
        list(s.body, true);
        return;
      case "for":
        if (s.init !== null) walk(s.init, true);
        scanExpr(s.cond);
        scanExpr(s.update);
        list(s.body, true);
        return;
      case "forOf":
        scanExpr(s.iterable);
        // The per-iteration binding IS a fresh box every pass.
        declare(s.localId, true);
        list(s.body, true);
        return;
      case "switch":
        scanExpr(s.disc);
        for (const c of s.cases) {
          scanExpr(c.test);
          list(c.body, inLoop);
        }
        return;
      case "tryCatch":
        list(s.tryBody, inLoop);
        if (s.catchBody !== null) list(s.catchBody, inLoop);
        if (s.finallyBody !== null) list(s.finallyBody, inLoop);
        return;
      default:
        scanExpr(s);
        return;
    }
  };
  list(body, false);
  return sites;
}

/** Every `varDecl` of `id` ANYWHERE in the tree, `seqExpr` bodies and
 * unwalked containers included. Disagreeing with boxSites's structured
 * count means a declaration sits somewhere the plan cannot reason about,
 * which is a refusal rather than a guess. */
function declCount(node: unknown, id: string): number {
  let n = 0;
  anyNode(node, (rec) => {
    if (rec["kind"] === "varDecl" && rec["localId"] === id) n++;
    return false;
  });
  return n;
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
type YieldNode = Extract<IrExpr, { kind: "yieldExpr" }>;

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
  | { form: "moduleAwait"; dep: IrExpr; loc: SrcLoc }
  /** `yield e` (or bare `yield;`, `node.value === null`) — a generator's
   * OWN suspension root, never present in an async body (yieldExpr is
   * frontend-fenced to generator bodies). */
  | { form: "yield"; node: YieldNode };

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
  if (e.kind === "yieldExpr") {
    // hasSuspension(null) is false (anyNode's own null guard) — the bare
    // `yield;` case (e.value === null) needs no special handling here.
    return hasSuspension(e.value) ? null : { form: "yield", node: e };
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

/* ── the hoistable positions ───────────────────────────────────────────── */

/** One operand position of a node: a plain field, a whole list field, or
 * one field of every entry of a list field. */
type HoistSlot = string | { list: string } | { each: string; field: string };

/** Expression kinds the rewrite may hoist THROUGH, each with its operands
 * in JS evaluation order — the register the header's HOISTING section
 * describes. Absence is a refusal, so this table is the whole contract:
 * every kind here evaluates its operands unconditionally, in this order,
 * and every kind NOT here — the conditional operators, most of the dyn
 * surface, anything the IR grows later — refuses instead of guessing. */
const HOIST_SLOTS: Partial<Record<IrExpr["kind"], HoistSlot[]>> = {
  // Operators. `bin` is the non-short-circuit family by construction
  // (IrNumBinOp); `logical`/`nullish`/`ternary`/`orDefault`/`optChain` are
  // deliberately absent.
  bin: ["left", "right"],
  unary: ["operand"],
  toBool: ["operand"],
  toString: ["operand"],
  strConcat: ["left", "right"],
  strEq: ["left", "right"],
  strCmp: ["left", "right"],
  unionEq: ["left", "right"],
  assignExpr: ["value"],
  // Calls: the callee expression evaluates before the arguments, and the
  // arguments in source order (ArgumentListEvaluation).
  call: [{ list: "args" }],
  callValue: ["callee", { list: "args" }],
  ffiCall: [{ list: "args" }],
  intrinsic: [{ list: "args" }],
  libCall: [{ list: "args" }],
  new: [{ list: "args" }],
  newValue: ["callee", { list: "args" }],
  virtualCall: [{ list: "args" }],
  // The island's engine ops are argument lists like any call (the C
  // emitter evaluates them left to right); a jsval TEMP is out of tier on
  // its own, which is the refusal such a program should be wearing.
  jsOp: [{ list: "args" }],
  strIntrinsic: ["receiver", { list: "args" }],
  arrIntrinsic: ["receiver", { list: "args" }],
  bytesIntrinsic: ["receiver", { list: "args" }],
  mapIntrinsic: ["receiver", { list: "args" }],
  setIntrinsic: ["receiver", { list: "args" }],
  regexIntrinsic: ["receiver", { list: "args" }],
  // Containers. recordLit's list is SOURCE order and covers `drop` and
  // `overflow` entries too — a dropped field's value still evaluates.
  arrayLit: [{ list: "elems" }],
  arrayNewLen: ["length"],
  arrayGet: ["arr", "index"],
  bytesNew: ["source"],
  setNew: ["seed"],
  recordLit: [{ each: "fields", field: "value" }],
  recordGet: ["obj"],
  recordKeyGet: ["obj", "key"],
  recordOvfKeys: ["obj"],
  fieldGet: ["obj"],
  fieldIncDec: ["obj"],
  jsonStringify: ["value"],
  // The two marshalling conversions. The rest of the dyn surface stays
  // out: `dynObjLit` and `mapNew` interleave key and value per entry,
  // which the slot vocabulary above cannot even spell, and the kinds that
  // could be spelled would only trade one out-of-tier refusal for
  // another. These two are here because a single operand has no order to
  // get wrong, and a dyn/jsval TEMP is the honest refusal for the
  // programs that reach them.
  dynFrom: ["value"],
  dynFromJsval: ["value"],
  // Type-only and tag-only nodes: one operand, nothing else to order.
  upcast: ["value"],
  downcast: ["value"],
  promiseVoidWiden: ["value"],
  instanceOf: ["value"],
  instanceOfValue: ["value", "classValue"],
  unionWrap: ["value"],
  unionNarrow: ["value"],
  unionDisc: ["value"],
  unionIsTag: ["value"],
  // Receiver before key: JS's `r[k]` order, and the C emitter's.
  unionKeyGet: ["value", "key"],
  // An await UNDER an await (`await f(await p)`): the inner one hoists
  // first and the outer is left as the root it already was.
  awaitExpr: ["value"],
  awaitUnionExpr: ["value"],
  newPromise: ["executor"],
  // `yield e` — a suspension ROOT (isSuspensionNode above), same as
  // awaitExpr; this entry only matters for a yield NESTED under another
  // hoistable position (mirrors "an await under an await"), since a root
  // yield never reaches hoistParts at all (hoistRoot returns a root
  // suspension unchanged — classifySuspension's job, not the hoister's).
  // Currently unreachable (see isSuspensionNode's note): no generator body
  // reaches this pass yet.
  yieldExpr: ["value"],
  // `g.next(arg)`/`g.return(arg)`/`g.throw(arg)` — NOT itself a suspension
  // (a generator resume from the CONSUMER's side is synchronous; see the
  // design doc's "no event loop" framing), but its `arg` can CONTAIN one:
  // yield*'s forwarding loop nests a yield inside `.next(...)`'s argument
  // (`%dele.next(<yield %dr.value>)`), and 2017's corpus shape puts a
  // genResume beside an await in the same async function. Operand order
  // is `gen` then `arg` — the generator reference evaluates before the
  // sent value, matching a method call's receiver-then-arguments order.
  // LIVE today, unlike the two entries above: `genResume` can appear
  // inside an ORDINARY async function's body (any function may hold and
  // drive a generator), so a genResume node whose `arg` awaits something
  // no longer refuses at THIS layer (`fn:async:await-position`) — it
  // hoists cleanly and meets the emitter's own `expr:genResume` refusal
  // instead (genResume emission is unimplemented until stage A3), a
  // strictly more precise refusal name for the same not-yet-supported
  // program, never a miscompile either way.
  genResume: ["gen", "arg"],
};

/** Statement kinds whose embedded expressions the rewrite may hoist —
 * none of them can host a state split, so EVERY suspended operand becomes
 * a temp ahead of the statement. Orders are nodes.ts's own (`arraySet` and
 * `bytesSet` say nothing there, and the C emitter spells out the JS order:
 * array, index, then value). */
const STMT_HOIST_SLOTS: Partial<Record<IrStmt["kind"], HoistSlot[]>> = {
  arraySet: ["arr", "index", "value"],
  bytesSet: ["arr", "index", "value"],
  fieldSet: ["obj", "value"],
  recordSet: ["obj", "value"],
  recordKeySet: ["obj", "key", "value"],
  recordKeyDelete: ["obj", "key"],
};

/** Operators whose operands evaluate CONDITIONALLY — hoisting one ahead
 * of the statement would evaluate what JS may skip. Named apart from the
 * rest of the un-hoistable positions so the census can measure them. */
const CONDITIONAL_KINDS = new Set<IrExpr["kind"]>(["logical", "nullish", "ternary", "optChain", "orDefault"]);

/** Values a suspension may be re-ordered PAST: re-evaluating one after the
 * resumption yields the same value and no effects, so they need no temp. */
function isStable(e: IrExpr): boolean {
  switch (e.kind) {
    case "numLit":
    case "strLit":
    case "boolLit":
    case "unitLit":
      return true;
    default:
      return false;
  }
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
/** The hoisting rewrite's temps (see the header). Guarded against a
 * source local wearing the same prefix, like the three bindings above. */
const HOIST_PREFIX = "%hoist.";
const DISPATCH_LABEL = "%dispatch";
const STATE_FIELD = "%state";
const PROMISE_FIELD = "%promise";
/** A generator frame's back-reference to its own $gen<triple> struct —
 * mirrors PROMISE_FIELD exactly: the wrapper allocates both frame and
 * $gen together (the design doc's Representation section), and resume,
 * given only the frame, needs a way back to $gen's own state/out/sent/
 * inject/retPark slots. Only present on a generator's frame; async's
 * carries PROMISE_FIELD instead — the two are mutually exclusive, same
 * as fn.generator/fn.async themselves. */
const GEN_FIELD = "%gen";

/** Exported for the test surface ONLY (increment 19's yield-lowering
 * unit): lowerResumableFunctions' own gate keeps every real generator
 * OUT of this class until the yield machinery is ready to receive one
 * (see the file header and lowerResumableFunctions below) — widening
 * that gate is deliberately its own, LAST step. Until then, nothing but
 * a test can reach a generator-shaped FunctionLowering at all, and
 * house rule #9 (increment 18: "force-emit what the lowering cannot
 * reach, behaviorally test what it can") says that is exactly when a
 * construction path needs to exist for tests to use directly. */
export class FunctionLowering {
  private readonly loc: SrcLoc;
  private readonly frameShapeId: string;
  private readonly resumeName: string;
  private readonly frameType: IrType;
  private readonly resumeType: IrType;
  private readonly promiseType: IrType;
  /** The function's OWN generator type (yieldT/retT/nextT), null for an
   * async function. Mutually exclusive with promiseType's relevance,
   * mirroring fn.generator/fn.async themselves. */
  private readonly genType: IrType | null;
  /** The function's locals plus the hoisting rewrite's temps. */
  private readonly locals: IrLocal[];
  /** The body AFTER the hoisting rewrite — what the linearization walks. */
  private body: IrStmt[];
  /** Non-boxed locals (params and hoist temps included) — the total
   * save/restore set, fixed once the rewrite has stopped adding temps. */
  private saved: IrLocal[] = [];
  /** Boxed (or tdz) locals this function OWNS rather than received — the
   * wrapper makes their boxes and resume captures them, in `locals`
   * order. See the header's BOXES THE BODY OWNS section. */
  private bodyBoxed: IrLocal[] = [];
  /** The subset the wrapper must allocate. A boxed PARAM is excluded: the
   * wrapper declares the parameter, and the emitter's prologue re-boxes
   * every boxed argument into its slot before the body runs. */
  private boxInits: IrLocal[] = [];
  private readonly bodyBoxedIds = new Set<string>();
  private hoisted = 0;
  private readonly frameFields: { name: string; type: IrType }[] = [];
  /** Dispatch states, each a stmt list that must end in a terminator. */
  private readonly states: WStmt[][] = [];
  /** Parallel to `states`: the handler state of the innermost protected
   * region each one was created inside, or -1 for none. A state's handler
   * is fixed by WHERE IT WAS CREATED, which is the whole reason the frame
   * needs no try-entry stack (see the header). */
  private readonly handlerOf: number[] = [];
  /** Protected regions open during linearization, innermost last. */
  private readonly regions: { handler: number }[] = [];
  /** Each region's catch binding, by handler state — recorded when the
   * region opens, read when the catch arm's routing table is built. */
  private readonly catchBindings = new Map<number, string | null>();
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
    this.genType =
      fn.generator !== undefined
        ? { kind: "generator", yieldT: fn.generator.yieldT, retT: fn.returnType, nextT: fn.generator.nextT }
        : null;
    this.locals = [...fn.locals];
    this.body = fn.body;
  }

  private decline(kind: string): never {
    this.refuse(kind, this.fn.loc);
    throw new AsyncBail(kind);
  }

  run(): { wrapper: WFunction; resume: WFunction; frame: IrRecordShape } {
    // GUARD, not documentation (the A2b gate's F2 finding): buildWrapper
    // and catchArm (reached through buildResume) BOTH write/reference
    // PROMISE_FIELD unconditionally — buildWrapper's frameInit literal
    // names it directly, and catchArm's "reject" default arm (embedded in
    // EVERY resume, whether or not the body has a covering try/catch —
    // the routing table's fallback for "no protected region") does too.
    // Neither checks genType. Until the lazy wrapper (buildWrapper) and
    // the GENRET-aware routing default (catchArm) exist — the NEXT
    // sub-unit's work, not this one's — calling this for a generator
    // would construct a recordLit/resume body naming a "%promise" field
    // the frame (buildFrameFields' own genType branch) no longer even
    // declares: invalid IR, not a crash (nothing here cross-checks field
    // names against the shape), which is exactly why it has to be
    // refused HERE rather than produced and trusted downstream.
    // runFrameAndStatesForTest() below is the narrower surface that
    // stays clear of both broken paths, for exactly this reason.
    if (this.genType !== null) this.decline("fn:async:generator-wrapper-not-built");

    this.checkEligible();
    this.buildFrameFields();
    this.splitStates();

    const frame: IrRecordShape = { id: this.frameShapeId, fields: this.frameFields };
    return { wrapper: this.buildWrapper(), resume: this.buildResume(), frame };
  }

  /** The state-splitting loop shared by run() and the test-only surface
   * below: eligibility already checked, frame fields already built: walk
   * the body into per-state statement lists and close every state that
   * fell off its own end. */
  private splitStates(): void {
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
    this.lowerList(this.body, entry);
    // Every state must END: a switch case that runs off its body falls
    // through into the next state's. The one state that legitimately runs
    // off the end is where control leaves the body, and completing there
    // is exactly what falling off an async body means; the rest are join
    // states nothing branched to.
    for (const state of this.states) {
      if (!isTerminator(state[state.length - 1])) state.push(...this.fellThrough());
    }
  }

  /** TEST-ONLY (see the class's own export comment): the frame shape and
   * the raw per-state statement lists, WITHOUT buildResume/buildWrapper/
   * catchArm — the two paths run()'s own guard above refuses generators
   * from reaching, because both are unconditionally async-shaped today.
   * This is how the A2b yield-lowering tests verify the suspend/resume
   * split (%gen.suspend/%gen.injectCheck/%gen.sent) without ever
   * constructing the invalid IR those two paths would produce for a
   * generator. Callable for an async function too (nothing here is
   * generator-specific), but the real entry point (run()) is the one
   * that matters for async — this exists for generators specifically. */
  runFrameAndStatesForTest(): { frame: IrRecordShape; states: WStmt[][] } {
    this.checkEligible();
    this.buildFrameFields();
    this.splitStates();
    return { frame: { id: this.frameShapeId, fields: this.frameFields }, states: [...this.states] };
  }

  /* ── eligibility and the hoisting rewrite ────────────────────────────── */

  /** One phase: the checks that read the SOURCE body, then the rewrite
   * that gives every suspension a statement root of its own, then the
   * checks that read the rewritten body — checkPositions last, as the
   * verifier of the residue hoisting could not fix. */
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
    if (
      fn.locals.some(
        (l) =>
          l.id === FRAME_LOCAL ||
          l.id === FRAME_ANY_LOCAL ||
          l.id === EXC_LOCAL ||
          l.id.startsWith(HOIST_PREFIX),
      )
    ) {
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
    this.planBoxes(captured);
    // A `return` crossing a finally settles AFTER the finally runs, which
    // the settle-then-return rewrite gets backwards. Checked over the WHOLE
    // body (not alongside the position scan) because the try may sit inside
    // a construct the scan does not descend into.
    if (anyNode(fn.body, (rec) => rec["kind"] === "tryCatch" && rec["finallyBody"] !== null && hasReturn(rec))) {
      this.decline("fn:async:return-in-finally");
    }
    // Order-preserving hoisting: after this, every suspension the pass
    // accepts sits at the root of a statement's value slot.
    this.body = this.hoistList(fn.body);
    // ...and after THIS, no `varDecl` of a body box survives: each one is
    // the `assign` that fills the wrapper's box in place. A declaration
    // the rewrite missed would mint a SECOND box in resume and fork the
    // binding the closures already captured — the one silent miscompile
    // this design admits, so it is CHECKED rather than argued. (planBoxes
    // proves there is exactly one declaration at a position the rewrite
    // reaches; reaching here means the two walks disagree, a pass bug.)
    this.body = this.rewriteBoxDecls(this.body);
    for (const id of this.bodyBoxedIds) {
      if (declCount(this.body, id) !== 0) {
        throw new Error(`async lowering: body box "${id}" kept its varDecl in "${fn.name}"`);
      }
    }
    this.saved = this.locals.filter((l) => l.boxed !== true && l.tdz !== true && !captured.has(l.id));
    if (this.saved.some((l) => l.type.kind === "void")) this.decline("fn:async:void-local");
    this.checkPositions(this.body);
  }

  /** Decide which boxes the wrapper pre-creates, and refuse the shapes
   * pre-creation cannot serve (the header's BOXES THE BODY OWNS section
   * and the three `fn:async:boxed-*` refusals). Runs on the SOURCE body:
   * hoisting only splices expressions into temps, so it can neither move
   * a declaration across a loop boundary nor invent one. */
  private planBoxes(captured: Set<string>): void {
    const fn = this.fn;
    const owned = fn.locals.filter((l) => (l.boxed === true || l.tdz === true) && !captured.has(l.id));
    if (owned.length === 0) return;
    // `tdz` is documented as always paired with `boxed`; without the box
    // there is no slot to pre-create and no through-box write to fill.
    if (owned.some((l) => l.boxed !== true)) this.decline("fn:async:boxed-local");
    const params = new Set(fn.params.map((p) => p.localId));
    const sites = boxSites(fn.body, new Set(owned.map((l) => l.id)));
    for (const l of owned) {
      if (params.has(l.id)) {
        // A boxed argument: the emitter's prologue boxes it, and a
        // parameter is bound exactly once per call by construction. That
        // prologue boxes by VALTYPE, not tdz-aware, so a tdz param's box
        // would disagree with the env field the closure packs — a
        // parameter arrives initialized, so the flag is a contradiction.
        if (l.tdz === true) this.decline("fn:async:boxed-local");
        this.bodyBoxed.push(l);
        continue;
      }
      const site = sites.get(l.id)!;
      if (site.inLoop) this.decline("fn:async:boxed-in-loop");
      if (site.decls !== 1 || declCount(fn.body, l.id) !== 1) this.decline("fn:async:boxed-local");
      // A tdz box is BUILT for the forward read — its empty slot answers
      // with Node's ReferenceError, so an early capture is the point.
      if (site.earlyCapture && l.tdz !== true) this.decline("fn:async:boxed-forward-capture");
      this.bodyBoxed.push(l);
      this.boxInits.push(l);
    }
    for (const l of this.bodyBoxed) this.bodyBoxedIds.add(l.id);
  }

  /** The declaration of a body box becomes the write that FILLS it: the
   * box already exists (the wrapper made it), and storeVar's boxed path
   * stores through the ref every closure captured — a tdz local's inner
   * indirection included, which is how it leaves the dead zone. An
   * initializer-free declaration disappears outright: `%async.boxInit`
   * already left the box in exactly the state that `varDecl` would. */
  private rewriteBoxDecls(body: IrStmt[]): IrStmt[] {
    if (this.bodyBoxedIds.size === 0) return body;
    const list = (stmts: IrStmt[]): IrStmt[] => stmts.flatMap((s) => one(s));
    const one = (s: IrStmt): IrStmt[] => {
      switch (s.kind) {
        case "varDecl":
          if (!this.bodyBoxedIds.has(s.localId)) return [s];
          return s.init === null ? [] : [{ kind: "assign", localId: s.localId, value: s.init, loc: s.loc }];
        case "if":
          return [{ ...s, then: list(s.then), else_: s.else_ === null ? null : list(s.else_) }];
        case "block":
        case "while":
        case "doWhile":
        case "forOf":
          return [{ ...s, body: list(s.body) }];
        case "for":
          return [{ ...s, body: list(s.body) }];
        case "switch":
          return [{ ...s, cases: s.cases.map((c) => ({ ...c, body: list(c.body) })) }];
        case "tryCatch":
          return [
            {
              ...s,
              tryBody: list(s.tryBody),
              catchBody: s.catchBody === null ? null : list(s.catchBody),
              finallyBody: s.finallyBody === null ? null : list(s.finallyBody),
            },
          ];
        default:
          return [s];
      }
    };
    return list(body);
  }

  /** Rewrite a statement list, splicing each statement's hoist prelude in
   * ahead of it. */
  private hoistList(body: IrStmt[]): IrStmt[] {
    if (!hasSuspension(body)) return body;
    return body.flatMap((s) => this.hoistStmt(s));
  }

  /** One statement in, its order-preserving sequence out (see the header).
   * Statement kinds that CAN host a split keep their root suspension where
   * it is — the splitter wants it there — and hoist only what surrounds
   * it; the rest hoist every suspended operand into a temp ahead of
   * themselves. A kind this does not rewrite comes back untouched and
   * meets checkPositions instead. */
  private hoistStmt(s: IrStmt): IrStmt[] {
    if (!hasSuspension(s)) return [s];
    const out: IrStmt[] = [];
    const slots = STMT_HOIST_SLOTS[s.kind];
    if (slots !== undefined) {
      const rewritten = this.hoistParts(s, slots, out);
      out.push(rewritten);
      return out;
    }
    switch (s.kind) {
      case "varDecl": {
        const init = s.init === null ? null : this.hoistRoot(s.init, out);
        out.push({ ...s, init });
        break;
      }
      case "assign": {
        const value = this.hoistRoot(s.value, out);
        out.push({ ...s, value });
        break;
      }
      case "exprStmt": {
        const expr = this.hoistRoot(s.expr, out);
        out.push({ ...s, expr });
        break;
      }
      case "return": {
        const value = s.value === null ? null : this.hoistRoot(s.value, out);
        out.push({ ...s, value });
        break;
      }
      case "throw": {
        // `throw` cannot host a split (nothing resumes into it), so the
        // payload has to be a value the resumed state already holds.
        const value = this.hoistValue(s.value, out);
        out.push({ ...s, value });
        break;
      }
      case "if": {
        // The condition evaluates exactly once, before either arm, so it
        // hoists like any other unconditional operand — the ARMS are what
        // may not run, and they are statement lists the pass explodes
        // rather than expressions it hoists.
        const cond = hasSuspension(s.cond) ? this.hoistValue(s.cond, out) : s.cond;
        out.push({ ...s, cond, then: this.hoistList(s.then), else_: s.else_ === null ? null : this.hoistList(s.else_) });
        break;
      }
      case "block":
        out.push({ ...s, body: this.hoistList(s.body) });
        break;
      case "while":
      case "doWhile":
        // The condition is re-evaluated per iteration: a temp ahead of the
        // loop would evaluate it once. Left for checkPositions to refuse.
        out.push({ ...s, body: this.hoistList(s.body) });
        break;
      case "for":
        // Same for the header's three slots, plus the per-iteration `let`
        // binding an init hoist would move out of the loop's scope.
        out.push({ ...s, body: this.hoistList(s.body) });
        break;
      case "tryCatch":
        // A try WITH a finalizer comes back untouched, so checkPositions
        // gets to name it `await-in-finally` rather than whatever position
        // the hoist walk would have refused inside it first.
        if (s.finallyBody !== null || s.catchBody === null) {
          out.push(s);
          break;
        }
        out.push({ ...s, tryBody: this.hoistList(s.tryBody), catchBody: this.hoistList(s.catchBody) });
        break;
      default:
        // forOf / switch — suspensions inside them are their own refusals,
        // and every other kind holds no expression that can suspend.
        out.push(s);
        break;
    }
    return out;
  }

  /** A value slot that CAN host a suspension at its root: a root
   * suspension stays put, anything else hoists its operands. */
  private hoistRoot(e: IrExpr, out: IrStmt[]): IrExpr {
    if (!hasSuspension(e)) return e;
    if (classifySuspension(e) !== null) return e;
    if (e.kind === "seqExpr") {
      // seqExpr is straight-line by construction (the validator's subset),
      // so its statements can be SPLICED into the host list at the point
      // the expression itself would have evaluated — nothing reorders.
      for (const st of e.stmts) out.push(...this.hoistStmt(st));
      return this.hoistRoot(e.result, out);
    }
    if (CONDITIONAL_KINDS.has(e.kind)) this.decline(this.positionRefusal(e, true));
    const slots = HOIST_SLOTS[e.kind];
    if (slots === undefined) this.decline(this.positionRefusal(e));
    return this.hoistParts(e, slots, out);
  }

  /** A value slot that canNOT host a suspension: hoist, then bind. */
  private hoistValue(e: IrExpr, out: IrStmt[]): IrExpr {
    return this.toTemp(this.hoistRoot(e, out), out);
  }

  /** Walk one node's operands in evaluation order, hoisting everything
   * that must run before its last suspension. Operands PAST that
   * suspension stay in place: they evaluate after the resumption, which is
   * where JS puts them. The node comes back copied, never mutated. */
  private hoistParts<T extends IrExpr | IrStmt>(node: T, slots: HoistSlot[], out: IrStmt[]): T {
    const copy = { ...node } as unknown as Record<string, unknown>;
    const ops: { get: () => IrExpr; set: (v: IrExpr) => void }[] = [];
    for (const slot of slots) {
      if (typeof slot === "string") {
        // Optional slots (bytesNew's source, setNew's seed) read null.
        if (copy[slot] === null || copy[slot] === undefined) continue;
        ops.push({ get: () => copy[slot] as IrExpr, set: (val) => void (copy[slot] = val) });
        continue;
      }
      if ("list" in slot) {
        const items = [...(copy[slot.list] as IrExpr[])];
        copy[slot.list] = items;
        items.forEach((_, i) => ops.push({ get: () => items[i]!, set: (val) => void (items[i] = val) }));
        continue;
      }
      const entries = (copy[slot.each] as Record<string, unknown>[]).map((entry) => ({ ...entry }));
      copy[slot.each] = entries;
      for (const entry of entries) {
        ops.push({ get: () => entry[slot.field] as IrExpr, set: (val) => void (entry[slot.field] = val) });
      }
    }
    let last = -1;
    ops.forEach((op, i) => {
      if (hasSuspension(op.get())) last = i;
    });
    for (let i = 0; i <= last; i++) {
      const op = ops[i]!;
      const cur = op.get();
      const rewritten = hasSuspension(cur) ? this.hoistRoot(cur, out) : cur;
      if (i < last) {
        // Something after this one suspends, so its value has to be taken
        // before the suspension — unless taking it twice is the same thing.
        op.set(isStable(rewritten) ? rewritten : this.toTemp(rewritten, out));
      } else {
        // The last suspended operand. Still suspended after the rewrite
        // means it IS a root suspension, which only a statement can host.
        op.set(hasSuspension(rewritten) ? this.toTemp(rewritten, out) : rewritten);
      }
    }
    return copy as unknown as T;
  }

  /** Bind `e` to a fresh `%hoist.<n>` local, in place, and answer the
   * reference that stands in for it. Ordinary locals: they ride the
   * frame's total save/restore like every other one. */
  private toTemp(e: IrExpr, out: IrStmt[]): IrExpr {
    // A void temp has no frame slot AND no reference to hand back; the
    // operand position it came from still needs an expression. The
    // loader's wait is void by nature, so it keeps its own name.
    if (e.type.kind === "void") {
      this.decline(hasModuleAwait(e) ? "fn:async:module-await-position" : "fn:async:hoist-void");
    }
    const id = `${HOIST_PREFIX}${++this.hoisted}`;
    this.locals.push({ id, name: id, type: e.type, mutable: false });
    out.push({ kind: "varDecl", localId: id, init: e, loc: e.loc });
    return { kind: "varRef", localId: id, type: e.type, loc: e.loc };
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
          if (s.finallyBody !== null || s.catchBody === null) {
            // A finalizer is completion machinery, not a handler (the
            // header's refusal list). A catchless try always has one, so
            // the name stays accurate for every shape that reaches here.
            if (hasSuspension(s)) this.decline("fn:async:await-in-finally");
            break;
          }
          // Both bodies linearize, so both are checked like any list.
          this.checkPositions(s.tryBody);
          this.checkPositions(s.catchBody);
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

  /** The census name for a suspension hoisting could not move: the
   * loader's dependency wait and a user `await` sit in the same positions
   * but are different constructs, and a CONDITIONAL position is a
   * different rock again (the header's refusal list says why). */
  private positionRefusal(node: unknown, conditional = false): string {
    if (hasModuleAwait(node)) return "fn:async:module-await-position";
    return conditional ? "fn:async:await-conditional" : "fn:async:await-position";
  }

  /* ── the frame shape ─────────────────────────────────────────────────── */

  private buildFrameFields(): void {
    this.frameFields.push({ name: STATE_FIELD, type: F64 });
    // A generator's frame carries the back-reference to its OWN $gen
    // (GEN_FIELD); an async function's carries the promise it settles
    // (PROMISE_FIELD) — mutually exclusive, mirroring fn.generator/
    // fn.async themselves.
    this.frameFields.push(
      this.genType !== null
        ? { name: GEN_FIELD, type: this.genType }
        : { name: PROMISE_FIELD, type: this.promiseType },
    );
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

  /** `frame.%gen` — the generator's own $gen<triple> struct. Only valid
   * where genType is non-null (a generator function), which every yield
   * site is: yieldExpr is frontend-fenced to generator bodies, so
   * reaching lowerSuspension's "yield" form already proves it. */
  private genRef(): WExpr {
    return this.get(GEN_FIELD, this.genType!);
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

  /** Resume's environment: the boxes it must be handed to run a body.
   * RECEIVED captures first, in the async function's own captures[]
   * order, then the boxes the body owns in `locals` order — a function of
   * the input alone, so the env layout is deterministic. Every re-entry
   * unpacks the same boxes, which is what closure aliasing depends on. */
  private resumeCaptures(): IrParam[] {
    return [
      ...(this.fn.captures ?? []),
      ...this.bodyBoxed.map((l) => ({ localId: l.id, name: l.name, type: l.type })),
    ];
  }

  /** The resume closure, materialized per use (see the header: it cannot
   * live in the frame). Its capture list is resumeCaptures()'s ids: in
   * the WRAPPER those name the boxes it just made, and inside resume they
   * name the slots its own prologue unpacked — the same boxes either way. */
  private resumeClosure(): WExpr {
    return {
      kind: "closure",
      fnName: this.resumeName,
      captures: this.resumeCaptures().map((c) => c.localId),
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

  /** Fulfil the wrapper's promise with `value` and leave resume.
   *
   * TODO(increment 19): unconditionally async-shaped — for a generator
   * this should retag `value` into `$gen.out` and set `$gen.state = DONE`
   * instead (the header's "A GENERATOR'S SIBLING PROTOCOL"), not settle a
   * promise this function's frame no longer even carries a slot for.
   * Not yet reachable: lowerResumableFunctions still gates every real
   * generator out, and every stage-A2b test avoids a body with an
   * explicit `return` for exactly this reason — see that describe
   * block's own SCOPE NOTE. */
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
   * test instead, which is where a numbering bug actually shows up.
   *
   * TODO(increment 19): the void branch below is unconditionally
   * async-shaped (references PROMISE_FIELD, a slot a generator's frame
   * no longer carries — see buildFrameFields' %gen/%promise branch); it
   * needs a generator arm settling `$gen` instead. The non-void branch
   * just above needs no change (a bare `this.ret()`, no field reference
   * either way) — every stage-A2b test relies on exactly that to stay
   * clear of this gap; see completion()'s own TODO and that describe
   * block's SCOPE NOTE. */
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
    this.handlerOf.push(this.regions[this.regions.length - 1]?.handler ?? -1);
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
      case "tryCatch":
        return this.lowerTry(s, cur);
      default:
        // A construct with a jump out of it that the pass cannot explode
        // (for-of, switch); suspensions inside these already refused
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

    // An exhaustive switch, not the if/else-if chain this used to be: a
    // bare trailing `else` type-checked here only by accident (the type
    // errors a missing arm produces are ordinary property-access errors
    // in that branch, not an exhaustiveness failure — there was no
    // `never`-check anywhere to trip). The `default` below is the guard;
    // adding a Suspension form without a case here is now a compile
    // error by construction, matching every other exhaustive dispatch in
    // this file (emitter.ts's `const rest: never = e` idiom).
    switch (susp.form) {
      case "moduleAwait": {
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
        break;
      }
      case "hop": {
        this.emit(cur, ...susp.before);
        this.emit(cur, ...this.saves(), this.set(STATE_FIELD, this.num(resumeState)), {
          kind: "%async.hop",
          frame: this.frameRef(),
          resume: this.resumeClosure(),
          loc: susp.before[0]?.loc ?? this.loc,
        });
        resumed = susp.result;
        break;
      }
      case "await": {
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
        break;
      }
      case "awaitUnion": {
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
        break;
      }
      case "yield": {
        // No event loop, no settled-dependency fast path: EVERY yield
        // suspends and returns — `tail` keeps its default (this.ret()).
        const node = susp.node;
        this.emit(cur, ...this.saves(), this.set(STATE_FIELD, this.num(resumeState)), {
          kind: "%gen.suspend",
          gen: this.genRef(),
          // The RAW yieldT-typed operand, un-retagged (null for a bare
          // `yield;`) — see %gen.suspend's own doc comment for why the
          // pass never wraps this into V itself.
          value: node.value === null ? null : widenExpr(node.value),
          loc: node.loc,
        });
        // NEXT falls through as a no-op; THROW/GENRET unwind into the
        // SAME per-iteration catch every other unwind already reaches
        // (%gen.injectCheck's own doc comment has the full three-way
        // story) — reentry order matters no differently than
        // rejectCheck's: it runs AFTER restore, BEFORE the resumed read,
        // exactly mirroring await's own reentry/resumed split below.
        reentry.push({ kind: "%gen.injectCheck", gen: this.genRef(), loc: node.loc });
        // nextT's "no value" spelling is the undefined-unit arm, not
        // `void` (generators.ts's GeneratorBuilder draws this exact
        // line for $gen's own `sent` field — mirrored here so the two
        // never drift apart on what "no sent slot" means).
        if (node.type.kind !== "undefinedT") {
          resumed = { kind: "%gen.sent", gen: this.genRef(), type: node.type, loc: node.loc };
        }
        break;
      }
      default: {
        // The never-check plus a LOUD, NAMED refusal — emitter.ts's own
        // idiom (its six `const rest: never = e; this.refuse(...)` sites),
        // not a bare compile-time-only assertNever: a future Suspension
        // form added here without a case declines this ONE function by
        // name (this.decline bails via AsyncBail, which
        // lowerResumableFunctions already catches and moves on from) —
        // never a hard crash of the whole compilation, matching "never
        // miscompile, refuse loudly" everywhere else in this file.
        const rest: never = susp;
        this.decline(`fn:async:unhandled-suspension-${(rest as Suspension).form}`);
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

  /** A try/catch a suspension crosses (or a jump leaves). Both bodies
   * linearize; what makes an exception ROUTE is the region stack, open
   * only while the try body is lowered — see the header's TRY/CATCH
   * section for why that is the whole mechanism. */
  private lowerTry(s: Extract<IrStmt, { kind: "tryCatch" }>, cur: number): number | null {
    if (s.finallyBody !== null || s.catchBody === null) {
      // checkPositions refused every SUSPENDING try with a finalizer, so
      // reaching here is a break/continue leaving one — and that jump has
      // to run the finalizer on its way out, which is the same work.
      this.decline("fn:async:jump-out-of-trycatch");
    }
    // Created with the region still CLOSED: the catch body is not
    // protected by its own try, and the join is past the region entirely.
    const handlerState = this.newState();
    const joinState = this.newState();
    this.catchBindings.set(handlerState, s.catchLocalId);
    this.regions.push({ handler: handlerState });
    // The try body opens a state of its own — `cur` may already hold the
    // statements that ran before the try, which this handler must not
    // cover (the header's first ordering fact).
    const bodyState = this.newState();
    this.emit(cur, ...this.goto(bodyState));
    const tried = this.lowerList(s.tryBody, bodyState);
    this.regions.pop();
    if (tried !== null) this.emit(tried, ...this.goto(joinState));
    const caught = this.lowerList(s.catchBody, handlerState);
    if (caught !== null) this.emit(caught, ...this.goto(joinState));
    return joinState;
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

  /** resume's catch arm: the STATIC routing table (the header's TRY/CATCH
   * section). A state inside a protected region fills that region's catch
   * binding, mirrors the live locals into the frame, points `%state` at
   * the handler and falls out — the dispatch loop's next turn is the catch
   * body. Every other state rejects this frame's own promise and leaves,
   * which in a function with no protected region at all is the whole arm.
   *
   * States sharing a handler share ONE case body: the cases ahead of it
   * have EMPTY bodies and fall through, exactly as a body-less case does
   * in the switch this pass's own dispatch already relies on. */
  private catchArm(): WStmt[] {
    const excRef: WExpr = { kind: "varRef", localId: EXC_LOCAL, type: CAUGHT, loc: this.loc };
    const reject: WStmt[] = [
      {
        kind: "%async.reject",
        promise: this.get(PROMISE_FIELD, this.promiseType),
        caught: excRef,
        loc: this.loc,
      },
      this.ret(),
    ];
    const byHandler = new Map<number, number[]>();
    this.handlerOf.forEach((handler, state) => {
      if (handler < 0) return;
      const group = byHandler.get(handler);
      if (group === undefined) byHandler.set(handler, [state]);
      else group.push(state);
    });
    if (byHandler.size === 0) return reject;

    const cases: { test: IrExpr | null; body: IrStmt[] }[] = [];
    for (const handler of [...byHandler.keys()].sort((a, b) => a - b)) {
      const states = byHandler.get(handler)!;
      const binding = this.catchBindings.get(handler) ?? null;
      // The binding is written BEFORE the saves so the frame slot and the
      // wasm local agree about the caught value (the header's second
      // ordering fact). A bindingless `catch {}` has nothing to write.
      const body: WStmt[] = [
        ...(binding === null
          ? []
          : [{ kind: "assign" as const, localId: binding, value: widenExpr(excRef), loc: this.loc }]),
        ...this.saves(),
        this.set(STATE_FIELD, this.num(handler)),
        // Out of the switch, out of the catch, and the loop re-dispatches.
        { kind: "break" as const, loc: this.loc },
      ];
      states.forEach((state, i) => {
        cases.push({ test: this.num(state), body: widenBody(i === states.length - 1 ? body : []) });
      });
    }
    cases.push({ test: null, body: widenBody(reject) });
    return [{ kind: "switch", disc: widenExpr(this.get(STATE_FIELD, F64)), cases, loc: this.loc }];
  }

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
    const states: WStmt = {
      kind: "switch",
      disc: widenExpr(this.get(STATE_FIELD, F64)),
      cases: [
        ...this.states.map((body, i) => ({ test: this.num(i), body: widenBody(body) })),
        // Unreachable: this pass is the only writer of %state, and the
        // default's job is to keep the switch total.
        { test: null, body: widenBody([this.ret()]) },
      ],
      loc: this.loc,
    };
    // The one tryCatch is load-bearing three times: a synchronous throw in
    // the body becomes this frame's REJECTION rather than unwinding into
    // whoever pumped the microtask, the awaited-rejection re-throw
    // (%async.rejectCheck) lands here too, and its arm is the routing
    // table for every protected state.
    //
    // It sits INSIDE the loop, not around it, so an exception a region
    // catches can hand control back to the dispatch instead of ending it.
    const guarded: WStmt = {
      kind: "tryCatch",
      tryBody: widenBody([states]),
      catchBody: widenBody(this.catchArm()),
      catchLocalId: EXC_LOCAL,
      finallyBody: null,
      loc: this.loc,
    };
    const dispatch: WStmt = {
      kind: "while",
      cond: { kind: "boolLit", value: true, type: BOOL, loc: this.loc },
      body: widenBody([guarded]),
      labels: [DISPATCH_LABEL],
      loc: this.loc,
    };
    // The cast prologue sits outside both: narrowing the parameter cannot
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
      dispatch,
    ];
    const caps = this.resumeCaptures();
    return {
      name: this.resumeName,
      params: [param],
      returnType: VOID,
      // The async function's own locals ride along (plus the hoisting
      // rewrite's temps): params become plain locals restored from the
      // frame, and every boxed entry — received or body-owned — keeps its
      // flags so the emitter's box-access gates still apply.
      locals: [frameAnyLocal, frameLocal, ...this.locals, excLocal],
      ...(caps.length > 0 || this.fn.captures !== undefined ? { captures: caps } : {}),
      body,
      loc: this.fn.loc,
    };
  }

  /** TODO(increment 19): unconditionally builds ASYNC's eager wrapper
   * (mint a promise, kick resume once, return the promise) — the
   * header's "A GENERATOR'S SIBLING PROTOCOL" describes the LAZY
   * alternative a generator needs instead (allocate frame + $gen, store
   * params, boxInit, $gen.state = UNSTARTED, NO resume call, return the
   * $gen), not yet built here. `run()` calling this unconditionally for
   * a generator function today produces a WRONG wrapper beside a correct
   * resume (frameInit literally names a "%promise" field the frame no
   * longer carries) — this does not throw (recordLit construction never
   * checks field names against the shape), it is just wrong IR, which is
   * exactly why lowerResumableFunctions' gate (below) stays closed until
   * this gets its generator branch. */
  private buildWrapper(): WFunction {
    const frameLocal: IrLocal = { id: FRAME_LOCAL, name: FRAME_LOCAL, type: this.frameType, mutable: false };
    const captured = new Set((this.fn.captures ?? []).map((c) => c.localId));
    // Params, received captures, and the boxes the body owns: the wrapper
    // stores the arguments, makes those boxes and hands the frame over, so
    // every other local — hoist temps included — belongs to resume alone.
    const keep = this.locals.filter(
      (l) =>
        captured.has(l.id) ||
        this.bodyBoxedIds.has(l.id) ||
        this.fn.params.some((p) => p.localId === l.id),
    );
    const frameInit: IrExpr = {
      kind: "recordLit",
      // Fields the literal omits take struct.new_default: %state is 0 (the
      // entry state) and the %await/%l_ slots are filled at their first
      // suspend. A BOXED param has no %l_ field to fill — it rides the env
      // as a box ref like any other capture, not the frame as a value.
      fields: [
        { name: PROMISE_FIELD, value: widenExpr({ kind: "%async.mint", type: this.promiseType, loc: this.loc }) },
        ...this.fn.params
          .filter((p) => !this.bodyBoxedIds.has(p.localId))
          .map((p) => ({
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
      this.resumeCaptures().length === 0
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
        // Before the frame and before the closure that captures them:
        // resumeClosure() reads these slots, so the boxes must exist by
        // the time the kick packs the env.
        ...this.boxInits.map((l) => ({ kind: "%async.boxInit" as const, localId: l.id, loc: this.loc })),
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
