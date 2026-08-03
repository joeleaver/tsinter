# tsinter semantics register

Every place tsinter's observable behavior deliberately diverges from Node
gets a numbered entry here — **before** the change merges, not after. Code
comments cite entries as `SEMANTICS.md S###`; citing an entry that does not
exist is a bug (CI lint planned). Node remains the oracle for everything not
listed here: if a question isn't answered on this page, the answer is
"whatever `node` does, byte-for-byte", and the differential corpus enforces
it.

This register exists because our upstream (scriptc) maintained one and never
shipped it — its code cites a `SEMANTICS.md` with 350+ entries that is not in
the repo. We inherit the discipline, not the file. Entries marked
*(inherited)* reproduce upstream stances we verified empirically from the IR
contract, validator, and corpus rather than from their register.

Format: `S###` numbers are permanent and never reused. An entry states the
divergence, the rationale, and how it is tested.

---

## S001 — Numbers are f64, exactly and only *(inherited)*

Every `number` is an IEEE-754 double at every point in the pipeline,
including loop counters and array indices. There is no integer inference and
no machine-int fast path; bitwise operators apply ToInt32/ToUint32 and return
to f64, as in JS. Number→string formatting must be byte-exact to Node.
**Rationale:** JS-exact semantics beat lookalike-language performance; integer
unboxing is a future *optimization* that must never change observable
behavior. **Tested by:** entire differential corpus; upstream's Ryū-based
formatting was fuzz-verified against Node on 10⁶ doubles — the wasm runtime
must meet the same bar.

## S002 — Strings are UTF-16 code-unit indexed, JS-exact *(inherited)*

The IR string contract is UTF-16 code-unit semantics (`length`, indexing,
`slice`, comparison), matching JS exactly. Upstream's C runtime stored UTF-8
and paid translation costs plus a documented lone-surrogate divergence;
tsinter's WasmGC backend uses UTF-16-faithful representations, so this
divergence class is *removed*, not inherited. **Tested by:** corpus string
programs; the wasm emitter unit test pins lone-surrogate identity through
`charCodeAt`/`split("")`/`isWellFormed`/`toWellFormed` (a corpus program
cannot cover this — the native lanes still carry upstream's U+FFFD
substitution, so the removal is observable on the wasm tier only).

## S003 — Out-of-bounds array reads throw `RangeError` *(inherited)*

Arrays are dense; `a[i]` with `i` outside `[0, length)` throws `RangeError`
instead of returning `undefined`. This is the static tier's largest deliberate
semantic divergence from JS and the price of unboxed typed arrays.
**Rationale:** returning `undefined` would force every element type to be
`T | undefined`. **Tested by:** diagnostics fixtures + corpus programs using
`@exit:` lanes (cannot be differential-tested against Node by definition).

## S004 — Node platform APIs are refused, not emulated

The static tier compiles the language and core stdlib (`Math`, `String`,
`Array`, `Map`/`Set`, `JSON`, `console.log`, `Promise`). Node platform
surfaces (`fs`, `net`, `http`, `child_process`, `process.*` beyond a minimal
subset, …) are **refused at compile time with a named diagnostic** — never
stubbed, never silently absent at runtime. Host capabilities enter a tsinter
module only through its declared imports. **Rationale:** the output is a
sandboxed wasm module; ambient OS authority would be a lie at best and a
sandbox hole at worst. **Tested by:** wasm-differential harness refusal
histogram (Node-platform corpus programs must appear as refusals, not
failures).

## S005 — Source string relational comparison is code-point order *(inherited)*

`<` `<=` `>` `>=` between strings compare by Unicode CODE POINT, not by
UTF-16 code unit as ECMAScript specifies. The two orders disagree exactly
when a supplementary character (U+10000+) meets a BMP character in
[U+E000, U+FFFF]: JS sorts the supplementary FIRST (its high surrogate
0xD800-0xDBFF is a smaller unit), code-point order sorts it LAST. This is
the IR's documented contract for `strCmp` without the `utf16` flag; the flag
— set only by the default `Array.prototype.sort` comparator — requests the
ECMAScript unit order, so sorted output stays Node-exact. **Rationale:**
inherited stance; code-point order is arguably saner and the divergent
range is exotic. **Tested by:** the wasm emitter unit test pins one
divergent-range comparison against this entry; corpus programs stay outside
the divergent range (they must, to pass the Node differential).

## S006 — `pop()` on an empty array throws `RangeError` *(inherited)*

`Array.prototype.pop` is typed as the ELEMENT (not `elem | undefined`), and
popping an empty array throws `RangeError` instead of returning `undefined`
— S003's stance extended to the one removal method whose JS result type
would otherwise poison every element type with `| undefined`. `shift()` is
NOT part of this divergence: it stays JS-exact (`elem | undefined`,
`undefined` on empty) because its result already crosses the union
representation. The C runtime's `scr_arr_pop_slot` and the wasm backend's
pop emission share the stance; the "throw" is an UNCATCHABLE abort on both
tiers (`scr_trap` natively, a wasm trap reported as exit 1 through the S003
bridge) — native parity, not a temporary bridge: the may-throw analysis
counts runtime traps as aborts, so no pending check ever observes one. **Rationale:** inherited from the upstream runtime; the
asymmetry with shift is upstream's, kept because re-typing pop would touch
every corpus program using it. **Tested by:** corpus array programs (pop on
non-empty paths must match Node byte-for-byte); the wasm emitter unit test
covers non-empty pop and empty shift.

## S007 — Wasm tier: an UNCAUGHT exception reports as a trap; stderr is not Node's

*(Narrowed 2026-08-03: the original entry described uncaught-throw-as-trap
for a tier with no `tryCatch` at all. The exception protocol has since
landed — real throw/catch/finally/rethrow via a pending-flag unwind, the
native backends' model — so thrown values are always evaluated and
catchable. What survives is the UNCAUGHT half.)*

An exception that unwinds out of `%main` is uncaught: `_start` tests the
pending cell and traps, which the harness bridge reports as exit code 1 —
Node's uncaught-exception exit — while stderr carries only what the program
itself wrote to fd 2, with no Node-style uncaught-exception report (stack
traces are not captured; the native tier's uncaught printer writes "name:
message" where Node writes a trace, so stderr already diverges there too).
The same holds for an exception out of a MACROTASK callback: `_tick` tests
the cell after every timer and every immediate callback and traps there,
and a repeating interval whose callback threw does not re-arm — the process
is already dead, exactly as it is in Node. **Rationale:** the artifact ABI
has no exit-code channel; the trap IS the nonzero exit. **Tested by:**
corpus uncaught-throw programs and `1442-interval-throw` (stdout before the
throw plus exit code must match Node; the harness skips the stderr compare
for nonzero-exit programs); the wasm emitter unit test pins the
evaluation-order-then-trap case and the wasm timers unit test the
interval-callback one.

## S008 — Wasm tier: string `repeat`/`pad` size cap is 2^31 units

`String.prototype.repeat` with a negative or infinite count traps (the
spec's RangeError through the S003 bridge, exit 1 like Node). The SIZE
limit differs: results at or past 2^31 UTF-16 units trap, where Node's
RangeError fires around 2^29 units — so a result length in [2^29, 2^31)
that Node rejects may instead be attempted here and survive if the GC can
allocate it. **Rationale:** native parity — the C runtime's `scr_str_repeat` aborts
through `scr_trap` on the same conditions (an UNCATCHABLE termination where
Node throws a catchable RangeError; the may-throw analysis counts runtime
traps as aborts on every tier), and 2^31 is the wasm storage's own bound;
real programs between the thresholds are allocating gigabytes of string
either way. **Tested by:** the wasm emitter unit test covers the trap side
(negative count); the divergent window is deliberately untested — corpus
programs cannot sit in it without multi-GB appetites.

## S009 — A checked cast on a catch binding validates instead of erasing *(inherited)*

`e as C` on a catch binding is a RUNTIME check: a payload that is an
instance of `C` passes through, and anything else throws a catchable
`TypeError` reading `caught value is not an instance of <C> (checked cast)`.
Node erases the annotation, so `(e as Error).message` on a thrown string
evaluates to `undefined` there and throws here. **Rationale:** inherited —
`as` is the documented trust-but-verify spelling at every dynamic boundary
in this compiler (the `dyn` surface's casts behave the same way, and
`scr_caught_check_obj` is the C runtime's implementation), and a static tier
that erased it would have to represent every catch payload as `dyn` to keep
the `undefined` answer. **Tested by:** the wasm emitter unit test (a corpus
program cannot cover it — every backend diverges from Node the same way, so
there is no byte-exact lane to compare).

## S010 — Wasm tier: an unhandled promise rejection reports as a trap; stderr is not Node's

A promise that is REJECTED and never observed — nothing awaited it, and no
handler ran — is reported at the END of a microtask checkpoint: after
`_start`'s drain, and inside `_tick` after the drain that follows every
timer and immediate callback, which is where Node decides it too. The tier
writes `Unhandled promise rejection: <reason>` to fd 2 (the reason rendered
exactly as the native runtime's `scr_report_unhandled_rejections` renders
it: numbers through ToString, booleans as `true`/`false`, strings raw,
`Error`s as `name: message`) and then TRAPS, which the harness bridge
reports as exit code 1 — Node's unhandled-rejection exit. Node's own stderr
instead carries an `ERR_UNHANDLED_REJECTION` report with a stack trace.
Only the FIRST unobserved rejection is reported, like Node and like the
native lane. **Rationale:** S007's reasoning exactly — the artifact ABI has
no exit-code channel, so the trap IS the nonzero exit, and stack traces are
not captured on this tier. **Tested by:** the wasm async unit test (stdout
before quiescence plus the stderr line and the trap); the differential
corpus for the exit code (the harness skips the stderr compare for
nonzero-exit programs).

## S011 — `Timeout.refresh()` cannot revive a one-shot that already fired *(inherited)*

`refresh()` re-arms a timer to now + its ORIGINAL delay. It works on an
ARMED timeout or interval and on the timer whose callback is currently
running (the common `t.refresh()`-inside-its-own-callback shape); but a
one-shot that fired on an EARLIER turn is gone from the heap, and
refreshing its handle is a silently tolerated no-op. Node revives it — a
fired `Timeout` object is still live and `refresh()` puts it back on the
clock. **Rationale:** inherited from the native tier (`scr_timer_refresh`),
where a fired one-shot has released its callback closure and there is
nothing left to re-arm; the compiled handle is an id into the heap, not an
object that outlives its entry, and giving every fired timeout an
indefinite afterlife would mean retaining every callback a program ever
armed. **Tested by:** the corpus pins the SUPPORTED shapes
(`1803-timeout-refresh`, refresh from inside the callback); the divergent
one is deliberately untested — a corpus program covering it could not
match Node on any backend.
