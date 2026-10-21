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
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Socket, type Server, createServer as netCreateServer } from "node:net";
import * as netModuleNs from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { hasSubscribers as dcHasSubscribers, subscribe as dcSubscribe, unsubscribe as dcUnsubscribe } from "node:diagnostics_channel";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { constants as osConstants, homedir, networkInterfaces, release, tmpdir, totalmem, type as osType, userInfo } from "node:os";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@tsinter/compiler";
import { shardSelect, shardSuffix } from "./shard.js";
import { makeHostFacts, type HostFactSnapshot } from "./host-facts.js";

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

// INC-26 P3 (design §3C, B-5): incremented by the `chdir`/`umask` RECORDING
// STUBS below — the positive proof that the zero-corpus-reach claim for
// both keys holds (asserted in "the process tail: chdir/umask are never
// reached" near the end of this file).
let chdirCallCount = 0;
let umaskCallCount = 0;

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
  "2701-spread-override-completion.ts",
  "2703-union-shared-field-read.ts",
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
  "2706-union-param-defaults.ts",
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
  "2696-string-trim-pad-static.ts",
  "1533-bool-equality.ts",
  "1556-union-retag-width-arms.ts",
  "1561-forof-strings.ts",
  "2718-string-raw-fold.ts",
  "2719-string-raw.ts",
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
  "2711-void-statement.ts",
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
  "2723-tdz-scalar-forward-capture.ts",
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
  "2716-promise-then.ts",

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
  "2740-promise-void-union-callbacks.ts",
  // The same await where the result carries a VALUE, which is the settled
  // read and its re-tag.
  "2741-promise-union-await-values.ts",
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
  // and 701-classes-composition were NOT here — the class surface stopped
  // blocking them, but they then named `bin:**` and `bin:ref-eq`, their own
  // work (700 is claimed with `**`, INC-27 U6, below).
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
  "2742-unions-retag.ts",
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
  "2726-mixin-heritage.ts",
  "2728-mixin-modules/main.ts",
  "2729-mixin-rc-stress.ts",
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
  "2727-mixin-values.ts",
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
  "2734-width-field-lifts.ts",
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
  "2710-unknown-truthiness.ts",
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
  "2730-parameter-properties.ts",
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
  "2739-unknown-array.ts",
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
  "2713-record-literal-into-union.ts",
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
  "2733-width-hybrid-shapes.ts",
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
  "2700-unknown-typeof-validation.ts",
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
  // computes these at compile time (since INC-27 U6 with the tier's own
  // pow, pow.ts, never the compiling host's), so both compile and are
  // byte-exact.
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
  "2732-optional-class-fields.ts",
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
  "2738-union-dyn-collapse.ts",
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
  "2736-jsval-routed-keyed-ops.js",
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
  // program). `pow` computed only y===2 and the ECMA-262 special-value
  // table then; since INC-27 U6 it is exact for every operand pair
  // (SEMANTICS.md S079; the op's own header comment, jsPowHelper).
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
  "2737-jsval-routed-calls.js",
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
  "2715-string-matchall.ts",
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
  // Increment 25, pass P1 (the scalar unit: math.abs/ceil/floor/trunc/
  // round/max/min/maxArr/minArr/random, num.isNaN, number.isFinite/isNaN/
  // isInteger/isSafeInteger): the instructions ARE the operations for the
  // first ten (f64.abs/ceil/floor/trunc direct; f64.min/f64.max propagate
  // NaN and order ±0 the JS way, measured — the opposite of C's fmin/
  // fmax; maxArr/minArr fold seeded with ∓Infinity so the empty array
  // falls out of the seed; Math.round ports scr_math_round, scr_lib.c:
  // 2505); Math.random transcribes V8's xorshift128+ (SEMANTICS.md S068)
  // behind a new `seed` ABI import, minted by the same reachable-function
  // prescan `now` uses, present only in modules that reach Math.random.
  // 803 -> 820, NOT 821: the survey's nesting hole (board #124) hid that
  // 1523-isnan-floor-static.ts ALSO needs num.parseInt (a P3 key) inside
  // one of its five isNaN(...) calls — 18 keys close but 17 claim; 1523
  // stays out of the tier until the parsers pass lands. Design-number-v6.
  // txt §2.1-§2.3/§2.6/§7.3, CP1 ack R1 (lead-ruled, rev-25 pre-read).
  "1111-math-random.ts",
  "1121-infinity-number-tostring.ts",
  "1420-number-statics.ts",
  "1435-math-spread.ts",
  "1437-pad-default.ts",
  "2709-math-static-scalar.ts",
  "1579-matchall-index.ts",
  "1590-js-unannotated.js",
  "2042-any-flow-loops.ts",
  "2731-objlit-accessors-effects.ts",
  "2112-array-at-findlast.ts",
  "2350-nan-global.ts",
  "2445-math-minmax-nary.ts",
  "2453-private-accessors.ts",
  "2488-ast-walker.ts",
  "2577-builtin-global-destructuring.js",
  "2611-regex-named-groups-js.cjs",
  // Increment 25, pass P2 (num.sameValue — Object.is's F64 SameValue, the
  // tier's last divergence from ===): (x!=x && y!=y) | (bits(x)==bits(y)),
  // a direct port of unions.ts's own already-tested union-payload
  // SameValue shape. Reached only for a statically-both-f64 operand pair
  // (lower-calls.ts's lowerObjectStaticCall); every other kind pair
  // already compiled before this pass. No register entry: the tier now
  // matches Node exactly on Object.is over every kind. 820 -> 821.
  "2561-object-is.ts",
  // Increment 25, pass P3 (the parsers: num.parseInt/num.parseFloat/num.
  // fromString) — and board #123's fix on EVERY radix (a live silent
  // miscompile: digit-at-a-time f64 accumulation, replaced by V8's own
  // three transcribed branches — the correctly-rounded decimal helper for
  // radix 10, InternalStringToIntDouble for power-of-two radices,
  // HandleGenericCase's chunked multiply-add for every other radix) plus
  // board #123b's fix (the radix argument now uses ToInt32's modular
  // wrap instead of a trapping signed truncation). No register entry
  // (S069 withdrawn, design §9.2): the tier now matches Node exactly on
  // every radix. 1523 is the P1 leftover this pass finally closes
  // ({num.isNaN, math.floor} landed in P1; num.parseInt was the missing
  // third key). 821 -> 831.
  "1115-parse-globals.ts",
  "2695-string-split-static.ts",
  "1522-parseint-static.ts",
  "1523-isnan-floor-static.ts",
  "2705-union-as-arm-cast.ts",
  "1636-util-format.ts",
  "1991-for-in-loops.ts",
  "2388-tonumber-grammar-zoo.ts",
  "2389-tonumber-unary-plus.ts",
  "2431-primitive-ctor-values.ts",
  // Increment 25, pass P4 (the formatters: num.toFixed/num.toFixed0/
  // num.toExponential, plus D4's three dyn-path options — Math.PI/Math.E
  // via the getProp closed-table shape, toPrecision on a dyn NUM
  // receiver, toString(radix) for radix != 10 via a transcription of
  // V8's DoubleToRadixStringView). Board #125 closes (the toPrecision
  // placeholder-call and direct-call texts are now Node's own).
  // SEMANTICS.md S043's three fenced bullets are amended as landed
  // hunks (a/radix, b/toFixed-window, c/placeholder-name) — the fences
  // fire nowhere. 831 -> 834.
  "1112-number-methods.ts",
  "1116-island-static-mix.ts",
  "1980-primitive-proto-statics.ts",
  // Increment 25, pass P5 (design-number-v6.txt §5.4/§7.6, D4's option
  // C, CP1 sha256 0c1128c8.../827 + addendum 0c156446.../374 — the "str.*"
  // URI component codecs (str.encodeUriComponent/str.encodeUri/str.
  // decodeUriComponent — one shared percentEncode walk plus a strict
  // UTF-8 decode, both new to this tier) and the "string.*" family's
  // three mechanical siblings of matchAt/indexOf (string.fromCharCode —
  // both the packed array<f64> AND the bytes<u8/u32/i32/f32> spread
  // shapes — string.lastIndexOf, string.raw). D5's str.atob/str.btoa
  // ship too (uri.ts) but claim NO corpus program (no candidate reaches
  // either key) and pin instead in wasm-uri.test.ts, computed from Node
  // in-process — the 1077 denominator does not move for them. No
  // register entry (v6 §7.6: "REGISTER: none expected" — the URIError
  // text is produced via the tier's existing name-independent-of-class
  // mechanism, R0's own ReferenceError precedent, zero new
  // RUNTIME_ERROR_CLASSES entries). 834 -> 840, every member accounted
  // for: 838 (four keys' worth) + 2 (the two remaining candidates'
  // remaining blockers, decodeUriComponent and fromCharCode's bytes
  // shape) = 840 exactly, the design's own predicted end point.
  "1406-dataview-mp4.ts",
  "1427-fromcharcode-lastindexof.ts",
  "1454-nonnull-narrow-and-fcc-bytes.ts",
  "2707-string-array-sweep.ts",
  "2140-uri-component-codecs.ts",
  "2191-uri-encoders.ts",

  // INC-25 pass P6 (design-number-v6.txt §5.5/§6.6/§7.6/§8; CP1 cp1-plan-
  // p6.txt e365032f + cp1-addendum-p6.txt bd77f800; CP1 ACK GO WITH
  // DELTA, five deltas folded — DELTA-1 the grammar-1 two-digit-year
  // remap board #134, DELTA-2 the day-guard wording fix, D-alpha/beta/
  // gamma/delta board #133's three grammar-2 defects + the years-1..12
  // reinterpretation class, none transcribed). date.now/date.
  // toISOString/date.parseGetTime/date.utc/intl.numFormatEnUs/perf.now,
  // the wallClock ABI import (D3/D6), S069 (68 -> 69). 840 -> 846, all
  // six candidates measured clean under the per-pass stub sweep, none
  // else moves.
  "1422-date-iso.ts",
  "1582-timer-sleep-resolve.ts",
  "1981-date-utc.ts",
  "2427-perf-hooks-now.ts",
  "2446-performance-global.ts",
  "2562-intl-numberformat-en-us.ts",

  // INC-26 pass P1 (design-host-v7.txt cccf7d6e §2.2-§2.5/§3.2/§4;
  // DECISIONS.md D2/D3; cp1-plan-p1.txt 70a46350). The process host
  // contract: `hostStr`/`hostNum`/`exit`, the argv+env snapshots (one
  // interned string vec for argv, two parallel string vecs for env), cwd,
  // platform, the raw writes (stdoutWrite/stderrWrite/stdoutWriteBytes),
  // the 'exit' listener list and its drain at all six insertion points
  // (process.exit's own arm; %w.tick's two -1 sites; _start's tail for a
  // no-`_tick` module; reportUncaughtHelper's top; promises.ts's
  // emitReport top, covering both report()/rootReport() callers), the
  // DYN-typed unhandledRejection listeners (onUnhandledRejection/
  // offUnhandledRejection dispatch through the ledger walk's own
  // report(), suppressing the default trap when a listener is
  // registered; onRejectionHandled built as REGISTRATION ONLY — reached
  // by no program, per D10), S070. 846 -> 871.
  "1405-bytes-unions-arrays.ts",
  "1436-default-undef-param.ts",
  "1444-exit-listeners.ts",
  "1445-exit-process-exit.ts",
  "1446-exit-uncaught.ts",
  "1460-console-error-warn.ts",
  "1465-env-value.ts",
  "1477-in-expressions.ts",
  "1528-delete-records-env.ts",
  "2712-union-keyed-reads.ts",
  "1559-conditional-spread-index-merge.ts",
  "2035-ternary-array-retag.cjs",
  "2212-unhandled-rejection-listener.cjs",
  "2310-process-next-tick.ts",
  "2383-cycle-assertdoc/main.js",
  "2387-tonumber-argv.ts",
  "240-stdout-write.ts",
  "2441-console-process-argv.ts",
  "2616-js-collect-probe-defers.js",
  "2643-or-default-retag.ts",
  "2665-top-level-await-unhandled-listener-liveness.ts",
  "978-unions-nullish.ts",
  "990-process-basics.ts",
  "991-process-exit.ts",
  "998-process-env.ts",

  // INC-26 pass P2 (brief-p2-v2.md 89fd68aa §3F; design-host-v7.txt
  // cccf7d6e §3.1/§5; cp1-plan-p2.txt 3a5721e2). The path family: both
  // posix and win32 halves (nine mirror pairs, 18 keys total) transcribed
  // from scr_path.c into the tier's own `(array i16)` string idiom — a
  // pure TRANSCRIPTION, no new import, no register entry (uri.ts / INC-25
  // P5's own precedent); `resolve`/`win32Resolve`/`relative`/
  // `win32Relative` read P1's cwd snapshot through process.ts's existing
  // accessor, never a fresh hostStr call per invocation. The 105-
  // occurrence short-circuit audit (findings-p2.txt) and the three-way
  // oracle (packages/compiler/test/wasm-path-oracle.test.ts, 41448 posix
  // + 38214 win32 committed cases, Node vs the C port vs this emitted
  // module) are this pass's own second instrument, run continuously as
  // part of this package's suite rather than as a manual step. 871 -> 880.
  "1350-path-normalize-join.ts",
  "1351-path-parts.ts",
  "1352-path-resolve-relative.ts",
  "2704-path-platform-namespaces.ts",
  "1598-cjs-builtin-require/main.js",
  "1610-path-win32-full.ts",
  "1629-require-main-filename.cjs",
  "2166-cjs-getter-this/main.cjs",
  "2637-create-require-bare/main.ts",

  // INC-26 pass P3 (brief-p3-v2.md ffbf2fdf/371; design-host-v7.txt
  // cccf7d6e §2.7/§3.2/§4.3/§9 P3; DECISIONS.md P3-J1..J4). The process
  // tail: arch/execPath/versions/pid/getuid/getgid/isTTY/columns/uptime/
  // the cpu+thread-cpu counters and their in-module diffs,
  // cpuPrevValidate, rusage, the memory reads, activeResources (no host),
  // the warning surface, stdin's two keys, D4's `kill` import with its
  // own errno enumeration, D5's two onSignal/offSignal refusals, and
  // Joe's five widened #138 keys (stderrWriteBytes, offRejectionHandled,
  // chdir, exiting, umask). 880 -> 891.
  "1425-stdin-tty.ts",
  "1448-stream-columns.ts",
  "1461-process-pid-getuid-kill.ts",
  "1468-exec-path.ts",
  "2702-process-arch-versions.ts",
  "1571-optional-call-tostring-tail.ts",
  "2721-stdin-set-raw-mode-non-tty.ts",
  "1612-cjs-module-globals.cjs",
  "1639-versions-openssl-probe.ts",
  "2215-process-emit-warning-exit.cjs",
  "2314-process-introspection.ts",

  // INC-26 pass P4 (brief-p4-v2.md eac927bd/304; delta-cp1 a910f5e3/37;
  // delta-1720 35a6cad6/22, JOE RULING P4-J4). The fs core: 13 fs.* keys
  // plus os.tmpdir/os.homedir behind ONE fsCall host import, and
  // deliverable 3I's shapeEndHelper fix (a matched RegExp shape key no
  // longer renders as a false mismatch when another key in the same
  // shape mismatches — 1720's own row M, the finding this pass measured
  // and Joe ruled to fix in-pass regardless of size). 891 -> 908.
  "1006-json-fs-config.ts",
  "1306-errors-runtime-instances.ts",
  "1353-os-basics.ts",
  "1354-builtin-bare-specifiers.ts",
  "1424-fs-options.ts",
  "2699-catch-narrowing.ts",
  "1583-loops-and-stream-captures.ts",
  "1720-assert-throws-shape.ts",
  "2361-assign-index-record.ts",
  "2391-default-builtin-imports/main.ts",
  "2631-create-require/main.ts",
  "992-fs-roundtrip.ts",
  "993-fs-readdir.ts",
  "994-fs-errors.ts",
  "995-fs-uncaught.ts",
  "996-fs-rc-stress.ts",
  "997-fs-modules/main.ts",
  // INC-26 P5 (3G, THE TWELVE — brief §1's own closed set, re-derived at
  // CP1, confirmed unchanged through every checkpoint's own census: 908
  // -> 920): 1357/1569 the stats-surface fsp twins; the rest the fs
  // tail's own new keys (bytes ops, os tail, fd table, the retry
  // record, the u16-prefixed realpath error path).
  "1357-fsp-roundtrip.ts",
  "1403-buffer-fs.ts",
  "1426-stdin-read.ts",
  "1480-os-network-interfaces.ts",
  "1520-fs-wider-surface.ts",
  "1540-os-userinfo.ts",
  "1541-fs-readdir-dirent.ts",
  "1569-fsp-mkdir-unlink-chmod.ts",
  "2724-promise-all-tuple-literal.ts",
  "2725-rmsync-retry-options.cjs",
  "1640-fd-read-decode.ts",
  "2096-os-type.ts",
  // INC-26 P6 (the twelve fs. argument-validation ladder keys,
  // transcribed to Node's own measured check orders): 920 -> 922. 2573
  // claims on the timestamp key alone; 2595 needs the other eleven.
  "2573-fs-url-arg-ladders.cjs",
  "2595-fs-arg-ladders.cjs",
  // INC-27 U1 (the symbol value: construction, toString, description,
  // identity, truthiness, the `Symbol.for` registry, the third Map/Set
  // key kind, and assert.eqSym's eight message shapes): 922 -> 934, the
  // twelve programs this unit lands.
  "1669-symbol-identity.ts",
  "1670-symbol-registry.ts",
  "1671-symbol-typeof.ts",
  "1672-symbol-containers.ts",
  "1673-symbol-cjs.cjs",
  "1674-symbol-inspect.ts",
  "1725-assert-symbols.ts",
  "1730-countdown-symbol-keys/main.js",
  "1731-symbol-field-shapes.cjs",
  "1732-symbol-field-cross-module/main.js",
  "2072-expando-function-members.ts",
  "2440-console-inspect-args.ts",
  // INC-27 U2 (H, the static smalls: the ES2023 copiers toReversed/
  // toSpliced/with over every VecInfo ElemKind, join over union elements
  // per the front end's own join element fence, expr:templateStrings's
  // per-site interning, toString:record, and classval:no-ctor's
  // mapType/mapTypeSoft lockstep): 934 -> 944, the ten programs this
  // unit lands.
  "1872-template-tostring-composite.ts",
  "1973-decorators-ambient.ts",
  "1983-array-tuple-surfaces.ts",
  "1992-small-syntax.ts",
  "2250-tagged-templates.ts",
  "2666-array-to-sorted.ts",
  "2669-array-copying-methods.ts",
  "2670-uint8array-copy-iterate.ts",
  "2671-array-copying-js.cjs",
  "2720-union-element-join.ts",
  // INC-27 U3 (G, rest-typed function values: closSigFor's opt-in,
  // mapType/mapTypeSoft's func arms in lockstep, the rest-array thunk
  // build, the process.onExit rest guard): 944 -> 950, the six programs
  // this unit lands.
  "1700-mustcall-common/main.cjs",
  "1701-mustcall-exit-report/main.cjs",
  "1703-arguments-rest-props.cjs",
  "1826-settimeout-arguments-callback.js",
  "2163-js-selfref-const.cjs",
  "2164-js-then-dyn-handler.cjs",
  // INC-27 U4 (A, the async shapes: return through a finally the state
  // machine keeps or explodes, a void await in an operand, an async loop
  // box, a typed promise boxed into dyn with its value converted once,
  // then/catch/finally on a dyn promise receiver with Node's adoption,
  // and process.once removing itself before its call): 950 -> 955, the
  // five programs this unit lands.
  "1452-return-through-finally.ts",
  "1453-pmap-settled.ts",
  "2210-dyn-promise-crossing.cjs",
  "2735-rejection-events.cjs",
  "409-params-async-generics.ts",
  // INC-27 U5 (D, the dyn smalls: a caught value narrowed as an Error,
  // DOMException with its derived code and cause, structuredClone over the
  // dynamic tree, spread arguments and variadic Object.assign's source
  // pack, Object.create(null), and a failing top-level-await module
  // reported before an unrelated rejection's listener): 955 -> 964, the
  // nine programs this unit lands.
  "1554-caught-into-unknown.ts",
  "2281-domexception-atob-btoa.cjs",
  "2283-structured-clone.cjs",
  "2567-rest-spread-forward.js",
  "2586-object-assign-spread.js",
  "2589-object-create-null.cjs",
  "2654-top-level-await-unrelated-rejection.ts",
  "2663-top-level-await-dependency-errors/main.ts",
  "2664-top-level-await-same-checkpoint-rejection.ts",
  // INC-27 U6: `**` computes for every operand pair (the ECMA-262 ladder,
  // V8's y = 2 and y = 0.5 pre-cases, and glibc's pow transcribed with its
  // fused multiply-adds; SEMANTICS.md S079) and `bin:**` is routed to it.
  "304-compound-incdec.ts",
  "700-classes-basic.ts",
  // INC-28 U1: child_process's synchronous surface (spawnSync, execSync,
  // execFileSync and promisified execFile through the cpCall host import,
  // the host holding each result behind a handle; SEMANTICS.md S085, S086):
  // 966 -> 981, the fifteen programs this unit lands.
  "1360-spawn-sync.ts",
  "1462-exec-sync.ts",
  "1464-env-writes.ts",
  "1473-promisify-execfile.ts",
  "1482-spawnsync-error.ts",
  "1521-fs-lstat-lock.ts",
  "1552-exec-options-record.ts",
  "1573-promisify-execfile-env-spread.ts",
  "1578-exec-input-optional.ts",
  "1580-exec-env-conditional-spread.ts",
  "1655-spawnsync-neutral.ts",
  "1656-execsync-neutral.ts",
  "2362-execsync-inherit.ts",
  "2697-spawnsync-options.ts",
  "2708-os-release-spawnsync-stdio.ts",
  // INC-28 U2: child_process's asynchronous surface (spawn, the ChildProcess
  // value with its 'exit' and 'error' events, kill and unref, through the
  // event loop's poll phase and the evPoll host import; SEMANTICS.md S085,
  // S086): 981 -> 993, the twelve programs this unit lands.
  "1361-spawn-events.ts",
  "1362-spawn-timers.ts",
  "1363-spawn-unhandled-error.ts",
  "1466-child-containers.ts",
  "1470-child-lifecycle.ts",
  "1471-child-unref.ts",
  "1472-errno-code.ts",
  "1525-child-exit-signal.ts",
  "1535-spawn-fd-stdio.ts",
  "1570-child-unref-kill-reffed.ts",
  "2698-spawn-options.ts",
  "2717-spawn-conditional-spread.ts",
  // INC-28 U3: child output streams (stdio "pipe" for stdout/stderr:
  // child.stdout / child.stderr with 'data' and 'end', through cpCall's FLOW
  // and evPoll's kinds 4 and 5) and node:string_decoder (strdec.ts;
  // SEMANTICS.md S086 (k)): 993 -> 998, the five programs this unit lands.
  "1474-string-decoder.ts",
  "1565-spawn-pipe-streams.ts",
  "1566-child-duck-interface.ts",
  "1657-spawn-async-neutral.ts",
  "1662-string-decoder-encodings.ts",
  // INC-29 U1: node:net — net.Server and net.Socket built in the module from
  // Node's own source over the OS-level netCall host import and the evPoll
  // queue (SEMANTICS.md S087): 998 -> 1004, the six programs this unit lands.
  "1567-server-close-override.ts",
  "1797-dyn-handle-socket.cjs",
  "2500-net-autosel-timeout.ts",
  "2596-net-arg-ladders.cjs",
  "2599-stream-arg-ladders.cjs",
  "2640-net-dyn-socket-compat.cjs",
  // INC-29 U2: node:http — servers, responses, client requests and agents
  // built in the module from Node's own _http_* source and llhttp, over
  // node:net's sockets (SEMANTICS.md S088): 1004 -> 1015.
  "1750-http-agent-options.ts",
  "1780-http-res-surface.ts",
  "1781-http-server-shapes.cjs",
  "1795-dyn-handle-request.cjs",
  "1796-dyn-handle-body.cjs",
  "1798-dyn-handle-typed-box.ts",
  "2638-http-dyn-res-compat.cjs",
  "2639-http-dyn-req-pause.cjs",
  "2641-http-agent-surface.cjs",
  "2642-http-agent-maxsockets.cjs",
  "2714-set-server-handles.ts",
  // INC-29 U3: the WHATWG URL and URLSearchParams built in the module
  // (url-whatwg.ts, url-idna.ts — Node's ada and lib/internal/url.js;
  // SEMANTICS.md S089): 1015 -> 1027.
  "1355-url-parse.ts",
  "1356-url-file-bridge.ts",
  "1557-url-host.ts",
  "1577-url-hostname.ts",
  "1611-url-file-bridge-neutral.ts",
  "1791-searchparams-core.ts",
  "1792-searchparams-encoding.ts",
  "1793-searchparams-iteration.ts",
  "1794-searchparams-url-live.ts",
  "2381-builtin-default-imports.js",
  "2571-searchparams-arg-validation.cjs",
  "2644-http-client-url-argument.ts",
  // the http option carry (1027 -> 1029): Agent options, request timeout, agent: false,
  // requireHostHeader, setHeader numbers and writeHead's check order
  "2743-http-option-carry.ts",
  "2744-http-option-carry-dyn.cjs",
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
 * one root timer for exactly this reason.
 *
 * INC-28 U2: an event module's clock is real only while one of its
 * children is live; a busy wait with none live never ends here. */
/** INC-26 P1's own sentinel class for `tsinter.exit` (abi.ts §2.5): the
 * host TERMINATES by throwing this, recognised BEFORE the RuntimeError
 * test below (a wasm trap and an exit are different channels — S007/S010
 * vs. the new nonzero-exit-without-a-trap channel abi.ts documents). */
class WasmExitSignal extends Error {
  constructor(readonly code: number) {
    super(`tsinter.exit(${code})`);
  }
}

/* ── INC-26 pass P4 (design-host-v7.txt §6.4, brief-p4-v2.md §0/§3E; CP1
 * delta N-1/N-3) — the fsCall adapter's SAFETY GUARD.
 * "THE RISKIEST TEST CODE IN THE INCREMENT" (design's own words): the
 * adapter performs REAL, DESTRUCTIVE filesystem writes in the worker's
 * own process. MEASURED across the seventeen (rev-26's own K-1): only
 * 1424/2361 use `os.tmpdir()`+`mkdtempSync`; SIX (992, 993, 994, 996,
 * 1006, 1354) write RELATIVE TO THE CWD, which on the wasm lane is the
 * WORKER's own — the repo root. A tmpdir-only guard would refuse those
 * six on their first write and make this pass's own tier movement
 * impossible.
 *
 * THE RULE (ROOT-SET PLUS EXCLUSION, never tmpdir-only): resolve every
 * destructive path and REFUSE unless it is under (a) `os.tmpdir()`, or
 * (b) the repo root AND untracked by git AND NOT under packages/,
 * tests/corpus/, tests/fixtures/, .git/ or node_modules/.
 *
 * N-1 (BLOCKING, CP1 delta): "resolve to an absolute REAL path" cannot
 * run on the TARGET for a CREATE — `realpathSync` throws ENOENT on a
 * path that does not exist yet, and every destructive CREATE (a new
 * file, a new directory, mkdtemp) targets exactly that. THE FIX:
 * `path.resolve(cwd, p)` first (never `realpathSync` the target), then
 * realpath the NEAREST EXISTING ANCESTOR (walk up until it exists) and
 * re-join the unresolved tail onto it — THAT is what gets screened
 * against the root set. A symlinked scratch dir resolves through the
 * link (its real ancestor is where the link POINTS); a path whose
 * nearest existing ancestor escapes the root set is refused whatever the
 * tail says.
 *
 * N-3 (record, CP1 delta): TWO DIFFERENT SETS. Several programs (1354:
 * 19-23; 992's own `freshDir`) clean up a PREDECESSOR run's leftover
 * scratch before creating their own — a LEGITIMATE remove of a repo-root
 * path THIS run did not itself create. The PERMISSION test screens on
 * LOCATION (the root set) and admits that; the CLEANUP `finally` (in
 * `runWasm`, below) removes only what THIS run's OWN `createdPaths` set
 * recorded — the two sets are deliberately different, and the cleanup
 * set is not a complete list of every path the run touched. */

const EXCLUDED_REPO_PREFIXES: readonly string[] = ["packages", "tests/corpus", "tests/fixtures", ".git", "node_modules"];

/** N-1's fix: resolve `rawPath` against `cwd`, then walk UP from there
 * until an EXISTING ancestor is found, realpath THAT ancestor (defeats a
 * symlink escape), and re-join the unresolved tail onto it. Never calls
 * `realpathSync` on the target itself. */
function resolveNearestExistingAncestor(rawPath: string, cwd: string): string {
  const resolved = pathResolve(cwd, rawPath);
  let ancestor = resolved;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(ancestor)) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // filesystem root — give up, ancestor stays as-is
    tail.unshift(basename(ancestor));
    ancestor = parent;
  }
  const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  return tail.length > 0 ? join(realAncestor, ...tail) : realAncestor;
}

/** Is `absPath` tracked by git (relative to `repoRoot`)? A destructive
 * write under the repo root is permitted only when UNTRACKED — the
 * corpus's own source files must never be touched. */
function isGitTracked(absPath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", absPath], { cwd: repoRoot, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Is `absPath` equal to, or a descendant of, `prefixAbs`? Both must
 * already be absolute, resolved paths. */
function isUnderPrefix(absPath: string, prefixAbs: string): boolean {
  if (absPath === prefixAbs) return true;
  return absPath.startsWith(prefixAbs.endsWith("/") ? prefixAbs : prefixAbs + "/");
}

/** The root-set + exclusion test itself (§0's rule, applied to the
 * ALREADY-RESOLVED-VIA-N-1 path). */
function isPermittedDestructivePath(resolvedPath: string): boolean {
  const realTmp = realpathSync(tmpdir());
  if (isUnderPrefix(resolvedPath, realTmp)) return true;
  const realRepoRoot = realpathSync(repoRoot);
  if (!isUnderPrefix(resolvedPath, realRepoRoot)) return false;
  for (const prefix of EXCLUDED_REPO_PREFIXES) {
    if (isUnderPrefix(resolvedPath, join(realRepoRoot, prefix))) return false;
  }
  return !isGitTracked(resolvedPath);
}

/** Resolves + screens a destructive op's path; THROWS LOUDLY, naming the
 * program, if it is not permitted. Returns the resolved absolute path a
 * caller that is CREATING something records into `createdPaths` (N-3). */
function guardDestructive(rawPath: string, cwd: string, modulePath: string, opName: string): string {
  const resolved = resolveNearestExistingAncestor(rawPath, cwd);
  if (!isPermittedDestructivePath(resolved)) {
    throw new Error(
      `HARNESS SAFETY GUARD: refusing a destructive fs op (${opName} '${rawPath}' -> resolved '${resolved}') for ${modulePath} — outside the permitted root set (os.tmpdir() or an untracked path under the repo root, excluding packages/, tests/corpus/, tests/fixtures/, .git/, node_modules/)`,
    );
  }
  return resolved;
}

// fs.ts's OWN fourteen-code enumeration (E-P4-3, delta-3e e4da1096 R-1:
// 13 ELOOP/14 ENAMETOOLONG appended, nothing renumbered), in the SAME
// order (index i is code i+1) — the adapter maps a thrown Node error's
// `.code` to this table's index, `-(256 + -e.errno)` for anything else.
// Independently written here (never imported from fs.ts — the module
// and the adapter are separate instruments; A-3's own two-sided rule
// applies to the CARRIER too, not only the message text). Module-scope
// (not runWasm-local) so the adapter's own unit rows can drive it
// directly (design §10-v).
const FS_CODE_INDEX: Readonly<Record<string, number>> = {
  ENOENT: 1,
  EEXIST: 2,
  EACCES: 3,
  ENOTDIR: 4,
  EISDIR: 5,
  ENOTEMPTY: 6,
  EPERM: 7,
  EBADF: 8,
  EMFILE: 9,
  ENOSPC: 10,
  EINVAL: 11,
  EROFS: 12,
  ELOOP: 13,
  ENAMETOOLONG: 14,
};

/** Maps a thrown Node fs error to fsCall's own status carrier. The rm-
 * on-directory SPECIAL CASE (S073's second sentence) throws
 * `ERR_FS_EISDIR`, not `EISDIR` — mapped to the SAME ordinary EISDIR
 * carrier value (-5): the MODULE alone decides (op===14 && code===
 * EISDIR) means "render the special shape" (fs.ts's own comment), so
 * the adapter needs no extra signal, only the ordinary code. */
function mapFsError(e: unknown, modulePathLabel: string): number {
  if (!(e instanceof Error)) {
    throw new Error(`HARNESS SAFETY GUARD: fsCall's adapter caught a non-Error throw for ${modulePathLabel}: ${String(e)}`);
  }
  const err = e as NodeJS.ErrnoException;
  const code = err.code === "ERR_FS_EISDIR" ? "EISDIR" : err.code;
  const idx = code !== undefined ? FS_CODE_INDEX[code] : undefined;
  if (idx !== undefined) return -idx;
  const errno = typeof err.errno === "number" ? err.errno : undefined;
  if (errno === undefined) {
    throw new Error(`HARNESS SAFETY GUARD: fsCall's adapter caught an error with no .errno for ${modulePathLabel}: ${err.code ?? err.message}`);
  }
  // e.errno is NEGATIVE for ordinary Node fs errors (measured); the
  // carrier wants the RAW positive platform errno.
  return -(256 + (errno < 0 ? -errno : errno));
}

// INC-26 P5 (design §6.2, emitter.ts's own FLAGS_ENUM at the openSync
// call site): the REVERSE of the module's compile-time literal-to-int
// table. The module already validated the literal at compile time (an
// unrecognized flags string is a compile-time ERR_INVALID_ARG_VALUE, the
// 1640 row) — the host only ever sees one of these ten codes.
const OPEN_FLAGS_BY_CODE: readonly string[] = ["r", "r+", "w", "wx", "w+", "wx+", "a", "ax", "a+", "ax+"];

// P5 (design §2.6, fs.readdirTypesSync's own %dtype field): libuv's
// UV_DIRENT encoding (scr_runtime.h:2640's own C-lane comment — the
// SAME vendored reference the field-order precedent already cites): 1
// file, 2 dir, 3 link, 4 fifo, 5 socket, 6 char, 7 block, 0 unknown.
// Node's own Dirent predicate methods already apply libuv's own
// DT_UNKNOWN -> lstat(2) fallback internally (documented Node
// behavior), so calling them directly reproduces the C lane's own
// fallback for free — no separate lstat call needed here.
function direntType(d: import("node:fs").Dirent): number {
  if (d.isFile()) return 1;
  if (d.isDirectory()) return 2;
  if (d.isSymbolicLink()) return 3;
  if (d.isFIFO()) return 4;
  if (d.isSocket()) return 5;
  if (d.isCharacterDevice()) return 6;
  if (d.isBlockDevice()) return 7;
  return 0;
}

// ── INC-28 U1 — the cpCall adapter's pure parts (abi.ts cpCall) ─────────
// Module-scope (not runWasm-local) so the U1 block's unit rows drive them
// directly, the mapFsError precedent. runWasm's own cpCall closure below
// is the only other caller.

/** One RUN request, decoded from the module's record (abi.ts layout). */
interface CpRequest {
  stdinMode: number;
  stdoutMode: number;
  stderrMode: number;
  killSignal: number;
  timeoutMs: number;
  maxBufferMode: number;
  file: string;
  argv: string[];
  cwd: string;
  env: [string, string][];
  input: Uint8Array;
}

/** A finished child, transcribed field by field from Node's own
 * spawnSync result. */
interface CpResult {
  hasStatus: number;
  status: number;
  signal: number;
  errCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Decodes the request record at [ptr, ptr + len): the 32-byte header
 * through a DataView, then the runs (u32 count + UTF-16 units, padded to
 * 4) and the input bytes. Throws on any record whose parts do not add up
 * to exactly `len` bytes. */
function cpDecodeRequest(buffer: ArrayBufferLike, ptr: number, len: number): CpRequest {
  const dv = new DataView(buffer, ptr, len);
  let off = 32;
  const u32 = (): number => {
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const run = (): string => {
    const n = u32();
    const units = new Uint16Array(buffer, ptr + off, n);
    let text = "";
    for (let i = 0; i < n; i += 4096) text += String.fromCharCode(...units.subarray(i, Math.min(n, i + 4096)));
    off += (2 * n + 3) & ~3;
    return text;
  };
  const file = run();
  const argc = u32();
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) argv.push(run());
  const cwd = run();
  const pairs = u32();
  const env: [string, string][] = [];
  for (let i = 0; i < pairs; i++) {
    const key = run();
    env.push([key, run()]);
  }
  const inputLen = u32();
  const input = new Uint8Array(buffer, ptr + off, inputLen).slice();
  off += inputLen;
  if (off !== len) throw new Error(`cpCall: request record is ${len} bytes but its parts add up to ${off}`);
  return {
    stdinMode: dv.getUint32(0, true),
    stdoutMode: dv.getUint32(4, true),
    stderrMode: dv.getUint32(8, true),
    killSignal: dv.getUint32(12, true),
    timeoutMs: dv.getFloat64(16, true),
    maxBufferMode: dv.getUint32(24, true),
    file,
    argv,
    cwd,
    env,
    input,
  };
}

/** stdin per mode: 0 pipe at end-of-file, 1 pipe carrying the input, 2
 * inherit EMULATED as a pipe at end-of-file (the program's own stdin is
 * not this worker's; the oracle's is a closed pipe, so its children read
 * end-of-file too), 3 ignore. */
function cpStdinFor(mode: number): "pipe" | "ignore" {
  if (mode === 0 || mode === 1 || mode === 2) return "pipe";
  if (mode === 3) return "ignore";
  throw new Error(`cpCall: unknown stdin mode ${mode}`);
}

/** stdout/stderr per mode: 0 capture, 1 discard, 2 inherit EMULATED —
 * captured here and written by the module to its own fd (a real inherit
 * would write to this worker's fds, past the per-fd capture). */
function cpStdioFor(mode: number): "pipe" | "ignore" {
  if (mode === 0 || mode === 2) return "pipe";
  if (mode === 1) return "ignore";
  throw new Error(`cpCall: unknown output mode ${mode}`);
}

/** maxBuffer: unbounded for the exec family (mode 1), and whenever
 * neither output is captured (Node has no pipe to limit then); otherwise
 * Node's default. */
function cpMaxBufferFor(req: Pick<CpRequest, "maxBufferMode" | "stdoutMode" | "stderrMode">): number | undefined {
  if (req.maxBufferMode === 1) return Infinity;
  if (req.stdoutMode !== 0 && req.stderrMode !== 0) return Infinity;
  return undefined;
}

/** The host's own errno table, written independently of the module's
 * (childproc.ts CP_CODES): index 1..15. A U1 unit row checks it against
 * the literal list. */
const CP_HOST_CODE_INDEX: Readonly<Record<string, number>> = {
  ENOENT: 1,
  EACCES: 2,
  EPERM: 3,
  ENOTDIR: 4,
  ENOEXEC: 5,
  ELOOP: 6,
  ENAMETOOLONG: 7,
  E2BIG: 8,
  ENOMEM: 9,
  EAGAIN: 10,
  EIO: 11,
  EINVAL: 12,
  ETIMEDOUT: 13,
  EPIPE: 14,
  ENOBUFS: 15,
};

/** Node's result.error -> the record's errCode: 0 none, the table's
 * index, or -(256 + errno) for a code outside it. */
function cpErrCodeFor(error: Error | undefined): number {
  if (error === undefined) return 0;
  const err = error as NodeJS.ErrnoException;
  const idx = err.code !== undefined ? CP_HOST_CODE_INDEX[err.code] : undefined;
  if (idx !== undefined) return idx;
  if (typeof err.errno !== "number") throw new Error(`cpCall: a child error with no .errno: ${err.code ?? err.message}`);
  return -(256 + Math.abs(err.errno));
}

/** Writes a result record (abi.ts layout) at ptr through a DataView. */
function cpEncodeResult(buffer: ArrayBufferLike, ptr: number, r: CpResult): void {
  const dv = new DataView(buffer, ptr, 32);
  dv.setUint32(0, r.hasStatus, true);
  dv.setFloat64(4, r.status, true);
  dv.setUint32(12, r.signal, true);
  dv.setInt32(16, r.errCode, true);
  dv.setUint32(20, r.stdout.length, true);
  dv.setUint32(24, r.stderr.length, true);
  dv.setUint32(28, 0, true);
}

/** Runs one decoded request with Node's own spawnSync and transcribes the
 * result. The environment is ALWAYS the request's (the module sends its
 * own map when the program gave no env option); the cwd is omitted when
 * the run is empty. */
function cpRunRequest(req: CpRequest): CpResult {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of req.env) env[k] = v;
  const r = spawnSync(req.file, req.argv, {
    ...(req.cwd === "" ? {} : { cwd: req.cwd }),
    env,
    stdio: [cpStdinFor(req.stdinMode), cpStdioFor(req.stdoutMode), cpStdioFor(req.stderrMode)],
    ...(req.stdinMode === 1 ? { input: req.input } : {}),
    ...(req.timeoutMs > 0 ? { timeout: req.timeoutMs } : {}),
    killSignal: req.killSignal,
    ...(cpMaxBufferFor(req) === undefined ? {} : { maxBuffer: Infinity }),
    encoding: "buffer",
    windowsHide: true,
  });
  const signals = osConstants.signals as Record<string, number>;
  return {
    hasStatus: r.status === null ? 0 : 1,
    status: r.status ?? 0,
    signal: r.signal === null ? 0 : (signals[r.signal] ?? 0),
    errCode: cpErrCodeFor(r.error),
    stdout: r.stdout ?? new Uint8Array(0),
    stderr: r.stderr ?? new Uint8Array(0),
  };
}

/** RUN's guard: any host-side throw becomes the negative status the
 * module turns into its named trap. */
function cpGuardedRun(run: () => number): number {
  try {
    return run();
  } catch {
    return -1;
  }
}

// ── INC-28 U2 — the event host's pure parts (abi.ts cpCall ops 5-8, evPoll) ──
// Module-scope so the U2 block's unit rows drive them directly (the U1
// precedent above); runWasm's own event host below is their only other
// caller.

/** One SPAWN request, decoded from the module's record (abi.ts layout). */
interface SpawnRequest {
  stdinMode: number;
  stdoutMode: number;
  stderrMode: number;
  outFd: number;
  errFd: number;
  detached: number;
  file: string;
  argv: string[];
  cwd: string;
  env: [string, string][];
}

/** Decodes a SPAWN request at [ptr, ptr + len): the 32-byte header through
 * a DataView, then the runs (U1's encoding, no input). Throws on any record
 * whose parts do not add up to exactly `len` bytes. */
function spawnDecodeRequest(buffer: ArrayBufferLike, ptr: number, len: number): SpawnRequest {
  const dv = new DataView(buffer, ptr, len);
  let off = 32;
  const u32 = (): number => {
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const run = (): string => {
    const n = u32();
    const units = new Uint16Array(buffer, ptr + off, n);
    let text = "";
    for (let i = 0; i < n; i += 4096) text += String.fromCharCode(...units.subarray(i, Math.min(n, i + 4096)));
    off += (2 * n + 3) & ~3;
    return text;
  };
  const file = run();
  const argc = u32();
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) argv.push(run());
  const cwd = run();
  const pairs = u32();
  const env: [string, string][] = [];
  for (let i = 0; i < pairs; i++) {
    const key = run();
    env.push([key, run()]);
  }
  if (off !== len) throw new Error(`cpCall: spawn request is ${len} bytes but its parts add up to ${off}`);
  return {
    stdinMode: dv.getUint32(0, true),
    stdoutMode: dv.getUint32(4, true),
    stderrMode: dv.getUint32(8, true),
    outFd: dv.getInt32(12, true),
    errFd: dv.getInt32(16, true),
    detached: dv.getUint32(20, true),
    file,
    argv,
    cwd,
    env,
  };
}

/** One queued host event (abi.ts evPoll). */
interface HostEvent {
  source: number;
  handle: number;
  kind: number;
  a: number;
  b: number;
  payload: Uint8Array;
  /** INC-29 U1 (review): the host loop iteration a net event was observed
   * in (abi.ts evPoll: one host iteration's net events form one poll
   * phase). */
  gen?: number;
}

/** Writes `ev` at ptr when it fits in `cap` bytes and answers its length
 * (24 + payload); answers -(that length) and writes nothing otherwise. */
function evEncodeRecord(buffer: ArrayBufferLike, ptr: number, cap: number, ev: HostEvent): number {
  const need = 24 + ev.payload.length;
  if (cap < need) return -need;
  const dv = new DataView(buffer, ptr, need);
  dv.setUint32(0, ev.source, true);
  dv.setUint32(4, ev.handle, true);
  dv.setUint32(8, ev.kind, true);
  dv.setUint32(12, ev.payload.length, true);
  dv.setInt32(16, ev.a, true);
  dv.setInt32(20, ev.b, true);
  new Uint8Array(buffer, ptr + 24, ev.payload.length).set(ev.payload);
  return need;
}

/** What one public ChildProcess.kill() call did, as KILL's answer: true is
 * 0; a throw is its errno; false with an 'error' the host's own listener
 * saw during the call is that error's errno; false with neither is ESRCH
 * (-3: the child is already reaped, or kill(2) said so). */
function killErrnoFor(outcome: { returned: boolean | undefined; thrownErrno: number | undefined; errorErrno: number | undefined }): number {
  if (outcome.thrownErrno !== undefined) return outcome.thrownErrno;
  if (outcome.returned === true) return 0;
  if (outcome.errorErrno !== undefined) return outcome.errorErrno;
  return -3;
}

/** The SPAWN disposition from what public spawn() did: it threw with a
 * failure the tracing channel saw -> 2 (thrown); it returned without a
 * pid and the channel saw a failure -> 1 (reported later); it returned a
 * pid and the channel saw none -> 0. Anything else (a throw the channel
 * never saw — an argument check the module should have made first) is a
 * host failure (null). */
function dispositionFor(r: { threw: boolean; dcErrno: number | undefined; pid: number | undefined }): { disposition: number; errno: number } | null {
  if (r.threw) return r.dcErrno === undefined ? null : { disposition: 2, errno: r.dcErrno };
  if (r.pid === undefined) return r.dcErrno === undefined ? null : { disposition: 1, errno: r.dcErrno };
  return r.dcErrno === undefined ? { disposition: 0, errno: 0 } : null;
}

/** Where one of a child's output slots goes (abi.ts SPAWN modes): ignored;
 * captured and written to the PROGRAM's stdout (1) or stderr (2) —
 * "inherit", or the fd 1 or 2 given by number in either slot; the write
 * end of a pipe whose reader is already closed for fd 0 (the harness's
 * Node oracle runs with fd 0 a socket whose peer is gone, so a child's
 * write there fails with SIGPIPE); an fd THIS run opened, passed through;
 * anything else is EBADF — never a host descriptor the run did not open. */
type StdioRoute = "ignore" | { capture: 1 | 2 } | "fd0-pipe" | { fd: number } | "EBADF" | "pipe";

function stdioRouteFor(slot: 1 | 2, mode: number, fd: number, openFds: ReadonlySet<number>): StdioRoute {
  if (mode === 0) return "ignore";
  if (mode === 1) return { capture: slot };
  // INC-28 U3: a piped slot — child.stdout / child.stderr's stream, read by
  // the host's own ChildProcess once the module sends FLOW.
  if (mode === 3) return "pipe";
  if (mode !== 2) throw new Error(`cpCall: unknown output mode ${mode}`);
  if (fd === 1 || fd === 2) return { capture: fd };
  if (fd === 0) return "fd0-pipe";
  if (openFds.has(fd)) return { fd };
  return "EBADF";
}

/** The event host's clock: virtual while no child of the run is live;
 * while one is, real time measured from the anchor (taken at the last
 * moment the first child went live), never behind the virtual clock. */
function clockFor(s: { vclock: number; live: number; anchorV: number; anchorR: number; nowR: number }): number {
  if (s.live === 0) return s.vclock;
  return Math.max(s.vclock, s.anchorV + (s.nowR - s.anchorR));
}

/** One child the event host started (abi.ts cpCall op 5). `live` until
 * the module has read its EXIT. */
interface EvChild {
  proc: ChildProcess;
  /** The host may still deliver an event for this child: its EXIT (a
   * spawned child) and every piped stream's END are unread. */
  live: boolean;
  /** INC-28 U3: the EXIT has been read (always true for a failed spawn,
   * which has none), and the piped streams' ENDs still unread. */
  exitRead: boolean;
  endsUnread: number;
  /** The piped streams by slot (index 0 stdout, 1 stderr), null for a
   * slot that is not piped; `flowing` once FLOW attached the host's
   * 'data' listener. */
  pipes: (import("node:stream").Readable | null)[];
  flowing: boolean[];
  /** The host's own exit-time listener reads this stream (kind 6). */
  held: boolean[];
  errorErrno: number | undefined;
  /** A pipe both output slots share (they name one program stream), read
   * by the host itself; null when there is none. */
  shared: Socket | null;
}

// ── INC-29 U1 — the net host (abi.ts netCall, evPoll source 2) ───────────
// node:net's OS-level operations, done with Node's own public net API: a
// listening handle is net._createServerHandle's bind (the module's own
// address and family, no fallback of its own) wrapped by a server whose
// listen() reports a listen failure through the documented
// tracing:net.server.listen:error channel; every socket is created with
// allowHalfOpen (the module decides when the write side ends) and paused,
// so nothing is read off the kernel until the module's READ_START; a
// write reports done when the host's own uv_try_write took it all (the
// writable length is back to 0 when write() returns), else pending until
// the host's write callback. Read results (DATA, EOF, READ_ERROR) are
// queued only while the module reads; between READ_STOP and READ_START
// they are held, in order. CLOSE drops every queued event of the handle
// (and, for a listening handle, closes the connections its dropped
// ACCEPTs carried). Module-scope so the INC-29 block's unit rows drive
// its pure parts directly; runWasm is its only other caller.

const NET_OP_LISTEN = 1;
const NET_OP_CONNECT = 2;
const NET_OP_READ_START = 3;
const NET_OP_READ_STOP = 4;
const NET_OP_WRITE = 5;
const NET_OP_SHUTDOWN = 6;
const NET_OP_CLOSE = 7;
const NET_OP_NODELAY = 8;
const NET_OP_RESOLVE = 9;
const NET_EV_ACCEPT = 1;
const NET_EV_CONNECT = 2;
const NET_EV_DATA = 3;
const NET_EV_EOF = 4;
const NET_EV_READ_ERROR = 5;
const NET_EV_WRITE_DONE = 6;
const NET_EV_RESOLVE_DONE = 8;
const NET_READ_KINDS: ReadonlySet<number> = new Set([NET_EV_DATA, NET_EV_EOF, NET_EV_READ_ERROR]);

/** One UTF-16 run (abi.ts): a u32 code-unit count, the units, padding to 4. */
function netRunBytes(s: string): Uint8Array {
  const out = new Uint8Array(4 + ((2 * s.length + 3) & ~3));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, s.length, true);
  for (let i = 0; i < s.length; i++) dv.setUint16(4 + 2 * i, s.charCodeAt(i), true);
  return out;
}

function netU32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

function netConcat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The run at `off`: its text and the offset after it. */
function netReadRun(buffer: ArrayBufferLike, off: number): { text: string; next: number } {
  const n = new DataView(buffer).getUint32(off, true);
  const units = new Uint16Array(buffer, off + 4, n);
  let text = "";
  for (let i = 0; i < n; i += 4096) text += String.fromCharCode(...units.subarray(i, Math.min(n, i + 4096)));
  return { text, next: off + 4 + ((2 * n + 3) & ~3) };
}

/** A peer, as ACCEPT's and CONNECT's payload carry it: u32 family, u32
 * port, the address run. */
function netPeerPayload(family: string | undefined, port: number | undefined, address: string | undefined): Uint8Array {
  return netConcat([netU32(family === "IPv6" ? 6 : 4), netU32(port ?? 0), netRunBytes(address ?? "")]);
}

/** RESOLVE_DONE's payload: u32 count, then (u32 family, address run) each. */
function netResolvePayload(addresses: { address: string; family: number }[]): Uint8Array {
  return netConcat([netU32(addresses.length), ...addresses.flatMap((a) => [netU32(a.family), netRunBytes(a.address)])]);
}

/** A Node error's negative errno (an error with none is EIO). */
function netErrno(e: unknown): number {
  const n = (e as { errno?: unknown } | null)?.errno;
  return typeof n === "number" ? n : -5;
}

/** INC-29 U1 (review; abi.ts evPoll): one host loop iteration's net events
 * form one module poll phase. `stamp` gives a net event the host
 * iteration it was observed in — the counter advances in the check phase
 * of an iteration that queued one (`schedule` is setImmediate: armed by
 * that iteration's first event, never left armed while nothing arrives);
 * `beginPoll`, at every _loop call, takes the oldest iteration still
 * queued; `admits` holds back a later iteration's events for the next
 * poll phase. */
class NetBatchGate {
  private hostGen = 0;
  private closer = false;
  private pollGen = -1;
  constructor(private readonly schedule: (f: () => void) => void) {}
  /** A held event re-queued at READ_START: the next iteration's. */
  stampNext(ev: HostEvent): void {
    this.stamp(ev);
    if (ev.source === 2) ev.gen = this.hostGen + 1;
  }
  stamp(ev: HostEvent): void {
    if (ev.source !== 2) return;
    ev.gen = this.hostGen;
    if (this.closer) return;
    this.closer = true;
    this.schedule(() => {
      this.closer = false;
      this.hostGen++;
    });
  }
  beginPoll(queue: readonly HostEvent[]): void {
    this.pollGen = queue.find((e) => e.source === 2)?.gen ?? -1;
  }
  admits(ev: HostEvent): boolean {
    return ev.source !== 2 || ev.gen === undefined || ev.gen <= this.pollGen;
  }
}

interface NetHostDeps {
  memory: () => WebAssembly.Memory;
  push: (ev: HostEvent) => void;
  /** Drop every queued event `pred` matches. */
  purge: (pred: (ev: HostEvent) => boolean) => void;
  /** Remove and answer, in order, every queued event `pred` matches. */
  take: (pred: (ev: HostEvent) => boolean) => HostEvent[];
  /** A handle or request came into being (+1) or ended (-1). */
  live: (delta: number) => void;
  /** Re-queue a held event at READ_START (default: push). The batch gate
   * stamps it with the NEXT host iteration. */
  requeue?: (ev: HostEvent) => void;
}

interface NetRec {
  kind: "server" | "socket" | "resolve";
  server?: Server;
  sock?: Socket;
  reading: boolean;
  /** The host socket has been resumed once (its stream flows from then on;
   * reads are gated by `reading` through its _read). */
  started: boolean;
  held: HostEvent[];
  pendingWrite: boolean;
  connected: boolean;
}

/** The host stream handle's own read switch (libuv's uv_read_start /
 * uv_read_stop, as Node's net.Socket drives it). */
interface NetStreamHandle {
  reading: boolean;
  readStart(): number;
  readStop(): number;
}

function makeNetHost(deps: NetHostDeps): { netCall: (op: number, ptr: number, len: number, h: number, x: number) => number; delivered: (ev: HostEvent) => void; finish: () => void; open: () => number; socketOf: (h: number) => Socket | undefined } {
  const recs = new Map<number, NetRec>();
  let next = 1;
  let finished = false;
  const ev = (handle: number, kind: number, a: number, payload?: Uint8Array): HostEvent => ({
    source: 2,
    handle,
    kind,
    a: a | 0,
    b: 0,
    payload: payload ?? new Uint8Array(0),
  });
  const queue = (h: number, e: HostEvent): void => {
    const rec = recs.get(h);
    if (finished || rec === undefined) return;
    if (NET_READ_KINDS.has(e.kind) && !rec.reading) {
      rec.held.push(e);
      return;
    }
    deps.push(e);
  };
  const newRec = (r: Partial<NetRec> & { kind: NetRec["kind"] }): number => {
    const h = next++;
    recs.set(h, { reading: false, started: false, held: [], pendingWrite: false, connected: false, ...r });
    deps.live(1);
    return h;
  };
  const watch = (h: number, sock: Socket): void => {
    // The module decides when this socket reads (READ_START / READ_STOP):
    // the stream's own _read — the one place Node's net.Socket starts the
    // handle reading — runs only while the module has it reading, so the
    // host's Node never reads ahead of the module (and never sees a read
    // error the module would not have seen).
    const ownRead = sock._read.bind(sock);
    sock._read = (n: number): void => {
      if (recs.get(h)?.reading === true) ownRead(n);
    };
    sock.on("data", (chunk: Buffer) => queue(h, ev(h, NET_EV_DATA, 0, new Uint8Array(chunk))));
    sock.on("end", () => queue(h, ev(h, NET_EV_EOF, 0)));
    sock.on("error", (e: NodeJS.ErrnoException) => {
      const rec = recs.get(h);
      if (rec === undefined) return;
      if (e.syscall === "connect") {
        if (!rec.connected) {
          rec.connected = true;
          queue(h, ev(h, NET_EV_CONNECT, netErrno(e)));
        }
        return;
      }
      if (e.syscall === "write") {
        if (rec.pendingWrite) {
          rec.pendingWrite = false;
          queue(h, ev(h, NET_EV_WRITE_DONE, netErrno(e)));
        }
        return;
      }
      // Node's afterShutdown ignores the shutdown status; so does the
      // module (abi.ts SHUTDOWN), and it is never a read error.
      if (e.syscall === "shutdown") return;
      queue(h, ev(h, NET_EV_READ_ERROR, netErrno(e)));
    });
  };
  const socketOf = (h: number): NetRec | undefined => {
    const rec = recs.get(h);
    return rec?.kind === "socket" ? rec : undefined;
  };
  const netCall = (op: number, ptr: number, len: number, h: number, x: number): number => {
    const buffer = deps.memory().buffer;
    const dv = new DataView(buffer);
    switch (op) {
      case NET_OP_LISTEN: {
        const port = dv.getUint32(ptr, true);
        const family = dv.getUint32(ptr + 4, true);
        const flags = dv.getUint32(ptr + 8, true);
        const backlog = dv.getUint32(ptr + 12, true);
        const { text: address } = netReadRun(buffer, ptr + 16);
        const reply = (stage: number, boundPort: number, boundFamily: number, boundAddress: string): void => {
          const out = new DataView(deps.memory().buffer);
          out.setUint32(ptr, stage, true);
          out.setUint32(ptr + 4, boundPort, true);
          out.setUint32(ptr + 8, boundFamily, true);
          const run = netRunBytes(boundAddress);
          new Uint8Array(deps.memory().buffer, ptr + 12, run.length).set(run);
        };
        const createHandle = (netModuleNs as unknown as { _createServerHandle: (a: string, p: number, f: number, fd: undefined, flags: number) => unknown })._createServerHandle;
        // UV_TCP_IPV6ONLY is 1.
        const handle = createHandle(address, port, family, undefined, flags & 1);
        if (typeof handle === "number") {
          reply(1, 0, 0, "");
          return handle;
        }
        const server = netCreateServer({ allowHalfOpen: true, pauseOnConnect: true });
        server.on("error", () => {});
        let listenErrno: number | undefined;
        const onListenError = (m: unknown): void => {
          const msg = m as { server?: unknown; error?: unknown };
          if (msg.server === server) listenErrno = netErrno(msg.error);
        };
        dcSubscribe("tracing:net.server.listen:error", onListenError);
        try {
          server.listen(handle as never, backlog);
        } finally {
          dcUnsubscribe("tracing:net.server.listen:error", onListenError);
        }
        if (listenErrno !== undefined) {
          reply(2, 0, 0, "");
          return listenErrno;
        }
        const bound = server.address();
        if (bound === null || typeof bound === "string") throw new Error("netCall: a listening server with no address");
        const sh = newRec({ kind: "server", server });
        server.on("connection", (sock: Socket) => {
          if (finished || !recs.has(sh)) {
            sock.destroy();
            return;
          }
          const ch = newRec({ kind: "socket", sock });
          watch(ch, sock);
          deps.push(ev(sh, NET_EV_ACCEPT, ch, netPeerPayload(sock.remoteFamily, sock.remotePort, sock.remoteAddress)));
        });
        reply(0, bound.port, bound.family === "IPv6" ? 6 : 4, bound.address);
        return sh;
      }
      case NET_OP_CONNECT: {
        const port = dv.getUint32(ptr, true);
        const family = dv.getUint32(ptr + 4, true);
        const { text: address } = netReadRun(buffer, ptr + 8);
        const sock = new Socket({ allowHalfOpen: true });
        sock.pause();
        const ch = newRec({ kind: "socket", sock });
        watch(ch, sock);
        sock.on("connect", () => {
          const rec = recs.get(ch);
          if (rec === undefined || rec.connected) return;
          rec.connected = true;
          queue(ch, ev(ch, NET_EV_CONNECT, 0, netPeerPayload(sock.remoteFamily, sock.remotePort, sock.remoteAddress)));
        });
        sock.connect({ port, host: address, family, autoSelectFamily: false });
        return ch;
      }
      case NET_OP_READ_START: {
        const rec = socketOf(h);
        if (rec === undefined) throw new Error(`netCall: READ_START of handle ${h}, not an open socket`);
        if (!rec.reading) {
          rec.reading = true;
          const held = rec.held;
          rec.held = [];
          // libuv would read these in a later iteration than this one.
          for (const e of held) (deps.requeue ?? deps.push)(e);
          const sock = rec.sock!;
          if (!rec.started) {
            rec.started = true;
            sock.resume();
          } else if (!sock.destroyed) {
            sock._read(0);
          }
        }
        return 0;
      }
      case NET_OP_READ_STOP: {
        const rec = socketOf(h);
        if (rec === undefined) throw new Error(`netCall: READ_STOP of handle ${h}, not an open socket`);
        if (rec.reading) {
          rec.reading = false;
          // uv_read_stop on the host's handle, now: no read past this
          // point until the next READ_START.
          const handle = (rec.sock as unknown as { _handle: NetStreamHandle | null })._handle;
          if (handle !== null && handle.reading) {
            handle.reading = false;
            handle.readStop();
          }
          rec.held = deps.take((e) => e.source === 2 && e.handle === h && NET_READ_KINDS.has(e.kind));
        }
        return 0;
      }
      case NET_OP_WRITE: {
        const rec = socketOf(h);
        if (rec === undefined) throw new Error(`netCall: WRITE to handle ${h}, not an open socket`);
        const sock = rec.sock!;
        // A host socket its Node already destroyed: the kernel would refuse
        // this write too — with the error the socket died of (ECONNRESET
        // after an RST, ...), else EPIPE, as write(2) answers on a socket
        // whose peer is gone.
        if (sock.destroyed) return sock.errored ? netErrno(sock.errored) : -32;
        const data = Buffer.from(new Uint8Array(buffer, ptr, len));
        const before = sock.errored;
        sock.write(data, (err) => {
          const r = recs.get(h);
          if (r === undefined || !r.pendingWrite) return;
          r.pendingWrite = false;
          queue(h, ev(h, NET_EV_WRITE_DONE, err ? netErrno(err) : 0));
        });
        const after = sock.errored;
        if (after !== null && after !== before) return netErrno(after);
        if (sock.writableLength === 0) return 0;
        rec.pendingWrite = true;
        return 1;
      }
      case NET_OP_SHUTDOWN: {
        const rec = socketOf(h);
        if (rec === undefined) throw new Error(`netCall: SHUTDOWN of handle ${h}, not an open socket`);
        // uv_shutdown's own refusal: a stream no longer writable is
        // ENOTCONN. Otherwise accepted (0): the host shuts the write side
        // down and the module completes the request in its own pending
        // pass (abi.ts SHUTDOWN), as libuv does.
        const sock = rec.sock!;
        if (sock.destroyed || !sock.writable) return -107;
        sock.end();
        return 0;
      }
      case NET_OP_CLOSE: {
        const rec = recs.get(h);
        if (rec === undefined || rec.kind === "resolve") throw new Error(`netCall: CLOSE of handle ${h}, not an open handle`);
        recs.delete(h);
        deps.live(-1);
        deps.purge((e) => {
          if (e.source !== 2 || e.handle !== h) return false;
          if (e.kind === NET_EV_ACCEPT) {
            const carried = recs.get(e.a);
            if (carried !== undefined) {
              carried.sock?.destroy();
              recs.delete(e.a);
              deps.live(-1);
            }
          }
          return true;
        });
        if (rec.kind === "socket") rec.sock!.destroy();
        else rec.server!.close();
        return 0;
      }
      case NET_OP_NODELAY: {
        const rec = socketOf(h);
        if (rec === undefined) throw new Error(`netCall: NODELAY of handle ${h}, not an open socket`);
        rec.sock!.setNoDelay(x !== 0);
        return 0;
      }
      case NET_OP_RESOLVE: {
        const family = dv.getUint32(ptr, true);
        const hints = dv.getUint32(ptr + 4, true);
        const { text: name } = netReadRun(buffer, ptr + 8);
        const rh = newRec({ kind: "resolve" });
        dnsLookup(name, { all: true, family: family as 0 | 4 | 6, hints, order: "verbatim" }, (err, addresses) => {
          if (finished || !recs.has(rh)) return;
          deps.push(ev(rh, NET_EV_RESOLVE_DONE, err ? netErrno(err) : 0, err ? undefined : netResolvePayload(addresses)));
        });
        return rh;
      }
      default:
        throw new Error(`netCall: unknown op ${op}`);
    }
  };
  return {
    netCall,
    // The module read a RESOLVE_DONE: that request is over.
    delivered(e: HostEvent): void {
      if (e.source === 2 && e.kind === NET_EV_RESOLVE_DONE && recs.get(e.handle)?.kind === "resolve") {
        recs.delete(e.handle);
        deps.live(-1);
      }
    },
    finish(): void {
      finished = true;
      for (const rec of recs.values()) {
        if (rec.kind === "socket") rec.sock!.destroy();
        else if (rec.kind === "server") rec.server!.close();
      }
      recs.clear();
    },
    open: (): number => recs.size,
    // For the unit rows: the host socket behind a handle.
    socketOf: (h: number): Socket | undefined => recs.get(h)?.sock,
  };
}

async function runWasm(modulePath: string): Promise<RunResult> {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  // wallBase, sampled ONCE per run, BEFORE instantiation (INC-25 P6, C-4).
  const wallBase = Date.now();
  // uptimeBase, sampled ONCE per run, BEFORE instantiation (INC-26 P3-F2,
  // gate round P3-F1's own follow-up correction) — the SAME shape as
  // wallBase directly above. The compiled module IS its own process on
  // the wasm lane (the ABI's own doctrine), so `process.uptime()` must
  // answer time since THIS run's own instantiation, never the shared
  // harness process's own cumulative uptime across the whole 1077-
  // program census: serving the latter made 2314-process-introspection
  // .ts's own `uptime < 120` bound fail once the harness had been
  // running long enough (a real defect this pass found via a genuine,
  // reproducible census failure, not assumed from a flake report).
  const uptimeBase = process.uptime();
  // INC-26 P4, rider R-B (board #144; host-facts.ts's own header) — the
  // SAME per-instance-baseline shape as `uptimeBase` directly above,
  // generalized to cpuUsage/threadCpuUsage/resourceUsage's own twelve
  // cumulative fields (maxRSS and the three always-zero-on-Linux memory-
  // size fields pass through raw, host-facts.ts's own stated exceptions).
  // Sampled ONCE, HERE, before `WebAssembly.instantiate` — `uptimeBase`'s
  // own ordering.
  const hostFacts = makeHostFacts((): HostFactSnapshot => {
    const cpu = process.cpuUsage();
    const threadCpu = process.threadCpuUsage();
    const ru = process.resourceUsage();
    return {
      cpuUser: cpu.user,
      cpuSystem: cpu.system,
      threadCpuUser: threadCpu.user,
      threadCpuSystem: threadCpu.system,
      rusage: [
        ru.userCPUTime,
        ru.systemCPUTime,
        ru.maxRSS,
        ru.sharedMemorySize,
        ru.unsharedDataSize,
        ru.unsharedStackSize,
        ru.minorPageFault,
        ru.majorPageFault,
        ru.swappedOut,
        ru.fsRead,
        ru.fsWrite,
        ru.ipcSent,
        ru.ipcReceived,
        ru.signalsCount,
        ru.voluntaryContextSwitches,
        ru.involuntaryContextSwitches,
      ],
    };
  });
  // INC-26 P1 (design §3G, S070): argv = ["scriptc", <the module path>] —
  // TWO non-empty strings, matching the native lanes' own shape (S070's
  // register entry). env = THIS harness process's real environment,
  // snapshotted ONCE per run (matching the module's own once-at-first-
  // touch snapshot contract, D2) — already carrying
  // SCRIPTC_TEST_ENV=from-harness from this file's own module-load-time
  // assignment above (line 61), so 998/1465's value-exact pins hold
  // without any extra wiring here.
  const argv: readonly string[] = ["scriptc", modulePath];
  const envPairs: readonly (readonly [string, string])[] = Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined,
  );
  const platform = process.platform;
  const cwd = process.cwd();
  const writeUtf16 = (s: string, ptr: number, cap: number): number => {
    const len = s.length;
    if (len > cap) return len;
    const view = new Uint16Array(memory!.buffer, ptr, len);
    for (let i = 0; i < len; i++) view[i] = s.charCodeAt(i);
    return len;
  };
  // INC-26 P4 — fsCall's own INBOUND read (module -> host): the reverse
  // of `writeUtf16` above, and of hostStr's own outbound direction.
  const readUtf16 = (ptr: number, len: number): string => {
    const view = new Uint16Array(memory!.buffer, ptr, len);
    return String.fromCharCode(...view);
  };
  // N-3 (CP1 delta): the CLEANUP set — every path THIS RUN created. NOT
  // the complete list of every path this run TOUCHED (several corpus
  // programs clean up a PREDECESSOR's leftover scratch first, which the
  // PERMISSION test (guardDestructive, screening on LOCATION) admits
  // without this run having created it) — two deliberately different
  // sets, per N-3's own text.
  const createdPaths = new Set<string>();
  // P5 (design §6.2, brief §3D): the per-run fd table — the module holds
  // fd numbers as opaque f64 handles; the host hands back its OWN real
  // OS-level fd from openSync and operates directly on it thereafter (no
  // translation needed — Node's real fd numbers are already the small
  // integers the module treats as opaque). SAME closure as createdPaths,
  // SAME finally (a real OS fd is a SHARED, PROCESS-WIDE resource across
  // the whole 1077-program census — a program that traps mid-run must
  // not leak one into every later program's own fd space).
  const openFds = new Set<number>();
  // P5 (design §3.5, brief §3D): os.networkInterfaces' own JSON document
  // — ONE real snapshot, captured lazily on first touch and reused for
  // the rest of THIS run (never re-queried: the harness's own interface
  // set can change between the oracle child's own call and this
  // in-process run — R-6/A-9's own measured flake axis with no bug; a
  // snapshot avoids observing that drift mid-run at least).
  let netIfSnapshot: string | null = null;
  // INC-28 U1 (abi.ts cpCall): every finished child this run started,
  // behind its handle; cleared in the finally below and required EMPTY
  // after a clean run (no trap, no exit) — the module FREEs every handle
  // it RUNs on every path that returns.
  const cpHandles = new Map<number, CpResult>();
  let cpNextHandle = 0;
  let cleanRun = false;
  // INC-28 U2 (abi.ts evPoll, cpCall ops 5-8): an EVENT MODULE (one that
  // imports evPoll) gets the event host — children started with Node's own
  // public spawn(), their events queued for the module's poll phase, and a
  // clock that is REAL time while any child is live (abi.ts's loop
  // contract). Every other module keeps the virtual clock and the
  // synchronous pump below, unchanged.
  const wasmModule = await WebAssembly.compile(readFileSync(modulePath));
  const eventModule = WebAssembly.Module.imports(wasmModule).some((i) => i.module === "tsinter" && i.name === "evPoll");
  const evChildren = new Map<number, EvChild>();
  const evQueue: HostEvent[] = [];
  let evNextHandle = 1;
  let evLive = 0;
  let evAnchorV = 0;
  let evAnchorR = 0;
  let evWaker: (() => void) | null = null;
  let evFinished = false;
  const clockNow = (): number =>
    clockFor({ vclock: clock, live: evLive, anchorV: evAnchorV, anchorR: evAnchorR, nowR: performance.now() });
  // INC-28 U3 (abi.ts evPoll, the kind word's bit 8): the host's callback
  // SCOPE — open from the first EXIT, DATA or END queued in one of the host
  // Node's callbacks until that callback's ticks and microtasks have
  // drained (a microtask queued at the first event runs only then). Each
  // such event queued while it is open marks the one before it: the module
  // runs no checkpoint between them, as Node runs none.
  let evScopeLast: HostEvent | null = null;
  // INC-29 U1 (review; abi.ts evPoll): each module poll phase delivers
  // only the net events of the oldest host loop iteration still queued.
  const evGate = new NetBatchGate((f) => setImmediate(f));
  const evPush = (ev: HostEvent): void => {
    if (evFinished) return;
    evGate.stamp(ev);
    // INC-29 U1: the scope bit is the children's (source 1) only.
    if (ev.source === 1 && (ev.kind === 1 || ev.kind === 4 || ev.kind === 5 || ev.kind === 6)) {
      if (evScopeLast !== null) {
        evScopeLast.kind |= 0x100;
      } else {
        queueMicrotask(() => {
          evScopeLast = null;
        });
      }
      evScopeLast = ev;
    }
    evQueue.push(ev);
    evWaker?.();
  };
  // INC-29 U1 (abi.ts netCall, evPoll source 2): the net host. Its handles
  // count as live for the clock exactly as children do: while any socket,
  // server or lookup is open the clock is real time.
  const evLiveAdd = (delta: number): void => {
    if (delta > 0 && evLive === 0) {
      evAnchorV = clock;
      evAnchorR = performance.now();
    }
    const t = clockNow();
    evLive += delta;
    if (delta < 0 && evLive === 0) clock = Math.max(clock, t);
  };
  const netHost = makeNetHost({
    memory: () => {
      if (memory === null) throw new Error("netCall before instantiation completed");
      return memory;
    },
    push: evPush,
    purge: (pred) => {
      for (let i = evQueue.length - 1; i >= 0; i--) if (pred(evQueue[i]!)) evQueue.splice(i, 1);
    },
    take: (pred) => {
      const taken: HostEvent[] = [];
      for (let i = 0; i < evQueue.length; ) {
        if (pred(evQueue[i]!)) taken.push(...evQueue.splice(i, 1));
        else i++;
      }
      return taken;
    },
    live: evLiveAdd,
    requeue: (ev) => {
      if (evFinished) return;
      evGate.stampNext(ev);
      evQueue.push(ev);
      evWaker?.();
    },
  });
  // SPAWN: public spawn() inside ONE synchronous span with the documented
  // tracing channel subscribed for exactly that span (never at module
  // scope: a subscriber makes every spawn in the worker publish), matched
  // to the ChildProcess this call creates; the failure's errno is reset
  // for every call.
  const evSpawn = (req: SpawnRequest, ptr: number, buffer: ArrayBufferLike): number => {
    if (req.stdinMode !== 0 && req.stdinMode !== 1) throw new Error(`cpCall: unknown stdin mode ${req.stdinMode}`);
    const routes = [stdioRouteFor(1, req.stdoutMode, req.outFd, openFds), stdioRouteFor(2, req.stderrMode, req.errFd, openFds)];
    // INC-28 U3: a piped slot beside an inherited or fd output slot is
    // refused by the module at compile time (cp.spawnOpts:pipeMixed).
    if (routes.includes("pipe") && routes.some((r) => r !== "pipe" && r !== "ignore")) {
      throw new Error("cpCall: a piped slot mixed with an inherited or fd output slot");
    }
    const reply = (errno: number, disposition: number, pid: number): void => {
      const dv = new DataView(buffer, ptr, 12);
      dv.setInt32(0, errno, true);
      dv.setInt32(4, disposition, true);
      dv.setInt32(8, pid, true);
    };
    // A descriptor this run did not open: Node's own throw, EBADF, and no
    // child (the harness never hands a child one of its own descriptors).
    if (routes.includes("EBADF")) {
      reply(-9, 2, 0);
      return 0;
    }
    // A FIFO in a directory of this call's own: its read end (opened
    // first, non-blocking) and its write end.
    const fifoPair = (): { reader: number; writer: number } => {
      const dir = mkdtempSync(join(tmpdir(), "u2-fifo-"));
      const fifo = join(dir, "p");
      try {
        const made = spawnSync("mkfifo", [fifo]);
        if (made.status !== 0) throw new Error("cpCall: mkfifo failed");
        const reader = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        const writer = openSync(fifo, fsConstants.O_WRONLY);
        return { reader, writer };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const tempFds: number[] = [];
    // Both output slots naming the same program stream (fd 2 twice, fd 1
    // twice, or "inherit" plus that stream's number) share ONE pipe, as
    // they share one descriptor under Node: the child's writes through
    // either keep the order it made them in.
    const [r1, r2] = routes;
    const sharedDest =
      typeof r1 === "object" && "capture" in r1 && typeof r2 === "object" && "capture" in r2 && r1.capture === r2.capture ? r1.capture : null;
    let sharedReader: number | null = null;
    if (sharedDest !== null) {
      const { reader, writer } = fifoPair();
      sharedReader = reader;
      tempFds.push(writer);
    }
    const slotStdio = routes.map((r): "ignore" | "pipe" | number => {
      if (r === "ignore") return "ignore";
      if (r === "pipe") return "pipe";
      // fd 0 in an output slot: the write end of a pipe whose read end is
      // already closed.
      if (r === "fd0-pipe") {
        const { reader, writer } = fifoPair();
        closeSync(reader);
        tempFds.push(writer);
        return writer;
      }
      if (typeof r === "object" && "fd" in r) return r.fd;
      if (sharedDest !== null) return tempFds[0]!;
      return "pipe";
    });
    const env: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [k, v] of req.env) env[k] = v;
    let created: unknown;
    let dcErrno: number | undefined;
    const onStart = (msg: unknown): void => {
      if (created === undefined) created = (msg as { process?: unknown }).process;
    };
    const onError = (msg: unknown): void => {
      const m = msg as { process?: unknown; error?: { errno?: unknown } };
      if (created !== undefined && m.process === created && typeof m.error?.errno === "number") dcErrno = m.error.errno;
    };
    let proc: ChildProcess | undefined;
    let threw = false;
    dcSubscribe("tracing:child_process.spawn:start", onStart);
    dcSubscribe("tracing:child_process.spawn:error", onError);
    try {
      proc = spawn(req.file, req.argv, {
        stdio: ["ignore", slotStdio[0]!, slotStdio[1]!],
        env,
        ...(req.cwd === "" ? {} : { cwd: req.cwd }),
        detached: req.detached !== 0,
        windowsHide: true,
      });
    } catch {
      threw = true;
    } finally {
      dcUnsubscribe("tracing:child_process.spawn:start", onStart);
      dcUnsubscribe("tracing:child_process.spawn:error", onError);
      for (const fd of tempFds) closeSync(fd);
    }
    const d = dispositionFor({ threw, dcErrno, pid: proc?.pid });
    if (sharedReader !== null && (d === null || d.disposition !== 0)) {
      closeSync(sharedReader);
      sharedReader = null;
    }
    if (d === null) throw new Error(`cpCall: a spawn outcome the module's own validation should have prevented (${req.file})`);
    // INC-28 U3: a failed spawn reported later still has its piped streams
    // (Node creates them, and they end), so it gets a handle too.
    const anyPipe = routes.includes("pipe");
    const handle = d.disposition === 0 || (d.disposition === 1 && anyPipe) ? evNextHandle++ : 0;
    if (proc !== undefined) {
      const rec: EvChild = {
        proc,
        live: handle !== 0,
        errorErrno: undefined,
        shared: null,
        exitRead: d.disposition !== 0,
        endsUnread: 0,
        pipes: [null, null],
        flowing: [false, false],
        held: [false, false],
      };
      const signals = osConstants.signals as Record<string, number>;
      proc.on("error", (e: NodeJS.ErrnoException) => {
        rec.errorErrno = typeof e.errno === "number" ? e.errno : undefined;
      });
      // The EXIT is queued on 'close': after every captured stream has
      // reached end of file (the shared pipe's too), so the child's output
      // precedes its exit. INC-28 U3: a child with a piped stream (never
      // mixed with a captured one) queues it at its 'exit' instead, in the
      // order Node emits it among the piped streams' events.
      let exitEv: HostEvent | null = null;
      let sharedOpen = sharedReader !== null;
      const queueExit = (): void => {
        if (exitEv !== null && !sharedOpen && rec.live) {
          evPush(exitEv);
          exitEv = null;
        }
      };
      proc.on(anyPipe ? "exit" : "close", (code: number | null, signal: NodeJS.Signals | null) => {
        exitEv = { source: 1, handle, kind: 1, a: code ?? -1, b: signal === null ? 0 : (signals[signal] ?? 0), payload: new Uint8Array(0) };
        queueExit();
        // INC-28 U3: Node's onexit queues flushStdio right after this
        // 'exit', which resumes every piped stream nobody consumed — its
        // buffered and later chunks flow to whatever 'data' listener the
        // program has by then (one added in its 'exit' listener, or a tick
        // after). The host reads each such stream from now on (kind 6,
        // STREAM-HELD) and the module, which knows its listeners, emits or
        // drops each chunk where Node's flow() would.
        if (anyPipe) {
          rec.pipes.forEach((stream, i) => {
            if (stream === null || rec.flowing[i]) return;
            rec.flowing[i] = true;
            rec.held[i] = true;
            stream.on("data", (chunk: Buffer) => {
              if (!rec.live) return;
              evPush({ source: 1, handle, kind: 6, a: i + 1, b: 0, payload: new Uint8Array(chunk) });
            });
          });
        }
      });
      if (sharedReader !== null && sharedDest !== null) {
        const sock = new Socket({ fd: sharedReader, readable: true, writable: false });
        rec.shared = sock;
        const kind = sharedDest === 1 ? 2 : 3;
        sock.on("data", (chunk: Buffer) => {
          if (!rec.live) return;
          evPush({ source: 1, handle, kind, a: 0, b: 0, payload: new Uint8Array(chunk) });
        });
        sock.on("error", () => {});
        sock.on("close", () => {
          sharedOpen = false;
          queueExit();
        });
      }
      // Captured output, queued as it arrives, named by destination.
      [proc.stdout, proc.stderr].forEach((stream, i) => {
        const r = routes[i]!;
        if (stream === null || typeof r !== "object" || !("capture" in r)) return;
        const kind = r.capture === 1 ? 2 : 3;
        stream.on("data", (chunk: Buffer) => {
          if (!rec.live) return;
          evPush({ source: 1, handle, kind, a: 0, b: 0, payload: new Uint8Array(chunk) });
        });
      });
      // INC-28 U3: the piped streams. Their 'end' is forwarded always (it
      // never changes how the stream reads); their 'data' only once FLOW
      // attaches the host's listener (cpCall op 9), so the stream starts
      // flowing exactly when the program's would.
      [proc.stdout, proc.stderr].forEach((stream, i) => {
        if (routes[i] !== "pipe" || stream === null || handle === 0) return;
        rec.pipes[i] = stream;
        rec.endsUnread++;
        stream.on("end", () => {
          if (!rec.live) return;
          evPush({ source: 1, handle, kind: 5, a: i + 1, b: 0, payload: new Uint8Array(0) });
        });
      });
      if (handle !== 0) {
        if (evLive === 0) {
          evAnchorV = clock;
          evAnchorR = performance.now();
        }
        evLive++;
        evChildren.set(handle, rec);
      }
    }
    reply(d.errno, d.disposition, proc?.pid ?? 0);
    return handle;
  };
  // One host loop turn: resolves ONLY from a host setImmediate callback
  // (the check phase, after a poll phase in which libuv reaps every child
  // that has exited) once an event is queued or the clock has reached
  // `due` — never from inside one of the host's own listeners, which would
  // split a batch reaped together.
  const evTurn = (due: number): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = (): void => {
        if (done) return;
        if (evFinished || evQueue.length > 0 || clockNow() >= due) {
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          evWaker = null;
          resolve();
          return;
        }
        if (Number.isFinite(due) && timer === undefined) {
          timer = setTimeout(
            () => {
              timer = undefined;
              setImmediate(check);
            },
            Math.max(1, Math.ceil(due - clockNow())),
          );
        }
      };
      evWaker = (): void => {
        setImmediate(check);
      };
      // Two hops. libuv reaps exited children only inside its poll phase,
      // and this function can be called from a promise continuation that
      // runs INSIDE a poll phase; a single setImmediate scheduled there
      // runs in that iteration's check phase, before any further poll, and
      // would miss a child that exited while the module ran. The first hop
      // reaches a check phase; the second runs in the next iteration's
      // check phase, after a full poll. (The wakes above are single hops:
      // they are scheduled from the poll or the timers phase.)
      setImmediate(() => setImmediate(check));
    });
  const instance = await WebAssembly.instantiate(wasmModule, {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (fd !== 1 && fd !== 2) throw new Error(`write to unknown fd ${fd}`);
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
      // Timer modules only; wasm ignores an import it never declared. An
      // event module reads the live clock at the call (abi.ts).
      now: eventModule ? (): number => clockNow() : (): number => clock,
      // Math.random modules only (INC-25 P1, abi.ts §8.1). Serviced from
      // a CSPRNG so NO corpus program can depend on a fixed sequence —
      // the seed pin (wasm-random.test.ts) uses its own host instead.
      seed: (): bigint => randomBytes(8).readBigUInt64BE(),
      // date.now modules only (INC-25 P6, D3/D6-iv, C-4). MUST be a
      // VIRTUAL wall clock in lockstep with the virtual timer clock
      // above, never the real clock: this harness's timer clock starts
      // at 0 and never sleeps (the pump jumps it straight to each
      // deadline), so 1582 measures a 20ms `setTimeout` in microseconds
      // of real time — a real-time `wallClock` host would print `false`
      // where Node prints `true` for that exact assertion. `wallBase`
      // is real (sampled once, above) so 1422's window rows still hold.
      wallClock: eventModule ? (): number => wallBase + clockNow() : (): number => wallBase + clock,
      // INC-26 P1 (abi.ts §2.2/§2.4/§3G): every HOST-FACT string, by kind
      // (abi.ts's own kind table — argv=0, envKey=1, envValue=2, cwd=3,
      // platform=4; kinds this pass does not consume are unreachable
      // here, since the module never mints hostStr unless it needs one
      // of these). `index` past the end answers -1 ("no such datum"),
      // abi.ts's own contract, distinct from an empty string (len 0).
      hostStr(kind: number, index: number, ptr: number, cap: number): number {
        if (memory === null) throw new Error("hostStr before instantiation completed");
        switch (kind) {
          case 0:
            return index < 0 || index >= argv.length ? -1 : writeUtf16(argv[index]!, ptr, cap);
          case 1:
            return index < 0 || index >= envPairs.length ? -1 : writeUtf16(envPairs[index]![0], ptr, cap);
          case 2:
            return index < 0 || index >= envPairs.length ? -1 : writeUtf16(envPairs[index]![1], ptr, cap);
          case 3:
            return writeUtf16(cwd, ptr, cap);
          case 4:
            return writeUtf16(platform, ptr, cap);
          // INC-26 P3 (design §11): THE VALUE PRINTS for arch/versions —
          // the real host, on the same machine, at the same moment,
          // licenses every row that prints one (1531/1639).
          case 5:
            return writeUtf16(process.arch, ptr, cap);
          case 6:
            return writeUtf16(process.versions.node, ptr, cap);
          case 7:
            return writeUtf16(process.versions.openssl ?? "", ptr, cap);
          case 12:
            return writeUtf16(process.execPath, ptr, cap);
          // INC-26 P4 (design §3.5/§11): THE VALUES PRINT for tmpdir/
          // homedir — the real host, on the same machine, at the same
          // moment, licenses 1353/2631 (tmpdir) and any future homedir
          // print exactly as arch/versions/execPath already do above.
          case 8:
            return writeUtf16(tmpdir(), ptr, cap);
          case 9:
            return writeUtf16(homedir(), ptr, cap);
          // INC-26 P5 (design §3.5, abi.ts's own kind numbers): os.type/
          // os.release/os.userInfo's three string fields — THE VALUE
          // PRINTS, arch/versions/execPath's own precedent (P3) restated:
          // the real host, on the same machine, at the same moment.
          case 10:
            return writeUtf16(osType(), ptr, cap);
          case 11:
            return writeUtf16(release(), ptr, cap);
          case 13:
            return writeUtf16(userInfo().username, ptr, cap);
          case 14:
            return writeUtf16(userInfo().homedir, ptr, cap);
          case 15:
            return writeUtf16(userInfo().shell ?? "", ptr, cap);
          // os.networkInterfaces (design §3.5, M-14): a JSON DOCUMENT, ONE
          // real snapshot per run (`netIfSnapshot`, declared beside
          // `createdPaths`/`openFds` above), captured lazily and reused —
          // never re-queried mid-run (R-6/A-9's own measured flake axis:
          // the interface set can change between the oracle child's own
          // call and this in-process run — a snapshot cannot observe that
          // drift, which is the point).
          case 16:
            if (netIfSnapshot === null) netIfSnapshot = JSON.stringify(networkInterfaces());
            return writeUtf16(netIfSnapshot, ptr, cap);
          default:
            throw new Error(`hostStr: unknown kind ${kind}`);
        }
      },
      // abi.ts's hostNum kind table — argc=0, env pair count=1. INC-26 P3
      // adds kinds 2-14 (design §11): the harness process's OWN facts —
      // isTTY false for 0/1/2 (sound: the oracle also runs under
      // execFile with pipes, so Node answers non-TTY too — LICENSES 1425
      // and 1571-stdin-set-raw-mode); columns "no width" (-1) for 1/2
      // (LICENSES 1448 entirely); uptime/cpu/rusage/memory are the
      // harness process's own counters, with maxRSS STRICTLY > 0 (§2.3's
      // own written constraint). `arg` is a NEW second parameter — every
      // hostNum stub in the tree took only `kind` before this pass
      // (isTTY(fd)/columns(fd)/rusage(idx) are the first three kinds that
      // need it).
      hostNum(kind: number, arg: number): number {
        switch (kind) {
          case 0:
            return argv.length;
          case 1:
            return envPairs.length;
          case 2:
            return process.pid;
          case 3:
            return process.getuid ? process.getuid() : 0;
          case 4:
            return process.getgid ? process.getgid() : 0;
          case 5: // isTTY(fd = arg)
            return 0;
          case 6: // columns(fd = arg)
            return -1;
          case 7:
            // Per-instantiation, not per-harness-process — see
            // `uptimeBase`'s own comment above (INC-26 P3-F2).
            return process.uptime() - uptimeBase;
          case 8: // cpuUsage.user
          case 9: // cpuUsage.system
          case 10: // threadCpuUsage.user
          case 11: // threadCpuUsage.system
          case 14: // rusage field `arg`
            // INC-26 P4 rider R-B (board #144): PER-INSTANTIATION, not
            // per-harness-process — host-facts.ts's own baseline-and-
            // delta shape, `uptimeBase`'s doctrine generalized.
            return hostFacts.hostNumFor(kind, arg);
          case 12:
            return process.availableMemory();
          case 13:
            return process.constrainedMemory() ?? 0;
          // INC-26 P5 (design §3.5, abi.ts's own hostNum kind 15):
          // os.totalmem — THE VALUE PRINTS, the same real-host stance as
          // hostStr's arch/versions/execPath (P3) and os.type/os.release
          // (P5) above.
          case 15:
            return totalmem();
          default:
            throw new Error(`hostNum: unknown kind ${kind}`);
        }
      },
      // abi.ts §2.5: the host TERMINATES by throwing a sentinel the catch
      // below recognises BEFORE the RuntimeError test — a trap and an
      // exit are different channels.
      exit(code: number): void {
        throw new WasmExitSignal(code);
      },
      // INC-26 P3 (design §2.7/§11, brief §3C, CP1 delta E-5's refined
      // guard): `process.kill` of the HARNESS process — a HARNESS SAFETY
      // GUARD, never a semantic one. The ABI crosses NUMBERS (the module
      // already resolved any name), so this reasons about LIVENESS:
      //   pid <= 0            -> LOUD (0/-1 broadcast to a process group)
      //   sig === 0           -> deliver (an existence probe is harmless)
      //   pid === process.pid -> deliver iff sig === 28 (SIGWINCH,
      //                          default-ignored — 1461's own two
      //                          self-directed shapes), else LOUD
      //   otherwise           -> probe first (kill(pid, 0)); deliver ONLY
      //                          if that probe itself answers ESRCH (the
      //                          pid does not exist); a LIVE non-self pid
      //                          is refused LOUDLY rather than signalled.
      // Maps success to 0, `.code` to kill's OWN 3-code enumeration
      // (-1/-2/-3), anything else to -(256 + the raw platform errno).
      kill(pid: number, sig: number): number {
        const loud = (why: string): never => {
          throw new Error(`HARNESS SAFETY GUARD: refusing to deliver a real signal (pid=${pid}, sig=${sig}) for ${modulePath} — ${why}`);
        };
        const doKill = (): number => {
          try {
            process.kill(pid, sig);
            return 0;
          } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ESRCH") return -1;
            if (err.code === "EPERM") return -2;
            if (err.code === "EINVAL") return -3;
            // delta-3e E-6: an errno-less error here would silently carry
            // as -(256+-0) = -256, decoded by the module as "kill E0" — a
            // string no lane ever produces. Unreachable today (a valid
            // int32 pid+signal either succeeds or throws a NAMED errno
            // error), which is exactly when a fabricated answer should be
            // a loud harness failure instead.
            if (typeof err.errno !== "number") {
              loud(`kill threw an error with no .errno: ${String(err.code)}`);
            }
            return -(256 + -err.errno!);
          }
        };
        if (pid <= 0) loud("pid <= 0 broadcasts to a process group");
        if (sig === 0) return doKill();
        if (pid === process.pid) {
          if (sig === 28) return doKill();
          loud("a real, non-zero, non-SIGWINCH signal to the harness's OWN process");
        }
        // Any other pid: probe first. Only an ESRCH probe licenses the
        // real call (the pid genuinely does not exist); a live pid is
        // refused loudly rather than signalled for real.
        try {
          process.kill(pid, 0);
          loud(`pid ${pid} is a LIVE process — refusing to deliver a real signal to it`);
        } catch (probeErr) {
          const probeCode = (probeErr as NodeJS.ErrnoException).code;
          if (probeCode !== "ESRCH") loud(`the existence probe for pid ${pid} answered ${String(probeCode)}, not ESRCH`);
        }
        return doKill();
      },
      // INC-26 P3 (design §3C, B-5): `chdir`/`umask` are RECORDING STUBS
      // that answer success and MUTATE NOTHING — the wasm lane runs
      // IN-PROCESS (this function, called directly — no child), and a
      // real chdir/umask would move the vitest worker's own cwd/file-mode
      // mask under EVERY LATER program (990/1352/1612 print or pin the
      // cwd). Both keys have ZERO corpus reach (rev-d10-p3.out b32fe774);
      // the module-level counters below are the POSITIVE PROOF of that
      // zero-reach claim, asserted in "the process tail: chdir/umask are
      // never reached" below.
      chdir(_ptr: number, _len: number): number {
        chdirCallCount++;
        return 0;
      },
      umask(_isRead: number, _mask: number): number {
        umaskCallCount++;
        return 0o22;
      },
      // INC-26 P4 (design §6.4, brief §3E) — the fsCall adapter. Dispatches
      // to `node:fs` IN-PROCESS. Every DESTRUCTIVE op resolves its path via
      // N-1's ancestor-realpath fix and screens it through the root-set
      // guard BEFORE touching the real filesystem; a refusal throws LOUDLY
      // (never silently declines), naming the program.
      fsCall(op: number, aPtr: number, aLen: number, bPtr: number, bLen: number, x: number, y: number): number {
        const pathA = readUtf16(aPtr, aLen);
        try {
          switch (op) {
            case 1: {
              // readFileSync (x=0, UTF-16 text) / readFileSyncBytes +
              // fsp.readFileBytes (x=1, RAW BYTES) — SHARED row (delta-3d
              // a3c02af9's own bytes flag, ruling on this pass's own
              // STOP-AND-REPORT + rev-26's confirming read): the wire
              // call was byte-for-byte identical between the two keys
              // before this flag existed, with INCOMPATIBLE slot-B
              // encodings and DIFFERENT capacity units — read-only, no
              // guard either way.
              if (x === 1) {
                const buf = readFileSync(pathA);
                if (buf.length > bLen) return buf.length;
                const view = new Uint8Array(memory!.buffer, bPtr, buf.length);
                view.set(buf);
                return buf.length;
              }
              const content = readFileSync(pathA, "utf8");
              if (content.length > bLen) return content.length;
              const view = new Uint16Array(memory!.buffer, bPtr, content.length);
              for (let i = 0; i < content.length; i++) view[i] = content.charCodeAt(i);
              return content.length;
            }
            case 2: {
              // readdirSync — read-only, no guard. JSON document (design
              // §2.6): the tier's own parser decodes it. x=1 (P5, D-6/D-8):
              // readdirTypesSync's SAME row — an array of {"%dtype","name"}
              // objects instead of bare name strings (fs.ts's own dispatch
              // arm supplies parentPath itself, never from this JSON —
              // never read `x` for anything but this ONE branch).
              const json =
                x === 1
                  ? JSON.stringify(readdirSync(pathA, { withFileTypes: true }).map((d) => ({ "%dtype": direntType(d), name: d.name })))
                  : JSON.stringify(readdirSync(pathA));
              if (json.length > bLen) return json.length;
              const view = new Uint16Array(memory!.buffer, bPtr, json.length);
              for (let i = 0; i < json.length; i++) view[i] = json.charCodeAt(i);
              return json.length;
            }
            case 3: {
              // mkdtempSync — ALWAYS creates a new directory.
              const resolved = guardDestructive(pathA, cwd, modulePath, "mkdtempSync");
              const created = mkdtempSync(resolved);
              createdPaths.add(created);
              if (created.length > bLen) return created.length;
              const view = new Uint16Array(memory!.buffer, bPtr, created.length);
              for (let i = 0; i < created.length; i++) view[i] = created.charCodeAt(i);
              return created.length;
            }
            case 4: {
              // realpathSync (P5, E-P5-2) — read-only, no guard. ON
              // SUCCESS: the SAME length-retry contract as ops 1/2/3
              // (bLen/CAP in code units). ON FAILURE: Node's OWN thrown
              // error already carries the EXACT resolve-then-truncate
              // path this op's message needs (B-3/B-4, measured
              // p5-realpath-rule.out) — no need to reimplement Node's own
              // resolution algorithm; slot B gets a u16 CODE-UNIT COUNT
              // at its base then the path's own UTF-16 payload at +2
              // (3C-2's ruling), and the OVERSHOOT-SIGNAL convention is
              // SHARED with success (a positive return exceeding bLen
              // means "retry with this much room", for EITHER eventual
              // outcome — the module cannot yet tell which, by design).
              try {
                const real = realpathSync(pathA);
                if (real.length > bLen) return real.length;
                const view = new Uint16Array(memory!.buffer, bPtr, real.length);
                for (let i = 0; i < real.length; i++) view[i] = real.charCodeAt(i);
                return real.length;
              } catch (e) {
                const err = e as NodeJS.ErrnoException;
                const errPath = typeof err.path === "string" ? err.path : pathA;
                const needed = 1 + errPath.length; // the u16 count slot + the payload, same code-unit unit bLen uses
                if (needed > bLen) return needed;
                const view = new Uint16Array(memory!.buffer, bPtr, needed);
                view[0] = errPath.length;
                for (let i = 0; i < errPath.length; i++) view[1 + i] = errPath.charCodeAt(i);
                return mapFsError(e, modulePath);
              }
            }
            case 5: {
              // readFdSync, ENCODED form (P5, design §2: syscall is
              // ALWAYS `read`) — the SAME length-retry contract as op 1,
              // reading from an fd (x) via Node's own fd-accepting
              // readFileSync (reads from the fd's CURRENT position to
              // EOF, exactly matching this op's own single-shot shape).
              // fd 0 (H1, rev A-4 measured 1426's own shape: `"" 0` /
              // `0 0` / `done`) is SYNTHESIZED as immediately empty —
              // never a real read against the harness's OWN stdin, which
              // this non-interactive process does not reliably offer.
              // KNOWN RESIDUAL GAP (undriven by any current corpus
              // fixture — 1426 only reaches the fd-0 branch above): a
              // genuine OVERSHOOT retry (content longer than the
              // module's initial 64-unit cap) would re-call
              // `readFileSync(x,'utf8')`, which has ALREADY consumed the
              // fd to EOF on the first attempt, losing the content on
              // retry — no fixture drives this path today.
              if (x === 0) return 0;
              const content = readFileSync(x, "utf8");
              if (content.length > bLen) return content.length;
              const view = new Uint16Array(memory!.buffer, bPtr, content.length);
              for (let i = 0; i < content.length; i++) view[i] = content.charCodeAt(i);
              return content.length;
            }
            case 6: {
              // readSync(fd,offset,length) -> byte count (P5, design
              // §6.2) — a FIXED-length read (never retried — Node's own
              // readSync answers the ACTUAL bytes read, short reads at
              // EOF included) into slot B as RAW BYTES (never UTF-16 —
              // the caller's own BYTES_U8 buffer, emitter.ts's own
              // dispatch-arm copy loop reads it that way). No fd-0
              // synthesis here — H1 names "BOTH readFd forms" only
              // (op 5, ops 22/23), never this lower-level form, and no
              // current fixture exercises fd 0 through it.
              const buf = Buffer.alloc(bLen);
              const n = readSync(x, buf, 0, bLen, null);
              const view = new Uint8Array(memory!.buffer, bPtr, n);
              for (let i = 0; i < n; i++) view[i] = buf[i]!;
              return n;
            }
            case 7:
            case 8: {
              // statSync (7) / lstatSync (8) (P5, E-P5-1) — read-only, no
              // guard. FIXED SIZE record (20 bytes, B-1/rev-26 a1b0b98f:
              // 4 + 8 + 8 — abi.ts's own corrected arithmetic), status 0
              // on success like a write-shaped op, never a length. THE
              // TWO f64 FIELDS THROUGH A DataView setFloat64 (N-1,
              // little-endian) — NEVER a Float64Array (slot B is only
              // 2-byte aligned; a Float64Array over an 8-unaligned base
              // throws on 7 of 8 sampled bases, measured
              // p5-f64-align.out).
              const st = op === 7 ? statSync(pathA) : lstatSync(pathA);
              const dv = new DataView(memory!.buffer, bPtr, 20);
              dv.setUint8(0, st.isFile() ? 1 : 0);
              dv.setUint8(1, st.isDirectory() ? 1 : 0);
              dv.setUint8(2, st.isSymbolicLink() ? 1 : 0);
              dv.setFloat64(4, st.size, true);
              dv.setFloat64(12, st.mtimeMs, true);
              return 0;
            }
            case 9: {
              // writeFileSync/writeFileModeSync (`x` carries mode+1 for
              // writeFileModeSync, abi.ts's own "mode=x-1" — delta-3db
              // d7e1c3db B-1: BIASED BY ONE, never the raw mode, because
              // x===0 already means "absent" for writeFileSync/
              // fsp.writeFile [the row's mode-less keys], and Node's own
              // writeFileSync({mode:0}) is NOT "no mode" — it is a REAL,
              // different mode, measured: a file created with mode 0 is
              // unreadable by its own creating process moments later,
              // EACCES — an UNBIASED x would collapse that representable
              // input into "no mode" silently, board #142's collision
              // rebuilt on x. x===0 stays "omit mode, Node's own default
              // applies"; x!==0 forwards `x-1` as the real mode) /
              // writeFileSyncBytes (`y`=1, RAW BYTES — op 9's `x` is
              // ALREADY spent by mode, so the bytes flag rides `y`
              // instead, delta-3d a3c02af9's correction to this pass's
              // own proposal; writeFileSync/writeFileModeSync/
              // fsp.writeFile all keep y=0, their own text-key row
              // asserts it).
              const resolved = guardDestructive(pathA, cwd, modulePath, "writeFileSync");
              const isNew = !existsSync(resolved);
              if (y === 1) {
                const view = new Uint8Array(memory!.buffer, bPtr, bLen);
                writeFileSync(resolved, Buffer.from(view));
              } else if (x !== 0) {
                writeFileSync(resolved, readUtf16(bPtr, bLen), { mode: x - 1 });
              } else {
                writeFileSync(resolved, readUtf16(bPtr, bLen));
              }
              if (isNew) createdPaths.add(resolved);
              return 0;
            }
            case 10: {
              const resolved = guardDestructive(pathA, cwd, modulePath, "appendFileSync");
              const isNew = !existsSync(resolved);
              appendFileSync(resolved, readUtf16(bPtr, bLen));
              if (isNew) createdPaths.add(resolved);
              return 0;
            }
            case 11: {
              // mkdirSync/mkdirRecursiveSync/mkdirModeSync/
              // mkdirRecursiveModeSync (P5: `x` carries mode+1 for the
              // two Mode keys — delta-3db d7e1c3db B-1, the SAME bias as
              // case 9's own; P4's own two non-Mode keys always send the
              // inert literal 0, unchanged).
              const resolved = guardDestructive(pathA, cwd, modulePath, "mkdirSync");
              const isNew = !existsSync(resolved);
              if (x !== 0) {
                mkdirSync(resolved, { recursive: y === 1, mode: x - 1 });
              } else {
                mkdirSync(resolved, { recursive: y === 1 });
              }
              if (isNew) createdPaths.add(resolved);
              return 0;
            }
            case 12: {
              const resolved = guardDestructive(pathA, cwd, modulePath, "rmdirSync");
              rmdirSync(resolved);
              return 0;
            }
            case 13: {
              const resolved = guardDestructive(pathA, cwd, modulePath, "unlinkSync");
              unlinkSync(resolved);
              return 0;
            }
            case 14: {
              // rmSync/rmOptsSync/rmRetrySync — recursive/force ride x/y
              // exactly as P4 built it; rmRetrySync (P5, CP1 delta cp1b)
              // ADDS maxRetries/retryDelay as a two-i32 LE record riding
              // slot B (bLen=8) instead of x/y (both already spent) —
              // read via DataView getInt32 (cp1b/M-24: an Int32Array
              // throws on a slot-B base that sits at 2 mod 4, which every
              // odd-code-unit path length produces); bLen=0 (rmSync/
              // rmOptsSync) means the record is ABSENT, Node's own
              // defaults apply. Forwarded straight into Node's own real
              // rmSync options so Node's OWN retry behavior does the
              // work — no hand-rolled retry loop here.
              const resolved = guardDestructive(pathA, cwd, modulePath, "rmSync");
              if (bLen === 8) {
                const dv = new DataView(memory!.buffer, bPtr, 8);
                const maxRetries = dv.getInt32(0, true);
                const retryDelay = dv.getInt32(4, true);
                rmSync(resolved, { recursive: x === 1, force: y === 1, maxRetries, retryDelay });
              } else {
                rmSync(resolved, { recursive: x === 1, force: y === 1 });
              }
              return 0;
            }
            case 15: {
              // copyFileSync (P5) — the ONE two-path op. src is
              // READ-ONLY (no guard, `pathA` unresolved — matching the
              // EISDIR-for-copyfile trap: Node's OWN missing-dest-parent-
              // wins check needs the real, unresolved arguments); dst is
              // the ONE thing being created/overwritten, guarded like
              // every other destructive op.
              const dst = readUtf16(bPtr, bLen);
              const resolvedDst = guardDestructive(dst, cwd, modulePath, "copyFileSync");
              const isNew = !existsSync(resolvedDst);
              copyFileSync(pathA, resolvedDst);
              if (isNew) createdPaths.add(resolvedDst);
              return 0;
            }
            case 16: {
              // chmodSync (P5) — guard extended here (rev-26 3C read,
              // POST-ACK #7): mutates an EXISTING path, never creates one
              // — no createdPaths tracking.
              const resolved = guardDestructive(pathA, cwd, modulePath, "chmodSync");
              chmodSync(resolved, x);
              return 0;
            }
            case 17: {
              // chownSync (P5) — same guard-but-no-create shape as
              // chmodSync above.
              const resolved = guardDestructive(pathA, cwd, modulePath, "chownSync");
              chownSync(resolved, x, y);
              return 0;
            }
            case 18: {
              // closeSync (P5) — fd-only, no path, no guard (closing
              // touches no filesystem location). fd 0: a no-op — never
              // actually close the HARNESS's own real stdin, which every
              // LATER census program in this same process would then
              // find closed too; no current fixture calls closeSync(0),
              // this is a defensive no-op matching fd 0's own
              // "synthesized, never real" stance throughout ops 5/22/23.
              if (x !== 0) {
                closeSync(x);
                openFds.delete(x);
              }
              return 0;
            }
            case 19: {
              // existsSync (design §6.2): PROBE-SHAPED, never throws —
              // read-only, no guard.
              try {
                accessSync(pathA);
                return 0;
              } catch {
                return -1;
              }
            }
            case 20: {
              // accessSync — read-only (a permission PROBE, not a
              // mutation), no guard.
              accessSync(pathA, x);
              return 0;
            }
            case 21: {
              // openSync(pathA,flags=x,mode=y) -> fd (P5) — `flags` is
              // the REVERSE of emitter.ts's own compile-time FLAGS_ENUM
              // (OPEN_FLAGS_BY_CODE above); the module already validated
              // the literal at compile time (1640's own row), so an
              // unrecognized code here is a HARNESS bug, not a module
              // one. 'r' never creates and never writes through the fd
              // it returns — no guard, matching every other read-only
              // op; every OTHER flag is guarded (root-set guard extended
              // here, POST-ACK #7's own RECORD item), and only the
              // STRICTLY CREATING flags (every flag but 'r' and 'r+' —
              // 'r+' opens an EXISTING file for read+write, never
              // creates, Node throws ENOENT if missing) are tracked in
              // createdPaths (H2's own creating-op enumeration).
              const flags = OPEN_FLAGS_BY_CODE[x];
              if (flags === undefined) {
                throw new Error(`HARNESS SAFETY GUARD: openSync received an unrecognized flags code ${x} for ${modulePath}`);
              }
              const resolved = flags === "r" ? pathA : guardDestructive(pathA, cwd, modulePath, "openSync");
              const isNew = flags !== "r" && flags !== "r+" && !existsSync(resolved);
              const fd = openSync(resolved, flags, y);
              openFds.add(fd);
              if (isNew) createdPaths.add(resolved);
              return fd;
            }
            case 22: {
              // fstatFd(fd=x) -> byte size (P5, readFdSyncBytes's own
              // stage 1) — the SIZE stage 2 allocates against. fd 0:
              // synthesized as size 0 (H1's own "immediately empty"
              // stance, matching op 5).
              if (x === 0) return 0;
              return fstatSync(x).size;
            }
            case 23: {
              // readFdInto(fd=x,ptr,cap) -> byte count (P5,
              // readFdSyncBytes's own stage 2) — RAW BYTES into slot B
              // (never UTF-16 — emitReadBytesAt's own 1-byte-per-unit
              // read), capacity = stage 1's own SIZE, never retried (a
              // single fixed-length read, op 6's own shape). fd 0:
              // synthesized as 0 bytes read (stage 1 already answered
              // size 0, so bLen is 0 here too).
              if (x === 0) return 0;
              const buf = Buffer.alloc(bLen);
              const n = readSync(x, buf, 0, bLen, null);
              const view = new Uint8Array(memory!.buffer, bPtr, n);
              for (let i = 0; i < n; i++) view[i] = buf[i]!;
              return n;
            }
            default:
              throw new Error(`fsCall: unhandled op ${op} for ${modulePath}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("HARNESS SAFETY GUARD")) throw e;
          return mapFsError(e, modulePath);
        }
      },
      // INC-28 U1 (abi.ts cpCall): Node's own spawnSync runs the child; the
      // result is transcribed field by field and held behind a handle.
      // RUN advances the virtual clock by the child's measured duration,
      // so a timer armed before a long child is due when the call returns.
      cpCall(op: number, ptr: number, len: number, h: number, which: number): number {
        if (memory === null) throw new Error("cpCall before instantiation completed");
        const mem = memory;
        if (op === 1) {
          return cpGuardedRun(() => {
            const req = cpDecodeRequest(mem.buffer, ptr, len);
            const t0 = performance.now();
            const result = cpRunRequest(req);
            clock += performance.now() - t0;
            const handle = cpNextHandle++;
            cpHandles.set(handle, result);
            return handle;
          });
        }
        // INC-28 U2: the asynchronous ops (abi.ts), event modules only.
        if (op >= 5 && op <= 9) {
          if (!eventModule) return -1;
          if (op === 5) return cpGuardedRun(() => evSpawn(spawnDecodeRequest(mem.buffer, ptr, len), ptr, mem.buffer));
          const rec = evChildren.get(h);
          if (rec === undefined) return -999999;
          // INC-28 U3: FLOW — the host's own 'data' listener on that piped
          // stream, attached now, once; Node's chunks are queued as they
          // are emitted.
          if (op === 9) {
            const stream = which === 1 || which === 2 ? rec.pipes[which - 1] : null;
            if (stream === null || stream === undefined) return -999999;
            // Already read since the exit (kind 6): the module decides.
            if (rec.held[which - 1]) return 0;
            if (rec.flowing[which - 1]) return -999999;
            rec.flowing[which - 1] = true;
            stream.on("data", (chunk: Buffer) => {
              if (!rec.live) return;
              evPush({ source: 1, handle: h, kind: 4, a: which, b: 0, payload: new Uint8Array(chunk) });
            });
            return 0;
          }
          if (op === 6) {
            let returned: boolean | undefined;
            let thrownErrno: number | undefined;
            rec.errorErrno = undefined;
            try {
              returned = rec.proc.kill(which);
            } catch (e) {
              const errno = (e as NodeJS.ErrnoException).errno;
              thrownErrno = typeof errno === "number" ? errno : -999999;
            }
            return killErrnoFor({ returned, thrownErrno, errorErrno: rec.errorErrno });
          }
          if (op === 7) {
            rec.proc.unref();
            return 0;
          }
          if (rec.live) return -999999;
          evChildren.delete(h);
          return 0;
        }
        const result = cpHandles.get(h);
        if (result === undefined) return -1;
        if (op === 2) {
          cpEncodeResult(mem.buffer, ptr, result);
          return 32;
        }
        if (op === 3) {
          const bytes = which === 1 ? result.stdout : which === 2 ? result.stderr : null;
          if (bytes === null) return -1;
          new Uint8Array(mem.buffer, ptr, bytes.length).set(bytes);
          return bytes.length;
        }
        if (op === 4) {
          cpHandles.delete(h);
          return 0;
        }
        return -1;
      },
      // INC-29 U1 (abi.ts netCall): node:net's OS-level operations.
      netCall(op: number, ptr: number, len: number, h: number, x: number): number {
        return netHost.netCall(op, ptr, len, h, x);
      },
      // INC-28 U2 (abi.ts evPoll): the oldest queued event, or 0; a short
      // buffer answers -(the length needed) and keeps the event. Reading an
      // EXIT ends that child's life for the clock.
      evPoll(ptr: number, cap: number): number {
        if (memory === null) throw new Error("evPoll before instantiation completed");
        const ev = evQueue[0];
        if (ev === undefined) return 0;
        // INC-29 U1 (review): a later host iteration's net events wait for
        // the module's next poll phase.
        if (!evGate.admits(ev)) return 0;
        const n = evEncodeRecord(memory.buffer, ptr, cap, ev);
        if (n < 0) return n;
        evQueue.shift();
        // INC-29 U1: a net event's own bookkeeping (a lookup's answer ends it).
        netHost.delivered(ev);
        // Reading a child's last event (its EXIT, and INC-28 U3 every piped
        // stream's END) ends that child's life for the clock.
        if (ev.source === 1 && ((ev.kind & 0xff) === 1 || (ev.kind & 0xff) === 5)) {
          const rec = evChildren.get(ev.handle);
          if (rec !== undefined && rec.live) {
            if ((ev.kind & 0xff) === 1) rec.exitRead = true;
            else rec.endsUnread--;
            if (rec.exitRead && rec.endsUnread === 0) {
              const t = clockNow();
              rec.live = false;
              evLive--;
              if (evLive === 0) clock = Math.max(clock, t);
            }
          }
        }
        return n;
      },
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
        // abi.ts: `_tick` never answers +Infinity (only `_loop` does).
        if (due === Infinity) throw new Error(`_tick answered +Infinity for ${modulePath}`);
        clock = Math.max(clock, due);
      }
    }
    // INC-28 U2: an event module's pump (abi.ts's loop contract).
    const loopExport = instance.exports["_loop"] as ((now: number) => number) | undefined;
    const loop =
      loopExport === undefined
        ? undefined
        : (now: number): number => {
            // INC-29 U1 (review): this call's poll phase takes the oldest
            // queued host iteration's net events, and only those.
            evGate.beginPoll(evQueue);
            return loopExport(now);
          };
    if (loop !== undefined) {
      let due = loop(clockNow());
      for (let turns = 0; ; turns++) {
        if (turns > 1_000_000) throw new Error(`_loop pump did not settle for ${modulePath}`);
        if (due < 0) break;
        if (evLive === 0) {
          if (due === Infinity) throw new Error(`module waits for an event no source can deliver: ${modulePath}`);
          clock = Math.max(clock, due);
          due = loop(clockNow());
          continue;
        }
        await evTurn(due);
        due = loop(clockNow());
      }
    }
    cleanRun = true;
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
    // INC-26 P1: an explicit process.exit(n) reports its OWN code — BEFORE
    // the RuntimeError test, since this is not a trap at all.
    if (err instanceof WasmExitSignal) {
      return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]), exitCode: err.code };
    }
    // A wasm TRAP is the tier's stand-in for an uncaught runtime error
    // (S003's index traps, until the exception protocol lands): Node
    // exits 1 on an uncaught exception, so a trap reports exit 1 with
    // whatever output preceded it. Comparison stays honest — the harness
    // skips the stderr compare for nonzero-exit programs, and any
    // OTHER error here (a bug in the host, a missing export) is not a
    // trap and still fails the test loudly.
    if (!(err instanceof WebAssembly.RuntimeError)) throw err;
    return { stdout: Buffer.concat(chunks[1]), stderr: Buffer.concat(chunks[2]), exitCode: 1 };
  } finally {
    // INC-28 U1: a clean run (no trap, no exit) must have FREEd every
    // child handle it RUN; a trap or an exit may leave one, which this
    // per-run table simply drops.
    const leakedHandles = cpHandles.size;
    cpHandles.clear();
    // INC-28 U2: the event host's per-run cleanup — no late host event can
    // reach a finished run, and every child still running is killed
    // (SEMANTICS.md S086; Node would leave it running). Each child keeps
    // the host's own 'error' listener.
    evFinished = true;
    evWaker = null;
    evQueue.length = 0;
    // INC-29 U1: every socket and server still open is closed (the module
    // left them so: the loop ended, or the program died).
    netHost.finish();
    for (const rec of evChildren.values()) {
      rec.proc.removeAllListeners("close");
      rec.proc.removeAllListeners("exit");
      rec.shared?.destroy();
      for (const stream of rec.pipes) {
        stream?.removeAllListeners("data");
        stream?.removeAllListeners("end");
        stream?.destroy();
      }
      if (rec.proc.exitCode === null && rec.proc.signalCode === null) {
        try {
          rec.proc.kill("SIGKILL");
        } catch {
          // Best-effort: the child may be gone already.
        }
      }
    }
    evChildren.clear();
    // N-3 (CP1 delta): remove every path THIS RUN created — so a program
    // that TRAPS mid-test still leaves the tree clean (992's own
    // `freshDir` is the evidence that traps happen in practice). Wraps
    // the WHOLE dispatch (every return path above), never just the
    // normal-completion tail.
    for (const p of createdPaths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort: a predecessor's own cleanup (or this program's
        // own rmSync/unlinkSync arm) may have already removed it.
      }
    }
    // P5: close every real fd THIS RUN opened and never closed itself
    // (createdPaths' own SAME shape/SAME reasoning — a trap mid-run must
    // not leak a real OS fd into every later census program).
    for (const fd of openFds) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort: the program's own closeSync arm, or its own
        // failure path, may have already closed it.
      }
    }
    // INC-28 U1: thrown LAST, after every cleanup above has run.
    if (cleanRun && leakedHandles !== 0) {
      throw new Error(`cpCall: ${leakedHandles} child handle(s) never freed after a clean run of ${modulePath}`);
    }
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

  // INC-26 P5, POST-ACK #25 §4 / delta-3gd (landed — M-4/M-6 were missing pins, closed
  // here): two hand-sequenced TWO-PROGRAM tests. `createdPaths`/`openFds` (this file's
  // own N-3/P5 leak-cleanup sets, both declared per-`runWasm`-call and reset every
  // invocation) can only be caught by running two programs in series and inspecting
  // REAL, process-wide filesystem/fd state between them — no single-program row can see
  // a cleanup bug in either set, since the JS bookkeeping itself never persists across
  // calls, only the underlying OS resource does. Fixtures live under
  // tests/harness/fixtures-p5/m04-fdleak/ and tests/harness/fixtures-p5/m06-leak/ —
  // harness-owned, outside every FORBID prefix (delta-3gd: tests/corpus/ itself is a
  // FORBID-PREFIX regardless of subdirectory or census-glob reach, so these do not
  // belong there even though the bulk `test.for` loop's own glob never matched them).
  const fixturesP5Dir = join(repoRoot, "tests/harness/fixtures-p5");
  test("M-6: a two-program createdPaths leak check — B must see A's own file gone", async () => {
    const shared = join(tmpdir(), "m6-leak-check-shared.txt");
    try { rmSync(shared, { force: true }); } catch { /* clean slate */ }
    const resA = await build(join(fixturesP5Dir, "m06-leak/a.ts"));
    if (!resA.ok) throw new Error("M-6 fixture A failed to build");
    const outA = await runWasm(resA.binaryPath);
    expect(outA.stdout.toString("utf8").trim()).toBe("a-wrote");
    const resB = await build(join(fixturesP5Dir, "m06-leak/b.ts"));
    if (!resB.ok) throw new Error("M-6 fixture B failed to build");
    const outB = await runWasm(resB.binaryPath);
    expect(outB.stdout.toString("utf8").trim()).toBe("b-sees false");
  });
  // Program B's own stdout carries the RAW fd number BY DESIGN — this row's whole
  // mechanism is comparing B's real OS fd against A's — but this is now safe under
  // every reader in the repo: fixturesP5Dir sits outside tests/corpus/ entirely (not
  // merely in an unglobbed subdirectory of it), so neither the wasm lane's own
  // `test.for` bulk loop NOR the llvm-differential lane's own equivalent can ever
  // discover these files and Node-oracle-compare that raw, non-deterministic number.
  test("M-4: a two-program fd-table leak check — B's fd must equal A's fd", async () => {
    const resA = await build(join(fixturesP5Dir, "m04-fdleak/a.ts"));
    if (!resA.ok) throw new Error("M-4 fixture A failed to build");
    const outA = await runWasm(resA.binaryPath);
    const fdA = Number(outA.stdout.toString("utf8").trim().split(" ")[1]);
    expect(Number.isFinite(fdA)).toBe(true);
    const resB = await build(join(fixturesP5Dir, "m04-fdleak/b.ts"));
    if (!resB.ok) throw new Error("M-4 fixture B failed to build");
    const outB = await runWasm(resB.binaryPath);
    const fdB = Number(outB.stdout.toString("utf8").trim().split(" ")[1]);
    expect(fdB).toBe(fdA);
  });

  // ── INC-26 pass P4 — the fsCall adapter's OWN unit rows (design §10-v:
  // "who attacks the adapter? the forced-host rows do not use it, and the
  // corpus rows do" — these drive the adapter FUNCTIONS directly, with
  // CONSTRUCTED Node errors, never a real fs call). Every row names its
  // SINGLE EDIT, matching the forced-host file's own row-vacuity rule.
  test("mapFsError: an ENOENT Error (errno -2) maps to the module's own -1 — SINGLE-EDIT: FS_CODE_INDEX.ENOENT changed from 1", () => {
    const e = Object.assign(new Error("x"), { code: "ENOENT", errno: -2 });
    expect(mapFsError(e, "test")).toBe(-1);
  });
  test("mapFsError: an ELOOP Error (errno -40) maps to -13, the appended code — never falls to UNKNOWN (delta-3e e4da1096 R-1, ERRATUM E-P4-3) — SINGLE-EDIT: FS_CODE_INDEX.ELOOP removed or renumbered", () => {
    const e = Object.assign(new Error("x"), { code: "ELOOP", errno: -40 });
    expect(mapFsError(e, "test")).toBe(-13);
  });
  test("mapFsError: an ENAMETOOLONG Error (errno -36) maps to -14, the appended code — never falls to UNKNOWN (delta-3e e4da1096 R-1, ERRATUM E-P4-3) — SINGLE-EDIT: FS_CODE_INDEX.ENAMETOOLONG removed or renumbered", () => {
    const e = Object.assign(new Error("x"), { code: "ENAMETOOLONG", errno: -36 });
    expect(mapFsError(e, "test")).toBe(-14);
  });
  test("mapFsError: an UNKNOWN code with errno -9999 maps to -(256+9999) — SINGLE-EDIT: the carrier's 256 base changed", () => {
    const e = Object.assign(new Error("x"), { code: "EWEIRD", errno: -9999 });
    expect(mapFsError(e, "test")).toBe(-(256 + 9999));
  });
  test("mapFsError: ERR_FS_EISDIR maps to the SAME carrier value as ordinary EISDIR (-5), never falling through to UNKNOWN — SINGLE-EDIT: the ERR_FS_EISDIR special case removed from mapFsError", () => {
    const e = Object.assign(new Error("x"), { code: "ERR_FS_EISDIR", errno: 21 });
    expect(mapFsError(e, "test")).toBe(-5);
  });
  test("mapFsError: an ordinary EISDIR Error maps to -5, never colliding with ENOTDIR's own slot (-4) — the design's own most-valuable mutation: the FORCED-HOST rows never touch this table (they script fsCall directly, bypassing the adapter entirely), so only THIS row or the real differential harness can tell 'the adapter is wrong' from 'the module is wrong' — SINGLE-EDIT: FS_CODE_INDEX.EISDIR changed from 5 (M-8)", () => {
    const e = Object.assign(new Error("x"), { code: "EISDIR", errno: -21 });
    expect(mapFsError(e, "test")).toBe(-5);
  });
  test("mapFsError: a non-Error throw is a LOUD harness failure, never silently mapped — SINGLE-EDIT: the instanceof Error guard removed", () => {
    expect(() => mapFsError("not an error", "test")).toThrow(/HARNESS SAFETY GUARD/);
  });
  test("mapFsError: an Error with no .code and no .errno is a LOUD harness failure, never a fabricated UNKNOWN — SINGLE-EDIT: the errno-undefined guard removed", () => {
    expect(() => mapFsError(new Error("x"), "test")).toThrow(/HARNESS SAFETY GUARD/);
  });

  // delta-3e (e4da1096) R-5 / delta-1720b (3f9cebce) Q-5: wasm-host-facts.
  // test.ts's own rows drive makeHostFacts's REAL builder logic (a
  // scripted sample() injected as the constructor argument) — that part
  // is NOT the gap. The residue is the harness SEAM: this exact
  // construction (an UNMOCKED sampler reading real process.cpuUsage()/
  // threadCpuUsage()/resourceUsage(), called ONCE per runWasm invocation
  // right before WebAssembly.instantiate — line ~3599 above) was never
  // exercised end-to-end; a wiring bug there (the baseline call dropped,
  // the wrong process.* method threaded in, etc.) would go undetected by
  // every existing row. This ONE integration row reproduces that EXACT
  // production construction verbatim and proves the wiring itself
  // subtracts a real baseline, not just that makeHostFacts's OWN
  // internal arithmetic is correct in isolation (already covered).
  test("host-facts INTEGRATION SEAM: hostFacts constructed EXACTLY as runWasm's own line ~3599 (an unmocked sampler reading REAL process.cpuUsage/threadCpuUsage/resourceUsage, never an injected/scripted one) answers a SMALL delta for real CPU work done AFTER construction — never the huge pre-existing cumulative total — SINGLE-EDIT: the wiring's baseline call dropped (mirrors M-11, but through the REAL sampler this time, not a scripted one)", () => {
    // Sampled INDEPENDENTLY, via a call that never touches makeHostFacts
    // at all — this worker's OWN cumulative user-CPU total, entering this
    // test (already substantial: this file alone runs thousands of prior
    // corpus compiles/executions before reaching this describe block).
    const rawBefore = process.cpuUsage().user;
    // VERBATIM production wiring (runWasm's own construction, copied here
    // rather than imported, since it is deliberately inline/unexported
    // there — an injected sampler would defeat the very seam this row
    // exists to test).
    const hostFacts = makeHostFacts((): HostFactSnapshot => {
      const cpu = process.cpuUsage();
      const threadCpu = process.threadCpuUsage();
      const ru = process.resourceUsage();
      return {
        cpuUser: cpu.user,
        cpuSystem: cpu.system,
        threadCpuUser: threadCpu.user,
        threadCpuSystem: threadCpu.system,
        rusage: [
          ru.userCPUTime,
          ru.systemCPUTime,
          ru.maxRSS,
          ru.sharedMemorySize,
          ru.unsharedDataSize,
          ru.unsharedStackSize,
          ru.minorPageFault,
          ru.majorPageFault,
          ru.swappedOut,
          ru.fsRead,
          ru.fsWrite,
          ru.ipcSent,
          ru.ipcReceived,
          ru.signalsCount,
          ru.voluntaryContextSwitches,
          ru.involuntaryContextSwitches,
        ],
      };
    });
    // Real CPU work, entirely AFTER the baseline sample above — kind 8
    // (cpuUser) is this seam's own witness.
    let x = 0;
    for (let i = 0; i < 100_000_000; i++) x += i;
    expect(x).toBeGreaterThan(0); // keeps the loop from being elided
    const delta = hostFacts.hostNumFor(8, 0);
    expect(delta).toBeGreaterThanOrEqual(0);
    // THE discriminating assertion: a correctly-wired seam answers only
    // THIS row's own small slice of CPU time (milliseconds), which must
    // be smaller than `rawBefore` — the worker's ENTIRE prior cumulative
    // total, already large by this point in the file. A wiring bug that
    // drops the baseline call answers close to the RAW cumulative value
    // AT THE TIME hostNumFor is called — which is >= rawBefore + this
    // loop's own contribution, i.e. STRICTLY GREATER than rawBefore —
    // failing this assertion exactly where the bug lives.
    expect(delta).toBeLessThan(rawBefore);
  });

  test("guardDestructive (N-1): a CREATE target that does not exist yet is resolved via its nearest EXISTING ancestor, never realpathSync'd directly — SINGLE-EDIT: resolveNearestExistingAncestor calling realpathSync on the raw target", () => {
    // The repo root itself always exists, so a nonexistent child under it
    // resolves cleanly (proving the walk-up-then-realpath path runs) and
    // is REFUSED for a different reason (tracked by git) — proving the
    // permission test itself still runs on the resolved path, not that
    // resolution silently no-ops.
    expect(() => guardDestructive(join(repoRoot, "definitely-not-a-real-file-xyz"), repoRoot, "test", "testOp")).not.toThrow(/ENOENT/);
  });
  test("guardDestructive: os.tmpdir() itself is permitted — SINGLE-EDIT: isPermittedDestructivePath's tmpdir branch removed", () => {
    expect(() => guardDestructive(tmpdir(), tmpdir(), "test", "testOp")).not.toThrow();
  });
  test("guardDestructive: a path under packages/ is REFUSED LOUDLY even though it is under the repo root — SINGLE-EDIT: the EXCLUDED_REPO_PREFIXES check removed", () => {
    expect(() => guardDestructive(join(repoRoot, "packages", "definitely-not-real-xyz"), repoRoot, "test", "testOp")).toThrow(/HARNESS SAFETY GUARD/);
  });
  test("guardDestructive: a TRACKED path under the repo root (this test file itself) is REFUSED even outside every excluded prefix — SINGLE-EDIT: isGitTracked inverted", () => {
    expect(() => guardDestructive(import.meta.filename, repoRoot, "test", "testOp")).toThrow(/HARNESS SAFETY GUARD/);
  });

  test("the process tail: chdir/umask are never reached", () => {
    // INC-26 P3 (design §3C/B-5, rev-d10-p3.out b32fe774): chdir and
    // umask are two of the FIVE D10-shaped keys — built, and reached by
    // NO corpus program. This is the positive proof: if either counter is
    // ever nonzero, either a NEW corpus program reaches the key (update
    // this test and the D10 accounting) or the harness's own RECORDING
    // STUB is being hit when it should not be — either way, investigate
    // before assuming the stub's "mutate nothing" contract is still safe.
    expect({ chdirCallCount, umaskCallCount }).toEqual({ chdirCallCount: 0, umaskCallCount: 0 });
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

// ── board #148: no duplicated corpus program numbers ────────────────────
// The corpus imported at 23d5918 carried 48 duplicated leading numbers
// (tests/corpus/RENUMBERED.md); every duplicate was renumbered in INC-26
// B1. This guard keeps it that way. `entries` is INJECTABLE (default the
// real directory listing) so the M-6 mutation battery can append a
// synthetic duplicate IN MEMORY, at the call site, and observe this row
// redden — no file is ever created under tests/corpus/ (a FORBID-PREFIX;
// a transient write is a write).
export function duplicateCorpusNumbers(entries: string[] = readdirSync(corpusDir)): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const name of entries) {
    const m = /^(\d+)-/.exec(name);
    if (m === null) continue;
    const num = m[1]!;
    if (seen.has(num)) dups.add(num);
    else seen.add(num);
  }
  return [...dups].sort((a, b) => Number(a) - Number(b));
}

describe("board #148: corpus number hygiene", () => {
  test("no duplicated corpus program numbers remain", () => {
    expect(duplicateCorpusNumbers()).toEqual([]);
  });
});

// ── board #150: the four for-in/Object.keys skip-rule sites cite the
// BEHAVIOUR, never a dangling register number ──────────────────────────
// "SEMANTICS.md 37" was a stale citation (S037 is the Buffer entry; no
// S-entry states the undefined-valued-field skip rule, and the rule is
// Node-exact — registering it would be a category error). All four sites
// were de-numbered in INC-26 B1 to cite the behaviour directly. This test
// (a) locates each site by a stable nearby anchor and asserts NO bare
// `SEMANTICS.md <digits>` token appears in its neighbourhood — the digit
// run is `\b`-delimited so "372" can never satisfy a check meant for "37"
// — and (b) asserts the matched-site count is exactly four, so an anchor
// silently going missing (an empty match) fails the row instead of
// passing it. lower-calls.ts's OTHER, unrelated dangling citations
// (S116/S117, upstream register numbers this board does not touch) are
// deliberately out of scope: the anchors below target only the four
// skip-rule sites, never a whole-file scan.
const SKIP_RULE_SITES: { file: string; anchor: string }[] = [
  {
    file: "packages/compiler/src/frontend/lowering/lower-containers.ts",
    anchor: "fixed-shape lowering and Node's missing-key behavior",
  },
  {
    file: "packages/compiler/src/frontend/lowering/lower-calls.ts",
    anchor: "of their union at runtime (Node's missing key — an unset optional",
  },
  {
    file: "packages/compiler/src/frontend/lowering/lower-stmts.ts",
    anchor: "declaration order, fields holding the undefined arm of their union",
  },
  {
    file: "packages/compiler/src/frontend/lowering/lower-stmts.ts",
    anchor: "Fixed and hybrid shapes cannot lose keys mid-walk",
  },
];

describe("board #150: no dangling SEMANTICS.md citation at the skip-rule sites", () => {
  test("all four sites found, none carries a bare register-number citation nearby", () => {
    let matched = 0;
    for (const site of SKIP_RULE_SITES) {
      const text = readFileSync(join(repoRoot, site.file), "utf8");
      const idx = text.indexOf(site.anchor);
      expect(idx, `anchor not found in ${site.file}: ${JSON.stringify(site.anchor)}`).toBeGreaterThanOrEqual(0);
      matched++;
      const windowStart = Math.max(0, idx - 400);
      const windowEnd = Math.min(text.length, idx + site.anchor.length + 400);
      const window = text.slice(windowStart, windowEnd);
      expect(window, `${site.file} still carries a bare SEMANTICS.md citation near "${site.anchor}"`).not.toMatch(
        /SEMANTICS\.md\s+\d+\b/,
      );
    }
    expect(matched).toBe(4);
  });
});

// ── INC-28 U1 child_process rows ─────────────────────────────────────────
// Rows that need a real child run through this file's own runWasm (never
// a copy of the host); the cpCall adapter's pure parts are driven
// directly by the unit rows (mapFsError's precedent). Not shard-gated: a
// row compiles its inline source into its own mkdtemp directory and
// shares no path or state with any other row or copy of this block.
describe("INC-28 U1 child_process rows", () => {
  /** Compiles `src` (a whole program) in a fresh directory of its own and
   * runs it through this file's runWasm; the directory goes afterwards. */
  async function runU1Source(src: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u1-row-"));
    try {
      const file = join(dir, "main.ts");
      writeFileSync(file, src);
      const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** A corpus program compiled into a fresh directory of its own (never
   * the shared content-keyed cache), then run through runWasm. */
  async function runU1Corpus(name: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u1-corpus-"));
    try {
      const res = await compile(join(corpusDir, name), { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("U1-C-1360 corpus 1360-spawn-sync.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1360-spawn-sync.ts");
    expect(r.stdout.toString("utf8")).toBe("hello spawn\n\n0\n3 out\n err\n\n0\nvia-path\n\ntrue 0 0\ntrue\n0 52890 25890\ntrue\ndone\n\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1464 corpus 1464-env-writes.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1464-env-writes.ts");
    expect(r.stdout.toString("utf8")).toBe("before: (unset)\nafter: written\noverwrite: rewritten\ncomputed: via-brackets\nchild sees: rewritten\ntemplate: n=6\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1482 corpus 1482-spawnsync-error.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1482-spawnsync-error.ts");
    expect(r.stdout.toString("utf8")).toBe("status: null\nmessage: spawnSync definitely-not-a-binary-xyz ENOENT\ninstanceof: true\ncode: ENOENT true\navailable: false\nok error: true true hi\nfailed error: true true\nexited 2\nspawn failed (ENOENT)\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1655 corpus 1655-spawnsync-neutral.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1655-spawnsync-neutral.ts");
    expect(r.stdout.toString("utf8")).toBe("\"hello from child\\n\" 0\n[\"plain\",\"with space\",\"tab\\there\",\"quote\\\"inside\",\"trailing\\\\\",\"back\\\\slash\",\"both\\\\\\\"mix\",\"run\\\\\\\\\",\"\",\"last one\"]\n\n0\n3 \"out\\n\" \"err\\n\"\nnull ENOENT\nprobe: 0 null true\ntimeout: null SIGTERM ETIMEDOUT\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-2697 corpus 2697-spawnsync-options.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("2697-spawnsync-options.ts");
    expect(r.stdout.toString("utf8")).toBe("probe: 0 null true\nmissing: null ENOENT null\ntimeout: null SIGKILL ETIMEDOUT\ntimeout default: SIGTERM\nselfkill: null SIGTERM true\ncapture: \"up\\n\" \"down\\n\" 4 null\nquiet: 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-2708 corpus 2708-os-release-spawnsync-stdio.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("2708-os-release-spawnsync-stdio.ts");
    expect(r.stdout.toString("utf8")).toBe(release() + "\ntrue true\n0 \"captured-line\\n\"\n0 \"explicit-pipe\\n\"\nbefore-inherit\ninherited-line\nafter-inherit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-01 spawnSync with asymmetric stdio tuples captures exactly the piped stream, and both with an exit status", async () => {
    const r = await runU1Source("// spawnSync with asymmetric stdio tuples: one output captured, the other\n// discarded, both ways round (only the captured stream is printed); then\n// both captured with an exit status.\nimport { spawnSync } from \"node:child_process\";\n\nconst a = spawnSync(\"/bin/sh\", [\"-c\", \"echo to-out; echo to-err 1>&2\"], { encoding: \"utf8\", stdio: [\"pipe\", \"pipe\", \"ignore\"] });\nconsole.log(\"out-only:\", JSON.stringify(a.stdout), a.status);\nconst b = spawnSync(\"/bin/sh\", [\"-c\", \"echo to-out; echo to-err 1>&2\"], { encoding: \"utf8\", stdio: [\"pipe\", \"ignore\", \"pipe\"] });\nconsole.log(\"err-only:\", JSON.stringify(b.stderr), b.status);\nconst c = spawnSync(\"/bin/sh\", [\"-c\", \"echo to-out; echo to-err 1>&2; exit 2\"], { encoding: \"utf8\", stdio: \"pipe\" });\nconsole.log(\"both:\", JSON.stringify(c.stdout), JSON.stringify(c.stderr), c.status, c.signal);\n");
    expect(r.stdout.toString("utf8")).toBe("out-only: \"to-out\\n\" 0\nerr-only: \"to-err\\n\" 0\nboth: \"to-out\\n\" \"to-err\\n\" 2 null\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-06 timeout + killSignal: the kill's signal and ETIMEDOUT; a child trapping the signal reports its own status beside ETIMEDOUT", async () => {
    const r = await runU1Source("// timeout + killSignal on spawnSync, and a child that traps SIGTERM and\n// exits after the timeout's signal: Node reports its status AND ETIMEDOUT.\nimport { spawnSync } from \"node:child_process\";\n\nconst k = spawnSync(\"sleep\", [\"5\"], { timeout: 200, killSignal: \"SIGKILL\", encoding: \"utf8\" });\nconsole.log(\"kill:\", k.status, k.signal, `${(k.error as NodeJS.ErrnoException | undefined)?.code}`, k.error?.message);\nconst d = spawnSync(\"sleep\", [\"5\"], { timeout: 200, encoding: \"utf8\" });\nconsole.log(\"default:\", d.status, d.signal, `${(d.error as NodeJS.ErrnoException | undefined)?.code}`);\nconst t = spawnSync(\"/bin/sh\", [\"-c\", \"trap 'echo trapped; exit 7' TERM; sleep 5 & wait\"], { timeout: 300, encoding: \"utf8\" });\nconsole.log(\"trapped:\", t.status, t.signal, `${(t.error as NodeJS.ErrnoException | undefined)?.code}`, JSON.stringify(t.stdout));\nconst z = spawnSync(\"/bin/sh\", [\"-c\", \"trap 'exit 0' TERM; sleep 5 & wait\"], { timeout: 300, encoding: \"utf8\" });\nconsole.log(\"trapped0:\", z.status, z.signal, `${(z.error as NodeJS.ErrnoException | undefined)?.code}`);\n");
    expect(r.stdout.toString("utf8")).toBe("kill: null SIGKILL ETIMEDOUT spawnSync sleep ETIMEDOUT\ndefault: null SIGTERM ETIMEDOUT\ntrapped: null SIGPIPE ETIMEDOUT \"\"\ntrapped0: 0 null ETIMEDOUT\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-07 spawnSync's default 1 MiB maxBuffer: ENOBUFS with SIGTERM past it, exactly 1 MiB passes", async () => {
    const r = await runU1Source("// spawnSync's default maxBuffer (1 MiB): a child writing more is killed\n// with SIGTERM and the result carries ENOBUFS.\nimport { spawnSync } from \"node:child_process\";\n\nconst r = spawnSync(\"/bin/sh\", [\"-c\", \"head -c 3000000 /dev/zero | tr '\\\\0' 'x'\"], { encoding: \"utf8\" });\nconsole.log(\"big:\", r.status, r.signal, `${(r.error as NodeJS.ErrnoException | undefined)?.code}`, r.error?.message, r.stdout.length >= 1048576);\nconst ok = spawnSync(\"/bin/sh\", [\"-c\", \"head -c 1048576 /dev/zero | tr '\\\\0' 'y'\"], { encoding: \"utf8\" });\nconsole.log(\"exact:\", ok.status, ok.signal, ok.error === undefined, ok.stdout.length);\n");
    expect(r.stdout.toString("utf8")).toBe("big: null SIGTERM ENOBUFS spawnSync /bin/sh ENOBUFS true\nexact: 0 null true 1048576\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-09 a spawnSync result flows through a ReturnType parameter, a closure, || and a conditional with undefined", async () => {
    const r = await runU1Source("// A spawnSync result as an ordinary value: through a ReturnType-typed\n// parameter, captured by a closure, chosen by `||` and by a conditional\n// with undefined, and read through optional chaining.\nimport { spawnSync } from \"node:child_process\";\n\nfunction make(word: string) {\n  return spawnSync(\"/bin/echo\", [word], { encoding: \"utf8\" });\n}\ntype R = ReturnType<typeof make>;\nfunction show(r: R): string {\n  return `${r.status}:${r.stdout.trim()}`;\n}\nconst r = make(\"flow\");\nconst later = (): string => r.stdout.trim();\nconsole.log(show(r), later());\nconst none: R | undefined = undefined;\nconst either = none || make(\"fallback\");\nconsole.log(either.status, either.stdout.trim());\nconst flag = process.argv.length > 99;\nconst maybe = flag ? undefined : make(\"maybe\");\nconsole.log(maybe?.status, maybe?.stdout.trim());\nconst skipped = flag ? make(\"never\") : undefined;\nconsole.log(skipped?.status ?? \"none\");\n");
    expect(r.stdout.toString("utf8")).toBe("0:flow flow\n0 fallback\n0 maybe\nnone\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-10 env writes holding U+0000 reach a child cut at the NUL, as Node's environment holds them", async () => {
    const r = await runU1Source("// process.env writes holding U+0000 in a value and in a key, then a child\n// that prints both through the inherited environment.\nimport { spawnSync } from \"node:child_process\";\n\nprocess.env.SCRIPTC_U1_NUL = \"a\\u0000b\";\nprocess.env[\"SCRIPTC_U1_K\\u0000Y\"] = \"kv\";\nconst r = spawnSync(\"/bin/sh\", [\"-c\", \"printf '[%s][%s]' \\\"$SCRIPTC_U1_NUL\\\" \\\"${SCRIPTC_U1_K-unset}\\\"\"], { encoding: \"utf8\" });\nconsole.log(\"child:\", r.status, r.error === undefined, JSON.stringify(r.stdout));\n");
    expect(r.stdout.toString("utf8")).toBe("child: 0 true \"[a][kv]\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-ERR-01 spawnSync's error property: ENOENT, EACCES, ENOTDIR as a real Error with code; none for a child that ran and failed", async () => {
    const r = await runU1Source("// spawnSync's error property for spawn failures: a missing binary, a file\n// that is not executable, a directory, a path through a file \u2014 and no\n// error for a child that ran and failed.\nimport { spawnSync } from \"node:child_process\";\nimport { chmodSync, mkdtempSync, rmSync, writeFileSync } from \"node:fs\";\nimport { tmpdir } from \"node:os\";\nimport { join } from \"node:path\";\n\nconst dir = mkdtempSync(join(tmpdir(), \"u1-err-\"));\nconst plain = join(dir, \"plain.sh\");\nwriteFileSync(plain, \"echo hi\\n\");\nchmodSync(plain, 0o644);\nconst show = (label: string, file: string): void => {\n  const r = spawnSync(file, [], { encoding: \"utf8\" });\n  if (r.error) {\n    console.log(label, r.status, r.signal, r.error.message.split(dir).join(\"<dir>\"), `${(r.error as NodeJS.ErrnoException).code}`, r.error instanceof Error);\n  } else {\n    console.log(label, r.status, r.signal, \"no error\");\n  }\n};\nshow(\"missing:\", \"definitely-not-a-binary-xyz\");\nshow(\"abs-missing:\", \"/definitely/not/here\");\nshow(\"not-exec:\", plain);\nshow(\"directory:\", dir);\nshow(\"through-file:\", join(plain, \"x\"));\nshow(\"ran-and-failed:\", \"false\");\nrmSync(dir, { recursive: true, force: true });\n");
    expect(r.stdout.toString("utf8")).toBe("missing: null null spawnSync definitely-not-a-binary-xyz ENOENT ENOENT true\nabs-missing: null null spawnSync /definitely/not/here ENOENT ENOENT true\nnot-exec: null null spawnSync <dir>/plain.sh EACCES EACCES true\ndirectory: null null spawnSync <dir> EACCES EACCES true\nthrough-file: null null spawnSync <dir>/plain.sh/x ENOTDIR ENOTDIR true\nran-and-failed: 1 null no error\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-01 timeout validation through spawnSync: Node's RangeError text incl. numeric separators; -0, 2**53 and 1e21 accepted", async () => {
    const r = await runU1Source("// timeout validation through spawnSync: values Node accepts and the\n// RangeError text for the ones it rejects.\nimport { spawnSync } from \"node:child_process\";\n\nconst vals: number[] = [1.5, -1, NaN, Infinity, -Infinity, -0, 2 ** 53, -(2 ** 33), -(2 ** 32) - 1, -(2 ** 32), -1e21, 4294967296.5, -4294967296.5, 0.1, 1e21];\nfor (const v of vals) {\n  try {\n    const r = spawnSync(\"true\", [], { timeout: v });\n    console.log(\"ran\", r.status, r.error === undefined);\n  } catch (e) {\n    console.log(\"threw\", e instanceof Error ? e.name + \": \" + e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n  }\n}\n");
    expect(r.stdout.toString("utf8")).toBe("threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received 1.5 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received NaN ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received Infinity ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -Infinity ERR_OUT_OF_RANGE\nran 0 true\nran 0 true\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -8_589_934_592 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -4_294_967_297 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -4294967296 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1e_+21 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received 4294967296.5 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -4294967296.5 ERR_OUT_OF_RANGE\nthrew RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received 0.1 ERR_OUT_OF_RANGE\nran 0 true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-02 killSignal SIGINFO throws Node's ERR_UNKNOWN_SIGNAL TypeError; SIGIOT is accepted", async () => {
    const r = await runU1Source("// killSignal validation: a name Node's front end accepts but Linux lacks.\nimport { spawnSync } from \"node:child_process\";\n\ntry {\n  const r = spawnSync(\"true\", [], { killSignal: \"SIGINFO\" });\n  console.log(\"no throw\", r.status);\n} catch (e) {\n  console.log(\"threw\", e instanceof Error ? e.name + \": \" + e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n}\nconst ok = spawnSync(\"true\", [], { killSignal: \"SIGIOT\", timeout: 1000 });\nconsole.log(\"alias ok\", ok.status, ok.error === undefined);\n");
    expect(r.stdout.toString("utf8")).toBe("threw TypeError: Unknown signal: SIGINFO ERR_UNKNOWN_SIGNAL\nalias ok 0 true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-03 NUL in spawnSync's file and arguments: Node's TypeError with the inspect-quoted value (quote choice, escapes, 128 cut); an empty file", async () => {
    const r = await runU1Source("// NUL bytes in spawnSync's file and arguments, the inspect-quoted value in\n// the message, and the empty file name.\nimport { spawnSync } from \"node:child_process\";\n\nconst show = (label: string, f: () => void): void => {\n  try {\n    f();\n    console.log(label, \"no throw\");\n  } catch (e) {\n    console.log(label, e instanceof Error ? e.name + \": \" + JSON.stringify(e.message) : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n  }\n};\nshow(\"file:\", () => spawnSync(\"ec\\u0000ho\", [], {}));\nshow(\"arg0:\", () => spawnSync(\"echo\", [\"a\\u0000b\"], {}));\nshow(\"arg2:\", () => spawnSync(\"echo\", [\"ok\", \"fine\", \"x\\u0000\"], {}));\nshow(\"both-quotes:\", () => spawnSync(\"echo\", [\"it's\\u0000\\\"q\\\"\"], {}));\nshow(\"single-quote:\", () => spawnSync(\"echo\", [\"it's\\u0000\"], {}));\nshow(\"newline:\", () => spawnSync(\"echo\", [\"line1\\nline2 is long enough\\u0000\"], {}));\nshow(\"long:\", () => spawnSync(\"echo\", [\"x\".repeat(200) + \"\\u0000\"], {}));\nshow(\"tab-and-unicode:\", () => spawnSync(\"echo\", [\"\\t\u00e9\u2028\\u0000\"], {}));\nshow(\"empty-file:\", () => spawnSync(\"\", [], {}));\nshow(\"plain-form:\", () => spawnSync(\"ec\\u0000ho\"));\n");
    expect(r.stdout.toString("utf8")).toBe("file: TypeError: \"The argument 'file' must be a string without null bytes. Received 'ec\\\\x00ho'\" ERR_INVALID_ARG_VALUE\narg0: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received 'a\\\\x00b'\" ERR_INVALID_ARG_VALUE\narg2: TypeError: \"The argument 'args[2]' must be a string without null bytes. Received 'x\\\\x00'\" ERR_INVALID_ARG_VALUE\nboth-quotes: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received `it's\\\\x00\\\"q\\\"`\" ERR_INVALID_ARG_VALUE\nsingle-quote: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received \\\"it's\\\\x00\\\"\" ERR_INVALID_ARG_VALUE\nnewline: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received 'line1\\\\nline2 is long enough\\\\x00'\" ERR_INVALID_ARG_VALUE\nlong: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...\" ERR_INVALID_ARG_VALUE\ntab-and-unicode: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received '\\\\t\u00e9\u2028\\\\x00'\" ERR_INVALID_ARG_VALUE\nempty-file: TypeError: \"The argument 'file' cannot be empty. Received ''\" ERR_INVALID_ARG_VALUE\nplain-form: TypeError: \"The argument 'file' must be a string without null bytes. Received 'ec\\\\x00ho'\" ERR_INVALID_ARG_VALUE\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-04 spawnSync validates in Node's order: file, args, timeout, killSignal", async () => {
    const r = await runU1Source("// Node's validation order through spawnSync: file, args, timeout,\n// killSignal.\nimport { spawnSync } from \"node:child_process\";\n\nconst show = (label: string, f: () => void): void => {\n  try {\n    f();\n    console.log(label, \"no throw\");\n  } catch (e) {\n    console.log(label, e instanceof Error ? e.name + \": \" + e.message : \"?\");\n  }\n};\nshow(\"file<args:\", () => spawnSync(\"f\\u0000\", [\"a\\u0000\"], {}));\nshow(\"args<timeout:\", () => spawnSync(\"echo\", [\"a\\u0000\"], { timeout: -1 }));\nshow(\"timeout<signal:\", () => spawnSync(\"echo\", [], { timeout: -1, killSignal: \"SIGINFO\" }));\nshow(\"args<signal:\", () => spawnSync(\"echo\", [\"b\\u0000\"], { killSignal: \"SIGINFO\" }));\nshow(\"empty<args:\", () => spawnSync(\"\", [\"a\\u0000\"], {}));\n");
    expect(r.stdout.toString("utf8")).toBe("file<args: TypeError: The argument 'file' must be a string without null bytes. Received 'f\\x00'\nargs<timeout: TypeError: The argument 'args[0]' must be a string without null bytes. Received 'a\\x00'\ntimeout<signal: RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1\nargs<signal: TypeError: The argument 'args[0]' must be a string without null bytes. Received 'b\\x00'\nempty<args: TypeError: The argument 'file' cannot be empty. Received ''\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-05 a spawnSync validation throw inside a named function, an arrow, a class method and two calls deep is caught by the caller", async () => {
    const r = await runU1Source("// A spawnSync validation throw raised inside a named function, an arrow,\n// a class method and a function two calls deep, each caught by its caller.\nimport { spawnSync } from \"node:child_process\";\n\nfunction named(): number | null {\n  return spawnSync(\"n\\u0000\", [], {}).status;\n}\nconst arrow = (): number | null => spawnSync(\"echo\", [\"a\\u0000\"], {}).status;\nclass Runner {\n  run(): number | null {\n    return spawnSync(\"true\", [], { timeout: -1 }).status;\n  }\n}\nfunction inner(): number | null {\n  return spawnSync(\"true\", [], { killSignal: \"SIGINFO\" }).status;\n}\nfunction outer(): number | null {\n  return inner();\n}\nconst attempt = (label: string, f: () => number | null): void => {\n  try {\n    console.log(label, \"returned\", f());\n  } catch (e) {\n    console.log(label, \"caught\", e instanceof Error ? e.name + \": \" + e.message : \"?\");\n  }\n};\nattempt(\"named:\", named);\nattempt(\"arrow:\", arrow);\nattempt(\"method:\", () => new Runner().run());\nattempt(\"two-deep:\", outer);\ntry {\n  named();\n  console.log(\"direct-call: no throw\");\n} catch (e) {\n  console.log(\"direct-call: caught\", e instanceof Error ? e.message : \"?\");\n}\nconsole.log(\"after\");\n");
    expect(r.stdout.toString("utf8")).toBe("named: caught TypeError: The argument 'file' must be a string without null bytes. Received 'n\\x00'\narrow: caught TypeError: The argument 'args[0]' must be a string without null bytes. Received 'a\\x00'\nmethod: caught RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1\ntwo-deep: caught TypeError: Unknown signal: SIGINFO\ndirect-call: caught The argument 'file' must be a string without null bytes. Received 'n\\x00'\nafter\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RES-01 every spawnSync result field per outcome: exit 0, exit 3, signal, spawn failure, timeout, trapped timeout (status AND error)", async () => {
    const r = await runU1Source("// Every field of the spawnSync result printed for each outcome kind (a\n// failed spawn's outputs are left out: their reading is registered).\nimport { spawnSync } from \"node:child_process\";\n\nconst show = (label: string, file: string, args: string[], timeout: number, outputs: boolean): void => {\n  const r = spawnSync(file, args, { encoding: \"utf8\", timeout: timeout });\n  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;\n  const io = outputs ? ` out=${JSON.stringify(r.stdout)} err=${JSON.stringify(r.stderr)}` : \"\";\n  console.log(label, `status=${r.status}`, `signal=${r.signal}`, `error=${r.error === undefined ? \"undefined\" : r.error.message}`, `code=${code}` + io);\n};\nshow(\"exit0:\", \"/bin/sh\", [\"-c\", \"printf a; printf b 1>&2\"], 0, true);\nshow(\"exit3:\", \"/bin/sh\", [\"-c\", \"printf a; exit 3\"], 0, true);\nshow(\"signal:\", \"/bin/sh\", [\"-c\", \"printf a; kill -TERM $$\"], 0, true);\nshow(\"spawnfail:\", \"definitely-not-a-binary-xyz\", [], 0, false);\nshow(\"timeout:\", \"/bin/sh\", [\"-c\", \"printf a; sleep 5\"], 300, true);\nshow(\"trapped:\", \"/bin/sh\", [\"-c\", \"trap 'printf t; exit 4' TERM; printf a; sleep 5 & wait\"], 300, true);\nshow(\"trapped-quiet:\", \"/bin/sh\", [\"-c\", \"trap 'exit 4' TERM; printf a; sleep 5 & wait\"], 300, true);\n");
    expect(r.stdout.toString("utf8")).toBe("exit0: status=0 signal=null error=undefined code=undefined out=\"a\" err=\"b\"\nexit3: status=3 signal=null error=undefined code=undefined out=\"a\" err=\"\"\nsignal: status=null signal=SIGTERM error=undefined code=undefined out=\"a\" err=\"\"\nspawnfail: status=null signal=null error=spawnSync definitely-not-a-binary-xyz ENOENT code=ENOENT\ntimeout: status=null signal=SIGTERM error=spawnSync /bin/sh ETIMEDOUT code=ETIMEDOUT out=\"a\" err=\"\"\ntrapped: status=null signal=SIGPIPE error=spawnSync /bin/sh ETIMEDOUT code=ETIMEDOUT out=\"a\" err=\"\"\ntrapped-quiet: status=4 signal=null error=spawnSync /bin/sh ETIMEDOUT code=ETIMEDOUT out=\"a\" err=\"\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RES-02 the signal name for every terminating signal 1..31, incl. 6 SIGABRT, 16 SIGSTKFLT, 29 SIGIO and 30 SIGPWR", async () => {
    const r = await runU1Source("// The signal name Node reports for each terminating signal a child sends\n// itself (stop signals and default-ignored ones are left out).\nimport { spawnSync } from \"node:child_process\";\n\nconst nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24, 25, 26, 27, 29, 30, 31];\nconst names: string[] = [];\nfor (const n of nums) {\n  const r = spawnSync(\"/bin/sh\", [\"-c\", `kill -${n} $$`], { encoding: \"utf8\" });\n  names.push(`${n}:${r.signal}:${r.status}`);\n}\nconsole.log(names.join(\" \"));\n");
    expect(r.stdout.toString("utf8")).toBe("1:SIGHUP:null 2:SIGINT:null 3:SIGQUIT:null 4:SIGILL:null 5:SIGTRAP:null 6:SIGABRT:null 7:SIGBUS:null 8:SIGFPE:null 9:SIGKILL:null 10:SIGUSR1:null 11:SIGSEGV:null 12:SIGUSR2:null 13:SIGPIPE:null 14:SIGALRM:null 15:SIGTERM:null 16:SIGSTKFLT:null 24:SIGXCPU:null 25:SIGXFSZ:null 26:SIGVTALRM:null 27:SIGPROF:null 29:SIGIO:null 30:SIGPWR:null 31:SIGSYS:null\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-DEC-01 invalid UTF-8 from a child decodes to U+FFFD per maximal subpart on stdout and stderr; valid sequences decode exactly", async () => {
    const r = await runU1Source("// Invalid UTF-8 from a child, decoded with U+FFFD per maximal subpart;\n// valid two- and four-byte sequences decode to their code units.\nimport { spawnSync } from \"node:child_process\";\n\nconst codes = (s: string): string => {\n  const out: number[] = [];\n  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));\n  return out.join(\",\");\n};\nconst r = spawnSync(\"/usr/bin/printf\", [\"a\\\\377b\\\\300\\\\200c\\\\342\\\\202\"], { encoding: \"utf8\" });\nconsole.log(\"stdout:\", r.stdout.length, codes(r.stdout));\nconst e = spawnSync(\"/bin/sh\", [\"-c\", \"printf 'x\\\\377y\\\\355\\\\240\\\\200z' 1>&2\"], { encoding: \"utf8\" });\nconsole.log(\"stderr:\", e.stderr.length, codes(e.stderr));\nconst ok = spawnSync(\"/usr/bin/printf\", [\"\\\\303\\\\251\\\\360\\\\237\\\\230\\\\200\"], { encoding: \"utf8\" });\nconsole.log(\"valid:\", ok.stdout.length, codes(ok.stdout));\n");
    expect(r.stdout.toString("utf8")).toBe("stdout: 7 97,65533,98,65533,65533,99,65533\nstderr: 7 120,65533,121,65533,65533,65533,122\nvalid: 3 233,55357,56832\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-CLK-01 a timer armed before a 300 ms child fires before an immediate armed after it, and Date.now advanced", async () => {
    const r = await runU1Source("// A timer armed before a long child is due before an immediate armed\n// after it, and the clock moves by the child's duration.\nimport { spawnSync } from \"node:child_process\";\n\nconst t0 = Date.now();\nsetTimeout(() => console.log(\"timer\"), 50);\nconst r = spawnSync(\"sleep\", [\"0.3\"], { encoding: \"utf8\" });\nsetImmediate(() => console.log(\"immediate\"));\nconsole.log(\"child\", r.status, Date.now() - t0 >= 300);\n");
    expect(r.stdout.toString("utf8")).toBe("child 0 true\ntimer\nimmediate\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-CLK-02 a child inside a timer callback: the callback's immediate, then the timers due during the child, in deadline order", async () => {
    const r = await runU1Source("// A child spawned inside a timer callback: a timer armed in that callback\n// before the child, an immediate armed in it, and an earlier timer that\n// became due while the child ran.\nimport { spawnSync } from \"node:child_process\";\n\nsetTimeout(() => {\n  console.log(\"root\");\n  setTimeout(() => console.log(\"B-100\"), 100);\n  setImmediate(() => console.log(\"imm\"));\n  const r = spawnSync(\"sleep\", [\"0.3\"], { encoding: \"utf8\" });\n  console.log(\"child\", r.status);\n}, 10);\nsetTimeout(() => console.log(\"A-200\"), 200);\n");
    expect(r.stdout.toString("utf8")).toBe("root\nchild 0\nimm\nB-100\nA-200\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-01 SEMANTICS.md S085(a): an uncaptured stream reads \"\" where Node reads null, a failed spawn's \"\" where Node reads undefined", async () => {
    const r = await runU1Source("// Uncaptured and failed-spawn outputs: Node reads null.\nimport { spawnSync } from \"node:child_process\";\n\nconst ig = spawnSync(\"/bin/sh\", [\"-c\", \"echo x; echo y 1>&2\"], { encoding: \"utf8\", stdio: \"ignore\" });\nconsole.log(\"ignored:\", JSON.stringify(ig.stdout), JSON.stringify(ig.stderr));\nconst inh = spawnSync(\"/bin/sh\", [\"-c\", \"true\"], { encoding: \"utf8\", stdio: \"inherit\" });\nconsole.log(\"inherited:\", JSON.stringify(inh.stdout), JSON.stringify(inh.stderr));\nconst miss = spawnSync(\"definitely-not-a-binary-xyz\", [], { encoding: \"utf8\" });\nconsole.log(\"failed:\", JSON.stringify(miss.stdout), JSON.stringify(miss.stderr));\n");
    expect(r.stdout.toString("utf8")).toBe("ignored: \"\" \"\"\ninherited: \"\" \"\"\nfailed: \"\" \"\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-03 SEMANTICS.md S085(c): spawnSync's error is a fresh Error on every read (Node: one object)", async () => {
    const r = await runU1Source("// The error property read twice: Node hands back one object; a property\n// written on the first read is seen through the second.\nimport { spawnSync } from \"node:child_process\";\n\nconst r = spawnSync(\"definitely-not-a-binary-xyz\", [], { encoding: \"utf8\" });\nconst a = r.error;\nconst b = r.error;\nif (a !== undefined && b !== undefined) {\n  console.log(\"same object:\", a === b);\n  a.message = \"rewritten\";\n  console.log(\"second read:\", b.message);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("same object: false\nsecond read: spawnSync definitely-not-a-binary-xyz ENOENT\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-09 SEMANTICS.md S086(d): stdin 'ignore' as a literal or tuple reaches the child as a socket (Node: /dev/null); the runtime string 'ignore' is /dev/null as in Node", async () => {
    const r = await runU1Source("// The kind of a spawnSync child's stdin per stdio form: pipe and ignore\n// through literal tuples, the ignore string (all fds ignored, so the kind\n// comes back as an exit status), and the runtime-string form.\nimport { spawnSync } from \"node:child_process\";\n\nconst probe = \"if [ -c /dev/stdin ]; then echo chardev; elif [ -S /dev/stdin ]; then echo socket; elif [ -p /dev/stdin ]; then echo fifo; else echo other; fi\";\nconst byStatus = \"if [ -c /dev/stdin ]; then exit 10; elif [ -S /dev/stdin ]; then exit 11; elif [ -p /dev/stdin ]; then exit 12; else exit 13; fi\";\nconsole.log(\"tuple-pipe:\", spawnSync(\"/bin/sh\", [\"-c\", probe], { encoding: \"utf8\", stdio: [\"pipe\", \"pipe\", \"pipe\"] }).stdout.trim());\nconsole.log(\"tuple-ignore:\", spawnSync(\"/bin/sh\", [\"-c\", probe], { encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"pipe\"] }).stdout.trim());\nconsole.log(\"literal-ignore status:\", spawnSync(\"/bin/sh\", [\"-c\", byStatus], { stdio: \"ignore\" }).status);\nconst runtime = (s: \"pipe\" | \"ignore\" | \"inherit\"): number | null => spawnSync(\"/bin/sh\", [\"-c\", byStatus], { encoding: \"utf8\", stdio: s }).status;\nconsole.log(\"str-ignore status:\", runtime(\"ignore\"));\nconsole.log(\"str-pipe status:\", runtime(\"pipe\"));\nconsole.log(\"plain status:\", spawnSync(\"/bin/sh\", [\"-c\", byStatus]).status);\n");
    expect(r.stdout.toString("utf8")).toBe("tuple-pipe: socket\ntuple-ignore: socket\nliteral-ignore status: 11\nstr-ignore status: 10\nstr-pipe status: 11\nplain status: 11\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-11 spawnSync with every output inherited applies no maxBuffer: 2,000,000 bytes reach stderr and the child exits 0", async () => {
    const r = await runU1Source("// spawnSync with every output inherited: Node applies no maxBuffer, so a\n// child writing 2,000,000 bytes to an inherited stderr runs normally.\nimport { spawnSync } from \"node:child_process\";\n\nconst all = spawnSync(\"/bin/sh\", [\"-c\", \"head -c 2000000 /dev/zero | tr '\\\\0' 'i' 1>&2\"], { stdio: \"inherit\" });\nconsole.log(\"all-inherit:\", all.status, all.signal, `${(all.error as NodeJS.ErrnoException | undefined)?.code}`);\n");
    expect(r.stdout.toString("utf8")).toBe("all-inherit: 0 null undefined\n");
    expect(r.stderr.toString("utf8")).toBe("i".repeat(2_000_000));
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-12 SEMANTICS.md S086(d): stdin 'inherit' reaches a spawnSync child as a socket (Node passes its own stdin, here a pipe)", async () => {
    const r = await runU1Source("// The kind of a spawnSync child's stdin given stdio \"inherit\": Node passes\n// its own stdin (here the oracle's closed pipe); the status names the kind.\nimport { spawnSync } from \"node:child_process\";\n\nconst byStatus = \"if [ -c /dev/stdin ]; then exit 10; elif [ -S /dev/stdin ]; then exit 11; elif [ -p /dev/stdin ]; then exit 12; else exit 13; fi\";\nconsole.log(\"inherit status:\", spawnSync(\"/bin/sh\", [\"-c\", byStatus], { stdio: \"inherit\" }).status);\n");
    expect(r.stdout.toString("utf8")).toBe("inherit status: 11\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);

  /** A request record built by hand in the module's layout (abi.ts). */
  function buildRequest(): { buffer: ArrayBuffer; len: number } {
    const parts: number[] = [];
    const u32 = (v: number): void => {
      parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    };
    const run = (text: string): void => {
      u32(text.length);
      for (let i = 0; i < text.length; i++) parts.push(text.charCodeAt(i) & 0xff, text.charCodeAt(i) >>> 8);
      while (parts.length % 4 !== 0) parts.push(0);
    };
    const header = new DataView(new ArrayBuffer(32));
    header.setUint32(0, 1, true);
    header.setUint32(4, 2, true);
    header.setUint32(8, 1, true);
    header.setUint32(12, 9, true);
    header.setFloat64(16, 1500, true);
    header.setUint32(24, 1, true);
    parts.push(...new Uint8Array(header.buffer));
    run("a\uD800");
    u32(2);
    run("x");
    run("yz");
    run("");
    u32(2);
    run("K");
    run("V");
    run("E");
    run("");
    u32(2);
    parts.push(0xff, 0x01);
    // 8 bytes before the record (a 4-aligned, non-zero base) and 8 after
    // (room for the length-mismatch row to over-read into zeros).
    const buffer = new ArrayBuffer(parts.length + 16);
    new Uint8Array(buffer, 8).set(parts);
    return { buffer, len: parts.length };
  }

  test("U1-C-1462 corpus 1462-exec-sync.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1462-exec-sync.ts");
    expect(r.stdout.toString("utf8")).toBe("\"a b\\nc\"\n\"42\\n\"\ncwd: /\n\nenv: A=one B=\n\ninput: fed to cat\nquiet: \"out\\n\"\nignored: \"kept\\n\"\necho: \"out-part\\n\"\nfail: Command failed: sh -c echo some-out; echo the-failure 1>&2; exit 3\nthe-failure\n\nfail2: Command failed: exit 7\nenoent: spawnSync definitely-not-a-command-xyz ENOENT\ntimeout: spawnSync sleep ETIMEDOUT\ndone\n");
    expect(r.stderr.toString("utf8")).toBe("visible-err\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1473 corpus 1473-promisify-execfile.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1473-promisify-execfile.ts");
    expect(r.stdout.toString("utf8")).toBe("plain: hi stderr empty: true\nboth: out err\nenv+cwd: envval:/\nfail: \"Command failed: /bin/sh -c printf failerr >&2; exit 3\\nfailerr\"\nspawnfail: spawn definitely-not-a-binary-xyz ENOENT code: ENOENT\ntimeout: \"Command failed: sleep 2\\n\"\ndone\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1521 corpus 1521-fs-lstat-lock.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1521-fs-lstat-lock.ts");
    expect(r.stdout.toString("utf8")).toBe("stat follows: true false 10\nlstat sees the link: true false\nplain file: false\nlstat missing: ENOENT true\nmtime sane: true true\nfirst lock: true\nheld, fresh: true\nsecond lock: false\nrelock after release: true\ndone: true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1552 corpus 1552-exec-options-record.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1552-exec-options-record.ts");
    expect(r.stdout.toString("utf8")).toBe("-store -user Root\n-store -user Root\nran:/bin/echo:-store|-user|Root:utf-8:30000\nC:\\certs\\ca.pem\nca.pem\na-b\nhi there\n/\nquiet-ok\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1573 corpus 1573-promisify-execfile-env-spread.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1573-promisify-execfile-env-spread.ts");
    expect(r.stdout.toString("utf8")).toBe("inherit: [none:from-harness]\nextra: [spread-on:from-harness]\nfalse-arm: none\ndone\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1578 corpus 1578-exec-input-optional.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1578-exec-input-optional.ts");
    expect(r.stdout.toString("utf8")).toBe("absent: \"\"\nempty-member: \"\"\nempty: \"\"\ntext: \"piped text\\n\"\n\"\"\n\"\"\n\"abc\"\n\"sure\\n\"\n\"via shell\\n\"\n\"\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1580 corpus 1580-exec-env-conditional-spread.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1580-exec-env-conditional-spread.ts");
    expect(r.stdout.toString("utf8")).toBe("inherit: A= B=from-harness\nempty: A= B=from-harness\nmerged: A=one B=from-harness\nloud: Q=loud\nquiet: Q=\npiped: body\nno-input: \"\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-1656 corpus 1656-execsync-neutral.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("1656-execsync-neutral.ts");
    expect(r.stdout.toString("utf8")).toBe("\"a b\\nc\"\ninput: FED TO NODE\nenv: one unset\n\ncwd match: true\nquiet: \"kept\\n\"\necho: \"out-part\\n\"\nfail: \"Command failed: node -e console.error('the-failure'); process.exit(3)\\nthe-failure\\n\"\nenoent: spawnSync definitely-not-a-binary-xyz ENOENT ENOENT\n");
    expect(r.stderr.toString("utf8")).toBe("visible-err\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-C-2362 corpus 2362-execsync-inherit.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU1Corpus("2362-execsync-inherit.ts");
    expect(r.stdout.toString("utf8")).toBe("before\nchild-out\nafter\ntuple-out\nshown-first\nfail: Command failed: echo shown-first; exit 5\ncwd=/ flag=on\ndone\n");
    expect(r.stderr.toString("utf8")).toBe("child-err\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-02 inherited output lands on the module's own fd in program order: stdout via spawnSync, stderr via execFileSync, both via 'inherit'", async () => {
    const r = await runU1Source("// Inherited child output interleaves with the parent's own writes on the\n// same fd in program order: stdout through spawnSync, stderr through\n// execFileSync, both through execFileSync's \"inherit\".\nimport { execFileSync, spawnSync } from \"node:child_process\";\n\nconsole.log(\"p1\");\nconst r = spawnSync(\"/bin/sh\", [\"-c\", \"echo c1; echo c1-err 1>&2\"], { encoding: \"utf8\", stdio: [\"pipe\", \"inherit\", \"pipe\"] });\nconsole.log(\"p2\", JSON.stringify(r.stderr));\nconsole.error(\"e1\");\nconst s = execFileSync(\"/bin/sh\", [\"-c\", \"echo c2; echo c2-err 1>&2\"], { encoding: \"utf8\", stdio: [\"pipe\", \"pipe\", \"inherit\"] });\nconsole.error(\"e2\");\nconsole.log(\"p3\", JSON.stringify(s));\nexecFileSync(\"/bin/sh\", [\"-c\", \"echo c3; echo c3-err 1>&2\"], { stdio: \"inherit\" });\nconsole.log(\"p4\");\nconsole.error(\"e3\");\n");
    expect(r.stdout.toString("utf8")).toBe("p1\nc1\np2 \"c1-err\\n\"\np3 \"c2\\n\"\nc3\np4\n");
    expect(r.stderr.toString("utf8")).toBe("e1\nc2-err\ne2\nc3-err\ne3\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-03 the input option: absent, empty, text, a lone surrogate sent as EF BF BD, astral text", async () => {
    const r = await runU1Source("// The input option: absent, empty, text, a lone surrogate (encoded as\n// EF BF BD on the way to the child), and astral text; od shows the bytes.\nimport { execFileSync } from \"node:child_process\";\n\nconst hex = (input: string | undefined): string =>\n  execFileSync(\"/usr/bin/od\", [\"-An\", \"-tx1\", \"-v\"], { encoding: \"utf8\", input: input }).replace(/\\s+/g, \" \").trim();\nconsole.log(\"absent:\", JSON.stringify(hex(undefined)));\nconsole.log(\"empty:\", JSON.stringify(hex(\"\")));\nconsole.log(\"text:\", hex(\"ab\\n\"));\nconsole.log(\"lone:\", hex(\"a\\uD800b\"));\nconsole.log(\"pair:\", hex(\"\ud83d\ude00\"));\nconsole.log(\"cat:\", JSON.stringify(execFileSync(\"cat\", [], { encoding: \"utf8\", input: \"line1\\nline2\" })));\n");
    expect(r.stdout.toString("utf8")).toBe("absent: \"\"\nempty: \"\"\ntext: 61 62 0a\nlone: 61 ef bf bd 62\npair: f0 9f 98 80\ncat: \"line1\\nline2\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-04 the child's environment: the module's map with a write and a delete, a replacement env, an env listing", async () => {
    const r = await runU1Source("// The child's environment: inherited from the module's map (a write made\n// before the call is seen, an unset is not), and REPLACED by an env option.\nimport { execFileSync, execSync, spawnSync } from \"node:child_process\";\n\nprocess.env.SCRIPTC_U1_W = \"written\";\nprocess.env.SCRIPTC_U1_GONE = \"x\";\ndelete process.env.SCRIPTC_U1_GONE;\nconst inh = spawnSync(\"/bin/sh\", [\"-c\", \"echo W=$SCRIPTC_U1_W G=${SCRIPTC_U1_GONE-unset} H=$SCRIPTC_TEST_ENV\"], { encoding: \"utf8\" });\nconsole.log(\"inherit:\", inh.stdout.trim());\nconst rep = execSync(\"echo W=${SCRIPTC_U1_W-unset} H=${SCRIPTC_TEST_ENV-unset} R=$SCRIPTC_U1_R\", { encoding: \"utf8\", env: { SCRIPTC_U1_R: \"replaced\" } });\nconsole.log(\"replace:\", rep.trim());\nconst cnt = execFileSync(\"/usr/bin/env\", [], { encoding: \"utf8\", env: { A: \"1\", B: \"two words\", C: \"\" } });\nconsole.log(\"env-list:\", JSON.stringify(cnt));\n");
    expect(r.stdout.toString("utf8")).toBe("inherit: W=written G=unset H=from-harness\nreplace: W=unset H=unset R=replaced\nenv-list: \"A=1\\nB=two words\\nC=\\n\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-05 PATH is searched in the child's environment: a replacement PATH that cannot find sh fails ENOENT", async () => {
    const r = await runU1Source("// PATH is searched in the CHILD's environment: a replacement env whose PATH\n// cannot find \"sh\" fails the spawn; an env without PATH falls back to the\n// default search path.\nimport { execFileSync } from \"node:child_process\";\n\ntry {\n  execFileSync(\"sh\", [\"-c\", \"echo ran\"], { encoding: \"utf8\", env: { PATH: \"/definitely/missing\" } });\n  console.log(\"missing-path: ran\");\n} catch (e) {\n  console.log(\"missing-path:\", e instanceof Error ? e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n}\nconsole.log(\"no-path:\", JSON.stringify(execFileSync(\"sh\", [\"-c\", \"echo ran\"], { encoding: \"utf8\", env: { X: \"1\" } })));\n");
    expect(r.stdout.toString("utf8")).toBe("missing-path: spawnSync sh ENOENT ENOENT\nno-path: \"ran\\n\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-RUN-08 a child closing stdin before a 1 MiB input: execFileSync throws EPIPE after a normal exit", async () => {
    const r = await runU1Source("// A child that closes its stdin before reading a large input: the write\n// fails with EPIPE after a normal exit, and execFileSync throws it.\nimport { execFileSync } from \"node:child_process\";\n\nconst big = \"z\".repeat(1048576);\ntry {\n  const out = execFileSync(\"/bin/sh\", [\"-c\", \"exec 0<&-; sleep 0.2; echo after\"], { encoding: \"utf8\", input: big, stdio: \"pipe\" });\n  console.log(\"no throw:\", JSON.stringify(out));\n} catch (e) {\n  console.log(\"epipe:\", e instanceof Error ? e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("epipe: spawnSync /bin/sh EPIPE EPIPE\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-ERR-02 execFileSync/execSync throws: tail, no tail, ignored stderr, signal, not-found, ENOENT forms, the display, a trapped timeout's ETIMEDOUT winning over status 7", async () => {
    const r = await runU1Source("// execFileSync / execSync throws: non-zero exit with a captured stderr\n// tail, an empty stderr (no tail), an ignored stderr (no tail), a signal\n// death, a shell not-found, spawn failures in both forms, the display of\n// the arguments, and a child that traps the timeout's signal and exits 7\n// (the errno wins over the status).\nimport { execFileSync, execSync } from \"node:child_process\";\n\nconst msg = (f: () => string): string => {\n  try {\n    return \"ok \" + JSON.stringify(f());\n  } catch (e) {\n    return e instanceof Error ? JSON.stringify(e.message) + \" code=\" + `${(e as NodeJS.ErrnoException).code}` : \"?\";\n  }\n};\nconsole.log(\"tail:\", msg(() => execFileSync(\"/bin/sh\", [\"-c\", \"echo o; echo bad 1>&2; exit 3\"], { encoding: \"utf8\", stdio: \"pipe\" })));\nconsole.log(\"no-tail:\", msg(() => execFileSync(\"/bin/sh\", [\"-c\", \"exit 4\"], { encoding: \"utf8\", stdio: \"pipe\" })));\nconsole.log(\"ignored:\", msg(() => execFileSync(\"/bin/sh\", [\"-c\", \"echo bad 1>&2; exit 5\"], { encoding: \"utf8\", stdio: [\"pipe\", \"pipe\", \"ignore\"] })));\nconsole.log(\"signal:\", msg(() => execSync(\"echo dying 1>&2; kill -KILL $$\", { encoding: \"utf8\", stdio: \"pipe\" })));\nconsole.log(\"not-found:\", msg(() => execSync(\"definitely-not-a-cmd-xyz\", { encoding: \"utf8\", stdio: \"pipe\" })));\nconsole.log(\"enoent-file:\", msg(() => execFileSync(\"definitely-not-a-binary-xyz\", [\"a\", \"b\"], { encoding: \"utf8\", stdio: \"pipe\" })));\nconsole.log(\"enoent-cwd:\", msg(() => execFileSync(\"echo\", [\"x\"], { encoding: \"utf8\", stdio: \"pipe\", cwd: \"/definitely/missing\" })));\nconsole.log(\"enoent-cwd-shell:\", msg(() => execSync(\"echo x\", { encoding: \"utf8\", stdio: \"pipe\", cwd: \"/definitely/missing\" })));\nconsole.log(\"display:\", msg(() => execFileSync(\"/bin/sh\", [\"-c\", \"exit 1\", \"arg with space\", \"\"], { encoding: \"utf8\", stdio: \"pipe\" })));\nconsole.log(\"no-args:\", msg(() => execFileSync(\"false\", [], { encoding: \"utf8\", stdio: \"pipe\" })));\nconsole.log(\"trapped:\", msg(() => execFileSync(\"/bin/sh\", [\"-c\", \"trap 'exit 7' TERM; sleep 5 & wait\"], { encoding: \"utf8\", stdio: \"pipe\", timeout: 300 })));\n");
    expect(r.stdout.toString("utf8")).toBe("tail: \"Command failed: /bin/sh -c echo o; echo bad 1>&2; exit 3\\nbad\\n\" code=undefined\nno-tail: \"Command failed: /bin/sh -c exit 4\" code=undefined\nignored: \"Command failed: /bin/sh -c echo bad 1>&2; exit 5\" code=undefined\nsignal: \"Command failed: echo dying 1>&2; kill -KILL $$\\ndying\\n\" code=undefined\nnot-found: \"Command failed: definitely-not-a-cmd-xyz\\n/bin/sh: 1: definitely-not-a-cmd-xyz: not found\\n\" code=undefined\nenoent-file: \"spawnSync definitely-not-a-binary-xyz ENOENT\" code=ENOENT\nenoent-cwd: \"spawnSync echo ENOENT\" code=ENOENT\nenoent-cwd-shell: \"spawnSync /bin/sh ENOENT\" code=ENOENT\ndisplay: \"Command failed: /bin/sh -c exit 1 arg with space \" code=undefined\nno-args: \"Command failed: false\" code=undefined\ntrapped: \"spawnSync /bin/sh ETIMEDOUT\" code=ETIMEDOUT\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-ERR-03 default stdio echoes the child's stderr before every throw (incl. ETIMEDOUT) and on success", async () => {
    const r = await runU1Source("// Default stdio: the child's captured stderr is echoed to ours BEFORE the\n// throw \u2014 for a non-zero exit, for a timeout, and on success.\nimport { execFileSync, execSync } from \"node:child_process\";\n\nconsole.error(\"before\");\ntry {\n  execFileSync(\"/bin/sh\", [\"-c\", \"echo partial-err 1>&2; sleep 5\"], { encoding: \"utf8\", timeout: 300 });\n} catch (e) {\n  console.error(\"caught:\", e instanceof Error ? e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n}\ntry {\n  execSync(\"echo fail-err 1>&2; exit 9\", { encoding: \"utf8\" });\n} catch (e) {\n  console.error(\"caught2:\", e instanceof Error ? JSON.stringify(e.message) : \"?\");\n}\nconsole.error(\"ok:\", JSON.stringify(execSync(\"echo ok-err 1>&2; echo ok-out\", { encoding: \"utf8\" })));\nconsole.error(\"after\");\n");
    expect(r.stdout.toString("utf8")).toBe("");
    expect(r.stderr.toString("utf8")).toBe("before\npartial-err\ncaught: spawnSync /bin/sh ETIMEDOUT ETIMEDOUT\nfail-err\ncaught2: \"Command failed: echo fail-err 1>&2; exit 9\\nfail-err\\n\"\nok-err\nok: \"ok-out\\n\"\nafter\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-ERR-04 promisified execFile: resolve, spawn failures, Command failed with the unconditional newline, a trapped exit 0 resolving", async () => {
    const r = await runU1Source("// The promisified execFile: success, a spawn failure, a non-zero exit, a\n// signal death, a timeout's kill, and a child that traps the timeout's\n// signal (exit 0 resolves, exit 7 rejects). The Command-failed codes are\n// left out (their reading is registered).\nimport { execFile } from \"node:child_process\";\nimport { promisify } from \"node:util\";\n\nconst execFileAsync = promisify(execFile);\n\nasync function show(label: string, file: string, args: string[], timeout: number, withCode: boolean): Promise<void> {\n  try {\n    const { stdout, stderr } = await execFileAsync(file, args, { encoding: \"utf8\", timeout: timeout });\n    console.log(label, \"resolved\", JSON.stringify(stdout), JSON.stringify(stderr));\n  } catch (e) {\n    const code = withCode ? ` ${(e as NodeJS.ErrnoException).code}` : \"\";\n    console.log(label, \"rejected\", e instanceof Error ? JSON.stringify(e.message) : \"?\", code);\n  }\n}\nasync function main(): Promise<void> {\n  await show(\"ok:\", \"/bin/sh\", [\"-c\", \"printf out; printf err 1>&2\"], 0, true);\n  await show(\"enoent:\", \"definitely-not-a-binary-xyz\", [\"x\"], 0, true);\n  await show(\"no-args:\", \"definitely-not-a-binary-xyz\", [], 0, true);\n  await show(\"exit:\", \"/bin/sh\", [\"-c\", \"printf e1 1>&2; exit 3\"], 0, false);\n  await show(\"signal:\", \"/bin/sh\", [\"-c\", \"kill -KILL $$\"], 0, false);\n  await show(\"timeout:\", \"/bin/sh\", [\"-c\", \"printf partial 1>&2; sleep 5\"], 300, false);\n  await show(\"trapped0:\", \"/bin/sh\", [\"-c\", \"trap 'exit 0' TERM; sleep 5 & wait\"], 300, false);\n  await show(\"trapped7:\", \"/bin/sh\", [\"-c\", \"trap 'exit 7' TERM; sleep 5 & wait\"], 300, false);\n}\nmain();\n");
    expect(r.stdout.toString("utf8")).toBe("ok: resolved \"out\" \"err\"\nenoent: rejected \"spawn definitely-not-a-binary-xyz ENOENT\"  ENOENT\nno-args: rejected \"spawn definitely-not-a-binary-xyz ENOENT\"  ENOENT\nexit: rejected \"Command failed: /bin/sh -c printf e1 1>&2; exit 3\\ne1\" \nsignal: rejected \"Command failed: /bin/sh -c kill -KILL $$\\n\" \ntimeout: rejected \"Command failed: /bin/sh -c printf partial 1>&2; sleep 5\\npartial\" \ntrapped0: resolved \"\" \"\"\ntrapped7: rejected \"Command failed: /bin/sh -c trap 'exit 7' TERM; sleep 5 & wait\\n\" \n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-06 NUL per position across the families (file, args, command, cwd, env key and value) and the empty file/command", async () => {
    const r = await runU1Source("// NUL bytes per position, and the inspect-quoted value in the message.\n// Every exec call carries an encoding: its result is used.\nimport { execFileSync, execSync, spawnSync } from \"node:child_process\";\n\nconst show = (label: string, f: () => void): void => {\n  try {\n    f();\n    console.log(label, \"no throw\");\n  } catch (e) {\n    console.log(label, e instanceof Error ? e.name + \": \" + JSON.stringify(e.message) : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n  }\n};\nshow(\"file:\", () => spawnSync(\"ec\\u0000ho\", [], {}));\nshow(\"arg0:\", () => spawnSync(\"echo\", [\"a\\u0000b\"], {}));\nshow(\"arg2:\", () => spawnSync(\"echo\", [\"ok\", \"fine\", \"x\\u0000\"], {}));\nshow(\"command:\", () => execSync(\"echo a\\u0000b\", { encoding: \"utf8\" }));\nshow(\"execfile-file:\", () => execFileSync(\"ec\\u0000ho\", [\"a\"], { encoding: \"utf8\" }));\nshow(\"cwd:\", () => execFileSync(\"echo\", [\"a\"], { encoding: \"utf8\", cwd: \"/tm\\u0000p\" }));\nshow(\"env-value:\", () => execFileSync(\"echo\", [\"a\"], { encoding: \"utf8\", env: { GOOD: \"1\", BAD: \"v\\u0000\" } }));\nshow(\"env-key:\", () => execFileSync(\"echo\", [\"a\"], { encoding: \"utf8\", env: { [\"K\\u0000\"]: \"v\" } }));\nshow(\"both-quotes:\", () => spawnSync(\"echo\", [\"it's\\u0000\\\"q\\\"\"], {}));\nshow(\"single-quote:\", () => spawnSync(\"echo\", [\"it's\\u0000\"], {}));\nshow(\"newline:\", () => spawnSync(\"echo\", [\"line1\\nline2 is long enough\\u0000\"], {}));\nshow(\"long:\", () => spawnSync(\"echo\", [\"x\".repeat(200) + \"\\u0000\"], {}));\nshow(\"input-nul:\", () => execFileSync(\"cat\", [], { encoding: \"utf8\", input: \"a\\u0000b\", stdio: \"pipe\" }));\nshow(\"empty-file:\", () => spawnSync(\"\", [], {}));\nshow(\"empty-command:\", () => execSync(\"\", { encoding: \"utf8\" }));\n");
    expect(r.stdout.toString("utf8")).toBe("file: TypeError: \"The argument 'file' must be a string without null bytes. Received 'ec\\\\x00ho'\" ERR_INVALID_ARG_VALUE\narg0: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received 'a\\\\x00b'\" ERR_INVALID_ARG_VALUE\narg2: TypeError: \"The argument 'args[2]' must be a string without null bytes. Received 'x\\\\x00'\" ERR_INVALID_ARG_VALUE\ncommand: TypeError: \"The argument 'command' must be a string without null bytes. Received 'echo a\\\\x00b'\" ERR_INVALID_ARG_VALUE\nexecfile-file: TypeError: \"The argument 'file' must be a string without null bytes. Received 'ec\\\\x00ho'\" ERR_INVALID_ARG_VALUE\ncwd: TypeError: \"The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received '/tm\\\\x00p'\" ERR_INVALID_ARG_VALUE\nenv-value: TypeError: \"The property 'options.env['BAD']' must be a string without null bytes. Received 'v\\\\x00'\" ERR_INVALID_ARG_VALUE\nenv-key: TypeError: \"The property 'options.env['K\\u0000']' must be a string without null bytes. Received 'K\\\\x00'\" ERR_INVALID_ARG_VALUE\nboth-quotes: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received `it's\\\\x00\\\"q\\\"`\" ERR_INVALID_ARG_VALUE\nsingle-quote: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received \\\"it's\\\\x00\\\"\" ERR_INVALID_ARG_VALUE\nnewline: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received 'line1\\\\nline2 is long enough\\\\x00'\" ERR_INVALID_ARG_VALUE\nlong: TypeError: \"The argument 'args[0]' must be a string without null bytes. Received 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...\" ERR_INVALID_ARG_VALUE\ninput-nul: no throw\nempty-file: TypeError: \"The argument 'file' cannot be empty. Received ''\" ERR_INVALID_ARG_VALUE\nempty-command: TypeError: \"The argument 'file' cannot be empty. Received ''\" ERR_INVALID_ARG_VALUE\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-07 Node's validation order across the families: file, args, cwd, env (insertion order), timeout, killSignal", async () => {
    const r = await runU1Source("// Node's validation order: file, args, cwd, env, timeout, killSignal.\n// Every exec call carries an encoding: its result is used.\nimport { execFileSync, spawnSync } from \"node:child_process\";\n\nconst show = (label: string, f: () => void): void => {\n  try {\n    f();\n    console.log(label, \"no throw\");\n  } catch (e) {\n    console.log(label, e instanceof Error ? e.name + \": \" + e.message : \"?\");\n  }\n};\nshow(\"file<args:\", () => spawnSync(\"f\\u0000\", [\"a\\u0000\"], {}));\nshow(\"args<timeout:\", () => spawnSync(\"echo\", [\"a\\u0000\"], { timeout: -1 }));\nshow(\"timeout<signal:\", () => spawnSync(\"echo\", [], { timeout: -1, killSignal: \"SIGINFO\" }));\nshow(\"args<cwd:\", () => execFileSync(\"echo\", [\"a\\u0000\"], { encoding: \"utf8\", cwd: \"c\\u0000\" }));\nshow(\"cwd<env:\", () => execFileSync(\"echo\", [], { encoding: \"utf8\", cwd: \"c\\u0000\", env: { E: \"v\\u0000\" } }));\nshow(\"env<timeout:\", () => execFileSync(\"echo\", [], { encoding: \"utf8\", env: { E: \"v\\u0000\" }, timeout: 1.5 }));\nshow(\"env-order:\", () => execFileSync(\"echo\", [], { encoding: \"utf8\", env: { A: \"a\\u0000\", B: \"b\\u0000\" } }));\nshow(\"empty<args:\", () => spawnSync(\"\", [\"a\\u0000\"], {}));\n");
    expect(r.stdout.toString("utf8")).toBe("file<args: TypeError: The argument 'file' must be a string without null bytes. Received 'f\\x00'\nargs<timeout: TypeError: The argument 'args[0]' must be a string without null bytes. Received 'a\\x00'\ntimeout<signal: RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1\nargs<cwd: TypeError: The argument 'args[0]' must be a string without null bytes. Received 'a\\x00'\ncwd<env: TypeError: The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received 'c\\x00'\nenv<timeout: TypeError: The property 'options.env['E']' must be a string without null bytes. Received 'v\\x00'\nenv-order: TypeError: The property 'options.env['A']' must be a string without null bytes. Received 'a\\x00'\nempty<args: TypeError: The argument 'file' cannot be empty. Received ''\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-08 timeout validation through spawnSync and execFileSync", async () => {
    const r = await runU1Source("// timeout validation: values Node accepts and the RangeError text for the\n// ones it rejects, through spawnSync and execFileSync.\nimport { execFileSync, spawnSync } from \"node:child_process\";\n\nconst vals: number[] = [1.5, -1, NaN, Infinity, -Infinity, -0, 2 ** 53, -(2 ** 33), -(2 ** 32) - 1, -(2 ** 32), -1e21, 4294967296.5, -4294967296.5, 0.1];\nfor (const v of vals) {\n  try {\n    const r = spawnSync(\"true\", [], { timeout: v });\n    console.log(\"spawnSync\", r.status, r.error === undefined);\n  } catch (e) {\n    console.log(\"spawnSync threw\", e instanceof Error ? e.name + \": \" + e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n  }\n}\ntry {\n  execFileSync(\"true\", [], { timeout: -5 });\n  console.log(\"execFileSync ok\");\n} catch (e) {\n  console.log(\"execFileSync threw\", e instanceof Error ? e.name + \": \" + e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("spawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received 1.5 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received NaN ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received Infinity ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -Infinity ERR_OUT_OF_RANGE\nspawnSync 0 true\nspawnSync 0 true\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -8_589_934_592 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -4_294_967_297 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -4294967296 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1e_+21 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received 4294967296.5 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -4294967296.5 ERR_OUT_OF_RANGE\nspawnSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received 0.1 ERR_OUT_OF_RANGE\nexecFileSync threw RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -5 ERR_OUT_OF_RANGE\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-VAL-09 promisified execFile's validation caught after await, in Node's async order (timeout first)", async () => {
    const r = await runU1Source("// The promisified execFile's validation, caught after await: each check's\n// text, and Node's async order (the timeout is checked before the file,\n// the arguments, the cwd and the environment).\nimport { execFile } from \"node:child_process\";\nimport { promisify } from \"node:util\";\n\nconst execFileAsync = promisify(execFile);\nasync function main(): Promise<void> {\n  try {\n    await execFileAsync(\"true\", [], { timeout: -1 });\n    console.log(\"timeout:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"timeout:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"t\\u0000rue\", []);\n    console.log(\"file-nul:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"file-nul:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"\", []);\n    console.log(\"file-empty:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"file-empty:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"true\", [\"a\\u0000\"]);\n    console.log(\"arg-nul:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"arg-nul:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"true\", [], { cwd: \"c\\u0000\" });\n    console.log(\"cwd-nul:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"cwd-nul:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"true\", [], { env: { A: \"a\\u0000\" } });\n    console.log(\"env-nul:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"env-nul:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"f\\u0000\", [], { timeout: 1.5 });\n    console.log(\"timeout-before-file:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"timeout-before-file:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"true\", [\"a\\u0000\"], { timeout: -2 });\n    console.log(\"timeout-before-arg:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"timeout-before-arg:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n  try {\n    await execFileAsync(\"f\\u0000\", [], { env: { B: \"b\\u0000\" } });\n    console.log(\"file-before-env:\", \"resolved\");\n  } catch (e) {\n    if (e instanceof Error) console.log(\"file-before-env:\", e.name + \": \" + e.message, `${(e as NodeJS.ErrnoException).code}`);\n  }\n}\nmain();\n");
    expect(r.stdout.toString("utf8")).toBe("timeout: RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -1 ERR_OUT_OF_RANGE\nfile-nul: TypeError: The argument 'file' must be a string without null bytes. Received 't\\x00rue' ERR_INVALID_ARG_VALUE\nfile-empty: TypeError: The argument 'file' cannot be empty. Received '' ERR_INVALID_ARG_VALUE\narg-nul: TypeError: The argument 'args[0]' must be a string without null bytes. Received 'a\\x00' ERR_INVALID_ARG_VALUE\ncwd-nul: TypeError: The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received 'c\\x00' ERR_INVALID_ARG_VALUE\nenv-nul: TypeError: The property 'options.env['A']' must be a string without null bytes. Received 'a\\x00' ERR_INVALID_ARG_VALUE\ntimeout-before-file: RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received 1.5 ERR_OUT_OF_RANGE\ntimeout-before-arg: RangeError: The value of \"timeout\" is out of range. It must be an unsigned integer. Received -2 ERR_OUT_OF_RANGE\nfile-before-env: TypeError: The argument 'file' must be a string without null bytes. Received 'f\\x00' ERR_INVALID_ARG_VALUE\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-DEC-03 invalid UTF-8 decodes to U+FFFD in captured output and in the Command-failed tail", async () => {
    const r = await runU1Source("// Invalid UTF-8 from a child: decoded with U+FFFD in captured output and in\n// the Command-failed tail.\nimport { execFileSync, spawnSync } from \"node:child_process\";\n\nconst r = spawnSync(\"/usr/bin/printf\", [\"a\\\\377b\\\\300\\\\200c\\\\342\\\\202\"], { encoding: \"utf8\" });\nconst codes: number[] = [];\nfor (let i = 0; i < r.stdout.length; i++) codes.push(r.stdout.charCodeAt(i));\nconsole.log(\"stdout:\", r.stdout.length, codes.join(\",\"));\ntry {\n  execFileSync(\"/bin/sh\", [\"-c\", \"printf 'x\\\\377y' 1>&2; exit 1\"], { encoding: \"utf8\", stdio: \"pipe\" });\n} catch (e) {\n  const m = e instanceof Error ? e.message : \"\";\n  const mc: number[] = [];\n  for (let i = 0; i < m.length; i++) mc.push(m.charCodeAt(i));\n  console.log(\"tail:\", mc.join(\",\"));\n}\nconst ok = execFileSync(\"/usr/bin/printf\", [\"\\\\303\\\\251\\\\360\\\\237\\\\230\\\\200\"], { encoding: \"utf8\" });\nconsole.log(\"valid:\", ok.length, ok.charCodeAt(0), ok.charCodeAt(1), ok.charCodeAt(2));\n");
    expect(r.stdout.toString("utf8")).toBe("stdout: 7 97,65533,98,65533,65533,99,65533\ntail: 67,111,109,109,97,110,100,32,102,97,105,108,101,100,58,32,47,98,105,110,47,115,104,32,45,99,32,112,114,105,110,116,102,32,39,120,92,51,55,55,121,39,32,49,62,38,50,59,32,101,120,105,116,32,49,10,120,65533,121\nvalid: 3 233 55357 56832\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-HYG-01 twenty children across every path leave no host handle behind (the clean-run table check)", async () => {
    const r = await runU1Source("// Twenty children across every path: success, a captured failure, a\n// spawn failure, a timeout, a caught validation throw, a caught exec\n// throw, and the promisified form resolving and rejecting.\nimport { execFile, execFileSync, execSync, spawnSync } from \"node:child_process\";\nimport { promisify } from \"node:util\";\n\nconst execFileAsync = promisify(execFile);\nlet n = 0;\nfor (let i = 0; i < 4; i++) n += spawnSync(\"/bin/echo\", [`${i}`], { encoding: \"utf8\" }).stdout.length;\nn += spawnSync(\"false\").status ?? 0;\nn += spawnSync(\"definitely-not-a-binary-xyz\").error === undefined ? 0 : 1;\nn += spawnSync(\"sleep\", [\"5\"], { timeout: 100 }).signal === \"SIGTERM\" ? 1 : 0;\nfor (const bad of [\"a\\u0000\", \"b\\u0000\"]) {\n  try {\n    spawnSync(bad);\n  } catch {\n    n += 1;\n  }\n}\nfor (let i = 0; i < 4; i++) n += execSync(`echo ${i}`, { encoding: \"utf8\" }).length;\nfor (const code of [1, 2]) {\n  try {\n    execFileSync(\"/bin/sh\", [\"-c\", `exit ${code}`], { stdio: \"pipe\" });\n  } catch {\n    n += code;\n  }\n}\nasync function main(): Promise<void> {\n  for (let i = 0; i < 3; i++) {\n    const { stdout } = await execFileAsync(\"/bin/echo\", [`${i}`]);\n    n += stdout.length;\n  }\n  try {\n    await execFileAsync(\"/bin/sh\", [\"-c\", \"exit 9\"]);\n  } catch {\n    n += 9;\n  }\n  console.log(\"total\", n);\n}\nmain();\n");
    expect(r.stdout.toString("utf8")).toBe("total 39\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-02 SEMANTICS.md S085(b): promisified execFile's Command-failed error has no numeric code (Node: the status or null)", async () => {
    const r = await runU1Source("// The promisified execFile: success, a spawn failure, a non-zero exit, a\n// signal death, a timeout's kill, and a child that traps the timeout's\n// signal and exits 0 (resolves).\nimport { execFile } from \"node:child_process\";\nimport { promisify } from \"node:util\";\n\nconst execFileAsync = promisify(execFile);\n\nasync function show(label: string, file: string, args: string[], timeout: number): Promise<void> {\n  try {\n    const { stdout, stderr } = await execFileAsync(file, args, { encoding: \"utf8\", timeout: timeout });\n    console.log(label, \"resolved\", JSON.stringify(stdout), JSON.stringify(stderr));\n  } catch (e) {\n    console.log(label, \"rejected\", e instanceof Error ? JSON.stringify(e.message) : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n  }\n}\nasync function main(): Promise<void> {\n  await show(\"ok:\", \"/bin/sh\", [\"-c\", \"printf out; printf err 1>&2\"], 0);\n  await show(\"enoent:\", \"definitely-not-a-binary-xyz\", [\"x\"], 0);\n  await show(\"exit:\", \"/bin/sh\", [\"-c\", \"printf e1 1>&2; exit 3\"], 0);\n  await show(\"signal:\", \"/bin/sh\", [\"-c\", \"kill -KILL $$\"], 0);\n  await show(\"timeout:\", \"/bin/sh\", [\"-c\", \"printf partial 1>&2; sleep 5\"], 300);\n  await show(\"trapped0:\", \"/bin/sh\", [\"-c\", \"trap 'exit 0' TERM; sleep 5 & wait\"], 300);\n  await show(\"trapped7:\", \"/bin/sh\", [\"-c\", \"trap 'exit 7' TERM; sleep 5 & wait\"], 300);\n}\nmain();\n");
    expect(r.stdout.toString("utf8")).toBe("ok: resolved \"out\" \"err\"\nenoent: rejected \"spawn definitely-not-a-binary-xyz ENOENT\" ENOENT\nexit: rejected \"Command failed: /bin/sh -c printf e1 1>&2; exit 3\\ne1\" undefined\nsignal: rejected \"Command failed: /bin/sh -c kill -KILL $$\\n\" undefined\ntimeout: rejected \"Command failed: /bin/sh -c printf partial 1>&2; sleep 5\\npartial\" undefined\ntrapped0: resolved \"\" \"\"\ntrapped7: rejected \"Command failed: /bin/sh -c trap 'exit 7' TERM; sleep 5 & wait\\n\" undefined\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-04 SEMANTICS.md S085(d): execFileSync returns 2,000,000 bytes (Node: ENOBUFS past its 1 MiB default)", async () => {
    const r = await runU1Source("// The exec family's maxBuffer: Node's default 1 MiB throws ENOBUFS.\nimport { execFileSync } from \"node:child_process\";\n\ntry {\n  const out = execFileSync(\"/bin/sh\", [\"-c\", \"head -c 2000000 /dev/zero | tr '\\\\0' 'q'\"], { encoding: \"utf8\" });\n  console.log(\"len:\", out.length);\n} catch (e) {\n  console.log(\"threw:\", e instanceof Error ? e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("len: 2000000\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-05 SEMANTICS.md S085(e): promisified execFile settles before a 20 ms timer; cat reads end-of-file and resolves", async () => {
    const r = await runU1Source("// The promisified execFile settles after the child, synchronously on the\n// tier: a timer armed before the call, and a child that reads stdin.\nimport { execFile } from \"node:child_process\";\nimport { promisify } from \"node:util\";\n\nconst execFileAsync = promisify(execFile);\nsetTimeout(() => console.log(\"timer\"), 20);\nasync function main(): Promise<void> {\n  const { stdout } = await execFileAsync(\"/bin/sh\", [\"-c\", \"sleep 0.2; printf done\"]);\n  console.log(\"settled\", stdout);\n  try {\n    const { stdout: catOut } = await execFileAsync(\"cat\", [], { timeout: 300 });\n    console.log(\"cat resolved\", JSON.stringify(catOut));\n  } catch (e) {\n    console.log(\"cat rejected\", e instanceof Error ? JSON.stringify(e.message) : \"?\");\n  }\n}\nmain();\nconsole.log(\"main-returned\");\n");
    expect(r.stdout.toString("utf8")).toBe("main-returned\nsettled done\ncat resolved \"\"\ntimer\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-07 SEMANTICS.md S085(g): an explicit cwd \"\" runs the child in the current directory (Node: ENOENT)", async () => {
    const r = await runU1Source("// An explicit empty cwd: Node fails the spawn with ENOENT.\nimport { execFileSync } from \"node:child_process\";\n\ntry {\n  const out = execFileSync(\"/bin/sh\", [\"-c\", \"echo ran\"], { encoding: \"utf8\", cwd: \"\" });\n  console.log(\"ran:\", JSON.stringify(out));\n} catch (e) {\n  console.log(\"threw:\", e instanceof Error ? e.message : \"?\", `${(e as NodeJS.ErrnoException).code}`);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("ran: \"ran\\n\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-08 SEMANTICS.md S086(b): a grandchild holding the inherited stdout lands its output before the parent's next write", async () => {
    const r = await runU1Source("// A grandchild that keeps an inherited stdout open after the child exits.\nimport { execSync } from \"node:child_process\";\n\nconsole.log(\"before\");\nexecSync(\"(sleep 0.5; echo late) & echo child-done\", { stdio: \"inherit\" });\nconsole.log(\"after\");\n");
    expect(r.stdout.toString("utf8")).toBe("before\nchild-done\nlate\nafter\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-REG-13 SEMANTICS.md S086(d): stdin 'ignore' through execFileSync reaches the child as a socket (Node: /dev/null)", async () => {
    const r = await runU1Source("// The kind of the child's stdin per stdio form: pipe and ignore through\n// literal tuples, the ignore string (all fds ignored, so the kind comes\n// back as an exit status), the runtime-string form, and the exec family.\nimport { execFileSync, spawnSync } from \"node:child_process\";\n\nconst probe = \"if [ -c /dev/stdin ]; then echo chardev; elif [ -S /dev/stdin ]; then echo socket; elif [ -p /dev/stdin ]; then echo fifo; else echo other; fi\";\nconst byStatus = \"if [ -c /dev/stdin ]; then exit 10; elif [ -S /dev/stdin ]; then exit 11; elif [ -p /dev/stdin ]; then exit 12; else exit 13; fi\";\nconsole.log(\"tuple-pipe:\", spawnSync(\"/bin/sh\", [\"-c\", probe], { encoding: \"utf8\", stdio: [\"pipe\", \"pipe\", \"pipe\"] }).stdout.trim());\nconsole.log(\"tuple-ignore:\", spawnSync(\"/bin/sh\", [\"-c\", probe], { encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"pipe\"] }).stdout.trim());\nconsole.log(\"literal-ignore status:\", spawnSync(\"/bin/sh\", [\"-c\", byStatus], { stdio: \"ignore\" }).status);\nconst runtime = (s: \"pipe\" | \"ignore\" | \"inherit\"): number | null => spawnSync(\"/bin/sh\", [\"-c\", byStatus], { encoding: \"utf8\", stdio: s }).status;\nconsole.log(\"str-ignore status:\", runtime(\"ignore\"));\nconsole.log(\"str-pipe status:\", runtime(\"pipe\"));\nconsole.log(\"plain status:\", spawnSync(\"/bin/sh\", [\"-c\", byStatus]).status);\nconsole.log(\"exec-default:\", execFileSync(\"/bin/sh\", [\"-c\", probe], { encoding: \"utf8\" }).trim());\nconsole.log(\"exec-ignore:\", execFileSync(\"/bin/sh\", [\"-c\", probe], { encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"pipe\"] }).trim());\nconsole.log(\"exec-input:\", execFileSync(\"/bin/sh\", [\"-c\", probe], { encoding: \"utf8\", input: \"\" }).trim());\n");
    expect(r.stdout.toString("utf8")).toBe("tuple-pipe: socket\ntuple-ignore: socket\nliteral-ignore status: 11\nstr-ignore status: 10\nstr-pipe status: 11\nplain status: 11\nexec-default: socket\nexec-ignore: socket\nexec-input: socket\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  // Node throws the validation error out of the call itself (its
  // promisify wrapper calls execFile synchronously), so the try catches it
  // and prints "threw: ..." then "after". Here the IR's helper is async:
  // the call returns a rejected promise, the try sees nothing, and the
  // rejection is reported unhandled at the end of the program.
  test("U1-REG-11 SEMANTICS.md S085(e): a validation failure in promisified execFile rejects the returned promise where Node throws from the call", async () => {
    const r = await runU1Source("// A validation failure in the promisified execFile, called as a statement\n// (not awaited) inside a synchronous try: Node throws from the call itself.\nimport { execFile } from \"node:child_process\";\nimport { promisify } from \"node:util\";\n\nconst execFileAsync = promisify(execFile);\ntry {\n  execFileAsync(\"t\\u0000rue\", []);\n  console.log(\"returned\");\n} catch (e) {\n  console.log(\"threw:\", e instanceof Error ? e.message : \"?\");\n}\nconsole.log(\"after\");\n");
    expect(r.stdout.toString("utf8")).toBe("returned\nafter\n");
    expect(r.stderr.toString("utf8")).toMatch(/^Unhandled promise rejection: /);
    expect(r.exitCode).toBe(1);
  }, 60000);
  // The echo's bytes, compared as bytes (a decoded comparison cannot tell
  // a raw FF from Node's EF BF BD). The first line has no encoding option:
  // Node echoes the raw byte, and so does this tier.
  test("U1-DEC-02 the default-stdio echo without an encoding writes the child's raw invalid byte (FF), as Node does", async () => {
    const r = await runU1Source("// The default-stdio echo of an invalid UTF-8 byte: without an encoding\n// option (raw) and with one (Node echoes the decoded string).\nimport { execFileSync } from \"node:child_process\";\n\nexecFileSync(\"/bin/sh\", [\"-c\", \"printf 'E1[\\\\377]\\\\n' 1>&2\"]);\nconst s = execFileSync(\"/bin/sh\", [\"-c\", \"printf 'E2[\\\\377]\\\\n' 1>&2\"], { encoding: \"utf8\" });\nconsole.log(\"done\", JSON.stringify(s));\n");
    expect(r.stdout.toString("utf8")).toBe('done ""\n');
    expect(r.stderr.subarray(0, 6).toString("hex")).toBe(Buffer.from("E1[\xff]\n", "latin1").toString("hex"));
    expect(r.exitCode).toBe(0);
  }, 60000);
  // The second line has encoding "utf8": Node echoes the DECODED string
  // (EF BF BD); this tier echoes the raw byte.
  test("U1-REG-06 SEMANTICS.md S085(f): the echo with an encoding option writes the raw byte FF where Node writes EF BF BD", async () => {
    const r = await runU1Source("// The default-stdio echo of an invalid UTF-8 byte: without an encoding\n// option (raw) and with one (Node echoes the decoded string).\nimport { execFileSync } from \"node:child_process\";\n\nexecFileSync(\"/bin/sh\", [\"-c\", \"printf 'E1[\\\\377]\\\\n' 1>&2\"]);\nconst s = execFileSync(\"/bin/sh\", [\"-c\", \"printf 'E2[\\\\377]\\\\n' 1>&2\"], { encoding: \"utf8\" });\nconsole.log(\"done\", JSON.stringify(s));\n");
    expect(r.stderr.subarray(6).toString("hex")).toBe(Buffer.from("E2[\xff]\n", "latin1").toString("hex"));
  }, 60000);
  // Node exits 1 with its stack and the error's extra properties on stderr;
  // this tier prints the uncaught report (name and message only — SEMANTICS.md
  // S085(b)). The child wrote nothing to stderr, so the message has no tail.
  test("U1-HYG-02 an uncaught execFileSync failure with an empty stderr: exit 1, the module's uncaught report with no tail", async () => {
    const r = await runU1Source("// An uncaught execFileSync failure whose child wrote nothing to stderr.\nimport { execFileSync } from \"node:child_process\";\n\nconsole.log(\"before\");\nexecFileSync(\"/bin/sh\", [\"-c\", \"exit 3\"], { stdio: \"pipe\" });\nconsole.log(\"never\");\n");
    expect(r.stdout.toString("utf8")).toBe("before\n");
    expect(r.stderr.toString("utf8")).toBe("Uncaught Error: Command failed: /bin/sh -c exit 3\n");
    expect(r.exitCode).toBe(1);
  }, 60000);
  // Node prints "mixed: 0 null undefined \"captured\\n\"" and 2,000,000
  // bytes on stderr: its inherited stream has no limit. Here the host pipes
  // the inherited stream, so spawnSync's 1 MiB default applies to it: the
  // child is killed with SIGTERM once stderr passes the limit (how far past
  // depends on pipe timing, so only the bound is asserted), and the
  // captured stdout never receives "captured".
  test("U1-REG-10 SEMANTICS.md S086(c): spawnSync with stderr inherited and stdout captured counts the inherited stream against the 1 MiB default", async () => {
    const r = await runU1Source("// spawnSync with stderr inherited and stdout captured: Node's inherited\n// stream has no limit; the captured one keeps the 1 MiB default.\nimport { spawnSync } from \"node:child_process\";\n\nconst mixed = spawnSync(\"/bin/sh\", [\"-c\", \"head -c 2000000 /dev/zero | tr '\\\\0' 'i' 1>&2; echo captured\"], { encoding: \"utf8\", stdio: [\"pipe\", \"pipe\", \"inherit\"] });\nconsole.log(\"mixed:\", mixed.status, mixed.signal, `${(mixed.error as NodeJS.ErrnoException | undefined)?.code}`, JSON.stringify(mixed.stdout));\n");
    expect(r.stdout.toString("utf8")).toBe("mixed: null SIGTERM ENOBUFS \"\"\n");
    const err = r.stderr.toString("utf8");
    expect(err.length).toBeGreaterThan(1_048_576);
    expect(err.length).toBeLessThan(2_000_000);
    expect(/^i+$/.test(err)).toBe(true);
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U1-UNIT-01 cpDecodeRequest reads every header field and run of a hand-built record at a 4-aligned base, odd-length runs padded — SINGLE-EDIT: the run padding or a header offset changed", () => {
    const { buffer, len } = buildRequest();
    expect(cpDecodeRequest(buffer, 8, len)).toEqual({
      stdinMode: 1,
      stdoutMode: 2,
      stderrMode: 1,
      killSignal: 9,
      timeoutMs: 1500,
      maxBufferMode: 1,
      file: "a\uD800",
      argv: ["x", "yz"],
      cwd: "",
      env: [
        ["K", "V"],
        ["E", ""],
      ],
      input: new Uint8Array([0xff, 0x01]),
    });
  });
  test("U1-UNIT-01b cpDecodeRequest refuses a record whose parts do not add up to its length — SINGLE-EDIT: the length check removed", () => {
    const { buffer, len } = buildRequest();
    expect(() => cpDecodeRequest(buffer, 8, len + 4)).toThrow(/request record/);
  });
  test("U1-UNIT-02 cpEncodeResult writes the 32-byte result record at the documented offsets (hasStatus 0, status 4, signal 12, errCode 16, stdoutLen 20, stderrLen 24) — SINGLE-EDIT: a field written at another offset", () => {
    const buffer = new ArrayBuffer(48);
    cpEncodeResult(buffer, 12, {
      hasStatus: 1,
      status: 7,
      signal: 15,
      errCode: -(256 + 18),
      stdout: new Uint8Array(3),
      stderr: new Uint8Array(5),
    });
    const dv = new DataView(buffer, 12, 32);
    expect([dv.getUint32(0, true), dv.getFloat64(4, true), dv.getUint32(12, true), dv.getInt32(16, true), dv.getUint32(20, true), dv.getUint32(24, true), dv.getUint32(28, true)]).toEqual([1, 7, 15, -274, 3, 5, 0]);
  });
  test("U1-UNIT-03 the host's errno table is ENOENT..ENOBUFS = 1..15 in the module's order, and a code outside it carries -(256 + errno) — SINGLE-EDIT: two table entries swapped", () => {
    expect(Object.entries(CP_HOST_CODE_INDEX).sort((a, b) => a[1] - b[1]).map(([k]) => k)).toEqual([
      "ENOENT",
      "EACCES",
      "EPERM",
      "ENOTDIR",
      "ENOEXEC",
      "ELOOP",
      "ENAMETOOLONG",
      "E2BIG",
      "ENOMEM",
      "EAGAIN",
      "EIO",
      "EINVAL",
      "ETIMEDOUT",
      "EPIPE",
      "ENOBUFS",
    ]);
    expect(cpErrCodeFor(undefined)).toBe(0);
    expect(cpErrCodeFor(Object.assign(new Error("x"), { code: "ENOENT", errno: -2 }))).toBe(1);
    expect(cpErrCodeFor(Object.assign(new Error("x"), { code: "ENOBUFS", errno: -105 }))).toBe(15);
    expect(cpErrCodeFor(Object.assign(new Error("x"), { code: "EXDEV", errno: -18 }))).toBe(-(256 + 18));
    expect(() => cpErrCodeFor(Object.assign(new Error("x"), { code: "EWEIRD" }))).toThrow(/no \.errno/);
  });
  test("U1-UNIT-04 the stdio and maxBuffer maps: stdin 0/1/2 pipe and 3 ignore, outputs 0 pipe, 1 ignore, 2 pipe (inherit emulated, never passed through), maxBuffer unbounded for the exec family or when nothing is captured — SINGLE-EDIT: inherit passed through, or a stdin mode mapped to ignore", () => {
    expect([0, 1, 2, 3].map(cpStdinFor)).toEqual(["pipe", "pipe", "pipe", "ignore"]);
    expect([0, 1, 2].map(cpStdioFor)).toEqual(["pipe", "ignore", "pipe"]);
    expect(() => cpStdinFor(4)).toThrow(/stdin mode/);
    expect(() => cpStdioFor(3)).toThrow(/output mode/);
    expect(cpMaxBufferFor({ maxBufferMode: 1, stdoutMode: 0, stderrMode: 0 })).toBe(Infinity);
    expect(cpMaxBufferFor({ maxBufferMode: 0, stdoutMode: 2, stderrMode: 1 })).toBe(Infinity);
    expect(cpMaxBufferFor({ maxBufferMode: 0, stdoutMode: 2, stderrMode: 0 })).toBeUndefined();
    expect(cpMaxBufferFor({ maxBufferMode: 0, stdoutMode: 0, stderrMode: 0 })).toBeUndefined();
  });
  test("U1-UNIT-05 a host-side throw during RUN becomes the negative status the module traps on, never an exception through the import — SINGLE-EDIT: the guard rethrows", () => {
    expect(
      cpGuardedRun(() => {
        throw new Error("boom");
      }),
    ).toBe(-1);
    expect(cpGuardedRun(() => 7)).toBe(7);
  });
});

// ── INC-28 U2 child_process async rows ───────────────────────────────────
// Rows that run real children go through this file's own runWasm and its
// event host (never a copy); the host's pure parts are driven directly by
// the unit rows. Not shard-gated: each row compiles its inline source into
// its own mkdtemp directory and owns its children and descriptors, so any
// number of copies of this block can run at once. Real-time rows keep
// Node's bounded-margin rule: a racing child is `true` or a `sleep` far
// from every timer, every busy wait runs while a child spawned before it
// is still running, and no margin is under 100 ms or 20x.
describe("INC-28 U2 child_process async rows", () => {
  /** Compiles `src` (a whole program) in a fresh directory of its own and
   * runs it through this file's runWasm; the directory goes afterwards. */
  async function runU2Source(src: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u2-row-"));
    try {
      const file = join(dir, "main.ts");
      writeFileSync(file, src);
      const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** A corpus program compiled into a fresh directory of its own (never
   * the shared content-keyed cache), then run through runWasm. */
  async function runU2Corpus(name: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u2-corpus-"));
    try {
      const res = await compile(join(corpusDir, name), { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("U2-C-1362 corpus 1362-spawn-timers.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1362-spawn-timers.ts");
    expect(r.stdout.toString("utf8")).toBe("main done\nfast exit 0\nlate exit 9\ntimer 700\nslow exit 0\ntimer 2000\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1525 corpus 1525-child-exit-signal.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1525-child-exit-signal.ts");
    expect(r.stdout.toString("utf8")).toBe("main done\nclean: 3 null true\nkilled: null SIGTERM\nnarrowed: true exit(143)\nquiet: 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-01 a child exits during _start: the pre-loop timers pass runs timer0 and timer10 before the first poll delivers the exit", async () => {
    const r = await runU2Source("// A child exits while _start busy-waits; timers 0 and 10 are due at the first look.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\nsetTimeout(() => {\n  console.log(\"timer0\");\n}, 0);\nsetTimeout(() => {\n  console.log(\"timer10\");\n}, 10);\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\ntimer0\ntimer10\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-02 a child exits during _start: the poll delivers its exit before the check phase runs the immediate", async () => {
    const r = await runU2Source("// A child exits while _start busy-waits; an immediate is queued: the exit is delivered first.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\nsetImmediate(() => {\n  console.log(\"immediate\");\n});\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nexit 0\nimmediate\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-03 two children reaped in one poll: spawn order, each exit followed by its own nextTick and microtask, all before the immediate", async () => {
    const r = await runU2Source("// Two children exit during _start (a spawned first but exiting second): spawn order,\n// each exit followed by its own nextTick and microtask, all before the check phase.\nimport { spawn } from \"node:child_process\";\nfunction watch(n: string, cmd: string, args: string[]): void {\n  const c = spawn(cmd, args, { stdio: \"ignore\" });\n  c.on(\"exit\", () => {\n    console.log(\"exit\", n);\n    process.nextTick(() => {\n      console.log(\"tick\", n);\n    });\n    Promise.resolve().then(() => {\n      console.log(\"micro\", n);\n    });\n  });\n}\nwatch(\"a\", \"/bin/sh\", [\"-c\", \"sleep 0.02\"]);\nwatch(\"b\", \"true\", []);\nsetImmediate(() => {\n  console.log(\"immediate\");\n});\nconst end = Date.now() + 600;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nexit a\ntick a\nmicro a\nexit b\ntick b\nmicro b\nimmediate\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-04 an unref'd child's exit is delivered while an immediate holds the loop", async () => {
    const r = await runU2Source("// An unref'd child's exit is delivered when an immediate holds the loop.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.unref();\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\nsetImmediate(() => {\n  console.log(\"immediate\");\n});\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nexit 0\nimmediate\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-05 an unref'd child with nothing else holding the loop: the exit is never delivered", async () => {
    const r = await runU2Source("// An unref'd child with nothing holding the loop: its exit is never delivered.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.unref();\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-06 a child exits during a timer callback that then queues an immediate: exit first", async () => {
    const r = await runU2Source("// A child exits during a timer callback that then queues an immediate.\nimport { spawn } from \"node:child_process\";\nsetTimeout(() => {\n  const c = spawn(\"true\", [], { stdio: \"ignore\" });\n  c.on(\"exit\", (code) => {\n    console.log(\"exit\", code);\n  });\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  setImmediate(() => {\n    console.log(\"immediate\");\n  });\n  console.log(\"timer done\");\n}, 10);\n");
    expect(r.stdout.toString("utf8")).toBe("timer done\nexit 0\nimmediate\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-07 an exit and a due 0 ms timer both ready: the poll phase comes before the timers phase", async () => {
    const r = await runU2Source("// A child exits during timer A, which arms timer B for 0 ms: the exit comes first.\nimport { spawn } from \"node:child_process\";\nsetTimeout(() => {\n  const c = spawn(\"true\", [], { stdio: \"ignore\" });\n  c.on(\"exit\", (code) => {\n    console.log(\"exit\", code);\n  });\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  setTimeout(() => {\n    console.log(\"timer B\");\n  }, 0);\n  console.log(\"A done\");\n}, 10);\n");
    expect(r.stdout.toString("utf8")).toBe("A done\nexit 0\ntimer B\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-08 an unref'd child exits during the last ref'd timer: liveness fails at once and the exit is never delivered", async () => {
    const r = await runU2Source("// An unref'd child exits during the last ref'd timer: alive is false right after, never delivered.\nimport { spawn } from \"node:child_process\";\nsetTimeout(() => {\n  const c = spawn(\"true\", [], { stdio: \"ignore\" });\n  c.unref();\n  c.on(\"exit\", (code) => {\n    console.log(\"exit (never)\", code);\n  });\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  console.log(\"A done\");\n}, 10);\n");
    expect(r.stdout.toString("utf8")).toBe("A done\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-09 a timer callback blocks while its child exits and a later timer becomes due: the exit, then that timer, then the holder", async () => {
    const r = await runU2Source("// A long timer callback blocks while a child it spawned exits and a later timer becomes\n// due; a sleeping holder child keeps a source live across the window.\nimport { spawn } from \"node:child_process\";\nconst holder = spawn(\"sleep\", [\"1\"], { stdio: \"ignore\" });\nholder.on(\"exit\", (code) => {\n  console.log(\"holder exit\", code);\n});\nsetTimeout(() => {\n  console.log(\"T400 (due while blocked)\");\n}, 400);\nsetTimeout(() => {\n  const c = spawn(\"true\", [], { stdio: \"ignore\" });\n  c.on(\"exit\", (code) => {\n    console.log(\"exit\", code);\n  });\n  const end = Date.now() + 400;\n  while (Date.now() < end) {\n    // busy\n  }\n  console.log(\"T200 done\");\n}, 200);\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nT200 done\nexit 0\nT400 (due while blocked)\nholder exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-LOOP-10 the last ref'd timer runs in the pre-loop pass and one poll still follows: the unref'd exit is delivered", async () => {
    const r = await runU2Source("// The last ref'd timer runs in the pre-loop timers pass; one poll still follows, so the\n// unref'd child's exit is delivered.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.unref();\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\nsetTimeout(() => {\n  console.log(\"t0 (last ref'd holder)\");\n}, 0);\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nt0 (last ref'd holder)\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-CLK-01 a timer armed in a timer callback after a busy wait counts from a fresh clock read", async () => {
    const r = await runU2Source("// A timer armed inside a callback after a busy wait counts from a fresh clock read.\nimport { spawn } from \"node:child_process\";\nconst holder = spawn(\"sleep\", [\"1\"], { stdio: \"ignore\" });\nholder.on(\"exit\", (code) => {\n  console.log(\"holder exit\", code);\n});\nsetTimeout(() => {\n  console.log(\"C (armed at start, 160)\");\n}, 160);\nsetTimeout(() => {\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  setTimeout(() => {\n    console.log(\"B (armed after busy, 50)\");\n  }, 50);\n  console.log(\"A done\");\n}, 10);\n");
    expect(r.stdout.toString("utf8")).toBe("A done\nC (armed at start, 160)\nB (armed after busy, 50)\nholder exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-CLK-02 a timer armed in an exit listener after a busy wait counts from a fresh clock read", async () => {
    const r = await runU2Source("// The same question inside an exit listener (a poll-phase callback).\nimport { spawn } from \"node:child_process\";\nconst holder = spawn(\"sleep\", [\"1\"], { stdio: \"ignore\" });\nholder.on(\"exit\", (code) => {\n  console.log(\"holder exit\", code);\n});\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", () => {\n  setTimeout(() => {\n    console.log(\"C (armed in exit, 150)\");\n  }, 150);\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  setTimeout(() => {\n    console.log(\"B (armed after busy, 40)\");\n  }, 40);\n  console.log(\"exit listener done\");\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit listener done\nC (armed in exit, 150)\nB (armed after busy, 40)\nholder exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-CLK-03 a timer armed in _start after a busy wait counts from a fresh clock read", async () => {
    const r = await runU2Source("// In _start: C armed before a busy wait, B after it.\nimport { spawn } from \"node:child_process\";\nconst holder = spawn(\"sleep\", [\"1\"], { stdio: \"ignore\" });\nholder.on(\"exit\", (code) => {\n  console.log(\"holder exit\", code);\n});\nsetTimeout(() => {\n  console.log(\"C (armed first, 150)\");\n}, 150);\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nsetTimeout(() => {\n  console.log(\"B (armed after busy, 40)\");\n}, 40);\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nC (armed first, 150)\nB (armed after busy, 40)\nholder exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-CLK-04 a timer that becomes due during an earlier timer callback waits for the next timers pass", async () => {
    const r = await runU2Source("// A timer that becomes due during an earlier timer callback does not run in the same pass.\nimport { spawn } from \"node:child_process\";\nconst holder = spawn(\"sleep\", [\"1\"], { stdio: \"ignore\" });\nholder.on(\"exit\", (code) => {\n  console.log(\"holder exit\", code);\n});\nsetTimeout(() => {\n  console.log(\"C (100)\");\n}, 100);\nsetTimeout(() => {\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  setImmediate(() => {\n    console.log(\"I (armed in A)\");\n  });\n  console.log(\"A (10) done\");\n}, 10);\n");
    expect(r.stdout.toString("utf8")).toBe("A (10) done\nI (armed in A)\nC (100)\nholder exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-CLK-05 the same with a timer of the running timer's own duration", async () => {
    const r = await runU2Source("// The same when the late timer has A's own duration.\nimport { spawn } from \"node:child_process\";\nconst holder = spawn(\"sleep\", [\"1\"], { stdio: \"ignore\" });\nholder.on(\"exit\", (code) => {\n  console.log(\"holder exit\", code);\n});\nsetTimeout(() => {\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  setTimeout(() => {\n    console.log(\"D (10, armed in A)\");\n  }, 10);\n  setImmediate(() => {\n    console.log(\"I (armed in A)\");\n  });\n  console.log(\"A (10) done\");\n}, 10);\n");
    expect(r.stdout.toString("utf8")).toBe("A (10) done\nI (armed in A)\nD (10, armed in A)\nholder exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-CLK-06 after a virtual 3000 ms jump with no child live, a new child's real clock is anchored afresh: the 100 ms timer fires before the 2 s child exits", async () => {
    const r = await runU2Source("// A child's exit is consumed, a 3 s timer passes with no source live, then a second child\n// and a 100 ms timer: the timer fires before the 2 s child exits.\nimport { spawn } from \"node:child_process\";\nconst a = spawn(\"true\", [], { stdio: \"ignore\" });\na.on(\"exit\", (code) => {\n  console.log(\"a exit\", code);\n  setTimeout(() => {\n    console.log(\"t3000\");\n    const b = spawn(\"sleep\", [\"2\"], { stdio: \"ignore\" });\n    b.on(\"exit\", (code2) => {\n      console.log(\"b exit\", code2);\n    });\n    setTimeout(() => {\n      console.log(\"t100\");\n    }, 100);\n  }, 3000);\n});\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\na exit 0\nt3000\nt100\nb exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1361 corpus 1361-spawn-events.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1361-spawn-events.ts");
    expect(r.stdout.toString("utf8")).toBe("spawned\n0\n7\n0\n-1\n-2\nspawn /no/such/bin ENOENT\nfirst 4\nsecond\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1363 corpus 1363-spawn-unhandled-error.ts: full stdout and exit code equal Node's (stderr is not compared on a nonzero exit)", async () => {
    const r = await runU2Corpus("1363-spawn-unhandled-error.ts");
    expect(r.stdout.toString("utf8")).toBe("before\n");
    expect(r.exitCode).toBe(1);
  }, 60000);
  test("U2-C-1466 corpus 1466-child-containers.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1466-child-containers.ts");
    expect(r.stdout.toString("utf8")).toBe("registered: 2\nhas alpha: true\nrunning count: 2\nafter delete: 1\nexited: alpha,beta\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1470 corpus 1470-child-lifecycle.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1470-child-lifecycle.ts");
    expect(r.stdout.toString("utf8")).toBe("c1 pid > 0 true\nc1 exitCode null\nc1 killed before false\nc1 kill -> true\nc1 killed after true\nmain done\nc1 exit arg null exitCode prop null killed true\nc1 kill after exit -> false killed still true\nunknown signal: Unknown signal: SIGWHATEVER\nc2 exit arg 3 exitCode prop 3 killed false\nc2 kill after exit -> false\nc3 error spawn definitely-not-a-binary-xyz ENOENT\nc3 pid undefined true\nc3 exitCode after error -2\nc3 kill -> false killed false\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1471 corpus 1471-child-unref.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1471-child-unref.ts");
    expect(r.stdout.toString("utf8")).toBe("main done\nquick exit 0\ntimer fired; slow killed: true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1472 corpus 1472-errno-code.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1472-errno-code.ts");
    expect(r.stdout.toString("utf8")).toBe("read: ENOENT true\nstat: ENOENT\nmkdir: EEXIST\nrmdir: ENOTEMPTY\nexec spawnfail: ENOENT\nexec fail: undefined true\nkill: ESRCH\nplain: undefined true\nmain done\nspawn error event: ENOENT\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1535 corpus 1535-spawn-fd-stdio.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1535-spawn-fd-stdio.ts");
    expect(r.stdout.toString("utf8")).toBe("true true\n\"first\\n\"\nexit 0 true true true\nTypeError The argument 'flags' is invalid. Received 'q'\ntrue true\nEBADF: bad file descriptor, close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-1570 corpus 1570-child-unref-kill-reffed.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("1570-child-unref-kill-reffed.ts");
    expect(r.stdout.toString("utf8")).toBe("main done\nkilling: true\nexit fired: true true\nholder done\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-2698 corpus 2698-spawn-options.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("2698-spawn-options.ts");
    expect(r.stdout.toString("utf8")).toBe("before children\nafter spawns\nghost error: ENOENT\nrecorder exit: 0\nown group: true\nenv+cwd: / flag\nfrom-child\necho exit: 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-C-2717 corpus 2717-spawn-conditional-spread.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU2Corpus("2717-spawn-conditional-spread.ts");
    expect(r.stdout.toString("utf8")).toBe("spawned\ndetached exit: 0\nown group: true\nattached exit: 0\nshares group: true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-01 two failed spawns among ticks, microtasks and an immediate: each 'error' on its own nextTick, in spawn order, exitCode -2 inside the listener", async () => {
    const r = await runU2Source("// Two failed spawns among ticks, microtasks and an immediate.\nimport { spawn } from \"node:child_process\";\nprocess.nextTick(() => {\n  console.log(\"tick-before\");\n});\nPromise.resolve().then(() => {\n  console.log(\"micro-before\");\n});\nsetImmediate(() => {\n  console.log(\"immediate\");\n});\nconst a = spawn(\"/no/such/a\", [], { stdio: \"ignore\" });\na.on(\"error\", (e) => {\n  console.log(\"error a\", e.message, a.exitCode, a.pid);\n});\nconst b = spawn(\"/no/such/b\", [], { stdio: \"ignore\" });\nb.on(\"error\", (e) => {\n  console.log(\"error b\", e.message);\n  process.nextTick(() => {\n    console.log(\"tick-in-b\");\n  });\n  Promise.resolve().then(() => {\n    console.log(\"micro-in-b\");\n  });\n});\nprocess.nextTick(() => {\n  console.log(\"tick-after\");\n});\nPromise.resolve().then(() => {\n  console.log(\"micro-after\");\n});\nconsole.log(\"main done\", a.pid, a.exitCode);\n");
    expect(r.stdout.toString("utf8")).toBe("main done undefined null\nmicro-before\nmicro-after\ntick-before\nerror a spawn /no/such/a ENOENT -2 undefined\nerror b spawn /no/such/b ENOENT\ntick-after\ntick-in-b\nmicro-in-b\nimmediate\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-02 the failure split: ENOTDIR is thrown at once (\"spawn ENOTDIR\"), ENOENT and EACCES are reported as 'error' (\"spawn <file> <CODE>\")", async () => {
    const r = await runU2Source("// The disposition split: ENOTDIR throws synchronously, ENOENT and EACCES emit 'error'.\nimport { spawn } from \"node:child_process\";\nfor (const cwd of [\"/etc/passwd\", \"/no/such/dir\"]) {\n  try {\n    const c = spawn(\"true\", [], { stdio: \"ignore\", cwd });\n    c.on(\"error\", (e) => {\n      console.log(\"error event\", cwd, e.message, (e as NodeJS.ErrnoException).code);\n    });\n    c.on(\"exit\", (code) => {\n      console.log(\"exit\", cwd, code);\n    });\n    console.log(\"returned\", cwd, c.pid === undefined);\n  } catch (e) {\n    console.log(\"threw\", cwd, (e as Error).message, (e as NodeJS.ErrnoException).code);\n  }\n}\ntry {\n  const c = spawn(\"/tmp\", [], { stdio: \"ignore\" });\n  c.on(\"error\", (e) => {\n    console.log(\"error event dir\", e.message, (e as NodeJS.ErrnoException).code);\n  });\n  console.log(\"returned dir\");\n} catch (e) {\n  console.log(\"threw dir\", (e as Error).message);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("threw /etc/passwd spawn ENOTDIR ENOTDIR\nreturned /no/such/dir true\nreturned dir\nerror event /no/such/dir spawn true ENOENT ENOENT\nerror event dir spawn /tmp EACCES EACCES\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-03 a failed spawn with no 'error' listener ends the program on that nextTick, after the earlier tick and before the later one (exit 1)", async () => {
    const r = await runU2Source("// A failed spawn with no 'error' listener dies on the error's nextTick, after earlier ticks.\nimport { spawn } from \"node:child_process\";\nsetTimeout(() => {\n  console.log(\"timer never\");\n}, 0);\nsetImmediate(() => {\n  console.log(\"immediate never\");\n});\nprocess.nextTick(() => {\n  console.log(\"tick before\");\n});\nconst c = spawn(\"/no/such/x\", [], { stdio: \"ignore\" });\nprocess.nextTick(() => {\n  console.log(\"tick after (never)\");\n});\nconsole.log(\"main done\", c.pid);\n");
    expect(r.stdout.toString("utf8")).toBe("main done undefined\ntick before\n");
    expect(r.exitCode).toBe(1);
  }, 60000);
  test("U2-SPN-04 spawn's argument validation: Node's TypeError texts for an empty file and NUL bytes in the file, an argument, an env key or value, and the cwd", async () => {
    const r = await runU2Source("// spawn's argument validation: Node's codes and texts, thrown synchronously.\nimport { spawn } from \"node:child_process\";\nconst tries: [string, () => unknown][] = [\n  [\"empty file\", () => spawn(\"\", [], { stdio: \"ignore\" })],\n  [\"NUL file\", () => spawn(\"tr\\u0000ue\", [], { stdio: \"ignore\" })],\n  [\"NUL arg\", () => spawn(\"true\", [\"a\\u0000b\"], { stdio: \"ignore\" })],\n  [\"NUL env\", () => spawn(\"true\", [], { stdio: \"ignore\", env: { A: \"x\\u0000y\" } })],\n  [\"NUL env key\", () => spawn(\"true\", [], { stdio: \"ignore\", env: { \"K\\u0000\": \"v\" } })],\n  [\"NUL cwd\", () => spawn(\"true\", [], { stdio: \"ignore\", cwd: \"/tm\\u0000p\" })],\n];\nfor (const [n, f] of tries) {\n  try {\n    f();\n    console.log(n, \"no throw\");\n  } catch (e) {\n    console.log(n, \"->\", (e as Error).name, (e as NodeJS.ErrnoException).code, (e as Error).message);\n  }\n}\n");
    expect(r.stdout.toString("utf8")).toBe("empty file -> TypeError ERR_INVALID_ARG_VALUE The argument 'file' cannot be empty. Received ''\nNUL file -> TypeError ERR_INVALID_ARG_VALUE The argument 'file' must be a string without null bytes. Received 'tr\\x00ue'\nNUL arg -> TypeError ERR_INVALID_ARG_VALUE The argument 'args[0]' must be a string without null bytes. Received 'a\\x00b'\nNUL env -> TypeError ERR_INVALID_ARG_VALUE The property 'options.env['A']' must be a string without null bytes. Received 'x\\x00y'\nNUL env key -> TypeError ERR_INVALID_ARG_VALUE The property 'options.env['K\u0000']' must be a string without null bytes. Received 'K\\x00'\nNUL cwd -> TypeError ERR_INVALID_ARG_VALUE The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received '/tm\\x00p'\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-05 a failed spawn followed by a successful one: the second has a pid and exits normally", async () => {
    const r = await runU2Source("// A failed spawn followed by a successful one: the second has a pid and exits.\nimport { spawn } from \"node:child_process\";\nconst bad = spawn(\"/no/such/first\", [], { stdio: \"ignore\" });\nbad.on(\"error\", (e) => {\n  console.log(\"bad error\", e.message, bad.pid === undefined);\n});\nconst good = spawn(\"/bin/sh\", [\"-c\", \"exit 6\"], { stdio: \"ignore\" });\ngood.on(\"exit\", (code) => {\n  console.log(\"good exit\", code, (good.pid ?? 0) > 0);\n});\nconsole.log(\"spawned\", bad.pid === undefined, (good.pid ?? 0) > 0);\n");
    expect(r.stdout.toString("utf8")).toBe("spawned true true\nbad error spawn /no/such/first ENOENT true\ngood exit 6 true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-06 two children with distinct exit codes reaped in one batch: spawn order, exitCode set inside each listener", async () => {
    const r = await runU2Source("// Two children with distinct exit codes, both exited before the first poll: spawn order.\nimport { spawn } from \"node:child_process\";\nconst a = spawn(\"/bin/sh\", [\"-c\", \"sleep 0.02; exit 3\"], { stdio: \"ignore\" });\na.on(\"exit\", (code, signal) => {\n  console.log(\"a\", code, signal, a.exitCode);\n});\nconst b = spawn(\"/bin/sh\", [\"-c\", \"exit 5\"], { stdio: \"ignore\" });\nb.on(\"exit\", (code, signal) => {\n  console.log(\"b\", code, signal, b.exitCode);\n});\nconst end = Date.now() + 600;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\", a.exitCode, b.exitCode);\n");
    expect(r.stdout.toString("utf8")).toBe("main done null null\na 3 null 3\nb 5 null 5\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-07 an exit listener queues a nextTick, a microtask, an immediate and a 0 ms timer: tick, microtask, immediate, timer", async () => {
    const r = await runU2Source("// An exit listener queues a nextTick, a microtask, an immediate and a 0 ms timer.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", () => {\n  console.log(\"exit\");\n  setTimeout(() => {\n    console.log(\"timer0\");\n  }, 0);\n  setImmediate(() => {\n    console.log(\"immediate\");\n  });\n  process.nextTick(() => {\n    console.log(\"tick\");\n  });\n  Promise.resolve().then(() => {\n    console.log(\"micro\");\n  });\n});\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nexit\ntick\nmicro\nimmediate\ntimer0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-08 a child spawned from an exit listener exits before a 600 ms timer armed at start", async () => {
    const r = await runU2Source("// A child spawned from an exit listener, against a timer armed at start.\nimport { spawn } from \"node:child_process\";\nsetTimeout(() => {\n  console.log(\"timer 600\");\n}, 600);\nconst first = spawn(\"true\", [], { stdio: \"ignore\" });\nfirst.on(\"exit\", () => {\n  console.log(\"first exit\");\n  const late = spawn(\"/bin/sh\", [\"-c\", \"exit 9\"], { stdio: \"ignore\" });\n  late.on(\"exit\", (code) => {\n    console.log(\"late exit\", code);\n  });\n});\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nfirst exit\nlate exit 9\ntimer 600\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-09 env replacement and cwd: the child sees only the given variables, in the given directory", async () => {
    const r = await runU2Source("// env replacement and cwd: the child sees only the given variables, in the given directory.\nimport { spawn } from \"node:child_process\";\nimport { mkdtempSync, readFileSync, rmSync } from \"node:fs\";\nimport { join } from \"node:path\";\nimport { tmpdir } from \"node:os\";\nconst dir = mkdtempSync(join(tmpdir(), \"u2-envcwd-\"));\nconst out = join(dir, \"seen.txt\");\nconst c = spawn(\"/bin/sh\", [\"-c\", `echo \"$PWD|$ONLY|\\${HOME-unset}\" > ${out}`], {\n  stdio: \"ignore\",\n  cwd: \"/\",\n  env: { ONLY: \"here\" },\n});\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code, readFileSync(out, \"utf8\").trim());\n  rmSync(dir, { recursive: true, force: true });\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0 /|here|unset\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-10 an explicit cwd \"\" on the asynchronous path runs the child in the current directory, as Node does", async () => {
    const r = await runU2Source("// An explicit cwd \"\" on the async path.\nimport { spawn } from \"node:child_process\";\ntry {\n  const c = spawn(\"/bin/sh\", [\"-c\", \"exit 0\"], { stdio: \"ignore\", cwd: \"\" });\n  c.on(\"error\", (e) => {\n    console.log(\"error\", e.message, (e as NodeJS.ErrnoException).code);\n  });\n  c.on(\"exit\", (code) => {\n    console.log(\"exit\", code);\n  });\n  console.log(\"returned\", c.pid === undefined);\n} catch (e) {\n  console.log(\"threw\", (e as Error).message);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("returned false\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-SPN-11 two exit listeners each queue work: both listeners run, then the ticks, then the microtask", async () => {
    const r = await runU2Source("// Two exit listeners each queue a nextTick and a microtask: both listeners run, then the ticks and microtasks.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", () => {\n  console.log(\"listener 1\");\n  process.nextTick(() => {\n    console.log(\"tick 1\");\n  });\n  Promise.resolve().then(() => {\n    console.log(\"micro 1\");\n  });\n});\nc.on(\"exit\", () => {\n  console.log(\"listener 2\");\n  process.nextTick(() => {\n    console.log(\"tick 2\");\n  });\n});\n");
    expect(r.stdout.toString("utf8")).toBe("listener 1\nlistener 2\ntick 1\ntick 2\nmicro 1\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-KILL-01 a child that exited during _start is not yet reaped: kill answers true and killed flips", async () => {
    const r = await runU2Source("// A child that exited during _start is a zombie until the first poll: kill answers true.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", (code, sig) => {\n  console.log(\"exit\", code, sig, \"killed\", c.killed, \"exitCode\", c.exitCode);\n});\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"exitCode before poll\", c.exitCode);\nconsole.log(\"kill ->\", c.kill(), \"killed\", c.killed);\n");
    expect(r.stdout.toString("utf8")).toBe("exitCode before poll null\nkill -> true killed true\nexit 0 null killed true exitCode 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-KILL-02 two children reaped in one batch: inside a's listener b is already reaped, kill answers false, b.exitCode is still null", async () => {
    const r = await runU2Source("// Two children reaped in one batch: in a's listener, b is already reaped, so kill is false.\nimport { spawn } from \"node:child_process\";\nconst a = spawn(\"true\", [], { stdio: \"ignore\" });\nconst b = spawn(\"true\", [], { stdio: \"ignore\" });\na.on(\"exit\", () => {\n  console.log(\"a exit; b.exitCode\", b.exitCode, \"b.kill() ->\", b.kill(), \"b.killed\", b.killed);\n});\nb.on(\"exit\", (code, sig) => {\n  console.log(\"b exit\", code, sig, \"killed\", b.killed);\n});\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\na exit; b.exitCode null b.kill() -> false b.killed false\nb exit 0 null killed false\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-KILL-03 a child spawned in a timer exits during that callback's busy wait: kill answers true", async () => {
    const r = await runU2Source("// A child spawned in a timer exits during that callback's busy wait: kill answers true.\nimport { spawn } from \"node:child_process\";\nsetTimeout(() => {\n  const c = spawn(\"true\", [], { stdio: \"ignore\" });\n  c.on(\"exit\", (code, sig) => {\n    console.log(\"c exit\", code, sig, \"killed\", c.killed);\n  });\n  const end = Date.now() + 300;\n  while (Date.now() < end) {\n    // busy\n  }\n  console.log(\"in timer: c.kill() ->\", c.kill(), \"killed\", c.killed);\n}, 10);\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nin timer: c.kill() -> true killed true\nc exit 0 null killed true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-KILL-04 kill on a failed spawn, before and after its 'error': false, killed stays false", async () => {
    const r = await runU2Source("// kill(0) on a failed spawn before its 'error' fires: false, no host child.\nimport { spawn } from \"node:child_process\";\nconst a = spawn(\"/no/such/a\", [], { stdio: \"ignore\" });\na.on(\"error\", (e) => {\n  console.log(\"error\", e.message, \"killed\", a.killed, \"kill after ->\", a.kill(\"SIGTERM\"));\n});\nconsole.log(\"kill(0) ->\", a.kill(0), \"killed\", a.killed);\n");
    expect(r.stdout.toString("utf8")).toBe("kill(0) -> false killed false\nerror spawn /no/such/a ENOENT killed false kill after -> false\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-KILL-05 kill(0) probes a live child (true, killed flips), kill(9) by number, false after the exit, an unknown number throws", async () => {
    const r = await runU2Source("// kill(0) probes a live child (true, and killed flips); kill(9) by number; kill after exit.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sleep\", [\"5\"], { stdio: \"ignore\" });\nconsole.log(\"kill(0) ->\", c.kill(0), \"killed\", c.killed);\nc.on(\"exit\", (code, signal) => {\n  console.log(\"exit\", code, signal, \"exitCode\", c.exitCode, \"killed\", c.killed);\n  console.log(\"kill(9) after exit ->\", c.kill(9));\n  try {\n    c.kill(999);\n  } catch (e) {\n    console.log(\"unknown number:\", (e as Error).name, (e as NodeJS.ErrnoException).code, (e as Error).message);\n  }\n});\nconsole.log(\"kill(9) ->\", c.kill(9), \"killed\", c.killed);\n");
    expect(r.stdout.toString("utf8")).toBe("kill(0) -> true killed true\nkill(9) -> true killed true\nexit null SIGKILL exitCode null killed true\nkill(9) after exit -> false\nunknown number: TypeError ERR_UNKNOWN_SIGNAL Unknown signal: 999\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-KILL-06 kill by name: SIGKILL, the default SIGTERM, and an unknown name throwing even after the exit", async () => {
    const r = await runU2Source("// kill by name: SIGKILL death, the default SIGTERM, and an unknown name throwing even after exit.\nimport { spawn } from \"node:child_process\";\nconst a = spawn(\"sleep\", [\"5\"], { stdio: \"ignore\" });\na.on(\"exit\", (code, signal) => {\n  console.log(\"a\", code, signal, a.killed);\n  const b = spawn(\"sleep\", [\"5\"], { stdio: \"ignore\" });\n  b.on(\"exit\", (code2, signal2) => {\n    console.log(\"b\", code2, signal2, b.killed);\n    try {\n      b.kill(\"SIGNOPE\");\n    } catch (e) {\n      console.log(\"threw\", (e as Error).name, (e as NodeJS.ErrnoException).code, (e as Error).message);\n    }\n  });\n  console.log(\"b.kill() ->\", b.kill());\n});\nconsole.log(\"a.kill(SIGKILL) ->\", a.kill(\"SIGKILL\"));\n");
    expect(r.stdout.toString("utf8")).toBe("a.kill(SIGKILL) -> true\na null SIGKILL true\nb.kill() -> true\nb null SIGTERM true\nthrew TypeError ERR_UNKNOWN_SIGNAL Unknown signal: SIGNOPE\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-KILL-07 kill's signal spellings: names are upper-cased (U+017F included); fractional, negative, too-large numbers, the empty name and SIGUNUSED throw", async () => {
    const r = await runU2Source("// child.kill signal spellings: lower case, a non-ASCII case-fold, fractional and negative numbers.\nimport { spawn } from \"node:child_process\";\nconst show = (label: string, f: () => boolean): void => {\n  try {\n    console.log(label, f());\n  } catch (e) {\n    console.log(label, \"threw\", (e as Error).name, (e as NodeJS.ErrnoException).code, (e as Error).message);\n  }\n};\nconst c = spawn(\"sleep\", [\"5\"], { stdio: \"ignore\" });\nshow(\"9.5\", () => c.kill(9.5));\nshow(\"-1\", () => c.kill(-1));\nshow(\"32\", () => c.kill(32));\nshow(\"empty\", () => c.kill(\"\"));\nshow(\"SIGUNUSED\", () => c.kill(\"SIGUNUSED\"));\nshow(\"ſigterm\", () => c.kill(\"ſigterm\"));\nc.on(\"exit\", (code, signal) => {\n  console.log(\"exit\", code, signal, c.killed);\n});\nshow(\"sigterm\", () => c.kill(\"sigterm\"));\n");
    expect(r.stdout.toString("utf8")).toBe("9.5 threw TypeError ERR_UNKNOWN_SIGNAL Unknown signal: 9.5\n-1 threw TypeError ERR_UNKNOWN_SIGNAL Unknown signal: -1\n32 threw TypeError ERR_UNKNOWN_SIGNAL Unknown signal: 32\nempty threw TypeError ERR_UNKNOWN_SIGNAL Unknown signal: \nSIGUNUSED threw TypeError ERR_UNKNOWN_SIGNAL Unknown signal: SIGUNUSED\nſigterm true\nsigterm true\nexit null SIGTERM true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-STATE-01 unref inside the exit listener and after it is a no-op on a finished child", async () => {
    const r = await runU2Source("// unref() inside the exit listener and after it: a no-op on a finished child.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", (code) => {\n  c.unref();\n  console.log(\"exit\", code);\n  setTimeout(() => {\n    c.unref();\n    console.log(\"after\", c.exitCode);\n  }, 20);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\nafter 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-01 descriptors by number: fd 2 in the stdout slot reaches the program's stderr; fds 1 and 2 in their own slots", async () => {
    const r = await runU2Source("// fds by number: fd 2 in the stdout slot reaches the program's stderr; fds 1 and 2 in their own slots.\nimport { spawn } from \"node:child_process\";\nconst a = spawn(\"/bin/sh\", [\"-c\", \"echo to-slot1-fd2\"], { stdio: [\"ignore\", 2, \"ignore\"] });\na.on(\"exit\", (code) => {\n  console.log(\"a exit\", code);\n  const b = spawn(\"/bin/sh\", [\"-c\", \"echo out-on-1; echo err-on-2 >&2\"], { stdio: [\"ignore\", 1, 2] });\n  b.on(\"exit\", (code2) => {\n    console.log(\"b exit\", code2);\n  });\n});\nconsole.log(\"parent first\");\n");
    expect(r.stdout.toString("utf8")).toBe("parent first\na exit 0\nout-on-1\nb exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("to-slot1-fd2\nerr-on-2\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-02 fd 0 in the stdout slot: the child's write fails with SIGPIPE, as under the harness's Node (exit null)", async () => {
    const r = await runU2Source("// fd 0 in the stdout slot.\nimport { spawn } from \"node:child_process\";\nconst b = spawn(\"/bin/sh\", [\"-c\", \"echo to-slot1-fd0; echo status=$? >&2\"], { stdio: [\"ignore\", 0, 2] });\nb.on(\"exit\", (code) => {\n  console.log(\"b exit\", code);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("b exit null\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-03 a descriptor nothing has open: spawn throws EBADF at once", async () => {
    const r = await runU2Source("// An fd the process does not have open: spawn throws EBADF synchronously.\nimport { spawn } from \"node:child_process\";\ntry {\n  const c = spawn(\"true\", [], { stdio: [\"ignore\", 98765, \"ignore\"] });\n  c.on(\"error\", (e) => {\n    console.log(\"error event\", e.message);\n  });\n  console.log(\"returned\", c.pid === undefined);\n} catch (e) {\n  console.log(\"threw\", (e as Error).message, (e as NodeJS.ErrnoException).code);\n}\nconsole.log(\"after\");\n");
    expect(r.stdout.toString("utf8")).toBe("threw spawn EBADF EBADF\nafter\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-05 stdio inherit: a child writing to both streams between the program's own lines", async () => {
    const r = await runU2Source("// stdio inherit: a child writing to both streams, between the parent's own lines.\nimport { spawn } from \"node:child_process\";\nconsole.log(\"parent before\");\nconst c = spawn(\"/bin/sh\", [\"-c\", \"echo child-out; echo child-err >&2; echo child-out-2\"], { stdio: \"inherit\" });\nc.on(\"exit\", (code) => {\n  console.log(\"parent after\", code);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("parent before\nchild-out\nchild-out-2\nparent after 0\n");
    expect(r.stderr.toString("utf8")).toBe("child-err\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-06 an inherited stream of 200000 bytes, larger than the module's first event buffer, arrives whole", async () => {
    const r = await runU2Source("// An inherited child writing 200000 bytes to stderr and a short line to stdout.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"head -c 200000 /dev/zero | tr '\\\\0' 'e' >&2; echo done-out\"], { stdio: \"inherit\" });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("done-out\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-07 stdin inherit on the asynchronous path: the child reads end of file", async () => {
    const r = await runU2Source("// stdin inherit on the async path: the child reads its stdin to end of file.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"n=$(wc -c); echo stdin-bytes=$n\"], { stdio: [\"inherit\", \"inherit\", \"inherit\"] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("stdin-bytes=0\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-04 a descriptor THIS test opened (200) but the program never did: the host refuses it as EBADF, as Node does for a descriptor its own process does not hold — SINGLE-EDIT: the host passes any number through", async () => {
    // The test holds descriptor 200 itself: /dev/null placeholders fill every
    // lower free number, the scratch file lands on 200, the placeholders close.
    const dir = mkdtempSync(join(tmpdir(), "u2-fd200-"));
    const placeholders: number[] = [];
    let held = -1;
    try {
      for (let fd = openSync("/dev/null", "r"); ; fd = openSync("/dev/null", "r")) {
        placeholders.push(fd);
        if (fd >= 199) break;
      }
      held = openSync(join(dir, "held.txt"), "w");
      expect(held).toBe(200);
      for (const fd of placeholders) closeSync(fd);
      placeholders.length = 0;
      const r = await runU2Source("// A program passes descriptor 200, which it never opened, in the stdout slot.\nimport { spawn } from \"node:child_process\";\ntry {\n  const c = spawn(\"/bin/sh\", [\"-c\", \"echo into-the-fd\"], { stdio: [\"ignore\", __FD__, \"ignore\"] });\n  c.on(\"exit\", (code) => {\n    console.log(\"exit\", code);\n  });\n  console.log(\"returned\");\n} catch (e) {\n  console.log(\"threw\", (e as Error).message, (e as NodeJS.ErrnoException).code);\n}\nconsole.log(\"after\");\n".replace("__FD__", String(held)));
      expect(r.stdout.toString("utf8")).toBe("threw spawn EBADF EBADF\nafter\n");
      expect(r.stderr.toString("utf8")).toBe("");
      expect(r.exitCode).toBe(0);
      expect(readFileSync(join(dir, "held.txt"), "utf8")).toBe("");
    } finally {
      for (const fd of placeholders) closeSync(fd);
      if (held >= 0) closeSync(held);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
  test("U2-UNIT-05 an output slot routed by descriptor NUMBER: inherit and fds 1/2 are captured for the program stdout/stderr whatever the slot, fd 0 is the closed-reader pipe, an fd this run opened passes through, any other is EBADF — SINGLE-EDIT: routed by slot", () => {
    const open = new Set([7]);
    expect(stdioRouteFor(1, 0, 0, open)).toBe("ignore");
    expect(stdioRouteFor(2, 1, 0, open)).toEqual({ capture: 2 });
    expect(stdioRouteFor(1, 2, 2, open)).toEqual({ capture: 2 });
    expect(stdioRouteFor(2, 2, 1, open)).toEqual({ capture: 1 });
    expect(stdioRouteFor(1, 2, 0, open)).toBe("fd0-pipe");
    expect(stdioRouteFor(1, 2, 7, open)).toEqual({ fd: 7 });
    expect(stdioRouteFor(2, 2, 8, open)).toBe("EBADF");
    // INC-28 U3: mode 3 is now a piped slot; the first unknown mode is 4.
    expect(stdioRouteFor(1, 3, 0, open)).toBe("pipe");
    expect(() => stdioRouteFor(1, 4, 0, open)).toThrow(/output mode/);
  });
  test("U2-HYG-01 an exit listener throws while a `sleep 5` child is live: the program dies with exit 1 (stdout and exit asserted; the leftover kill is U2-HYG-03's assertion, not this row's)", async () => {
    const r = await runU2Source("// An exit listener throws while another child is still running: the program dies (exit 1).\nimport { spawn } from \"node:child_process\";\nconst long = spawn(\"sleep\", [\"5\"], { stdio: \"ignore\" });\nlong.on(\"exit\", () => {\n  console.log(\"long exit never\");\n});\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", () => {\n  console.log(\"throwing\");\n  throw new Error(\"boom in exit\");\n});\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nthrowing\n");
    expect(r.exitCode).toBe(1);
  }, 60000);
  test("U2-HYG-02 process.exit(4) inside an exit listener while another child is live: the 'exit' listeners run and the program exits 4", async () => {
    const r = await runU2Source("// process.exit inside an exit listener while another child is still running.\nimport { spawn } from \"node:child_process\";\nconst long = spawn(\"sleep\", [\"5\"], { stdio: \"ignore\" });\nlong.on(\"exit\", () => {\n  console.log(\"long exit never\");\n});\nprocess.on(\"exit\", (code) => {\n  console.log(\"process exit\", code);\n});\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", () => {\n  console.log(\"exiting 4\");\n  process.exit(4);\n});\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nexiting 4\nprocess exit 4\n");
    expect(r.exitCode).toBe(4);
  }, 60000);
  test("U2-REG-01 SEMANTICS.md S086 (f): output a child inherits is written when the event loop polls, so the program's own line written during a busy wait comes first (Node: the child's line first)", async () => {
    // Node prints "child-first\nparent after busy\nexit 0\n".
    const r = await runU2Source("// An inherited child writes at once while the parent busy-waits, then the parent writes.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"echo child-first\"], { stdio: \"inherit\" });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\nconst end = Date.now() + 300;\nwhile (Date.now() < end) {\n  // busy\n}\nconsole.log(\"parent after busy\");\n");
    expect(r.stdout.toString("utf8")).toBe("parent after busy\nchild-first\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-REG-02 SEMANTICS.md S086 (g): a grandchild holding the inherited stdout delays the child's 'exit' until it closes the stream (Node: 'exit' when the child itself exits)", async () => {
    // Node prints "early\nexit 0\ntimer 300\nlate\n".
    const r = await runU2Source("// A child leaves a background process holding the inherited stdout; a 300 ms timer races its exit.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"(sleep 1; echo late) & echo early\"], { stdio: \"inherit\" });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\nsetTimeout(() => {\n  console.log(\"timer 300\");\n}, 300);\n");
    expect(r.stdout.toString("utf8")).toBe("early\ntimer 300\nlate\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-REG-03 SEMANTICS.md S086 (h): an asynchronous child's stdin given as \"inherit\" is /dev/null (Node passes its own stdin: a socket under the harness)", async () => {
    // Node prints "socket:[N]\nexit 0\n".
    // The probe's sed replaces the socket's inode number with N.
    const r = await runU2Source("// What the child's stdin is under stdio \"inherit\" (the async path).\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"readlink /proc/self/fd/0 | sed 's/[0-9][0-9]*/N/g'\"], { stdio: \"inherit\" });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("/dev/null\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-REG-05 SEMANTICS.md S085 (b): a failed spawn's 'error' carries name, message and code only — console.log shows no errno, syscall, path or spawnargs (Node shows all four after the stack)", async () => {
    // Node prints "Error: spawn /no/such/shape ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:287:19)\n    at onErrorNT (node:internal/child_process:508:16)\n    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {\n  errno: -2,\n  code: 'ENOENT',\n  syscall: 'spawn /no/such/shape',\n  path: '/no/such/shape',\n  spawnargs: [ 'a1' ]\n}\nError spawn /no/such/shape ENOENT ENOENT true\n".
    const r = await runU2Source("// The spawn error as console.log renders it (Node: the stack, then its own properties).\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/no/such/shape\", [\"a1\"], { stdio: \"ignore\" });\nc.on(\"error\", (e) => {\n  console.log(e);\n  console.log(e.name, e.message, (e as NodeJS.ErrnoException).code, e instanceof Error);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("[Error: spawn /no/such/shape ENOENT] { code: 'ENOENT' }\nError spawn /no/such/shape ENOENT ENOENT true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-REG-06 SEMANTICS.md S086 (j): a descriptor the program did not open (5) is refused as EBADF (Node hands the child whatever its own process holds at 5)", async () => {
    // Node prints "returned\nexit 0\n" with stderr "status=1\n".
    const r = await runU2Source("// A program passes descriptor 5, which it never opened, in the stdout slot.\nimport { spawn } from \"node:child_process\";\ntry {\n  const c = spawn(\"/bin/sh\", [\"-c\", \"echo into-fd-5 2>/dev/null; echo status=$? >&2\"], { stdio: [\"ignore\", 5, 2] });\n  c.on(\"exit\", (code) => {\n    console.log(\"exit\", code);\n  });\n  console.log(\"returned\");\n} catch (e) {\n  console.log(\"threw\", (e as Error).message, (e as NodeJS.ErrnoException).code);\n}\n");
    expect(r.stdout.toString("utf8")).toBe("threw spawn EBADF EBADF\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-HYG-03 a child still running when the program calls process.exit is killed by the host at the end of the run (its process is gone within 2 s)", async () => {
    const r = await runU2Source("// A running child is left behind when the program calls process.exit; it prints the child's pid first.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sleep\", [\"30\"], { stdio: \"ignore\" });\nconsole.log(\"pid\", c.pid);\nsetTimeout(() => {\n  process.exit(0);\n}, 50);\n");
    const m = /^pid (\d+)\n$/.exec(r.stdout.toString("utf8"));
    expect(m).not.toBeNull();
    expect(r.exitCode).toBe(0);
    // The host killed the child when the run ended; this test only watches
    // for its process entry to go, and never signals anything itself.
    const pid = Number(m![1]);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      gone = !existsSync(`/proc/${pid}`) || readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") === true;
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(gone).toBe(true);
  }, 60000);
  test("U2-REG-04 SEMANTICS.md S086 (i): an unref'd child still running when the loop has nothing left is killed by the host at the end of the run (Node leaves it running)", async () => {
    const r = await runU2Source("// An unref'd child still running when the loop has nothing left: the program ends; it prints the child's pid.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sleep\", [\"30\"], { stdio: \"ignore\" });\nc.unref();\nconsole.log(\"pid\", c.pid);\n");
    const m = /^pid (\d+)\n$/.exec(r.stdout.toString("utf8"));
    expect(m).not.toBeNull();
    expect(r.exitCode).toBe(0);
    // The host killed the child when the run ended; this test only watches
    // for its process entry to go, and never signals anything itself.
    const pid = Number(m![1]);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      gone = !existsSync(`/proc/${pid}`) || readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") === true;
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(gone).toBe(true);
  }, 60000);
  test("U2-HYG-04 no run leaves the spawn tracing channel subscribed: the host subscribes only for the span of each spawn() call — SINGLE-EDIT: the subscriber left attached", async () => {
    const r = await runU2Source("// A failed spawn followed by a successful one: the second has a pid and exits.\nimport { spawn } from \"node:child_process\";\nconst bad = spawn(\"/no/such/first\", [], { stdio: \"ignore\" });\nbad.on(\"error\", (e) => {\n  console.log(\"bad error\", e.message, bad.pid === undefined);\n});\nconst good = spawn(\"/bin/sh\", [\"-c\", \"exit 6\"], { stdio: \"ignore\" });\ngood.on(\"exit\", (code) => {\n  console.log(\"good exit\", code, (good.pid ?? 0) > 0);\n});\nconsole.log(\"spawned\", bad.pid === undefined, (good.pid ?? 0) > 0);\n");
    expect(r.exitCode).toBe(0);
    expect(dcHasSubscribers("tracing:child_process.spawn:start")).toBe(false);
    expect(dcHasSubscribers("tracing:child_process.spawn:error")).toBe(false);
  }, 60000);
  test("U2-SPN-12 a listener added during an 'exit' or 'error' emission is not called for that emission (the listener list is read once, as Node's emit copies it)", async () => {
    const r = await runU2Source("import { spawn } from \"node:child_process\";\n// A listener added DURING the 'exit' emission is not called for that emission (EventEmitter.emit snapshots its listener list).\nconst c = spawn(\"true\", [], { stdio: \"ignore\" });\nc.on(\"exit\", () => {\n  console.log(\"first\");\n  c.on(\"exit\", () => {\n    console.log(\"added during emit (Node: never)\");\n  });\n});\nconst bad = spawn(\"/no/such/listener-snapshot\", [], { stdio: \"ignore\" });\nbad.on(\"error\", () => {\n  console.log(\"error first\");\n  bad.on(\"error\", () => {\n    console.log(\"error added during emit (Node: never)\");\n  });\n});\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nerror first\nfirst\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-FD-08 both output slots naming the program's fd 2 share one pipe: the child's alternating writes keep their order", async () => {
    const r = await runU2Source("import { spawn } from \"node:child_process\";\n// Both output slots given the program's fd 2: one destination, the child's write order kept (Node: the same fd).\nconst c = spawn(\"/bin/sh\", [\"-c\", \"echo a; echo b >&2; echo c; echo d >&2\"], { stdio: [\"ignore\", 2, 2] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\n");
    expect(r.stderr.toString("utf8")).toBe("a\nb\nc\nd\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U2-UNIT-01 evPoll's record: a 24-byte header (source, handle, kind, payloadLen, a, b) then the payload; a short buffer answers -(the length needed) and writes nothing — SINGLE-EDIT: the payload offset or the short-buffer answer changed", () => {
    const buf = new ArrayBuffer(64);
    const ev = { source: 1, handle: 7, kind: 2, a: -1, b: 9, payload: new Uint8Array([104, 105]) };
    expect(evEncodeRecord(buf, 8, 25, ev)).toBe(-26);
    expect(new Uint8Array(buf).every((x) => x === 0)).toBe(true);
    expect(evEncodeRecord(buf, 8, 26, ev)).toBe(26);
    const dv = new DataView(buf, 8);
    expect([dv.getUint32(0, true), dv.getUint32(4, true), dv.getUint32(8, true), dv.getUint32(12, true), dv.getInt32(16, true), dv.getInt32(20, true)]).toEqual([1, 7, 2, 2, -1, 9]);
    expect([...new Uint8Array(buf, 32, 2)]).toEqual([104, 105]);
  });
  test("U2-UNIT-02 the SPAWN request: the 32-byte header (modes, fds, detached) and the runs (file, args, cwd, pairs) decode, and a length that does not add up throws — SINGLE-EDIT: a header offset changed", () => {
    const buf = new ArrayBuffer(256);
    const dv = new DataView(buf);
    [0, 1, 2].forEach((m, i) => dv.setUint32(4 * i, m, true));
    dv.setInt32(12, 9, true);
    dv.setInt32(16, -1, true);
    dv.setUint32(20, 1, true);
    let off = 32;
    const run = (s: string): void => {
      dv.setUint32(off, s.length, true);
      for (let i = 0; i < s.length; i++) dv.setUint16(off + 4 + 2 * i, s.charCodeAt(i), true);
      off += 4 + ((2 * s.length + 3) & ~3);
    };
    const u32 = (v: number): void => {
      dv.setUint32(off, v, true);
      off += 4;
    };
    run("sh");
    u32(2);
    run("-c");
    run("exit 1");
    run("/tmp");
    u32(1);
    run("K");
    run("v");
    expect(spawnDecodeRequest(buf, 0, off)).toEqual({ stdinMode: 0, stdoutMode: 1, stderrMode: 2, outFd: 9, errFd: -1, detached: 1, file: "sh", argv: ["-c", "exit 1"], cwd: "/tmp", env: [["K", "v"]] });
    expect(() => spawnDecodeRequest(buf, 0, off + 4)).toThrow(/add up/);
  });
  test("U2-UNIT-03 KILL's answer from public kill(): true is 0, a throw its errno, false with a host 'error' that error's errno, false alone ESRCH (-3) — SINGLE-EDIT: false mapped to 0", () => {
    expect(killErrnoFor({ returned: true, thrownErrno: undefined, errorErrno: undefined })).toBe(0);
    expect(killErrnoFor({ returned: undefined, thrownErrno: -22, errorErrno: undefined })).toBe(-22);
    expect(killErrnoFor({ returned: false, thrownErrno: undefined, errorErrno: -1 })).toBe(-1);
    expect(killErrnoFor({ returned: false, thrownErrno: undefined, errorErrno: undefined })).toBe(-3);
  });
  test("U2-UNIT-04 the SPAWN disposition: thrown + a channel errno is 2, no pid + a channel errno is 1, a pid and no errno is 0, anything else a host failure — SINGLE-EDIT: the two failure dispositions swapped", () => {
    expect(dispositionFor({ threw: true, dcErrno: -20, pid: undefined })).toEqual({ disposition: 2, errno: -20 });
    expect(dispositionFor({ threw: false, dcErrno: -2, pid: undefined })).toEqual({ disposition: 1, errno: -2 });
    expect(dispositionFor({ threw: false, dcErrno: undefined, pid: 4242 })).toEqual({ disposition: 0, errno: 0 });
    expect(dispositionFor({ threw: true, dcErrno: undefined, pid: undefined })).toBeNull();
    expect(dispositionFor({ threw: false, dcErrno: undefined, pid: undefined })).toBeNull();
    expect(dispositionFor({ threw: false, dcErrno: -2, pid: 4242 })).toBeNull();
  });
  test("U2-UNIT-06 the tracing channel the host reads spawn failures from still fires synchronously inside public spawn(): ENOENT on a returned child without a pid, ENOTDIR on a throw, the start message naming the ChildProcess being created — SINGLE-EDIT: the subscriber attached after the call", () => {
    const seen: { kind: string; errno: number | undefined; same: boolean }[] = [];
    let created: unknown;
    const onStart = (msg: unknown): void => {
      created = (msg as { process?: unknown }).process;
    };
    const onError = (msg: unknown): void => {
      const m = msg as { process?: unknown; error?: { errno?: number } };
      seen.push({ kind: "error", errno: m.error?.errno, same: m.process === created });
    };
    dcSubscribe("tracing:child_process.spawn:start", onStart);
    dcSubscribe("tracing:child_process.spawn:error", onError);
    let returned: ChildProcess | undefined;
    let threw = false;
    try {
      returned = spawn("/no/such/u2-dc-self-test", [], { stdio: "ignore" });
      returned.on("error", () => {});
      expect(seen).toEqual([{ kind: "error", errno: -2, same: true }]);
      expect(returned.pid).toBeUndefined();
      expect(created).toBe(returned);
      try {
        spawn("true", [], { stdio: "ignore", cwd: "/etc/passwd" });
      } catch {
        threw = true;
      }
    } finally {
      dcUnsubscribe("tracing:child_process.spawn:start", onStart);
      dcUnsubscribe("tracing:child_process.spawn:error", onError);
    }
    expect(threw).toBe(true);
    expect(seen).toEqual([
      { kind: "error", errno: -2, same: true },
      { kind: "error", errno: -20, same: true },
    ]);
  });
  test("U2-UNIT-07 the event host's clock: virtual with no child live; real time from the anchor while one is, never behind the virtual clock — SINGLE-EDIT: the max against the virtual clock dropped", () => {
    expect(clockFor({ vclock: 5000, live: 0, anchorV: 0, anchorR: 0, nowR: 999 })).toBe(5000);
    expect(clockFor({ vclock: 5000, live: 1, anchorV: 5000, anchorR: 100, nowR: 350 })).toBe(5250);
    expect(clockFor({ vclock: 5000, live: 2, anchorV: 0, anchorR: 100, nowR: 350 })).toBe(5000);
  });
});

// ── INC-28 U3 child output stream rows ───────────────────────────────────
// child.stdout / child.stderr as streams ('data' with Node's own chunks,
// 'end'), on U2's event host: the module tells the host when a stream starts
// flowing (cpCall op 9, FLOW), and the host forwards its own Node's 'data'
// and 'end' (evPoll kinds 4 and 5) with the callback-scope flag. Rows that
// run real children go through this file's own runWasm; the expected text
// of every row is Node's own, measured with the same source under the
// harness oracle and stable across repeated runs (a row whose order is
// scheduling noise in Node is not written). Not shard-gated, U2's rule.
describe("INC-28 U3 child output stream rows", () => {
  async function runU3Source(src: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u3-row-"));
    try {
      const file = join(dir, "main.ts");
      writeFileSync(file, src);
      const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async function runU3Corpus(name: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u3-corpus-"));
    try {
      const res = await compile(join(corpusDir, name), { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** Node's own run of `src` under the harness oracle's flags. */
  async function runU3Node(src: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u3-node-"));
    try {
      const file = join(dir, "main.ts");
      writeFileSync(file, src);
      const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", file], { maxBuffer: 64 * 1024 * 1024 });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("U3-C-1566 corpus 1566-child-duck-interface.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU3Corpus("1566-child-duck-interface.ts");
    expect(r.stdout.toString("utf8")).toBe("spawned\nexit clean: true true\nsaw out1: true\nsaw err2: true\npid real: true\nlate kill: false\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-C-1565 corpus 1565-spawn-pipe-streams.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU3Corpus("1565-spawn-pipe-streams.ts");
    expect(r.stdout.toString("utf8")).toBe(
      'spawned\nphase1 text: "hello\\nworld\\n"\nphase1 order: end exit:3\nphase2 lines: e1|e2\nphase2 order: end exit:0\nphase3 total: 300000 chunked: true capped: true\nphase3 exit: true\nphase4 error: spawn definitely-not-a-binary-zzz ENOENT\nphase4 impossible end\n',
    );
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-C-1657 corpus 1657-spawn-async-neutral.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU3Corpus("1657-spawn-async-neutral.ts");
    expect(r.stdout.toString("utf8")).toBe(
      'main done\nclean: 5 null true\npiped: "hello\\nworld\\n" "warn\\n" 3\nkill sent: true\nkilled: null SIGTERM true\nerror: spawn definitely-not-a-binary-xyz ENOENT ENOENT\npid gone: true\n',
    );
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-C-1474 corpus 1474-string-decoder.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU3Corpus("1474-string-decoder.ts");
    const n = await runU3Node(readFileSync(join(corpusDir, "1474-string-decoder.ts"), "utf8"));
    expect(n.stdout.length).toBeGreaterThan(0);
    expect(r.stdout.toString("utf8")).toBe(n.stdout.toString("utf8"));
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-C-1662 corpus 1662-string-decoder-encodings.ts: full stdout, stderr and exit code equal Node's", async () => {
    const r = await runU3Corpus("1662-string-decoder-encodings.ts");
    const n = await runU3Node(readFileSync(join(corpusDir, "1662-string-decoder-encodings.ts"), "utf8"));
    expect(n.stdout.length).toBeGreaterThan(0);
    expect(r.stdout.toString("utf8")).toBe(n.stdout.toString("utf8"));
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-ORD-01 data then end then exit (the child closes its stdout long before it exits): 'data' runs where the chunk arrives and its ticks and microtask drain before the immediate; 'end' is one tick after the EOF; each listener's tick chain and microtask run before the next event", async () => {
    const r = await runU3Source("// data then end (the child closes its stdout long before it exits), then exit; each listener queues a nextTick chain and a microtask.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"printf abc; exec 1>&-; sleep 0.4\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nconst mark = (name: string): void => {\n  console.log(name);\n  process.nextTick(() => {\n    console.log(name + \":t1\");\n    process.nextTick(() => {\n      console.log(name + \":t2\");\n      process.nextTick(() => console.log(name + \":t3\"));\n    });\n  });\n  void Promise.resolve().then(() => console.log(name + \":m\"));\n};\nc.stdout?.on(\"data\", (chunk: Buffer) => mark(\"data \" + chunk.toString()));\nc.stdout?.on(\"end\", () => mark(\"end\"));\nc.on(\"exit\", (code) => mark(\"exit \" + code));\nsetImmediate(() => console.log(\"immediate\"));\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\ndata abc\ndata abc:t1\ndata abc:t2\ndata abc:t3\ndata abc:m\nimmediate\nend\nend:t1\nend:t2\nend:t3\nend:m\nexit 0\nexit 0:t1\nexit 0:t2\nexit 0:t3\nexit 0:m\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-ORD-02 'end' with no 'data' listener (Q1/Q2): the empty stderr ends on its own before the exit; the non-empty stdout, its EOF read before the exit, ends from the exit's flushStdio chain three ticks after the exit, after the exit listener's two-deep ticks and before its microtask", async () => {
    const r = await runU3Source("// 'end' with no 'data' listener, the child's EOF read before its exit: the exit's flushStdio chain ends the stream three ticks after the exit, before the exit listener's microtask.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"printf abc; exec 1>&- 2>&-; sleep 0.4\"], { stdio: [\"ignore\", \"pipe\", \"pipe\"] });\nconst mark = (name: string): void => {\n  console.log(name);\n  process.nextTick(() => {\n    console.log(name + \":t1\");\n    process.nextTick(() => {\n      console.log(name + \":t2\");\n      process.nextTick(() => console.log(name + \":t3\"));\n    });\n  });\n  void Promise.resolve().then(() => console.log(name + \":m\"));\n};\nc.stdout?.on(\"end\", () => mark(\"out end\"));\nc.stderr?.on(\"end\", () => mark(\"err end\"));\nc.on(\"exit\", (code) => mark(\"exit \" + code));\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nerr end\nerr end:t1\nerr end:t2\nerr end:t3\nerr end:m\nexit 0\nexit 0:t1\nexit 0:t2\nexit 0:t3\nout end\nout end:t1\nout end:t2\nout end:t3\nexit 0:m\nout end:m\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-ORD-03 'end' with no 'data' listener whose EOF comes after the exit (a grandchild holds the pipe): exit, its ticks and microtask, then 'end' in its own callback", async () => {
    const r = await runU3Source("// 'end' with no 'data' listener, the EOF after the exit (a grandchild holds the pipe): exit, its ticks and microtask, then 'end' in its own callback.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"(sleep 0.4; printf late) & exit 0\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nconst mark = (name: string): void => {\n  console.log(name);\n  process.nextTick(() => {\n    console.log(name + \":t1\");\n    process.nextTick(() => console.log(name + \":t2\"));\n  });\n  void Promise.resolve().then(() => console.log(name + \":m\"));\n};\nc.stdout?.on(\"end\", () => mark(\"end\"));\nc.on(\"exit\", (code) => mark(\"exit \" + code));\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nexit 0\nexit 0:t1\nexit 0:t2\nexit 0:m\nend\nend:t1\nend:t2\nend:m\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-ORD-04 exit before data and end: a grandchild writes after the shell exits \u2014 exit, the late chunk, then end (EXIT is forwarded in arrival order for a piped child, not after its streams)", async () => {
    const r = await runU3Source("// exit before data and end: a grandchild writes after the shell exits; the reader sees exit, then the late chunk, then end.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"(sleep 0.4; printf late) & exit 7\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nconst mark = (name: string): void => {\n  console.log(name);\n  process.nextTick(() => console.log(name + \":t1\"));\n  void Promise.resolve().then(() => console.log(name + \":m\"));\n};\nc.stdout?.on(\"data\", (chunk: Buffer) => mark(\"data \" + chunk.toString()));\nc.stdout?.on(\"end\", () => mark(\"end\"));\nc.on(\"exit\", (code) => mark(\"exit \" + code));\n");
    expect(r.stdout.toString("utf8")).toBe("exit 7\nexit 7:t1\nexit 7:m\ndata late\ndata late:t1\ndata late:m\nend\nend:t1\nend:m\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-TWO-01 two streams interleaved: each chunk reaches its own stream's listener in the order the child wrote them; both ends and the exit arrive", async () => {
    const r = await runU3Source("// two streams interleaved: each chunk reaches its own stream's listener in the order the child wrote them; the two ends and the exit (their relative order is scheduling noise in Node) are printed sorted once all three arrived.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"printf o1; sleep 0.15; printf e1 >&2; sleep 0.15; printf o2; sleep 0.15; printf e2 >&2\"], { stdio: [\"ignore\", \"pipe\", \"pipe\"] });\nconst seen: string[] = [];\nconst tail: string[] = [];\nconst done = (what: string): void => {\n  tail.push(what);\n  if (tail.length === 3) console.log(seen.join(\" \"), \"|\", tail.sort().join(\" \"));\n};\nc.stdout?.on(\"data\", (chunk: Buffer) => seen.push(\"out:\" + chunk.toString()));\nc.stderr?.on(\"data\", (chunk: Buffer) => seen.push(\"err:\" + chunk.toString()));\nc.stdout?.on(\"end\", () => done(\"out-end\"));\nc.stderr?.on(\"end\", () => done(\"err-end\"));\nc.on(\"exit\", (code) => done(\"exit-\" + code));\n");
    expect(r.stdout.toString("utf8")).toBe("out:o1 err:e1 out:o2 err:e2 | err-end exit-0 out-end\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-ONCE-01 once listeners: a once 'data' listener sees only the first chunk, an on listener every chunk; a 'data' listener added during an emission is not called for it; a once 'end' fires once and an 'end' listener added inside it never runs", async () => {
    const r = await runU3Source("// once listeners: a once 'data' listener sees only the first chunk, an on listener every chunk; a once 'end' listener fires once; a listener added during an emission is not called for it.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"printf one; sleep 0.15; printf two; sleep 0.15; printf three\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nlet added = false;\nc.stdout?.once(\"data\", (chunk: Buffer) => console.log(\"once data\", chunk.toString()));\nc.stdout?.on(\"data\", (chunk: Buffer) => {\n  console.log(\"on data\", chunk.toString());\n  if (!added) {\n    added = true;\n    c.stdout?.on(\"data\", (later: Buffer) => console.log(\"added data\", later.toString()));\n  }\n});\nc.stdout?.once(\"end\", () => {\n  console.log(\"once end\");\n  c.stdout?.on(\"end\", () => console.log(\"added end never\"));\n});\nc.stdout?.on(\"end\", () => console.log(\"on end\"));\n");
    expect(r.stdout.toString("utf8")).toBe("once data one\non data one\non data two\nadded data two\non data three\nadded data three\nonce end\non end\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-BIG-01 a large output (1 MB) with a reader: Node's own chunks, at most 64 KiB each, add up to every byte", async () => {
    const r = await runU3Source("// a large output with a reader: Node's own chunks (at most 64 KiB each) add up to every byte.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"head\", [\"-c\", \"1000000\", \"/dev/zero\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nlet total = 0;\nlet chunks = 0;\nlet max = 0;\nc.stdout?.on(\"data\", (chunk: Buffer) => {\n  total += chunk.length;\n  chunks += 1;\n  if (chunk.length > max) max = chunk.length;\n});\nc.stdout?.on(\"end\", () => console.log(\"end\", total, chunks >= 2, max <= 65536));\nc.on(\"exit\", (code) => console.log(\"exit\", code));\n");
    expect(r.stdout.toString("utf8")).toBe("end 1000000 true true\nexit 0\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-BIG-02 a large output (2 MB) with NO reader: the child blocks on its full pipe and is still running at 500 ms; killed, its exit is (null, SIGTERM) and the exit's flushStdio drains the pipe so 'end' still fires", async () => {
    const r = await runU3Source("// a large output with NO reader: the child blocks on its full pipe (Node reads only to its high-water mark), so it is still running when a timer kills it; the exit's flushStdio then drains the pipe and 'end' fires.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"head\", [\"-c\", \"2000000\", \"/dev/zero\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.stdout?.on(\"end\", () => console.log(\"end\"));\nc.on(\"exit\", (code, signal) => console.log(\"exit\", code, signal));\nsetTimeout(() => {\n  console.log(\"still running\", c.exitCode === null);\n  console.log(\"kill\", c.kill(\"SIGTERM\"));\n}, 500);\n");
    expect(r.stdout.toString("utf8")).toBe("still running true\nkill true\nexit null SIGTERM\nend\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-FAIL-01 a failed spawn with both outputs piped: 'error' on its nextTick with both streams present, then stdout's and stderr's 'end', no data, no exit", async () => {
    const r = await runU3Source("// a failed spawn with both outputs piped: 'error' on its nextTick, then both streams end (stdout first) and no data arrives.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"definitely-not-a-binary-u3\", [], { stdio: [\"ignore\", \"pipe\", \"pipe\"] });\nc.stdout?.on(\"data\", () => console.log(\"data never\"));\nc.stderr?.on(\"data\", () => console.log(\"data never\"));\nc.stdout?.on(\"end\", () => console.log(\"out end\"));\nc.stderr?.on(\"end\", () => console.log(\"err end\"));\nc.on(\"error\", (e) => console.log(\"error\", e.message, c.stdout !== null, c.stderr !== null));\nc.on(\"exit\", () => console.log(\"exit never\"));\nconsole.log(\"main done\");\n");
    expect(r.stdout.toString("utf8")).toBe("main done\nerror spawn definitely-not-a-binary-u3 ENOENT true true\nout end\nerr end\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-MIX-01 (re-aimed: refused) a piped slot beside an inherited or fd output slot refuses by name, cp.spawnOpts:pipeMixed — the host would hold the exit for the captured stream, where Node prints 'exit' before the piped stream's 'end' (reviewer's a08 and d09)", async () => {
    for (const stdio of ['["ignore", "pipe", "inherit"]', '["ignore", "inherit", "pipe"]', '["ignore", "pipe", 1]', '["ignore", 2, "pipe"]']) {
      const dir = mkdtempSync(join(tmpdir(), "u3-mix-"));
      try {
        const file = join(dir, "main.ts");
        writeFileSync(file, `import { spawn } from "node:child_process";\nconst c = spawn("sh", ["-c", "printf a"], { stdio: ${stdio} });\nc.on("exit", () => console.log("exit"));\n`);
        const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
        expect(res.ok, stdio).toBe(false);
        if (!res.ok) expect(res.diagnostics.map((d) => d.message).join("\n")).toContain("(libCall:cp.spawnOpts:pipeMixed)");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60000);
  test("U3-NULL-01 child.stdout / child.stderr are null for \"ignore\", \"inherit\" and fd slots and a stream for each \"pipe\" slot", async () => {
    const r = await runU3Source("// child.stdout / child.stderr: null for \"ignore\", \"inherit\" and fd slots, a stream for \"pipe\".\nimport { spawn } from \"node:child_process\";\nconst a = spawn(\"true\", [], { stdio: \"ignore\" });\nconst b = spawn(\"true\", [], { stdio: \"inherit\" });\nconst d = spawn(\"true\", [], { stdio: [\"ignore\", 1, 2] });\nconst p = spawn(\"true\", [], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nconst q = spawn(\"true\", [], { stdio: [\"ignore\", \"ignore\", \"pipe\"] });\nconsole.log(a.stdout === null, a.stderr === null, b.stdout === null, b.stderr === null, d.stdout === null, d.stderr === null);\nconsole.log(p.stdout === null, p.stderr === null, q.stdout === null, q.stderr === null);\nlet n = 0;\nfor (const c of [a, b, d, p, q]) c.on(\"exit\", () => {\n  n++;\n  if (n === 5) console.log(\"all exited\");\n});\n");
    expect(r.stdout.toString("utf8")).toBe("true true true true true true\nfalse true true false\nall exited\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-CHUNK-01 the chunk is a Buffer of the child's raw bytes (invalid UTF-8 and NUL included): hex, length, indexing, and a Buffer | string listener's toString", async () => {
    const r = await runU3Source("// the chunk is a Buffer of the child's raw bytes (invalid UTF-8 included): hex, length, indexing, and a Buffer | string listener's toString.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"printf\", [\"\\\\377\\\\000A\\\\342\\\\202\\\\254\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.stdout?.on(\"data\", (chunk: Buffer) => {\n  console.log(chunk.toString(\"hex\"), chunk.length, chunk[0], chunk[1] === 0);\n});\nconst asText = (chunk: Buffer | string): void => {\n  console.log(JSON.stringify(chunk.toString()));\n};\nc.stdout?.on(\"data\", asText);\nc.stdout?.on(\"end\", () => console.log(\"end\"));\n");
    expect(r.stdout.toString("utf8")).toBe("ff0041e282ac 6 255 true\n\"\ufffd\\u0000A\u20ac\"\nend\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-DEATH-01 a 'data' listener that throws ends the program with exit 1 after the output before it (stderr is not compared on a nonzero exit)", async () => {
    const r = await runU3Source("// a 'data' listener that throws ends the program (exit 1) after the output before it.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"printf x; sleep 0.2; printf y\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.stdout?.on(\"data\", (chunk: Buffer) => {\n  console.log(\"got\", chunk.toString());\n  throw new Error(\"boom in data\");\n});\nc.on(\"exit\", () => console.log(\"exit never\"));\n");
    expect(r.stdout.toString("utf8")).toBe("got x\n");
    expect(r.exitCode).toBe(1);
  }, 60000);
  test("U3-LATE-01 SEMANTICS.md S086 (k): a 'data' listener added on a later turn, after the output was buffered — Node prints listener added, data early, tick (the buffered chunk from the resume tick the listener queued); this tier delivers it at the next poll phase, after the adding turn's nextTick", async () => {
    const r = await runU3Source("// a 'data' listener added on a later turn, after the child's output was buffered (SEMANTICS.md S086 (k)): Node emits the buffered chunk from the resume tick the listener queued, before the timer callback's own later nextTick; this tier delivers it at the next poll phase.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"sh\", [\"-c\", \"printf early; sleep 0.6\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nsetTimeout(() => {\n  c.stdout?.on(\"data\", (chunk: Buffer) => console.log(\"data\", chunk.toString()));\n  process.nextTick(() => console.log(\"tick\"));\n  console.log(\"listener added\");\n}, 300);\nc.stdout?.on(\"end\", () => console.log(\"end\"));\nc.on(\"exit\", (code) => console.log(\"exit\", code));\n");
    expect(r.stdout.toString("utf8")).toBe("listener added\ntick\ndata early\nend\nexit 0\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-LX-01 a 'data' listener added inside the 'exit' listener (the EOF read before the exit) gets the output from its own resume_ tick — before the exit listener's tick — then 'end', before the exit listener's microtask (Node 10/10)", async () => {
    const r = await runU3Source("// a 'data' listener added inside the 'exit' listener: the exit's flushStdio has not run yet, so the buffered output reaches it, then 'end'.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"printf hi; exec 1>&-; sleep 0.3\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n  c.stdout?.on(\"data\", (d: Buffer) => console.log(\"data\", d.toString()));\n  c.stdout?.on(\"end\", () => console.log(\"end\"));\n  process.nextTick(() => console.log(\"exit tick\"));\n  void Promise.resolve().then(() => console.log(\"exit micro\"));\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\ndata hi\nexit tick\nend\nexit micro\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-LX-02 a 'data' listener added one nextTick after the 'exit' listener, the EOF read before the exit: the output still reaches it, then 'end'", async () => {
    const r = await runU3Source("// a 'data' listener added one nextTick after the 'exit' listener (before flushStdio's resume_ flows): the output still reaches it.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"printf hi; exec 1>&-; sleep 0.3\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n  process.nextTick(() => {\n    c.stdout?.on(\"data\", (d: Buffer) => console.log(\"data\", d.toString()));\n    c.stdout?.on(\"end\", () => console.log(\"end\"));\n  });\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\ndata hi\nend\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-LX-03 a 'data' listener added two nextTicks after the 'exit' listener: still before flushStdio's resume_ flows, so the output reaches it, then 'end'", async () => {
    const r = await runU3Source("// a 'data' listener added two nextTicks after the 'exit' listener: flushStdio's resume_ has already flowed the output to nobody, so only 'end' is seen.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"printf hi; exec 1>&-; sleep 0.3\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n  process.nextTick(() => {\n    process.nextTick(() => {\n      c.stdout?.on(\"data\", (d: Buffer) => console.log(\"data\", d.toString()));\n      c.stdout?.on(\"end\", () => console.log(\"end\"));\n    });\n  });\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\ndata hi\nend\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-LX-04 listeners (once and on) added in the 'exit' listener while a grandchild still writes: the buffered chunk and the later one, the once listener only the first, then 'end'", async () => {
    const r = await runU3Source("// a 'data' listener added in the 'exit' listener while a grandchild still writes: the buffered chunk and the later one both reach it, then 'end'.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"printf a; (sleep 0.3; printf b) & exit 0\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n  c.stdout?.once(\"data\", (d: Buffer) => console.log(\"once\", d.toString()));\n  c.stdout?.on(\"data\", (d: Buffer) => console.log(\"data\", d.toString()));\n  c.stdout?.on(\"end\", () => console.log(\"end\"));\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\nonce a\ndata a\ndata b\nend\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-LX-05 a 'data' listener added in a timer after the exit: the output that flowed before it is gone, the grandchild's later chunk reaches it, then 'end'", async () => {
    const r = await runU3Source("// a 'data' listener added after the exit, in a timer, while a grandchild still writes: output flowed before the listener is gone, the later chunk reaches it.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"printf a; (sleep 0.5; printf b) & exit 0\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n  setTimeout(() => {\n    console.log(\"timer\");\n    c.stdout?.on(\"data\", (d: Buffer) => console.log(\"data\", d.toString()));\n    c.stdout?.on(\"end\", () => console.log(\"end\"));\n  }, 200);\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\ntimer\ndata b\nend\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-TWO-02 two concurrent piped children that outlive the program's start, 'end' and 'exit' listeners only: exit 1, end 1, exit 2, end 2 — each unread stream ends from its own exit's flushStdio (Node, 12/12); the fast-child order is S086 (l)", async () => {
    const r = await runU3Source("// two concurrent piped children that run longer than the program takes to reach its event loop: each exit is followed by its own unread stream's end (flushStdio), then the next child's (SEMANTICS.md S086 (l) is the fast-child case).\nimport { spawn } from \"node:child_process\";\nfor (const n of [\"1\", \"2\"]) {\n  const c = spawn(\"/bin/sh\", [\"-c\", \"sleep 0.2; printf \" + n], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\n  c.stdout?.on(\"end\", () => console.log(\"end\", n));\n  c.on(\"exit\", () => { console.log(\"exit\", n); });\n}\n");
    expect(r.stdout.toString("utf8")).toBe("exit 1\nend 1\nexit 2\nend 2\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("U3-LX-06 a 'data' listener added three nextTicks after the 'exit' listener: flushStdio's resume_ already flowed the output to nobody, only 'end' is seen (Node 5/5)", async () => {
    const r = await runU3Source("// a data listener added three nextTicks after the exit listener: flushStdio's resume_ has flowed the output to nobody, so only end is seen.\nimport { spawn } from \"node:child_process\";\nconst c = spawn(\"/bin/sh\", [\"-c\", \"printf hi; exec 1>&-; sleep 0.3\"], { stdio: [\"ignore\", \"pipe\", \"ignore\"] });\nc.on(\"exit\", (code) => {\n  console.log(\"exit\", code);\n  process.nextTick(() => {\n    process.nextTick(() => { process.nextTick(() => {\n      c.stdout?.on(\"data\", (d: Buffer) => console.log(\"data\", d.toString()));\n      c.stdout?.on(\"end\", () => console.log(\"end\"));\n    }); });\n  });\n});\n");
    expect(r.stdout.toString("utf8")).toBe("exit 0\nend\n");
    expect(r.exitCode).toBe(0);
  }, 60000);
});

// ── INC-29 U1 node:net rows ───────────────────────────────────────────────
// Rows that open real sockets go through this file's own runWasm and its
// net host (makeNetHost above); the host's pure parts are driven directly
// by the unit rows. Not shard-gated: each row compiles its inline source
// into its own mkdtemp directory and uses ephemeral ports only. Every
// expected output was measured against Node v24.18.1 on the same source,
// and no row depends on the kernel's order between a client's 'connect'
// and the server's 'connection': each line is printed by the side that
// causes it, or after a causal round trip.
describe("INC-29 U1 node:net rows", () => {
  /** Compiles `src` (a whole program, `ext` its file kind) in a fresh
   * directory of its own and runs it through this file's runWasm. */
  async function runN1Source(src: string, ext: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "n1-row-"));
    try {
      const file = join(dir, `main.${ext}`);
      writeFileSync(file, src);
      const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** A corpus program compiled into a fresh directory of its own, then
   * run through runWasm. */
  async function runN1Corpus(name: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "n1-corpus-"));
    try {
      const res = await compile(join(corpusDir, name), { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const corpusRows: [string, string, string][] = [
    ["1567-server-close-override.ts", "both listening\noverride ran\ninner closed\nwrapper closed\n", "two servers, the close override closing the inner one through the bound real close"],
    ["1797-dyn-handle-socket.cjs", "typeof socket: object, string form: [object Object]\ndestroyed: false, writable: true\nremote is loopback: true\nserver saw: marbles\nclient got: echo:marbles\nserver socket closed, destroyed now: true\n", "a checked-dynamic accepted socket: its properties, data / close listeners, write and end with a dyn chunk"],
    ["2599-stream-arg-ladders.cjs", "TypeError|ERR_INVALID_ARG_TYPE|The \"stream\" argument must be an instance of ReadableStream, WritableStream, or Stream. Received an instance of Object\nTypeError|ERR_INVALID_ARG_TYPE|The \"stream\" argument must be an instance of ReadableStream, WritableStream, or Stream. Received type string ('nope')\nTypeError|ERR_INVALID_ARG_VALUE|The property 'options.type' must be one of: 'bytes', undefined. Received 'wrong type'\nTypeError|ERR_INVALID_ARG_TYPE|Second argument must be a buffer\n", "a connect to 'localhost' (a lookup, two addresses), a write and destroy on 'connect'"],
    ["2640-net-dyn-socket-compat.cjs", "setNoDelay is sock: true\nreadable pre: true\nwrite cb, bytesWritten: 6\nfinish cb\npause returns c: true\nclient got: \"hello!\" readable: false\nat(-1): 10 slice: 3 97 99\nclient closed, destroyed: true\n", "the checked-dynamic socket members (setNoDelay, write / end callbacks, bytesWritten, readable), pause / resume, destroySoon"],
    ["2500-net-autosel-timeout.ts", "number 300\n1234\n10\n", "the attempt-budget pair"],
    ["2596-net-arg-ladders.cjs", "TypeError|ERR_INVALID_ARG_TYPE|The \"options\" argument must be of type object. Received type string ('path')\nTypeError|ERR_INVALID_ARG_TYPE|The \"options\" argument must be of type object. Received type number (0)\nTypeError|ERR_INVALID_ARG_TYPE|The \"options.host\" property must be of type string. Received an instance of Array\nTypeError|ERR_INVALID_ARG_TYPE|The \"options.autoSelectFamily\" property must be of type boolean. Received type string ('INVALID')\nRangeError|ERR_OUT_OF_RANGE|The value of \"options.autoSelectFamilyAttemptTimeout\" is out of range. It must be >= 1 && <= 2147483647. Received -10\nRangeError|ERR_OUT_OF_RANGE|The value of \"options.autoSelectFamilyAttemptTimeout\" is out of range. It must be >= 1 && <= 2147483647. Received 0\nRangeError|ERR_OUT_OF_RANGE|The value of \"options.autoSelectFamilyAttemptTimeout\" is out of range. It must be >= 1 && <= 2147483647. Received -10\nRangeError|ERR_OUT_OF_RANGE|The value of \"value\" is out of range. It must be >= 1 && <= 2147483647. Received -10\nRangeError|ERR_OUT_OF_RANGE|The value of \"options.autoSelectFamilyAttemptTimeout\" is out of range. It must be >= 1 && <= 2147483647. Received 0\nRangeError|ERR_OUT_OF_RANGE|The value of \"value\" is out of range. It must be >= 1 && <= 2147483647. Received 0\nRangeError|ERR_OUT_OF_RANGE|The value of \"value\" is out of range. It must be an integer. Received 2.5\nbudget 10\nbudget 10\nbudget 25\nTypeError|ERR_INVALID_ARG_TYPE|The \"options.signal\" property must be an instance of AbortSignal. Received type string ('INVALID_SIGNAL')\nTypeError|ERR_INVALID_ARG_VALUE|The property 'options.objectMode' is not supported. Received true\nTypeError|ERR_INVALID_ARG_VALUE|The property 'options.readableObjectMode' is not supported. Received true\nTypeError|ERR_INVALID_ARG_VALUE|The property 'options.writableObjectMode' is not supported. Received true\n", "the argument ladders: the attempt budget's validation in connect and in its setter, the option bag's objectMode trio"],
  ];
  for (const [name, stdout, what] of corpusRows) {
    test(`N1-C-${name.slice(0, 4)} corpus ${name} (${what}): full stdout, stderr and exit code equal Node's`, async () => {
      const r = await runN1Corpus(name);
      expect(r.stdout.toString("utf8")).toBe(stdout);
      expect(r.stderr.toString("utf8")).toBe("");
      expect(r.exitCode).toBe(0);
    }, 60000);
  }

  test("N1-UNIT-01 the host's records: a UTF-16 run is a u32 count, the units and zero padding to 4; a peer is u32 family, u32 port, the address run; a lookup answer is a u32 count then (family, run) pairs — SINGLE-EDIT: the padding rounded to 2", () => {
    expect([...netRunBytes("ab")]).toEqual([2, 0, 0, 0, 97, 0, 98, 0]);
    expect([...netRunBytes("abc")]).toEqual([3, 0, 0, 0, 97, 0, 98, 0, 99, 0, 0, 0]);
    expect([...netPeerPayload("IPv6", 258, "::1")]).toEqual([6, 0, 0, 0, 2, 1, 0, 0, 3, 0, 0, 0, 58, 0, 58, 0, 49, 0, 0, 0]);
    expect([...netPeerPayload("IPv4", 1, "")]).toEqual([4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    const answer = netResolvePayload([{ address: "::1", family: 6 }, { address: "1", family: 4 }]);
    expect([...answer]).toEqual([2, 0, 0, 0, 6, 0, 0, 0, 3, 0, 0, 0, 58, 0, 58, 0, 49, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 49, 0, 0, 0]);
    const mem = new ArrayBuffer(64);
    new Uint8Array(mem, 8).set(netRunBytes("héllo"));
    expect(netReadRun(mem, 8)).toEqual({ text: "héllo", next: 8 + 4 + 12 });
  });
  test("N1-UNIT-02 a Node error's errno is the negative number it carries, EIO (-5) when it has none — SINGLE-EDIT: the default errno 0", () => {
    expect(netErrno({ errno: -111 })).toBe(-111);
    expect(netErrno(new Error("x"))).toBe(-5);
    expect(netErrno(null)).toBe(-5);
  });
  test("N1-UNIT-03 CLOSE purges every event queued for that handle and only those, and the handle stops counting as live — SINGLE-EDIT: the CLOSE purge's predicate", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const queued: HostEvent[] = [];
    let live = 0;
    const host = makeNetHost({
      memory: () => memory,
      push: (e) => queued.push(e),
      purge: (pred) => {
        for (let i = queued.length - 1; i >= 0; i--) if (pred(queued[i]!)) queued.splice(i, 1);
      },
      take: () => [],
      live: (d) => {
        live += d;
      },
    });
    const req = netConcat([netU32(1), netU32(4), netRunBytes("127.0.0.1")]);
    new Uint8Array(memory.buffer, 0, req.length).set(req);
    const a = host.netCall(2, 0, req.length, 0, 0);
    new Uint8Array(memory.buffer, 0, req.length).set(req);
    const b = host.netCall(2, 0, req.length, 0, 0);
    expect([a, b, live]).toEqual([1, 2, 2]);
    const ev = (source: number, handle: number, kind: number): HostEvent => ({ source, handle, kind, a: 0, b: 0, payload: new Uint8Array(0) });
    queued.push(ev(2, a, 3), ev(2, b, 3), ev(1, a, 1), ev(2, a, 4));
    expect(host.netCall(7, 0, 0, a, 0)).toBe(0);
    expect(queued.map((e) => `${e.source}:${e.handle}:${e.kind}`)).toEqual([`2:${b}:3`, `1:${a}:1`]);
    expect(live).toBe(1);
    host.finish();
  });
  test("N1-ERR-01 a refused connect to an IP literal: 'error' (connect ECONNREFUSED <ip>:<port>, its name and code) with its nextTick and microtask, then 'close'", async () => {
    const r = await runN1Source("// ECONNREFUSED to an IP literal: a port freed by closing a server; the\n// error's message, code and name, then 'close'; nextTick and microtask\n// ordering around the error.\nimport * as net from \"node:net\";\n\nconst probe = net.createServer();\nprobe.listen(0, \"127.0.0.1\", () => {\n  const port = probe.address().port;\n  probe.close(() => {\n    const c = net.connect(port, \"127.0.0.1\");\n    c.on(\"error\", (e) => {\n      console.log(\"error\", e.message === \"connect ECONNREFUSED 127.0.0.1:\" + port, e.name, (e as NodeJS.ErrnoException).code);\n      process.nextTick(() => console.log(\"tick after error\"));\n      Promise.resolve().then(() => console.log(\"micro after error\"));\n    });\n    c.on(\"close\", () => {\n      console.log(\"close\", c.destroyed);\n    });\n    c.on(\"connect\", () => console.log(\"connect (never)\"));\n    console.log(\"connecting\", c.destroyed);\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("connecting false\nerror true Error ECONNREFUSED\ntick after error\nmicro after error\nclose true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-ERR-02 EADDRINUSE with no host (the '::' bind: listen EADDRINUSE: address already in use :::<port>) and with an IP host (its lookup tick first), in Node's order", async () => {
    const r = await runN1Source("// EADDRINUSE: a second server on the first one's port, with no host (the\n// '::' bind) and with an IP host; the errors' texts and codes, in order.\nimport * as net from \"node:net\";\n\nconst a = net.createServer();\na.listen(0, () => {\n  const port = a.address().port;\n  const b = net.createServer();\n  b.on(\"error\", (e) => {\n    console.log(\"b error\", e.message === \"listen EADDRINUSE: address already in use :::\" + port, (e as NodeJS.ErrnoException).code);\n    const c = net.createServer();\n    c.on(\"error\", (e2) => {\n      console.log(\"c error\", e2.message === \"listen EADDRINUSE: address already in use 127.0.0.1:\" + port, (e2 as NodeJS.ErrnoException).code);\n      a.close(() => console.log(\"a closed\"));\n    });\n    c.on(\"listening\", () => console.log(\"c listening (never)\"));\n    c.listen(port, \"127.0.0.1\");\n    console.log(\"c listen called\");\n  });\n  b.listen(port);\n  console.log(\"b listen called\");\n  process.nextTick(() => console.log(\"tick after b listen\"));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("b listen called\nb error true EADDRINUSE\nc listen called\ntick after b listen\nc error true EADDRINUSE\na closed\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-HALF-01 half-close with allowHalfOpen false: the server writes and ends, the client reads it all and its write side ends on its own; each side's events in order", async () => {
    const r = await runN1Source("// Half-close with allowHalfOpen false: the server writes and ends; the\n// client reads everything, sees 'end', and its write side ends on its own\n// (the server then sees 'end'); both sides close. Each side's events in\n// order, printed only from the side that owns them (no cross-side race).\nimport * as net from \"node:net\";\n\nconst serverLog: string[] = [];\nconst clientLog: string[] = [];\nlet closed = 0;\nfunction done(): void {\n  closed++;\n  if (closed === 2) {\n    console.log(\"server:\", serverLog.join(\" \"));\n    console.log(\"client:\", clientLog.join(\" \"));\n    server.close(() => console.log(\"server closed\"));\n  }\n}\nconst server = net.createServer((sock) => {\n  let got = \"\";\n  sock.on(\"data\", (d: Buffer) => {\n    got += d.toString();\n  });\n  sock.on(\"end\", () => serverLog.push(\"end(\" + got + \")\"));\n  sock.on(\"finish\", () => serverLog.push(\"finish\"));\n  sock.on(\"close\", () => {\n    serverLog.push(\"close\");\n    done();\n  });\n  sock.write(\"hello \");\n  sock.end(\"world\");\n  serverLog.push(\"ended-writable:\" + sock.writable);\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  let got = \"\";\n  c.on(\"data\", (d: Buffer) => {\n    got += d.toString();\n  });\n  c.on(\"end\", () => {\n    clientLog.push(\"end(\" + got + \") writable:\" + c.writable + \" readable:\" + c.readable);\n    process.nextTick(() => clientLog.push(\"tick writable:\" + c.writable));\n  });\n  c.on(\"finish\", () => clientLog.push(\"finish\"));\n  c.on(\"close\", () => {\n    clientLog.push(\"close destroyed:\" + c.destroyed);\n    done();\n  });\n  c.write(\"ping\");\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("server: ended-writable:false finish end(ping) close\nclient: end(hello world) writable:true readable:false tick writable:true finish close destroyed:true\nserver closed\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-CLOSE-01 a server closed with a live connection: its 'close' (callback and event) only once that socket is destroyed", async () => {
    const r = await runN1Source("// A server closed while a connection is live: 'close' waits until that\n// connection's socket is gone; the listening handle stops accepting at once.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  console.log(\"connection\");\n  server.close(() => console.log(\"server close callback\"));\n  server.on(\"close\", () => console.log(\"server close event\"));\n  console.log(\"close called\");\n  setTimeout(() => {\n    console.log(\"destroying the connection\");\n    sock.destroy();\n  }, 100);\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  c.on(\"close\", () => console.log(\"client close\"));\n  c.on(\"end\", () => console.log(\"client end\"));\n  c.on(\"data\", () => console.log(\"client data (never)\"));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("connection\nclose called\ndestroying the connection\nserver close callback\nserver close event\nclient end\nclient close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-PAUSE-01 pause() holds 'data' while the peer writes more and ends; resume() delivers the rest, then 'end'", async () => {
    const r = await runN1Source("// pause() and resume() gate the reads: while paused no 'data' arrives, even\n// after the peer has written more and ended; resume delivers the rest, then\n// 'end'. isPaused-like state through readable.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.write(\"first\");\n  setTimeout(() => {\n    sock.write(\"second\");\n    sock.end(\"third\");\n  }, 50);\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  const seen: string[] = [];\n  let paused = false;\n  c.on(\"data\", (d: Buffer) => {\n    seen.push(d.toString());\n    if (!paused) {\n      paused = true;\n      c.pause();\n      console.log(\"paused after\", JSON.stringify(seen.join(\"\")));\n      setTimeout(() => {\n        console.log(\"while paused saw\", JSON.stringify(seen.join(\"\")));\n        c.resume();\n      }, 300);\n    }\n  });\n  c.on(\"end\", () => {\n    console.log(\"end, all:\", JSON.stringify(seen.join(\"\")));\n    server.close();\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("paused after \"first\"\nwhile paused saw \"first\"\nend, all: \"firstsecondthird\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-VAL-01 the synchronous throws: address().port before a listen, a bad or fractional listen port, a bad connect port, a NUL in the host, listen twice \u2014 Node's names, codes and texts", async () => {
    const r = await runN1Source("// The synchronous throws: listen twice, a bad listen port, a bad connect\n// port, a NUL in the host, address().port before a listen.\nimport * as net from \"node:net\";\n\nfunction show(label: string, f: () => void): void {\n  try {\n    f();\n    console.log(label, \"ok\");\n  } catch (e) {\n    const err = e as NodeJS.ErrnoException;\n    console.log(label, err.name, err.code, err.message);\n  }\n}\nconst s = net.createServer();\nshow(\"port before listen\", () => {\n  console.log(s.address().port);\n});\nshow(\"bad listen port\", () => {\n  s.listen(70000);\n});\nshow(\"fraction port\", () => {\n  s.listen(1.5);\n});\nshow(\"bad connect port\", () => {\n  net.connect(-1, \"127.0.0.1\");\n});\nshow(\"nul host\", () => {\n  net.connect(80, \"a\\u0000b\");\n});\ns.listen(0, () => {\n  show(\"listen twice\", () => {\n    s.listen(0);\n  });\n  s.close(() => console.log(\"closed\"));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("port before listen TypeError undefined Cannot read properties of null (reading 'port')\nbad listen port RangeError ERR_SOCKET_BAD_PORT options.port should be >= 0 and < 65536. Received type number (70000).\nfraction port RangeError ERR_SOCKET_BAD_PORT options.port should be >= 0 and < 65536. Received type number (1.5).\nbad connect port RangeError ERR_SOCKET_BAD_PORT Port should be >= 0 and < 65536. Received type number (-1).\nnul host TypeError ERR_INVALID_ARG_VALUE The property 'options.host' must be a string without null bytes. Received 'a\\x00b'\nlisten twice Error ERR_SERVER_ALREADY_LISTEN Listen method has been called more than once without closing.\nclosed\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-WAE-01 write() after end(): ERR_STREAM_WRITE_AFTER_END as an 'error', the socket destroyed at once, then 'close'", async () => {
    const r = await runN1Source("// write() after end(): the stream's ERR_STREAM_WRITE_AFTER_END 'error'\n// (asynchronous), then 'close' with the error set.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.on(\"data\", () => {});\n  sock.on(\"error\", () => {});\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\", () => {\n    c.end(\"bye\");\n    c.write(\"late\");\n    console.log(\"after late write, destroyed:\", c.destroyed);\n  });\n  c.on(\"error\", (e) => console.log(\"error\", e.message, (e as NodeJS.ErrnoException).code));\n  c.on(\"close\", () => {\n    console.log(\"close\", c.destroyed);\n    server.close();\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("after late write, destroyed: true\nerror write after end ERR_STREAM_WRITE_AFTER_END\nclose true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-PRE-01 writes and end() while connecting: buffered, one writev on 'connect'; bytesWritten counts the buffered bytes (UTF-8); the server reads all of it", async () => {
    const r = await runN1Source("// Writes made while connecting (buffered, then one writev on 'connect') and\n// an end() before the connect: the server reads all of it, then 'end';\n// bytesWritten counts the buffered bytes before the connect.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  let got = \"\";\n  sock.on(\"data\", (d: Buffer) => {\n    got += d.toString();\n  });\n  sock.on(\"end\", () => {\n    console.log(\"server got\", JSON.stringify(got));\n    server.close();\n  });\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  c.write(\"one,\");\n  c.write(\"two,\");\n  c.write(\"thr\u00e9e\");\n  console.log(\"bytesWritten before connect\", c.bytesWritten, \"connecting writable\", c.writable);\n  c.end();\n  c.on(\"connect\", () => console.log(\"connect, bytesWritten\", c.bytesWritten));\n  c.on(\"finish\", () => console.log(\"finish, bytesWritten\", c.bytesWritten));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("bytesWritten before connect 14 connecting writable true\nconnect, bytesWritten 14\nfinish, bytesWritten 14\nserver got \"one,two,thr\u00e9e\"\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-BIG-01 a 4 MiB transfer with the reader paused midway: every byte, in order (checksum), then 'end'", async () => {
    const r = await runN1Source("// A large transfer (4 MiB): every byte arrives, in order, and 'end' follows;\n// the receiver pauses midway for a while (the sender's writes back up).\nimport * as net from \"node:net\";\n\nconst total = 4 * 1024 * 1024;\nconst server = net.createServer((sock) => {\n  const chunk = Buffer.alloc(64 * 1024);\n  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;\n  for (let n = 0; n < total / chunk.length; n++) sock.write(chunk);\n  sock.end();\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  let got = 0;\n  let sum = 0;\n  let paused = false;\n  c.on(\"data\", (d: Buffer) => {\n    for (let i = 0; i < d.length; i++) sum = (sum + d[i]! * ((got + i) % 7 + 1)) % 1000000007;\n    got += d.length;\n    if (!paused && got > total / 2) {\n      paused = true;\n      c.pause();\n      setTimeout(() => c.resume(), 200);\n    }\n  });\n  c.on(\"end\", () => {\n    console.log(\"received\", got, \"checksum\", sum);\n    server.close();\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("received 4194304 checksum 96428761\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-ERR-03 a refused connect through 'localhost' (both addresses tried in turn): the AggregateError's name, empty message and code", async () => {
    const r = await runN1Source("// A refused connect through 'localhost' (both of its addresses are tried,\n// one after the other): the aggregate error's name, message and code.\nimport * as net from \"node:net\";\n\nconst probe = net.createServer();\nprobe.listen(0, \"127.0.0.1\", () => {\n  const port = probe.address().port;\n  probe.close(() => {\n    const c = net.connect(port);\n    c.on(\"error\", (e) => {\n      console.log(\"error\", e.name, JSON.stringify(e.message), (e as NodeJS.ErrnoException).code);\n    });\n    c.on(\"close\", () => console.log(\"close\"));\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("error AggregateError \"\" ECONNREFUSED\nclose\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-DMW-01 destroy() in the middle of a large write: the pending write's and a buffered write's callbacks get ECANCELED in the closing phase, after a queued immediate, then 'close'", async () => {
    const r = await runN1Source("// Destroy in the middle of a large write (a checked-dynamic socket, so the\n// write callbacks are reachable): the pending write's callback and a\n// buffered one's both see the ECANCELED error, in the closing phase, after\n// a queued immediate, then 'close' without an error.\n'use strict';\nconst net = require('net');\n\nfunction wrap(fn) {\n  return function () {\n    return fn.apply(this, arguments);\n  };\n}\nconst server = net.createServer((sock) => {\n  sock.on('data', () => {});\n  sock.on('error', () => {});\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, '127.0.0.1', wrap(function () {\n    const s = wrap(function (x) { return x; })(c);\n    const big = Buffer.alloc(8 * 1024 * 1024, 97);\n    const r = s.write(big, function (err) {\n      console.log('big write cb', err && err.message, err && err.code);\n    });\n    console.log('write returned', r);\n    s.write('small', function (err) {\n      console.log('small write cb', err && err.message);\n    });\n    s.destroy();\n    console.log('after destroy', s.destroyed);\n    process.nextTick(function () { console.log('tick after destroy'); });\n    setImmediate(function () { console.log('immediate'); });\n  }));\n  c.on('close', function () {\n    console.log('close');\n    server.close();\n  });\n  c.on('error', function (e) { console.log('error', e.message); });\n});\n", "cjs");
    expect(r.stdout.toString("utf8")).toBe("write returned false\nafter destroy true\ntick after destroy\nimmediate\nbig write cb write ECANCELED ECANCELED\nsmall write cb write ECANCELED\nclose\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-ECHO-01 three echo round trips on one connection, then the client ends and both sides close", async () => {
    const r = await runN1Source("// Several round trips on one connection (the client waits for each echo\n// before it sends the next), then the client ends and both sides close.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.on(\"data\", (d: Buffer) => {\n    sock.write(\"echo(\" + d.toString() + \")\");\n  });\n  sock.on(\"end\", () => console.log(\"server end\"));\n  sock.on(\"close\", () => {\n    console.log(\"server socket close\");\n    server.close(() => console.log(\"server closed\"));\n  });\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  const words = [\"alpha\", \"beta\", \"gamma\"];\n  let i = 0;\n  c.on(\"connect\", () => {\n    c.write(words[i]!);\n  });\n  let pending = \"\";\n  c.on(\"data\", (d: Buffer) => {\n    pending += d.toString();\n    const want = \"echo(\" + words[i] + \")\";\n    if (pending === want) {\n      console.log(\"got\", pending);\n      pending = \"\";\n      i++;\n      if (i < words.length) c.write(words[i]!);\n      else c.end();\n    }\n  });\n  c.on(\"close\", () => console.log(\"client close\"));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("got echo(alpha)\ngot echo(beta)\ngot echo(gamma)\nserver end\nserver socket close\nserver closed\nclient close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-STATE-01 a client socket's destroyed / writable / readable / bytesWritten / remoteAddress at each stage of its life", async () => {
    const r = await runN1Source("// A client socket's state through its life: destroyed / writable /\n// readable / bytesWritten / remoteAddress before the connect, after it,\n// after end(), at 'end', after destroy() and at 'close'.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.end(\"bye\");\n});\nserver.listen(0, \"127.0.0.1\", () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  const state = (label: string): void => {\n    console.log(label, c.destroyed, c.writable, c.readable, c.bytesWritten, c.remoteAddress);\n  };\n  state(\"created\");\n  c.on(\"connect\", () => {\n    state(\"connect\");\n    c.write(\"abc\");\n    state(\"written\");\n  });\n  c.on(\"data\", () => {});\n  c.on(\"end\", () => {\n    state(\"end\");\n    process.nextTick(() => {\n      state(\"end+tick\");\n      c.destroy();\n      state(\"destroyed\");\n    });\n  });\n  c.on(\"close\", () => {\n    state(\"close\");\n    server.close();\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("created false true true 0 undefined\nconnect false true true 0 127.0.0.1\nwritten false true true 3 127.0.0.1\nend false true false 3 127.0.0.1\nend+tick false true false 3 127.0.0.1\ndestroyed true false false 3 127.0.0.1\nclose true false false 3 127.0.0.1\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-ORD-01 'listening' (event and callback) and a server's 'close' with no connections, among nextTicks, microtasks and immediates", async () => {
    const r = await runN1Source("// Callback order around listen and close: the 'listening' listener, a\n// nextTick, a microtask and an immediate queued around them; a server\n// closed with no connections ('close' on a nextTick, before an immediate).\nimport * as net from \"node:net\";\n\nconst s = net.createServer();\ns.on(\"listening\", () => console.log(\"listening event\"));\ns.listen(0, () => {\n  console.log(\"listen callback\");\n  setImmediate(() => console.log(\"immediate after listening\"));\n  s.close(() => console.log(\"close callback\"));\n  s.on(\"close\", () => console.log(\"close event\"));\n  process.nextTick(() => console.log(\"tick after close()\"));\n  Promise.resolve().then(() => console.log(\"micro after close()\"));\n});\nprocess.nextTick(() => console.log(\"tick after listen()\"));\nPromise.resolve().then(() => console.log(\"micro after listen()\"));\nsetImmediate(() => console.log(\"immediate after listen()\"));\nconsole.log(\"main done\");\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("main done\nmicro after listen()\nlistening event\nlisten callback\ntick after listen()\nclose callback\nclose event\ntick after close()\nmicro after close()\nimmediate after listen()\nimmediate after listening\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-SOON-01 destroySoon() and the write(chunk, cb) / end(chunk, cb) callbacks on a checked-dynamic socket", async () => {
    const r = await runN1Source("// destroySoon after a write: end(), 'finish', then the destroy and 'close';\n// end(chunk, cb) and write(chunk, cb) callbacks on a checked-dynamic socket\n// (cb(null) after the bytes left, the end callback at 'finish').\n'use strict';\nconst net = require('net');\n\nfunction wrap(fn) {\n  return function () {\n    return fn.apply(this, arguments);\n  };\n}\nconst server = net.createServer(wrap(function (sock) {\n  let got = '';\n  sock.on('data', wrap(function (d) { got += d; }));\n  sock.on('end', wrap(function () {\n    console.log('server got', JSON.stringify(got));\n  }));\n  sock.on('close', wrap(function () {\n    console.log('server socket close');\n    server.close();\n  }));\n}));\nserver.listen(0, wrap(function () {\n  const c = net.connect(server.address().port, '127.0.0.1');\n  const s = wrap(function (x) { return x; })(c);\n  s.write('one', function (err) { console.log('write cb', err, s.bytesWritten); });\n  s.end('two', function (err) { console.log('end cb', err); });\n  c.on('finish', function () { console.log('finish'); });\n  c.on('close', function () { console.log('client close', c.destroyed); });\n  c.on('connect', function () {\n    console.log('connect');\n    c.destroySoon();\n    console.log('after destroySoon', c.destroyed);\n  });\n}));\n", "cjs");
    expect(r.stdout.toString("utf8")).toBe("write cb null 6\nconnect\nafter destroySoon false\nend cb null\nfinish\nclient close true\nserver got \"onetwo\"\nserver socket close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-DYN-01 a checked-dynamic socket: typeof, String(), identity through a second crossing, and a non-function listener's TypeError", async () => {
    const r = await runN1Source("// The checked-dynamic surface's edges on a socket: typeof, String(), ===,\n// a property and an event the tier does not model (each a named Error,\n// caught), a non-function listener (Node's TypeError).\n'use strict';\nconst net = require('net');\n\nfunction wrap(fn) {\n  return function () {\n    return fn.apply(this, arguments);\n  };\n}\nconst server = net.createServer(wrap(function (sock) {\n  const again = wrap(function (x) { return x; })(sock);\n  console.log(typeof sock, String(sock), sock === again);\n  try {\n    sock.on('data', 42);\n  } catch (e) {\n    console.log('bad listener:', e.name, e.code, e.message);\n  }\n  sock.destroy();\n  server.close();\n}));\nserver.listen(0, wrap(function () {\n  const c = net.connect(server.address().port, '127.0.0.1');\n  c.on('error', function () {});\n}));\n", "cjs");
    expect(r.stdout.toString("utf8")).toBe("object [object Object] true\nbad listener: TypeError ERR_INVALID_ARG_TYPE The \"listener\" argument must be of type function. Received type number (42)\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-MANY-01 three clients at once, each answered; the server closes after its last connection is gone", async () => {
    const r = await runN1Source("// Three clients at once; each sends its name and is answered; the server\n// counts its connections and closes after the last socket is gone.\nimport * as net from \"node:net\";\n\nlet open = 0;\nlet seen = 0;\nconst names: string[] = [];\nconst server = net.createServer((sock) => {\n  open++;\n  sock.on(\"data\", (d: Buffer) => {\n    names.push(d.toString());\n    sock.end(\"hi \" + d.toString());\n  });\n  sock.on(\"close\", () => {\n    open--;\n    seen++;\n    if (seen === 3) {\n      console.log(\"server saw\", names.sort().join(\",\"), \"open\", open);\n      server.close(() => console.log(\"server closed\"));\n    }\n  });\n});\nserver.listen(0, () => {\n  const port = server.address().port;\n  const replies: string[] = [];\n  for (const name of [\"c1\", \"c2\", \"c3\"]) {\n    const c = net.connect(port, \"127.0.0.1\");\n    let got = \"\";\n    c.on(\"data\", (d: Buffer) => {\n      got += d.toString();\n    });\n    c.on(\"end\", () => {\n      replies.push(got);\n      if (replies.length === 3) console.log(\"clients got\", replies.sort().join(\",\"));\n    });\n    c.write(name);\n  }\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("clients got hi c1,hi c2,hi c3\nserver saw c1,c2,c3 open 0\nserver closed\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-UNH-01 an 'error' with no listener: exit 1 after the output already written", async () => {
    const r = await runN1Source("// An 'error' with no listener: the program dies (exit 1) on the error's\n// nextTick, after the output already written.\nimport * as net from \"node:net\";\n\nconst probe = net.createServer();\nprobe.listen(0, \"127.0.0.1\", () => {\n  const port = probe.address().port;\n  probe.close(() => {\n    net.connect(port, \"127.0.0.1\");\n    console.log(\"connect called\");\n    setTimeout(() => console.log(\"timer (never)\"), 1000);\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("connect called\n");
    expect(r.exitCode).toBe(1);
  }, 60000);
  test("N1-LATE-01 a 'data' listener added after the peer wrote and ended: the buffered bytes on resume's tick, then 'end', with the listener's own nextTick and microtask", async () => {
    const r = await runN1Source("// A 'data' listener added well after the peer wrote: the socket read the\n// bytes into its buffer meanwhile, and the listener gets them on resume's\n// tick; 'end' follows. A nextTick and a microtask from the data listener.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.end(\"early bytes\");\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  c.on(\"end\", () => {\n    console.log(\"end\");\n    server.close();\n  });\n  setTimeout(() => {\n    console.log(\"adding data listener, readable:\", c.readable);\n    c.on(\"data\", (d: Buffer) => {\n      console.log(\"data\", d.toString());\n      process.nextTick(() => console.log(\"tick in data\"));\n      Promise.resolve().then(() => console.log(\"micro in data\"));\n    });\n    process.nextTick(() => console.log(\"tick after on(data)\"));\n  }, 200);\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("adding data listener, readable: true\ndata early bytes\ntick after on(data)\nend\ntick in data\nmicro in data\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-HOST-01 listen on a hostname (a real lookup, then the bind), a connect to it, and close(cb) twice", async () => {
    const r = await runN1Source("// listen on a hostname ('localhost': a real lookup, then the bind), a\n// connect to it, and close(cb) twice \u2014 the second on a server that is no\n// longer listening.\nimport * as net from \"node:net\";\n\nconst s = net.createServer((sock) => {\n  sock.end(\"x\");\n});\ns.listen(0, \"localhost\", () => {\n  console.log(\"listening on localhost\");\n  const c = net.connect(s.address().port, \"localhost\");\n  c.on(\"data\", (d: Buffer) => console.log(\"client data\", d.toString()));\n  c.on(\"end\", () => {\n    s.close(() => console.log(\"first close callback\"));\n    s.close(() => console.log(\"second close callback\"));\n    s.on(\"close\", () => console.log(\"close event\"));\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("listening on localhost\nclient data x\nfirst close callback\nsecond close callback\nclose event\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-PEER-01 the client ends first: the server sees 'end', a nextTick from its 'end' listener still writes before its own write side ends", async () => {
    const r = await runN1Source("// The client ends first while the server keeps writing: the server sees\n// 'end' (still writable), and a nextTick queued by its 'end' listener runs\n// before the auto end() that allowHalfOpen false queues right after the\n// listeners, so its write still goes out; then 'close'.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.on(\"data\", () => {});\n  sock.on(\"end\", () => {\n    console.log(\"server end, writable:\", sock.writable);\n    process.nextTick(() => {\n      console.log(\"tick, writable:\", sock.writable);\n      sock.write(\"too late\");\n    });\n  });\n  sock.on(\"error\", (e) => console.log(\"server error\", e.message, (e as NodeJS.ErrnoException).code));\n  sock.on(\"close\", () => {\n    console.log(\"server socket close\");\n    server.close();\n  });\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\", () => {\n    c.end(\"bye\");\n  });\n  c.on(\"data\", () => {});\n  c.on(\"error\", () => {});\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("server end, writable: true\ntick, writable: true\nserver socket close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-TICK-01 a nextTick and a microtask from 'connect', 'data', 'end', 'finish' and 'close' listeners: each callback's queues drain before the next callback", async () => {
    const r = await runN1Source("// nextTicks and microtasks queued from 'connect', 'data', 'end', 'finish'\n// and 'close' listeners on one socket: each callback's own queue drains\n// before the next callback.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.on(\"data\", () => {\n    sock.end(\"reply\");\n  });\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  const mark = (name: string): void => {\n    console.log(name);\n    process.nextTick(() => console.log(name + \":tick\"));\n    Promise.resolve().then(() => console.log(name + \":micro\"));\n  };\n  c.on(\"connect\", () => {\n    mark(\"connect\");\n    c.write(\"ask\");\n  });\n  c.on(\"data\", () => mark(\"data\"));\n  c.on(\"end\", () => mark(\"end\"));\n  c.on(\"finish\", () => mark(\"finish\"));\n  c.on(\"close\", () => {\n    mark(\"close\");\n    server.close();\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("connect\nconnect:tick\nconnect:micro\ndata\ndata:tick\ndata:micro\nend\nend:tick\nend:micro\nfinish\nfinish:tick\nfinish:micro\nclose\nclose:tick\nclose:micro\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-UNIT-04 the batch gate: a net event takes the host iteration it was queued in, the iteration ends at the host's next check phase, and a poll phase admits only the oldest iteration still queued (a child's events are never held) — SINGLE-EDIT: admits() ignoring the generation", () => {
    const scheduled: (() => void)[] = [];
    const gate = new NetBatchGate((f) => scheduled.push(f));
    const ev = (source: number, kind: number): HostEvent => ({ source, handle: 1, kind, a: 0, b: 0, payload: new Uint8Array(0) });
    const a = ev(2, 3);
    const b = ev(2, 3);
    gate.stamp(a);
    gate.stamp(b);
    expect(scheduled.length).toBe(1);
    scheduled.shift()!();
    const c = ev(2, 4);
    const child = ev(1, 1);
    gate.stamp(c);
    gate.stamp(child);
    expect([a.gen, b.gen, c.gen, child.gen]).toEqual([0, 0, 1, undefined]);
    gate.beginPoll([a, b, c, child]);
    expect([gate.admits(a), gate.admits(b), gate.admits(c), gate.admits(child)]).toEqual([true, true, false, true]);
    gate.beginPoll([c]);
    expect(gate.admits(c)).toBe(true);
    gate.beginPoll([]);
    expect(gate.admits(c)).toBe(false);
    // A held event re-queued at READ_START is the NEXT iteration's.
    const held = ev(2, 3);
    gate.stampNext(held);
    expect(held.gen).toBe(2);
    gate.beginPoll([c, held]);
    expect([gate.admits(c), gate.admits(held)]).toEqual([true, false]);
  });
  test("N1-UNIT-05 the host answers from its own socket's state: WRITE to a host socket its Node already destroyed answers the error it died of (here ECONNREFUSED; EPIPE when it has none), SHUTDOWN of one is ENOTCONN — SINGLE-EDIT: the destroyed-socket WRITE answered as written", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const queued: HostEvent[] = [];
    const host = makeNetHost({ memory: () => memory, push: (e) => queued.push(e), purge: () => {}, take: () => [], live: () => {} });
    const probe = netCreateServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const req = netConcat([netU32(port), netU32(4), netRunBytes("127.0.0.1")]);
    new Uint8Array(memory.buffer, 0, req.length).set(req);
    const h = host.netCall(2, 0, req.length, 0, 0);
    for (let i = 0; i < 400 && !queued.some((e) => e.handle === h && e.kind === 2); i++) await new Promise((r) => setTimeout(r, 5));
    expect(queued.find((e) => e.handle === h && e.kind === 2)?.a).toBe(-111);
    expect(host.socketOf(h)?.destroyed).toBe(true);
    new Uint8Array(memory.buffer, 0, 3).set([1, 2, 3]);
    expect(host.netCall(5, 0, 3, h, 0)).toBe(-111);
    expect(host.netCall(6, 0, 0, h, 0)).toBe(-107);
    host.finish();
  });
  test("N1-UNIT-06 READ_STOP stops the host's reads at once (the handle's own readStop): while the peer keeps writing, the host socket buffers nothing and reads nothing until the next READ_START — SINGLE-EDIT: READ_STOP as the stream's pause()", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const queued: HostEvent[] = [];
    const host = makeNetHost({
      memory: () => memory,
      push: (e) => queued.push(e),
      purge: () => {},
      take: (pred) => {
        const taken = queued.filter(pred);
        for (const e of taken) queued.splice(queued.indexOf(e), 1);
        return taken;
      },
      live: () => {},
    });
    const big = Buffer.alloc(1 << 16, 97);
    const peer = netCreateServer((s) => {
      s.on("error", () => {});
      const pump = (): void => {
        while (s.writable && s.write(big)) {}
      };
      s.on("drain", pump);
      pump();
    });
    await new Promise<void>((r) => peer.listen(0, "127.0.0.1", () => r()));
    const port = (peer.address() as { port: number }).port;
    const req = netConcat([netU32(port), netU32(4), netRunBytes("127.0.0.1")]);
    new Uint8Array(memory.buffer, 0, req.length).set(req);
    const h = host.netCall(2, 0, req.length, 0, 0);
    const until = async (p: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !p(); i++) await new Promise((r) => setTimeout(r, 5));
    };
    await until(() => queued.some((e) => e.handle === h && e.kind === 2));
    expect(host.netCall(3, 0, 0, h, 0)).toBe(0);
    await until(() => queued.some((e) => e.handle === h && e.kind === 3));
    expect(host.netCall(4, 0, 0, h, 0)).toBe(0);
    const sock = host.socketOf(h)!;
    await new Promise((r) => setTimeout(r, 150));
    expect(queued.filter((e) => e.handle === h && e.kind === 3).length).toBe(0);
    expect(sock.readableLength).toBe(0);
    expect((sock as unknown as { _handle: { reading: boolean } })._handle.reading).toBe(false);
    expect(host.netCall(3, 0, 0, h, 0)).toBe(0);
    await until(() => queued.some((e) => e.handle === h && e.kind === 3));
    expect(queued.some((e) => e.handle === h && e.kind === 3)).toBe(true);
    host.finish();
    await new Promise<void>((r) => peer.close(() => r()));
  });
  test("N1-PEND-01 a shutdown with an empty write queue completes in the pending pass after the poll: 'finish' before an immediate queued beside end(), from a 'connect' and from a 'data' listener (libuv's uv__run_pending)", async () => {
    const r = await runN1Source("// The pending phase: a shutdown with an empty write queue completes in\n// libuv's pending pass after the poll, before the check phase \u2014 so\n// 'finish' comes before an immediate queued in the same callback, from a\n// 'connect' listener and from a 'data' listener.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.on(\"data\", () => {});\n  sock.on(\"end\", () => sock.end());\n});\nserver.listen(0, () => {\n  const port = server.address().port;\n  const a = net.connect(port, \"127.0.0.1\", () => {\n    console.log(\"a connect\");\n    a.end();\n    setImmediate(() => console.log(\"a imm\"));\n  });\n  a.on(\"finish\", () => console.log(\"a finish\"));\n  a.on(\"data\", () => {});\n  a.on(\"close\", () => {\n    console.log(\"a close\");\n    const b = net.connect(port, \"127.0.0.1\", () => b.write(\"x\"));\n    b.on(\"data\", () => {});\n    b.on(\"finish\", () => console.log(\"b finish\"));\n    b.on(\"close\", () => {\n      console.log(\"b close\");\n      server.close();\n    });\n    let first = true;\n    server.once(\"connection\", (s2) => {\n      s2.write(\"hello\");\n    });\n    b.on(\"data\", () => {\n      if (!first) return;\n      first = false;\n      console.log(\"b data\");\n      b.end();\n      setImmediate(() => console.log(\"b imm\"));\n    });\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("a connect\na finish\na imm\na close\nb data\nb finish\nb imm\nb close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-PEND-02 the commonest shape: the server's FIN under allowHalfOpen false \u2014 the automatic end's 'finish' (and its nextTick and microtask) before the 'end' listener's immediate", async () => {
    const r = await runN1Source("// The commonest shape: the client gets the server's FIN under\n// allowHalfOpen false; its automatic end() shuts its write side down,\n// completed in the pending pass. A nextTick, a microtask and an\n// immediate from its 'end' and 'finish' listeners.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.on(\"data\", () => {});\n  sock.end(\"bye\");\n  sock.on(\"close\", () => server.close());\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  const mark = (name: string): void => {\n    console.log(name);\n    process.nextTick(() => console.log(name + \":t\"));\n    Promise.resolve().then(() => console.log(name + \":m\"));\n    setImmediate(() => console.log(name + \":i\"));\n  };\n  c.on(\"data\", () => mark(\"data\"));\n  c.on(\"end\", () => mark(\"end\"));\n  c.on(\"finish\", () => mark(\"finish\"));\n  c.on(\"close\", () => mark(\"close\"));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("data\ndata:t\ndata:m\ndata:i\nend\nend:t\nend:m\nfinish\nfinish:t\nfinish:m\nend:i\nfinish:i\nclose\nclose:t\nclose:m\nclose:i\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-PEND-03 destroySoon() on a connected checked-dynamic socket: 'finish' in the pending pass, before an immediate queued beside the call", async () => {
    const r = await runN1Source("// destroySoon() on a connected socket with nothing buffered: end(), the\n// shutdown in the pending pass, then 'finish' and the destroy \u2014 before an\n// immediate queued beside the call.\n'use strict';\nconst net = require('net');\nfunction wrap(fn) { return function () { return fn.apply(this, arguments); }; }\nconst server = net.createServer(function (sock) {\n  sock.on('data', function () {});\n  sock.on('end', function () { console.log('server end'); });\n  sock.on('close', function () { console.log('server sock close'); server.close(); });\n});\nserver.listen(0, function () {\n  const c = net.connect(server.address().port, '127.0.0.1');\n  const s = wrap(function (x) { return x; })(c);\n  c.on('connect', function () {\n    console.log('connect');\n    s.destroySoon();\n    setImmediate(function () { console.log('imm'); });\n    process.nextTick(function () { console.log('tick'); });\n  });\n  c.on('finish', function () { console.log('finish'); });\n  c.on('close', function () { console.log('close'); });\n});\n", "cjs");
    expect(r.stdout.toString("utf8")).toBe("connect\ntick\nfinish\nimm\nclose\nserver end\nserver sock close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-CLOSE-02 the closing phase runs the handle closed last first (libuv's closing list is LIFO): three sockets destroyed in one callback close c, b, a; two destroyed while connecting close e, d", async () => {
    const r = await runN1Source("// The closing phase walks libuv's closing list from its head: the handle\n// closed last runs first. Three connected sockets destroyed in one\n// callback, then two sockets destroyed while still connecting.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.on(\"data\", () => {});\n  sock.on(\"error\", () => {});\n});\nserver.listen(0, () => {\n  const port = server.address().port;\n  let ready = 0;\n  const onReady = (): void => {\n    ready++;\n    if (ready === 3) {\n      a.destroy();\n      b.destroy();\n      c.destroy();\n    }\n  };\n  const a = net.connect(port, \"127.0.0.1\", onReady);\n  const b = net.connect(port, \"127.0.0.1\", onReady);\n  const c = net.connect(port, \"127.0.0.1\", onReady);\n  b.on(\"close\", () => console.log(\"close b\"));\n  c.on(\"close\", () => console.log(\"close c\"));\n  a.on(\"close\", () => {\n    console.log(\"close a\");\n    const d = net.connect(port, \"127.0.0.1\");\n    const e = net.connect(port, \"127.0.0.1\");\n    d.on(\"close\", () => console.log(\"close d\"));\n    e.on(\"close\", () => {\n      console.log(\"close e\");\n      server.close();\n    });\n    d.destroy();\n    e.destroy();\n  });\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("close c\nclose b\nclose a\nclose e\nclose d\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-CLOSE-03 a paused-then-resumed server socket while the client ends (cend, cclose, then the server socket's close); a server closed with a callback while its connection echoes and ends", async () => {
    const r = await runN1Source("// A paused-then-resumed server socket while the client ends; and a server\n// closed (with a callback) while a connection is live, whose socket echoes\n// and then ends. Each socket's close lands in the closing phase of the\n// loop iteration that saw its peer's end.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.pause();\n  setTimeout(() => {\n    console.log(\"resume\");\n    sock.resume();\n  }, 50);\n  sock.on(\"data\", (d: Buffer) => console.log(\"sdata\", d.toString()));\n  sock.on(\"end\", () => console.log(\"send\"));\n  sock.on(\"close\", () => {\n    console.log(\"close\");\n    second();\n  });\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\", () => {\n    c.end(\"hi\");\n  });\n  c.on(\"end\", () => console.log(\"cend\"));\n  c.on(\"close\", () => console.log(\"cclose\"));\n});\n\nconst second = (): void => {\n  const s2 = net.createServer((sock) => {\n    sock.on(\"data\", (d: Buffer) => {\n      sock.write(d);\n      s2.close(() => console.log(\"close cb\"));\n      s2.on(\"close\", () => console.log(\"close ev\"));\n    });\n    sock.on(\"end\", () => sock.end());\n    sock.on(\"close\", () => {\n      console.log(\"sock close\");\n      server.close();\n    });\n  });\n  s2.listen(0, () => {\n    const c2 = net.connect(s2.address().port, \"127.0.0.1\", () => c2.write(\"echo\"));\n    c2.on(\"data\", () => c2.end());\n    c2.on(\"end\", () => console.log(\"c2end\"));\n    c2.on(\"close\", () => console.log(\"c2close\"));\n  });\n};\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("resume\nsdata hi\nsend\ncend\ncclose\nclose\nclose cb\nclose ev\nsock close\nc2end\nc2close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-BATCH-01 a server closed with a callback while its one connection echoes and ends: the client's end and close before the server socket's, then the close callback, the event and the socket's close", async () => {
    const r = await runN1Source("// A server closed with a callback while its one connection is live; the\n// connection echoes and ends. Client and server events interleave across\n// loop iterations: each host iteration's events are one poll phase.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  server.close(() => console.log(\"close cb\"));\n  server.on(\"close\", () => console.log(\"close ev\"));\n  sock.on(\"data\", (d: Buffer) => {\n    sock.write(d);\n    sock.end();\n  });\n  sock.on(\"end\", () => console.log(\"send\"));\n  sock.on(\"close\", () => console.log(\"sock close\"));\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\", () => c.write(\"x\"));\n  c.on(\"data\", (d: Buffer) => console.log(\"cdata\", d.toString()));\n  c.on(\"end\", () => console.log(\"cend\"));\n  c.on(\"close\", () => console.log(\"cclose\"));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("cdata x\ncend\ncclose\nsend\nclose cb\nclose ev\nsock close\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-BATCH-02 chunks the peer wrote from successive check phases: each 'data' callback's immediate runs before the next chunk Node read in a later iteration", async () => {
    const r = await runN1Source("// Events the host observed in different loop iterations stay in different\n// poll phases: an immediate queued from one 'data' callback runs before\n// a chunk the next iteration read.\nimport * as net from \"node:net\";\n\nconst server = net.createServer((sock) => {\n  sock.write(\"a\");\n  setImmediate(() => {\n    sock.write(\"b\");\n    setImmediate(() => {\n      sock.write(\"c\");\n      setImmediate(() => sock.end());\n    });\n  });\n  sock.on(\"data\", () => {});\n  sock.on(\"close\", () => server.close());\n});\nserver.listen(0, () => {\n  const c = net.connect(server.address().port, \"127.0.0.1\");\n  c.on(\"data\", (d: Buffer) => {\n    const x = d.toString();\n    console.log(\"data\", x);\n    setImmediate(() => console.log(\"imm\", x));\n  });\n  c.on(\"end\", () => console.log(\"end\"));\n});\n", "ts");
    expect(r.stdout.toString("utf8")).toBe("data ab\nimm ab\ndata c\nimm c\nend\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-REG-02 S087 (f): on a checked-dynamic Socket or Server, `in`, Object.hasOwn and Object.assign onto or from one are named Errors, and so is a non-utf8 or unknown encoding to a modelled write or end", async () => {
    const r = await runN1Source("// S087 (f): on a checked-dynamic Socket or Server, `in`, Object.hasOwn and\n// Object.assign (onto one or from one) are named Errors, and so is an\n// encoding argument other than utf8 to a modelled write or end.\n'use strict';\nconst net = require('net');\nfunction wrap(fn) { return function () { return fn.apply(this, arguments); }; }\nconst srv = net.createServer();\nconst c = net.connect(1, '127.0.0.1');\nc.on('error', function () {});\nconst s = wrap(function (x) { return x; })(c);\nconst v = wrap(function (x) { return x; })(srv);\nfunction t(name, f) {\n  try { console.log(name, String(f())); } catch (e) { console.log(name, e.name, e.message); }\n}\nt('in', () => 'on' in s);\nt('in server', () => 'close' in v);\nt('hasOwn', () => Object.hasOwn(s, 'connecting'));\nt('assign from', () => Object.keys(Object.assign({}, s)).length);\nt('assign onto', () => Object.assign(s, { zz: 1 }) === s);\nt('assign from server', () => Object.keys(Object.assign({}, v)).length);\nt('write latin1', () => s.write('x', 'latin1'));\nt('write unknown encoding', () => s.write('x', 'nope'));\nt('end hex', () => s.end('00', 'hex') === s);\nc.destroy();\n", "cjs");
    // Node v24.18.1 prints: "in true\nin server true\nhasOwn true\nassign from 16\nassign onto true\nassign from server 15\nwrite latin1 true\nwrite unknown encoding TypeError Unknown encoding: nope\nend hex true\n"
    expect(r.stdout.toString("utf8")).toBe("in Error 'in' or Object.hasOwn on a net handle is not supported yet\nin server Error 'in' or Object.hasOwn on a net handle is not supported yet\nhasOwn Error 'in' or Object.hasOwn on a net handle is not supported yet\nassign from Error Object.assign from a net handle is not supported yet\nassign onto Error Object.assign onto a net handle is not supported yet\nassign from server Error Object.assign from a net handle is not supported yet\nwrite latin1 Error 'write' with an encoding other than utf8 on a net handle is not supported yet\nwrite unknown encoding Error 'write' with an encoding other than utf8 on a net handle is not supported yet\nend hex Error 'end' with an encoding other than utf8 on a net handle is not supported yet\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-REG-03 S037 (INC-29 U1 amendment): slice() of a Buffer that crossed an untyped call is a Uint8Array's slice here, a copy (Node: a view, so a write through it shows in the source); a 'data' chunk keeps the Buffer flag and its slice is a view", async () => {
    const r = await runN1Source("// S037's INC-29 U1 amendment: a Buffer that crossed an untyped call is a\n// Uint8Array on this side, so its slice() is a copy (Node: a view, and the\n// write through it shows in the source). A 'data' chunk keeps the Buffer\n// flag, and its slice is a view.\n'use strict';\nconst net = require('net');\nfunction pass(x) { return x; }\nconst raw = pass(Buffer.from('abcd'));\nconst p = raw.slice(1, 3);\np[0] = 65;\nconsole.log('through the slice:', raw[1]);\nconst server = net.createServer(function (sock) {\n  sock.end('wxyz');\n});\nserver.listen(0, function () {\n  const c = net.connect(server.address().port, '127.0.0.1');\n  c.on('data', function (d) {\n    const q = d.slice(1, 3);\n    q[0] = 90;\n    console.log('chunk', d.toString(), q.length);\n  });\n  c.on('end', function () { server.close(); });\n});\n", "cjs");
    // Node v24.18.1 prints "through the slice: 65" (the view).
    expect(r.stdout.toString("utf8")).toBe("through the slice: 98\nchunk wZyz 2\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
  test("N1-REG-01 S087 (a): a refused connect's error has no errno, syscall, address or port, and the AggregateError of a 'localhost' connect has no errors array (Node: -111 connect 127.0.0.1 <port>, and an array of two)", async () => {
    const r = await runN1Source("// S087 (a): a connect error carries name, message and code only; the\n// AggregateError has no errors array. Node's answers are in the row.\nimport * as net from \"node:net\";\nconst srv = net.createServer();\nsrv.listen(0, \"127.0.0.1\", () => {\n  const port = srv.address().port;\n  srv.close(() => {\n    const c = net.connect(port, \"127.0.0.1\");\n    c.on(\"error\", (e: any) => {\n      console.log(e.name, e.code);\n      console.log(\"errno\", e.errno, \"syscall\", e.syscall, \"address\", e.address, \"port\", e.port === undefined);\n      const d = net.connect(port, \"localhost\");\n      d.on(\"error\", (a: any) => {\n        console.log(a.name, a.code, \"errors\", a.errors === undefined);\n      });\n    });\n  });\n});\n", "ts");
    // Node v24.18.1 prints "errno -111 syscall connect address 127.0.0.1 port false" and "... errors false".
    expect(r.stdout.toString("utf8")).toBe("Error ECONNREFUSED\nerrno undefined syscall undefined address undefined port true\nAggregateError ECONNREFUSED errors true\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
});

// ── INC-29 U2 node:http rows ──────────────────────────────────────────────
// node:http is built in the module (http.ts over net.ts) on node:net's host
// contract, so every row here opens real sockets through this file's
// runWasm and its net host. Not shard-gated: each row compiles into its own
// mkdtemp directory and listens on an ephemeral port. Every expected output
// was measured against Node v24.18.1 on the same source (a REG row pins this
// tier's registered answer and names Node's in its comment). A response's
// Date line is dropped by the program itself (it is the wall clock).
describe("INC-29 U2 node:http rows", () => {
  async function runN2(file: string, src: string | null): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "n2-row-"));
    try {
      let path = file;
      if (src !== null) {
        path = join(dir, file);
        writeFileSync(path, src);
      }
      const res = await compile(path, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const corpusRows: [string, string, string][] = [
    ["1750-http-agent-options.ts", "srv /one connection=close\ncli /one status=200 body=echo:/one\nsrv /two connection=keep-alive\ncli /two status=200 body=echo:/two\nsrv /three connection=close\ncli /three status=200 body=echo:/three\n", "the Agent options record: keepAlive, maxSockets, maxFreeSockets, timeout, scheduling, a request through it"],
    ["1780-http-res-surface.ts", "listening event\nlisten callback, ports agree: yes\nchain x-a=1\nchain status=202 msg=Chained Along body=chained\nsrv props read back: 404 Gone Fishing\nprops status=404 msg=Gone Fishing body=props\nsrv after end (before the callback)\nsrv end callback fired\ncrud got=2 had=yes after=no x-b=-\ncrud status=200 msg=OK body=crud\nclosed\n", "the typed ServerResponse surface: statusCode / statusMessage, headers CRUD, writeHead forms, write / end"],
    ["1781-http-server-shapes.cjs", "call-form listening\n/call -> call-form\nnew-form listening, wrappers made: several\n/new -> new-form\ndone\n", "createServer's shapes: no listener, a listener, an options record, on('request')"],
    ["1795-dyn-handle-request.cjs", "method GET url /one\ntypeof req object, typeof res object\nserver req.statusCode: null\naccept header: text/probe\nstatusCode read-back: 203\nclient status 203\nx-num: 7 x-obj: yes\nbody served:/one\nwrappers made: several\n", "a checked-dynamic IncomingMessage: method, url, headers, rawHeaders, httpVersion, statusCode null"],
    ["1796-dyn-handle-body.cjs", "identity held: true\nserver body: ping-pong\nheadersSent before: false ended before: false\nheadersSent after: true ended after: true\nend callback fired\ncollect leg: 201 got:ping-pong\necho leg: 200 straight-through\n", "a checked-dynamic request body: 'data' / 'end', pipe into the response"],
    ["1798-dyn-handle-typed-box.ts", "identity across the boundary: true\nlane header: typed body: typed:/boxed\n", "a typed (req, res) listener crossing into dyn and back by identity"],
    ["2638-http-dyn-res-compat.cjs", "srv /plain req.destroyed: false req.readable: true\nsetHeader chains: true\ngetHeaders: {\"a\":\"1\",\"b\":\"2\"}\nres.req is req: true\nheadersSent after flushHeaders: true\nres close, destroyed: true\n/plain -> 200 \"done\" test: undefined a: 1 b: 2\nsrv /raw req.destroyed: false req.readable: true\nsetHeader chains: true\ngetHeaders: {\"a\":\"1\",\"b\":\"2\"}\n/raw -> 200 \"raw\" test: 9 a: 1 b: override\nsrv /cork req.destroyed: false req.readable: true\nsetHeader chains: true\ngetHeaders: {\"a\":\"1\",\"b\":\"2\"}\ncorked0: 0\ncorked2: 2\ncorked-after: 0 finished: false\nend cb, finished: true\n/cork -> 200 \"AABBCC\" test: undefined a: 1 b: 2\nsrv /hex req.destroyed: false req.readable: true\nsetHeader chains: true\ngetHeaders: {\"a\":\"1\",\"b\":\"2\"}\nwrite cb ran\n/hex -> 200 \"ABC\" test: undefined a: 1 b: 2\n", "the checked-dynamic ServerResponse: setHeader chains, getHeaders, writeHead with an array, cork, flags"],
    ["2639-http-dyn-req-pause.cjs", "pausing after first chunk: true\nresuming\nserver end, body: \"abcdefghij\"\nres.readable pre: true destroyed pre: false\nres.readable post: false\n", "pause / resume of a checked-dynamic request around its 'data' events"],
    ["2641-http-agent-surface.cjs", "getName(): localhost::\ngetName({}): localhost::\ngetName(full): 0.0.0.0:80:192.168.1.1\ngetName(family4): localhost:::4\ngetName(sockPath): localhost:::/tmp/x.sock\nmaxSockets: Infinity maxFreeSockets: 256\nprotocol: http: keepAlive: false\ndefaultPort set: true\nstatus: 200\nsockets has name: true len: 1\nrequests has name: false\nfreeSockets empty: {}\nbody: ok:/merged\n", "Agent.getName's forms, the global agent's defaults, the agent tables"],
    ["2642-http-agent-maxsockets.cjs", "res1 200 active: 1 queued: 1\nres2 200 still queued: false active: 1\nafter both: sockets? true requests? false\n", "maxSockets 1: the second request queues in agent.requests until the first frees the socket"],
    ["2714-set-server-handles.ts", "2 true true false\n3\nvisited 3\ntrue false 1\n0 1\n", "Set<http.Server> by reference identity"],
    ["2743-http-option-carry.ts", "negatives kept: -5 -1 -2\nzeros default: 1000 Infinity 256\nscheduling fifo: ok\nscheduling '': ok\nscheduling bogus: TypeError ERR_INVALID_ARG_VALUE The argument 'scheduling' must be one of: 'fifo', 'lifo'. Received 'bogus'\nrequireHostHeader false: HTTP/1.1 200 OK\nrequireHostHeader true: HTTP/1.1 400 Bad Request\nrequireHostHeader default: HTTP/1.1 400 Bad Request\nagent timeout -3: RangeError ERR_OUT_OF_RANGE The value of \"msecs\" is out of range. It must be a non-negative finite number. Received -3\nagent port -4: RangeError ERR_SOCKET_BAD_PORT Port should be >= 0 and < 65536. Received type number (-4).\nrequest timeout -1: RangeError ERR_OUT_OF_RANGE The value of \"timeout\" is out of range. It must be a non-negative finite number. Received -1\nrequest timeout NaN: RangeError ERR_OUT_OF_RANGE The value of \"timeout\" is out of range. It must be a non-negative finite number. Received NaN\nsrv /hold connection=close\nagent timeout fired\nsrv /slow connection=close\ntimeout 0: no timeout fired, status 200\nsrv /raw connection=close\nraw [\"X-A\",\"1\",\"Host\",\"Connection\",\"close\"]\nreason through a headers record: 201 Okay Then\nsrv /one connection=keep-alive\ngetHeader keeps the number: true false\nwriteHead threw: Invalid status code: 99\nstatusMessage after: Before\nsrv /two connection=keep-alive\ngetHeader keeps the number: true false\nwriteHead threw: Invalid status code: 99\nstatusMessage after: Before\none-shot pair done true\nconnections: 5\ndone\n", "the options the lowering now carries: Agent negatives and scheduling, agent timeout / port throws, request timeout validation and timeout: 0, agent: false with Connection: keep-alive, requireHostHeader, writeHead's check order, setHeader keeping a number"],
    ["2744-http-option-carry-dyn.cjs", "negatives: -5 -1 -2\nscheduling: fifo lifo lifo\nscheduling with a quote: TypeError ERR_INVALID_ARG_VALUE The argument 'scheduling' must be one of: 'fifo', 'lifo'. Received \"it's\"\nscheduling with every quote: TypeError ERR_INVALID_ARG_VALUE The argument 'scheduling' must be one of: 'fifo', 'lifo'. Received 'a\\'b\"c`d'\na long scheduling: TypeError ERR_INVALID_ARG_VALUE The argument 'scheduling' must be one of: 'fifo', 'lifo'. Received 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...\nagent timeout -3: RangeError ERR_OUT_OF_RANGE The value of \"msecs\" is out of range. It must be a non-negative finite number. Received -3\nsockets after the throw: [\"NAME\"] []\ntimeout a string: TypeError ERR_INVALID_ARG_TYPE The \"timeout\" argument must be of type number. Received type string ('5')\nmaxSockets -1 queues: [\"NAME\"] [\"NAME\"] 0 1\nsrv /one connection=keep-alive\ngetHeader number: number 7\ngetHeaders: {\"x-num\":7}\nsrv /two connection=keep-alive\ngetHeader number: number 7\ngetHeaders: {\"x-num\":7}\nconnections: 2\n", "the carried options through checked-dynamic values: Agent read-backs, agent.sockets after a throw and under maxSockets -1, a non-number timeout, setHeader / getHeaders numbers, agent: false connections"],
  ];
  for (const [name, stdout, what] of corpusRows) {
    test(`N2-C-${name.slice(0, 4)} corpus ${name} (${what}): full stdout, stderr and exit code equal Node's`, async () => {
      const r = await runN2(join(corpusDir, name), null);
      expect(r.stdout.toString("utf8")).toBe(stdout);
      expect(r.stderr.toString("utf8")).toBe("");
      expect(r.exitCode).toBe(0);
    }, 60000);
  }
  test("N2-OPT-01 an Agent's scheduling reaches the pool: with two free keep-alive sockets 'fifo' reuses the one freed first and 'lifo' (the default) the one freed last \u2014 SINGLE-EDIT: A_FIFO always 0", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// scheduling picks which free socket a keep-alive Agent reuses: 'fifo'\n// the one freed first, 'lifo' (the default) the one freed last.\nconst http = require('http');\nlet ports = [];\nlet heldA = null;\nconst server = http.createServer(function (req, res) {\n  const id = ports.indexOf(req.socket) + 1;\n  if (req.url === '/a') { heldA = res; return; }\n  if (req.url === '/b') { res.end('b'); return; }\n  res.end('conn' + id);\n});\nserver.on('connection', function (s) { ports.push(s); });\nfunction round(scheduling, agent, done) {\n  ports = [];\n  const port = server.address().port;\n  let ended = 0;\n  function both() {\n    if (++ended < 2) return;\n    setTimeout(function () {\n      http.get({ host: '127.0.0.1', port: port, path: '/c', agent: agent }, function (res) {\n        let body = '';\n        res.on('data', function (d) { body += d; });\n        res.on('end', function () {\n          console.log(scheduling + ': /c served on ' + body + ' (a was conn1, b conn2)');\n          agent.destroy();\n          done();\n        });\n      });\n    }, 50);\n  }\n  http.get({ host: '127.0.0.1', port: port, path: '/a', agent: agent }, function (res) { res.resume(); res.on('end', both); });\n  http.get({ host: '127.0.0.1', port: port, path: '/b', agent: agent }, function (res) {\n    res.resume();\n    res.on('end', function () { setTimeout(function () { heldA.end('a'); }, 20); both(); });\n  });\n}\nserver.listen(0, '127.0.0.1', function () {\n  round('fifo', new http.Agent({ keepAlive: true, scheduling: 'fifo' }), function () {\n    round('lifo', new http.Agent({ keepAlive: true }), function () { server.close(); });\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "fifo: /c served on conn2 (a was conn1, b conn2)\nlifo: /c served on conn1 (a was conn1, b conn2)\n", stderr: "", exitCode: 0 });
  }, 60000);

  test("N2-PARSE-01 malformed requests reach llhttp's error states: each is answered with the default clientError response (400, Connection: close, a Host-less HTTP/1.1 request's chunked 400), a two-Content-Length request too, while a bad chunk size after the headers lets the listener answer first; the request listener never runs for the others \u2014 SINGLE-EDIT: an llhttp error code mapped to a non-error", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// Malformed requests reach llhttp's error states: the server answers each\n// with its default clientError response and the request listener never runs.\nconst http = require('http');\nconst net = require('net');\nconst server = http.createServer(function (req, res) {\n  console.log('request listener ran for', req.url);\n  res.end('ok');\n});\nconst cases = [\n  ['bad method', 'G@T / HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n'],\n  ['bad version', 'GET / HTTP/9.9\\r\\nHost: x\\r\\n\\r\\n'],\n  ['space in header name', 'GET / HTTP/1.1\\r\\nBad Name: x\\r\\nHost: x\\r\\n\\r\\n'],\n  ['no Host on HTTP/1.1', 'GET / HTTP/1.1\\r\\n\\r\\n'],\n  ['two content-lengths', 'POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 1\\r\\nContent-Length: 2\\r\\n\\r\\nab'],\n  ['bad chunk size', 'POST / HTTP/1.1\\r\\nHost: x\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\nzz\\r\\n'],\n  ['a good one', 'GET /fine HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n'],\n];\nfunction next(port) {\n  const item = cases.shift();\n  if (item === undefined) {\n    server.close();\n    return;\n  }\n  const c = net.connect(port, '127.0.0.1');\n  let got = '';\n  c.on('data', function (d) { got += d.toString('latin1'); });\n  c.on('end', function () {\n    const lines = got.split('\\r\\n').filter(function (l) { return l.indexOf('Date:') !== 0; });\n    console.log(item[0] + ': ' + JSON.stringify(lines.join('|')));\n    next(port);\n  });\n  c.write(item[1]);\n}\nserver.listen(0, '127.0.0.1', function () {\n  next(server.address().port);\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "bad method: \"HTTP/1.1 400 Bad Request|Connection: close||\"\nbad version: \"HTTP/1.1 400 Bad Request|Connection: close||\"\nspace in header name: \"HTTP/1.1 400 Bad Request|Connection: close||\"\nno Host on HTTP/1.1: \"HTTP/1.1 400 Bad Request|Connection: close|Transfer-Encoding: chunked||0||\"\ntwo content-lengths: \"HTTP/1.1 400 Bad Request|Connection: close||\"\nrequest listener ran for /\nbad chunk size: \"HTTP/1.1 200 OK|Connection: keep-alive|Keep-Alive: timeout=5|Content-Length: 2||ok\"\nrequest listener ran for /fine\na good one: \"HTTP/1.1 200 OK|Connection: close|Content-Length: 2||ok\"\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-FRAME-01 _storeHeader's framing: end(body) alone is Content-Length, write() first is chunked, an explicit Content-Length wins, HTTP/1.0 closes with no length, HEAD has no body, a 204 no Transfer-Encoding, write(hex) decodes, cork / uncork and writableCorked \u2014 SINGLE-EDIT: the chunked decision ignoring hasContentLength", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// The framing _storeHeader chooses: end(body) alone is Content-Length,\n// write() before end() is chunked, an explicit Content-Length wins, HTTP/1.0\n// without keep-alive closes, HEAD has no body; cork batches chunks.\nconst http = require('http');\nfunction pass(x) { return x; }\nconst net = require('net');\nconst server = http.createServer(function (rq, rs) {\n  const req = pass(rq);\n  const res = pass(rs);\n  if (req.url === '/len') {\n    res.end('hello');\n  } else if (req.url === '/chunked') {\n    res.write('ab');\n    res.write(Buffer.from('cd'));\n    res.end('ef');\n  } else if (req.url === '/explicit') {\n    res.setHeader('Content-Length', 4);\n    res.write('wx');\n    res.end('yz');\n  } else if (req.url === '/hex') {\n    res.write('6869', 'hex');\n    res.end();\n  } else if (req.url === '/cork') {\n    res.cork();\n    res.write('one');\n    res.write('two');\n    console.log('corked:', res.writableCorked);\n    res.uncork();\n    res.end();\n  } else {\n    res.writeHead(204, { 'X-A': 'a' });\n    res.end();\n  }\n});\nconst cases = [\n  'GET /len HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n',\n  'GET /chunked HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n',\n  'GET /explicit HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n',\n  'GET /hex HTTP/1.0\\r\\n\\r\\n',\n  'HEAD /len HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n',\n  'GET /cork HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n',\n  'GET /none HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n',\n];\nfunction next(port) {\n  const item = cases.shift();\n  if (item === undefined) {\n    server.close();\n    return;\n  }\n  const c = net.connect(port, '127.0.0.1');\n  let got = '';\n  c.on('data', function (d) { got += d.toString('latin1'); });\n  c.on('end', function () {\n    const lines = got.split('\\r\\n').filter(function (l) { return l.indexOf('Date:') !== 0; });\n    console.log(JSON.stringify(lines.join('|')));\n    next(port);\n  });\n  c.write(item);\n}\nserver.listen(0, '127.0.0.1', function () {\n  next(server.address().port);\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "\"HTTP/1.1 200 OK|Connection: close|Content-Length: 5||hello\"\n\"HTTP/1.1 200 OK|Connection: close|Transfer-Encoding: chunked||2|ab|2|cd|2|ef|0||\"\n\"HTTP/1.1 200 OK|Content-Length: 4|Connection: close||wxyz\"\n\"HTTP/1.1 200 OK|Connection: close||hi\"\n\"HTTP/1.1 200 OK|Connection: close||\"\ncorked: 1\n\"HTTP/1.1 200 OK|Connection: close|Transfer-Encoding: chunked||3|one|3|two|0||\"\n\"HTTP/1.1 204 No Content|X-A: a|Connection: close||\"\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-AGENT-01 keep-alive reuse through an Agent: the freed socket parks in freeSockets and the next request reuses it (reusedSocket true), a concurrent request queues in agent.requests under the agent's name and takes the socket from 'free' (reusedSocket false, as in Node); one server connection in all \u2014 SINGLE-EDIT: onFree destroying instead of parking", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// Keep-alive reuse through an Agent: a second request after the first\n// response ends takes the freed socket (reusedSocket true); with\n// maxSockets 1 a concurrent request queues in agent.requests until the\n// socket is free. The server counts its connections.\nconst http = require('http');\nfunction pass(x) { return x; }\nlet conns = 0;\nconst server = http.createServer(function (req, res) {\n  res.end('r' + req.url);\n});\nserver.on('connection', function () { conns++; });\nconst agent = new http.Agent({ keepAlive: true, maxSockets: 1 });\nfunction get(path, cb) {\n  const req = http.get({ host: '127.0.0.1', port: server.address().port, path: path, agent: agent }, function (res) {\n    let body = '';\n    res.on('data', function (d) { body += d; });\n    res.on('end', function () {\n      console.log(path, res.statusCode, body, 'reused:', pass(req).reusedSocket, 'conn header:', res.headers.connection);\n      cb();\n    });\n  });\n  return req;\n}\nserver.listen(0, '127.0.0.1', function () {\n  get('/a', function () {\n    setImmediate(function () {\n      console.log('free after /a:', Object.keys(agent.freeSockets).length);\n      let left = 2;\n      const done = function () {\n        if (--left === 0) {\n          console.log('connections:', conns);\n          agent.destroy();\n          server.close();\n        }\n      };\n      get('/b', done);\n      get('/c', done);\n      const name = Object.keys(agent.requests)[0];\n      console.log('queued:', name.split(String(server.address().port)).join('PORT'), agent.requests[name].length);\n    });\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "/a 200 r/a reused: false conn header: keep-alive\nfree after /a: 1\nqueued: 127.0.0.1:PORT: 1\n/b 200 r/b reused: true conn header: keep-alive\n/c 200 r/c reused: false conn header: keep-alive\nconnections: 1\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-CLOSE-01 a client response whose body is never read, its socket closed by the server (Connection: close): the request's 'close' comes, the response is ended by push(null) and the program runs on to its timer \u2014 SINGLE-EDIT: socketCloseListener pushing a null chunk instead of push(null)", async () => {
    const r = await runN2("main.cjs", "'use strict';\nconst http = require('http');\nconst server = http.createServer(function (req, res) { res.setHeader('Connection', 'close'); res.end('body never read'); });\nserver.listen(0, '127.0.0.1', function () {\n  const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, function (res) {\n    console.log('response', res.statusCode);\n  });\n  req.on('close', function () { console.log('req close'); server.close(); });\n});\nsetTimeout(function () { console.log('timer'); }, 200);\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "response 200\nreq close\ntimer\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-CLOSE-02 a CONNECT response with no 'connect' listener: the socket is destroyed, the request closes and the program runs on \u2014 SINGLE-EDIT: socketCloseListener pushing a null chunk instead of push(null)", async () => {
    const r = await runN2("main.cjs", "'use strict';\nconst http = require('http');\nconst net = require('net');\nconst srv = net.createServer(function (s) {\n  s.on('data', function () {});\n  s.on('error', function () {});\n  s.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\ntunnel');\n});\nsrv.listen(0, '127.0.0.1', function () {\n  const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'CONNECT', path: 'example.com:443' }, function (res) { console.log('response', res.statusCode); });\n  req.on('close', function () { console.log('req close'); srv.close(); });\n  req.on('error', function (e) { console.log('req error', e.message); });\n  req.end();\n});\nsetTimeout(function () { console.log('timer'); }, 300);\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "req close\ntimer\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-CLOSE-03 a typed 101 Upgrade response with no 'upgrade' listener: the request closes and the program runs on \u2014 SINGLE-EDIT: socketCloseListener pushing a null chunk instead of push(null)", async () => {
    const r = await runN2("main.ts", "import * as http from \"node:http\";\nimport * as net from \"node:net\";\nconst srv = net.createServer((s) => {\n  s.on(\"data\", () => {});\n  s.end(\"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: x\\r\\nConnection: Upgrade\\r\\n\\r\\n\");\n});\nsrv.listen(0, \"127.0.0.1\", () => {\n  const req = http.request({ host: \"127.0.0.1\", port: srv.address().port, path: \"/\", headers: { Connection: \"Upgrade\", Upgrade: \"x\" } });\n  req.on(\"close\", () => { console.log(\"req close\"); srv.close(); });\n  req.end();\n});\nsetTimeout(() => console.log(\"timer\"), 300);\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "req close\ntimer\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-ENDCB-01 a dyn end(cb) once the response has finished writing hands cb ERR_STREAM_ALREADY_FINISHED, before and after 'finish'; the first end's cb is the 'finish' listener (no argument) \u2014 SINGLE-EDIT: the error callback dropped for the void one", async () => {
    const r = await runN2("main.cjs", "'use strict';\nconst http = require('http');\nfunction pass(x) { return x; }\nconst server = http.createServer(function (rq, rs) {\n  const res = pass(rs);\n  res.on('error', function (e) { console.log('res error', e.code); });\n  res.end('a', function (err) { console.log('first end cb', err === undefined ? 'undef' : err === null ? 'null' : err.code); });\n  res.end(function (err) { console.log('second end cb (before finish)', err === undefined ? 'undef' : err === null ? 'null' : err.code); });\n  res.on('finish', function () {\n    setImmediate(function () {\n      res.end(function (err) { console.log('third end cb (after finish)', err === undefined ? 'undef' : err === null ? 'null' : err.code); });\n      res.end('x', function (err) { console.log('fourth end cb (chunk)', err === undefined ? 'undef' : err === null ? 'null' : err.code); });\n    });\n  });\n});\nserver.listen(0, '127.0.0.1', function () {\n  http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, function (r) {\n    r.resume();\n    r.on('end', function () { setTimeout(function () { server.close(); }, 20); });\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "second end cb (before finish) ERR_STREAM_ALREADY_FINISHED\nfirst end cb undef\nthird end cb (after finish) ERR_STREAM_ALREADY_FINISHED\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-ENDCB-02 write(chunk, cb) and end(chunk, cb) after end(): each cb gets ERR_STREAM_WRITE_AFTER_END on a nextTick, followed by the response's 'error'; a bare end(cb) gets ERR_STREAM_ALREADY_FINISHED at once \u2014 SINGLE-EDIT: the error callback dropped for the void one", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// write() and end(chunk) after end(): each callback gets\n// ERR_STREAM_WRITE_AFTER_END on a nextTick, then the response emits 'error'.\nconst http = require('http');\nfunction pass(x) { return x; }\nconst server = http.createServer(function (rq, rs) {\n  const res = pass(rs);\n  res.end('a');\n  res.on('error', function (e) { console.log('res error', e.code, e.message); });\n  const r = res.write('b', function (err) { console.log('write cb', err && err.code); });\n  console.log('write returned', r);\n  res.end('again', function (err) { console.log('end cb', err && err.code); });\n  res.end(function (err) { console.log('bare end cb', err === undefined ? 'undefined' : err && err.code); });\n});\nserver.listen(0, '127.0.0.1', function () {\n  http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, function (res) {\n    let b = '';\n    res.on('data', function (d) { b += d; });\n    res.on('end', function () { console.log('client got', b); server.close(); });\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "write returned false\nbare end cb ERR_STREAM_ALREADY_FINISHED\nwrite cb ERR_STREAM_WRITE_AFTER_END\nres error ERR_STREAM_WRITE_AFTER_END write after end\nend cb ERR_STREAM_WRITE_AFTER_END\nres error ERR_STREAM_WRITE_AFTER_END write after end\nclient got a\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-RAW-01 a dyn rawHeaders is one array per message: two reads are the same array and a push to it is seen by the next read, on the server request and the client response \u2014 SINGLE-EDIT: the cached array not stored", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// rawHeaders is one array per message: two reads are the same array, and a\n// write to it is seen by the next read.\nconst http = require('http');\nfunction pass(x) { return x; }\nconst server = http.createServer(function (rq, rs) {\n  const req = pass(rq);\n  console.log('server same array:', req.rawHeaders === req.rawHeaders);\n  const raw = req.rawHeaders;\n  raw.push('X-Added');\n  console.log('server write kept:', req.rawHeaders[req.rawHeaders.length - 1], req.rawHeaders.length === raw.length);\n  rs.end('ok');\n});\nserver.listen(0, '127.0.0.1', function () {\n  http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, function (rs) {\n    const res = pass(rs);\n    console.log('client same array:', res.rawHeaders === res.rawHeaders, res.rawHeaders.length > 0);\n    res.resume();\n    res.on('end', function () { server.close(); });\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "server same array: true\nserver write kept: X-Added true\nclient same array: true true\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-RAW-02 the typed surface: rawHeaders (length, identity) and the headers record (Object.keys, a spread stringified) on the server request and the client response, and writeHead's odd-length array error, its inspection cut to 128 characters and '...' \u2014 SINGLE-EDIT: the rawHeaders vector built over a nullable buffer", async () => {
    const r = await runN2("main.ts", "// The typed surface: rawHeaders is one array per message, its length and\n// entries read on the server request and the client response; the headers\n// record spreads and stringifies; and an odd-length headers array long\n// enough that util.inspect breaks it over lines is cut to 128 characters in\n// ERR_INVALID_ARG_VALUE's message.\nimport * as http from \"node:http\";\n\nconst server = http.createServer((req, res) => {\n  console.log(\"server rawHeaders:\", req.rawHeaders.length, req.rawHeaders === req.rawHeaders);\n  console.log(\"server keys:\", Object.keys(req.headers).join(\",\"));\n  try {\n    res.writeHead(200, [\"x-header-one\", \"the first value\", \"x-header-two\", \"the second value\", \"x-header-three\", \"the third value\", \"x-header-four\", \"the fourth value\", \"x-header-five\"]);\n  } catch (e) {\n    console.log((e as Error).message);\n  }\n  try {\n    res.writeHead(200, [\"a\", \"b\", \"c\"]);\n  } catch (e) {\n    console.log((e as Error).message);\n  }\n  res.end(\"x\");\n});\nserver.listen(0, \"127.0.0.1\", () => {\n  http.get({ host: \"127.0.0.1\", port: server.address().port, path: \"/\", headers: { \"X-Q\": \"q\" } }, (res) => {\n    console.log(\"client rawHeaders:\", res.rawHeaders.length > 0, res.rawHeaders === res.rawHeaders);\n    console.log(\"client headers:\", JSON.stringify({ ...res.headers }).length > 2, Object.keys(res.headers).length > 0);\n    res.resume();\n    res.on(\"end\", () => server.close());\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "server rawHeaders: 6 true\nserver keys: x-q,host,connection\nThe argument 'headers' is invalid. Received [\n  'x-header-one',\n  'the first value',\n  'x-header-two',\n  'the second value',\n  'x-header-three',\n  'the third value',\n  'x-h...\nThe argument 'headers' is invalid. Received [ 'a', 'b', 'c' ]\nclient rawHeaders: true true\nclient headers: true true\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-ODD-01 a dyn writeHead with an odd-length headers array: ERR_INVALID_ARG_VALUE with util.inspect's rendering, cut to 128 characters and '...' when longer \u2014 SINGLE-EDIT: the 128-character cut dropped", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// writeHead with a long odd-length headers array through a dynamic value:\n// ERR_INVALID_ARG_VALUE's message cuts the inspection to 128 characters.\nconst http = require('http');\nfunction pass(x) { return x; }\nconst server = http.createServer(function (rq, rs) {\n  const res = pass(rs);\n  try {\n    res.writeHead(200, ['x-header-one', 'the first value', 'x-header-two', 'the second value', 'x-header-three', 'the third value', 'x-header-four', 'the fourth value', 'x-header-five']);\n  } catch (e) {\n    console.log(e.code, e.message);\n  }\n  try {\n    res.writeHead(200, ['a', 'b', 'c']);\n  } catch (e) {\n    console.log(e.code, e.message);\n  }\n  res.end('x');\n});\nserver.listen(0, '127.0.0.1', function () {\n  http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, function (res) {\n    res.resume();\n    res.on('end', function () { server.close(); });\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "ERR_INVALID_ARG_VALUE The argument 'headers' is invalid. Received [\n  'x-header-one',\n  'the first value',\n  'x-header-two',\n  'the second value',\n  'x-header-three',\n  'the third value',\n  'x-h...\nERR_INVALID_ARG_VALUE The argument 'headers' is invalid. Received [ 'a', 'b', 'c' ]\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-HDR-01 header validation and the headers-sent errors: ERR_INVALID_HTTP_TOKEN, ERR_INVALID_CHAR (value and statusMessage), ERR_HTTP_INVALID_HEADER_VALUE, ERR_INVALID_ARG_TYPE (getHeader, write), ERR_HTTP_INVALID_STATUS_CODE, ERR_STREAM_NULL_VALUES, ERR_HTTP_HEADERS_SENT for set / remove / write; writeHead keeps a rejected statusMessage, as Node's does \u2014 SINGLE-EDIT: the token check accepting a space", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// Header validation and the headers-sent errors, each caught and printed\n// as name|code|message; the response that follows is still well formed.\nconst http = require('http');\nfunction pass(x) { return x; }\nfunction attempt(label, fn) {\n  try {\n    fn();\n    console.log(label + ': ok');\n  } catch (e) {\n    console.log(label + ': ' + e.name + '|' + e.code + '|' + e.message);\n  }\n}\nconst server = http.createServer(function (rq, rs) {\n  const req = pass(rq);\n  const res = pass(rs);\n  attempt('token', function () { res.setHeader('bad name', 'v'); });\n  attempt('char', function () { res.setHeader('x-a', 'a\\nb'); });\n  attempt('undefined value', function () { res.setHeader('x-b', undefined); });\n  attempt('getHeader(5)', function () { res.getHeader(5); });\n  attempt('status 99', function () { res.writeHead(99); });\n  attempt('status msg', function () { res.writeHead(200, 'bad\\nmsg'); });\n  attempt('write null', function () { res.write(null); });\n  attempt('write number', function () { res.write(5); });\n  attempt('fine', function () { res.setHeader('X-Ok', ['a', 'b']); });\n  console.log('getHeader:', JSON.stringify(res.getHeader('x-ok')), 'names:', JSON.stringify(res.getHeaderNames()));\n  console.log('statusMessage kept:', JSON.stringify(res.statusMessage));\n  res.statusMessage = 'Made';\n  res.writeHead(201, { 'X-W': 'w' });\n  console.log('headersSent:', res.headersSent);\n  attempt('set after', function () { res.setHeader('x-c', 'c'); });\n  attempt('remove after', function () { res.removeHeader('x-ok'); });\n  attempt('writeHead after', function () { res.writeHead(202); });\n  res.end('done');\n});\nserver.listen(0, '127.0.0.1', function () {\n  http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, function (res) {\n    let body = '';\n    res.on('data', function (d) { body += d; });\n    res.on('end', function () {\n      const d = pass(res);\n      console.log(d.statusCode, d.statusMessage, JSON.stringify(d.headers['x-ok']), d.headers['x-w'], body);\n      server.close();\n    });\n  });\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "token: TypeError|ERR_INVALID_HTTP_TOKEN|Header name must be a valid HTTP token [\"bad name\"]\nchar: TypeError|ERR_INVALID_CHAR|Invalid character in header content [\"x-a\"]\nundefined value: TypeError|ERR_HTTP_INVALID_HEADER_VALUE|Invalid value \"undefined\" for header \"x-b\"\ngetHeader(5): TypeError|ERR_INVALID_ARG_TYPE|The \"name\" argument must be of type string. Received type number (5)\nstatus 99: RangeError|ERR_HTTP_INVALID_STATUS_CODE|Invalid status code: 99\nstatus msg: TypeError|ERR_INVALID_CHAR|Invalid character in statusMessage\nwrite null: TypeError|ERR_STREAM_NULL_VALUES|May not write null values to stream\nwrite number: TypeError|ERR_INVALID_ARG_TYPE|The \"chunk\" argument must be of type string or an instance of Buffer or Uint8Array. Received type number (5)\nfine: ok\ngetHeader: [\"a\",\"b\"] names: [\"x-ok\"]\nstatusMessage kept: \"bad\\nmsg\"\nheadersSent: true\nset after: Error|ERR_HTTP_HEADERS_SENT|Cannot set headers after they are sent to the client\nremove after: Error|ERR_HTTP_HEADERS_SENT|Cannot remove headers after they are sent to the client\nwriteHead after: Error|ERR_HTTP_HEADERS_SENT|Cannot write headers after they are sent to the client\n201 Made \"a, b\" w done\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-REG-01 S088 (f): a member of a checked-dynamic http handle this tier does not model throws a named Error (Node: req.trailers is an object, req.setTimeout and req.on return the request, res.addTrailers undefined, res.sendDate a boolean)", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// SEMANTICS.md S088 (f): members of the checked-dynamic http handles this\n// tier does not model throw a named, catchable Error (Node: they work);\n// (e) a request pipes into one destination; (d) the agent's tables are\n// snapshots.\nconst http = require('http');\nfunction pass(x) { return x; }\nfunction attempt(label, fn) {\n  try {\n    const v = fn();\n    console.log(label + ': ' + typeof v);\n  } catch (e) {\n    console.log(label + ': ' + e.name + '|' + e.message);\n  }\n}\nconst server = http.createServer(function (rq, rs) {\n  const req = pass(rq);\n  const res = pass(rs);\n  attempt('req.trailers', function () { return req.trailers; });\n  attempt('req.setTimeout', function () { return req.setTimeout(10); });\n  attempt('res.addTrailers', function () { return res.addTrailers({}); });\n  attempt('res.sendDate', function () { return res.sendDate; });\n  attempt('req.on(readable)', function () { return req.on('readable', function () {}); });\n  req.pipe(res);\n  attempt('a second pipe', function () { return req.pipe(res); });\n  const agent = pass(new http.Agent());\n  console.log('agent.sockets twice the same object:', agent.sockets === agent.sockets);\n  res.write('fenced');\n});\nserver.listen(0, '127.0.0.1', function () {\n  http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, function (res) {\n    let body = '';\n    res.on('data', function (d) { body += d; });\n    res.on('end', function () {\n      console.log(body);\n      server.close();\n    });\n  });\n});\n");
    // Node v24.18.1 prints: "req.trailers: object\nreq.setTimeout: object\nres.addTrailers: undefined\nres.sendDate: boolean\nreq.on(readable): object\na second pipe: object\nagent.sockets twice the same object: true\nfenced\n"
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "req.trailers: Error|reading the property 'trailers' of an http handle is not supported yet\nreq.setTimeout: Error|'setTimeout' on an http handle is not supported yet\nres.addTrailers: Error|'addTrailers' on an http handle is not supported yet\nres.sendDate: Error|reading the property 'sendDate' of an http handle is not supported yet\nreq.on(readable): Error|'on' for the event 'readable' on an http handle is not supported yet\na second pipe: Error|piping an IncomingMessage into a second destination is not supported yet\nagent.sockets twice the same object: false\nfenced\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-OPT-02 an options record's requireHostHeader: false reaches the server: a Host-less HTTP/1.1 request runs the listener (200), as in Node \u2014 SINGLE-EDIT: serverRequireHost ignoring its flag", async () => {
    const r = await runN2("main.cjs", "'use strict';\n// The options record's requireHostHeader: false reaches the server, so a\n// Host-less HTTP/1.1 request runs the listener (200), as in Node.\nconst http = require('http');\nconst net = require('net');\nconst server = http.createServer({ requireHostHeader: false }, function (req, res) {\n  res.end('listener ran');\n});\nserver.listen(0, '127.0.0.1', function () {\n  const c = net.connect(server.address().port, '127.0.0.1');\n  let got = '';\n  c.on('data', function (d) { got += d.toString('latin1'); });\n  c.on('end', function () {\n    console.log(got.split('\\r\\n')[0]);\n    server.close();\n  });\n  c.write('GET / HTTP/1.1\\r\\nConnection: close\\r\\n\\r\\n');\n});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "HTTP/1.1 200 OK\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("N2-REG-03 S088 (g): a null the static type does not admit (a server request's statusCode) is fenced by name (Node: null); on the same typed surface setHeader keeps a number and writeHead checks its status before it takes the reason, as in Node", async () => {
    const r = await runN2("main.ts", "// SEMANTICS.md S088 (g): a null the static type does not admit is fenced.\n// The typed ServerResponse lowerings around it are Node's: setHeader keeps\n// a number, and writeHead checks its status before it takes the reason.\nimport * as http from \"node:http\";\n\nconst server = http.createServer((req, res) => {\n  res.statusMessage = \"Before\";\n  res.setHeader(\"X-Count\", 5);\n  console.log(\"getHeader is the string:\", res.getHeader(\"X-Count\") === \"5\");\n  try {\n    res.writeHead(99, \"Odd\");\n  } catch (e) {\n    console.log(\"writeHead threw:\", (e as Error).message);\n  }\n  console.log(\"statusMessage after:\", res.statusMessage);\n  res.statusMessage = \"OK\";\n  try {\n    console.log(\"server request statusCode:\", req.statusCode);\n  } catch (e) {\n    console.log(\"statusCode threw:\", (e as Error).message);\n  }\n  res.end(\"done\");\n});\nserver.listen(0, \"127.0.0.1\", () => {\n  http.get({ host: \"127.0.0.1\", port: server.address().port, path: \"/\" }, (res) => {\n    res.on(\"data\", () => {});\n    res.on(\"end\", () => {\n      console.log(res.statusCode, res.headers[\"x-count\"]);\n      server.close();\n    });\n  });\n});\n");
    // Node v24.18.1 prints: "getHeader is the string: false\nwriteHead threw: Invalid status code: 99\nstatusMessage after: Before\nserver request statusCode: null\n200 5\n"
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "getHeader is the string: false\nwriteHead threw: Invalid status code: 99\nstatusMessage after: Before\nstatusCode threw: reading 'statusCode' of a server request (null) is not supported yet\n200 5\n", stderr: "", exitCode: 0 });
  }, 60000);
});

// ── self-capturing boxed declarations ─────────────────────────────────────
// A hoisted `function f` that hands `f` to a nested closure captures its own
// binding while that binding is being initialized: the box must be minted
// before the closure is built (a stale null box trapped on the first nested
// read). Expected outputs measured against Node v24.18.1 on the same source.
describe("self-capturing boxed declaration rows", () => {
  async function runDyn(src: string): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "selfcap-row-"));
    try {
      const path = join(dir, "main.cjs");
      writeFileSync(path, src);
      const res = await compile(path, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: true, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("SELFCAP-01 the write/drain pump: a nested hoisted function capturing let locals and a dyn value, re-entered from a timer callback that captures it \u2014 SINGLE-EDIT: the boxed varDecl walking its initializer before minting the box", async () => {
    const r = await runDyn("'use strict';\nconst EventEmitter = require('events');\nfunction pass(x) { return x; }\nfunction run(e0) {\n  const res = pass(e0);\n  let i = 0;\n  let drains = 0;\n  let falses = 0;\n  function pump() {\n    while (i < 5) {\n      i++;\n      if (i % 2 === 0) { falses++; setTimeout(function () { drains++; pump(); }, 1); return; }\n    }\n    console.log('done', falses, drains, typeof res);\n  }\n  pump();\n}\nrun({});\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "done 2 2 object\n", stderr: "", exitCode: 0 });
  }, 60000);
  test("SELFCAP-02 a block-scoped hoisted function in a for-let loop recursing through a nested closure, and an outer function called twice: a fresh box per execution, each shared with its own closure \u2014 SINGLE-EDIT: the boxed varDecl walking its initializer before minting the box", async () => {
    const r = await runDyn("'use strict';\nfor (let k = 0; k < 3; k++) {\n  function tick(n) {\n    if (n > 0) { const g = function () { tick(n - 1); }; g(); return; }\n    console.log('k' + String(k));\n  }\n  tick(2);\n}\nfunction outer(tag) {\n  let c = 0;\n  function again() { c++; if (c < 2) setTimeout(function () { again(); }, 1); else console.log(`${tag} ${c}`); }\n  again();\n}\nouter('one');\nouter('two');\n");
    expect({ stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), exitCode: r.exitCode }).toEqual({ stdout: "k0\nk1\nk2\none 2\ntwo 2\n", stderr: "", exitCode: 0 });
  }, 60000);
});

// ── INC-29 U3 WHATWG URL rows ─────────────────────────────────────────────
// The WHATWG URL and URLSearchParams are built in the module (url-whatwg.ts,
// url-idna.ts — Node's ada and lib/internal/url.js). The parse, IDNA and
// URLSearchParams oracle matrices are host-free (packages/compiler/test/
// wasm-url-u3.test.ts); these rows pin the twelve corpus programs this unit
// claims and the http client's URL argument, which needs this file's net
// host. Every expected output was measured against Node v24.18.1 on the
// same source.
describe("INC-29 U3 WHATWG URL rows", () => {
  async function runU3(file: string, src: string | null): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "u3-row-"));
    try {
      let path = file;
      if (src !== null) {
        path = join(dir, file);
        writeFileSync(path, src);
      }
      const res = await compile(path, { outPath: join(dir, "p.wasm"), outDir: dir, dynamic: wantsDynamic(path), backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      return await runWasm(res.binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const corpusRows: [string, string, string][] = [
    ["1355-url-parse.ts", "U http://example.com/b?q=1#f | http: | /b\nT true\nU https://a.b/x | https: | /x\nT true\nU http://a.b:8080/x | http: | /x\nT true\nU http://h/x | http: | /x\nT true\nU http://h:0/x | http: | /x\nT true\nU http://h/x | http: | /x\nT true\nU file:///tmp/x%20y/z | file: | /tmp/x%20y/z\nT true\nU file:///tmp/x | file: | /tmp/x\nT true\nU file:///tmp | file: | /tmp\nT true\nU file:/// | file: | /\nT true\nU file:///etc | file: | /etc\nT true\nU file:////double | file: | //double\nT true\nU data:text/plain,hi there | data: | text/plain,hi there\nT true\nU mailto:x@y.z | mailto: | x@y.z\nT true\nU git://Host/X | git: | /X\nT true\nU git://host | git: | \nT true\nU git://host?q | git: | \nT true\nU http://user:pw@host/p | http: | /p\nT true\nU ws://h/ | ws: | /\nT true\nU wss://h/a | wss: | /a\nT true\nU ftp://h/f | ftp: | /f\nT true\nU http://h/a%20b?c%20d#e%20f | http: | /a%20b\nT true\nU http://h//double//slash/ | http: | //double//slash/\nT true\nU http://h/x | http: | /x\nT true\nU http://h/y | http: | /y\nT true\nU http://h/ | http: | /\nT true\nU http://h/a/ | http: | /a/\nT true\nU http://h/a | http: | /a\nT true\nU https://h/?q | https: | /\nT true\nU https://h/#f | https: | /\nT true\nU http://foo.com/x | http: | /x\nT true\nU http://foo.com/x | http: | /x\nT true\nU https://h/x | https: | /x\nT true\nU foo:/x | foo: | /x\nT true\nU foo:bar/../x | foo: | bar/../x\nT true\nU view-source:http://x/ | view-source: | http://x/\nT true\nU c:\\windows | c: | \\windows\nT true\nU http://h/backslash/x | http: | /backslash/x\nT true\nU http://h/%41%zz | http: | /%41%zz\nT true\nU http://h/a?b%20c?d | http: | /a\nT true\nU http://h/%7Bcurly%7D?`tick`#lt%3Cgt%3E | http: | /%7Bcurly%7D\nT true\nU http://trimmed.example/ | http: | /\nT true\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nX Invalid URL\nhit https: /path\nmiss true\n", "the URL class over the WHATWG parse table, Invalid URL TypeErrors, URL | undefined"],
    ["1356-url-file-bridge.ts", "file:///tmp/a%20b/c%25d\nfile:///tmp/%C3%A9%F0%9F%8C%8D\n/tmp/a b/c%d\n/tmp/é\n/x/y\n/\n/upper\ntrue\ntrue\ntrue\nThe URL must be of scheme file\nFile URL path must not include encoded / characters\nFile URL path must not include encoded / characters\nFile URL host must be \"localhost\" or empty on linux\nInvalid URL\n", "fileURLToPath / pathToFileURL: percent round-trips, both receiver forms, the TypeError texts"],
    ["1557-url-host.ts", "example.com\nlocalhost:3000\napi.test:8443\n<>\n<>\nexample.com\napi.test:8443\nhttps: example.com /path\n", "URL.host: lowercase, non-default ports, empty for file and opaque URLs"],
    ["1577-url-hostname.ts", "example.com\nlocalhost\napi.test\n<>\n<>\nexample.com\nfalse\ntrue\napi.test\nhttps: example.com example.com /path\n", "URL.hostname beside host"],
    ["1611-url-file-bridge-neutral.ts", "U1 file: true\nU2 true\nU3 true\nU4 true\nU5 true\nU6 true\nU7 true true\nF1 The URL must be of scheme file\nF2 Invalid URL\nF3 File URL path must not include encoded / characters\nF4 File URL host must be \"localhost\" or empty on linux\n", "the file-URL bridge built from the cwd"],
    ["1791-searchparams-core.ts", "a=1&b=2&a=3\n\"1\" null\n1,3 0\na=1&b=2&a=3&c+d=x+y%2Bz\na=9&b=2&c+d=x+y%2Bz\na=9&b=2&c+d=x+y%2Bz&brand=new\na=9&c+d=x+y%2Bz&brand=new 3 true false true\na=9&brand=new&c+d=x+y%2Bz\na=0&k=3&k=1&k=2\na=2&b=9 true false false\nlead=1\n%3Fkeep=1\n0 0\na=1&b+c=2+3\nk=v&k=w&s+p=q%2Br\na=1&b+c=2+3 | a=1&b+c=2+3&q=r\ncaught TypeError Each query pair must be an iterable [name, value] tuple\ncaught TypeError Each query pair must be an iterable [name, value] tuple\n", "URLSearchParams constructor shapes and list methods, ERR_INVALID_TUPLE"],
    ["1792-searchparams-encoding.ts", "q \"\" ->  |  | 0\nq \"&\" ->  |  | 0\nq \"&&\" ->  |  | 0\nq \"a\" -> \"a\":\"\" | a= | 1\nq \"=x\" -> \"\":\"x\" | =x | 1\nq \"a=\" -> \"a\":\"\" | a= | 1\nq \"=\" -> \"\":\"\" | = | 1\nq \"a==b\" -> \"a\":\"=b\" | a=%3Db | 1\nq \"a=b=c\" -> \"a\":\"b=c\" | a=b%3Dc | 1\nq \"%\" -> \"%\":\"\" | %25= | 1\nq \"%2\" -> \"%2\":\"\" | %252= | 1\nq \"%2G\" -> \"%2G\":\"\" | %252G= | 1\nq \"%2b=%2B\" -> \"+\":\"+\" | %2B=%2B | 1\nq \"%ff=%FF\" -> \"�\":\"�\" | %EF%BF%BD=%EF%BF%BD | 1\nq \"a+b=c+d\" -> \"a b\":\"c d\" | a+b=c+d | 1\nq \"%41=%61\" -> \"A\":\"a\" | A=a | 1\nq \"??a=1\" -> \"?a\":\"1\" | %3Fa=1 | 1\nq \"a=%E2%88\" -> \"a\":\"�\" | a=%EF%BF%BD | 1\nq \"a=%ED%A0%80\" -> \"a\":\"���\" | a=%EF%BF%BD%EF%BF%BD%EF%BF%BD | 1\nq \"🚀=💥\" -> \"🚀\":\"💥\" | %F0%9F%9A%80=%F0%9F%92%A5 | 1\n%01%02%03%04%05%06%07%08%09%0A%0B%0C%0D%0E%0F%10%11%12%13%14%15%16%17%18%19%1A%1B%1C%1D%1E%1F+%21%22%23%24%25%26%27%28%29*%2B%2C-.%2F0123456789%3A%3B%3C%3D%3E%3F%40ABCDEFGHIJKLMNOPQRSTUVWXYZ%5B%5C%5D%5E_%60abcdefghijklmnopqrstuvwxyz%7B%7C%7D%7E%7F=%01%02%03%04%05%06%07%08%09%0A%0B%0C%0D%0E%0F%10%11%12%13%14%15%16%17%18%19%1A%1B%1C%1D%1E%1F+%21%22%23%24%25%26%27%28%29*%2B%2C-.%2F0123456789%3A%3B%3C%3D%3E%3F%40ABCDEFGHIJKLMNOPQRSTUVWXYZ%5B%5C%5D%5E_%60abcdefghijklmnopqrstuvwxyz%7B%7C%7D%7E%7F\n%C3%A9=%E6%BC%A2%E5%AD%97&%F0%9D%92%B3=%EF%BF%BDx\n=3|a=5|z=4|z=6|🚀=2|￻=1\ntrue \"c&d=e\" \"100%\"\n", "the urlencoded parser and serializer edges, sort by code units"],
    ["1793-searchparams-iteration.ts", "pair a 1\npair b 2\npair c 3\nkeyonly a\nkeyonly b\nkeyonly c\ntuple a 1 2\ntuple b 2 2\ntuple c 3 2\nentry a 1\nentry b 2\nentry c 3\nkey a\nkey b\nkey c\nval 1\nval 2\nval 3\nfe2 a 1\nfe2 b 2\nfe2 c 3\nfe1 1\nfe1 2\nfe1 3\nfe3 a 1 3\nfe3 b 2 3\nfe3 c 3 3\na,c,d | a=1&c=3&d=4\na,ax,axx\nmid y\n", "for-of, keys/values/entries and forEach over a live list"],
    ["1794-searchparams-url-live.ts", "?a=1 1\nhttps://ex.com/p?a=1&b=2+3 ?a=1&b=2+3 a=1&b=2+3\n?a=zz&b=2+3 https://ex.com/p?a=zz&b=2+3\nhttps://ex.com/p?a=zz&b=2+3\nhttps://ex.com/p \"\" 0\nhttps://ex.com/p?late=1\n\"c d\" \"é\"\nhttp://h/p?a+b=c+d&u=%C3%A9&w=x+y\n\"\"\n\"\"\n?q=1 q=1\nhttp://h/x?k=v | k=v&more=1\n?z=one ?z=2\n", "url.searchParams as the live view of the URL's query"],
    ["2381-builtin-default-imports.js", "a/c / y.txt .gz\ntrue true true\nfalse\n/tmp/a b.txt file:///tmp/x%20y\n/home/u false /a/c\n", "node:url's default import: fileURLToPath and pathToFileURL(...).href"],
    ["2571-searchparams-arg-validation.cjs", "TypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_INVALID_THIS|Value of \"this\" must be of type URLSearchParams\nTypeError|ERR_MISSING_ARGS|The \"name\" argument must be specified\nTypeError|ERR_MISSING_ARGS|The \"name\" argument must be specified\nTypeError|ERR_MISSING_ARGS|The \"name\" argument must be specified\nTypeError|ERR_MISSING_ARGS|The \"name\" argument must be specified\nTypeError|ERR_MISSING_ARGS|The \"name\" and \"value\" arguments must be specified\nTypeError|ERR_MISSING_ARGS|The \"name\" and \"value\" arguments must be specified\nError|undefined|toString\nError|undefined|toString\nError|undefined|toString\nret \"1\"\nTypeError|undefined|Cannot convert a Symbol value to a string\nTypeError|undefined|Cannot convert a Symbol value to a string\nTypeError|undefined|Cannot convert a Symbol value to a string\nret null\nret null\nret null\n?foo=~bar\n?foo=%7Ebar\n", "URLSearchParams argument coercion through a user toString"],
    ["2644-http-client-url-argument.ts", "string 200\nbody hi /one?q=1\nurl object hi /two\nrequest hi /three\nscheme Protocol \"https:\" not supported. Expected \"http:\"\nparse Invalid URL\n", "http.get / http.request with a URL string or URL object, ERR_INVALID_PROTOCOL, Invalid URL"],
  ];
  for (const [name, stdout, what] of corpusRows) {
    test(`URL-C-${name.slice(0, 4)} corpus ${name} (${what}): full stdout, stderr and exit code equal Node's`, async () => {
      const r = await runU3(join(corpusDir, name), null);
      expect(r.stdout.toString("utf8")).toBe(stdout);
      expect(r.stderr.toString("utf8")).toBe("");
      expect(r.exitCode).toBe(0);
    }, 60000);
  }

  test("URL-HTTP-01 the http client's URL argument: ERR_INVALID_PROTOCOL for another scheme (whatever its case), urlToHttpOptions' URIError on malformed credentials before the protocol check, Invalid URL; credentials become the Authorization header after Host, the path is pathname + search with dot segments resolved and the fragment dropped, a host lowercases, request(url) without a callback — SINGLE-EDIT: httpTarget's checks or clientRequestUrl's header order", async () => {
    const r = await runU3("main.ts", "import * as http from \"node:http\";\n\nconst server = http.createServer((req, res) => {\n  res.end(`${req.method} ${req.url} auth=${req.headers.authorization ?? \"-\"} host=${req.headers.host ?? \"-\"}`);\n});\n\nfunction fails(f: () => void): void {\n  try {\n    f();\n    console.log(\"no throw\");\n  } catch (e) {\n    console.log(\"threw\", (e as Error).name, (e as Error).message);\n  }\n}\n\nserver.listen(0, () => {\n  const port = server.address().port;\n  fails(() => http.get(\"ftp://127.0.0.1/x\", () => {}));\n  fails(() => http.get(\"HTTPS://127.0.0.1/x\", () => {}));\n  fails(() => http.get(\"http://%zz@127.0.0.1:1/\", () => {}));\n  fails(() => http.get(\"http://u:%zz@127.0.0.1:1/\", () => {}));\n  fails(() => http.get(\"ftp://%zz@127.0.0.1:1/\", () => {}));\n  fails(() => http.get(\"\", () => {}));\n  http.get(`http://us%20er:p%C3%A9ss@127.0.0.1:${port}/a/../b%20c?x=1#frag`, (res) => {\n    let b = \"\";\n    res.on(\"data\", (c) => { b += c; });\n    res.on(\"end\", () => {\n      console.log(\"one\", res.statusCode, b.split(String(port)).join(\"PORT\"));\n      const req = http.request(`http://LOCALHOST:${port}/two?é`);\n      req.on(\"response\", (res2) => {\n        let b2 = \"\";\n        res2.on(\"data\", (c) => { b2 += c; });\n        res2.on(\"end\", () => {\n          console.log(\"two\", b2.split(String(port)).join(\"PORT\"));\n          http.get(new URL(`http://:pw@127.0.0.1:${port}`), (res3) => {\n            let b3 = \"\";\n            res3.on(\"data\", (c) => { b3 += c; });\n            res3.on(\"end\", () => {\n              console.log(\"three\", b3.split(String(port)).join(\"PORT\"));\n              server.close();\n            });\n          });\n        });\n      });\n      req.end();\n    });\n  });\n});\n");
    expect(r.stdout.toString("utf8")).toBe("threw TypeError Protocol \"ftp:\" not supported. Expected \"http:\"\nthrew TypeError Protocol \"https:\" not supported. Expected \"http:\"\nthrew URIError URI malformed\nthrew URIError URI malformed\nthrew URIError URI malformed\nthrew TypeError Invalid URL\none 200 GET /b%20c?x=1 auth=Basic dXMgZXI6cMOpc3M= host=127.0.0.1:PORT\ntwo GET /two?%C3%A9 auth=- host=localhost:PORT\nthree GET / auth=Basic OnB3 host=127.0.0.1:PORT\n");
    expect(r.stderr.toString("utf8")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60000);
});
