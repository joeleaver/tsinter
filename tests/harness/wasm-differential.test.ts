/* The wasm backend's differential: tier membership is AUTO-DISCOVERED by
 * attempting the wasm build on every corpus program, exactly like
 * llvm-differential.test.ts. A program the tier claims runs IN-PROCESS
 * through the abi.ts host contract (instantiate the .wasm, service its
 * `tsinter.write` import, drive `_start`) and must match the Node oracle
 * byte for byte; a program outside the tier must REFUSE loudly under the
 * `backend: "wasm"` pin — diagnostic SC3001 naming the first unsupported
 * IR construct, never wrong code.
 *
 * TWO DIFFERENCES from the LLVM suite, both structural:
 *
 * 1. There is no fallback lane to check. The wasm backend is an explicit
 *    pin only (its artifact is a .wasm module, not a native executable),
 *    so a refusal is always SC3001 and there is no "did the default lane
 *    land on C" half to assert.
 *
 * 2. The refusal histogram is not the whole work queue yet. While the
 *    tier is small most programs refuse at whatever the frontend emits
 *    FIRST, so the queue comes from the SURVEY (compile()'s `wasmSurvey`:
 *    every distinct construct a program needs, not just the first), and
 *    both histograms print at the end. As coverage lands the two
 *    converge, and the first-refusal histogram becomes the useful one —
 *    which is the signal that this comment can go.
 *
 * A wasm TRAP in a claimed program reports as exit code 1 — the
 * S003/S007 bridge: traps stand in for uncaught runtime errors (index
 * checks, empty pop, `throw`) until the exception protocol lands, and
 * Node exits 1 on an uncaught exception, so the comparison stays honest
 * through the @exit directive and the skipped nonzero-exit stderr. Any
 * NON-trap error (a host bug, a missing export) still fails the test as
 * the raised error itself. The one nonzero exit that is NOT a trap is a
 * top-level-await program whose module evaluation promise never settled:
 * `_status()` answers Node's 13 (abi.ts). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@tsinter/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

// Same corpus and same SCRIPTC_TEST_SHARD slice as the other corpus lanes.
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = shardSelect(
  ENTRY_EXTS.flatMap((ext) => [
    ...globSync(join(corpusDir, `*.${ext}`)),
    ...globSync(join(corpusDir, `*/main.${ext}`)),
  ]).sort(),
  (f) => f.slice(corpusDir.length + 1),
);

// Same known-env contract as the other differential suites.
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

/** The tier floor: programs whose membership is pinned, so a regression
 * out of the tier fails the suite instead of quietly shrinking the
 * histogram. Auto-discovery may claim more; these regressing out is
 * always a bug. */
const TIER_FLOOR: string[] = [
  // Increment 1 (module prologue): hello world, and cross-module wiring
  // free of charge (module bindings flatten into %g. globals plus
  // per-file %init functions).
  "001-hello.ts",
  "2124-imports-field-wildcard/main.ts",
  // Increment 2 (scalars + control flow): comparisons, if/else chains,
  // switch dispatch, recursion, and the module-graph family whose
  // programs compute in scalars and print strings/bools.
  "102-comparisons.ts",
  "300-if-else.ts",
  "401-mutual-recursion.ts",
  "800-switch-basics.ts",
  "951-modules-diamond/main.ts",
  "1622-cjs-require-conditional/main.js",
  "1625-cjs-require-lazy-fn/main.js",
  "2121-esm-cycle-inert-backedge/main.ts",
  "2193-discarded-stdlib-reads.ts",
  "2605-cycle-three-module/main.ts",
  // Increment 3 (number→string): the Ryū claim wave — number formatting,
  // templates over numbers, loops that print, enums, IEEE corners (the
  // emitted fmod under corpus scrutiny), and the rest of the cjs/esm
  // module-graph family.
  "002-log-args.ts",
  "100-number-format.ts",
  "103-ternary.ts",
  "200-strings.ts",
  "201-templates.ts",
  "301-while.ts",
  "302-for.ts",
  "303-break-continue.ts",
  "305-truthiness.ts",
  "400-fib.ts",
  "402-string-functions.ts",
  "403-void-and-params.ts",
  "404-rc-stress.ts",
  "804-switch-braced-blocks.ts",
  "954-modules-reexport/main.ts",
  "1620-cjs-require-effects-order/main.js",
  "1621-cjs-require-cache-hit/main.js",
  "1623-cjs-require-diamond/main.js",
  "1624-cjs-require-dir-mid-file/main.js",
  "1626-cjs-require-mjs/main.js",
  "1627-mjs-import-cjs-requires/main.mjs",
  "1822-static-block-js.js",
  "1830-enum-numeric-basics.ts",
  "1891-ns-reexport/main.ts",
  "1968-namespace-import-eq-snapshot.ts",
  "2092-package-imports/main.ts",
  "2120-package-self-import/main.ts",
  "2260-http2-constants.cjs",
  "2382-cycle-two-decl/main.ts",
  "2384-cycle-mixed-bindings/main.ts",
  "2422-ieee-div-rem-corners.ts",
  "2426-default-snapshot-mutable/main.ts",
  "2617-enum-static-field-import/main.ts",
  // Increment 4 (arrays): the vector-struct representation and its core
  // intrinsic surface, plus the programs the array types unlock.
  "503-array-functions.ts",
  "511-array-indexof-includes.ts",
  "802-switch-loops.ts",
  "803-switch-rc-stress.ts",
  "963-generics-modules/main.ts",
  "1054-comptime-modules/main.ts",
  "1543-rest-destructuring.ts",
  // Increment 5 (closures + function values): captures through shared
  // boxes, per-iteration loop bindings, function identity, and the
  // programs those unlock (HOF desugars, class statics, namespaces).
  "600-closures-basic.ts",
  "601-closures-loops.ts",
  "602-closures-identity-recursion.ts",
  "750-cycle-closure-box.ts",
  "801-switch-lazy-tests.ts",
  "820-multi-decl.ts",
  "830-let-uninitialized.ts",
  "1050-comptime-tables.ts",
  "1596-cjs-modules/main.js",
  "1821-static-block-order.ts",
  "1943-class-statics-expanded.ts",
  "1960-namespace-basics.ts",
  "2021-generic-value-binding-modules/main.ts",
  "2390-dot-requires/main.cjs",
  // Increment 6 (records): struct-per-shape, tuples, accessor-slot
  // shapes, and the programs those unlock.
  "517-array-hof-index-args.ts",
  "751-cycle-records-mutual.ts",
  "901-records-eval-order.ts",
  "902-records-functions-closures.ts",
  "953-modules-default/main.ts",
  "960-generics-basics.ts",
  "1359-json-module/main.ts",
  "1450-incdec-expression.ts",
  "1537-chalk-hybrid/main.ts",
  "1824-for-of-destructuring-defaults.ts",
  "1964-namespace-type-only.ts",
  "2045-objlit-accessors-basic.ts",
  "2102-empty-pattern-decls.ts",
  "2551-generics-value-aliases.ts",
  "2555-generics-keyof-writes.ts",
  "2587-array-entries-forof.ts",
  // Increment 7 (unions): the shared-base tagged representation, unit-arm
  // singletons, per-union dispatch helpers (truthy/eq/toStr), nullish/
  // orDefault/optChain, unionDisc/unionKeyGet, pop/shift, insp.f64 — and
  // the claim wave those unlock: the union corpus family, the whole
  // narrowing-kill family (2392-2425), destructuring, union-element
  // arrays, recursive unions.
  "1366-union-equality.ts",
  "1367-destructuring.ts",
  "1368-constructor-functions.ts",
  "1370-spread.ts",
  "1372-loose-null-tests.ts",
  "1530-spread-override-completion.ts",
  "1532-union-shared-field-read.ts",
  "1536-destructuring-defaults.ts",
  "1549-array-isarray-unions.ts",
  "1553-truthy-hof-predicates.ts",
  "1676-func-array-surface.ts",
  "1853-overload-modules/main.ts",
  "2026-width-spread.ts",
  "2053-typeof-static-fold.ts",
  "2060-empty-tuple.ts",
  "2082-destructuring-assignment.ts",
  "2363-nullish-retag.ts",
  "2392-block-guard-alias-scope.ts",
  "2393-loop-exit-guard-narrow.ts",
  "2394-loop-narrow-containment.ts",
  "2395-while-cond-guard.ts",
  "2396-born-narrowed-decl.ts",
  "2397-branch-kill-merge.ts",
  "2398-switch-arm-kill.ts",
  "2399-reassign-kill-polarity.ts",
  "2400-kill-return-edge.ts",
  "2401-kill-break-staging.ts",
  "2402-labeled-break-kill.ts",
  "2403-kill-continue-backedge.ts",
  "2405-sibling-arm-narrow.ts",
  "2406-switch-clause-sibling-narrow.ts",
  "2407-infinite-loop-seal.ts",
  "2408-loop-terminality-reopen.ts",
  "2409-loop-body-return-not-terminal.ts",
  "2410-stacked-cases-terminality.ts",
  "2411-exhaustive-switch-terminality.ts",
  "2412-dowhile-guard-trailing-test.ts",
  "2413-dowhile-kill-renarrow.ts",
  "2414-dowhile-continue-kill.ts",
  "2415-dowhile-break-trailing-test.ts",
  "2418-wrapped-ternary-arms.ts",
  "2420-nullish-null-identity.ts",
  "2421-float-lane-inference.ts",
  "2423-param-null-reassign.ts",
  "2424-ternary-miss-first-narrowing.ts",
  "2425-elseif-head-exit-narrow.ts",
  "2442-union-literal-arm-widening.ts",
  "2443-union-literal-shadow-narrowing.ts",
  "2482-recursive-union-tree.ts",
  "2490-find-miss-null-compare.ts",
  "2492-loose-null-compare-unions.ts",
  "2493-switch-unit-cases.ts",
  "2494-no-arm-compare-effects.ts",
  "2530-object-destructuring-decl.ts",
  "2531-array-tuple-destructuring-decl.ts",
  "2536-destructuring-assign-nested.ts",
  "2541-destructuring-eval-order.ts",
  "501-array-push-pop.ts",
  "504-array-rc-stress.ts",
  "532-record-arrays-rc-stress.ts",
  "534-record-width-subtyping.ts",
  "535-object-statics.ts",
  "542-union-element-arrays.ts",
  "604-closures-for-of.ts",
  "961-generics-recursion.ts",
  "971-unions-switch.ts",
  "974-unions-modules/main.ts",
  "976-unions-null.ts",
  // Increment 8 (uncaught-throw-as-trap, S007): throw compiles to a trap
  // — an emitted program has no tryCatch, so every executed throw is
  // uncaught, and effect-free thrown values (error.new of literals) skip
  // evaluation so their out-of-tier construction can't refuse. Claims the
  // union retag/narrow backstop riders, the width-lift family, var
  // hoisting, the startup-crash pair (%main opens with the lowered
  // throw), and the invisible/poisoned cjs-esm tails.
  "1124-union-narrowed-retag.ts",
  "1535-union-param-defaults.ts",
  "1616-cjs-esm-lexer-invisible/main.mjs",
  "1618-cjs-esm-poisoned-tail/main.mjs",
  "1619-cjs-esm-reexport-invisible/main.mjs",
  "1837-var-undefined-hoisting.ts",
  "1838-var-modules/main.ts",
  "2024-width-array-elems.ts",
  "2025-width-union-compose.ts",
  "2030-width-nested.ts",
  "2122-import-refusal-crash/main.ts",
  "2123-ambient-import-crash/main.ts",
  "2615-nullish-field-record-binding.ts",
  "966-unions-retag-rc-stress.ts",
  // Increment 9 (string intrinsics): the UTF-16-exact method surface
  // direct over faithful (array i16) storage — everything but the
  // lre-backed case pair (strings.ts). The claim wave: the string corpus
  // family, string destructuring/for-of (cpAt), String.raw folds, and a
  // long tail of array/union/record/generics programs whose LAST refusal
  // was one string call.
  "104-ternary-empty-arrays.ts",
  "1051-comptime-strings.ts",
  "1053-comptime-json.ts",
  "1117-typeof-static-union.ts",
  "1364-union-truthiness.ts",
  "1365-union-logical.ts",
  "1371-union-template-tostring.ts",
  "140-bitwise-operators.ts",
  "1408-string-indexing.ts",
  "1432-destructured-params.ts",
  "1433-filter-narrow.ts",
  "1521-string-trim-pad-static.ts",
  "1533-bool-equality.ts",
  "1556-union-retag-width-arms.ts",
  "1561-forof-strings.ts",
  "1563-string-raw-fold.ts",
  "1564-string-raw.ts",
  "1851-overload-return-narrowing.ts",
  "1990-labels-basics.ts",
  "2087-destructuring-for-heads.ts",
  "210-string-methods.ts",
  "211-string-unicode.ts",
  "212-string-aliasing-append.ts",
  "2253-union-coercions.ts",
  "2419-selector-ternary-union.ts",
  "2491-strict-unit-compare-no-arm.ts",
  "2553-generics-signature-bindings.ts",
  "2556-crypto-introspection.ts",
  "2575-string-destructuring-decl.ts",
  "2576-string-destructuring-assign.ts",
  "2593-generic-inert-bindings.ts",
  "500-array-basics.ts",
  "502-array-for-of.ts",
  "510-array-map-filter-foreach.ts",
  "512-array-join-chains.ts",
  "513-array-methods-rc-stress.ts",
  "514-array-find-some-every.ts",
  "515-array-flatmap.ts",
  "603-closures-rc-stress.ts",
  "810-do-while.ts",
  "903-records-rc-stress.ts",
  "905-records-optional-rc-stress.ts",
  "962-generics-closures.ts",
  "964-generics-rc-stress.ts",
  "973-unions-rc-stress.ts",
  "975-unions-undefined.ts",
  "977-unions-unit-rc-stress.ts",
  // Increment 10 (exception protocol): pending-flag unwind — real
  // throw/catch/finally/rethrow, catch-binding snapshots with typeof and
  // builtin-error instanceof tests, TDZ ReferenceErrors, fences as
  // catchable Errors, error.new as an in-tier value. Claims the whole
  // exceptions corpus family plus the fence/throw riders.
  "1599-js-uncaught-throw.js",
  "1613-cjs-esm-proxy-named/main.mjs",
  "1835-var-basics.ts",
  "2404-kill-throw-catch.ts",
  "2588-array-entries-chains.ts",
  "980-exceptions-basics.ts",
  "982-exceptions-rc-stress.ts",
  "983-exceptions-control-flow.ts",
  "984-exceptions-finally.ts",
  "985-exceptions-call-chains.ts",
  "986-exceptions-uncaught.ts",
  "987-exceptions-result-unions.ts",
  // Increment 11 (the builtin-error member surface): name/message reads
  // and writes off the shared error struct, toString, instanceof and the
  // checked cast on error VALUES (not just catch bindings), and the
  // upcast/downcast pair that carries a TypeError through an `Error`
  // slot. Claims the error surface program outright; the rest are
  // programs whose last refusal was one error-member read.
  "1119-switch-union.ts",
  "1300-errors-basics.ts",
  "2371-iterator-helpers.ts",
  "516-array-reduce.ts",
  // Increment 12 (async), stage 2: the promise runtime under the state
  // machines — one promise struct, a FIFO microtask queue drained after
  // the entry returns, and the unhandled-rejection ledger. Every await
  // spends exactly one turn, which is what makes these four match Node's
  // interleaving byte-for-byte.
  //
  // A promise nobody resolves: the parked frame is dropped and quiescence
  // is exit 0.
  "1024-async-pending-exit.ts",
  // Awaited record results across two suspensions (the checker's
  // `T | PromiseLike<T>` return form).
  "1538-await-promiselike-return.ts",
  // Fire-and-forget `void asyncFn()` beside an awaiting one.
  "1540-void-statement.ts",
  // `await null` / `await undefined` interleaved with `.then` chains —
  // the bare microtask hop against settled-promise awaits, one turn each.
  "2320-await-unit.ts",
  // Increment 12 (async), stage 3: timers, immediates, and the event loop
  // the HOST pumps (`_tick`, abi.ts). One min-heap keyed on (deadline,
  // seq), Node's delay coercion, eager clears, ref/unref liveness, the
  // firing flags that carry a self-clear or a self-refresh across the
  // callback, and the check phase with its end snapshot.
  //
  // Delay coercion end to end: 1, 1.8, 1.1 and 0.5 share the 1ms bucket
  // and fire in registration order.
  "1806-timer-delay-trunc.ts",
  // The clearable one-shot: clearTimeout, unref/ref/hasRef, and an
  // unref'd timer that fires anyway while the loop lives for other work.
  "1463-timeout-unref.ts",
  // setInterval on period beside a setTimeout landing between ticks, and
  // the self-clear that releases the loop.
  "1440-interval-basics.ts",
  // Two intervals cleared from OUTSIDE and from inside, with an async
  // frame awaiting a timer-resolved promise across them.
  "1441-interval-clear-cross.ts",
  // A throw out of an interval callback: stdout survives, the trap is
  // exit 1, and the interval does not re-arm (S007).
  "1442-interval-throw.ts",
  // Timeout.refresh() from inside the callback — the one-shot that fires
  // exactly twice (S011 for the shape this deliberately does not cover).
  "1803-timeout-refresh.ts",
  // The check phase: FIFO, clearImmediate mid-phase, and the end
  // snapshot that makes a mid-phase setImmediate wait a turn.
  "1800-immediate-basics.ts",
  // The Immediate handle surface — hasRef/unref/ref chaining, and every
  // op on a FIRED handle as a tolerated no-op.
  "1801-immediate-handle.ts",
  // Immediate liveness: an unref'd immediate rides a reffed neighbour's
  // phase, and one queued with nothing reffed left never fires.
  "1802-immediate-unref-exit.ts",
  // node:timers' named/namespace imports driving the same heap and queue
  // as the ambient globals.
  "1804-timers-module.ts",
  // Microtasks before timers, equal-deadline timers in registration
  // order, and an async chain woken by promises a timer resolves.
  "1021-async-ordering.ts",
  // Increment 12 (async), stage 4: top-level await — the module graph as
  // async functions. Each initializer's evaluation promise caches in its
  // own global (guard first, publish after the eager spawn, last write
  // wins under a cycle), the loader's internal dependency wait continues
  // synchronously into the importer when the dependency already settled,
  // and the entry's own promise becomes the root the ABI reports on
  // (`_status`, abi.ts; SEMANTICS.md S010's root paragraph and S012).
  //
  // The whole shape end to end: a settled await, a timer-resolved one, a
  // bare `await null`, and the module tail after each.
  "2646-top-level-await.ts",
  // A rejected root: exit 1 at the checkpoint that observed it.
  "2648-top-level-await-rejection.ts",
  // A root nothing settles: the loop drains, `_status` answers 13.
  "2649-top-level-await-pending.ts",
  // A pending root beside an unrelated unhandled rejection — the ledger
  // walk answers first, and it is the same exit 1.
  "2651-top-level-await-pending-unhandled.ts",
  // The rejected root STOPS the loop: a 10ms timer armed before it never
  // fires, exactly where scr_loop_run breaks.
  "2653-top-level-await-rejection-stops-loop.ts",
  // An async import cycle: the re-entrant guard, module.await on the
  // already-settled back edge, and Node's b-then-a evaluation order.
  "2655-top-level-await-cycle/main.ts",
  // The counterpart the cycle is told apart from: an ordinary async
  // dependency DOES cost a turn, so the dependency's own microtask still
  // beats the importer's first statement.
  "2658-top-level-await-sync-completion/main.ts",
  // Increment 12 (async), stage 5a: order-preserving operand hoisting —
  // an await anywhere in a statement's value expression, rewritten into
  // temps in evaluation order so each suspension lands at a statement
  // root the state split can take (statemachine.ts's HOISTING section).
  // `console.log(await p)` is the shape the whole corpus is full of.
  //
  // Timer-resolved awaits, two per body, under console.log arguments,
  // with two frames interleaving.
  "1020-async-basics.ts",
  // A promise as a THROWN value, awaited nowhere: the hoist is in the
  // console.log tail after the catch.
  "1026-throw-promise.ts",
  // Record literals fulfilled through the `T | PromiseLike<T>` return
  // slot, read back through awaited member arguments.
  "1028-async-return-record-literals.ts",
  // The settled-await hop under `console.log(await q)` — the awaited
  // value reaching an argument list still costs its own turn.
  "1428-settled-await-order.ts",

  // Increment 12 (async), stage 5b: the boxes a body OWNS. A captured (or
  // TDZ) local declared inside an async body is pre-created by the spawn
  // wrapper, rides resume's closure environment like a received capture,
  // and its declaration becomes the write that fills it — so the frame,
  // the closures and any later timer callback all share ONE box
  // (statemachine.ts's BOXES THE BODY OWNS section).
  //
  // Refcounted state held across suspensions by async arrows: the shape
  // the section was written for.
  "1023-async-rc-stress.ts",
  // Promise-typed boxes, awaited more than once through the capture.
  "1025-async-promise-capture.ts",
  // Forward-captured scalar consts: the TDZ box pre-creates EMPTY (its
  // null inner slot is the sentinel), the declaration's `assign` fills it
  // through the indirection, and an early read is Node's catchable
  // ReferenceError.
  "1573-tdz-scalar-forward-capture.ts",
  // A reference CYCLE through a body box: the box holds a promise that is
  // fulfilled with a closure capturing that same box. Also the boxed
  // PARAM shape — no boxInit, since the wrapper's prologue re-boxes every
  // boxed argument on its way in.
  "755-cycle-async-promise.ts",

  // Increment 12 (async), stage 6: awaits inside try/catch. States are
  // numbered at compile time, so which handler covers which state is a
  // STATIC map — no try-entry stack in the frame. It compiles into
  // resume's catch arm, which moved inside the dispatch loop so a caught
  // exception can hand control back to it (statemachine.ts's TRY/CATCH
  // section). Both bodies linearize; a catch body is protected by the
  // OUTER regions only, which is what makes nesting and rethrow work.
  //
  // The rejected/fulfilled `await` inside a try, the throw after it, and a
  // `return await` under the same handler.
  "1027-async-return-promise.ts",
  // The `.catch(h)` and `.finally(f)` desugars, which ARE this shape: a
  // lifted async function whose whole body is try/catch around one await,
  // `.finally`'s catch body ending in the rethrow that passes the
  // rejection on.
  "1429-promise-catch-finally.ts",
  // The `.then(onFulfilled, onRejected)` family beside them.
  "1561-promise-then.ts",

  // Increment 12 (async), stage 7: the promise combinators and the
  // union-armed await. Promise.all and Promise.race subscribe one REACTION
  // per entry — an ordinary waiter over the existing FIFO, so the promise
  // runtime is unchanged and the reactions cost the microtask turn
  // ECMAScript spends on them (emitter.ts's combinator block; scr_async.c
  // runs them inline and is a turn early). Promise.withResolvers is
  // newPromise's settler closures assembled into a record instead of
  // handed to an executor, and `await (p: Promise<T> | units)` narrows on
  // the tag: the promise arm parks, a unit arm hops, and the settled value
  // is RE-TAGGED into the result union (the two unions number their arms
  // independently).
  //
  // Promise.all's whole surface: out-of-order settlement with in-order
  // results, first-rejection-in-settlement-order with the losers still
  // handled, the empty array, already-settled entries, and void entries.
  "1438-promise-all.ts",
  // Promise.all under the checker's TUPLE overload, beside Promise.reject
  // and the `.catch` desugar.
  "1572-promise-reject-all-tuple.ts",
  // Promise.race: first settle wins, a rejection can win, and the
  // heterogeneous entries exercise the payload-wrapping adapter (a
  // Promise<number> settling a `string | number` result).
  "1430-promise-race.ts",
  // Promise.withResolvers over string/number/void, destructured and held
  // whole, resolved from a timer long after the expression that made it.
  "1726-promise-with-resolvers.ts",
  // `Promise<void> | void` callbacks: the union-armed await where the
  // result is VOID, so only subscribe/rejectCheck are involved — hop
  // counts pinned against a background fiber, tick for tick.
  "518-promise-void-union-callbacks.ts",
  // The same await where the result carries a VALUE, which is the settled
  // read and its re-tag.
  "519-promise-union-await-values.ts",
  // Free riders: a top-level-await loader waiting on several dependencies
  // at once is a Promise.all, in the module initializer and across a
  // cycle's external importer (stage 4 named both).
  "2647-top-level-await-modules/main.ts",
  "2662-top-level-await-cycle-external-wait/main.ts",
  // Increment 13 (classes), stage 1: the types and the MONOMORPHIC data
  // plane. One GC struct per emitted class, wasm-subtyped along the source
  // hierarchy (so an upcast is subsumption and a downcast a ref.cast) with
  // the preorder interval carried as data in a `vt` field; `new` is one
  // struct.new with every operand explicit followed by the constructor;
  // fields are struct slots past that word. Instanceof, virtual dispatch,
  // classes-as-values and `extends Error` are still ahead — stage 1 claims
  // the programs that build, read, and pass instances around.
  //
  // The core shapes: `this` captured into a closure, the refcount stress
  // program, and an inheritance chain (constructors chaining through
  // super, base fields as the derived struct's prefix). 700-classes-basic
  // and 701-classes-composition are NOT here — the class surface stopped
  // blocking them, but they now name `bin:**` and `bin:ref-eq`, which are
  // their own work.
  "702-classes-this-capture.ts",
  "703-classes-rc-stress.ts",
  "710-inheritance-basics.ts",
  // Accessors need no dedicated work: by IR time `get x()` is a call of
  // `%C.get:x`, so direct-dispatch accessors ride the ordinary call path
  // (the virtual ones wait for the vtables).
  "720-accessors-basics.ts",
  "721-accessors-eval-order.ts",
  // Parameter lists against constructors: defaults, ctor inheritance, and
  // the ownership stress program.
  "406-params-defaults.ts",
  "408-params-ctors-inheritance.ts",
  "410-params-rc-stress.ts",
  // Reference CYCLES are free on this tier — the whole point of a GC
  // target. These four are the native lanes' collector tests; here they
  // are just object graphs, including the mutually-recursive class pair
  // that made the rec-group span necessary in the first place.
  "752-cycle-classes.ts",
  "753-cycle-owned-arrays.ts",
  "754-cycle-external-ref.ts",
  "533-array-element-cycles.ts",
  "2604-cycle-classes-mutual/main.ts",
  // Statics are module globals plus plain functions by IR time, so they
  // land with the instance side; static blocks and the `.name` reads too.
  "1529-class-with-statics.ts",
  "1820-static-block-basics.ts",
  "1823-static-instance-method-names.ts",
  // Generic classes are ordinary classes once instantiated (the family
  // class is their synthetic base, which is exactly a hierarchy).
  "2001-generic-methods-generic-class.ts",
  "2004-generic-methods-statics.ts",
  // Class fields typed by a UNION: an unassigned one reads back as
  // `undefined`, which is why `new` seeds those slots with the interned
  // undefined arm instead of a null.
  "1584-union-field-unassigned.ts",
  "1585-union-field-conditional-ctor.ts",
  "2434-deferred-init-fields.ts",
  // `obj.n++` in both fixities, against fields and through accessors.
  "1712-field-incdec.ts",
  "2252-class-iterators.ts",
  // Instances flowing through the rest of the tier: destructured, spread
  // into records, width-compared against them, and assigned member-wise.
  "2429-destructure-class-instance.ts",
  "2241-width-record-into-class.ts",
  "2242-width-statics-into-record.ts",
  "2532-param-destructuring-options.ts",
  "2537-destructuring-assign-member-targets.ts",
  "2540-accessor-destructuring-defaults.ts",
  "2192-object-default-tostring.ts",
  // Async METHODS ride free: the resumable lowering already walks class
  // nodes, so it only ever needed the types to map (the increment's
  // trap G — deliberately no special case in statemachine.ts).
  "2351-async-methods.ts",
  // Classes across module boundaries, namespaces, and default exports —
  // the module-graph family whose only blocker was the class surface.
  "950-modules-basic/main.ts",
  "420-dead-strip-modules/main.ts",
  "1881-default-anon/main.ts",
  "1883-default-exports/main.ts",
  "1890-ns-imports/main.ts",
  "1963-namespace-aliases.ts",
  "1966-namespace-modules/main.ts",
  // Union programs that were only ever blocked by an object ARM.
  "969-unions-arm-matrix.ts",
  "972-unions-nested.ts",
  "979-unions-optional-chaining.ts",
  // Increment 13 (classes), stage 2: the IDENTITY plane. `instanceof` is
  // the O(1) preorder-interval test the C and LLVM lanes use — the vt
  // word an instance carries holds its class's `pre`, the target's
  // interval inlines as two constants, and one range test answers for a
  // whole subtree. `===`/`!==` on any GC reference becomes `ref.eq`.
  //
  // instanceof across an inheritance chain, including the narrowing the
  // frontend does NOT fold.
  "712-inheritance-instanceof.ts",
  "2455-private-brand-checks.ts",
  "1962-namespace-classes.ts",
  "1954-generic-modules/main.ts",
  "2552-generics-iface-methods.ts",
  // Class-instance identity: 701 was one `===` away after stage 1, and
  // upcast-identity pins that widening a reference keeps it the SAME
  // reference (subsumption emits nothing, so this is the observable
  // proof).
  "701-classes-composition.ts",
  "2569-upcast-identity.ts",
  // RECORD identity rides the same arm — the C lane compares records with
  // the same plain pointer compare, and recordLit allocates per
  // evaluation, so two structurally equal literals are correctly unequal.
  // This is most of the record surface arriving at once.
  "900-records-basics.ts",
  "904-records-optional-fields.ts",
  "906-records-utility-types.ts",
  "907-records-utility-generics.ts",
  "530-record-arrays.ts",
  "531-record-array-hofs.ts",
  "540-tuples-basics.ts",
  "1052-comptime-records.ts",
  "2481-mutual-recursive-records.ts",
  "2073-destructuring-assignment.ts",
  "952-modules-cross/main.ts",
  // Unions whose only remaining blocker was identity on a ref arm.
  "965-unions-retag.ts",
  "970-unions-basics.ts",
  // PROMISE identity rides the same arm: every promise is one struct
  // whatever its inner type, so `p1 === p2` is the same single compare.
  // 1982 is the one that earns its keep — it asserts `p0.then() === p0`
  // is FALSE, so claiming it puts our `.then` under a live differential
  // check that it mints a fresh promise rather than passing one through.
  "1369-promise-union.ts",
  "1982-freeze-resolve-passthrough.ts",
  // Increment 13 (classes), stage 3: VIRTUAL DISPATCH. Each hierarchy
  // root with virtual slots gets a $vtt_<root> subtype of $ci — the same
  // interval head, then one funcref per slot — and every class in that
  // root's subtree gets a constant vtable instance its instances point at.
  // A dispatch reads the vt, casts to the root's vtable, loads the slot
  // and call_refs it. Overrides that narrowed `this` are stored as
  // cast-and-forward ADAPTERS, because wasm parameters are contravariant
  // and a `(ref $Dog)` function cannot sit in an `(ref $Animal)` slot —
  // the C backend's sc_vm_* thunks, needed here for the same reason and
  // needed by neither the LLVM lane (all pointers) nor stages 1-2.
  //
  // The dispatch core, including a receiver whose slot implementation
  // lives on an unoverridden ancestor.
  "711-inheritance-dispatch.ts",
  "713-inheritance-rc-stress.ts",
  "756-cycle-inheritance.ts",
  // Sibling branches declaring the same method name at different depths —
  // the slot-numbering torture test.
  "2044-vtable-sibling-slots.ts",
  // Virtual ACCESSORS need no dedicated work: `get x()` is the method
  // `get:x` by IR time, so it takes an ordinary slot.
  "722-accessors-inheritance.ts",
  "723-accessors-rc-stress.ts",
  // Mixins are plain inheritance chains once the frontend has flattened
  // them, so the whole family arrives with dispatch.
  "2040-mixin-heritage.ts",
  "2042-mixin-modules/main.ts",
  "2043-mixin-rc-stress.ts",
  // Generic classes and generic methods dispatching through a hierarchy.
  "1953-generic-class-hierarchy.ts",
  "2002-generic-methods-inheritance.ts",
  // Parameter-list shapes against overridden methods.
  "405-params-optional.ts",
  "407-params-rest.ts",
  "1852-overload-class-members.ts",
  // A base constructor's virtual call reaching a derived field BEFORE the
  // derived constructor assigns it — the reason `new` seeds union fields
  // with the interned undefined arm rather than a null (stage 1's seed
  // rule, first actually exercised here).
  "1586-derived-field-before-super-init.ts",
  // Increment 13 (classes), stage 4: the ERROR UNIFICATION. The builtin
  // error struct's slot 0 stopped being a class id out of a closed table
  // and became the same `vt` every hierarchy class carries, so a user
  // `extends Error` class is now an ordinary wasm SUBTYPE of it (its IR
  // field prefix is exactly name/message/%code) and instanceof is the
  // stage-2 interval test for builtins and user subclasses alike — an id
  // compare could never have recognised a subclass at all.
  //
  // The catch side records the thrown object's DYNAMIC interval position
  // in the cell and copies it into the snapshot, so a class test on a
  // caught value never casts the payload. That is what lets an
  // Error-typed binding discriminate a user hierarchy.
  "1301-errors-subclass.ts",
  "1303-errors-rc-stress.ts",
  "1304-errors-uncaught.ts",
  "2428-field-redeclare-inherited.ts",
  // Rejections carry error subclasses through the promise runtime: the
  // payload triple has no interval slot, so the cell's is recovered from
  // the payload's own vt when a rejection re-enters as an exception.
  "1029-async-eager-chains.ts",
  "1305-errors-async-rejections.ts",
  "1478-promise-reject.ts",
  // Increment 13 (classes), stage 5: classes as VALUES. One immortal
  // class object per class — interval, construct thunk, JS-visible name —
  // in a struct that SUBTYPES $ci, so `x instanceof someClassValue` reads
  // the target's bounds through the same head an instance's vt exposes.
  //
  // The struct is keyed by (hierarchy ROOT, constructor ABI), not by
  // class: a classval upcast leaves the reference untouched, so every
  // class one slot can hold must share a wasm type — and the validator's
  // rule for that upcast (strict descendant, equal completed ABI) is
  // exactly that pair. The thunk answers with the root's struct and
  // newValue casts down to its own static class.
  //
  // The object is filled on FIRST EVALUATION rather than by a constant
  // initializer, because its name is a string and `array.new_data` is not
  // a constant expression in WasmGC (checked against V8). The
  // zero-capture closure interning does the same for the same reason, and
  // it is what makes `C === C` hold.
  "1940-class-values-basics.ts",
  "1944-class-values-modules/main.ts",
  "2033-property-assigned-class-extends.cjs",
  "2523-private-statics-aliased-class.ts",
  // Generic instantiations: the class object carries the FAMILY's
  // interval (JS has one `Box` at runtime) while construction still runs
  // the instantiation's own thunk — the native lanes' split.
  "1952-generic-class-statics-values.ts",
  "2041-mixin-values.ts",
  // Decorators are class values by IR time: the decorator expression
  // takes and returns one, so the whole family arrives here.
  "1970-decorators-basics.ts",
  "1971-decorators-rebinding.ts",
  "1972-decorators-throwing.ts",
  "2522-private-statics-decorated.ts",
  // Increment 13 (classes), stage 6: the promise payload gained a 4th
  // slot for the thrown object's class interval, so a rejection that
  // re-enters as an exception restores the class it was thrown with.
  // That was the last thing forcing thrown objects to be error-rooted —
  // `throw:class` is gone, and ANY class instance now rides both the
  // exception cell and a promise rejection.
  "981-exceptions-values.ts",
  // Increment 14 (dyn core), stage 1: the checked-dynamic representation
  // — one $dyn struct with an explicit kind tag, four interned constant
  // boxes, and the scalar halves of the C emitter's to-dyn and check
  // walkers. `unknown` is a type the tier HOLDS now, so mapType stopped
  // refusing it and the census names the missing SHAPE instead
  // (dynFrom:func, dynCheck:record, ...).
  //
  // What that alone claims is the long tail of programs whose only dyn
  // was incidental: an uninitialized implicit-any `let` (which lowers to
  // `dynFrom(undefined)` and is now one global.get at THE immortal
  // undefined), an `unknown` callback parameter nobody validates, a bare
  // `typeof u`, a width-lifted record field.
  "519-array-from-length.ts",
  "1711-cjs-export-single-values/main.js",
  "1825-exhaustive-typeof-switch.ts",
  "2352-void-coercions.ts",
  "2557-width-field-lifts.ts",
  "2613-for-init-uninitialized-let.ts",
  // Increment 14 (dyn core), stage 2: the COMPOSITE walkers — per-typeKey
  // emitted functions that convert a static value into a dyn tree and
  // validate one back out, the C emitter's sc_td_N / sc_dc_N / sc_dm_N
  // families ported. Records are width-tolerant on the way out and
  // insertion-ordered on the way in; unions try arms in canonical order
  // and the first FULL match wins, which is what the match predicates
  // exist to decide before anything is built.
  //
  // Also the two JS-lane dyn literals and String(unknown). The claim
  // count is small because most dyn programs need a SECOND thing (the
  // keyed reads, the call boundary, json.parse) — what this stage really
  // moved is the floor under those.
  "1882-default-cjs-interop/main.ts",
  "2430-empty-literal-unknown-field.js",
  "2435-loose-same-kind-equality.ts",
  // Increment 14 (dyn core), stage 2b-i: JSON.parse — a recursive-descent
  // parser over the UTF-16 string (json.ts). The GRAMMAR is scr_json.c's;
  // the error TEXTS are V8's, because those are observable through a catch
  // binding and the C runtime's are self-described approximations that
  // match Node in 4 of 18 cases. Lone surrogates survive (S002), positions
  // are code-unit indices, and the depth cap throws a CATCHABLE RangeError
  // (S013).
  //
  // The number path is deliberately HALF-LANDED: Clinger's fast path is
  // exact for <=15 significant digits with |exp10| <= 22, and everything
  // else traps loudly until Simple Decimal Conversion lands in 2b-ii. A
  // corpus program whose real input misses the fast path therefore fails
  // the differential rather than answering wrongly, which is what keeps
  // this list honest without a compile-time fence.
  "1002-json-parse-cast.ts",
  "1004-json-parse-errors.ts",
  "1539-unknown-truthiness.ts",
  "912-unknown-slots.ts",
  // Increment 14 (dyn core), stage 3b: the rest of the keyed surface —
  // the keyed write, the presence tests, the three enumeration walks and
  // Object.assign over one shared own-key-order walk, strict equality
  // against a dyn side, array destructuring's GetIterator + N steps, and
  // the dyn arms of `??` / `&&` / `||` / `?.`.
  //
  // What these three actually pin is narrower than that list, so read
  // them for what they are: 1544 covers `in` on a dyn receiver and the
  // dyn `&&` arm, 2300 the keyed WRITE through objPut, and 2471 the
  // write plus Object.hasOwn and Object.assign. Everything else this
  // stage built — the enumeration order, the index writes, the
  // destructuring texts, the equality shapes, `??` and `?.` — is pinned
  // by the wasm emitter unit tests, because the programs that exercise
  // it all PRINT their dyn values and the inspect surface (x83 in the
  // queue) has not landed.
  "1544-dyn-json-reads.ts",
  "2300-dyn-record-spread-and-keyed-access.cjs",
  "2471-record-keyed-write-hasown.js",
  // Increment 14 (dyn core), stage 4: the FUNCTION boundary. A closure
  // boxes into the dyn tree carrying a per-SIGNATURE call thunk; a
  // checked cast back to the IDENTICAL signature hands back the very
  // same closure (identity survives the round trip), and a cast to any
  // other signature mints a per-target adapter that converts arguments
  // in and validates the result out. `dynCall` calls a dyn value: the
  // arguments evaluate first, then the callability test throws Node's
  // "<name> is not a function" (S018 for the spellings it renders
  // differently), then the thunk validates each argument into the
  // declared parameter type — JS arity, so a missing argument IS
  // undefined and extras are evaluated and dropped.
  //
  // These five are the real thing rather than a fixture: test/common's
  // mustCall wrapping a typed function and flowing to a timer slot,
  // captured state surviving both the boundary and an unwind through
  // it, uncaught TypeErrors at exit 1, and the timer forms that deliver
  // trailing arguments to a typed callback.
  "1665-dyn-fn-mustcall/main.cjs",
  "1666-dyn-fn-identity.ts",
  "1667-dyn-fn-not-callable.cjs",
  "1668-dyn-fn-throws.cjs",
  "1805-timer-callback-args.ts",
  // Increment 14 (dyn core), stage 5: prototype-method DISPATCH on a dyn
  // receiver, and the ERROR encoding both of its producers build.
  // `recv.m(...)` runs the real method for the receiver's runtime kind —
  // the Array surface, String's slice and its string-needle searches,
  // Function's apply/call, an object's own member — and answers Node's
  // own TypeError wherever the kind's prototype lacks the name. A caught
  // value crossing into `unknown` becomes the reserved-key `%error`
  // object through an identity cache, so `instanceof Error`, the
  // name/message reads and `String(err)` all answer like Node and one
  // error crossing twice stays ONE value.
  //
  // The four here are what the corpus can actually observe: everything
  // else this stage built is pinned by the wasm emitter unit tests,
  // because the dyn-dispatch programs print their receivers and the
  // inspect surface has not landed.
  "1839-var-js/main.cjs",
  "2037-fn-decl-hoisting.cjs",
  "2195-require-missing-package/main.mjs",
  "2566-promise-reject-dyn-reason.js",
  // Increment 15 (JSON.stringify), stage A: TYPE-DIRECTED serialization.
  // The static type picks an emitted walker (one per typeKey, C's sc_jw_*
  // family) writing into one module-global output buffer; records
  // serialize in declared order with their labels — keys escaped — baked
  // into the emitted literals, optional fields drop while they hold
  // undefined, tuples serialize as JSON arrays, and a `space` argument
  // re-indents the compact text with Node's gap algorithm. Escaping is
  // Node's WELL-FORMED rule, which is where this tier stops following the
  // C runtime (S002 again: unpaired surrogates survive here, so they must
  // escape rather than never arrive).
  //
  // The json-named eight are the direct claim. The rest were blocked on a
  // stringify buried somewhere in a program about something else, which
  // is why the queue counted this construct in 148 programs while only 62
  // refused at it FIRST: the width/spread/destructuring families print
  // their results as JSON.
  //
  // Two shapes stay out and both are named in the census rather than
  // silent: a dyn ROOT (2110, 2111) needs the dyn walker, and a RECURSIVE
  // record shape (2484 and the 2480s) now refuses as `record:recursive`,
  // which is the rec-group stage's queue signal.
  "541-ref-array-json.ts",
  "967-record-field-widening.ts",
  "1000-json-stringify-basics.ts",
  "1001-json-escapes-unicode.ts",
  "1003-json-parse-unions.ts",
  "1005-json-nested.ts",
  "1007-json-rc-stress.ts",
  "1008-json-null-arms.ts",
  "1009-json-optional-fields.ts",
  "1010-json-stringify-space.ts",
  "1118-object-spread-conditional.ts",
  "1373-union-array-arms.ts",
  "1476-assign-expression.ts",
  "1479-destructuring-assign.ts",
  "1530-array-push-variadic.ts",
  "1531-delete-optional-fields.ts",
  "1532-array-splice-shift.ts",
  "1871-empty-array-never.ts",
  "1942-class-expressions.ts",
  "2023-width-readonly.ts",
  "2031-width-tuples.ts",
  "2036-evolving-array-decl.cjs",
  "2070-computed-key-folds.ts",
  "2071-integer-key-enumeration-order.ts",
  "2105-computed-key-static-folds.ts",
  "2106-comma-expressions.ts",
  "2190-new-object-and-string-wrappers.ts",
  "2240-width-class-into-record.ts",
  "2243-width-assert-satisfies-shapes.ts",
  "2416-spread-ternary-positions.ts",
  "2417-ternary-local-inference.ts",
  "2444-union-literal-reducer-spread.ts",
  "2535-destructuring-assign-basics.ts",
  "2539-class-instance-rest.ts",
  // Increment 15 (JSON.stringify), stage B: the DYN ROOT — the one
  // stringify shape with no static type to direct a serializer, so the
  // dyn tree's own kinds drive a runtime walk instead. Undefined and
  // function members drop with their keys where array slots holding them
  // print null; a dropped ROOT becomes the text "undefined"; objects
  // serialize in JS own-key order (through the same helper Object.keys
  // goes through, so integer-like keys come out ascending first — C walks
  // its entry table raw and does not); a promise is `{}`; and recursion
  // caps at 1000 levels with a catchable RangeError, which is
  // SEMANTICS.md S026.
  //
  // `expr:jsonStringify` leaves the census entirely with these five. The
  // two other programs that were refusing at it turned out to be blocked
  // behind it as well rather than only by it — 2286 now names
  // libCall:insp.dynS and 2383 libCall:process.envGet.
  "1870-unit-type-values.ts",
  "2081-destructuring-rest.ts",
  "2110-top-object-types.ts",
  "2111-json-stringify-unknown.ts",
  "2534-object-rest-decl.ts",
  // Increment 15 (JSON.stringify), stage C: RECURSIVE record shapes and
  // the cycles their values admit. A shape that embeds itself cannot be
  // one type-section entry, so its whole strongly-connected component
  // becomes one REC GROUP — reserve an index per member, define them all
  // while their fields name each other, close. And because such a value
  // can point back at an ancestor, the walkers over cycle-capable
  // containers bracket their bodies with a seen STACK and stamp the edge
  // they are about to follow, so a repeat throws V8's circular-structure
  // TypeError with its message built byte for byte.
  //
  // Cycle-capability is NOT rec-group membership: a union arm breaks the
  // struct cycle (every union value is a ref to one shared base) while
  // still carrying a payload that can point back, so `{ next: L | null }`
  // needs no group and detects cycles anyway. 2484's chain case is
  // exactly that shape.
  //
  // `record:recursive` leaves the census with these three. The rest of
  // the 2480 family was blocked behind it as well as by it, and now
  // names what it actually still needs: 2485 libCall:insp.circCheck,
  // 2486 expr:mapNew, 2487 libCall:assert.deepResult, 2488
  // libCall:math.max.
  "2480-recursive-record-tree.ts",
  "2483-recursive-record-cycles.ts",
  "2484-json-stringify-circular.ts",
  // Increment 16 (util.inspect), stage B: the LAYOUT ENGINE. The frontend
  // synthesizes one traversal helper per static type; everything the type
  // cannot know lives in the runtime — a frame stack driving
  // reduceToSingleString and groupArrayElements, and Node's
  // `<ref *N>`/`[Circular *N]` protocol.
  //
  // The frame stack is ONE FLAT ITEM STACK plus a frame table, which works
  // because begin/end nest the way the type nests: a frame is the index its
  // items start at, an entry is a push, and `end` reads a span. Entries are
  // finished STRINGS, never open buffer regions — that is what keeps stage
  // A's mark discipline sound, and grid rows take their marks strictly
  // between the entries being complete and the output region opening.
  //
  // The grid's arithmetic is Node's verbatim including two asymmetries that
  // look like bugs and are not: averageBias divides by the FULL entry count
  // while the column estimate uses the grid's count, and MathRound is
  // floor(x + 0.5) rather than f64.nearest, which breaks ties to even and
  // picks different columns. Entries are sized by DISPLAY WIDTH, not
  // length, which is SEMANTICS.md S028's whole exposure. The `... n more
  // items` tail sits outside the grid but inside the bias.
  //
  // Errors render the stackless bracket form (SEMANTICS.md S027) — what
  // Node prints for an error whose stack is empty, measured shape by shape
  // rather than invented.
  //
  // Nine libCall names leave the census together: begin, entry, end,
  // moreItems, circCheck, seenPush, refWrap, circular, error.
  "1631-inspect-arrays.ts",
  "1632-inspect-records.ts",
  "2045-parameter-properties.ts",
  "2046-abstract-classes.ts",
  "2451-private-fields.ts",
  "2485-inspect-circular-refs.ts",
  // Increment 16 (util.inspect), stage C: the DYN WALKER — the one runtime
  // type whose SHAPE lives in the value, so the traversal is emitted code
  // rather than a synthesized per-type helper. `insp.dyn` recurses over the
  // tree's own kinds through the same frame engine; `insp.dynS` is
  // format's %s twin, where a dyn STRING passes verbatim (that ONE rule is
  // why console.log of a dyn value was blocked, and why unblocking it
  // claims twenty-four programs that are not about inspect at all); and %j
  // goes through the stringify walker with Node's tryStringify behavior.
  //
  // Four things the walker decides that the C reference decides otherwise,
  // all measured against Node first: key order is OWN-KEY order through
  // `objWalk` (integer-like keys ascending FIRST — C walks its entry table
  // raw); the CIRCULAR protocol runs here at all (C has none, and a cyclic
  // dyn tree kills the process); identity on the seen stack is the PAYLOAD,
  // not the `$dyn` box, because a keyed write copies the box and shares the
  // payload; and recursion is capped, emitting Node's own interruption
  // marker and finishing the render (SEMANTICS.md S029).
  //
  // A PROMISE in the tree fences loudly (S030) — the one throw in the
  // engine, which is what put `insp.dyn`/`insp.dynS` in the may-throw seed
  // set. `%j` needed the stringify walker to grow the seen stack S026 had
  // named as its own missing piece, so a cyclic dyn tree now throws V8's
  // circular TypeError there instead of running out of depth.
  //
  // `libCall:insp.dynS` leaves the census entirely: it was the work
  // queue's largest single entry (×83 programs, ×34 of them refusing at it
  // FIRST), and the difference between those numbers is the point — most
  // of these programs are about dyn keyed writes, prototype dispatch,
  // destructuring or `any` bindings, and were blocked only on printing
  // their results.
  //
  // 2383 still refuses, at libCall:process.envGet. 2601 was expected to
  // keep refusing for non-inspect reasons and does not — printing was its
  // last gap.
  "1591-js-closures.js",
  "1617-cjs-esm-lexer-visible/main.mjs",
  "1637-inspect-dyn.ts",
  "1664-dyn-fn-boundary.cjs",
  "1679-console-dyn.js",
  "1702-dyn-proto-dispatch.cjs",
  "1713-js-dyn-fields.js",
  "1760-surplus-args-drop.cjs",
  "1840-jsdoc-import-type-only/main.js",
  "2032-cjs-export-assigned-class-expression/main.cjs",
  "2038-evolving-array-js.cjs",
  "2040-any-bindings.ts",
  "2041-any-params-returns.ts",
  "2043-any-dom-values.ts",
  "2097-js-evolving-globals.js",
  "2162-js-dyn-destructure.cjs",
  "2286-dyn-object-walks.cjs",
  "2301-cjs-export-table-dom-attach.cjs",
  "2322-dyn-array-sort.cjs",
  "2473-option-table-widths.js",
  "2585-unknown-array.ts",
  "2600-dyn-keyed-write-harness.js",
  "2601-dyn-keyed-write-ops.js",
  "2602-dyn-array-destructure.js",
  // Increment 17 stage A (the map runtime): the compact-dict Map/Set
  // surface over WasmGC (maps.ts, new file) — parallel dense arrays
  // (keys/vals/live) plus an open-addressing bucket table, ported from
  // scr_map.c's design with one measured, deliberate correction: Node
  // preserves a NaN key's exact bit pattern in storage (scr_map.c
  // collapses every NaN to one canonical pattern, an undetected C-lane
  // divergence — flagged, not fixed there); hashing still canonicalizes
  // NaN to a fixed sentinel internally so equal keys hash identically.
  // `Set<T>` shares a `Map<T, number>`'s exact struct/helper family
  // whenever their keys agree (one interning key, no "map"/"set" prefix)
  // — one layer tighter than scr_map.c's own design. get()'s `V |
  // undefined` union construction needed a real case split, not just an
  // optimization: when V is ITSELF already union-typed with its own
  // undefined arm, "V | undefined" canonicalizes to V's own union
  // (measured via --emit-ir: exactly one IrUnionDef, shared by the map's
  // declared value type and get()'s result type) — 523-map-ref-values.ts
  // caught the case a naive "always wrap in a fresh arm" implementation
  // gets wrong. mapType/mapTypeSoft gained map/set arms in lockstep,
  // including mapTypeSoft's array-elem mappable list (Map<K,V>[] /
  // Set<T>[] now map instead of falling to the I32 placeholder).
  "518-array-sort.ts",
  "521-map-number-keys.ts",
  "522-map-foreach.ts",
  "523-map-ref-values.ts",
  "524-map-cycles.ts",
  "525-map-rc-stress.ts",
  "527-set-foreach.ts",
  "528-set-seeded.ts",
  "529-map-seeded.ts",
  "536-map-seed-array.ts",
  "537-map-iter-drains.ts",
  "538-map-set-for-of.ts",
  "1526-set-spread.ts",
  "1539-readonly-set-map.ts",
  "1550-param-defaults-func-set.ts",
  "1563-forof-iterator-projections.ts",
  "1593-js-jsdoc-records.js",
  "1614-js-fence-dodges.cjs",
  "1615-cjs-export-shapes/main.cjs",
  "1633-inspect-map-set.ts",
  "1638-inspect-cjs.cjs",
  "1836-var-loop-capture.ts",
  "1941-class-values-registry.ts",
  "2047-objlit-accessors-shapes.ts",
  "2080-destructuring-defaults.ts",
  "2085-destructuring-heads-rest-params.ts",
  "2368-set-methods.ts",
  "2486-recursive-record-boundaries.ts",
  "2533-forof-destructuring.ts",
  // Increment 17 stage A rider: bin:ref-eq for map/set-typed ===/!==
  // (ref.eq identity, joining the array/func/record/object/promise/
  // classval arm that already existed) — both flagship map/set corpus
  // programs needed it.
  "520-map-basics.ts",
  "526-set-basics.ts",
  // Increment 17 stage B (index-signature records): the overflow store —
  // a record's `[key: string]: V` slice reuses maps.ts's compact dict
  // verbatim (one Map<string,V>-shaped struct trailing the declared
  // fields), so hybrid shapes get BOTH struct-slot fields and an
  // embedded map with no second implementation. recordKeySet/Get/Delete
  // and the JSON.stringify overflow-appending fix (a real miscompile:
  // overflow keys were silently dropped) land here, plus the
  // recordKeyGet-into-optChain fix for a dyn-typed chain body (`dyn`
  // represents its own undefined, so a union-receiver optChain whose
  // BODY is dyn-typed short-circuits to the dyn undefined singleton,
  // not a union unit arm — see the optChain case in emitter.ts).
  // recordKeySet/Delete also serve signature-free shapes with a single
  // uniform field type (the "mockable module" pattern, confirmed via
  // lower-exprs.ts and corpus 2470) — not just true index signatures.
  // Own-key order on hybrid shapes (declared-then-overflow) diverges
  // from Node's single interleave; registered as S031 (inherited from
  // the existing C lane, not introduced here). S032/S033 register the
  // trap-on-unrepresentable-miss and fixed-shape-write-refusal wasm-tier
  // behaviors; S009 gained an amendment for dyn-value validation on
  // hybrid shapes.
  "908-records-index-signatures.ts",
  "911-records-index-dot-access.ts",
  "1542-record-literal-into-union.ts",
  "1545-spread-order-and-optional.ts",
  "1547-computed-key-fold.ts",
  "1548-boolean-condition-forms.ts",
  "1555-index-spread-into-declared.ts",
  "1576-width-coercions.ts",
  "1642-object-fromentries-rows.ts",
  "1790-computed-key-folds.ts",
  "1880-json-declared-field-order.ts",
  "2022-width-index-capture.ts",
  "2075-index-signature-runtime-keys.ts",
  "2090-index-signature-number-keys.ts",
  "2091-index-signature-string-intersection.ts",
  "2364-in-runtime-key.ts",
  "2370-group-by.ts",
  "2433-as-const-command-tables.ts",
  "2470-mockable-module-shape.js",
  "2550-generics-keyof-pick.ts",
  "2556-width-hybrid-shapes.ts",
  "2559-index-signature-container-values.ts",
  // Increment 17 stage C (the edges + integration sweep): dyn.ts's CHECK
  // and MATCH walkers gain index-signature arms — width TOLERANCE becomes
  // width CAPTURE (undeclared keys inserted into the overflow, values
  // checked/matched against indexValue), dissolving dynCheck:record:
  // index-signature, dynMatch:record:index-signature and dynFrom:record:
  // index-signature (the record→dyn overflow tail, JS own-key order via
  // keysJsOrder like the JSON writer). unionKeyGet:keyed-read now routes
  // a record-armed union's runtime/overflow-only keyed reads through the
  // same %w.rkg helper a single-record read uses, rather than
  // reimplementing declared-then-overflow dispatch a second time. A
  // downstream gap surfaced by dynCheck's dissolution and fixed here too:
  // JSON.stringify of a `dyn`-valued (`unknown`-signature) overflow entry
  // routed through jsonWriteHelper, which has no "dyn" arm and refused
  // (`jsonWrite:dyn`) — routed through json.ts's putDyn instead (already
  // a complete dyn-tree serializer with its own cycle detection), peeking
  // the entry's kind for putDyn's own undefined-or-function "absent" rule
  // BEFORE writing the comma/key, matching putDyn's own OBJ-arm pattern
  // for its own members exactly. A record↔dyn aliasing cycle cannot be
  // constructed in the first place (S014: crossing the dyn boundary
  // always deep-copies), so no coordination with the record's own
  // jbEnter/jbLeave identity stack is needed — verified with a probe
  // (function-valued and cyclic dyn overflow entries, both matching Node
  // exactly: the former drops silently, the latter throws the identical
  // circular-structure TypeError after the same preceding stdout).
  "909-records-index-json.ts",
  "910-records-index-rc-stress.ts",
  "913-records-index-iteration.ts",
  "914-records-from-entries.ts",
  "915-unknown-tostring-eq.ts",
  "1011-json-unknown-typeof.ts",
  "1525-unknown-typeof-validation.ts",
  "1575-unknown-assert-into-record.ts",
  // Increment 18 stage A (typed arrays — the core): the $bytes struct
  // (typedarrays.ts), all four bytesNew source forms, get/bytesSet with
  // JS-exact element coercion, length/byteLength/byteOffset, slice
  // (copy) vs subarray (VIEW — the design doc's owner-flattening-for-
  // free stance), setFrom, toArray, join, with/toReversed, fillElem, and
  // the union-arm/vecKeyFor/mapType plumbing bytes now rides. The array-
  // iterator protocol for typed arrays (2668) needed NO new machinery
  // beyond the representation existing — it was already generic over any
  // indexable element type.
  "1400-typedarray-basics.ts",
  "2668-stored-number-array-iterator.ts",
  // A record field union-arm (`Uint8Array | string`) plus `.length` on
  // the narrowed bytes arm — the union-arm plumbing's own claim.
  "1455-lambda-union-return-adoption.ts",
  // Increment 18 stage B (bytes io, partial): the full encoding surface
  // (typedarrays.ts's toStrHelper/fromStrHelper — hex, base64, base64url,
  // latin1, ascii, utf16le, utf8, both directions) plus the 1-arg
  // `toString(enc)` and `Buffer.from(string, enc)` wiring. 1401 needed
  // `.toString("hex")` specifically, which stage A's own design doc
  // flagged as blocked on this stage.
  "1401-typedarray-slice-set.ts",
  // Increment 18 stage B, round B3: buffer.concat/concatLen (with the
  // THIRD emitByteSizeGuard site), toString(enc, start, end)'s own clamp
  // rule, and Buffer.byteLength/isEncoding over runtime strings. 1402 and
  // 1663 head at concat/compareBuf-family constructs stage B2 had not
  // reached yet; 1661 needed toString:range specifically; 2380 needed
  // fillNum (B2) PLUS one of this round's constructs to fully claim — a
  // program can carry more than one refusal, and census counts only
  // change once every one of them is gone.
  "1402-buffer-encodings.ts",
  "1661-buffer-encodings-full.ts",
  "1663-buffer-compare-search-fill.ts",
  "2380-buffer-module-named-import.ts",
  // Increment 18 stage B, round B4 (closing stage B): readNum/writeNum's
  // float kinds (f32be/f32le/f64be/f64le) and the readNumVar/writeNumVar
  // 1-6 byte variable-width family. 1660 needed BOTH pieces to fully
  // claim, plus a fix mid-round: the census caught the var-width WRITE
  // family's value-range error message switching to a symbolic "2 ** N"
  // format at byteLength > 4 (now Node-exact), and separately exposed
  // that a NaN's bit pattern depends on its PROVENANCE (literal-folded
  // vs. genuinely runtime-computed) on BOTH Node and this tier — this
  // tier now folds literal-operand float arithmetic at compile time
  // (emitter.ts's emitBin) the same way V8 folds it, matching Node's
  // bytes on every provenance measured (SEMANTICS.md S036) — 1660 is
  // this fix's own corpus pin for the literal-fold case (`0/0`).
  "1660-buffer-read-write-num.ts",
  // Two more programs claimed as a SIDE EFFECT of the same fix: both use
  // a literal-literal `**` expression (e.g. `2 ** 10`), previously an
  // unconditional bin:** refusal — emitBin's literal-operand fold now
  // computes these at compile time (no general Math.pow support needed
  // for the literal case), so both compile and are byte-exact.
  "101-arithmetic.ts",
  "1630-inspect-scalars.ts",
  // Increment 18 stage C, round R1: DataView (dataViewNew + every
  // dvGet*/dvSet* accessor). 1407 and 2560 claim via the construction +
  // accessor surface directly; 2625 had been heading at
  // bytesIntrinsic:dataViewNew since round B2 and cleared the moment
  // dataViewNew landed.
  "1407-dataview-bounds.ts",
  "2560-arraybuffer-dataview-set.ts",
  "2625-bytes-views.ts",
  // Increment 18 stage C, round R2: dyn↔bytes crossing (dynFrom/dynCheck/
  // dynMatch/dynTest over bytes<u8>, SEMANTICS.md S014's bytes-aliasing
  // amendment). 916 exercises extraction, the aliased keyed reads,
  // String(), and JSON.stringify over a dyn-crossed Buffer/Uint8Array —
  // the outer dynFrom/dynCheck dispatch-gate fix and the objWalk local-
  // type fix (this round's two real bugs) both claim through it. 1451
  // exercises the OTHER capture direction, `instanceof Uint8Array`
  // narrowing (dynTest/dynMatch) over mixed dyn kinds including negated
  // flow and a Buffer receiver — DYN_TEST_KINDS already had DK.BYTES
  // wired from R1, so this one claimed without needing a fix of its own.
  "916-unknown-bytes.ts",
  "1451-instanceof-uint8array-unknown.ts",
  // Increment 18 stage C, round R3 (closing the increment): insp.buffer,
  // the STATIC-typed-Buffer inspect path (lower-inspect.ts's own
  // checker-type isBuffer gate — a real, non-dyn Buffer variable, not the
  // dyn walker's flag-aware BYTES arm R2 built). The wasm backend had no
  // dispatch for the "insp.buffer" libCall at all; it now calls the SAME
  // `bufferForm` helper (inspect.ts) the dyn walker's Buffer arm already
  // used, unmodified — no new runtime code, just the missing wire-up.
  "1635-inspect-buffer.ts",
  // Increment 19 stage A3: genResume's "next" and "return" modes (the
  // reentrancy TypeError, the DONE/UNSTARTED fast paths, the first-.next()
  // argument discard, the SUSPENDED resume path through the shared
  // emitResumeCallAndResult tail). All six programs the gate-widening
  // (A2c slice 5) relocated to expr:genResume clear here — 2017 composes
  // generators with async and claims too (no hoister gap found). The
  // yield-* five (2011/2012/2013/2014/2019) and the private-method
  // programs (2454/2456) stay declined under their own fn:generator:
  // yield-in-finally/yield-position/yield-in-switch/yield-in-forof names
  // until finalizer linearization (stage B) and the composition sweep
  // (stage C) land — `.throw()` mode (expr:genResume:throw) is still
  // unbuilt too.
  "2010-generators-basics.ts",
  "2015-generators-yieldstar.ts",
  "2016-generators-rc-stress.ts",
  "2017-generators-async.ts",
  "2018-generators-uncaught.ts",
  "2457-private-members.js",
  // Increment 19 stage A3-2: `dynCheck: ["value"]` — a single missing
  // HOIST_SLOTS entry, not a linearization feature. `yield`'s own static
  // type is the generator's nextT (unknown in 2013's `sum()`), so `(yield
  // 1) as number` compiles to a REAL checked cast (S009) wrapping the
  // yield, and hoistRoot could not see through it to find the suspension
  // underneath — declined at the wrapper (fn:generator:yield-position)
  // with the yield itself never reached. Overlooked originally, not a
  // deliberate exclusion (dynFrom/dynFromJsval/upcast/downcast are the
  // same "one operand, nothing to get wrong" shape and were already
  // covered).
  "2013-generators-sent-values.ts",
  // Increment 19 stage B: finalizer linearization, built generically over
  // BOTH lanes (statemachine.ts's TRY/CATCH section, "STAGE B ADDITION").
  // A suspension — or a return/uncaught-throw/GENRET crossing — inside a
  // try/catch/finally now linearizes instead of declining. 2011/2012/2014
  // are the generator targets (all at fn:generator:yield-in-finally
  // before this slice; 2011 needed only the normal/GENRET-crossing corner,
  // 2012 exercised the fuller set including a finally that itself yields
  // and a finally whose own throw replaces the parked completion, 2014's
  // one finally is simply abandoned mid-drain and never runs, matching
  // Node). 1022 is the async lift's own stretch claim (fn:async:
  // await-in-finally), taken because it byte-diffed green, exactly the
  // "acceptance test that the machinery is actually general" the design
  // report proposed. 1452/2432 (fn:async:return-in-finally) are NOT
  // claimed here: both cleared their own return-in-finally blocker but
  // hit separate, unrelated pre-existing gaps next (1452:
  // fn:async:await-in-forof, 2432: strIntrinsic:toUpperCase) — refusal-
  // bucket movement only, never forced, per the design report's own
  // "stretch riders taken only if green by the same bar" rule.
  "2011-generators-forof.ts",
  "2012-generators-return-throw.ts",
  "2014-generators-values.ts",
  "1022-async-exceptions.ts",
  // Increment 19 stage B, round 3: the reviewer's substance gate found
  // four blocking findings on the nested-finalizer/handler-boundary axis
  // (F1 reraisePending's THROW arm never chaining through a still-open
  // outer finally, F2 catchArm routing to a handler regardless of
  // nesting depth, F3 a compiler crash reading completion fields the
  // frame never allocated, F4 a GENRET handler-group sentinel using the
  // wrong representative state's finallyOf) plus two more found mid-fix
  // (F5 the mandated regression pin not actually discriminating a real
  // crash from the intended trap, F6/F7 the true final exit skipping the
  // lane's own completion — %gen.markDone / %async.reject — leaving a
  // generator wrongly resumable or a promise silently unsettled forever).
  // Ten programs, one per finding plus two permanent controls (2679 for
  // RETURN's own chaining, which never needed a fix; 2682 for async's own
  // ordinary resolving path) — every one Node-measured, all three lanes
  // byte-exact before landing.
  "2673-generators-finally-chain.ts",
  "2674-generators-finally-plain-outer.ts",
  "2675-generators-finally-plain-inner.ts",
  "2676-generators-finally-catch-order.ts",
  "2677-generators-finally-fallthrough.ts",
  "2678-generators-finally-genret-group.ts",
  "2679-generators-finally-return-chain.ts",
  "2680-generators-finally-throw-done.ts",
  "2681-async-finally-throw.ts",
  "2682-async-finally-normal.ts",
  // F8, found by the reviewer's re-gate on the round-3 fix itself:
  // reraisePending's THROW arm gave finallyOf a fixed FIRST priority over
  // handlerOf — the exact category-first mistake F2 already fixed inside
  // catchArm's own grouping, reintroduced at the one site that never got
  // routed through nearestOf. A catch nested BETWEEN a suspending inner
  // finally and an outer finally is where this actually matters: the
  // catch is nearer, but the fixed order skipped it. Fixed by having
  // this arm call nearestOf too, same as catchArm already does.
  "2683-generators-finally-catch-between.ts",
  "2684-async-finally-catch-between.ts",
  // Increment 19 stage C: switch linearization. lowerSwitch reuses the
  // source "switch" shape itself as the dispatch — same disc, same tests,
  // verbatim, in source order — replacing only each case's body with a
  // goto into its own new state; fallthrough (including a MIDDLE default)
  // comes for free from lowerList's own "non-null return falls through"
  // contract. 2019's fromSwitch() is the direct claim (its own
  // fn:generator:yield-in-switch clears); the async mirror
  // (fn:async:await-in-switch) had no corpus program sitting on it today.
  "2019-generators-loops.ts",
  // Increment 19 stage C: for-of array desugar. hoistStmt's own "forOf"
  // case rewrites an array-typed, suspension-containing for-of into an
  // ordinary index-based "for" (a hidden array-hold local, a hidden index
  // local, arrayGet/arrIntrinsic("length") — the same shape emitter.ts's
  // own non-suspending array-forOf case already uses) BEFORE checkPositions
  // ever runs, so the existing for-machinery does the rest with no changes
  // of its own. A for-of over a GENERATOR was never this pass's problem —
  // lower-generators.ts's lowerForOfGenerator already desugars it to a
  // while loop at the FRONTEND, unconditionally, so no "forOf" IR node
  // survives for one. Building this ALSO exposed a real, unrelated stage
  // A2c bug live: lowerSuspension's "yield" case embedded a suspending
  // yield's operand straight into %gen.suspend's own value field,
  // evaluated AFTER saves() already ran (rather than into its own frame
  // slot BEFORE saves(), the way "await"'s case already did) — a
  // side-effecting operand (`yield i++`) lost its side effect on every
  // suspend/resume round trip, so `while (true) yield i++;` silently
  // yielded the same element forever. Fixed the same way await already
  // handles it (evaluate into an awaitSlot first). 2454's own
  // Feed/#emit()/takeTwo() (a private generator method whose finally
  // observes IteratorClose on an early for-of break) is what exposed it —
  // no existing corpus program had combined a suspending LOOP with a
  // side-effecting yield operand before.
  //
  // 2454 and its own yield-in-forof clear; 1594 and 965 clear their own
  // await-in-forof. 2456's first refusal RELOCATES rather than clearing —
  // its pre-slice-5 blocker (strIntrinsic:toUpperCase) was always waiting
  // one refusal further in, simply unreachable until yield-in-forof lifted
  // — so it is NOT a new claim, deliberately left off this list. 1452 does
  // NOT claim either, for an unrelated, pre-existing, documented reason:
  // its OWN asyncThrough() for-of/await clears, but a SEPARATE nested
  // function in the same file (asyncReplaced(), line ~140) independently
  // trips fn:async:return-in-finally — a return crossing a finally that
  // itself never suspends, the narrowed (not lifted) case the header's
  // own comment on that decline describes ("still has no fix — the decline
  // narrows to exactly that case rather than lifting outright"). Not
  // forOf's scope; not fixed here.
  "2454-private-generator-methods.ts",
  "1594-js-async.js",
  "965-generics-async.ts",
  // Increment 20 stage B: toLowerCase/toUpperCase route through casing.ts
  // (ECMA Default Case Conversion, the ported libunicode tables — stage A
  // landed the builder gated behind emitter.ts's strIntrinsic refusal;
  // this stage deletes that refusal). 29 programs claim, all first-
  // refusing on strIntrinsic:toUpperCase/toLowerCase in stage A's own
  // survey; 1113/1114 (expr:jsExit), 1528 (libCall:process.envSet), 1562
  // (expr:regexIntrinsic), 1850 (libCall:global.undefRead), and 2042
  // (libCall:math.random) sat behind the SAME first refusal but have a
  // second, still-unclaimed blocker, so they do NOT join this list.
  // 2456's own toUpperCase blocker RELOCATED here from increment 19's
  // yield-in-forof lift (that increment's own TIER_FLOOR comment names
  // this explicitly) — it is a new claim now, not a relisting. 2432
  // next-blocks here from 19's return-in-finally clear the same way.
  "605-closures-forward-capture-tdz.ts",
  "1481-string-case-static.ts",
  "1527-logical-mixed-operands.ts",
  "1542-map-promise-values.ts",
  "1560-forof-homogeneous-tuples.ts",
  "1592-js-classes.js",
  "1597-mjs-graph/main.mjs",
  "1831-enum-string-const-reverse.ts",
  "1950-generic-fn-values.ts",
  "1951-generic-classes-basics.ts",
  "1961-namespace-nested.ts",
  "2000-generic-methods-basic.ts",
  "2003-generic-methods-object-literal.ts",
  "2020-generic-value-bindings.ts",
  "2047-optional-class-fields.ts",
  "2360-tuple-to-array.ts",
  "2366-string-well-formed.ts",
  "2369-promise-try.ts",
  "2386-string-to-chars.ts",
  "2432-generic-member-fields-async.ts",
  "2450-private-instance-methods.ts",
  "2452-private-statics.ts",
  "2456-private-async-methods.ts",
  "2520-private-statics-class-name-calls.ts",
  "2521-private-statics-class-expression.ts",
  "2538-destructuring-assign-class-source.ts",
  "2554-generics-frontier-mix.ts",
  "2558-index-signature-func-values.ts",
  "2584-union-dyn-collapse.ts",
  // Increment 21, toString:caught rider: String(e) / `${e}` over a catch
  // binding now lowers (emitter.ts's "toString" case, the "caught" arm) —
  // scalars format directly, an %Error-rooted OBJ payload renders through
  // the SAME errToStrHelper `e.toString()` on a statically-typed Error
  // already used ("error.toString" libCall), and everything else (a
  // thrown array/closure/record/union, or a non-Error class) is the
  // "[object Object]" default the exception cell's type-erasure forces —
  // scr_caught_to_string ported, verified against Node directly (not
  // transcribed from the C runtime; see the wasm-emitter.test.ts pin's
  // comment for the measured table). 4 programs first-refused here and
  // now claim, all byte-verified against Node: 1302 and 2095 hit it
  // through an UNNARROWED `${e}` inside a `typeof e === "string"` guard
  // (the caught local's own type stays "caught" regardless of a
  // surrounding narrow; only field/member reads narrow), 1431 is the
  // dedicated corpus pin for this construct, and 1434 hits it through a
  // `.catch()` handler parameter (the same catch-binding desugar).
  "1302-errors-typed-catch.ts",
  "1431-caught-tostring.ts",
  "1434-async-never.ts",
  "2095-js-catch-unknown.js",
  // Increment 21 stage A: the static island's representation. jsval ≡
  // dyn at representation (mapType(jsval) = the SAME (ref null $dyn) as
  // dyn; DK.JSVAL stays unconstructible — any-world values are ordinary
  // dyn payloads from birth), dynFromJsval is identity, and the
  // NO-COERCION jsOps (truthy/typeof/toStr/getProp/setProp/getIdx/
  // setIdx/objLit/arrLit/undefLit/nullLit) route through the existing
  // dyn runtime. 14 programs claim — the exact CLAIM-PREDICTION set
  // computed BEFORE implementation (op-census.txt §4: every program
  // whose jsOp set ⊆ that no-coercion list, cross-checked against
  // needsets.txt for no other unimplemented needs).
  //
  // Two names the prediction MISSED on the first pass (2583/2585-dyn-
  // nullish-coalesce.js): both hit a dynFrom:jsval refusal — NOT from a
  // nested composite position (the first write-up here was wrong and
  // was corrected before landing), but from emitDynFnThunkBody's boxed-
  // CALLBACK RETURN conversion (emitter.ts ~4024: a dyn-invoke callback
  // whose inferred/declared return type is jsval — 2583/2585's flatMap
  // callback `(v) => (v === 1 ? [v, v] : v)` — calls dynFromHelper(t.ret)
  // directly on its bare jsval return value). dynFromHelper's internal
  // per-typeKey walker (emitDynFromBody) needed its OWN jsval arm
  // (identity, same as its existing "dyn" arm) for this SECOND caller;
  // the dynFrom NODE's own top-level switch correctly has no jsval arm
  // (validate.ts's canConvertToDyn never admits a bare jsval operand
  // there) and needed no change.
  //
  // A real correctness bug found and fixed rather than left as a silent
  // wrong-output claim, in two rounds: 2086-destructuring-island-
  // globals.ts's module-scope `{ toString } = 1` / `{ toFixed } = 2.5`
  // needs getProp to answer a real FUNCTION for a NUM receiver's
  // prototype method name (Node boxes primitives for property access).
  // Round 1 (this agent) added a 2-name placeholder table — too narrow,
  // silently wrong for `toPrecision` and the rest of Number.prototype.
  // Round 2 (post-gate review) found the gap generalizes far past NUM:
  // `typeof s.toString` (STR/BOOL/ARR/OBJ receivers) and any Number.
  // prototype name outside the placeholder six ALSO silently answered
  // undefined where Node answers a function — S015 ("keyed reads on
  // `unknown` see OWN properties only") does NOT excuse this: S015 is a
  // registered divergence for the checked-dynamic `dyn` world (where
  // every operation is frontend-rejected by default), not for jsval
  // (whose contract is JS-exact engine calls — nodes.ts's own jsval
  // doc). dyn.keyGet's own NUM arm never existed because nothing could
  // reach one before this increment — y3-dyn-num-read.js shows the
  // UNCHANGED dyn-world case still answering S015's undefined today, on
  // both lanes, correctly. jsOp:getProp now carries closed, Node-
  // measured prototype-member tables (OBJECT_PROTO_MEMBERS — 10 names,
  // annex-B accessor definers included — applies to every kind;
  // ARRAY_/STRING_/BOOLEAN_/FUNCTION_PROTO_MEMBERS to their own kind,
  // each checked BEFORE the Object.prototype fallback so an override
  // like `toString` fences under its OWN constructor name, never
  // "Object.prototype.toString") and a per-name S023-style runtime
  // fence (protoFenceGetPropHelper) — a plain, catchable Error,
  // "'<Ctor>.prototype.<name>' on an island value is not supported
  // yet", never a silent wrong answer — for every tabled name outside
  // the Number six, which alone still get real placeholders (F2:
  // nativeMethodPlaceholderHelper interns ONE dyn FUNC per NAME in a
  // module global, not a fresh struct per call site, so same-name-
  // different-receiver stays `===` and different names never collide —
  // reachable through those SAME placeholders too: a placeholder is a
  // real FUNC-kind jsval, so `.call`/`.apply`/`.bind`/`.toString` on one
  // fence as Function.prototype members, FUNCTION_PROTO_MEMBERS's own
  // reason to exist). OBJ receivers check their OWN entries first (an
  // own field shadows the prototype fence, matching Node). A name in
  // NEITHER a fence table nor a modeled name (length, canonical
  // indices, FUNC's name/length) keeps keyGet's plain undefined —
  // Node-exact for a genuinely missing key. This fence-or-fallback
  // dispatch is only ever BUILT for a getProp call site whose compile-
  // time `name` matches at least one table; 13 of the 14 claimed
  // programs' own getProp names never do, so those 13 still take the
  // exact original keyGet path, unchanged — the 14th,
  // 2086-destructuring-island-globals.ts, DOES match (its own
  // "toString"/"toFixed" are in NUM_PROTO_METHOD_ARITY), so this
  // dispatch IS built for it and resolves through the placeholder arm,
  // not the fence — output stays Node-exact, that arm's whole point.
  "1123-any-conditional-spread.ts",
  "2086-destructuring-island-globals.ts",
  "2130-overload-island-returns.ts",
  "2579-jsval-object-param-crossing.js",
  "2580-jsval-routed-keyed-ops.js",
  "2582-jsval-object-statics.js",
  "2582-jsval-routed-keyed-ops.js",
  "2583-dyn-nullish-coalesce.js",
  "2584-jsval-object-statics.js",
  "2585-dyn-nullish-coalesce.js",
  "2603-island-keyed-write-dyn.js",
  "2632-dyn-jsval-iterate.js",
  "767-string-literal-keys.ts",
  "968-jsval-lift.ts",
  // Increment 21 stage B, gate 1 (coercion ops over jsval ≡ dyn payloads):
  // add/sub/mul/div/mod/pow/neg/plus/lt/le/gt/ge/eq/neq, all newly
  // implemented (ToPrimitive/ToNumber/ToString via jsToNumber/dyn.toStr,
  // a from-scratch StringToNumber grammar, and dyn.strictEq() reused
  // directly for eq/neq — CORRECTED from the design doc's "loose
  // equality" draft to the C reference's actual "strict ===/!=="
  // semantics, scr_runtime.h SCR_JSOP_EQ/NEQ). Plus the logical:jsval
  // route-through (763's `||`/`&&` over `any` operands — a small, pre-
  // existing gap in the exhaustive `logical` dispatch, same shape as the
  // adjacent `dyn` arm; validate.ts already admitted jsval there). Two
  // real bugs found and fixed by actual compile+run+diff against Node,
  // not by tsc alone: jsOpResultKind's bool-not-jsval result kind for
  // the six relational/equality ops (WebAssembly's own validator caught
  // the mismatch — a boxed dyn where a bare i32 was declared); and
  // class-field default-seeding (emitFieldSeed) missing a jsval arm
  // alongside its existing "dyn" one, so an unassigned `any` field
  // defaulted to a raw null ref instead of the engine's own undefined
  // (1587's `String(h.x)` before `.fill()` runs is what surfaced it —
  // masked until this gate opened a real end-to-end path through the
  // program). `pow` computes exactly y===2 (`x*x`, fdlibm-exact) plus
  // the full ECMA-262 special-value table; every other exponent takes a
  // runtime "not supported yet" fence — narrowed deliberately, see the
  // op's own header comment (jsPowHelper).
  "1587-any-field-unassigned.ts",
  "2365-dyn-into-island.ts",
  "2667-array-to-sorted-any.ts",
  "760-any-arithmetic.ts",
  "763-any-flow.ts",
  "764-any-async.ts",
  "768-any-uninitialized.ts",
  // Increment 21 stage B, gate 2 (the call family: callMethod/callFn over
  // jsval ≡ dyn payloads). callMethod reuses the EXISTING S023-style
  // `dyn.invoke(name)` ladder wholesale — its OBJ arm already does keyed-
  // get + FUNC check + this-bracket (thisPush/thisPop around callFn()),
  // which is the "program-defined method" dispatch this gate would
  // otherwise have had to build from scratch; extended with STR replace/
  // replaceAll/at/charAt and NUM toFixed/toString (measured names:
  // 1113/1114/2084/761/765). toUpperCase/toLowerCase and .split() route
  // to the EXISTING static case-mapping (casing.ts, increment 20) and
  // string-splitting (strings.ts) machinery directly — the SAME
  // implementations plain `string`-typed receivers already used, now
  // also reachable from an `any`-typed receiver. callFn is now guarded
  // against a real trap the review round flagged: a FUNC value CAN be a
  // `nativeMethodPlaceholderHelper` placeholder (one of the six
  // Number.prototype names extracted via destructuring, e.g. `const {
  // toFixed } = 5`) with a NULL thunk; calling it via the unconditional
  // `callRef` path would trap. `dyn.callFn()` now rescues exactly the
  // three measured names (toFixed/toString/valueOf) when the ambient
  // `this` (dyn.this) is actually a Number, and throws Node's own exact
  // "Number.prototype.<name> requires that 'this' be a Number" (oracle-
  // measured, uniform across all six names) otherwise — never a bare
  // trap. Zero regressions; the gate closed at exactly the 5 programs
  // whose ONLY remaining need was the call family (1113, 1114, 1122,
  // 1595, 761) — others needing callMethod/callFn (762, 765, 2084, 2170,
  // 2449, 2474, 2475, ...) still refuse cleanly on a LATER gate's
  // boundary (jsExit composites, jsMarshal's func arm, globalGet, or the
  // Function-eval recognizer — none crash, all named diagnostics).
  "1113-string-methods.ts",
  "1114-string-unicode-island.ts",
  "1122-any-captures.ts",
  "1595-js-island-gap/main.js",
  "761-any-objects.ts",
  // Increment 21 stage B, gate 3 (globalGet's closed table, continued, plus
  // the Function-eval recognizer). `Number.parseFloat`/`Number.parseInt`
  // route through the SAME globalGet callFn dispatch JSON.stringify/
  // Number.isInteger already used (1421) — a leftover claim from earlier
  // gate-3 work not yet swept into a differential run. The Function-eval
  // recognizer (this file's own header on FnEvalValue/FnEvalPlan,
  // scratchpad/function-helper-decision.md, Option A) parses the compiler's
  // OWN `construct(globalGet("Function"), ...strLit)` synthesis for
  // destructuring assignment/declaration over island sources at EMISSION
  // TIME (ordinary TypeScript string parsing over compile-time-constant
  // strLit args, never runtime bytecode) into a plan, then compiles the
  // plan into a real synthetic wasm thunk boxed as a dyn FUNC — reusing
  // `dyn.iterN()` for array-pattern GetIterator/not-iterable semantics and
  // `dyn.keyGet()`/the getProp proto-fence tables for object-pattern reads,
  // rather than hand-rolling either. SCOPED for this gate (measured against
  // the recognizer's own 15 observed body shapes): flat and nested object/
  // array patterns, holes, defaults (literal scalars, array/object literals
  // recursively, temp/extra references), and LITERAL property keys.
  // Tier 625→631 (this first pass; 595 was the pre-increment-21 baseline,
  // not the from-number here). Zero regressions; claims 2054, 2074 (a
  // top-level uncaught TypeError after several caught ones — S007's trap
  // bridge), 2084, 2101, 2196. 2083/2104 refused cleanly on
  // `fnEval:arrayRest`/`fnEval:computedKey`; 2103 refused on an unrelated
  // `expr:jsExit` gate-4 boundary — none crash, all named diagnostics.
  //
  // Prediction-reconciliation follow-up (same gate, closed before gate 4):
  // rest (object — `dyn.objWalk(v, KEYS)`'s own-key enumeration with a
  // runtime exclusion list, exactly the way `for-in`/`Object.keys` already
  // walk; array — a second unbounded `dyn.iterPack` drain sliced from
  // where the leading `iterN` left off), computed keys via extra/call
  // (`dyn.toStr()` — ToPropertyKey reduces to ToString, no Symbol kind in
  // this representation), and call-shaped default values (`dyn.callFn()`,
  // gate 2's own call machinery) are ALL now implemented, oracle-verified.
  // Tier 631→632: closes 2083 outright. 2104 still refuses (now on
  // `expr:jsMarshal`, gate 4's own func-arm boundary — a captured closure
  // marshaled in as a computed-key extra — confirming the fnEval gap
  // itself is closed, not just relocated). One documented, narrow
  // residual gap: computed keys do not route through the getProp
  // proto-fence tables (compile-time-keyed, unusable against a runtime
  // string) — not observed in any measured shape, not an S-entry (a
  // scoped limitation, not a deliberate divergence).
  "1421-number-parse-dynamic.ts",
  "2054-destructuring-island-source.ts",
  "2074-island-destructuring.ts",
  "2083-destructuring-island-decl.ts",
  "2084-destructuring-primitive-sources.ts",
  "2101-dyn-param-defaults.ts",
  "2196-island-computed-key-chain.ts",
  // Gate 4, part 1: jsExit's COMPOSITE path (records, arrays of non-jsval
  // elements, bytes<u8>, undefined-armed unions of JSON-safe arms — the
  // domain past the two special cases (strict primitives, array<jsval> by
  // reference) already covered). Reuses `dynCheckHelper` verbatim — the
  // SAME validating extractor `as`-casts and typed function parameters
  // already use. Measured DIRECTLY against the reference LLVM lane before
  // landing (scratchpad/oracle3/jsexit-composite.ts: a missing optional
  // field builds the undefined arm, a wrong-type field throws
  // "expected <type> at $.<field>, got <type>" — wasm's output is
  // byte-identical to the native lane's). No Node oracle exists for the
  // type-check itself (Node erases TS types entirely, so it never throws
  // here) — S009 ("trust-but-verify at every dynamic boundary") already
  // covers exactly this shape for the checked-dynamic world; extending it
  // to jsval's jsExit boundary is a drafted amendment for the close-out
  // report, not yet registered. Tier 632→634: closes 2103 AND a bonus,
  // 762-any-boundary.ts. Zero regressions.
  "2103-optional-tuple-elements.ts",
  "762-any-boundary.ts",
  // Gate 4, part 2: jsMarshal's `func` arm (host-closure boxing — a
  // STATICALLY typed closure crossing INTO the island as a real dyn FUNC
  // value). Reuses `dynFnBox`/`dynFnThunk` verbatim, the SAME per-
  // signature box/thunk pair the checked-dynamic `unknown` boundary
  // already builds — boxed ANONYMOUSLY (jsMarshal's IR node carries no
  // name field, matching `emitDynFromBody`'s own "func" walker arm, not
  // the NAMED "dynFrom" expression arm). Two bugs found and fixed via
  // this path reaching them for the FIRST time (all oracle-verified,
  // native-lane-compared where no Node type-erasure applies):
  //  - `emitDynFnThunkBody`'s param/return handling checked `p.kind ===
  //    "dyn"` but not `"jsval"` — `isIslandCallbackParamType`/
  //    `islandCallbackRet` explicitly admit jsval-typed callback
  //    params/returns (jsval ≡ dyn, same wasm representation, just a
  //    missing arm) — fixed by treating them identically.
  //  - `dyn.keyGet`'s BYTES arm modeled "length" but not "byteLength";
  //    this tier's bytes<u8> is always single-byte elements, so the two
  //    are the same number by construction — fixed by treating
  //    "byteLength" as a length synonym for BYTES receivers specifically
  //    (unaffected: hasOwn/objWalk, measured against Node — neither name
  //    is enumerable or own on a real Uint8Array either).
  // The island-REST ABI form (`(...args) => ...` — canMarshalTypedFunc
  // IntoIsland's `t.rest === true` branch, a trailing jsval param that
  // must COLLECT every surplus argument rather than bind just one) is
  // NOT yet implemented — `dynFnThunk`'s fixed-arity per-param loop
  // would mis-bind it; refuses named. Review round 1 (SB11) reverted
  // this refusal's OWN bucket from a fragmented `jsMarshal:func-rest`
  // back to the stable `expr:jsMarshal` aggregate every other
  // unimplemented jsMarshal shape uses — the fragmented name was this
  // file's own mistake, not a deliberate per-shape exception. One more
  // gap surfaced ONLY by this path becoming reachable: an island object
  // literal's `toJSON` member (needs jsMarshal's func arm to exist AT
  // ALL before `{toJSON: fn}` could ever compile) was previously
  // unimplemented in the dyn JSON.stringify walker (`putDyn`) —
  // SerializeJSONProperty's own first step, `Get`ting and, if callable,
  // calling `toJSON` and re-serializing its result instead of walking
  // the object structurally. Implemented via the SAME thisPush/thisPop
  // bracket `dyn.invoke`'s program-defined-method dispatch already
  // uses, and the SAME self-recursive `idx` call the array arm already
  // makes per element. Review round 1 closed three further gaps in this
  // FIRST toJSON landing, all oracle-measured: SB8 threads the REAL
  // `key` argument (property name / array index-as-string / `""` at
  // the root) through a global call-channel (`jbToJsonKey`/
  // `jbSkipToJson`) rather than a `putDyn` signature change (avoids
  // renumbering ~15 existing locals); SB9 makes the toJSON dispatch
  // fire EXACTLY ONCE per property — the RESULT is serialized
  // structurally, its OWN "toJSON" (if any) is never re-invoked
  // (`{toJSON:()=>({toJSON:()=>99})}` stringifies `{}`, not `99`),
  // while a composite result's OWN CHILDREN still get their own fresh
  // dispatch (`{toJSON:()=>({x:{toJSON:()=>7}})}` → `{"x":7}`); and a
  // genuine REENTRANCY bug the reviewer's probe caught — a `toJSON`
  // that itself calls `JSON.stringify` shares this walker's buffer/
  // seen-stack/depth/circular-flag globals with the OUTER, still-in-
  // progress walk, corrupting it (Node has no such sharing — verified
  // directly, `JSON.stringify({a:{toJSON:k=>JSON.stringify({inner:k})},
  // b:{toJSON:k=>\`k2=\${k}\`}})` composes cleanly) — fixed by saving
  // the outer's buffer text (via `jbFinish`, which snapshots-and-resets
  // in one call), swapping the seen-stack ARRAY REFERENCE to null
  // (`jbEnter` allocates fresh on null, so the reentrant call gets its
  // own isolated stack, never touching the outer's frames), and saving
  // depth/circular-flag as plain scalars — all restored unconditionally
  // once the callback returns. Zero regressions; closes 2170, 765, 2578
  // (the three directly targeted, non-rest programs) plus SEVEN bonus
  // claims the jsval-identity/byteLength/toJSON fixes together unlocked:
  // 2104 (computed-key destructuring's captured-closure extra), 2171
  // (toJSON), 2449, 2510-2513 (the dyn-evolving-array family — closures
  // pushed into an array, later mapped/filtered/foreach'd), 2581, 2583.
  // RECONCILIATION: 2633-island-promise-crossing.js is NOT claimed here
  // and never was — noted so its movement cannot read as a silent
  // shrink. Before this fix it refused first on `expr:jsMarshal`
  // (blocked by the SAME func-arm gap this section closes); it now
  // refuses first on `dynFrom:promise:adapt` instead — a forward move
  // into stage-C (island promise bridge) territory, not a regression
  // and not a new claim.
  "2104-computed-key-destructuring.ts",
  "2170-island-array-exits.ts",
  "2171-island-json-stringify.ts",
  "2449-js-dyn-worlds/main.js",
  "2510-dyn-evolving-array-map.ts",
  "2511-dyn-evolving-array-filter-foreach.ts",
  "2512-dyn-evolving-array-mixed-push.ts",
  "2513-dyn-evolving-array-derived.ts",
  "2578-jsval-into-unknown-rows.ts",
  "2581-jsval-routed-calls.js",
  "2583-jsval-routed-calls.js",
  "765-any-optional-chain.ts",
  // Increment 21, stage C (the import bridge — the closing stage): the
  // TLA/dynamic-import family's `jsBridgePromise` needs, plus the two
  // (PROMISE, method) invoke arms the spine's own synthesis calls
  // (lower-island.ts:365–380 — `globalGet("Promise")` →
  // `callMethod("resolve")` → `jsMarshal(builder closure)` →
  // `callMethod("then")`, wrapped in `jsBridgePromise`). New machinery:
  // (1) `dynFromHelper`'s "promise" arm now direct-boxes an inner
  // `jsval` (not just literal "dyn") — needed by the async builder
  // closures' OWN dyn-FUNC-thunk return conversion (their declared
  // return is always `promise<jsval>`); (2) jsOp callMethod's
  // globalGet-pattern table gains `(Promise, "resolve")` — always
  // zero-arg, mints a promise fulfilled with the engine's own undefined
  // and boxes it DK.PROMISE; (3) callMethod gains a runtime-kind-checked
  // `(PROMISE, "then")` arm (the `%w.async.thenRx` reaction: fulfillment
  // calls the handler, then either settles directly or ADOPTS when the
  // handler itself returns a thenable — the async builder's own shape;
  // a handler THROW is absorbed as the destination's rejection, never
  // propagated) — any OTHER receiver kind falls through to the
  // pre-existing `dyn.invoke("then")` fence unchanged; (4)
  // `jsBridgePromise` re-wraps a dyn PROMISE payload as a fresh static
  // promise, jsval/dyn inner only, reusing `raceReactionFor`'s "copy"
  // path (`typeEquals` forces the same-type key: a promise-of-jsval
  // settling from another promise-of-jsval is a plain field-wise copy).
  //
  // MUTATION-CHECKED per mechanism pin, not just typechecked (this
  // increment's own fresh lesson): every non-trivial branch in the
  // `%w.async.thenRx` reaction was individually forced off and the
  // census re-run to confirm it is load-bearing, not merely present.
  // Two were NOT — `then`'s SRC-rejected passthrough (unreachable by
  // construction: the only producer feeding a `then` reaction's SRC is
  // this file's own zero-arg `resolve`, which never rejects) is now a
  // documented `unreachable()` trap instead of untested code; the
  // handler-threw absorption WAS reachable in general (an imported
  // module's own top-level throw) but unexercised by the nine TLA/import
  // claims alone, so 2685 (new, this stage) pins it directly — a
  // SYNCHRONOUS sibling module whose `%init` throws at the dynamic
  // import's OWN builder call, distinct from 2660's shape (whose thrown
  // module is ASYNC, surfacing through the adoption path instead).
  // array<jsval> (2633's `Promise<any[]>` shape) and `void`-inner
  // `jsBridgePromise` were drafted, found UNEXECUTED by the same
  // per-branch check, and pulled rather than shipped unverified — see
  // `emitJsBridgePromise`'s own doc for the native-reference port to
  // restore each under a program that actually reaches it.
  //
  // Tier 646→657: 656 from the ten TLA/import claims measured against
  // the design doc's own prediction, 657 with 2685 — the mutation-
  // check's own pinning addition, found necessary AFTER that measurement
  // by forcing each reaction branch off in turn. Zero regressions,
  // exactly these eleven claims — no
  // rider claims beyond them (2633 and 2210-dyn-promise-crossing.cjs,
  // the pre-existing `dynFrom:promise:adapt` bucket's OTHER member,
  // both stay refused: 2210 needs the checked-dynamic world's OWN
  // `dynInvoke` "then"/"catch"/"finally" — a different, more general
  // reaction-chaining feature `PROMISE_REACTION_METHODS` still fences —
  // and 2633's only diagnostic is the pulled `expr:jsBridgePromise`
  // array arm itself (emitJsBridgePromise's own doc has the full
  // account); MEASURED, not assumed — survey-accepting that arm
  // hypothetically does NOT reach jsMarshal's own separate unimplemented
  // "promise" arm next either, the following gate is `expr:jsOp` (a
  // `Promise.all`-shaped island invoke need), with jsMarshal's gap
  // surfacing only as an additional, non-blocking survey need).
  "2050-dynamic-import-own-module/main.ts",
  "2051-dynamic-import-then/main.ts",
  "2052-dynamic-import-self.ts",
  "2606-dynamic-import-cycle/main.ts",
  "2650-top-level-await-self-import.ts",
  "2652-top-level-await-dynamic/main.ts",
  "2657-top-level-await-cycle-dynamic/main.ts",
  "2659-top-level-await-dynamic-cycle/main.ts",
  "2660-top-level-await-cycle-rejection/main.ts",
  "2661-top-level-await-dynamic-runtime-root/main.ts",
  "2685-dynamic-import-sync-throw/main.ts",
  // Pins the two-independent-observers equivalence nodes.ts:4887 asserts (two `.then()` subscriptions on ONE import promise, run-once init, both fire in order) — lead-side gate finding, previously unguarded.
  "2686-dynamic-import-two-observers/main.ts",
  // Increment 22, stage 0 (the process.nextTick queue — the streams/
  // events family's prerequisite): nexttick.ts's second FIFO beside
  // promises.ts's microtask queue, and emitter.ts's checkpoint rebuilt as
  // the two-queue fixpoint (ticks to exhaustion, then microtasks, repeat
  // while either has new work) with a measured first-checkpoint swap
  // (nexttick.ts's header has the full truth table against a live Node
  // oracle). Tier 658→661, exactly these three claims, zero rider/other
  // movement.
  //
  // NOT a claim, though its first refusal WAS `libCall:process.nextTick`
  // before this stage (the census-bucket-vs-full-survey distinction this
  // stage's own report corrects): 2310-process-next-tick.ts. Its `process.
  // on("exit", cb)` call lowers to `libCall:process.onExit`, wholly
  // unimplemented in the wasm backend (zero arms anywhere in emitter.ts,
  // and 1444/1445/1446-exit-*.ts stay refused on the exact same gate) —
  // the 2633 precedent: a plausible-looking claim that measurement
  // disproved stays named here, not silently dropped.
  "2311-next-tick-js-callbacks.js",
  "2323-timer-callback-returns.ts",
  "2656-top-level-await-cycle-order/main.ts",
  // Increment 22 stage A (the EventEmitter core + the extends-runtime gate
  // lift for the emitter root): classes.ts's rootKind now distinguishes
  // "emitter" (liftable) from stream-rooted "runtime" (still refused) and
  // plan() injects the two-field ScrEmitter prefix (registry ref, display
  // name) past `vt` on every emitter-rooted class; events.ts is the new
  // registry runtime — the general (dyn-array-thunk) bucket/entry family
  // per the approved ABI decision (scratchpad/listener-abi-decision.md:
  // every listener normalizes to dyn.ts's {clos, thunk: thunkSig} pair,
  // reusing dynFnThunk/dynFromHelper wholesale). Tier 661→673, these
  // twelve claims: construction (new/ctor, plain subclassing, namespace
  // spellings), on/addListener/prependListener/prependOnceListener (once
  // and prepend both landed — the entry's once/fired fields, the
  // prepend-vs-append insert, and emitDispatch's fired-guard + re-find-
  // and-unlink-before-invoke), emit over the general dyn tuple, off/
  // removeListener (identity by `clos`; onDyn's `orig` split is not
  // wired, so every claim here registers through the PLAIN typed path),
  // listenerCount(name)/listenerCount(name,fn), eventNames() (the bucket
  // chain IS insertion order — no shape-mode filter needed yet, since a
  // bucket always drops the instant it empties), and removeAllListeners
  // in BOTH forms (named: one bucket drop; whole-emitter: reg.head reset
  // to null). Emit-override dispatch (2618/2619/2622/2623) needed ZERO
  // new backend code — the vtable machinery already treats the emitter
  // root as an ordinary hierarchy root once the gate lift plans it, so
  // `%<class>.emit:<event>` virtualCalls just work.
  "1644-ee-basics.ts",
  "1645-ee-extends.ts",
  "1646-ee-once-remove.ts",
  "1649-ee-names-counts.ts",
  "1650-ee-prepend.ts",
  "1652-ee-snapshot.ts",
  "1653-ee-cjs.cjs",
  "1654-ee-namespace.ts",
  "2618-ee-emit-override.ts",
  "2619-ee-override-chain.ts",
  "2622-ee-override-filter.ts",
  "2623-ee-job-queue.ts",
  // Increment 22 stage A, rider: the 'error' bucket. The approved
  // exception to the ABI decision — dynCheckHelper has no "object" arm
  // (it cannot unbox a dyn value back into a class instance), and the
  // error-rooted dynFromHelper direction is S021's copy-and-cache
  // encoding, wrong for what must be invisible internal marshaling — so
  // 'error' listeners ride a SEPARATE bucket/entry pair (eeBucketErr/
  // eeEntryErr) whose thunk takes the real error reference DIRECTLY, no
  // dyn box, built by errThunkFor (the arity-0-or-1 adapter mirroring
  // dynFnThunk, interned per listener signature). emitError reuses the
  // ordinary `throw` statement's own emitThrowValue+emitUnwind pair for
  // the no-listener case — caught one real depth-tracking bug doing
  // this: a raw `code.ifResult`/`code.end()` (not the tracked
  // `this.openIfResult`/`this.close()`) left `this.fn.depth` one short,
  // so emitUnwind's branch-to-try-handler mistargeted under 1648's OWN
  // try/catch around emit('error', ...) — a bare top-level emitError
  // call would never have exercised the miscount; only running the
  // actual differential caught it, not typechecking. Tier 673→675.
  "1648-ee-error-event.ts",
  "2621-ee-override-error-throw.ts",
  // Increment 22 stage A, rider: the maxListeners family + onDyn/
  // checkListener. setMax/getMax/setDefaultMax(Chk): the range half
  // (`!(n>=0)`, catching NaN — IEEE754 comparisons against NaN are
  // false either way, so `n<0` alone would miss it) is shared by the
  // unchecked and checked forms; the Chk ladder's TYPE half needed TWO
  // passes — a runtime dyn-kind dispatch first (correct but unusable:
  // building even an UNREACHABLE arm's `refuse()` call fails the WHOLE
  // compile regardless of whether that arm is dynamically reachable,
  // measured directly on 2574's own valid-number case, which refused
  // before ever taking the throwing branch), replaced by a static fast
  // path reading the PRE-`dynFrom`-box value's own IR type (every
  // argument across 1651/2321/2574 is a literal expression) — zero
  // runtime dispatch, zero unhandled-kind exposure, for the corpus's
  // actual shape. checkListener/onDyn/offDyn (1678/2624) hit the
  // SAME "any unhandled arm fails the whole compile" wall from the
  // OTHER side: the lifted onDyn helper's `cb` parameter is a genuine,
  // unnarrowable `dyn` (shared across every call site of one adapter
  // shape) — closed by building the FULL 12-member DK dispatch instead
  // (dyn.ts's own established precedent: HANDLE/JSVAL are
  // `unreachable()` with no `refuse()`, since a handle is
  // unconstructible on this tier and a JSVAL-tagged box never actually
  // exists post the jsval≡dyn unification — bigint/symbol have no dyn
  // representation at all, so the frontend refuses those before a
  // value ever reaches here). onDyn's `orig` extraction (dyn.ts's
  // fnPayload/FN_CLOS) gives off/removeListener and
  // listenerCount(name,fn) Node's own identity rule for dyn-registered
  // listeners — 1678 pins the whole matrix (register-by-name-arity,
  // remove-by-original-identity, count-by-original-identity, 0-param
  // listeners taking the PLAIN typed path since a 0-param function type
  // has no dyn-flavored parameter to trigger the adapter at all).
  // Named, unmeasured simplifications carried forward (see the
  // relevant methods' own doc comments): no 25/28-char string
  // truncation in either ladder's rendering; a dyn OBJECT always
  // renders "Object" (this tier's dyn OBJ payload carries no
  // constructor-name tracking, so a boxed user-class instance would
  // print the wrong name — unexercised by any claim here); dyn BYTES
  // renders "Uint8Array" per S037 (this tier's OWN already-registered
  // Buffer/Uint8Array conflation crossing `unknown`, not a new
  // divergence). Tier 675→681.
  "1651-ee-max-listeners.ts",
  "1678-emitter-dyn-listeners.cjs",
  "2321-emitter-static-setmax.cjs",
  "2574-emitter-max-listeners-ladders.cjs",
  "2620-ee-override-once-order.ts",
  "2624-ee-override-js.cjs",
  // Increment 22 stage A, rider: the meta events. newListener fires
  // BEFORE the add (still reading the OLD listenerCount — entryAppend/
  // errEntryAppend call fireMetaHelper right after regEnsure, before
  // the actual insert) and removeListener fires AFTER each removal
  // (unlinkEntry/errUnlinkEntry, name read BEFORE a possible bucket
  // drop — Node's own scr_ee_remove_at order). Both ride the SAME
  // general dispatch (fireMetaHelper just calls emitDispatch with a
  // one-string tuple) — meta events are ordinary string-tuple events,
  // never special-cased below the bucket/entry level. Caught one build-
  // time bug closing this out: emitDispatch and unlinkEntry became
  // MUTUALLY recursive through fireMetaHelper (emitDispatch's once-
  // removal calls unlinkEntry, which fires 'removeListener' through
  // fireMetaHelper, which calls emitDispatch again) — the existing
  // `cached()` memoizer only records a function's index once its BODY
  // finishes building, so the reentrant call during that same build
  // recursed forever ("Maximum call stack size exceeded" at TS-compile
  // time, before any wasm ran) — fixed by a `cachedRecursive` variant
  // that records the index the moment `declareFunc` reserves it, before
  // the body is built. removeAllListeners' meta-aware form (both the
  // named and whole-emitter spellings) does the full LIFO-from-a-
  // snapshot removal with entryPresent's re-check each step (a nested
  // 'removeListener' handler may already have removed the next
  // candidate) and, for the whole-emitter form, every other bucket
  // before 'removeListener' itself last — Node's exact order. NAMED
  // GAP: errRemoveAll (the error-bucket's whole-wipe) still does NOT
  // fire per-entry 'removeListener' — unexercised by any claim here.
  // Tier 681→682.
  "1647-ee-meta-events.ts",
  // Increment 22 stage B, pass 1 (the Readable state machine — classes.
  // ts's stream-root gate lift for %Readable ONLY, stream.ts's $rState
  // struct + private tick FIFO riding nexttick.ts's stage-0 raw-marker
  // seam, construction/push/read/pause/resume/flow + the direct-emit
  // fast path, destroy's default path, the underscore `_read` dispatch,
  // and the scalar/flowing/errored property surface). Phase-2 predicted
  // 9 claims, landed exactly 9 — zero net-new refusals anywhere else in
  // the corpus (measured: the full 1069-program run's only failure was
  // this list itself, before the addition).
  //
  // CONTAMINATION RULING (the Phase-2 correction): 12 more stream-family
  // programs than pipe/unpipe (1692/1693) turned out to construct a
  // Writable/Duplex ALONGSIDE their Readable content in the SAME file
  // (source-verified real construction sites, not filename guesses) —
  // 1694, 1695, 1699, 1744, 1747, 1810, 1811, 1812, 2100, 2312, 2313,
  // 2626 — so they stay refused (`writable.new`/`writable.init`/etc)
  // THIS stage regardless of Readable completeness; they move to stage
  // C's pre-verified population alongside 1692/1693, 1743 (writable.init
  // — its Readable-half vtable-dispatch mechanism is exercised and
  // validated via 1740 instead), 1815 (writable.new), and 2634
  // (passthrough.new). 2310 stays refused for an UNRELATED reason
  // (libCall:process.onExit, issue #65 — not a stream/EE gap). 2599
  // needs stream.finished + node:net + Duplex + Readable.toWeb, none in
  // scope — stage D territory.
  //
  // SHAPE-MODE DEFERRAL: the stage-B brief's "shape-mode reservation
  // lands NOW" line was written when 2626 was still a stage-B claim;
  // once the contamination ruling moved 2626 to stage C, NOTHING left in
  // this stage's claim set exercises the reservation machinery or
  // events.ts's eventNames() error-bucket merge (grepped all 9 — only
  // 1761 calls eventNames(), and only on a plain EventEmitter, never a
  // Readable; 1761's own special-name-lookup story is frontend-fixed and
  // needs neither). Both land together in stage C with 2626 as their
  // pinner (events.ts's REG_SHAPE header carries this forward).
  //
  // TWO CORRECTIONS TO NODE DEFAULTS FOUND WHILE LANDING: (1) the
  // frontend's "no explicit highWaterMark" sentinel is -1 (the head's
  // hwm slot), resolved here to Node's REAL default — 65536 on non-
  // Windows since node#52037 (measured directly against v24.18.1;
  // win32's 16384 split is not modeled, no win32 target this tier) —
  // storing the sentinel verbatim silently poisoned every `length < hwm`
  // comparison downstream (a wrong-in-a-different-way bug the census
  // alone would not have caught, since every claim here pushes far below
  // either threshold). (2) `unshift()`'s EOF guard is NOT `push()`'s:
  // Node's real `readableAddChunk` checks `state.endEmitted` for the
  // FRONT path (ERR_STREAM_UNSHIFT_AFTER_END_EVENT) and `state.ended`/
  // `state.destroyed` for the back path — DIFFERENT flags — so a push(){}
  // -after-EOF path applied to unshift() would wrongly refuse a legal
  // `unshift()` called from a 'readable'/'data' handler that runs after
  // `push(null)` already set `ended` but before 'end' has emitted
  // (1686's pin). unshift/unshiftStr RECLASSIFIED from the design doc's
  // pass-2 grouping to pass 1: trivial once push's front parameter
  // exists, and 1686 (a pass-1 target) needs it.
  //
  // TWO MORE Node-exact orderings measured directly (both diverge from
  // this file's own first-draft assumptions, caught by the corpus, not
  // predicted): a push() reached SYNCHRONOUSLY in the SAME top-level
  // stack that registered a 'data'/'readable' listener does NOT take the
  // direct-emit fast path even once `flowing` already reads `true`
  // (Node's real per-instance `state.sync`, broader than "mid a `_read`
  // call" — RS_SYNC, cleared by this stream's own first tick, 1687's
  // pin); and `push(null)` reached from OUTSIDE a synchronous `_read`
  // frame synchronously drains a flowing stream right there rather than
  // waiting for the resume/readable tick (scr_stream.c's "outside a
  // _read call it runs NOW" — gated by the SAME RS_SYNC, since the
  // ungated version regressed 1685/1697 before the gate was added).
  //
  // Tier 682→691.
  "1685-stream-readable-basics.ts",
  "1686-stream-readable-paused.ts",
  "1687-stream-readable-flow-control.ts",
  "1696-stream-read-inside-read.ts",
  "1697-stream-tick-vs-timer.ts",
  "1698-stream-uncaught-error.ts",
  "1740-stream-extends-readable.ts",
  "1761-emitter-special-event-names.cjs",
  "2572-readable-emitted-readable-flag.cjs",
  // Increment 22 stage B, pass 2 (setEncoding + the utf8 StringDecoder,
  // Readable.from, for-await via readable.nextChunkDyn, stream/consumers).
  // Predicted 6 (Phase 2's fixed table); landed all 6 AND a 7th, unpicked
  // bonus claim (2594) that fell out of a PRE-EXISTING, unrelated-to-
  // streams gap this pass had to close along the way (error.nodeThrow —
  // 2628's ERR_UNKNOWN_ENCODING throws needed it and it was completely
  // unimplemented in this backend; 2594's own null-binding TypeError
  // throws ride the exact same libCall). Zero regressions across the full
  // 1069-program run.
  //
  // TWO OTHER PRE-EXISTING, UNRELATED-TO-STREAMS GAPS closed along the
  // way, both measured as genuinely load-bearing for the six targets, not
  // scope creep: `dyn.toString` (a checked-dynamic `.toString(enc)` —
  // 2628's 'data' listener calls it on the boxed chunk; the frontend had
  // already special-cased BYTES-kind receivers to decode per the literal
  // encoding argument, this backend just never implemented the libCall)
  // and `error.code` (`err.code` on an Error-rooted receiver — 2630's
  // `(e as NodeJS.ErrnoException).code`).
  //
  // THE DYN LANES, MEASURED NOT NEEDED: readable.newDyn/initDyn/pushDyn/
  // pushU are UNCLAIMED by this pass — all six targets' construction/push
  // call sites use compile-time-literal options and chunks throughout
  // (verified by reading every one; dynOptionsValue's own contract routes
  // an inline object literal through the STATIC path unconditionally), so
  // none of the four ever get reached. Left refusing by name, unbuilt.
  //
  // THE DECODER'S SCOPE, MEASURED: only utf8 needed the STATEFUL
  // StringDecoder (the held-back-incomplete-tail machinery, scr_bytes.c's
  // scr_strdec_tail ported) — 2628 is entirely the OTHER direction
  // (push(str,enc)/defaultEncoding = Buffer.from(str,enc), stateless,
  // already covered by typedarrays.ts's existing fromStrHelper for all
  // seven canonical encodings). setEncoding itself refuses by name for any
  // spelling but "utf8" (readable.setEncoding's encoding argument is
  // always a compile-time strLit, so the refusal is a compile-time name).
  //
  // A REAL CORRECTION TO THIS PASS'S OWN BRIEF, MEASURED: "concurrent
  // for-await iteration throws" does NOT hold in real Node (two `for
  // await` loops over one Readable share Node's cached async-iterator and
  // interleave/chain rather than throwing) — the brief's assumption
  // traced to scr_stream.c's own `next_waiter` model, itself now a
  // C-lane divergence candidate (flagged, not fixed here). RS_WAITER
  // (the single parked-continuation slot `readable.nextChunkDyn` uses)
  // TRAPS LOUDLY on a second concurrent park (S049 — the gate's fix
  // round replaced the original silent overwrite, whose user-visible
  // shape was truncated output with exit 0) — unreachable by any of
  // these seven claims (verified: none run concurrent iteration).
  //
  // THE GATE'S FIX ROUND (post-verdict, pre-landing, Joe's ruling on the
  // four measured divergences): concurrent-park now traps (S049, above);
  // a consumer registered on an ALREADY-closed stream settles at
  // registration via the factored settleConsumerCore (Node-ward fix —
  // previously its promise never settled and the program exited 0
  // silently short; the pre-close registration orders, including 2629
  // r7/r8's after-push(null)-before-'close', are untouched); encoded-
  // stream byte-vs-code-unit length accounting is REGISTERED as S047
  // (observable via push()'s return and readableLength, no claim reads
  // either); for-await early exit (break) not destroying the stream is
  // REGISTERED as S048 with a board item to build Node's destroy-on-
  // early-exit in a later stage.
  //
  // Readable.from(array) answers Node's REAL construction defaults
  // exactly (`{objectMode:true, highWaterMark:1}`, oracle-measured) for
  // the two properties a claim reads (readableObjectMode,
  // readableHighWaterMark) WITHOUT implementing true object-mode
  // entry-count buffering internally — a named, scoped simplification
  // (this file's own RS_OBJECT_MODE header carries the full argument for
  // why it is safe for every access pattern these claims reach: for-await
  // always drains the buffer to empty between chunks, so readCore's own
  // `length===0` doRead clause forces the next `_read()` regardless of
  // what hwm holds).
  //
  // Tier 691→698.
  "1745-stream-encoding-js.cjs",
  "1746-stream-for-await.ts",
  "2594-nullish-generic-bindings.ts",
  "2627-stream-ticks-are-nextticks.ts",
  "2628-stream-push-encodings.cjs",
  "2629-stream-consumers.ts",
  "2630-stream-consumers-errors.ts",

  // Increment 22 stage C, checkpoint (gate-lift + Writable core + the
  // "easy half" — CHECKPOINT, not the stage's full claim set; more
  // programs land before this stage closes). classes.ts's extends-
  // runtime gate lifted for all five RUNTIME_STREAM_CLASSES (was
  // %Readable-only); %Writable's own base chain (nodes.ts's map) goes
  // straight to %EventEmitter, a SIBLING of %Readable — unlike %Duplex/
  // %Transform/%PassThrough, whose base chains already run through
  // %Readable — so %Writable alone needed a struct-sharing fix in
  // classes.ts's plan() (share the wasm STRUCT index with %Readable,
  // keep %Writable's OWN `meta` for instanceof/vtGlobal's preorder
  // interval — the first attempt shared the whole ClassInfo and broke
  // `instanceof`, caught via 1741's own execution). New machinery: the
  // Writable write/end/cork/drain/finish/prefinish core (stream.ts,
  // mirroring the Readable side's tick-scheduled pattern), writeThunkFor/
  // finalThunkFor/destroyThunkFor + a runtime-synthesized completion-
  // callback closure per declared signature (doneClosFor, the
  // dynFnAdapter env-subtype pattern reused for a non-dyn purpose), the
  // SHARED destroy-override gate (destroyErrCore now checks a user
  // `_destroy` first, on every stream side, before the pass-1 default
  // path), readable.pushU (union-chunk push, tag-dispatched to the
  // existing pushNullCore/pushCore/pushStrCore), and the readable.new:
  // no-read / writable.new:no-write lifts (construct without the
  // callback, bind later via stream.setRead/setWrite).
  //
  // TWO PRE-EXISTING, UNRELATED-TO-THIS-STAGE'S-OWN-SCOPE GAPS closed
  // along the way, both measured load-bearing for these targets: (1)
  // `stream.errored`'s dispatch returned RS_ERROR's raw nullable ref
  // where the declared IR type is a tagged union (`%Error | null`) —
  // nobody had read `.errored` non-null before 1694; fixed by wrapping
  // into the union, mirroring readable.read()'s established pattern. (2)
  // `readThunkFor` (pass 1) had no guard against a checked-dynamic VALUE
  // option callback (`read: wrap(fn)` — lowerStreamCallbackValue's
  // thisless, all-dyn-boxed shape): it built wasm that VALIDATED but
  // TRAPPED AT RUNTIME (an isolated repro measured node exit 0 with real
  // output vs wasm exit 1 — a silent-wrong-exit-code bug, never reached
  // by any prior claim). Fixed with the same named-refusal guard this
  // stage's own writeThunkFor/finalThunkFor/destroyThunkFor carry from
  // the start; CENSUS-NEUTRAL (the bucket diff below has zero
  // regressions — nothing was ever claiming that shape, only trapping).
  //
  // STILL REFUSING BY NAME, not this checkpoint's scope: dyn-VALUE
  // option/underscore-assign callbacks generally (`libCall:writable.
  // write:dyn-callback-value` and its final/destroy/read siblings — 1811,
  // 2313 need this: real dyn-boxing/unboxing machinery, sized but not
  // built this checkpoint); readable.initDyn/writable.initDyn (1812 —
  // the runtime dyn-option-walk twins, sized but not built);
  // readable.pipe (1743, 1692, 1693 — board #71's flagged hazard);
  // duplex.new/transform.new (2626, 1747); passthrough.new (1695, 1692);
  // shape-mode event-key reservation (2626).
  //
  // Tier 698→707.
  "1688-stream-writable-basics.ts",
  "1689-stream-writable-async-drain.ts",
  "1694-stream-destroy.ts",
  "1699-stream-callback-shapes.ts",
  "1741-stream-extends-writable.ts",
  "1810-stream-options-const-record.ts",
  "1815-stream-state-reads.cjs",
  "2100-stream-default-hwm.ts",
  "2312-stream-underscore-assign.ts",
  //
  // STAGE C PASS 2, structural (pipe()/unpipe()): entryAppend/removeLast-
  // registered internal 'data'/'drain'/'end' listeners (Node's own real
  // mechanism, ported directly — not a parallel fast path), backpressure
  // via writeCore's existing return-value/pauseCore, resumeCore on
  // 'drain', end propagation via endCore on the source's 'end' (once).
  // A second simultaneous pipe() destination TRAPS (SEMANTICS.md S050,
  // registered before this landed) rather than silently overwriting or
  // fanning out — this tier tracks one relationship per source. Board
  // #71's flowing-seam note read and cleared: none of this pass's own
  // pipe claims register a 'readable' listener alongside pipe(), so the
  // hazard stays unobserved and unfixed, named in the pass-2 report.
  //
  // STILL REFUSING BY NAME: passthrough.new/transform.new (1692, 1695 —
  // construction itself, this pass's own next structural item); dyn-VALUE
  // option/underscore-assign callbacks (1811, 2313); readable.initDyn/
  // writable.initDyn (1812); readable.setEncoding:hex (1744 — needs BOTH
  // hex decode-out AND this pipe machinery, hex not yet built).
  "1693-stream-pipe-backpressure.ts",
  "1743-stream-extends-vt-dispatch.ts",
  //
  // STAGE C PASS 2, structural (Duplex construction + shape-mode):
  // duplex.new/init (readable.new/writable.new precedents, fused —
  // allowHalfOpen consumed and, after gate C2S-1's third remedy
  // iteration, fully WIRED: opEnd/OP_AUTO_END auto-ends the writable
  // side when the readable side ends under `allowHalfOpen: false`,
  // matching Node's real endReadableNT — that header has the full
  // mechanism story and the remedy history). Unblocking Duplex let 2626 compile, which then FAILED
  // the differential run — not this pass's build failing, the harness
  // doing its job — exposing TWO gaps, both fixed together: (1) a
  // pre-existing, general (non-stream) bug where eventNames() excluded
  // 'error' entirely for ANY EventEmitter (REG_SEQ/BUCKET_SEQ/
  // BUCKETERR_SEQ monotonic-stamp merge-walk, events.ts's own header —
  // the ten-case regression pin, p2-error-eventnames-measure.ts,
  // permanent); (2) shape-mode itself — streams pre-create their
  // canonical reserved-name buckets at construction (BUCKET_RESERVED/
  // BUCKETERR_RESERVED, events.ts's own headers), invisible until a real
  // listener lands, surviving a removeListener-emptying at their own
  // rank (unlinkEntry's honorReserved=true), but NOT surviving a named
  // removeAllListeners's fast (no-'removeListener'-meta-listener) path,
  // which deletes even a reserved key (measured directly against Node,
  // 2626's own r3/r4 cases). 'error' rides the DEDICATED err-bucket for
  // its own reservation, never the main chain (errBucketEnsure's own
  // reserved param) — the design's one named hole, closed before
  // building. Two audit-discovered fixes beyond the reviewed design,
  // both verified: removeAllWhole()'s meta-aware bucket-picking walk
  // gained a BUCKET_N>0 filter (a reserved-but-empty bucket sitting in
  // the chain would otherwise never be skipped nor ever get dropped,
  // an infinite loop, not just a wrong answer — unreachable by any
  // claim here but a real hang risk once BUCKET_RESERVED buckets exist
  // at all); removeAllNamedMeta's own per-entry unlinkEntry() calls now
  // pass honorReserved=true, matching a single removeListener(name,cb)
  // (measured: p2-shapemode-removeall-meta.ts's "with-meta" reserved-
  // name case matches Node exactly). NAMED, UNRESOLVED GAP (not fixed,
  // not silently miscompiled — flagged in the pass-2 report): the SAME
  // probe's "plain-with-meta" case shows a NON-reserved custom name on a
  // reserved-name-bearing stream ALSO preserving its position across
  // removeAllListeners+re-add when a 'removeListener' meta-listener is
  // present — Node does this too, but BUCKET_RESERVED does not model it
  // (the name itself is never reserved) and root cause is not
  // understood; verified unreachable by 2626 and by all seven other
  // eventNames()-exercising claims in this corpus, so left as a true,
  // execution-confirmed corner rather than guessed at further.
  "2626-stream-event-names.ts",
  //
  // STAGE C PASS 2, structural (Transform/PassThrough construction, the
  // pass's own closing item): the write-bridge-to-_transform and final-
  // bridge-to-_flush (writeThunkFor/finalThunkFor generalized with a
  // `kind` param — "transform"/"flush" sit alongside "write"/"final",
  // same struct-arity/cache-key discipline as the originals, doneClosFor
  // gained matching 2-param arms reading a REAL union tag, not dyn — see
  // the ambient-file correction below), RS_SYNC cleared at construction
  // (Node's real `_readableState.sync = false` runs INSIDE Transform's
  // own constructor, not waiting for a first `_read()` like a plain
  // Readable/Duplex — pushCore's direct-emit fast path needs it on the
  // very first push, not just later ones), PassThrough's canned identity
  // `_transform`/`_flush` bridges (no `_transform` override anywhere ⇒
  // pass the chunk straight through; no `_flush` ⇒ still push(null) and
  // finish, nothing extra — both measured directly against Node, not
  // assumed). Bare `%Transform` with NEITHER an option nor an override
  // refuses by name (`libCall:transform.new:missing-transform`) rather
  // than an unverified silent path — Node's own throws
  // ERR_METHOD_NOT_IMPLEMENTED lazily on first write, machinery this
  // tier does not have.
  //
  // THREE BUGS FOUND BY EXECUTION, ALL FIXED, NONE ANTICIPATED BY THE
  // REVIEWED DESIGN:
  // (1) doneClosFor's struct-field arity — "transform" kind shares
  // writeThunkFor's own structNew call site (which always pushes a wreq
  // value regardless of kind), but the struct's OWN field list only grew
  // a wreq slot for kind==="write" — caught immediately by wasm
  // validation ("struct.new[0] expected type... found local.get"), not
  // silently wrong.
  // (2) The completion callback's data parameter is NOT `dyn` for a
  // TYPED override (the design paragraph's own grounding error, self-
  // corrected mid-build): the project's OWN ambient
  // (scriptc-node-fallback.d.ts) declares `_transform`/`_flush`'s
  // callback as `(error?: Error|null, data?: Buffer|string) => void` — a
  // CONCRETE union, never dyn, for any TYPE-ANNOTATED override (matching
  // this backend's "chunks are bytes-or-string, never any" stance
  // everywhere else). doneClosFor's "transform"/"flush" arm reads this
  // union directly (dynFromHelper's own per-arm-by-kind pattern, reused
  // rather than re-derived) instead of dyn-unboxing — chunkDynToBytesCore
  // (pipe()'s own function) ended up UNUSED for this specific purpose.
  // BUT: an UNANNOTATED `.cjs` override (no JSDoc at all — 1747's own
  // shape, this pass's one deferred claim) infers ALL THREE params
  // (chunk/encoding/callback) as checked-dynamic, not just data — chunk
  // and encoding get boxed bytes/string→dyn at the call site
  // (writeThunkFor's own new chunkIsDyn/encIsDyn arms, "transform" kind
  // only), but `callback` itself being dyn needs real dyn-function/dyn-
  // invoke machinery this pass does not build — 1747 stays refused by
  // name (`libCall:transform.transform:non-func-callback`), parked for
  // the dyn-adapter phase rather than force-built here.
  // (3) `maybeFinishCore` (pass-1, shared, UNCHANGED by this pass)
  // branches on WS_FINAL_CLOS being null to decide whether ANY `_final`
  // exists at all, calling `finalDoneCore` directly and skipping
  // WS_FINAL_THUNK entirely when null — correct for a plain Writable/
  // Duplex with no `_final`. PassThrough/Transform's own "no `_flush`
  // override" construction populated WS_FINAL_THUNK with the identity
  // bridge but left WS_FINAL_CLOS null (mirroring the write side's own
  // "CLOS unused" pattern, which has NO such fast path — doWriteCore
  // always calls through WS_WRITE_THUNK unconditionally) — silently
  // routing every one of THOSE constructions around
  // identityFlushThunk/flushDoneCore/pushNullCore entirely.
  // 'prefinish'/'finish' still fired correctly (finalDoneCore ran either
  // way, from the OTHER branch), which is exactly why only the readable
  // side's 'end' went missing. Root-caused via temporary, fully-stripped
  // instrumentation (a `dbgLine` helper over the existing stage/putc/
  // flush console.log primitives, verified working via a stateEnsure-
  // only sanity print BEFORE trusting silence elsewhere as signal) after
  // static tracing through readCore/howMuchToRead/endReadableCore found
  // nothing wrong on paper — the actual break was one level further up
  // the call chain than any measurement had looked yet. Fixed by giving
  // WS_FINAL_CLOS a harmless non-null placeholder (`recv`, the instance
  // itself) alongside WS_FINAL_THUNK in that branch.
  //
  // A SECOND, INDEPENDENT INSTANCE OF THE SAME "DESTROYED BLOCKS A
  // STILL-OWED EVENT" PATTERN, found verifying the fix above against the
  // full suite (1690's own bonus-rider failure, below) — NOT a Transform
  // bug, PURE pass-1 Writable/Duplex machinery: `opFinish`'s own
  // autoDestroy trigger (`destroyCore` right after 'finish', built when
  // pass 1 only had single-sided Writable, where 'finish' IS the whole
  // lifecycle) fires unconditionally, with no notion that a duplex-
  // shaped stream has a second, independent half that may still be
  // open. Node's real autoDestroy waits for BOTH
  // `_writableState.finished` AND `_readableState.endEmitted` before
  // actually destroying — measured directly, ORDER-INDEPENDENT (p6a:
  // end() then push(null); p6b: push(null) then end() — `destroyed`
  // stays false through BOTH 'finish' and 'end' firing either way, only
  // flipping true once both are done, right before 'close'). Fixed with
  // a new WS_DUPLEX_SHAPED flag (set at duplex.new/transform.new/
  // passthrough.new construction, alongside WS_ALLOW_HALF_OPEN, same
  // lockstep) gating BOTH `opFinish`'s and `opEnd`'s autoDestroy calls:
  // a single-sided stream destroys immediately once its own side
  // completes (unchanged, 1688/1689/1694/the readable family stay the
  // control); a duplex-shaped one only destroys once ITS OWN side is
  // done AND the other side's own completion flag is already set —
  // whichever side finishes SECOND is the one that actually fires it.
  // Re-verified the FULL destroy-family pin set this shared machinery
  // touches (F1/F2/C4's own stabilization): c-destroy-cbfate/-midqueue,
  // c-err-queue2/3, c-err-destroy-collide, f-write-after-destroy,
  // f-mech-explicit-vs-autoDestroy — all still MATCH, zero regressions.
  //
  // readableLength UNDER utf8 fix, discovered running 1744 itself (SEE
  // SEMANTICS.md S047, corrected in the same landing): Node counts
  // STRING UNITS (JS `.length`), not RS_LENGTH's raw utf8-byte count
  // ("wörld": 11 units vs 12 bytes) — a NEW, non-destructive per-chunk
  // walk (`stringUnitsLengthOf`) decodes each buffered chunk's own
  // remaining slice independently and sums lengths, sound because every
  // STORED chunk is already a complete decoded-then-reencoded sequence
  // (pushCore's own decode choke point never stores a split tail — that
  // lives in RS_DEC_PENDING instead, so no chunk boundary could ever
  // split what the walk needs to re-join). RS_LENGTH's own internal
  // representation is UNCHANGED (still bytes) — only the property GETTER
  // now computes the Node-true answer on demand; `push()`'s own
  // highWaterMark-gated boolean return still shares the byte-counted
  // internal comparison and remains genuinely divergent, S047's own
  // remaining half. hex needed NO equivalent fix (`hexEncodeStep`'s own
  // header: one input byte becomes exactly one ASCII output byte, so
  // RS_LENGTH already IS the string-unit count for a hex-mode buffer).
  //
  // hex ITSELF (1744's own second half, `readable.setEncoding('hex')`):
  // a NEW RS_ENCODING tag (2, alongside 0=off/1=utf8) and
  // `hexEncodeStep` — pure, stateless bytes→bytes, no held-back tail at
  // all (measured directly against Node's real `hex` StringDecoder: an
  // ODD byte count, or a byte split across separate `write()` calls,
  // both answer the FULL hex text immediately every time — unlike
  // utf8's variable-width sequences, which genuinely can hold a trailing
  // incomplete char). `setEncodingHexCore` mirrors
  // `setEncodingUtf8Core`'s own "flip on, redecode anything already
  // buffered" shape exactly, minus the decoder-step complexity hex
  // never needs. emitDataFrom/emitBoxChunkAsDyn/pushNullCore's decoder-
  // flush-at-EOF needed ZERO changes for hex — verified by reading each
  // site, not assumed: the first two already branch on "is ANY encoding
  // on" (a plain nonzero check, generalizing for free), and the third's
  // own RS_DEC_PENDING-null gate already skips a no-op for hex (which
  // never populates that field) without an explicit encoding check at
  // all.
  //
  // BONUS RIDERS (2594's own precedent: unpicked claims that fell out of
  // this pass's own targeted work, not independently pursued) — 1690,
  // 1691, 1742, all landing clean once the bugs above were fixed:
  // 1690-stream-duplex.ts is the SOURCE of the both-sides-autoDestroy
  // bug's own discovery (a plain Duplex, `.end()` before `.push(null)`,
  // no Transform involved at all — the full-suite run's own harness
  // doing its job, not a build failure). 1691-stream-transform.ts and
  // 1742-stream-extends-duplex-transform.ts exercise the SAME Transform/
  // Duplex-extends construction and write/final-bridge machinery this
  // pass built for other reasons, MATCHing without any claim-specific
  // work. 1742 in particular is `super({ allowHalfOpen: false })` through
  // a Duplex subclass, read back via `e.allowHalfOpen` — see the
  // GATE C2S-1 paragraph below for why that shape's own history is worth
  // a second look.
  //
  // GATE C2S-1 (found at the pass-2 structural gate, post-freeze):
  // allowHalfOpen's own BEHAVIOR (auto-ending the writable side when the
  // readable side ends under `allowHalfOpen: false`) was stored but
  // silently unwired — a real, silent divergence (rule 1). THREE remedy
  // iterations, each forced by measured evidence: (1) a compile-time
  // refusal for a literal `false`; (2) extended to a runtime trap for a
  // non-literal `false`; both came OUT once the reviewer's gate measured
  // that they UNCLAIM 1742 — its entire exercised surface (construct-
  // with-false, write/end, flag read-back) this tier already handled
  // byte-exactly, because its own execution trace never reaches the
  // readable side's 'end' at all (a no-op `_read`), so the missing
  // wiring never had a chance to diverge for that specific program. (3)
  // the wiring itself, built: opEnd/OP_AUTO_END, Node's real
  // `endReadableNT`/`endWritableNT` ported (NOT a `once('end', ...)`
  // listener — measured directly against v24.18.1's own
  // `internal/streams/readable.js` source AND an ordering probe showing
  // 'end' takes multiple tick-hops to fire, ruling out a same-tick
  // listener; opEnd/OP_AUTO_END's own headers have the full mechanism
  // and measurement story, including the two reentrancy siblings
  // measured before wiring — a Transform's _flush-driven push(null)
  // during writable finish, and an explicit end() called before 'end'
  // fires — both no-op cleanly via the SAME four-flag guard Node's own
  // `endWritableNT` uses, matching byte-for-byte). SEMANTICS.md briefly
  // carried a draft S051 for remedy (2)'s trap; withdrawn once (2) came
  // out — no divergence remained to register FOR THIS FINDING (a
  // permanent gap in the sequence would have misread as a suppressed
  // entry). The number was reused, not permanently retired: S051 is now
  // registered for a genuinely different divergence, the dyn-adapter
  // phase's completion-callback truthiness gap — a live entry again, an
  // unrelated one. No claim movement across all three C2S-1 iterations:
  // 716 throughout, 1742 claimed throughout.
  //
  // Tier 710→716 (six claims, one shared-machinery fix touching every
  // duplex-shaped construction already landed).
  "1690-stream-duplex.ts",
  "1691-stream-transform.ts",
  "1692-stream-pipe.ts",
  "1695-stream-props.ts",
  "1742-stream-extends-duplex-transform.ts",
  "1744-stream-set-encoding.ts",
  //
  // STAGE C, DYN-ADAPTER PHASE (the pass's final unit — landed 08ad661
  // freezes the structural half at 716; this phase's own gate closes
  // stage C). Scope, staked out before the first line of build:
  // 1811 (readable.new:dyn-callback-value — the `{ read: wrap(fn) }`
  // checked-dynamic option-callback shape), 2313
  // (writable.write:dyn-callback-value — the JS-lane underscore-method-
  // assignment sibling of the same boundary), 1812 (readable.initDyn —
  // the scalar options walk first, the callback half rides the SAME
  // adapters 1811 builds), 1747 (transform.transform:non-func-callback —
  // the boxFunc-minted done-callback, parked at pass 2's own gate for
  // exactly this phase), listeners()/rawListeners() (the Draft B
  // S-entry filed at
  // ~/.claude/projects/-home-joe-dev-tsinter/memory/inc22_unfiled_s_drafts.md,
  // adapted to whatever this phase actually builds — resolves board #66's
  // wasm half), and 1677's next-refusal measurement (report the advance,
  // don't force a claim it doesn't earn). EXPLICITLY NOT in scope: 1814
  // (stream.pipelineDyn) — stream/promises is stage D's own unit, not
  // this one. Design basis: `inc22-stageC-pass2-design-notes.md`'s
  // re-verified dyn-call trace and `pending-check-audit-sitelist.md`
  // (both scratchpad, both read-only prep from the pass-2 gate) — the
  // audit's 8 sites plus the third-layer reentrancy flag are this
  // phase's own deliverable, not just planning: every site gets its
  // verdict written in the closing report.
  //
  // AS LANDED: all four predicted claims land — 1811, 2313, 1812, 1747
  // — via one shared adapter family, exactly the "shared machinery,
  // multiple claims" shape 1690's own both-sides fix had. 1677 advances
  // (libCall:emitter.listeners -> libCall:assert.deepResult, exactly as
  // predicted) but does not claim; listeners()/rawListeners() are built
  // and real, Draft B is filed for real as SEMANTICS.md S052. No
  // regressions anywhere; the full consolidated report (scratchpad) has
  // the audit site-list's own per-site verdicts, the pending-check
  // findings, and every bug found along the way in full — this block is
  // the mechanism-story summary TIER_FLOOR itself wants.
  //
  // THE CORE ADAPTER (1811, 2313, 1747's shared half): readThunkFor/
  // writeThunkFor/finalThunkFor/destroyThunkFor's `thisParam.kind ===
  // "dyn"` branches, ALL sharing one corrected design found by
  // execution — the FIRST cut assumed the walked closure-slot value was
  // a raw `$dyn` struct and dispatched via `dyn.callFn()` directly;
  // wrong (a bare wasm trap, empty stderr, before the user's own
  // closure body ever ran). Traced to source: `lowerStreamCallbackValue`
  // wraps the raw dyn value in a `dynCheck` targeting a "thisless"
  // `adapterT = funcOf([DYN,...], VOID)`, and `dynCheck`'s own FUNC arm
  // (`emitDynCheckBody`) MINTS a real closure via `dynFnAdapter` — `t`
  // is func-kind with uniformly-dyn params, `pair = closSigFor(t, loc)`
  // is the identical pair a static override gets. Corrected shape:
  // refCast CLOS to `pair.clos`, `callRef(pair.fn)` — the static
  // branch's own call shape, every position (including 0) a plain
  // dyn-boxed argument, no receiver at all (Node calls option-callbacks
  // with `this` undefined). No inline pending-check needed at any of
  // the four thunks: `callRead()`'s pre-existing `tryCatchAsError`
  // wrapper (D2's own fix) already catches whatever the callRef'd thunk
  // leaves pending, generic regardless of thunk kind — the ONE
  // dispatch-site gap the pending-check audit had flagged as needing
  // NEW coverage turned out to already be covered by pass-1 machinery,
  // verified not assumed.
  //
  // THE DONE-CALLBACK (write/final/destroy/transform/flush's shared
  // completion-callback slot, ALSO uniformly dyn in adapterT):
  // `dynDoneClosFor` mints a REAL dyn FUNC value via `dyn.boxFn`
  // directly (not the typed `doneClosFor` — no `cbType` to match
  // against a uniformly-dyn slot), whose thunk matches `dyn.thunkSig()`.
  // The err-argument dispatch is MEASURED (m-cb-err-matrix.cjs, 9
  // values): Node's own truthiness rule, no coercion — `dyn.truthy()`
  // (pre-existing) decides falsy-vs-truthy, `dyn.isError()` + the new
  // `dyn.toError()` (dyn.ts — the reverse of `fromError()`'s own
  // identity-preserving cache, a genuine reuse of that cache's existing
  // entries rather than new state) decide Error-vs-trap; SEMANTICS.md
  // S051 registers the non-Error-truthy trap for real. A GENUINELY
  // GENERALIZABLE bug, caught here and worth naming for whatever hand-
  // built dyn adapter comes next: `emitSetCellErrorLit` writes to
  // `this.fn.code` (the NORMAL walker's own tracked current function),
  // not to a hand-built function's own Code buffer — using it inside
  // `dynDoneClosFor` (itself hand-built, exactly the class the pass-2
  // design notes' own §2 warned about) silently injected the trap into
  // whatever function the walker happened to be compiling at THAT
  // moment (construction-time compilation of `writable.new`), not into
  // the done-callback thunk at all — no probe ever caught it reachable,
  // because the corrupted code ran somewhere else entirely.
  // `emitSetCellError(c, ...)` — the explicit-buffer variant that
  // already existed for exactly this situation — is the fix; any FUTURE
  // hand-built dyn adapter needing the exception cell must use it too.
  //
  // 1812 (readable.initDyn/writable.initDyn) is a genuinely THIRD
  // dispatch shape, not an extension of the two above — a from-scratch
  // dyn-record walk (`emitInitDynScalars`/`emitInitDynSlot`,
  // `dyn.objGet`) with RUNTIME branching per callback slot between the
  // dyn-adapter above and the class's own declared fallback
  // (`streamMethodWrapper`'s pre-existing wrappers), matching Node's
  // instance-property-over-prototype rule. THREE bugs found building
  // it: (1) the wasm `i32.or`/`i32.and` no-short-circuit trap — a bare
  // `structGet` on a possibly-null dyn value computed as ONE operand of
  // an OR whose OTHER operand was the null-check itself; wasm never
  // short-circuits, so the null case trapped before the OR ever ran.
  // Hit in FOUR places (hwm/encoding/autoDestroy scalar reads, the slot
  // dispatch's own DK.FUNC check); fixed with a shared
  // `emitDynIsAbsentish` helper using a real `ifResult` branch instead
  // of a bitwise OR. (2) A pre-existing gap in readThunkFor's STATIC
  // branch: an untyped `_read(n)` override (MyReader's own shape, no
  // JSDoc at all) lifts `n` to dyn, but the code pushed the raw f64
  // SIZE local into a call_ref built for a dyn param — a wasm COMPILE
  // error, caught immediately, never reachable by any claim before 1812
  // since no prior one declared `_read` with an untyped size param.
  // Fixed with the same boxNum-when-dyn pattern writeThunkFor's own
  // chunk/encoding gap already used. (3) The real one: `emitInitDynSlot`
  // stored the RAW `$dyn` struct straight from `dyn.objGet()` into
  // RS_READ_CLOS/etc — but the adapter thunk's own refCast expects the
  // `pair.clos`-shaped wrapper 1811's construction gets for free via
  // the frontend's `dynCheck`; reading straight from `objGet` skips
  // that conversion. Fixed by calling `dynFnAdapter(adapterT, loc)`
  // directly in both `.initDyn` case bodies and building `refFunc(fn);
  // OPTVAL; structNew(env)` as the stored closure. Also extended
  // writeThunkFor's existing chunk/encoding dyn-boxing (pass 2's own
  // "transform"-only scoping) to "write" too — MyWriter's own untyped
  // `_write(chunk,enc,cb)` needed it, and the restriction was never
  // load-bearing, just scoped to whichever claim needed it at the time.
  //
  // 1747's own mandatory dig (the coordinator's own ruling, after the
  // async-consumer mismatch surfaced mid-phase): the "two concurrent
  // for-await loops" framing from the FIRST investigation was a RED
  // HERRING, fully dissolved by isolation. The true minimal repro
  // (d11-park-then-end.ts, scratchpad) has ZERO concurrency: park a
  // for-await waiter on an EMPTY Transform, then `.end()` it with
  // nothing ever written — Node settles the waiter with EOF, this tier
  // hangs (no trap, exit 0, the tick pump just runs dry). Root cause,
  // found by reading `checkWaiterCore`'s own header against
  // `pushNullCore`'s actual body: `checkWaiterCore`'s three
  // non-creation re-check triggers are named explicitly as "pushCore's
  // tail, opEnd, destroyErrCore" — `pushNullCore` (the EOF-specific
  // push, a DIFFERENT function from `pushCore`) was never one of them.
  // A waiter parked before any real data exists, then answered only by
  // `push(null)` with nothing else to drive a subsequent read()/
  // resume() discovery of EOF — exactly Transform's own internal
  // `_final -> flushDoneCore -> pushNullCore` chain when nothing was
  // ever written, and the ONLY way this pass's own Transform
  // construction can produce the shape — has nothing left to
  // re-examine it. One-line fix: `pushNullCore`'s own tail now calls
  // `checkWaiterCore`, mirroring `pushCore`'s own pre-existing
  // precedent exactly (same idempotent-no-op-when-nothing-parked
  // safety). Diagnosed entirely via source reading, no instrumentation
  // needed — the minimal repro came from bisecting the ORIGINAL
  // concurrent-loops probe down to nothing, not from guessing.
  //
  // listeners()/rawListeners(): lower-emitter.ts ALREADY unifies both
  // into one libCall (`emitter.listeners`) because `entryIdentity()`
  // (pre-existing, `listenerCount`/`removeListener`'s own `orig ??
  // clos`) answers the same thing for either — Draft B's own core claim
  // confirmed directly from source, not assumed. New `listenersOf`
  // (events.ts) walks the general bucket into a fresh per-event-tuple
  // array (`vecInfoFor`'s own VecInfo, parameterized in since the
  // element type varies by event). Two named boundaries, both in
  // SEMANTICS.md S052's own body: the dedicated 'error' bucket refuses
  // by name (a different representation entirely, unexercised by any
  // claim); a declared-prefix listener (narrower arity than the event's
  // canonical tuple) needs an adapter this phase does not build —
  // FIRST cut bare-`refCast`-trapped on it (the #73 class, cannot ship
  // bare), fixed to a `ref.test`-guarded NAMED loud trap instead
  // (S050/S051's own reportUncaught pattern) per the gate's own ruling.
  // Census-invisible either way: 1677 is the only corpus program
  // calling either method, and it is independently blocked by
  // `libCall:assert.deepResult` regardless.
  "1747-stream-for-await-js.cjs",
  "1811-stream-option-value-callbacks.cjs",
  "1812-stream-super-options-forwarding.cjs",
  "2313-stream-underscore-assign-js.cjs",
  //
  // Tier 716→720 (four claims, one shared adapter family plus one
  // genuinely third dispatch shape for 1812, all landing together).
  //
  // STAGE D P1 (increment 22, board #77): finished()/eos() — a per-
  // stream watcher LIST (FIN_HEAD), fired from opClose right after
  // 'close' (the willEmitClose:true default path), plus an already-
  // closed-at-registration fast path (OP_FIN). The frontend threads a
  // static "r"/"w"/"rw" sidedness literal into the libCall args ($rState
  // is one shared struct for every Readable/Writable/Duplex-rooted
  // class, so the backend cannot recover which side(s) a premature-
  // close check should watch from the struct alone) — 1813's own `w`
  // case (a bare Writable) pins this directly. opError's "is this
  // handled" gate also learned FIN_HEAD (a finished()/eos() watcher
  // joins RS_WAITER/RS_CONSUMER_KIND's existing set) — 2564's r2
  // (destroy(new Error), no user 'error' listener, only a pending
  // sp.finished promise) pins that. Full 1069-program run, both
  // instruments: TIER_FLOOR set-equality (this addition) and the full
  // non-claimed bucket diff (zero net-new refusals elsewhere) both
  // close — 720 → 722.
  "1813-stream-finished.ts",
  "2564-stream-promises-finished.ts",
  //
  // STAGE D P2 (increment 22, board #77): pipeline() — a per-stage
  // FIN_KIND_PIPELINE destroyer watcher (role by POSITION: source=R,
  // dest=W, every middle stage=RW, live-measured against real Node
  // rather than assumed from the stream's own Readable/Writable/Duplex-
  // ness), reusing P1's list/detach/fire/OP_FIN machinery verbatim
  // (fireFinListCore's own dispatch learned FIN_KIND_PIPELINE), plus a
  // raw internal 'error' listener per stage (the SAME real-listener path
  // Node's own pipeline() takes — no unhandled-'error' crash) feeding
  // pipelineFinishImpl's own placeholder-vs-real supersession rule
  // (Node's finishImpl, ported; a durable builder-level pin covers the
  // supersession shape no corpus claim exercises — wasm-stream-
  // pipeline.test.ts). 1814's own untyped .cjs callback (`(err) =>
  // {...}`, no annotation) required extending finThunkFor with a dyn-
  // param branch: @types/node's pipeline() overload set does not thread
  // a clean contextual type through an implicitly-typed JS callback
  // parameter the way finished()'s simpler overload does (live-measured;
  // finThunkFor's own comment on the branch has the full story) — boxes
  // the error through dyn.fromError/dyn.undefinedGlobal and calls
  // through the SAME closure-call tail every other branch shares. Full
  // 1069-program run, both instruments: TIER_FLOOR set-equality (this
  // addition) and the full non-claimed bucket diff (zero net-new
  // refusals elsewhere) both close — 722 → 725.
  "1814-stream-pipeline.cjs",
  "2563-stream-promises-pipeline.ts",
  "2565-stream-promises-js.cjs",
  //
  // STAGE D P2b (increment 22, board #26): error.argTypeThrow's
  // "Received ..." tail — dyn.ts's specificType(), determineSpecificType
  // (internal/errors.js) ported verbatim. NULL/UNDEF/ARR/OBJ/PROMISE
  // hardcoded literals, NUM (general plus the four -0/NaN/±Infinity
  // specials, `1 / value === -Infinity` sorting the zeros exactly like
  // Node's own check), BOOL, STR (>28-char truncation THEN the quote
  // check on the possibly-truncated value, embedded-single-quote falling
  // to json.ts's own quoteStr() — a thin jbBegin/jbPutStr/jbFinish
  // wrapper reusing the ALREADY-correct escaper rather than porting the
  // C lane's #82 quote bug), FUNC (fnT's FN_NAME field, null-safe, S020's
  // approximations inherited as-is), BYTES (kindName's own proven
  // Buffer/Uint8Array flag branch, inheriting S014/S037's pre-existing
  // no-surviving-marker gap rather than introducing a new one). HANDLE
  // and JSVAL hit a BARE `unreachable` trap (no name, code, or message —
  // there is nothing to grep; unconstructible on this tier, no Node-exact
  // answer exists to approximate) — wasm-dyn-specifictype.test.ts force-
  // emits both directly, since no real source can reach them, and cause-
  // pins each with a sentinel global written immediately before the
  // specificType() call so the trap is tied to THAT call rather than
  // merely "the run threw something". Same-session frontend fix
  // alongside the renderer: lower-emitter.ts's EventEmitter.
  // setMaxListeners per-target argTypeThrow construction was dropping
  // every FUNC target's name (a bare dynFrom node with no fnName field);
  // threaded jsFuncNameOf through it, mirroring lower-assert.ts's own
  // established pattern — verified against a fresh Node oracle across
  // four function shapes. Board #83 (a nullish null/undefined target at
  // that same call site diverging from Node's real property-read crash,
  // confirmed live on the already-shipping LLVM lane too before this
  // session touched anything — pre-existing, not introduced by board
  // #26) is RESOLVED for THIS lane: lower-emitter.ts now excludes a
  // unitLit target from the argTypeThrow-admitting condition, falling
  // through to the SAME generic noLowering("EventEmitter.setMaxListeners
  // with N arguments", ...) every other unhandled setMaxListeners shape
  // already uses — a RUNTIME exception (SC2020, arity-worded message,
  // catchable) fired when the expression is REACHED, not a compile-time
  // build failure. LLVM/C are UNTOUCHED and still render the wrong
  // ERR_INVALID_ARG_TYPE for this one shape — #83 stays open for the
  // native lanes. 2570 (Buffer.compare's *Chk family) is NOT unblocked by
  // this renderer alone — it refuses at the separate, still-unbuilt
  // `buffer.compareChk` compound libCall. Full 1069-program run, both
  // instruments: TIER_FLOOR set-equality (this addition) and the full
  // non-claimed bucket diff (zero net-new refusals elsewhere) both
  // close — 725 → 726.
  "2634-stream-pipeline-arg-ladders.cjs",
  // Stage D P3 (node:assert board #37 + board #75 listeners()/
  // rawListeners() narrower-arity adapters): assert.deepResult/
  // refEqBytes/bytesDeepEq (emitAssertLibCall, emitter.ts) unblock
  // 1680's Buffer/Uint8Array strict+deep equality family, byte-exact
  // against the Node oracle including every generated-header branch and
  // the custom-message override. 1677's own remaining blocker (the
  // narrower-arity listener snapshot trap) is resolved by board #75's
  // adapter cascade (events.ts's listenersOf, emitter.ts's
  // listenerAdapterBase/listenerAdapterFn/universalUnwrapFn) with
  // identity transparency: EVERY func-typed reference-identity site in
  // this backend (bin "===", removeLast/countFnOf's both sides) unwraps
  // an adapter back to its captured original through ONE universal
  // cascading function (not a per-type one — the gate's own second-round
  // ruling, closing the re-register-then-remove combo on both sides),
  // verified against 1677's own line 25 identity comparisons AND the
  // dedicated wasm-listener-adapters.test.ts pin suite (mutation-checked
  // at both the cascade and stored-side granularity). Full 1069-program
  // run, both instruments: TIER_FLOOR set-equality (this addition) and
  // the full non-claimed bucket diff (predicted movers: 1604/2487 move
  // from libCall:assert.deepResult to a new named refusal, nothing else
  // moves) both close — 726 → 728.
  "1677-emitter-listeners.ts",
  "1680-assert-bytes.ts",
  // Stage D P3's own 1681 stretch (timeboxed, per the lead's own GO
  // under Joe's scoped upside-with-verification allowance):
  // assert.refEqFn (bare-function strictEqual/notStrictEqual) — SIMPLER
  // than refEqBytes, no "same structure" branch is possible (deep-
  // equality over functions IS reference identity, so a strictEqual
  // FAILURE can never also be deep-equal — measured directly, not
  // inherited from the earlier design-note prediction). 1681's own
  // deepStrictEqual/notDeepStrictEqual calls over bare functions and
  // function arrays were ALREADY covered by board #75's generic
  // deepResult/deepEqHelper path (identical machinery 1677 needed) —
  // refEqFn was the only genuinely new case. Byte-exact against the
  // Node oracle; force-pinned custom-message branches 1681 itself never
  // exercises (Node-measured first, wasm-assert.test.ts). Both
  // instruments close — 728 → 729.
  "1681-assert-funcs.ts",
  // Task #94 (board #94): six re-derived corpus programs, one gated unit —
  // the corpus-scan census's own candidates, re-measured at 43f71a7 (post
  // board #89) rather than transcribed from the 0f991c2 sketches. All six
  // claim on wasm with zero movement among the pre-existing 729; both
  // instruments (this set-equality addition and the full non-claimed
  // bucket diff) close — 729 → 735. The arity-widen-identity program
  // (formerly labeled g1 during the corpus-scan re-derivation) widened in
  // place (not merely ported) once board #89 made its refcounted-trailing-
  // drop axis byte-exact — see that file's own header for the provenance
  // chain. Numbered 2687-2692 (94-D1's fix round: the corpus is
  // numerically keyed, and ts7/order-parity.test.ts's baseline is
  // path-keyed — the g-prefixed names never should have shipped).
  "2687-arity-widen-identity.ts",
  "2688-forawait-early-exit.ts",
  "2689-pipeline-stage-shapes.ts",
  "2690-finished-watcher-list.ts",
  "2691-received-tail-specific-types.cjs",
  "2692-finished-duplex-sides.ts",
  // Increment 23, pass P1 (node:assert static core — the Group A build:
  // ok/eqF64/eqStr/eqBool/sameValue/deqEnter+Leave/throwsNone/
  // throwsMismatch/unwantedRejection/shapeBegin+Str+End/ifErrorErr+F64+
  // Str+Bool/ifErrorDyn's scalar+%error arms). Ten programs claim, all
  // verified byte-exact against the live Node oracle (own scratch host,
  // not merely "compiles") before this addition landed; both instruments
  // (TIER_FLOOR set-equality here, plus the full non-claimed bucket diff
  // against census-753640d.log) close — 735 -> 745, exactly the
  // predicted movers and nothing else (see FINDINGS.txt for the table).
  // eqFail/neqFail (scr_assert_eq_fail/neq_fail) and the deqEnter/
  // deqLeave pair memo are new standalone wasm helpers; shapeEnd's
  // Comparison-diff LCS walk is a faithful DP-table port (a simpler
  // per-key-order shortcut was tried first and DISPROVED by direct Node
  // measurement before this landed — the walk genuinely reorders +/-
  // lines). KNOWN, MEASURED, REPORTED gap (not a new S-entry — see
  // FINDINGS.txt and wasm-assert-core.test.ts's own header comment on
  // the pin that documents it): the pair memo answers "equal" for
  // same-label cyclic structures of MISMATCHED period, where Node's real
  // position-tracking memo throws; no claimed program here or elsewhere
  // constructs such a shape. ifErrorDyn's FUNC-kind dyn value is grouped
  // with the named-trap composite arm (P2's job) — the brief's own arm
  // enumeration did not name it either way; a judgment call, flagged for
  // the gate.
  "1601-assert-fail-exit.ts",
  "1602-assert-caught-error.ts",
  "1603-assert-scalar-messages.ts",
  "1604-assert-deep-structures.ts",
  "1605-assert-import-forms.ts",
  "1609-assert-async.ts",
  "1724-assert-iferror.ts",
  "1727-assert-throws-shape-exit.ts",
  "2285-iferror-dyn.cjs",
  "2487-recursive-deep-equal.ts",
  // Increment 23, F1 fix round item 5: the deqEnter/deqLeave cross-lane
  // fix (Node's real set-of-values cycle memo, not a pair memo — a
  // same-labeled cyclic structure of mismatched period now correctly
  // throws instead of wrongly comparing equal; FINDINGS.txt §3 has the
  // full record). 745 -> 746, exactly this one new claim, nothing else
  // moves (both instruments verified before this addition — see the
  // freeze/checkpoint message for the closing sums).
  "2693-deep-equal-cycle-period.ts",
  // Increment 23, F2 fix round: the depth-2/depth-3 two-rule memo fix
  // (gate finding F-1 — F1's own set-of-values-from-depth-1 rule wrongly
  // answered UNEQUAL on a crossed depth-2 pair that Node's real a/b
  // two-slot fast path walks; SEMANTICS.md S056 has the full measured
  // record, including the registered depth-3 divergence from a truly
  // fresh Node process that this file's own trigger-then-measure shape
  // avoids exercising against the oracle). 746 -> 747, exactly this one
  // new claim.
  "2694-deep-equal-cycle-crossed.ts",
  // Increment 23 P2b: `assert.eqDyn`'s libCall wired for real (D.1-D.5's
  // decision tree — showSimpleDiff/notIdentical/the myers branch —
  // reusing P1's eqFail/neqFail per D.5; D.9's boxing shim retiring
  // eqStr's own multi-line sentinel trap). Six programs claim, all
  // verified byte-exact against the live Node oracle before this
  // addition landed (a real bug caught by this SAME differential run,
  // not by review: dynNeqFailHelper's multi-line branch was still
  // assembling a diff under a custom message for the notStrictEqual/
  // notDeepStrictEqual family, where real Node's own AssertionError
  // constructor bypasses the WHOLE assembler via `super(String(message))`
  // whenever `message != null` — fixed as a top-of-function early
  // return, re-verified). 747 -> 753, exactly the predicted movers.
  "1770-assert-dyn-strict.ts",
  "1771-assert-dyn-deep.ts",
  "1772-assert-dyn-js.cjs",
  "1773-assert-dyn-exit.ts",
  "2161-js-object-literal-identity.cjs",
  "2165-js-throw-dyn.cjs",
  // Increment 23 P3 — the three riders (predicted then confirmed, per
  // the freeze's own predictions.txt): expr:fieldIncDec:dyn (a checked-
  // dynamic class field's `++`/`--`, dynCheck-out/±1/box-back, SEMANTICS.
  // md S009's third amendment); url.fileURLToPathStr (the file-scheme
  // subset of scr_url.c's parser, its own new file url.ts, SEMANTICS.md
  // S060's two scope traps — dot-segments, non-ASCII bytes); timers.
  // queueMicrotask + Dyn (a `mtFrame <: frameBase` subtype answering the
  // "a plain closure widens the waiter queue" objection, ZERO type
  // widening, the SAME `%w.async.hop` enqueue the bare `await` turn
  // already uses). 753 -> 756, exactly the predicted movers; the three
  // bucket-advance predictions (1730 -> libCall:sym.new, 1356 ->
  // libCall:url.href, 1611 -> libCall:process.cwd) confirmed exactly.
  "1710-cjs-export-class/main.js",
  "2385-builtin-reexport-facade/main.ts",
  "2282-queue-microtask.cjs",
  // Increment 24 P2 — the predicate surface: expr:regexLit, type:regex,
  // and the three regexIntrinsic predicates (test/source/flags) wired
  // end to end (RegexBuilder + RegexInterpreterBuilder, dormant since
  // P1, into the actual emitter). 1200 is the acceptance test (\p{L}
  // under /u, astral matching, canonical .flags ordering, regexes as
  // ordinary values); 1628 exercises a checked-dynamic STRING argument
  // to a static regex's .test(); 2472/2476 are the type:regex surface
  // (Map<string, RegExp> values, a string|RegExp union narrowed by
  // instanceof) — the generic type:regex/expr:regexLit/expr:
  // regexIntrinsic buckets all dissolve with this addition; the seven
  // unopened regexIntrinsic methods now refuse by their own per-method
  // name instead. 756 -> 760, exactly the predicted movers.
  "1200-regex-test-basics.ts",
  "1628-checked-dynamic-builtin-args.cjs",
  "2472-string-regexp-union.ts",
  "2476-map-regex-values.ts",
  // Increment 24 P3 — the string-producing surface, the increment's own
  // hard pass: regexIntrinsic{replace, replaceAll, split, search} and
  // GetSubstitution (transcribed from quickjs.c's own js_string___Get
  // Substitution + js_regexp_Symbol_replace/_split), plus split()'s
  // Node-exact capture splice (S066, board #118). 1202 is GetSubstitution's
  // own acceptance test (every $-rule); 2609 is the named-group workout
  // ($<name> templates and \k<name> backreferences both ways, including
  // the case-insensitive backreference); 1204 exercises the empty-match
  // advance under astral subjects, with and without /u. The four opened
  // per-method buckets (:replace, :replaceAll, :split, :search) all
  // dissolve; 1206 and 1306 advance to their own non-regex blockers
  // (libCall:island.eval, libCall:fs.readFileSync). 760 -> 772, exactly
  // the predicted movers.
  "1201-regex-replace.ts",
  "1202-regex-substitutions.ts",
  "1203-regex-split.ts",
  "1204-regex-empty-unicode.ts",
  "1205-regex-rc-stress.ts",
  "1483-array-slice.ts",
  "1546-union-element-reads.ts",
  "1551-dyn-receiver-methods.ts",
  "1558-any-joins-and-dyn-validation.ts",
  "1641-string-search.ts",
  "1643-metadata-dyn-return.cjs",
  "2609-regex-named-replace.ts",
  // Increment 24 P4 — the match surface: regexIntrinsic{match, matchAll,
  // matchAllInto}, the program-dependent `string[] | null` union result
  // (validate.ts's own REGEX_INTRINSIC_SIGS comment — "the regexIntrinsic
  // case checks the union's arms"), the honest-slice rule applied to
  // match's own array arm (S064), and the for-of-over-matchAll companion-
  // index desugar (lower-stmts.ts's own lowerForOfMatchAll). Ruled:
  // match serves the NON-GLOBAL exec-shaped form only (design §3, R1,
  // retracting the v2 draft's F9) — a literal g/y receiver is fenced at
  // compile time (SC1120/SC1121) before it ever reaches here; the
  // value-path g/y gap stays open, unreachable by any claim in this set
  // (findings-p4-v1.txt entries 1-2, a named P5-forward deliverable, not
  // a new key). 1544 prints the matchAll-on-non-global TypeError
  // (String.prototype.matchAll called with a non-global RegExp argument,
  // measured live against Node); 1562/1574 are the optional-chaining
  // third observable (undefined?.match(re) is undefined, riding the
  // pre-existing general chain machinery, not anything match-specific).
  // The three opened per-method buckets (:match, :matchAll,
  // :matchAllInto) all dissolve; 1579/2611 stay on their own non-regex
  // blockers per Joe's B ruling (libCall:math.max, libCall:math.random);
  // 2608 advances to libCall:regex.new (P5's own construction surface,
  // its pattern clean and static, no P2 refinement key applies).
  // 772 -> 777, exactly the predicted movers.
  "1467-string-match.ts",
  "1544-string-matchall.ts",
  "1562-optional-chain-tails.ts",
  "1574-dyn-optional-method-number-keys.ts",
  "2610-regex-named-matchall.ts",
  // Increment 24 P5 — regex.new construction: THE CONSTANT-FOLDER (strLit,
  // strConcat, a varRef to a PROVABLY-const global gated on BOTH
  // mutable===false AND design-regex-v6-errata-1.txt item 3's own
  // ordering condition — the assign and the fold site both inside the
  // same module-init function, assign preceding site — closing a TDZ
  // hole mutable===false alone cannot), regexp.escape over an already-
  // folded argument), non-interned construction (design §7.5's own named
  // non-requirement — new RegExp("a") !== new RegExp("a")), the §5.5(B)
  // constant-folded catchable SyntaxError (invalid flags; the three
  // structurally-decidable pattern reasons), EscapeRegExpPattern (§5.6,
  // .source normalisation for new RegExp(str) specifically), canonical
  // .flags order, the general runtime regexp.escape libCall (%w.re.escape,
  // a genuinely dynamic string — 2367's own `dyn` case), and insp.regex
  // (`/source/flags`, scr_inspect.c:618-625).
  //
  // 2284-regexp-constructor.cjs advances HERE, not in the first P5 round:
  // fixing a real misclassification bug (classifyRegexLitRefusal's four-
  // way disposition — modifiers/unported-unicode-property/unicode-
  // casefold/annexb — only had the first two special-cased pre-fix)
  // surfaced that 2284's own pattern (`\-` outside a character class)
  // depends on Annex-B legacy grammar leniency (the SourceCharacter-
  // IdentityEscape production, ECMA-262 B.1.2, "family 6" in des-24's own
  // nine-family enumeration — findings/annexb-enumeration.txt, sha256
  // 17a97f4c...). Joe's own scope ruling (relayed by team-lead) pulled
  // Annex-B's family-6-outside-a-class slice INTO P5 rather than leaving
  // 2284 refused: the shared classifyRegexLitRefusal gate (BOTH surfaces —
  // regexLit AND regex.new; no asymmetry) now IMPLEMENTS family 6 outside
  // a class (family 6 inside a class was already IMPLEMENT, errata item
  // 1's own sibling fix) via an ELIMINATION classifier (classifyAnnexBFamily,
  // regex-disposition.ts) — eight positive detectors rule OUT families
  // 1,2,3,4,5,7,8,9 (each REFUSES by its own name now, splitting the old
  // blanket "annexb" key so the census shows which legacy construct a
  // program actually needs); a pattern that's Annex-B-only but matches
  // none of the eight is family 6 by elimination, sound because
  // usesAnnexBOnly's own precondition guarantees a real, correctly-parsed
  // AST already exists (the ported parser — real QuickJS libregexp.c
  // machinery — implements the FULL Annex-B grammar already; opening this
  // slice is a POLICY narrowing, not new parser code) and des-24
  // separately proved the nine-family enumeration EXHAUSTIVE (a
  // 2352-position × form sweep against live Node, zero unassigned
  // results). Census re-measured after landing: EXACTLY 2284 moves (des's
  // own independent measurement — all 235 corpus regex literals plus all
  // six of 2284's own constructor sites swept — and this harness's own
  // differential run agree: missingFromClaimed stays empty, missingFromFloor
  // is exactly this one name, confirmed by two instruments).
  // The §4 discrimination requirement (the F5 value-path-flag guard fires
  // for a regex.new-constructed value exactly as it does for a literal)
  // is additionally proven by two standalone unit pins (wasm-emitter.
  // test.ts's own "§4 must-not-trap" / "§4 covered-by-construction" —
  // neither depends on the Annex-B slice at all).
  // 777 -> 781, all four originally-scoped claims.
  "1634-inspect-classes.ts",
  "2284-regexp-constructor.cjs",
  "2367-regexp-escape.ts",
  "2608-regex-named-groups.ts",
  // Increment 24 P6 — the assert surface, THE INCREMENT'S LAST PASS:
  // assert.match/doesNotMatch (ONE libCall, both spellings — a
  // compile-time boolLit negate arg selects the lead-in text),
  // assert.throwsRegex (assert.throws/rejects's regex-expectation
  // mismatch — Node tests `regex.test(String(error))`; String(error) is
  // built inline from the caught %Error's name/message fields, NOT
  // errToStrHelper's own format, which appends a "[CODE]" bracket that
  // Error.prototype.toString() never does), assert.shapeRe (a shape
  // key's expected value can be a regex, on ANY of code/message/name —
  // measured directly, not message-only as first assumed; shapeEndHelper's
  // own EQ-computation and expected-side diff rendering now branch per
  // slot on a runtime isRegexN flag, since one generic function serves
  // every shapeBegin/shapeStr/shapeRe/shapeEnd call site), and
  // assert.regexErrTest (doesNotReject's own regex-form predicate — pure
  // boolean, no throw, shares String(error) and the regex-exec pattern
  // with throwsRegex verbatim).
  //
  // BOTH of the brief's originally-scoped "corrected error arms" for
  // assert.match (a non-string input; a non-regex pattern) turned out
  // STRUCTURALLY UNREACHABLE through this backend — measured directly
  // (four distinct source shapes): lower-assert.ts's own pre-existing
  // lowerAssertMatch refuses both at the frontend, by name (SC1090/
  // SC2020), before any libCall reaches this switch — a scope reduction,
  // not a gap.
  //
  // F5-CONSISTENT VALUE-PATH TRAP, extended to all three new reaching
  // methods (SEMANTICS.md S003's own amendment, extended not
  // re-registered — a NEW reaching path into an ALREADY-registered
  // divergence class): assert.match/doesNotMatch, assert.throwsRegex,
  // and assert.shapeRe each MEASURED stateful for a value-bound
  // GLOBAL/STICKY regex (assert.regexErrTest's own guard is identical in
  // shape — measured via the same per-intrinsic discipline, condition
  // #2 of P6's own GO). Literal receivers are excluded exactly as
  // replace()'s own non-global guard excludes them.
  //
  // 781 -> 788, all seven originally-scoped claims.
  "1600-assert-passing.ts",
  "1606-assert-strict-module.ts",
  "1607-assert-throws-match.ts",
  "1608-cjs-assert/main.js",
  "1721-assert-throws-regex-class.ts",
  "1722-assert-rejects.ts",
  "1723-assert-does-not-reject.ts",
  // Increment 25, rider R0 (the ambient `declare` read): a read of an
  // ambient `declare`d binding NOTHING defines — Node erases the
  // declaration entirely, so the access throws Node's own catchable
  // ReferenceError "<name> is not defined" — the TDZ site's shape
  // (emitter.ts:9121) at a different message, reached through four
  // pre-existing frontend sites that already lowered to
  // `libCall:global.undefRead` (ir/nodes.ts:3199-3204's typed dummy).
  // The largest single first-refusal bucket in the tier: one intrinsic,
  // pure language, no ABI, no register entry, no IR signature widened.
  // All eight axes of design-number-v4.txt §6.5 pinned in
  // wasm-undefread.test.ts (six original plus the two rev-25 found: a
  // default-parameter initializer, and a class-field initializer).
  // 788 -> 803.
  "1581-declare-const-read.ts",
  "1832-enum-modules/main.ts",
  "1850-overload-basics.ts",
  "1854-ambient-declare-fn.ts",
  "1855-ambient-declare-fn-uncaught.ts",
  "1965-namespace-ambient.ts",
  "1967-namespace-alias-typeonly.ts",
  "2194-ambient-undef-chains.ts",
  "2353-decorators-member-ambient.ts",
  "2354-decorators-expression-ambient.ts",
  "2591-ambient-generic-traps.ts",
  "2592-ambient-trap-uncaught.ts",
  "2614-trap-binding-later-writes.ts",
  "2635-trap-binding-unmappable-written.ts",
  "2636-trap-binding-ambient-rooted-rewrite.ts",
];

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** First TWO lines — a program can combine directives, one per line
 * (differential.test.ts's directiveHead). */
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 2);
}

function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

function wantsDynamic(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @dynamic\s*$/.test(l));
}

function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...ENTRY_EXTS.flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

/* ── the Node oracle (llvm-differential.test.ts's twin) ────────────────── */

const comptimeShim = pathToFileURL(join(import.meta.dirname, "comptime-shim.mjs")).href;
const islandShim = pathToFileURL(join(import.meta.dirname, "island-shim.mjs")).href;

/** The oracle runs with --experimental-transform-types for corpus programs
 * using non-erasable syntax — the `// @transform-types` directive
 * (namespaces) OR any enum declaration (strip-only mode refuses to parse
 * enums, no directive needed; a pure function of the program bytes). */
function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

/** `// @tsc-decorators`: decorators are the one supported construct Node
 * cannot execute at all, so the oracle runs tsc's deterministic ES2022
 * downlevel materialized under the test cache. */
function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

function nodeOracleFile(file: string): string {
  if (!wantsTscDecorators(file)) return file;
  const src = readFileSync(file, "utf8");
  const out = ts5.transpileModule(src, {
    compilerOptions: { target: ts5.ScriptTarget.ES2022, module: ts5.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const key = createHash("sha256").update(ts5.version).update("\0").update(src).digest("hex").slice(0, 16);
  const path = join(cacheDir, `dec-oracle-${key}.mjs`);
  mkdirSync(cacheDir, { recursive: true });
  // Atomic publish: concurrent suites write this same content-keyed path;
  // rename keeps readers from ever seeing a truncated oracle.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return path;
}

function wantsNoDeprecation(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l));
}

function nodeOracleArgs(file: string): string[] {
  const transform = wantsTransformTypes(file)
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
    : [];
  const nodep = wantsNoDeprecation(file) ? ["--no-deprecation"] : [];
  return [...transform, ...nodep, "--import", comptimeShim, "--import", islandShim, nodeOracleFile(file)];
}

/** Runs the oracle, tolerating an expected nonzero exit. The child's stdin
 * closes immediately: corpus programs may read fd 0 to EOF, and the
 * default open pipe would block both sides forever. */
async function runNode(file: string): Promise<RunResult> {
  const pending = execFileAsync("node", nodeOracleArgs(file), { encoding: "buffer" });
  pending.child.stdin?.end();
  try {
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) {
      throw err;
    }
    return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
  }
}

/* ── the wasm host ─────────────────────────────────────────────────────── */

/** The abi.ts contract's Node side: instantiate the module, service
 * `tsinter.write` by copying [ptr, ptr+len) out of the exported memory
 * into per-fd buffers, run `_start` and then PUMP `_tick` to quiescence.
 * In-process — a .wasm needs no spawn, and the per-fd capture matches
 * what the comparison reads (cross-fd interleaving is not observable
 * through separate buffers on the Node side either).
 *
 * THE CLOCK IS VIRTUAL and never sleeps: `tsinter.now` answers whatever
 * deadline the pump last jumped to, so a program with a 5-second timer
 * runs in microseconds. That is sound because every claimable timer
 * program is ORDER-only by construction — the corpus forbids wall-clock
 * assertions, since the native lane could not make them either.
 *
 * One consequence to know about: the synchronous body takes ZERO virtual
 * time, so a `setTimeout(f, 1)` armed there is never due before the first
 * check phase, while under Node's real clock module startup has usually
 * already burned that millisecond. Node calls that particular ordering
 * non-deterministic ("bound by the performance of the process"), so no
 * corpus program may pin it — 1804 arms its immediates and timers inside
 * one root timer for exactly this reason. */
async function runWasm(modulePath: string): Promise<RunResult> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (fd !== 1 && fd !== 2) throw new Error(`write to unknown fd ${fd}`);
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
      // Timer modules only; wasm ignores an import it never declared.
      now: (): number => clock,
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  try {
    (instance.exports["_start"] as () => void)();
    // The event loop the module cannot run itself (abi.ts): a negative
    // deadline is quiescence, `clock` again is ready work (immediates),
    // anything else is a time to jump to. Inside the try because a trap
    // mid-pump is the same exit-1 story a trap in _start is.
    const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
    if (tick !== undefined) {
      for (let turns = 0; ; turns++) {
        // A pump that never settles would hang the whole suite instead of
        // failing one program. The bound is generous: an immediate chain
        // legitimately returns `clock` once per queued callback.
        if (turns > 1_000_000) throw new Error(`_tick pump did not settle for ${modulePath}`);
        const due = tick(clock);
        if (due < 0) break;
        clock = Math.max(clock, due);
      }
    }
    // The one non-trap nonzero exit (abi.ts): a top-level-await program
    // whose module evaluation promise never settled answers 13 here, which
    // is Node's own status for it. Only meaningful at quiescence, which is
    // exactly where this reads it.
    const status = instance.exports["_status"] as (() => number) | undefined;
    if (status !== undefined) {
      return {
        stdout: Buffer.concat(chunks[1]),
        stderr: Buffer.concat(chunks[2]),
        exitCode: status(),
      };
    }
  } catch (err) {
    // A wasm TRAP is the tier's stand-in for an uncaught runtime error
    // (S003's index traps, until the exception protocol lands): Node
    // exits 1 on an uncaught exception, so a trap reports exit 1 with
    // whatever output preceded it. Comparison stays honest — the harness
    // skips the stderr compare for nonzero-exit programs, and any
    // OTHER error here (a bug in the host, a missing export) is not a
    // trap and still fails the test loudly.
    if (!(err instanceof WebAssembly.RuntimeError)) throw err;
    return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]), exitCode: 1 };
  }
  return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]), exitCode: 0 };
}

async function build(file: string) {
  const hash = createHash("sha256");
  for (const f of programInputs(file)) hash.update(f).update(readFileSync(f));
  const key = hash.update("wasm").update(wantsDynamic(file) ? "dyn" : "").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  return compile(file, {
    outPath: join(outDir, "program.wasm"),
    outDir,
    dynamic: wantsDynamic(file),
    backend: "wasm",
  });
}

// The two ledgers, summarized after the run: what the tier claims, the
// FIRST refusal per program (the loudness contract's census), and the
// SURVEY union (the actual work queue — see the header).
const claimed: string[] = [];
const refusalKinds = new Map<string, number>();
const refusalPrograms = new Map<string, string[]>();
const surveyKinds = new Map<string, number>();

describe(`wasm differential corpus (${files.length} programs${shardSuffix()})`, () => {
  test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
    "%s",
    async ([rel, file]) => {
      const res = await build(file);
      if (!res.ok) {
        // Out of tier: the refusal must be LOUD and must be THE refusal —
        // exactly one SC3001 naming the first unhandled construct. Any
        // other diagnostic here means a corpus program stopped compiling
        // at all, which the main differential suite forbids.
        expect(res.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
        const kind = /\(([^)]+)\)/.exec(res.diagnostics[0]!.message)?.[1] ?? "?";
        refusalKinds.set(kind, (refusalKinds.get(kind) ?? 0) + 1);
        refusalPrograms.set(kind, [...(refusalPrograms.get(kind) ?? []), rel]);
        // The survey rides every refusal — a program's whole construct
        // set, which is what makes the queue below a queue.
        expect(res.wasmSurvey).toBeDefined();
        for (const k of res.wasmSurvey!) surveyKinds.set(k, (surveyKinds.get(k) ?? 0) + 1);
        // The first refusal is always IN the survey: the two walks share
        // one dispatch, so a kind the emit path can produce and the
        // survey path cannot would mean they have drifted apart.
        expect(res.wasmSurvey).toContain(kind);
        return;
      }
      claimed.push(rel);
      expect(res.backend).toBe("wasm");
      // The module IS the artifact: no program TU beside it, no link.
      expect(res.binaryPath.endsWith(".wasm")).toBe(true);
      expect(res.cPath).toBe(res.binaryPath);

      // The claimed half of the contract: the module's output against the
      // Node oracle, byte for byte.
      const [wasm, node] = await Promise.all([runWasm(res.binaryPath), runNode(file)]);
      if (!wasm.stdout.equals(node.stdout)) {
        expect(wasm.stdout.toString("utf8")).toBe(node.stdout.toString("utf8"));
        expect.unreachable("wasm-vs-node stdout differed at byte level but not after utf8 decode");
      }
      // stderr: the exit-0 contract of the main differential suite (a
      // nonzero-exit oracle's stderr carries Node stack traces no other
      // backend reproduces — but nothing that exits nonzero is claimable
      // yet anyway: throw and process.exit both still refuse).
      const expectedExit = expectedExitCode(file);
      if (expectedExit === 0 && !wasm.stderr.equals(node.stderr)) {
        expect(wasm.stderr.toString("utf8")).toBe(node.stderr.toString("utf8"));
        expect.unreachable("wasm-vs-node stderr differed at byte level but not after utf8 decode");
      }
      expect(wasm.exitCode).toBe(expectedExit);
      expect(node.exitCode).toBe(expectedExit);
    },
  );

  test("tier floor: EXACTLY the claimed set, both directions", () => {
    // TIER_FLOOR is not a curated highlight subset — it is a complete
    // mirror of the claimed set, one entry per claimed program (538 in,
    // 538 pinned, checked below). A SUBSET check (every floor name is
    // claimed) only catches a REGRESSION — a program falling out of the
    // tier — and was blind to the opposite drift: a compiler change that
    // newly claims a program nobody added to TIER_FLOOR passes a subset
    // check identically at 537 pinned names or at 1, because it never
    // looks at what claimed contains that the floor doesn't. That gap
    // shipped three consecutive rounds with an unpinned claim sitting in
    // the tier unnoticed. This is the real check: exact set equality,
    // with a set-difference printout on mismatch naming every program on
    // the wrong side, not just the count.
    //
    // Under a shard, only THIS slice's programs can be compared (same key
    // as the corpus split above); the shard union covers the whole list.
    const floorHere = new Set(shardSelect(TIER_FLOOR, (n) => n));
    const claimedHere = new Set(claimed);
    const missingFromClaimed = [...floorHere].filter((n) => !claimedHere.has(n)).sort();
    const missingFromFloor = [...claimedHere].filter((n) => !floorHere.has(n)).sort();
    expect(
      { missingFromClaimed, missingFromFloor },
      missingFromClaimed.length || missingFromFloor.length
        ? `TIER_FLOOR and the claimed set disagree — pinned-but-not-claimed (regressions): ${JSON.stringify(missingFromClaimed)}; claimed-but-not-pinned (unpinned new claims): ${JSON.stringify(missingFromFloor)}`
        : undefined,
    ).toEqual({ missingFromClaimed: [], missingFromFloor: [] });
  });

  afterAll(() => {
    const top = (m: Map<string, number>, n: number) =>
      [...m]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, n)
        .map(([k, c]) => `${k}×${c}`)
        .join(", ");
    /* eslint-disable no-console */
    console.info(
      `wasm tier: ${claimed.length}/${files.length} corpus programs claimed; ` +
        `first refusals: ${top(refusalKinds, 10)}`,
    );
    console.info(
      `wasm work queue (${surveyKinds.size} distinct constructs, by programs needing them): ${top(surveyKinds, 20)}`,
    );
    if (process.env["SCRIPTC_WASM_REFUSALS"] === "1") {
      console.info(`  claimed: ${[...claimed].sort().join(" ")}`);
      for (const [kind] of [...refusalKinds].sort((a, b) => b[1] - a[1])) {
        console.info(`  ${kind}: ${refusalPrograms.get(kind)!.join(" ")}`);
      }
    }
    /* eslint-enable no-console */
  });
});
