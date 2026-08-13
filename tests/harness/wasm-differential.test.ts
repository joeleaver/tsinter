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
