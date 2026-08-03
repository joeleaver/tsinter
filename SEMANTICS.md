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
pop emission share the stance; on the wasm tier the throw is currently the
S003 trap bridge (a wasm trap reported as exit 1) until the exception
protocol lands. **Rationale:** inherited from the upstream runtime; the
asymmetry with shift is upstream's, kept because re-typing pop would touch
every corpus program using it. **Tested by:** corpus array programs (pop on
non-empty paths must match Node byte-for-byte); the wasm emitter unit test
covers non-empty pop and empty shift.

## S007 — Wasm tier: uncaught `throw` is a trap; stderr is not Node's

A program the wasm tier emits contains no `tryCatch` anywhere (the construct
refuses, and one refusal refuses the whole program), so every `throw` that
executes is uncaught. `throw` therefore compiles to a wasm trap: the S003
bridge reports it as exit code 1 — Node's uncaught-exception exit — while
stderr carries only what the program itself wrote to fd 2, with no Node-style
uncaught-exception report. An **effect-free** thrown value (literals,
variable reads, `error.new`/`error.newDom` of effect-free arguments — the
shape of `throw new Error("...")` and of the frontend's lowering backstops)
is not evaluated at all: the trap makes the value unobservable, and skipping
keeps the out-of-tier Error construction from refusing programs it cannot
affect. Any other thrown value evaluates in Node's order first, then traps.
This entry retires when the exception protocol lands (real throw/catch/
rethrow with instances). **Rationale:** unlocks every uncaught-throw corpus
program — including the union retag/narrow backstop riders — without the
exception protocol. **Tested by:** corpus throw programs (stdout before the
throw plus exit code must match Node; the harness skips the stderr compare
for nonzero-exit programs); the wasm emitter unit test pins evaluation-order
and skipped-evaluation cases against this entry.

## S008 — Wasm tier: string `repeat`/`pad` size cap is 2^31 units

`String.prototype.repeat` with a negative or infinite count traps (the
spec's RangeError through the S003 bridge, exit 1 like Node). The SIZE
limit differs: results at or past 2^31 UTF-16 units trap, where Node's
RangeError fires around 2^29 units — so a result length in [2^29, 2^31)
that Node rejects may instead be attempted here and survive if the GC can
allocate it. **Rationale:** the tier has no exception protocol to throw
the threshold RangeError with, and 2^31 is the storage's own bound; real
programs between the thresholds are allocating gigabytes of string either
way. Revisit (match Node's threshold with a real RangeError) when the
exception protocol lands. **Tested by:** the wasm emitter unit test covers
the trap side (negative count); the divergent window is deliberately
untested — corpus programs cannot sit in it without multi-GB appetites.
